import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, initDb } from "../src/db/connection.js";
import { actionLog, candidateTrace, silenceLog } from "../src/db/schema.js";
import { counterfactualD5 } from "../src/diagnostics/counterfactual.js";

beforeEach(() => initDb(":memory:"));
afterEach(() => closeDb());

describe("counterfactualD5", () => {
  it("prefers typed candidate_trace over legacy silence_log", () => {
    getDb()
      .insert(silenceLog)
      .values({
        tick: 1,
        voice: "curiosity",
        target: "channel:legacy",
        reason: "legacy",
        deltaP: 10,
        socialCost: 1,
      })
      .run();
    getDb()
      .insert(candidateTrace)
      .values({
        candidateId: "candidate:2:curiosity:channel:typed",
        tick: 2,
        targetNamespace: "channel",
        targetId: "typed",
        actionType: "curiosity",
        normalizedConsiderationsJson: "{}",
        deltaP: 0.5,
        socialCost: 0.9,
        netValue: 0.4,
        bottleneck: "social_cost",
        gatePlane: "policy",
        selected: false,
        silenceReason: "active_cooling",
        sampleStatus: "real",
      })
      .run();
    getDb()
      .insert(actionLog)
      .values({ tick: 3, voice: "curiosity", actionType: "send_message", success: true })
      .run();

    const report = counterfactualD5();

    expect(report.source).toBe("candidate_trace");
    expect(report.sampleStatus).toBe("real");
    expect(report.totalSilenceSamples).toBe(1);
    expect(report.nonApplicableSilences).toBe(0);
    expect(report.applicableSilences).toBe(1);
    expect(report.analyzableSilences).toBe(1);
    expect(report.flippedActions).toBe(1);
    expect(report.coolingGate.analyzable).toBe(1);
    expect(report.coolingGate.flipped).toBe(1);
    expect(report.socialCost.analyzable).toBe(0);
    expect(report.flipsByTarget["channel:typed"]).toBe(1);
    expect(report.sampleQualityByReason.active_cooling).toMatchObject({
      total: 1,
      applicable: 1,
      analyzable: 1,
    });
    expect(report.frequencyMultiplier).toBe(2);
  });

  it("marks typed D5 samples as partial when numeric counterfactual fields are missing", () => {
    getDb()
      .insert(candidateTrace)
      .values({
        candidateId: "candidate:4:sociability:channel:partial",
        tick: 4,
        targetNamespace: "channel",
        targetId: "partial",
        actionType: "sociability",
        normalizedConsiderationsJson: "{}",
        gatePlane: "policy",
        selected: false,
        silenceReason: "active_cooling",
        sampleStatus: "partial",
      })
      .run();

    const report = counterfactualD5();

    expect(report.source).toBe("candidate_trace");
    expect(report.sampleStatus).toBe("partial");
    expect(report.totalSilenceSamples).toBe(1);
    expect(report.nonApplicableSilences).toBe(0);
    expect(report.applicableSilences).toBe(1);
    expect(report.partialSilences).toBe(1);
    expect(report.analyzableSilences).toBe(0);
    expect(report.coolingGate.partial).toBe(1);
    expect(report.coolingGate.analyzable).toBe(0);
    expect(report.sampleQualityByReason.active_cooling).toMatchObject({
      total: 1,
      applicable: 1,
      partial: 1,
    });
  });

  it("treats no-candidate silence as not applicable to D5 counterfactuals", () => {
    getDb()
      .insert(candidateTrace)
      .values({
        candidateId: "candidate:5:sociability:channel:none",
        tick: 5,
        targetNamespace: "channel",
        targetId: "none",
        actionType: "sociability",
        normalizedConsiderationsJson: "{}",
        gatePlane: "policy",
        selected: false,
        silenceReason: "all_candidates_negative",
        sampleStatus: "partial",
      })
      .run();

    const report = counterfactualD5();

    expect(report.source).toBe("candidate_trace");
    expect(report.sampleStatus).toBe("empty");
    expect(report.totalSilenceSamples).toBe(1);
    expect(report.nonApplicableSilences).toBe(1);
    expect(report.applicableSilences).toBe(0);
    expect(report.partialSilences).toBe(0);
    expect(report.analyzableSilences).toBe(0);
    expect(report.sampleQualityByReason.all_candidates_negative).toMatchObject({
      total: 1,
      nonApplicable: 1,
    });
  });

  it("separates social-cost counterfactuals from cooling-gate counterfactuals", () => {
    getDb()
      .insert(candidateTrace)
      .values({
        candidateId: "candidate:6:curiosity:channel:social",
        tick: 6,
        targetNamespace: "channel",
        targetId: "social",
        actionType: "curiosity",
        normalizedConsiderationsJson: "{}",
        deltaP: 0.3,
        socialCost: 0.8,
        netValue: -0.5,
        bottleneck: "social_cost",
        gatePlane: "policy",
        selected: false,
        silenceReason: "social_cost",
        sampleStatus: "real",
      })
      .run();
    getDb()
      .insert(actionLog)
      .values({ tick: 7, voice: "curiosity", actionType: "send_message", success: true })
      .run();

    const report = counterfactualD5();

    expect(report.coolingGate.analyzable).toBe(0);
    expect(report.socialCost.analyzable).toBe(1);
    expect(report.socialCost.flipped).toBe(1);
    expect(report.socialCost.flipRate).toBe(1);
    expect(report.frequencyMultiplier).toBe(2);
  });

  it("counts losing candidates with social-safety bottleneck as social-cost samples", () => {
    getDb()
      .insert(candidateTrace)
      .values([
        {
          candidateId: "candidate:8:sociability:channel:social:rank:1",
          tick: 8,
          targetNamespace: "channel",
          targetId: "social",
          actionType: "sociability",
          normalizedConsiderationsJson: "{}",
          deltaP: 0.4,
          socialCost: 0.9,
          netValue: 0.2,
          bottleneck: "U_social_safety",
          gatePlane: "iaus_competition",
          selected: false,
          candidateRank: 1,
          silenceReason: "lost_candidate",
          sampleStatus: "real",
        },
        {
          candidateId: "candidate:8:curiosity:channel:other:rank:2",
          tick: 8,
          targetNamespace: "channel",
          targetId: "other",
          actionType: "curiosity",
          normalizedConsiderationsJson: "{}",
          deltaP: 0.4,
          socialCost: 0.1,
          netValue: 0.3,
          bottleneck: "U_freshness",
          gatePlane: "iaus_competition",
          selected: false,
          candidateRank: 2,
          silenceReason: "lost_candidate",
          sampleStatus: "real",
        },
      ])
      .run();
    getDb()
      .insert(actionLog)
      .values({ tick: 9, voice: "curiosity", actionType: "send_message", success: true })
      .run();

    const report = counterfactualD5();

    expect(report.coolingGate.analyzable).toBe(0);
    expect(report.socialCost.total).toBe(1);
    expect(report.socialCost.analyzable).toBe(1);
    expect(report.socialCost.flipped).toBe(1);
    expect(report.socialCost.flipsByReason.lost_candidate).toMatchObject({
      total: 1,
      flipped: 1,
      rate: 1,
    });
    expect(report.flipsByTarget["channel:social"]).toBe(1);
  });

  it("reports social-safety rank ablation when removing U_social_safety changes the tick winner", () => {
    getDb()
      .insert(candidateTrace)
      .values([
        {
          candidateId: "candidate:10:curiosity:channel:winner",
          tick: 10,
          targetNamespace: "channel",
          targetId: "winner",
          actionType: "curiosity",
          normalizedConsiderationsJson: JSON.stringify({ U_info_pressure: 0.8 }),
          deltaP: 0.2,
          socialCost: 0.1,
          netValue: 0.8,
          bottleneck: "U_info_pressure",
          gatePlane: "none",
          selected: true,
          candidateRank: 0,
          silenceReason: "N/A",
          sampleStatus: "real",
        },
        {
          candidateId: "candidate:10:sociability:channel:social:rank:1",
          tick: 10,
          targetNamespace: "channel",
          targetId: "social",
          actionType: "sociability",
          normalizedConsiderationsJson: JSON.stringify({
            U_social_safety: 0.1,
            U_social_bond: 1,
            U_goldilocks: 1,
          }),
          deltaP: 0.2,
          socialCost: 0.8,
          netValue: 0.7,
          bottleneck: "U_social_safety",
          gatePlane: "iaus_competition",
          selected: false,
          candidateRank: 1,
          silenceReason: "lost_candidate",
          sampleStatus: "real",
        },
      ])
      .run();

    const report = counterfactualD5();

    expect(report.socialSafetyRankAblation.totalPools).toBe(1);
    expect(report.socialSafetyRankAblation.analyzablePools).toBe(1);
    expect(report.socialSafetyRankAblation.socialSafetyCandidateCount).toBe(1);
    expect(report.socialSafetyRankAblation.changedTop).toBe(1);
    expect(report.socialSafetyRankAblation.changeRate).toBe(1);
    expect(report.socialSafetyRankAblation.topChanges[0]).toMatchObject({
      tick: 10,
      original: { action: "curiosity", target: "channel:winner" },
      counterfactual: { action: "sociability", target: "channel:social" },
    });
  });

  it("reports social-safety rank ablation without overstating when the winner is unchanged", () => {
    getDb()
      .insert(candidateTrace)
      .values([
        {
          candidateId: "candidate:11:curiosity:channel:winner",
          tick: 11,
          targetNamespace: "channel",
          targetId: "winner",
          actionType: "curiosity",
          normalizedConsiderationsJson: JSON.stringify({ U_info_pressure: 0.8 }),
          deltaP: 0.2,
          socialCost: 0.1,
          netValue: 2.0,
          bottleneck: "U_info_pressure",
          gatePlane: "none",
          selected: true,
          candidateRank: 0,
          silenceReason: "N/A",
          sampleStatus: "real",
        },
        {
          candidateId: "candidate:11:sociability:channel:social:rank:1",
          tick: 11,
          targetNamespace: "channel",
          targetId: "social",
          actionType: "sociability",
          normalizedConsiderationsJson: JSON.stringify({
            U_social_safety: 0.9,
            U_social_bond: 1,
            U_goldilocks: 1,
          }),
          deltaP: 0.2,
          socialCost: 0.8,
          netValue: 0.7,
          bottleneck: "U_goldilocks",
          gatePlane: "iaus_competition",
          selected: false,
          candidateRank: 1,
          silenceReason: "lost_candidate",
          sampleStatus: "real",
        },
      ])
      .run();

    const report = counterfactualD5();

    expect(report.socialSafetyRankAblation.analyzablePools).toBe(1);
    expect(report.socialSafetyRankAblation.socialSafetyCandidateCount).toBe(1);
    expect(report.socialSafetyRankAblation.changedTop).toBe(0);
    expect(report.socialSafetyRankAblation.topChanges).toEqual([]);
  });
});
