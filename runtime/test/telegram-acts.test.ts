import type { TelegramClient } from "@mtcute/node";
import { tl } from "@mtcute/node";
import { describe, expect, it } from "vitest";
import { Album } from "../src/album.js";
import { itemId } from "../src/mechanisms/pressure/reach.js";
import { mechanisms } from "../src/mechanisms/registry.js";
import type { Act } from "../src/mind/affordances.js";
import type { MessageReceived } from "../src/mind/events.js";
import { presentIn } from "../src/mind/presence.js";
import { emptyState } from "../src/mind/state.js";
import { createFold } from "../src/shell.js";
import { type ActContext, executeAct } from "../src/telegram/acts.js";
import { TelegramActionError } from "../src/telegram/errors.js";
import { Acquaintances } from "../src/telegram/first-dm.js";
import { Gates, Telegram } from "../src/telegram/gates.js";
import { Shelf } from "../src/telegram/shelf.js";
import { mtcuteFake } from "./mtcute-fake.js";

/** 只记录调用的假 Telegram 客户端。 */
function fakeClient(
  fail: Partial<Record<string, Error>> = {},
  joined: { status: string } = { status: "ok" },
) {
  const calls: Array<[string, unknown[]]> = [];
  const method =
    (name: string, result: unknown = undefined) =>
    async (...args: unknown[]) => {
      calls.push([name, args]);
      if (fail[name]) throw fail[name];
      return result;
    };
  const client = mtcuteFake<TelegramClient>({
    sendText: method("sendText", { id: 41 }),
    sendMedia: method("sendMedia", { id: 42 }),
    readHistory: method("readHistory"),
    readReactions: method("readReactions"),
    sendReaction: method("sendReaction"),
    leaveChat: method("leaveChat"),
    joinChat: method("joinChat", joined),
    forwardMessagesById: method("forwardMessagesById", [{ id: 43 }]),
    getChat: method("getChat"),
  });
  return { client, calls };
}

/** 和这个人已经有过私聊来往（不是第一次私聊；第一次私聊见 telegram-first-dm.test.ts）。 */
function talkedWith(chatId: number): Acquaintances {
  const people = new Acquaintances();
  if (chatId > 0) {
    people.observe({
      type: "message.received",
      at: 0,
      scope: `telegram:${chatId}`,
      chatType: "private",
      messageId: "1",
      senderId: String(chatId),
      senderName: "朋友",
      text: "在吗",
      contentType: "text",
      replyToMessageId: null,
      directed: true,
    });
  }
  return people;
}

const ctx = (client: TelegramClient, chatId = -100123, gates = new Gates()): ActContext => ({
  telegram: new Telegram(client, gates, undefined, talkedWith(chatId)),
  target: { chatId },
  scope: `telegram:${chatId}`,
  shelf: new Shelf(),
  stickerFileId: (word) => (word === "laugh" ? "file-laugh" : null),
  album: new Album(async () => []),
  now: () => 0,
  speak: async () => {
    throw new Error("no speech synthesis in this test");
  },
  pause: async () => {},
});

describe("executeAct", () => {
  it("sends text with a quote and returns the delivered id", async () => {
    const { client, calls } = fakeClient();
    await expect(
      executeAct(ctx(client), { kind: "send", text: "在", replyTo: "7" }),
    ).resolves.toEqual({ kind: "posted", messageId: "41" });
    expect(calls.find(([n]) => n === "sendText")?.[1]).toEqual([
      -100123,
      "在",
      { replyTo: 7, abortSignal: expect.any(AbortSignal) as AbortSignal },
    ]);
  });

  it("reacts to a message by its Telegram id", async () => {
    const { client, calls } = fakeClient();
    await expect(
      executeAct(ctx(client), { kind: "react", messageId: "9", emoji: "👍" }),
    ).resolves.toEqual({ kind: "done" });
    expect(calls).toEqual([["sendReaction", [{ chatId: -100123, message: 9, emoji: "👍" }]]]);
  });

  it("marks read, leaves and joins the chat it was decided in", async () => {
    const { client, calls } = fakeClient();
    await executeAct(ctx(client), { kind: "mark-read" });
    await executeAct(ctx(client), { kind: "leave-chat" });
    await executeAct(ctx(client), { kind: "join-chat" });
    expect(calls.map(([n, args]) => [n, args[0]])).toEqual([
      ["readHistory", -100123],
      ["readReactions", -100123],
      ["leaveChat", -100123],
      ["joinChat", -100123],
    ]);
  });

  it("turns Telegram's refusal into a typed failure and leaves other errors as unknown", async () => {
    const forbidden = fakeClient({ leaveChat: new tl.RpcError(400, "CHANNEL_PRIVATE") });
    await expect(executeAct(ctx(forbidden.client), { kind: "leave-chat" })).rejects.toBeInstanceOf(
      TelegramActionError,
    );
    const flaky = fakeClient({ sendReaction: new Error("socket hang up") });
    const unknown = executeAct(ctx(flaky.client), { kind: "react", messageId: "9", emoji: "👍" });
    await expect(unknown).rejects.not.toBeInstanceOf(TelegramActionError);
  });

  it("a private message goes to the user id; a closed inbox is typed and says so about the person", async () => {
    const { client, calls } = fakeClient();
    await executeAct(ctx(client, 100), { kind: "send", text: "嗨", replyTo: null });
    expect(calls.find(([n]) => n === "sendText")?.[1]?.[0]).toBe(100);
    const closed = fakeClient({ sendText: new tl.RpcError(403, "PRIVACY_PREMIUM_REQUIRED") });
    await expect(
      executeAct(ctx(closed.client, 100), { kind: "send", text: "嗨", replyTo: null }),
    ).rejects.toMatchObject({
      code: "private_closed",
      failure: { reason: "private_closed", rpc: "PRIVACY_PREMIUM_REQUIRED", dmClosed: true },
    });
  });

  it("joins a group known only by its invite link through the link; a join request is typed", async () => {
    const { client, calls } = fakeClient();
    const invite = (c: TelegramClient, hash: string) => ({
      ...ctx(c),
      target: { invite: hash },
    });
    await executeAct(invite(client, "abcDEF"), { kind: "join-chat" });
    expect(calls).toEqual([["joinChat", ["https://t.me/+abcDEF"]]]);
    // 只有邀请链接的会话里，加入以外的动作没有对象：带类型的失败，不发请求。
    await expect(
      executeAct(invite(client, "abcDEF"), { kind: "send", text: "嗨", replyTo: null }),
    ).rejects.toMatchObject({ code: "peer_unreachable" });
    expect(calls).toHaveLength(1);
    const pending = fakeClient({}, { status: "request_sent" });
    await expect(
      executeAct(invite(pending.client, "xyz"), { kind: "join-chat" }),
    ).rejects.toMatchObject({ code: "join_requested" });
    const guarded = fakeClient({}, { status: "webview" });
    await expect(
      executeAct(invite(guarded.client, "xyz"), { kind: "join-chat" }),
    ).rejects.toMatchObject({ code: "transport_soft_permanent" });
  });

  it("forwards a channel post; a private message never leaves its chat (audience rule at the actuator)", async () => {
    const shelf = new Shelf();
    shelf.observe(
      {
        type: "post.received",
        at: 0,
        scope: "telegram:-1009",
        messageId: "77",
        title: "冷知识日报",
        text: "章鱼有三颗心脏",
      },
      emptyState,
    );
    shelf.observe(
      {
        type: "message.received",
        at: 0,
        scope: "telegram:300",
        chatType: "private",
        messageId: "5",
        senderId: "300",
        senderName: "小雨",
        text: "私事",
        contentType: "text",
        replyToMessageId: null,
        directed: true,
      },
      emptyState,
    );
    const { client, calls } = fakeClient();
    const toFriend = { ...ctx(client, 400), shelf, scope: "telegram:400" };
    await executeAct(toFriend, { kind: "forward", item: itemId("telegram:-1009", "77") });
    expect(calls).toEqual([
      ["forwardMessagesById", [{ fromChatId: -1009, messages: [77], toChatId: 400 }]],
    ]);
    await expect(
      executeAct(toFriend, { kind: "forward", item: itemId("telegram:300", "5") }),
    ).rejects.toMatchObject({ code: "not_shareable" });
    expect(calls.length).toBe(1);
  });

  it("forwarding from a group that forbids forwards is a typed failure, not an unknown outcome", async () => {
    const album = new Album(async () => [0]);
    album.observe({
      type: "message.received",
      at: 0,
      scope: "telegram:-1007",
      chatType: "group",
      messageId: "8",
      senderId: "5",
      senderName: "阿青",
      text: "猫",
      contentType: "photo",
      replyToMessageId: null,
      directed: false,
    });
    const asset = (await album.search("猫", 0)).match(/\[(p\w+)\]/)?.[1] ?? "";
    const restricted = fakeClient({
      forwardMessagesById: new tl.RpcError(400, "CHAT_FORWARDS_RESTRICTED"),
    });
    await expect(
      executeAct({ ...ctx(restricted.client), album }, { kind: "album-send", asset }),
    ).rejects.toMatchObject({ code: "transport_soft_permanent" });
    await expect(
      executeAct(ctx(restricted.client), { kind: "repeat", messageId: "3" }),
    ).rejects.toMatchObject({ code: "transport_soft_permanent" });
  });

  it("forwards count against the per-chat burst gate like any other message of hers", async () => {
    const shelf = new Shelf();
    shelf.observe(
      {
        type: "post.received",
        at: 0,
        scope: "telegram:-1009",
        messageId: "77",
        title: "冷知识日报",
        text: "章鱼有三颗心脏",
      },
      emptyState,
    );
    const { client, calls } = fakeClient();
    const to = { ...ctx(client, 401), shelf, scope: "telegram:401" };
    const item = itemId("telegram:-1009", "77");
    for (let i = 0; i < 6; i++) await executeAct(to, { kind: "forward", item });
    await expect(executeAct(to, { kind: "forward", item })).rejects.toMatchObject({
      code: "outgoing_burst_limited",
    });
    expect(calls.filter(([n]) => n === "forwardMessagesById").length).toBe(6);
  });

  it("burst limit allows 6 messages per minute including recovered history without double-counting", async () => {
    const now = 1_771_000_000_000;
    const gates = new Gates(() => now);
    // 启动恢复：窗口内已有 2 条历史发出记录
    for (let i = 0; i < 2; i++) {
      gates.observe({
        type: "message.sent",
        at: now - (20 - i) * 1000,
        scope: "telegram:-100123",
        messageId: String(i + 1),
        kind: "text",
        text: "历史消息",
      });
    }
    const { client, calls } = fakeClient();
    const to = ctx(client, -100123, gates);
    // 运行期应还能发出 4 条（合计 6 条），第 5 条（第 7 条）才被拦截
    for (let i = 0; i < 4; i++) {
      await executeAct(to, { kind: "send", text: `第${i + 1}条`, replyTo: null });
    }
    await expect(
      executeAct(to, { kind: "send", text: "第5条超限", replyTo: null }),
    ).rejects.toMatchObject({
      code: "outgoing_burst_limited",
    });
    expect(calls.filter(([n]) => n === "sendText").length).toBe(4);
  });

  it("looking up a group by a name nobody has is a typed failure", async () => {
    const missing = fakeClient({ getChat: new tl.RpcError(400, "USERNAME_NOT_OCCUPIED") });
    await expect(
      executeAct(ctx(missing.client), { kind: "chat-search", query: "@nosuchgroup" }),
    ).rejects.toMatchObject({ code: "peer_unreachable" });
  });

  it("the join and search budgets survive a restart: they are counted back from the Journal", async () => {
    const H = 3_600_000;
    const now = 1_771_000_000_000;
    const gates = new Gates(() => now);
    const at = (ms: number, kind: "join-chat" | "chat-search", reason?: "too_often") =>
      gates.observe(
        reason
          ? { type: "act.failed", at: ms, scope: "telegram:-7", act: actOf(kind), reason }
          : { type: "act.done", at: ms, scope: "telegram:-7", act: actOf(kind) },
      );
    const actOf = (kind: "join-chat" | "chat-search"): Act =>
      kind === "join-chat" ? { kind } : { kind, query: "胶片" };
    // 昨天以前的一次不算；今天的 4 次加 1 次 Telegram 拒绝的（发出了请求）是 5 次；被额度挡下的不算。
    at(now - 25 * H, "join-chat");
    for (let i = 1; i <= 4; i++) at(now - i * H, "join-chat");
    gates.observe({
      type: "act.failed",
      at: now - 30_000,
      scope: "telegram:-8",
      act: { kind: "join-chat" },
      reason: "join_requested",
    });
    at(now - 20_000, "join-chat", "too_often");
    const { client, calls } = fakeClient();
    await expect(
      executeAct(ctx(client, -100123, gates), { kind: "join-chat" }),
    ).rejects.toMatchObject({ code: "too_often" });
    for (let i = 0; i < 10; i++) at(now - 60_000, "chat-search");
    await expect(
      executeAct(ctx(client, -100123, gates), { kind: "chat-search", query: "胶片" }),
    ).rejects.toMatchObject({ code: "too_often" });
    expect(calls).toEqual([]);
    // 刚开的一份（没读日志）还有额度：差别只来自 Journal。
    await executeAct(ctx(client), { kind: "join-chat" });
    expect(calls.map(([n]) => n)).toEqual(["joinChat"]);
  });

  // PLAN 第 33 件以前只转给当时在场的人；群里当众说的现在转到哪都行，私聊里的照旧不转（reach.ts mayForward）。
  it("a group message may be forwarded to anyone, by the same rule the mind uses", async () => {
    const say = (id: string, sender: string): MessageReceived => ({
      type: "message.received",
      at: 1_771_000_000_000 + Number(id) * 1000,
      scope: "telegram:-500",
      chatType: "group",
      messageId: id,
      senderId: sender,
      senderName: sender,
      text: `第${id}条`,
      contentType: "text",
      replyToMessageId: null,
      directed: false,
    });
    // 只从 fold（写进了日志的事件）喂：和运行时同一个钩子。
    const shelf = new Shelf();
    const fold = createFold(mechanisms, (event, state) => shelf.observe(event, state));
    fold.feed(say("1", "201"));
    fold.feed(say("2", "202"));
    const { client, calls } = fakeClient();
    const to = (person: string) => ({
      ...ctx(client, Number(person)),
      shelf,
      scope: `telegram:${person}`,
    });
    const item = itemId("telegram:-500", "2");
    // 201 那时在场、203 没在这个群说过话：都可以。
    await executeAct(to("201"), { kind: "forward", item });
    expect(presentIn(fold.result().state.chats["telegram:-500"])).toEqual(["201", "202"]);
    await executeAct(to("203"), { kind: "forward", item });
    expect(calls).toHaveLength(2);
  });

  it("fails a sticker it has no file for without calling Telegram", async () => {
    const { client, calls } = fakeClient();
    await expect(executeAct(ctx(client), { kind: "sticker", word: "shy" })).rejects.toMatchObject({
      code: "invalid_sticker_keyword",
    });
    expect(calls).toEqual([]);
  });
});
