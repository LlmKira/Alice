/**
 * Blackboard 构建与 drain — tick 循环的共享状态管理。
 *
 * @see docs/adr/142-action-space-architecture/README.md
 */

import {
  emptyScriptExecutionResult,
  mergeScriptExecutionResults,
  type ScriptExecutionResult,
} from "../../core/script-execution.js";
import type { Blackboard, FeatureFlags, TickOutcome, TickResult, ToolCategory } from "./types.js";

/** 默认最大步数。 */
const DEFAULT_MAX_STEPS = 3;

/**
 * 创建 Blackboard。
 */
export function createBlackboard(opts: {
  pressures: [number, number, number, number, number, number];
  voice: string;
  target: string | null;
  features: FeatureFlags;
  contextVars: Record<string, unknown>;
  maxSteps?: number;
}): Blackboard {
  return {
    pressures: opts.pressures,
    voice: opts.voice,
    target: opts.target,
    features: opts.features,
    contextVars: opts.contextVars,
    observations: [],
    execution: emptyScriptExecutionResult(),
    preparedCategories: new Set<ToolCategory>(),
    budget: {
      maxSteps: opts.maxSteps ?? DEFAULT_MAX_STEPS,
      usedSteps: 0,
    },
  };
}

/**
 * 更新 Blackboard — 合并一次脚本执行的结果。
 */
export function updateBoard(board: Blackboard, result: ScriptExecutionResult): void {
  board.execution = mergeScriptExecutionResults([board.execution, result]);
  board.budget.usedSteps++;
}

/**
 * 判断 tick 循环是否应终止。
 * 返回 null 表示可继续，否则返回退出原因。
 */
export function isTerminal(board: Blackboard): TickOutcome | null {
  // 预算耗尽 — 返回 "terminal" 而非 "empty"。
  // 预算耗尽 = LLM 用完了所有轮次（通常是 host 因本地 follow-up / 自纠而连续续轮），
  // 不等于 LLM 无产出。"empty" 被 orchestrator 映射为 llm_failed，
  // 触发指数退避 + 强制静默，对沉默决策造成死循环。
  if (board.budget.usedSteps >= board.budget.maxSteps) {
    return "terminal";
  }

  return null;
}

/**
 * Drain Blackboard — 将 Blackboard 状态转换为 TickResult。
 * 调用后 Blackboard 不应再被使用。
 *
 * @param episodeRounds ADR-232: episode 内 block 续轮次数（host 触发的额外轮数）。
 */
export function drainBoard(
  board: Blackboard,
  outcome: TickOutcome,
  durationMs: number,
  episodeRounds = 0,
): TickResult {
  return {
    outcome,
    observations: board.observations,
    execution: board.execution,
    stepsUsed: board.budget.usedSteps,
    preparedCategories: [...board.preparedCategories],
    duration: durationMs,
    episodeRounds,
    failureKind: board.failureKind,
  };
}
