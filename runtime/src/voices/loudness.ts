/**
 * 声部响度计算 (ADR-26 v5)。
 *
 * v5: L_v = π_v × mean(R_v(T(e)) for e in focal_set_v) + ε_v
 *
 * 替代 v4 的全局 tanh(Pi/κi) + 激活函数映射。
 */

import { readEmotionControlPatch } from "../emotion/graph.js";
import { DEFAULT_VOICE_COOLDOWN, voiceFatigue } from "../engine/deliberation.js";
import type { TensionVector } from "../graph/tension.js";
import type { WorldModel } from "../graph/world-model.js";
import { computeFocalSets, type FocalSet, readSelfMood } from "./focus.js";
import { type PersonalityVector, VOICES, type VoiceAction } from "./personality.js";

// -- 类型 -------------------------------------------------------------------

export interface LoudnessResult {
  /** 各声部的响度 [L_D, L_C, L_S, L_X]。ADR-81: 4 声部。 */
  loudness: number[];
  /** 各声部的焦点集。 */
  focalSets: Record<VoiceAction, FocalSet>;
}

// -- Uncertainty ------------------------------------------------------------

/**
 * ADR-112 D3: 环境新颖度 — 新加入的群组触发高 Caution。
 *
 * novelty(ch) = exp(-interaction_count(ch) / κ_novelty)
 * κ_novelty = 10（10 次交互后 novelty 衰减到 ~37%）
 *
 * 环境不确定性 = mean(novelty(ch) for ch in channels)
 */
const KAPPA_NOVELTY = 10;

function computeEnvUncertainty(G: WorldModel): number {
  const channels = G.getEntitiesByType("channel");
  if (channels.length === 0) return 0;

  let totalNovelty = 0;
  for (const chId of channels) {
    const attrs = G.getChannel(chId);
    // 用 join_ms 判断是否是新加入的群——无 join_ms 用 interaction count 估计
    const interactionCount = attrs.contact_recv_window ?? 0;
    const novelty = Math.exp(-interactionCount / KAPPA_NOVELTY);
    totalNovelty += novelty;
  }
  return totalNovelty / channels.length;
}

/**
 * 计算 Uncertainty（驱动 Caution 声部的正向激活）。
 *
 * ADR-112 D3: uncertainty = max(info_uncertainty, env_uncertainty)
 *
 * info_uncertainty: 近期事件少于期望时上升。
 * env_uncertainty: 新群组的环境不确定性（Bowlby 安全基地理论）。
 *
 * @param G - 伴侣图（环境不确定性计算需要）。
 */
export function computeUncertainty(
  recentEventCounts: number[] | null,
  k: number,
  expectedRate: number,
  G: WorldModel,
): number {
  // 信息不确定性
  let infoUncertainty: number;
  if (!recentEventCounts || recentEventCounts.length === 0) {
    infoUncertainty = 0.5; // 无历史时中等不确定
  } else {
    const recent = recentEventCounts.slice(-k);
    const actualRate = recent.reduce((a, b) => a + b, 0) / recent.length;
    const ratio = Math.min(actualRate / Math.max(expectedRate, 0.01), 2.0);
    infoUncertainty = Math.max(0.0, 1.0 - ratio);
  }

  // ADR-112 D3: 环境不确定性
  const envUncertainty = computeEnvUncertainty(G);

  return Math.max(infoUncertainty, envUncertainty);
}

// -- 声部响度 ---------------------------------------------------------------

/** 声部 ID 顺序（从 VOICES 注册表派生）。 */
const VOICE_ORDER = VOICES.map((v) => v.id);

/**
 * 计算各声部的响度。
 *
 * v5 公式: L_v = π_v × mean(R_v over focal set) + ε_v
 *
 * @see paper-five-dim/ Def 3.6 eq 13: L_v = π_v × mean(R_v(τ(e))) + ε_v
 */
export function computeLoudness(
  tensionMap: Map<string, TensionVector>,
  personality: PersonalityVector,
  G: WorldModel,
  tick: number,
  options: {
    recentEventCounts?: number[] | null;
    epsilonScale?: number;
    /** 传入确定性噪声用于测试，长度 = VOICES.length。 */
    noiseOverride?: number[] | null;
    /**
     * ADR-110: 声部上次获胜的墙钟时间（voiceId → ms）。
     * 启用声部疲劳因子 φ_v。未提供时所有声部 φ_v = 1（无疲劳）。
     * @see paper-five-dim/ Eq. voice-fatigue
     */
    voiceLastWon?: Record<VoiceAction, number> | null;
    /** ADR-110: 声部冷却窗口 K_v（秒）。默认 DEFAULT_VOICE_COOLDOWN。 */
    voiceCooldown?: number;
    /** ADR-110: 当前墙钟时间（ms）。未提供时使用 Date.now()。 */
    nowMs?: number;
    /** 候选目标白名单。设置后仅这些 target 可进入焦点集。 */
    targetWhitelist?: ReadonlySet<string> | null;
  } = {},
): LoudnessResult {
  const {
    recentEventCounts = null,
    epsilonScale = 0.1,
    noiseOverride = null,
    voiceLastWon = null,
    voiceCooldown = DEFAULT_VOICE_COOLDOWN,
    nowMs = Date.now(),
    targetWhitelist = null,
  } = options;

  // 全局不确定性（R_Caution 基线）— ADR-112 D3: 含环境不确定性
  const uncertainty = computeUncertainty(recentEventCounts, 10, 2.0, G);

  // 焦点集计算
  const focalSets = computeFocalSets(tensionMap, G, tick, {
    uncertainty,
    nowMs,
    targetWhitelist,
  });

  // ADR-181: L_v = π_v × mean(R_v) × φ_v × ψ_v(m) + ε_v
  // φ_v = voice fatigue factor (ADR-75, paper Eq. voice-fatigue)
  // ψ_v(m) = mood modulation (ADR-30 → ADR-181: 从焦点集迁移到此)
  const pi = personality.weights;
  const epsilon =
    noiseOverride ?? Array.from({ length: VOICES.length }, () => gaussianRandom() * epsilonScale);

  // ADR-181: mood ±30% 调制——mood>0 利好 Sociability、抑制 Caution；反向亦然
  const MOOD_DELTA = 0.3;
  const selfMood = readSelfMood(G, nowMs);
  const emotionControl = readEmotionControlPatch(G, nowMs);
  const PSI: Record<VoiceAction, number> = {
    diligence: 1.0,
    curiosity: 1.0,
    sociability: 1 + MOOD_DELTA * selfMood + emotionControl.voiceBias.sociability,
    caution: 1 - MOOD_DELTA * selfMood + emotionControl.voiceBias.caution,
  };

  const loudness = VOICE_ORDER.map((v, i) => {
    const phi = voiceLastWon ? voiceFatigue(nowMs, voiceLastWon[v], voiceCooldown) : 1;
    return pi[i] * focalSets[v].meanRelevance * phi * PSI[v] + epsilon[i];
  });

  return { loudness, focalSets };
}

/** Box-Muller 标准正态随机数。 */
function gaussianRandom(): number {
  // 防止 Math.random() 返回 0 导致 Math.log(0) = -Infinity
  const u1 = Math.max(1e-10, Math.random());
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
