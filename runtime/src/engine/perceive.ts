/**
 * PERCEIVE 线程：事件驱动，将 EventBuffer 中的事件应用到图。
 *
 * 这不是独立循环——由 EVOLVE 线程在每 tick 开始时调用。
 */

import { writeAuditEvent } from "../db/audit.js";
import {
  chatIdToContactId,
  PERCEIVE_FACT_DEBOUNCE_MS,
  PERCEIVE_FACT_MSG_THRESHOLD,
  PERCEIVE_FACTS_LIMIT,
} from "../graph/constants.js";
import { safeDisplayName } from "../graph/display.js";
import type { WorldModel } from "../graph/world-model.js";
import type { EventBuffer } from "../telegram/events.js";
import type { GraphPerturbation } from "../telegram/mapper.js";
import { applyPerturbations } from "../telegram/mapper.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("perceive");

/**
 * 消费事件缓冲区，应用到图，返回本 tick 的 novelty。
 * ADR-115: 增加 channelCounts — per-channel 消息计数，供 anomaly generator 使用。
 */
export function perceiveTick(
  G: WorldModel,
  buffer: EventBuffer,
  tick?: number,
): { eventCount: number; novelty: number; channelCounts: Map<string, number> } {
  const { events, droppedCount, droppedDirectedCount } = buffer.drain();
  const effectiveTick = tick ?? events[0]?.tick ?? -1;
  if (droppedCount > 0) {
    // T-5: 通知引擎事件丢失，供日志和压力校正参考
    log.warn("EventBuffer dropped events since last tick", { droppedCount });
    // ADR-147 D1: 溢出写入结构化审计，供 anomaly.ts 检测
    writeAuditEvent(
      effectiveTick,
      "warn",
      "events",
      `EventBuffer overflow: ${droppedCount} regular events dropped`,
      { droppedCount },
    );
  }
  // ADR-114 D4: directed 事件丢失是严重信号——@mention/reply 被淹没
  if (droppedDirectedCount > 0) {
    log.warn("Directed events were dropped due to protected buffer overflow", {
      droppedDirectedCount,
    });
    writeAuditEvent(
      effectiveTick,
      "warn",
      "events",
      `EventBuffer overflow: ${droppedDirectedCount} directed events dropped`,
      { droppedDirectedCount },
    );
  }
  const novelty = applyPerturbations(G, events);

  // D5: per-contact recv 窗口计数更新（contact_recv_window）
  updateContactRecvWindow(G, events);

  // ADR-116: 频道有新活动 → consecutive_act_silences 衰减（渐进恢复，非突变清零）
  // 但群聊里的 bot flood 不是"社交恢复"信号：只有真人消息才应该解锁冷却。
  // 纯 bot 连发反而说明房间正在变吵，Alice 应更倾向于收手而不是继续被唤醒。
  // @see docs/GOAL.md §场景 4 / §场景 7
  decayActSilences(G, events);

  // ADR-115: per-channel 消息计数（供 anomaly generator 的 EMA 统计）
  const channelCounts = new Map<string, number>();
  for (const e of events) {
    if (e.channelId && e.type === "new_message") {
      channelCounts.set(e.channelId, (channelCounts.get(e.channelId) ?? 0) + 1);
    }
  }

  // ADR-160 Fix A: perceive-sourced facts — 为有显著活动的 channel 自动创建 observation fact。
  // 完成 P2 传感器：P2 不再完全依赖 LLM 调用 remember()。
  // @see docs/adr/158-outbound-feedback-gap.md §Fix A
  createPerceiveFacts(G, channelCounts, Date.now());

  return { eventCount: events.length, novelty, channelCounts };
}

/**
 * ADR-116: 衰减 consecutive_act_silences — 频道有新消息时 -1。
 *
 * 渐进恢复比突变清零更稳定——Alice 不会在一条消息后就从"沉默"跳到"积极"。
 * 只对 new_message 类型事件触发（typing 等低信号不触发）。
 *
 * @see docs/adr/116-group-silence-trap.md §修复 4 方案 A
 */
function decayActSilences(G: WorldModel, events: GraphPerturbation[]): void {
  const humanActivityChannels = new Set<string>();
  const botOnlyBurst = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "new_message" || !event.channelId) continue;
    if (event.senderIsBot) {
      botOnlyBurst.set(event.channelId, (botOnlyBurst.get(event.channelId) ?? 0) + 1);
      continue;
    }
    humanActivityChannels.add(event.channelId);
    botOnlyBurst.delete(event.channelId);
  }

  // 真人消息才算真正的"房间恢复"，允许逐步解锁沉默冷却。
  for (const channelId of humanActivityChannels) {
    if (!G.has(channelId)) continue;
    const silences = Number(G.getChannel(channelId).consecutive_act_silences ?? 0);
    if (silences > 0) {
      G.updateChannel(channelId, { consecutive_act_silences: silences - 1 });
    }
  }

  // 群聊纯 bot 连发：不解锁，反而追加一层轻微冷却，避免 Alice 被工具输出勾着聊。
  for (const [channelId, count] of botOnlyBurst) {
    if (count < 2 || !G.has(channelId)) continue;
    const attrs = G.getChannel(channelId);
    if (attrs.chat_type !== "group" && attrs.chat_type !== "supergroup") continue;
    const silences = Number(attrs.consecutive_act_silences ?? 0);
    G.updateChannel(channelId, {
      consecutive_act_silences: silences + 1,
      last_act_silence_ms: Date.now(),
    });
  }
}

/**
 * D5: 更新 per-channel contact_recv_window 计数。
 *
 * 对方发消息（new_message 且不是 Alice 自己发的）→ 对应频道 contact_recv_window++。
 * 用于 C_dist 互惠失衡计算。
 *
 * @see paper/ Definition 8, C_dist: sent(n,w) / recv(n,w)
 */
function updateContactRecvWindow(G: WorldModel, events: GraphPerturbation[]): void {
  for (const event of events) {
    if (event.type !== "new_message") continue;
    const channelId = event.channelId;
    if (!channelId || !G.has(channelId)) continue;

    // 递增对方消息计数
    const current = Number(G.getChannel(channelId).contact_recv_window ?? 0);
    G.updateChannel(channelId, { contact_recv_window: current + 1 });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ADR-160 Fix A: Perceive-Sourced Facts
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 为有显著新活动的 channel 自动创建/更新 perceive-sourced observation facts。
 *
 * 创建条件（避免噪声）：
 * 1. 该 channel 本 tick 有 ≥ PERCEIVE_FACT_MSG_THRESHOLD 条新消息
 * 2. 最近 PERCEIVE_FACT_DEBOUNCE_MS 内未为同一 channel 创建过 perceive fact
 *
 * Fact 属性：
 * - source: "perceive", fact_type: "observation"
 * - importance: 0.3（结构性基线）, stability: 1（~27天半衰期）
 * - last_access_ms 不自动刷新（Alice 没有主动处理 ≠ "访问"）
 *
 * 容量控制：PERCEIVE_FACTS_LIMIT 独立池，超限淘汰最低 R 的 perceive fact。
 *
 * @see docs/adr/158-outbound-feedback-gap.md §Fix A
 * @see paper/ §3.2 "Information Pressure" — P2 遗忘曲线
 */
function createPerceiveFacts(
  G: WorldModel,
  channelCounts: Map<string, number>,
  nowMs: number,
): void {
  for (const [channelId, count] of channelCounts) {
    if (count < PERCEIVE_FACT_MSG_THRESHOLD) continue;
    if (!G.has(channelId)) continue;

    const channelAttrs = G.getChannel(channelId);
    // 只为 Alice 曾参与过的 channel 创建（无历史行动 = 无观察意义）
    const lastAliceActionMs = Number(channelAttrs.last_alice_action_ms ?? 0);
    if (lastAliceActionMs <= 0) continue;

    // 检查是否已有同 channel 的近期 perceive fact（去抖）
    const factId = `fact:perceive:${channelId}`;
    if (G.has(factId)) {
      const existing = G.getFact(factId);
      const createdMs = Number(existing.created_ms ?? 0);
      if (nowMs - createdMs < PERCEIVE_FACT_DEBOUNCE_MS) {
        // 更新内容但不刷新 last_access_ms（Alice 没有主动处理）
        const displayName = safeDisplayName(G, channelId);
        G.updateFact(factId, {
          content: `Activity: ${count} messages in ${displayName}`,
          created_ms: nowMs, // 刷新创建时间以重置去抖窗口
        });
        continue;
      }
    }

    // 容量控制：超限时淘汰最低 R 的 perceive fact
    enforcePerceiveFactsLimit(G, nowMs);

    const displayName = safeDisplayName(G, channelId);
    // 推导 contact ID（私聊 channel → contact 对应）
    const sourceContact = chatIdToContactId(channelId) ?? undefined;

    G.addFact(factId, {
      content: `Activity: ${count} messages in ${displayName}`,
      fact_type: "observation",
      importance: 0.3,
      stability: 1,
      source: "perceive",
      source_channel: channelId,
      source_contact: sourceContact && G.has(sourceContact) ? sourceContact : undefined,
      created_ms: nowMs,
      last_access_ms: nowMs,
    });

    // 连接到 self（P2 通过遍历 fact 类型实体获取，边是可选的语义连接）
    if (G.has("self")) {
      G.addEdge("self", factId, "knows", "cognitive");
    }
  }
}

/** SM-2 retrievability 计算（与 P2 一致）。 */
function factRetrievability(stability: number, lastAccessMs: number, nowMs: number): number {
  const gapDays = Math.max(0, (nowMs - lastAccessMs) / 86_400_000);
  const S = Math.max(stability, 0.1);
  return (1 + gapDays / (9 * S)) ** -0.5;
}

/** 淘汰最低 R 的 perceive fact（维持容量池）。 */
function enforcePerceiveFactsLimit(G: WorldModel, nowMs: number): void {
  const perceiveFacts: Array<{ id: string; R: number }> = [];
  for (const fid of G.getEntitiesByType("fact")) {
    const attrs = G.getFact(fid);
    if (attrs.source !== "perceive") continue;
    const R = factRetrievability(attrs.stability, Number(attrs.last_access_ms ?? 0), nowMs);
    perceiveFacts.push({ id: fid, R });
  }

  if (perceiveFacts.length < PERCEIVE_FACTS_LIMIT) return;

  // 淘汰最低 R
  perceiveFacts.sort((a, b) => a.R - b.R);
  const toRemove = perceiveFacts.length - PERCEIVE_FACTS_LIMIT + 1; // +1 为新 fact 腾位
  for (let i = 0; i < toRemove; i++) {
    G.removeEntity(perceiveFacts[i].id);
  }
}
