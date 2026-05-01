/**
 * Script execution result types.
 *
 * The shell-native executor (`shell-executor.ts`) is the execution backend.
 * This module provides the shared result types used across the tick pipeline.
 *
 * ADR-214 Wave B: ScriptExecutionResult 是唯一的执行结果类型。
 * ExecutableResult / RecordedAction 已删除——shell-native 架构下 Telegram 动作
 * 通过容器内 Engine API HTTP 直接执行，结果以 completedActions 字符串追踪。
 */

export type ExecutionObservationKind =
  | "new_message_context"
  | "query_result"
  | "state_snapshot"
  | "read_ack"
  | "empty";

export interface ExecutionObservation {
  kind: ExecutionObservationKind;
  source: string;
  text: string;
  enablesContinuation: boolean;
  currentChatId?: string | null;
  targetChatId?: string | null;
  payload?: Record<string, unknown>;
}

export interface ScriptExecutionErrorDetail {
  code: ScriptExecutionErrorCode;
  source: string;
  currentChatId?: string | null;
  requestedChatId?: string | null;
  payload?: Record<string, unknown>;
}

export const EXECUTION_OBSERVATION_KINDS: readonly ExecutionObservationKind[] = [
  "new_message_context",
  "query_result",
  "state_snapshot",
  "read_ack",
  "empty",
] as const;

export function isExecutionObservationKind(value: unknown): value is ExecutionObservationKind {
  return (
    typeof value === "string" && (EXECUTION_OBSERVATION_KINDS as readonly string[]).includes(value)
  );
}

export function isExecutionObservation(value: unknown): value is ExecutionObservation {
  if (!value || typeof value !== "object") return false;
  const observation = value as Record<string, unknown>;
  return (
    isExecutionObservationKind(observation.kind) &&
    typeof observation.source === "string" &&
    typeof observation.text === "string" &&
    typeof observation.enablesContinuation === "boolean" &&
    (observation.currentChatId == null || typeof observation.currentChatId === "string") &&
    (observation.targetChatId == null || typeof observation.targetChatId === "string") &&
    (observation.payload == null ||
      (typeof observation.payload === "object" && !Array.isArray(observation.payload)))
  );
}

/** Unified script execution result used across the tick pipeline. */
export interface ScriptExecutionResult {
  logs: string[];
  errors: string[];
  instructionErrors: string[];
  /** 机器可解析错误码。运行时控制只能读取这里，不能从自然语言日志猜语义。 */
  errorCodes: ScriptExecutionErrorCode[];
  /** 机器可解析错误细节。仅供诊断事实写入；控制流不得从自然语言日志反推。 */
  errorDetails?: ScriptExecutionErrorDetail[];
  duration: number;
  thinks: string[];
  queryLogs: Array<{ fn: string; result: string }>;
  /** 机器可解析 observation fact。续轮控制只能读取这里，不能从 logs/queryLogs 猜语义。 */
  observations: ExecutionObservation[];
  /** 已完成的动作（shell 脚本输出的 __ALICE_ACTION__ 行）。格式: "sent:chatId=X:msgId=Y" 等。 */
  completedActions: string[];
  /** LLM 主动选择沉默的原因（null = 非沉默）。 */
  silenceReason: string | null;
}

export function emptyScriptExecutionResult(
  overrides: Partial<ScriptExecutionResult> = {},
): ScriptExecutionResult {
  return {
    logs: overrides.logs ?? [],
    errors: overrides.errors ?? [],
    instructionErrors: overrides.instructionErrors ?? [],
    errorCodes: overrides.errorCodes ?? [],
    errorDetails: overrides.errorDetails ?? [],
    duration: overrides.duration ?? 0,
    thinks: overrides.thinks ?? [],
    queryLogs: overrides.queryLogs ?? [],
    observations: overrides.observations ?? [],
    completedActions: overrides.completedActions ?? [],
    silenceReason: overrides.silenceReason ?? null,
  };
}

export function mergeScriptExecutionResults(
  results: readonly ScriptExecutionResult[],
): ScriptExecutionResult {
  const merged = emptyScriptExecutionResult();
  for (const result of results) {
    merged.logs.push(...result.logs);
    merged.errors.push(...result.errors);
    merged.instructionErrors.push(...result.instructionErrors);
    merged.errorCodes.push(...result.errorCodes);
    merged.errorDetails?.push(...(result.errorDetails ?? []));
    merged.duration += result.duration;
    merged.thinks.push(...result.thinks);
    merged.queryLogs.push(...result.queryLogs);
    merged.observations.push(...result.observations);
    merged.completedActions.push(...result.completedActions);
    if (result.silenceReason && !merged.silenceReason) {
      merged.silenceReason = result.silenceReason;
    }
  }
  return merged;
}

export const SCRIPT_EXECUTION_ERROR_CODES = [
  "command_cross_chat_send",
  "command_invalid_target",
  "command_invalid_message_id",
  "command_invalid_reply_ref",
  "command_missing_argument",
  "command_arg_format",
  "invalid_reaction",
  "invalid_sticker_keyword",
  "unreachable_telegram_user",
  "voice_messages_forbidden",
  "telegram_hard_permanent",
  "telegram_soft_permanent",
  "timeout",
  "provider_unavailable",
  "script_validation",
  "shell_nonzero",
] as const;

export type ScriptExecutionErrorCode = (typeof SCRIPT_EXECUTION_ERROR_CODES)[number];

export function isScriptExecutionErrorCode(value: string): value is ScriptExecutionErrorCode {
  return (SCRIPT_EXECUTION_ERROR_CODES as readonly string[]).includes(value);
}

export function isScriptExecutionErrorDetail(value: unknown): value is ScriptExecutionErrorDetail {
  if (!value || typeof value !== "object") return false;
  const detail = value as Record<string, unknown>;
  if (typeof detail.code !== "string" || !isScriptExecutionErrorCode(detail.code)) return false;
  if (typeof detail.source !== "string" || detail.source.length === 0) return false;
  if (
    detail.currentChatId !== undefined &&
    detail.currentChatId !== null &&
    typeof detail.currentChatId !== "string"
  ) {
    return false;
  }
  if (
    detail.requestedChatId !== undefined &&
    detail.requestedChatId !== null &&
    typeof detail.requestedChatId !== "string"
  ) {
    return false;
  }
  if (
    detail.payload !== undefined &&
    (detail.payload === null || typeof detail.payload !== "object" || Array.isArray(detail.payload))
  ) {
    return false;
  }
  return true;
}

// ── completedActions 解析工具 ─────────────────────────────────────────────

/**
 * completedActions 是否包含真实出站消息动作。
 * 唯一传感器是 __ALICE_ACTION__。自然语言确认行只允许给人看，不能反向进入控制流。
 */
export function hasCompletedSend(result: { completedActions: string[] }): boolean {
  return result.completedActions.some(
    (a) =>
      a.startsWith("sent:") ||
      a.startsWith("voice:") ||
      a.startsWith("sticker:") ||
      a.startsWith("react:") ||
      a.startsWith("sent-file:") ||
      a.startsWith("forwarded:"),
  );
}
