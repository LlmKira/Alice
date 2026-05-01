/**
 * Blackboard Tick 核心循环 — buildPrompt → callLLM → updateBoard。
 *
 * ADR-214 Wave A: resolveQueries 已删除（shell-native 架构下 actions 始终为空）。
 *
 * 核心循环语义：
 * 1. buildPrompt → callLLM（生成一个 structured block 并执行）
 * 2. updateBoard：执行结果写入 Blackboard
 * 3. Host 分两层判断：
 *    - afterward: 这一轮结束后的对话走向
 *    - intra-tick continuation: 基于本地 observations / 错误反馈决定是否立即续轮
 *
 * 终止条件（ADR-216 + ADR-246）：
 * - isTerminal(board) 非 null（budget 耗尽）
 * - 执行错误 / 指令错误 → 优先同一 tick 内自纠，不能被 afterward 覆盖
 * - afterward = waiting_reply / resting / fed_up / cooling_down → 无错误时终止
 * - afterward = watching 且 host 观察到新的本地 follow-up 上下文 → 同一 tick 内续轮
 * - afterward = watching 但 host 未观察到新的本地 follow-up 上下文 → 交给外层 watcher
 * - afterward = done 且有错误反馈 → 同一 tick 内自纠续轮
 * - 其余情况终止
 *
 * @see docs/adr/169-fire-query-auto-continuation.md
 * @see docs/adr/142-action-space-architecture/README.md
 * @see docs/adr/246-transport-separation-block-first-execution.md
 * @see docs/adr/256-tc-block-execution-fact-authority/README.md
 */

import type { ActionRuntimeConfig } from "../../core/action-executor.js";
import {
  type ExecutionObservation,
  hasCompletedSend,
  type ScriptExecutionErrorCode,
} from "../../core/script-execution.js";
import { logPromptSnapshot } from "../../diagnostics/prompt-log.js";
import type { AvailableProvider } from "../../llm/client.js";
import type { Afterward } from "../../llm/tools.js";
import { drainBoard, isTerminal, updateBoard } from "./blackboard.js";
import type { TickCallResult, TickExecutionResult, TickFailureResult } from "./callLLM.js";
import { buildTickPrompt, type TickPromptContext } from "./prompt-builder.js";
import type {
  Blackboard,
  IntraTickContinuationReason,
  TickOutcome,
  TickResult,
  UnifiedTool,
} from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════
// afterward → outcome 映射
// ═══════════════════════════════════════════════════════════════════════════

const AFTERWARD_TO_OUTCOME: Record<Afterward, TickOutcome> = {
  done: "terminal",
  resting: "resting",
  fed_up: "fed_up",
  cooling_down: "cooling_down",
  waiting_reply: "waiting_reply",
  watching: "watching",
};

function describeExecutionErrorCode(code: ScriptExecutionErrorCode): string {
  switch (code) {
    case "command_invalid_target":
      return "不知道那是谁";
    case "command_missing_argument":
      return "命令缺了必要参数";
    case "command_arg_format":
    case "command_invalid_message_id":
    case "command_invalid_reply_ref":
      return "命令好像写错了";
    case "invalid_reaction":
      return "这个表情反应不能发送";
    case "invalid_sticker_keyword":
      return "找不到这个贴纸";
    case "unreachable_telegram_user":
    case "telegram_hard_permanent":
    case "telegram_soft_permanent":
      return "这个目标现在不可达";
    case "voice_messages_forbidden":
      return "对方不允许发送语音";
    case "timeout":
    case "provider_unavailable":
      return "外部服务暂时不可用";
    case "command_cross_chat_send":
      return "不能跨聊天主动发消息";
    case "script_validation":
    case "shell_nonzero":
      return "命令执行失败";
  }
}

interface IntraTickContinuationDecision {
  continueInTick: boolean;
  reason: IntraTickContinuationReason;
}

function isTickFailureResult(result: TickCallResult): result is TickFailureResult {
  return result != null && "ok" in result && result.ok === false;
}

function deriveIntraTickContinuation(
  execResult: TickExecutionResult,
  continuationTokens: ContinuationTokenSet,
): IntraTickContinuationDecision {
  if (hasCompletedSend(execResult)) {
    return { continueInTick: false, reason: "none" };
  }

  if (execResult.errors.length > 0 || execResult.instructionErrors.length > 0) {
    return { continueInTick: true, reason: "error_recovery" };
  }

  if (continuationTokens.actionableObservation) {
    switch (execResult.afterward) {
      case "done":
      case "waiting_reply":
      case "watching":
        return { continueInTick: true, reason: "local_observation_followup" };
      case "resting":
      case "fed_up":
      case "cooling_down":
        return { continueInTick: false, reason: "none" };
    }
  }

  if (execResult.afterward === "watching") {
    if (continuationTokens.newObservation) {
      return { continueInTick: true, reason: "local_observation_followup" };
    }
    return { continueInTick: false, reason: "none" };
  }

  return { continueInTick: false, reason: "none" };
}

interface ContinuationTokenSet {
  newObservation: boolean;
  actionableObservation: boolean;
}

function isActionableObservation(observation: ExecutionObservation): boolean {
  const intent = observation.payload?.intent;
  return observation.enablesContinuation && typeof intent === "string" && intent.length > 0;
}

function getTickSelectedProvider(
  ctx: TickPromptContext & { llmProvider?: AvailableProvider },
): AvailableProvider | undefined {
  return ctx.llmProvider;
}

function classifyContinuationTokens(
  execResult: TickExecutionResult,
  boardDelta: { hasNewObservations: boolean },
): ContinuationTokenSet {
  if (!boardDelta.hasNewObservations) {
    return { newObservation: false, actionableObservation: false };
  }
  if (execResult.errors.length > 0 || execResult.instructionErrors.length > 0) {
    return { newObservation: false, actionableObservation: false };
  }
  if (hasCompletedSend(execResult)) return { newObservation: false, actionableObservation: false };

  return {
    newObservation: execResult.observations.some((observation) => observation.enablesContinuation),
    actionableObservation: execResult.observations.some(isActionableObservation),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 依赖注入接口
// ═══════════════════════════════════════════════════════════════════════════

/** Tick 循环的外部依赖（测试可 mock）。 */
export interface TickDeps {
  /** 调用 LLM — 生成并执行一个 structured block，返回完整结果。 */
  callLLM: (
    system: string,
    user: string,
    tick: number,
    target: string | null,
    voice: string,
    contextVars: Record<string, unknown> | undefined,
    selectedProvider?: AvailableProvider,
  ) => Promise<TickCallResult>;

  /** Prompt 构建覆盖（eval 消融实验用）。省略时使用 buildTickPrompt。 */
  buildPrompt?: (
    board: Blackboard,
    allTools: readonly UnifiedTool[],
    ctx: TickPromptContext,
  ) => Promise<{ system: string; user: string }> | { system: string; user: string };

  /** 每步完成后回调（eval 诊断用）。在 LLM 调用后触发。 */
  onStep?: (info: { round: number; system: string; user: string; script: string | null }) => void;
}

// ═══════════════════════════════════════════════════════════════════════════
// 核心 tick 循环
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Blackboard Tick 循环 — 主入口。
 *
 * 每步：buildTickPrompt → callLLM → updateBoard → inject errors
 * 终止：isTerminal(board) 非 null，或 afterward 信号中断
 */
export async function tick(
  board: Blackboard,
  allTools: readonly UnifiedTool[],
  deps: TickDeps,
  ctx: TickPromptContext & {
    client: unknown;
    runtimeConfig: ActionRuntimeConfig;
  },
): Promise<TickResult> {
  const startTime = Date.now();
  let outcome: TickOutcome = "terminal";
  let lastExecResult: TickExecutionResult | null = null;
  let episodeRound = 0;
  const hostContinuationTrace: IntraTickContinuationReason[] = [];

  while (true) {
    // 检查终止条件
    const terminal = isTerminal(board);
    if (terminal != null) {
      outcome = terminal;
      break;
    }

    const round = board.budget.usedSteps;
    const obsBefore = board.observations.length;

    // ── 构建 prompt ──
    const promptCtx: TickPromptContext = {
      ...ctx,
      messages: ctx.messages,
      observations: board.observations,
      round,
      episodeRound,
    };
    const { system, user } = deps.buildPrompt
      ? await deps.buildPrompt(board, allTools, promptCtx)
      : await buildTickPrompt(board, promptCtx);

    // ── LLM 调用 ──
    const execResult = await deps.callLLM(
      system,
      user,
      ctx.tick,
      ctx.item.target,
      ctx.item.action,
      board.contextVars as Record<string, unknown>,
      getTickSelectedProvider(ctx),
    );

    if (!execResult) {
      logPromptSnapshot({
        tick: ctx.tick,
        target: ctx.item.target,
        voice: ctx.item.action,
        round,
        system,
        user,
        script: null,
      });
      deps.onStep?.({ round, system, user, script: null });
      outcome = "empty";
      break;
    }

    if (isTickFailureResult(execResult)) {
      logPromptSnapshot({
        tick: ctx.tick,
        target: ctx.item.target,
        voice: ctx.item.action,
        round,
        system,
        user,
        script: null,
      });
      deps.onStep?.({ round, system, user, script: null });
      outcome = "empty";
      board.failureKind = execResult.failureKind;
      board.execution.errors.push(execResult.error);
      break;
    }

    lastExecResult = execResult;

    // ── 更新 Blackboard ──
    updateBoard(board, execResult);

    // ── ADR-213: 执行结果 → observations（分形坍缩：round → 事实节点）──
    if (execResult.logs.length > 0) {
      const outputText = execResult.logs.slice(0, 50).join("\n");
      board.observations.push(`(Command output:\n${outputText})`);
    }

    // ── ADR-169: 脚本错误 → observations（LLM 自纠）──
    // ADR-237 增强：将技术错误转换为自然语言描述
    if (execResult.errors.length > 0) {
      const naturalErrors =
        execResult.errorCodes.length > 0
          ? execResult.errorCodes.map(describeExecutionErrorCode)
          : execResult.errors;

      let obs = `(刚才的命令出了点问题:\n${naturalErrors.map((e) => `- ${e}`).join("\n")})`;

      // 已完成的操作
      if (execResult.completedActions.length > 0) {
        const doneLines = execResult.completedActions.map((a) => `- ${a}`).join("\n");
        obs += `\n(这些已经做完了，不要再重复:\n${doneLines})`;
      }

      board.observations.push(obs);
    }

    // 指令错误（无效 consult category、参数 arity 等）——非致命但 LLM 应知晓
    if (execResult.instructionErrors.length > 0) {
      const errLines = execResult.instructionErrors.map((e) => `- ${e}`).join("\n");
      board.observations.push(`(Instruction issues:\n${errLines})`);
    }

    const hasNewObservations = board.observations.length > obsBefore;
    const continuationTokens = classifyContinuationTokens(execResult, { hasNewObservations });

    const continuation = deriveIntraTickContinuation(execResult, continuationTokens);

    // ── prompt 快照落盘 ──
    logPromptSnapshot({
      tick: ctx.tick,
      target: ctx.item.target,
      voice: ctx.item.action,
      round,
      system,
      user,
      script: execResult.rawScript,
      execution: {
        afterward: execResult.afterward,
        toolCallCount: execResult.toolCallCount,
        assistantTurnCount: execResult.assistantTurnCount,
        bashCallCount: execResult.bashCallCount,
        signalCallCount: execResult.signalCallCount,
        budgetExhausted: execResult.budgetExhausted,
        transcript: execResult.transcript,
        commandOutput: execResult.commandOutput,
        thinks: execResult.thinks,
        queryLogs: execResult.queryLogs,
        instructionErrors: execResult.instructionErrors,
        errors: execResult.errors,
        hostContinuedInTick: continuation.continueInTick,
        hostContinuationReason: continuation.reason,
      },
    });
    deps.onStep?.({ round, system, user, script: execResult.rawScript });

    if (continuation.continueInTick) {
      hostContinuationTrace.push(continuation.reason);
      episodeRound++;
      continue;
    }

    // ── afterward 信号驱动退出 ──
    outcome = AFTERWARD_TO_OUTCOME[execResult.afterward] ?? "terminal";
    break;
  }

  const result = drainBoard(board, outcome, Date.now() - startTime, episodeRound);

  // ADR-235: 从最后一次 TC 循环结果中提取可观测性元数据
  if (lastExecResult) {
    const cmdLog = lastExecResult.commandOutput ?? "";
    if (lastExecResult.llmResidue) {
      result.llmResidue = lastExecResult.llmResidue;
    }
    result.tcMeta = {
      toolCallCount: lastExecResult.toolCallCount,
      budgetExhausted: lastExecResult.budgetExhausted,
      afterward: lastExecResult.afterward,
      commandLog: cmdLog.length > 4096 ? cmdLog.slice(0, 4096) : cmdLog,
      provider: lastExecResult.llmProvider,
      model: lastExecResult.llmModel,
    };
    if (hostContinuationTrace.length > 0) {
      result.tcMeta.hostContinuationTrace = hostContinuationTrace;
    }
  }

  return result;
}
