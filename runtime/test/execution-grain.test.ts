import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, initDb } from "../src/db/connection.js";
import { actionLog } from "../src/db/schema.js";
import { renderExecutionGrainReport } from "../src/diagnostics/execution-grain.js";

function writePromptLog(
  dir: string,
  name: string,
  body: { script: string; afterward: string; hostContinued?: boolean; reason?: string; dcpMessages?: number },
): void {
  writeFileSync(
    join(dir, name),
    [
      "# Prompt Snapshot",
      "",
      "## User Prompt",
      "",
      "```",
      "prompt",
      "```",
      "",
      "## DCP Shadow Context",
      "",
      "- source: canonical_events",
      "- target: channel:1",
      "- events: 0",
      `- messages: ${body.dcpMessages ?? 0}`,
      "- directed: 0",
      "",
      "## LLM Script",
      "",
      "```sh",
      body.script,
      "```",
      "",
      "## Execution",
      "",
      `- afterward: ${body.afterward}`,
      "- tool calls: 0",
      "- assistant turns: 1",
      "- bash calls: 1",
      `- host continued in tick: ${body.hostContinued ? "yes" : "no"}`,
      body.reason ? `- host continuation reason: ${body.reason}` : null,
      "",
    ]
      .filter((line): line is string => line != null)
      .join("\n"),
  );
}

describe("execution grain report", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("summarizes prompt rounds, continuation reasons, failures, and DCP drift", () => {
    const dir = mkdtempSync(join(tmpdir(), "alice-grain-"));
    writePromptLog(dir, "10-r0-channel_1-2026-04-25T00-00-00-000Z.md", {
      script: "irc tail --count 3",
      afterward: "watching",
      hostContinued: true,
      reason: "local_observation_followup",
    });
    writePromptLog(dir, "10-r1-channel_1-2026-04-25T00-00-01-000Z.md", {
      script: 'irc say --text "hello"',
      afterward: "done",
      dcpMessages: 1,
    });
    writePromptLog(dir, "11-r0-channel_2-2026-04-25T00-00-02-000Z.md", {
      script: "self feel --valence neutral",
      afterward: "done",
    });

    getDb().insert(actionLog).values({
      tick: 10,
      voice: "curiosity",
      target: "channel:1",
      actionType: "observe",
      success: false,
      tcAfterward: "done",
      tcCommandLog: "Error: Engine API timeout",
      tcHostContinuationTrace: JSON.stringify(["local_observation_followup"]),
    }).run();

    const raw = renderExecutionGrainReport({ promptLogsDir: dir, json: true });
    const parsed = JSON.parse(raw) as {
      promptCount: number;
      tickCount: number;
      metrics: {
        ticksWithMultiRound: number;
        r0SingleCommand: number;
        dcpCoverageDrift: number;
        continuationReasons: Record<string, number>;
        continuationAuditClasses: Record<string, number>;
        failureClasses: Record<string, number>;
      };
    };

    expect(parsed.promptCount).toBe(3);
    expect(parsed.tickCount).toBe(2);
    expect(parsed.metrics.ticksWithMultiRound).toBe(1);
    expect(parsed.metrics.r0SingleCommand).toBe(2);
    expect(parsed.metrics.dcpCoverageDrift).toBe(1);
    expect(parsed.metrics.continuationReasons.local_observation_followup).toBe(1);
    expect(parsed.metrics.continuationAuditClasses.read_then_act_needed).toBe(1);
    expect(parsed.metrics.failureClasses.engine_failure).toBe(1);
  });
});
