/**
 * ADR-262 Wave 3D: optional real-model replay CLI for social case scenarios.
 *
 * Dry-run mode validates prompt construction only. Real-model mode calls the
 * configured provider to produce candidate scripts, then grades them with the
 * deterministic oracle from replay-eval.ts.
 *
 * @see docs/adr/262-social-case-management/README.md
 */
import { parseArgs } from "node:util";
import { generateText } from "ai";
import { loadConfig } from "../config.js";
import { selectProviderForFirstPass, initProviders } from "../llm/client.js";
import { normalizeScript } from "../llm/schemas.js";
import {
  runSocialCaseReplaySuite,
  type SocialCaseReplayProviderInput,
  selectSocialCaseReplayScenarios,
} from "./replay-runner.js";

const rawArgs = process.argv.slice(2);
if (rawArgs[0] === "--") rawArgs.shift();

const { values } = parseArgs({
  args: rawArgs,
  options: {
    "dry-run": { type: "boolean", default: false },
    id: { type: "string" },
    prefix: { type: "string" },
    limit: { type: "string" },
    repeat: { type: "string", short: "r", default: "1" },
    temperature: { type: "string", short: "t", default: "0" },
    timeout: { type: "string", default: "120000" },
    json: { type: "boolean", default: false },
    "stop-on-failure": { type: "boolean", default: false },
  },
  strict: false,
  allowPositionals: true,
});

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function renderFailedChecks(checks: readonly { name: string; actual: string }[]): string {
  return checks.map((check) => `${check.name}=${check.actual}`).join("; ");
}

async function callReplayLLM(input: SocialCaseReplayProviderInput): Promise<string> {
  const temperature = Number.parseFloat(values.temperature as string) || 0;
  const timeout = Number.parseInt(values.timeout as string, 10) || 120_000;
  const { provider, model } = selectProviderForFirstPass();
  const { text } = await generateText({
    model: provider(model),
    system: input.system,
    prompt: input.prompt,
    temperature,
    abortSignal: AbortSignal.timeout(timeout),
  });
  return normalizeScript(text);
}

async function main(): Promise<void> {
  const scenarios = selectSocialCaseReplayScenarios({
    id: values.id as string | undefined,
    prefix: values.prefix as string | undefined,
    limit: parsePositiveInt(values.limit),
  });
  if (scenarios.length === 0) {
    throw new Error("No social case replay scenarios selected.");
  }
  const iterations = parsePositiveInt(values.repeat) ?? 1;

  const dryRun = Boolean(values["dry-run"]);
  if (!dryRun) {
    initProviders(loadConfig());
  }

  console.log("ADR-262 Social Case Replay");
  console.log(`  mode=${dryRun ? "dry-run prompt contract" : "real-model candidate replay"}`);
  console.log(`  scenarios=${scenarios.length}`);
  console.log(`  repeat=${iterations}`);
  if (values.id) console.log(`  id=${values.id}`);
  if (values.prefix) console.log(`  prefix=${values.prefix}`);
  console.log("");

  const result = await runSocialCaseReplaySuite({
    scenarios,
    candidateProvider: dryRun ? undefined : callReplayLLM,
    stopOnFailure: Boolean(values["stop-on-failure"]),
    iterations,
  });

  for (const run of result.runs) {
    const candidateStatus = run.candidate ? (run.candidate.pass ? "PASS" : "FAIL") : "SKIP";
    const iterationLabel = iterations > 1 ? `#${run.iteration}` : "";
    console.log(
      `${run.pass ? "PASS" : "FAIL"} ${run.scenarioId}${iterationLabel} prompt=${
        run.prompt.pass ? "PASS" : "FAIL"
      } candidate=${candidateStatus}`,
    );
    const failedPrompt = run.prompt.checks.filter((check) => !check.pass);
    const failedCandidate = run.candidate?.checks.filter((check) => !check.pass) ?? [];
    if (failedPrompt.length > 0) {
      console.log(`  prompt: ${renderFailedChecks(failedPrompt)}`);
    }
    if (failedCandidate.length > 0) {
      console.log(`  candidate: ${renderFailedChecks(failedCandidate)}`);
    }
    if (run.error) {
      console.log(`  error: ${run.error}`);
    }
  }

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  }

  process.exit(result.pass ? 0 : 1);
}

main().catch((error) => {
  console.error("Social case replay failed:", error);
  process.exit(2);
});
