/**
 * ADR-262 Wave 4B: social case pressure vs thread contrast diagnostics.
 *
 * Shadow only. This module compares two existing read surfaces and must not
 * feed IAUS, target-control, prompt injection, or action selection.
 *
 * @see docs/adr/262-social-case-management/README.md
 */
import { getSqlite } from "../db/connection.js";
import { parseThreadInvolvementNodeIds } from "../graph/thread-involvement.js";
import type { SocialCasePressureShadow } from "./social-case.js";
import { analyzeSocialCases } from "./social-case.js";

type ThreadStatusClass = "open" | "closed" | "unknown";

const DEFAULT_STALE_THREAD_TICK_THRESHOLD = 2_000;
const DEFAULT_ORPHAN_CONVERSATION_IDLE_MS = 4 * 60 * 60 * 1000;

export type SocialCaseThreadContrastClass =
  | "case_with_open_thread"
  | "case_without_thread"
  | "case_closed_thread_open"
  | "thread_closed_but_case_open"
  | "thread_without_case";

export type ThreadWithoutCaseSampleClass =
  | "topic_cluster"
  | "wait_thread_candidate"
  | "stale_lifecycle_debt"
  | "orphan_conversation_lifecycle_debt"
  | "missing_social_event_candidate"
  | "unknown";

export type SocialCaseAttentionSurfaceClass =
  | "open_case_missing_attention_surface"
  | "open_case_closed_attention_surface"
  | "closed_case_open_attention_surface"
  | "closed_case_stale_attention_surface"
  | "orphan_stale_attention_surface";

export interface SocialCaseThreadContrastOptions {
  limit?: number;
  json?: boolean;
  selfIds?: readonly string[];
  staleThreadTickThreshold?: number;
}

export interface SocialCaseThreadRow {
  id: number;
  title: string;
  status: string;
  weight: string;
  source: string | null;
  createdTick: number;
  lastBeatTick: number | null;
  resolvedTick: number | null;
  horizon: number | null;
  deadlineTick: number | null;
  involves: readonly string[];
}

export interface SocialCaseThreadContrastItem {
  classification: SocialCaseThreadContrastClass;
  caseId: string | null;
  threadId: number | null;
  pressure: number | null;
  caseOpen: boolean | null;
  threadStatus: string | null;
  reason: string;
  pair: readonly [string, string] | null;
  threadTitle: string | null;
}

export interface ThreadWithoutCaseSample {
  threadId: number;
  title: string;
  status: string;
  weight: string;
  source: string | null;
  createdTick: number;
  lastBeatTick: number | null;
  resolvedTick: number | null;
  horizon: number | null;
  deadlineTick: number | null;
  involves: readonly string[];
  beatCount: number;
  lastBeatTickObserved: number | null;
  activityTick: number;
  tickAge: number | null;
  deadlineDelta: number | null;
  graphIdleMs: number | null;
  graphIdleThresholdMs: number | null;
  classification: ThreadWithoutCaseSampleClass;
  reasons: readonly string[];
}

export interface SocialCaseAttentionSurfaceShadow {
  classification: SocialCaseAttentionSurfaceClass;
  caseId: string | null;
  threadId: number | null;
  caseOpen: boolean | null;
  pressure: number | null;
  pair: readonly [string, string] | null;
  threadStatus: string | null;
  threadSource: string | null;
  threadTitle: string | null;
  threadActivityTick: number | null;
  threadTickAge: number | null;
  reason: string;
}

export interface SocialCaseThreadContrastReport {
  socialCaseCount: number;
  openSocialCaseCount: number;
  pressureShadowCount: number;
  narrativeThreadCount: number;
  openNarrativeThreadCount: number;
  currentTick: number | null;
  staleThreadTickThreshold: number;
  counts: Record<SocialCaseThreadContrastClass, number>;
  threadWithoutCaseSampleCounts: Record<ThreadWithoutCaseSampleClass, number>;
  attentionSurfaceCounts: Record<SocialCaseAttentionSurfaceClass, number>;
  controlGate: {
    status: "shadow_only";
    killCriteria: readonly string[];
  };
  items: readonly SocialCaseThreadContrastItem[];
  threadWithoutCaseSamples: readonly ThreadWithoutCaseSample[];
  attentionSurfaceShadows: readonly SocialCaseAttentionSurfaceShadow[];
}

interface NarrativeThreadSqlRow {
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

interface NarrativeBeatStats {
  thread_id: number;
  beat_count: number;
  last_beat_tick: number | null;
}

interface GraphThreadSqlRow {
  id: string;
  attrs: string;
}

interface GraphThreadStats {
  id: number;
  status: string | null;
  source: string | null;
  createdMs: number | null;
  lastActivityMs: number | null;
  deadline: number | null;
  deadlineMs: number | null;
}

interface GraphThreadAttrs {
  status?: unknown;
  source?: unknown;
  created_ms?: unknown;
  last_activity_ms?: unknown;
  deadline?: unknown;
  deadline_ms?: unknown;
}

const DEFAULT_SELF_IDS = new Set(["alice", "self"]);

function tableExists(tableName: string): boolean {
  const row = getSqlite()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name: string } | undefined;
  return row != null;
}

function listNarrativeThreads(): SocialCaseThreadRow[] {
  if (!tableExists("narrative_threads")) return [];
  return (
    getSqlite()
      .prepare(
        `SELECT id, title, status, weight, source, created_tick, last_beat_tick,
                resolved_tick, horizon, deadline_tick, involves
         FROM narrative_threads
         ORDER BY id`,
      )
      .all() as NarrativeThreadSqlRow[]
  ).map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    weight: row.weight,
    source: row.source,
    createdTick: row.created_tick,
    lastBeatTick: row.last_beat_tick,
    resolvedTick: row.resolved_tick,
    horizon: row.horizon,
    deadlineTick: row.deadline_tick,
    involves: parseThreadInvolvementNodeIds(row.involves),
  }));
}

function listBeatStats(): Map<number, NarrativeBeatStats> {
  if (!tableExists("narrative_beats")) return new Map();
  const rows = getSqlite()
    .prepare(
      `SELECT thread_id, count(*) AS beat_count, max(tick) AS last_beat_tick
       FROM narrative_beats
       GROUP BY thread_id`,
    )
    .all() as NarrativeBeatStats[];
  return new Map(rows.map((row) => [row.thread_id, row]));
}

function listGraphThreadStats(): Map<number, GraphThreadStats> {
  if (!tableExists("graph_nodes")) return new Map();
  const rows = getSqlite()
    .prepare("SELECT id, attrs FROM graph_nodes WHERE entity_type = 'thread'")
    .all() as GraphThreadSqlRow[];
  const stats = new Map<number, GraphThreadStats>();
  for (const row of rows) {
    const threadId = threadIdFromGraphNodeId(row.id);
    if (threadId == null) continue;
    const attrs = parseJson<GraphThreadAttrs>(row.attrs) ?? {};
    stats.set(threadId, {
      id: threadId,
      status: typeof attrs.status === "string" ? attrs.status : null,
      source: typeof attrs.source === "string" ? attrs.source : null,
      createdMs: finiteNumber(attrs.created_ms),
      lastActivityMs: finiteNumber(attrs.last_activity_ms),
      deadline: finiteNumber(attrs.deadline),
      deadlineMs: finiteNumber(attrs.deadline_ms),
    });
  }
  return stats;
}

function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function threadIdFromGraphNodeId(nodeId: string): number | null {
  const match = /^thread_(\d+)$/.exec(nodeId);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isInteger(id) ? id : null;
}

function maxTickFrom(tableName: "tick_log" | "action_log" | "message_log"): number | null {
  if (!tableExists(tableName)) return null;
  try {
    const row = getSqlite().prepare(`SELECT max(tick) AS tick FROM ${tableName}`).get() as
      | { tick: number | null }
      | undefined;
    return finiteInteger(row?.tick);
  } catch {
    return null;
  }
}

function finiteInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function maxNullable(values: readonly (number | null | undefined)[]): number | null {
  const finite = values.filter((value): value is number => Number.isFinite(value));
  if (finite.length === 0) return null;
  return Math.max(...finite);
}

function detectCurrentTick(threads: readonly SocialCaseThreadRow[]): number | null {
  return maxNullable([
    maxTickFrom("tick_log"),
    maxTickFrom("action_log"),
    maxTickFrom("message_log"),
    ...threads.map((thread) => thread.createdTick),
    ...threads.map((thread) => thread.lastBeatTick),
  ]);
}

function statusClass(status: string): ThreadStatusClass {
  if (status === "open" || status === "active") return "open";
  if (status === "resolved" || status === "abandoned" || status === "expired") return "closed";
  return "unknown";
}

function caseMatchKeys(
  shadow: SocialCasePressureShadow,
  selfIds: ReadonlySet<string>,
): readonly string[] {
  const nonSelf = shadow.pair.filter((id) => !selfIds.has(id));
  return nonSelf.length > 0 ? nonSelf : [...shadow.pair];
}

function matchesCase(
  shadow: SocialCasePressureShadow,
  thread: SocialCaseThreadRow,
  selfIds: ReadonlySet<string>,
): boolean {
  const keys = caseMatchKeys(shadow, selfIds);
  return keys.some((id) => thread.involves.includes(id));
}

function emptyCounts(): Record<SocialCaseThreadContrastClass, number> {
  return {
    case_with_open_thread: 0,
    case_without_thread: 0,
    case_closed_thread_open: 0,
    thread_closed_but_case_open: 0,
    thread_without_case: 0,
  };
}

function emptySampleCounts(): Record<ThreadWithoutCaseSampleClass, number> {
  return {
    topic_cluster: 0,
    wait_thread_candidate: 0,
    stale_lifecycle_debt: 0,
    orphan_conversation_lifecycle_debt: 0,
    missing_social_event_candidate: 0,
    unknown: 0,
  };
}

function emptyAttentionSurfaceCounts(): Record<SocialCaseAttentionSurfaceClass, number> {
  return {
    open_case_missing_attention_surface: 0,
    open_case_closed_attention_surface: 0,
    closed_case_open_attention_surface: 0,
    closed_case_stale_attention_surface: 0,
    orphan_stale_attention_surface: 0,
  };
}

function involvementKind(nodeId: string): string {
  return nodeId.split(":", 1)[0] ?? "";
}

function hasPersonLikeInvolvement(thread: SocialCaseThreadRow): boolean {
  return thread.involves.some((nodeId) =>
    ["contact", "person", "user", "member"].includes(involvementKind(nodeId)),
  );
}

function classifyThreadWithoutCaseSample(input: {
  thread: SocialCaseThreadRow;
  beatCount: number;
  tickAge: number | null;
  deadlineDelta: number | null;
  graphStats: GraphThreadStats | undefined;
  nowMs: number;
  staleThreadTickThreshold: number;
}): { classification: ThreadWithoutCaseSampleClass; reasons: string[] } {
  const { thread, beatCount, tickAge, deadlineDelta, graphStats, nowMs, staleThreadTickThreshold } =
    input;
  const reasons = ["open_thread_has_no_social_case_relation_match"];
  if (thread.involves.length === 0) reasons.push("empty_structured_involves");
  if (beatCount === 0) reasons.push("no_narrative_beats");
  const lastActivityMs = graphStats?.lastActivityMs ?? graphStats?.createdMs ?? null;
  const graphIdleMs = lastActivityMs == null ? null : Math.max(nowMs - lastActivityMs, 0);

  if (thread.source === "conversation" && thread.horizon != null && thread.deadlineTick != null) {
    reasons.push("conversation_thread_has_horizon_and_deadline");
    if (deadlineDelta != null) reasons.push(`deadline_delta_ticks=${deadlineDelta}`);
    return { classification: "wait_thread_candidate", reasons };
  }

  if (
    thread.source === "conversation" &&
    thread.horizon == null &&
    thread.deadlineTick == null &&
    thread.involves.length === 0 &&
    beatCount === 0 &&
    graphStats?.status === "open" &&
    graphStats.source === "conversation" &&
    graphStats.deadline == null &&
    graphStats.deadlineMs == null &&
    graphIdleMs != null &&
    graphIdleMs > DEFAULT_ORPHAN_CONVERSATION_IDLE_MS
  ) {
    reasons.push("conversation_thread_without_deadline_involves_or_beats");
    reasons.push(`graph_idle_ms=${Math.round(graphIdleMs)}`);
    reasons.push(`idle_threshold_ms=${DEFAULT_ORPHAN_CONVERSATION_IDLE_MS}`);
    return { classification: "orphan_conversation_lifecycle_debt", reasons };
  }

  if (tickAge != null && tickAge > staleThreadTickThreshold) {
    reasons.push(`activity_age_ticks=${tickAge}`);
    reasons.push(`stale_threshold_ticks=${staleThreadTickThreshold}`);
    return { classification: "stale_lifecycle_debt", reasons };
  }

  if (thread.source === "auto" && thread.involves.length === 0) {
    reasons.push("auto_source_without_structured_involvement");
    return { classification: "topic_cluster", reasons };
  }

  if (hasPersonLikeInvolvement(thread)) {
    reasons.push("structured_person_like_involvement_without_social_case");
    return { classification: "missing_social_event_candidate", reasons };
  }

  reasons.push("insufficient_structured_evidence_for_social_case");
  return { classification: "unknown", reasons };
}

function computeThreadActivity(input: {
  thread: SocialCaseThreadRow;
  beatStats: NarrativeBeatStats | undefined;
  currentTick: number | null;
}): {
  beatCount: number;
  lastBeatTickObserved: number | null;
  activityTick: number;
  tickAge: number | null;
  deadlineDelta: number | null;
} {
  const observedLastBeatTick = input.beatStats?.last_beat_tick ?? null;
  const beatCount = input.beatStats?.beat_count ?? 0;
  const activityTick = Math.max(
    input.thread.createdTick,
    input.thread.lastBeatTick ?? input.thread.createdTick,
    observedLastBeatTick ?? input.thread.createdTick,
  );
  const tickAge = input.currentTick == null ? null : Math.max(input.currentTick - activityTick, 0);
  const deadlineDelta =
    input.currentTick == null || input.thread.deadlineTick == null
      ? null
      : input.thread.deadlineTick - input.currentTick;

  return {
    beatCount,
    lastBeatTickObserved: observedLastBeatTick,
    activityTick,
    tickAge,
    deadlineDelta,
  };
}

function buildThreadWithoutCaseSample(input: {
  thread: SocialCaseThreadRow;
  beatStats: NarrativeBeatStats | undefined;
  graphStats: GraphThreadStats | undefined;
  currentTick: number | null;
  nowMs: number;
  staleThreadTickThreshold: number;
}): ThreadWithoutCaseSample {
  const activity = computeThreadActivity({
    thread: input.thread,
    beatStats: input.beatStats,
    currentTick: input.currentTick,
  });
  const { classification, reasons } = classifyThreadWithoutCaseSample({
    thread: input.thread,
    beatCount: activity.beatCount,
    tickAge: activity.tickAge,
    deadlineDelta: activity.deadlineDelta,
    graphStats: input.graphStats,
    nowMs: input.nowMs,
    staleThreadTickThreshold: input.staleThreadTickThreshold,
  });
  const graphActivityMs = input.graphStats?.lastActivityMs ?? input.graphStats?.createdMs ?? null;
  const graphIdleMs = graphActivityMs == null ? null : Math.max(input.nowMs - graphActivityMs, 0);

  return {
    threadId: input.thread.id,
    title: input.thread.title,
    status: input.thread.status,
    weight: input.thread.weight,
    source: input.thread.source,
    createdTick: input.thread.createdTick,
    lastBeatTick: input.thread.lastBeatTick,
    resolvedTick: input.thread.resolvedTick,
    horizon: input.thread.horizon,
    deadlineTick: input.thread.deadlineTick,
    involves: input.thread.involves,
    beatCount: activity.beatCount,
    lastBeatTickObserved: activity.lastBeatTickObserved,
    activityTick: activity.activityTick,
    tickAge: activity.tickAge,
    deadlineDelta: activity.deadlineDelta,
    graphIdleMs,
    graphIdleThresholdMs: DEFAULT_ORPHAN_CONVERSATION_IDLE_MS,
    classification,
    reasons,
  };
}

function buildThreadWithoutCaseSamples(input: {
  threads: readonly SocialCaseThreadRow[];
  beatStats?: ReadonlyMap<number, NarrativeBeatStats>;
  graphStats?: ReadonlyMap<number, GraphThreadStats>;
  currentTick: number | null;
  nowMs: number;
  staleThreadTickThreshold: number;
}): ThreadWithoutCaseSample[] {
  const beatStats = input.beatStats ?? listBeatStats();
  const graphStats = input.graphStats ?? listGraphThreadStats();
  return input.threads
    .map((thread) =>
      buildThreadWithoutCaseSample({
        thread,
        beatStats: beatStats.get(thread.id),
        graphStats: graphStats.get(thread.id),
        currentTick: input.currentTick,
        nowMs: input.nowMs,
        staleThreadTickThreshold: input.staleThreadTickThreshold,
      }),
    )
    .sort(
      (a, b) =>
        sampleClassRank(a.classification) - sampleClassRank(b.classification) ||
        (b.tickAge ?? -1) - (a.tickAge ?? -1) ||
        a.threadId - b.threadId,
    );
}

function sampleClassRank(classification: ThreadWithoutCaseSampleClass): number {
  switch (classification) {
    case "stale_lifecycle_debt":
      return 0;
    case "missing_social_event_candidate":
      return 1;
    case "wait_thread_candidate":
      return 2;
    case "orphan_conversation_lifecycle_debt":
      return 3;
    case "topic_cluster":
      return 4;
    case "unknown":
      return 5;
  }
}

function buildCaseAttentionSurfaceShadow(input: {
  shadow: SocialCasePressureShadow;
  matches: readonly SocialCaseThreadRow[];
  beatStats: ReadonlyMap<number, NarrativeBeatStats>;
  currentTick: number | null;
  staleThreadTickThreshold: number;
}): SocialCaseAttentionSurfaceShadow | null {
  const openThread = input.matches.find((thread) => statusClass(thread.status) === "open") ?? null;
  const closedThread =
    input.matches.find((thread) => statusClass(thread.status) === "closed") ?? null;
  const thread = openThread ?? closedThread ?? input.matches[0] ?? null;

  if (input.shadow.open && openThread == null) {
    return {
      classification:
        thread == null
          ? "open_case_missing_attention_surface"
          : "open_case_closed_attention_surface",
      caseId: input.shadow.caseId,
      threadId: thread?.id ?? null,
      caseOpen: input.shadow.open,
      pressure: input.shadow.pressure,
      pair: input.shadow.pair,
      threadStatus: thread?.status ?? null,
      threadSource: thread?.source ?? null,
      threadTitle: thread?.title ?? null,
      threadActivityTick: null,
      threadTickAge: null,
      reason:
        thread == null
          ? "social_case_open_but_no_open_attention_surface"
          : "social_case_open_but_matched_attention_surface_closed",
    };
  }

  if (!input.shadow.open && openThread != null) {
    const activity = computeThreadActivity({
      thread: openThread,
      beatStats: input.beatStats.get(openThread.id),
      currentTick: input.currentTick,
    });
    const stale = activity.tickAge != null && activity.tickAge > input.staleThreadTickThreshold;
    return {
      classification: stale
        ? "closed_case_stale_attention_surface"
        : "closed_case_open_attention_surface",
      caseId: input.shadow.caseId,
      threadId: openThread.id,
      caseOpen: input.shadow.open,
      pressure: input.shadow.pressure,
      pair: input.shadow.pair,
      threadStatus: openThread.status,
      threadSource: openThread.source,
      threadTitle: openThread.title,
      threadActivityTick: activity.activityTick,
      threadTickAge: activity.tickAge,
      reason: stale
        ? `social_case_closed_but_stale_open_attention_surface; activity_age_ticks=${activity.tickAge}; stale_threshold_ticks=${input.staleThreadTickThreshold}`
        : "social_case_closed_but_open_attention_surface",
    };
  }

  return null;
}

function buildOrphanAttentionSurfaceShadow(
  sample: ThreadWithoutCaseSample,
): SocialCaseAttentionSurfaceShadow | null {
  if (sample.classification !== "stale_lifecycle_debt") return null;
  return {
    classification: "orphan_stale_attention_surface",
    caseId: null,
    threadId: sample.threadId,
    caseOpen: null,
    pressure: null,
    pair: null,
    threadStatus: sample.status,
    threadSource: sample.source,
    threadTitle: sample.title,
    threadActivityTick: sample.activityTick,
    threadTickAge: sample.tickAge,
    reason: "open_attention_surface_has_no_social_case_and_is_stale",
  };
}

function sortAttentionSurfaceShadows(
  shadows: readonly SocialCaseAttentionSurfaceShadow[],
): SocialCaseAttentionSurfaceShadow[] {
  return [...shadows].sort(
    (a, b) =>
      attentionSurfaceClassRank(a.classification) - attentionSurfaceClassRank(b.classification) ||
      (b.pressure ?? 0) - (a.pressure ?? 0) ||
      (b.threadTickAge ?? -1) - (a.threadTickAge ?? -1) ||
      String(a.caseId ?? "").localeCompare(String(b.caseId ?? "")) ||
      (a.threadId ?? 0) - (b.threadId ?? 0),
  );
}

function attentionSurfaceClassRank(classification: SocialCaseAttentionSurfaceClass): number {
  switch (classification) {
    case "closed_case_stale_attention_surface":
      return 0;
    case "open_case_missing_attention_surface":
      return 1;
    case "open_case_closed_attention_surface":
      return 2;
    case "closed_case_open_attention_surface":
      return 3;
    case "orphan_stale_attention_surface":
      return 4;
  }
}

function classifyCase(
  shadow: SocialCasePressureShadow,
  matches: readonly SocialCaseThreadRow[],
): SocialCaseThreadContrastItem {
  const openThread = matches.find((thread) => statusClass(thread.status) === "open") ?? null;
  const closedThread = matches.find((thread) => statusClass(thread.status) === "closed") ?? null;
  const thread = openThread ?? closedThread ?? matches[0] ?? null;

  if (!thread) {
    return {
      classification: "case_without_thread",
      caseId: shadow.caseId,
      threadId: null,
      pressure: shadow.pressure,
      caseOpen: shadow.open,
      threadStatus: null,
      reason: shadow.open
        ? "open_social_case_has_no_structural_thread_match"
        : "closed_case_has_no_thread_match",
      pair: shadow.pair,
      threadTitle: null,
    };
  }

  if (shadow.open && statusClass(thread.status) === "closed") {
    return {
      classification: "thread_closed_but_case_open",
      caseId: shadow.caseId,
      threadId: thread.id,
      pressure: shadow.pressure,
      caseOpen: shadow.open,
      threadStatus: thread.status,
      reason: "social_case_open_but_matched_thread_closed",
      pair: shadow.pair,
      threadTitle: thread.title,
    };
  }

  if (!shadow.open && statusClass(thread.status) === "open") {
    return {
      classification: "case_closed_thread_open",
      caseId: shadow.caseId,
      threadId: thread.id,
      pressure: shadow.pressure,
      caseOpen: shadow.open,
      threadStatus: thread.status,
      reason: "social_case_closed_but_matched_thread_still_open",
      pair: shadow.pair,
      threadTitle: thread.title,
    };
  }

  return {
    classification:
      statusClass(thread.status) === "open" ? "case_with_open_thread" : "case_without_thread",
    caseId: shadow.caseId,
    threadId: thread.id,
    pressure: shadow.pressure,
    caseOpen: shadow.open,
    threadStatus: thread.status,
    reason:
      statusClass(thread.status) === "open"
        ? "open_social_case_has_structural_thread_match"
        : "closed_social_case_has_no_open_thread",
    pair: shadow.pair,
    threadTitle: thread.title,
  };
}

function sortItems(items: readonly SocialCaseThreadContrastItem[]): SocialCaseThreadContrastItem[] {
  return [...items].sort(
    (a, b) =>
      (b.pressure ?? 0) - (a.pressure ?? 0) ||
      classRank(a.classification) - classRank(b.classification) ||
      String(a.caseId ?? "").localeCompare(String(b.caseId ?? "")) ||
      (a.threadId ?? 0) - (b.threadId ?? 0),
  );
}

function classRank(classification: SocialCaseThreadContrastClass): number {
  switch (classification) {
    case "thread_closed_but_case_open":
      return 0;
    case "case_closed_thread_open":
      return 1;
    case "case_without_thread":
      return 2;
    case "thread_without_case":
      return 3;
    case "case_with_open_thread":
      return 4;
  }
}

export function analyzeSocialCaseThreadContrast(
  options: SocialCaseThreadContrastOptions = {},
): SocialCaseThreadContrastReport {
  const selfIds = new Set([...(options.selfIds ?? []), ...DEFAULT_SELF_IDS]);
  const staleThreadTickThreshold =
    options.staleThreadTickThreshold ?? DEFAULT_STALE_THREAD_TICK_THRESHOLD;
  const socialReport = analyzeSocialCases();
  const threads = listNarrativeThreads();
  const openThreads = threads.filter((thread) => statusClass(thread.status) === "open");
  const currentTick = detectCurrentTick(threads);
  const beatStats = listBeatStats();
  const graphStats = listGraphThreadStats();
  const nowMs = Date.now();
  const items: SocialCaseThreadContrastItem[] = [];
  const attentionSurfaceShadows: SocialCaseAttentionSurfaceShadow[] = [];
  const matchedThreadIds = new Set<number>();

  for (const shadow of socialReport.pressureShadows) {
    const matches = threads.filter((thread) => matchesCase(shadow, thread, selfIds));
    for (const match of matches) matchedThreadIds.add(match.id);
    items.push(classifyCase(shadow, matches));
    const attentionShadow = buildCaseAttentionSurfaceShadow({
      shadow,
      matches,
      beatStats,
      currentTick,
      staleThreadTickThreshold,
    });
    if (attentionShadow != null) attentionSurfaceShadows.push(attentionShadow);
  }

  const threadWithoutCaseRows: SocialCaseThreadRow[] = [];
  for (const thread of openThreads) {
    if (matchedThreadIds.has(thread.id)) continue;
    threadWithoutCaseRows.push(thread);
    items.push({
      classification: "thread_without_case",
      caseId: null,
      threadId: thread.id,
      pressure: null,
      caseOpen: null,
      threadStatus: thread.status,
      reason: "open_thread_has_no_social_case_relation_match",
      pair: null,
      threadTitle: thread.title,
    });
  }

  const counts = emptyCounts();
  for (const item of items) counts[item.classification]++;
  const threadWithoutCaseSamples = buildThreadWithoutCaseSamples({
    threads: threadWithoutCaseRows,
    beatStats,
    graphStats,
    currentTick,
    nowMs,
    staleThreadTickThreshold,
  });
  const threadWithoutCaseSampleCounts = emptySampleCounts();
  for (const sample of threadWithoutCaseSamples) {
    threadWithoutCaseSampleCounts[sample.classification]++;
    const attentionShadow = buildOrphanAttentionSurfaceShadow(sample);
    if (attentionShadow != null) attentionSurfaceShadows.push(attentionShadow);
  }
  const attentionSurfaceCounts = emptyAttentionSurfaceCounts();
  for (const shadow of attentionSurfaceShadows) {
    attentionSurfaceCounts[shadow.classification]++;
  }

  return {
    socialCaseCount: socialReport.caseCount,
    openSocialCaseCount: socialReport.openCaseCount,
    pressureShadowCount: socialReport.pressureShadows.length,
    narrativeThreadCount: threads.length,
    openNarrativeThreadCount: openThreads.length,
    currentTick,
    staleThreadTickThreshold,
    counts,
    threadWithoutCaseSampleCounts,
    attentionSurfaceCounts,
    controlGate: {
      status: "shadow_only",
      killCriteria: [
        "Any prompt replay oracle regression blocks control integration.",
        "Any private-cause leak blocks control integration.",
        "Any thread/case closure mismatch must be explained before IAUS integration.",
        "Any stale attention surface after social case closure must be explained before control integration.",
        "High-pressure open cases without a structural thread match are evidence gaps, not control signals.",
      ],
    },
    items: sortItems(items),
    threadWithoutCaseSamples,
    attentionSurfaceShadows: sortAttentionSurfaceShadows(attentionSurfaceShadows),
  };
}

function formatNullableNumber(value: number | null): string {
  return value == null ? "n/a" : String(value);
}

export function renderSocialCaseThreadContrastDiagnostic(
  options: SocialCaseThreadContrastOptions = {},
): string {
  const report = analyzeSocialCaseThreadContrast(options);
  if (options.json) return JSON.stringify(report, null, 2);

  const limit = Math.max(1, options.limit ?? 20);
  const lines = [
    "── Social case / thread contrast diagnostics ──",
    "shadow only: not fed to IAUS, target-control, prompt, or action selection",
    `social_cases=${report.socialCaseCount}, open_social_cases=${report.openSocialCaseCount}, narrative_threads=${report.narrativeThreadCount}, open_threads=${report.openNarrativeThreadCount}`,
    `counts: case_with_open_thread=${report.counts.case_with_open_thread}, case_without_thread=${report.counts.case_without_thread}, case_closed_thread_open=${report.counts.case_closed_thread_open}, thread_closed_but_case_open=${report.counts.thread_closed_but_case_open}, thread_without_case=${report.counts.thread_without_case}`,
    `thread_without_case sample classes: stale_lifecycle_debt=${report.threadWithoutCaseSampleCounts.stale_lifecycle_debt}, orphan_conversation_lifecycle_debt=${report.threadWithoutCaseSampleCounts.orphan_conversation_lifecycle_debt}, missing_social_event_candidate=${report.threadWithoutCaseSampleCounts.missing_social_event_candidate}, wait_thread_candidate=${report.threadWithoutCaseSampleCounts.wait_thread_candidate}, topic_cluster=${report.threadWithoutCaseSampleCounts.topic_cluster}, unknown=${report.threadWithoutCaseSampleCounts.unknown}`,
    `attention surface shadows: closed_case_stale=${report.attentionSurfaceCounts.closed_case_stale_attention_surface}, closed_case_open=${report.attentionSurfaceCounts.closed_case_open_attention_surface}, open_case_missing=${report.attentionSurfaceCounts.open_case_missing_attention_surface}, open_case_closed=${report.attentionSurfaceCounts.open_case_closed_attention_surface}, orphan_stale=${report.attentionSurfaceCounts.orphan_stale_attention_surface}`,
    `current_tick=${formatNullableNumber(report.currentTick)}, stale_threshold_ticks=${report.staleThreadTickThreshold}`,
    "sample classification uses structured thread fields only; title text is display evidence, not classifier authority",
    "control gate: shadow_only",
    "kill criteria before control integration:",
  ];

  for (const criterion of report.controlGate.killCriteria) {
    lines.push(`- ${criterion}`);
  }

  lines.push("contrast items:");
  for (const item of report.items.slice(0, limit)) {
    const target = item.caseId ?? `thread:${item.threadId ?? "unknown"}`;
    const pressure = item.pressure == null ? "n/a" : item.pressure.toFixed(3);
    lines.push(
      `- ${item.classification} ${target} pressure=${pressure} thread=${item.threadId ?? "none"} status=${item.threadStatus ?? "none"} reason=${item.reason}`,
    );
  }
  if (report.items.length === 0) lines.push("- none");

  lines.push("thread_without_case samples:");
  for (const sample of report.threadWithoutCaseSamples.slice(0, limit)) {
    lines.push(
      `- ${sample.classification} thread:${sample.threadId} source=${sample.source ?? "unknown"} status=${sample.status} beats=${sample.beatCount} age_ticks=${formatNullableNumber(sample.tickAge)} graph_idle_ms=${formatNullableNumber(sample.graphIdleMs)} deadline_delta=${formatNullableNumber(sample.deadlineDelta)} reason=${sample.reasons.join(",")}`,
    );
  }
  if (report.threadWithoutCaseSamples.length === 0) lines.push("- none");

  lines.push("attention surface shadows:");
  for (const shadow of report.attentionSurfaceShadows.slice(0, limit)) {
    const target = shadow.caseId ?? `thread:${shadow.threadId ?? "unknown"}`;
    const pressure = shadow.pressure == null ? "n/a" : shadow.pressure.toFixed(3);
    lines.push(
      `- ${shadow.classification} ${target} pressure=${pressure} thread=${shadow.threadId ?? "none"} status=${shadow.threadStatus ?? "none"} age_ticks=${formatNullableNumber(shadow.threadTickAge)} reason=${shadow.reason}`,
    );
  }
  if (report.attentionSurfaceShadows.length === 0) lines.push("- none");

  return lines.join("\n");
}
