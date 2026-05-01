/**
 * 可组合门控函数——从 evolve.ts 提取。
 *
 * 每个 gate 是纯函数（可单独测试），判定当前 tick 是否应入队行动。
 * 返回 GateVerdict：act（通过）、silent（记录沉默）、pass（不匹配，交给下一个 gate）。
 *
 * @see paper-five-dim §4.2 "Action Gating Pipeline"
 */

import { chatIdToContactId } from "../graph/constants.js";
import { findConversationForChannel } from "../graph/queries.js";
import type { WorldModel } from "../graph/world-model.js";
import { type ChannelClass, ChatTarget } from "../prompt/types.js";
import type { VoiceAction } from "../voices/personality.js";
import type { ActionCandidate } from "./iaus-scorer.js";

// -- 频道分类 ----------------------------------------------------------------

// ChannelClass 类型从 prompt/types.ts 导入（ADR-237 统一）
// @see ADR-237: ChatTargetType 五分法 → ChannelClass 四分法派生

/**
 * 将 Telegram chat_type 归类为四分法的 ChannelClass。
 *
 * 用于历史行动分类（只有 chatType + isBot，无 isOwnedChannel 信息）。
 * 场景判定（有完整上下文）应使用 snapshot.ts 的 ChatTargetType + toChannelClass。
 *
 * ADR-206: channel 独立分类，不再归入 group。
 * group/supergroup → "group"，channel → "channel"。
 * isBot 仅在非群聊/非频道时生效：private + isBot → "bot"。
 *
 * @see ADR-237: ChatTargetType 为场景判定唯一真相源
 * @see ADR-189 D1 → ADR-206 §3
 */
export function classifyChatType(chatType: string | undefined, isBot?: boolean): ChannelClass {
  if (ChatTarget.isGroupChat(chatType)) return "group";
  if (ChatTarget.isChannelChat(chatType)) return "channel";
  if (isBot === true) return "bot";
  return "private";
}

/** 判断 chat_type 是否为频道。 @see ADR-206 §3 */
export function isChannel(chatType: string | undefined): boolean {
  return ChatTarget.isChannelChat(chatType);
}

/**
 * 从 channel ID 推导对应 contact 的 is_bot 属性。
 * channel:xxx → contact:xxx → contact.is_bot。
 * 不在图中或无 contact 时返回 undefined（回退到 private）。
 * @see ADR-189 D1
 */
export function resolveIsBot(G: WorldModel, channelId: string): boolean | undefined {
  const cId = chatIdToContactId(channelId);
  if (!cId || !G.has(cId)) return undefined;
  const isBot = G.getContact(cId).is_bot;
  return typeof isBot === "boolean" ? isBot : undefined;
}

/**
 * 从 recentActions 中按 ChannelClass 分类统计行动数。
 * 不在图中的 target 回退到 "private"（保守：更严格的 cap）。
 */
export function countActionsByClass(
  recentActions: ReadonlyArray<{ target: string | null }>,
  G: WorldModel,
): Record<ChannelClass, number> {
  const counts: Record<ChannelClass, number> = { private: 0, group: 0, channel: 0, bot: 0 };
  for (const a of recentActions) {
    if (!a.target) continue;
    const chatType = G.has(a.target) ? (G.getChannel(a.target).chat_type ?? undefined) : undefined;
    const isBot = resolveIsBot(G, a.target);
    counts[classifyChatType(chatType, isBot)]++;
  }
  return counts;
}

// -- 类型 -------------------------------------------------------------------

// ADR-84: 论文 L5 是 Degraded Action（行动，不是沉默），不属于沉默谱。
// CRISIS_OVERRIDE 是工程安全阀（消息频率异常时的紧急刹车），非理论谱层级。
export type SilenceLevel =
  | "L1_LOW_PRESSURE" // API < floor
  | "L2_ACTIVE_COOLING" // 行动密度抑制
  | "L3_STRATEGIC" // V(a,n) ≤ 0
  | "L4_DEFERRED" // 观望（VoI 实现）
  | "CRISIS_OVERRIDE"; // 工程安全阀：频率异常紧急刹车

/** 沉默判决携带的数值上下文——闭合集合，替代 Record<string, number>。 */
export interface SilenceValues {
  netValue?: number;
  deltaP?: number;
  socialCost?: number;
  apiValue?: number;
  /** ADR-252: ActionQueue queued item count at resource-plane suppression time. */
  queueQueued?: number;
  /** ADR-252: ActionQueue processing target count at resource-plane suppression time. */
  queueProcessing?: number;
  /** ADR-252: queued + processing, used as sink occupancy pressure. */
  queueActive?: number;
  /** ADR-252: queue/ACT saturation ratio used by backpressure. */
  queueSaturation?: number;
  /** ADR-252: threshold that triggered queue backpressure. */
  queueBackpressureThreshold?: number;
}

export type GateVerdict =
  | { type: "act"; candidate: ActionCandidate }
  | { type: "silent"; level: SilenceLevel; reason: string; values?: SilenceValues }
  | { type: "pass" };

/**
 * 门控链组合器：第一个非 "pass" 判决获胜。
 * @see paper-five-dim/ §4.2: Gate Pipeline
 */
export function runGateChain(gates: Array<() => GateVerdict>): GateVerdict {
  for (const gate of gates) {
    const v = gate();
    if (v.type !== "pass") return v;
  }
  return { type: "pass" };
}

// -- Gate 函数 ---------------------------------------------------------------

/**
 * Gate: 空闲自启动 — 长时间无行动时触发已选声部。
 * ADR-81: 不再硬编码 reflection，而是使用已选中的声部。
 *
 * dt 迁移：idleThresholdS 单位为秒，idleSinceActionS 为墙钟秒差。
 * @see paper-five-dim §4.2 "Idle Self-Start"
 */
export function gateIdleSelfStart(
  idleSinceActionS: number,
  idleThresholdS: number,
  selectedAction: VoiceAction,
  target: string | null,
  focalEntities: string[],
): GateVerdict {
  if (idleSinceActionS >= idleThresholdS) {
    return {
      type: "act",
      candidate: {
        action: selectedAction,
        target,
        focalEntities: target != null ? focalEntities : [],
        netValue: 0,
        deltaP: 0,
        socialCost: 0,
      },
    };
  }
  return { type: "pass" };
}

/**
 * Gate: 危机模式 — 仅封锁危机频道自身的非社交义务行动。
 *
 * 设计边界：此 gate 是**消息洪水安全阀**（频率异常 → 抑制刷屏），
 * 不处理「Alice 被个人攻击/霸凌」场景。个人攻击的情绪反应通过
 * 另一条涌现管线实现：LLM 语义感知 → feel() → mood 声部调制 → 行为涌现。
 * 两条管线独立且互补，不要混淆。
 * @see soul.mod.ts "When someone is upset" — 人设层的攻击应对引导
 *
 * ADR-84 修正：旧逻辑 `!isCrisisTarget || !hasDirected` 会连坐非危机频道。
 * 新逻辑：非危机频道直接 pass；危机频道 + shouldBypassGates → pass（穿透）；
 * 危机频道 + 非义务行动 → CRISIS_OVERRIDE。
 *
 * @see docs/adr/84-theory-code-final-alignment.md
 */
export function gateCrisisMode(
  _G: WorldModel,
  target: string | null,
  crisisChannels: string[],
  shouldBypassGates: boolean,
): GateVerdict {
  if (crisisChannels.length === 0 || !target) return { type: "pass" };
  const isCrisisTarget = crisisChannels.includes(target);
  // 非危机频道 → 不受影响（修复旧逻辑的连坐问题）
  if (!isCrisisTarget) return { type: "pass" };
  // 危机频道 + directed/continuation 穿透
  if (shouldBypassGates) return { type: "pass" };
  // 危机频道 + 非义务行动 → 紧急刹车
  return { type: "silent", level: "CRISIS_OVERRIDE", reason: "crisis_mode" };
}

/**
 * Gate: 硬上限安全兜底 — chat-type-aware 行动频率超限。
 *
 * 私聊和群聊使用独立的行动计数和上限，互不侵占配额。
 * directed/continuation 目标跳过此 gate（与其他 gate 一致）。
 *
 * @param classActionCount - 与当前 target 同类（private/group）的窗口内行动数
 * @param classCap         - 该类别的行动数硬上限
 * @see ADR-113 F15: Rate cap 不区分群聊/私聊
 */
export function gateRateCap(
  classActionCount: number,
  classCap: number,
  apiValue: number,
  shouldBypassGates: boolean,
): GateVerdict {
  if (shouldBypassGates) return { type: "pass" };
  if (classActionCount >= classCap) {
    return {
      type: "silent",
      level: "L2_ACTIVE_COOLING",
      reason: "rate_cap",
      values: { apiValue },
    };
  }
  return { type: "pass" };
}

/**
 * Gate: L2 Active Cooling — 指数衰减替代硬上限。
 * directed 目标跳过此 gate。
 * @see paper/ Definition 8, C_temp: density-based cooling
 */
export function gateActiveCooling(
  recentActionsCount: number,
  lambdaC: number,
  bypassGates: boolean,
  apiValue: number,
  rng: () => number = Math.random,
): GateVerdict {
  if (bypassGates) return { type: "pass" };
  const actionProb = Math.exp(-recentActionsCount / Math.max(lambdaC, 0.01));
  if (rng() > actionProb) {
    return {
      type: "silent",
      level: "L2_ACTIVE_COOLING",
      reason: "active_cooling",
      values: { apiValue },
    };
  }
  return { type: "pass" };
}

/**
 * Gate: API 下限门控 — 压力太低时不行动（Circadian 调制）。
 * bypass 目标跳过此 gate。
 *
 * @see paper-five-dim/ Axiom 4: silence when aggregate pressure below threshold
 */
export function gateAPIFloor(
  apiValue: number,
  effectiveFloor: number,
  circadian: number,
  bypassGates: boolean,
  bestV: number,
): GateVerdict {
  if (bypassGates) return { type: "pass" };
  // 审计修复: API 范围是 [0, 7)（P1-P6 + P_prospect），乘数从 6 → 7。
  if (apiValue < effectiveFloor * 7 * circadian) {
    return {
      type: "silent",
      level: "L1_LOW_PRESSURE",
      reason: "api_floor",
      values: { netValue: bestV, apiValue },
    };
  }
  return { type: "pass" };
}

/**
 * Gate: Closing Conversation — leave() 后阻断对该 target 的后续行动。
 *
 * Alice 说了"再见"后不应继续发消息，除非对方在 closing 之后
 * 发了新的 directed 消息（允许对方重新拉回 Alice）。
 *
 * F3 修复：穿透条件基于 **时间戳比较**（last_directed_ms > closing_since_ms），
 * 而非累积 effectiveObligation。旧实现中 closing 前残留的 pending_directed
 * 衰减值可能意外穿透告别承诺。
 */
export function gateClosingConversation(G: WorldModel, target: string | null): GateVerdict {
  if (!target || !G.has(target)) return { type: "pass" };
  const convId = findConversationForChannel(G, target);
  if (!convId || !G.has(convId)) return { type: "pass" };

  const convAttrs = G.getConversation(convId);
  if (convAttrs.state === "closing") {
    // F3: 时间戳精确比较——只有 closing 之后的新 directed 消息才能穿透
    const closingSinceMs = convAttrs.closing_since_ms ?? convAttrs.last_activity_ms ?? 0;
    const lastDirectedMs = G.getChannel(target).last_directed_ms ?? 0;
    if (lastDirectedMs > closingSinceMs) return { type: "pass" };
    return {
      type: "silent",
      level: "L2_ACTIVE_COOLING",
      reason: "closing_conversation",
    };
  }
  return { type: "pass" };
}

/**
 * Gate: Conversation-aware — 基于对话状态调整行动门控。
 * @see paper/ ADR-26 §3 "Conversation State Machine"
 */
export function gateConversationAware(
  G: WorldModel,
  target: string | null,
): { lambdaMultiplier: number; silenceBoost: boolean } {
  if (!target || !G.has(target)) return { lambdaMultiplier: 1.0, silenceBoost: false };
  const convId = findConversationForChannel(G, target);
  if (!convId || !G.has(convId)) return { lambdaMultiplier: 1.0, silenceBoost: false };

  const convAttrs = G.getConversation(convId);
  if (convAttrs.state === "active" && convAttrs.turn_state === "alice_turn") {
    return { lambdaMultiplier: 0.5, silenceBoost: false }; // 降低 lambda，更容易通过
  }
  if (convAttrs.state === "closing") {
    return { lambdaMultiplier: 1.0, silenceBoost: true }; // 自然结束
  }
  if (convAttrs.state === "cooldown") {
    return { lambdaMultiplier: 2.0, silenceBoost: false }; // 冷却期阻止主动发起
  }
  return { lambdaMultiplier: 1.0, silenceBoost: false };
}
