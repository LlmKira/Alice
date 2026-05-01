import { resolveContactAndChannel } from "../../graph/constants.js";
import type { WorldModel } from "../../graph/world-model.js";
import { hasObligation, OBLIGATION_THRESHOLDS } from "../../pressure/signal-decay.js";

// -- V-1: 外部反馈锚 ---------------------------------------------------------
// @see docs/adr/64-runtime-theory-alignment-audit.md §V-1
// LLM 自评是写入-读取回路的自强化源。外部行为信号作为真理锚，校准 rate_outcome。

export interface ExternalFeedback {
  score: number; // [-1, 1]
  confidence: number; // [0, 1] 基于可用信号数量
  signals: string[];
}

/**
 * 计算外部行为反馈分数。
 *
 * 从图属性中提取 actionMs 之后的外部行为信号：
 * 1. 对方是否回复（last_active_ms > actionMs）
 * 2. 对方是否给了 reaction（last_reaction_ms > actionMs）
 * 3. 对话是否延续（conversation state ∈ {opening, active}）
 * 4. 对方是否主动找 Alice（pending_directed > 0）
 *
 * 返回加权平均分数 ∈ [-1, 1]，confidence 基于可用信号数量。
 */
export function computeExternalFeedback(
  G: WorldModel,
  target: string,
  actionMs: number,
  nowMs: number,
): ExternalFeedback {
  const signals: string[] = [];
  let weightedSum = 0;
  let totalWeight = 0;

  // 解析 contact ID 和 channel ID
  const { contactId, channelId } = resolveContactAndChannel(target, (id) => G.has(id));

  // 信号 1: 对方是否在 Alice 行动后回复（权重 0.4 — 最强信号）
  if (contactId && G.has(contactId)) {
    const attrs = G.getContact(contactId);
    const lastActiveMs = attrs.last_active_ms ?? 0;
    if (lastActiveMs > actionMs) {
      // 对方回复了 → 正反馈
      signals.push("replied");
      weightedSum += 0.4 * 0.7;
      totalWeight += 0.4;
    } else if ((nowMs - actionMs) / 1000 > 600) {
      // 超过 600 秒（10 ticks × 60s）仍无回复 → 轻微负反馈
      signals.push("no_reply");
      weightedSum += 0.4 * -0.3;
      totalWeight += 0.4;
    }
    // actionMs 之后不到 600 秒 → 还在等，不计入
  }

  // 信号 2: 对方是否给了 reaction（权重 0.2 — 低成本但明确）
  if (contactId && G.has(contactId)) {
    const attrs = G.getContact(contactId);
    const reactionMs = attrs.last_reaction_ms ?? 0;
    if (reactionMs > actionMs) {
      signals.push("reaction");
      weightedSum += 0.2 * 0.6;
      totalWeight += 0.2;
    }
  }

  // 信号 3: 对话是否延续（权重 0.25 — 对话状态是重要的上下文信号）
  // 注意：不用 findActiveConversation（只返回 pending/opening/active），
  // 我们还需要检测 closing/cooldown 状态作为负信号。
  if (channelId && G.has(channelId)) {
    // 优先选择最活跃的对话（active > opening > closing > cooldown）
    let bestConvState: string | null = null;
    const statePriority: Record<string, number> = {
      active: 4,
      opening: 3,
      closing: 2,
      cooldown: 1,
    };
    let bestPriority = 0;
    for (const convId of G.getEntitiesByType("conversation")) {
      const convAttrs = G.getConversation(convId);
      if (convAttrs.channel !== channelId) continue;
      const p = statePriority[convAttrs.state] ?? 0;
      if (p > bestPriority) {
        bestPriority = p;
        bestConvState = convAttrs.state;
      }
    }
    if (bestConvState === "active" || bestConvState === "opening") {
      signals.push("conversation_active");
      weightedSum += 0.25 * 0.5;
      totalWeight += 0.25;
    } else if (bestConvState === "closing" || bestConvState === "cooldown") {
      signals.push("conversation_ending");
      weightedSum += 0.25 * -0.4;
      totalWeight += 0.25;
    }
  }

  // 信号 4: 对方是否主动找 Alice（权重 0.15 — 主动性是强正信号）
  // ADR-124: 使用 hasObligation 替代 pending_directed > 0
  // @see docs/adr/126-obligation-field-decay.md §D6
  if (channelId && G.has(channelId)) {
    if (hasObligation(G, channelId, nowMs, OBLIGATION_THRESHOLDS.signal)) {
      signals.push("directed_message");
      weightedSum += 0.15 * 0.8;
      totalWeight += 0.15;
    }
  }

  // 计算最终分数和置信度
  const score = totalWeight > 0 ? Math.max(-1, Math.min(1, weightedSum / totalWeight)) : 0;
  // confidence = 可用信号数量 / 4（最大信号数）
  const confidence = Math.min(1, signals.length / 4);

  return { score, confidence, signals };
}
