import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, initDb } from "../src/db/connection.js";
import { narrativeBeats, narrativeThreads, threadLifecycleEvent } from "../src/db/schema.js";
import {
  expireLegacyAutoTopicThreads,
  expireNarrativeOnlyOpenThreads,
  expireOrphanConversationThreads,
  expireOverdueThreads,
  snoozeThreadLifecycle,
} from "../src/db/thread-lifecycle.js";
import { resolveThreadInGraph } from "../src/engine/generators.js";
import { WorldModel } from "../src/graph/world-model.js";

beforeEach(() => initDb(":memory:"));
afterEach(() => closeDb());

function insertNarrativeThread(id: number, status = "open"): void {
  getDb()
    .insert(narrativeThreads)
    .values({
      id,
      title: `thread ${id}`,
      status,
      weight: "minor",
      source: "conversation",
      createdTick: 1,
    })
    .run();
}

function insertAutoNarrativeThread(id: number, involves: string | null = null): void {
  getDb()
    .insert(narrativeThreads)
    .values({
      id,
      title: `auto thread ${id}`,
      status: "open",
      weight: "minor",
      source: "auto",
      involves,
      createdTick: 1,
    })
    .run();
}

function insertConversationNarrativeThread(input: {
  id: number;
  involves?: string | null;
  horizon?: number | null;
  deadlineTick?: number | null;
}): void {
  getDb()
    .insert(narrativeThreads)
    .values({
      id: input.id,
      title: `conversation thread ${input.id}`,
      status: "open",
      weight: "trivial",
      source: "conversation",
      involves: input.involves ?? null,
      createdTick: 1,
      horizon: input.horizon ?? null,
      deadlineTick: input.deadlineTick ?? null,
    })
    .run();
}

describe("thread lifecycle events", () => {
  it("expires overdue open threads as unresolved lifecycle events", () => {
    const nowMs = 1_000_000;
    const G = new WorldModel();
    insertNarrativeThread(1);
    G.addThread("thread_1", {
      status: "open",
      title: "overdue",
      created_ms: nowMs - 86_400_000,
      deadline_ms: nowMs - 3_600_000,
      deadline: 1,
      weight: "minor",
      w: 1,
    });

    const expired = expireOverdueThreads(G, 10, nowMs, { graceMs: 0 });

    expect(expired).toBe(1);
    expect(G.getThread("thread_1").status).toBe("expired");
    const narrative = getDb()
      .select({ status: narrativeThreads.status })
      .from(narrativeThreads)
      .where(eq(narrativeThreads.id, 1))
      .get();
    expect(narrative?.status).toBe("expired_unresolved");
    const event = getDb().select().from(threadLifecycleEvent).get();
    expect(event?.outcome).toBe("expired_unresolved");
    expect(event?.reason).toBe("deadline_passed_without_resolution");
    expect(event?.p4Before).toBeGreaterThan(0);
  });

  it("does not duplicate overdue expiry events on repeated scans", () => {
    const nowMs = 1_000_000;
    const G = new WorldModel();
    insertNarrativeThread(3);
    G.addThread("thread_3", {
      status: "open",
      title: "overdue once",
      created_ms: nowMs - 86_400_000,
      deadline_ms: nowMs - 3_600_000,
      deadline: 1,
      weight: "minor",
      w: 1,
    });

    const first = expireOverdueThreads(G, 10, nowMs, { graceMs: 0 });
    const second = expireOverdueThreads(G, 11, nowMs + 60_000, { graceMs: 0 });

    expect(first).toBe(1);
    expect(second).toBe(0);
    const events = getDb().select().from(threadLifecycleEvent).all();
    expect(events).toHaveLength(1);
    expect(events[0].threadNodeId).toBe("thread_3");
    expect(events[0].outcome).toBe("expired_unresolved");
  });

  it("expires narrative-only open threads as authority-alignment repairs", () => {
    const nowMs = 1_000_000;
    const G = new WorldModel();
    insertNarrativeThread(5);
    insertNarrativeThread(6);
    G.addThread("thread_6", {
      status: "open",
      title: "real graph thread",
      created_ms: nowMs - 60_000,
      deadline_ms: nowMs + 3_600_000,
      deadline: 60,
      weight: "minor",
      w: 1,
    });

    const first = expireNarrativeOnlyOpenThreads(G, 12, nowMs);
    const second = expireNarrativeOnlyOpenThreads(G, 13, nowMs + 60_000);

    expect(first).toBe(1);
    expect(second).toBe(0);
    const rows = getDb()
      .select({ id: narrativeThreads.id, status: narrativeThreads.status })
      .from(narrativeThreads)
      .all();
    expect(rows.find((row) => row.id === 5)?.status).toBe("expired_unresolved");
    expect(rows.find((row) => row.id === 6)?.status).toBe("open");
    const event = getDb().select().from(threadLifecycleEvent).get();
    expect(event?.threadNodeId).toBe("thread_5");
    expect(event?.reason).toBe("narrative_open_missing_graph_node");
    expect(event?.p4Before).toBe(0);
  });

  it("expires idle legacy auto topic threads without deadline or structured involvement", () => {
    const nowMs = 100_000_000;
    const G = new WorldModel();
    insertAutoNarrativeThread(7);
    insertAutoNarrativeThread(8, JSON.stringify([{ nodeId: "contact:A", role: "participant" }]));
    G.addThread("thread_7", {
      status: "open",
      title: "old auto topic",
      source: "auto",
      created_ms: nowMs - 24 * 60 * 60_000,
      last_activity_ms: nowMs - 13 * 60 * 60_000,
      deadline: Number.POSITIVE_INFINITY,
      weight: "minor",
      w: 1,
    });
    G.addThread("thread_8", {
      status: "open",
      title: "auto topic with person",
      source: "auto",
      created_ms: nowMs - 24 * 60 * 60_000,
      last_activity_ms: nowMs - 13 * 60 * 60_000,
      deadline: Number.POSITIVE_INFINITY,
      weight: "minor",
      w: 1,
    });

    const expired = expireLegacyAutoTopicThreads(G, 21, nowMs);

    expect(expired).toBe(1);
    expect(G.getThread("thread_7").status).toBe("expired");
    expect(G.getThread("thread_8").status).toBe("open");
    const rows = getDb()
      .select({ id: narrativeThreads.id, status: narrativeThreads.status })
      .from(narrativeThreads)
      .all();
    expect(rows.find((row) => row.id === 7)?.status).toBe("expired_unresolved");
    expect(rows.find((row) => row.id === 8)?.status).toBe("open");
    const event = getDb().select().from(threadLifecycleEvent).get();
    expect(event?.threadNodeId).toBe("thread_7");
    expect(event?.reason).toBe("legacy_auto_topic_idle_without_deadline");
    expect(event?.p4Before).toBeGreaterThan(0);
  });

  it("expires legacy auto topics whose involvement is only a raw display handle", () => {
    const nowMs = 100_000_000;
    const G = new WorldModel();
    insertAutoNarrativeThread(
      9,
      JSON.stringify([{ nodeId: "@6822668883", role: "romantic_interest" }]),
    );
    G.addThread("thread_9", {
      status: "open",
      title: "old auto topic with raw handle",
      source: "auto",
      created_ms: nowMs - 24 * 60 * 60_000,
      last_activity_ms: nowMs - 13 * 60 * 60_000,
      deadline: Number.POSITIVE_INFINITY,
      weight: "minor",
      w: 1,
    });

    const expired = expireLegacyAutoTopicThreads(G, 22, nowMs);

    expect(expired).toBe(1);
    expect(G.getThread("thread_9").status).toBe("expired");
    const narrative = getDb()
      .select({ status: narrativeThreads.status })
      .from(narrativeThreads)
      .where(eq(narrativeThreads.id, 9))
      .get();
    expect(narrative?.status).toBe("expired_unresolved");
    const event = getDb().select().from(threadLifecycleEvent).get();
    expect(event?.threadNodeId).toBe("thread_9");
    expect(event?.reason).toBe("legacy_auto_topic_idle_without_deadline");
  });

  it("expires orphan conversation threads without deadline, involvement, or beats", () => {
    const nowMs = 100_000_000;
    const G = new WorldModel();
    insertConversationNarrativeThread({ id: 10 });
    insertConversationNarrativeThread({
      id: 11,
      involves: JSON.stringify([{ nodeId: "contact:A" }]),
    });
    insertConversationNarrativeThread({ id: 12, deadlineTick: 30 });
    insertConversationNarrativeThread({ id: 13, horizon: 30 });
    insertConversationNarrativeThread({ id: 14 });
    insertConversationNarrativeThread({ id: 15 });
    getDb()
      .insert(narrativeBeats)
      .values({
        threadId: 14,
        tick: 2,
        content: "still has a narrative beat",
        beatType: "ambient",
      })
      .run();
    G.addThread("thread_10", {
      status: "open",
      title: "old orphan conversation",
      source: "conversation",
      created_ms: nowMs - 5 * 60 * 60_000,
      last_activity_ms: nowMs - 5 * 60 * 60_000,
      deadline: Number.POSITIVE_INFINITY,
      weight: "subtle",
      w: 0.5,
    });
    G.addThread("thread_11", {
      status: "open",
      title: "old conversation with person",
      source: "conversation",
      created_ms: nowMs - 5 * 60 * 60_000,
      last_activity_ms: nowMs - 5 * 60 * 60_000,
      deadline: Number.POSITIVE_INFINITY,
      weight: "subtle",
      w: 0.5,
    });
    G.addThread("thread_12", {
      status: "open",
      title: "old conversation with deadline",
      source: "conversation",
      created_ms: nowMs - 5 * 60 * 60_000,
      last_activity_ms: nowMs - 5 * 60 * 60_000,
      deadline_ms: nowMs + 60_000,
      deadline: 30,
      weight: "subtle",
      w: 0.5,
    });
    G.addThread("thread_13", {
      status: "open",
      title: "old conversation with horizon",
      source: "conversation",
      created_ms: nowMs - 5 * 60 * 60_000,
      last_activity_ms: nowMs - 5 * 60 * 60_000,
      deadline: 30,
      weight: "subtle",
      w: 0.5,
    });
    G.addThread("thread_14", {
      status: "open",
      title: "old conversation with beat",
      source: "conversation",
      created_ms: nowMs - 5 * 60 * 60_000,
      last_activity_ms: nowMs - 5 * 60 * 60_000,
      deadline: Number.POSITIVE_INFINITY,
      weight: "subtle",
      w: 0.5,
    });
    G.addThread("thread_15", {
      status: "open",
      title: "old conversation with legacy graph deadline",
      source: "conversation",
      created_ms: nowMs - 5 * 60 * 60_000,
      last_activity_ms: nowMs - 5 * 60 * 60_000,
      deadline: 30,
      weight: "subtle",
      w: 0.5,
    });

    const expired = expireOrphanConversationThreads(G, 23, nowMs, { idleMs: 4 * 60 * 60_000 });

    expect(expired).toBe(1);
    expect(G.getThread("thread_10").status).toBe("expired");
    expect(G.getThread("thread_11").status).toBe("open");
    expect(G.getThread("thread_12").status).toBe("open");
    expect(G.getThread("thread_13").status).toBe("open");
    expect(G.getThread("thread_14").status).toBe("open");
    expect(G.getThread("thread_15").status).toBe("open");
    const rows = getDb()
      .select({ id: narrativeThreads.id, status: narrativeThreads.status })
      .from(narrativeThreads)
      .all();
    expect(rows.find((row) => row.id === 10)?.status).toBe("expired_unresolved");
    expect(rows.find((row) => row.id === 11)?.status).toBe("open");
    expect(rows.find((row) => row.id === 12)?.status).toBe("open");
    expect(rows.find((row) => row.id === 13)?.status).toBe("open");
    expect(rows.find((row) => row.id === 14)?.status).toBe("open");
    expect(rows.find((row) => row.id === 15)?.status).toBe("open");
    const event = getDb().select().from(threadLifecycleEvent).get();
    expect(event?.threadNodeId).toBe("thread_10");
    expect(event?.reason).toBe("orphan_conversation_idle_without_deadline");
  });

  it("records resolve lifecycle events with the caller supplied tick time", () => {
    const nowMs = 1_000_000;
    const G = new WorldModel();
    insertNarrativeThread(4);
    G.addThread("thread_4", {
      status: "open",
      title: "resolve at deterministic time",
      created_ms: nowMs - 60_000,
      deadline_ms: nowMs + 3_600_000,
      deadline: 60,
      weight: "minor",
      w: 1,
    });

    resolveThreadInGraph(getDb(), G, "thread_4", 30, nowMs);

    expect(G.getThread("thread_4").status).toBe("resolved");
    const narrative = getDb()
      .select({ status: narrativeThreads.status, resolvedTick: narrativeThreads.resolvedTick })
      .from(narrativeThreads)
      .where(eq(narrativeThreads.id, 4))
      .get();
    expect(narrative?.status).toBe("resolved");
    expect(narrative?.resolvedTick).toBe(30);
    const event = getDb().select().from(threadLifecycleEvent).get();
    expect(event?.outcome).toBe("resolved");
    expect(event?.occurredAtMs).toBe(nowMs);
  });

  it("snoozes a thread with a typed lifecycle event and new deadline", () => {
    const nowMs = 1_000_000;
    const G = new WorldModel();
    insertNarrativeThread(2);
    G.addThread("thread_2", {
      status: "open",
      title: "still useful",
      created_ms: nowMs - 60_000,
      deadline_ms: nowMs - 1_000,
      deadline: 1,
      weight: "minor",
      w: 1,
    });

    const ok = snoozeThreadLifecycle({
      G,
      threadId: 2,
      tick: 20,
      nowMs,
      minutes: 30,
      reason: "wait_for_reply",
      outcome: "snoozed",
    });

    expect(ok).toBe(true);
    expect(G.getThread("thread_2").status).toBe("open");
    expect(G.getThread("thread_2").deadline_ms).toBe(nowMs + 30 * 60_000);
    const event = getDb().select().from(threadLifecycleEvent).get();
    expect(event?.outcome).toBe("snoozed");
    expect(event?.snoozeUntilMs).toBe(nowMs + 30 * 60_000);
  });
});
