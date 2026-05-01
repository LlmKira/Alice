/**
 * EVOLVE 线程：定时 tick 循环 (ADR-26 v5)。
 *
 * 每 tick：
 * 1. Self 维护（情绪 projection 刷新）
 * 2. PERCEIVE（消费事件）
 * 3. 计算压力 → 张力 Map → 焦点集 → 声部 → 选行动/目标
 * 4. 门控（行动频率限制 + Social Value Gate）
 * 5. 通过则 enqueue 到 ActionQueue
 *
 * ADR-268: self affect projection, digest 行动, System1Options.
 */

import { eq } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Dispatcher } from "../core/dispatcher.js";
import { typedQuery } from "../core/query-helpers.js";
import { writeAuditEvent } from "../db/audit.js";
import { getDb } from "../db/connection.js";
import { type DecisionTracePayload, writeDecisionTrace } from "../db/decision-trace.js";
import { gcExpiredFacts } from "../db/maintenance.js";
import {
  makeCandidateId,
  makeEnqueueId,
  makeRankedCandidateId,
  pressureVectorFromDims,
  writeCandidateTrace,
  writePressureDeltasForPreviousTrace,
  writeQueueTrace,
  writeTickTrace,
} from "../db/observation-spine.js";
import { rhythmProfiles, silenceLog, tickLog } from "../db/schema.js";
import { flushGraph } from "../db/snapshot.js";
import { computeClosureHealth } from "../diagnostics/closure-health.js";
import { appraiseLonelySilence } from "../emotion/appraisal.js";
import { updateEmotionStateOnGraph } from "../emotion/graph.js";
import {
  ALICE_SELF,
  chatIdToContactId,
  ensureChannelId,
  ensureContactId,
  extractNumericId,
} from "../graph/constants.js";
import type { DunbarTier } from "../graph/entities.js";
import { buildTensionMap, routeContributions } from "../graph/tension.js";
import type { WorldModel } from "../graph/world-model.js";
import { isAnyProviderHealthy } from "../llm/client.js";
import { persistBehavioralInsights } from "../llm/self-observation.js";
import {
  type AdaptiveKappa,
  type AllPressures,
  computeAllPressures,
  type PressureHistory,
} from "../pressure/aggregate.js";
import { updateAttentionDebt } from "../pressure/attention-debt.js";
import { computeGoldilocksUtility } from "../pressure/goldilocks.js";
import {
  computeHawkesLambdaDiscount,
  effectiveMu,
  getDefaultParams as getHawkesParams,
  type HawkesParams,
  type HawkesState,
  queryIntensity,
} from "../pressure/hawkes.js";
import { computeNaturalness } from "../pressure/naturalness.js";
import {
  ACT_SILENCE_SAFETY_THRESHOLD,
  computeHabituationFactor,
  DORMANT_PRESSURE_FACTOR,
  effectiveActSilences,
  effectiveObligation,
  effectiveRisk,
  isConversationContinuation,
  isInQuietWindow,
  OBLIGATION_THRESHOLDS,
  SILENCE_COOLDOWN_THRESHOLD,
} from "../pressure/signal-decay.js";
import { ChatTarget } from "../prompt/types.js";
import { maybeAutoUpgrade } from "../skills/auto-upgrade.js";
import type { EventBuffer } from "../telegram/events.js";
import { createLogger } from "../utils/logger.js";
import type { AgentMode, TickClock } from "../utils/time.js";
import { computeLoudness, computeUncertainty } from "../voices/loudness.js";
import { type FacetContext, normalizePressuresForFacet, selectFacet } from "../voices/palette.js";
import type { PersonalityVector, VoiceAction } from "../voices/personality.js";
import { selectAction } from "../voices/selection.js";
import type { ActionQueue } from "./action-queue.js";
import {
  commitTickEvents,
  emit as emitConsciousness,
  gc as gcConsciousness,
} from "./consciousness.js";
import { tickConversations } from "./conversation.js";
import { evaluateDeferredOutcome, scanPendingOutcomes } from "./deferred-outcome.js";
import {
  addImpulse,
  type DeliberationState,
  IMPULSE_MIN_VALUE,
  onActionEnqueued,
  onSilence,
  type PendingImpulse,
  SILENCE_VOI_DECAY_RATE,
} from "./deliberation.js";
import { deriveDesires, findTopDesireForTarget } from "./desire.js";
import {
  type EpisodeWorkingState,
  injectResidueContributions,
  refreshResidueCache,
  updateEpisode,
} from "./episode.js";
import {
  classifyChatType,
  countActionsByClass,
  gateActiveCooling,
  gateAPIFloor,
  gateClosingConversation,
  gateConversationAware,
  gateIdleSelfStart,
  resolveIsBot,
  runGateChain,
  type SilenceLevel,
  type SilenceValues,
} from "./gates.js";
import { runGenerators, updateChannelRateEma } from "./generators.js";
import {
  assembleIAUSReason,
  type CandidateContext,
  type IAUSCandidate,
  type IAUSConfig,
  type IAUSScoredCandidate,
  type RhythmTimingProfile,
  scoreAllCandidates,
} from "./iaus-scorer.js";
import { perceiveTick } from "./perceive.js";
import { classifySilence, computeVoINull } from "./silence.js";
import { trySystem1 } from "./system1.js";

const log = createLogger("evolve");

/** ADR-252 Wave 1: queue/ACT active saturation at or above this value suppresses non-bypass IAUS winners. */
const IAUS_QUEUE_BACKPRESSURE_SATURATION = 0.8;
/** Post-wakeup recovery: briefly keep Alice on a small set of already-open targets. */
export const POST_WAKEUP_RECOVERY_MS = 10 * 60 * 1000;
const POST_WAKEUP_RECOVERY_TARGET_BUDGET = 2;

/**
 * ADR-64 II-2: 记录沉默事件到 silence_log 表。
 * 在声部已选中、目标已确定之后的门控 skip 出口调用。
 */
function recordSilence(
  tick: number,
  voice: string,
  target: string | null,
  reason: string,
  values: { netValue?: number; deltaP?: number; socialCost?: number; apiValue?: number },
  silenceLevel?: SilenceLevel,
): void {
  try {
    const db = getDb();
    db.insert(silenceLog)
      .values({
        tick,
        voice,
        target,
        reason,
        netValue: values.netValue ?? null,
        deltaP: values.deltaP ?? null,
        socialCost: values.socialCost ?? null,
        apiValue: values.apiValue ?? null,
        silenceLevel: silenceLevel ?? null,
      })
      .run();
  } catch (e) {
    log.warn("Failed to write silence log", e);
  }
}

export interface EvolveState {
  G: WorldModel;
  personality: PersonalityVector;
  clock: TickClock;
  buffer: EventBuffer;
  queue: ActionQueue;
  config: Config;
  noveltyHistory: number[];
  recentEventCounts: number[];
  /**
   * 最近真实行动记录。
   * ADR-173: 仅在 act 线程确认 Telegram 行动后写入（recordAction 回调），
   * 不在 enqueue 时乐观写入——消除幽灵条目（silence/observe/llm_failed）。
   */
  recentActions: Array<{ tick: number; action: string; ms: number; target: string | null }>;
  dispatcher: Dispatcher;
  /** H1: 上次行动的墙钟时间戳（ms）。 */
  lastActionMs: number;
  /** D2 Trend: 实例化压力历史（消除全局可变状态）。 */
  pressureHistory: PressureHistory;
  /**
   * ADR-75: 中间时间尺度工作记忆。
   * 声部疲劳 + 冲动保留 + 沉默积累 + 行动谱系。
   * @see docs/adr/75-deliberation-state/75-deliberation-state.md
   */
  deliberation: DeliberationState;
  /** 可注入的 UTC 小时（0-23），用于 circadian 门控。未提供时回退到墙钟。 */
  utcHour?: number;
  /**
   * ADR-100: 注意力负债 map（channel → debt）。
   * 跨 tick 维护，在 evolve 管线中更新。
   * @see docs/adr/100-attention-debt.md §9
   */
  attentionDebtMap: Map<string, number>;
  /** ADR-100: 上一 tick 选中的行动目标（用于 debt 累积判断）。null = 沉默/skip。 */
  lastSelectedTarget: string | null;
  /** ADR-182 D1: 上一 tick 选中的 (action, target) — Momentum Bonus 依据。 */
  lastSelectedCandidate: { action: VoiceAction; target: string } | null;

  // ── Agent Mode FSM（论文 §6.2）──────────────────────────────────
  /** 当前运行模态。 */
  mode: AgentMode;
  /** conversation mode 锁定的目标频道。 */
  focusTarget?: string;
  /** 进入当前 mode 的墙钟时间戳（ms）。 */
  modeEnteredMs: number;
  /** ADR-112 D4: 自适应 κ 实例。 */
  adaptiveKappa: AdaptiveKappa;
  /**
   * ADR-115: per-channel 消息速率 EMA。
   * @see docs/adr/115-evolve-observability/
   */
  channelRateEma: Map<string, { ema: number; variance: number }>;
  /**
   * ADR-191: 最近一次 perceiveTick 的 per-channel 消息计数。
   * spike 信号的数据源——computeTickPlan 用此与 channelRateEma 对比计算 z-score。
   */
  lastChannelCounts: Map<string, number>;
  /** ADR-147 D2: 事件计数 EMA（积压检测基线）。 */
  eventCountEma: number;
  /** ADR-147 D12: 连续洪水 tick 计数（P1 cap avgP1 排除用）。 */
  floodTickCount: number;
  /** ADR-190: wakeup 模态内经过的 tick 数。 */
  wakeupTicksElapsed: number;
  /** ADR-190: wakeup 期间已主动接触的目标（允许继续同一对话，限制新目标扩散）。 */
  wakeupEngagedTargets: Set<string>;
  /** Post-wakeup recovery window end timestamp. Ordinary proactive stays near wakeup targets. */
  wakeupRecoveryUntilMs?: number;
  /** 最近一次 API 聚合值（供 startEvolveLoop 计算 interval 使用）。 */
  lastAPI: number;
  /** ADR-195: Peak-based API — 驱动 tick 间隔调度。 */
  lastAPIPeak: number;
  /** 上次成功 flushGraph 的墙钟时间戳（ms）。OL-5 重试用。 */
  lastFlushMs: number;
  /** 当前 tick 的 dt（秒），由 advance() 计算。 */
  currentDt: number;

  // ── ADR-190: 调度层 LLM 失败指数退避 ──────────────────────────────────
  /**
   * act 线程 LLM 调用结果追踪。
   * evolve 线程在 startEvolveLoop 中读取，计算 tick 间隔退避乘数。
   * act 线程通过 ActContext.reportLLMOutcome 回调写入。
   */
  llmBackoff: {
    /** 连续 LLM 失败次数。成功一次立即重置为 0。 */
    consecutiveFailures: number;
    /** 上次失败的墙钟时间戳（ms）。用于退避超时自动重置。 */
    lastFailureMs: number;
  };

  // ── ADR-215: Cognitive Episode Graph ──────────────────────────────────
  /**
   * 认知片段工作状态。
   * 跨 tick 维护当前活跃 episode + 活跃 residue 缓存。
   * @see docs/adr/215-cognitive-episode-graph.md
   */
  episodeState: EpisodeWorkingState;
}

// ═══════════════════════════════════════════════════════════════════════════
// ADR-147: 积压检测 — EMA 突增 + mtcute 状态 = 统一谓词
// ═══════════════════════════════════════════════════════════════════════════

export const EMA_ALPHA = 0.1;

/**
 * EMA 积压检测：eventCount 超过 3×EMA（至少 50）则判定为积压。
 * 积压事件不参与 EMA 更新（避免污染基线）。
 *
 * @see docs/adr/147-flood-backlog-recovery.md §D2
 */
export function detectBacklog(state: { eventCountEma: number }, eventCount: number): boolean {
  const threshold = Math.max(3 * state.eventCountEma, 50);
  return eventCount > threshold;
  // ADR-147 D9: EMA 更新已移至 evolveTick 单点调用，此函数为纯查询。
}

/**
 * 统一洪水条件谓词：mtcute 重连恢复 OR EMA 统计推断。
 * 所有下游消费者（P1 cap、mode 守卫）统一使用此谓词。
 *
 * @see docs/adr/147-flood-backlog-recovery.md §D2
 */
export function isFloodCondition(
  state: { buffer: { isRecovering: boolean }; eventCountEma: number },
  eventCount: number,
): boolean {
  return state.buffer.isRecovering || detectBacklog(state, eventCount);
}

/**
 * 入队 + 状态簿记（从 3 处 copy-paste 抽取）。
 * 设置 lastActionTick、追踪 recentActions、清理过期窗口。
 */
function enqueueAndRecord(
  state: EvolveState,
  tick: number,
  nowMs: number,
  action: VoiceAction,
  target: string | null,
  pressures: AllPressures,
  focalEntities: string[],
  reason?: string,
  vmaxScored?: IAUSScoredCandidate[],
  vmaxSpread?: number,
  facetId?: string,
): void {
  const candidateId = makeCandidateId(tick, action, target);
  const enqueueId = makeEnqueueId(tick, action, target);
  const pressureSnapshot: [number, number, number, number, number, number] = [
    pressures.P1,
    pressures.P2,
    pressures.P3,
    pressures.P4,
    pressures.P5,
    pressures.P6,
  ];
  const item = {
    enqueueTick: tick,
    action,
    target,
    pressureSnapshot,
    contributions: pressures.contributions,
    focalEntities,
    reason,
    vmaxScored,
    vmaxSpread,
    facetId,
    // ADR-215: episode ID 是确定性的（episode:${tick}），可预计算。
    // updateEpisode 在 enqueue 之后执行，但 ID 可提前确定。
    episodeId:
      state.episodeState.currentId ??
      (target && target !== state.episodeState.currentTarget ? `episode:${tick}` : undefined),
    observation: { candidateId, enqueueId, api: pressures.API, apiPeak: pressures.API_peak },
  };
  const result = state.queue.enqueue(item);
  const metrics = state.queue.getMetrics();
  writeQueueTrace({
    tick,
    candidateId,
    enqueueId,
    enqueueOutcome: result.outcome,
    fate: result.outcome === "accepted" ? "accepted" : "dropped",
    queueDepth: metrics.queued,
    activeCount: metrics.active,
    saturation: metrics.saturation,
    reasonCode: result.outcome === "accepted" ? `enqueue_${result.delivery}` : "rejected_overflow",
  });
  if (result.evicted?.observation) {
    writeQueueTrace({
      tick,
      candidateId: result.evicted.observation.candidateId,
      enqueueId: result.evicted.observation.enqueueId,
      enqueueOutcome: "accepted",
      fate: "dropped",
      queueDepth: metrics.queued,
      activeCount: metrics.active,
      saturation: metrics.saturation,
      supersededByEnqueueId: enqueueId,
      reasonCode: "overflow_evicted",
    });
  }
  state.lastActionMs = nowMs;
  // ADR-173: recentActions 不在此写入——由 act 确认后通过 recordAction 回调写入。
  // lastActionMs 保留乐观更新：语义是"Alice 上次打算行动的时间"（idle 判断），
  // 与 recentActions 的"真实执行记录"（频率计数）语义分离。
}

// ═══════════════════════════════════════════════════════════════════════════
// TickPlan — evolve 管线的纯输出
// ═══════════════════════════════════════════════════════════════════════════

/**
 * TickPlan — evolve 管线的纯输出。
 * 描述"应该发生什么"，不执行副作用。
 * @see paper/ eq. G → P → τ → (L, E_v) → a* → G'
 */
type TickPlan =
  | {
      type: "enqueue";
      action: VoiceAction;
      target: string | null;
      pressures: AllPressures;
      focalEntities: string[];
      voice: string;
      /** V-max 赢家的 Net Social Value（ADR-75 行动谱系用）。 */
      netValue: number;
      /** 引擎侧结构化行动理由。 */
      reason?: string;
      /** ADR-115: ΔP 预期压力降低量。 */
      deltaP?: number;
      /** ADR-115: C_social 社交成本。 */
      socialCost?: number;
      /** ADR-115: softmax 选中概率。 */
      selectedProbability?: number;
      /** D8: V-max 评分候选（fan-out 用）。 */
      vmaxScored?: IAUSScoredCandidate[];
      /** D8: V-max 候选 spread（fan-out 触发条件）。 */
      vmaxSpread?: number;
      /** ADR-174: 人格面向 ID。 */
      facetId?: string;
    }
  | {
      type: "system1";
      decision: ReturnType<typeof trySystem1>;
      pressures: AllPressures;
      voice: string;
      target: string | null;
      focalEntities: string[];
    }
  | {
      type: "silent";
      pressures: AllPressures;
      voice: string;
      target: string | null;
      reason: string;
      level: SilenceLevel;
      values: SilenceValues;
      focalEntities: string[];
      /** ADR-75: VoI-deferred 时携带的高 V 冲动（applyPlan 中执行 addImpulse）。 */
      impulseToRetain?: Omit<PendingImpulse, "decay" | "salience">;
      /** ADR-258: 即使最终沉默，也保留本 tick 曾评分的 IAUS 候选池。 */
      vmaxScored?: IAUSScoredCandidate[];
    }
  | { type: "skip"; reason: string };

/** ADR-115: 格式化统一决策结果标签，用于 tick_log 审计。 */
function formatGateVerdict(plan: TickPlan): string {
  switch (plan.type) {
    case "enqueue":
      return "enqueue";
    case "system1":
      return `system1:${plan.decision.action}`;
    case "silent":
      return `silent:${plan.level}`;
    case "skip":
      return `skip:${plan.reason}`;
  }
}

function pressureTracePayload(pressures: AllPressures): Record<string, number> {
  return {
    p1: pressures.P1,
    p2: pressures.P2,
    p3: pressures.P3,
    p4: pressures.P4,
    p5: pressures.P5,
    p6: pressures.P6,
    api: pressures.API,
    apiPeak: pressures.API_peak,
  };
}

function pressureVectorSnapshot(pressures: AllPressures) {
  return pressureVectorFromDims(
    [pressures.P1, pressures.P2, pressures.P3, pressures.P4, pressures.P5, pressures.P6],
    pressures.API,
    pressures.API_peak,
  );
}

function silenceValuesFromCandidate(
  candidate: IAUSCandidate,
  bestV: number,
  apiValue: number,
  extra: SilenceValues = {},
): SilenceValues {
  return {
    ...extra,
    netValue: bestV,
    deltaP: candidate.deltaP,
    socialCost: candidate.socialCost,
    apiValue,
  };
}

function makeRhythmTimingProfileReader(): (
  target: string,
  chatType?: string,
) => RhythmTimingProfile | null {
  const cache = new Map<string, RhythmTimingProfile | null>();

  return (target: string, chatType?: string) => {
    const cacheKey = `${chatType ?? "unknown"}:${target}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null;

    try {
      for (const entityId of rhythmProfileLookupIds(target, chatType)) {
        const row = getDb()
          .select({
            activeNowScore: rhythmProfiles.activeNowScore,
            quietNowScore: rhythmProfiles.quietNowScore,
            confidence: rhythmProfiles.confidence,
            stale: rhythmProfiles.stale,
          })
          .from(rhythmProfiles)
          .where(eq(rhythmProfiles.entityId, entityId))
          .get();

        const profile = row ? rhythmTimingProfileFromRow(row) : null;
        if (profile) {
          cache.set(cacheKey, profile);
          return profile;
        }
      }

      const profile = null;
      cache.set(cacheKey, profile);
      return profile;
    } catch {
      cache.set(cacheKey, null);
      return null;
    }
  };
}

function rhythmProfileLookupIds(target: string, chatType?: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (id: string | null) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };

  push(target);
  const channelId = ensureChannelId(target);
  const contactId = positiveContactId(target);
  if (chatType === "private") {
    push(contactId);
    push(channelId);
    return ids;
  }

  push(channelId);
  if (chatType !== "channel") push(contactId);
  return ids;
}

function positiveContactId(target: string): string | null {
  const numericId = extractNumericId(target);
  if (numericId == null || numericId < 0) return null;
  return ensureContactId(String(numericId));
}

function rhythmTimingProfileFromRow(row: {
  activeNowScore: number;
  quietNowScore: number;
  confidence: string;
  stale: boolean;
}): RhythmTimingProfile | null {
  if (row.confidence !== "low" && row.confidence !== "medium" && row.confidence !== "high") {
    return null;
  }
  return {
    activeNowScore: row.activeNowScore,
    quietNowScore: row.quietNowScore,
    confidence: row.confidence,
    stale: row.stale,
  };
}

type CandidateTracePayload = {
  [key: string]: number | IAUSScoredCandidate["diagnostics"] | undefined;
  __diagnostics?: IAUSScoredCandidate["diagnostics"];
};

function traceConsiderations(
  candidate: IAUSScoredCandidate | null | undefined,
): CandidateTracePayload {
  if (!candidate) return {};
  if (!candidate.diagnostics || Object.keys(candidate.diagnostics).length === 0) {
    return candidate.considerations;
  }
  return {
    ...candidate.considerations,
    __diagnostics: candidate.diagnostics,
  };
}

function planCandidateId(tick: number, plan: Exclude<TickPlan, { type: "skip" }>): string | null {
  if (plan.type === "system1") return null;
  if (plan.type === "enqueue") return makeCandidateId(tick, plan.action, plan.target);
  return makeCandidateId(tick, plan.voice, plan.target);
}

function recordObservationSpineTick(tick: number, nowMs: number, plan: TickPlan): void {
  if (plan.type === "skip") return;
  const pressureVector = pressureVectorSnapshot(plan.pressures);
  try {
    writePressureDeltasForPreviousTrace(tick, pressureVector);
    const candidateId = planCandidateId(tick, plan);
    writeTickTrace({
      tick,
      occurredAtMs: nowMs,
      pressureVector,
      schedulerPhase: plan.type,
      selectedCandidateId: candidateId,
      silenceMarker: plan.type === "silent" ? plan.reason : null,
      sampleStatus: "real",
    });
    if (plan.type === "enqueue") {
      const selectedRank = plan.vmaxScored?.findIndex(
        (candidate) => candidate.action === plan.action && candidate.target === plan.target,
      );
      const selected =
        selectedRank !== undefined && selectedRank >= 0 ? plan.vmaxScored?.[selectedRank] : null;
      writeCandidateTrace({
        candidateId: candidateId ?? makeCandidateId(tick, plan.action, plan.target),
        tick,
        target: plan.target,
        actionType: plan.action,
        normalizedConsiderations: traceConsiderations(selected),
        deltaP: plan.deltaP ?? null,
        socialCost: plan.socialCost ?? null,
        netValue: plan.netValue,
        bottleneck: selected?.bottleneck ?? null,
        gatePlane: plan.reason === "directed_override" ? "directed_override" : "none",
        selected: true,
        candidateRank: selectedRank !== undefined && selectedRank >= 0 ? selectedRank : null,
        silenceReason: "N/A",
        sampleStatus: "real",
      });
      for (const [rank, candidate] of (plan.vmaxScored ?? []).entries()) {
        if (rank === selectedRank) continue;
        writeCandidateTrace({
          candidateId: makeRankedCandidateId(tick, candidate.action, candidate.target, rank),
          tick,
          target: candidate.target,
          actionType: candidate.action,
          normalizedConsiderations: traceConsiderations(candidate),
          deltaP: candidate.deltaP,
          socialCost: candidate.socialCost,
          netValue: candidate.netValue,
          bottleneck: candidate.bottleneck,
          gatePlane: "iaus_competition",
          selected: false,
          candidateRank: rank,
          silenceReason: "lost_candidate",
          sampleStatus: "real",
        });
      }
    } else if (plan.type === "silent") {
      writeCandidateTrace({
        candidateId: candidateId ?? makeCandidateId(tick, plan.voice, plan.target),
        tick,
        target: plan.target,
        actionType: plan.voice,
        normalizedConsiderations: plan.values,
        deltaP: plan.values.deltaP ?? null,
        socialCost: plan.values.socialCost ?? null,
        netValue: plan.values.netValue ?? null,
        bottleneck: plan.reason,
        gatePlane: "policy",
        selected: false,
        candidateRank: null,
        silenceReason: plan.reason,
        retainedImpulse: plan.impulseToRetain ?? null,
        sampleStatus: plan.values.netValue == null ? "partial" : "real",
      });
      for (const [rank, candidate] of (plan.vmaxScored ?? []).entries()) {
        writeCandidateTrace({
          candidateId: makeRankedCandidateId(tick, candidate.action, candidate.target, rank),
          tick,
          target: candidate.target,
          actionType: candidate.action,
          normalizedConsiderations: traceConsiderations(candidate),
          deltaP: candidate.deltaP,
          socialCost: candidate.socialCost,
          netValue: candidate.netValue,
          bottleneck: candidate.bottleneck,
          gatePlane: "iaus_competition",
          selected: false,
          candidateRank: rank,
          silenceReason: "lost_candidate",
          sampleStatus: "real",
        });
      }
    }
  } catch (e) {
    log.warn("Failed to write ADR-258 observation spine", e);
  }
}

function isPostWakeupRecoveryActive(state: EvolveState, nowMs: number): boolean {
  return state.mode !== "wakeup" && (state.wakeupRecoveryUntilMs ?? 0) > nowMs;
}

/** ADR-248 W1: EVOLVE decision_trace 写入。只写审计事实，不参与控制流。 */
function recordEvolveDecisionTrace(tick: number, plan: TickPlan): void {
  if (plan.type === "skip") return;

  const payload: DecisionTracePayload = {
    pressureOutput: pressureTracePayload(plan.pressures),
    selectedVoice: plan.voice,
    selectedAction:
      plan.type === "enqueue" ? plan.action : plan.type === "system1" ? plan.decision.action : null,
    gateResults: [{ verdict: formatGateVerdict(plan) }],
  };

  if (plan.type === "enqueue") {
    payload.candidates = plan.vmaxScored;
    payload.netValue = plan.netValue;
    payload.deltaP = plan.deltaP ?? null;
    payload.socialCost = plan.socialCost ?? null;
    payload.selectedProbability = plan.selectedProbability ?? null;
    payload.facetId = plan.facetId ?? null;
    payload.reason = plan.reason ?? null;
  } else if (plan.type === "silent") {
    payload.silenceLevel = plan.level;
    payload.values = plan.values;
    payload.reason = plan.reason;
    payload.retainedImpulse = plan.impulseToRetain ?? null;
  } else {
    payload.reason = `system1:${plan.decision.action}`;
  }

  try {
    writeDecisionTrace({
      tick,
      phase: "evolve",
      target: "target" in plan ? plan.target : null,
      finalDecision:
        plan.type === "enqueue" ? "enqueue" : plan.type === "silent" ? "silence" : "execute",
      reason: formatGateVerdict(plan),
      payload,
    });
  } catch (e) {
    log.warn("Failed to write evolve decision trace", e);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// computeTickPlan — 纯函数管线
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 纯函数：G → P(G,n) → τ(e) → (L, E_v) → gates → TickPlan
 * 不执行任何副作用（不写 DB、不 dispatch、不 enqueue）。
 *
 * @see paper/ §3: P_k(G, n) = f_k(G, n)
 * @see paper-five-dim/ Def 3.6: L_v = π_v × mean(R_v(τ(e))) + ε_v
 * @see paper/ Def 9: V(a,n) = ΔP - λ·C_social
 */
function computeTickPlan(
  state: EvolveState,
  tick: number,
  nowMs: number,
  lastEventCount = 0,
): TickPlan {
  const { G, personality, config } = state;

  // ADR-195 D6: LLM 全熔断 → 跳过整个管线（消除 tick 风暴）
  // 所有 provider 熔断时 IAUS 评分结果不变（图状态未变）→ 必定入队 → 必定失败。
  // 直接 skip 避免 CPU 开销和无意义的 tick_log 记录。
  if (!isAnyProviderHealthy()) {
    return { type: "skip", reason: "llm_all_circuit_open" };
  }

  // D1: P(G, n) — 六力计算
  // ADR-112 D4: 使用自适应 κ（当前值 ≥ kappaMin）
  // @see paper/ §3 eq 1-6
  const effectiveKappa = state.adaptiveKappa.current();
  const pressures = computeAllPressures(G, tick, {
    kappa: effectiveKappa,
    threadAgeScale: config.threadAgeScale,
    mu: config.mu,
    d: config.d,

    deltaDeadline: config.delta,
    history: state.pressureHistory,
    nowMs,
    eta: config.eta,
    // ADR-161 §3.4: 群组轨迹驱动 theta — 从 channelRateEma 推导 P3 群组 theta
    channelRateEma: state.channelRateEma,
    tickDt: state.currentDt,
  });
  // 更新 EMA（下一 tick 使用更新后的 κ）
  // 审计修复: 传入 tick 间隔（秒），使 EMA 半衰期基于墙钟时间而非 tick 计数。
  state.adaptiveKappa.update(
    [pressures.P1, pressures.P2, pressures.P3, pressures.P4, pressures.P5, pressures.P6],
    state.currentDt,
  );

  // ADR-147 D7: 洪水条件下 P1 soft cap — 防止多频道聚合爆炸，但不抑制正常处理
  // 积压的预期行为是像真人一样正常处理，不是忽略。D5 的时间衰减已足够；
  // cap 只防极端异常（长断线 × 超多频道 → P1 远超正常水平的场景）。
  // cap = max(5 × 历史 P1 均值, 3 × κ₁) — 宽松上限，给 Alice 充分注意力预算。
  // @see docs/adr/147-flood-backlog-recovery.md §D7
  if (isFloodCondition(state, lastEventCount)) {
    state.floodTickCount++;
    // D12: 排除最近洪水 tick 的 P1 值，避免 cap 自膨胀
    const safeHistory =
      state.floodTickCount > 0
        ? state.pressureHistory.slice(
            0,
            Math.max(0, state.pressureHistory.length - state.floodTickCount),
          )
        : state.pressureHistory;
    const histP1 = safeHistory.map((h) => h[0]);
    const avgP1 = histP1.length > 0 ? histP1.reduce((a, b) => a + b, 0) / histP1.length : 0;
    const p1Cap = Math.max(5 * avgP1, 3 * effectiveKappa[0]);
    if (pressures.P1 > p1Cap) {
      log.info("Flood P1 cap applied", { rawP1: pressures.P1, cap: p1Cap });
      pressures.P1 = p1Cap;
    }
    // ADR-190: P3 洪水保护（与 P1 D7 对称）— 防止关系压力在积压期聚合爆炸
    // @see docs/adr/190-wakeup-mode.md §P3 洪水保护
    const histP3 = safeHistory.map((h) => h[2]);
    const avgP3 = histP3.length > 0 ? histP3.reduce((a, b) => a + b, 0) / histP3.length : 0;
    const p3Cap = Math.max(5 * avgP3, 3 * effectiveKappa[2]);
    if (pressures.P3 > p3Cap) {
      log.info("Flood P3 cap applied", { rawP3: pressures.P3, cap: p3Cap });
      pressures.P3 = p3Cap;
    }
  } else {
    state.floodTickCount = 0;
  }

  // ADR-190: Wakeup 阻尼 — P3 按 α_w 逐渐恢复
  // α_w(n) = min(1, wakeupTicksElapsed / N_wakeup)
  // 聚合值 + per-entity contributions 同步缩放（下游 tensionMap / IAUS 都使用贡献）
  const isWakeup = state.mode === "wakeup";
  if (isWakeup) {
    const alphaW = Math.min(1, state.wakeupTicksElapsed / config.wakeupGraduationTicks);
    pressures.P3 *= alphaW;
    if (alphaW < 1 && pressures.contributions.P3) {
      for (const key of Object.keys(pressures.contributions.P3)) {
        pressures.contributions.P3[key] *= alphaW;
      }
    }
  }

  // ρ: V → V_A — 贡献路由：将非可行动实体投影到可行动频道。
  // P3→contact, P4→thread, P2→info_item, P6→contact 路由到 channel:* 频道。
  // 所有下游（张力 Map, 焦点集, V-maximizer, 注意力负债）使用路由后的贡献。
  // @see docs/adr/101-contribution-routing.md
  const routed = routeContributions(pressures.contributions, pressures.prospectContributions, G);

  // ADR-100: 更新注意力负债 — 从 contributions 中提取 per-entity 总压力
  // channelPressures: entity → Σ_k contributions[Pk][entity]（所有维度累加）
  // @see docs/adr/100-attention-debt.md §9
  const channelPressures = new Map<string, number>();
  for (const dimContribs of Object.values(routed.contributions)) {
    for (const [eid, val] of Object.entries(dimContribs)) {
      channelPressures.set(eid, (channelPressures.get(eid) ?? 0) + Math.abs(val));
    }
  }
  // P_prospect 单独加入
  for (const [eid, val] of Object.entries(routed.prospectContributions)) {
    channelPressures.set(eid, (channelPressures.get(eid) ?? 0) + Math.abs(val));
  }
  // ADR-215: Residue → channelPressures 注入。
  // 从 DB 刷新缓存（act 线程可能写入了新 residue），然后注入压力竞争。
  state.episodeState.activeResidues = refreshResidueCache(nowMs);
  injectResidueContributions(state.episodeState.activeResidues, channelPressures, nowMs);

  // 构造 lastIncomingMs map：频道最后收到消息的墙钟时间。
  // 超过 7 天无新消息的频道仅衰减 debt，不累积——消息驱动注意力。
  const lastIncomingMs = new Map<string, number>();
  for (const chId of G.getEntitiesByType("channel")) {
    const ms = Number(G.getChannel(chId).last_incoming_ms ?? 0);
    if (ms > 0) lastIncomingMs.set(chId, ms);
  }
  state.attentionDebtMap = updateAttentionDebt(
    state.attentionDebtMap,
    channelPressures,
    state.lastSelectedTarget,
    config.attentionDebt,
    state.currentDt,
    lastIncomingMs,
    nowMs,
  );

  // ADR-181: 注入风险信号到张力向量（R_Caution 的 τ_risk 分量）
  const riskContribs: Record<string, number> = {};
  for (const chId of G.getEntitiesByType("channel")) {
    const risk = effectiveRisk(G, chId, nowMs);
    if (risk > 0) riskContribs[chId] = risk;
  }

  // ADR-178: 注入吸引力信号到张力向量
  const attractionContribs: Record<string, number> = {};
  for (const chId of G.getEntitiesByType("channel")) {
    const cId = chatIdToContactId(chId);
    if (!cId || !G.has(cId)) continue;
    const rvAttraction = G.getContact(cId).rv_attraction ?? 0;
    if (rvAttraction > 0) attractionContribs[chId] = rvAttraction;
  }

  // ADR-191: 速率尖峰 → tauSpike（直接结构路径，替代 anomaly 线程）
  // @see docs/adr/191-anomaly-thread-elimination.md
  const spikeContribs: Record<string, number> = {};
  for (const [chId, count] of state.lastChannelCounts) {
    const stats = state.channelRateEma.get(chId);
    if (!stats || stats.variance < 0.01) continue;
    const z = (count - stats.ema) / Math.sqrt(stats.variance);
    if (z > 1.0) spikeContribs[chId] = z; // 只注入正向尖峰
  }

  // ADR-222: 适应性衰减 — 对 P5 以外的压力应用 ρ_H。
  // P5（义务）不衰减：对方在等回复时，饱和不应让 Alice 离开。
  // @see docs/adr/222-habituation-truth-model.md §Definition (Habituation Modulation)
  {
    const habAlpha = config.habituationAlpha;
    const habHL = config.habituationHalfLifeS;
    for (const pk of ["P1", "P2", "P3", "P4", "P6"] as const) {
      const pkContribs = routed.contributions[pk];
      if (!pkContribs) continue;
      for (const eid of Object.keys(pkContribs)) {
        if (!G.has(eid)) continue;
        const ch = G.getChannel(eid);
        const factor = computeHabituationFactor(
          ch.habituation ?? 0,
          ch.habituation_ms ?? 0,
          nowMs,
          habAlpha,
          habHL,
        );
        pkContribs[eid] *= factor;
      }
    }
    // prospect 也衰减
    for (const eid of Object.keys(routed.prospectContributions)) {
      if (!G.has(eid)) continue;
      const ch = G.getChannel(eid);
      const factor = computeHabituationFactor(
        ch.habituation ?? 0,
        ch.habituation_ms ?? 0,
        nowMs,
        habAlpha,
        habHL,
      );
      routed.prospectContributions[eid] *= factor;
    }
  }

  // ADR-225: Dormant 调制 ρ_C — 睡眠时全维度压力 ×0.1（含 P5）。
  // 与 habituation 正交：hab 是交互饱和度，dormant 是昼夜节律。
  if (state.mode === "dormant") {
    for (const pk of ["P1", "P2", "P3", "P4", "P5", "P6"] as const) {
      const pkContribs = routed.contributions[pk];
      if (!pkContribs) continue;
      for (const eid of Object.keys(pkContribs)) {
        pkContribs[eid] *= DORMANT_PRESSURE_FACTOR;
      }
    }
    for (const eid of Object.keys(routed.prospectContributions)) {
      routed.prospectContributions[eid] *= DORMANT_PRESSURE_FACTOR;
    }
  }

  // τ(e) = Pᵀ — 逐实体张力向量
  // @see paper/ §3.3: tension as transpose of contributions
  const tensionMap = buildTensionMap(
    routed.contributions,
    routed.prospectContributions,
    riskContribs,
    attractionContribs,
    spikeContribs,
  );

  // ADR-185 §1: Desire 派生 — tension → 显式目标
  const desires = deriveDesires(tensionMap, G, nowMs);

  // (L, E_v) = voice(τ, π) — 声部竞争 + 焦点集
  // @see paper-five-dim/ Def 3.6 eq 13
  const { loudness, focalSets } = computeLoudness(tensionMap, personality, G, tick, {
    recentEventCounts: state.recentEventCounts,
    // ADR-75: 声部疲劳 — 论文 Eq. voice-fatigue
    voiceLastWon: state.deliberation.voiceLastWon,
    targetWhitelist: config.focusWhitelist,
  });
  const [, action] = selectAction(loudness);

  const focal = focalSets[action];
  if (!focal) return { type: "skip", reason: "no_focal_set" };
  const target = focal.primaryTarget;

  // ADR-101: 路由后焦点集应只含 channel。非 channel 泄漏是上游 bug，此处防御
  if (target && G.has(target) && G.getNodeType(target) !== "channel") {
    log.warn("Non-channel primaryTarget leaked past routing", {
      target,
      type: G.getNodeType(target),
      action,
    });
    return { type: "skip", reason: "non_channel_target" };
  }

  // ADR-174: 从获胜声部选择 Persona Facet（人格面向）
  // facet 在整个 prompt 中留下可感知的人格指纹（guidance + whisper + example tags）
  const targetTier = (() => {
    if (!target || !G.has(target)) return null;
    const cId = chatIdToContactId(target);
    return cId && G.has(cId) ? (G.getContact(cId).tier as number | null) : null;
  })();
  const targetChatTypeForFacet =
    target && G.has(target) ? (G.getChannel(target).chat_type ?? "private") : "private";
  // ADR-206: channel target 回退 isGroup=false（private 模式）。
  // channel 被压力隔离压到极低 IAUS 评分，此路径几乎不可达。
  const isGroupForFacet =
    targetChatTypeForFacet === "group" || targetChatTypeForFacet === "supergroup";
  const facetCtx: FacetContext = {
    normalized: normalizePressuresForFacet(pressures, effectiveKappa),
    isGroup: isGroupForFacet,
    tier: targetTier,
  };
  const facet = selectFacet(action, facetCtx);

  // ── ADR-189: shouldBypassGates 已内化到 IAUS per-candidate pre-filter ──
  // 管线级 bypass 消除——每个候选自带 bypass 信号（computeCandidateBypass）。
  // isContinuation 仅保留给 System 1 快速路径使用。
  const isContinuation = target != null && isConversationContinuation(G, target, nowMs);

  // ADR-180: Engagement Exclusivity 已移入 IAUS retry loop。
  // ADR-136: Proactive cooldown 已折叠进 C_sat σ_cool 子组件。

  // Pre-gate chain — 空闲自启动
  // ADR-81: gateReflectionGuarantee 移除（Reflection 声部已消除）
  // ADR-190: wakeup 中不触发空闲自启动（真人起床翻消息，不主动发）
  // ADR-225: dormant 中不触发空闲自启动（睡着了不主动找事）
  // dt 迁移：空闲判断基于墙钟秒差
  const idleSinceActionS = (nowMs - state.lastActionMs) / 1000;
  const isDormant = state.mode === "dormant";
  const preGate =
    isWakeup || isDormant
      ? ({ type: "pass" } as const)
      : runGateChain([
          () =>
            gateIdleSelfStart(
              idleSinceActionS,
              config.idleThreshold,
              action,
              target,
              target != null ? focal.entities : [],
            ),
        ]);
  if (preGate.type === "act") {
    return {
      type: "enqueue",
      action: preGate.candidate.action,
      target,
      pressures,
      focalEntities: preGate.candidate.focalEntities,
      voice: action,
      netValue: preGate.candidate.netValue,
      facetId: facet.id,
    };
  }

  // System 1 快速路径
  const s1 = trySystem1(action, focalSets, G, tick, {
    leakProb: config.s10LeakProb,
    isConversationContinuation: isContinuation,
    nowMs, // ADR-124: effectiveObligation 需要墙钟时间
  });
  if (s1.handled) {
    return {
      type: "system1",
      decision: s1,
      pressures,
      voice: action,
      target,
      focalEntities: focal.entities,
    };
  }

  // ADR-186: hasActive() 全局锁已移除——替换为 per-target 排他。
  // IAUS 评分前通过 excludeTargets 预填充活跃 target（见下方），
  // IAUS retry loop 已有 per-target isTargetActive() 检查。
  // System 1 快速路径（mark_read 等）不受约束。

  // ADR-110: System 2 门控链 — 使用墙钟 ms 窗口
  const windowStartMs = nowMs - config.actionRateWindow * 1000;
  const recentInWindow = state.recentActions.filter((a) => a.ms > windowStartMs);
  const crisisChannels = typedQuery(state.dispatcher, "crisis_channels") ?? [];

  // ADR-113 F15: chat-type-aware 分类统计，rate_cap 和 active_cooling 共用。
  // 一次计算，两处复用——V-max 不改变 recentActions，同一 tick 内稳定。
  const classCounts = countActionsByClass(recentInWindow, G);
  // ADR-189: targetClass / convAware / postGate（gateClosingConversation, gateCrisisMode, gateRateCap）
  // 已内化到 IAUS per-candidate pre-filter。convAware 移到 IAUS winner 确定后。

  // ADR-180: IAUS 评分 — 乘法 Considerations 替代加法 NSV
  // V = CF(∏ U_k) — action_type × target 一步选出
  // @see docs/adr/180-iaus-phase2/README.md

  // API floor 门控 + Hawkes circadian 调制（candidateCtx 闭包依赖，需提前计算）
  const hour = state.utcHour ?? new Date().getUTCHours();
  const peakHourResult = typedQuery(state.dispatcher, "best_time");
  const circadian = circadianMultiplier(hour, config.timezoneOffset, peakHourResult?.peakHour);
  const effectiveFloor = G.tick < 100 ? 0.02 : config.actionRateFloor;

  const candidateCtx: CandidateContext = {
    G,
    nowMs,
    getRhythmTimingProfile: makeRhythmTimingProfileReader(),
    // ADR-153: Hawkes 对话热度 discount — λ(t) 高 → discount 低 → 社交成本降低
    getHawkesDiscount: (target: string) => {
      if (!G.has(target)) return 1.0;
      const chAttrs = G.getChannel(target);
      const chatType = chAttrs.chat_type ?? "private";
      const isGroupChat = ChatTarget.isGroupChat(chatType);

      // 私聊：contact Hawkes + Phase 2 在线校准 + 昼夜调制
      if (!isGroupChat) {
        const cId = chatIdToContactId(target);
        if (!cId || !G.has(cId)) return 1.0;
        const contact = G.getContact(cId);
        if (contact.hawkes_last_event_ms == null) return 1.0;
        const baseParams = getHawkesParams(contact.tier, false);
        const effMu = effectiveMu(
          baseParams.mu,
          contact.hawkes_event_count,
          contact.hawkes_first_event_ms,
          nowMs,
          circadian,
        );
        const effParams: HawkesParams = { ...baseParams, mu: effMu };
        const hState: HawkesState = {
          lambdaCarry: contact.hawkes_carry ?? 0,
          lastEventMs: contact.hawkes_last_event_ms ?? 0,
        };
        return computeHawkesLambdaDiscount(queryIntensity(effParams, hState, nowMs));
      }

      // 群组：channel Hawkes + 昼夜调制
      if (chAttrs.hawkes_last_event_ms == null) return 1.0;
      const baseParams = getHawkesParams(chAttrs.tier_contact, true);
      const effMu = effectiveMu(baseParams.mu, undefined, undefined, undefined, circadian);
      const effParams: HawkesParams = { ...baseParams, mu: effMu };
      const hState: HawkesState = {
        lambdaCarry: chAttrs.hawkes_carry ?? 0,
        lastEventMs: chAttrs.hawkes_last_event_ms ?? 0,
      };
      return computeHawkesLambdaDiscount(queryIntensity(effParams, hState, nowMs));
    },
    // ADR-154: Goldilocks 效用 — 窗口外抑制 proactive ΔP，窗口内放行。
    // 死区（Hawkes 衰减完毕 ~ Goldilocks tMin 之前）是正确行为：
    // 刚聊完的人不需要在冷却期内被主动联系。义务消息通过 bypassGates 不受影响。
    // @see docs/adr/154-goldilocks-window/README.md §5.4
    getGoldilocksUtility: (target: string) => {
      if (!G.has(target)) return 1.0;
      const chAttrs = G.getChannel(target);

      // silence 时间：从 channel 最后活动算起
      const lastActivityMs = Number(chAttrs.last_activity_ms ?? 0);
      if (lastActivityMs <= 0) return 1.0; // 无交互记录 → 不限制
      const silenceS = Math.max(0, (nowMs - lastActivityMs) / 1000);

      // 获取 tier
      const cId = chatIdToContactId(target);
      const tier: DunbarTier =
        cId && G.has(cId)
          ? (G.getContact(cId).tier as DunbarTier)
          : (chAttrs.tier_contact as DunbarTier);

      // 可选：EMA 自适应 + σ² 不确定性加宽
      const ema = cId && G.has(cId) ? G.getContact(cId).ema_contact_interval_s : undefined;
      const sigma2 = cId ? G.beliefs.getOrDefault(cId, "tier").sigma2 : undefined;

      // ADR-191: 群组折扣已移除。bypass 通道使私聊免疫折扣，
      // 导致单方面惩罚群聊。Social Cost 系统已结构性区分群聊/私聊。
      return computeGoldilocksUtility(silenceS, tier, ema, sigma2);
    },
  };

  // ── IAUS scoring + post-gates retry loop ─────────────────────────────────
  // ADR-180: IAUS 评分替代 V-max。per-target rate limit 拦截时重试。
  // ADR-186: 预排除已有活跃 engagement 的 target（替代全局锁）。
  const excludedTargets = new Set<string>(state.queue.getActiveTargets());
  const MAX_PER_TARGET_RETRIES = 3;

  // 全局不确定性（U_conflict_avoidance 基线）— ADR-112 D3: 含环境不确定性
  const uncertainty = computeUncertainty(state.recentEventCounts, 10, 2.0, G);

  const iausConfig: IAUSConfig = {
    candidateCtx,
    kappa: config.kappa,
    contributions: routed.contributions,
    beliefs: G.beliefs,
    beliefGamma: config.beliefGamma,
    thompsonEta: config.thompsonEta,
    socialCost: config.socialCost,
    saturationCost: config.saturationCost,
    windowStartMs,
    uncertainty,
    personality,
    voiceLastWon: state.deliberation.voiceLastWon,
    nowMs,
    targetWhitelist: config.focusWhitelist,
    deterministic: config.iausDeterministic,
    // ADR-182 D1: Momentum Bonus
    lastWinner: state.lastSelectedCandidate,
    lastActionMs: state.lastActionMs,
    momentumBonus: config.momentumBonus,
    momentumDecayMs: config.momentumDecayMs,
    // ADR-183: 人格驱动曲线调制
    curveModulationStrength: config.curveModulationStrength,
    // ADR-185 §1: Desire Boost
    desires,
    desireBoost: config.desireBoost,
    // ADR-218 Phase 2: attentionDebtMap/Config 不再传入 IAUS（U_coverage → U_fairness）。
    // debt 累积仍在 evolve 中维护（压力监控 + channelPressures 输入）。
    // ADR-189: Gate 内化到 IAUS per-candidate pre-filter
    crisisChannels,
    classRateCaps: config.rateCap,
    classActionCounts: classCounts,
  };

  let iausResult = scoreAllCandidates(tensionMap, G, tick, state.recentActions, iausConfig);
  let lastIausScored: IAUSScoredCandidate[] | undefined = iausResult?.scored;
  let perTargetRetryCount = 0;
  let postWakeupRecoverySuppression: {
    action: VoiceAction;
    target: string | null;
    bestV: number;
    deltaP: number;
    socialCost: number;
    focalEntities: string[];
  } | null = null;
  let queueBackpressureSuppression: {
    action: VoiceAction;
    target: string | null;
    bestV: number;
    deltaP: number;
    socialCost: number;
    focalEntities: string[];
    metrics: ReturnType<ActionQueue["getMetrics"]>;
  } | null = null;

  // eslint-disable-next-line no-constant-condition
  while (iausResult) {
    lastIausScored = iausResult.scored;
    const { candidate: best, bestV } = iausResult;

    // Engagement Exclusivity: IAUS 赢家的 target 可能已有活跃 engagement。
    if (best.target && state.queue.isTargetActive(best.target)) {
      if (perTargetRetryCount < MAX_PER_TARGET_RETRIES) {
        excludedTargets.add(best.target);
        perTargetRetryCount++;
        log.debug("IAUS winner target already active, retrying with exclusion", {
          excluded: best.target,
          retry: perTargetRetryCount,
        });
        iausResult = scoreAllCandidates(tensionMap, G, tick, state.recentActions, {
          ...iausConfig,
          excludeTargets: excludedTargets,
        });
        lastIausScored = iausResult?.scored ?? lastIausScored;
        continue;
      }
      iausResult = null;
      break; // 重试耗尽 → directedCandidate fallback
    }

    // ADR-190: Wakeup 目标多样性限流 — 每 tick 最多 1 个新主动目标
    // 义务驱动（winnerBypassGates）或已接触过的目标不受限
    if (isWakeup && best.target && !iausResult.winnerBypassGates) {
      if (!state.wakeupEngagedTargets.has(best.target) && state.wakeupEngagedTargets.size > 0) {
        log.info("Wakeup diversity throttle — suppressing new proactive target", {
          target: best.target,
          engaged: state.wakeupEngagedTargets.size,
        });
        iausResult = null;
        break; // → directedCandidate fallback（义务消息仍可通过）
      }
    }

    // Post-wakeup recovery: wakeup 毕业后短时间仍保留“先处理已打开目标”的惯性。
    // 只压普通 proactive 的新目标扩散；directed / continuation bypass 不受影响。
    if (
      isPostWakeupRecoveryActive(state, nowMs) &&
      best.target &&
      !iausResult.winnerBypassGates &&
      !state.wakeupEngagedTargets.has(best.target) &&
      state.wakeupEngagedTargets.size >= POST_WAKEUP_RECOVERY_TARGET_BUDGET
    ) {
      log.info("Post-wakeup recovery — suppressing new proactive target", {
        target: best.target,
        engaged: state.wakeupEngagedTargets.size,
        recoveryRemainingMs: Math.max(0, (state.wakeupRecoveryUntilMs ?? 0) - nowMs),
      });
      postWakeupRecoverySuppression = {
        action: best.action,
        target: best.target ?? null,
        bestV,
        deltaP: best.deltaP,
        socialCost: best.socialCost,
        focalEntities: best.focalEntities,
      };
      iausResult = null;
      break; // → directedCandidate fallback；无义务则记录 post_wakeup_recovery
    }

    // ADR-252 Wave 1: Queue/ACT 背压属于 Execution Resource Plane。
    // 只抑制普通 proactive 赢家；directed / continuation 等 bypass 义务继续入队。
    {
      const queueMetrics = state.queue.getMetrics();
      if (
        !iausResult.winnerBypassGates &&
        queueMetrics.saturation >= IAUS_QUEUE_BACKPRESSURE_SATURATION
      ) {
        log.info("IAUS queue backpressure — suppressing non-bypass winner", {
          target: best.target,
          action: best.action,
          saturation: queueMetrics.saturation,
          active: queueMetrics.active,
          maxDepth: queueMetrics.maxDepth,
        });
        queueBackpressureSuppression = {
          action: best.action,
          target: best.target ?? null,
          bestV,
          deltaP: best.deltaP,
          socialCost: best.socialCost,
          focalEntities: best.focalEntities,
          metrics: queueMetrics,
        };
        iausResult = null;
        break; // → directedCandidate fallback；无义务则走普通沉默路径
      }
    }

    // VoI(null) — 观望是否比行动更好
    // ADR-189: convAware 使用 IAUS winner 的 target（而非 Voice target）
    // ADR-75: 沉默积累衰减——墙钟时间替代 tick 计数，conversation mode 不再 20x 加速衰减
    // @see paper-pomdp/ Def 5.3
    const voiNull = computeVoINull(best.focalEntities, G.beliefs, tick);
    const convAware = gateConversationAware(G, best.target ?? null);
    const voiMultiplier = convAware.silenceBoost ? 2.0 : 1.0;
    const silenceDurationS = (nowMs - state.lastActionMs) / 1000;
    const silenceDecay = 1 / (1 + silenceDurationS * SILENCE_VOI_DECAY_RATE);
    const effectiveVoI = voiNull * voiMultiplier * silenceDecay;
    if (effectiveVoI > bestV && bestV > 0) {
      const silLvl = classifySilence(
        pressures.API,
        config.actionRateFloor,
        bestV,
        effectiveVoI,
        false,
      );
      return {
        type: "silent",
        pressures,
        voice: best.action,
        target: best.target ?? null,
        reason: "voi_deferred",
        level: silLvl,
        values: silenceValuesFromCandidate(best, bestV, pressures.API),
        focalEntities: best.focalEntities,
        vmaxScored: iausResult.scored,
        impulseToRetain:
          best.netValue >= IMPULSE_MIN_VALUE
            ? {
                action: best.action,
                target: best.target ?? "",
                netValue: best.netValue,
                originTick: tick,
                originMs: nowMs,
              }
            : undefined,
      };
    }

    // API floor 门控（Circadian 调制）
    // @see paper-five-dim/ Axiom 4: silence when V ≤ 0
    // ADR-180: post-IAUS bypass 使用 IAUS 赢家的信号。
    const apiVerdict = gateAPIFloor(
      pressures.API,
      effectiveFloor,
      circadian,
      iausResult.winnerBypassGates,
      bestV,
    );
    if (apiVerdict.type === "silent") {
      const silLvl = classifySilence(
        pressures.API,
        effectiveFloor * circadian,
        bestV,
        voiNull,
        false,
      );
      return {
        type: "silent",
        pressures,
        voice: best.action,
        target: best.target ?? null,
        reason: apiVerdict.reason,
        level: silLvl,
        values: silenceValuesFromCandidate(best, bestV, pressures.API, apiVerdict.values ?? {}),
        focalEntities: best.focalEntities,
        vmaxScored: iausResult.scored,
      };
    }

    // ADR-160 Fix C: chat-type-aware active cooling。
    // ADR-113 F15: 复用 classifyChatType + classCounts。
    // ADR-189: 传入 isBot 区分 bot scope。
    // @see docs/adr/158-outbound-feedback-gap.md §Fix C
    {
      const winnerClass = classifyChatType(
        best.target && G.has(best.target) ? G.getChannel(best.target).chat_type : undefined,
        best.target ? resolveIsBot(G, best.target) : undefined,
      );
      const coolVerdict = gateActiveCooling(
        classCounts[winnerClass],
        config.socialCost.lambdaC,
        iausResult.winnerBypassGates,
        pressures.API,
      );
      if (coolVerdict.type === "silent") {
        const silLvl = classifySilence(pressures.API, config.actionRateFloor, bestV, 0, true);
        return {
          type: "silent",
          pressures,
          voice: best.action,
          target: best.target ?? null,
          reason: coolVerdict.reason,
          level: silLvl,
          values: silenceValuesFromCandidate(best, bestV, pressures.API, coolVerdict.values ?? {}),
          focalEntities: best.focalEntities,
          vmaxScored: iausResult.scored,
        };
      }
    }

    // ADR-189: per-target rate limit 已内化到 IAUS per-candidate pre-filter。

    break; // 所有门控通过
  }

  if (!iausResult) {
    // ADR-180: directedFallback — 遍历所有 channel 实体的 obligation，选最高义务 target 入队。
    // 替代 selectTopK(loudness)：直接遍历所有 channel，更全面。
    const directedCandidate = (() => {
      let bestTarget: string | null = null;
      let bestObligation = 0;
      let bestAction: VoiceAction = action;
      let bestFocalEntities = focal.entities;
      for (const chId of G.getEntitiesByType("channel")) {
        if (!G.has(chId)) continue;
        if (G.getChannel(chId).failure_type === "permanent") continue;
        // ADR-136: 保留软性过滤：effectiveActSilences > 5 仍跳过（极端失败场景的安全网）。
        const effSilences = effectiveActSilences(G, chId, nowMs);
        if (effSilences > ACT_SILENCE_SAFETY_THRESHOLD) continue;
        // Engagement Exclusivity: 目标已有活跃 engagement 则跳过
        if (state.queue.isTargetActive(chId)) continue;
        // leave() 告别承诺：closing 中的对话跳过
        if (gateClosingConversation(G, chId).type === "silent") continue;
        // 显式义务
        const obligation = effectiveObligation(G, chId, nowMs);
        if (obligation > bestObligation) {
          bestObligation = obligation;
          bestTarget = chId;
          bestAction = "diligence"; // 义务驱动默认 diligence
          bestFocalEntities = [chId];
        }
        // 隐式对话延续（低于 directed 但非零）
        if (bestObligation < 0.01 && isConversationContinuation(G, chId, nowMs)) {
          bestTarget = chId;
          bestAction = "diligence";
          bestFocalEntities = [chId];
          bestObligation = 0.01;
        }
      }
      // ADR-189: consecutive_outgoing 硬上限——directedCandidate 不再绕过连发 cap
      // ADR-189 蟑螂审计 Fix 1: 强义务（effectiveObligation > θ_bypassGates）跳过 outgoing cap，
      // 弱义务（conversation continuation，bestObligation ≈ 0.01）仍受 cap 约束。
      // @see docs/adr/189-gate-iaus-unification.md §蟑螂审计
      const isStrongObligation = bestObligation > OBLIGATION_THRESHOLDS.bypassGates;
      if (bestTarget && G.has(bestTarget) && !isStrongObligation) {
        const outgoing = Number(G.getChannel(bestTarget).consecutive_outgoing ?? 0);
        const cls = classifyChatType(
          G.getChannel(bestTarget).chat_type,
          resolveIsBot(G, bestTarget),
        );
        const hardCap =
          cls === "group"
            ? config.saturationCost.outgoingCapGroup
            : config.saturationCost.outgoingCapPrivate;
        if (outgoing >= hardCap) {
          bestTarget = null; // reject — 连发硬上限
        }
      }
      return bestTarget
        ? { target: bestTarget, action: bestAction, focalEntities: bestFocalEntities }
        : null;
    })();

    if (directedCandidate) {
      // 熔断器全开时不强制行动——LLM 不可用，强制 enqueue 只会空转浪费 tick
      // @see docs/adr/156-emotional-reactivity-damping.md — 级联故障分析
      if (!isAnyProviderHealthy()) {
        log.warn("IAUS directed but all LLM providers circuit-open — suppressing", {
          target: directedCandidate.target,
        });
      } else {
        log.info("IAUS all filtered but directed — forcing action", {
          target: directedCandidate.target,
          voice: directedCandidate.action,
        });
        return {
          type: "enqueue",
          action: directedCandidate.action,
          target: directedCandidate.target,
          pressures,
          voice: directedCandidate.action,
          reason: "directed_override",
          focalEntities: directedCandidate.focalEntities,
          netValue: 0.01,
          vmaxScored: lastIausScored,
          facetId: facet.id,
        };
      }
    }

    if (postWakeupRecoverySuppression) {
      const {
        action: suppressedAction,
        bestV,
        deltaP,
        focalEntities,
        socialCost,
        target: suppressedTarget,
      } = postWakeupRecoverySuppression;
      const silLvl = classifySilence(pressures.API, config.actionRateFloor, bestV, 0, true);
      return {
        type: "silent",
        pressures,
        voice: suppressedAction,
        target: suppressedTarget,
        reason: "post_wakeup_recovery",
        level: silLvl,
        values: { netValue: bestV, deltaP, socialCost, apiValue: pressures.API },
        focalEntities,
        vmaxScored: lastIausScored,
      };
    }

    if (queueBackpressureSuppression) {
      const {
        action: suppressedAction,
        bestV,
        deltaP,
        focalEntities,
        metrics,
        socialCost,
        target: suppressedTarget,
      } = queueBackpressureSuppression;
      const silLvl = classifySilence(pressures.API, config.actionRateFloor, bestV, 0, true);
      return {
        type: "silent",
        pressures,
        voice: suppressedAction,
        target: suppressedTarget,
        reason: "queue_backpressure",
        level: silLvl,
        values: {
          netValue: bestV,
          deltaP,
          socialCost,
          apiValue: pressures.API,
          queueQueued: metrics.queued,
          queueProcessing: metrics.processing,
          queueActive: metrics.active,
          queueSaturation: metrics.saturation,
          queueBackpressureThreshold: IAUS_QUEUE_BACKPRESSURE_SATURATION,
        },
        focalEntities,
        vmaxScored: lastIausScored,
      };
    }

    // 所有候选被过滤 — 沉默
    const actSilences = target && G.has(target) ? effectiveActSilences(G, target, nowMs) : 0;
    const silLvl = classifySilence(pressures.API, config.actionRateFloor, 0, 0, false);
    return {
      type: "silent",
      pressures,
      voice: action,
      target,
      reason:
        actSilences >= SILENCE_COOLDOWN_THRESHOLD ? "silence_cooldown" : "all_candidates_negative",
      level: silLvl,
      values: { apiValue: pressures.API },
      focalEntities: focal.entities,
      vmaxScored: lastIausScored,
    };
  }

  const { candidate: best, bestV } = iausResult;

  // 所有门控通过 — IAUS 赢家入队
  // 论文 L5: degraded action 通过 reason 传递到 act 层，约束 LLM 输出简短回复
  const finalVoiNull = computeVoINull(best.focalEntities, G.beliefs, tick);
  const topDesire = best.target ? findTopDesireForTarget(desires, best.target) : undefined;
  const baseReason = assembleIAUSReason(
    best,
    pressures.API,
    finalVoiNull,
    iausResult.selectedProbability,
    topDesire,
  );
  return {
    type: "enqueue",
    action: best.action,
    target: best.target ?? null,
    pressures,
    focalEntities: best.focalEntities,
    voice: action,
    netValue: bestV,
    reason: best.degraded ? `degraded_action, ${baseReason}` : baseReason,
    // ADR-115: IAUS trace
    deltaP: best.deltaP,
    socialCost: best.socialCost,
    selectedProbability: iausResult.selectedProbability,
    // D8: fan-out 用
    vmaxScored: iausResult.scored,
    vmaxSpread: iausResult.spread,
    // ADR-174: 人格面向
    facetId: facet.id,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// applyPlan — 唯一的副作用出口
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 执行 TickPlan：DB 写入 + dispatcher 通知 + 队列操作。
 * 这是 evolve 管线中唯一有副作用的函数。
 */
function applyPlan(state: EvolveState, plan: TickPlan, tick: number, nowMs: number): boolean {
  // 1. Dispatcher 通知 + tick_log（所有非 skip 路径都需要）
  if (plan.type !== "skip") {
    const focalEntities = "focalEntities" in plan ? plan.focalEntities : [];
    state.dispatcher.dispatch("UPDATE_PRESSURES", {
      pressures: plan.pressures,
      focalEntities,
    });
    state.dispatcher.dispatch("SET_VOICE", { voice: plan.voice });
    // ADR-174: 传递 facet 选择结果到 soul.mod
    if (plan.type === "enqueue" && plan.facetId) {
      state.dispatcher.dispatch("SET_FACET", { facetId: plan.facetId });
    }

    try {
      // ADR-115: enqueue 路径携带 V-max trace，其他路径为 null
      // ADR-135 Change 5: silent plan 也记录 target，便于诊断被拦截的实际 target
      const trace =
        plan.type === "enqueue"
          ? {
              target: plan.target,
              netValue: plan.netValue,
              deltaP: plan.deltaP ?? null,
              socialCost: plan.socialCost ?? null,
              selectedProbability: plan.selectedProbability ?? null,
            }
          : {
              target: "target" in plan ? plan.target : null,
              netValue: null,
              deltaP: null,
              socialCost: null,
              selectedProbability: null,
            };

      const db = getDb();
      db.insert(tickLog)
        .values({
          tick,
          p1: plan.pressures.P1,
          p2: plan.pressures.P2,
          p3: plan.pressures.P3,
          p4: plan.pressures.P4,
          p5: plan.pressures.P5,
          p6: plan.pressures.P6,
          api: plan.pressures.API,
          apiPeak: plan.pressures.API_peak,
          action: plan.voice,
          ...trace,
          gateVerdict: formatGateVerdict(plan),
          mode: state.mode,
        })
        .run();
    } catch (e) {
      log.warn("Failed to write tick log", e);
    }
  }

  recordObservationSpineTick(tick, nowMs, plan);
  recordEvolveDecisionTrace(tick, plan);

  // 2. 按 plan 类型执行
  switch (plan.type) {
    case "skip":
      // ADR-100: 沉默 tick → 无选中目标
      state.lastSelectedTarget = null;
      state.lastSelectedCandidate = null;
      return false;

    case "enqueue": {
      enqueueAndRecord(
        state,
        tick,
        nowMs,
        plan.action,
        plan.target,
        plan.pressures,
        plan.focalEntities,
        plan.reason,
        plan.vmaxScored,
        plan.vmaxSpread,
        plan.facetId,
      );
      // ADR-75: 更新审议状态（声部疲劳 + 沉默清零 + 行动谱系）
      onActionEnqueued(state.deliberation, tick, plan.action, plan.target, plan.netValue, nowMs);
      // ADR-100: 记录选中目标，用于下一 tick 的 debt 累积判断
      state.lastSelectedTarget = plan.target;
      // ADR-182 D1: 记录 (action, target) 用于下一 tick 的 Momentum Bonus
      state.lastSelectedCandidate = plan.target
        ? { action: plan.action, target: plan.target }
        : null;

      // ADR-180: consecutive_caution_acts 追踪已移除——IAUS 不产出 "caution" action type，
      // Caution 已折叠为 U_conflict_avoidance 共享 Consideration。

      // ADR-190 + post-wakeup recovery: 追踪已接触目标，限制恢复期新目标扩散。
      if ((state.mode === "wakeup" || isPostWakeupRecoveryActive(state, nowMs)) && plan.target) {
        state.wakeupEngagedTargets.add(plan.target);
      }

      // ADR-222: 行动入队后递增 habituation H(v)。
      // 先衰减到当前时刻，再 +1.0（一次行动 = 一个 Dirac 脉冲）。
      if (plan.target && state.G.has(plan.target)) {
        const ch = state.G.getChannel(plan.target);
        const prevH = ch.habituation ?? 0;
        const prevMs = ch.habituation_ms ?? 0;
        const ageS = Math.max(0, (nowMs - prevMs) / 1000);
        const decayedH = prevH * 2 ** (-ageS / state.config.habituationHalfLifeS);
        state.G.updateChannel(plan.target, {
          habituation: decayedH + 1.0,
          habituation_ms: nowMs,
        });
      }

      log.info("Action enqueued", { tick, action: plan.action, target: plan.target });
      return true;
    }

    case "system1": {
      const { decision: s1 } = plan;
      if (s1.action === "mark_read" && s1.target && state.G.has(s1.target)) {
        state.G.updateChannel(s1.target, { unread: 0, unread_ewms: 0, recently_cleared_ms: nowMs });
        state.lastActionMs = nowMs;
      } else if (s1.action === "digest" && s1.target && state.G.has(s1.target)) {
        executeDigest(state.G, s1.target, tick, nowMs);
        state.lastActionMs = nowMs;
      }
      log.debug("System 1 handled", { tick, action: s1.action, target: s1.target });
      return s1.action === "mark_read" || s1.action === "digest";
    }

    case "silent":
      recordSilence(tick, plan.voice, plan.target, plan.reason, plan.values, plan.level);
      // ADR-75: 更新审议状态（沉默积累 + 冲动衰减）
      onSilence(state.deliberation, tick, plan.reason, nowMs);
      // ADR-75: VoI-deferred 的高 V 冲动保留（纯函数不能做，在这里做）
      if (plan.impulseToRetain) addImpulse(state.deliberation, plan.impulseToRetain);
      // ADR-100: 沉默 tick → 无选中目标
      state.lastSelectedTarget = null;
      state.lastSelectedCandidate = null;
      log.debug("Silence", { tick, voice: plan.voice, reason: plan.reason, level: plan.level });
      return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// updateSlidingWindows — 辅助函数
// ═══════════════════════════════════════════════════════════════════════════

function updateSlidingWindows(state: EvolveState, eventCount: number): void {
  state.recentEventCounts.push(eventCount);
  if (state.recentEventCounts.length > state.config.k) state.recentEventCounts.shift();
  if (state.noveltyHistory.length > state.config.k * 10)
    state.noveltyHistory.splice(0, state.noveltyHistory.length - state.config.k * 10);
}

// ═══════════════════════════════════════════════════════════════════════════
// ADR-215: 辅助 — 返回最高压力维度名
// ═══════════════════════════════════════════════════════════════════════════

function dominantDimension(p: AllPressures): string {
  const dims: [[string, number], ...[string, number][]] = [
    ["P1", p.P1],
    ["P2", p.P2],
    ["P3", p.P3],
    ["P4", p.P4],
    ["P5", p.P5],
    ["P6", p.P6],
  ];
  let best = dims[0];
  for (const d of dims) {
    if (d[1] > best[1]) best = d;
  }
  return best[0];
}

// ═══════════════════════════════════════════════════════════════════════════
// ADR-225: Dormant Mode 辅助函数
// ═══════════════════════════════════════════════════════════════════════════

/** 获取给定时间戳的本地小时。 */
function getLocalHour(nowMs: number, timezoneOffset: number): number {
  const utcHour = new Date(nowMs).getUTCHours();
  return (((utcHour + timezoneOffset) % 24) + 24) % 24;
}

/** 判断当前是否满足 dormant 入睡条件。 */
function shouldEnterDormant(api: number, nowMs: number, config: Config): boolean {
  const localHour = getLocalHour(nowMs, config.timezoneOffset);
  return (
    isInQuietWindow(localHour, config.quietWindowStart, config.quietWindowEnd) &&
    api < config.thetaDormantAPI
  );
}

/**
 * 判断是否有足够亲密的联系人发来 directed 消息（深夜叫醒 Alice）。
 * 遍历所有频道，检查 pending_directed > 0 且关联 contact tier < wakeTier。
 */
function hasDormantWakeSignal(G: WorldModel, nowMs: number, wakeTier: number): boolean {
  for (const chId of G.getEntitiesByType("channel")) {
    if (effectiveObligation(G, chId, nowMs) <= OBLIGATION_THRESHOLDS.modeEnter) continue;
    const contactId = chatIdToContactId(chId);
    if (!contactId || !G.has(contactId)) continue;
    const contact = G.getContact(contactId);
    if ((contact.tier ?? 500) < wakeTier) return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// Agent Mode FSM — 论文 §6.2 Definition 6.2
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 模态转换逻辑。每 tick 开头调用，返回新模态。
 *
 * 转换规则：
 * - patrol → conversation: directed 消息到达 + 高 P5（社交义务压力）→ 锁定 focus
 * - conversation → patrol: focus 沉默超过 θ_silence
 * - patrol → consolidation: API < θ_low 且 P2 > θ_mem
 * - consolidation → patrol: 完成或高优先级中断
 * - patrol/consolidation → dormant: quiet window + 低 API（ADR-225）
 * - dormant → patrol: 离开 quiet window 或亲密联系人 directed 消息
 *
 * @see paper/ §6.2 Definition 6.2
 * @see docs/adr/225-dormant-mode.md
 */
function transitionMode(
  state: EvolveState,
  api: number,
  p2: number,
  p5: number,
  nowMs: number,
): void {
  const { config, mode } = state;
  const now = nowMs;

  switch (mode) {
    // ADR-190: Wakeup 模态 — 重启后渐进恢复
    case "wakeup": {
      state.wakeupTicksElapsed++;
      // 毕业条件：足够 tick 且不在洪水中
      if (
        state.wakeupTicksElapsed >= config.wakeupGraduationTicks &&
        !isFloodCondition(state, state.recentEventCounts.at(-1) ?? 0)
      ) {
        state.mode = "patrol";
        state.focusTarget = undefined;
        state.modeEnteredMs = now;
        state.wakeupRecoveryUntilMs = now + POST_WAKEUP_RECOVERY_MS;
        log.info("Mode transition: wakeup → patrol (graduated)", {
          ticksElapsed: state.wakeupTicksElapsed,
          recoveryMs: POST_WAKEUP_RECOVERY_MS,
        });
      }
      // wakeup 期间不转换到其他模态
      break;
    }
    case "patrol": {
      // ADR-147 D8: 洪水条件下不进入 conversation mode — 保持 patrol 让 V-maximizer 全局调度。
      // 真人处理积压时会扫一遍全部频道再决定回谁，不会锁定第一个看到的。
      // 积压消化完毕后 isFloodCondition 恢复 false，正常 conversation 转换自动恢复。
      // @see docs/adr/147-flood-backlog-recovery.md §D8
      if (isFloodCondition(state, state.recentEventCounts.at(-1) ?? 0)) break;
      // → conversation: 有未回复的 directed 目标 + 社交压力高
      // ADR-124: 使用 effectiveObligation 阈值替代 pending_directed > 0
      // @see docs/adr/126-obligation-field-decay.md §D3
      if (p5 > 0.3) {
        const channels = state.G.getEntitiesByType("channel");
        for (const ch of channels) {
          if (effectiveObligation(state.G, ch, now) > OBLIGATION_THRESHOLDS.modeEnter) {
            state.mode = "conversation";
            state.focusTarget = ch;
            state.modeEnteredMs = now;
            log.info("Mode transition: patrol → conversation", { focusTarget: ch, p5 });
            return;
          }
        }
      }
      // → consolidation: 低压力 + 高记忆整理需求
      if (api < config.thetaLowAPI && p2 > config.thetaMem) {
        state.mode = "consolidation";
        state.focusTarget = undefined;
        state.modeEnteredMs = now;
        log.info("Mode transition: patrol → consolidation", { api, p2 });
        break;
      }
      // ADR-225: → dormant: quiet window + 低 API（没事做就去睡觉）
      if (shouldEnterDormant(api, now, config)) {
        state.mode = "dormant";
        state.focusTarget = undefined;
        state.modeEnteredMs = now;
        log.info("Mode transition: patrol → dormant", {
          api,
          localHour: getLocalHour(now, config.timezoneOffset),
        });
      }
      break;
    }
    case "conversation": {
      // → patrol: focus 沉默超时 或 focus 不存在
      if (!state.focusTarget || !state.G.has(state.focusTarget)) {
        state.mode = "patrol";
        state.focusTarget = undefined;
        state.modeEnteredMs = now;
        log.info("Mode transition: conversation → patrol (focus lost)");
        break;
      }
      const focusLastActivityMs = Number(
        state.G.getChannel(state.focusTarget).last_activity_ms ?? state.modeEnteredMs,
      );
      const silenceS = (now - focusLastActivityMs) / 1000;
      if (silenceS > config.thetaSilenceS) {
        state.mode = "patrol";
        state.focusTarget = undefined;
        state.modeEnteredMs = now;
        log.info("Mode transition: conversation → patrol (silence timeout)", { silenceS });
        break;
      }
      // ADR-124: 义务已衰减至阈值以下 → 退出对话模式（滞回）
      // θ_exit (0.1) < θ_enter (0.3) — 从结构上消除模式震荡
      // @see docs/adr/126-obligation-field-decay.md §D3
      if (
        state.focusTarget &&
        effectiveObligation(state.G, state.focusTarget, now) < OBLIGATION_THRESHOLDS.modeExit
      ) {
        state.mode = "patrol";
        state.focusTarget = undefined;
        state.modeEnteredMs = now;
        log.info("Mode transition: conversation → patrol (obligation decayed)");
        break;
      }
      // 高优先级中断：另一个 directed 比 focus 更紧急
      // （暂不实现——V-maximizer 的 focus boost 足以处理大多数情况）
      break;
    }
    case "consolidation": {
      // → patrol: API 恢复 或 高优先级中断
      if (api > config.thetaLowAPI * 2) {
        state.mode = "patrol";
        state.focusTarget = undefined;
        state.modeEnteredMs = now;
        log.info("Mode transition: consolidation → patrol (API restored)", { api });
        break;
      }
      // 长时间 consolidation 自动退出（最长 10 分钟）
      if ((now - state.modeEnteredMs) / 1000 > 600) {
        // ADR-225: consolidation 超时 + quiet window → 直接 dormant（不绕回 patrol）
        if (shouldEnterDormant(api, now, config)) {
          state.mode = "dormant";
          state.focusTarget = undefined;
          state.modeEnteredMs = now;
          log.info("Mode transition: consolidation → dormant (timeout + quiet window)");
        } else {
          state.mode = "patrol";
          state.focusTarget = undefined;
          state.modeEnteredMs = now;
          log.info("Mode transition: consolidation → patrol (timeout)");
        }
      }
      break;
    }
    // ADR-225: Dormant 模态 — 睡眠节律
    case "dormant": {
      const localHour = getLocalHour(now, config.timezoneOffset);
      const inQuiet = isInQuietWindow(localHour, config.quietWindowStart, config.quietWindowEnd);

      // 觉醒条件 1: 离开 quiet window（自然醒）
      if (!inQuiet) {
        // 觉醒后进 wakeup 模式，复用渐进恢复逻辑
        state.mode = "wakeup";
        state.focusTarget = undefined;
        state.modeEnteredMs = now;
        state.wakeupTicksElapsed = 0;
        state.wakeupEngagedTargets.clear();
        state.wakeupRecoveryUntilMs = undefined;
        log.info("Mode transition: dormant → wakeup (quiet window ended)", { localHour });
        break;
      }

      // 觉醒条件 2: 亲密联系人 directed 消息（被叫醒）
      if (hasDormantWakeSignal(state.G, now, config.dormantWakeTier)) {
        state.mode = "wakeup";
        state.focusTarget = undefined;
        state.modeEnteredMs = now;
        state.wakeupTicksElapsed = 0;
        state.wakeupEngagedTargets.clear();
        state.wakeupRecoveryUntilMs = undefined;
        log.info("Mode transition: dormant → wakeup (intimate directed)", { localHour });
        break;
      }

      // 保持 dormant — 不转换到其他模态
      break;
    }
  }
}

/** 行为洞察持久化间隔（秒）。 */
const BEHAVIORAL_INSIGHT_INTERVAL_S = 3600; // 1 小时
let lastBehavioralInsightMs = Date.now();

// ═══════════════════════════════════════════════════════════════════════════
// evolveTick — 精简主入口
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 执行一个 tick 的完整 EVOLVE 管线。
 * 返回是否入队了一个行动。
 *
 * 管线结构：
 * Phase 0: 模态转换
 * Phase 1: 图准备（压力计算前的必要突变）
 * Phase 2: 纯管线 — G → P → τ → (L, E_v) → gates → plan
 * Phase 3: 副作用边界（唯一的突变出口）
 * Phase 4: 快照（墙钟间隔 + OL-5 重试）
 */
export function evolveTick(state: EvolveState): boolean {
  const { tick, dt } = state.clock.advance();
  // ADR-110: 单源墙钟时间，同 tick 内所有子函数共享同一 nowMs
  const nowMs = Date.now();
  state.currentDt = dt;
  state.G.tick = tick;
  state.dispatcher.startTick(tick, nowMs);

  try {
    // Phase 1: 图准备（压力计算前的必要突变）
    appraiseLonelySilence(state.G, nowMs);
    updateEmotionStateOnGraph(state.G, nowMs);
    state.G.beliefs.decayAll(nowMs);
    const { eventCount, channelCounts } = perceiveTick(
      state.G,
      state.buffer,
      state.noveltyHistory,
      tick,
    );
    // ADR-191: 保存 channelCounts 供 computeTickPlan 计算 spike 信号
    state.lastChannelCounts = channelCounts;
    updateSlidingWindows(state, eventCount);
    // ADR-147 D2+D9: 积压检测（纯查询）+ EMA 单次更新
    const backlogDetected = detectBacklog(state, eventCount);
    if (backlogDetected) {
      log.warn("Backlog detected via EMA", { eventCount, ema: state.eventCountEma });
    } else {
      // D9: EMA 更新仅在此单点执行（detectBacklog 为纯查询，无副作用）
      state.eventCountEma = EMA_ALPHA * eventCount + (1 - EMA_ALPHA) * state.eventCountEma;
    }
    tickConversations(state.G, tick, nowMs);

    // Phase 1.5: ADR-115 内源性线程生成（perceive 之后、pressure 之前）
    // @see docs/adr/115-evolve-observability/
    // ADR-166: 传入实际 tick 墙钟秒数，连续时间 EMA 自适应 α
    updateChannelRateEma(state.channelRateEma, channelCounts, state.currentDt);
    runGenerators({
      G: state.G,
      db: getDb(),
      tick,
      nowMs,
      config: state.config,
      channelCounts,
      channelRateEma: state.channelRateEma,
      mode: state.mode, // ADR-225: dormant 时抑制周期生成器
    });

    // Phase 2: 纯管线 — G → P → τ → (L, E_v) → gates → plan
    const plan = computeTickPlan(state, tick, nowMs, eventCount);

    // 更新 lastAPI（供 startEvolveLoop 计算 interval 和 mode 转换使用）
    if (plan.type !== "skip") {
      // ADR-204 C5: 压力显著变化 emit
      const oldApi = state.lastAPI;
      state.lastAPI = plan.pressures.API;
      state.lastAPIPeak = plan.pressures.API_peak;
      if (Math.abs(plan.pressures.API - oldApi) > 0.15) {
        try {
          emitConsciousness(getDb(), tick, nowMs, {
            kind: "evolve:pressure",
            entityIds: plan.target ? [plan.target] : [],
            summary: plan.pressures.API > oldApi ? "things getting busier" : "things calming down",
          });
        } catch (e) {
          log.warn("consciousness pressure-emit failed", e);
        }
      }
      // Phase 0: 模态转换（使用当前 tick 计算的压力值）
      // 注意：transitionMode 继续使用总量 API——模态转换语义是"整体有多忙"，需要广延量。
      transitionMode(state, plan.pressures.API, plan.pressures.P2, plan.pressures.P5, nowMs);
    }

    // Phase 3: 副作用边界（唯一的突变出口）
    const prevMode = state.mode;
    const acted = applyPlan(state, plan, tick, nowMs);

    // Phase 3.1: ADR-215 — Episode 边界检测 + 更新
    if (plan.type !== "skip") {
      try {
        const planSnapshot = {
          type: plan.type,
          target: "target" in plan ? (plan.target ?? null) : null,
          voice: plan.voice,
          api: plan.pressures.API,
          dominantPressure: dominantDimension(plan.pressures),
          focalEntities: "focalEntities" in plan ? plan.focalEntities : [],
        };
        updateEpisode(state.episodeState, planSnapshot, tick, nowMs, state.mode !== prevMode);
      } catch (e) {
        log.warn("Episode update failed", e);
      }
    } else if (state.episodeState.currentId) {
      // skip plan 但有活跃 episode → 结束它
      try {
        updateEpisode(
          state.episodeState,
          {
            type: "skip",
            target: null,
            voice: "diligence",
            api: 0,
            dominantPressure: "P1",
            focalEntities: [],
          },
          tick,
          nowMs,
          false,
        );
      } catch (e) {
        log.warn("Episode close on skip failed", e);
      }
    }

    // Phase 3.5: ADR-204 — 意识流事件 emit（决策级）
    try {
      commitTickEvents(getDb(), tick, nowMs, plan);
    } catch (e) {
      log.warn("consciousness emit failed", e);
    }

    // Phase 4: 快照（墙钟间隔 + OL-5 重试）
    const now = Date.now();
    const timeSinceFlushS = (now - state.lastFlushMs) / 1000;
    if (timeSinceFlushS > state.config.snapshotIntervalS) {
      try {
        if (state.G.has(ALICE_SELF)) {
          state.G.updateAgent(ALICE_SELF, { runtime_last_seen_ms: now });
        }
        flushGraph(state.G);
        state.lastFlushMs = now;
      } catch (e) {
        log.error("Snapshot failed, will retry next tick", e);
        writeAuditEvent(tick, "error", "evolve", "snapshot_failed", {
          error: e instanceof Error ? e.message : String(e),
          timeSinceLastFlushS: timeSinceFlushS,
        });
        // OL-5: 不更新 lastFlushMs → 下个 tick 自动重试
      }
    }

    // Phase 5: 行为洞察持久化（墙钟间隔）
    if ((now - lastBehavioralInsightMs) / 1000 > BEHAVIORAL_INSIGHT_INTERVAL_S) {
      lastBehavioralInsightMs = now;
      try {
        const chatIds = state.G.getEntitiesByType("channel");
        persistBehavioralInsights(tick, state.dispatcher, chatIds);
      } catch (e) {
        log.warn("Failed to persist behavioral insights", e);
      }
    }

    // Phase 5.5: ADR-199 — 延迟反馈扫描（每 5 tick 执行）
    if (tick > 0 && tick % 5 === 0) {
      try {
        const pendings = scanPendingOutcomes(state.G, now);
        for (const p of pendings) {
          evaluateDeferredOutcome(state.G, p, now, tick);
        }
      } catch (e) {
        log.warn("Deferred outcome scan failed", e);
      }
    }

    // Phase 5.6: ADR-117 D6 — Fact GC + ADR-199 闭环体检 + ADR-204 意识流 GC（每 100 tick）
    if (tick > 0 && tick % 100 === 0) {
      try {
        gcExpiredFacts(state.G, now);
      } catch (e) {
        log.warn("Fact GC failed", e);
      }
      // ADR-204: 意识流 GC — 清理过期低 salience 事件
      try {
        const removed = gcConsciousness(getDb(), now);
        if (removed > 0) log.info("Consciousness GC", { removed });
      } catch (e) {
        log.warn("Consciousness GC failed", e);
      }
      // ADR-199 W4: 闭环健康度体检
      try {
        const health = computeClosureHealth(getDb(), 100);
        if (health.overallHealth !== "healthy") {
          writeAuditEvent(tick, "warn", "closure-health", health.issues.join("; "), {
            actionStateRatio: health.actionStateRatio,
            feelCoverage: health.feelCoverage,
            deferredEvalCount: health.deferredEvalCount,
            autoWritebackRatio: health.autoWritebackRatio,
            overallHealth: health.overallHealth,
            totalMessages: health.totalMessages,
          });
          log.warn("Closure health degraded", health);
        } else {
          log.info("Closure health OK", {
            actionStateRatio: health.actionStateRatio.toFixed(2),
            feelCoverage: health.feelCoverage.toFixed(2),
            totalMessages: health.totalMessages,
          });
        }
      } catch (e) {
        log.warn("Closure health check failed", e);
      }
    }

    // Phase 6: ADR-112 D5 — 自然性指标（每 50 tick 计算一次，低开销）
    if (tick > 0 && tick % 50 === 0) {
      const metrics = computeNaturalness(state.G, state.recentActions, now);
      if (metrics.idi !== null || metrics.vde !== null || metrics.rai !== null) {
        log.info("Naturalness metrics", {
          tick,
          idi: metrics.idi?.toFixed(3) ?? "n/a",
          vde: metrics.vde?.toFixed(3) ?? "n/a",
          rai: metrics.rai?.toFixed(3) ?? "n/a",
        });
      }
    }

    return acted;
  } finally {
    state.dispatcher.endTick(tick);
  }
}

// -- ADR-30: Self mood decay ------------------------------------------------

// -- M2: Circadian 调制器 --------------------------------------------------

/**
 * 昼夜节律门控乘数：按用户本地时间调整 API 下限门控。
 *
 * cos 曲线平滑过渡，无阶跃突变：
 *   multiplier = 1.5 - cos(2π × (localHour - peakHour) / 24)
 *
 *   peakHour → 0.5  (最活跃，门控最低)
 *   peakHour ± 12h → 2.5  (最安静，门控最高)
 *
 * 乘数越高 → floor 越高 → 需要更大压力才能通过门控 → 行动越少。
 *
 * ADR-34 F1: 接受时区偏移参数，避免服务器时区与用户时区错位。
 * ADR-47 G5: 接受 userPeakHour 参数，从用户活跃模式学习峰值小时。
 * @see docs/adr/47-gap-closure.md §G5
 */
export function circadianMultiplier(
  hour: number,
  timezoneOffset = 0,
  userPeakHour?: number,
): number {
  // hour 是 UTC 小时，加上偏移得到用户本地小时
  const localHour = (((hour + timezoneOffset) % 24) + 24) % 24;
  const peakHour = userPeakHour ?? 14; // 默认 14:00（无数据时向后兼容）
  const theta = (2 * Math.PI * (localHour - peakHour)) / 24;
  return 1.5 - Math.cos(theta);
}

// -- ADR-30: Digest 行动 ---------------------------------------------------

/**
 * Digest: mark_read + 浅层图状态更新（无 LLM 成本）。
 *
 * 成本梯度: skip(零) → mark_read(标记已读) → digest(浅层消化) → System 2(LLM)
 */
function executeDigest(
  G: WorldModel,
  target: string,
  _tick: number,
  nowMs: number = Date.now(),
): void {
  // ADR-101: 防御性守卫——digest 操作 channel 专属属性
  if (!G.has(target) || G.getNodeType(target) !== "channel") return;

  // mark_read 基础 + activity_relevance 衰减（灌水群 → 逐渐降低关注度）
  const relevance = G.getChannel(target).activity_relevance ?? 0.5;
  G.updateChannel(target, {
    unread: 0,
    unread_ewms: 0, // ADR-150 D3: EWMS 同步清零（与 mapper.ts read_history 对齐）
    recently_cleared_ms: nowMs,
    activity_relevance: relevance * 0.95,
  });
}

/**
 * ADR-64 I-1: directed 消息防抖窗口（毫秒）。
 * 收到第一条 directed 消息后等待此时间再唤醒，避免一条消息一个 tick。
 */
const DIRECTED_DEBOUNCE_MS = 2000;

/** 最小 tick 间隔（ms）防 tick 风暴。 */
const MIN_TICK_INTERVAL_MS = 3000;
/** anyEvent debounce 窗口（ms）。
 * ADR-190: 10s→30s。多群场景下 10s 使 patrol 退化为近实时轮询，
 * 30s 仍足够快但大幅减少空转 tick。 */
const ANY_EVENT_DEBOUNCE_MS = 30_000;

// ── ADR-190: LLM 失败指数退避常量 ──────────────────────────────────────

/** 退避乘数上限。max = 2^4 = 16 → 最多把 interval 放大 16 倍。 */
const BACKOFF_MAX_MULTIPLIER = 16;
/** 退避自动重置时间（ms）。超过此时间无新失败 → 认为 LLM 已恢复。
 * 与熔断器 circuitResetMs (60s) 对齐。 */
const BACKOFF_RESET_MS = 60_000;

/**
 * 计算 LLM 失败退避乘数。
 * multiplier = min(maxMultiplier, 2^consecutiveFailures)
 * 超过 BACKOFF_RESET_MS 无新失败 → 重置为 1（正常速度）。
 */
export function computeBackoffMultiplier(
  backoff: EvolveState["llmBackoff"],
  nowMs: number,
): number {
  if (backoff.consecutiveFailures <= 0) return 1;
  // 超时自动重置
  if (nowMs - backoff.lastFailureMs > BACKOFF_RESET_MS) return 1;
  return Math.min(BACKOFF_MAX_MULTIPLIER, 2 ** backoff.consecutiveFailures);
}

/**
 * 启动 EVOLVE 循环（自适应定时器 + event-driven 唤醒）。
 * 返回一个 AbortController 用于停止。
 *
 * 三路 Promise.race：
 * 1. directed wakeup (2s debounce) — 最高优先级
 * 2. anyEvent wakeup (10s debounce) — conversation mode 下有用
 * 3. computeInterval(lastAPI, mode) timeout — 自适应间隔
 *
 * @see paper/ §6.4 Definition 6.3
 */
export function startEvolveLoop(state: EvolveState): AbortController {
  const ac = new AbortController();

  // ADR-54: 连续异常计数 — 防止 evolveTick 持续静默失败
  const MAX_CONSECUTIVE_ERRORS = 10;
  const MAX_FATAL_ROUNDS = 3;

  (async () => {
    let consecutiveErrors = 0;
    let fatalRounds = 0;

    // ADR-64 I-1: directed wakeup 机制
    let directedResolve: (() => void) | null = null;
    let directedDebounce: ReturnType<typeof setTimeout> | null = null;

    state.buffer.onDirected = () => {
      if (directedDebounce) clearTimeout(directedDebounce);
      directedDebounce = setTimeout(() => {
        directedDebounce = null;
        if (directedResolve) {
          directedResolve();
          directedResolve = null;
        }
      }, DIRECTED_DEBOUNCE_MS);
    };

    // anyEvent wakeup 机制（低优先级）
    let anyEventResolve: (() => void) | null = null;
    let anyEventDebounce: ReturnType<typeof setTimeout> | null = null;

    state.buffer.onAnyEvent = () => {
      if (anyEventDebounce) clearTimeout(anyEventDebounce);
      anyEventDebounce = setTimeout(() => {
        anyEventDebounce = null;
        if (anyEventResolve) {
          anyEventResolve();
          anyEventResolve = null;
        }
      }, ANY_EVENT_DEBOUNCE_MS);
    };

    while (!ac.signal.aborted && !state.queue.closed) {
      const tickStart = Date.now();
      try {
        evolveTick(state);
        consecutiveErrors = 0;

        // ADR-201: Skill 自动升级（tick 间隙无感检查）
        maybeAutoUpgrade(state.clock.tick, log).catch((e) => {
          log.warn("auto-upgrade check failed", {
            error: e instanceof Error ? e.message : String(e),
          });
        });
      } catch (e) {
        consecutiveErrors++;
        log.error("Evolve tick error", { error: e, consecutiveErrors });
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          fatalRounds++;
          log.fatal(
            "EVOLVE loop: 连续 %d 次异常（第 %d 轮 fatal）",
            MAX_CONSECUTIVE_ERRORS,
            fatalRounds,
          );
          writeAuditEvent(state.clock.tick, "fatal", "evolve", "连续异常超限", {
            consecutiveErrors,
            fatalRounds,
            lastError: e instanceof Error ? e.message : String(e),
          });
          if (fatalRounds >= MAX_FATAL_ROUNDS) {
            log.fatal("EVOLVE loop: %d 轮 fatal，管线不可恢复", fatalRounds);
            ac.abort(`EVOLVE: ${fatalRounds} fatal rounds, pipeline unrecoverable`);
            break;
          }
          consecutiveErrors = 0;
        }
      }

      // 自适应调度：基于 lastAPI 和当前 mode 计算下次间隔
      // ADR-190: LLM 失败时指数退避放大 interval，减少无效 tick
      const elapsed = Date.now() - tickStart;
      // ADR-195: tick 间隔使用 peak-based API（强度量），不随实体数量膨胀
      const adaptiveInterval = state.clock.computeInterval(state.lastAPIPeak, state.mode);
      const backoffMult = computeBackoffMultiplier(state.llmBackoff, Date.now());
      const backedOffInterval = adaptiveInterval * backoffMult;
      const remaining = Math.max(MIN_TICK_INTERVAL_MS - elapsed, backedOffInterval - elapsed);
      if (backoffMult > 1) {
        log.info("LLM backoff active", {
          consecutiveFailures: state.llmBackoff.consecutiveFailures,
          multiplier: backoffMult,
          intervalMs: Math.round(backedOffInterval),
        });
      }
      if (elapsed > backedOffInterval) {
        log.warn("Tick overran interval", { elapsed, adaptiveIntervalMs: backedOffInterval });
      }

      // 三路 Promise.race
      let sleepTimer: ReturnType<typeof setTimeout> | undefined;
      const sleepPromise = new Promise<void>((resolve) => {
        sleepTimer = setTimeout(resolve, remaining);
      });
      const directedPromise = new Promise<void>((resolve) => {
        directedResolve = resolve;
      });
      const anyEventPromise = new Promise<void>((resolve) => {
        anyEventResolve = resolve;
      });
      await Promise.race([sleepPromise, directedPromise, anyEventPromise]);
      // 清理
      clearTimeout(sleepTimer);
      directedResolve = null;
      anyEventResolve = null;
    }
    // 清理回调
    state.buffer.onDirected = null;
    state.buffer.onAnyEvent = null;
    if (directedDebounce) clearTimeout(directedDebounce);
    if (anyEventDebounce) clearTimeout(anyEventDebounce);
    log.info("Evolve loop stopped");
  })().catch((err) => {
    log.fatal("Evolve loop crashed unexpectedly", {
      error: err instanceof Error ? err.message : String(err),
    });
    ac.abort(err instanceof Error ? err.message : String(err));
  });

  return ac;
}
