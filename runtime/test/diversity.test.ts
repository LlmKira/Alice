import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, initDb } from "../src/db/connection.js";
import { actionLog, candidateTrace, decisionTrace, tickLog } from "../src/db/schema.js";
import { analyzeVoiceDiversity } from "../src/diagnostics/diversity.js";

beforeEach(() => initDb(":memory:"));
afterEach(() => closeDb());

function insertTick(tick: number, action: string) {
  getDb()
    .insert(tickLog)
    .values({
      tick,
      p1: 0,
      p2: 0,
      p3: 0,
      p4: 0,
      p5: 0,
      p6: 0,
      api: 0,
      action,
      gateVerdict: "enqueue",
    })
    .run();
}

function insertSelectedCandidate(input: {
  tick: number;
  action: string;
  gatePlane: string;
  selected?: boolean;
}) {
  getDb()
    .insert(candidateTrace)
    .values({
      candidateId: `candidate:${input.tick}:${input.action}:${input.gatePlane}`,
      tick: input.tick,
      targetNamespace: "channel",
      targetId: "test",
      actionType: input.action,
      normalizedConsiderationsJson: "{}",
      gatePlane: input.gatePlane,
      selected: input.selected ?? true,
      silenceReason: "N/A",
      sampleStatus: "real",
    })
    .run();
}

describe("analyzeVoiceDiversity", () => {
  it("uses tick_log loudness winners as the A2 authority plane", () => {
    insertTick(1, "diligence");
    insertTick(2, "curiosity");
    insertTick(3, "sociability");
    insertTick(4, "caution");
    getDb()
      .insert(actionLog)
      .values([
        { tick: 1, voice: "diligence", actionType: "send_message", success: true },
        { tick: 2, voice: "diligence", actionType: "send_message", success: true },
        { tick: 3, voice: "diligence", actionType: "send_message", success: true },
      ])
      .run();

    const report = analyzeVoiceDiversity();

    expect(report.authorityPlane).toBe("voice_selection_tick_log");
    expect(report.normalizedEntropy).toBe(1);
    expect(report.voiceFrequencies).toMatchObject({
      diligence: 0.25,
      curiosity: 0.25,
      sociability: 0.25,
      caution: 0.25,
    });
    expect(report.planes.action_log_all?.voiceFrequencies.diligence).toBe(1);
  });

  it("separates normal IAUS selections from directed overrides", () => {
    insertTick(1, "curiosity");
    insertTick(2, "diligence");
    insertTick(3, "sociability");
    insertSelectedCandidate({ tick: 1, action: "curiosity", gatePlane: "none" });
    insertSelectedCandidate({ tick: 2, action: "diligence", gatePlane: "none" });
    insertSelectedCandidate({ tick: 3, action: "sociability", gatePlane: "none" });
    insertSelectedCandidate({ tick: 4, action: "diligence", gatePlane: "directed_override" });
    getDb()
      .insert(decisionTrace)
      .values({
        tick: 1,
        phase: "evolve",
        finalDecision: "enqueue",
        reason: "enqueue",
        payloadJson: JSON.stringify({ selectedAction: "curiosity" }),
      })
      .run();

    const report = analyzeVoiceDiversity();

    expect(report.planes.iaus_selected_normal?.sampleCount).toBe(3);
    expect(report.planes.iaus_selected_normal?.normalizedEntropy).toBe(1);
    expect(report.planes.iaus_selected_directed_override?.sampleCount).toBe(1);
    expect(report.planes.iaus_selected_directed_override?.voiceFrequencies.diligence).toBe(1);
    expect(report.planes.decision_enqueue?.voiceFrequencies.curiosity).toBe(1);
  });
});
