/**
 * ADR-248 W5: auxiliary probe policy seam.
 *
 * Probe is a cost gate, not a personality gate. It may decide whether to spend
 * a large-model call only after Alice's motivation layer is weak/uncertain.
 * It must never override directed obligations or write relationship/pressure state.
 *
 * @see docs/adr/248-dcp-reference-implementation-plan/README.md
 */
export interface ProbePolicyInput {
  enabled: boolean;
  /** Motivation layer already decided the obligation is direct; probe must not silence it. */
  directlyAddressed: boolean;
  /** Motivation layer's normalized confidence that action is socially worthwhile. */
  motivationConfidence: number;
  /** Motivation layer says this is worth acting without probe. */
  strongMotivation: boolean;
  /** Auxiliary probe is only useful if there is enough context to inspect. */
  contextItemCount: number;
  /** Avoid repeatedly probing the same stale context. */
  lastProbeAtMs: number | null;
  nowMs: number;
  minProbeIntervalMs: number;
}

export type ProbePolicyDecision =
  | { type: "skip_probe"; reason: "disabled" | "directed" | "strong_motivation" | "no_context" | "cooldown" }
  | { type: "run_probe"; reason: "weak_uncertain_motivation" };

export function decideProbe(input: ProbePolicyInput): ProbePolicyDecision {
  if (!input.enabled) return { type: "skip_probe", reason: "disabled" };
  if (input.directlyAddressed) return { type: "skip_probe", reason: "directed" };
  if (input.strongMotivation) return { type: "skip_probe", reason: "strong_motivation" };
  if (input.contextItemCount <= 0) return { type: "skip_probe", reason: "no_context" };
  if (
    input.lastProbeAtMs != null &&
    input.nowMs - input.lastProbeAtMs < input.minProbeIntervalMs
  ) {
    return { type: "skip_probe", reason: "cooldown" };
  }
  if (input.motivationConfidence < 0.5) {
    return { type: "run_probe", reason: "weak_uncertain_motivation" };
  }
  return { type: "skip_probe", reason: "strong_motivation" };
}
