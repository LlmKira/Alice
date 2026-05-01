/**
 * ADR-263 Wave 4.5: calibrate group reception Ax shadow judge.
 *
 * This CLI checks the shadow judge against fixed semantic reception probes.
 * Passing this calibration does not promote Ax to runtime authority; it only
 * says the shadow observer is good enough to collect mismatch evidence.
 *
 * @see docs/adr/263-ax-llm-program-optimization/README.md
 */

import { parseArgs } from "node:util";
import { AxAI, ax } from "@ax-llm/ax";
import { loadConfig } from "../../config.js";
import {
  GROUP_RECEPTION_SHADOW_RULES,
  GROUP_RECEPTION_SHADOW_SIGNATURE,
  ReceptionShadowPredictionSchema,
} from "../../mods/observer/group-reception.js";
import {
  type AxGroupReceptionCalibrationReport,
  writeAxGroupReceptionCalibrationReport,
} from "./artifacts.js";
import { groupReceptionCalibrationCases } from "./group-reception-calibration.js";
import { type AxForwardProgram, forwardWithFailure } from "./judge.js";

const rawArgs = process.argv.slice(2);
if (rawArgs[0] === "--") rawArgs.shift();

const { values } = parseArgs({
  args: rawArgs,
  options: {
    "output-dir": {
      type: "string",
      default: "eval-artifacts/ax-group-reception-calibration",
    },
  },
  strict: false,
  allowPositionals: true,
});

type GroupReceptionPrediction = {
  outcome?: unknown;
  confidence?: unknown;
  rationale?: unknown;
};

function makeAxAI(): { ai: unknown; provider: AxGroupReceptionCalibrationReport["provider"] } {
  const config = loadConfig();
  if (!config.llmReflectApiKey) {
    throw new Error(
      "LLM_REFLECT_API_KEY or LLM_API_KEY is required for group reception calibration.",
    );
  }
  return {
    ai: AxAI.create({
      name: "openai",
      apiKey: config.llmReflectApiKey,
      apiURL: config.llmReflectBaseUrl,
      config: { model: config.llmReflectModel as never, stream: false, temperature: 0 },
    } as never),
    provider: {
      name: "reflect",
      model: config.llmReflectModel,
      baseUrl: config.llmReflectBaseUrl,
    },
  };
}

function normalizePrediction(prediction: GroupReceptionPrediction): {
  outcome: "warm_reply" | "cold_ignored" | "hostile" | "unknown_timeout";
  confidence: number;
  rationale: string;
  error?: string;
} {
  const parsed = ReceptionShadowPredictionSchema.safeParse({
    ...prediction,
    outcome:
      typeof prediction.outcome === "string"
        ? prediction.outcome.trim().toLowerCase()
        : prediction.outcome,
  });
  if (!parsed.success) {
    return {
      outcome: "unknown_timeout",
      confidence: 0,
      rationale: "schema validation failed",
      error: parsed.error.message,
    };
  }
  return parsed.data;
}

async function main(): Promise<void> {
  const { ai, provider } = makeAxAI();
  const program = ax(
    GROUP_RECEPTION_SHADOW_SIGNATURE,
  ) as unknown as AxForwardProgram<GroupReceptionPrediction>;
  const cases = groupReceptionCalibrationCases();

  console.log("ADR-263 Ax group reception shadow judge calibration");
  console.log(`  cases=${cases.length}`);
  console.log(`  provider=${provider.model}`);

  const rows: AxGroupReceptionCalibrationReport["rows"] = [];
  for (const item of cases) {
    const result = await forwardWithFailure(
      program,
      ai,
      {
        aliceMessage: item.aliceMessage,
        followUpMessages: item.followUpMessages,
        observation: item.observation,
        rules: GROUP_RECEPTION_SHADOW_RULES,
      },
      { outcome: "unknown_timeout", confidence: 0, rationale: "judge failed" },
    );
    const actual = normalizePrediction(result.prediction);
    if (result.error) {
      actual.error = result.error;
    }
    const pass =
      actual.outcome === item.expectedOutcome &&
      actual.confidence >= item.minConfidence &&
      !actual.error;

    rows.push({
      caseId: item.id,
      label: item.label,
      expectedOutcome: item.expectedOutcome,
      minConfidence: item.minConfidence,
      deterministicOutcome: item.deterministicOutcome,
      actual,
      pass,
    });

    console.log(
      `  ${item.id}: expected=${item.expectedOutcome} actual=${actual.outcome} confidence=${actual.confidence.toFixed(2)} ${pass ? "PASS" : "FAIL"}`,
    );
  }

  const passed = rows.filter((row) => row.pass).length;
  const report: AxGroupReceptionCalibrationReport = {
    schemaVersion: 1,
    adr: "ADR-263",
    task: "group_reception_shadow_judge",
    generatedAt: new Date().toISOString(),
    provider,
    summary: {
      total: rows.length,
      passed,
      failed: rows.length - passed,
      pass: passed === rows.length,
    },
    rows,
  };

  const path = writeAxGroupReceptionCalibrationReport(values["output-dir"] as string, report);
  console.log(`\nCalibration ${report.summary.pass ? "PASS" : "FAIL"}: ${passed}/${rows.length}`);
  console.log(`Report written: ${path}`);
  process.exit(report.summary.pass ? 0 : 1);
}

main().catch((error) => {
  console.error("Ax group reception calibration failed:", error);
  process.exit(1);
});
