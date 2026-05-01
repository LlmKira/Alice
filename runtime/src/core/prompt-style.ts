/**
 * Alice Prompt Style Spec — 排版构建器 + linter 安全网。
 *
 * 主要机制：PromptBuilder 构建器只暴露合规操作（heading/kv/line/list/timeline），
 * 从构造时就消除违规可能——无需后验。
 *
 * 安全网：lintPromptStyle() 对最终组装文本做兜底校验，
 * 捕获未经 builder 的裸字符串漏网。
 *
 * 排版规范（Style Spec）：
 *   允许：## Title, Key: value, - item, [HH:MM] Name: text, ```code```, ---, 裸文本
 *   禁止：缩进、> blockquote、**bold**、*italic*、嵌套列表、#/###
 *
 * @see docs/adr/141-prompt-style-spec.md
 */

import { createLogger } from "../utils/logger.js";

const log = createLogger("prompt-style");

// ═══════════════════════════════════════════════════════════════════════════
// Branded type — 只能由 PromptBuilder 产出
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Branded string 类型——只能由 PromptBuilder 产出。
 * 防止裸 string[] 绕过 builder 注入 ContributionItem。
 */
export type PromptLine = string & { readonly __brand: "PromptLine" };

// ═══════════════════════════════════════════════════════════════════════════
// Builder — 构造时保证合规
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Prompt 内容构建器。
 *
 * 只暴露合规操作，输出保证符合 Style Spec。
 * Mod 在 contribute() 中用 `const m = new PromptBuilder()` 替代裸 `string[]`。
 *
 * ```typescript
 * const m = new PromptBuilder();
 * m.kv("Mood", "neutral");
 * m.timeline("14:32", "Carol", "你看！");
 * m.line("Some observation.");
 * return section("key", m.build());
 * ```
 */
export class PromptBuilder {
  private readonly lines: PromptLine[] = [];

  /** ## 节标题。 */
  heading(title: string): this {
    this.lines.push(`## ${title}` as PromptLine);
    return this;
  }

  /** Key: value 键值对。 */
  kv(key: string, value: string): this {
    this.lines.push(`${key}: ${value}` as PromptLine);
    return this;
  }

  /** 裸文本行（零缩进）。 */
  line(text: string): this {
    this.lines.push(text as PromptLine);
    return this;
  }

  /** 空行。 */
  blank(): this {
    this.lines.push("" as PromptLine);
    return this;
  }

  /** - 列表项（零缩进，扁平）。内嵌换行自动合并为空格，防止格式爆裂。 */
  list(items: string[]): this {
    for (const item of items) {
      this.lines.push(`- ${item.replaceAll("\n", " ")}` as PromptLine);
    }
    return this;
  }

  /** [HH:MM] Name (msgId N): text 时间线条目。msgId 可选，用于 irc forward --ref 引用。 */
  timeline(time: string, name: string, text: string, msgId?: number | null): this {
    const idTag = msgId != null && msgId > 0 ? ` (msgId ${msgId})` : "";
    this.lines.push(`[${time}] ${name}${idTag}: ${text}` as PromptLine);
    return this;
  }

  /** --- 分隔线。 */
  separator(): this {
    this.lines.push("---" as PromptLine);
    return this;
  }

  /** 输出 PromptLine[]，直接用于 ContributionItem.lines。 */
  build(): PromptLine[] {
    return [...this.lines];
  }

  /** 将裸文本（可含换行）拆为 PromptLine[]。用于预格式化常量（如 SOUL_CORE）。 */
  static fromRaw(text: string): PromptLine[] {
    return text.split("\n") as PromptLine[];
  }

  /** 将单行文本标记为 PromptLine。多行文本应使用 fromRaw()。 */
  static of(text: string): PromptLine {
    if (text.includes("\n")) {
      log.warn("PromptBuilder.of() received multi-line text; use fromRaw() instead", {
        preview: text.slice(0, 80),
      });
    }
    return text as PromptLine;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Linter — 安全网（兜底校验）
// ═══════════════════════════════════════════════════════════════════════════

export interface StyleViolation {
  rule: string;
  line: number;
  text: string;
  message: string;
}

export interface PromptStyleEnforcementOptions {
  /**
   * 违规则如何落日志。
   *
   * - warn: 默认。适用于 system prompt 等纯内部生成文本
   * - debug: 仅审计，不干扰日常日志。适用于夹带 Telegram 原始内容的 user prompt
   * - silent: 仅返回计数，不落日志
   */
  violationLogLevel?: "warn" | "debug" | "silent";
}

const RULES: Array<{ name: string; test: (line: string) => boolean; msg: string }> = [
  { name: "no-indent", test: (l) => /^[ \t]+\S/.test(l), msg: "行首禁止缩进" },
  { name: "no-bare-title", test: (l) => /^[A-Z][\w ]+:\s*$/.test(l), msg: "裸标题 → ## Title" },
  { name: "no-h1", test: (l) => /^# [^#]/.test(l), msg: "禁止 # → 用 ##" },
  { name: "no-h3", test: (l) => /^###+ /.test(l), msg: "禁止 ### 及更深" },
  { name: "no-bold", test: (l) => /\*\*[^*]+\*\*/.test(l), msg: "禁止 **bold**" },
  { name: "no-blockquote", test: (l) => /^> /.test(l), msg: "禁止 > blockquote" },
  { name: "no-nested-list", test: (l) => /^ +- /.test(l), msg: "禁止嵌套列表" },
];

/**
 * 对组装后的 prompt 文本校验排版规范。
 *
 * 自动跳过 ```...``` 代码块（手册区域允许缩进和特殊格式）
 * 和 `---` 分隔线（zone 硬分界）。
 */
export function lintPromptStyle(text: string): StyleViolation[] {
  const lines = text.split("\n");
  const violations: StyleViolation[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 代码块边界切换
    if (line.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    if (line.trim() === "" || line.trim() === "---") continue;

    for (const rule of RULES) {
      if (rule.test(line)) {
        violations.push({ rule: rule.name, line: i + 1, text: line, message: rule.msg });
      }
    }
  }

  return violations;
}

/**
 * 强制校验 — 有 violation 时打 warn 日志。
 * 在 buildPrompt 管线末端集成调用。
 *
 * @returns violation 数量
 */
export function enforcePromptStyle(
  text: string,
  label: string,
  options: PromptStyleEnforcementOptions = {},
): number {
  const violations = lintPromptStyle(text);
  if (violations.length > 0) {
    const payload = {
      count: violations.length,
      first5: violations.slice(0, 5).map((v) => `L${v.line} [${v.rule}] ${v.message}: ${v.text}`),
    };
    const level = options.violationLogLevel ?? "warn";
    if (level === "warn") {
      log.warn(`Prompt style violations in ${label}`, payload);
    } else if (level === "debug") {
      log.debug(`Prompt style violations in ${label}`, payload);
    }
  }
  return violations.length;
}
