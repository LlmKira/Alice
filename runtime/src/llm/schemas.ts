/**
 * LLM 行动 schema（Zod 定义）。
 *
 * Schema 演化历史：
 * - V2 (ADR-64): message + sideEffects 分离（三字段：reasoning/message/sideEffects）— 已删除
 * - V3 (ADR-66): Script-First 收敛（单字段：script）— 已删除，合并入 TickStepSchema
 * - V4 (ADR-142): Blackboard Tick（needs + script）— 已删除
 * - V5 (§16): Script-only — shell manual 扁平可见，不再需要 JSON 层 needs 字段
 *
 * @see docs/adr/64-runtime-theory-alignment-audit.md
 * @see docs/adr/66-runtime-practice-review.md
 * @see docs/adr/163-expand-instruction-bt-native-disclosure.md §16
 */
import { z } from "zod";

// ── §16: Script-only Schema ────────────────────────────────────────
//
// JSON schema 只保留 script 字段；命令发现由 shell manual 和 `<command> --help` 承担。
// 旧 needs/man/prepare 激活机制已退出普通路径，避免无 intent 的批量激活后门。

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
const ALICE_COMMAND_RE = /\b(?:irc|album|self|engine|alice-pkg)\b/;
/** 导出供 callTickLLM generateText 路径使用。 */
export function normalizeScript(raw: string): string {
  let s = raw.trim();
  if (!s) return "# no action";
  // 剥离 markdown 围栏
  if (/^```(?:sh|bash|shell)?\n?/i.test(s)) {
    s = s.replace(/^```(?:sh|bash|shell)?\n?/i, "");
    s = s.replace(/\n?```$/, "");
    s = s.trim();
  }
  if (!s) return "# no action";
  // Some providers leak the markdown language label into the JSON string:
  // {"script":"sh\nirc read"}. The script already runs inside a shell, so a
  // leading language label is transport noise, not an Alice command.
  s = s.replace(/^(?:sh|bash|shell)\s*\n/i, "").trim();
  if (!s) return "# no action";
  // 单行脚本归一化：在 `# ` 注释边界和已知命令名前插入换行
  if (!s.includes("\n") && ALICE_COMMAND_RE.test(s)) {
    // 在 mid-line `# ` 前插入换行（拆分内心独白）
    s = s.replace(/(?<=\S)\s*(?=# )/g, "\n");
    // 在已知命令名前插入换行
    s = s.replace(/(?<=['"。！？.!?\s])(?=(?:irc|album|self|engine|alice-pkg)\b)/g, "\n");
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

function formatSchemaError(error: {
  issues: Array<{ path: Array<string | number>; message: string }>;
}): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("\n");
}

function parseJsonCandidate(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();

  try {
    return JSON.parse(candidate);
  } catch (firstError) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        // Report the original error; it best describes the model's response shape.
      }
    }
    throw firstError;
  }
}

function normalizeResidue(value: unknown): unknown {
  if (value === null) return undefined;
  if (typeof value === "object") {
    if (Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const feeling = normalizeResidueFeeling(record.feeling);
    if (!feeling) return undefined;
    return {
      feeling,
      ...(typeof record.toward === "string" && record.toward.trim()
        ? { toward: record.toward.trim() }
        : {}),
      ...(typeof record.reason === "string" && record.reason.trim()
        ? { reason: record.reason.trim().slice(0, 200) }
        : {}),
    };
  }
  if (typeof value !== "string") return value;

  const feeling = normalizeResidueFeeling(value);
  return feeling ? { feeling } : undefined;
}

function normalizeResidueFeeling(value: unknown): LLMResidue["feeling"] | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed === "none" || trimmed === "null" || trimmed === "settled") {
    return null;
  }
  if (["unresolved", "interrupted", "curious"].includes(trimmed)) {
    return trimmed as LLMResidue["feeling"];
  }
  return null;
}

export const TickStepSchema = z.object({
  script: z
    .preprocess(
      (value) => (typeof value === "string" ? normalizeScript(value) : value),
      z.string().min(1, "Script must not be empty"),
    )
    .describe(
      "A multi-line POSIX sh script file. " +
        "IMPORTANT: write one command per line, separated by newlines (\\n). " +
        "Use # comments on their own line for scratchpad reasoning. " +
        "Commands: irc (Telegram I/O), self (perception/queries), engine (instructions).",
    ),
  afterward: z
    .enum(["done", "waiting_reply", "watching", "resting", "fed_up", "cooling_down"])
    .describe(
      "What should happen to this chat after your turn. " +
        "done: finished — said what you wanted, nothing more to do (most common, use this by default). " +
        "waiting_reply: you JUST SAID something and are waiting for THEIR response — " +
        "if you asked a question, you must use this, not done. " +
        "watching: after this turn, stay engaged with this chat because something is still unfolding " +
        "or you want to keep the thread warm. The host may continue immediately if fresh local " +
        "observations appear; otherwise it will keep watching this chat for the next turn. " +
        "resting: you are tired, going to sleep, or leaving Telegram for a while — " +
        "the host should stop ordinary follow-up until rest expires. " +
        "fed_up: the room is draining or hostile — walk away (penalty: closes the conversation). " +
        "cooling_down: the room is spammy or toxic — take a break (penalty: freezes this chat for ~30 min).",
    ),
  // ADR-215: Episode residue — LLM 直接表达认知残留。
  // Optional: 只在有未消化的感受时填写。大多数情况下不填。
  residue: z
    .preprocess(normalizeResidue, ResidueSchema.optional())
    .describe(
      "Only fill this if something feels unfinished or unresolved as you leave this conversation. " +
        "Most of the time, omit this entirely.",
    ),
});
export type TickStep = z.infer<typeof TickStepSchema>;

export function parseTickStep(text: string): TickStep {
  let json: unknown;
  try {
    json = parseJsonCandidate(text);
  } catch (error) {
    throw new Error(
      `Structured block JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = TickStepSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `Structured block schema validation failed:\n${formatSchemaError(parsed.error)}`,
    );
  }
  return parsed.data;
}
