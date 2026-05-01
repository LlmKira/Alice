/**
 * IAUS 触发频率审计 — 基于真实 tick_log 数据的离线模拟。
 *
 * 用途：诊断 IAUS → LLM 调用链的有效利用率，模拟不同门控阈值下的效果。
 *
 * 运行方式：npx tsx runtime/scripts/iaus-frequency-audit.ts
 *
 * @see docs/adr/191-anomaly-thread-elimination.md
 */

import { resolve } from "node:path";
import Database from "better-sqlite3";
import {
  classifyIausActionRow,
  emptyEffectCounts,
  type IausActionCategory,
  type IausTelegramEffectCounts,
} from "../src/diagnostics/iaus-action-classifier.js";

const DB_PATH = resolve(import.meta.dirname ?? ".", "../alice.db");
const db = new Database(DB_PATH, { readonly: true });

// ── 数据提取 ────────────────────────────────────────────────────────

interface TickRow {
  tick: number;
  p1: number;
  p2: number;
  p3: number;
  p4: number;
  p5: number;
  p6: number;
  api: number;
  /** ADR-195: Peak-based API（驱动 tick 间隔）。 */
  api_peak: number | null;
  action: string | null;
  target: string | null;
  net_value: number | null;
  selected_probability: number | null;
  gate_verdict: string;
  mode: string;
  created_at: number;
}

interface ActionRow {
  tick: number;
  action_type: string;
  success: number;
  tc_command_log: string | null;
  engagement_outcome: string | null;
  tc_afterward: string | null;
}

interface SilenceRow {
  tick: number;
  target: string | null;
  reason: string;
  silence_level: string | null;
}

interface DecisionTraceRow {
  tick: number;
  phase: string;
  final_decision: string;
  payload_json: string;
}

interface QueueTraceRow {
  tick: number;
  enqueue_id: string;
  fate: string;
  enqueue_outcome: string;
  reason_code: string;
}

interface ActionResultRow {
  tick: number;
  enqueue_id: string | null;
  result: string;
  failure_code: string;
  action_type: string;
}

function tableExists(tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(tableName) as { name: string } | undefined;
  return Boolean(row);
}

const ticks: TickRow[] = db
  .prepare(
    `SELECT tick, p1, p2, p3, p4, p5, p6, api, api_peak, action, target,
            net_value, selected_probability, gate_verdict, mode, created_at
     FROM tick_log ORDER BY tick`,
  )
  .all() as TickRow[];

const actions: ActionRow[] = db
  .prepare(
    `SELECT tick, action_type, success, tc_command_log, engagement_outcome, tc_afterward
     FROM action_log`,
  )
  .all() as ActionRow[];

let silences: SilenceRow[] = [];
try {
  silences = db
    .prepare(`SELECT tick, target, reason, silence_level FROM silence_log ORDER BY tick`)
    .all() as SilenceRow[];
} catch {
  silences = [];
}

let decisionTraces: DecisionTraceRow[] = [];
try {
  decisionTraces = db
    .prepare(
      `SELECT tick, phase, final_decision, payload_json
       FROM decision_trace
       WHERE phase = 'evolve' AND final_decision = 'silence'
       ORDER BY tick`,
    )
    .all() as DecisionTraceRow[];
} catch {
  decisionTraces = [];
}

const queueTraces: QueueTraceRow[] = tableExists("queue_trace")
  ? (db
      .prepare(
        `SELECT tick, enqueue_id, enqueue_outcome, fate, reason_code
         FROM queue_trace ORDER BY tick, id`,
      )
      .all() as QueueTraceRow[])
  : [];

const actionResults: ActionResultRow[] = tableExists("action_result")
  ? (db
      .prepare(
        `SELECT tick, enqueue_id, result, failure_code, action_type
         FROM action_result ORDER BY tick, id`,
      )
      .all() as ActionResultRow[])
  : [];

const actionByTick = new Map<number, ActionRow[]>();
for (const a of actions) {
  const arr = actionByTick.get(a.tick) ?? [];
  arr.push(a);
  actionByTick.set(a.tick, arr);
}

const silenceByTick = new Map<number, SilenceRow[]>();
for (const s of silences) {
  const arr = silenceByTick.get(s.tick) ?? [];
  arr.push(s);
  silenceByTick.set(s.tick, arr);
}

// ── 分析 ──────────────────────────────────────────────────────────────

console.log("═══════════════════════════════════════════════════════════════");
console.log("  IAUS 触发频率审计报告");
console.log("═══════════════════════════════════════════════════════════════");
console.log();

// 1. 基本统计
const totalTicks = ticks.length;
const enqueueTicks = ticks.filter((t) => t.gate_verdict === "enqueue");
const silentTicks = ticks.filter((t) => t.gate_verdict.startsWith("silent:"));
const skipTicks = ticks.filter((t) => t.gate_verdict.startsWith("system1:skip"));

console.log("§1. 漏斗统计");
console.log("─────────────────────────────────────────────────────────────");
console.log(`  总 tick:              ${totalTicks}`);
console.log(
  `  enqueue（入队 LLM）:  ${enqueueTicks.length} (${pct(enqueueTicks.length, totalTicks)})`,
);
console.log(
  `  silent（门控拦截）:   ${silentTicks.length} (${pct(silentTicks.length, totalTicks)})`,
);
console.log(`  system1:skip:         ${skipTicks.length} (${pct(skipTicks.length, totalTicks)})`);
console.log();

// 1b. EVOLVE resource/recovery suppressions 可观测性
const queueBackpressureRows = silences.filter((s) => s.reason === "queue_backpressure");
const postWakeupRecoveryRows = silences.filter((s) => s.reason === "post_wakeup_recovery");
const queueBackpressureTicks = new Set(queueBackpressureRows.map((s) => s.tick));
const queueBackpressureTraces = decisionTraces
  // silence_log.reason 是沉默原因权威；decision_trace.payload 只提供解释性遥测。
  .filter((row) => queueBackpressureTicks.has(row.tick))
  .map((row) => parseDecisionTracePayload(row.payload_json))
  .filter((payload) => payload !== null);
const queueSaturations = queueBackpressureTraces
  .map((payload) => Number(payload.values?.queueSaturation))
  .filter((v) => Number.isFinite(v));
const queueActives = queueBackpressureTraces
  .map((payload) => Number(payload.values?.queueActive))
  .filter((v) => Number.isFinite(v));
if (silences.length > 0 || decisionTraces.length > 0) {
  console.log("§1b. EVOLVE Resource / Recovery Suppressions");
  console.log("─────────────────────────────────────────────────────────────");
  console.log(
    `  queue_backpressure:   ${queueBackpressureRows.length} (${pct(queueBackpressureRows.length, totalTicks)})`,
  );
  console.log(
    `  post_wakeup_recovery: ${postWakeupRecoveryRows.length} (${pct(postWakeupRecoveryRows.length, totalTicks)})`,
  );
  const postWakeupTargets = new Set(
    postWakeupRecoveryRows.map((s) => s.target).filter((target) => target !== null),
  );
  if (postWakeupRecoveryRows.length > 0) {
    console.log(`  recovery 目标数:      ${postWakeupTargets.size}`);
  }
  if (queueSaturations.length > 0) {
    console.log(
      `  saturation 中位/平均: ${median(queueSaturations).toFixed(3)} / ${mean(queueSaturations).toFixed(3)}`,
    );
  }
  if (queueActives.length > 0) {
    console.log(
      `  queue active 中位/平均: ${median(queueActives).toFixed(1)} / ${mean(queueActives).toFixed(1)}`,
    );
  }
  console.log();
}

// 1c. ADR-195: API vs API_peak 对比
const peakTicks = ticks.filter((t) => t.api_peak !== null);
if (peakTicks.length > 0) {
  const apiPeakValues = peakTicks.map((t) => Number(t.api_peak));
  const apiValues = peakTicks.map((t) => t.api);
  console.log("§1c. ADR-195: API vs API_peak 对比");
  console.log("─────────────────────────────────────────────────────────────");
  console.log(`  采样 tick 数:         ${peakTicks.length}`);
  console.log(
    `  API      中位/平均:   ${median(apiValues).toFixed(2)} / ${mean(apiValues).toFixed(2)}`,
  );
  console.log(
    `  API_peak 中位/平均:   ${median(apiPeakValues).toFixed(2)} / ${mean(apiPeakValues).toFixed(2)}`,
  );
  console.log(`  压缩比 (peak/api):    ${(mean(apiPeakValues) / mean(apiValues)).toFixed(3)}`);
  console.log();
}

// 1d. ADR-258 typed observation spine
if (queueTraces.length > 0 || actionResults.length > 0) {
  console.log("§1d. ADR-258 Typed Observation Spine");
  console.log("─────────────────────────────────────────────────────────────");
  console.log(`  queue_trace rows:     ${queueTraces.length}`);
  console.log(`  action_result rows:   ${actionResults.length}`);
  console.log(
    `  queue fate:           ${formatCounts(countBy(queueTraces.map((row) => row.fate)))}`,
  );
  console.log(
    `  enqueue outcome:      ${formatCounts(countBy(queueTraces.map((row) => row.enqueue_outcome)))}`,
  );
  console.log(
    `  action result:        ${formatCounts(countBy(actionResults.map((row) => row.result)))}`,
  );
  const missingTypedFate = enqueueTicks.filter(
    (tick) => !queueTraces.some((row) => row.tick === tick.tick),
  ).length;
  console.log(`  enqueue 缺 typed fate: ${missingTypedFate}`);
  console.log();
}

// 2. Enqueue 质量分析
const enqueueWithAction = enqueueTicks.filter((t) => actionByTick.has(t.tick));
const enqueueNoAction = enqueueTicks.filter((t) => !actionByTick.has(t.tick));

const enqueueActionSummary = summarizeActions(
  enqueueWithAction.flatMap((t) => actionByTick.get(t.tick) ?? []),
);
const llmFailed = enqueueActionSummary.categories.llm_failure;
const llmSilence = enqueueActionSummary.categories.llm_silence;
const telegramSuccessRows = enqueueActionSummary.categories.telegram_success;
const telegramFailureRows = enqueueActionSummary.categories.telegram_failure;
const observeOnly = enqueueActionSummary.categories.observe_only;
const internalAction = enqueueActionSummary.categories.internal_action;
const telegramSuccesses = enqueueActionSummary.telegramSuccesses;
const telegramFailures = enqueueActionSummary.telegramFailures;
const totalLLMCalls = enqueueActionSummary.totalRows;

console.log("§2. LLM 调用质量");
console.log("─────────────────────────────────────────────────────────────");
console.log(`  入队 tick:            ${enqueueTicks.length}`);
console.log(`  实际执行（有 action_log）: ${enqueueWithAction.length}`);
console.log(`  队列丢弃（无 action_log）: ${enqueueNoAction.length}`);
console.log();
console.log(`  LLM 调用结果分布（${totalLLMCalls} 条 action_log）:`);
console.log(`    LLM 失败:           ${llmFailed} (${pct(llmFailed, totalLLMCalls)}) ← 浪费`);
console.log(
  `    LLM 选择沉默:       ${llmSilence} (${pct(llmSilence, totalLLMCalls)}) ← IAUS 认为值得，LLM 否决`,
);
console.log(
  `    Telegram 成功行:    ${telegramSuccessRows} (${pct(telegramSuccessRows, totalLLMCalls)})`,
);
console.log(
  `    Telegram 失败行:    ${telegramFailureRows} (${pct(telegramFailureRows, totalLLMCalls)})`,
);
console.log(`    Observe-only:       ${observeOnly} (${pct(observeOnly, totalLLMCalls)})`);
console.log(`    内部行动:           ${internalAction} (${pct(internalAction, totalLLMCalls)})`);
console.log();
console.log(`  Telegram 成功副作用:  ${telegramSuccesses}`);
console.log(`  Telegram 失败副作用:  ${telegramFailures}`);
console.log(`  Telegram 成功类型:    ${formatEffectCounts(enqueueActionSummary.successEffects)}`);
console.log(`  Telegram 失败类型:    ${formatEffectCounts(enqueueActionSummary.failureEffects)}`);
console.log(
  `  ⚡ 有效利用率 = Telegram 成功行 / LLM 调用 = ${pct(telegramSuccessRows, totalLLMCalls)}`,
);
console.log(
  `  ⚡ IAUS-LLM 校准偏差 = LLM 沉默 / (LLM 沉默 + Telegram 成功行) = ${pct(llmSilence, llmSilence + telegramSuccessRows)}`,
);
console.log();

// 3. Net Value 分布
const nvBuckets = [
  { label: "< 0.3 (低)", min: -Infinity, max: 0.3 },
  { label: "0.3-0.5 (中低)", min: 0.3, max: 0.5 },
  { label: "0.5-0.7 (中)", min: 0.5, max: 0.7 },
  { label: "0.7-0.9 (高)", min: 0.7, max: 0.9 },
  { label: ">= 0.9 (极高)", min: 0.9, max: Infinity },
];

console.log("§3. Net Value 分布（enqueue tick）");
console.log("─────────────────────────────────────────────────────────────");
for (const b of nvBuckets) {
  const inBucket = enqueueTicks.filter(
    (t) => t.net_value !== null && t.net_value >= b.min && t.net_value < b.max,
  );
  const bucketSummary = summarizeActions(inBucket.flatMap((t) => actionByTick.get(t.tick) ?? []));
  console.log(
    `  ${b.label.padEnd(20)} ${String(inBucket.length).padStart(4)} enqueue → ${bucketSummary.telegramSuccesses} TG成功 / ${bucketSummary.categories.llm_silence} 沉默 / ${bucketSummary.categories.llm_failure} LLM失败 / ${bucketSummary.telegramFailures} TG失败`,
  );
}
console.log();

// 4. LLM 故障期间的 tick 风暴检测
console.log("§4. LLM 故障 tick 风暴检测");
console.log("─────────────────────────────────────────────────────────────");
let stormStart = -1;
let stormLen = 0;
let maxStormLen = 0;
let maxStormStart = -1;
const storms: Array<{ start: number; len: number }> = [];

for (let i = 0; i < enqueueTicks.length; i++) {
  const t = enqueueTicks[i];
  const acts = actionByTick.get(t.tick);
  const isFailed = acts?.some((a) => classifyIausActionRow(a).category === "llm_failure") ?? false;

  if (isFailed) {
    if (stormStart < 0) stormStart = t.tick;
    stormLen++;
  } else {
    if (stormLen >= 3) {
      storms.push({ start: stormStart, len: stormLen });
      if (stormLen > maxStormLen) {
        maxStormLen = stormLen;
        maxStormStart = stormStart;
      }
    }
    stormStart = -1;
    stormLen = 0;
  }
}
if (stormLen >= 3) storms.push({ start: stormStart, len: stormLen });

console.log(`  连续 LLM 失败风暴（≥3 次连续）: ${storms.length} 次`);
for (const s of storms) {
  console.log(`    tick ${s.start} ~ ${s.start + s.len - 1}: ${s.len} 次连续失败`);
}
console.log(`  最长风暴: ${maxStormLen} ticks (从 tick ${maxStormStart})`);
console.log();

// 5. 沉默率 vs 模态
console.log("§5. 按模态分析");
console.log("─────────────────────────────────────────────────────────────");
const modes = ["wakeup", "patrol", "conversation", "consolidation"];
for (const m of modes) {
  const modeTicks = ticks.filter((t) => t.mode === m);
  const modeEnqueue = modeTicks.filter((t) => t.gate_verdict === "enqueue");
  const modeQueueBackpressure = modeTicks.filter((t) =>
    silenceByTick.get(t.tick)?.some((s) => s.reason === "queue_backpressure"),
  );
  const modePostWakeupRecovery = modeTicks.filter((t) =>
    silenceByTick.get(t.tick)?.some((s) => s.reason === "post_wakeup_recovery"),
  );
  if (modeTicks.length === 0) continue;

  const modeSummary = summarizeActions(modeEnqueue.flatMap((t) => actionByTick.get(t.tick) ?? []));

  console.log(
    `  ${m.padEnd(16)} ${modeTicks.length} ticks → ${modeEnqueue.length} enqueue (${pct(modeEnqueue.length, modeTicks.length)}) → ${modeSummary.telegramSuccesses} TG成功 / ${modeSummary.categories.llm_silence} 沉默 / ${modeQueueBackpressure.length} queue_backpressure / ${modePostWakeupRecovery.length} post_wakeup_recovery`,
  );
}
console.log();

// 6. 模拟：如果提高 net_value 阈值会怎样
console.log("§6. 模拟：提高入队 NV 阈值的效果");
console.log("─────────────────────────────────────────────────────────────");
const thresholds = [0.0, 0.3, 0.5, 0.6, 0.7];
for (const threshold of thresholds) {
  const wouldEnqueue = enqueueTicks.filter((t) => (t.net_value ?? 0) >= threshold);
  const simSummary = summarizeActions(wouldEnqueue.flatMap((t) => actionByTick.get(t.tick) ?? []));
  const simTotal =
    simSummary.categories.telegram_success +
    simSummary.categories.telegram_failure +
    simSummary.categories.llm_silence +
    simSummary.categories.llm_failure;
  const efficiency =
    simTotal > 0 ? ((simSummary.categories.telegram_success / simTotal) * 100).toFixed(1) : "N/A";
  console.log(
    `  NV ≥ ${threshold.toFixed(1)}: ${wouldEnqueue.length} enqueue → ${simSummary.telegramSuccesses} TG成功 / ${simSummary.categories.llm_silence} 沉默 / ${simSummary.categories.llm_failure} LLM失败 / ${simSummary.telegramFailures} TG失败 | 效率 ${efficiency}%`,
  );
}
console.log();

// 7. 每 target 的 LLM 调用频率
console.log("§7. Per-target LLM 调用频率（Top 10）");
console.log("─────────────────────────────────────────────────────────────");
const targetCounts = new Map<
  string,
  {
    enqueue: number;
    telegramSuccessRows: number;
    telegramSuccesses: number;
    telegramFailureRows: number;
    telegramFailures: number;
    silence: number;
    llmFailures: number;
  }
>();
for (const t of enqueueTicks) {
  const key = t.target ?? "(no target)";
  const entry = targetCounts.get(key) ?? {
    enqueue: 0,
    telegramSuccessRows: 0,
    telegramSuccesses: 0,
    telegramFailureRows: 0,
    telegramFailures: 0,
    silence: 0,
    llmFailures: 0,
  };
  entry.enqueue++;
  const summary = summarizeActions(actionByTick.get(t.tick) ?? []);
  entry.telegramSuccessRows += summary.categories.telegram_success;
  entry.telegramSuccesses += summary.telegramSuccesses;
  entry.telegramFailureRows += summary.categories.telegram_failure;
  entry.telegramFailures += summary.telegramFailures;
  entry.silence += summary.categories.llm_silence;
  entry.llmFailures += summary.categories.llm_failure;
  targetCounts.set(key, entry);
}

const sortedTargets = [...targetCounts.entries()]
  .sort((a, b) => b[1].enqueue - a[1].enqueue)
  .slice(0, 10);
for (const [target, stats] of sortedTargets) {
  const denominator =
    stats.telegramSuccessRows + stats.telegramFailureRows + stats.silence + stats.llmFailures;
  const eff = denominator > 0 ? pct(stats.telegramSuccessRows, denominator) : "N/A";
  console.log(
    `  ${target.padEnd(30)} ${String(stats.enqueue).padStart(4)} enqueue → ${stats.telegramSuccessRows} TG成功行/${stats.telegramSuccesses} 副作用 / ${stats.telegramFailureRows} TG失败行/${stats.telegramFailures} 副作用 / ${stats.silence} 沉默 / ${stats.llmFailures} LLM失败 (成功行效率 ${eff})`,
  );
}
console.log();

// 8. 时间分布——识别 burst 模式
console.log("§8. Tick 间隔分布");
console.log("─────────────────────────────────────────────────────────────");
const intervals: number[] = [];
for (let i = 1; i < ticks.length; i++) {
  const dt = ticks[i].created_at - ticks[i - 1].created_at;
  if (dt > 0 && dt < 600) intervals.push(dt);
}
const dtBuckets = [
  { label: "< 2s", max: 2 },
  { label: "2-5s", max: 5 },
  { label: "5-10s", max: 10 },
  { label: "10-30s", max: 30 },
  { label: "30-60s", max: 60 },
  { label: "60-300s", max: 300 },
  { label: "> 300s", max: Infinity },
];
for (const b of dtBuckets) {
  const prev = dtBuckets[dtBuckets.indexOf(b) - 1]?.max ?? 0;
  const cnt = intervals.filter((d) => d >= prev && d < b.max).length;
  console.log(`  ${b.label.padEnd(10)} ${String(cnt).padStart(5)} (${pct(cnt, intervals.length)})`);
}
console.log(`  中位数: ${median(intervals).toFixed(1)}s  平均: ${mean(intervals).toFixed(1)}s`);

console.log();
console.log("═══════════════════════════════════════════════════════════════");
console.log("  审计完成");
console.log("═══════════════════════════════════════════════════════════════");

db.close();

// ── 辅助函数 ──────────────────────────────────────────────────────────

function pct(n: number, total: number): string {
  return total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "0%";
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(arr: number[]): number {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function formatCounts(counts: Record<string, number>): string {
  const parts = Object.entries(counts).filter(([, count]) => count > 0);
  if (parts.length === 0) return "none";
  return parts.map(([key, count]) => `${key}:${count}`).join(", ");
}

type CategoryCounts = Record<IausActionCategory, number>;

interface ActionSummary {
  totalRows: number;
  categories: CategoryCounts;
  telegramSuccesses: number;
  telegramFailures: number;
  successEffects: IausTelegramEffectCounts;
  failureEffects: IausTelegramEffectCounts;
}

function summarizeActions(rows: ActionRow[]): ActionSummary {
  const categories: CategoryCounts = {
    telegram_success: 0,
    telegram_failure: 0,
    llm_silence: 0,
    llm_failure: 0,
    observe_only: 0,
    internal_action: 0,
  };
  const successEffects = emptyEffectCounts();
  const failureEffects = emptyEffectCounts();
  let telegramSuccesses = 0;
  let telegramFailures = 0;

  for (const row of rows) {
    const classified = classifyIausActionRow(row);
    categories[classified.category]++;
    telegramSuccesses += classified.telegramSuccesses;
    telegramFailures += classified.telegramFailures;
    mergeEffectCounts(successEffects, classified.successEffects);
    mergeEffectCounts(failureEffects, classified.failureEffects);
  }

  return {
    totalRows: rows.length,
    categories,
    telegramSuccesses,
    telegramFailures,
    successEffects,
    failureEffects,
  };
}

function mergeEffectCounts(
  target: IausTelegramEffectCounts,
  source: IausTelegramEffectCounts,
): void {
  for (const effect of Object.keys(target) as Array<keyof IausTelegramEffectCounts>) {
    target[effect] += source[effect];
  }
}

function formatEffectCounts(counts: IausTelegramEffectCounts): string {
  const parts = Object.entries(counts).filter(([, count]) => count > 0);
  if (parts.length === 0) return "none";
  return parts.map(([effect, count]) => `${effect}:${count}`).join(", ");
}

function parseDecisionTracePayload(payloadJson: string): {
  values?: Record<string, unknown>;
} | null {
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as { values?: Record<string, unknown> };
  } catch {
    return null;
  }
}
