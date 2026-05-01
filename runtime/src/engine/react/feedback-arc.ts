/**
 * 反馈闭环 — 从 act/result.ts 迁移。
 *
 * 包含：processResult（后处理）、updateReachability（可达性更新）、
 * classifyFailure（失败分类）、adaptiveGamma（自适应均值回归）、
 * logPersonalityEvolution（人格演化日志）、computeEAProxy（EA 代理指标）、
 * computeAdaptiveCooldown（自适应冷却）。
 *
 * ADR-214 Wave B: 全面切换到 ScriptExecutionResult。
 * ExecutableResult / RecordedAction 已删除。messageSent 等信号从 completedActions 推导。
 *
 * @see docs/adr/79-reachability-gc-mod-migration.md
 * @see docs/adr/90-reachability-recovery.md
 * @see docs/adr/53-audit-gap-closure.md
 * @see docs/adr/127-adaptive-rhythm-cooldown.md
 */

import { checkFeedbackGap } from "../../core/action-executor.js";
import type {
  ScriptExecutionErrorCode,
  ScriptExecutionResult,
} from "../../core/script-execution.js";
import { hasCompletedSend } from "../../core/script-execution.js";
import { getDb } from "../../db/connection.js";
import { writeDecisionTrace } from "../../db/decision-trace.js";
import { writeFocusTransitionShadows } from "../../db/focus-transition-shadow.js";
import {
  makeActionId,
  pressureVectorFromDims,
  writeActionResult,
  writeFactMutation,
  writePressureDeltasForAction,
} from "../../db/observation-spine.js";
import { actionLog, personalityEvolutionLog } from "../../db/schema.js";
import { appraiseActionFailureEmotion } from "../../emotion/appraisal.js";
import { recordEmotionEpisode } from "../../emotion/graph.js";
import {
  ALICE_SELF,
  chatIdToContactId,
  EMOTIONAL_DISCHARGE_FACTOR,
  ensureChannelId,
} from "../../graph/constants.js";
import { findActiveConversation } from "../../graph/queries.js";
import type { WorldModel } from "../../graph/world-model.js";
import { computeExternalFeedback } from "../../mods/observer/external-feedback.js";
import { ACT_SILENCE_SAFETY_THRESHOLD } from "../../pressure/signal-decay.js";
import { createLogger } from "../../utils/logger.js";
import {
  extractBeatFeedback,
  extractBeatTypes,
  extractOutcomeFeedback,
} from "../../voices/beat-feedback.js";
import {
  personalityEvolutionBatch,
  VOICE_BY_INDEX,
  VOICE_INDEX,
} from "../../voices/personality.js";
import type { ActionQueueItem } from "../action-queue.js";
import { closeEpisodeFromAct } from "../episode.js";
import type { TickTcMeta } from "../tick/types.js";
import type { ActContext } from "./orchestrator.js";

const log = createLogger("react:feedback");

// ═══════════════════════════════════════════════════════════════════════════
// ADR-156: 情感排放弧
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 消息发送后，对目标联系人的情感性 fact 触发排放（E *= DISCHARGE_FACTOR）。
 * 一次回应消解 70% 情感压力。连续回应进一步衰减：两次 → 91%。
 * @see docs/adr/156-emotional-reactivity-damping.md §排放因子
 */
function dischargeEmotionalFacts(G: WorldModel, channelId: string): void {
  const contactId = chatIdToContactId(channelId);
  if (!contactId || !G.has(contactId)) return;
  const neighbors = G.getNeighbors(contactId, "knows");
  let discharged = 0;
  for (const nid of neighbors) {
    if (G.getNodeType(nid) !== "fact") continue;
    const f = G.getFact(nid);
    if (f.reactivity != null && f.reactivity > 0) {
      G.updateFact(nid, {
        reactivity: f.reactivity * EMOTIONAL_DISCHARGE_FACTOR,
        reactivity_ms: Date.now(),
      });
      discharged++;
    }
  }
  if (discharged > 0) {
    log.info("Emotional discharge after message", { channelId, factsAffected: discharged });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// completedActions 解析工具
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 从 completedActions 提取第一条发送动作的消息文本。
 * completedActions 格式: "sent:chatId=X:msgId=Y"。
 * 注意：completedActions 不含消息文本——文本存在于 Engine API 调用参数中，
 * 但不回传到 shell-executor。返回 null。
 */
function extractFirstSentMessageText(_result: ScriptExecutionResult): string | null {
  // shell-native 架构下消息文本不回传到 completedActions
  return null;
}

function extractFirstExternalMessageId(result: ScriptExecutionResult): string | null {
  const sent = result.completedActions.find((action) => action.startsWith("sent:"));
  if (!sent) return null;
  const msgId = /(?:^|:)msgId=([^:]+)/.exec(sent)?.[1];
  const chatId = /(?:^|:)chatId=([^:]+)/.exec(sent)?.[1];
  if (chatId && msgId) return `${chatId}:${msgId}`;
  return msgId ?? sent;
}

function isCommandMisuseError(result: ScriptExecutionResult): boolean {
  return result.errorCodes.some(
    (code) =>
      code === "command_cross_chat_send" ||
      code === "command_invalid_target" ||
      code === "command_invalid_message_id" ||
      code === "command_invalid_reply_ref",
  );
}

type ExecutionOutcomeKind =
  | "message_sent"
  | "silence"
  | "provider_failed"
  | "validation_failed"
  | "command_misuse"
  | "telegram_failed"
  | "script_failed"
  | "observe_success";

interface ExecutionOutcome {
  kind: ExecutionOutcomeKind;
  actionType: string;
  success: boolean;
  finalDecision: "execute" | "fail" | "stop";
}

function isTelegramFailure(result: ScriptExecutionResult): boolean {
  return result.errorCodes.some(
    (code) =>
      code === "invalid_reaction" ||
      code === "invalid_sticker_keyword" ||
      code === "unreachable_telegram_user" ||
      code === "voice_messages_forbidden" ||
      code === "telegram_hard_permanent" ||
      code === "telegram_soft_permanent" ||
      code === "timeout",
  );
}

function classifyExecutionOutcome(
  result: ScriptExecutionResult,
  llmFailed: boolean,
  messageSent: boolean,
  failureKind?: EngagementMetrics["failureKind"],
): ExecutionOutcome {
  if (messageSent) {
    return {
      kind: "message_sent",
      actionType: "message",
      success: true,
      finalDecision: "execute",
    };
  }

  if (result.silenceReason && result.errors.length === 0) {
    return {
      kind: "silence",
      actionType: "silence",
      success: true,
      finalDecision: "stop",
    };
  }

  if (isCommandMisuseError(result)) {
    return {
      kind: "command_misuse",
      actionType: "command_misuse",
      success: false,
      finalDecision: "fail",
    };
  }

  if (isTelegramFailure(result)) {
    return {
      kind: "telegram_failed",
      actionType: "telegram_failed",
      success: false,
      finalDecision: "fail",
    };
  }

  if (llmFailed && failureKind === "provider_unavailable") {
    return {
      kind: "provider_failed",
      actionType: "provider_failed",
      success: false,
      finalDecision: "fail",
    };
  }

  if (llmFailed || result.errorCodes.includes("script_validation")) {
    return {
      kind: "validation_failed",
      actionType: "validation_failed",
      success: false,
      finalDecision: "fail",
    };
  }

  if (result.errors.length > 0 || result.instructionErrors.length > 0) {
    return {
      kind: "script_failed",
      actionType: "script_failed",
      success: false,
      finalDecision: "fail",
    };
  }

  return {
    kind: "observe_success",
    actionType: "observe",
    success: true,
    finalDecision: "execute",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ADR-185 §3: 行动结果 → Mood 反馈环
// ═══════════════════════════════════════════════════════════════════════════

/** ADR-185 §3: 无 rate_outcome 但消息已发送时的正向系数。 */
const NUDGE_SENT_FALLBACK = 0.3;
/** ADR-185 §3: LLM 失败时的负向系数。 */
const NUDGE_LLM_FAILED = -0.5;
/** ADR-185 §3: 深度对话（subcycles > 2）额外正向系数。 */
const NUDGE_DEEP_CONVERSATION = 0.3;

/**
 * ADR-185 §3: 行动结果微调 mood — 填补 "行动→情绪" 反馈弧断裂。
 *
 * ADR-214 Wave B: 参数改为 ScriptExecutionResult。
 * rate_outcome 在 shell-native 下通过 Engine API dispatch 执行，
 * 不在 completedActions 中追踪。当前实现中 rate_outcome 始终为空，
 * 退化到 NUDGE_SENT_FALLBACK（消息已发送但无显式评价）。
 *
 * @see docs/adr/185-cross-pollination-from-llm-agent-landscape.md §3
 */
export function applyOutcomeMoodNudge(
  G: WorldModel,
  executionResult: ScriptExecutionResult,
  messageSent: boolean,
  llmFailed: boolean,
  nudgeScale: number,
  subcycles?: number,
  targetId?: string,
  failureKind?: EngagementMetrics["failureKind"],
): void {
  if (!G.has(ALICE_SELF)) return;

  let delta = 0;

  if (llmFailed) {
    delta = nudgeScale * NUDGE_LLM_FAILED;
  } else if (messageSent) {
    // shell-native: rate_outcome 通过 dispatch 执行，不在 completedActions 中。
    // 退化到 fallback: 消息已发送但无显式评价 → 轻微正向。
    delta = nudgeScale * NUDGE_SENT_FALLBACK;

    // 深度对话奖励
    if (subcycles != null && subcycles > 2) {
      delta += nudgeScale * NUDGE_DEEP_CONVERSATION;
    }
  }
  // silence → delta = 0, 直接返回

  if (llmFailed || executionResult.errorCodes.length > 0) {
    appraiseActionFailureEmotion(G, {
      targetId,
      errorCodes: executionResult.errorCodes,
      failureKind,
      nowMs: Date.now(),
    });
    return;
  }

  if (delta === 0) return;

  recordEmotionEpisode(G, {
    kind: llmFailed ? "tired" : "pleased",
    valence: llmFailed ? -0.25 : 0.25,
    arousal: llmFailed ? 0.35 : 0.25,
    intensity: Math.min(0.45, Math.abs(delta) * 4),
    confidence: 0.7,
    nowMs: Date.now(),
    cause: {
      type: "action_result",
      summary: llmFailed
        ? "The last response attempt failed before it could land."
        : subcycles != null && subcycles > 2
          ? "A deeper exchange completed successfully."
          : "A message was sent successfully.",
    },
  });

  // ADR-268: self affect authority is the emotion episode ledger.
  // Do not mirror this into legacy self mood_valence / mood_set_ms.
}

// ═══════════════════════════════════════════════════════════════════════════
// 可达性反馈弧
// ═══════════════════════════════════════════════════════════════════════════

// ADR-79 M1: Reachability 反馈弧常量
// @see docs/adr/79-reachability-gc-mod-migration.md

/** 指数衰减 λ — 3 次失败 → score ≈ 0.22，与 ExplorationGuard threshold=3 对齐。 */
const REACHABILITY_LAMBDA = 2;

/** ADR-90 W2: 恢复 EMA 平滑因子 — 首次成功 0.22→0.61，第二次 0.61→0.81。 */
const REACHABILITY_RECOVERY_ALPHA = 0.5;
/** ADR-90 W2: failure_type 清除阈值 — score 恢复到此值以上才清除 failure_type。 */
const REACHABILITY_CLEAR_THRESHOLD = 0.8;

/** 分类 ACT 失败类型：permanent（被踢/封禁/无效 peer）或 transient（超时/限流）。 */
export type FailureType = "permanent" | "transient";
/**
 * ADR-90 W4: permanent failure 子分类。
 * hard — 用户维度不可逆（账号注销/封禁）→ 清零社交义务
 * soft — 频道级不可达（被踢/未加入）→ 保留义务但阻断强制行动
 */
export type FailureSubtype = "hard" | "soft";

/**
 * ADR-79 M1 + ADR-90 W4: 从结构化错误码推导失败类型和子类型。
 * permanent → 目标不可达（被踢/封禁/账号注销）
 * transient → 临时故障（超时/限流/网络抖动）
 */
export function classifyFailure(executionResult: {
  errorCodes: readonly ScriptExecutionErrorCode[];
}): {
  type: FailureType;
  subtype: FailureSubtype | null;
} {
  if (executionResult.errorCodes.includes("telegram_hard_permanent")) {
    return { type: "permanent", subtype: "hard" };
  }
  if (
    executionResult.errorCodes.includes("telegram_soft_permanent") ||
    executionResult.errorCodes.includes("unreachable_telegram_user")
  ) {
    return { type: "permanent", subtype: "soft" };
  }
  return { type: "transient", subtype: null };
}

/**
 * ADR-79 M1 + ADR-90 W2/W4: 更新图节点的可达性分数。
 *
 * 失败时递增 failures 并衰减 score。
 * 成功时 EMA 渐进恢复（不再阶跃到 1.0），score ≥ 0.8 时清除 failure_type。
 * permanent hard failure → 清零社交义务（账号不可逆）。
 * permanent soft failure → 保留义务但 shouldBypassGates 被阻断。
 */
export function updateReachability(
  G: WorldModel,
  target: string,
  success: boolean,
  executionResult: { errorCodes: readonly ScriptExecutionErrorCode[] },
): void {
  if (!target || !G.has(target)) return;

  // Reachability 追踪仅限 channel 节点
  if (G.getNodeType(target) !== "channel") return;

  if (!success) {
    const attrs = G.getChannel(target);
    const oldFailures = attrs.consecutive_act_failures ?? 0;
    const newFailures = oldFailures + 1;
    const score = Math.exp(-newFailures / REACHABILITY_LAMBDA);
    const { type: failureType, subtype } = classifyFailure(executionResult);

    const failPatch: Partial<import("../../graph/entities.js").ChannelAttrs> = {
      consecutive_act_failures: newFailures,
      reachability_score: score,
      failure_type: failureType,
    };
    if (subtype) failPatch.failure_subtype = subtype;

    // 目标 channel 已被证明不可达时，清掉这个 channel 上的本地待回复义务。
    // 如果同一个人在其他 channel 继续对话，应由那个 channel 的事实重新产生义务。
    if (failureType === "permanent") {
      failPatch.pending_directed = 0;
      failPatch.mentions_alice = false;
      log.info("Reachability permanent — cleared target-local social obligations", {
        target,
        subtype,
      });
    }
    G.updateChannel(target, failPatch);

    log.info("Reachability degraded", {
      target,
      failures: newFailures,
      score,
      failureType,
      subtype,
    });
  } else {
    const attrs = G.getChannel(target);
    const oldFailures = attrs.consecutive_act_failures ?? 0;
    if (oldFailures > 0) {
      // ADR-90 W2: EMA 渐进恢复 — 不再阶跃到 1.0
      const oldScore = attrs.reachability_score ?? 0;
      const newScore =
        oldScore * (1 - REACHABILITY_RECOVERY_ALPHA) + 1.0 * REACHABILITY_RECOVERY_ALPHA;
      const recoverPatch: Partial<import("../../graph/entities.js").ChannelAttrs> = {
        consecutive_act_failures: Math.max(0, oldFailures - 1),
        reachability_score: newScore,
      };

      // failure_type 只在 score 恢复到阈值以上时清除
      if (newScore >= REACHABILITY_CLEAR_THRESHOLD) {
        recoverPatch.failure_type = null;
        recoverPatch.failure_subtype = null;
        log.info("Reachability fully restored", { target, score: newScore });
      } else {
        log.info("Reachability recovering", {
          target,
          score: newScore,
          threshold: REACHABILITY_CLEAR_THRESHOLD,
        });
      }
      G.updateChannel(target, recoverPatch);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EA Proxy + 人格演化
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ADR-69: 有效推进代理指标 — EA_proxy(t) = observationValue / max(1, actionCount)
 *
 * ADR-214 Wave B: 基于 completedActions 计算。
 * shell-native 下 dispatch 动作（self_note, self_feel 等）不在 completedActions 中追踪，
 * observationValue 退化到 0。actionCount 从 "sent:" 前缀统计。
 * EA_proxy 在当前架构下始终返回 0——作为纯诊断指标保留，后续可扩展。
 */
export function computeEAProxy(result: ScriptExecutionResult): number {
  // shell-native: dispatch 动作不在 completedActions 中，observationValue = 0
  const observationValue = 0;
  const actionCount = result.completedActions.filter((a) => a.startsWith("sent:")).length;
  return observationValue / Math.max(1, actionCount);
}

/**
 * ADR-53 #2: 记录人格向量变化归因。
 * @see docs/adr/53-audit-gap-closure.md
 */
export function logPersonalityEvolution(
  tick: number,
  voiceIdx: number,
  feedbackSignal: number,
  source: "beat" | "outcome" | "decay",
  beatType?: string | null,
  targetEntity?: string | null,
): void {
  if (feedbackSignal === 0) return;
  try {
    getDb()
      .insert(personalityEvolutionLog)
      .values({
        tick,
        dimension: VOICE_BY_INDEX[voiceIdx] ?? `unknown_${voiceIdx}`,
        delta: feedbackSignal,
        source,
        beatType: beatType ?? null,
        targetEntity: targetEntity ?? null,
      })
      .run();
  } catch (e) {
    log.warn("Failed to write personality evolution log", e);
  }
}

/**
 * 自适应均值回归 γ — 漂移越大，回归力越强。
 *
 * 当 personality_health === "alert" 时 γ × 3（加速回归），
 * 避免人格因持续单侧反馈而退化（winner-takes-all 问题）。
 *
 * ADR-46 F7c: alert 时 γ ×2 → ×3（加速回归，配合 F7a 上限和 F7b 更低阈值）。
 * @see docs/adr/45-real-data-validation.md §3.6
 */
export function adaptiveGamma(G: WorldModel, baseGamma: number): number {
  if (!G.has("self")) return baseGamma;
  const health = G.getAgent("self").personality_health;
  if (health === "alert") return baseGamma * 3;
  return baseGamma;
}

// ═══════════════════════════════════════════════════════════════════════════
// Engagement Metrics
// ═══════════════════════════════════════════════════════════════════════════

/** ADR-108: Engagement session 遥测数据。 */
export interface EngagementMetrics {
  subcycles: number;
  durationMs: number;
  outcome: string;
  failureKind?: import("../tick/callLLM.js").TickFailureKind;
}

// ═══════════════════════════════════════════════════════════════════════════
// processResult — 后处理：反馈闭环 + 行动日志 + 人格演化
// ═══════════════════════════════════════════════════════════════════════════

type TcMeta = TickTcMeta;

/** 后处理：反馈闭环 + 行动日志 + 人格演化。 */
export function processResult(
  ctx: ActContext,
  item: ActionQueueItem,
  tick: number,
  executionResult: ScriptExecutionResult,
  errorCount: number,
  closureDepth?: number,
  engagementMetrics?: EngagementMetrics,
  tcMeta?: TcMeta,
): void {
  // ADR-129: LLM 调用失败时正确标记 success=false
  const llmFailed = engagementMetrics?.outcome === "llm_failed";
  const messageSent = hasCompletedSend(executionResult);
  const outcome = classifyExecutionOutcome(
    executionResult,
    llmFailed,
    messageSent,
    engagementMetrics?.failureKind,
  );
  const success = outcome.success && errorCount === 0 && executionResult.errors.length === 0;

  if (item.target && ctx.G.has(item.target) && ctx.G.getNodeType(item.target) === "channel") {
    const shouldUpdateReachability = messageSent || isTelegramFailure(executionResult);
    if (shouldUpdateReachability) {
      updateReachability(ctx.G, item.target, success, executionResult);
    }
  }

  // ADR-95 W1+W2+W4: 沉默冷却 + 沉默即感知 + directed 信号衰减
  // @see docs/adr/95-prompt-log-behavioral-audit.md §5
  // ADR-101: 防御性守卫——这些属性是 channel 专属，非 channel 节点不应写入
  // D-I: 脚本错误 ≠ 沉默——脚本编译/运行时错误不算 "主动选择沉默"
  const isSilence =
    !messageSent && !!executionResult.silenceReason && executionResult.errors.length === 0;
  if (item.target && ctx.G.has(item.target) && ctx.G.getNodeType(item.target) === "channel") {
    if (messageSent) {
      // ADR-158: 出站反馈弧补全。
      const pd = Number(ctx.G.getChannel(item.target).pending_directed ?? 0);
      ctx.G.updateChannel(item.target, {
        consecutive_act_silences: 0,
        pending_directed: Math.max(0, pd - 1),
        unread: 0,
        unread_ewms: 0,
      });
      // ADR-156 D2: 排放
      dischargeEmotionalFacts(ctx.G, item.target);

      // ADR-158 安全网: 对话 turn_state → other_turn。
      const channelForConv = ensureChannelId(item.target) ?? item.target;
      const convId = findActiveConversation(ctx.G, channelForConv);
      if (convId && ctx.G.has(convId)) {
        ctx.G.updateConversation(convId, {
          turn_state: "other_turn",
          last_activity_ms: Date.now(),
        });
      }
    } else if (llmFailed && engagementMetrics?.failureKind === "provider_unavailable") {
      log.warn("LLM provider unavailable — not treating as social silence", {
        target: item.target,
      });
    } else if (llmFailed) {
      // ADR-156 环路 2 修复：LLM 失败 ≈ 强制沉默。
      const prevSil = Number(ctx.G.getChannel(item.target).consecutive_act_silences ?? 0);
      const failPatch: Partial<import("../../graph/entities.js").ChannelAttrs> = {
        consecutive_act_silences: Math.max(prevSil, ACT_SILENCE_SAFETY_THRESHOLD + 1),
        last_act_silence_ms: Date.now(),
      };
      const pd = Number(ctx.G.getChannel(item.target).pending_directed ?? 0);
      if (pd > 0) failPatch.pending_directed = pd - 1;
      ctx.G.updateChannel(item.target, failPatch);
      log.warn("LLM failed — clamping act_silences as forced silence", {
        target: item.target,
        newSilences: Math.max(prevSil, ACT_SILENCE_SAFETY_THRESHOLD + 1),
      });
    } else if (isSilence) {
      const prevSil = Number(ctx.G.getChannel(item.target).consecutive_act_silences ?? 0);
      const silPatch: Partial<import("../../graph/entities.js").ChannelAttrs> = {
        consecutive_act_silences: prevSil + 1,
        last_act_silence_ms: Date.now(),
      };

      const oldUnread = Number(ctx.G.getChannel(item.target).unread ?? 0);
      if (oldUnread > 0) {
        silPatch.unread = Math.ceil(oldUnread * 0.5);
        const oldEwms = Number(ctx.G.getChannel(item.target).unread_ewms ?? 0);
        if (oldEwms > 0) silPatch.unread_ewms = oldEwms * 0.5;
      }

      const pd = Number(ctx.G.getChannel(item.target).pending_directed ?? 0);
      if (pd > 0) silPatch.pending_directed = pd - 1;

      ctx.G.updateChannel(item.target, silPatch);
    } else if (outcome.kind === "command_misuse") {
      log.warn("Command misuse — not treating as social silence", {
        target: item.target,
        errorCount,
        scriptErrors: executionResult.errors.length,
      });
    } else if (!success) {
      // 脚本错误（目标不可达、500 等）≈ 失败的行动尝试。
      // 压力释放等同于沉默——Alice 尝试了但没送达，不应无限重试。
      // 递增 act_silences 使频道在超过 ACT_SILENCE_SAFETY_THRESHOLD 后被门控跳过。
      const prevSil = Number(ctx.G.getChannel(item.target).consecutive_act_silences ?? 0);
      const errPatch: Partial<import("../../graph/entities.js").ChannelAttrs> = {
        consecutive_act_silences: prevSil + 1,
        last_act_silence_ms: Date.now(),
      };
      const pd = Number(ctx.G.getChannel(item.target).pending_directed ?? 0);
      if (pd > 0) errPatch.pending_directed = pd - 1;
      ctx.G.updateChannel(item.target, errPatch);
      log.warn("Script error — treating as failed action attempt", {
        target: item.target,
        errorCount,
        scriptErrors: executionResult.errors.length,
        newSilences: prevSil + 1,
      });
    } else {
      // ADR-218 F2: 成功的 observe（非消息、非沉默、非错误）— 信号守恒。
      // Alice 已"看到"目标但未回复。消耗 1 单位义务信号，防止
      // pending_directed 永远不被消清导致无限 bypass 循环。
      // 后续由 P3 关系冷却自然接管"已读不回"的社交压力。
      const pd = Number(ctx.G.getChannel(item.target).pending_directed ?? 0);
      if (pd > 0) {
        ctx.G.updateChannel(item.target, { pending_directed: pd - 1 });
      }
    }
  }

  // ADR-43 §P0: 反馈闭环缺口检查
  const feedbackGap = checkFeedbackGap(executionResult);

  // ADR-199 W1: 自动状态回写 — 强制闭环
  const autoWriteback: Record<string, string> = {};

  // ADR-199 W1.1: self_feel 质量升级 — 不再注入 "neutral"，而是推断 valence
  if (feedbackGap.isMissing && item.target) {
    try {
      const ext = computeExternalFeedback(ctx.G, item.target, Date.now() - 60_000, Date.now());
      const valence = ext.score > 0.2 ? "positive" : ext.score < -0.2 ? "negative" : "neutral";
      ctx.dispatcher.dispatch("feel", {
        target: item.target,
        valence,
        reason: `auto: inferred from external signals (${ext.signals.join(",") || "none"})`,
      });
      autoWriteback.feel = valence;
      log.info("Auto-injected feel (feedback gap, inferred)", {
        target: item.target,
        valence,
        extScore: ext.score,
        signals: ext.signals,
      });
    } catch (e) {
      log.warn("Failed to auto-inject self_feel", e);
    }
  }

  // ADR-185 §3: 行动结果微调 mood
  applyOutcomeMoodNudge(
    ctx.G,
    executionResult,
    messageSent,
    llmFailed,
    ctx.config.moodNudgeScale,
    engagementMetrics?.subcycles,
    item.target ?? undefined,
    engagementMetrics?.failureKind,
  );

  const unresolvedFeedbackGap = feedbackGap.isMissing && autoWriteback.feel == null;

  // 记录行动日志
  try {
    const actionType = outcome.actionType;
    const messageText = extractFirstSentMessageText(executionResult);
    let reasoning: string | null =
      executionResult.thinks.length > 0
        ? executionResult.thinks.slice(0, 3).join("; ")
        : (executionResult.silenceReason ?? null);

    // ADR-70: query 自动打印结果追加到 reasoning
    if (executionResult.queryLogs.length > 0) {
      const querySummary = executionResult.queryLogs
        .map((l) => `[${l.fn}] ${l.result.slice(0, 100)}`)
        .join("; ");
      reasoning = reasoning
        ? `${reasoning} | queries: ${querySummary}`
        : `queries: ${querySummary}`;
    }

    // ADR-69: EA_proxy 诊断指标
    const eaProxy = computeEAProxy(executionResult);

    const actionRow = getDb()
      .insert(actionLog)
      .values({
        tick,
        voice: item.action,
        target: item.target,
        actionType,
        chatId: item.target ?? null,
        messageText,
        confidence: null, // ADR-131 D4: 不填假数据，null = 尚无置信度评估能力
        reasoning,
        success: outcome.success,
        observationGap: unresolvedFeedbackGap ? 1 : 0,
        closureDepth: closureDepth ?? null,
        eaProxy,
        engagementSubcycles: engagementMetrics?.subcycles ?? null,
        engagementDurationMs: engagementMetrics?.durationMs ?? null,
        engagementOutcome: engagementMetrics?.outcome ?? null,
        autoWriteback: Object.keys(autoWriteback).length > 0 ? JSON.stringify(autoWriteback) : null,
        tcToolCallCount: tcMeta?.toolCallCount ?? null,
        tcBudgetExhausted: tcMeta?.budgetExhausted ?? null,
        tcAfterward: tcMeta?.afterward ?? null,
        tcCommandLog: tcMeta?.commandLog ?? null,
        tcHostContinuationTrace: tcMeta?.hostContinuationTrace
          ? JSON.stringify(tcMeta.hostContinuationTrace)
          : null,
        llmProvider: tcMeta?.provider ?? null,
        llmModel: tcMeta?.model ?? null,
      })
      .returning({ id: actionLog.id })
      .get();
    const actionId = makeActionId(actionRow.id);
    const typedResult = outcome.success
      ? outcome.kind === "observe_success" || outcome.kind === "silence"
        ? "no_op"
        : "success"
      : "typed_failure";
    const failureCode = outcome.success
      ? "N/A"
      : (executionResult.errorCodes[0] ?? outcome.kind ?? "unknown_failure");

    writeActionResult({
      actionId,
      tick,
      enqueueId: item.observation?.enqueueId ?? null,
      candidateId: item.observation?.candidateId ?? null,
      actionLogId: actionRow.id,
      target: item.target,
      actionType,
      result: typedResult,
      failureCode,
      externalMessageId: extractFirstExternalMessageId(executionResult),
      completedActionRefs: executionResult.completedActions,
      executionObservations: executionResult.observations,
    });
    writeFocusTransitionShadows({
      tick,
      actionId,
      actionLogId: actionRow.id,
      candidateId: item.observation?.candidateId ?? null,
      sourceTarget: item.target,
      errorDetails: executionResult.errorDetails ?? [],
      observations: executionResult.observations,
      completedActions: executionResult.completedActions,
    });
    writeFactMutation({
      mutationId: `mutation:${actionId}:auto_writeback`,
      actionId,
      sourceTick: tick,
      factNamespace: Object.keys(autoWriteback).length > 0 ? "graph" : "diagnostic",
      entityNamespace: item.target ? "channel" : "none",
      entityId: item.target,
      mutationKind: Object.keys(autoWriteback).length > 0 ? "update" : "none",
      delta: Object.keys(autoWriteback).length > 0 ? autoWriteback : undefined,
      authorityTable: Object.keys(autoWriteback).length > 0 ? "graph_nodes" : "action_log",
    });
    const pressureAfter = ctx.getCurrentPressures();
    writePressureDeltasForAction({
      sourceTick: item.enqueueTick,
      actionTick: tick,
      relatedCandidateId: item.observation?.candidateId ?? null,
      relatedActionId: actionId,
      pressureBefore: pressureVectorFromDims(
        item.pressureSnapshot,
        item.observation?.api ?? item.pressureSnapshot.reduce((sum, value) => sum + value, 0),
        item.observation?.apiPeak ?? null,
      ),
      pressureAfter: pressureVectorFromDims(
        pressureAfter,
        pressureAfter.reduce((sum, value) => sum + value, 0),
      ),
    });

    writeDecisionTrace({
      tick,
      phase: "act",
      target: item.target,
      actionLogId: actionRow.id,
      finalDecision: outcome.finalDecision,
      reason: actionType,
      payload: {
        selectedAction: item.action,
        block: {
          completedActions: executionResult.completedActions,
          errors: executionResult.errors,
          instructionErrors: executionResult.instructionErrors,
          errorCodes: executionResult.errorCodes,
          errorDetails: executionResult.errorDetails ?? [],
          silenceReason: executionResult.silenceReason,
        },
        hostExecution: {
          success: outcome.success,
          messageSent,
          llmFailed,
          outcome: outcome.kind,
          errorCount,
          closureDepth: closureDepth ?? null,
          feedbackGap: unresolvedFeedbackGap,
          engagement: engagementMetrics ?? null,
          tcMeta: tcMeta ?? null,
        },
        observations: executionResult.logs,
      },
    });
  } catch (e) {
    log.warn("Failed to write action log", e);
  }

  // ADR-199 W2: 回写行动摘要到 observer mod state → 下一轮 prompt 注入
  // shell-native 下 dispatch 动作不在 completedActions 中，stateChanges 从 completedActions 推导
  try {
    const stateChanges: string[] = [];
    for (const ca of executionResult.completedActions) {
      if (ca.startsWith("sent:")) stateChanges.push("sent a message");
      else if (ca.startsWith("sticker:")) stateChanges.push("sent a sticker");
      else if (ca.startsWith("forwarded:")) stateChanges.push("forwarded a message");
      else if (ca.startsWith("downloaded:")) stateChanges.push("downloaded media");
      else if (ca.startsWith("sent-file:")) stateChanges.push("sent a file");
    }
    if (stateChanges.length === 0 && messageSent) stateChanges.push("sent a message");
    const autoWbEntries = Object.entries(autoWriteback).map(([k, v]) => `auto-${k}:${v}`);
    ctx.dispatcher.dispatch("SET_LAST_ACTION_RECAP", {
      tick,
      target: item.target ?? null,
      messageSent,
      stateChanges,
      autoWriteback: autoWbEntries,
      timestamp: Date.now(),
    });
  } catch (e) {
    log.warn("Failed to write action recap", e);
  }

  // ADR-23/31 人格演化
  // 论文 Def 3.6 eq 14: 累加所有 delta → 一次回归 → 一次投影。
  const beatFeedback = extractBeatFeedback(executionResult);
  const outcomeFeedback = extractOutcomeFeedback(executionResult);
  const actionIdx = VOICE_INDEX[item.action] ?? -1;
  const allFeedback = [...(beatFeedback ?? []), ...(outcomeFeedback ?? [])];

  if (allFeedback.length > 0) {
    const gamma = adaptiveGamma(ctx.G, ctx.config.meanReversion);
    const newPersonality = personalityEvolutionBatch(
      ctx.personality,
      allFeedback.map((fb) => ({ actionIdx: fb.voice, feedback: fb.magnitude })),
      ctx.config.learningRate,
      gamma,
      ctx.config.piHome,
      ctx.config.piMin,
    );
    ctx.onPersonalityUpdate(newPersonality);

    const beatTypes = extractBeatTypes(executionResult);
    const primaryBeatType = beatTypes[0] ?? null;
    if (beatFeedback) {
      for (const fb of beatFeedback) {
        logPersonalityEvolution(tick, fb.voice, fb.magnitude, "beat", primaryBeatType, item.target);
      }
    }
    if (outcomeFeedback) {
      for (const fb of outcomeFeedback) {
        logPersonalityEvolution(tick, fb.voice, fb.magnitude, "outcome", null, item.target);
      }
    }
  } else if (actionIdx >= 0) {
    const feedback = success ? 0.3 : -0.3;
    const newPersonality = personalityEvolutionBatch(
      ctx.personality,
      [{ actionIdx, feedback }],
      ctx.config.learningRate,
      adaptiveGamma(ctx.G, ctx.config.meanReversion),
      ctx.config.piHome,
      ctx.config.piMin,
    );
    logPersonalityEvolution(tick, actionIdx, feedback, "decay", null, item.target);
    ctx.onPersonalityUpdate(newPersonality);
  }

  // ADR-215: Episode 关闭——双源融合（LLM residue + 结构信号）。
  if (item.episodeId) {
    try {
      closeEpisodeFromAct(
        item.episodeId,
        {
          messageSent,
          isSilence,
          success,
          errorCount,
          scriptErrors: executionResult.errors.length,
          silenceReason: executionResult.silenceReason ?? null,
          engagementOutcome: engagementMetrics?.outcome ?? null,
          subcycles: engagementMetrics?.subcycles ?? 1,
          durationMs: engagementMetrics?.durationMs ?? 0,
          target: item.target,
          tick,
        },
        item.llmResidue,
      );
    } catch (e) {
      log.warn("Episode close from act failed", e);
    }
  }

  log.info("Action executed", {
    tick,
    voice: item.action,
    completedActions: executionResult.completedActions.length,
    thinks: executionResult.thinks.length,
    thinksPreview: executionResult.thinks[0]?.slice(0, 80) ?? null,
    errorCount,
    scriptErrors: executionResult.errors.length,
    afterward: engagementMetrics?.outcome ?? null,
    subcycles: engagementMetrics?.subcycles ?? 1,
    outcome: outcome.kind,
    success: outcome.success,
    hostClean: success,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 自适应节奏冷却 — cooldown 补偿 engagement 时长以维持目标总周期。
// @see docs/adr/127-adaptive-rhythm-cooldown.md
// ═══════════════════════════════════════════════════════════════════════════

/** 自适应冷却参数（纯函数输入，便于测试）。 */
export interface AdaptiveCooldownOpts {
  engagementMs: number;
  consecutiveOutgoing: number;
  chatType: string;
  isConversationActive: boolean;
}

// -- 常量 --

/** 活跃对话基础周期（ms）。 */
const TAU_BASE_CONVERSATION = 4000;
/** 非活跃 / 主动出击基础周期（ms）。 */
const TAU_BASE_PROACTIVE = 7000;
/** 每条连续发出消息追加的延迟（ms）。 */
const ALPHA_CONSECUTIVE = 1500;
/** 群组 / 超级群组的周期乘数。 */
const M_CHAT_GROUP = 1.5;
/** 绝对冷却下限（ms）。 */
const TAU_FLOOR = 800;

/**
 * 计算自适应冷却时长。
 *
 * τ_target = (τ_base + α · consecutive_outgoing) × m_chat
 * cooldown = max(τ_floor, τ_target − engagement_ms) × jitter
 *
 * 纯函数——不依赖外部状态，可直接单元测试。
 * @see docs/adr/127-adaptive-rhythm-cooldown.md
 */
export function computeAdaptiveCooldown(opts: AdaptiveCooldownOpts): number {
  const tauBase = opts.isConversationActive ? TAU_BASE_CONVERSATION : TAU_BASE_PROACTIVE;
  const mChat = opts.chatType === "group" || opts.chatType === "supergroup" ? M_CHAT_GROUP : 1.0;
  const tauTarget = (tauBase + ALPHA_CONSECUTIVE * opts.consecutiveOutgoing) * mChat;
  const jitter = 0.8 + Math.random() * 0.4; // [0.8, 1.2]
  return Math.max(TAU_FLOOR, tauTarget - opts.engagementMs) * jitter;
}
