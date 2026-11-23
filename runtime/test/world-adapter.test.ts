import type { Dispatcher } from "@mtcute/dispatcher";
import { describe, expect, it } from "vitest";
import type { AliceEvent } from "../src/mind/events.js";
import { bindTelegramWorldAdapter } from "../src/telegram/world-adapter.js";
import { mtcuteFake } from "./mtcute-fake.js";

/** 只记下注册的处理函数，按 Telegram 的形状手动喂更新。 */
function fakeDispatcher() {
  const h: {
    raw?: {
      filter: (c: unknown, u: { _: string }) => boolean;
      fn: (c: unknown, u: unknown) => unknown;
    };
    member?: (ctx: unknown) => unknown;
  } = {};
  const dispatcher = mtcuteFake<Dispatcher>({
    onNewMessage: () => {},
    onRawUpdate: (filter: never, fn: never) => {
      h.raw = { filter, fn };
    },
    onChatMemberUpdate: (fn: never) => {
      h.member = fn;
    },
  });
  return { dispatcher, h };
}

function bind() {
  const events: AliceEvent[] = [];
  const { dispatcher, h } = fakeDispatcher();
  bindTelegramWorldAdapter(dispatcher, {
    selfId: "42",
    now: () => 1000,
    onEvent: (e) => void events.push(e),
    admit: () => true,
    newGroup: () => false,
  });
  return { events, h };
}

const reactionUpdate = (userId: number, emoji = "👍") => ({
  _: "updateMessageReactions",
  peer: { _: "peerUser", userId: 7 },
  msgId: 11,
  reactions: {
    results: [],
    recentReactions: [
      {
        peerId: { _: "peerUser", userId },
        reaction: { _: "reactionEmoji", emoticon: emoji },
        unread: true,
      },
    ],
  },
});

describe("telegram world adapter: perception beyond messages", () => {
  it("turns a raw reaction update into reaction.received, ignoring her own", async () => {
    const { events, h } = bind();
    expect(h.raw?.filter(null, { _: "updateMessageReactions" })).toBe(true);
    await h.raw?.fn(null, reactionUpdate(7));
    await h.raw?.fn(null, reactionUpdate(42));
    expect(events).toEqual([
      {
        type: "reaction.received",
        at: 1000,
        scope: "telegram:7",
        messageId: "11",
        senderId: "7",
        emoji: "👍",
      },
    ]);
  });

  // 用户账号收不到这个更新（线上 22 小时一次也没有）；收到时也照样记，主要的来源是下面的入群、退群提示。
  it("a member update about her, when Telegram sends one, is her membership change; others' are not", async () => {
    const { events, h } = bind();
    await h.member?.({ user: { id: 42 }, chat: { id: -100 }, type: "kicked" });
    await h.member?.({ user: { id: 9 }, chat: { id: -100 }, type: "left" });
    expect(events).toEqual([
      {
        type: "membership.changed",
        at: 1000,
        scope: "telegram:-100",
        member: false,
        reason: "kicked",
      },
    ]);
  });

  it("a join or leave notice: member.joined for others, membership.changed for her, never an empty message", () => {
    const events: AliceEvent[] = [];
    const { dispatcher } = fakeDispatcher();
    const { receive } = bindTelegramWorldAdapter(dispatcher, {
      selfId: "42",
      now: () => 1000,
      onEvent: (e) => void events.push(e),
      admit: () => true,
      newGroup: () => false,
    });
    const notice = (action: unknown, sender = 9) =>
      ({
        id: 5,
        chat: { id: -100, chatType: "supergroup" },
        sender: { id: sender, displayName: "阿杰" },
        action,
        text: "",
        entities: [],
        media: null,
      }) as never;
    receive(notice({ type: "users_added", users: [7, 42] }), {} as never);
    receive(notice({ type: "user_joined_link", inviter: 3 }), {} as never);
    receive(notice({ type: "user_joined_link", inviter: 3 }, 42), {} as never);
    receive(notice({ type: "user_removed", user: 42 }), {} as never);
    receive(notice({ type: "user_left" }, 42), {} as never);
    const scope = "telegram:-100";
    expect(events).toEqual([
      { type: "member.joined", at: 1000, scope, userId: "7" },
      { type: "membership.changed", at: 1000, scope, member: true, reason: "added" },
      { type: "member.joined", at: 1000, scope, userId: "9" },
      { type: "membership.changed", at: 1000, scope, member: true, reason: "joined" },
      { type: "membership.changed", at: 1000, scope, member: false, reason: "kicked" },
      { type: "membership.changed", at: 1000, scope, member: false, reason: "left" },
    ]);
  });

  it("uses perceived sticker cache without downloading sticker bytes", async () => {
    const events: AliceEvent[] = [];
    const perceived = Promise.withResolvers<void>();
    const { dispatcher } = fakeDispatcher();
    let downloaded = 0;
    const { receive } = bindTelegramWorldAdapter(dispatcher, {
      selfId: "42",
      now: () => 1000,
      onEvent: (e) => {
        events.push(e);
        if (e.type === "message.perceived") perceived.resolve();
      },
      admit: () => true,
      newGroup: () => false,
      perceive: {
        image: async () => "",
        gif: async () => "",
        video: async () => "",
        voice: async () => "",
        sticker: (meta, load) => {
          if (meta.fileUniqueId === "uniq-1") return "贴纸:猫猫偷笑";
          return load().then(() => "miss");
        },
      },
    });
    receive(
      {
        id: 88,
        chat: { id: 7, chatType: "private" },
        sender: { id: 7, displayName: "池塘" },
        text: "",
        entities: [],
        media: {
          type: "sticker",
          sourceType: "static",
          uniqueFileId: "uniq-1",
          emoji: "😏",
          stickerSet: null,
          thumbnails: [],
        },
      } as never,
      {
        downloadAsBuffer: async () => {
          downloaded += 1;
          return new Uint8Array([1, 2, 3]);
        },
      },
    );
    await perceived.promise;
    expect(downloaded).toBe(0);
    expect(events.some((e) => e.type === "message.perceived" && e.media === "贴纸:猫猫偷笑")).toBe(
      true,
    );
  });
});
