/**
 * irc — IRC-native Telegram system client (CLI 入口)。
 *
 * citty 严格解析 → Engine API 调用 → 人类可读输出。
 * 成功的发送动作输出 action 控制行，shell-executor 可追踪已完成操作。
 *
 * @see docs/adr/235-cli-human-readable-output.md
 */

import { defineCommand, runMain } from "citty";
import {
  inOption,
  parseMsgId,
  rejectExtraArgs,
  resolveTarget,
  stripFlags,
} from "../../src/system/chat-client.ts";
import { engineGet, enginePost, engineQuery } from "../_lib/engine-client.ts";
import {
  extractJsonFlag,
  renderConfirm,
  renderHuman,
  renderJson,
  renderKeyValue,
  truncate,
} from "../../src/system/cli-bridge.ts";

const ACTION_PREFIX = "__ALICE_ACTION__:";

// ── 工具函数 ──

function die(msg: string): never {
  process.stderr.write(`irc: ${msg}\n`);
  process.exitCode = 1;
  // eslint-disable-next-line unicorn/no-process-exit
  process.exit(1);
}

/** 输出结果：--json 模式输出 JSON，默认输出人类可读文本。 */
function output(jsonMode: boolean, result: unknown, humanText: string): void {
  console.log(jsonMode ? renderJson(result) : humanText);
}

// ── Subcommands ──

const say = defineCommand({
  meta: { name: "say", description: "Send a message" },
  args: {
    in: inOption,
    text: { type: "positional", description: "Message text", required: true },
  },
  async run({ args, rawArgs }) {
    const { json, args: cleaned } = extractJsonFlag(rawArgs);
    const positionals = stripFlags(cleaned, ["--in"]);
    rejectExtraArgs(positionals, 1, "say");
    const chatId = resolveTarget(args.in);
    const text = args.text as string;
    if (!text.trim()) die("say requires non-empty text");
    const result = (await enginePost("/telegram/send", { chatId, text })) as {
      msgId?: number;
    } | null;
    if (result?.msgId != null) {
      console.log(`${ACTION_PREFIX}sent:chatId=${chatId}:msgId=${result.msgId}`);
    }
    output(json, result, renderConfirm("Sent", `"${truncate(text)}"`));
  },
});

const reply = defineCommand({
  meta: { name: "reply", description: "Reply to a message" },
  args: {
    in: inOption,
    msgId: { type: "positional", description: "Message ID to reply to", required: true },
    text: { type: "positional", description: "Reply text", required: true },
  },
  async run({ args, rawArgs }) {
    const { json, args: cleaned } = extractJsonFlag(rawArgs);
    const positionals = stripFlags(cleaned, ["--in"]);
    rejectExtraArgs(positionals, 2, "reply");
    const chatId = resolveTarget(args.in);
    const replyTo = parseMsgId(args.msgId as string);
    const text = args.text as string;
    if (!text.trim()) die("reply requires non-empty text");
    const result = (await enginePost("/telegram/send", { chatId, text, replyTo })) as {
      msgId?: number;
    } | null;
    if (result?.msgId != null) {
      console.log(`${ACTION_PREFIX}sent:chatId=${chatId}:msgId=${result.msgId}`);
    }
    output(json, result, renderConfirm("Replied to", `#${replyTo}: "${truncate(text)}"`));
  },
});

const react = defineCommand({
  meta: { name: "react", description: "React to a message" },
  args: {
    in: inOption,
    msgId: { type: "positional", description: "Message ID to react to", required: true },
    emoji: { type: "positional", description: "Emoji", required: true },
  },
  async run({ args, rawArgs }) {
    const { json, args: cleaned } = extractJsonFlag(rawArgs);
    const positionals = stripFlags(cleaned, ["--in"]);
    rejectExtraArgs(positionals, 2, "react");
    const chatId = resolveTarget(args.in);
    const msgId = parseMsgId(args.msgId as string);
    const emoji = args.emoji as string;
    const result = await enginePost("/telegram/react", { chatId, msgId, emoji });
    output(json, result, renderConfirm(`Reacted ${emoji} to`, `#${msgId}`));
  },
});

const sticker = defineCommand({
  meta: { name: "sticker", description: "Send a sticker by keyword" },
  args: {
    in: inOption,
    keyword: {
      type: "positional",
      description: "Sticker keyword (emotion/action)",
      required: true,
    },
  },
  async run({ args, rawArgs }) {
    const { json, args: cleaned } = extractJsonFlag(rawArgs);
    const positionals = stripFlags(cleaned, ["--in"]);
    rejectExtraArgs(positionals, 1, "sticker");
    const chatId = resolveTarget(args.in);
    const keyword = args.keyword as string;
    const result = (await enginePost("/telegram/sticker", { chatId, sticker: keyword })) as {
      msgId?: number;
    } | null;
    if (result?.msgId != null) {
      console.log(`${ACTION_PREFIX}sticker:chatId=${chatId}:msgId=${result.msgId}`);
    }
    output(json, result, renderConfirm("Sent sticker", keyword));
  },
});

const voice = defineCommand({
  meta: { name: "voice", description: "Send a voice message (text-to-speech)" },
  args: {
    in: inOption,
    emotion: { type: "string", description: "Emotion: happy, sad, angry, calm, whisper, ..." },
    ref: { type: "string", description: "Message ID to reply to" },
    text: { type: "positional", description: "Text to speak", required: true },
  },
  async run({ args, rawArgs }) {
    const { json, args: cleaned } = extractJsonFlag(rawArgs);
    const positionals = stripFlags(cleaned, ["--in", "--emotion", "--ref"]);
    rejectExtraArgs(positionals, 1, "voice");
    const chatId = resolveTarget(args.in);
    const text = (args.text as string).trim();
    if (!text) die("voice requires non-empty text");
    const body: Record<string, unknown> = { chatId, text };
    if (args.emotion) body.emotion = args.emotion;
    if (args.ref) body.replyTo = parseMsgId(args.ref as string);
    const result = (await enginePost("/telegram/voice", body)) as {
      msgId?: number;
    } | null;
    if (result?.msgId != null) {
      console.log(`${ACTION_PREFIX}voice:chatId=${chatId}:msgId=${result.msgId}`);
    }
    output(json, result, renderConfirm("Sent voice", `"${truncate(text)}"`));
  },
});

const read = defineCommand({
  meta: { name: "read", description: "Mark chat as read" },
  args: { in: inOption },
  async run({ args, rawArgs }) {
    const { json, args: cleaned } = extractJsonFlag(rawArgs);
    const positionals = stripFlags(cleaned, ["--in"]);
    rejectExtraArgs(positionals, 0, "read");
    const chatId = resolveTarget(args.in);
    const result = await enginePost("/telegram/read", { chatId });
    output(json, result, renderConfirm("Marked as read"));
  },
});

const tail = defineCommand({
  meta: { name: "tail", description: "Show recent messages" },
  args: {
    in: inOption,
    count: { type: "positional", description: "Number of messages", default: "20" },
  },
  async run({ args, rawArgs }) {
    const { json, args: cleaned } = extractJsonFlag(rawArgs);
    const positionals = stripFlags(cleaned, ["--in"]);
    rejectExtraArgs(positionals, 1, "tail");
    const chatId = resolveTarget(args.in);
    const count = Number(args.count);
    if (!Number.isFinite(count)) die("tail count must be a number");
    const result = await engineGet(`/chat/${chatId}/tail?limit=${count}`);
    // ADR-221: 标注来源 chatId，防止 LLM 跨 round 时搞混群组 ID
    const isRemote = args.in != null;
    if (isRemote) {
      console.log(`[tail @${chatId}]`);
    }
    if (json) {
      console.log(renderJson(result));
    } else {
      // tail 返回的是消息数组，格式化为编号列表
      const messages = Array.isArray(result) ? result : [];
      if (messages.length === 0) {
        console.log("(no messages)");
      } else {
        for (let i = 0; i < messages.length; i++) {
          const m = messages[i] as { sender?: string; text?: string; id?: number };
          const sender = m.sender ?? "?";
          const text = m.text ?? "";
          const prefix = m.id != null ? `(#${m.id}) ` : "";
          console.log(`${i + 1}. ${prefix}${sender}: "${truncate(text, 80)}"`);
        }
      }
    }
  },
});

// ── whois: 统一查人/查房间（IRC /whois）──

/** 从 graph 属性响应中提取 value。 */
function gval(res: unknown): unknown {
  return (res as { value?: unknown } | null)?.value ?? null;
}

const whois = defineCommand({
  meta: { name: "whois", description: "Look up a contact or the current chat room" },
  args: {
    in: inOption,
    target: { type: "positional", description: "Contact @ID (omit for room info)", default: "" },
  },
  async run({ args, rawArgs }) {
    const { json, args: cleaned } = extractJsonFlag(rawArgs);
    const positionals = stripFlags(cleaned, ["--in"]);
    rejectExtraArgs(positionals, 1, "whois");
    const target = (args.target as string | undefined)?.trim() || undefined;

    if (target) {
      // whois @ID → 联系人画像（/query/contact_profile）
      const stripped = target.startsWith("@") || target.startsWith("~") ? target.slice(1) : target;
      const contactId = `contact:${stripped}`;
      const result = await engineQuery("/query/contact_profile", { contactId });
      output(json, result, renderHuman(result));
    } else {
      // whois（无参数）→ 聊天室信息（原 irc who）
      const chatId = resolveTarget(args.in);
      const [name, chatType, topic, unread, pendingDirected, aliceRole] = await Promise.all([
        engineGet(`/graph/channel:${chatId}/display_name`),
        engineGet(`/graph/channel:${chatId}/chat_type`),
        engineGet(`/graph/channel:${chatId}/topic`),
        engineGet(`/graph/channel:${chatId}/unread`),
        engineGet(`/graph/channel:${chatId}/pending_directed`),
        engineGet(`/graph/channel:${chatId}/alice_role`),
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
      if (json) {
        console.log(renderJson(data));
      } else {
        console.log(
          renderKeyValue([
            ["Channel", data.name ?? chatId],
            ["Type", data.chatType],
            ["Topic", data.topic ? `"${data.topic}"` : null],
            ["Unread", data.unread],
            ["Pending directed", data.pendingDirected],
            ["Your role", data.role],
          ]),
        );
      }
    }
  },
});

// ── motd: 聊天室氛围（IRC /motd）──

const motd = defineCommand({
  meta: { name: "motd", description: "Show chat mood and atmosphere" },
  args: { in: inOption },
  async run({ args, rawArgs }) {
    const { json, args: cleaned } = extractJsonFlag(rawArgs);
    const positionals = stripFlags(cleaned, ["--in"]);
    rejectExtraArgs(positionals, 0, "motd");
    const chatId = resolveTarget(args.in);
    const result = await engineQuery("/query/chat_mood", { chatId: `channel:${chatId}` });
    output(json, result, renderHuman(result));
  },
});

// ── threads: 未结话题（Discord/Slack 风格）──

const threads = defineCommand({
  meta: { name: "threads", description: "Show open discussion threads" },
  async run({ rawArgs }) {
    const { json } = extractJsonFlag(rawArgs);
    const result = await engineQuery("/query/open_topics", {});
    output(json, result, renderHuman(result));
  },
});

const topicCmd = defineCommand({
  meta: { name: "topic", description: "Show chat topic" },
  args: { in: inOption },
  async run({ args, rawArgs }) {
    const { json, args: cleaned } = extractJsonFlag(rawArgs);
    const positionals = stripFlags(cleaned, ["--in"]);
    rejectExtraArgs(positionals, 0, "topic");
    const chatId = resolveTarget(args.in);
    const topicResult = await engineGet(`/graph/channel:${chatId}/topic`);
    const topicValue = (topicResult as { value?: unknown } | null)?.value ?? null;
    output(json, { chatId, topic: topicValue }, topicValue ? `Topic: "${topicValue}"` : "(no topic)");
  },
});

const join = defineCommand({
  meta: { name: "join", description: "Join a chat" },
  args: {
    target: {
      type: "positional",
      description: "Chat ID, @username, or invite link",
      required: true,
    },
  },
  async run({ args, rawArgs }) {
    const { json, args: cleaned } = extractJsonFlag(rawArgs);
    rejectExtraArgs(cleaned, 1, "join");
    const chatIdOrLink = (args.target as string).trim();
    if (!chatIdOrLink) die("join requires a target");
    const result = await enginePost("/telegram/join", { chatIdOrLink });
    output(json, result, renderConfirm("Joined", chatIdOrLink));
  },
});

const leave = defineCommand({
  meta: { name: "leave", description: "Leave current chat" },
  args: { in: inOption },
  async run({ args, rawArgs }) {
    const { json, args: cleaned } = extractJsonFlag(rawArgs);
    const positionals = stripFlags(cleaned, ["--in"]);
    rejectExtraArgs(positionals, 0, "leave");
    const chatId = resolveTarget(args.in);
    const result = await enginePost("/telegram/leave", { chatId });
    output(json, result, renderConfirm("Left chat"));
  },
});

const download = defineCommand({
  meta: { name: "download", description: "Download a file attachment from a message" },
  args: {
    in: inOption,
    ref: { type: "string", description: "Message ID containing the attachment", required: true },
    output: {
      type: "string",
      description: "Output path (must be under $ALICE_HOME)",
      required: true,
    },
  },
  async run({ args, rawArgs }) {
    const { json } = extractJsonFlag(rawArgs);
    const chatId = resolveTarget(args.in);
    const msgId = parseMsgId(args.ref as string);
    const outputPath = (args.output as string).trim();
    if (!outputPath) die("download requires --output path");
    const result = (await enginePost("/telegram/download", {
      chatId,
      msgId,
      output: outputPath,
    })) as {
      path?: string;
      mime?: string;
      size?: number;
    } | null;
    if (result?.path) {
      console.log(`${ACTION_PREFIX}downloaded:chatId=${chatId}:msgId=${msgId}:path=${result.path}`);
    }
    const detail = result?.path ?? outputPath;
    const size = result?.size != null ? ` (${result.size} bytes)` : "";
    output(json, result, renderConfirm("Downloaded", `${detail}${size}`));
  },
});

const sendFile = defineCommand({
  meta: { name: "send-file", description: "Send a local file to a chat" },
  args: {
    in: inOption,
    path: { type: "string", description: "File path (must be under $ALICE_HOME)", required: true },
    caption: { type: "string", description: "Optional caption" },
    ref: { type: "string", description: "Message ID to reply to" },
  },
  async run({ args, rawArgs }) {
    const { json } = extractJsonFlag(rawArgs);
    const chatId = resolveTarget(args.in);
    const filePath = (args.path as string).trim();
    if (!filePath) die("send-file requires --path");
    const body: Record<string, unknown> = { chatId, path: filePath };
    if (args.caption) body.caption = args.caption;
    if (args.ref) body.replyTo = parseMsgId(args.ref as string);
    const result = (await enginePost("/telegram/upload", body)) as {
      msgId?: number;
    } | null;
    if (result?.msgId != null) {
      console.log(`${ACTION_PREFIX}sent-file:chatId=${chatId}:path=${filePath}`);
    }
    output(json, result, renderConfirm("Sent file", filePath));
  },
});

// ── ADR-206 W8: 跨聊天转发 + 可选附加评论 ──

const forward = defineCommand({
  meta: {
    name: "forward",
    description: "Forward a message to another chat (with optional comment)",
  },
  args: {
    from: {
      type: "string" as const,
      description: "Source chat (@ID or numeric)",
      required: true,
    },
    ref: { type: "string", description: "Message ID to forward", required: true },
    to: {
      type: "string" as const,
      description: "Destination chat (@ID or numeric). Omit to use current chat context.",
    },
    text: {
      type: "positional",
      description: "Optional comment (attached as reply to forwarded message)",
      default: "",
    },
  },
  async run({ args, rawArgs }) {
    const { json, args: cleaned } = extractJsonFlag(rawArgs);
    const positionals = stripFlags(cleaned, ["--from", "--ref", "--to"]);
    rejectExtraArgs(positionals, 1, "forward");
    const fromChatId = resolveTarget(args.from);
    const msgId = parseMsgId(args.ref as string);
    const toChatId = resolveTarget(args.to);
    const comment = (args.text as string | undefined)?.trim() || undefined;
    const result = (await enginePost("/telegram/forward", {
      fromChatId,
      msgId,
      toChatId,
      ...(comment && { comment }),
    })) as { forwardedMsgId?: number; commentMsgId?: number } | null;
    if (result?.forwardedMsgId != null) {
      console.log(
        `${ACTION_PREFIX}forwarded:from=${fromChatId}:to=${toChatId}:msgId=${result.forwardedMsgId}`,
      );
    }
    if (result?.commentMsgId != null) {
      console.log(`${ACTION_PREFIX}sent:chatId=${toChatId}:msgId=${result.commentMsgId}`);
    }
    output(json, result, renderConfirm("Forwarded", `#${msgId} → @${toChatId}`));
  },
});

// ── Main ──

const main = defineCommand({
  meta: {
    name: "irc",
    description: "Telegram system chat client for Alice",
  },
  subCommands: {
    say,
    reply,
    react,
    sticker,
    voice,
    read,
    tail,
    whois,
    motd,
    threads,
    topic: topicCmd,
    join,
    leave,
    download,
    "send-file": sendFile,
    forward,
  },
});

runMain(main);
