/**
 * IRC 命令逻辑 — 纯函数版本（ADR-239 GitHub CLI 风格）。
 *
 * ADR-239 变更：
 * - --json 接受逗号分隔字段列表（非 boolean）
 * - 命令返回 rawResult 供字段过滤
 * - 输出格式化由 makeRunner 统一处理
 *
 * @see docs/adr/239-gh-cli-style-output-pipeline.md
 */

import type { ChatTailResponse } from "../core/chat-tail-contract.js";
import { sanitizeOutgoingText } from "../core/sandbox-schemas.js";
import type { ExecutionObservation } from "../core/script-execution.js";
import { telegramChannelId, telegramContactId } from "../graph/constants.js";
import {
  parseTelegramNativeId,
  parseTransportMessageId,
  parseTransportTargetId,
  stableTransportMessageId,
  type TransportTargetRef,
} from "../platform/transport.js";
import { ALLOWED_REACTIONS, normalizeReactionEmoji } from "../telegram/actions/shared.js";
import { renderConfirm, renderHuman, truncate } from "./cli-bridge.js";
import {
  type CliContext,
  type CliErrorDetail,
  CliExecutionError,
  makeDie,
  type SendResult,
} from "./cli-types.js";

const ACTION_PREFIX = "__ALICE_ACTION__:";
export const OBSERVATION_PREFIX = "__ALICE_OBSERVATION__:";

interface TransportSendResult {
  platform?: string;
  target?: string;
  messageId?: string | null;
  nativeMessageId?: number | string | null;
}

interface ResolveTargetResult {
  target?: string;
}

interface TransportCommandTarget {
  ref: TransportTargetRef;
  chatId?: number;
}

function telegramTarget(chatId: number): string {
  return `channel:telegram:${chatId}`;
}

function telegramMessage(chatId: number, msgId: number): string {
  return stableTransportMessageId("telegram", String(chatId), msgId);
}

function nativeMsgId(result: SendResult | TransportSendResult | null): number | undefined {
  if (!result) return undefined;
  if (typeof (result as SendResult).msgId === "number") return (result as SendResult).msgId;
  const native = (result as TransportSendResult).nativeMessageId;
  return typeof native === "number" ? native : undefined;
}

async function resolveTransportTarget(
  ctx: CliContext,
  raw?: string,
): Promise<TransportCommandTarget> {
  const stable = parseTransportTargetId(raw?.trim());
  if (stable) {
    return {
      ref: stable,
      chatId:
        stable.platform === "telegram"
          ? (parseTelegramNativeId(stable.nativeId) ?? undefined)
          : undefined,
    };
  }

  const trimmed = raw?.trim();
  if (trimmed && !/^[@~]?-?\d+$/.test(trimmed)) {
    const resolved = (await ctx.engine.post("/resolve/target", { target: trimmed })) as {
      result?: ResolveTargetResult | null;
    } | null;
    const resolvedTarget = parseTransportTargetId(resolved?.result?.target);
    if (resolvedTarget) {
      return {
        ref: resolvedTarget,
        chatId:
          resolvedTarget.platform === "telegram"
            ? (parseTelegramNativeId(resolvedTarget.nativeId) ?? undefined)
            : undefined,
      };
    }
  }

  const chatId = await ctx.resolveTarget(raw);
  return {
    ref: parseTransportTargetId(telegramTarget(chatId)) as TransportTargetRef,
    chatId,
  };
}

function messageRefForTarget(target: TransportCommandTarget, raw: string): string {
  const stable = parseTransportMessageId(raw.trim());
  if (stable) return stable.stableId;

  const msgId = parseMsgId(raw);
  if (target.ref.platform !== "telegram" || target.chatId == null) {
    throw new CliExecutionError(
      "command_invalid_message_id",
      `invalid message ID: "${raw}" (use a stable message ref for ${target.ref.platform})`,
    );
  }
  return telegramMessage(target.chatId, msgId);
}

function nativeTelegramMsgIdFromRef(messageRef: string): number | undefined {
  const parsed = parseTransportMessageId(messageRef);
  if (!parsed || parsed.platform !== "telegram") return undefined;
  return parseTelegramNativeId(parsed.messageNativeId) ?? undefined;
}

export function assertCurrentChatForSend(
  ctx: CliContext,
  chatId: number,
  die: (msg: string, code?: "command_cross_chat_send", detail?: CliErrorDetail) => never,
  source = "irc.send",
  payload?: Record<string, unknown>,
) {
  if (ctx.currentChatId == null || chatId === ctx.currentChatId) return;
  die(
    `refusing cross-chat send: current chat is @${ctx.currentChatId}, requested @${chatId}. No message was sent there. If you need that chat to become current, use self switch-chat --to @${chatId} --reason "...". Use irc forward for sharing content here.`,
    "command_cross_chat_send",
    {
      code: "command_cross_chat_send",
      source,
      currentChatId: String(ctx.currentChatId),
      requestedChatId: String(chatId),
      ...(payload ? { payload } : {}),
    },
  );
}

function assertCurrentTransportTargetForSend(
  ctx: CliContext,
  target: TransportCommandTarget,
  die: (msg: string, code?: "command_cross_chat_send", detail?: CliErrorDetail) => never,
  source = "irc.send",
  payload?: Record<string, unknown>,
) {
  if (ctx.currentChatId == null) return;
  if (target.ref.platform === "telegram" && target.chatId === ctx.currentChatId) return;
  const requestedLabel =
    target.ref.platform === "telegram" && target.chatId != null
      ? `@${target.chatId}`
      : target.ref.stableId;
  die(
    `refusing cross-chat send: current chat is @${ctx.currentChatId}, requested ${requestedLabel}. No message was sent there. If you need that chat to become current, use self switch-chat --to ${requestedLabel} --reason "...". Use irc forward for sharing content here.`,
    "command_cross_chat_send",
    {
      code: "command_cross_chat_send",
      source,
      currentChatId: String(ctx.currentChatId),
      requestedChatId: target.ref.stableId,
      ...(payload ? { payload } : {}),
    },
  );
}

// ── Command Result Types ──

/** 命令执行结果 — 包含所有待输出内容。 */
export interface CommandResult {
  /** action trace 行（如 `__ALICE_ACTION__:sent:chatId=xxx:msgId=yyy`）。 */
  action?: string;
  /** structured observation fact；控制流只读这个，不从 output 文本猜语义。 */
  observation?: ExecutionObservation;
  /** 主输出内容（人类可读文本）。 */
  output: string;
  /** 原始结果对象（用于 JSON 字段过滤）。 */
  rawResult?: unknown;
}

/** 命令处理器 — 接收上下文和参数，返回待输出结果。 */
export type CommandHandler<T = Record<string, unknown>> = (
  ctx: CliContext,
  args: T,
) => Promise<CommandResult>;

function chatObservationMeta(
  ctx: CliContext,
  chatId: number,
  payload?: Record<string, unknown>,
): Pick<ExecutionObservation, "currentChatId" | "targetChatId" | "payload"> {
  return {
    currentChatId: ctx.currentChatId == null ? null : String(ctx.currentChatId),
    targetChatId: String(chatId),
    ...(payload ? { payload } : {}),
  };
}

// ── Say Command ──

export interface SayArgs {
  json?: string;
  in?: string;
  text: string;
  "resolve-thread"?: string; // thread ID to resolve after sending (CLI flag format)
}

/** say 命令逻辑。 */
export async function sayCommand(ctx: CliContext, args: SayArgs): Promise<CommandResult> {
  const die = makeDie(ctx.output, "irc");

  const target = await resolveTransportTarget(ctx, args.in);
  const text = sanitizeOutgoingText(args.text);

  if (!text.trim()) die("say requires non-empty text", "command_missing_argument");
  assertCurrentTransportTargetForSend(ctx, target, die, "irc.say");

  const result = (await ctx.engine.post("/transport/send", {
    target: target.ref.stableId,
    text,
  })) as TransportSendResult | null;

  const msgId = nativeMsgId(result);
  const action =
    msgId != null && target.chatId != null
      ? `${ACTION_PREFIX}sent:chatId=${target.chatId}:msgId=${msgId}:message=${telegramMessage(target.chatId, msgId)}`
      : undefined;

  // ADR-240: resolve thread after sending message
  if (args["resolve-thread"]) {
    const threadId = Number(args["resolve-thread"]);
    if (!Number.isFinite(threadId) || threadId <= 0) {
      die("--resolve-thread requires a positive integer thread ID", "command_arg_format");
    }
    try {
      await ctx.engine.post("/dispatch/resolve_topic", { threadId });
    } catch (err) {
      // Don't fail the entire command if resolve fails
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[resolve-thread] Failed to resolve thread #${threadId}: ${errMsg}`);
    }
  }

  return {
    action,
    output: renderConfirm("Sent", `"${truncate(text)}"`),
    rawResult: {
      msgId,
      chatId: target.chatId,
      target: target.ref.stableId,
      messageId: result?.messageId,
    },
  };
}

// ── Reply Command ──

export interface ReplyArgs {
  json?: string;
  in?: string;
  ref: string;
  text: string;
}

/** 解析消息 ID（纯函数）。 */
export function parseMsgId(raw: string): number {
  const normalized = raw.trim().replace(/^#/, "");
  if (/^(latest|last|recent)$/i.test(normalized)) {
    throw new CliExecutionError(
      "command_invalid_message_id",
      `invalid message ID: ${raw}; use a visible current-chat msgId, never latest`,
    );
  }
  if (!/^\d+$/.test(normalized)) {
    throw new CliExecutionError(
      "command_invalid_message_id",
      `invalid message ID: ${raw}; use a visible current-chat msgId`,
    );
  }
  const n = Number(normalized);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new CliExecutionError(
      "command_invalid_message_id",
      `invalid message ID: ${raw}; use a visible current-chat msgId`,
    );
  }
  return n;
}

/** reply 命令逻辑。 */
export async function replyCommand(ctx: CliContext, args: ReplyArgs): Promise<CommandResult> {
  const die = makeDie(ctx.output, "irc");

  const target = await resolveTransportTarget(ctx, args.in);
  let replyToMessage = "";
  try {
    replyToMessage = messageRefForTarget(target, args.ref);
  } catch (err) {
    die(
      err instanceof Error ? err.message : "invalid reply ref; use a visible current-chat msgId",
      "command_invalid_reply_ref",
    );
  }
  const text = sanitizeOutgoingText(args.text);
  const replyTo = nativeTelegramMsgIdFromRef(replyToMessage);

  if (!text.trim()) die("reply requires non-empty text", "command_missing_argument");
  assertCurrentTransportTargetForSend(ctx, target, die, "irc.reply", { replyToMessage });

  const result = (await ctx.engine.post("/transport/send", {
    target: target.ref.stableId,
    text,
    replyTo: replyToMessage,
  })) as TransportSendResult | null;

  const msgId = nativeMsgId(result);
  const action =
    msgId != null && target.chatId != null
      ? `${ACTION_PREFIX}sent:chatId=${target.chatId}:msgId=${msgId}:message=${telegramMessage(target.chatId, msgId)}`
      : undefined;

  return {
    action,
    output: renderConfirm(
      "Replied to",
      `${replyTo == null ? replyToMessage : `#${replyTo}`}: "${truncate(text)}"`,
    ),
    rawResult: {
      msgId,
      chatId: target.chatId,
      target: target.ref.stableId,
      messageId: result?.messageId,
      replyTo,
      replyToMessage,
    },
  };
}

// ── React Command ──

export interface ReactArgs {
  json?: string;
  in?: string;
  ref: string;
  emoji: string;
}

function allowedReactionList(): string {
  return Array.from(ALLOWED_REACTIONS).join(" ");
}

/** react 命令逻辑。 */
export async function reactCommand(ctx: CliContext, args: ReactArgs): Promise<CommandResult> {
  const die = makeDie(ctx.output, "irc");
  const target = await resolveTransportTarget(ctx, args.in);
  const messageRef = messageRefForTarget(target, args.ref);
  const msgId = nativeTelegramMsgIdFromRef(messageRef);
  const emoji = normalizeReactionEmoji(args.emoji);
  if (!ALLOWED_REACTIONS.has(emoji)) {
    die(
      `invalid reaction ${JSON.stringify(args.emoji)}; use one of: ${allowedReactionList()}`,
      "invalid_reaction",
    );
  }

  await ctx.engine.post("/transport/react", {
    target: target.ref.stableId,
    message: messageRef,
    emoji,
  });

  return {
    action:
      msgId != null && target.chatId != null
        ? `${ACTION_PREFIX}react:chatId=${target.chatId}:msgId=${msgId}`
        : undefined,
    output: renderConfirm(`Reacted ${emoji} to`, msgId == null ? messageRef : `#${msgId}`),
    rawResult: {
      success: true,
      chatId: target.chatId,
      msgId,
      target: target.ref.stableId,
      message: messageRef,
    },
  };
}

// ── Sticker Command ──

export interface StickerArgs {
  json?: string;
  in?: string;
  keyword: string;
}

/** sticker 命令逻辑。 */
export async function stickerCommand(ctx: CliContext, args: StickerArgs): Promise<CommandResult> {
  const die = makeDie(ctx.output, "irc");

  const chatId = await ctx.resolveTarget(args.in);
  const keyword = args.keyword.trim();

  if (!keyword) die("sticker requires non-empty keyword", "command_missing_argument");
  assertCurrentChatForSend(ctx, chatId, die, "irc.sticker");

  const result = (await ctx.engine.post("/telegram/sticker", {
    chatId,
    sticker: keyword,
  })) as SendResult | null;

  const action =
    result?.msgId != null
      ? `${ACTION_PREFIX}sticker:chatId=${chatId}:msgId=${result.msgId}`
      : undefined;

  return {
    action,
    output: renderConfirm("Sent sticker", keyword),
    rawResult: { msgId: result?.msgId, chatId },
  };
}

// ── Voice Command ──

export interface VoiceArgs {
  json?: string;
  in?: string;
  emotion?: string;
  ref?: string;
  text: string;
}

/** voice 命令逻辑。 */
export async function voiceCommand(ctx: CliContext, args: VoiceArgs): Promise<CommandResult> {
  const die = makeDie(ctx.output, "irc");

  const chatId = await ctx.resolveTarget(args.in);
  const text = sanitizeOutgoingText(args.text);

  if (!text) die("voice requires non-empty text", "command_missing_argument");
  assertCurrentChatForSend(
    ctx,
    chatId,
    die,
    "irc.voice",
    args.ref ? { replyRef: args.ref } : undefined,
  );

  const body: Record<string, unknown> = { chatId, text };
  if (args.emotion) body.emotion = args.emotion;
  if (args.ref) body.replyTo = parseMsgId(args.ref);

  const result = (await ctx.engine.post("/telegram/voice", body)) as SendResult | null;
  const deliveredAs = result?.deliveredAs ?? "voice";

  const action =
    result?.msgId != null
      ? `${ACTION_PREFIX}${deliveredAs === "text" ? "sent" : "voice"}:chatId=${chatId}:msgId=${result.msgId}`
      : undefined;

  return {
    action,
    output: renderConfirm(
      deliveredAs === "text" ? "Sent text fallback" : "Sent voice",
      `"${truncate(text)}"`,
    ),
    rawResult: {
      msgId: result?.msgId,
      chatId,
      deliveredAs,
      fallbackReason: result?.fallbackReason,
    },
  };
}

// ── Read Command ──

export interface ReadArgs {
  json?: string;
  in?: string;
}

/** read 命令逻辑。 */
export async function readCommand(ctx: CliContext, args: ReadArgs): Promise<CommandResult> {
  const target = await resolveTransportTarget(ctx, args.in);
  await ctx.engine.post("/transport/read", { target: target.ref.stableId });

  return {
    observation: {
      kind: "read_ack",
      source: "irc.read",
      text: `marked chat ${target.ref.stableId} as read`,
      enablesContinuation: false,
      ...(target.chatId == null
        ? {
            currentChatId: ctx.currentChatId == null ? null : String(ctx.currentChatId),
            targetChatId: target.ref.stableId,
          }
        : chatObservationMeta(ctx, target.chatId)),
    },
    output: renderConfirm("Marked as read"),
    rawResult: { success: true },
  };
}

// ── Tail Command ──

export interface TailArgs {
  json?: string;
  in?: string;
  count: string;
}

/** tail 命令逻辑。 */
export async function tailCommand(ctx: CliContext, args: TailArgs): Promise<CommandResult> {
  const die = makeDie(ctx.output, "irc");

  const chatId = await ctx.resolveTarget(args.in);
  const count = Number(args.count);

  if (!Number.isFinite(count)) die("tail count must be a number", "command_arg_format");

  const result = (await ctx.engine.get(
    `/chat/${chatId}/tail?limit=${count}`,
  )) as ChatTailResponse | null;

  // 标注来源（用于远程聊天）
  const isRemote = args.in != null;
  const header = isRemote ? `[tail @${chatId}]\n` : "";

  const messages = result?.messages ?? [];
  if (messages.length === 0) {
    return {
      observation: {
        kind: "empty",
        source: "irc.tail",
        text: `no messages in chat ${chatId}`,
        enablesContinuation: false,
        ...chatObservationMeta(ctx, chatId, { count }),
      },
      output: `${header}(no messages)`,
      rawResult: [],
    };
  }

  const lines: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const sender = m.sender ?? "?";
    const text = m.text ?? "";
    const prefix = m.id != null ? `(msgId ${m.id}) ` : "";
    lines.push(`${i + 1}. ${prefix}${sender}: "${truncate(text, 80)}"`);
  }

  return {
    observation: {
      kind: "new_message_context",
      source: "irc.tail",
      text: header + lines.join("\n"),
      enablesContinuation: true,
      ...chatObservationMeta(ctx, chatId, { count, messageCount: messages.length }),
    },
    output: header + lines.join("\n"),
    rawResult: messages,
  };
}

// ── Whois Command ──

export interface WhoisArgs {
  json?: string;
  in?: string;
  target?: string;
}

/** 从 graph 属性响应中提取 value（纯函数）。 */
export function gval(res: unknown): unknown {
  return (res as { value?: unknown } | null)?.value ?? null;
}

/** whois 命令逻辑。 */
export async function whoisCommand(ctx: CliContext, args: WhoisArgs): Promise<CommandResult> {
  const target = args.target?.trim() || undefined;

  if (target) {
    // whois NAME/@ID → 联系人画像
    const stripped = target.startsWith("@") || target.startsWith("~") ? target.slice(1) : target;

    // 尝试解析为数字 ID
    const n = Number(stripped);
    let contactId: string;

    if (Number.isFinite(n)) {
      contactId = telegramContactId(n);
    } else {
      // 尝试名称解析
      const resolveResult = (await ctx.engine.post("/resolve/name", { name: target })) as {
        result?: { telegramId: number | null } | null;
      };
      if (resolveResult?.result?.telegramId != null) {
        contactId = telegramContactId(resolveResult.result.telegramId);
      } else {
        throw new Error(`contact not found: "${target}"`);
      }
    }

    const result = await ctx.engine.query("/query/contact_profile", { contactId });
    const output = renderHuman(result);
    return {
      observation: {
        kind: result == null ? "empty" : "query_result",
        source: "irc.whois",
        text: output,
        enablesContinuation: result != null,
      },
      output,
      rawResult: result,
    };
  }

  // whois（无参数）→ 聊天室信息
  const chatId = await ctx.resolveTarget(args.in);
  const [name, chatType, topic, unread, pendingDirected, aliceRole] = await Promise.all([
    ctx.engine.get(`/graph/channel:${chatId}/display_name`),
    ctx.engine.get(`/graph/channel:${chatId}/chat_type`),
    ctx.engine.get(`/graph/channel:${chatId}/topic`),
    ctx.engine.get(`/graph/channel:${chatId}/unread`),
    ctx.engine.get(`/graph/channel:${chatId}/pending_directed`),
    ctx.engine.get(`/graph/channel:${chatId}/alice_role`),
  ]);

  const data = {
    chatId,
    name: gval(name),
    chatType: gval(chatType),
    topic: gval(topic),
    unread: gval(unread) ?? 0,
    pendingDirected: gval(pendingDirected) ?? 0,
    role: gval(aliceRole),
  };

  const lines = [
    `Channel: ${data.name ?? chatId}`,
    data.chatType ? `Type: ${data.chatType}` : null,
    data.topic ? `Topic: "${data.topic}"` : null,
    `Unread: ${data.unread}`,
    `Pending directed: ${data.pendingDirected}`,
    data.role ? `Your role: ${data.role}` : null,
  ].filter((l): l is string => l != null);

  return {
    observation: {
      kind: "state_snapshot",
      source: "irc.whois",
      text: lines.join("\n"),
      enablesContinuation: true,
    },
    output: lines.join("\n"),
    rawResult: data,
  };
}

// ── Motd Command ──

export interface MotdArgs {
  json?: string;
  in?: string;
}

/** motd 命令逻辑。 */
export async function motdCommand(ctx: CliContext, args: MotdArgs): Promise<CommandResult> {
  const chatId = await ctx.resolveTarget(args.in);
  const result = await ctx.engine.query("/query/chat_mood", { chatId: telegramChannelId(chatId) });

  const output = renderHuman(result);
  return {
    observation: {
      kind: result == null ? "empty" : "query_result",
      source: "irc.motd",
      text: output,
      enablesContinuation: result != null,
    },
    output,
    rawResult: result,
  };
}

// ── Threads Command ──

export interface ThreadsArgs {
  json?: string;
}

/** threads 命令逻辑。 */
export async function threadsCommand(ctx: CliContext, _args: ThreadsArgs): Promise<CommandResult> {
  const result = await ctx.engine.query("/query/open_topics", {});
  const output = renderHuman(result);
  const hasThreads = Array.isArray(result) ? result.length > 0 : result != null;
  return {
    observation: {
      kind: hasThreads ? "query_result" : "empty",
      source: "irc.threads",
      text: output,
      enablesContinuation: hasThreads,
    },
    output,
    rawResult: result,
  };
}

// ── Join Command ──

export interface JoinArgs {
  json?: string;
  target: string;
}

/** join 命令逻辑。 */
export async function joinCommand(ctx: CliContext, args: JoinArgs): Promise<CommandResult> {
  const die = makeDie(ctx.output, "irc");

  const chatIdOrLink = args.target.trim();
  if (!chatIdOrLink) die("join requires a target", "command_missing_argument");

  const result = await ctx.engine.post("/telegram/join", { chatIdOrLink });

  return { output: renderConfirm("Joined", chatIdOrLink), rawResult: result };
}

// ── Leave Command ──

export interface LeaveArgs {
  json?: string;
  in?: string;
}

/** leave 命令逻辑。 */
export async function leaveCommand(ctx: CliContext, args: LeaveArgs): Promise<CommandResult> {
  const chatId = await ctx.resolveTarget(args.in);
  const result = await ctx.engine.post("/telegram/leave", { chatId });

  return { output: renderConfirm("Left chat"), rawResult: result };
}
