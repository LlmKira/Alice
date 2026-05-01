/**
 * 焦点集计算 (ADR-26 §2)。
 *
 * 每个声部声明 R_v(T(e)) 相关函数，选出 top-K 实体作为焦点集，
 * 响度 = π_v × mean(R_v) over focal set。
 *
 * 替代 v4 的全局 tanh(Pi/κi) + 激活函数映射。
 */

import { readEmotionState } from "../emotion/graph.js";
import { emotionStateMoodSignal } from "../emotion/state.js";
import { type TensionVector, tensionNorm, ZERO_TENSION } from "../graph/tension.js";
import type { WorldModel } from "../graph/world-model.js";
import { elapsedS, readNodeMs } from "../pressure/clock.js";
import type { VoiceAction } from "./personality.js";

// -- 类型 -------------------------------------------------------------------

export interface FocalSet {
  /** 焦点集中的实体 ID（按 R_v 降序）。 */
  entities: string[];
  /** R_v 最高的实体（行动目标）。 */
  primaryTarget: string | null;
  /** 焦点集内 R_v 的均值。 */
  meanRelevance: number;
}

// -- R_v 相关函数 -----------------------------------------------------------

/** 加权均值。 */
function weightedMean(values: number[], weights: number[]): number {
  let sumWV = 0;
  let sumW = 0;
  for (let i = 0; i < values.length; i++) {
    sumWV += weights[i] * values[i];
    sumW += weights[i];
  }
  return sumW > 0 ? sumWV / sumW : 0;
}

/**
 * ADR-181: R_v 权重常量。
 *
 * 每组权重控制张力分量对声部的贡献比例。
 * 加权均值保证不同声部接收的信号带宽可比。
 */
export const W_DILIGENCE = {
  values: ["tau1", "tau4", "tau5", "tauP"] as const,
  weights: [1.0, 0.7, 1.0, 0.5],
};
export const W_CURIOSITY = { values: ["tau2", "tau6"] as const, weights: [0.8, 1.0] };
export const W_SOCIABILITY = { values: ["tau3", "tau5"] as const, weights: [1.0, 0.6] };

/** ADR-181: R_Diligence = WeightedMean([τ₁, τ₄, τ₅, τ_P], [1.0, 0.7, 1.0, 0.5]) */
export function rDiligence(t: TensionVector): number {
  return weightedMean([t.tau1, t.tau4, t.tau5, t.tauP], W_DILIGENCE.weights);
}

/** ADR-181: R_Curiosity = WeightedMean([τ₂, τ₆], [0.8, 1.0]) */
export function rCuriosity(t: TensionVector): number {
  return weightedMean([t.tau2, t.tau6], W_CURIOSITY.weights);
}

/** ADR-181: R_Sociability = WeightedMean([τ₃, τ₅], [1.0, 0.6]) — τ₅ 双重路由。 */
export function rSociability(t: TensionVector): number {
  return weightedMean([t.tau3, t.tau5], W_SOCIABILITY.weights);
}

/** ADR-181: R_Caution 权重。 */
const ALPHA_CONFLICT = 0.6;
const ALPHA_RISK = 0.8;
/** ADR-191: 速率尖峰权重。tauSpike ∈ [1,5]，α=0.5 → z=2 时 rCaution += 1.0。 */
const ALPHA_SPIKE = 0.5;
/** κ_norm: tensionNorm 归一化尺度。 */
const KAPPA_NORM = 10;

/**
 * ADR-181: 归一化 Shannon 熵 H(τ̂)。
 *
 * 衡量张力向量的分散程度（目标冲突度）：
 * - H ≈ 1: 张力均匀分布在多维 → 多目标冲突 → BIS 激活
 * - H ≈ 0: 单维度主导 → 目标清晰 → 无需抑制
 *
 * @param t - 张力向量
 * @returns [0, 1] 归一化熵
 */
export function normalizedEntropy(t: TensionVector): number {
  const dims = [t.tau1, t.tau2, t.tau3, t.tau4, t.tau5, t.tau6, t.tauP];
  const absVals = dims.map(Math.abs);
  const sum = absVals.reduce((a, b) => a + b, 0);
  if (sum <= 0) return 0;

  const N = dims.length;
  let entropy = 0;
  for (const v of absVals) {
    const p = v / sum; // L1 归一化
    if (p > 0) entropy -= p * Math.log(p);
  }
  // 归一化到 [0, 1]
  return entropy / Math.log(N);
}

/**
 * ADR-181: R_Caution — 基于 BIS 理论的熵公式。
 *
 * R_Caution(τ(e)) = (α_c · H(τ̂) · ‖τ‖_norm + α_r · τ_risk(e) + α_s · τ_spike) × (1 + uncertainty)
 *
 * 审计修复: uncertainty 从加法改为乘法调制。
 * 旧公式 `... + uncertainty` 导致低压力下 Caution 有 0.5 的永久保底（R_v），
 * 而其他声部 R_v ≈ 0，Caution 系统性获胜 → Alice 在安静时过度沉默，
 * 抑制 Sociability 的 "missing" 行为（想念某人并主动联系）。
 *
 * 新公式: uncertainty 作为乘法放大器 (1 + uncertainty)，
 * 高不确定性时 Caution 信号放大（冲突、风险的权重增大），
 * 但零信号 × 任何乘数 = 零（无信号时不虚假激活）。
 *
 * @see docs/adr/178-voice-first-principles.md — Gray's RST: BIS → Caution
 */
export function rCaution(t: TensionVector, uncertainty: number): number {
  const H = normalizedEntropy(t);
  const normMag = Math.tanh(tensionNorm(t) / KAPPA_NORM);
  const signal =
    ALPHA_CONFLICT * H * normMag + ALPHA_RISK * t.tauRisk + ALPHA_SPIKE * (t.tauSpike ?? 0);
  return signal * (1 + uncertainty);
}

// -- 焦点集大小 -------------------------------------------------------------

/** K = max(2, min(5, ceil(|entities| / 3))) */
export function focalSetSize(entityCount: number): number {
  if (entityCount <= 0) return 0;
  return Math.max(2, Math.min(5, Math.ceil(entityCount / 3)));
}

// -- 焦点集计算 -------------------------------------------------------------

/** 按 R_v 降序排列，取 top-K。 */
function topK(scored: [string, number][], k: number): [string, number][] {
  return scored.sort((a, b) => b[1] - a[1]).slice(0, k);
}

/** 读取 ADR-268 EmotionState mood signal；旧 self mood scalar 不再是控制 authority。 */
export function readSelfMood(G: WorldModel, nowMs = Date.now()): number {
  if (!G.has("self")) return 0;
  return emotionStateMoodSignal(readEmotionState(G, nowMs));
}

/**
 * 为每个声部计算焦点集。
 *
 * ADR-181: mood 调制从此函数迁移到 computeLoudness()（ψ_v 项）。
 * 焦点集只负责 R_v 排序和 top-K 选择，不含 mood 调制。
 *
 * @param tensionMap - 逐实体张力向量（来自 buildTensionMap）
 * @param G - 伴侣图
 * @param tick - 当前 tick（序数）
 * @param options.uncertainty - 全局不确定性（R_Caution 基线）
 * @param options.nowMs - 当前墙钟时间（ms），默认 Date.now()
 */
export function computeFocalSets(
  tensionMap: Map<string, TensionVector>,
  G: WorldModel,
  _tick: number,
  options: {
    uncertainty?: number;
    nowMs?: number;
    targetWhitelist?: ReadonlySet<string> | null;
  } = {},
): Record<VoiceAction, FocalSet> {
  const { uncertainty = 0.5, nowMs = Date.now(), targetWhitelist = null } = options;
  const entityIds = Array.from(tensionMap.keys()).filter(
    (eid) => !targetWhitelist || targetWhitelist.has(eid),
  );
  const K = focalSetSize(entityIds.length);

  const getTension = (eid: string): TensionVector => tensionMap.get(eid) ?? ZERO_TENSION;

  const voiceConfigs: [VoiceAction, (eid: string) => number][] = [
    [
      "diligence",
      (eid) => {
        let base = rDiligence(getTension(eid));
        // S12 修复: recently cleared 实体衰减（防灌水霸占 focal set）
        if (G.has(eid)) {
          const clearedMs = readNodeMs(G, eid, "recently_cleared_ms");
          if (clearedMs > 0) {
            const ageS = elapsedS(nowMs, clearedMs);
            const damping = Math.min(1.0, ageS / 180); // 3 ticks × 60s = 180s 内逐步恢复
            base *= damping;
          }
        }
        return base;
      },
    ],
    ["curiosity", (eid) => rCuriosity(getTension(eid))],
    [
      "sociability",
      (eid) => {
        const base = rSociability(getTension(eid));
        if (!G.has(eid)) return base;
        let boost = 0;

        // H2: reaction boost（半衰期 5 ticks = 300s）
        const reactionMs = readNodeMs(G, eid, "reaction_boost_ms");
        if (reactionMs > 0) {
          const ageS = elapsedS(nowMs, reactionMs);
          boost += 0.5 / (1 + ageS / 300); // 5 ticks × 60s = 300s
        }

        // M2: returning contact boost（半衰期 10 ticks = 600s）
        const returningMs = readNodeMs(G, eid, "returning_ms");
        if (returningMs > 0) {
          const ageS = elapsedS(nowMs, returningMs);
          boost += 2.0 / (1 + ageS / 600); // 10 ticks × 60s = 600s
        }

        return base + boost;
      },
    ],
    ["caution", (eid) => rCaution(getTension(eid), uncertainty)],
  ];

  const emptySet: FocalSet = { entities: [], primaryTarget: null, meanRelevance: 0 };
  const result: Record<VoiceAction, FocalSet> = {
    diligence: emptySet,
    curiosity: emptySet,
    sociability: emptySet,
    caution: emptySet,
  };

  for (const [voice, rFn] of voiceConfigs) {
    if (entityIds.length === 0) {
      result[voice] = { entities: [], primaryTarget: null, meanRelevance: 0 };
      continue;
    }

    const scored = entityIds.map((eid) => [eid, rFn(eid)] as [string, number]);
    // 论文 Def 3.8 (eq 16): E_v = top_κ({e ∈ V | R_v(T(e,n)) > 0}, R_v)
    // 只有正相关实体参与焦点集竞争；全零时 fallback 保留全部（防空集）
    const positive = scored.filter(([, r]) => r > 0);
    const top = topK(positive.length > 0 ? positive : scored, K);
    const meanR = top.reduce((sum, [, r]) => sum + r, 0) / top.length;

    result[voice] = {
      entities: top.map(([eid]) => eid),
      primaryTarget: top[0][0],
      meanRelevance: meanR,
    };
  }

  return result;
}
