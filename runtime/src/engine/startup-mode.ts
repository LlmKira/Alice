import type { AgentMode } from "../utils/time.js";

/** Short process restarts should not make Alice behave like she woke from a real absence. */
export const POST_RESTART_RECOVERY_MIN_OFFLINE_MS = 2 * 60 * 1000;

export interface StartupModeInput {
  runtimeOfflineMs: number;
  actionSilenceMs: number;
  wakeupOfflineThresholdS: number;
  postRestartRecoveryMinOfflineMs: number;
}

export interface StartupModeDecision {
  initialMode: AgentMode;
  shouldUsePostRestartRecovery: boolean;
  runtimeOfflineS: number;
  actionSilenceS: number;
}

/**
 * 启动模态只由 runtime 离线传感器决定。
 * lastActionMs 只表示 Alice 多久没行动，不能冒充进程离线时长。
 */
export function decideStartupMode(input: StartupModeInput): StartupModeDecision {
  const runtimeOfflineMs = Math.max(0, input.runtimeOfflineMs);
  const actionSilenceMs = Math.max(0, input.actionSilenceMs);
  const initialMode: AgentMode =
    runtimeOfflineMs / 1000 > input.wakeupOfflineThresholdS ? "wakeup" : "patrol";
  return {
    initialMode,
    shouldUsePostRestartRecovery:
      initialMode !== "wakeup" && runtimeOfflineMs >= input.postRestartRecoveryMinOfflineMs,
    runtimeOfflineS: runtimeOfflineMs / 1000,
    actionSilenceS: actionSilenceMs / 1000,
  };
}

export function latestRuntimeSeenMs(values: {
  lastSeenMs?: number | null;
  shutdownMs?: number | null;
}): number {
  return Math.max(0, values.lastSeenMs ?? 0, values.shutdownMs ?? 0);
}
