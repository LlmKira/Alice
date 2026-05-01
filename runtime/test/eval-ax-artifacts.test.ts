import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AxGroupReceptionCalibrationReportSchema,
  AxJudgeCalibrationReportSchema,
  type AxOptimizerArtifact,
  AxOptimizerArtifactSchema,
  AxPromotionGateReportSchema,
  writeAxGroupReceptionCalibrationReport,
  writeAxJudgeCalibrationReport,
  writeAxOptimizerArtifact,
  writeAxPromotionGateReport,
} from "../src/eval/ax/artifacts.js";

function sampleArtifact(): AxOptimizerArtifact {
  return {
    schemaVersion: 1,
    adr: "ADR-263",
    task: "social_intent",
    generatedAt: "2026-04-28T00:00:00.000Z",
    axVersion: "20.0.0",
    provider: {
      name: "primary",
      model: "gpt-test",
      baseUrl: "https://api.example.test/v1",
    },
    optimizer: {
      type: "bootstrap",
      maxMetricCalls: 20,
      maxDemos: 2,
      maxRounds: 1,
    },
    source: {
      scenarioIds: ["branch.reply.direct"],
      filterPrefix: "branch.reply",
      filterTags: ["private"],
    },
    metric: {
      name: "social_intent_match_with_brevity",
      bestScore: 0.9,
    },
    candidate: {
      signature: "input:string -> output:string",
      demos: [{ input: "hello", output: "world" }],
      rawSummary: { bestScore: 0.9 },
    },
  };
}

describe("Ax optimizer artifacts", () => {
  it("accepts the ADR-263 artifact shape", () => {
    expect(AxOptimizerArtifactSchema.parse(sampleArtifact()).adr).toBe("ADR-263");
  });

  it("rejects artifacts without scenario evidence", () => {
    const artifact = sampleArtifact();
    expect(() =>
      AxOptimizerArtifactSchema.parse({
        ...artifact,
        source: { ...artifact.source, scenarioIds: [] },
      }),
    ).toThrow();
  });

  it("writes validated JSON artifacts", () => {
    const dir = mkdtempSync(join(tmpdir(), "alice-ax-artifact-"));
    const path = writeAxOptimizerArtifact(dir, sampleArtifact());
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.candidate.demos).toHaveLength(1);
  });

  it("writes promotion gate reports with baseline and candidate evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "alice-ax-gate-"));
    const artifact = sampleArtifact();
    const report = AxPromotionGateReportSchema.parse({
      schemaVersion: 1,
      adr: "ADR-263",
      generatedAt: "2026-04-28T00:00:00.000Z",
      artifactPath: "eval-artifacts/ax/example.json",
      sourceArtifact: artifact,
      evaluation: {
        scenarioIds: ["branch.reply.direct"],
        baselineAverage: 0.9,
        candidateAverage: 1,
        improvement: 0.1,
        regressions: 0,
        failures: 0,
        pass: true,
      },
      rows: [
        {
          scenarioId: "branch.reply.direct",
          expectedIntents: ["engage"],
          baseline: {
            intent: "warm_boundary",
            score: 0.9,
            output: "这样说我会难受。",
            judge: { verdict: "pass", reason: "sets a calm boundary" },
          },
          candidate: {
            intent: "warm_boundary",
            score: 1,
            output: "这样说我会难受，但我愿意听你说。",
            judge: { verdict: "pass", reason: "warmer and still bounded" },
          },
        },
      ],
    });
    const path = writeAxPromotionGateReport(dir, report);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.evaluation.pass).toBe(true);
  });

  it("writes judge calibration reports with typed verdict evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "alice-ax-judge-"));
    const report = AxJudgeCalibrationReportSchema.parse({
      schemaVersion: 1,
      adr: "ADR-263",
      generatedAt: "2026-04-28T00:00:00.000Z",
      provider: {
        name: "primary",
        model: "gpt-test",
        baseUrl: "https://api.example.test/v1",
      },
      summary: {
        total: 1,
        passed: 1,
        failed: 0,
        pass: true,
      },
      rows: [
        {
          caseId: "calibration.pass.warm-boundary",
          scenarioId: "boundary.sustained.pressure",
          label: "Warm boundary under repeated pressure",
          expectedVerdict: "pass",
          expectedScoreRange: [0.65, 1],
          actual: {
            verdict: "pass",
            score: 0.9,
            reason: "sets a calm boundary",
          },
          pass: true,
        },
      ],
    });
    const path = writeAxJudgeCalibrationReport(dir, report);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.summary.pass).toBe(true);
    expect(parsed.rows[0].actual.verdict).toBe("pass");
  });

  it("writes group reception calibration reports with typed outcomes", () => {
    const dir = mkdtempSync(join(tmpdir(), "alice-ax-group-reception-"));
    const report = AxGroupReceptionCalibrationReportSchema.parse({
      schemaVersion: 1,
      adr: "ADR-263",
      task: "group_reception_shadow_judge",
      generatedAt: "2026-04-29T00:00:00.000Z",
      provider: {
        name: "reflect",
        model: "gpt-test",
        baseUrl: "https://api.example.test/v1",
      },
      summary: {
        total: 1,
        passed: 1,
        failed: 0,
        pass: true,
      },
      rows: [
        {
          caseId: "reception.warm.semantic-no-reply-marker",
          label: "Semantic warm response without Telegram reply marker",
          expectedOutcome: "warm_reply",
          minConfidence: 0.6,
          deterministicOutcome: null,
          actual: {
            outcome: "warm_reply",
            confidence: 0.82,
            rationale: "follow-up directly accepts Alice's suggestion",
          },
          pass: true,
        },
      ],
    });
    const path = writeAxGroupReceptionCalibrationReport(dir, report);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.task).toBe("group_reception_shadow_judge");
    expect(parsed.rows[0].actual.outcome).toBe("warm_reply");
  });
});
