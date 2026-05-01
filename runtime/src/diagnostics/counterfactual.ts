/**
 * A4 D5 必要性反事实分析 — ADR-76 自动化行为验证。
 *
 * A4 同时报告两个不同反事实：
 * - cooling_gate_counterfactual: 移除 active_cooling 后，有多少沉默会行动。
 * - social_cost_counterfactual: 移除 C_social 后，有多少沉默会行动。
 *
 * 这两个 plane 不能混在一起。active_cooling 是行动密度/节奏抑制；
 * social_cost 才是社交成本项本身。
 *
 * @see docs/adr/76-naturalness-validation-methodology.md
 * @see docs/adr/63-theory-validation-checklist.md §V2
 * @see paper-five-dim/ Proposition: D5 Irreducibility
 */

import { asc, eq } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { actionLog, candidateTrace, silenceLog } from "../db/schema.js";

const NON_APPLICABLE_REASONS = new Set(["all_candidates_negative", "silence_cooldown"]);
const NON_SOCIAL_COST_REASONS = new Set([
  "active_cooling",
  "voi_deferred",
  "post_wakeup_recovery",
  "queue_backpressure",
  "all_candidates_negative",
  "silence_cooldown",
]);
const SOCIAL_COST_BOTTLENECKS = new Set(["U_social_safety", "social_cost", "C_social"]);

// ═══════════════════════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════════════════════

export interface CounterfactualD5Report {
  /** 反事实样本来源。 */
  source: "candidate_trace" | "silence_log";
  /** 样本完整性。 */
  sampleStatus: "real" | "partial" | "empty";
  /** 沉默样本总数。 */
  totalSilenceSamples: number;
  /** 与 D5 反事实无关的沉默样本数，例如没有候选可行动。 */
  nonApplicableSilences: number;
  /** 进入 D5 反事实范围的沉默样本数。 */
  applicableSilences: number;
  /** 缺少 deltaP/socialCost 的沉默样本数。 */
  partialSilences: number;
  /** 沉默总数（有 netValue 和 socialCost 数据的）。 */
  analyzableSilences: number;
  /** 兼容字段：所有 plane 的翻转合计。新读面应看 coolingGate/socialCost。 */
  flippedActions: number;
  /** 兼容字段：所有 plane 的合计翻转率。新读面应看 coolingGate/socialCost。 */
  flipRate: number;
  /** 按沉默原因分组的翻转统计。 */
  flipsByReason: Record<string, { total: number; flipped: number; rate: number }>;
  /** 按沉默原因分组的样本质量统计。 */
  sampleQualityByReason: Record<
    string,
    {
      total: number;
      nonApplicable: number;
      applicable: number;
      partial: number;
      analyzable: number;
    }
  >;
  /** 行动总数（参考基线）。 */
  totalActions: number;
  /**
   * 无 D5 时的行动频率变化 = (totalActions + flippedActions) / totalActions。
   * ADR-63 V2 预测：此值 >> 1（D5 显著抑制行动频率）。
   */
  frequencyMultiplier: number;
  /** 按目标分组的翻转分布（哪些目标受 D5 保护最多）。 */
  flipsByTarget: Record<string, number>;
  /** 移除 active_cooling gate 后的反事实。 */
  coolingGate: CounterfactualPlaneReport;
  /** 移除 social cost 后的反事实。 */
  socialCost: CounterfactualPlaneReport;
  /** IAUS 乘法评分下，将 U_social_safety 置为 1 后的候选排序反事实。 */
  socialSafetyRankAblation: SocialSafetyRankAblationReport;
}

export interface CounterfactualPlaneReport {
  total: number;
  analyzable: number;
  partial: number;
  flipped: number;
  flipRate: number;
  frequencyMultiplier: number;
  flipsByReason: Record<string, { total: number; flipped: number; rate: number }>;
  flipsByTarget: Record<string, number>;
}

export interface SocialSafetyRankAblationReport {
  /** 有候选池可重放的 tick 数。 */
  totalPools: number;
  /** 至少一个候选含 U_social_safety 的 tick 数。 */
  analyzablePools: number;
  /** 参与 ablation 的 sociability 候选数。 */
  socialSafetyCandidateCount: number;
  /** U_social_safety 的平均值。 */
  meanSocialSafety: number;
  /** ablation 后平均分数提升倍数（只统计含 U_social_safety 的候选）。 */
  meanLift: number;
  /** ablation 后最大分数提升倍数。 */
  maxLift: number;
  /** ablation 后 top candidate 发生变化的 tick 数。 */
  changedTop: number;
  /** changedTop / analyzablePools。 */
  changeRate: number;
  /** 变化样例。 */
  topChanges: Array<{
    tick: number;
    original: CandidateSummary;
    counterfactual: CandidateSummary;
  }>;
}

export interface CandidateSummary {
  candidateId: string;
  action: string;
  target: string | null;
  score: number;
  bottleneck: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 分析函数
// ═══════════════════════════════════════════════════════════════════════════

/**
 * D5 反事实分析：令 C_social = 0 后有多少沉默会翻转。
 *
 * 使用 silence_log 中已记录的 deltaP 和 socialCost 重建 NSV：
 * - 原始 NSV = netValue = deltaP - lambda * socialCost（已被门控跳过）
 * - 反事实 NSV' = deltaP（移除 socialCost）
 * - 如果 NSV' > 0 且原始决策是沉默，则该决策翻转
 *
 * 注意：仅分析 reason 不是 rate_cap 的沉默（rate_cap 与 D5 无关）。
 */
export function counterfactualD5(): CounterfactualD5Report {
  const db = getDb();

  const candidateSilences = db
    .select({
      tick: candidateTrace.tick,
      reason: candidateTrace.silenceReason,
      targetNamespace: candidateTrace.targetNamespace,
      targetId: candidateTrace.targetId,
      netValue: candidateTrace.netValue,
      deltaP: candidateTrace.deltaP,
      socialCost: candidateTrace.socialCost,
      bottleneck: candidateTrace.bottleneck,
      sampleStatus: candidateTrace.sampleStatus,
    })
    .from(candidateTrace)
    .where(eq(candidateTrace.selected, false))
    .orderBy(asc(candidateTrace.tick))
    .all()
    .filter((s) => s.reason !== "N/A");
  const candidateRows = db
    .select({
      candidateId: candidateTrace.candidateId,
      tick: candidateTrace.tick,
      targetNamespace: candidateTrace.targetNamespace,
      targetId: candidateTrace.targetId,
      actionType: candidateTrace.actionType,
      normalizedConsiderationsJson: candidateTrace.normalizedConsiderationsJson,
      netValue: candidateTrace.netValue,
      bottleneck: candidateTrace.bottleneck,
      gatePlane: candidateTrace.gatePlane,
      selected: candidateTrace.selected,
      silenceReason: candidateTrace.silenceReason,
    })
    .from(candidateTrace)
    .orderBy(asc(candidateTrace.tick))
    .all();

  const legacySilences = db
    .select({
      tick: silenceLog.tick,
      reason: silenceLog.reason,
      target: silenceLog.target,
      netValue: silenceLog.netValue,
      deltaP: silenceLog.deltaP,
      socialCost: silenceLog.socialCost,
    })
    .from(silenceLog)
    .orderBy(asc(silenceLog.tick))
    .all();

  const totalActions = db.select({ tick: actionLog.tick }).from(actionLog).all().length;
  const source = candidateSilences.length > 0 ? "candidate_trace" : "silence_log";
  const silences =
    source === "candidate_trace"
      ? candidateSilences.map((s) => ({
          tick: s.tick,
          reason: s.reason,
          target:
            s.targetId == null
              ? null
              : s.targetNamespace === "none"
                ? null
                : `${s.targetNamespace}:${s.targetId}`,
          netValue: s.netValue,
          deltaP: s.deltaP,
          socialCost: s.socialCost,
          bottleneck: s.bottleneck,
        }))
      : legacySilences.map((s) => ({ ...s, bottleneck: null }));

  const nonApplicableSilences = silences.filter(
    (s) => NON_APPLICABLE_REASONS.has(s.reason) && s.deltaP === null && s.socialCost === null,
  ).length;
  const applicable = silences.filter(
    (s) => !NON_APPLICABLE_REASONS.has(s.reason) || s.deltaP !== null || s.socialCost !== null,
  );

  // 只分析有完整数值数据的沉默记录。
  const analyzable = applicable.filter((s) => s.deltaP !== null && s.socialCost !== null);
  const partialSilences = applicable.length - analyzable.length;
  const sampleStatus = applicable.length === 0 ? "empty" : partialSilences > 0 ? "partial" : "real";

  const sampleQualityByReason: CounterfactualD5Report["sampleQualityByReason"] = {};

  for (const silence of silences) {
    let quality = sampleQualityByReason[silence.reason];
    if (!quality) {
      quality = {
        total: 0,
        nonApplicable: 0,
        applicable: 0,
        partial: 0,
        analyzable: 0,
      };
      sampleQualityByReason[silence.reason] = quality;
    }
    quality.total++;
    const isNonApplicable =
      NON_APPLICABLE_REASONS.has(silence.reason) &&
      silence.deltaP === null &&
      silence.socialCost === null;
    if (isNonApplicable) {
      quality.nonApplicable++;
      continue;
    }
    quality.applicable++;
    if (silence.deltaP !== null && silence.socialCost !== null) {
      quality.analyzable++;
    } else {
      quality.partial++;
    }
  }

  const coolingGate = buildPlaneReport(
    applicable.filter((s) => s.reason === "active_cooling"),
    totalActions,
    (s) => (s.netValue ?? 0) > 0,
  );
  const socialCost = buildPlaneReport(
    applicable.filter((s) => isSocialCostCounterfactualSample(s)),
    totalActions,
    (s) => (s.deltaP ?? 0) > 0,
  );
  const flippedActions = coolingGate.flipped + socialCost.flipped;
  const combinedAnalyzable = coolingGate.analyzable + socialCost.analyzable;
  const combinedFlipsByReason = mergeReasonCounts(
    coolingGate.flipsByReason,
    socialCost.flipsByReason,
  );
  const combinedFlipsByTarget = mergeTargetCounts(
    coolingGate.flipsByTarget,
    socialCost.flipsByTarget,
  );

  return {
    source,
    sampleStatus,
    totalSilenceSamples: silences.length,
    nonApplicableSilences,
    applicableSilences: applicable.length,
    partialSilences,
    analyzableSilences: analyzable.length,
    flippedActions,
    flipRate: combinedAnalyzable > 0 ? flippedActions / combinedAnalyzable : 0,
    flipsByReason: combinedFlipsByReason,
    totalActions,
    frequencyMultiplier: totalActions > 0 ? (totalActions + flippedActions) / totalActions : 1,
    flipsByTarget: combinedFlipsByTarget,
    sampleQualityByReason,
    coolingGate,
    socialCost,
    socialSafetyRankAblation: buildSocialSafetyRankAblation(candidateRows),
  };
}

type CandidateTraceRow = {
  candidateId: string;
  tick: number;
  targetNamespace: string;
  targetId: string | null;
  actionType: string;
  normalizedConsiderationsJson: string;
  netValue: number | null;
  bottleneck: string | null;
  gatePlane: string;
  selected: boolean;
  silenceReason: string;
};

type CounterfactualSilence = {
  reason: string;
  target: string | null;
  netValue: number | null;
  deltaP: number | null;
  socialCost: number | null;
  bottleneck?: string | null;
};

function isAnalyzable(s: CounterfactualSilence): boolean {
  return s.deltaP !== null && s.socialCost !== null;
}

function isSocialCostCounterfactualSample(sample: CounterfactualSilence): boolean {
  if (NON_SOCIAL_COST_REASONS.has(sample.reason)) {
    return false;
  }
  if (isSocialCostBottleneck(sample.bottleneck)) return true;
  return sample.reason !== "lost_candidate";
}

function isSocialCostBottleneck(bottleneck: string | null | undefined): boolean {
  return SOCIAL_COST_BOTTLENECKS.has(bottleneck ?? "");
}

const IAUS_COMPENSATION_FACTOR = 0.4;
const POST_CF_CONSIDERATIONS = new Set(["U_proactive_pacing", "U_fairness"]);

function buildSocialSafetyRankAblation(rows: CandidateTraceRow[]): SocialSafetyRankAblationReport {
  const pools = new Map<number, CandidateTraceRow[]>();
  for (const row of rows) {
    if (!isCandidatePoolRow(row)) continue;
    const pool = pools.get(row.tick) ?? [];
    pool.push(row);
    pools.set(row.tick, pool);
  }

  let analyzablePools = 0;
  let socialSafetyCandidateCount = 0;
  let socialSafetySum = 0;
  let liftSum = 0;
  let maxLift = 1;
  let changedTop = 0;
  const topChanges: SocialSafetyRankAblationReport["topChanges"] = [];

  for (const [tick, pool] of pools) {
    const scored = pool
      .map((row) => {
        const originalScore = row.netValue;
        if (originalScore === null) return null;
        const considerations = decodeConsiderations(row.normalizedConsiderationsJson);
        const ablatedScore = ablateSocialSafetyScore(originalScore, considerations);
        const socialSafety = readConsideration(considerations, "U_social_safety");
        if (socialSafety !== null) {
          socialSafetyCandidateCount++;
          socialSafetySum += socialSafety;
          const lift = originalScore > 0 ? ablatedScore / originalScore : 1;
          liftSum += lift;
          maxLift = Math.max(maxLift, lift);
        }
        return { row, originalScore, ablatedScore, socialSafety };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    if (scored.length === 0) continue;
    if (!scored.some((entry) => entry.socialSafety !== null)) continue;
    analyzablePools++;

    const originalTop = maxBy(scored, (entry) => entry.originalScore);
    const counterfactualTop = maxBy(scored, (entry) => entry.ablatedScore);
    if (!originalTop || !counterfactualTop) continue;
    if (originalTop.row.candidateId !== counterfactualTop.row.candidateId) {
      changedTop++;
      if (topChanges.length < 10) {
        topChanges.push({
          tick,
          original: summarizeCandidate(originalTop.row, originalTop.originalScore),
          counterfactual: summarizeCandidate(counterfactualTop.row, counterfactualTop.ablatedScore),
        });
      }
    }
  }

  return {
    totalPools: pools.size,
    analyzablePools,
    socialSafetyCandidateCount,
    meanSocialSafety:
      socialSafetyCandidateCount > 0 ? socialSafetySum / socialSafetyCandidateCount : 0,
    meanLift: socialSafetyCandidateCount > 0 ? liftSum / socialSafetyCandidateCount : 1,
    maxLift,
    changedTop,
    changeRate: analyzablePools > 0 ? changedTop / analyzablePools : 0,
    topChanges,
  };
}

function isCandidatePoolRow(row: CandidateTraceRow): boolean {
  return row.selected || row.silenceReason === "lost_candidate" || row.gatePlane === "none";
}

function decodeConsiderations(raw: string): Record<string, number> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function ablateSocialSafetyScore(
  originalScore: number,
  considerations: Record<string, number>,
): number {
  const socialSafety = readConsideration(considerations, "U_social_safety");
  if (socialSafety === null || socialSafety <= 0 || socialSafety >= 1) return originalScore;

  const preCfValues = Object.entries(considerations)
    .filter(([key]) => !POST_CF_CONSIDERATIONS.has(key))
    .map(([key, value]) => (key === "U_social_safety" ? 1 : value));
  const originalPreCfValues = Object.entries(considerations)
    .filter(([key]) => !POST_CF_CONSIDERATIONS.has(key))
    .map(([, value]) => value);
  if (preCfValues.length === 0 || originalPreCfValues.length !== preCfValues.length) {
    return originalScore;
  }

  const originalPreCf = compensateProduct(originalPreCfValues);
  const ablatedPreCf = compensateProduct(preCfValues);
  if (originalPreCf <= 0) return originalScore;
  return originalScore * (ablatedPreCf / originalPreCf);
}

function readConsideration(considerations: Record<string, number>, key: string): number | null {
  const value = considerations[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compensateProduct(values: number): number;
function compensateProduct(values: number[]): number;
function compensateProduct(values: number | number[]): number {
  if (typeof values === "number") return values;
  const product = values.reduce((acc, value) => acc * value, 1);
  const n = values.length;
  if (n <= 1 || product <= 0) return product;
  const geomMean = product ** (1 / n);
  return geomMean * (1 + (1 - geomMean) * IAUS_COMPENSATION_FACTOR);
}

function maxBy<T>(items: T[], score: (item: T) => number): T | null {
  let best: T | null = null;
  let bestScore = -Infinity;
  for (const item of items) {
    const value = score(item);
    if (value > bestScore) {
      best = item;
      bestScore = value;
    }
  }
  return best;
}

function summarizeCandidate(row: CandidateTraceRow, score: number): CandidateSummary {
  return {
    candidateId: row.candidateId,
    action: row.actionType,
    target:
      row.targetId == null
        ? null
        : row.targetNamespace === "none"
          ? null
          : `${row.targetNamespace}:${row.targetId}`,
    score,
    bottleneck: row.bottleneck,
  };
}

function buildPlaneReport(
  samples: CounterfactualSilence[],
  totalActions: number,
  flips: (sample: CounterfactualSilence) => boolean,
): CounterfactualPlaneReport {
  const analyzable = samples.filter(isAnalyzable);
  const flipsByReason: Record<string, { total: number; flipped: number }> = {};
  const flipsByTarget: Record<string, number> = {};
  let flipped = 0;

  for (const sample of analyzable) {
    const reason = sample.reason;
    if (!flipsByReason[reason]) flipsByReason[reason] = { total: 0, flipped: 0 };
    flipsByReason[reason].total++;
    if (flips(sample)) {
      flipped++;
      flipsByReason[reason].flipped++;
      const target = sample.target ?? "__no_target__";
      flipsByTarget[target] = (flipsByTarget[target] ?? 0) + 1;
    }
  }

  return {
    total: samples.length,
    analyzable: analyzable.length,
    partial: samples.length - analyzable.length,
    flipped,
    flipRate: analyzable.length > 0 ? flipped / analyzable.length : 0,
    frequencyMultiplier: totalActions > 0 ? (totalActions + flipped) / totalActions : 1,
    flipsByReason: withRates(flipsByReason),
    flipsByTarget,
  };
}

function withRates(
  counts: Record<string, { total: number; flipped: number }>,
): Record<string, { total: number; flipped: number; rate: number }> {
  const out: Record<string, { total: number; flipped: number; rate: number }> = {};
  for (const [reason, stats] of Object.entries(counts)) {
    out[reason] = {
      ...stats,
      rate: stats.total > 0 ? stats.flipped / stats.total : 0,
    };
  }
  return out;
}

function mergeReasonCounts(
  ...reports: Array<Record<string, { total: number; flipped: number; rate: number }>>
): Record<string, { total: number; flipped: number; rate: number }> {
  const merged: Record<string, { total: number; flipped: number }> = {};
  for (const report of reports) {
    for (const [reason, stats] of Object.entries(report)) {
      let row = merged[reason];
      if (!row) {
        row = { total: 0, flipped: 0 };
        merged[reason] = row;
      }
      row.total += stats.total;
      row.flipped += stats.flipped;
    }
  }
  return withRates(merged);
}

function mergeTargetCounts(...reports: Array<Record<string, number>>): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const report of reports) {
    for (const [target, count] of Object.entries(report)) {
      merged[target] = (merged[target] ?? 0) + count;
    }
  }
  return merged;
}
