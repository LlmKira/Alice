import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, initDb } from "../src/db/connection.js";
import { interventionOutcomeEvidence } from "../src/db/schema.js";
import {
  buildTargetReceptionProjections,
  renderTargetControlProjectionDiagnostic,
} from "../src/diagnostics/target-control-projection.js";

describe("target control projection diagnostics", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("projects reception evidence into ADR-254 target control fields", () => {
    insertEvidence({
      channelId: "channel:-1001",
      outcome: "warm_reply",
      signal: 0.3,
      evaluatedAtMs: 2000,
      sourceMessageLogIdsJson: "[11]",
    });
    insertEvidence({
      channelId: "channel:-1001",
      outcome: "hostile",
      signal: -0.5,
      evaluatedAtMs: 3000,
      sourceMessageLogIdsJson: "[12,13]",
    });
    insertEvidence({
      channelId: "channel:-1001",
      outcome: "unknown_timeout",
      signal: null,
      evaluatedAtMs: 4000,
      sourceMessageLogIdsJson: "[]",
    });

    const [projection] = buildTargetReceptionProjections({ target: "channel:-1001" });

    expect(projection).toMatchObject({
      target: "channel:-1001",
      evidenceCount: 3,
      warmCount: 1,
      hostileCount: 1,
      unknownCount: 1,
      timeoutCount: 1,
      latestOutcome: "unknown_timeout",
      latestEvidenceAtMs: 4000,
    });
    expect(projection?.receptionScore).toBeLessThan(0);
  });

  it("renders a human diagnostic without becoming a control path", () => {
    insertEvidence({
      channelId: "channel:-1002",
      outcome: "cold_ignored",
      signal: -0.2,
      evaluatedAtMs: 5000,
      sourceMessageLogIdsJson: "[21,22,23,24,25]",
    });

    const report = renderTargetControlProjectionDiagnostic({ target: "channel:-1002" });

    expect(report).toContain("Target Control Projection — channel:-1002");
    expect(report).toContain("receptionScore=-0.200");
    expect(report).toContain("noReply=1");
    expect(report).toContain("source_message_log_ids=21,22,23,24,25");
  });
});

function insertEvidence(values: {
  channelId: string;
  outcome: "warm_reply" | "cold_ignored" | "hostile" | "unknown_timeout";
  signal: number | null;
  evaluatedAtMs: number;
  sourceMessageLogIdsJson: string;
}): void {
  getDb()
    .insert(interventionOutcomeEvidence)
    .values({
      tick: 1,
      channelId: values.channelId,
      aliceMessageLogId: values.evaluatedAtMs,
      aliceMsgId: values.evaluatedAtMs,
      aliceMessageAtMs: values.evaluatedAtMs - 1000,
      evaluatedAtMs: values.evaluatedAtMs,
      outcome: values.outcome,
      signal: values.signal,
      afterMessageCount: 1,
      replyToAliceCount: values.outcome === "warm_reply" ? 1 : 0,
      hostileMatchCount: values.outcome === "hostile" ? 1 : 0,
      sourceMessageLogIdsJson: values.sourceMessageLogIdsJson,
      previousReception: values.signal == null ? null : 0,
      nextReception: values.signal,
    })
    .run();
}
