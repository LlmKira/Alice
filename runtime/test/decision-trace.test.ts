import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, initDb } from "../src/db/connection.js";
import {
  listDecisionTraces,
  summarizeDecisionTrace,
  writeDecisionTrace,
} from "../src/db/decision-trace.js";
import { renderDecisionTraceDiagnostic } from "../src/diagnostics/decision-trace.js";

describe("decision_trace", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("writes and reads an audit-only decision trace", () => {
    const id = writeDecisionTrace({
      tick: 42,
      phase: "evolve",
      target: "channel:100",
      finalDecision: "silence",
      reason: "api_floor",
      payload: {
        selectedVoice: "caution",
        selectedAction: "send_message",
        gateResults: [{ gate: "api_floor", passed: false }],
      },
    });

    const rows = listDecisionTraces({ tick: 42 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(id);
    expect(rows[0]?.payload.selectedVoice).toBe("caution");
    expect(summarizeDecisionTrace(rows[0]!)).toContain("decision=silence");
  });

  it("renders a human-readable diagnostic", () => {
    writeDecisionTrace({
      tick: 7,
      phase: "act",
      actionLogId: 3,
      finalDecision: "execute",
      reason: "block_completed",
      payload: { observations: ["sent"] },
    });

    const report = renderDecisionTraceDiagnostic({ actionLogId: 3 });
    expect(report).toContain("Decision Trace — action_log 3");
    expect(report).toContain("phase=act");
    expect(report).toContain("payload keys: observations");
  });
});
