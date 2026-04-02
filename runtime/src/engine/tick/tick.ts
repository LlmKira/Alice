/**
 * Blackboard Tick 核心循环 — buildPrompt → callLLM → updateBoard。
 *
 * ADR-214 Wave A: resolveQueries 已删除（shell-native 架构下 actions 始终为空）。
 * ADR-234: TC 循环内部执行命令，tick.ts 不再双重执行。
 *
 * 核心循环语义：
 * 1. buildPrompt → callLLM（内部 TC 循环执行命令）
 * 2. updateBoard：执行结果写入 Blackboard
 * 3. afterward 信号驱动退出
 *
 * 终止条件（ADR-216: afterward 信号驱动）：
 * - isTerminal(board) 非 null（budget 耗尽）
 * - afterward = done / fed_up / cooling_down / waiting_reply → 始终终止
 * - afterward = watching → 继续循环（外层 subcycle 信号）
 *
 * @see docs/adr/169-fire-query-auto-continuation.md
 * @see docs/adr/142-action-space-architecture/README.md
 * @see docs/adr/234-wave5-session-erratum.md
 */

import type { ActionRuntimeConfig } from "../../core/action-executor.js";
import { logPromptSnapshot } from "../../diagnostics/prompt-log.js";
import type { Afterward } from "../../llm/tools.js";
import { drainBoard, isTerminal, updateBoard } from "./blackboard.js";
import type { TCLoopResult } from "./callLLM.js";
import { buildTickPrompt, type TickPromptContext } from "./prompt-builder.js";
import type { Blackboard, TickOutcome, TickResult, UnifiedTool } from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════
// afterward → outcome 映射
// ═══════════════════════════════════════════════════════════════════════════

const AFTERWARD_TO_OUTCOME: Record<Afterward, TickOutcome> = {
  done: "terminal",
  fed_up: "fed_up",
  cooling_down: "cooling_down",
  waiting_reply: "waiting_reply",
  watching: "watching",
};

// ═══════════════════════════════════════════════════════════════════════════
// 依赖注入接口
// ═══════════════════════════════════════════════════════════════════════════

/** Tick 循环的外部依赖（测试可 mock）。 */
export interface TickDeps {
  /** ADR-234: 调用 LLM — 内部 TC 循环执行命令，返回完整结果。 */
  callLLM: (
    system: string,
    user: string,
    tick: number,
    target: string | null,
    voice: string,
    contextVars: Record<string, unknown> | undefined,
  ) => Promise<TCLoopResult | null>;

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
  let lastExecResult: TCLoopResult | null = null;

  while (true) {
    // 检查终止条件
    const terminal = isTerminal(board);
    if (terminal != null) {
      outcome = terminal;
      break;
    }

    const round = board.budget.usedSteps;

    // ── 构建 prompt ──
    const promptCtx: TickPromptContext = {
      ...ctx,
      messages: ctx.messages,
      observations: board.observations,
      round,
    };
    const { system, user } = await (deps.buildPrompt ?? buildTickPrompt)(
      board,
      allTools,
      promptCtx,
    );

    // ── LLM 调用 ──
    const execResult = await deps.callLLM(
      system,
      user,
      ctx.tick,
      ctx.item.target,
      ctx.item.action,
      board.contextVars as Record<string, unknown>,
    );

    lastExecResult = execResult;

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
        budgetExhausted: execResult.budgetExhausted,
        commandOutput: execResult.commandOutput,
        thinks: execResult.thinks,
        queryLogs: execResult.queryLogs,
        errors: execResult.errors,
      },
    });
    deps.onStep?.({ round, system, user, script: execResult.rawScript });

    // ── 更新 Blackboard ──
    updateBoard(board, execResult);

    // ── ADR-213: 执行结果 → observations（分形坍缩：round → 事实节点）──
    if (execResult.logs.length > 0) {
      const outputText = execResult.logs.slice(0, 50).join("\n");
      board.observations.push(`(Command output:\n${outputText})`);
    }

    // ── ADR-169: 脚本错误 → observations（LLM 自纠）──
    if (execResult.errors.length > 0) {
      const errLines = execResult.errors.map((e) => `- ${e}`).join("\n");
      let obs = `(Script errors — review and adjust:\n${errLines})`;
      if (execResult.completedActions.length > 0) {
        const doneLines = execResult.completedActions.map((a) => `- ✓ ${a}`).join("\n");
        obs += `\n(Already completed — do NOT repeat:\n${doneLines})`;
      }
      board.observations.push(obs);
    }

    // 指令错误（无效 consult category、参数 arity 等）——非致命但 LLM 应知晓
    if (execResult.instructionErrors.length > 0) {
      const errLines = execResult.instructionErrors.map((e) => `- ${e}`).join("\n");
      board.observations.push(`(Instruction issues:\n${errLines})`);
    }

    // ── afterward 信号驱动退出 ──
    outcome = AFTERWARD_TO_OUTCOME[execResult.afterward] ?? "terminal";
    break;
  }

  const result = drainBoard(board, outcome, Date.now() - startTime, 0);

  // ADR-235: 从最后一次 TC 循环结果中提取可观测性元数据
  if (lastExecResult) {
    const cmdLog = lastExecResult.commandOutput ?? "";
    result.tcMeta = {
      toolCallCount: lastExecResult.toolCallCount,
      budgetExhausted: lastExecResult.budgetExhausted,
      afterward: lastExecResult.afterward,
      commandLog: cmdLog.length > 4096 ? cmdLog.slice(0, 4096) : cmdLog,
    };
  }

  return result;
}
