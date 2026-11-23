import { describe, expect, it } from "vitest";
import { paletteAuthentic } from "../src/mechanisms/palette.js";
import type { ActKind } from "../src/mind/affordances.js";
import { emptyChat } from "../src/mind/state.js";

const T0 = 1_772_570_000_000;
const HOUR = 60 * 60_000;
const OFFERED: ActKind[] = ["send", "sticker", "react", "feel", "think", "let-go"];

describe("paletteAuthentic", () => {
  it("shifts registers away from bubbly chatter and keeps hurt-silence in private after hostile tone", () => {
    const dm = emptyChat("telegram:998404", "private", true);
    const next = paletteAuthentic.reduce?.(paletteAuthentic.initial, {
      type: "message.perceived",
      at: T0,
      scope: "telegram:998404",
      messageId: "m1",
      tone: "hostile",
    });

    const contrib = paletteAuthentic.contribute?.(dm, T0 + 60_000, next, OFFERED)[0];
    expect(contrib).toBeDefined();
    if (!contrib) return;
    const scenes = (contrib.examples ?? []).map((e) => e.scene);
    const hasHurtSilent = (contrib.examples ?? []).some(
      (e) => e.acts.some((a) => a.kind === "feel") && !e.acts.some((a) => a.kind === "send"),
    );

    expect(contrib.style).toBe("default");
    expect(hasHurtSilent).toBe(true);
    expect(scenes.some((s) => s.includes("考上了"))).toBe(false);
    expect(scenes.some((s) => s.includes("嫌烦") || s.includes("笑料"))).toBe(true);
  });

  it("does not leak hurt-silence template into a different caring private chat", () => {
    const caringDm = emptyChat("telegram:990701", "private", true);
    const next = paletteAuthentic.reduce?.(paletteAuthentic.initial, {
      type: "message.perceived",
      at: T0,
      scope: "telegram:-1009901",
      messageId: "m1",
      tone: "hostile",
    });

    const contrib = paletteAuthentic.contribute?.(caringDm, T0 + 60_000, next, OFFERED)[0];
    expect(contrib).toBeDefined();
    if (!contrib) return;
    const hasHurtSilent = (contrib.examples ?? []).some(
      (e) => e.acts.some((a) => a.kind === "feel") && !e.acts.some((a) => a.kind === "send"),
    );
    expect(hasHurtSilent).toBe(false);
  });

  it("recovers naturally over time without reading wall clock", () => {
    const dm = emptyChat("telegram:998404", "private", true);
    const next = paletteAuthentic.reduce?.(paletteAuthentic.initial, {
      type: "message.perceived",
      at: T0,
      scope: "telegram:998404",
      messageId: "m1",
      tone: "hostile",
    });
    const later = paletteAuthentic.contribute?.(dm, T0 + 6 * HOUR, next, OFFERED)[0];
    expect((later?.examples ?? []).length).toBeGreaterThanOrEqual(5);
  });
});
