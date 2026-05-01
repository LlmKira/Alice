/**
 * 动作执行器 — 运行时配置类型 + 反馈缺口检测。
 *
 * ADR-214 Wave B: 删除 RecordedAction / ExecutableResult / executeRecordedActions 死管线。
 * shell-native 架构下 Telegram 动作通过容器内 Engine API HTTP 直接执行，
 * 执行结果以 completedActions 字符串追踪（格式: "sent:chatId=X:msgId=Y" 等）。
 *
 * 保留:
 * - ActionRuntimeConfig（tick 管线依赖）
 * - FeedbackGap + checkFeedbackGap（基于 completedActions 重写）
 */

import type { ScriptExecutionResult } from "./script-execution.js";
import { hasCompletedSend } from "./script-execution.js";

// ═══════════════════════════════════════════════════════════════════════════
// ActionRuntimeConfig — tick 管线运行时配置
// ═══════════════════════════════════════════════════════════════════════════

/**
 * impl 函数运行时所需的配置子集。
 * 从完整 Config 中提取，避免 action-executor 依赖完整配置类型。
 * @see src/telegram/action-types.ts — ActionImplContext 的注入式配置字段
 */
export interface ActionRuntimeConfig {
  ttsConfig: import("../telegram/action-types.js").TtsConfig;
  exaApiKey: string;
  musicApiBaseUrl: string;
  youtubeApiKey: string;
  timezoneOffset: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// FeedbackGap — 反馈闭环缺口检测（基于 completedActions）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ADR-43 P0: 检查脚本执行结果是否包含必要的反馈指令。
 */
export interface FeedbackGap {
  hasSendMessage: boolean;
  hasObserveMood: boolean;
  hasRateOutcome: boolean;
  isMissing: boolean;
}

/**
 * ADR-43 P0: 检测反馈闭环缺口。
 *
 * ADR-214 Wave B: 基于 completedActions 推导 hasSendMessage（"sent:" 前缀），
 * hasObserveMood/hasRateOutcome 从 completedActions 中解析 dispatch 动作。
 *
 * shell-native 架构下 feel/rate_outcome 通过 Engine API dispatch 执行，
 * 但不输出 __ALICE_ACTION__ 控制行——它们是内部状态更新，不是 Telegram 动作。
 * 因此 hasObserveMood/hasRateOutcome 在当前架构下始终为 false。
 * 反馈闭环由 processResult 的自动注入 self_feel 兜底（ADR-199 W1.1）。
 */
export function checkFeedbackGap(result: ScriptExecutionResult): FeedbackGap {
  const hasSendMessage = hasCompletedSend(result);
  // shell-native: dispatch 动作不输出 __ALICE_ACTION__，无法从 completedActions 检测。
  // 保守估计: 始终视为缺失，由 processResult 自动注入兜底。
  const hasObserveMood = false;
  const hasRateOutcome = false;
  const isMissing = hasSendMessage && !hasObserveMood;

  return { hasSendMessage, hasObserveMood, hasRateOutcome, isMissing };
}
