/**
 * IAUS (Infinite Axis Utility System) 评分器 — ADR-180 Phase 2。
 *
 * 替代 V-maximizer 的加法 NSV 评分：
 * - 旧：NSV = ΔP - λ·C_social（加法，声部先选→目标后选，两步决策）
 * - 新：V = CF(∏ U_k)（乘法 Considerations，action_type × target 一步选出）
 *
 * 每个 Consideration 是纯函数 (input, curve) → [ε, 1]。
 * 所有 Considerations 乘积经 Compensation Factor 校正后通过 Boltzmann softmax 选择。
 *
 * Caution 不再是独立 action_type。R_Caution 作为 U_conflict_avoidance
 * 共享 Consideration 参与所有 action_type 的乘法评分。
 *
 * @see docs/adr/180-iaus-migration/README.md
 * @see paper/ §3: 六维压力场
 */

import type { BeliefStore } from "../belief/store.js";
import { readEmotionControlPatch } from "../emotion/graph.js";
import type { EmotionControlPatch } from "../emotion/types.js";
import { type TensionVector, ZERO_TENSION } from "../graph/tension.js";
import type { WorldModel } from "../graph/world-model.js";
import {
  effectiveActSilences,
  effectiveAversion,
  effectiveObligation,
  isConversationContinuation,
  isSelfResting,
  OBLIGATION_THRESHOLDS,
} from "../pressure/signal-decay.js";
import {
  computeSocialCost,
  type SaturationCostConfig,
  type SocialCostConfig,
} from "../pressure/social-cost.js";
import { computeVoI, estimateDeltaP } from "../pressure/social-value.js";
import { type ChannelClass, ChatTarget } from "../prompt/types.js";
import type { PressureDims } from "../utils/math.js";
import { std } from "../utils/math.js";
import { rCaution, readSelfMood } from "../voices/focus.js";
import { type PersonalityVector, VOICE_INDEX, type VoiceAction } from "../voices/personality.js";
import { DEFAULT_VOICE_COOLDOWN, voiceFatigue } from "./deliberation.js";
import { type Desire, findTopDesireForTarget } from "./desire.js";
import { classifyChatType, gateClosingConversation, resolveIsBot } from "./gates.js";

// ═══════════════════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════════════════

/** 最小 Consideration 值——禁止绝对否决。 */
const EPSILON = 0.01;

/** ADR-185 §1: Desire boost 默认系数。 */
const DEFAULT_DESIRE_BOOST = 0.15;
/** ADR-182 D1: Momentum bonus 默认系数。 */
const DEFAULT_MOMENTUM_BONUS = 0.2;
/** ADR-182 D1: Momentum 衰减超时（ms）。 */
const DEFAULT_MOMENTUM_DECAY_MS = 300_000;
/** ADR-251 Wave 1: 无回应 private proactive 短 burst 软恢复窗口。 */
const PROACTIVE_PACING_MIN_INTERVAL_MS = 60_000;
/** ADR-251 Wave 1: 最近主动外展的软阻尼下限。硬限制只用于 100% 确定的语义门。 */
const PROACTIVE_PACING_RECENT_MIN = 0.2;
/** ADR-251 Wave 1: 单方连续输出阻尼斜率。 */
const PROACTIVE_PACING_CONSECUTIVE_GAIN = 2.5;
/** ADR-268: lonely connection pull must not amplify repeated unsolicited outreach. */
const EMOTION_PROACTIVE_CAP_MIN = 0.2;
/** ADR-268: active affect gently modulates non-obligatory action tendency. */
const EMOTION_ACTION_UTILITY_MIN = 0.55;
const EMOTION_ACTION_UTILITY_MAX = 1.08;
/** 久未收到私聊 incoming 后，主动外展开始软降权。 */
const INACTIVITY_STALE_GRACE_MS = 24 * 3600_000;
/** 久未收到私聊 incoming 的软降权完整展开窗口。 */
const INACTIVITY_STALE_FULL_MS = 7 * 24 * 3600_000;
/** stale 不是不可达证明，所以只软降权，不清零。 */
const INACTIVITY_STALE_MIN = 0.15;

/**
 * ADR-218 Phase 2: U_fairness — CFS-inspired 服务比例公平 Consideration。
 *
 * 幂律映射：U_fairness = clamp(ratio^(-α), ε, U_MAX)
 *   ratio = actual_share / expected_share
 *   actual_share = service(target, window) / total_service
 *   expected_share = V_raw(target) / Σ V_raw
 *
 * ratio < 1 (欠服务) → boost > 1.0（underserved 目标加成）
 * ratio = 1 (公平)   → 1.0（中性）
 * ratio > 1 (过服务) → penalty < 1.0（overserved 目标惩罚）
 *
 * 统一替代 Phase 1 的三个离散机制（URGENCY_BOOST、URGENCY_BUDGET、U_coverage）。
 * 连续衰减，无离散跳变。
 *
 * @see docs/adr/218-attention-fairness-rank-gate-starvation.md §A4 Phase 2
 * @see Linux CFS: vruntime += delta/weight → 选 min(vruntime)
 * @see Shreedhar & Varghese 1995 (DRR deficit counter)
 */
const FAIRNESS_ALPHA = 2.0;
/** U_fairness 上界：防止 ratio→0 时无穷大。4.0 = 最多 4 倍加成。 */
const U_FAIRNESS_MAX = 4.0;
/** 服务数据不足（冷启动）时不启用公平性。 */
const FAIRNESS_MIN_TOTAL_SERVICE = 5;

/**
 * ADR-151: 观测噪声方差（Kalman 信息比率分母常数）。
 * @see docs/adr/151-algorithm-audit/ #1 VoI 信息增益项
 */
const SIGMA2_OBS = 0.1;

/** 群组沉默衰减下限，防止死亡螺旋。@see ADR-116 */
const GROUP_SILENCE_DAMPING_FLOOR = 0.3;

/** IAUS 候选的 3 种行动类型（Caution 已折叠为 U_conflict_avoidance）。 */
const IAUS_ACTIONS: readonly VoiceAction[] = ["diligence", "curiosity", "sociability"] as const;

/** Mood 调制系数。@see loudness.ts PSI */
const MOOD_DELTA = 0.3;

/** ADR-183: 等权人格中性点（π_v = 0.25 时曲线不变）。 */
const PERSONALITY_NEUTRAL = 0.25;
/** ADR-183: 默认曲线调制强度。 */
const DEFAULT_CURVE_MODULATION_STRENGTH = 0.5;

// ═══════════════════════════════════════════════════════════════════════════
// Response Curves
// ═══════════════════════════════════════════════════════════════════════════

type CurveType = "sigmoid" | "inv_sigmoid" | "linear" | "linear_dec" | "log" | "exp_recovery";

export interface ResponseCurve {
  type: CurveType;
  /** sigmoid 中点 / linear 范围起点。 */
  midpoint: number;
  /** sigmoid 斜率 / linear 全程宽度。 */
  slope: number;
  /** 输出下限 (≥ ε)。 */
  min: number;
  /** 输出上限 (≤ 1.0)。 */
  max: number;
}

/**
 * 评估 Response Curve。输出 clamp 到 [curve.min, curve.max]。
 *
 * - sigmoid: S 曲线，从 min 到 max，中心 x=midpoint
 * - inv_sigmoid: 反向 S 曲线，从 max 到 min
 * - linear: 线性递增（x=midpoint → min，x=midpoint+slope → max）
 * - linear_dec: 线性递减（x=midpoint → max，x=midpoint+slope → min）
 * - log: 对数增长
 * - exp_recovery: 指数恢复（1 - exp(-...)）
 */
export function evalCurve(curve: ResponseCurve, x: number): number {
  let t: number;
  switch (curve.type) {
    case "sigmoid":
      t = 1 / (1 + Math.exp(-curve.slope * (x - curve.midpoint)));
      break;
    case "inv_sigmoid":
      t = 1 - 1 / (1 + Math.exp(-curve.slope * (x - curve.midpoint)));
      break;
    case "linear":
      t = curve.slope > 0 ? clamp01((x - curve.midpoint) / curve.slope) : 0;
      break;
    case "linear_dec":
      t = 1 - (curve.slope > 0 ? clamp01((x - curve.midpoint) / curve.slope) : 0);
      break;
    case "log":
      if (curve.slope <= 0 || curve.midpoint <= 0) {
        t = 0;
      } else {
        t = clamp01(
          Math.log(1 + Math.max(0, x) * curve.slope) / Math.log(1 + curve.midpoint * curve.slope),
        );
      }
      break;
    case "exp_recovery":
      t = 1 - Math.exp(-curve.slope * Math.max(0, x - curve.midpoint));
      break;
  }
  return Math.max(curve.min, Math.min(curve.max, curve.min + (curve.max - curve.min) * t));
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * ADR-183 Direction A: 人格驱动曲线调制。
 *
 * 高 π_v → 更低 midpoint（更早激活） + 更陡 slope（更尖锐响应）。
 * 低 π_v → 更高 midpoint（更晚激活） + 更平 slope（更迟钝响应）。
 * 等权人格（π_v = 0.25）= 零调制（基准不变）。
 *
 * 稳定性保证：在 π_v ∈ [0.05, 0.5]、strength ∈ [0, 1] 范围内，
 * midpoint 乘子 ∈ [0.50, 1.40]，slope 乘子 ∈ [0.60, 1.50]——永不为负。
 * （默认 strength=0.5 时：midpoint ∈ [0.75, 1.20]，slope ∈ [0.80, 1.25]）
 *
 * @see docs/adr/183-iaus-motive-layer-curve-modulation.md §3
 * @see Game AI Pro Ch.9 — "traits modify the shape of consideration curves"
 */
export function modulateCurve(base: ResponseCurve, piV: number, strength: number): ResponseCurve {
  if (strength <= 0) return base;
  const delta = (piV - PERSONALITY_NEUTRAL) * strength;
  return {
    ...base,
    midpoint: base.midpoint * (1 - delta * 2),
    slope: base.slope * (1 + delta * 2),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Entity-Gated Dormancy
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 当压力维度的图实体不存在时（τ₄=0 无线程、τ₅=0 无回应义务），
 * 返回 1.0（中性），不是 ε（否决）。
 */
function dormantNeutral(rawInput: number, hasEntity: boolean, curve: ResponseCurve): number {
  if (!hasEntity && rawInput === 0) return 1.0;
  return evalCurve(curve, rawInput);
}

// ═══════════════════════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════════════════════

/**
 * IAUS 候选上下文：bypassGates 推导 + Hawkes/Goldilocks 闭包。
 */
export interface CandidateContext {
  G: WorldModel;
  nowMs: number;
  getHawkesDiscount?: (target: string) => number;
  getGoldilocksUtility?: (target: string) => number;
  getRhythmTimingProfile?: (target: string, chatType?: string) => RhythmTimingProfile | null;
}

/** gates.ts 及 idle gate 构建候选时的最小接口。 */
export interface ActionCandidate {
  action: VoiceAction;
  target: string | null;
  focalEntities: string[];
  netValue: number;
  deltaP: number;
  socialCost: number;
  degraded?: boolean;
}

/** IAUS 评分器产生的完整候选（扩展 ActionCandidate）。 */
export interface IAUSCandidate extends ActionCandidate {
  /** 逐项 Consideration 得分（调试用）。 */
  considerations: Record<string, number>;
  /** 不参与评分的 shadow 诊断。 */
  diagnostics?: IAUSCandidateDiagnostics;
  /** 是否绕过门控。 */
  bypassGates: boolean;
}

export interface IAUSScoredCandidate {
  action: string;
  target: string | null;
  V: number;
  bypassGates: boolean;
  bottleneck: string;
  deltaP: number;
  socialCost: number;
  netValue: number;
  considerations: Record<string, number>;
  diagnostics?: IAUSCandidateDiagnostics;
}

export interface RhythmTimingProfile {
  activeNowScore: number;
  quietNowScore: number;
  confidence: "low" | "medium" | "high";
  stale: boolean;
}

export interface TimingShadowDiagnostic {
  utility: number;
  applied: boolean;
  reason:
    | "bypass"
    | "unsupported_chat_type"
    | "missing_profile"
    | "low_confidence"
    | "stale"
    | "eligible";
  activeNowScore?: number;
  quietNowScore?: number;
  confidence?: RhythmTimingProfile["confidence"];
  stale?: boolean;
  netValue?: number;
  shadowNetValue?: number;
}

export interface IAUSCandidateDiagnostics {
  timingShadow?: TimingShadowDiagnostic;
}

export interface IAUSResult {
  candidate: IAUSCandidate;
  bestV: number;
  candidateCount: number;
  selectedProbability: number;
  winnerBypassGates: boolean;
  spread: number;
  scored: IAUSScoredCandidate[];
}

export interface IAUSConfig {
  candidateCtx: CandidateContext;
  kappa: PressureDims;
  contributions: Record<string, Record<string, number>>;
  beliefs: BeliefStore;
  beliefGamma: number;
  thompsonEta: number;
  socialCost: SocialCostConfig;
  saturationCost: SaturationCostConfig;
  windowStartMs: number;
  uncertainty: number;
  personality: PersonalityVector;
  voiceLastWon: Record<VoiceAction, number>;
  nowMs: number;
  excludeTargets?: ReadonlySet<string>;
  /** 候选目标白名单。设置后仅这些 target 进入 IAUS 候选池。 */
  targetWhitelist?: ReadonlySet<string> | null;
  /** 测试用：禁用 Boltzmann 随机选择，改用 argmax（确定性）。 */
  deterministic?: boolean;
  /** ADR-182 D1: 上一 tick 胜出的 (action, target)。 */
  lastWinner?: { action: VoiceAction; target: string } | null;
  /** ADR-182 D1: 上次行动的墙钟时间戳（ms）。 */
  lastActionMs?: number;
  /** ADR-182 D1: Momentum bonus 系数（默认 0.2）。 */
  momentumBonus?: number;
  /** ADR-182 D1: Momentum 衰减超时（ms，默认 300_000）。 */
  momentumDecayMs?: number;
  /** ADR-183: 曲线调制强度（0 = 无调制，1 = 最大调制）。 */
  curveModulationStrength?: number;
  /** ADR-185 §1: 当前 tick 派生的 Desire 列表。 */
  desires?: readonly Desire[];
  /** ADR-185 §1: Desire boost 系数（默认 0.15）。 */
  desireBoost?: number;
  // ADR-218 Phase 2: attentionDebtMap/attentionDebtConfig 已移除。
  // U_coverage 被 U_fairness 取代（post-scoring pass，不依赖外部 debt 数据）。

  // ── ADR-189: Gate 内化到 IAUS per-candidate pre-filter ──
  /** 危机频道列表（消息洪水安全阀）。 */
  crisisChannels?: readonly string[];
  /** chat-type-aware 行动频率硬上限。 */
  classRateCaps?: Record<ChannelClass, number>;
  /** 窗口内按 class 分类的行动数。 */
  classActionCounts?: Record<ChannelClass, number>;
}

// ═══════════════════════════════════════════════════════════════════════════
// 辅助函数（从 v-maximizer.ts 迁移）
// ═══════════════════════════════════════════════════════════════════════════

function silenceDamping(actSilences: number, chatType: string): number {
  const raw = 1 / (1 + actSilences);
  // ADR-206: channel 不是 group——频道是信息流实体，不参与社交成本计算
  return ChatTarget.isGroupChat(chatType) ? Math.max(GROUP_SILENCE_DAMPING_FLOOR, raw) : raw;
}

function extractSigma2(beliefs: BeliefStore, target: string): number {
  return beliefs.getOrDefault(target, "tier").sigma2 + beliefs.getOrDefault(target, "mood").sigma2;
}

function extractVoI(beliefs: BeliefStore, target: string): number {
  return computeVoI(extractSigma2(beliefs, target), SIGMA2_OBS);
}

function gaussianRandom(): number {
  const u1 = Math.max(1e-10, Math.random());
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * 为单个候选计算 bypassGates。从 v-maximizer.ts 的 computeCandidateLambda 提取。
 *
 * 优先级：
 * 1. permanent failure → 不 bypass（最高优先级排除）
 * 2. ADR-186: 原始 pending_directed > 0 → 无条件 bypass（不经衰减/折扣）
 * 3. directed（effectiveObligation > θ_Ω）→ bypass（覆盖非 @ 义务场景）
 * 4. conversation continuation（alice_turn）→ bypass
 */
export function computeCandidateBypass(ctx: CandidateContext, target: string): boolean {
  const { G, nowMs } = ctx;
  const isPermanentlyUnreachable =
    G.has(target) && G.getChannel(target).failure_type === "permanent";
  if (isPermanentlyUnreachable) return false;

  // ADR-186: 原始 pending_directed > 0 → 无条件 bypass（不经衰减/折扣）。
  // 有人叫 Alice 的名字，不论在哪里，都应被注意到。
  if (G.has(target)) {
    const rawDirected = Number(G.getChannel(target).pending_directed ?? 0);
    if (rawDirected > 0) return true;
  }

  // 衰减后的义务仍可触发 bypass（覆盖非 @ 义务场景）
  const obligation = G.has(target) ? effectiveObligation(G, target, nowMs) : 0;
  const targetHasDirected = obligation > OBLIGATION_THRESHOLDS.bypassGates;

  // 对话延续也可 bypass
  const isContinuation = !targetHasDirected && isConversationContinuation(G, target, nowMs);

  return targetHasDirected || isContinuation;
}

/**
 * ADR-251: 热聊安全的主动性阻尼。
 *
 * 这不是普通 pre-CF consideration，也不是硬 gate。CF 会把单个极低项用几何均值抬高，
 * 所以该 utility 在 CF 之后相乘；它仍记录到 considerations 供 bottleneck 审计。
 *
 * 不变量：
 * - directed / obligation / conversation continuation 不阻尼；
 * - group/channel 不阻尼；
 * - private 中只要对方在 Alice 上次发言后又说话（hot chat），不阻尼；
 * - 只软压无人回应的 unsolicited private proactive。
 *
 * @see docs/adr/251-hot-chat-safe-proactive-damping.md
 */
export function computeProactivePacingUtility(opts: {
  chatType: string | undefined;
  bypassGates: boolean;
  nowMs: number;
  lastIncomingMs?: number;
  lastOutgoingMs?: number;
  lastProactiveOutreachMs?: number;
  consecutiveOutgoing?: number;
}): number {
  if (opts.bypassGates) return 1.0;

  const chatType = opts.chatType ?? "private";
  if (ChatTarget.isGroupChat(chatType) || ChatTarget.isChannelChat(chatType)) return 1.0;

  const lastIncomingMs = Number(opts.lastIncomingMs ?? 0);
  const lastOutgoingMs = Number(opts.lastOutgoingMs ?? 0);
  if (lastIncomingMs > lastOutgoingMs) return 1.0;

  const lastProactiveMs = Number(opts.lastProactiveOutreachMs ?? 0);
  let utility = 1.0;
  if (lastProactiveMs > 0) {
    const elapsedRatio = clamp01((opts.nowMs - lastProactiveMs) / PROACTIVE_PACING_MIN_INTERVAL_MS);
    utility *= PROACTIVE_PACING_RECENT_MIN + (1 - PROACTIVE_PACING_RECENT_MIN) * elapsedRatio ** 2;
  }

  const unilateralCount = Math.max(0, Number(opts.consecutiveOutgoing ?? 0) - 1);
  if (unilateralCount > 0) {
    utility *= 1 / (1 + PROACTIVE_PACING_CONSECUTIVE_GAIN * unilateralCount);
  }

  return Math.max(EPSILON, Math.min(1.0, utility));
}

export function computeEmotionProactiveCapUtility(opts: {
  chatType: string | undefined;
  bypassGates: boolean;
  proactiveCap: number | null;
  consecutiveOutgoing?: number;
  lastIncomingMs?: number;
  lastOutgoingMs?: number;
}): number {
  if (opts.bypassGates) return 1.0;
  if (opts.proactiveCap == null) return 1.0;

  const chatType = opts.chatType ?? "private";
  if (ChatTarget.isGroupChat(chatType) || ChatTarget.isChannelChat(chatType)) return 1.0;

  const lastIncomingMs = Number(opts.lastIncomingMs ?? 0);
  const lastOutgoingMs = Number(opts.lastOutgoingMs ?? 0);
  if (lastIncomingMs > lastOutgoingMs) return 1.0;

  const overCap = Math.max(0, Number(opts.consecutiveOutgoing ?? 0) - opts.proactiveCap);
  if (overCap <= 0) return 1.0;

  return Math.max(EPSILON, EMOTION_PROACTIVE_CAP_MIN / overCap);
}

export function computeInactivityStaleUtility(opts: {
  chatType: string | undefined;
  bypassGates: boolean;
  nowMs: number;
  lastIncomingMs?: number;
}): number {
  if (opts.bypassGates) return 1.0;

  const chatType = opts.chatType ?? "private";
  if (chatType !== "private") return 1.0;

  const lastIncomingMs = Number(opts.lastIncomingMs ?? 0);
  if (!Number.isFinite(lastIncomingMs) || lastIncomingMs <= 0) return 1.0;

  const inactiveMs = opts.nowMs - lastIncomingMs;
  if (inactiveMs <= INACTIVITY_STALE_GRACE_MS) return 1.0;

  const span = INACTIVITY_STALE_FULL_MS - INACTIVITY_STALE_GRACE_MS;
  const ratio = span > 0 ? clamp01((inactiveMs - INACTIVITY_STALE_GRACE_MS) / span) : 1.0;
  return 1.0 - ratio * (1.0 - INACTIVITY_STALE_MIN);
}

export function computeEmotionActionUtility(opts: {
  actionType: VoiceAction;
  chatType: string | undefined;
  bypassGates: boolean;
  control: EmotionControlPatch;
}): number {
  if (opts.bypassGates) return 1.0;

  const chatType = opts.chatType ?? "private";
  if (ChatTarget.isChannelChat(chatType)) return 1.0;

  const { voiceBias, styleBudget } = opts.control;
  let utility = 1.0;

  if (opts.actionType === "sociability") {
    utility += voiceBias.sociability;
    utility -= Math.max(0, voiceBias.caution) * 0.35;
    if (styleBudget.preferShort) utility -= 0.08;
    if (styleBudget.avoidSelfProof) utility -= 0.12;
  } else if (opts.actionType === "curiosity") {
    utility += Math.min(0, voiceBias.sociability) * 0.4;
    utility -= Math.max(0, voiceBias.caution) * 0.2;
    if (styleBudget.preferShort) utility -= 0.04;
  } else {
    utility -= Math.max(0, voiceBias.caution) * 0.1;
  }

  if (styleBudget.maxCharsMultiplier < 0.85) {
    utility -= (0.85 - styleBudget.maxCharsMultiplier) * 0.25;
  }

  return Math.max(EMOTION_ACTION_UTILITY_MIN, Math.min(EMOTION_ACTION_UTILITY_MAX, utility));
}

/**
 * ADR-261 Wave 3: rhythm profile timing utility, shadow-only.
 *
 * 这个函数只产出诊断值，不参与当前 IAUS 乘法评分。未来 Wave 4 若启用，
 * 也只能作用于非 bypass 的 unsolicited private/channel proactive。
 */
export function computeTimingShadowUtility(opts: {
  chatType: string | undefined;
  bypassGates: boolean;
  profile?: RhythmTimingProfile | null;
}): TimingShadowDiagnostic {
  if (opts.bypassGates) {
    return { utility: 1.0, applied: false, reason: "bypass" };
  }

  const chatType = opts.chatType ?? "private";
  if (ChatTarget.isGroupChat(chatType) || chatType === "bot") {
    return { utility: 1.0, applied: false, reason: "unsupported_chat_type" };
  }

  const profile = opts.profile;
  if (!profile) {
    return { utility: 1.0, applied: false, reason: "missing_profile" };
  }

  if (profile.confidence === "low") {
    return {
      utility: 1.0,
      applied: false,
      reason: "low_confidence",
      activeNowScore: profile.activeNowScore,
      quietNowScore: profile.quietNowScore,
      confidence: profile.confidence,
      stale: profile.stale,
    };
  }

  if (profile.stale) {
    return {
      utility: 1.0,
      applied: false,
      reason: "stale",
      activeNowScore: profile.activeNowScore,
      quietNowScore: profile.quietNowScore,
      confidence: profile.confidence,
      stale: profile.stale,
    };
  }

  const utility = Math.max(
    0.3,
    Math.min(1.15, 1.0 + 0.15 * profile.activeNowScore - 0.45 * profile.quietNowScore),
  );

  return {
    utility,
    applied: true,
    reason: "eligible",
    activeNowScore: profile.activeNowScore,
    quietNowScore: profile.quietNowScore,
    confidence: profile.confidence,
    stale: profile.stale,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Consideration Curves（默认参数，Phase 1 实验校准）
// ═══════════════════════════════════════════════════════════════════════════

const CURVES = {
  // 共享
  conflict_avoidance: {
    type: "inv_sigmoid",
    midpoint: 0.6,
    slope: 5,
    min: EPSILON,
    max: 1,
  } as ResponseCurve,
  freshness: { type: "linear_dec", midpoint: 0, slope: 1, min: EPSILON, max: 1 } as ResponseCurve,
  reciprocity: { type: "linear_dec", midpoint: 0, slope: 3, min: 0.05, max: 1 } as ResponseCurve,
  // Diligence
  obligation: { type: "sigmoid", midpoint: 0.3, slope: 8, min: EPSILON, max: 1 } as ResponseCurve,
  attention: { type: "sigmoid", midpoint: 0.2, slope: 6, min: EPSILON, max: 1 } as ResponseCurve,
  thread_age: { type: "log", midpoint: 1, slope: 0.5, min: EPSILON, max: 1 } as ResponseCurve,
  deltaP: { type: "sigmoid", midpoint: 0.3, slope: 4, min: EPSILON, max: 1 } as ResponseCurve,
  prospect: { type: "sigmoid", midpoint: 0.1, slope: 6, min: EPSILON, max: 1 } as ResponseCurve,
  // Sociability
  cooling: { type: "sigmoid", midpoint: 0.3, slope: 5, min: EPSILON, max: 1 } as ResponseCurve,
  social_bond: { type: "sigmoid", midpoint: 0.2, slope: 4, min: EPSILON, max: 1 } as ResponseCurve,
  social_safety: {
    type: "inv_sigmoid",
    midpoint: 0.5,
    slope: 4,
    min: EPSILON,
    max: 1,
  } as ResponseCurve,
  // Curiosity
  novelty: { type: "sigmoid", midpoint: 0.1, slope: 6, min: EPSILON, max: 1 } as ResponseCurve,
  info_pressure: {
    type: "sigmoid",
    midpoint: 0.2,
    slope: 5,
    min: EPSILON,
    max: 1,
  } as ResponseCurve,
  exploration: { type: "log", midpoint: 0.1, slope: 0.8, min: EPSILON, max: 1 } as ResponseCurve,
  // ADR-178: Attraction
  attraction: { type: "sigmoid", midpoint: 0.15, slope: 6, min: EPSILON, max: 1 } as ResponseCurve,
  // ADR-219 D1: Voice Affinity — 跨声部压力主导度
  // midpoint=1/3（三 voice 均分时中性），slope=6（适中陡峭度）
  // share=0.6 → U≈0.83, share=0.1 → U≈0.12, 乘法区分度 ~7x
  voice_affinity: {
    type: "sigmoid",
    midpoint: 0.33,
    slope: 6,
    min: EPSILON,
    max: 1,
  } as ResponseCurve,
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// Compensation Factor
// ═══════════════════════════════════════════════════════════════════════════

/** Phase 1 校准的 CF 值。 */
const CF = 0.4;

/**
 * 补偿乘法评分的"考虑越多、得分越低"问题。
 * rawScore = ∏ U_k → geomMean = rawScore^(1/n) → 校正输出。
 */
export function compensate(rawScore: number, n: number, cf: number): number {
  if (n <= 1 || rawScore <= 0) return rawScore;
  const geomMean = rawScore ** (1 / n);
  return geomMean * (1 + (1 - geomMean) * cf);
}

// ═══════════════════════════════════════════════════════════════════════════
// Voice Affinity（ADR-219 D1: 跨声部压力主导度）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ADR-219 D1: 计算声部亲和力——该 voice 的主要压力维度在 target 上的相对主导度。
 *
 * 每个 voice 关联特定压力维度（κ-归一化后可比较）：
 *   Diligence:    P5(义务) + P1(注意力)
 *   Sociability:  P3(关系冷却)
 *   Curiosity:    P6(好奇) + P2(信息)
 *
 * share = mySignal / totalSignal → sigmoid(midpoint=1/3) → [ε, 1]
 *
 * 恢复了 IAUS 统一选择中丢失的 cross-voice inhibition（旧 loudness 竞争的功能），
 * 但作为乘法 consideration 参与——其他 considerations 可 override。
 *
 * @see docs/adr/219-pressure-field-evolution-directions.md §D1
 */
function computeVoiceAffinity(
  tension: TensionVector,
  actionType: VoiceAction,
  kappa: PressureDims,
): number {
  // κ-归一化的 per-voice 主要压力信号
  const k1 = Math.max(kappa[0], 1e-6);
  const k2 = Math.max(kappa[1], 1e-6);
  const k3 = Math.max(kappa[2], 1e-6);
  const k5 = Math.max(kappa[4], 1e-6);
  const k6 = Math.max(kappa[5], 1e-6);

  const dSignal = tension.tau5 / k5 + tension.tau1 / k1;
  const sSignal = tension.tau3 / k3;
  const cSignal = tension.tau6 / k6 + tension.tau2 / k2;

  const total = dSignal + sSignal + cSignal;
  if (total < 1e-6) return 1.0; // 无压力信号 → 中性（不参与 voice 竞争）

  const mySignal =
    actionType === "diligence" ? dSignal : actionType === "sociability" ? sSignal : cSignal;
  const share = mySignal / total;

  return evalCurve(CURVES.voice_affinity, share);
}

// ═══════════════════════════════════════════════════════════════════════════
// Consideration 计算
// ═══════════════════════════════════════════════════════════════════════════

interface SharedInputs {
  tension: TensionVector;
  chatType: string;
  reachabilityScore: number;
  effSilences: number;
  freshness: number; // recentActionsForTarget / perTargetCap
  consecutiveOutgoing: number;
  bypassGates: boolean;
}

/**
 * 计算共享 Considerations（所有 action_type 都乘）。
 * ADR-218 Phase 2: U_coverage 移除（被 U_fairness 取代，在 post-scoring pass 中计算）。
 */
function computeSharedConsiderations(
  inputs: SharedInputs,
  actionType: VoiceAction,
  config: IAUSConfig,
  selfMood: number,
): Record<string, number> {
  const { tension, chatType, reachabilityScore, effSilences, freshness, consecutiveOutgoing } =
    inputs;

  // U_conflict_avoidance: rCaution(tension, uncertainty) → inv_sigmoid
  const cautionInput = rCaution(tension, config.uncertainty);
  const U_conflict_avoidance = evalCurve(CURVES.conflict_avoidance, cautionInput);

  // U_freshness: ratio → linear_dec
  const U_freshness = evalCurve(CURVES.freshness, freshness);

  // U_reciprocity: consecutive_outgoing → linear_dec
  const U_reciprocity = evalCurve(CURVES.reciprocity, consecutiveOutgoing);

  // U_reachable: 二值 {ε, 1}
  const U_reachable = reachabilityScore > 0.5 ? 1.0 : EPSILON;

  // U_fatigue: voiceFatigue → 直传 [0, 1]
  const lastWonMs = config.voiceLastWon[actionType];
  const U_fatigue = Math.max(
    EPSILON,
    voiceFatigue(config.nowMs, lastWonMs, DEFAULT_VOICE_COOLDOWN),
  );

  // U_mood: ψ_v(selfMood)
  // diligence/curiosity: 1.0（无 mood 效应），sociability: 1 ± 0.3 × mood
  let U_mood: number;
  if (actionType === "sociability") {
    U_mood = Math.max(EPSILON, 1 + MOOD_DELTA * selfMood);
  } else {
    U_mood = 1.0;
  }

  // ADR-183: U_personality 移除——其效果通过 modulateCurve() 编码到专属 Consideration 曲线中。
  // 常数乘子 + 曲线调制 = double-counting。曲线调制产生输入依赖的灵敏度曲面（质变），
  // 常数乘子只产生均匀缩放（量变）。

  // U_silence_damping: 1/(1+n) with group floor
  const U_silence_damping = Math.max(EPSILON, silenceDamping(effSilences, chatType));

  // ADR-219 D1: U_voice_affinity — 跨声部压力主导度。
  // 恢复 IAUS 统一选择中丢失的 cross-voice inhibition。
  // 基于 tension pattern（非 personality）→ 默认等权人格下仍有区分度。
  const U_voice_affinity = computeVoiceAffinity(tension, actionType, config.kappa);

  return {
    U_conflict_avoidance,
    U_freshness,
    U_reciprocity,
    U_reachable,
    U_fatigue,
    U_mood,
    U_silence_damping,
    U_voice_affinity,
  };
}

/**
 * Diligence 专属 Considerations（5 个）。
 * ADR-183: 所有曲线经 π_D 调制——高 Diligence 人格更早响应义务信号。
 */
function computeDiligenceConsiderations(
  tension: TensionVector,
  target: string,
  G: WorldModel,
  config: IAUSConfig,
): Record<string, number> {
  const { nowMs, contributions, kappa } = config;
  const piD = config.personality.weights[VOICE_INDEX.diligence];
  const cms = config.curveModulationStrength ?? DEFAULT_CURVE_MODULATION_STRENGTH;

  // U_obligation: effectiveObligation → sigmoid（人格调制）
  const obligationRaw = G.has(target) ? effectiveObligation(G, target, nowMs) : 0;
  const hasEntity = G.has(target);
  const U_obligation = dormantNeutral(
    obligationRaw,
    hasEntity,
    modulateCurve(CURVES.obligation, piD, cms),
  );

  // U_attention: τ₁ → sigmoid（人格调制）
  const U_attention = evalCurve(modulateCurve(CURVES.attention, piD, cms), tension.tau1);

  // U_thread_age: τ₄ → log（entity-gated: τ₄=0 且无线程 → 1.0）（人格调制）
  const hasThreads = tension.tau4 > 0;
  const U_thread_age = dormantNeutral(
    tension.tau4,
    hasThreads,
    modulateCurve(CURVES.thread_age, piD, cms),
  );

  // U_deltaP: estimateDeltaP → sigmoid（人格调制）
  const rawDeltaP = estimateDeltaP(contributions, target, kappa);
  const U_deltaP = evalCurve(modulateCurve(CURVES.deltaP, piD, cms), rawDeltaP);

  // U_prospect: τ_P → sigmoid（entity-gated: τ_P=0 → 1.0）（人格调制）
  const hasProspect = tension.tauP > 0;
  const U_prospect = dormantNeutral(
    tension.tauP,
    hasProspect,
    modulateCurve(CURVES.prospect, piD, cms),
  );

  return { U_obligation, U_attention, U_thread_age, U_deltaP, U_prospect };
}

/**
 * Sociability 专属 Considerations（6 个）。
 * ADR-183: evalCurve 曲线经 π_S 调制——高 Sociability 人格更早响应关系冷却。
 * U_goldilocks 和 U_hawkes 是直传值，不使用 ResponseCurve，不被调制。
 */
function computeSociabilityConsiderations(
  tension: TensionVector,
  target: string,
  G: WorldModel,
  tick: number,
  recentActions: Array<{ tick: number; action: string; ms?: number; target?: string | null }>,
  config: IAUSConfig,
  chatType: string,
  bypassGates: boolean,
): Record<string, number> {
  const { nowMs, socialCost: scConfig, candidateCtx } = config;
  const piS = config.personality.weights[VOICE_INDEX.sociability];
  const cms = config.curveModulationStrength ?? DEFAULT_CURVE_MODULATION_STRENGTH;

  // U_cooling: τ₃ → sigmoid（人格调制）
  const U_cooling = evalCurve(modulateCurve(CURVES.cooling, piS, cms), tension.tau3);

  // U_social_bond: τ₅ × 0.6 → sigmoid（entity-gated: τ₅=0 且非 directed → 1.0）（人格调制）
  const bondInput = tension.tau5 * 0.6;
  const hasBond = tension.tau5 > 0 || bypassGates;
  const U_social_bond = dormantNeutral(
    bondInput,
    hasBond,
    modulateCurve(CURVES.social_bond, piS, cms),
  );

  // U_social_safety: computeSocialCost → inv_sigmoid（人格调制）
  // 观察项：高 π_S → midpoint 降低 → 安全刹车更早激活（对社交成本更敏感）。
  // 当前诠释：高社交意识 = 高边界敏感度。如运行时数据不符合预期，
  // 可对 inv_sigmoid 单独翻转调制方向。@see ADR-183 审查报告 P2
  const rawSocialCost = computeSocialCost(
    G,
    target,
    "sociability",
    tick,
    nowMs,
    recentActions,
    scConfig,
    chatType,
  );
  const U_social_safety = evalCurve(modulateCurve(CURVES.social_safety, piS, cms), rawSocialCost);

  // U_goldilocks: 直传 [ε, 1]（bypassGates=true → 1.0）— 不使用 ResponseCurve，不被人格调制
  const goldilocksRaw =
    !bypassGates && candidateCtx.getGoldilocksUtility
      ? candidateCtx.getGoldilocksUtility(target)
      : 1.0;
  const U_goldilocks = Math.max(EPSILON, goldilocksRaw);

  // U_hawkes: Hawkes λ discount 直传 [ε, 1] — 不使用 ResponseCurve，不被人格调制
  const hawkesRaw = candidateCtx.getHawkesDiscount?.(target) ?? 1.0;
  const U_hawkes = Math.max(EPSILON, hawkesRaw);

  // U_attraction: τ_attraction → sigmoid（ADR-178）（人格调制）
  const U_attraction = evalCurve(
    modulateCurve(CURVES.attraction, piS, cms),
    tension.tauAttraction ?? 0,
  );

  return { U_cooling, U_social_bond, U_social_safety, U_goldilocks, U_hawkes, U_attraction };
}

/**
 * Curiosity 专属 Considerations（3 个）。
 * ADR-183: 所有曲线经 π_C 调制——高 Curiosity 人格更早响应新颖信号。
 */
function computeCuriosityConsiderations(
  tension: TensionVector,
  target: string,
  config: IAUSConfig,
): Record<string, number> {
  const piC = config.personality.weights[VOICE_INDEX.curiosity];
  const cms = config.curveModulationStrength ?? DEFAULT_CURVE_MODULATION_STRENGTH;

  // U_novelty: τ₆ → sigmoid（人格调制）
  const U_novelty = evalCurve(modulateCurve(CURVES.novelty, piC, cms), tension.tau6);

  // U_info_pressure: τ₂ → sigmoid（人格调制）
  const U_info_pressure = evalCurve(modulateCurve(CURVES.info_pressure, piC, cms), tension.tau2);

  // U_exploration: VoI (Kalman σ²) → log（人格调制）
  const isPermanent =
    config.candidateCtx.G.has(target) &&
    config.candidateCtx.G.getChannel(target).failure_type === "permanent";
  const voiValue = !isPermanent && config.beliefGamma > 0 ? extractVoI(config.beliefs, target) : 0;
  const U_exploration = evalCurve(modulateCurve(CURVES.exploration, piC, cms), voiValue);

  return { U_novelty, U_info_pressure, U_exploration };
}

// ═══════════════════════════════════════════════════════════════════════════
// 主评分管线
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 在所有 channel × 3 action_types 上执行 IAUS 评分。
 *
 * @returns IAUSResult 或 null（所有候选得分 ≤ ε）。
 */
export function scoreAllCandidates(
  tensionMap: Map<string, TensionVector>,
  G: WorldModel,
  tick: number,
  recentActions: Array<{ tick: number; action: string; ms?: number; target?: string | null }>,
  config: IAUSConfig,
): IAUSResult | null {
  const { nowMs, candidateCtx, saturationCost: satConfig, windowStartMs } = config;
  if (isSelfResting(G, nowMs)) return null;

  const selfMood = readSelfMood(G, nowMs);
  const emotionControl = readEmotionControlPatch(G, nowMs);
  const channels = G.getEntitiesByType("channel").filter(
    (target) => !config.targetWhitelist || config.targetWhitelist.has(target),
  );

  const scored: Array<{
    candidate: IAUSCandidate;
    V: number;
    bypassGates: boolean;
  }> = [];

  for (const target of channels) {
    if (config.excludeTargets?.has(target)) continue;

    // Pre-filter: permanent 不可达 target 不评分
    if (G.has(target) && G.getChannel(target).failure_type === "permanent") continue;

    // 每个 target 只计算一次的共享输入
    const tension = tensionMap.get(target) ?? ZERO_TENSION;
    const chatType = G.has(target) ? (G.getChannel(target).chat_type ?? "private") : "private";
    const rawReach = G.has(target) ? G.getChannel(target).reachability_score : undefined;
    const reachabilityScore =
      typeof rawReach === "number" && !Number.isNaN(rawReach) ? rawReach : 1.0;
    const effSilences = effectiveActSilences(G, target, nowMs);
    const channelAttrs = G.has(target) ? G.getChannel(target) : null;
    const consecutiveOutgoing = channelAttrs ? Number(channelAttrs.consecutive_outgoing ?? 0) : 0;

    // U_freshness input: per-target action count in window / perTargetCap
    const targetActionsInWindow = recentActions.filter(
      (a) => (a.ms ?? 0) > windowStartMs && a.target === target,
    ).length;

    const bypass = computeCandidateBypass(candidateCtx, target);

    // Pre-filter: consecutive_outgoing >= cap 且无义务 → 跳过（防垃圾轰炸）
    // 在 V-max 中此逻辑通过 C_sat σ_out 使 V ≤ 0 实现；IAUS 乘法不支持绝对否决，
    // 因此改为硬门控。义务信号（bypassGates）绕过此限制。
    const isGroupChat = ChatTarget.isGroupChat(chatType);
    const outgoingCap = isGroupChat ? satConfig.outgoingCapGroup : satConfig.outgoingCapPrivate;
    if (!bypass && consecutiveOutgoing >= outgoingCap) continue;

    const perTargetCap = bypass ? satConfig.perTargetCapBypass : satConfig.perTargetCap;
    const freshness = perTargetCap > 0 ? targetActionsInWindow / perTargetCap : 0;

    // ── ADR-189: 4 个 gate 内化到 IAUS per-candidate pre-filter ──

    // 1. Closing conversation — leave() 承诺封锁（无条件，bypass 不穿透告别承诺）
    if (gateClosingConversation(G, target).type === "silent") continue;

    // 2. Crisis mode — 危机频道无义务时封锁
    if (!bypass && config.crisisChannels?.includes(target)) continue;

    // 3. Class rate cap — chat-type-aware 硬上限（ADR-189: bot scope 通过 isBot 区分）
    if (!bypass && config.classRateCaps && config.classActionCounts) {
      const cls = classifyChatType(chatType, resolveIsBot(G, target));
      if (
        (config.classActionCounts[cls] ?? 0) >=
        (config.classRateCaps[cls] ?? Number.POSITIVE_INFINITY)
      )
        continue;
    }

    // 4. Per-target rate limit (hard filter, replaces retry loop in evolve.ts)
    if (targetActionsInWindow >= perTargetCap) continue;

    const proactivePacingUtility = computeProactivePacingUtility({
      chatType,
      bypassGates: bypass,
      nowMs,
      lastIncomingMs: Number(channelAttrs?.last_incoming_ms ?? 0),
      lastOutgoingMs: Number(channelAttrs?.last_outgoing_ms ?? 0),
      lastProactiveOutreachMs: Number(channelAttrs?.last_proactive_outreach_ms ?? 0),
      consecutiveOutgoing,
    });
    const emotionProactiveCapUtility = computeEmotionProactiveCapUtility({
      chatType,
      bypassGates: bypass,
      proactiveCap: emotionControl.actionCaps.proactiveMessages,
      consecutiveOutgoing,
      lastIncomingMs: Number(channelAttrs?.last_incoming_ms ?? 0),
      lastOutgoingMs: Number(channelAttrs?.last_outgoing_ms ?? 0),
    });
    const timingShadow = computeTimingShadowUtility({
      chatType,
      bypassGates: bypass,
      profile: candidateCtx.getRhythmTimingProfile?.(target, chatType) ?? null,
    });
    const inactivityStaleUtility = computeInactivityStaleUtility({
      chatType,
      bypassGates: bypass,
      nowMs,
      lastIncomingMs: Number(channelAttrs?.last_incoming_ms ?? 0),
    });

    const sharedInputs: SharedInputs = {
      tension,
      chatType,
      reachabilityScore,
      effSilences,
      freshness,
      consecutiveOutgoing,
      bypassGates: bypass,
    };

    // 遍历 3 个 action types
    for (const actionType of IAUS_ACTIONS) {
      // ADR-206: 频道只能被 curiosity 选中（信息流实体，非社交对等体）。
      // diligence 在 W7 频道发布实现后可放开（admin/owner 限定）。
      if (chatType === "channel" && actionType !== "curiosity") continue;
      const shared = computeSharedConsiderations(sharedInputs, actionType, config, selfMood);
      let specific: Record<string, number>;
      let n: number;

      switch (actionType) {
        case "diligence":
          specific = computeDiligenceConsiderations(tension, target, G, config);
          n = Object.keys(shared).length + Object.keys(specific).length;
          break;
        case "sociability":
          specific = computeSociabilityConsiderations(
            tension,
            target,
            G,
            tick,
            recentActions,
            config,
            chatType,
            bypass,
          );
          n = Object.keys(shared).length + Object.keys(specific).length;
          break;
        case "curiosity":
          specific = computeCuriosityConsiderations(tension, target, config);
          n = Object.keys(shared).length + Object.keys(specific).length;
          break;
        default:
          continue;
      }

      // 乘积 ∏ U_k。ADR-251 的 U_proactive_pacing 在 CF 后应用，避免被几何均值补偿稀释。
      const preCFConsiderations = { ...shared, ...specific };
      let rawScore = 1;
      for (const v of Object.values(preCFConsiderations)) {
        rawScore *= v;
      }

      // Compensation Factor
      let compensatedScore = compensate(rawScore, n, CF);

      // ADR-251: private proactive pacing — post-CF utility。
      // 只压无人回应的 unsolicited private proactive；directed/hot-chat/group/channel 均为 1.0。
      compensatedScore *= proactivePacingUtility;
      compensatedScore *= emotionProactiveCapUtility;
      compensatedScore *= inactivityStaleUtility;
      const emotionActionUtility = computeEmotionActionUtility({
        actionType,
        chatType,
        bypassGates: bypass,
        control: emotionControl,
      });
      compensatedScore *= emotionActionUtility;
      const allConsiderations = {
        ...preCFConsiderations,
        U_proactive_pacing: proactivePacingUtility,
        U_emotion_proactive_cap: emotionProactiveCapUtility,
        U_inactivity_stale: inactivityStaleUtility,
        U_emotion_action: emotionActionUtility,
      };

      // ADR-217: Aversion — 社交回避乘性调制。
      // V_eff = V × (1 - aversion)。bypass 不穿透回避（Alice 主动选择，义务不覆盖）。
      const aversion = effectiveAversion(G, target, nowMs);
      if (aversion > 0) {
        compensatedScore *= 1 - Math.min(aversion, 1);
      }

      // ADR-182 D1: Momentum Bonus — 上一 tick 赢家获得乘法加成
      const mBonus = config.momentumBonus ?? DEFAULT_MOMENTUM_BONUS;
      const mDecayMs = config.momentumDecayMs ?? DEFAULT_MOMENTUM_DECAY_MS;
      const lastWinner = config.lastWinner;
      const lastActMs = config.lastActionMs ?? 0;
      if (
        mBonus > 0 &&
        lastWinner &&
        actionType === lastWinner.action &&
        target === lastWinner.target &&
        nowMs - lastActMs < mDecayMs
      ) {
        compensatedScore *= 1 + mBonus;
      }

      // ADR-185 §1: Desire Boost — 匹配 desire 的 target 获得乘法加成
      const dBoost = config.desireBoost ?? DEFAULT_DESIRE_BOOST;
      if (dBoost > 0 && config.desires?.length) {
        const topDesire = findTopDesireForTarget(config.desires, target);
        if (topDesire) {
          compensatedScore *= 1 + dBoost * topDesire.urgency;
        }
      }

      // ε 过滤
      if (compensatedScore <= EPSILON) continue;

      // deltaP 和 socialCost 用于审计
      const rawDeltaP = estimateDeltaP(config.contributions, target, config.kappa);
      const rawSocialCost = computeSocialCost(
        G,
        target,
        actionType,
        tick,
        nowMs,
        recentActions,
        config.socialCost,
        chatType,
      );

      scored.push({
        candidate: {
          action: actionType,
          target,
          focalEntities: [target],
          netValue: compensatedScore,
          deltaP: rawDeltaP,
          socialCost: rawSocialCost,
          considerations: allConsiderations,
          diagnostics: { timingShadow },
          bypassGates: bypass,
        },
        V: compensatedScore,
        bypassGates: bypass,
      });
    }
  }

  if (scored.length === 0) return null;

  // ── ADR-218 Phase 2: U_fairness — CFS-inspired 服务比例公平 ────────
  //
  // 统一替代 Phase 1 的三个离散机制：
  //   URGENCY_BOOST   → 未服务目标自然获得 ratio^(-α) > 1.0 加成
  //   URGENCY_BUDGET  → 过服务目标自然获得 ratio^(-α) < 1.0 惩罚（连续衰减，无跳变）
  //   U_coverage      → 长期欠服务的 ratio 持续低 → 持续加成（替代 attention debt bonus）
  //
  // 数学公式：
  //   expected_share(i) = V_raw(i) / Σ V_raw     （效用比例期望份额）
  //   actual_share(i)   = service(i) / total       （窗口内实际服务份额）
  //   ratio(i)          = actual / expected
  //   U_fairness(i)     = clamp(ratio^(-α), ε, U_MAX)
  //
  // 不变量保证：
  //   I1 比例公平 — 过服务惩罚 + 欠服务加成 → 长期 service ∝ V_raw
  //   I2 有界响应 — 新义务 ratio≈0 → U_fairness=U_MAX → 近确定性胜出
  //   I3 无饥饿   — 长期欠服务 → ratio持续低 → U_fairness持续高 → 终必被选
  //   I5 自修正   — 选中后 ratio↑ → U_fairness↓ → 自动让位
  //
  // @see docs/adr/218-attention-fairness-rank-gate-starvation.md §A4
  // @see Linux CFS: vruntime += delta/weight → 选 min(vruntime)
  const pool = scored; // 统一池

  // ��算窗口内 per-target 服务次数
  const serviceInWindow = new Map<string, number>();
  let totalService = 0;
  for (const a of recentActions) {
    if ((a.ms ?? 0) > config.windowStartMs && a.target) {
      serviceInWindow.set(a.target, (serviceInWindow.get(a.target) ?? 0) + 1);
      totalService++;
    }
  }

  // 计算 Σ V_raw（用于 expected_share）
  const sumVRaw = pool.reduce((s, e) => s + e.V, 0);

  // 应用 U_fairness：第二遍 pass
  if (totalService >= FAIRNESS_MIN_TOTAL_SERVICE && sumVRaw > 0) {
    for (const entry of pool) {
      const target = entry.candidate.target;
      if (!target) continue;

      const expectedShare = entry.V / sumVRaw;
      const actualShare = (serviceInWindow.get(target) ?? 0) / totalService;

      // ratio = actual / expected. ratio < 1 = 欠服务, ratio > 1 = 过服务
      const ratio = actualShare / Math.max(1e-6, expectedShare);

      // 幂律映射：ratio^(-α)
      // ratio=0.5 → 4.0（强加成），ratio=1 → 1.0，ratio=2 → 0.25（强惩罚）
      const rawFairness = Math.max(ratio, 1e-6) ** -FAIRNESS_ALPHA;
      const U_fairness = Math.max(EPSILON, Math.min(U_FAIRNESS_MAX, rawFairness));

      entry.V *= U_fairness;
      entry.candidate.considerations.U_fairness = U_fairness;
    }
  }

  for (const entry of pool) {
    const timingShadow = entry.candidate.diagnostics?.timingShadow;
    if (!timingShadow) continue;
    entry.candidate.diagnostics = {
      ...entry.candidate.diagnostics,
      timingShadow: {
        ...timingShadow,
        netValue: entry.V,
        shadowNetValue: entry.V * timingShadow.utility,
      },
    };
  }

  // ── Thompson Sampling 噪声叠加 ──────────────────────────────────────
  const eta = config.thompsonEta;
  let softmaxValues: number[];
  if (eta > 0 && pool.length > 1) {
    softmaxValues = pool.map((entry) => {
      const t = entry.candidate.target;
      if (!t) return entry.V;
      const isPermanent = G.has(t) && G.getChannel(t).failure_type === "permanent";
      const sigma2 = isPermanent ? 0 : extractSigma2(config.beliefs, t);
      if (sigma2 > 0) {
        return entry.V + eta * Math.sqrt(sigma2) * gaussianRandom();
      }
      return entry.V;
    });
  } else {
    softmaxValues = pool.map((s) => s.V);
  }

  // ── 自适应温度 Boltzmann softmax 选择 ─────────────────────────────
  const vValues = pool.map((s) => s.V);
  const spread = std(scored.map((s) => s.V)); // spread 仍基于全部 scored（审计一致性）
  const tau = 0.05 + 0.2 / (1.0 + spread * 5.0);

  const maxV = Math.max(...softmaxValues);
  const exps = softmaxValues.map((v) => Math.exp((v - maxV) / tau));
  const sumExp = exps.reduce((a, b) => a + b, 0);
  const probs = sumExp > 0 ? exps.map((e) => e / sumExp) : vValues.map(() => 1.0 / vValues.length);

  let winnerIdx: number;
  if (config.deterministic) {
    // 确定性 argmax——测试用，避免 Boltzmann 随机性
    winnerIdx = softmaxValues.indexOf(Math.max(...softmaxValues));
  } else {
    const r = Math.random();
    let cumulative = 0;
    winnerIdx = probs.length - 1;
    for (let i = 0; i < probs.length; i++) {
      cumulative += probs[i];
      if (r < cumulative) {
        winnerIdx = i;
        break;
      }
    }
  }

  return {
    candidate: pool[winnerIdx].candidate,
    bestV: pool[winnerIdx].V,
    candidateCount: pool.length,
    selectedProbability: probs[winnerIdx],
    winnerBypassGates: pool[winnerIdx].bypassGates,
    spread,
    // D5: scored 返回全部候选（审计完整性），保留反事实所需的结构化字段。
    scored: scored.map((s) => ({
      action: s.candidate.action,
      target: s.candidate.target,
      V: s.V,
      bypassGates: s.bypassGates,
      bottleneck: Object.entries(s.candidate.considerations).reduce(
        (min, [k, v]) => (v < min[1] ? [k, v] : min),
        ["", Infinity] as [string, number],
      )[0],
      deltaP: s.candidate.deltaP,
      socialCost: s.candidate.socialCost,
      netValue: s.V,
      considerations: s.candidate.considerations,
      diagnostics: s.candidate.diagnostics,
    })),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Reason 组装（从 v-maximizer.ts 迁移）
// ═══════════════════════════════════════════════════════════════════════════

function magnitudeLabel(value: number, thresholds: [number, number] = [0.3, 1.0]): string {
  return value > thresholds[1] ? "high" : value > thresholds[0] ? "moderate" : "low";
}

/**
 * 将 IAUSCandidate 翻译为机器生成的结构化理由。
 *
 * ADR-185 §1: 有匹配 desire 时，reason 首项显示 desire 标签和 urgency 级别。
 */
export function assembleIAUSReason(
  candidate: IAUSCandidate,
  apiValue: number,
  voiNull?: number,
  selectedProbability?: number,
  desire?: Desire,
): string {
  const parts: string[] = [];

  // ADR-185 §1: desire 首项
  if (desire) {
    parts.push(`desire: ${desire.label} (urgency=${magnitudeLabel(desire.urgency)})`);
  }

  parts.push(`pressure=${magnitudeLabel(apiValue)}`);

  if (candidate.deltaP > 0) {
    parts.push(`relief=${magnitudeLabel(candidate.deltaP, [0.2, 0.8])}`);
  }
  if (candidate.socialCost > 0) {
    parts.push(`cost=${magnitudeLabel(candidate.socialCost, [0.2, 0.6])}`);
  }
  parts.push(`value=${magnitudeLabel(candidate.netValue, [0.1, 0.5])}`);

  if (selectedProbability !== undefined) {
    parts.push(`p=${(selectedProbability * 100).toFixed(0)}%`);
  }

  if (voiNull !== undefined && voiNull > 0.01) {
    parts.push(voiNull > 0.1 ? "waiting may help" : "acting is slightly better than waiting");
  }

  return parts.join(", ");
}
