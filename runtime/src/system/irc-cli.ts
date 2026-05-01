import { defineCommand, renderUsage } from "citty";
import { EngineApiError, engineGet, enginePost } from "../../skills/_lib/engine-client.js";
import type { ExecutionObservation } from "../core/script-execution.js";
import { telegramChannelId } from "../graph/constants.js";
import { parseMsgId, resolveTarget } from "./chat-client.js";
import { renderConfirm } from "./cli-bridge.js";
import {
  assertCurrentChatForSend,
  joinCommand,
  leaveCommand,
  motdCommand,
  OBSERVATION_PREFIX,
  reactCommand,
  readCommand,
  replyCommand,
  sayCommand,
  stickerCommand,
  tailCommand,
  threadsCommand,
  voiceCommand,
  whoisCommand,
} from "./cli-commands.js";
import { createRealContext } from "./cli-io.js";
import { type CommandName, filterOutput, parseOutputMode } from "./cli-json.js";
import { findUnknownOption } from "./cli-strict.js";
import {
  type CliContext,
  type CliErrorCode,
  CliExecutionError,
  emitCliErrorCode,
  isCliErrorCode,
  makeDie,
} from "./cli-types.js";

/** --in 选项：目标聊天。 */
const inOption = {
  type: "string" as const,
  description: "Target chat (@ID or numeric). Omit to use current chat context.",
  valueHint: "chatId",
};

/** --json 选项：指定输出字段（逗号分隔）。无参数则输出全部字段。 */
const jsonFlag = {
  json: {
    type: "string" as const,
    description: "Output as JSON with specified fields (comma-separated). Omit for human-readable.",
    valueHint: "fields",
  },
};

/** 命令执行结果。 */
interface CommandResult {
  action?: string;
  observation?: ExecutionObservation;
  output: string;
  /** 原始结果对象（用于 JSON 字段过滤）。 */
  rawResult?: unknown;
}

/** citty run 函数签名。 */
type CittyRun<A = Record<string, unknown>> = (ctx: { args: A }) => Promise<void>;

type ArgShape = Record<string, { alias?: string | readonly string[] | undefined }>;

/**
 * 创建命令执行器。
 * ADR-239: --json 接受字段列表，验证 + 过滤输出。
 */
function makeRunner<A extends { json?: string }>(
  command: CommandName,
  handler: (ctx: CliContext, args: A) => Promise<CommandResult>,
): CittyRun<A> {
  return async (cittyCtx) => {
    const ctx = createRealContext();
    const { json } = cittyCtx.args;

    try {
      const mode = parseOutputMode(command, json);
      const result = await handler(ctx, cittyCtx.args);

      if (result.action) console.log(result.action);
      if (result.observation) {
        console.log(`${OBSERVATION_PREFIX}${JSON.stringify(result.observation)}`);
      }

      switch (mode.type) {
        case "human":
          console.log(result.output);
          break;
        case "json": {
          const filtered = filterOutput(result.rawResult as Record<string, unknown>, mode.fields);
          console.log(JSON.stringify(filtered, null, 2));
          break;
        }
      }
    } catch (error) {
      const code = extractCliErrorCode(error);
      if (code) emitCliErrorCode(ctx.output, code);
      throw error;
    }
  };
}

function extractCliErrorCode(error: unknown): CliErrorCode | null {
  if (error instanceof CliExecutionError) return error.code;
  if (error instanceof EngineApiError && error.code && isCliErrorCode(error.code)) {
    return error.code;
  }
  return null;
}

const say = defineCommand({
  meta: { name: "say", description: "Send a message" },
  args: {
    ...jsonFlag,
    in: inOption,
    text: { type: "string", description: "Message text", required: true, valueHint: "message" },
    "resolve-thread": {
      type: "string",
      description: "Thread ID to resolve after sending",
      valueHint: "threadId",
    },
  },
  run: makeRunner("say", sayCommand),
});

const reply = defineCommand({
  meta: { name: "reply", description: "Reply to a message" },
  args: {
    ...jsonFlag,
    in: inOption,
    ref: {
      type: "string",
      description: "Visible current-chat message ID to reply to",
      required: true,
      valueHint: "msgId",
    },
    text: { type: "string", description: "Reply text", required: true, valueHint: "message" },
  },
  run: makeRunner("reply", replyCommand),
});

const react = defineCommand({
  meta: { name: "react", description: "React to a message" },
  args: {
    ...jsonFlag,
    in: inOption,
    ref: {
      type: "string",
      description: "Visible current-chat message ID to react to",
      required: true,
      valueHint: "msgId",
    },
    emoji: {
      type: "string",
      description: "Telegram reaction emoji, e.g. 👍 👎 ❤ 🔥 🥰 👏 😁 🤔 😢 🎉 👀 😴",
      required: true,
      valueHint: "telegram-reaction",
    },
  },
  run: makeRunner("react", reactCommand),
});

const sticker = defineCommand({
  meta: { name: "sticker", description: "Send a sticker by keyword" },
  args: {
    ...jsonFlag,
    in: inOption,
    keyword: {
      type: "string",
      description:
        "Sticker keyword. Use one of: happy, sad, angry, surprised, shy, tired, love, scared, wave, hug, cry, laugh, sleep, eat, dance, thumbsup, facepalm, peek.",
      required: true,
      valueHint: "happy|shy|laugh|hug|wave|peek",
    },
  },
  run: makeRunner("sticker", stickerCommand),
});

const voice = defineCommand({
  meta: { name: "voice", description: "Send a voice message (text-to-speech)" },
  args: {
    ...jsonFlag,
    in: inOption,
    emotion: {
      type: "string",
      description: "Emotion: happy, sad, angry, calm, whisper, ...",
      valueHint: "emotion",
    },
    ref: {
      type: "string",
      description: "Visible current-chat message ID to reply to",
      valueHint: "msgId",
    },
    text: { type: "string", description: "Text to speak", required: true, valueHint: "message" },
  },
  run: makeRunner("voice", voiceCommand),
});

const read = defineCommand({
  meta: { name: "read", description: "Mark chat as read" },
  args: {
    ...jsonFlag,
    in: inOption,
  },
  run: makeRunner("read", readCommand),
});

const tail = defineCommand({
  meta: { name: "tail", description: "Show recent messages" },
  args: {
    ...jsonFlag,
    in: inOption,
    count: {
      type: "string",
      description: "Number of messages",
      default: "20",
      alias: "c",
      valueHint: "number",
    },
  },
  run: makeRunner("tail", tailCommand),
});

const whois = defineCommand({
  meta: { name: "whois", description: "Look up a contact or the current chat room" },
  args: {
    ...jsonFlag,
    in: inOption,
    target: {
      type: "string",
      description: "Contact name or @ID (omit for room info)",
      valueHint: "userId",
    },
  },
  run: makeRunner("whois", whoisCommand),
});

const whoami = defineCommand({
  meta: {
    name: "whoami",
    description: "Show the current chat ID (hidden compatibility alias)",
    hidden: true,
  },
  args: {
    ...jsonFlag,
    in: inOption,
  },
  async run({ args }) {
    const chatId = await resolveTarget(args.in as string | undefined);
    outputMode("whoami", args.json, { chatId }, `chat: ${chatId}`);
  },
});

const motd = defineCommand({
  meta: { name: "motd", description: "Show chat mood and atmosphere" },
  args: {
    ...jsonFlag,
    in: inOption,
  },
  run: makeRunner("motd", motdCommand),
});

const threads = defineCommand({
  meta: { name: "threads", description: "Show open discussion threads" },
  args: jsonFlag,
  run: makeRunner("threads", threadsCommand),
});

const join = defineCommand({
  meta: { name: "join", description: "Join a chat" },
  args: {
    ...jsonFlag,
    target: {
      type: "string",
      description: "Chat ID, @username, or invite link",
      required: true,
      valueHint: "target",
    },
  },
  run: makeRunner("join", joinCommand),
});

const leave = defineCommand({
  meta: { name: "leave", description: "Leave current chat" },
  args: {
    ...jsonFlag,
    in: inOption,
  },
  run: makeRunner("leave", leaveCommand),
});

const ACTION_PREFIX = "__ALICE_ACTION__:";

function gval(res: unknown): unknown {
  return (res as { value?: unknown } | null)?.value ?? null;
}

function outputMode(
  command: CommandName | string,
  json: string | undefined,
  rawResult: unknown,
  humanText: string,
): void {
  const mode = parseOutputMode(command, json);
  switch (mode.type) {
    case "human":
      console.log(humanText);
      break;
    case "json": {
      const filtered = filterOutput(rawResult as Record<string, unknown>, mode.fields);
      console.log(JSON.stringify(filtered, null, 2));
      break;
    }
  }
}

const topic = defineCommand({
  meta: { name: "topic", description: "Show chat topic" },
  args: {
    ...jsonFlag,
    in: inOption,
  },
  async run({ args }) {
    const chatId = await resolveTarget(args.in as string | undefined);
    const topicResult = await engineGet(`/graph/${telegramChannelId(chatId)}/topic`);
    const topicValue = gval(topicResult);
    const rawResult = { chatId, topic: topicValue };
    outputMode("topic", args.json, rawResult, topicValue ? `Topic: "${topicValue}"` : "(no topic)");
  },
});

const download = defineCommand({
  meta: { name: "download", description: "Download a file attachment from a message" },
  args: {
    ...jsonFlag,
    in: inOption,
    ref: {
      type: "string",
      description: "Visible current-chat message ID containing the attachment",
      required: true,
      valueHint: "msgId",
    },
    output: {
      type: "string",
      description: "Output path (must be under $ALICE_HOME)",
      required: true,
      valueHint: "path",
    },
  },
  async run({ args }) {
    const ctx = createRealContext();
    const chatId = await resolveTarget(args.in as string | undefined);
    const msgId = parseMsgId(args.ref as string);
    const outputPath = (args.output as string).trim();

    const result = (await enginePost("/telegram/download", {
      chatId,
      msgId,
      output: outputPath,
    })) as { path?: string; mime?: string; size?: number } | null;

    if (result?.path) {
      console.log(`${ACTION_PREFIX}downloaded:chatId=${chatId}:msgId=${msgId}:path=${result.path}`);
      console.log(
        `${OBSERVATION_PREFIX}${JSON.stringify({
          kind: "query_result",
          source: "irc.download",
          text: `downloaded attachment from #${msgId} to ${result.path}`,
          enablesContinuation: true,
          currentChatId: ctx.currentChatId == null ? null : String(ctx.currentChatId),
          targetChatId: String(chatId),
          payload: {
            intent: "send_downloaded_file",
            path: result.path,
            sourceChatId: chatId,
            sourceMsgId: msgId,
            mime: result.mime ?? null,
            size: result.size ?? null,
          },
        })}`,
      );
    }

    const detail = result?.path ?? outputPath;
    const size = result?.size != null ? ` (${result.size} bytes)` : "";
    outputMode("download", args.json, result, renderConfirm("Downloaded", `${detail}${size}`));
  },
});

const sendFile = defineCommand({
  meta: { name: "send-file", description: "Send a local file to a chat" },
  args: {
    ...jsonFlag,
    in: inOption,
    path: {
      type: "string",
      description: "File path (must be under $ALICE_HOME)",
      required: true,
      valueHint: "file",
    },
    caption: { type: "string", description: "Optional caption", valueHint: "message" },
    ref: {
      type: "string",
      description: "Visible current-chat message ID to reply to",
      valueHint: "msgId",
    },
  },
  async run({ args }) {
    const ctx = createRealContext();
    const die = makeDie(ctx.output, "irc");
    const chatId = await resolveTarget(args.in as string | undefined);
    assertCurrentChatForSend(
      ctx,
      chatId,
      die,
      "irc.send-file",
      args.ref ? { replyRef: args.ref } : undefined,
    );
    const filePath = (args.path as string).trim();

    const body: Record<string, unknown> = { chatId, path: filePath };
    if (args.caption) body.caption = args.caption;
    if (args.ref) body.replyTo = parseMsgId(args.ref as string);

    const result = (await enginePost("/telegram/upload", body)) as { msgId?: number } | null;

    if (result?.msgId != null) {
      console.log(`${ACTION_PREFIX}sent-file:chatId=${chatId}:path=${filePath}`);
    }
    outputMode("send-file", args.json, result, renderConfirm("Sent file", filePath));
  },
});

const forward = defineCommand({
  meta: {
    name: "forward",
    description: "Forward a message to another chat (with optional comment)",
  },
  args: {
    ...jsonFlag,
    from: {
      type: "string",
      description: "Source chat (@ID or numeric)",
      required: true,
      valueHint: "chatId",
    },
    ref: {
      type: "string",
      description: "Message ID to forward",
      required: true,
      valueHint: "msgId",
    },
    to: {
      type: "string",
      description: "Destination chat (@ID or numeric). Omit to use current chat context.",
      valueHint: "chatId",
    },
    comment: {
      type: "string",
      description: "Optional comment (attached as reply to forwarded message)",
      default: "",
      valueHint: "message",
    },
  },
  async run({ args }) {
    const fromChatId = await resolveTarget(args.from as string);
    const msgId = parseMsgId(args.ref as string);
    const toChatId = await resolveTarget(args.to as string | undefined);
    const comment = (args.comment as string | undefined)?.trim() || undefined;

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
    outputMode(
      "forward",
      args.json,
      result,
      renderConfirm("Forwarded", `#${msgId} → @${toChatId}`),
    );
  },
});

export const ircSubCommands = {
  say,
  reply,
  react,
  sticker,
  voice,
  read,
  tail,
  whois,
  whoami,
  motd,
  threads,
  topic,
  join,
  leave,
  download,
  "send-file": sendFile,
  forward,
} as const;

export const ircCommand = defineCommand({
  meta: {
    name: "irc",
    description: "Telegram system chat client for Alice",
  },
  subCommands: ircSubCommands,
});

function isFlagLike(token: string): boolean {
  return token.startsWith("-") && token !== "-" && !/^-?\d/.test(token);
}

export async function validateIrcRawArgs(rawArgs: string[]): Promise<void> {
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) return;
  if (rawArgs.length === 1 && rawArgs[0] === "--version") return;

  const subCommandIndex = rawArgs.findIndex((arg) => !isFlagLike(arg));
  if (subCommandIndex < 0) return;

  for (const token of rawArgs.slice(0, subCommandIndex)) {
    if (!isFlagLike(token)) continue;
    console.log(await renderUsage(ircCommand));
    console.error(`Unknown option ${token}`);
    process.exit(1);
  }

  const subCommandName = rawArgs[subCommandIndex] as keyof typeof ircSubCommands;
  const subCommand = ircSubCommands[subCommandName];
  if (!subCommand) return;

  const argsDef = (subCommand.args ?? {}) as ArgShape;
  const unknown = findUnknownOption(rawArgs.slice(subCommandIndex + 1), argsDef);
  if (!unknown) return;

  console.log(
    await renderUsage(
      subCommand as Parameters<typeof renderUsage>[0],
      ircCommand as Parameters<typeof renderUsage>[1],
    ),
  );
  console.error(`Unknown option ${unknown}`);
  process.exit(1);
}
