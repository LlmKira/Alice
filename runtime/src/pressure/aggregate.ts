/**
 * 压力聚合：API 归一化和完整计算管线。
 * 对应 Python pressure.py api_aggregate() + compute_all_pressures()。
 */

import { DEFAULT_KAPPA } from "../graph/constants.js";
import type { WorldModel } from "../graph/world-model.js";
import type { PressureDims } from "../utils/math.js";
import { tanhNormalize } from "../utils/math.js";
import { pProspect } from "./p-prospect.js";
import { p1AttentionDebt } from "./p1-attention.js";
import { p2InformationPressure } from "./p2-information.js";
import { p3RelationshipCooling } from "./p3-relationship.js";
import { p4ThreadDivergence } from "./p4-thread.js";
import { p5ResponseObligation } from "./p5-response.js";
import { type CuriosityHistory, p6CuriosityWithHistory } from "./p6-curiosity.js";
import type { PropagationConfig } from "./propagation.js";
import { propagatePressuresMatrix as propagatePressures } from "./propagation.js";

export type { PressureResult } from "./p1-attention.js";

// ═══════════════════════════════════════════════════════════════════════════
// ADR-112 D4: AdaptiveKappa — 运行时信号统计驱动的自适应 κ
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 自适应 κ：基于运行时信号统计动态调整。
 *
 * κ_k(n) = max(κ_min_k, EMA_k(n))
 * EMA_k(n) = α × |P_k(n)| + (1-α) × EMA_k(n-1)
 * α = 0.02（50-tick 半衰期）
 *
 * 效果：P3=16.55 运行后 → κ₃ 自动上调 → tanh(16.55/κ₃) 不再饱和。
 *
 * @see docs/adr/112-pressure-dynamics-rehabilitation/ §D4
 */
export class AdaptiveKappa {
  private ema: [number, number, number, number, number, number];
  private readonly kappaMin: [number, number, number, number, number, number];
  /** EMA 半衰期（秒）。审计修复: 从 tick-based alpha 改为时间驱动。 */
  private readonly halfLifeS: number;

  /**
   * @param kappaMin 每维度的最小 kappa
   * @param halfLifeS EMA 半衰期（秒）。默认 1500s（25 分钟）——
   *   等价于旧 alpha=0.02 在 tick=30s 时的行为（50 ticks × 30s）。
   *   时间驱动确保 patrol 模式（tick=300s）和 conversation 模式（tick=30s）
   *   有一致的墙钟适应速度。
   */
  constructor(kappaMin: [number, number, number, number, number, number], halfLifeS = 1500) {
    this.kappaMin = [...kappaMin] as [number, number, number, number, number, number];
    this.halfLifeS = halfLifeS;
    // 初始 EMA = kappaMin（冷启动时使用硬编码默认值）
    this.ema = [...kappaMin] as [number, number, number, number, number, number];
  }

  /**
   * 更新 EMA 并返回当前有效 kappa。
   * 每 tick 调用一次，在 computeAllPressures 完成后。
   *
   * @param pressures 当前 tick 的六维压力值
   * @param dtS tick 间隔（秒）。用于计算时间驱动的 alpha。
   *   alpha = 1 - exp(-dt * ln2 / halfLife)——确保无论 tick 间隔如何变化，
   *   EMA 的墙钟半衰期恒定。
   */
  update(
    pressures: [number, number, number, number, number, number],
    dtS?: number,
  ): [number, number, number, number, number, number] {
    // 时间驱动 alpha：dt 越大 alpha 越大（一步跨度更大）
    const effectiveDt = dtS != null && dtS > 0 ? dtS : 60; // fallback 60s
    const alpha = 1 - Math.exp((-effectiveDt * Math.LN2) / this.halfLifeS);
    for (let i = 0; i < 6; i++) {
      this.ema[i] = alpha * Math.abs(pressures[i]) + (1 - alpha) * this.ema[i];
    }
    return this.current();
  }

  /** 返回当前有效 kappa（max(kappaMin, EMA)）。 */
  current(): [number, number, number, number, number, number] {
    return [
      Math.max(this.kappaMin[0], this.ema[0]),
      Math.max(this.kappaMin[1], this.ema[1]),
      Math.max(this.kappaMin[2], this.ema[2]),
      Math.max(this.kappaMin[3], this.ema[3]),
      Math.max(this.kappaMin[4], this.ema[4]),
      Math.max(this.kappaMin[5], this.ema[5]),
    ];
  }

  /** 用于序列化/调试。 */
  toDict(): { ema: number[]; kappaMin: number[] } {
    return { ema: [...this.ema], kappaMin: [...this.kappaMin] };
  }
}

export interface AllPressures {
  P1: number;
  P2: number;
  P3: number;
  P4: number;
  P5: number;
  P6: number;
  /** ADR-23: 前瞻性压力（Thread horizon 驱动）。无 horizon 时为 0。 */
  P_prospect: number;
  /** API ∈ [0, 7)：6 个 tanh(P_k/κ_k) ∈ [0,1) + tanh(P_prospect/κ_prospect) ∈ [0,1)。 */
  API: number;
  /** ADR-195: Peak-based API ∈ [0, 7) — 每维度最大单实体贡献的 tanh 归一化。驱动 tick 间隔。 */
  API_peak: number;
  /** A(n) = A_max · tanh(API(n) / κ) */
  A: number;
  /** 各压力分量的实体贡献（含传播后的有效值） */
  contributions: Record<string, Record<string, number>>;
  /** ADR-26: P_prospect 逐实体贡献（用于 buildTensionMap）。 */
  prospectContributions: Record<string, number>;
  /** D2 Trend: 前 N ticks 的各维度压力总量历史（不含当前 tick），用于 Semantic Triple ⟨F,T,S⟩ 的 Trend 计算。 */
  pressureHistory: {
    P1: number[];
    P2: number[];
    P3: number[];
    P4: number[];
    P5: number[];
    P6: number[];
  };
}

// -- D2 Trend: 压力历史 ring buffer（实例化，不持久化，重启后重新积累） ------

const PRESSURE_HISTORY_SIZE = 10;

/** 压力历史实例——消除全局可变状态，保证测试隔离。 */
export type PressureHistory = Array<[number, number, number, number, number, number]>;

/** 创建一个空的压力历史实例。 */
export function createPressureHistory(): PressureHistory {
  return [];
}

/**
 * API(G, n) = Σ_k tanh(P_k / κ_k) ∈ [0, 6)
 *
 * v4: tanh 归一化。API 是纯观测量，不反馈到任何压力函数。
 */
export function apiAggregate(
  p1: number,
  p2: number,
  p3: number,
  p4: number,
  p5: number,
  p6: number,
  kappa: PressureDims = DEFAULT_KAPPA,
): number {
  const raw = [p1, p2, p3, p4, p5, p6];
  let sum = 0;
  for (let i = 0; i < 6; i++) {
    sum += tanhNormalize(raw[i], kappa[i]);
  }
  return sum;
}

/**
 * ADR-195: Peak-based API — 每维度取最大单实体贡献的 tanh 归一化。
 * 强度量 by construction：不随实体数量增长。
 *
 * API_peak = Σ_k tanh(max_e(P_k(e)) / κ_k)
 *
 * @see docs/adr/195-pressure-saturation-tick-storm.md
 */
export function apiPeak(
  contribSources: Record<string, number>[],
  kappa: PressureDims = DEFAULT_KAPPA,
): number {
  let sum = 0;
  for (let i = 0; i < contribSources.length && i < 6; i++) {
    const contribs = contribSources[i];
    let maxVal = 0;
    for (const v of Object.values(contribs)) {
      if (v > maxVal) maxVal = v;
    }
    sum += tanhNormalize(maxVal, kappa[i]);
  }
  return sum;
}

/**
 * A(n) = A_max · tanh(API(n) / κ)
 */
export function observableMapping(api: number, aMax: number = 10.0, kappa: number = 20.0): number {
  return aMax * Math.tanh(api / kappa);
}

/**
 * 计算所有六个压力 + Laplacian 传播 + 归一化 API。
 *
 * v4 管线：
 * 1. 计算本地压力 P1-P6（P3 不读 API）
 * 2. 传播: p_eff = propagate(G, local, μ)
 * 3. 归一化 API = Σ tanh(P_k / κ_k)
 *
 * @see paper/ §3 eq 1-6: P_k(G, n) = f_k(G, n)
 * @see paper/ §5: API(G,n) = Σ tanh(P_k/κ_k)
 */
export function computeAllPressures(
  G: WorldModel,
  n: number,
  options: {
    kappa?: [number, number, number, number, number, number];
    threadAgeScale?: number;
    mu?: number;
    d?: number;
    /** @deprecated 审计修复: forecast 分量已从 P4 移除，由 P_prospect 统一处理。保留参数避免调用方编译错误。 */
    deltaDeadline?: number;
    /** ADR-23: P_prospect sigmoid 陡度。 */
    kSteepness?: number;
    /** ADR-23: P_prospect 归一化 κ。 */
    kappaProspect?: number;
    /** D2 Trend: 外部管理的压力历史实例（消除全局可变状态）。 */
    history?: PressureHistory;
    /** 当前墙钟时间（毫秒）。压力公式 dt 迁移后必须提供。 */
    nowMs?: number;
    /** ADR-112 D2: 环境好奇心基线 η。 */
    eta?: number;
    /** ADR-112: P6 curiosity pressure smoothing window. */
    k?: number;
    /** ADR-268/P6 audit: 显式 curiosity smoothing history，避免模块级共享状态。 */
    curiosityHistory?: CuriosityHistory;
    /** FJ-MM 惯性系数 ρ ∈ [0,1)。传播前将本地压力与历史均值混合，抑制瞬态尖峰。默认 0.2。设 0 禁用。 */
    rho?: number;
    /** APPNP 传播配置。未设置时使用 legacy one-hop。 */
    propagationConfig?: PropagationConfig;
    /** ADR-161 §3.4: per-channel 消息速率 EMA（传入 P3 群组轨迹驱动 theta）。 */
    channelRateEma?: Map<string, { ema: number; variance: number }>;
    /** ADR-161 §3.4: 当前 tick 墙钟持续时间（秒），用于 EMA 单位换算。 */
    tickDt?: number;
  } = {},
): AllPressures {
  const {
    kappa = DEFAULT_KAPPA,
    threadAgeScale = 86_400,
    mu = 0.3,
    d = -0.5,
    deltaDeadline: _deltaDeadline,
    kSteepness = 5.0,
    kappaProspect = 3.0,
    history,
    nowMs = Date.now(),
    eta = 0.6,
    k = 20,
    curiosityHistory,
    rho = 0.2,
    propagationConfig,
    channelRateEma,
    tickDt,
  } = options;

  // 1. 本地压力
  const r1 = p1AttentionDebt(G, nowMs);
  const r2 = p2InformationPressure(G, n, nowMs, d);
  const r3 = p3RelationshipCooling(G, n, nowMs, channelRateEma, tickDt);
  const r4 = p4ThreadDivergence(G, n, nowMs, threadAgeScale);
  const r5 = p5ResponseObligation(G, n, nowMs);
  const r6 = p6CuriosityWithHistory(G, nowMs, eta, k, curiosityHistory);

  // ADR-23: P_prospect（独立加法项，不参与 Laplacian 传播）
  const rProspect = pProspect(G, n, nowMs, kSteepness);

  // 2. FJ-MM 惯性平滑 + Laplacian 传播
  // FJ-MM: 传播前将本地压力总量与历史均值混合，抑制瞬态尖峰。
  // p_smoothed_k = (1-rho) * p_local_k + rho * mean(history[-2:])[k]
  // 按维度计算缩放比，等比应用到 per-entity contributions。
  // API aggregate 仍用原始 p_local（保持灵敏度）。
  const rawTotals = [r1.total, r2.total, r3.total, r4.total, r5.total, r6.total];
  const smoothingRatios = [1, 1, 1, 1, 1, 1];
  if (rho > 0 && history && history.length > 0) {
    const lastN = history.slice(-2);
    const histMean = [0, 0, 0, 0, 0, 0];
    for (const h of lastN) {
      for (let i = 0; i < 6; i++) histMean[i] += h[i];
    }
    for (let i = 0; i < 6; i++) histMean[i] /= lastN.length;
    for (let i = 0; i < 6; i++) {
      const smoothed = (1 - rho) * rawTotals[i] + rho * histMean[i];
      // 审计修复: clamp smoothingRatio 到 [0.1, 10]，防止压力骤降时比例极端放大。
      // 旧代码在 rawTotals 从高值跌到 1e-14 时可产生 10^6 级乘子。
      const rawRatio = rawTotals[i] > 1e-15 ? smoothed / rawTotals[i] : 1;
      smoothingRatios[i] = Math.max(0.1, Math.min(10, rawRatio));
    }
  }

  const contribSources = [
    r1.contributions,
    r2.contributions,
    r3.contributions,
    r4.contributions,
    r5.contributions,
    r6.contributions,
  ];
  const localAll: Record<string, number> = {};
  for (let dim = 0; dim < 6; dim++) {
    const ratio = smoothingRatios[dim];
    for (const [eid, val] of Object.entries(contribSources[dim])) {
      localAll[eid] = (localAll[eid] ?? 0.0) + val * ratio;
    }
  }
  const pEff = propagatePressures(G, localAll, mu, nowMs, propagationConfig);

  // 按原始归属分配传播增量
  const effContributions: Record<string, Record<string, number>> = {
    P1: {},
    P2: {},
    P3: {},
    P4: {},
    P5: {},
    P6: {},
  };
  const contribPairs: [string, Record<string, number>][] = [
    ["P1", r1.contributions],
    ["P2", r2.contributions],
    ["P3", r3.contributions],
    ["P4", r4.contributions],
    ["P5", r5.contributions],
    ["P6", r6.contributions],
  ];
  for (const [pk, ck] of contribPairs) {
    for (const [eid, localVal] of Object.entries(ck)) {
      const totalLocal = localAll[eid] ?? 0;
      const totalEff = pEff[eid] ?? totalLocal;
      if (totalLocal > 1e-10) {
        // 按原始贡献比例分配传播后的有效值（1e-10 守卫防止浮点抵消导致除零爆炸）
        effContributions[pk][eid] = localVal * (totalEff / totalLocal);
      } else {
        effContributions[pk][eid] = localVal;
      }
    }
  }

  // 3. tanh 归一化 API（纯观测量）+ P_prospect 独立加法项
  // 设计决策：API 使用预传播本地总量（r_k.total），传播仅影响逐实体 contributions。
  // 这是因为 API 是全局行动门控指标，不需要逐实体粒度；
  // 而 contributions 的传播增量用于焦点集选择和张力 Map 构建。
  const apiBase = apiAggregate(r1.total, r2.total, r3.total, r4.total, r5.total, r6.total, kappa);
  const prospectTerm = tanhNormalize(rProspect.total, kappaProspect);
  const api = apiBase + prospectTerm;
  const a = observableMapping(api);

  // D2 Trend: 构建 per-dimension 历史（不含当前 tick）→ 再更新 ring buffer
  // 无 history 时返回空历史（向后兼容：dry-run 和无需 trend 的调用点）
  const buf = history ?? [];
  const historyByDim = {
    P1: buf.map((h) => h[0]),
    P2: buf.map((h) => h[1]),
    P3: buf.map((h) => h[2]),
    P4: buf.map((h) => h[3]),
    P5: buf.map((h) => h[4]),
    P6: buf.map((h) => h[5]),
  };
  if (history) {
    history.push([r1.total, r2.total, r3.total, r4.total, r5.total, r6.total]);
    if (history.length > PRESSURE_HISTORY_SIZE) history.shift();
  }

  // ADR-195: Peak-based API — 用原始 pre-smoothing contributions（与 apiBase 同源）
  const apiPeakVal = apiPeak(contribSources, kappa);
  // prospect 加法项复用（peak 场景下 prospect 只有一个值，peak=total）
  const apiPeakTotal = apiPeakVal + prospectTerm;

  return {
    P1: r1.total,
    P2: r2.total,
    P3: r3.total,
    P4: r4.total,
    P5: r5.total,
    P6: r6.total,
    P_prospect: rProspect.total,
    API: api,
    API_peak: apiPeakTotal,
    A: a,
    contributions: effContributions,
    prospectContributions: rProspect.contributions,
    pressureHistory: historyByDim,
  };
}
