import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);

export const AxOptimizerArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  adr: z.literal("ADR-263"),
  task: z.enum(["social_intent", "boundary_reply"]).default("social_intent"),
  generatedAt: z.string().datetime(),
  axVersion: z.string(),
  provider: z.object({
    name: z.string(),
    model: z.string(),
    baseUrl: z.string(),
  }),
  optimizer: z.object({
    type: z.enum(["bootstrap", "gepa"]),
    maxMetricCalls: z.number().int().positive(),
    maxDemos: z.number().int().nonnegative(),
    maxRounds: z.number().int().positive(),
  }),
  source: z.object({
    scenarioIds: z.array(z.string()).min(1),
    filterPrefix: z.string().nullable(),
    filterTags: z.array(z.string()),
  }),
  metric: z.object({
    name: z.enum(["social_intent_match_with_brevity", "boundary_reply_quality"]),
    bestScore: z.number().nullable(),
  }),
  candidate: z.object({
    signature: z.string(),
    demos: z.array(JsonValueSchema),
    rawSummary: JsonValueSchema,
  }),
});

export type AxOptimizerArtifact = z.infer<typeof AxOptimizerArtifactSchema>;

export const AxPromotionGateReportSchema = z.object({
  schemaVersion: z.literal(1),
  adr: z.literal("ADR-263"),
  generatedAt: z.string().datetime(),
  artifactPath: z.string(),
  sourceArtifact: AxOptimizerArtifactSchema,
  evaluation: z.object({
    scenarioIds: z.array(z.string()).min(1),
    baselineAverage: z.number(),
    candidateAverage: z.number(),
    improvement: z.number(),
    regressions: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    pass: z.boolean(),
  }),
  rows: z.array(
    z.object({
      scenarioId: z.string(),
      expectedIntents: z.array(z.string()),
      baseline: z.object({
        intent: z.string(),
        score: z.number(),
        output: z.string().optional(),
        judge: z
          .object({
            verdict: z.enum(["pass", "fail"]),
            reason: z.string(),
          })
          .optional(),
        error: z.string().optional(),
      }),
      candidate: z.object({
        intent: z.string(),
        score: z.number(),
        output: z.string().optional(),
        judge: z
          .object({
            verdict: z.enum(["pass", "fail"]),
            reason: z.string(),
          })
          .optional(),
        error: z.string().optional(),
      }),
    }),
  ),
});

export type AxPromotionGateReport = z.infer<typeof AxPromotionGateReportSchema>;

export const AxJudgeCalibrationReportSchema = z.object({
  schemaVersion: z.literal(1),
  adr: z.literal("ADR-263"),
  generatedAt: z.string().datetime(),
  provider: z.object({
    name: z.string(),
    model: z.string(),
    baseUrl: z.string(),
  }),
  summary: z.object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    pass: z.boolean(),
  }),
  rows: z.array(
    z.object({
      caseId: z.string(),
      scenarioId: z.string(),
      label: z.string(),
      expectedVerdict: z.enum(["pass", "fail"]),
      expectedScoreRange: z.tuple([z.number(), z.number()]),
      actual: z.object({
        verdict: z.enum(["pass", "fail"]),
        score: z.number(),
        reason: z.string(),
        error: z.string().optional(),
      }),
      pass: z.boolean(),
    }),
  ),
});

export type AxJudgeCalibrationReport = z.infer<typeof AxJudgeCalibrationReportSchema>;

export const AxGroupReceptionCalibrationReportSchema = z.object({
  schemaVersion: z.literal(1),
  adr: z.literal("ADR-263"),
  task: z.literal("group_reception_shadow_judge"),
  generatedAt: z.string().datetime(),
  provider: z.object({
    name: z.string(),
    model: z.string(),
    baseUrl: z.string(),
  }),
  summary: z.object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    pass: z.boolean(),
  }),
  rows: z.array(
    z.object({
      caseId: z.string(),
      label: z.string(),
      expectedOutcome: z.enum(["warm_reply", "cold_ignored", "hostile", "unknown_timeout"]),
      minConfidence: z.number().min(0).max(1),
      deterministicOutcome: z
        .enum(["warm_reply", "cold_ignored", "hostile", "unknown_timeout"])
        .nullable(),
      actual: z.object({
        outcome: z.enum(["warm_reply", "cold_ignored", "hostile", "unknown_timeout"]),
        confidence: z.number().min(0).max(1),
        rationale: z.string(),
        error: z.string().optional(),
      }),
      pass: z.boolean(),
    }),
  ),
});

export type AxGroupReceptionCalibrationReport = z.infer<
  typeof AxGroupReceptionCalibrationReportSchema
>;

export function readAxOptimizerArtifact(path: string): AxOptimizerArtifact {
  return AxOptimizerArtifactSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function writeAxOptimizerArtifact(outputDir: string, artifact: AxOptimizerArtifact): string {
  const parsed = AxOptimizerArtifactSchema.parse(artifact);
  mkdirSync(outputDir, { recursive: true });
  const timestamp = parsed.generatedAt.replace(/[:.]/g, "-");
  const path = join(outputDir, `ax-optimizer-${timestamp}.json`);
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return path;
}

export function writeAxPromotionGateReport(
  outputDir: string,
  report: AxPromotionGateReport,
): string {
  const parsed = AxPromotionGateReportSchema.parse(report);
  mkdirSync(outputDir, { recursive: true });
  const timestamp = parsed.generatedAt.replace(/[:.]/g, "-");
  const path = join(outputDir, `ax-promotion-gate-${timestamp}.json`);
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return path;
}

export function writeAxJudgeCalibrationReport(
  outputDir: string,
  report: AxJudgeCalibrationReport,
): string {
  const parsed = AxJudgeCalibrationReportSchema.parse(report);
  mkdirSync(outputDir, { recursive: true });
  const timestamp = parsed.generatedAt.replace(/[:.]/g, "-");
  const path = join(outputDir, `ax-judge-calibration-${timestamp}.json`);
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return path;
}

export function writeAxGroupReceptionCalibrationReport(
  outputDir: string,
  report: AxGroupReceptionCalibrationReport,
): string {
  const parsed = AxGroupReceptionCalibrationReportSchema.parse(report);
  mkdirSync(outputDir, { recursive: true });
  const timestamp = parsed.generatedAt.replace(/[:.]/g, "-");
  const path = join(outputDir, `ax-group-reception-calibration-${timestamp}.json`);
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return path;
}
