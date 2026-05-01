#!/usr/bin/env tsx
/**
 * ADR-261 Wave 3: audit IAUS timing shadow diagnostics.
 *
 * 只读 candidate_trace，统计 rhythm timing shadow 如果启用会不会改变 winner。
 * 这个脚本不参与 runtime 决策。
 *
 * Usage:
 *   cd runtime && pnpm tsx scripts/timing-shadow-audit.ts
 *   cd runtime && pnpm tsx scripts/timing-shadow-audit.ts --limit 20
 *
 * @see docs/adr/261-rhythm-profile-projection.md
 */

import { resolve } from "node:path";
import Database from "better-sqlite3";

interface Args {
  dbPath: string;
  limit: number;
}

interface CandidateTraceRow {
  tick: number;
  candidate_id: string;
  target_namespace: string;
  target_id: string | null;
  action_type: string;
  selected: number;
  net_value: number | null;
  normalized_considerations_json: string;
}

interface TimingShadow {
  utility: number;
  applied: boolean;
  reason: string;
  netValue?: number;
  shadowNetValue?: number;
}

const args = parseArgs(process.argv.slice(2));
const db = new Database(args.dbPath, { readonly: true });

const rows = db
  .prepare(
    `SELECT tick, candidate_id, target_namespace, target_id, action_type, selected,
            net_value, normalized_considerations_json
     FROM candidate_trace
     WHERE json_type(normalized_considerations_json, '$.__diagnostics.timingShadow') IS NOT NULL
     ORDER BY tick ASC, candidate_rank ASC, id ASC`,
  )
  .all() as CandidateTraceRow[];

const parsed = rows
  .map((row) => ({ row, timing: readTimingShadow(row.normalized_considerations_json) }))
  .filter((item): item is { row: CandidateTraceRow; timing: TimingShadow } => item.timing != null);

const reasons = new Map<string, number>();
let applied = 0;
let bypassViolations = 0;
for (const item of parsed) {
  const reason = item.timing.reason;
  reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  if (item.timing.applied) applied++;
  if (
    reason === "bypass" &&
    (item.timing.utility !== 1 || !nearlyEqual(shadowScore(item), originalScore(item)))
  ) {
    bypassViolations++;
  }
}

const pools = new Map<number, typeof parsed>();
for (const item of parsed) {
  const pool = pools.get(item.row.tick) ?? [];
  pool.push(item);
  pools.set(item.row.tick, pool);
}

let analyzableTicks = 0;
let changedTop = 0;
const examples: string[] = [];
for (const [tick, pool] of pools) {
  const scored = pool.filter((item) => originalScore(item) != null);
  if (scored.length === 0) continue;
  analyzableTicks++;

  const original = maxBy(scored, (item) => originalScore(item) ?? Number.NEGATIVE_INFINITY);
  const shadow = maxBy(scored, (item) => shadowScore(item) ?? Number.NEGATIVE_INFINITY);
  if (!original || !shadow) continue;
  if (original.row.candidate_id !== shadow.row.candidate_id) {
    changedTop++;
    if (examples.length < args.limit) {
      examples.push(`tick=${tick} original=${summarize(original)} shadow=${summarize(shadow)}`);
    }
  }
}

console.log(`rows=${parsed.length} ticks=${pools.size} analyzable_ticks=${analyzableTicks}`);
console.log(`applied=${applied} bypass_violations=${bypassViolations}`);
console.log(
  `shadow_changed_top=${changedTop} rate=${analyzableTicks > 0 ? (changedTop / analyzableTicks).toFixed(4) : "0.0000"}`,
);
console.log(
  `reasons=${[...reasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `${key}:${count}`)
    .join(", ")}`,
);
if (examples.length > 0) {
  console.log("examples:");
  for (const example of examples) console.log(`- ${example}`);
}

function readTimingShadow(raw: string): TimingShadow | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const diagnostics = parsed.__diagnostics;
    if (!isRecord(diagnostics)) return null;
    const timing = diagnostics.timingShadow;
    if (!isRecord(timing)) return null;
    if (typeof timing.utility !== "number" || !Number.isFinite(timing.utility)) return null;
    if (typeof timing.applied !== "boolean") return null;
    if (typeof timing.reason !== "string" || timing.reason.length === 0) return null;
    return {
      utility: timing.utility,
      applied: timing.applied,
      reason: timing.reason,
      netValue: finiteOptional(timing.netValue),
      shadowNetValue: finiteOptional(timing.shadowNetValue),
    };
  } catch {
    return null;
  }
}

function summarize(item: { row: CandidateTraceRow; timing: TimingShadow }): string {
  const target = item.row.target_id
    ? `${item.row.target_namespace}:${item.row.target_id}`
    : item.row.target_namespace;
  const score = originalScore(item)?.toFixed(4) ?? "null";
  const shadow = shadowScore(item)?.toFixed(4) ?? score;
  return `${item.row.action_type}/${target} V=${score} shadow=${shadow} reason=${item.timing.reason}`;
}

function originalScore(item: { row: CandidateTraceRow; timing: TimingShadow }): number | null {
  return item.timing.netValue ?? item.row.net_value;
}

function shadowScore(item: { row: CandidateTraceRow; timing: TimingShadow }): number | null {
  return item.timing.shadowNetValue ?? originalScore(item);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object";
}

function finiteOptional(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function maxBy<T>(items: readonly T[], score: (item: T) => number): T | null {
  let best: T | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const value = score(item);
    if (value > bestScore) {
      best = item;
      bestScore = value;
    }
  }
  return best;
}

function nearlyEqual(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(a - b) < 1e-9;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dbPath: resolve(import.meta.dirname ?? ".", "../alice.db"),
    limit: 10,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--db" && next) {
      args.dbPath = resolve(process.cwd(), next);
      i++;
    } else if (arg === "--limit" && next) {
      args.limit = Number(next);
      i++;
    }
  }
  return args;
}
