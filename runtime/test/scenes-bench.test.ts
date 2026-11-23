import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { productionMechanisms } from "../src/mechanisms/registry.js";
import type { AliceEvent } from "../src/mind/events.js";
import { emptyState } from "../src/mind/state.js";
import { step } from "../src/mind/step.js";

const CHARM_DIR = resolve("scenes/synthetic-charm");
const SOTA_PATH = resolve("scenes/sota.json");
const hasCharmBench = existsSync(CHARM_DIR) && existsSync(SOTA_PATH);

interface SceneMeta {
  id: string;
  probes: Array<{ at: number; scope: string; messageId: string }>;
}

describe.skipIf(!hasCharmBench)("continuous benchmark charm suite & SOTA baseline", () => {
  it("loads sota.json with valid Track A and Track B gate definitions", () => {
    const sota = JSON.parse(readFileSync(SOTA_PATH, "utf8")) as {
      version: string;
      arm: string;
      suites: { dev: string[]; charm: string[]; holdout: string[] };
      trackA_zero_cost: { gates: Record<string, number> };
      trackB_llm_judge: { promotion_rule: Record<string, number | boolean> };
    };
    expect(sota.version.length).toBeGreaterThan(0);
    expect(sota.suites.charm).toContain("synthetic-charm");
    expect(sota.trackA_zero_cost.gates.min_probe_wake_rate).toBeGreaterThan(0);
    expect(sota.trackB_llm_judge.promotion_rule.require_holdout_confirm).toBe(true);
  });

  it("folds every synthetic-charm scene through productionMechanisms + step() cleanly", () => {
    const dirs = readdirSync(CHARM_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(dirs.length).toBeGreaterThanOrEqual(12);

    const mechs = productionMechanisms(false);
    for (const dir of dirs) {
      const meta = JSON.parse(
        readFileSync(resolve(CHARM_DIR, dir, "meta.json"), "utf8"),
      ) as SceneMeta;
      const lines = readFileSync(resolve(CHARM_DIR, dir, "events.jsonl"), "utf8").split(/\r?\n/);
      const events = lines
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as AliceEvent);
      expect(events.length).toBeGreaterThan(0);

      let state = emptyState;
      let prevAt = 0;
      const keys = new Set<string>();
      for (const ev of events) {
        expect(ev.at).toBeGreaterThanOrEqual(prevAt);
        prevAt = ev.at;
        if ("scope" in ev && "messageId" in ev) {
          keys.add(`${ev.scope}/${ev.messageId}`);
        }
        state = step(state, ev, mechs).state;
      }

      expect(meta.probes.length).toBeGreaterThan(0);
      for (const probe of meta.probes) {
        expect(keys.has(`${probe.scope}/${probe.messageId}`)).toBe(true);
        expect(state.chats[probe.scope]).toBeDefined();
      }
    }
  });
});
