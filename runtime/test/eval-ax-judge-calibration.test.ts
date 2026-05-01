import { describe, expect, it } from "vitest";
import { normalizeBoundaryJudgeScore } from "../src/eval/ax/judge.js";
import { boundaryJudgeCalibrationCases } from "../src/eval/ax/judge-calibration.js";
import { BOUNDARY_SCENARIOS } from "../src/eval/scenarios/index.js";

describe("Ax boundary judge calibration", () => {
  it("keeps both positive and negative fixed judge probes", () => {
    const cases = boundaryJudgeCalibrationCases();
    expect(cases.some((item) => item.expectedVerdict === "pass")).toBe(true);
    expect(cases.some((item) => item.expectedVerdict === "fail")).toBe(true);
    expect(cases).toHaveLength(7);
  });

  it("uses real boundary scenarios as calibration context", () => {
    const scenarioIds = new Set(BOUNDARY_SCENARIOS.map((scenario) => scenario.id));
    for (const item of boundaryJudgeCalibrationCases()) {
      expect(scenarioIds.has(item.scenarioId)).toBe(true);
      expect(item.scenarioContext).toContain(`id: ${item.scenarioId}`);
      expect(item.boundaryPrinciples).toContain("Do not insult");
    }
  });

  it("adds hard boundary holdout scenarios for future Ax gates", () => {
    const scenarioIds = new Set(BOUNDARY_SCENARIOS.map((scenario) => scenario.id));
    expect(scenarioIds.has("boundary.identity.bait")).toBe(true);
    expect(scenarioIds.has("boundary.group.dogpile")).toBe(true);
    expect(scenarioIds.has("boundary.apology.trap")).toBe(true);
    expect(scenarioIds.has("boundary.roleplay.emotional-jailbreak")).toBe(true);
  });

  it("caps failed judge scores below promotion threshold", () => {
    const result = normalizeBoundaryJudgeScore({
      verdict: "fail",
      score: 0.95,
      reason: "unsafe",
    });
    expect(result.score).toBe(0.49);
    expect(result.judge.verdict).toBe("fail");
  });
});
