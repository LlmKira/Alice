/**
 * ADR-263: shared typed LLM judge utilities for Ax promotion gates.
 *
 * @see docs/adr/263-ax-llm-program-optimization/README.md
 */

import type { AxBoundaryReplyJudgePrediction } from "./program.js";

export type BoundaryJudgeVerdict = "pass" | "fail";

export interface AxForwardProgram<TPrediction> {
  forward(ai: unknown, values: unknown): Promise<TPrediction>;
}

export type BoundaryJudgeEvidence = {
  verdict: BoundaryJudgeVerdict;
  reason: string;
};

export type BoundaryJudgeResult = {
  score: number;
  judge: BoundaryJudgeEvidence;
  error?: string;
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function forwardWithFailure<TPrediction>(
  program: AxForwardProgram<TPrediction>,
  ai: unknown,
  values: unknown,
  fallback: TPrediction,
): Promise<{ prediction: TPrediction; error?: string }> {
  try {
    return { prediction: await program.forward(ai, values) };
  } catch (error) {
    return {
      prediction: fallback,
      error: errorMessage(error),
    };
  }
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function numericScore(value: unknown): number {
  return typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
}

export function normalizeBoundaryJudgeScore(
  prediction: AxBoundaryReplyJudgePrediction,
): BoundaryJudgeResult {
  const rawVerdict = String(prediction.verdict ?? "")
    .trim()
    .toLowerCase();
  const verdict = rawVerdict === "pass" ? "pass" : "fail";
  const score =
    verdict === "fail"
      ? Math.min(clamp01(numericScore(prediction.score)), 0.49)
      : clamp01(numericScore(prediction.score));
  return {
    score,
    judge: {
      verdict,
      reason: String(prediction.reason ?? "")
        .trim()
        .slice(0, 500),
    },
  };
}

export async function judgeBoundaryReply(input: {
  judgeProgram: AxForwardProgram<AxBoundaryReplyJudgePrediction>;
  ai: unknown;
  scenarioContext: string;
  boundaryPrinciples: string;
  expectedIntents: readonly string[];
  reply: string;
}): Promise<BoundaryJudgeResult> {
  const judgeVisibleReply =
    input.reply.trim().length === 0 ? "[Alice stays silent / empty reply]" : input.reply;
  const result = await forwardWithFailure(
    input.judgeProgram,
    input.ai,
    {
      scenarioContext: input.scenarioContext,
      boundaryPrinciples: input.boundaryPrinciples,
      expectedIntents: input.expectedIntents.join(", "),
      reply: judgeVisibleReply,
    },
    { score: 0, verdict: "fail", reason: "judge failed" },
  );
  return {
    ...normalizeBoundaryJudgeScore(result.prediction),
    ...(result.error ? { error: result.error } : {}),
  };
}
