/**
 * ADR-261 Wave 0: harmonic rhythm profile diagnostics.
 *
 * 这里故意保持为纯函数：输入事件值，输出可重建 projection。
 * DB 读取、prompt 渲染、IAUS 控制接入都在外层组合，避免把事实、分析、投影和控制编织在一起。
 *
 * @see docs/adr/261-rhythm-profile-projection.md
 */

const HOUR_MS = 3_600_000;
const DAY_HOURS = 24;
const DEFAULT_PERIODS_HOURS = [24, 12, 168] as const;
const MIN_CONFIDENCE_SAMPLES = 12;
const MIN_CONFIDENCE_BUCKETS = 48;
const MIN_CONFIDENCE_ACTIVE_BUCKETS = 6;
const MIN_CONFIDENCE_OBSERVED_DAYS = 3;
const MIN_CONFIDENCE_R2 = 0.08;
const HIGH_CONFIDENCE_SAMPLES = 60;
const HIGH_CONFIDENCE_R2 = 0.18;
const HIGH_CONFIDENCE_RHYTHMIC_STRENGTH = 0.18;
const MIN_PERIOD_COVERAGE_HOURS = new Map<number, number>([
  [24, 72],
  [12, 48],
  [168, 21 * 24],
]);

export type RhythmEntityType = "contact" | "channel" | "self";
export type RhythmConfidence = "low" | "medium" | "high";

export interface RhythmEvent {
  entityId: string;
  entityType: RhythmEntityType;
  occurredAtMs: number;
  weight?: number;
}

export interface TimeWindow {
  startHour: number;
  endHour: number;
}

export interface HarmonicCoefficients {
  intercept: number;
  terms: Array<{
    periodHours: number;
    cos: number;
    sin: number;
    amplitude: number;
    phaseHour: number;
  }>;
}

export interface RhythmDiagnostics {
  r2: number;
  dailyStrength: number;
  halfDailyStrength: number;
  weeklyStrength: number;
  activeBucketCount: number;
  observedSpanHours: number;
  observedDays: number;
  timezoneOffsetHours: number;
  enabledPeriodsHours: number[];
  coefficients: HarmonicCoefficients;
  hourlyScores: number[];
}

export interface RhythmProfileProjection {
  entityId: string;
  entityType: RhythmEntityType;
  sourceWindowStartMs: number;
  sourceWindowEndMs: number;
  sampleCount: number;
  bucketCount: number;
  activeBucketCount: number;
  observedSpanHours: number;
  observedDays: number;
  timezoneOffsetHours: number;
  enabledPeriodsHours: number[];
  activeNowScore: number;
  quietNowScore: number;
  unusualActivityScore: number;
  peakWindows: TimeWindow[];
  quietWindows: TimeWindow[];
  confidence: RhythmConfidence;
  stale: boolean;
  diagnostics: RhythmDiagnostics;
}

export type RhythmConfidenceReason =
  | "insufficient_samples"
  | "insufficient_buckets"
  | "insufficient_coverage"
  | "no_enabled_periods"
  | "weak_fit"
  | "medium_confidence"
  | "high_confidence";

export interface BuildRhythmProfileOptions {
  entityId: string;
  entityType: RhythmEntityType;
  nowMs: number;
  windowStartMs?: number;
  windowEndMs?: number;
  bucketMs?: number;
  ridgeLambda?: number;
  periodsHours?: readonly number[];
  timezoneOffsetHours?: number;
  recentActivityMs?: number;
  staleAfterMs?: number;
}

interface BucketSeries {
  startMs: number;
  bucketMs: number;
  values: number[];
  sampleCount: number;
  activeBucketCount: number;
  observedSpanHours: number;
  observedDays: number;
  lastEventMs: number | null;
}

interface FittedHarmonicModel {
  coefficients: HarmonicCoefficients;
  r2: number;
  predict: (timeMs: number) => number;
}

export function buildRhythmProfile(
  events: readonly RhythmEvent[],
  options: BuildRhythmProfileOptions,
): RhythmProfileProjection {
  const bucketMs = options.bucketMs ?? HOUR_MS;
  const sourceWindowEndMs = options.windowEndMs ?? options.nowMs;
  const sourceWindowStartMs =
    options.windowStartMs ?? inferWindowStart(events, sourceWindowEndMs, 90 * DAY_HOURS * HOUR_MS);
  const timezoneOffsetHours = options.timezoneOffsetHours ?? 0;
  const buckets = bucketEvents(events, {
    startMs: sourceWindowStartMs,
    endMs: sourceWindowEndMs,
    bucketMs,
    timezoneOffsetHours,
  });
  const periodsHours = enabledPeriodsForSpan(
    options.periodsHours ?? DEFAULT_PERIODS_HOURS,
    buckets.observedSpanHours,
  );
  const model = fitHarmonicModel(buckets, {
    periodsHours,
    ridgeLambda: options.ridgeLambda ?? 0.01,
  });
  const hourlyScores = buildHourlyScores(model, options.nowMs, timezoneOffsetHours);
  const activeNowScore = scoreAt(options.nowMs, hourlyScores, timezoneOffsetHours);
  const quietNowScore = 1 - activeNowScore;
  const dailyStrength = strengthFor(model.coefficients, 24);
  const halfDailyStrength = strengthFor(model.coefficients, 12);
  const weeklyStrength = strengthFor(model.coefficients, 168);
  const rhythmicStrength = Math.max(dailyStrength, halfDailyStrength, weeklyStrength);
  const confidence = classifyConfidence({
    sampleCount: buckets.sampleCount,
    bucketCount: buckets.values.length,
    activeBucketCount: buckets.activeBucketCount,
    observedDays: buckets.observedDays,
    enabledPeriodCount: periodsHours.length,
    r2: model.r2,
    rhythmicStrength,
  });
  const staleAfterMs = options.staleAfterMs ?? 14 * DAY_HOURS * HOUR_MS;
  const stale = buckets.lastEventMs === null || options.nowMs - buckets.lastEventMs > staleAfterMs;
  const recentActivityMs = options.recentActivityMs ?? buckets.lastEventMs;
  const unusualActivityScore =
    confidence === "low" || recentActivityMs === null
      ? 0
      : 1 - scoreAt(recentActivityMs, hourlyScores, timezoneOffsetHours);

  return {
    entityId: options.entityId,
    entityType: options.entityType,
    sourceWindowStartMs,
    sourceWindowEndMs,
    sampleCount: buckets.sampleCount,
    bucketCount: buckets.values.length,
    activeBucketCount: buckets.activeBucketCount,
    observedSpanHours: buckets.observedSpanHours,
    observedDays: buckets.observedDays,
    timezoneOffsetHours,
    enabledPeriodsHours: [...periodsHours],
    activeNowScore,
    quietNowScore,
    unusualActivityScore,
    peakWindows: windowsFromScores(hourlyScores, (score) => score >= 0.7),
    quietWindows: windowsFromScores(hourlyScores, (score) => score <= 0.3),
    confidence,
    stale,
    diagnostics: {
      r2: model.r2,
      dailyStrength,
      halfDailyStrength,
      weeklyStrength,
      activeBucketCount: buckets.activeBucketCount,
      observedSpanHours: buckets.observedSpanHours,
      observedDays: buckets.observedDays,
      timezoneOffsetHours,
      enabledPeriodsHours: [...periodsHours],
      coefficients: model.coefficients,
      hourlyScores,
    },
  };
}

export function renderTimingLine(profile: RhythmProfileProjection, label: string): string | null {
  if (profile.confidence === "low" || profile.stale) return null;
  const active = profile.activeNowScore >= 0.7;
  const quiet = profile.quietNowScore >= 0.7;
  const unusual = profile.unusualActivityScore >= 0.8;
  if (!active && !quiet && !unusual) return null;

  const peak = profile.peakWindows[0] ? formatWindow(profile.peakWindows[0]) : null;
  const quietWindow = profile.quietWindows[0] ? formatWindow(profile.quietWindows[0]) : null;
  if (active && peak) return `${label} 通常本地 ${peak} 活跃；现在在活跃窗口内。`;
  if (quiet && quietWindow) return `${label} 通常本地 ${quietWindow} 很安静；现在最好少打扰。`;
  if (unusual) return `${label} 现在活跃得有点反常，可能值得留意。`;
  return null;
}

export function explainRhythmConfidence(
  profile: RhythmProfileProjection,
): RhythmConfidenceReason[] {
  const rhythmicStrength = Math.max(
    profile.diagnostics.dailyStrength,
    profile.diagnostics.halfDailyStrength,
    profile.diagnostics.weeklyStrength,
  );
  const reasons: RhythmConfidenceReason[] = [];
  if (profile.sampleCount < MIN_CONFIDENCE_SAMPLES) reasons.push("insufficient_samples");
  if (profile.bucketCount < MIN_CONFIDENCE_BUCKETS) reasons.push("insufficient_buckets");
  if (
    profile.activeBucketCount < MIN_CONFIDENCE_ACTIVE_BUCKETS ||
    profile.observedDays < MIN_CONFIDENCE_OBSERVED_DAYS
  ) {
    reasons.push("insufficient_coverage");
  }
  if (profile.enabledPeriodsHours.length === 0) reasons.push("no_enabled_periods");
  if (profile.diagnostics.r2 < MIN_CONFIDENCE_R2) reasons.push("weak_fit");
  if (reasons.length > 0) return reasons;
  if (
    profile.sampleCount >= HIGH_CONFIDENCE_SAMPLES &&
    profile.diagnostics.r2 >= HIGH_CONFIDENCE_R2 &&
    rhythmicStrength >= HIGH_CONFIDENCE_RHYTHMIC_STRENGTH
  ) {
    return ["high_confidence"];
  }
  return ["medium_confidence"];
}

function inferWindowStart(
  events: readonly RhythmEvent[],
  fallbackEndMs: number,
  maxWindowMs: number,
): number {
  let min = Number.POSITIVE_INFINITY;
  for (const event of events) {
    if (Number.isFinite(event.occurredAtMs)) min = Math.min(min, event.occurredAtMs);
  }
  if (!Number.isFinite(min)) return fallbackEndMs - maxWindowMs;
  return Math.max(min, fallbackEndMs - maxWindowMs);
}

function bucketEvents(
  events: readonly RhythmEvent[],
  options: { startMs: number; endMs: number; bucketMs: number; timezoneOffsetHours: number },
): BucketSeries {
  const bucketCount = Math.max(1, Math.ceil((options.endMs - options.startMs) / options.bucketMs));
  const counts = new Array(bucketCount).fill(0) as number[];
  let sampleCount = 0;
  let firstEventMs: number | null = null;
  let lastEventMs: number | null = null;
  const observedDays = new Set<number>();
  const timezoneOffsetMs = options.timezoneOffsetHours * HOUR_MS;

  for (const event of events) {
    if (event.occurredAtMs < options.startMs || event.occurredAtMs >= options.endMs) continue;
    const idx = Math.floor((event.occurredAtMs - options.startMs) / options.bucketMs);
    if (idx < 0 || idx >= counts.length) continue;
    counts[idx] += event.weight ?? 1;
    sampleCount++;
    firstEventMs = Math.min(firstEventMs ?? event.occurredAtMs, event.occurredAtMs);
    lastEventMs = Math.max(lastEventMs ?? event.occurredAtMs, event.occurredAtMs);
    observedDays.add(Math.floor((event.occurredAtMs + timezoneOffsetMs) / (DAY_HOURS * HOUR_MS)));
  }

  const activeBucketCount = counts.filter((count) => count > 0).length;
  const observedSpanHours =
    firstEventMs === null || lastEventMs === null
      ? 0
      : Math.max(options.bucketMs / HOUR_MS, (lastEventMs - firstEventMs) / HOUR_MS);

  return {
    startMs: options.startMs,
    bucketMs: options.bucketMs,
    values: counts.map((count) => Math.log1p(count)),
    sampleCount,
    activeBucketCount,
    observedSpanHours,
    observedDays: observedDays.size,
    lastEventMs,
  };
}

function enabledPeriodsForSpan(
  periodsHours: readonly number[],
  observedSpanHours: number,
): number[] {
  return periodsHours.filter((periodHours) => {
    const minCoverage = MIN_PERIOD_COVERAGE_HOURS.get(periodHours) ?? periodHours * 3;
    return observedSpanHours >= minCoverage;
  });
}

function fitHarmonicModel(
  series: BucketSeries,
  options: { periodsHours: readonly number[]; ridgeLambda: number },
): FittedHarmonicModel {
  const featureCount = 1 + options.periodsHours.length * 2;
  const xtx = Array.from(
    { length: featureCount },
    () => new Array(featureCount).fill(0) as number[],
  );
  const xty = new Array(featureCount).fill(0) as number[];
  let ySum = 0;

  for (let i = 0; i < series.values.length; i++) {
    const timeMs = series.startMs + i * series.bucketMs;
    const row = harmonicFeatures(timeMs, options.periodsHours);
    const y = series.values[i];
    ySum += y;
    for (let r = 0; r < featureCount; r++) {
      xty[r] += row[r] * y;
      for (let c = 0; c < featureCount; c++) {
        xtx[r][c] += row[r] * row[c];
      }
    }
  }

  for (let i = 1; i < featureCount; i++) {
    xtx[i][i] += options.ridgeLambda;
  }

  const beta = solveLinearSystem(xtx, xty);
  const meanY = series.values.length > 0 ? ySum / series.values.length : 0;
  let ssTotal = 0;
  let ssResidual = 0;
  for (let i = 0; i < series.values.length; i++) {
    const timeMs = series.startMs + i * series.bucketMs;
    const predicted = dot(harmonicFeatures(timeMs, options.periodsHours), beta);
    const y = series.values[i];
    ssTotal += (y - meanY) ** 2;
    ssResidual += (y - predicted) ** 2;
  }

  return {
    coefficients: coefficientsFromBeta(beta, options.periodsHours),
    r2: ssTotal <= 1e-12 ? 0 : Math.max(0, 1 - ssResidual / ssTotal),
    predict: (timeMs: number) => dot(harmonicFeatures(timeMs, options.periodsHours), beta),
  };
}

function harmonicFeatures(timeMs: number, periodsHours: readonly number[]): number[] {
  const tHours = timeMs / HOUR_MS;
  const features = [1];
  for (const periodHours of periodsHours) {
    const theta = (2 * Math.PI * tHours) / periodHours;
    features.push(Math.cos(theta), Math.sin(theta));
  }
  return features;
}

function coefficientsFromBeta(
  beta: readonly number[],
  periodsHours: readonly number[],
): HarmonicCoefficients {
  const terms: HarmonicCoefficients["terms"] = [];
  for (let i = 0; i < periodsHours.length; i++) {
    const cos = beta[1 + i * 2] ?? 0;
    const sin = beta[2 + i * 2] ?? 0;
    const amplitude = Math.hypot(cos, sin);
    const rawPhase = (Math.atan2(sin, cos) * periodsHours[i]) / (2 * Math.PI);
    const phaseHour = positiveModulo(rawPhase, periodsHours[i]);
    terms.push({ periodHours: periodsHours[i], cos, sin, amplitude, phaseHour });
  }
  return { intercept: beta[0] ?? 0, terms };
}

function buildHourlyScores(
  model: FittedHarmonicModel,
  nowMs: number,
  timezoneOffsetHours: number,
): number[] {
  const timezoneOffsetMs = timezoneOffsetHours * HOUR_MS;
  const startOfDayMs =
    Math.floor((nowMs + timezoneOffsetMs) / (DAY_HOURS * HOUR_MS)) * DAY_HOURS * HOUR_MS -
    timezoneOffsetMs;
  const raw = Array.from({ length: DAY_HOURS }, (_, hour) =>
    model.predict(startOfDayMs + hour * HOUR_MS),
  );
  return normalize(raw);
}

function scoreAt(
  timeMs: number,
  hourlyScores: readonly number[],
  timezoneOffsetHours: number,
): number {
  const hour = positiveModulo(Math.floor(timeMs / HOUR_MS + timezoneOffsetHours), DAY_HOURS);
  return hourlyScores[hour] ?? 0.5;
}

function normalize(values: readonly number[]): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max - min < 1e-9) return values.map(() => 0.5);
  return values.map((value) => clamp01((value - min) / (max - min)));
}

function classifyConfidence(input: {
  sampleCount: number;
  bucketCount: number;
  activeBucketCount: number;
  observedDays: number;
  enabledPeriodCount: number;
  r2: number;
  rhythmicStrength: number;
}): RhythmConfidence {
  if (input.sampleCount < MIN_CONFIDENCE_SAMPLES || input.bucketCount < MIN_CONFIDENCE_BUCKETS) {
    return "low";
  }
  if (
    input.activeBucketCount < MIN_CONFIDENCE_ACTIVE_BUCKETS ||
    input.observedDays < MIN_CONFIDENCE_OBSERVED_DAYS ||
    input.enabledPeriodCount === 0
  ) {
    return "low";
  }
  if (input.r2 < MIN_CONFIDENCE_R2) return "low";
  if (
    input.sampleCount >= HIGH_CONFIDENCE_SAMPLES &&
    input.r2 >= HIGH_CONFIDENCE_R2 &&
    input.rhythmicStrength >= HIGH_CONFIDENCE_RHYTHMIC_STRENGTH
  ) {
    return "high";
  }
  return "medium";
}

function strengthFor(coefficients: HarmonicCoefficients, periodHours: number): number {
  const term = coefficients.terms.find((item) => item.periodHours === periodHours);
  if (!term) return 0;
  return term.amplitude / (Math.abs(coefficients.intercept) + term.amplitude + 1e-9);
}

function windowsFromScores(
  scores: readonly number[],
  predicate: (score: number) => boolean,
): TimeWindow[] {
  const windows: TimeWindow[] = [];
  let i = 0;
  while (i < scores.length) {
    if (!predicate(scores[i])) {
      i++;
      continue;
    }
    const start = i;
    while (i < scores.length && predicate(scores[i])) i++;
    windows.push({
      startHour: start,
      endHour: i % scores.length,
    });
  }

  if (windows.length > 1) {
    const first = windows[0];
    const last = windows[windows.length - 1];
    if (first.startHour === 0 && last.endHour === 0) {
      return [{ startHour: last.startHour, endHour: first.endHour }, ...windows.slice(1, -1)].slice(
        0,
        3,
      );
    }
  }
  return windows.slice(0, 3);
}

function formatWindow(window: TimeWindow): string {
  return `${formatHour(window.startHour)}-${formatHour(window.endHour)}`;
}

function formatHour(hour: number): string {
  return `${String(positiveModulo(hour, DAY_HOURS)).padStart(2, "0")}:00`;
}

function solveLinearSystem(matrix: number[][], vector: number[]): number[] {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-12) continue;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const div = a[col][col];
    for (let j = col; j <= n; j++) a[col][j] /= div;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let j = col; j <= n; j++) a[row][j] -= factor * a[col][j];
    }
  }

  return a.map((row) => (Number.isFinite(row[n]) ? row[n] : 0));
}

function dot(a: readonly number[], b: readonly number[]): number {
  let total = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) total += a[i] * b[i];
  return total;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function positiveModulo(value: number, modulo: number): number {
  return ((value % modulo) + modulo) % modulo;
}
