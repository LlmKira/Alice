/**
 * 沙箱原语的 Zod 字数限制 — 防御 LLM 异常输出。
 *
 * 使用 .transform() 截断而非 .max() 拒绝：
 * - 宁可截断也不要丢弃整个操作
 * - LLM 对精确字数没有感知，多 1 字就 reject 不合理
 */
import { z } from "zod";

/** 创建截断字符串 schema：超过 max 字符时静默截断。 */
const truncStr = (max: number) => z.string().transform((s) => s.slice(0, max));

// ── 共享枚举 ─────────────────────────────────────────────────────────────

/**
 * Deadline 语义标签 — LLM 选标签，代码映射数值。
 * 遵循 AGENTS.md「语义归 LLM，结构归代码」和「LLM 语义无障碍」。
 * 语言无关：任何语种的 LLM 都能正确选择这些英文标签。
 */
export const DEADLINE_LABELS = [
  "hours",
  "today",
  "tomorrow",
  "days",
  "week",
  "weeks",
  "month",
] as const;

/** Deadline 标签 → horizon（ticks，1 tick ≈ 1 hour）。 */
export const DEADLINE_TO_HORIZON: Record<(typeof DEADLINE_LABELS)[number], number> = {
  hours: 12,
  today: 24,
  tomorrow: 48,
  days: 168,
  week: 168,
  weeks: 336,
  month: 720,
};

/**
 * 将 deadline 语义标签转换为 horizon（ticks）。
 * 非法标签 fallback 到 "week"（168 ticks），不拒绝。
 */
export function deadlineToHorizon(label?: string): number {
  if (!label) return DEADLINE_TO_HORIZON.week;
  return DEADLINE_TO_HORIZON[label as (typeof DEADLINE_LABELS)[number]] ?? DEADLINE_TO_HORIZON.week;
}

// ── 文本清洗 ─────────────────────────────────────────────────────────────

/**
 * 剥离 LLM 从 prompt 上下文中复制的注解标记。
 * 仅匹配已知媒体/元数据关键词或 emoji×count 反应格式，不误伤正常文本。
 *
 * 方括号版本（遗留 + 安全网 — 拦截 LLM 从历史上下文中复制的旧格式）：
 *   Pattern 1: `[keyword ...]` — 关键词注解（sticker/photo/voice/...）
 *   Pattern 2: `[emoji×N ...]` — 反应注解（无关键词，靠 ×digits 识别）
 *
 * 圆括号版本（新格式 defense-in-depth — prompt 现在使用 `(...)` 注解）：
 *   Pattern 3: `(keyword ...)` — 如果 LLM 连圆括号注解也复制到输出中
 *   Pattern 4: `(emoji×N ...)` — 圆括号版反应注解
 */
const KEYWORD_ANNOTATION_RE =
  /\[(sticker|photo|voice|gif|video|document|media|poll|contact|venue|reacts|edited|fwd)(?:[:\s|][^\]]*)?]/gi;
const REACTION_ANNOTATION_RE = /\[[^[\]]*×\d+[^[\]]*]/g;

const PAREN_ANNOTATION_RE =
  /\((sticker|photo|voice|gif|video|document|media|poll|contact|venue|reacts|edited|fwd)(?:[:\s|][^)]*)??\)/gi;
const PAREN_REACTION_RE = /\([^()]*×\d+[^()]*\)/g;

/**
 * 方括号注解检测 — Zod refine 安全网。
 *
 * 审计修复: 收窄匹配范围。旧正则 `/\[(?!\d{1,2}:\d{2}])[^[\]]{2,}\]/` 误拒
 * LLM 生成的合法中文方括号内容（[笑]、[链接文本]、[index]），导致 safeParse
 * 失败消息被静默丢弃（"失语"）。
 *
 * 新策略: 只匹配已知的 prompt 注解模式（以英文 media 关键词开头的方括号内容），
 * 而非"所有方括号内容"。KEYWORD_ANNOTATION_RE 和 REACTION_ANNOTATION_RE
 * 在 sanitize 阶段已处理大部分情况，此处作为 defense-in-depth 的最后防线。
 */
const BRACKET_ANNOTATION_RE =
  /\[(?:sticker|photo|voice|gif|video|document|media|poll|contact|venue|reacts|edited|fwd|forwarded|reply|audio|action)\b[^[\]]*]/i;

/**
 * ASCII 直引号 → 排版引号。
 *
 * generateObject / tool calling 模式下，LLM 处于 JSON 语法空间，
 * 倾向于用 ASCII `'` `"` 做引用——人类聊天不这样写。
 *
 * 只保留两种引号：
 * - 中文引号 ""（U+201C/U+201D）——中文内容一律用这个
 * - 英文撇号 '（U+2019）——仅用于 don't / it's 等缩写
 *
 * 关键规则：`'中文'` → `"中文"`（中国人不用单引号做主引号）。
 */
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;

export function normalizeQuotes(s: string): string {
  // 成对双引号 "..." → "..."
  let r = s.replace(/"([^"\n]+)"/g, "\u201c$1\u201d");
  // 成对单引号 '...'：CJK 内容提升为中文双引号，英文保留为单引号
  r = r.replace(/'([^'\n]+)'/g, (_, content) =>
    CJK_RE.test(content) ? `\u201c${content}\u201d` : `\u2018${content}\u2019`,
  );
  // 剩余孤立 " → "
  r = r.replace(/"/g, "\u201d");
  // 剩余孤立 ' → '（英文撇号）
  r = r.replace(/'/g, "\u2019");
  return r;
}

/**
 * 削掉句尾孤立句号（中文。或英文.）。
 * 省略号（...、。。。、…）保留——它们是表达性标点，不是 LLM 味。
 */
function trimTrailingPeriod(s: string): string {
  return s.replace(/(?<![.。…])([.。])$/, "");
}

/**
 * shell 脚本文本参数里，LLM 常把换行写成字面量 \n。
 * Telegram 用户应看到真实换行，不应看到反斜杠+n。
 */
function decodeEscapedNewlines(s: string): string {
  return s.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\r/g, "\n");
}

/** 清洗 LLM 输出文本：剥离泄漏的注解标记 + 句尾句号 + 引号规范化 + 截断。 */
export function sanitizeOutgoingText(s: string, max = 4096): string {
  return normalizeQuotes(
    trimTrailingPeriod(
      decodeEscapedNewlines(s)
        .replace(KEYWORD_ANNOTATION_RE, "")
        .replace(REACTION_ANNOTATION_RE, "")
        .replace(PAREN_ANNOTATION_RE, "")
        .replace(PAREN_REACTION_RE, "")
        .trim(),
    ),
  ).slice(0, max);
}

// ── 控制流原语 schema ─────────────────────────────────────────────────────

/** think(thought) — 2000 字符上限，超长 reasoning 无意义。 */
export const ThinkSchema = truncStr(2000);

/** stay_silent(reason) — 500 字符上限。 */
export const StaySilentSchema = truncStr(500);

/** reply(text, replyTo?) — text 4096（Telegram API 上限），replyTo 正整数。 */
export const ReplySchema = z.object({
  text: z
    .string()
    .min(1)
    .refine((s) => !BRACKET_ANNOTATION_RE.test(s), {
      message: "square bracket annotations are not allowed in message text",
    })
    .transform((s) => sanitizeOutgoingText(s)),
  replyTo: z.number().int().positive().optional(),
});

/** say(text) — 向群组/聊天说一句话（不回复任何消息）。ADR-118: 语义分离。 */
export const SaySchema = z.object({
  text: z
    .string()
    .min(1)
    .refine((s) => !BRACKET_ANNOTATION_RE.test(s), {
      message: "square bracket annotations are not allowed in message text",
    })
    .transform((s) => sanitizeOutgoingText(s)),
});
