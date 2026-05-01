/**
 * Prompt 日志 — 生产环境拦截完整 LLM prompt + 响应，落盘为 markdown。
 *
 * 启用方式：环境变量 ALICE_PROMPT_LOG=true
 * 输出目录：runtime/prompt-logs/（自动创建，.gitignore 排除）
 *
 * 每次 LLM 调用产生一个 markdown 文件，包含：
 * - 元数据（tick / target / voice / round / 时间）
 * - 完整 system prompt
 * - 完整 user prompt
 * - LLM 生成的脚本（rawScript）
 * - 执行结果（afterward / 调用计数 / transcript / thinks / instructionErrors / errors / command output）
 *
 * 用途：事后诊断 prompt 工程问题——看 LLM 看到了什么、产出了什么。
 *
 * @see docs/adr/78-naturalness-hotfixes.md — 实战群聊诊断
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TCAssistantRoundTrace } from "../engine/tick/tc-loop.js";
import type { IntraTickContinuationReason } from "../engine/tick/types.js";
import type { Afterward } from "../llm/tools.js";
import { createLogger } from "../utils/logger.js";
import { renderDcpShadowContext } from "./dcp-shadow.js";

const log = createLogger("prompt-log");
const __dirname = dirname(fileURLToPath(import.meta.url));

/** prompt-logs 目录（runtime/prompt-logs/） */
const LOG_DIR = resolve(__dirname, "../../prompt-logs");

/** 是否启用 prompt 日志。 */
export function isPromptLogEnabled(): boolean {
  return process.env.ALICE_PROMPT_LOG === "true" || process.env.ALICE_PROMPT_LOG === "1";
}

/** prompt 快照的输入数据。 */
export interface PromptSnapshot {
  tick: number;
  target: string | null;
  voice: string;
  round: number;
  system: string;
  user: string;
  /** LLM 生成的脚本（rawScript，null = LLM 调用失败）。 */
  script: string | null;
  /** 执行数据（LLM 调用成功时存在）。 */
  execution?: {
    afterward: Afterward;
    toolCallCount: number;
    assistantTurnCount?: number;
    bashCallCount?: number;
    signalCallCount?: number;
    budgetExhausted: boolean;
    transcript?: TCAssistantRoundTrace[];
    /** 聚合的 `$ cmd\noutput` 块（完整命令+输出对）。 */
    commandOutput: string;
    thinks: string[];
    queryLogs: Array<{ fn: string; result: string }>;
    instructionErrors: string[];
    errors: string[];
    hostContinuedInTick?: boolean;
    hostContinuationReason?: IntraTickContinuationReason;
  };
}

function renderTranscript(transcript: TCAssistantRoundTrace[]): string[] {
  const parts: string[] = ["### Transcript", ""];

  for (const round of transcript) {
    parts.push(`#### Assistant Round ${round.round + 1}`, "");
    parts.push(`- tool choice: ${round.toolChoice}`);
    if (round.finishReason) {
      parts.push(`- finish reason: ${round.finishReason}`);
    }
    parts.push(`- assistant text: ${round.assistantText || "(none)"}`);
    parts.push(`- tool calls: ${round.toolCalls.length}`, "");

    for (const toolCall of round.toolCalls) {
      parts.push(`##### ${toolCall.name} #${toolCall.sequence} (\`${toolCall.toolCallId}\`)`, "");

      if (toolCall.command) {
        parts.push("```sh", toolCall.command, "```", "");
      } else if (toolCall.afterward) {
        parts.push(`- afterward: ${toolCall.afterward}`, "");
      } else if (Object.keys(toolCall.args).length > 0) {
        parts.push("```json", JSON.stringify(toolCall.args, null, 2), "```", "");
      }

      if (toolCall.output) {
        parts.push("```", toolCall.output, "```", "");
      }
    }
  }

  return parts;
}

/**
 * 将 prompt 快照写入 markdown 文件。
 *
 * 文件名格式：{tick}-{round}-{target}-{timestamp}.md
 * 非阻塞——写入失败只 log.warn，不影响主流程。
 */
export function logPromptSnapshot(snapshot: PromptSnapshot): void {
  if (!isPromptLogEnabled()) return;

  try {
    mkdirSync(LOG_DIR, { recursive: true });

    const ts = new Date();
    const tsStr = ts.toISOString().replace(/[:.]/g, "-");
    const targetSlug = (snapshot.target ?? "no-target").replace(/[^a-zA-Z0-9_-]/g, "_");
    const filename = `${snapshot.tick}-r${snapshot.round}-${targetSlug}-${tsStr}.md`;
    const filepath = resolve(LOG_DIR, filename);

    const parts: string[] = [
      `# Prompt Snapshot — tick ${snapshot.tick}, round ${snapshot.round}`,
      "",
      "| Key | Value |",
      "|-----|-------|",
      `| tick | ${snapshot.tick} |`,
      `| round | ${snapshot.round} |`,
      `| target | ${snapshot.target ?? "(none)"} |`,
      `| voice | ${snapshot.voice} |`,
      `| time | ${ts.toISOString()} |`,
      `| script | ${snapshot.script === null ? "FAILED" : snapshot.script.length > 0 ? `${snapshot.script.length} chars` : "SILENT (0 tools)"} |`,
      "",
    ];

    // System prompt
    parts.push("## System Prompt", "", "```", snapshot.system, "```", "");

    // User prompt
    parts.push("## User Prompt", "", "```", snapshot.user, "```", "");

    // ADR-248: DCP shadow context for prompt diagnostics only.
    // @see docs/adr/248-dcp-reference-implementation-plan/README.md §Implementation Log
    parts.push(...renderDcpShadowContext(snapshot.target));

    // LLM script
    if (snapshot.script === null) {
      parts.push("## LLM Script", "", "**LLM 调用失败**", "");
    } else if (snapshot.script.length === 0) {
      parts.push("## LLM Script", "", "**模型未调用任何工具（静默）**", "");
    } else {
      parts.push("## LLM Script", "", "```sh", snapshot.script, "```", "");
    }

    // 执行结果
    if (snapshot.execution) {
      const ex = snapshot.execution;

      parts.push("## Execution", "");
      parts.push(`- afterward: ${ex.afterward}`);
      parts.push(`- tool calls: ${ex.toolCallCount}`);
      if (ex.assistantTurnCount != null) parts.push(`- assistant turns: ${ex.assistantTurnCount}`);
      if (ex.bashCallCount != null) parts.push(`- bash calls: ${ex.bashCallCount}`);
      if (ex.signalCallCount != null) parts.push(`- signal calls: ${ex.signalCallCount}`);
      if (ex.hostContinuedInTick != null) {
        parts.push(`- host continued in tick: ${ex.hostContinuedInTick ? "yes" : "no"}`);
      }
      if (ex.hostContinuedInTick && ex.hostContinuationReason) {
        parts.push(`- host continuation reason: ${ex.hostContinuationReason}`);
      }
      if (ex.budgetExhausted) parts.push("- **budget exhausted**");
      parts.push("");

      if (ex.transcript && ex.transcript.length > 0) {
        parts.push(...renderTranscript(ex.transcript), "");
      }

      if (ex.thinks.length > 0) {
        parts.push("### Thinks", "");
        for (const t of ex.thinks) {
          parts.push(`- ${t}`);
        }
        parts.push("");
      }

      if (ex.queryLogs.length > 0) {
        parts.push("### Query Logs", "");
        for (const q of ex.queryLogs) {
          const preview = q.result.length > 200 ? `${q.result.slice(0, 200)}...` : q.result;
          parts.push(`- \`${q.fn}\`: ${preview}`);
        }
        parts.push("");
      }

      if (ex.instructionErrors.length > 0) {
        parts.push("### Instruction Errors", "");
        for (const e of ex.instructionErrors) {
          parts.push(`- ${e}`);
        }
        parts.push("");
      }

      if (ex.errors.length > 0) {
        parts.push("### Errors", "");
        for (const e of ex.errors) {
          parts.push(`- ${e}`);
        }
        parts.push("");
      }

      if (ex.commandOutput) {
        parts.push("### Command Output", "", "```", ex.commandOutput, "```", "");
      }
    }

    writeFileSync(filepath, parts.join("\n"), "utf-8");
    log.info("Prompt snapshot saved", { filepath: filename });
  } catch (e) {
    // 写入失败不影响主流程
    log.warn("Failed to save prompt snapshot", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
