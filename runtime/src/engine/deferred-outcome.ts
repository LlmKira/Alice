/**
 * ADR-199 W3: 延迟反馈模块 — 系统性延迟评估消息发送后的外部反应。
 *
 * 解决 Decision→Outcome 闭环断裂：
 * - 发言后的外部反馈（是否被回复/忽略）没有被系统性延迟回写
 * - computeExternalFeedback 只在 rate_outcome 内部调用
 *
 * 本模块在 evolveTick 中定期扫描：
 * 1. 找出 Alice 最近发过消息但尚未评估 outcome 的 channel
 * 2. 调用 computeExternalFeedback 推断外部反馈
 * 3. 回写 last_outcome_quality / last_outcome_ms / rv_trust
 *
 * @see docs/adr/199-closure-feedback-structural-upgrade.md
 */
import { getDb } from "../db/connection.js";
import { deferredOutcomeLog } from "../db/schema.js";
import { resolveContactAndChannel } from "../graph/constants.js";
import type { WorldModel } from "../graph/world-model.js";
import { computeExternalFeedback } from "../mods/observer/external-feedback.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("deferred-outcome");

/** 延迟评估的最小等待时间（ms）— 给对方足够的回复窗口。 */
const MIN_DELAY_MS = 3 * 60 * 1000; // 3 分钟
/** 延迟评估的最大窗口（ms）— 超过此时间不再评估。 */
const MAX_DELAY_MS = 30 * 60 * 1000; // 30 分钟
/** 外部反馈置信度阈值 — 低于此值不回写（信号不足）。 */
const MIN_CONFIDENCE = 0.2;

export interface PendingOutcome {
  channelId: string;
  contactId: string | null;
  actionMs: number;
  lastOutcomeMs: number;
}

export interface DeferredFeedbackResult {
  channelId: string;
  score: number;
  confidence: number;
  signals: string[];
  delayMs: number;
}

/**
 * 扫描所有 channel，找出 Alice 最近发过消息但尚未评估 outcome 的目标。
 *
 * 条件：
 * - last_alice_action_ms > last_outcome_ms（有行动但无评估）
 * - nowMs - last_alice_action_ms > MIN_DELAY_MS（已过最小等待时间）
 * - nowMs - last_alice_action_ms < MAX_DELAY_MS（未超最大窗口）
 */
export function scanPendingOutcomes(G: WorldModel, nowMs: number): PendingOutcome[] {
  const pendings: PendingOutcome[] = [];
  for (const channelId of G.getEntitiesByType("channel")) {
    const ch = G.getChannel(channelId);
    const actionMs = ch.last_alice_action_ms ?? 0;
    const outcomeMs = ch.last_outcome_ms ?? 0;
    if (actionMs <= 0 || actionMs <= outcomeMs) continue;

    const elapsed = nowMs - actionMs;
    if (elapsed < MIN_DELAY_MS || elapsed > MAX_DELAY_MS) continue;

    const { contactId } = resolveContactAndChannel(channelId, (id) => G.has(id));
    pendings.push({ channelId, contactId, actionMs, lastOutcomeMs: outcomeMs });
  }
  return pendings;
}

/**
 * 对一个 pending outcome 执行延迟评估：
 * 1. 调用 computeExternalFeedback 推断外部反馈
 * 2. 回写 channel.last_outcome_quality / last_outcome_ms
 * 3. 可选：回写 contact.rv_trust 微调
 * 4. 写入 deferred_outcome_log 审计表
 */
export function evaluateDeferredOutcome(
  G: WorldModel,
  pending: PendingOutcome,
  nowMs: number,
  tick: number,
): DeferredFeedbackResult | null {
  const ext = computeExternalFeedback(G, pending.channelId, pending.actionMs, nowMs);

  // 置信度太低（信号不足）→ 跳过
  if (ext.confidence < MIN_CONFIDENCE) return null;

  const delayMs = nowMs - pending.actionMs;

  // 回写 channel
  G.updateChannel(pending.channelId, {
    last_outcome_quality: ext.score,
    last_outcome_ms: nowMs,
  });

  // 回写 contact（如果存在且有足够信号）
  // ADR-199: 延迟反馈 → 关系向量微调 — 让"世界后果"真正塑形关系
  // trust: 正反馈增加信任（"我说的话被认真对待了"），负反馈降低信任
  // respect: 持续被忽略 → 降低 respect（"对方不把我的话当回事"）
  if (pending.contactId && G.has(pending.contactId)) {
    const contact = G.getContact(pending.contactId);
    const trustDelta = ext.score * 0.05;
    const currentTrust = contact.rv_trust ?? 0.5;
    // respect 只在负反馈时微降（正反馈不应抬高 respect——"被回复"不等于"被尊重"）
    const respectDelta = ext.score < -0.2 ? ext.score * 0.03 : 0;
    const currentRespect = contact.rv_respect ?? 0.5;
    G.updateContact(pending.contactId, {
      last_outcome_quality: ext.score,
      last_outcome_ms: nowMs,
      rv_trust: Math.max(0, Math.min(1, currentTrust + trustDelta)),
      rv_trust_ms: nowMs,
      rv_respect: Math.max(0, Math.min(1, currentRespect + respectDelta)),
      rv_respect_ms: nowMs,
    });
  }

  // 写入审计日志
  try {
    getDb()
      .insert(deferredOutcomeLog)
      .values({
        tick,
        channelId: pending.channelId,
        actionMs: pending.actionMs,
        evaluationMs: nowMs,
        delayMs,
        score: ext.score,
        confidence: ext.confidence,
        signals: JSON.stringify(ext.signals),
      })
      .run();
  } catch (e) {
    log.warn("Failed to write deferred outcome log", e);
  }

  log.info("Deferred outcome evaluated", {
    channelId: pending.channelId,
    score: ext.score,
    confidence: ext.confidence,
    signals: ext.signals,
    delayMs,
  });

  return {
    channelId: pending.channelId,
    score: ext.score,
    confidence: ext.confidence,
    signals: ext.signals,
    delayMs,
  };
}
