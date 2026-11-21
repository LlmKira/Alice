import { describe, expect, it } from "vitest";
import { decodeEvent } from "../src/journal.js";
import { NOISE_KEYS, normalCdf, ou, ouStep } from "../src/mind/noise.js";
import { noiseSource } from "../src/noise-source.js";

describe("her own randomness", () => {
  it("the same seed draws the same numbers, so a replay reproduces her day", () => {
    const a = noiseSource(7);
    const b = noiseSource(7);
    for (let i = 0; i < 5; i++) expect(a()).toEqual(b());
    expect(Object.keys(noiseSource(7)()).sort()).toEqual([...NOISE_KEYS].sort());
  });

  it("draws are standard normal", () => {
    const draw = noiseSource(1);
    const xs = Array.from({ length: 20_000 }, () => draw().energy);
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
    expect(Math.abs(mean)).toBeLessThan(0.03);
    expect(Math.abs(sd - 1)).toBeLessThan(0.03);
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
  });

  it("the walk returns to its home base with the spread it was given, whatever the step", () => {
    const sd0 = 0.4;
    const p = ou({ mu: 0.3, sd: sd0, halfLife: 1.4 });
    for (const dt of [1 / 12, 1, 3]) {
      const draw = noiseSource(3);
      let x = 2;
      const xs: number[] = [];
      for (let i = 0; i < 20_000; i++) {
        x = ouStep(x, p, dt, draw().energy);
        if (i > 200) xs.push(x);
      }
      const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
      const sd = Math.sqrt(xs.reduce((s, v) => s + (v - mean) ** 2, 0) / xs.length);
      expect(Math.abs(mean - p.mu)).toBeLessThan(0.06);
      expect(Math.abs(sd - sd0) / sd0).toBeLessThan(0.08);
    }
    expect(ouStep(1, p, 0, 5)).toBe(1);
  });

  it("the journal keeps the draws", () => {
    const event = { type: "noise.drawn", at: 1, scope: "self", draws: { energy: 0.1 } };
    expect(decodeEvent("noise.drawn", "self", event)).toEqual(event);
    expect(decodeEvent("noise.drawn", "self", { ...event, draws: null })).toBeNull();
  });
});
