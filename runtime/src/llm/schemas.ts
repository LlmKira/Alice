/**
 * LLM 行动 schema（Zod 定义）。
 *
 * Schema 演化历史：
 * - V2 (ADR-64): message + sideEffects 分离（三字段：reasoning/message/sideEffects）— 已删除
 * - V3 (ADR-66): Script-First 收敛（单字段：script）— 已删除，合并入 TickStepSchema
 * - V4 (ADR-142): Blackboard Tick（needs + script）— 已删除
 * - V5 (§16): Script-only — man 内联激活，不再需要 JSON 层 needs 字段
 *
 * @see docs/adr/64-runtime-theory-alignment-audit.md
 * @see docs/adr/66-runtime-practice-review.md
 * @see docs/adr/163-expand-instruction-bt-native-disclosure.md §16
 */
import { z } from "zod";

// ── §16: Script-only Schema ────────────────────────────────────────
//
// man 在脚本内非终端调用，工具族激活由沙箱门控完成。
// JSON schema 只保留 script 字段——消除公理 B 违反（无 intent 的批量激活后门）。

/**
 * LLM 行动 schema — Blackboard Tick 管线使用。
 *
 * script: POSIX sh 脚本（shell-native 执行）。
 *   使用 Alice command space（irc / self / engine / app CLIs）。
 *
 * @see docs/adr/163-expand-instruction-bt-native-disclosure.md §16
 */
/**
 * 归一化 LLM 输出的脚本：
 * 1. 剥离 markdown 围栏
 * 2. 拆分单行多命令脚本（LLM 常见退化模式）
 *
 * @see preprocessScript in shell-executor.ts — 双重防线，这里做第一道
 */
const ALICE_COMMAND_RE = /\b(?:irc|self|engine|alice-pkg)\b/;
/** 导出供 callTickLLM generateText 路径使用。 */
export function normalizeScript(raw: string): string {
  let s = raw.trim();
  // 剥离 markdown 围栏
  if (/^```(?:sh|bash|shell)?\n?/i.test(s)) {
    s = s.replace(/^```(?:sh|bash|shell)?\n?/i, "");
    s = s.replace(/\n?```$/, "");
    s = s.trim();
  }
  // 单行脚本归一化：在 `# ` 注释边界和已知命令名前插入换行
  if (!s.includes("\n") && ALICE_COMMAND_RE.test(s)) {
    // 在 mid-line `# ` 前插入换行（拆分内心独白）
    s = s.replace(/(?<=\S)\s*(?=# )/g, "\n");
    // 在已知命令名前插入换行
    s = s.replace(/(?<=['"。！？.!?\s])(?=(?:irc|self|engine|alice-pkg)\b)/g, "\n");
    s = s.trim();
  }
  return s;
}

/**
 * ADR-215: LLM 直接表达的认知残留。
 * 语义归 LLM——代码只提供结构，不替 LLM 做判断。
 */
export const ResidueSchema = z.object({
  feeling: z
    .enum(["unresolved", "interrupted", "curious", "settled"])
    .describe(
      "How you feel as this conversation ends. " +
        "unresolved: something is bothering you that you couldn't express. " +
        "interrupted: you were cut off and want to come back. " +
        "curious: something caught your attention elsewhere. " +
        "settled: you're at peace — conversation ended naturally.",
    ),
  toward: z
    .string()
    .optional()
    .describe(
      "If your mind drifts to someone or somewhere, their @id (e.g. @7785440246). Omit if nowhere specific.",
    ),
  reason: z.string().max(200).optional().describe("Why, in a few words."),
});
export type LLMResidue = z.infer<typeof ResidueSchema>;

export const TickStepSchema = z.object({
  script: z
    .string()
    .min(1, "Script must not be empty")
    .describe(
      "A multi-line POSIX sh script file. " +
        "IMPORTANT: write one command per line, separated by newlines (\\n). " +
        "Use # comments on their own line for scratchpad reasoning. " +
        "Commands: irc (Telegram I/O), self (perception/queries), engine (instructions).",
    )
    .transform(normalizeScript),
  afterward: z
    .enum(["done", "waiting_reply", "watching", "fed_up", "cooling_down"])
    .describe(
      "What should happen to this chat after your turn. " +
        "done: finished — said what you wanted, nothing more to do (most common, use this by default). " +
        "waiting_reply: you JUST SAID something and are waiting for THEIR response — " +
        "if you asked a question, you must use this, not done. " +
        "watching: you just ran a command to fetch data (weather, music, search...) and need to " +
        "see its output before deciding what to say — your next execution will have the result. " +
        "Also use when something external is unfolding and you want to observe before deciding. " +
        "fed_up: the room is draining or hostile — walk away (penalty: closes the conversation). " +
        "cooling_down: the room is spammy or toxic — take a break (penalty: freezes this chat for ~30 min).",
    ),
  // ADR-215: Episode residue — LLM 直接表达认知残留。
  // Optional: 只在有未消化的感受时填写。大多数情况下不填。
  residue: ResidueSchema.optional().describe(
    "Only fill this if something feels unfinished or unresolved as you leave this conversation. " +
      "Most of the time, omit this entirely.",
  ),
});
export type TickStep = z.infer<typeof TickStepSchema>;
