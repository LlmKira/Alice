import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, initDb } from "../src/db/connection.js";
import { listEmotionEventsForReplay, listRecentEmotionEvents } from "../src/emotion/event-store.js";
import {
  readEmotionEpisodes,
  recordEmotionEpisode,
  recordEmotionRepair,
} from "../src/emotion/graph.js";
import { listEmotionRepairEventsForReplay } from "../src/emotion/repair-store.js";
import { WorldModel } from "../src/graph/world-model.js";

const NOW = 1_700_000_000_000;

describe("ADR-268 emotion_events store", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("persists self emotion episodes as append-only facts", () => {
    const G = new WorldModel();
    G.addAgent("self");

    recordEmotionEpisode(G, {
      id: "emotion-test-1",
      kind: "hurt",
      intensity: 0.7,
      nowMs: NOW,
      cause: { type: "feedback", evidenceId: "347", summary: "hostile reception" },
      targetId: "channel:telegram:-1001",
    });
    recordEmotionEpisode(G, {
      id: "emotion-test-2",
      kind: "tired",
      intensity: 0.5,
      nowMs: NOW + 1,
      cause: { type: "overload", summary: "too many inputs" },
    });

    const rows = listEmotionEventsForReplay();
    expect(rows.map((row) => row.id)).toEqual(["emotion-test-1", "emotion-test-2"]);
    expect(rows[0]?.cause).toEqual({
      type: "feedback",
      evidenceId: "347",
      summary: "hostile reception",
    });
    expect(readEmotionEpisodes(G, NOW + 1).map((row) => row.kind)).toEqual(["hurt", "tired"]);
  });

  it("deduplicates by stable event id without overwriting the original fact", () => {
    const G = new WorldModel();
    G.addAgent("self");

    recordEmotionEpisode(G, {
      id: "same-emotion",
      kind: "hurt",
      intensity: 0.7,
      nowMs: NOW,
      cause: { type: "feedback", summary: "first cause" },
    });
    recordEmotionEpisode(G, {
      id: "same-emotion",
      kind: "pleased",
      intensity: 0.7,
      nowMs: NOW + 1,
      cause: { type: "feedback", summary: "second cause" },
    });

    const rows = listRecentEmotionEvents({ nowMs: NOW + 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("hurt");
    expect(rows[0]?.cause).toEqual({ type: "feedback", summary: "first cause" });
  });

  it("persists repair accelerators as append-only facts separate from emotion episodes", () => {
    const G = new WorldModel();
    G.addAgent("self");

    recordEmotionEpisode(G, {
      id: "hurt-before-repair",
      kind: "hurt",
      intensity: 0.7,
      nowMs: NOW,
      cause: { type: "feedback", summary: "sharp reply" },
      targetId: "channel:test",
    });
    recordEmotionRepair(G, {
      id: "repair-1",
      repairKind: "apology",
      emotionKind: "hurt",
      strength: 0.8,
      nowMs: NOW + 1,
      cause: { type: "feedback", summary: "apology" },
      targetId: "channel:test",
    });

    expect(listEmotionEventsForReplay()).toHaveLength(1);
    expect(listEmotionRepairEventsForReplay()).toMatchObject([
      {
        id: "repair-1",
        repairKind: "apology",
        emotionKind: "hurt",
        targetId: "channel:test",
      },
    ]);
  });
});
