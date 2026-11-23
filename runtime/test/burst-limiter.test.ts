import { describe, expect, it } from "vitest";
import { KeyedBurstLimiter } from "../src/utils/rate-limit.js";

describe("KeyedBurstLimiter", () => {
  it("allows up to max acquisitions within the window", () => {
    const limiter = new KeyedBurstLimiter(3, 60_000);
    expect(limiter.tryAcquire("chat:1")).toBe(true);
    expect(limiter.tryAcquire("chat:1")).toBe(true);
    expect(limiter.tryAcquire("chat:1")).toBe(true);
    expect(limiter.tryAcquire("chat:1")).toBe(false);
  });

  it("tracks keys independently", () => {
    const limiter = new KeyedBurstLimiter(2, 60_000);
    expect(limiter.tryAcquire("chat:1")).toBe(true);
    expect(limiter.tryAcquire("chat:1")).toBe(true);
    expect(limiter.tryAcquire("chat:1")).toBe(false);
    expect(limiter.tryAcquire("chat:2")).toBe(true);
  });

  it("recording a long history keeps only what can still count, and still blocks a fresh burst", () => {
    let now = 1_000_000;
    const limiter = new KeyedBurstLimiter(3, 60_000, () => now);
    for (let i = 0; i < 10_000; i++) limiter.record("chat:1", now - 10_000_000 + i * 1_000);
    for (const at of [now - 3_000, now - 2_000, now - 1_000]) limiter.record("chat:1", at);
    expect(limiter.tryAcquire("chat:1")).toBe(false);
    now += 60_000;
    expect(limiter.tryAcquire("chat:1")).toBe(true);
  });
});
