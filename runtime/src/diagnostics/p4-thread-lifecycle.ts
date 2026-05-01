import type Database from "better-sqlite3";
import { hasEffectiveThreadInvolvement } from "../graph/thread-involvement.js";

const DEFAULT_THREAD_AGE_SCALE_S = 86_400;
const THREAD_EXPIRY_S = 7 * 86_400;
const ORPHAN_CONVERSATION_EXPIRY_S = 4 * 60 * 60;

type Sqlite = InstanceType<typeof Database>;

type GraphThreadStatus = "open" | "resolved" | "expired" | string;
type P4ThreadClass =
  | "still_valid"
  | "legacy_auto_topic_needs_expiry"
  | "orphan_conversation_needs_expiry"
  | "overdue_open"
  | "resolved_but_not_closed"
  | "expired_stale"
  | "invalid_phantom"
  | "not_p4_open";

interface GraphThreadRow {
  id: string;
  updated_tick: number;
  attrs: string;
}

interface NarrativeThreadRow {
  id: number;
  title: string;
  status: string;
  weight: string;
  source: string | null;
  created_tick: number;
  last_beat_tick: number | null;
  resolved_tick: number | null;
  horizon: number | null;
  deadline_tick: number | null;
  involves: string | null;
}

interface GraphThreadAttrs {
  status?: GraphThreadStatus;
  title?: string;
  weight?: string;
  w?: number;
  source?: string;
  source_channel?: string;
  created_ms?: number;
  last_activity_ms?: number;
  deadline?: number;
  deadline_ms?: number;
}

export interface P4ThreadLifecycleItem {
  nodeId: string;
  dbId: number | null;
  title: string;
  graphStatus: string | null;
  narrativeStatus: string | null;
  source: string | null;
  sourceChannel: string | null;
  weight: string | null;
  w: number;
  createdMs: number | null;
  lastActivityMs: number | null;
  deadlineMs: number | null;
  ageS: number | null;
  idleS: number | null;
  overdueS: number | null;
  p4Contribution: number;
  classification: P4ThreadClass;
  reasons: string[];
}

export interface P4ThreadLifecycleReport {
  nowMs: number;
  graphThreadCount: number;
  narrativeThreadCount: number;
  graphOpenCount: number;
  narrativeOpenCount: number;
  p4Total: number;
  counts: Record<P4ThreadClass, number>;
  lifecycleOutcomeCounts: Record<string, number>;
  items: P4ThreadLifecycleItem[];
}

function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function dbIdFromNodeId(nodeId: string): number | null {
  const match = /^thread_(\d+)$/.exec(nodeId);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isInteger(id) ? id : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function computeP4Contribution(
  nowMs: number,
  createdMs: number | null,
  w: number,
  threadAgeScaleS: number,
): { contribution: number; ageS: number | null } {
  if (createdMs == null || createdMs <= 0) return { contribution: 0, ageS: null };
  const ageS = Math.max((nowMs - createdMs) / 1000, 1);
  const maxAgeS = threadAgeScaleS * 7;
  const decayFactor = ageS > maxAgeS ? Math.exp(-(ageS - maxAgeS) / maxAgeS) : 1;
  return {
    ageS,
    contribution: Math.log(1 + ageS / threadAgeScaleS) * w * decayFactor,
  };
}

function classifyGraphThread(input: {
  graphStatus: string | null;
  narrativeStatus: string | null;
  source: string | null;
  hasEffectiveInvolvement: boolean;
  hasNarrative: boolean;
  hasNarrativeDeadline: boolean;
  hasGraphDeadline: boolean;
  hasNarrativeBeats: boolean;
  createdMs: number | null;
  idleS: number | null;
  overdueS: number | null;
}): { classification: P4ThreadClass; reasons: string[] } {
  const reasons: string[] = [];

  if (input.graphStatus !== "open") {
    reasons.push("graph_status_not_open");
    return { classification: "not_p4_open", reasons };
  }
  if (!input.hasNarrative) {
    reasons.push("graph_thread_missing_narrative_row");
    return { classification: "invalid_phantom", reasons };
  }
  if (input.narrativeStatus === "resolved") {
    reasons.push("narrative_resolved_but_graph_open");
    return { classification: "resolved_but_not_closed", reasons };
  }
  if (input.createdMs == null || input.createdMs <= 0) {
    reasons.push("missing_created_ms");
    return { classification: "invalid_phantom", reasons };
  }
  if (
    input.source === "auto" &&
    !input.hasEffectiveInvolvement &&
    input.overdueS == null &&
    (input.idleS ?? 0) > 12 * 60 * 60
  ) {
    reasons.push("legacy_auto_topic_without_deadline");
    reasons.push("empty_structured_involvement");
    reasons.push("idle_over_12h");
    return { classification: "legacy_auto_topic_needs_expiry", reasons };
  }
  if (
    input.source === "conversation" &&
    !input.hasEffectiveInvolvement &&
    !input.hasNarrativeDeadline &&
    !input.hasGraphDeadline &&
    !input.hasNarrativeBeats &&
    input.overdueS == null &&
    (input.idleS ?? 0) > ORPHAN_CONVERSATION_EXPIRY_S
  ) {
    reasons.push("orphan_conversation_without_deadline_involvement_or_beats");
    reasons.push("empty_structured_involvement");
    reasons.push("idle_over_4h");
    return { classification: "orphan_conversation_needs_expiry", reasons };
  }
  if ((input.idleS ?? 0) > THREAD_EXPIRY_S) {
    reasons.push("idle_over_7d_but_still_open");
    return { classification: "expired_stale", reasons };
  }
  if ((input.overdueS ?? 0) > 0) {
    reasons.push("deadline_passed_but_still_open");
    return { classification: "overdue_open", reasons };
  }

  reasons.push("open_and_not_overdue");
  return { classification: "still_valid", reasons };
}

function makeGraphItem(
  row: GraphThreadRow,
  narrativeById: Map<number, NarrativeThreadRow>,
  beatCountsByThreadId: ReadonlyMap<number, number>,
  nowMs: number,
  threadAgeScaleS: number,
): P4ThreadLifecycleItem {
  const attrs = parseJson<GraphThreadAttrs>(row.attrs) ?? {};
  const dbId = dbIdFromNodeId(row.id);
  const narrative = dbId == null ? undefined : narrativeById.get(dbId);
  const createdMs = finiteNumber(attrs.created_ms);
  const lastActivityMs = finiteNumber(attrs.last_activity_ms) ?? createdMs;
  const deadline = finiteNumber(attrs.deadline);
  const deadlineMs = finiteNumber(attrs.deadline_ms);
  const graphStatus = attrs.status ?? null;
  const w = finiteNumber(attrs.w) ?? 0;
  const { contribution, ageS } =
    graphStatus === "open"
      ? computeP4Contribution(nowMs, createdMs, w, threadAgeScaleS)
      : {
          contribution: 0,
          ageS: createdMs == null ? null : Math.max((nowMs - createdMs) / 1000, 1),
        };
  const idleS = lastActivityMs == null ? null : Math.max((nowMs - lastActivityMs) / 1000, 0);
  const overdueS = deadlineMs == null ? null : Math.max((nowMs - deadlineMs) / 1000, 0);
  const { classification, reasons } = classifyGraphThread({
    graphStatus,
    narrativeStatus: narrative?.status ?? null,
    source: attrs.source ?? narrative?.source ?? null,
    hasEffectiveInvolvement: hasEffectiveThreadInvolvement(narrative?.involves ?? null),
    hasNarrative: Boolean(narrative),
    hasNarrativeDeadline: narrative?.horizon != null || narrative?.deadline_tick != null,
    hasGraphDeadline: deadline != null,
    hasNarrativeBeats: dbId != null && (beatCountsByThreadId.get(dbId) ?? 0) > 0,
    createdMs,
    idleS,
    overdueS,
  });

  return {
    nodeId: row.id,
    dbId,
    title: String(attrs.title ?? narrative?.title ?? row.id),
    graphStatus,
    narrativeStatus: narrative?.status ?? null,
    source: attrs.source ?? narrative?.source ?? null,
    sourceChannel: attrs.source_channel ?? null,
    weight: attrs.weight ?? narrative?.weight ?? null,
    w,
    createdMs,
    lastActivityMs,
    deadlineMs,
    ageS,
    idleS,
    overdueS,
    p4Contribution: contribution,
    classification,
    reasons,
  };
}

function makeNarrativeOnlyItem(row: NarrativeThreadRow): P4ThreadLifecycleItem {
  return {
    nodeId: `thread_${row.id}`,
    dbId: row.id,
    title: row.title,
    graphStatus: null,
    narrativeStatus: row.status,
    source: row.source,
    sourceChannel: null,
    weight: row.weight,
    w: 0,
    createdMs: null,
    lastActivityMs: null,
    deadlineMs: null,
    ageS: null,
    idleS: null,
    overdueS: null,
    p4Contribution: 0,
    classification: "invalid_phantom",
    reasons: ["narrative_open_missing_graph_node"],
  };
}

function emptyCounts(): Record<P4ThreadClass, number> {
  return {
    still_valid: 0,
    legacy_auto_topic_needs_expiry: 0,
    overdue_open: 0,
    resolved_but_not_closed: 0,
    expired_stale: 0,
    invalid_phantom: 0,
    not_p4_open: 0,
    orphan_conversation_needs_expiry: 0,
  };
}

function listBeatCounts(sqlite: Sqlite): Map<number, number> {
  if (!tableExists(sqlite, "narrative_beats")) return new Map();
  const rows = sqlite
    .prepare("SELECT thread_id, count(*) AS count FROM narrative_beats GROUP BY thread_id")
    .all() as Array<{ thread_id: number; count: number }>;
  return new Map(rows.map((row) => [row.thread_id, row.count]));
}

export function analyzeP4ThreadLifecycle(
  sqlite: Sqlite,
  options: { nowMs?: number; threadAgeScaleS?: number } = {},
): P4ThreadLifecycleReport {
  const nowMs = options.nowMs ?? Date.now();
  const threadAgeScaleS = options.threadAgeScaleS ?? DEFAULT_THREAD_AGE_SCALE_S;
  const graphRows = sqlite
    .prepare("SELECT id, updated_tick, attrs FROM graph_nodes WHERE entity_type = 'thread'")
    .all() as GraphThreadRow[];
  const narrativeRows = sqlite
    .prepare(
      `SELECT id, title, status, weight, source, created_tick, last_beat_tick,
              resolved_tick, horizon, deadline_tick, involves
       FROM narrative_threads`,
    )
    .all() as NarrativeThreadRow[];
  const lifecycleOutcomeCounts = tableExists(sqlite, "thread_lifecycle_event")
    ? Object.fromEntries(
        (
          sqlite
            .prepare(
              "SELECT outcome, count(*) AS count FROM thread_lifecycle_event GROUP BY outcome",
            )
            .all() as Array<{ outcome: string; count: number }>
        ).map((row) => [row.outcome, row.count]),
      )
    : {};

  const narrativeById = new Map(narrativeRows.map((row) => [row.id, row]));
  const beatCountsByThreadId = listBeatCounts(sqlite);
  const graphDbIds = new Set<number>();
  const items = graphRows.map((row) => {
    const dbId = dbIdFromNodeId(row.id);
    if (dbId != null) graphDbIds.add(dbId);
    return makeGraphItem(row, narrativeById, beatCountsByThreadId, nowMs, threadAgeScaleS);
  });

  for (const row of narrativeRows) {
    if (row.status === "open" && !graphDbIds.has(row.id)) {
      items.push(makeNarrativeOnlyItem(row));
    }
  }

  const counts = emptyCounts();
  for (const item of items) counts[item.classification]++;

  const graphOpenItems = items.filter((item) => item.graphStatus === "open");
  return {
    nowMs,
    graphThreadCount: graphRows.length,
    narrativeThreadCount: narrativeRows.length,
    graphOpenCount: graphOpenItems.length,
    narrativeOpenCount: narrativeRows.filter((row) => row.status === "open").length,
    p4Total: graphOpenItems.reduce((sum, item) => sum + item.p4Contribution, 0),
    counts,
    lifecycleOutcomeCounts,
    items: items.sort((a, b) => b.p4Contribution - a.p4Contribution),
  };
}

function tableExists(sqlite: Sqlite, tableName: string): boolean {
  const row = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name: string } | undefined;
  return Boolean(row);
}

function formatDuration(seconds: number | null): string {
  if (seconds == null) return "unknown";
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86_400).toFixed(1)}d`;
}

export function renderP4ThreadLifecycleReport(
  report: P4ThreadLifecycleReport,
  options: { limit?: number } = {},
): string {
  const limit = options.limit ?? 12;
  const lines: string[] = [];
  lines.push("── A4c: P4 thread lifecycle audit ──");
  lines.push(
    `graph threads=${report.graphThreadCount}, graph open=${report.graphOpenCount}, narrative open=${report.narrativeOpenCount}, P4 total=${report.p4Total.toFixed(3)}`,
  );
  lines.push(
    `classes: still_valid=${report.counts.still_valid}, legacy_auto_topic_needs_expiry=${report.counts.legacy_auto_topic_needs_expiry}, orphan_conversation_needs_expiry=${report.counts.orphan_conversation_needs_expiry}, overdue_open=${report.counts.overdue_open}, resolved_but_not_closed=${report.counts.resolved_but_not_closed}, expired_stale=${report.counts.expired_stale}, invalid_phantom=${report.counts.invalid_phantom}`,
  );
  lines.push(`lifecycle outcomes: ${formatCounts(report.lifecycleOutcomeCounts)}`);
  lines.push("top P4 contributors:");

  const top = report.items
    .filter((item) => item.graphStatus === "open" || item.classification === "invalid_phantom")
    .slice(0, limit);
  if (top.length === 0) {
    lines.push("  none");
    return lines.join("\n");
  }

  for (const item of top) {
    lines.push(
      `  ${item.nodeId.padEnd(10)} ${item.classification.padEnd(23)} P4=${item.p4Contribution.toFixed(3)} idle=${formatDuration(item.idleS)} overdue=${formatDuration(item.overdueS)} title=${item.title}`,
    );
    lines.push(`    reason=${item.reasons.join(",")} source=${item.source ?? "unknown"}`);
  }

  return lines.join("\n");
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).filter(([, count]) => count > 0);
  if (entries.length === 0) return "none";
  return entries.map(([key, count]) => `${key}:${count}`).join(", ");
}
