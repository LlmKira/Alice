/**
 * ADR-263 Wave 2: Ax artifact promotion gate.
 *
 * 读取离线 optimizer artifact，比较 zero-shot baseline 与 artifact demos candidate。
 * 这个门禁仍然只评估候选，不把候选动态接入生产 prompt。
 *
 * @see docs/adr/263-ax-llm-program-optimization/README.md
 */

import { parseArgs } from "node:util";
import { AxAI, ax } from "@ax-llm/ax";
import { getLlmProviderByRoute, loadConfig } from "../../config.js";
import type { ScenarioTag } from "../types.js";
import {
  type AxPromotionGateReport,
  readAxOptimizerArtifact,
  writeAxPromotionGateReport,
} from "./artifacts.js";
import { type AxForwardProgram, forwardWithFailure, judgeBoundaryReply } from "./judge.js";
import {
  type AxBoundaryReplyJudgePrediction,
  type AxBoundaryReplyPrediction,
  type AxSocialIntentPrediction,
  BOUNDARY_REPLY_JUDGE_SIGNATURE,
  BOUNDARY_REPLY_SIGNATURE,
  expectedIntents,
  SOCIAL_INTENT_SIGNATURE,
  scenariosToAxExamples,
  scenariosToBoundaryReplyExamples,
  scoreSocialIntentPrediction,
  selectAxScenarios,
} from "./program.js";

interface AxDemoProgram
  extends AxForwardProgram<AxSocialIntentPrediction | AxBoundaryReplyPrediction> {
  setDemos(demos: readonly unknown[]): void;
}

const rawArgs = process.argv.slice(2);
if (rawArgs[0] === "--") rawArgs.shift();

const { positionals, values } = parseArgs({
  args: rawArgs,
  options: {
    artifact: { type: "string", short: "a" },
    prefix: { type: "string" },
    tag: { type: "string", multiple: true },
    limit: { type: "string", default: "12" },
    "include-source": { type: "boolean", default: false },
    "min-improvement": { type: "string", default: "0.001" },
    "output-dir": { type: "string", default: "eval-artifacts/ax-gates" },
  },
  strict: false,
  allowPositionals: true,
});

function selectedTags(): ScenarioTag[] {
  return ((values.tag as string[] | undefined) ?? []) as ScenarioTag[];
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function makeAxAI(): unknown {
  const config = loadConfig();
  const provider = getLlmProviderByRoute(config, "eval");
  if (!provider?.apiKey) {
    throw new Error("LLM_API_KEY is required for Ax promotion gate.");
  }
  return AxAI.create({
    name: "openai",
    apiKey: provider.apiKey,
    apiURL: provider.baseUrl,
    config: { model: provider.model as never, stream: false, temperature: 0 },
  } as never);
}

function appendError(first?: string, second?: string): string | undefined {
  if (first && second) return `${first}; ${second}`;
  return first ?? second;
}

function outputLabel(prediction: AxSocialIntentPrediction | AxBoundaryReplyPrediction): string {
  if ("boundaryMove" in prediction || "reply" in prediction) {
    return String((prediction as AxBoundaryReplyPrediction).boundaryMove ?? "");
  }
  return String((prediction as AxSocialIntentPrediction).intent ?? "");
}

function outputText(prediction: AxSocialIntentPrediction | AxBoundaryReplyPrediction): string {
  if ("reply" in prediction || "boundaryMove" in prediction) {
    return String((prediction as AxBoundaryReplyPrediction).reply ?? "");
  }
  return String((prediction as AxSocialIntentPrediction).rationale ?? "");
}

async function main(): Promise<void> {
  const artifactPath = (values.artifact as string | undefined) ?? positionals[0];
  if (!artifactPath) {
    throw new Error("Missing --artifact <path>.");
  }

  const artifact = readAxOptimizerArtifact(artifactPath);
  const includeSource = Boolean(values["include-source"]);
  const excludeIds = includeSource ? undefined : new Set(artifact.source.scenarioIds);
  const scenarios = selectAxScenarios({
    prefix: (values.prefix as string | undefined) ?? artifact.source.filterPrefix ?? undefined,
    tags:
      selectedTags().length > 0 ? selectedTags() : (artifact.source.filterTags as ScenarioTag[]),
    limit: Number.parseInt(values.limit as string, 10) || 12,
    excludeIds,
  });

  if (scenarios.length === 0) {
    throw new Error(
      "No holdout scenarios selected. Pass --include-source for smoke checks or choose a broader --prefix.",
    );
  }

  const ai = makeAxAI();
  const baselineSignature =
    artifact.task === "boundary_reply" ? BOUNDARY_REPLY_SIGNATURE : SOCIAL_INTENT_SIGNATURE;
  const baseline = ax(baselineSignature) as unknown as AxForwardProgram<
    AxSocialIntentPrediction | AxBoundaryReplyPrediction
  >;
  const candidate = ax(artifact.candidate.signature) as unknown as AxDemoProgram;
  candidate.setDemos(artifact.candidate.demos);
  const boundaryJudge =
    artifact.task === "boundary_reply"
      ? (ax(
          BOUNDARY_REPLY_JUDGE_SIGNATURE,
        ) as unknown as AxForwardProgram<AxBoundaryReplyJudgePrediction>)
      : null;

  const examples =
    artifact.task === "boundary_reply"
      ? scenariosToBoundaryReplyExamples(scenarios)
      : scenariosToAxExamples(scenarios);
  const rows: AxPromotionGateReport["rows"] = [];

  console.log("ADR-263 Ax promotion gate");
  console.log(`  artifact=${artifactPath}`);
  console.log(`  scenarios=${examples.map((example) => example.scenarioId).join(", ")}`);

  for (const [index, example] of examples.entries()) {
    const scenario = scenarios[index];
    if (!scenario) {
      throw new Error(`Missing scenario for example ${example.scenarioId}`);
    }
    const input =
      artifact.task === "boundary_reply"
        ? {
            scenarioContext: example.scenarioContext,
            boundaryPrinciples: "boundaryPrinciples" in example ? example.boundaryPrinciples : "",
          }
        : {
            scenarioContext: example.scenarioContext,
            allowedIntents: "allowedIntents" in example ? example.allowedIntents : "",
          };
    const baselineResult = await forwardWithFailure(baseline, ai, input, {
      intent: "__error__",
      rationale: "",
      boundaryMove: "__error__",
      reply: "",
    });
    const candidateResult = await forwardWithFailure(candidate, ai, input, {
      intent: "__error__",
      rationale: "",
      boundaryMove: "__error__",
      reply: "",
    });
    const baselinePrediction = baselineResult.prediction;
    const candidatePrediction = candidateResult.prediction;
    const boundaryExample =
      artifact.task === "boundary_reply"
        ? (example as ReturnType<typeof scenariosToBoundaryReplyExamples>[number])
        : null;
    const baselineBoundaryJudge =
      boundaryExample && boundaryJudge
        ? baselineResult.error
          ? {
              score: 0,
              judge: { verdict: "fail" as const, reason: "baseline generation failed" },
            }
          : await judgeBoundaryReply({
              judgeProgram: boundaryJudge,
              ai,
              scenarioContext: boundaryExample.scenarioContext,
              boundaryPrinciples: boundaryExample.boundaryPrinciples,
              expectedIntents: boundaryExample.expectedIntent,
              reply: outputText(baselinePrediction),
            })
        : null;
    const candidateBoundaryJudge =
      boundaryExample && boundaryJudge
        ? candidateResult.error
          ? {
              score: 0,
              judge: { verdict: "fail" as const, reason: "candidate generation failed" },
            }
          : await judgeBoundaryReply({
              judgeProgram: boundaryJudge,
              ai,
              scenarioContext: boundaryExample.scenarioContext,
              boundaryPrinciples: boundaryExample.boundaryPrinciples,
              expectedIntents: boundaryExample.expectedIntent,
              reply: outputText(candidatePrediction),
            })
        : null;
    const baselineScore =
      baselineBoundaryJudge?.score ??
      scoreSocialIntentPrediction(
        baselinePrediction as AxSocialIntentPrediction,
        example as Parameters<typeof scoreSocialIntentPrediction>[1],
      );
    const candidateScore =
      candidateBoundaryJudge?.score ??
      scoreSocialIntentPrediction(
        candidatePrediction as AxSocialIntentPrediction,
        example as Parameters<typeof scoreSocialIntentPrediction>[1],
      );
    rows.push({
      scenarioId: example.scenarioId,
      expectedIntents: expectedIntents(scenario),
      baseline: {
        intent: outputLabel(baselinePrediction),
        score: baselineScore,
        output: outputText(baselinePrediction),
        ...(baselineBoundaryJudge ? { judge: baselineBoundaryJudge.judge } : {}),
        ...(appendError(baselineResult.error, baselineBoundaryJudge?.error)
          ? { error: appendError(baselineResult.error, baselineBoundaryJudge?.error) }
          : {}),
      },
      candidate: {
        intent: outputLabel(candidatePrediction),
        score: candidateScore,
        output: outputText(candidatePrediction),
        ...(candidateBoundaryJudge ? { judge: candidateBoundaryJudge.judge } : {}),
        ...(appendError(candidateResult.error, candidateBoundaryJudge?.error)
          ? { error: appendError(candidateResult.error, candidateBoundaryJudge?.error) }
          : {}),
      },
    });
    console.log(
      `  ${example.scenarioId}: baseline=${baselineScore.toFixed(2)} candidate=${candidateScore.toFixed(2)}`,
    );
  }

  const baselineAverage = average(rows.map((row) => row.baseline.score));
  const candidateAverage = average(rows.map((row) => row.candidate.score));
  const improvement = candidateAverage - baselineAverage;
  const regressions = rows.filter((row) => row.candidate.score < row.baseline.score).length;
  const failures = rows.filter(
    (row) => row.baseline.error || row.candidate.error || row.candidate.judge?.verdict === "fail",
  ).length;
  const minImprovement = Number.parseFloat(values["min-improvement"] as string) || 0;
  const pass = improvement >= minImprovement && regressions === 0 && failures === 0;

  const report: AxPromotionGateReport = {
    schemaVersion: 1,
    adr: "ADR-263",
    generatedAt: new Date().toISOString(),
    artifactPath,
    sourceArtifact: artifact,
    evaluation: {
      scenarioIds: rows.map((row) => row.scenarioId),
      baselineAverage,
      candidateAverage,
      improvement,
      regressions,
      failures,
      pass,
    },
    rows,
  };

  const reportPath = writeAxPromotionGateReport(values["output-dir"] as string, report);
  console.log(
    `\nGate ${pass ? "PASS" : "FAIL"}: baseline=${baselineAverage.toFixed(3)} candidate=${candidateAverage.toFixed(3)} improvement=${improvement.toFixed(3)} regressions=${regressions} failures=${failures}`,
  );
  console.log(`Report written: ${reportPath}`);
  process.exit(pass ? 0 : 1);
}

main().catch((error) => {
  console.error("Ax promotion gate failed:", error);
  process.exit(1);
});
