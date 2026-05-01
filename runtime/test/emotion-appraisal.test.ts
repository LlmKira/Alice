import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModContext } from "../src/core/types.js";
import * as connection from "../src/db/connection.js";
import { emotionEvents, emotionRepairs, socialEvents } from "../src/db/schema.js";
import {
  appraiseActionFailureEmotion,
  appraiseLonelySilence,
  appraiseWarmReturnRepair,
} from "../src/emotion/appraisal.js";
import { readEmotionEpisodes, readEmotionState } from "../src/emotion/graph.js";
import { listEmotionRepairEventsForReplay } from "../src/emotion/repair-store.js";
import { WorldModel } from "../src/graph/world-model.js";
import { observerMod } from "../src/mods/observer.mod.js";
import { socialCaseMod } from "../src/mods/social-case.mod.js";

const NOW = 1_700_000_000_000;
const CONTACT = "contact:telegram:42";
const PRIVATE = "channel:telegram:42";
const GROUP = "channel:telegram:-10042";

let sqlite: InstanceType<typeof Database>;
let db: ReturnType<typeof drizzle>;

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema: { emotionEvents, emotionRepairs, socialEvents } });
  createTables();
  vi.spyOn(connection, "getDb").mockReturnValue(db as ReturnType<typeof connection.getDb>);
  vi.spyOn(connection, "isDbInitialized").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  sqlite.close();
});

function createTables(): void {
  sqlite.exec(`
    CREATE TABLE emotion_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      valence REAL NOT NULL,
      arousal REAL NOT NULL,
      intensity REAL NOT NULL,
      target_id TEXT,
      cause_type TEXT NOT NULL,
      cause_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      half_life_ms INTEGER NOT NULL,
      confidence REAL NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_emotion_events_event ON emotion_events (event_id);
    CREATE INDEX idx_emotion_events_created ON emotion_events (created_at_ms);
    CREATE INDEX idx_emotion_events_kind_created ON emotion_events (kind, created_at_ms);
    CREATE INDEX idx_emotion_events_target_created ON emotion_events (target_id, created_at_ms);

    CREATE TABLE emotion_repairs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repair_id TEXT NOT NULL,
      repair_kind TEXT NOT NULL,
      emotion_kind TEXT,
      target_id TEXT,
      strength REAL NOT NULL,
      cause_type TEXT NOT NULL,
      cause_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      confidence REAL NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_emotion_repairs_repair ON emotion_repairs (repair_id);
    CREATE INDEX idx_emotion_repairs_created ON emotion_repairs (created_at_ms);
    CREATE INDEX idx_emotion_repairs_kind_created ON emotion_repairs (repair_kind, created_at_ms);
    CREATE INDEX idx_emotion_repairs_target_created ON emotion_repairs (target_id, created_at_ms);

    CREATE TABLE social_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      case_id TEXT,
      kind TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      target_id TEXT,
      affected_relation_a TEXT NOT NULL,
      affected_relation_b TEXT NOT NULL,
      affected_relation_key TEXT NOT NULL,
      venue_id TEXT NOT NULL,
      visibility TEXT NOT NULL,
      witnesses_json TEXT NOT NULL DEFAULT '[]',
      severity REAL NOT NULL,
      confidence REAL NOT NULL,
      evidence_msg_ids_json TEXT NOT NULL DEFAULT '[]',
      causes_json TEXT NOT NULL DEFAULT '[]',
      occurred_at_ms INTEGER NOT NULL,
      repairs_event_id TEXT,
      boundary_text TEXT,
      content_text TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_social_events_event ON social_events (event_id);
    CREATE INDEX idx_social_events_case_time ON social_events (case_id, occurred_at_ms);
    CREATE INDEX idx_social_events_relation_time ON social_events (affected_relation_key, occurred_at_ms);
    CREATE INDEX idx_social_events_kind ON social_events (kind);
    CREATE INDEX idx_social_events_venue_time ON social_events (venue_id, occurred_at_ms);
  `);
}

function makeGraph(): WorldModel {
  const graph = new WorldModel();
  graph.addAgent("self", { mood_valence: 0, mood_set_ms: 0 });
  graph.addContact(CONTACT, { tier: 15, display_name: "A" });
  graph.addChannel(PRIVATE, { chat_type: "private", display_name: "A" });
  graph.addChannel(GROUP, { chat_type: "supergroup", display_name: "Group" });
  return graph;
}

function makeCtx<T>(graph: WorldModel, state: T, nowMs = NOW): ModContext<T> {
  return {
    graph,
    state,
    tick: 500,
    nowMs,
    getModState: () => undefined,
    dispatch: () => undefined,
  };
}

describe("ADR-268 structured emotion appraisal", () => {
  it("social support fact produces touched without legacy self mood writes", () => {
    const graph = makeGraph();
    const instruction = socialCaseMod.instructions?.social_case_note;
    if (!instruction) throw new Error("social_case_note instruction missing");

    const result = instruction.impl(makeCtx(graph, {}, NOW), {
      kind: "support",
      other: CONTACT,
      venue: GROUP,
      visibility: "public",
      text: "Alice, that was kind and careful.",
      severity: "high",
      confidence: "high",
    }) as { success: boolean };

    expect(result.success).toBe(true);
    expect(readEmotionEpisodes(graph, NOW).map((episode) => episode.kind)).toContain("touched");
    expect(graph.getAgent("self").mood_valence).toBe(0);
    expect(graph.getAgent("self").mood_set_ms).toBe(0);
  });

  it("social apology writes a repair fact that accelerates hurt decay without deleting episode", () => {
    const graph = makeGraph();
    const instruction = socialCaseMod.instructions?.social_case_note;
    if (!instruction) throw new Error("social_case_note instruction missing");

    expect(
      (
        instruction.impl(makeCtx(graph, {}, NOW), {
          caseId: "case:test-repair",
          kind: "insult",
          other: CONTACT,
          venue: GROUP,
          visibility: "public",
          text: "Alice, shut up.",
          severity: "high",
          confidence: "high",
        }) as { success: boolean }
      ).success,
    ).toBe(true);

    const beforeRepair = readEmotionState(graph, NOW + 60_000).dominant?.effectiveIntensity ?? 0;

    expect(
      (
        instruction.impl(makeCtx(graph, {}, NOW + 120_000), {
          caseId: "case:test-repair",
          kind: "apology",
          other: CONTACT,
          venue: GROUP,
          visibility: "public",
          text: "I went too far. Sorry, Alice.",
          severity: "high",
          confidence: "high",
        }) as { success: boolean }
      ).success,
    ).toBe(true);

    const afterRepair = readEmotionState(graph, NOW + 120_000).dominant?.effectiveIntensity ?? 0;
    expect(listEmotionRepairEventsForReplay()).toHaveLength(1);
    expect(readEmotionEpisodes(graph, NOW + 120_000).filter((e) => e.kind === "hurt")).toHaveLength(
      1,
    );
    expect(afterRepair).toBeLessThan(beforeRepair * 0.7);
  });

  it("strong support also produces shy as a secondary emotion", () => {
    const graph = makeGraph();
    const instruction = socialCaseMod.instructions?.social_case_note;
    if (!instruction) throw new Error("social_case_note instruction missing");

    const result = instruction.impl(makeCtx(graph, {}, NOW), {
      kind: "support",
      other: CONTACT,
      venue: GROUP,
      visibility: "public",
      text: "Alice, that was kind and careful.",
      severity: "high",
      confidence: "high",
    }) as { success: boolean };

    expect(result.success).toBe(true);
    expect(readEmotionEpisodes(graph, NOW).map((episode) => episode.kind)).toContain("shy");
    expect(readEmotionState(graph, NOW).secondary?.kind).toBe("shy");
  });

  it("low-relevance low-intensity activity produces flat", () => {
    const graph = makeGraph();
    const instruction = observerMod.instructions?.observe_activity;
    if (!instruction) throw new Error("observe_activity instruction missing");

    const result = instruction.impl(
      makeCtx(graph, { outcomeHistory: [], impressionCounts: {} }, NOW),
      {
        chatId: GROUP,
        type: "background chatter",
        intensity: "low",
        relevance_to_alice: "not_relevant",
      },
    ) as { success: boolean };

    expect(result.success).toBe(true);
    expect(readEmotionState(graph, NOW).dominant?.kind).toBe("flat");
  });

  it("close-target silence after one soft check-in produces lonely with proactive cap", () => {
    const graph = makeGraph();
    graph.updateChannel(PRIVATE, {
      last_outgoing_ms: NOW - 70 * 60_000,
      last_incoming_ms: NOW - 2 * 60 * 60_000,
      consecutive_outgoing: 1,
    });

    appraiseLonelySilence(graph, NOW);

    const state = readEmotionState(graph, NOW);
    expect(state.dominant?.kind).toBe("lonely");
    expect(JSON.parse(String(graph.getDynamic("self", "emotion_control")))).toMatchObject({
      actionCaps: { proactiveMessages: 1 },
    });
  });

  it("warm return repair accelerates lonely decay", () => {
    const graph = makeGraph();
    graph.updateChannel(PRIVATE, {
      last_outgoing_ms: NOW - 70 * 60_000,
      last_incoming_ms: NOW - 2 * 60 * 60_000,
      consecutive_outgoing: 1,
    });
    appraiseLonelySilence(graph, NOW);
    const before = readEmotionState(graph, NOW).dominant?.effectiveIntensity ?? 0;

    appraiseWarmReturnRepair(graph, { channelId: PRIVATE, nowMs: NOW + 60_000 });

    const after = readEmotionState(graph, NOW + 60_000).dominant?.effectiveIntensity ?? 0;
    expect(after).toBeLessThan(before * 0.65);
  });

  it("structured social risk produces uneasy", () => {
    const graph = makeGraph();
    const instruction = observerMod.instructions?.flag_risk;
    if (!instruction) throw new Error("flag_risk instruction missing");

    const result = instruction.impl(
      makeCtx(graph, { outcomeHistory: [], impressionCounts: {} }, NOW),
      {
        chatId: GROUP,
        level: "medium",
        reason: "ambiguous correction may be socially risky",
      },
    ) as { success: boolean };

    expect(result.success).toBe(true);
    expect(readEmotionState(graph, NOW).dominant?.kind).toBe("uneasy");
  });

  it("repeated deterministic action failures produce annoyed", () => {
    const graph = makeGraph();

    appraiseActionFailureEmotion(graph, {
      targetId: GROUP,
      errorCodes: ["invalid_reaction"],
      nowMs: NOW,
    });
    appraiseActionFailureEmotion(graph, {
      targetId: GROUP,
      errorCodes: ["invalid_reaction"],
      nowMs: NOW + 1000,
    });

    expect(readEmotionState(graph, NOW + 1000).dominant?.kind).toBe("annoyed");
  });
});
