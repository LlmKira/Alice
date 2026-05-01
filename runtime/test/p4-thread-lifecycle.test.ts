import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeP4ThreadLifecycle } from "../src/diagnostics/p4-thread-lifecycle.js";

let sqlite: InstanceType<typeof Database>;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE graph_nodes (
      id TEXT PRIMARY KEY NOT NULL,
      entity_type TEXT NOT NULL,
      attrs TEXT NOT NULL,
      updated_tick INTEGER NOT NULL
    );
    CREATE TABLE narrative_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      weight TEXT NOT NULL DEFAULT 'minor',
      source TEXT,
      involves TEXT,
      created_tick INTEGER NOT NULL,
      last_beat_tick INTEGER,
      resolved_tick INTEGER,
      horizon INTEGER,
      deadline_tick INTEGER
    );
    CREATE TABLE narrative_beats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL,
      tick INTEGER NOT NULL,
      content TEXT NOT NULL,
      beat_type TEXT NOT NULL DEFAULT 'ambient'
    );
  `);
});

afterEach(() => {
  sqlite.close();
});

function insertNarrative(id: number, status: string, title = `thread ${id}`): void {
  sqlite
    .prepare(
      `INSERT INTO narrative_threads
       (id, title, status, weight, source, created_tick)
       VALUES (?, ?, ?, 'minor', 'conversation', 1)`,
    )
    .run(id, title, status);
}

function insertNarrativeWithSource(input: {
  id: number;
  status: string;
  source: string;
  involves?: string | null;
  horizon?: number | null;
  deadlineTick?: number | null;
}): void {
  sqlite
    .prepare(
      `INSERT INTO narrative_threads
       (id, title, status, weight, source, involves, created_tick, horizon, deadline_tick)
       VALUES (?, ?, ?, 'minor', ?, ?, 1, ?, ?)`,
    )
    .run(
      input.id,
      `thread ${input.id}`,
      input.status,
      input.source,
      input.involves ?? null,
      input.horizon ?? null,
      input.deadlineTick ?? null,
    );
}

function insertGraphThread(id: number, attrs: Record<string, unknown>, status = "open"): void {
  sqlite
    .prepare(
      "INSERT INTO graph_nodes (id, entity_type, attrs, updated_tick) VALUES (?, 'thread', ?, 1)",
    )
    .run(
      `thread_${id}`,
      JSON.stringify({
        title: `thread ${id}`,
        status,
        weight: "minor",
        w: 1,
        source: "conversation",
        created_ms: 1_000,
        last_activity_ms: 1_000,
        ...attrs,
      }),
    );
}

describe("analyzeP4ThreadLifecycle", () => {
  it("classifies valid, overdue, stale, and resolved-but-open graph threads", () => {
    const nowMs = 10 * 86_400_000;
    insertNarrative(1, "open");
    insertGraphThread(1, {
      created_ms: nowMs - 60_000,
      last_activity_ms: nowMs - 60_000,
      deadline_ms: nowMs + 60_000,
    });

    insertNarrative(2, "open");
    insertGraphThread(2, {
      created_ms: nowMs - 60_000,
      last_activity_ms: nowMs - 60_000,
      deadline_ms: nowMs - 1_000,
    });

    insertNarrative(3, "open");
    insertGraphThread(3, {
      created_ms: nowMs - 8 * 86_400_000,
      last_activity_ms: nowMs - 8 * 86_400_000,
      deadline_ms: nowMs + 60_000,
    });

    insertNarrative(4, "resolved");
    insertGraphThread(4, {
      created_ms: nowMs - 60_000,
      last_activity_ms: nowMs - 60_000,
      deadline_ms: nowMs + 60_000,
    });

    const report = analyzeP4ThreadLifecycle(sqlite, { nowMs });

    expect(report.counts.still_valid).toBe(1);
    expect(report.counts.overdue_open).toBe(1);
    expect(report.counts.expired_stale).toBe(1);
    expect(report.counts.resolved_but_not_closed).toBe(1);
    expect(report.p4Total).toBeGreaterThan(0);
  });

  it("reports graph/narrative alignment drift as invalid phantom", () => {
    insertNarrative(9, "open");
    insertGraphThread(10, { created_ms: 1_000, last_activity_ms: 1_000 });

    const report = analyzeP4ThreadLifecycle(sqlite, { nowMs: 2_000 });

    expect(report.counts.invalid_phantom).toBe(2);
    expect(report.items.map((item) => item.reasons[0]).sort()).toEqual([
      "graph_thread_missing_narrative_row",
      "narrative_open_missing_graph_node",
    ]);
  });

  it("classifies old auto topics without deadline as lifecycle debt", () => {
    const nowMs = 2 * 86_400_000;
    insertNarrativeWithSource({ id: 12, status: "open", source: "auto" });
    insertGraphThread(12, {
      source: "auto",
      created_ms: nowMs - 24 * 60 * 60_000,
      last_activity_ms: nowMs - 13 * 60 * 60_000,
      deadline_ms: undefined,
    });

    const report = analyzeP4ThreadLifecycle(sqlite, { nowMs });
    const item = report.items.find((entry) => entry.dbId === 12);

    expect(item?.classification).toBe("legacy_auto_topic_needs_expiry");
    expect(item?.reasons).toContain("legacy_auto_topic_without_deadline");
    expect(report.counts.legacy_auto_topic_needs_expiry).toBe(1);
    expect(report.counts.still_valid).toBe(0);
  });

  it("does not let legacy raw handles protect auto topics from lifecycle debt", () => {
    const nowMs = 2 * 86_400_000;
    insertNarrativeWithSource({
      id: 13,
      status: "open",
      source: "auto",
      involves: JSON.stringify([{ nodeId: "@6822668883", role: "romantic_interest" }]),
    });
    insertGraphThread(13, {
      source: "auto",
      created_ms: nowMs - 24 * 60 * 60_000,
      last_activity_ms: nowMs - 13 * 60 * 60_000,
      deadline_ms: undefined,
    });

    const report = analyzeP4ThreadLifecycle(sqlite, { nowMs });
    const item = report.items.find((entry) => entry.dbId === 13);

    expect(item?.classification).toBe("legacy_auto_topic_needs_expiry");
    expect(item?.reasons).toContain("empty_structured_involvement");
    expect(report.counts.legacy_auto_topic_needs_expiry).toBe(1);
  });

  it("classifies orphan conversation threads without deadline, involvement, or beats", () => {
    const nowMs = 2 * 86_400_000;
    insertNarrativeWithSource({ id: 14, status: "open", source: "conversation" });
    insertNarrativeWithSource({
      id: 15,
      status: "open",
      source: "conversation",
      horizon: 30,
    });
    insertNarrativeWithSource({ id: 16, status: "open", source: "conversation" });
    insertNarrativeWithSource({ id: 17, status: "open", source: "conversation" });
    sqlite
      .prepare(
        "INSERT INTO narrative_beats (thread_id, tick, content, beat_type) VALUES (?, 2, 'beat', 'ambient')",
      )
      .run(16);
    insertGraphThread(14, {
      source: "conversation",
      created_ms: nowMs - 5 * 60 * 60_000,
      last_activity_ms: nowMs - 5 * 60 * 60_000,
      deadline_ms: undefined,
    });
    insertGraphThread(15, {
      source: "conversation",
      created_ms: nowMs - 5 * 60 * 60_000,
      last_activity_ms: nowMs - 5 * 60 * 60_000,
      deadline_ms: undefined,
    });
    insertGraphThread(16, {
      source: "conversation",
      created_ms: nowMs - 5 * 60 * 60_000,
      last_activity_ms: nowMs - 5 * 60 * 60_000,
      deadline_ms: undefined,
    });
    insertGraphThread(17, {
      source: "conversation",
      created_ms: nowMs - 5 * 60 * 60_000,
      last_activity_ms: nowMs - 5 * 60 * 60_000,
      deadline: 30,
      deadline_ms: undefined,
    });

    const report = analyzeP4ThreadLifecycle(sqlite, { nowMs });
    const orphan = report.items.find((entry) => entry.dbId === 14);
    const horizon = report.items.find((entry) => entry.dbId === 15);
    const beat = report.items.find((entry) => entry.dbId === 16);
    const legacyDeadline = report.items.find((entry) => entry.dbId === 17);

    expect(orphan?.classification).toBe("orphan_conversation_needs_expiry");
    expect(orphan?.reasons).toContain("orphan_conversation_without_deadline_involvement_or_beats");
    expect(horizon?.classification).toBe("still_valid");
    expect(beat?.classification).toBe("still_valid");
    expect(legacyDeadline?.classification).toBe("still_valid");
    expect(report.counts.orphan_conversation_needs_expiry).toBe(1);
  });
});
