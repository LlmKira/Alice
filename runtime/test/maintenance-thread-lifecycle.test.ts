import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb, initDb } from "../src/db/connection.js";
import { runMaintenance } from "../src/db/maintenance.js";
import { narrativeThreads, threadLifecycleEvent } from "../src/db/schema.js";
import { WorldModel } from "../src/graph/world-model.js";

beforeEach(() => initDb(":memory:"));
afterEach(() => {
  vi.useRealTimers();
  closeDb();
});

describe("runMaintenance thread lifecycle path", () => {
  it("expires legacy auto topics whose only involvement is a raw display handle", () => {
    const nowMs = 100_000_000;
    vi.setSystemTime(nowMs);
    const G = new WorldModel();
    G.addAgent("self");
    getDb()
      .insert(narrativeThreads)
      .values({
        id: 104,
        title: "old auto topic with raw handle",
        status: "open",
        weight: "minor",
        source: "auto",
        involves: JSON.stringify([{ nodeId: "@6822668883", role: "romantic_interest" }]),
        createdTick: 1,
        lastBeatTick: 2,
      })
      .run();
    G.addThread("thread_104", {
      title: "old auto topic with raw handle",
      status: "open",
      weight: "minor",
      w: 1,
      source: "auto",
      created_ms: nowMs - 24 * 60 * 60_000,
      last_activity_ms: nowMs - 13 * 60 * 60_000,
      deadline: Number.POSITIVE_INFINITY,
    });

    runMaintenance(200, G);

    expect(G.getThread("thread_104").status).toBe("expired");
    const narrative = getDb()
      .select({ status: narrativeThreads.status })
      .from(narrativeThreads)
      .where(eq(narrativeThreads.id, 104))
      .get();
    expect(narrative?.status).toBe("expired_unresolved");
    const event = getDb().select().from(threadLifecycleEvent).get();
    expect(event).toMatchObject({
      threadNodeId: "thread_104",
      threadId: 104,
      tick: 200,
      outcome: "expired_unresolved",
      reason: "legacy_auto_topic_idle_without_deadline",
    });
  });

  it("expires orphan conversation threads without deadline, involvement, or beats", () => {
    const nowMs = 100_000_000;
    vi.setSystemTime(nowMs);
    const G = new WorldModel();
    G.addAgent("self");
    getDb()
      .insert(narrativeThreads)
      .values({
        id: 126,
        title: "orphan conversation topic",
        status: "open",
        weight: "trivial",
        source: "conversation",
        createdTick: 1,
      })
      .run();
    G.addThread("thread_126", {
      title: "orphan conversation topic",
      status: "open",
      weight: "subtle",
      w: 0.5,
      source: "conversation",
      created_ms: nowMs - 5 * 60 * 60_000,
      last_activity_ms: nowMs - 5 * 60 * 60_000,
      deadline: Number.POSITIVE_INFINITY,
    });

    runMaintenance(201, G);

    expect(G.getThread("thread_126").status).toBe("expired");
    const narrative = getDb()
      .select({ status: narrativeThreads.status })
      .from(narrativeThreads)
      .where(eq(narrativeThreads.id, 126))
      .get();
    expect(narrative?.status).toBe("expired_unresolved");
    const event = getDb().select().from(threadLifecycleEvent).get();
    expect(event).toMatchObject({
      threadNodeId: "thread_126",
      threadId: 126,
      tick: 201,
      outcome: "expired_unresolved",
      reason: "orphan_conversation_idle_without_deadline",
    });
  });
});
