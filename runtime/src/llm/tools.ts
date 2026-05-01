/**
 * ADR-233: 原生 Tool Use 工具定义。
 *
 * 单 `bash` 工具（执行 POSIX sh 脚本）+ `signal` 工具（afterward 语义）。
 *
 * TC 循环下 Flow 信号的新定义：
 * - 旧架构下 `watching` = "等中间结果"（intra-episode，被 TC 消解）
 * - TC 下 `watching` = "这一轮结束后我还想继续关注这个聊天"（inter-episode 行为状态）
 * - 同一 tick 内是否继续执行，由 host 根据本地 observations / 错误反馈决定
 *
 * @see docs/adr/233-native-toolcall-bt-hybrid.md
 * @see nanoclaw (Bash tool), pi-mono (BashOperations)
 */
import type OpenAI from "openai";

/**
 * `bash` 工具 — 执行 POSIX sh 脚本（在 Docker 容器中）。
 *
 * 单工具设计：Alice 的所有能力通过 CLI 命令暴露（irc/self/engine/app），
 * LLM 写纯 bash 脚本，容器中执行。
 *
 * 与 NanoClaw/pi-mono 对齐：工具命名 `bash` 准确反映技术本质。
 */
export const TOOL_BASH: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function" as const,
  function: {
    name: "bash",
    description:
      "Execute bash commands in a sandboxed Docker container. " +
      "Available commands: irc (Telegram), self (perception/memory), " +
      "engine (system), app (weather, music, etc). " +
      "TIP: Use '<command> --help' to discover usage. " +
      "You can chain commands with pipes and redirects. " +
      "Use 'echo' for scratchpad reasoning, '#' for comments.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "Multi-line POSIX sh script. " +
            "IMPORTANT: write one command per line, separated by newlines. " +
            "Examples:\n" +
            "  'irc tail --count 5'\n" +
            "  'self feel curious\\nirc say --text \"hello\"'\n" +
            "  'weather tokyo | grep -i sun'",
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
      "watching: after this turn, stay engaged with this chat because something is still unfolding " +
      "or you want to keep the thread warm. Immediate same-tick follow-up is host-controlled.\n" +
      "resting: you are tired, going to sleep, or leaving Telegram for a while.\n" +
      "fed_up: walk away (closes conversation).\n" +
      "cooling_down: take a break (freezes chat for ~30 min).",
    parameters: {
      type: "object",
      properties: {
        afterward: {
          type: "string",
          enum: ["done", "waiting_reply", "watching", "resting", "fed_up", "cooling_down"],
          description: "How the conversation should continue. Default: done.",
        },
      },
      required: ["afterward"],
    },
  },
};

/** ADR-233 工具列表 — 导出供 TC 循环使用。 */
export const ADR233_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [TOOL_BASH, TOOL_SIGNAL];

/** Signal 工具的 afterward 值 — 单一来源，其他模块 import 此类型。 */
export type Afterward =
  | "done"
  | "waiting_reply"
  | "watching"
  | "resting"
  | "fed_up"
  | "cooling_down";

/**
 * 从 LLM 响应中提取 tool_use 参数。
 */
export function extractToolUseParams(
  toolCall: OpenAI.Chat.Completions.ChatCompletionMessageToolCall,
): { name: string; args: Record<string, unknown> } {
  // ChatCompletionMessageToolCall = FunctionToolCall | CustomToolCall
  // 我们只处理 function 类型（LLM 标准 tool_use）
  if (toolCall.type !== "function") {
    return { name: "unknown", args: {} };
  }

  try {
    const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
    return { name: toolCall.function.name, args };
  } catch {
    return { name: toolCall.function.name, args: {} };
  }
}
