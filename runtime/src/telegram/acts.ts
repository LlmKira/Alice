import type { Album } from "../album.js";
import { type Act, type ActKind, affordanceOf, type TelegramAct } from "../mind/affordances.js";
import { Failed } from "../mind/failure.js";
import type { ActOutcome } from "../mind/outcome.js";
import { typingMs } from "../utils/typing.js";
import {
  editText,
  forwardMessage,
  joinChat,
  leaveChat,
  markRead,
  type SpokenVoice,
  sendReaction,
  sendSticker,
  sendText,
  sendVoice,
} from "./actions.js";
import { discover } from "./discover.js";
import { TelegramActionError } from "./errors.js";
import type { Telegram } from "./gates.js";
import type { Shelf } from "./shelf.js";
import { chatIdOf } from "./world-adapter.js";

export interface ActContext {
  /** 客户端和执行器的限额（gates.ts）。 */
  telegram: Telegram;
  /**
   * 动作作用的会话：Telegram 的数字 id，或者只有邀请链接、不知道 id 的群（world-adapter inviteOf，
   * 找群时只看到了预览）——那种会话里只能按链接加入。
   */
  target: { chatId: number } | { invite: string };
  /** 做决定的会话（转发的受众规则要知道转到哪）。 */
  scope: string;
  /** 她看过、可以转发的东西（转发时按受众规则检查）。 */
  shelf: Shelf;
  album: Album;
  /** 贴纸词 → Telegram fileId（palette）；没有可用贴纸时为 null。 */
  stickerFileId: (word: string) => string | null;
  now: () => number;
  /** 把一句话合成语音（llm/tts.ts）。 */
  speak: (text: string) => Promise<SpokenVoice>;
  /** 等一会儿（发文字前"正在输入"的那几秒）。 */
  pause: (ms: number) => Promise<void>;
}

/** 有数字 id 的会话里的动作。 */
type ChatContext = Omit<ActContext, "target"> & { chatId: number };

type Executor<K extends ActKind> = (
  ctx: ChatContext,
  act: Extract<Act, { kind: K }>,
) => Promise<ActOutcome>;

const DONE: ActOutcome = { kind: "done" };

function posted(sent: number | undefined): ActOutcome {
  // 没拿到 id 不代表没发出去：当作结果未知，不重发。
  if (sent == null) throw new Error("Telegram did not return a message id");
  return { kind: "posted", messageId: String(sent) };
}

function telegramId(id: string | null): number | undefined {
  const n = id === null ? Number.NaN : Number(id);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * affordance 登记表里每一行在 Telegram 上怎么做。类型要求每种动作都有一项，
 * 所以登记表加一行而这里没补，类型检查会失败。
 */
const executors: { [K in Exclude<TelegramAct["kind"], "join-chat">]: Executor<K> } = {
  send: async ({ telegram, chatId, pause }, act) =>
    posted(
      await sendText(telegram, chatId, act.text, {
        replyToMsgId: telegramId(act.replyTo),
        typing: { ms: typingMs(act.text), pause },
      }),
    ),
  sticker: async ({ telegram, chatId, stickerFileId }, act) => {
    const fileId = stickerFileId(act.word);
    if (fileId === null) {
      throw new TelegramActionError("invalid_sticker_keyword", `no sticker for "${act.word}"`);
    }
    return posted(await sendSticker(telegram, chatId, fileId));
  },
  react: async ({ telegram, chatId }, act) => {
    const messageId = telegramId(act.messageId);
    if (messageId === undefined) {
      throw new TelegramActionError(
        "peer_unreachable",
        `not a Telegram message id: ${act.messageId}`,
      );
    }
    await sendReaction(telegram, chatId, messageId, act.emoji);
    return DONE;
  },
  "mark-read": async ({ telegram, chatId }) => {
    await markRead(telegram, chatId);
    return DONE;
  },
  "leave-chat": async ({ telegram, chatId }) => {
    await leaveChat(telegram, chatId);
    return DONE;
  },
  // 看了才知道的动作：返回的是她看到的东西（act.done 的 result），不是消息 id。
  "album-search": async ({ album, now }, act) => ({
    kind: "looked",
    text: await album.search(act.query, now(), "telegram:"),
    found: [],
  }),
  "album-send": async ({ telegram, chatId, album }, act) => {
    const photo = album.source(act.asset);
    if (!photo) {
      throw new TelegramActionError("invalid_asset", `no album photo ${act.asset}`);
    }
    const from = { chatId: chatIdOf(photo.scope), messageId: Number(photo.messageId) };
    return posted(await forwardMessage(telegram, from, chatId, { noAuthor: true }));
  },
  forward: async ({ telegram, chatId, shelf, scope }, act) => {
    // Telegram 的用户 id 是正数：转到私聊时对方就是这个 id（受众规则看对方当时在不在场）。
    const target = {
      scope,
      chatType: chatId > 0 ? ("private" as const) : ("group" as const),
      partner: chatId > 0 ? String(chatId) : null,
    };
    const source = shelf.source(act.item, target);
    const from = { chatId: chatIdOf(source.scope), messageId: Number(source.messageId) };
    return posted(await forwardMessage(telegram, from, chatId));
  },
  "chat-search": async ({ telegram }, act) => ({
    kind: "looked",
    ...(await discover(telegram, act.query)),
  }),
  voice: async ({ telegram, chatId, speak }, act) =>
    posted(await sendVoice(telegram, chatId, () => speak(act.text))),
  edit: async ({ telegram, chatId }, act) => {
    const messageId = telegramId(act.messageId);
    if (messageId === undefined) {
      throw new TelegramActionError("edit_refused", `not a Telegram message id: ${act.messageId}`);
    }
    await editText(telegram, chatId, messageId, act.text);
    return DONE;
  },
  // Telegram 生产未开启 unsend（用 edit 改消息）；保留执行器位以满足类型完备性。
  unsend: async () => {
    throw new Failed({ reason: "unavailable" }, "unsend is not enabled on Telegram");
  },
  repeat: async ({ telegram, chatId }, act) => {
    const messageId = telegramId(act.messageId);
    if (messageId === undefined) {
      throw new TelegramActionError(
        "peer_unreachable",
        `not a Telegram message id: ${act.messageId}`,
      );
    }
    const from = { chatId, messageId };
    return posted(await forwardMessage(telegram, from, chatId, { noAuthor: true }));
  },
};

/**
 * 加入按会话的写法加（数字 id 或邀请链接）；其余动作都要一个有数字 id 的会话。
 * 不经 Telegram 的事（心里的事、交出去办的事，登记表 via）外壳不会送到这里。
 */
export async function executeAct(ctx: ActContext, act: Act): Promise<ActOutcome> {
  if (affordanceOf(act.kind).via !== "telegram") {
    throw new Error(`act has no Telegram effect: ${act.kind}`);
  }
  const { target, ...rest } = ctx;
  if (act.kind === "join-chat") {
    await joinChat(ctx.telegram, target);
    return DONE;
  }
  if (!("chatId" in target)) {
    throw new TelegramActionError("peer_unreachable", `${act.kind} needs a chat id, not an invite`);
  }
  type Kind = Exclude<TelegramAct["kind"], "join-chat">;
  const run = executors[act.kind as Kind] as Executor<Kind>;
  return run({ ...rest, chatId: target.chatId }, act as never);
}
