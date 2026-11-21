import { describe, expect, it } from "vitest";
import { KeyedBurstLimiter } from "../src/telegram/burst-limiter.js";

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

  it("reopens after the window elapses", () => {
    const limiter = new KeyedBurstLimiter(1, 50);
    expect(limiter.tryAcquire("chat:1")).toBe(true);
    expect(limiter.tryAcquire("chat:1")).toBe(false);
    return new Promise((resolve) =>
      setTimeout(() => {
        expect(limiter.tryAcquire("chat:1")).toBe(true);
        resolve(null);
      }, 80),
    );
  });
});
