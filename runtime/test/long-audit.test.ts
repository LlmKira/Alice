import { describe, expect, it } from "vitest";
import type { AliceEvent } from "../src/mind/events.js";
import { auditLongRun } from "../src/sim/long-audit.js";

describe("long-run audit", () => {
  it("measures the span of a run with more events than a call can take as arguments", () => {
    const DAY = 24 * 3_600_000;
    const n = 200_000;
    const events: AliceEvent[] = Array.from({ length: n }, (_, i) => ({
      type: "clock.tick",
      at: (i / (n - 1)) * 3 * DAY,
    }));
    expect(auditLongRun(events).days).toBe(3);
  });
});
