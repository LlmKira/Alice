/**
 * action 定义共享件。
 *
 * - ALLOWED_REACTIONS + TelegramReactionSchema（reaction.ts 消费）
 * - ExplorationGuard 全局实例（group.ts 消费）
 * - usageHint helpers（strategy.mod + 测试消费）
 */

import { z } from "zod";
import type { ActionCategory, TelegramActionDef } from "../action-types.js";
import { ExplorationGuard } from "../exploration-guard.js";

// ═══════════════════════════════════════════════════════════════════════════
// Telegram Reaction 白名单
// ═══════════════════════════════════════════════════════════════════════════

// Telegram 允许的 reaction emoji 白名单（2024 版，含 Telegram Premium 常用子集）。
// 不在此列表中的 emoji 会被 API 拒绝（"The specified reaction is invalid."）。
// @see https://core.telegram.org/api/reactions
export const ALLOWED_REACTIONS = new Set([
  "👍",
  "👎",
  "❤",
  "🔥",
  "🥰",
  "👏",
  "😁",
  "🤔",
  "🤯",
  "😱",
  "🤬",
  "😢",
  "🎉",
  "🤩",
  "🤮",
  "💩",
  "🙏",
  "👌",
  "🕊",
  "🤡",
  "🥱",
  "🥴",
  "😍",
  "🐳",
  "❤‍🔥",
  "🌚",
  "🌭",
  "💯",
  "🤣",
  "⚡",
  "🍌",
  "🏆",
  "💔",
  "🤨",
  "😐",
  "🍓",
  "🍾",
  "💋",
  "🖕",
  "😈",
  "😴",
  "😭",
  "🤓",
  "👻",
  "👨‍💻",
  "👀",
  "🎃",
  "🙈",
  "😇",
  "😨",
  "🤝",
  "✍",
  "🤗",
  "🫡",
  "🎅",
  "🎄",
  "☃",
  "💅",
  "🤪",
  "🗿",
  "🆒",
  "💘",
  "🙉",
  "🦄",
  "😘",
  "💊",
  "🙊",
  "😎",
  "👾",
  "🤷‍♂",
  "🤷",
  "🤷‍♀",
  "😡",
]);

/** Telegram reaction 比较前的 Unicode 归一化。 */
export function normalizeReactionEmoji(emoji: string): string {
  return emoji.trim().replace(/\uFE0F/g, "");
}

/** Zod schema：coerce + 白名单验证。沙箱录入阶段即拦截非法 emoji。 */
export const TelegramReactionSchema = z.preprocess(
  (v) => (v == null ? "" : normalizeReactionEmoji(String(v))),
  z.string().refine((s) => ALLOWED_REACTIONS.has(s), {
    message: "Not a valid Telegram reaction emoji",
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// 全局 ExplorationGuard 实例
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 全局探索保护守卫。由 initExplorationGuard() 初始化。
 * 默认创建一个使用默认配置的实例（测试和生产均可用）。
 */
let explorationGuard = new ExplorationGuard();

/**
 * 用外部配置初始化全局 ExplorationGuard。
 * 由 bootstrap / index.ts 在加载 config 后调用。
 */
export function initExplorationGuard(
  config?: Partial<import("../exploration-guard.js").ExplorationConfig>,
): void {
  explorationGuard = new ExplorationGuard(config);
}

/** 用完整 ExplorationGuard 实例替换全局守卫（测试专用）。 */
export function setExplorationGuard(guard: ExplorationGuard): void {
  explorationGuard = guard;
}

/** 获取当前全局 ExplorationGuard 实例。 */
export function getExplorationGuard(): ExplorationGuard {
  return explorationGuard;
}

// ═══════════════════════════════════════════════════════════════════════════
// usageHint 工具函数（供 strategy.mod 消费）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 按类别返回 usageHint 列表。
 * strategy.mod 用此函数自动生成 capability hints，
 * 而非硬编码函数名字符串（QUERY_* 幻觉的根因）。
 *
 * 注意：此函数引用 TELEGRAM_ACTIONS，由 index.ts 在模块加载后可用（循环安全）。
 *
 * @see docs/adr/51-m5-interaction-primitives-implementation.md — QUERY_* 教训
 */
let _actions: TelegramActionDef[] = [];

/** 由 index.ts 调用，注入全量 action 数组（避免循环导入）。 */
export function _setActions(actions: TelegramActionDef[]): void {
  _actions = actions;
}

export function getUsageHintsByCategory(
  category: ActionCategory,
): Array<{ name: string; hint: string }> {
  return _actions
    .filter(
      (def): def is typeof def & { usageHint: string } =>
        def.category === category && typeof def.usageHint === "string",
    )
    .map((def) => ({ name: def.name, hint: def.usageHint }));
}

/**
 * 生成指定类别的合并 hint 文本。
 * 格式：每个动作一行，`name — hint`。
 */
export function renderCategoryHints(category: ActionCategory): string {
  const hints = getUsageHintsByCategory(category);
  if (hints.length === 0) return "";
  return hints.map((h) => `${h.name}: ${h.hint}`).join("\n");
}

/**
 * 生成全量 capability hints（按类别分组）。
 * 只包含有 usageHint 的动作。
 */
export function renderAllUsageHints(): string {
  const categories: ActionCategory[] = [
    "messaging",
    "reaction",
    "media",
    "sticker",
    "moderation",
    "group",
    "bot",
    "search",
    "account",
    "knowledge",
    "app",
  ];
  const lines: string[] = [];
  for (const cat of categories) {
    const hints = getUsageHintsByCategory(cat);
    if (hints.length === 0) continue;
    lines.push(`[${cat}]`);
    for (const h of hints) {
      lines.push(`  ${h.name}: ${h.hint}`);
    }
  }
  return lines.join("\n");
}
