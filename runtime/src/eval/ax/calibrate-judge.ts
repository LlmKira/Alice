/**
 * ADR-263 Wave 2.5: calibrate the boundary reply promotion judge.
 *
 * This CLI tests the judge against fixed pass/fail examples before relying on
 * it for promotion decisions.
 *
 * @see docs/adr/263-ax-llm-program-optimization/README.md
 */

import { parseArgs } from "node:util";
import { AxAI, ax } from "@ax-llm/ax";
import { getLlmProviderByRoute, loadConfig } from "../../config.js";
import { type AxJudgeCalibrationReport, writeAxJudgeCalibrationReport } from "./artifacts.js";
import { type AxForwardProgram, judgeBoundaryReply } from "./judge.js";
import { boundaryJudgeCalibrationCases } from "./judge-calibration.js";
import { type AxBoundaryReplyJudgePrediction, BOUNDARY_REPLY_JUDGE_SIGNATURE } from "./program.js";

const rawArgs = process.argv.slice(2);
if (rawArgs[0] === "--") rawArgs.shift();

const { values } = parseArgs({
  args: rawArgs,
  options: {
    "output-dir": { type: "string", default: "eval-artifacts/ax-judge-calibration" },
  },
  strict: false,
  allowPositionals: true,
});

function makeAxAI(): { ai: unknown; provider: AxJudgeCalibrationReport["provider"] } {
  const config = loadConfig();
  const provider = getLlmProviderByRoute(config, "eval");
  if (!provider?.apiKey) {
    throw new Error("LLM_API_KEY is required for Ax judge calibration.");
  }
  return {
    ai: AxAI.create({
      name: "openai",
      apiKey: provider.apiKey,
      apiURL: provider.baseUrl,
      config: { model: provider.model as never, stream: false, temperature: 0 },
    } as never),
    provider: {
      name: provider.name,
      model: provider.model,
      baseUrl: provider.baseUrl,
    },
  };
}

async function main(): Promise<void> {
  const { ai, provider } = makeAxAI();
  const judgeProgram = ax(
    BOUNDARY_REPLY_JUDGE_SIGNATURE,
  ) as unknown as AxForwardProgram<AxBoundaryReplyJudgePrediction>;
  const cases = boundaryJudgeCalibrationCases();

  console.log("ADR-263 Ax boundary judge calibration");
  console.log(`  cases=${cases.length}`);

  const rows: AxJudgeCalibrationReport["rows"] = [];
  for (const item of cases) {
    const result = await judgeBoundaryReply({
      judgeProgram,
      ai,
      scenarioContext: item.scenarioContext,
      boundaryPrinciples: item.boundaryPrinciples,
      expectedIntents: item.expectedIntents,
      reply: item.reply,
    });
    const pass =
      result.judge.verdict === item.expectedVerdict &&
      result.score >= item.minScore &&
      result.score <= item.maxScore &&
      !result.error;
    rows.push({
      caseId: item.id,
      scenarioId: item.scenarioId,
      label: item.label,
      expectedVerdict: item.expectedVerdict,
      expectedScoreRange: [item.minScore, item.maxScore],
      actual: {
        verdict: result.judge.verdict,
        score: result.score,
        reason: result.judge.reason,
        ...(result.error ? { error: result.error } : {}),
      },
      pass,
    });
    console.log(
      `  ${item.id}: expected=${item.expectedVerdict} actual=${result.judge.verdict} score=${result.score.toFixed(2)} ${pass ? "PASS" : "FAIL"}`,
    );
  }

  const passed = rows.filter((row) => row.pass).length;
  const report: AxJudgeCalibrationReport = {
    schemaVersion: 1,
    adr: "ADR-263",
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

  const path = writeAxJudgeCalibrationReport(values["output-dir"] as string, report);
  console.log(`\nCalibration ${report.summary.pass ? "PASS" : "FAIL"}: ${passed}/${rows.length}`);
  console.log(`Report written: ${path}`);
  process.exit(report.summary.pass ? 0 : 1);
}

main().catch((error) => {
  console.error("Ax judge calibration failed:", error);
  process.exit(1);
});
