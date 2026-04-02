/**
 * ADR-233: 原生 Tool Use 工具定义。
 *
 * 单 `run` 工具（执行 Alice CLI）+ `signal` 工具（afterward 语义）。
 *
 * TC 循环下 Flow 信号的新定义：
 * - 旧架构下 `watching` = "等中间结果"（intra-episode，被 TC 消解）
 * - TC 下 `watching` = "我还在关注，想继续说/观察展开"（inter-episode 行为状态）
 *
 * @see docs/adr/233-native-toolcall-bt-hybrid.md
 */
import type OpenAI from "openai";

/**
 * `run` 工具 — 执行 Alice shell 命令。
 *
 * 单工具设计：Alice 的所有能力已是 CLI 命令，不需要多工具目录。
 * LLM 在训练数据中有大量 `run(command="...")` 模式，理解成本极低。
 */
export const TOOL_RUN: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function" as const,
  function: {
    name: "run",
    description:
      "Execute Alice shell commands. " +
      "Write one command per line. " +
      "Available commands: irc (Telegram), self (perception/memory), engine (system), app (weather, music, etc). " +
      "Use '<command> --help' to discover usage. " +
      "TIP: Use 'echo' for scratchpad reasoning, '#' for comments.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "Multi-line POSIX sh script. " +
            "IMPORTANT: write one command per line, separated by newlines. " +
            "Examples:\n" +
            "  'irc tail 5'\n" +
            "  'self feel curious\\nirc say \"hello\"'\n" +
            "  'weather tokyo'",
        },
      },
      required: ["command"],
    },
  },
};

/**
 * `signal` 工具 — 表达 episode 结束后 orchestrator 的行为指令。
 *
 * Flow 信号只管 inter-episode 语义（episode 结束后做什么）。
 * Intra-episode 的工具链由 TC 循环自由控制，不需要 flow 信号。
 */
export const TOOL_SIGNAL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function" as const,
  function: {
    name: "signal",
    description:
      "Signal how this conversation should continue after your turn. " +
      "Call this ONCE at the end of your turn. " +
      "If you don't call signal, default is 'done'. " +
      "\n\n" +
      "done: finished (default if you don't call signal).\n" +
      "waiting_reply: you said something and expect their response.\n" +
      "watching: you said something but have more to say, or something is unfolding — " +
      "you want to continue in the next turn (stay engaged).\n" +
      "fed_up: walk away (closes conversation).\n" +
      "cooling_down: take a break (freezes chat for ~30 min).",
    parameters: {
      type: "object",
      properties: {
        afterward: {
          type: "string",
          enum: ["done", "waiting_reply", "watching", "fed_up", "cooling_down"],
          description: "How the conversation should continue. Default: done.",
        },
      },
      required: ["afterward"],
    },
  },
};

/** ADR-233 工具列表 — 导出供 TC 循环使用。 */
export const ADR233_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [TOOL_RUN, TOOL_SIGNAL];

/** Signal 工具的 afterward 值 — 单一来源，其他模块 import 此类型。 */
export type Afterward = "done" | "waiting_reply" | "watching" | "fed_up" | "cooling_down";

/**
 * 从 LLM 响应中提取 tool_use 参数。
 */
export function extractToolUseParams(
  toolCall: OpenAI.Chat.Completions.ChatCompletionMessageToolCall,
): { name: string; args: Record<string, unknown> } {
  try {
    // @ts-expect-error OpenAI SDK 类型定义不一致，实际结构是 { id, type, function: { name, arguments } }
    const fn = toolCall.function as { name: string; arguments: string };
    const args = JSON.parse(fn.arguments) as Record<string, unknown>;
    return { name: fn.name, args };
  } catch {
    // @ts-expect-error 同上
    return { name: (toolCall.function as { name: string }).name ?? "unknown", args: {} };
  }
}
