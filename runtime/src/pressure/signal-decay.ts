/**
 * 信号衰减层 — 认知架构的感觉寄存器。
 *
 * 认知三层架构：
 *   感觉层（本模块）  — 原始观测 × 时间衰减 → 有效信号
 *   工作层（BeliefStore）— 多次观测的贝叶斯整合（μ, σ², tObs）
 *   情景层（info_item） — 长期存储 + 间隔重复
 *
 * 核心不变量：
 *   所有用于控制决策（模式转换、门控、System 1 判断）的图属性读取
 *   MUST 通过本模块的衰减函数。直接读取 nodeAttrs 做布尔判断是反模式。
 *
 * 衰减核选择——事件信号 vs 记忆信号：
 *
 *   本模块的所有信号（obligation, mention, risk, outcome, outgoing, unread）
 *   均为**事件驱动信号**——由具体事件触发、随时间自然消退。
 *   正确的物理模型是**指数衰减**（一阶动力学）：
 *     S_eff(t) = neutral + (S_raw - neutral) × 2^(-t / τ_half)
 *
 *   这与 Wickelgren (1974) 双曲线 (1+βt)^(-ψ) 是不同的物理过程：
 *   - 指数衰减 = 恒速率消退（感觉寄存器、药物清除、放射衰变）
 *   - 双曲线 = 记忆痕迹的干扰累积（Rubin & Wenzel 1996 的元分析对象）
 *
 *   Atkinson & Shiffrin (1968) 三存储模型中，感觉寄存器层的特征正是
 *   快速指数衰减（Sperling 1960 部分报告法实验：τ ≈ 250ms）。
 *   本模块将此机制推广到社交信号层（τ = 分钟~小时级）。
 *
 *   指数核的自然消退性质：10 个半衰期后残余 0.1%（2^-10 ≈ 0.001），
 *   无需人工硬截断，信号自然归零。
 *
 * 抗性机制：
 *   1. 所有信号定义集中在此文件 — 单一事实源
 *   2. 每个信号绑定 (valueKey, tsKey, halfLife) — 无法遗漏时间戳
 *   3. 消费者只能导入命名函数 — API 强制时间感知
 *
 * @see docs/adr/134-temporal-coherence.md — 信号寿命与感知地平线
 * @see docs/adr/126-obligation-field-decay.md
 * @see Atkinson & Shiffrin (1968) — 三存储模型：感觉寄存器 = 指数衰减
 * @see Sperling (1960) — 部分报告法：感觉记忆指数衰减 τ ≈ 250ms
 * @see Wickelgren (1974) — 单迹脆弱性理论（记忆保持，非事件信号）
 * @see Rubin & Wenzel (1996) — 百年遗忘函数元分析（记忆保持，非事件信号）
 */

import { findActiveConversation } from "../graph/queries.js";
import type { WorldModel } from "../graph/world-model.js";
import { ChatTarget } from "../prompt/types.js";
import { readNodeMs } from "./clock.js";

// ═══════════════════════════════════════════════════════════════════════════
// 通用衰减核心
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 事件信号指数衰减。
 *
 * S_eff(t) = neutral + (S_raw - neutral) × 2^(-ageS / halfLifeS)
 *
 * 指数核性质：
 *   - 恰好 1 个半衰期后信号减半（定义）
 *   - 10 个半衰期后残余 0.1%（自然消退，无需硬截断）
 *   - 恒速率消退——与一阶动力学（感觉记忆、药物清除）一致
 *
 * @param value - 原始信号值
 * @param ageS - 观测年龄（秒）
 * @param halfLifeS - 半衰期（秒）
 * @param neutral - 衰减目标（默认 0）
 * @returns 衰减后的有效值，趋向 neutral
 *
 * @see docs/adr/134-temporal-coherence.md §D1
 */
export function decaySignal(value: number, ageS: number, halfLifeS: number, neutral = 0): number {
  if (ageS <= 0) return value;
  const decay = 2 ** (-ageS / halfLifeS);
  return neutral + (value - neutral) * decay;
}

// ═══════════════════════════════════════════════════════════════════════════
// 信号 1: Obligation（pending_directed 义务场）
// ═══════════════════════════════════════════════════════════════════════════

/** 私聊义务半衰期（秒）。 */
export const OBLIGATION_HALFLIFE_PRIVATE = 3600;
/** 群聊义务半衰期（秒）。ADR-186: 统一为 3600s——响应紧迫度不应因场景而异。 */
export const OBLIGATION_HALFLIFE_GROUP = 3600;

export const OBLIGATION_THRESHOLDS = {
  /** 模式进入：只有新鲜义务才触发 patrol → conversation。 */
  modeEnter: 0.3,
  /** 模式退出：义务已充分衰减时允许退出（滞回防震荡）。 */
  modeExit: 0.1,
  /** 门控绕过：轻微陈旧仍允许绕过门控。 */
  bypassGates: 0.2,
  /** System 1 升级：任何非平凡义务都需要 LLM。 */
  system1: 0.1,
  /** Mod 信号：observer/consolidation 阈值。 */
  signal: 0.1,
} as const;

/**
 * 有效义务：pending_directed × 指数时间衰减（无地板）。
 * Ω(h,t) = pending_directed(h) × 2^(-(t - t_last) / τ_half)
 */
export function effectiveObligation(G: WorldModel, channelId: string, nowMs: number): number {
  if (!G.has(channelId)) return 0;

  const attrs = G.getChannel(channelId);
  const directed = Number(attrs.pending_directed ?? 0);
  if (directed <= 0) return 0;

  const lastDirectedMs = readNodeMs(G, channelId, "last_directed_ms");
  if (lastDirectedMs <= 0) return directed;

  const ageS = Math.max(0, (nowMs - lastDirectedMs) / 1000);
  const chatType = attrs.chat_type ?? "private";
  const halfLife = ChatTarget.isGroupChat(chatType)
    ? OBLIGATION_HALFLIFE_GROUP
    : OBLIGATION_HALFLIFE_PRIVATE;

  return decaySignal(directed, ageS, halfLife);
}

/** 便捷布尔：有效义务 > 阈值。默认 θ = 0.1。 */
export function hasObligation(
  G: WorldModel,
  channelId: string,
  nowMs: number,
  threshold: number = OBLIGATION_THRESHOLDS.signal,
): boolean {
  return effectiveObligation(G, channelId, nowMs) > threshold;
}

// ═══════════════════════════════════════════════════════════════════════════
// 信号 2: Mention（mentions_alice 名字提及）
// ═══════════════════════════════════════════════════════════════════════════

/** 名字提及衰减半衰期（秒）。15 分钟——提及是瞬时社交信号。 */
export const MENTION_HALFLIFE_S = 900;

/**
 * 有效提及强度：mentions_alice × 时间衰减。
 *
 * 消费 mentions_alice（boolean → 1/0）和 mentions_alice_ms（时间戳）。
 * 15 分钟后衰减至 0.5，30 分钟后 0.25。
 *
 * @returns ∈ [0, 1]，0 = 无提及或完全衰减
 */
export function effectiveMention(G: WorldModel, channelId: string, nowMs: number): number {
  if (!G.has(channelId)) return 0;

  const attrs = G.getChannel(channelId);
  if (!attrs.mentions_alice) return 0;

  const mentionMs = readNodeMs(G, channelId, "mentions_alice_ms");
  if (mentionMs <= 0) return 1; // 无时间戳 → 视为刚发生

  const ageS = Math.max(0, (nowMs - mentionMs) / 1000);
  return decaySignal(1, ageS, MENTION_HALFLIFE_S);
}

// ═══════════════════════════════════════════════════════════════════════════
// 信号 3: Risk（risk_level 风险评级）
// ═══════════════════════════════════════════════════════════════════════════

/** 风险衰减半衰期（秒）。30 分钟——与 focus.ts 的 decayFactor(ageS/60, 10.0) 语义一致。 */
export const RISK_HALFLIFE_S = 1800;

const RISK_NUMERIC: Record<string, number> = {
  none: 0,
  low: 0.25,
  medium: 0.5,
  high: 1.0,
};

/**
 * 有效风险强度：risk_level（类别 → 数值）× 时间衰减。
 *
 * 复用 focus.ts 中已验证的衰减语义——那里正确地衰减了风险，
 * 但 system1.ts 和 social-cost.ts 遗漏了。本函数统一所有读取路径。
 *
 * @returns ∈ [0, 1]，0 = 无风险或完全衰减
 */
export function effectiveRisk(G: WorldModel, channelId: string, nowMs: number): number {
  if (!G.has(channelId)) return 0;

  const attrs = G.getChannel(channelId);
  const riskLevel = String(attrs.risk_level ?? "none");
  const riskValue = RISK_NUMERIC[riskLevel] ?? 0;
  if (riskValue <= 0) return 0;

  const riskMs = readNodeMs(G, channelId, "risk_updated_ms");
  if (riskMs <= 0) return riskValue;

  const ageS = Math.max(0, (nowMs - riskMs) / 1000);
  return decaySignal(riskValue, ageS, RISK_HALFLIFE_S);
}

/**
 * 风险是否低于 "需要关注" 阈值。替代 isLowRisk() 的布尔判断。
 * 阈值 0.3 = "low"(0.25) 和 "medium"(0.5) 的分界线。
 * "none"(0) 和 "low"(0.25) 视为可忽略，与旧 isLowRisk 语义一致。
 */
export function isRiskNegligible(G: WorldModel, channelId: string, nowMs: number): boolean {
  return effectiveRisk(G, channelId, nowMs) < 0.3;
}

// ═══════════════════════════════════════════════════════════════════════════
// 信号 4: Outcome Quality（last_outcome_quality 交互质量）
// ═══════════════════════════════════════════════════════════════════════════

/** 交互质量衰减半衰期（秒）。1 小时——过去的差评不应永久影响社交成本。 */
export const OUTCOME_HALFLIFE_S = 3600;

/**
 * 有效交互质量：last_outcome_quality 向中性值 (0.5) 衰减。
 *
 * Q_eff(t) = 0.5 + (Q_raw - 0.5) × 2^(-ageS / halfLife)
 *
 * 新鲜的差评 (0.2) → 0.2（强信号）
 * 陈旧的差评 (0.2, 2h) → 趋向 0.5（中性）
 *
 * @returns ∈ [0, 1]，趋向 0.5（中性）
 */
export function effectiveOutcomeQuality(G: WorldModel, channelId: string, nowMs: number): number {
  if (!G.has(channelId)) return 0.5;

  const attrs = G.getChannel(channelId);
  const quality = Number(attrs.last_outcome_quality ?? 0.5);

  const outcomeMs = readNodeMs(G, channelId, "last_outcome_ms");
  if (outcomeMs <= 0) return quality;

  const ageS = Math.max(0, (nowMs - outcomeMs) / 1000);
  return decaySignal(quality, ageS, OUTCOME_HALFLIFE_S, 0.5);
}

// ═══════════════════════════════════════════════════════════════════════════
// 信号 5: Outgoing Pressure（consecutive_outgoing 连发压力）
// ═══════════════════════════════════════════════════════════════════════════

/** 连发压力衰减半衰期（秒）。24 小时——一天后社交语境已重置。 */
export const OUTGOING_HALFLIFE_S = 86400;

/**
 * 有效连发压力：consecutive_outgoing × 时间衰减。
 *
 * 5 分钟内连发 4 条 → 极高侵入性
 * 24 小时后连发 4 条 → 衰减到 2（允许重新接触）
 *
 * 注意：原始计数器在对方回复时归零（mapper.ts），衰减只影响对方不回的情况。
 *
 * @returns ∈ [0, +∞)，0 = 无连发或完全衰减
 */
export function effectiveOutgoing(G: WorldModel, channelId: string, nowMs: number): number {
  if (!G.has(channelId)) return 0;

  const attrs = G.getChannel(channelId);
  const outgoing = Number(attrs.consecutive_outgoing ?? 0);
  if (outgoing <= 0) return 0;

  const lastOutgoingMs = readNodeMs(G, channelId, "last_outgoing_ms");
  if (lastOutgoingMs <= 0) return outgoing;

  const ageS = Math.max(0, (nowMs - lastOutgoingMs) / 1000);
  return decaySignal(outgoing, ageS, OUTGOING_HALFLIFE_S);
}

// ═══════════════════════════════════════════════════════════════════════════
// 信号 6: Unread Freshness（P1 未读消息新鲜度）
// ═══════════════════════════════════════════════════════════════════════════

/** P1 未读新鲜度半衰期（秒）。1 小时——与 obligation 私聊一致。 */
export const UNREAD_FRESHNESS_HALFLIFE_S = 3600;

/**
 * Tonic 注意力增益系数。
 *
 * tonic = κ × ln(1 + rawUnread) 提供持续基线感知，
 * 防止旧积压因 phasic（EWMS）衰减而变得不可见。
 *
 * @see docs/adr/176-tonic-phasic-attention.md
 * @see Posner & Petersen (1990) — tonic/phasic 注意力分解
 */
export const KAPPA_TONIC = 1.0;

/**
 * 有效未读数：max(phasic, tonic)。
 *
 * - Phasic（警觉）：EWMS × 指数衰减——刺激驱动，快速起效快速消退。
 * - Tonic（持续）：κ × ln(1 + rawUnread)——覆盖度感知，Weber-Fechner 对数缩放。
 *
 * max() 而非 sum()：避免双重计数新鲜消息。新消息用 phasic（更高信号），
 * 旧积压用 tonic（phasic 衰减到 tonic 地板以下后接管）。
 *
 * @see docs/adr/176-tonic-phasic-attention.md
 * @see docs/adr/134-temporal-coherence.md §D2
 * @see docs/adr/150-ewms-exact-unread-decay.md
 */
export function effectiveUnread(G: WorldModel, channelId: string, nowMs: number): number {
  if (!G.has(channelId)) return 0;
  const attrs = G.getChannel(channelId);
  const rawUnread = attrs.unread ?? 0;
  if (rawUnread <= 0) return 0;

  // Phasic: EWMS × 指数衰减（ADR-150）
  const ewms = Number(attrs.unread_ewms ?? 0);
  const ewmsMs = Number(attrs.unread_ewms_ms ?? 0);
  let phasic = 0;
  if (ewms > 0 && ewmsMs > 0) {
    const ageS = Math.max(0, (nowMs - ewmsMs) / 1000);
    phasic = ewms * decaySignal(1.0, ageS, UNREAD_FRESHNESS_HALFLIFE_S);
  }

  // Tonic: Weber-Fechner 对数感知（ADR-176）
  const tonic = KAPPA_TONIC * Math.log(1 + rawUnread);

  return Math.max(phasic, tonic);
}

// ═══════════════════════════════════════════════════════════════════════════
// 信号 7: Act Silence（连续 ACT 沉默的时间衰减）
// ═══════════════════════════════════════════════════════════════════════════

/** ACT 沉默衰减半衰期（秒）。30 分钟——暂时性 Telegram 错误不应永久封锁频道。 */
export const ACT_SILENCE_HALFLIFE_S = 1800;

/** 连续行动沉默安全阈值。effectiveActSilences 超过此值时跳过 directed_override 候选。 */
export const ACT_SILENCE_SAFETY_THRESHOLD = 5;

/**
 * 沉默冷却阈值。effectiveActSilences >= 此值时，沉默原因标记为 "silence_cooldown"。
 * @see docs/adr/157-signal-decay-integrity.md §Fix 4
 */
export const SILENCE_COOLDOWN_THRESHOLD = 3;

/**
 * 有效 ACT 沉默计数：consecutive_act_silences × 时间衰减。
 *
 * ADR-136: 替代旧的 `actSilences >= 3` 硬门控。连续失败后系统
 * 自动在 30 分钟半衰期内恢复——不再需要成功发送来"解锁"。
 *
 * 消费 consecutive_act_silences 和 last_act_silence_ms（时间戳）。
 *
 * @returns ≥ 0 的连续值。3 次失败 + 30 分钟后 → ~1.5。
 *
 * @see docs/adr/136-constrained-vmax/README.md §2.3 σ_fail
 */
export function effectiveActSilences(
  G: WorldModel,
  channelId: string,
  nowMs: number,
  halfLifeS = ACT_SILENCE_HALFLIFE_S,
): number {
  if (!G.has(channelId)) return 0;

  const attrs = G.getChannel(channelId);
  const silences = Number(attrs.consecutive_act_silences ?? 0);
  if (silences <= 0) return 0;

  const lastSilenceMs = readNodeMs(G, channelId, "last_act_silence_ms");
  if (lastSilenceMs <= 0) return silences; // 无时间戳 → 不衰减

  const ageS = Math.max(0, (nowMs - lastSilenceMs) / 1000);
  return decaySignal(silences, ageS, halfLifeS);
}

// ═══════════════════════════════════════════════════════════════════════════
// 信号 8: Aversion（社交回避的指数衰减）
// ═══════════════════════════════════════════════════════════════════════════

/** 群聊回避衰减时间常数（秒）。群聊气氛变化快，2 小时。 */
const AVERSION_TAU_GROUP_S = 2 * 3600;
/** 私聊回避衰减时间常数（秒）。私聊情绪持续更久，8 小时。 */
const AVERSION_TAU_PRIVATE_S = 8 * 3600;

/**
 * ADR-217: 有效回避强度 ∈ [0, 1]。
 *
 * 指数衰减：aversion(t) = A × exp(-age / τ)
 * τ 按 chat_type 区分：群聊 2h，私聊 8h。
 *
 * 不被 directed 消息重置（与 act_silences 完全分离）。
 * 恢复路径：时间自然衰减 + LLM 主动解除。
 *
 * @see docs/adr/217-pressure-field-aversion-gap.md §方案 D
 */
export function effectiveAversion(G: WorldModel, channelId: string, nowMs: number): number {
  if (!G.has(channelId)) return 0;

  const attrs = G.getChannel(channelId);
  const raw = Number(attrs.aversion ?? 0);
  if (raw <= 0) return 0;

  const eventMs = Number(attrs.aversion_ms ?? 0);
  if (eventMs <= 0) return raw; // 无时间戳 → 不衰减

  const ageS = Math.max(0, (nowMs - eventMs) / 1000);
  const chatType = attrs.chat_type;
  const tau = chatType === "private" ? AVERSION_TAU_PRIVATE_S : AVERSION_TAU_GROUP_S;

  return raw * Math.exp(-ageS / tau);
}

// ═══════════════════════════════════════════════════════════════════════════
// 信号 9: Resting（Alice 主动离席/睡觉）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Alice 主动选择休息时，普通行动候选应暂停。
 *
 * 这是结构化的状态事实，不从“晚安”等文本里猜测。只有 LLM 显式给出
 * afterward=resting 时写入 self.resting_until_ms。
 */
export function isSelfResting(G: WorldModel, nowMs: number): boolean {
  if (!G.has("self")) return false;
  const untilMs = Number(G.getAgent("self").resting_until_ms ?? 0);
  return untilMs > nowMs;
}

// ═══════════════════════════════════════════════════════════════════════════
// 对话延续信号（共享判定）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 对话延续判定：目标频道处于活跃对话的 alice_turn 且无显式社交义务。
 *
 * 三处消费者（evolve.ts ×2, iaus-scorer.ts ×1）共享此函数，
 * 消除 inline 重复导致的维护炸弹。
 *
 * 返回 true 的条件（全部满足）：
 * 1. target 存在于图中
 * 2. 最后发言者不是 bot（bot 发言后 alice_turn 不代表社交期望）
 * 3. 无有效显式义务（effectiveObligation ≤ bypassGates）
 * 4. target 上有活跃对话（state ∈ {pending, opening, active}）
 * 5. 对话 turn_state === "alice_turn"
 */
export function isConversationContinuation(G: WorldModel, target: string, nowMs: number): boolean {
  if (!G.has(target)) return false;
  if (G.getChannel(target).last_sender_is_bot === true) return false;
  if (effectiveObligation(G, target, nowMs) > OBLIGATION_THRESHOLDS.bypassGates) return false;
  const convId = findActiveConversation(G, target);
  if (!convId || !G.has(convId)) return false;
  return G.getConversation(convId).turn_state === "alice_turn";
}

// ─── ADR-222: Habituation（适应性衰减）──────────────────────────────

/**
 * ADR-222: 适应性衰减因子 ρ_H = 1/(1 + α·H_eff)。
 *
 * H_eff = H · 2^(-elapsed/halfLife) 是时间衰减后的有效适应状态。
 * 对重复刺激的响应递减——从视网膜到皮层的普遍物理约束。
 *
 * 与除法归一化模型同构：R = E/(σ+E)（Carandini & Heeger 2012）。
 * 双曲线 1/(1+αH) 是其 n=1 特例。
 *
 * @param H - 适应性累积值（每次行动 +1.0，指数衰减）
 * @param habituationMs - 上次更新的墙钟时间（ms）
 * @param nowMs - 当前时间（ms）
 * @param alpha - 适应性强度（默认 0.5）
 * @param halfLifeS - 衰减半衰期（秒，默认 1800 = 30 分钟）
 * @returns 乘性衰减系数 ∈ (0, 1]
 *
 * @see docs/adr/222-habituation-truth-model.md
 * @see Carandini & Heeger (2012) — Normalization as a canonical neural computation
 */
export function computeHabituationFactor(
  H: number,
  habituationMs: number,
  nowMs: number,
  alpha = 0.5,
  halfLifeS = 1800,
): number {
  if (H <= 0 || habituationMs <= 0) return 1.0;
  const ageS = Math.max(0, (nowMs - habituationMs) / 1000);
  const effectiveH = H * 2 ** (-ageS / halfLifeS);
  if (effectiveH < 0.01) return 1.0; // 数值归零
  return 1 / (1 + alpha * effectiveH);
}

// ═══════════════════════════════════════════════════════════════════════════
// ADR-225: Dormant Mode — 昼夜节律辅助
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 判断给定的本地小时是否在 quiet window 内。
 * 支持跨午夜（start > end，如 23-7）。
 * @see docs/adr/225-dormant-mode.md
 */
export function isInQuietWindow(localHour: number, start: number, end: number): boolean {
  if (start <= end) {
    // 不跨午夜（如 1-6）
    return localHour >= start && localHour < end;
  }
  // 跨午夜（如 23-7）
  return localHour >= start || localHour < end;
}

/**
 * Dormant 调制因子 ρ_C。
 * dormant 时全维度压力 ×0.1（包括 P5——睡觉时义务不累积）。
 * 非 dormant 时返回 1.0（无调制）。
 */
export const DORMANT_PRESSURE_FACTOR = 0.1;
