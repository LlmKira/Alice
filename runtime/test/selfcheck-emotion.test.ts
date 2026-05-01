import { describe, expect, it } from "vitest";
import { recordEmotionEpisode } from "../src/emotion/graph.js";
import { WorldModel } from "../src/graph/world-model.js";
import { getSelfcheckData } from "../src/telegram/apps/selfcheck.js";

const NOW = 1_700_000_000_000;

describe("ADR-268 selfcheck emotion projection", () => {
  it("uses active emotion projection instead of legacy mood fallback", () => {
    const G = new WorldModel();
    G.addAgent("self", { mood_valence: 0.8, mood_effective: 0.8, mood_arousal: 0.9 });
    recordEmotionEpisode(G, {
      kind: "tired",
      intensity: 0.7,
      nowMs: NOW,
      cause: { type: "overload", summary: "too much recent input" },
    });

    const result = getSelfcheckData(G, NOW, 100, "mood");
    const lines = result.sections[0]?.lines ?? [];
    expect(lines.join("\n")).toContain("low on energy");
    expect(lines.join("\n")).toContain("recent cause");
    expect(lines.join("\n")).not.toContain("emotion_kind");
    expect(lines.join("\n")).not.toContain("valence");
    expect(lines.join("\n")).not.toContain("Legacy mood fallback");
  });

  it("does not treat legacy scalar as current mood when no active episode exists", () => {
    const G = new WorldModel();
    G.addAgent("self", { mood_valence: -0.4, mood_effective: -0.3, mood_arousal: 0.2 });

    const result = getSelfcheckData(G, NOW, 100, "mood");
    const lines = result.sections[0]?.lines ?? [];
    expect(lines.join("\n")).toContain("No active self emotion episode");
    expect(lines.join("\n")).not.toContain("Legacy mood fallback");
    expect(lines[0]).toContain("neutral");
  });
});
