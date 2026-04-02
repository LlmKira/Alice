/**
 * ADR-233: TC 循环 — 原生 tool_use + BT 可变尾部。
 *
 * 核心循环：LLM call → tool_use → execute → tool_result → 回 LLM
 * 终止条件：LLM end_turn（无 tool_use）或触及 TC_MAX_TOOL_CALLS 预算
 *
 * 执行复用：直接调用 shell-executor.ts → docker.ts（ADR-207 persistent session）。
 *
 * 双区模型：
 * - 累积区：messages 数组（自然 append-only，LLM 看到完整 tool 历史）
 * - 可变区：system prompt 可变尾部（每 episode 由 contribute() 重算）
 *
 * @see docs/adr/233-native-toolcall-bt-hybrid.md
 * @see docs/adr/234-wave5-session-erratum.md
 */
import type OpenAI from "openai";
import type { ScriptExecutionResult } from "../../core/script-execution.js";
import { executeShellScript } from "../../core/shell-executor.js";
import { withResilience } from "../../llm/resilience.js";
import { ADR233_TOOLS, type Afterward, extractToolUseParams } from "../../llm/tools.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("tick/tc-loop");

/** ADR-233: 单 episode 内最多 tool_use 次数（含 signal）。 */
export const TC_MAX_TOOL_CALLS = 8;

// 工具名常量
const RUN_TOOL_NAME = "run";
const SIGNAL_TOOL_NAME = "signal";

/**
 * TC 循环上下文。
 */
export interface TCLoopContext {
  openai: OpenAI;
  model: string;
  providerName: string;
  systemPrompt: string;
  userMessage: string;
  /** ADR-234: 执行命令时需要的 contextVars（传给 executeShellScript）。 */
  contextVars?: Record<string, unknown>;
}

/**
 * TC 循环执行结果 — tool 编排元数据 + 命令执行结果。
 */
export interface TCLoopResult extends ScriptExecutionResult {
  /** signal 工具的 afterward 值（tc-loop 内保证非 undefined）。 */
  afterward: Afterward;
  /** tool_use 调用次数。 */
  toolCallCount: number;
  /** 是否触及 TC_MAX_TOOL_CALLS 预算上限。 */
  budgetExhausted: boolean;
  /** 原始脚本（LLM 生成的命令行，用于诊断日志）。 */
  rawScript: string;
  /** 聚合的 `$ cmd\noutput` 块（完整命令 + 输出对）。 */
  commandOutput: string;
}

/**
 * 运行 TC 循环 — 使用 shell-executor 执行（复用 docker.ts persistent session）。
 */
export async function runTCLoop(ctx: TCLoopContext): Promise<TCLoopResult> {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: ctx.systemPrompt },
    { role: "user", content: ctx.userMessage },
  ];

  let toolCallCount = 0;
  let afterward: Afterward = "done";
  let budgetExhausted = false;
  const commandOutputs: string[] = [];

  // ADR-234: 聚合每次执行的结果
  const executionResult: ScriptExecutionResult = {
    logs: [],
    errors: [],
    instructionErrors: [],
    duration: 0,
    thinks: [],
    queryLogs: [],
    completedActions: [],
    silenceReason: null,
  };
  const startTime = Date.now();

  try {
    while (toolCallCount < TC_MAX_TOOL_CALLS) {
      const response = await withResilience(
        () =>
          ctx.openai.chat.completions.create({
            model: ctx.model,
            messages,
            tools: ADR233_TOOLS,
            tool_choice: "auto",
            temperature: 0.7,
          }),
        {},
        ctx.providerName,
      );

      const assistantMsg = response.choices[0]?.message;
      if (!assistantMsg) {
        log.warn("Empty LLM response", { provider: ctx.providerName });
        break;
      }

      messages.push(assistantMsg);

      const toolCalls = assistantMsg.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        log.info("TC loop end_turn", {
          provider: ctx.providerName,
          toolCallCount,
          afterward,
        });
        break;
      }

      for (const toolCall of toolCalls) {
        toolCallCount++;
        const { name, args } = extractToolUseParams(toolCall);
        log.debug("Tool call", { name, toolCallCount });

        if (name === RUN_TOOL_NAME) {
          const command = String(args.command ?? "");
          if (!command) {
            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: "(no command provided)",
            });
            continue;
          }

          // ADR-234: 使用 shell-executor 执行（复用 docker.ts persistent session）
          const result = await executeShellScript(command, { contextVars: ctx.contextVars });

          // ADR-234: 聚合 ScriptExecutionResult
          executionResult.logs.push(...result.logs);
          executionResult.errors.push(...result.errors);
          executionResult.instructionErrors.push(...result.instructionErrors);
          executionResult.thinks.push(...result.thinks);
          executionResult.queryLogs.push(...result.queryLogs);
          executionResult.completedActions.push(...result.completedActions);
          if (result.silenceReason && !executionResult.silenceReason) {
            executionResult.silenceReason = result.silenceReason;
          }

          const output =
            result.errors.length > 0
              ? `exit ${result.errors.join("\n")}\n${result.logs.join("\n")}`
              : result.logs.join("\n") || "(no output)";

          commandOutputs.push(`$ ${command}\n${output}`);

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: output,
          });
        } else if (name === SIGNAL_TOOL_NAME) {
          const sig = String(args.afterward ?? "done") as Afterward;
          afterward = sig;

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: `ack: ${sig}`,
          });
        } else {
          log.warn("Unknown tool call", { name, toolCallId: toolCall.id });
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: "(unknown tool)",
          });
        }
      }
    }

    if (toolCallCount >= TC_MAX_TOOL_CALLS) {
      budgetExhausted = true;
      log.warn("TC loop budget exhausted", { provider: ctx.providerName, toolCallCount });
    }
  } catch (e) {
    log.error("TC loop error", { provider: ctx.providerName, error: e });
    throw e;
  }

  // rawScript: 从 commandOutputs 提取原始命令行（去掉输出，只留 `$ cmd` 行）
  const rawScript = commandOutputs
    .map((block) => {
      const firstLine = block.split("\n")[0];
      return firstLine.startsWith("$ ") ? firstLine.slice(2) : firstLine;
    })
    .join("\n");

  return {
    commandOutput: commandOutputs.join("\n---\n"),
    rawScript,
    afterward,
    toolCallCount,
    budgetExhausted,
    // ScriptExecutionResult 字段
    logs: executionResult.logs,
    errors: executionResult.errors,
    instructionErrors: executionResult.instructionErrors,
    duration: Date.now() - startTime,
    thinks: executionResult.thinks,
    queryLogs: executionResult.queryLogs,
    completedActions: executionResult.completedActions,
    silenceReason: executionResult.silenceReason,
  };
}
