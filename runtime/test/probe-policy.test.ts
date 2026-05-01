import { describe, expect, it } from "vitest";
import { decideProbe, type ProbePolicyInput } from "../src/probe/policy.js";

const base = (overrides: Partial<ProbePolicyInput> = {}): ProbePolicyInput => ({
  enabled: true,
  directlyAddressed: false,
  motivationConfidence: 0.2,
  strongMotivation: false,
  contextItemCount: 3,
  lastProbeAtMs: null,
  nowMs: 10_000,
  minProbeIntervalMs: 1_000,
  ...overrides,
});

describe("auxiliary probe policy", () => {
  it("runs only for weak uncertain motivation", () => {
    expect(decideProbe(base())).toEqual({
      type: "run_probe",
      reason: "weak_uncertain_motivation",
    });
  });

  it("never probes directly addressed contexts", () => {
    expect(decideProbe(base({ directlyAddressed: true }))).toEqual({
      type: "skip_probe",
      reason: "directed",
    });
  });

  it("does not probe when Alice already has strong motivation", () => {
    expect(decideProbe(base({ strongMotivation: true, motivationConfidence: 0.9 }))).toEqual({
      type: "skip_probe",
      reason: "strong_motivation",
    });
  });

  it("respects context absence and cooldown", () => {
    expect(decideProbe(base({ contextItemCount: 0 }))).toEqual({
      type: "skip_probe",
      reason: "no_context",
    });
    expect(decideProbe(base({ lastProbeAtMs: 9_500 }))).toEqual({
      type: "skip_probe",
      reason: "cooldown",
    });
  });
});
