import { describe, expect, it } from "vitest";
import { decideStartupMode, latestRuntimeSeenMs } from "../src/engine/startup-mode.js";

const WAKEUP_THRESHOLD_S = 600;
const RECOVERY_MIN_MS = 120_000;

describe("startup mode decision", () => {
  it("does not treat action silence as runtime offline", () => {
    const decision = decideStartupMode({
      runtimeOfflineMs: 36_000,
      actionSilenceMs: 180_000,
      wakeupOfflineThresholdS: WAKEUP_THRESHOLD_S,
      postRestartRecoveryMinOfflineMs: RECOVERY_MIN_MS,
    });

    expect(decision.initialMode).toBe("patrol");
    expect(decision.shouldUsePostRestartRecovery).toBe(false);
    expect(Math.round(decision.runtimeOfflineS)).toBe(36);
    expect(Math.round(decision.actionSilenceS)).toBe(180);
  });

  it("uses short runtime offline to enter post-restart recovery", () => {
    const decision = decideStartupMode({
      runtimeOfflineMs: 180_000,
      actionSilenceMs: 10_000,
      wakeupOfflineThresholdS: WAKEUP_THRESHOLD_S,
      postRestartRecoveryMinOfflineMs: RECOVERY_MIN_MS,
    });

    expect(decision.initialMode).toBe("patrol");
    expect(decision.shouldUsePostRestartRecovery).toBe(true);
  });

  it("uses long runtime offline to enter wakeup mode", () => {
    const decision = decideStartupMode({
      runtimeOfflineMs: 3 * 60 * 60_000,
      actionSilenceMs: 10_000,
      wakeupOfflineThresholdS: WAKEUP_THRESHOLD_S,
      postRestartRecoveryMinOfflineMs: RECOVERY_MIN_MS,
    });

    expect(decision.initialMode).toBe("wakeup");
    expect(decision.shouldUsePostRestartRecovery).toBe(false);
  });

  it("treats missing runtime heartbeat as unknown instead of inferring from action time", () => {
    const startupNowMs = 1_000_000;
    const runtimeSeenMs = latestRuntimeSeenMs({});
    const decision = decideStartupMode({
      runtimeOfflineMs: runtimeSeenMs > 0 ? startupNowMs - runtimeSeenMs : 0,
      actionSilenceMs: 3 * 60_000,
      wakeupOfflineThresholdS: WAKEUP_THRESHOLD_S,
      postRestartRecoveryMinOfflineMs: RECOVERY_MIN_MS,
    });

    expect(decision.initialMode).toBe("patrol");
    expect(decision.shouldUsePostRestartRecovery).toBe(false);
  });

  it("uses the newest lifecycle sensor", () => {
    expect(latestRuntimeSeenMs({ lastSeenMs: 100, shutdownMs: 120 })).toBe(120);
    expect(latestRuntimeSeenMs({ lastSeenMs: 150, shutdownMs: 120 })).toBe(150);
  });
});
