/**
 * System 1 — 零 LLM 成本反射决策 (ADR-26 §4)。
 *
 * 低风险、机械性的行动不需要 LLM 推理。
 * System 1 在声部选择之后、入队之前执行。
 * 如果 System 1 能处理，直接执行并跳过入队（不消耗 LLM 额度）。
 * 否则升级到 System 2（入队给 ACT 线程，由 LLM 执行）。
 *
 * ADR-29 方向5: S10 leakProb — 条件匹配时概率泄漏到 System 2（群聊参与）。
 * ADR-30: digest 行动 — mark_read + 浅层图状态更新（novelty 注入、relevance 衰减）。
 */
import type { WorldModel } from "../graph/world-model.js";
import {
  effectiveMention,
  hasObligation,
  isRiskNegligible,
  OBLIGATION_THRESHOLDS,
} from "../pressure/signal-decay.js";
import type { FocalSet } from "../voices/focus.js";
import type { VoiceAction } from "../voices/personality.js";

// -- 类型 -------------------------------------------------------------------

export interface System1Decision {
  /** System 1 是否能处理此行动。 */
  handled: boolean;
  /** System 1 执行的行动类型。 */
  action?: "mark_read" | "skip" | "digest";
  /** 行动目标实体 ID。 */
  target?: string;
}

/** System 1 配置选项。 */
export interface System1Options {
  /** S10: Diligence mark_read 条件匹配时泄漏到 System 2 的概率。 */
  leakProb?: number;
  /** 对话延续信号：target 有活跃对话且 turn_state = alice_turn。
   *  为 true 时 Diligence 无条件升级 System 2——隐式回复不应被 digest 吞掉。 */
  isConversationContinuation?: boolean;
  /** ADR-124: 墙钟毫秒，用于 effectiveObligation 计算。 */
  nowMs?: number;
}

// -- 规则 -------------------------------------------------------------------

/**
 * 尝试 System 1 处理。
 *
 * 规则:
 * | 声部 | 条件 | System 1 行动 |
 * |------|------|--------------|
 * | Caution | 所有焦点实体 risk≤low + 无 alice_turn conv | skip |
 * | Diligence | target.pending_directed=0 + target.unread>0 | mark_read / digest (leakProb 泄漏) |
 *
 * @returns System1Decision — handled=true 表示 System 1 已处理
 */
export function trySystem1(
  action: VoiceAction,
  focalSets: Record<VoiceAction, FocalSet>,
  G: WorldModel,
  tick: number,
  options?: System1Options,
): System1Decision {
  if (action === "caution") {
    return tryCautionSkip(focalSets.caution, G, tick, options?.nowMs);
  }

  if (action === "diligence") {
    return tryDiligenceMarkRead(
      focalSets.diligence,
      G,
      tick,
      options?.leakProb ?? 0,
      options?.isConversationContinuation ?? false,
      options?.nowMs ?? Date.now(),
    );
  }

  return { handled: false };
}

// -- Caution skip -----------------------------------------------------------

/**
 * Caution skip: 焦点集内所有实体风险 ≤ low，且没有 alice_turn 对话。
 *
 * 有 alice_turn 对话 → 可能需要 LLM 评估是否回复 → 升级 System 2。
 * 有高风险实体 → 需要 LLM 评估风险 → 升级 System 2。
 */
function tryCautionSkip(
  focalSet: FocalSet,
  G: WorldModel,
  _tick: number,
  nowMs?: number,
): System1Decision {
  // 空焦点集 → 安全跳过
  if (focalSet.entities.length === 0) {
    return { handled: true, action: "skip" };
  }

  for (const eid of focalSet.entities) {
    if (!G.has(eid)) continue;

    // risk_level 是 channel 属性，非 channel 实体跳过
    if (G.getNodeType(eid) !== "channel") continue;

    // 高风险 → 升级 System 2
    // ADR-126: 使用 effectiveRisk 替代 isLowRisk 布尔判断
    // 陈旧的风险评级不再无条件强制 System 2 升级
    if (!isRiskNegligible(G, eid, nowMs ?? Date.now())) {
      return { handled: false };
    }
  }

  // 检查是否有 alice_turn 对话（需要回复 → 升级 System 2）
  if (hasAliceTurnConversation(G)) {
    return { handled: false };
  }

  return { handled: true, action: "skip" };
}

// -- Diligence mark_read / digest -------------------------------------------

/**
 * Diligence mark_read: 目标频道有 unread 但无 pending_directed。
 *
 * 有 pending_directed → 需要 LLM 回复 → 升级 System 2。
 * 无 unread → 无事可做 → 不处理。
 *
 * ADR-29 S10: leakProb > 0 时，条件匹配后以该概率泄漏到 System 2，
 * 实现概率性群聊参与（Alice 偶尔在非@消息的群聊中发言）。
 *
 * ADR-30: unread 高但 directed=0 时使用 digest（浅层消化）而非 mark_read。
 * digest = mark_read + novelty 注入 + activity_relevance 衰减。
 *
 * G7: 动态频率控制 — participation_ratio 调节 leakProb，避免 Alice 过度参与群聊。
 * Bot 消息 digest 兜底：mapper/events 层已阻止 bot 产生义务/延续（不递增 pending_directed、
 * 不触发 isContinuation），因此 bot 消息不会在义务/延续检查处被提前升级。
 * 到达 unread > 0 分支后由 last_sender_is_bot 检查兜底 → digest。
 */
/** ADR-110: 对话延续信号窗口（秒）：Alice 发言后 N 秒内的消息视为可能的隐式回复。 */
const CONTINUATION_WINDOW_S = 300;
/** 对话延续信号的 leakProb 下限：确保高概率捕获隐式回复。 */
const CONTINUATION_LEAK_FLOOR = 0.7;
/** #22: 他人提到 Alice 名字时的泄漏概率下限。 */
const MENTION_LEAK_FLOOR = 0.5;
/** #22: 高活跃对话 burst 检测阈值（unread 消息数）。 */
const ACTIVITY_BURST_THRESHOLD = 10;
/** #22: 高活跃对话的泄漏概率下限。 */
const ACTIVITY_BURST_LEAK_FLOOR = 0.3;
/**
 * effectiveLeakProb 的绝对天花板。
 * 多层 Math.max() 地板叠加可能将配置值推高到不可预期的程度：
 *   用户配 leakProb=0.1 → participation boost(×2)=0.2 → mention floor=0.5 → continuation=0.7
 * 此天花板确保最终概率不超过 0.7，防止"几乎总是泄漏"的意外行为。
 */
const MAX_EFFECTIVE_LEAK_PROB = 0.7;
/**
 * ADR-116: 新群观察期泄漏概率下限。
 * Alice 从未在此群发言（participation_ratio = 0）时使用。
 * 让 LLM 有机会"读懂房间"并建立初始参与——打破鸡生蛋困境。
 * @see docs/adr/116-group-silence-trap.md §修复 1
 */
const NEWCOMER_LEAK_FLOOR = 0.5;

function tryDiligenceMarkRead(
  focalSet: FocalSet,
  G: WorldModel,
  _tick: number,
  leakProb: number,
  isConversationContinuation: boolean,
  nowMs: number,
): System1Decision {
  const target = focalSet.primaryTarget;
  if (!target || !G.has(target)) return { handled: false };

  // Diligence 目标应为 channel 节点
  if (G.getNodeType(target) !== "channel") return { handled: false };
  const attrs = G.getChannel(target);
  const unread = attrs.unread ?? 0;

  // ADR-124: 使用 hasObligation 替代 pending_directed > 0
  // 陈旧的 directed 消息不再无条件升级 System 2
  // @see docs/adr/126-obligation-field-decay.md §D5
  if (hasObligation(G, target, nowMs, OBLIGATION_THRESHOLDS.system1)) {
    // 有效义务 > 阈值 → 需要 LLM 回复
    return { handled: false };
  }

  // 对话延续：target 有活跃对话且 turn_state = alice_turn
  // 对方隐式回复（不 reply/不 @）不递增 pending_directed，但对话状态机已翻转。
  // 此时无条件升级 System 2——digest 会吞掉隐式回复，导致 Alice 在活跃对话中沉默。
  if (isConversationContinuation) {
    return { handled: false };
  }

  if (unread > 0) {
    // ADR-91: Bot 是最后发送者 → 直接 digest，不泄漏到 System 2
    // Bot 群聊消息（验证提示、翻译结果等）几乎不需要 Alice 主动回应
    if (attrs.last_sender_is_bot === true) {
      return { handled: true, action: "digest", target };
    }

    // G7: 动态 leakProb 基于 participation_ratio
    let effectiveLeakProb = leakProb;
    const ratio = attrs.participation_ratio ?? 0;
    // ADR-161 §3.6: 线上群组参与比例上限 15%。
    // 真人在多人群组中占比 >15% 已属过度参与。
    // @see docs/adr/161-action-space-audit-group-cadence.md §3.6
    if (ratio > 0.15) {
      effectiveLeakProb = 0; // Alice 已过度参与，停止泄漏
    } else if (ratio === 0) {
      // ADR-116: Alice 从未在此群发言 → 使用 newcomer floor
      // 打破鸡生蛋困境：需要先发言才有 participation，但发言需要泄漏
      effectiveLeakProb = Math.max(effectiveLeakProb, NEWCOMER_LEAK_FLOOR);
    } else if (ratio > 0 && ratio < 0.05) {
      effectiveLeakProb = leakProb * 2; // 参与不足，增加泄漏概率
    }

    // ADR-78 F4: 对话延续信号独立于 participation_ratio 截断。
    // 回马枪是"对方回应 Alice"的场景，不同于 Alice 主动凑热闹。
    // 即使 ratio > 0.25，Alice 刚发言后的隐式回复仍应被捕获。
    // 动态衰减：ratio 越高，continuation 泄漏概率越低，防止高参与时仍过度响应。
    {
      // ADR-110: 使用墙钟 ms 判断对话延续窗口
      const lastAliceActionMs = Number(attrs.last_alice_action_ms ?? 0);
      if (
        lastAliceActionMs > 0 &&
        ((nowMs ?? Date.now()) - lastAliceActionMs) / 1000 <= CONTINUATION_WINDOW_S
      ) {
        const continuationProb = CONTINUATION_LEAK_FLOOR * Math.max(0, 1 - ratio * 2);
        effectiveLeakProb = Math.max(effectiveLeakProb, continuationProb);
      }
    }

    // #22: 隐性回复 — 他人提到 Alice 名字时提高泄漏概率
    // 结构匹配（text.includes），非语义判断，符合 ADR-50
    // ADR-126: 使用 effectiveMention 替代 mentions_alice 布尔闩锁
    // 名字提及是瞬时社交信号，15 分钟半衰期后衰减。
    // 泄漏概率与提及新鲜度成比例，而非二值全有或全无。
    if (effectiveLeakProb < MENTION_LEAK_FLOOR) {
      const mentionStrength = effectiveMention(G, target, nowMs);
      if (mentionStrength > 0.1) {
        // 衰减的提及 → 衰减的泄漏。新鲜提及给满额，陈旧提及给比例额。
        const mentionLeak = MENTION_LEAK_FLOOR * mentionStrength;
        effectiveLeakProb = Math.max(effectiveLeakProb, mentionLeak);
      }
    }

    // #22: 高活跃对话更可能包含隐式回复
    if (effectiveLeakProb > 0 && unread >= ACTIVITY_BURST_THRESHOLD) {
      effectiveLeakProb = Math.max(effectiveLeakProb, ACTIVITY_BURST_LEAK_FLOOR);
    }

    // 绝对天花板：多层 Math.max() 地板叠加后的最终截断。
    // 防止配置 leakProb=0.1 被层层推高到接近 1.0。
    effectiveLeakProb = Math.min(effectiveLeakProb, MAX_EFFECTIVE_LEAK_PROB);

    // S10: 概率泄漏到 System 2（群聊参与机会）
    if (effectiveLeakProb > 0 && Math.random() < effectiveLeakProb) {
      return { handled: false };
    }
    // ADR-30: digest（浅层消化）— 比 mark_read 多一层认知处理
    return { handled: true, action: "digest", target };
  }

  return { handled: false };
}

// -- 辅助 -------------------------------------------------------------------

/** 图中是否存在 alice_turn 的活跃对话。 */
function hasAliceTurnConversation(G: WorldModel): boolean {
  for (const convId of G.getEntitiesByType("conversation")) {
    const attrs = G.getConversation(convId);
    if (attrs.state === "cooldown" || attrs.state === "closing") continue;
    if (attrs.turn_state === "alice_turn") return true;
  }
  return false;
}
