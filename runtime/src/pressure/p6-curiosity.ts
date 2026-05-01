/**
 * P6 好奇心 (Curiosity) — 论文 Definition 3.3 对齐实现。
 *
 * 论文公式（减性，有界）：
 *   P6(n) = max(0, η - (1/k) × Σ_{j=n-k}^{n} novelty(j))    ∈ [0, η]
 *
 * 当信息丰富时 P6→0（好奇心得到满足），信息匮乏时 P6→η（驱动探索行为）。
 *
 * 线上实现用 per-contact prediction error 和频道信息饥渴具体化 curiosity pressure。
 * 注意：prediction error / hunger 是未满足的 epistemic pressure，不是已满足的 novelty。
 * 把 surprise 放进 `η - mean(novelty)` 会反向钳制 P6，让越异常的联系人越不会触发好奇心。
 * contributions 保留 per-contact/per-channel 粒度用于 IAUS 路由。
 *
 * @see paper/ Definition 3.3 (Curiosity)
 * @see paper/ Remark "Per-Contact Surprise as Novelty Realization"
 * @see paper/ Remark "Curiosity Saturation" — max(0,·) guarantees P6 ∈ [0, η]
 * @see docs/adr/112-pressure-dynamics-rehabilitation/ §D1, §D2
 * @see docs/adr/206-channel-information-flow/theory-impl-divergence-audit.md §P6
 */

import { DUNBAR_TIER_WEIGHT } from "../graph/constants.js";
import type { ContactAttrs, DunbarTier } from "../graph/entities.js";
import type { WorldModel } from "../graph/world-model.js";
import { elapsedS, readNodeMs } from "./clock.js";
import type { PressureResult } from "./p1-attention.js";

// -- ADR-206 W4: 频道好奇心常量 -----------------------------------------------

/**
 * 频道信息饥渴时间常数 τ（秒）：hunger = 1 - exp(-t/τ)。
 * τ=21600s (6h) 时，6h 不看 → ~63% 饥渴恢复，12h → ~86%。
 * @see docs/adr/206-channel-information-flow/206-channel-information-flow.md §5
 */
const CHANNEL_HUNGER_TAU_S = 21_600; // 6h

/**
 * 频道好奇心权重：相对于联系人好奇心的基础系数。
 * 频道是信息源不是社交对等体，好奇心贡献低于联系人。
 */
const CHANNEL_CURIOSITY_WEIGHT = 0.3;

// -- 常量 -------------------------------------------------------------------

/** 信息增益折扣时间常数（秒）：最近交互过的联系人好奇心打折。 */
export const TAU_CURIOSITY = 3000;

/** 最大 tier 权重（用于归一化 w_tier ∈ (0, 1]）。 */
const MAX_TIER_WEIGHT = Math.max(...Object.values(DUNBAR_TIER_WEIGHT));

/**
 * 冷启动 σ_prediction：新联系人的预测不确定性。
 * 随 interaction_count 递减：σ = 1 / (1 + interaction_count / SIGMA_HALF_LIFE)
 * 10 次交互后 σ ≈ 0.5。
 */
const SIGMA_HALF_LIFE = 10;

/** Dunbar 150 常量（ambient curiosity 归一化用）。 */
const DUNBAR_150 = 150;

/** 环境熟悉度时间窗口（天）：7 天达到完全熟悉。 */
const FAMILIARITY_DAYS = 7;

/**
 * Tier → 期望沉默间隔（秒）。
 *
 * 为**线上即时通讯**场景标定（非面对面社交）。
 * @see Dunbar (2016) "Do online social media cut through the constraints
 *      that limit the size of offline social networks?"
 */
const TIER_EXPECTED_SILENCE_S: Record<DunbarTier, number> = {
  5: 14_400, // 4 小时
  15: 86_400, // 1 天
  50: 259_200, // 3 天
  150: 1_209_600, // 14 天
  500: 5_184_000, // 60 天
};

/**
 * Tier → 期望每日消息率。
 * 与 TIER_EXPECTED_SILENCE_S 互为倒数，用于活跃率偏差计算。
 */
const TIER_EXPECTED_DAILY_RATE: Record<DunbarTier, number> = {
  5: 6.0, // ~6 条/天
  15: 1.0, // ~1 条/天
  50: 0.33, // ~1 条/3 天
  150: 0.07, // ~1 条/2 周
  500: 0.016, // ~1 条/2 月
};

// -- Curiosity history buffer ------------------------------------------------
// 追踪最近 k 个 tick 的 aggregate curiosity pressure，用于轻度平滑。
// 生产路径由 EvolveState 持有该 buffer，避免模块级共享状态污染多实例/测试。

export type CuriosityHistory = number[];

/** 创建空 curiosity 历史实例。 */
export function createCuriosityHistory(): CuriosityHistory {
  return [];
}

/**
 * 旧测试辅助保留为 no-op：P6 不再使用模块级 history。
 * 新测试请传入显式 history。
 */
export function resetNoveltyHistory(): void {
  // no-op
}

// -- Surprise 信号 -----------------------------------------------------------

/** σ_prediction: 预测不确定性。 */
function sigmaPrediction(interactionCount: number): number {
  return 1.0 / (1.0 + interactionCount / SIGMA_HALF_LIFE);
}

/**
 * 信号 1: 沉默偏差（时间维度）。
 * @see Dunbar (2010) "How Many Friends Does One Person Need?"
 */
function silenceDeviation(attrs: ContactAttrs, nowMs: number): number {
  const lastActiveMs = attrs.last_active_ms ?? 0;
  if (lastActiveMs === 0) return 0;

  const actualSilenceS = elapsedS(nowMs, lastActiveMs);
  const expectedSilenceS = TIER_EXPECTED_SILENCE_S[attrs.tier] ?? 604_800;

  return Math.abs(actualSilenceS - expectedSilenceS) / expectedSilenceS;
}

/**
 * 信号 2: 活跃率偏差（量级维度，Weber-Fechner 对数律）。
 * @see Weber-Fechner law
 */
function activityRateDeviation(attrs: ContactAttrs, graphAgeDays: number): number {
  const interactionCount = attrs.interaction_count ?? 0;
  if (interactionCount < 2 || graphAgeDays < 1) return 0;

  const actualDailyRate = interactionCount / graphAgeDays;
  const expectedDailyRate = TIER_EXPECTED_DAILY_RATE[attrs.tier] ?? 0.14;

  const ratio = actualDailyRate / expectedDailyRate;
  return Math.abs(Math.log(Math.max(ratio, 0.01)));
}

/**
 * 综合 surprise 值（有界 ∈ [0, 1]）。
 *
 * surprise = σ + (1 - σ) × tanh(signalMean)
 *
 * @see Friston (2010) "The free-energy principle: a unified brain theory?"
 */
function computeSurprise(attrs: ContactAttrs, nowMs: number, graphAgeDays: number): number {
  const sigma = sigmaPrediction(attrs.interaction_count ?? 0);

  const s1 = silenceDeviation(attrs, nowMs);
  const s2 = activityRateDeviation(attrs, graphAgeDays);

  const signalMean = (s1 + s2) / 2;

  return sigma + (1 - sigma) * Math.tanh(signalMean);
}

// -- P6 主函数 ---------------------------------------------------------------

/**
 * P6 好奇心压力（线上 pressure-field 版）。
 *
 * per-contact prediction error 与 per-channel hunger 作为未满足的 curiosity pressure。
 * 总量用 tanh 映射到 [0, η]，保证 mature graph 不会因实体数量过多而饱和失控。
 *
 * @param G - 伴侣图
 * @param nowMs - 当前墙钟时间（毫秒）
 * @param eta - 环境好奇心基线（config.eta，默认 0.6）
 * @param k - curiosity smoothing window（config.k，默认 20）
 */
export function p6Curiosity(G: WorldModel, nowMs: number, eta = 0.6, k = 20): PressureResult {
  return p6CuriosityWithHistory(G, nowMs, eta, k);
}

export function p6CuriosityWithHistory(
  G: WorldModel,
  nowMs: number,
  eta = 0.6,
  k = 20,
  history?: CuriosityHistory,
): PressureResult {
  const contacts = G.getEntitiesByType("contact");
  const contactCount = contacts.length;
  const graphAgeDays = G.getGraphAgeMs(nowMs) / 86_400_000;

  // ── 计算 per-contact surprise（论文 Remark: novelty 的具体化）──────

  const contributions: Record<string, number> = {};
  let rawCuriositySum = 0;

  for (const cid of contacts) {
    const attrs = G.getContact(cid);

    const wTier = DUNBAR_TIER_WEIGHT[attrs.tier] / MAX_TIER_WEIGHT;
    const surprise = computeSurprise(attrs, nowMs, graphAgeDays);

    // γ: 信息增益折扣（最近交互过的联系人打折）
    const lastActiveMs = readNodeMs(G, cid, "last_active_ms");
    if (lastActiveMs <= 0) continue; // 从未交互 → 跳过
    const timeSinceLastS = elapsedS(nowMs, lastActiveMs);
    const gamma = 1 - Math.exp(-timeSinceLastS / TAU_CURIOSITY);

    const curiosity = wTier * surprise * gamma;
    if (curiosity > 0) {
      contributions[cid] = curiosity;
      rawCuriositySum += curiosity;
    }
  }

  // ── ADR-206 W4: 频道好奇心（信息饥渴）──────────────────────────
  for (const chId of G.getEntitiesByType("channel")) {
    const attrs = G.getChannel(chId);
    if (attrs.chat_type !== "channel") continue;

    const unread = attrs.unread ?? 0;
    if (unread === 0) continue;

    const lastReadMs = Number(attrs.last_read_ms ?? 0);
    const sinceReadS = lastReadMs > 0 ? elapsedS(nowMs, lastReadMs) : 0;
    const effectiveSinceS =
      sinceReadS > 0 ? sinceReadS : elapsedS(nowMs, Number(attrs.last_activity_ms ?? 0));
    if (effectiveSinceS <= 0) continue;

    const hunger = 1 - Math.exp(-effectiveSinceS / CHANNEL_HUNGER_TAU_S);
    const unreadSignal = Math.log1p(unread);

    const chCuriosity = CHANNEL_CURIOSITY_WEIGHT * hunger * unreadSignal;
    if (chCuriosity > 0) {
      contributions[chId] = chCuriosity;
      rawCuriositySum += chCuriosity;
    }
  }

  // ── Aggregate pressure: bounded, source-count safe ──────────────────────
  // rawCuriositySum 随联系人/频道数量增长；用 tanh 映射到 [0, η)，避免 529 个
  // contact 把 P6 打爆，同时保留单个强 surprise 触发好奇心的能力。
  const curiosityThisTick = eta * Math.tanh(rawCuriositySum);

  const activeHistory = history ?? [curiosityThisTick];
  if (history) {
    history.push(curiosityThisTick);
    if (history.length > k) history.shift();
  }

  const smoothedCuriosity = activeHistory.reduce((a, b) => a + b, 0) / activeHistory.length;

  // D2: Ambient Curiosity 兜底（冷启动时 curiosityHistory 为空，P6=η）
  const contactFamiliarity = Math.min(1, contactCount / DUNBAR_150);
  const timeFamiliarity = Math.min(1, graphAgeDays / FAMILIARITY_DAYS);
  const familiarity = contactFamiliarity * timeFamiliarity;
  const ambientCuriosity = eta * (1 - familiarity);

  const finalTotal = Math.max(smoothedCuriosity, ambientCuriosity);

  // 缩放 contributions 使其总和 = finalTotal（IAUS 路由用）
  const rawContribSum = Object.values(contributions).reduce((a, b) => a + b, 0);
  if (rawContribSum > 0 && finalTotal > 0) {
    const scale = finalTotal / rawContribSum;
    for (const key of Object.keys(contributions)) {
      contributions[key] *= scale;
    }
  } else if (rawContribSum > 0 && finalTotal === 0) {
    // P6=0 时清空 contributions（好奇心满足，不需要路由）
    for (const key of Object.keys(contributions)) {
      contributions[key] = 0;
    }
  }

  return { total: finalTotal, contributions };
}
