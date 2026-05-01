import { describe, expect, it } from "vitest";
import {
  readEmotionEpisodes,
  readEmotionState,
  recordEmotionEpisode,
} from "../src/emotion/graph.js";
import { renderEmotionProjection } from "../src/emotion/projection.js";
import {
  deriveEmotionControlPatch,
  deriveEmotionState,
  effectiveEmotionIntensityWithRepairs,
} from "../src/emotion/state.js";
import type { EmotionEpisode, EmotionKind } from "../src/emotion/types.js";
import { WorldModel } from "../src/graph/world-model.js";

const NOW = 1_700_000_000_000;

function episode(overrides: Partial<EmotionEpisode> = {}): EmotionEpisode {
  return {
    id: "e1",
    kind: "hurt",
    valence: -0.6,
    arousal: 0.4,
    intensity: 0.8,
    cause: { type: "feedback", summary: "sharp correction" },
    createdAtMs: NOW,
    halfLifeMs: 60_000,
    confidence: 0.8,
    ...overrides,
  };
}

describe("ADR-268 emotion state", () => {
  it("uses wall-clock half-life for effective intensity", () => {
    const state = deriveEmotionState([episode()], NOW + 60_000);
    expect(state.dominant?.kind).toBe("hurt");
    expect(state.dominant?.effectiveIntensity).toBeCloseTo(0.4);
  });

  it("repair acceleration reduces effective intensity without changing the episode fact", () => {
    const hurt = episode({ id: "hurt", kind: "hurt", intensity: 0.8, targetId: "channel:test" });
    const repaired = effectiveEmotionIntensityWithRepairs(hurt, NOW + 60_000, [
      {
        id: "repair",
        repairKind: "apology",
        emotionKind: "hurt",
        targetId: "channel:test",
        strength: 0.8,
        confidence: 1,
        createdAtMs: NOW + 30_000,
        cause: { type: "feedback", summary: "apology" },
      },
    ]);
    const natural = effectiveEmotionIntensityWithRepairs(hurt, NOW + 60_000, []);
    expect(repaired).toBeLessThan(natural * 0.6);
    expect(hurt.intensity).toBe(0.8);
  });

  it("selects dominant plus non-redundant secondary emotion", () => {
    const state = deriveEmotionState(
      [
        episode({ id: "hurt", kind: "hurt", intensity: 0.7 }),
        episode({ id: "tired", kind: "tired", valence: -0.3, intensity: 0.5 }),
      ],
      NOW,
    );
    expect(state.dominant?.kind).toBe("hurt");
    expect(state.secondary?.kind).toBe("tired");
  });

  it("does not expose internal ids or scalar fields in normal prompt projection", () => {
    const state = deriveEmotionState([episode({ id: "secret-id" })], NOW);
    const projection = renderEmotionProjection(state);
    expect(projection).toContain("stings");
    expect(projection).not.toContain("secret-id");
    expect(projection).not.toContain("valence");
    expect(projection).not.toContain("emotion_kind");
  });

  it("maps hurt and tired to bounded control modulation", () => {
    const state = deriveEmotionState(
      [
        episode({ id: "hurt", kind: "hurt", intensity: 0.7 }),
        episode({ id: "tired", kind: "tired", valence: -0.3, intensity: 0.5 }),
      ],
      NOW,
    );
    const patch = deriveEmotionControlPatch(state);
    expect(patch.voiceBias.caution).toBeGreaterThan(0);
    expect(patch.voiceBias.sociability).toBeLessThan(0);
    expect(patch.styleBudget.maxCharsMultiplier).toBeLessThan(1);
    expect(patch.styleBudget.avoidSelfProof).toBe(true);
    expect(patch.styleBudget.avoidCruelty).toBe(true);
  });

  it("maps every ADR-owned emotion to a behaviorally distinct control direction", () => {
    const patchFor = (kind: EmotionKind) =>
      deriveEmotionControlPatch(
        deriveEmotionState([episode({ id: kind, kind, intensity: 0.8 })], NOW),
      );

    const pleased = patchFor("pleased");
    expect(pleased.voiceBias.sociability).toBeGreaterThan(0);
    expect(pleased.voiceBias.caution).toBeLessThan(0);
    expect(pleased.actionCaps.proactiveMessages).toBeNull();

    const touched = patchFor("touched");
    expect(touched.voiceBias.sociability).toBeGreaterThan(0);
    expect(touched.styleBudget.allowVulnerability).toBe(true);

    const shy = patchFor("shy");
    expect(shy.styleBudget.preferShort).toBe(true);
    expect(shy.styleBudget.maxCharsMultiplier).toBeLessThan(1);

    const lonely = patchFor("lonely");
    expect(lonely.voiceBias.sociability).toBeGreaterThan(0);
    expect(lonely.actionCaps.proactiveMessages).toBe(1);

    const hurt = patchFor("hurt");
    expect(hurt.voiceBias.caution).toBeGreaterThan(0);
    expect(hurt.styleBudget.avoidSelfProof).toBe(true);

    const uneasy = patchFor("uneasy");
    expect(uneasy.voiceBias.caution).toBeGreaterThan(0);
    expect(uneasy.voiceBias.reflection).toBeGreaterThan(0);

    const annoyed = patchFor("annoyed");
    expect(annoyed.voiceBias.sociability).toBeLessThan(0);
    expect(annoyed.styleBudget.preferShort).toBe(true);
    expect(annoyed.styleBudget.avoidCruelty).toBe(true);

    const tired = patchFor("tired");
    expect(tired.voiceBias.sociability).toBeLessThan(0);
    expect(tired.styleBudget.preferShort).toBe(true);

    const flat = patchFor("flat");
    expect(flat.voiceBias.sociability).toBeLessThan(0);
    expect(flat.voiceBias.reflection).toBeGreaterThan(0);
    expect(flat.styleBudget.preferShort).toBe(true);
  });

  it("records graph-backed episodes and derives current state", () => {
    const G = new WorldModel();
    G.addAgent("self");
    recordEmotionEpisode(G, {
      kind: "touched",
      intensity: 0.6,
      nowMs: NOW,
      cause: { type: "feedback", summary: "warm return" },
    });
    expect(readEmotionEpisodes(G)).toHaveLength(1);
    expect(readEmotionState(G, NOW).dominant?.kind).toBe("touched");
  });

  it("transient graph cache is capped and is not the append-only fact ledger", () => {
    const G = new WorldModel();
    G.addAgent("self");
    for (let i = 0; i < 40; i++) {
      recordEmotionEpisode(G, {
        id: `transient-${i}`,
        kind: "flat",
        intensity: 0.3,
        nowMs: NOW + i,
        cause: { type: "memory", summary: `transient ${i}` },
      });
    }
    expect(readEmotionEpisodes(G)).toHaveLength(32);
    expect(readEmotionEpisodes(G)[0]?.id).toBe("transient-8");
  });

  it("lonely creates connection pull with a proactive cap", () => {
    const state = deriveEmotionState(
      [episode({ kind: "lonely", valence: -0.45, intensity: 0.6 })],
      NOW,
    );
    const patch = deriveEmotionControlPatch(state);
    expect(patch.voiceBias.sociability).toBeGreaterThan(0);
    expect(patch.actionCaps.proactiveMessages).toBe(1);
  });
});
