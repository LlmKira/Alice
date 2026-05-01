/**
 * ADR-263 Wave 1: Ax 离线优化入口。
 *
 * 这个 CLI 只产出候选 artifact，不改生产 prompt，也不接入 runtime tick。
 *
 * @see docs/adr/263-ax-llm-program-optimization/README.md
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { AxAI, AxBootstrapFewShot, AxGEPA, type AxMetricFn, ax } from "@ax-llm/ax";
import { getLlmProviderByRoute, loadConfig } from "../../config.js";
import type { ScenarioTag } from "../types.js";
import { type AxOptimizerArtifact, writeAxOptimizerArtifact } from "./artifacts.js";
import {
  type AxEvalTask,
  BOUNDARY_REPLY_SIGNATURE,
  boundaryReplyMetric,
  SOCIAL_INTENT_SIGNATURE,
  scenariosToAxExamples,
  scenariosToBoundaryReplyExamples,
  selectAxScenarios,
  socialIntentMetric,
} from "./program.js";

const require = createRequire(import.meta.url);

interface AxCompileResult {
  bestScore?: unknown;
  demos?: unknown;
  stats?: unknown;
  paretoFrontSize?: unknown;
  hypervolume?: unknown;
}

interface CompileableOptimizer {
  compile(
    program: unknown,
    examples: readonly unknown[],
    metric: AxMetricFn,
    options: Readonly<Record<string, unknown>>,
  ): Promise<AxCompileResult>;
}

const rawArgs = process.argv.slice(2);
if (rawArgs[0] === "--") rawArgs.shift();

const { values } = parseArgs({
  args: rawArgs,
  options: {
    prefix: { type: "string" },
    tag: { type: "string", multiple: true },
    limit: { type: "string", default: "12" },
    optimizer: { type: "string", default: "bootstrap" },
    task: { type: "string", default: "social_intent" },
    "max-metric-calls": { type: "string", default: "40" },
    "max-demos": { type: "string", default: "4" },
    "max-rounds": { type: "string", default: "2" },
    "output-dir": { type: "string", default: "eval-artifacts/ax" },
    verbose: { type: "boolean", default: false },
  },
  strict: false,
  allowPositionals: true,
});

function selectedTags(): ScenarioTag[] {
  return ((values.tag as string[] | undefined) ?? []) as ScenarioTag[];
}

function safeJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item) => (item === undefined ? null : item)));
}

function readAxVersion(): string {
  try {
    const entry = require.resolve("@ax-llm/ax");
    const raw = readFileSync(join(dirname(entry), "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const scenarios = selectAxScenarios({
    prefix: values.prefix as string | undefined,
    tags: selectedTags(),
    limit: Number.parseInt(values.limit as string, 10) || 12,
  });
  if (scenarios.length === 0) {
    throw new Error("No eval scenarios selected. Use --prefix or --tag less restrictively.");
  }

  const config = loadConfig();
  const provider = getLlmProviderByRoute(config, "eval");
  if (!provider?.apiKey) {
    throw new Error("LLM_API_KEY is required for Ax optimization.");
  }

  const optimizerType = values.optimizer === "gepa" ? "gepa" : "bootstrap";
  const task: AxEvalTask = values.task === "boundary_reply" ? "boundary_reply" : "social_intent";
  const maxMetricCalls = Number.parseInt(values["max-metric-calls"] as string, 10) || 40;
  const maxDemos = Number.parseInt(values["max-demos"] as string, 10) || 4;
  const maxRounds = Number.parseInt(values["max-rounds"] as string, 10) || 2;
  const verbose = Boolean(values.verbose);

  const examples =
    task === "boundary_reply"
      ? scenariosToBoundaryReplyExamples(scenarios)
      : scenariosToAxExamples(scenarios);
  const splitIndex = Math.max(1, Math.floor(examples.length * 0.7));
  const train = examples.slice(0, splitIndex);
  const validation = examples.slice(splitIndex);

  const signature = task === "boundary_reply" ? BOUNDARY_REPLY_SIGNATURE : SOCIAL_INTENT_SIGNATURE;
  const metric = task === "boundary_reply" ? boundaryReplyMetric : socialIntentMetric;
  const program = ax(signature);
  const ai = AxAI.create({
    name: "openai",
    apiKey: provider.apiKey,
    apiURL: provider.baseUrl,
    config: { model: provider.model as never, stream: false },
  } as never);

  const optimizer =
    optimizerType === "gepa"
      ? new AxGEPA({
          studentAI: ai,
          teacherAI: ai,
          numTrials: Math.max(4, maxRounds * 4),
          sampleCount: 1,
          verbose,
        })
      : new AxBootstrapFewShot({
          studentAI: ai,
          verbose,
          options: {
            maxRounds,
            maxDemos,
          },
        });

  console.log("ADR-263 Ax optimizer");
  console.log(`  task=${task}`);
  console.log(`  optimizer=${optimizerType}`);
  console.log(`  provider=${provider.name} model=${provider.model}`);
  console.log(`  train=${train.length} validation=${validation.length}`);
  console.log(`  scenarios=${scenarios.map((s) => s.id).join(", ")}`);

  const result = await (optimizer as unknown as CompileableOptimizer).compile(
    program,
    train,
    metric,
    {
      validationExamples: validation.length > 0 ? validation : train,
      maxMetricCalls,
      verbose,
    },
  );

  const artifact: AxOptimizerArtifact = {
    schemaVersion: 1,
    adr: "ADR-263",
    task,
    generatedAt: new Date().toISOString(),
    axVersion: readAxVersion(),
    provider: {
      name: provider.name,
      model: provider.model,
      baseUrl: provider.baseUrl,
    },
    optimizer: {
      type: optimizerType,
      maxMetricCalls,
      maxDemos,
      maxRounds,
    },
    source: {
      scenarioIds: scenarios.map((s) => s.id),
      filterPrefix: (values.prefix as string | undefined) ?? null,
      filterTags: selectedTags(),
    },
    metric: {
      name:
        task === "boundary_reply" ? "boundary_reply_quality" : "social_intent_match_with_brevity",
      bestScore: typeof result.bestScore === "number" ? result.bestScore : null,
    },
    candidate: {
      signature,
      demos: Array.isArray(result.demos) ? (safeJson(result.demos) as unknown[]) : [],
      rawSummary: safeJson({
        bestScore: result.bestScore ?? null,
        stats: result.stats ?? null,
        paretoFrontSize: result.paretoFrontSize ?? null,
        hypervolume: result.hypervolume ?? null,
      }),
    },
  };

  const path = writeAxOptimizerArtifact(values["output-dir"] as string, artifact);
  console.log(`\nArtifact written: ${path}`);
}

main().catch((error) => {
  console.error("Ax optimization failed:", error);
  process.exit(1);
});
