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
import type {
  ScriptExecutionErrorCode,
  ScriptExecutionResult,
} from "../../core/script-execution.js";
import { executeShellScript } from "../../core/shell-executor.js";
import { withResilience } from "../../llm/resilience.js";
import { ADR233_TOOLS, type Afterward, extractToolUseParams } from "../../llm/tools.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("tick/tc-loop");

/** ADR-233: 单 episode 内最多 tool_use 次数（含 signal）。 */
export const TC_MAX_TOOL_CALLS = 8;

// 工具名常量
const BASH_TOOL_NAME = "bash";
const SIGNAL_TOOL_NAME = "signal";
type ToolChoice = "required" | "auto";
export type StopLossErrorClass =
  | "timeout"
  | "invalid_target"
  | "contact_not_found"
  | "missing_argument"
  | "arg_format_error";

const STOP_LOSS_LABELS: Record<StopLossErrorClass, string> = {
  timeout: "timeout",
  invalid_target: "invalid target",
  contact_not_found: "contact not found",
  missing_argument: "missing argument",
  arg_format_error: "argument format error",
};

export interface TCToolCallTrace {
  sequence: number;
  round: number;
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  command?: string;
  afterward?: Afterward;
  output: string;
  errors: string[];
  instructionErrors: string[];
}

export interface TCAssistantRoundTrace {
  round: number;
  toolChoice: ToolChoice;
  finishReason: string | null;
  assistantText: string;
  toolCalls: TCToolCallTrace[];
}

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
  /** assistant 轮次数（一次 ChatCompletion 响应算一轮）。 */
  assistantTurnCount?: number;
  /** bash 工具调用次数。 */
  bashCallCount?: number;
  /** signal 工具调用次数。 */
  signalCallCount?: number;
  /** 是否触及 TC_MAX_TOOL_CALLS 预算上限。 */
  budgetExhausted: boolean;
  /** 原始脚本（LLM 生成的命令行，用于诊断日志）。 */
  rawScript: string;
  /** 聚合的 `$ cmd\noutput` 块（完整命令 + 输出对）。 */
  commandOutput: string;
  /** TC 内部真实 transcript（按 assistant round 保真）。 */
  transcript?: TCAssistantRoundTrace[];
}

function extractAssistantText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (!item || typeof item !== "object") continue;

    const text = (item as { text?: unknown }).text;
    if (typeof text === "string" && text.length > 0) {
      parts.push(text);
    }
  }

  return parts.join("\n").trim();
}

function classifyStopLossError(code: ScriptExecutionErrorCode): StopLossErrorClass | null {
  switch (code) {
    case "command_invalid_target":
      return "invalid_target";
    case "command_missing_argument":
      return "missing_argument";
    case "command_arg_format":
    case "command_invalid_message_id":
    case "command_invalid_reply_ref":
      return "arg_format_error";
    case "timeout":
      return "timeout";
    default:
      return null;
  }
}

export function collectStopLossErrors(
  errorCodes: readonly ScriptExecutionErrorCode[],
): StopLossErrorClass[] {
  const found = new Set<StopLossErrorClass>();
  for (const code of errorCodes) {
    const cls = classifyStopLossError(code);
    if (cls) found.add(cls);
  }
  return [...found];
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
  let bashCallCount = 0;
  let signalCallCount = 0;
  let callSequence = 0;
  let stopReason: string | null = null;
  const commandOutputs: string[] = [];
  const rawScripts: string[] = [];
  const transcript: TCAssistantRoundTrace[] = [];
  const stopLossCounts = new Map<StopLossErrorClass, number>();

  // ADR-234: 聚合每次执行的结果
  const executionResult: ScriptExecutionResult = {
    logs: [],
    errors: [],
    instructionErrors: [],
    errorCodes: [],
    errorDetails: [],
    duration: 0,
    thinks: [],
    queryLogs: [],
    observations: [],
    completedActions: [],
    silenceReason: null,
  };
  const startTime = Date.now();

  try {
    tcLoop: while (toolCallCount < TC_MAX_TOOL_CALLS) {
      // ADR-233: 首轮强制 tool_choice="required"，确保模型至少调用一次工具（bash 或 signal）。
      // 后续轮次 "auto" 允许自然 end_turn。
      const choice: ToolChoice = toolCallCount === 0 ? "required" : "auto";
      const response = await withResilience(
        () =>
          ctx.openai.chat.completions.create({
            model: ctx.model,
            messages,
            tools: ADR233_TOOLS,
            tool_choice: choice,
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
      const roundTrace: TCAssistantRoundTrace = {
        round: transcript.length,
        toolChoice: choice,
        finishReason: response.choices[0]?.finish_reason ?? null,
        assistantText: extractAssistantText(assistantMsg.content),
        toolCalls: [],
      };
      transcript.push(roundTrace);

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
        if (toolCallCount >= TC_MAX_TOOL_CALLS) {
          budgetExhausted = true;
          log.warn("TC loop budget exhausted before tool execution", {
            provider: ctx.providerName,
            toolCallCount,
            requestedToolCalls: toolCalls.length,
          });
          break tcLoop;
        }

        toolCallCount++;
        callSequence++;
        const { name, args } = extractToolUseParams(toolCall);
        log.debug("Tool call", { name, toolCallCount });

        if (name === BASH_TOOL_NAME) {
          bashCallCount++;
          const command = String(args.command ?? "");
          if (!command) {
            roundTrace.toolCalls.push({
              sequence: callSequence,
              round: roundTrace.round,
              toolCallId: toolCall.id,
              name,
              args,
              output: "(no command provided)",
              errors: [],
              instructionErrors: [],
            });
            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: "(no command provided)",
            });
            continue;
          }

          rawScripts.push(command);

          // ADR-234: 使用 shell-executor 执行（复用 docker.ts persistent session）
          const result = await executeShellScript(command, { contextVars: ctx.contextVars });

          // ADR-234: 聚合 ScriptExecutionResult
          executionResult.logs.push(...result.logs);
          executionResult.errors.push(...result.errors);
          executionResult.instructionErrors.push(...result.instructionErrors);
          executionResult.errorCodes.push(...result.errorCodes);
          executionResult.errorDetails?.push(...(result.errorDetails ?? []));
          executionResult.thinks.push(...result.thinks);
          executionResult.queryLogs.push(...result.queryLogs);
          executionResult.observations.push(...result.observations);
          executionResult.completedActions.push(...result.completedActions);
          if (result.silenceReason && !executionResult.silenceReason) {
            executionResult.silenceReason = result.silenceReason;
          }

          const outputParts: string[] = [];
          if (result.instructionErrors.length > 0) {
            outputParts.push(`instruction error\n${result.instructionErrors.join("\n")}`);
          }
          if (result.errors.length > 0) {
            outputParts.push(`exit ${result.errors.join("\n")}`);
          }
          if (result.logs.length > 0) {
            outputParts.push(result.logs.join("\n"));
          }
          const output = outputParts.join("\n") || "(no output)";

          roundTrace.toolCalls.push({
            sequence: callSequence,
            round: roundTrace.round,
            toolCallId: toolCall.id,
            name,
            args,
            command,
            output,
            errors: [...result.errors],
            instructionErrors: [...result.instructionErrors],
          });
          commandOutputs.push(`$ ${command}\n${output}`);

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: output,
          });

          const stopLossErrors = collectStopLossErrors(result.errorCodes);
          for (const cls of stopLossErrors) {
            const seen = (stopLossCounts.get(cls) ?? 0) + 1;
            stopLossCounts.set(cls, seen);
            if (seen >= 2) {
              stopReason = `stop-loss: repeated ${STOP_LOSS_LABELS[cls]} twice; stop retrying in this episode`;
              break;
            }
          }

          if (stopReason) {
            executionResult.instructionErrors.push(stopReason);
            const trace = roundTrace.toolCalls[roundTrace.toolCalls.length - 1];
            if (trace) {
              trace.instructionErrors.push(stopReason);
              trace.output = `${trace.output}\n${stopReason}`;
            }
            commandOutputs[commandOutputs.length - 1] =
              `${commandOutputs[commandOutputs.length - 1]}\n${stopReason}`;
            log.warn("TC loop stop-loss triggered", {
              provider: ctx.providerName,
              reason: stopReason,
              toolCallCount,
            });
            break tcLoop;
          }
        } else if (name === SIGNAL_TOOL_NAME) {
          signalCallCount++;
          const sig = String(args.afterward ?? "done") as Afterward;
          afterward = sig;
          const ack = `ack: ${sig}`;

          roundTrace.toolCalls.push({
            sequence: callSequence,
            round: roundTrace.round,
            toolCallId: toolCall.id,
            name,
            args,
            afterward: sig,
            output: ack,
            errors: [],
            instructionErrors: [],
          });

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: ack,
          });
        } else {
          log.warn("Unknown tool call", { name, toolCallId: toolCall.id });
          roundTrace.toolCalls.push({
            sequence: callSequence,
            round: roundTrace.round,
            toolCallId: toolCall.id,
            name,
            args,
            output: "(unknown tool)",
            errors: [],
            instructionErrors: [],
          });
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: "(unknown tool)",
          });
        }
      }
    }

    if (!budgetExhausted && toolCallCount >= TC_MAX_TOOL_CALLS) {
      budgetExhausted = true;
      log.warn("TC loop budget exhausted", { provider: ctx.providerName, toolCallCount });
    }
  } catch (e) {
    log.error("TC loop error", { provider: ctx.providerName, error: e });
    throw e;
  }

  const rawScript = rawScripts.join("\n\n");

  return {
    commandOutput: commandOutputs.join("\n---\n"),
    rawScript,
    afterward,
    toolCallCount,
    assistantTurnCount: transcript.length,
    bashCallCount,
    signalCallCount,
    budgetExhausted,
    transcript,
    // ScriptExecutionResult 字段
    logs: executionResult.logs,
    errors: executionResult.errors,
    instructionErrors: executionResult.instructionErrors,
    errorCodes: executionResult.errorCodes,
    errorDetails: executionResult.errorDetails,
    duration: Date.now() - startTime,
    thinks: executionResult.thinks,
    queryLogs: executionResult.queryLogs,
    observations: executionResult.observations,
    completedActions: executionResult.completedActions,
    silenceReason: executionResult.silenceReason,
  };
}
