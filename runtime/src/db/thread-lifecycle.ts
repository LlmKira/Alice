import { eq } from "drizzle-orm";
import { hasEffectiveThreadInvolvement } from "../graph/thread-involvement.js";
import type { WorldModel } from "../graph/world-model.js";
import { getDb, getSqlite } from "./connection.js";
import { narrativeBeats, narrativeThreads, threadLifecycleEvent } from "./schema.js";

const DEFAULT_THREAD_AGE_SCALE_S = 86_400;
const DEFAULT_LEGACY_AUTO_TOPIC_IDLE_MS = 12 * 60 * 60 * 1000;
const DEFAULT_ORPHAN_CONVERSATION_IDLE_MS = 4 * 60 * 60 * 1000;

export type ThreadLifecycleOutcome = "resolved" | "renewed" | "snoozed" | "expired_unresolved";

export interface ThreadLifecycleInput {
  threadNodeId: string;
  tick: number;
  occurredAtMs: number;
  previousStatus: string;
  outcome: ThreadLifecycleOutcome;
  reason: string;
  deadlineMs?: number | null;
  snoozeUntilMs?: number | null;
  p4Before?: number | null;
  metadata?: unknown;
}

export function threadDbId(threadNodeId: string): number | null {
  const match = /^thread_(\d+)$/.exec(threadNodeId);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) ? value : null;
}

export function threadP4Contribution(
  nowMs: number,
  createdMs: number,
  w: number,
  threadAgeScaleS = DEFAULT_THREAD_AGE_SCALE_S,
): number {
  const ageS = Math.max((nowMs - createdMs) / 1000, 1.0);
  const maxAgeS = threadAgeScaleS * 7;
  const decayFactor = ageS > maxAgeS ? Math.exp(-(ageS - maxAgeS) / maxAgeS) : 1.0;
  return Math.log(1 + ageS / threadAgeScaleS) * w * decayFactor;
}

export function recordThreadLifecycleEvent(input: ThreadLifecycleInput): void {
  getDb()
    .insert(threadLifecycleEvent)
    .values({
      threadNodeId: input.threadNodeId,
      threadId: threadDbId(input.threadNodeId),
      tick: input.tick,
      occurredAtMs: input.occurredAtMs,
      previousStatus: input.previousStatus,
      outcome: input.outcome,
      reason: input.reason,
      deadlineMs: input.deadlineMs ?? null,
      snoozeUntilMs: input.snoozeUntilMs ?? null,
      p4Before: input.p4Before ?? null,
      metadataJson: JSON.stringify(input.metadata ?? {}),
    })
    .run();
}

function recordEventAndProjectNarrativeStatus(input: ThreadLifecycleInput, status: string): void {
  const sqlite = getSqlite();
  const db = getDb();
  const tx = sqlite.transaction(() => {
    recordThreadLifecycleEvent(input);
    const threadId = threadDbId(input.threadNodeId);
    if (threadId != null) {
      db.update(narrativeThreads).set({ status }).where(eq(narrativeThreads.id, threadId)).run();
    }
  });
  tx();
}

export function expireOverdueThreads(
  G: WorldModel,
  tick: number,
  nowMs: number,
  options: { graceMs?: number } = {},
): number {
  const graceMs = options.graceMs ?? 30 * 60 * 1000;
  let expired = 0;

  for (const threadNodeId of G.getEntitiesByType("thread")) {
    if (!G.has(threadNodeId)) continue;
    const attrs = G.getThread(threadNodeId);
    if (attrs.status !== "open") continue;
    const deadlineMs = typeof attrs.deadline_ms === "number" ? attrs.deadline_ms : null;
    if (deadlineMs == null || !Number.isFinite(deadlineMs)) continue;
    if (nowMs <= deadlineMs + graceMs) continue;

    const p4Before = threadP4Contribution(nowMs, attrs.created_ms, attrs.w);
    recordEventAndProjectNarrativeStatus(
      {
        threadNodeId,
        tick,
        occurredAtMs: nowMs,
        previousStatus: attrs.status,
        outcome: "expired_unresolved",
        reason: "deadline_passed_without_resolution",
        deadlineMs,
        p4Before,
        metadata: {
          title: attrs.title ?? threadNodeId,
          source: attrs.source ?? "unknown",
          sourceChannel: attrs.source_channel ?? null,
        },
      },
      "expired_unresolved",
    );

    G.updateThread(threadNodeId, { status: "expired", last_activity_ms: nowMs });
    expired++;
  }

  return expired;
}

export function expireLegacyAutoTopicThreads(
  G: WorldModel,
  tick: number,
  nowMs: number,
  options: { idleMs?: number } = {},
): number {
  const idleMs = options.idleMs ?? DEFAULT_LEGACY_AUTO_TOPIC_IDLE_MS;
  const rows = getDb()
    .select({
      id: narrativeThreads.id,
      title: narrativeThreads.title,
      status: narrativeThreads.status,
      source: narrativeThreads.source,
      weight: narrativeThreads.weight,
      involves: narrativeThreads.involves,
    })
    .from(narrativeThreads)
    .where(eq(narrativeThreads.status, "open"))
    .all();

  let expired = 0;
  for (const row of rows) {
    if (row.source !== "auto") continue;
    if (hasEffectiveThreadInvolvement(row.involves)) continue;

    const threadNodeId = `thread_${row.id}`;
    if (!G.has(threadNodeId)) continue;
    const attrs = G.getThread(threadNodeId);
    if (attrs.status !== "open") continue;
    if (attrs.source !== "auto") continue;
    if (typeof attrs.deadline_ms === "number" && Number.isFinite(attrs.deadline_ms)) continue;

    const lastActivityMs = attrs.last_activity_ms ?? attrs.created_ms;
    if (!Number.isFinite(lastActivityMs) || nowMs - lastActivityMs <= idleMs) continue;

    recordEventAndProjectNarrativeStatus(
      {
        threadNodeId,
        tick,
        occurredAtMs: nowMs,
        previousStatus: attrs.status,
        outcome: "expired_unresolved",
        reason: "legacy_auto_topic_idle_without_deadline",
        deadlineMs: null,
        p4Before: threadP4Contribution(nowMs, attrs.created_ms, attrs.w),
        metadata: {
          title: row.title,
          source: row.source,
          weight: row.weight,
          idleMs: nowMs - lastActivityMs,
          idleThresholdMs: idleMs,
        },
      },
      "expired_unresolved",
    );

    G.updateThread(threadNodeId, { status: "expired", last_activity_ms: nowMs });
    expired++;
  }

  return expired;
}

// @see docs/adr/262-social-case-management/README.md Wave 4N
export function expireOrphanConversationThreads(
  G: WorldModel,
  tick: number,
  nowMs: number,
  options: { idleMs?: number } = {},
): number {
  const idleMs = options.idleMs ?? DEFAULT_ORPHAN_CONVERSATION_IDLE_MS;
  const db = getDb();
  const rows = db
    .select({
      id: narrativeThreads.id,
      title: narrativeThreads.title,
      status: narrativeThreads.status,
      source: narrativeThreads.source,
      weight: narrativeThreads.weight,
      involves: narrativeThreads.involves,
      horizon: narrativeThreads.horizon,
      deadlineTick: narrativeThreads.deadlineTick,
    })
    .from(narrativeThreads)
    .where(eq(narrativeThreads.status, "open"))
    .all();

  let expired = 0;
  for (const row of rows) {
    if (row.source !== "conversation") continue;
    if (row.horizon != null) continue;
    if (row.deadlineTick != null) continue;
    if (hasEffectiveThreadInvolvement(row.involves)) continue;

    const threadNodeId = `thread_${row.id}`;
    if (!G.has(threadNodeId)) continue;
    const attrs = G.getThread(threadNodeId);
    if (attrs.status !== "open") continue;
    if (attrs.source !== "conversation") continue;
    if (typeof attrs.deadline === "number" && Number.isFinite(attrs.deadline)) continue;
    if (typeof attrs.deadline_ms === "number" && Number.isFinite(attrs.deadline_ms)) continue;

    const beat = db
      .select({ id: narrativeBeats.id })
      .from(narrativeBeats)
      .where(eq(narrativeBeats.threadId, row.id))
      .limit(1)
      .get();
    if (beat != null) continue;

    const lastActivityMs = attrs.last_activity_ms ?? attrs.created_ms;
    if (!Number.isFinite(lastActivityMs) || nowMs - lastActivityMs <= idleMs) continue;

    recordEventAndProjectNarrativeStatus(
      {
        threadNodeId,
        tick,
        occurredAtMs: nowMs,
        previousStatus: attrs.status,
        outcome: "expired_unresolved",
        reason: "orphan_conversation_idle_without_deadline",
        deadlineMs: null,
        p4Before: threadP4Contribution(nowMs, attrs.created_ms, attrs.w),
        metadata: {
          title: row.title,
          source: row.source,
          weight: row.weight,
          idleMs: nowMs - lastActivityMs,
          idleThresholdMs: idleMs,
        },
      },
      "expired_unresolved",
    );

    G.updateThread(threadNodeId, { status: "expired", last_activity_ms: nowMs });
    expired++;
  }

  return expired;
}

export function expireNarrativeOnlyOpenThreads(G: WorldModel, tick: number, nowMs: number): number {
  const rows = getDb()
    .select({
      id: narrativeThreads.id,
      title: narrativeThreads.title,
      status: narrativeThreads.status,
      source: narrativeThreads.source,
      weight: narrativeThreads.weight,
    })
    .from(narrativeThreads)
    .where(eq(narrativeThreads.status, "open"))
    .all();

  let expired = 0;
  for (const row of rows) {
    const threadNodeId = `thread_${row.id}`;
    if (G.has(threadNodeId)) continue;

    recordEventAndProjectNarrativeStatus(
      {
        threadNodeId,
        tick,
        occurredAtMs: nowMs,
        previousStatus: row.status,
        outcome: "expired_unresolved",
        reason: "narrative_open_missing_graph_node",
        p4Before: 0,
        metadata: {
          title: row.title,
          source: row.source ?? "unknown",
          weight: row.weight,
        },
      },
      "expired_unresolved",
    );
    expired++;
  }

  return expired;
}

export function snoozeThreadLifecycle(input: {
  G: WorldModel;
  threadId: number;
  tick: number;
  nowMs: number;
  minutes: number;
  reason: string;
  outcome: Extract<ThreadLifecycleOutcome, "renewed" | "snoozed">;
}): boolean {
  const threadNodeId = `thread_${input.threadId}`;
  if (!input.G.has(threadNodeId)) return false;
  const attrs = input.G.getThread(threadNodeId);
  const deadlineMs = input.nowMs + Math.max(1, input.minutes) * 60_000;
  const deadlineTick = input.tick + Math.max(1, input.minutes);

  const sqlite = getSqlite();
  const db = getDb();
  const tx = sqlite.transaction(() => {
    recordThreadLifecycleEvent({
      threadNodeId,
      tick: input.tick,
      occurredAtMs: input.nowMs,
      previousStatus: attrs.status,
      outcome: input.outcome,
      reason: input.reason,
      deadlineMs: attrs.deadline_ms ?? null,
      snoozeUntilMs: deadlineMs,
      p4Before: threadP4Contribution(input.nowMs, attrs.created_ms, attrs.w),
      metadata: { title: attrs.title ?? threadNodeId },
    });
    db.update(narrativeThreads)
      .set({
        status: "open",
        horizon: Math.max(1, input.minutes),
        deadlineTick,
      })
      .where(eq(narrativeThreads.id, input.threadId))
      .run();
  });
  tx();

  input.G.updateThread(threadNodeId, {
    status: "open",
    deadline: deadlineTick,
    deadline_ms: deadlineMs,
    last_activity_ms: input.nowMs,
  });
  return true;
}
