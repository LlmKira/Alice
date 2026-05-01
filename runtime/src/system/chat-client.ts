/**
 * irc — 共享解析工具。
 *
 * ADR-238: 简化为纯工具函数，命令定义在 irc.ts 中。
 *
 * 命令签名设计（IRC 直觉 + POSIX 严格）：
 *   irc say [--in TARGET] --text <text>
 *   irc reply [--in TARGET] --ref <msgId> --text <text>
 *   irc react [--in TARGET] --ref <msgId> --emoji <emoji>
 *   irc sticker [--in TARGET] --keyword <keyword>
 *   irc read [--in TARGET]
 *   irc tail [--in TARGET] [--count <number>]
 *   irc whois [--in TARGET] [--target <contact>]
 *   irc motd [--in TARGET]
 *   irc threads
 *   irc topic [--in TARGET]
 *   irc join --target <target>
 *   irc leave [--in TARGET]
 *   irc forward --from SOURCE --ref <msgId> [--to TARGET] [--comment <text>]
 *
 * --in TARGET = "在哪个聊天室操作"（空间介词，IRC "I'm in #channel"）。
 * --to TARGET 仅用于 forward（方向介词，"转发到"）。
 * TARGET 支持 @ID（聊天平台惯例）、~ID（向后兼容）和裸数字。
 * 省略时自动从 ALICE_CTX_TARGET_CHAT 环境变量获取当前聊天上下文。
 * 兼容别名：`0` / `me` / `@me` / `~me` / `current` / `here` / `this`
 * 也解析为当前聊天。
 *
 * @see docs/adr/238-citty-native-cli-redesign.md
 */

import { enginePost } from "../../skills/_lib/engine-client.js";
import { CliExecutionError } from "./cli-types.js";

// ── 共享解析工具 ──

const CURRENT_CHAT_ALIASES = new Set(["0", "me", "@me", "~me", "current", "here", "this"]);

/**
 * 解析 --in TARGET（或 forward 的 --to/--from TARGET）。
 *
 * ADR-237: 支持名称解析。
 * - 数字 ID / @数字 / ~数字 → 直接返回数字
 * - 名称 / @名称 → 调用 Engine API /resolve/name 解析
 *
 * 省略时自动从 ALICE_CTX_TARGET_CHAT 环境变量获取当前聊天上下文。
 */
export async function resolveTarget(raw?: string): Promise<number> {
  const trimmed = raw?.trim();
  const currentChat = process.env.ALICE_CTX_TARGET_CHAT?.trim();
  const useCurrentChat = trimmed == null || trimmed === "" || CURRENT_CHAT_ALIASES.has(trimmed);
  const effective = useCurrentChat ? currentChat : trimmed;
  if (!effective) {
    throw new CliExecutionError("command_missing_argument", "missing target: use --in @ID");
  }

  // 去掉 @ 或 ~ 前缀
  const stripped =
    effective.startsWith("@") || effective.startsWith("~") ? effective.slice(1) : effective;

  // 尝试解析为数字
  const n = Number(stripped);
  if (Number.isFinite(n)) {
    return n;
  }

  // 不是数字 → 尝试名称解析
  // 调用 Engine API /resolve/name
  const result = (await enginePost("/resolve/name", { name: effective })) as {
    result?: { telegramId: number | null } | null;
  };

  if (result?.result?.telegramId != null) {
    return result.result.telegramId;
  }

  throw new CliExecutionError("command_invalid_target", `invalid target: "${effective}"`);
}

/**
 * 解析 msgId，容忍带引号的 # 前缀；提示面不再主动展示 shell 不安全的裸 #。
 */
export function parseMsgId(raw: string): number {
  const stripped = raw.trim().replace(/^#/, "");
  if (/^(latest|last|recent)$/i.test(stripped)) {
    throw new CliExecutionError(
      "command_invalid_message_id",
      `invalid message ID: "${raw}" (use a visible current-chat msgId, never latest)`,
    );
  }
  if (!/^\d+$/.test(stripped)) {
    throw new CliExecutionError(
      "command_invalid_message_id",
      `invalid message ID: "${raw}" (expected a visible msgId like 5791)`,
    );
  }
  const n = Number(stripped);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new CliExecutionError(
      "command_invalid_message_id",
      `invalid message ID: "${raw}" (expected a visible msgId like 5791)`,
    );
  }
  return n;
}

// ── --in 选项定义（所有需要 target 的 subcommand 共用）──

export const inOption = {
  type: "string" as const,
  description: "Target chat (@ID or numeric). Omit to use current chat context.",
};
