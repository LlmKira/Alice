/**
 * 通过平台接口测试 QQ 平台（OneBot v11）：在 WebSocket 这一层换上假的 OneBot 服务端（不连网络）。
 * 入站检查平台产出的 AliceEvent；出站检查平台发出的 OneBot 请求、动作结果和失败码。
 */
import { afterEach, describe, expect, it } from "vitest";
import { closeDb, initDb } from "../src/db/connection.js";
import type { Gateway } from "../src/llm/gateway.js";
import { StickerCache } from "../src/llm/sticker-perceive.js";
import { isGroupAttentionWorthy } from "../src/mechanisms/pressure/group-filter.js";
import {
  emptyWorld,
  intentionsFor,
  PRODUCTION,
  willWake,
  worldFold,
} from "../src/mechanisms/pressure/index.js";
import { productionMechanisms } from "../src/mechanisms/registry.js";
import { type Act, affordances } from "../src/mind/affordances.js";
import type { AliceEvent, MessageReceived } from "../src/mind/events.js";
import { Failed } from "../src/mind/failure.js";
import { emptyChat, emptyState } from "../src/mind/state.js";
import { speechRequest, step } from "../src/mind/step.js";
import type { PlatformHost } from "../src/platform.js";
import type { SocketLike } from "../src/qq/client.js";
import { QQPlatform } from "../src/qq/platform.js";
import { perceiveSticker, resolveStickerFileId } from "../src/sticker-palette.js";
import { fakeGateway } from "./fake-gateway.js";

const SELF = "10001";
const OPERATOR = "20002";
const GROUP = 300;
const T0 = 1_771_000_000_000;

type Answer = unknown | { fail: { retcode: number; wording: string } };
type Listener = (event: { data?: unknown }) => void;
interface Request {
  action: string;
  params: Record<string, unknown>;
  echo: string;
}

/** 假的 OneBot 服务端：记录每个请求，按动作名返回预设的回复（没预设的回 null）。 */
class FakeOneBot {
  readonly requests: Array<{ action: string; params: Record<string, unknown> }> = [];
  readonly answers = new Map<string, (params: Record<string, unknown>) => Answer>([
    ["get_login_info", () => ({ user_id: Number(SELF), nickname: "Alice" })],
  ]);

  url = "";
  headers: Record<string, string> = {};
  /** 为 false 时连接不会自动打开，要等调用 open()。 */
  autoOpen = true;
  private listeners = new Map<string, Listener[]>();

  readonly connect = (url: string, headers: Record<string, string>): SocketLike => {
    this.url = url;
    this.headers = headers;
    const socket: SocketLike = {
      send: (data) => this.handle(JSON.parse(data) as Request),
      close: () => this.emit("close"),
      addEventListener: (type: string, listener: Listener) => {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      },
    };
    if (this.autoOpen) queueMicrotask(() => this.emit("open"));
    return socket;
  };

  open(): void {
    this.emit("open");
  }

  answer(action: string, fn: (params: Record<string, unknown>) => Answer): void {
    this.answers.set(action, fn);
  }

  /** OneBot 推送一个事件。 */
  push(event: Record<string, unknown>): void {
    this.emit("message", { data: JSON.stringify({ time: 1, self_id: Number(SELF), ...event }) });
  }

  /** 她做的请求：连上时平台自己发的两个（登录信息、收藏表情）不算。 */
  actions(): string[] {
    return this.requests
      .map((r) => r.action)
      .filter((a) => a !== "get_login_info" && a !== "fetch_custom_face");
  }

  private handle(req: Request): void {
    this.requests.push({ action: req.action, params: req.params });
    const answer = this.answers.get(req.action)?.(req.params) ?? null;
    const reply =
      answer !== null && typeof answer === "object" && "fail" in answer
        ? { status: "failed", ...(answer as { fail: object }).fail, echo: req.echo }
        : { status: "ok", retcode: 0, data: answer, echo: req.echo };
    queueMicrotask(() => this.emit("message", { data: JSON.stringify(reply) }));
  }

  private emit(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

/** 等平台处理完 OneBot 推来的事件和看图结果（都在微任务里完成）。 */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

interface StartOptions {
  token?: string;
  gateway?: Gateway;
  /** 替换运行时的看贴纸（默认只回"贴纸"）。 */
  sticker?: PlatformHost["perceive"]["sticker"];
  /** 连上之前先给假的 OneBot 预设回复（如收藏表情）。 */
  prepare?: (server: FakeOneBot) => void;
}

async function startQQ(options: StartOptions = {}) {
  const server = new FakeOneBot();
  options.prepare?.(server);
  const events: AliceEvent[] = [];
  const platform = new QQPlatform(
    { name: "qq", wsUrl: "ws://127.0.0.1:3001", token: options.token ?? null, selfId: null },
    {
      gateway: options.gateway ?? fakeGateway(() => ({})),
      operatorId: OPERATOR,
      ignoredSenders: new Set(["99999"]),
      tts: null,
      connect: server.connect,
      download: async (url) => new TextEncoder().encode(url),
    },
  );
  const host: PlatformHost = {
    dispatch: (event) => {
      events.push(event);
      // 和运行时一样：写进 Journal 的事件经 observe 回传给平台，更新它的投影。
      platform.observe(event, emptyState, "live");
    },
    now: () => T0,
    state: () => emptyState,
    pause: { paused: false, onPause: () => {} },
    perceive: {
      image: async (bytes) => `看到了 ${new TextDecoder().decode(bytes)}`,
      gif: async () => "动图",
      video: async () => "视频",
      voice: async () => "你好呀",
      sticker: options.sticker ?? (async () => "贴纸"),
    },
    signal: new AbortController().signal,
    track: (task) => task,
    connection: () => {},
    warn: () => {},
  };
  const { selfId } = await platform.start(host);
  return { server, platform, events, selfId };
}

const groupMessage = (message: unknown, extra: Record<string, unknown> = {}) => ({
  post_type: "message",
  message_type: "group",
  sub_type: "normal",
  message_id: 501,
  group_id: GROUP,
  user_id: 40004,
  message,
  sender: { user_id: 40004, nickname: "小周", card: "周周" },
  ...extra,
});

const received = (events: AliceEvent[]) =>
  events.filter((e): e is MessageReceived => e.type === "message.received");

async function failureOf(task: Promise<unknown>) {
  const error = await task.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Failed);
  return (error as Failed).failure;
}

describe("QQ platform: connecting", () => {
  it("authenticates with the header only (the token never goes into the URL), and learns who she is from get_login_info", async () => {
    const { server, selfId } = await startQQ({ token: "t0ken" });
    expect(selfId).toBe(SELF);
    expect(server.url).toBe("ws://127.0.0.1:3001");
    expect(server.url).not.toContain("t0ken");
    expect(server.headers).toEqual({ Authorization: "Bearer t0ken" });
  });

  it("does not wait forever when OneBot never opens: start returns after the grace window and binds once it connects", async () => {
    const server = new FakeOneBot();
    server.autoOpen = false;
    const events: AliceEvent[] = [];
    const warnings: string[] = [];
    const platform = new QQPlatform(
      { name: "qq", wsUrl: "ws://127.0.0.1:3001", token: null, selfId: null },
      {
        gateway: fakeGateway(() => ({})),
        operatorId: OPERATOR,
        ignoredSenders: new Set(),
        tts: null,
        startupGraceMs: 20,
        connect: server.connect,
      },
    );
    const host: PlatformHost = {
      dispatch: (event) => events.push(event),
      now: () => T0,
      state: () => emptyState,
      pause: { paused: false, onPause: () => {} },
      perceive: {
        image: async () => "图",
        gif: async () => "动图",
        video: async () => "视频",
        voice: async () => "语音",
        sticker: async () => "贴纸",
      },
      signal: new AbortController().signal,
      track: (task) => task,
      connection: () => {},
      warn: (message) => warnings.push(message),
    };
    const started = Date.now();
    expect(await platform.start(host)).toEqual({ selfId: "pending" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(warnings.some((w) => w.includes("not connected yet"))).toBe(true);
    expect(await platform.selftest()).toBe("还没连上 QQ。");

    // 之后连上了：拿到她的账号，此后推来的消息照常进来。
    server.open();
    await settle();
    server.push(groupMessage([{ type: "text", data: { text: "有人吗" } }]));
    await settle();
    expect(received(events).map((e) => e.text)).toEqual(["有人吗"]);
    await platform.stop();
  });
});

describe("QQ platform: what comes in", () => {
  it("a group message that @s her is directed, in the group's scope, with the sender's group card", async () => {
    const { server, events } = await startQQ();
    server.push(
      groupMessage([
        { type: "at", data: { qq: SELF } },
        { type: "text", data: { text: " 你好" } },
      ]),
    );
    await settle();
    expect(received(events)).toEqual([
      {
        type: "message.received",
        at: T0,
        scope: "qq:group:300",
        chatType: "group",
        messageId: "501",
        senderId: "40004",
        senderName: "周周",
        text: "@Alice 你好",
        contentType: "text",
        replyToMessageId: null,
        directed: true,
      },
    ]);
  });

  it("@ someone else by a Chinese nickname is marked mentionsOther, so it does not pull her attention", async () => {
    const { server, events } = await startQQ();
    server.push(
      groupMessage([
        { type: "at", data: { qq: "50005", name: "小李" } },
        { type: "text", data: { text: " 明天几点" } },
      ]),
    );
    await settle();
    const [message] = received(events);
    expect(message).toMatchObject({ directed: false, mentionsOther: true, text: "@小李 明天几点" });
    expect(isGroupAttentionWorthy(message as MessageReceived)).toBe(false);
  });

  it("keeps the replied-to message id and reads CQ-code strings the same as segment arrays", async () => {
    const { server, events } = await startQQ();
    server.push(groupMessage("[CQ:reply,id=77]说得对 &#91;笑&#93;"));
    await settle();
    expect(received(events)[0]).toMatchObject({
      replyToMessageId: "77",
      text: "说得对 [笑]",
      directed: false,
    });
    expect(received(events)[0]).not.toHaveProperty("mentionsOther");
  });

  it("a private message is directed and lives in qq:private:<sender>", async () => {
    const { server, events } = await startQQ();
    server.push({
      post_type: "message",
      message_type: "private",
      sub_type: "friend",
      message_id: 9,
      user_id: 40004,
      message: [{ type: "text", data: { text: "在吗" } }],
      sender: { user_id: 40004, nickname: "小周" },
    });
    await settle();
    expect(received(events)[0]).toMatchObject({
      scope: "qq:private:40004",
      chatType: "private",
      senderName: "小周",
      directed: true,
    });
  });

  it("describes a picture first, then sends what she saw in it as message.perceived", async () => {
    const { server, events } = await startQQ();
    server.push(
      groupMessage([{ type: "image", data: { file: "a.jpg", url: "https://img.example/a.jpg" } }]),
    );
    await settle();
    expect(received(events)[0]).toMatchObject({ contentType: "photo", media: "图片", text: null });
    expect(events.find((e) => e.type === "message.perceived")).toEqual({
      type: "message.perceived",
      at: T0,
      scope: "qq:group:300",
      messageId: "501",
      media: "图片：看到了 https://img.example/a.jpg",
    });
  });

  it("drops her own messages and ignored senders", async () => {
    const { server, events } = await startQQ();
    server.push(
      groupMessage([{ type: "text", data: { text: "我说的" } }], { user_id: Number(SELF) }),
    );
    server.push(groupMessage([{ type: "text", data: { text: "机器人" } }], { user_id: 99999 }));
    await settle();
    expect(events).toEqual([]);
  });

  it("a ban on her becomes chat.described with every kind banned; the lift clears it", async () => {
    const { server, events } = await startQQ();
    const ban = {
      post_type: "notice",
      notice_type: "group_ban",
      group_id: GROUP,
      user_id: Number(SELF),
    };
    server.push({ ...ban, sub_type: "ban", duration: 600 });
    await settle();
    server.push({ ...ban, sub_type: "lift_ban", duration: 0 });
    await settle();
    expect(events).toEqual([
      {
        type: "chat.described",
        at: T0,
        scope: "qq:group:300",
        members: null,
        admins: [],
        banned: ["text", "forward", "sticker", "photo", "voice"],
      },
      {
        type: "chat.described",
        at: T0,
        scope: "qq:group:300",
        members: null,
        admins: [],
        banned: [],
      },
    ]);
  });

  it("someone else joining is member.joined; her being invited or kicked is membership.changed", async () => {
    const { server, events } = await startQQ();
    const notice = { post_type: "notice", group_id: GROUP };
    server.push({ ...notice, notice_type: "group_increase", sub_type: "approve", user_id: 60006 });
    server.push({
      ...notice,
      notice_type: "group_increase",
      sub_type: "invite",
      user_id: Number(SELF),
    });
    server.push({ ...notice, notice_type: "group_decrease", sub_type: "leave", user_id: 60006 });
    server.push({
      ...notice,
      notice_type: "group_decrease",
      sub_type: "kick_me",
      user_id: Number(SELF),
    });
    await settle();
    expect(events).toEqual([
      { type: "member.joined", at: T0, scope: "qq:group:300", userId: "60006" },
      { type: "membership.changed", at: T0, scope: "qq:group:300", member: true, reason: "added" },
      {
        type: "membership.changed",
        at: T0,
        scope: "qq:group:300",
        member: false,
        reason: "kicked",
      },
    ]);
  });

  it("an emoji stuck on a message is reaction.received", async () => {
    const { server, events } = await startQQ();
    server.push({
      post_type: "notice",
      notice_type: "group_msg_emoji_like",
      group_id: GROUP,
      user_id: 40004,
      message_id: 501,
      likes: [{ emoji_id: "76", count: 1 }],
    });
    await settle();
    expect(events).toEqual([
      {
        type: "reaction.received",
        at: T0,
        scope: "qq:group:300",
        messageId: "501",
        senderId: "40004",
        emoji: "👍",
      },
    ]);
  });
});

describe("QQ platform: duplicate pushes after a reconnect", () => {
  it("the same message pushed twice (or already in the journal) enters her timeline once", async () => {
    const { server, platform, events } = await startQQ();
    const message = groupMessage([{ type: "text", data: { text: "在吗" } }], { message_id: 600 });
    server.push(message);
    server.push(message);
    await settle();
    expect(received(events).map((e) => e.messageId)).toEqual(["600"]);
    // 启动 fold 时已经见过的（已写进 Journal 的）也不再进来。
    platform.observe(
      {
        type: "message.received",
        at: T0,
        scope: "qq:group:300",
        chatType: "group",
        messageId: "601",
        senderId: "40004",
        senderName: "小周",
        text: "旧的",
        contentType: "text",
        replyToMessageId: null,
        directed: false,
      },
      emptyState,
      "fold",
    );
    server.push(groupMessage([{ type: "text", data: { text: "旧的" } }], { message_id: 601 }));
    await settle();
    expect(received(events).map((e) => e.messageId)).toEqual(["600"]);
  });
});

describe("QQ platform: the operator", () => {
  it("with no QQ operator configured, it never messages anyone and skips the selftest", async () => {
    const server = new FakeOneBot();
    const platform = new QQPlatform(
      { name: "qq", wsUrl: "ws://127.0.0.1:3001", token: null, selfId: null },
      {
        gateway: fakeGateway(() => ({})),
        operatorId: null,
        ignoredSenders: new Set(),
        tts: null,
        connect: server.connect,
      },
    );
    await platform.start({
      dispatch: () => {},
      now: () => T0,
      state: () => emptyState,
      pause: { paused: false, onPause: () => {} },
      perceive: {
        image: async () => "图",
        gif: async () => "动图",
        video: async () => "视频",
        voice: async () => "语音",
        sticker: async () => "贴纸",
      },
      signal: new AbortController().signal,
      track: (task) => task,
      connection: () => {},
      warn: () => {},
    });
    await platform.sendToOperator("上线了");
    expect(await platform.selftest()).toBe("未配置 QQ_OPERATOR_ID，跳过 QQ 自检。");
    expect(server.actions()).toEqual([]);
  });
});

describe("QQ platform: what she does", () => {
  const signal = new AbortController().signal;

  it("sends text with a reply segment to the group and returns the new message id", async () => {
    const { server, platform } = await startQQ();
    server.answer("send_group_msg", () => ({ message_id: 777 }));
    const outcome = await platform.act(
      "qq:group:300",
      { kind: "send", text: "嗯", replyTo: "501" },
      signal,
    );
    expect(outcome).toEqual({ kind: "posted", messageId: "777" });
    expect(server.requests.at(-1)).toEqual({
      action: "send_group_msg",
      params: {
        group_id: GROUP,
        message: [
          { type: "reply", data: { id: "501" } },
          { type: "text", data: { text: "嗯" } },
        ],
      },
    });
  });

  it("only a real friend/temp-session refusal is private_closed; 'temporarily unavailable' or 'bandwidth' are not", async () => {
    const { server, platform } = await startQQ();
    // 复读不模拟"正在输入"，所以用它来测私聊发送这条路径。
    server.answer("get_msg", () => ({ message: [{ type: "text", data: { text: "+1" } }] }));
    const send = () => platform.act("qq:private:40004", { kind: "repeat", messageId: "1" }, signal);
    const refuse = (wording: string) =>
      server.answer("send_private_msg", () => ({ fail: { retcode: 100, wording } }));
    refuse("非好友");
    expect(await failureOf(send())).toMatchObject({ reason: "private_closed", dmClosed: true });
    refuse("send private message rejected: result=16 err=发送失败，请先添加对方为好友");
    expect(await failureOf(send())).toMatchObject({ reason: "private_closed", dmClosed: true });
    refuse("temporary session not allowed");
    expect(await failureOf(send())).toMatchObject({ reason: "private_closed", dmClosed: true });
    refuse("service temporarily unavailable");
    expect((await failureOf(send())).reason).toBe("outcome_unknown");
    const leave = (wording: string) => {
      server.answer("set_group_leave", () => ({ fail: { retcode: 200, wording } }));
      return failureOf(platform.act("qq:group:300", { kind: "leave-chat" }, signal));
    };
    expect((await leave("bandwidth exceeded")).reason).toBe("outcome_unknown");
    expect((await leave("bot is banned")).reason).toBe("transport_soft_permanent");
  });

  it("a private chat refused because they are not her friend is private_closed with dmClosed", async () => {
    const { server, platform } = await startQQ();
    server.answer("send_private_msg", () => ({
      fail: { retcode: 100, wording: "对方不是你的好友" },
    }));
    const failure = await failureOf(
      platform.act("qq:private:40004", { kind: "send", text: "嗯", replyTo: null }, signal),
    );
    expect(failure).toMatchObject({ reason: "private_closed", dmClosed: true });
  });

  it("uses group temporary DM for non-friends seen in a group, remembers blocked groups, and short-circuits locally", async () => {
    const { server, platform } = await startQQ({
      prepare: (s) => {
        s.answer("get_friend_list", () => [{ user_id: 50001 }]);
      },
    });
    // 等待后台 get_friend_list 完成。
    await new Promise((r) => setTimeout(r, 20));
    server.answer("get_msg", () => ({ message: [{ type: "text", data: { text: "hi" } }] }));
    server.answer("send_private_msg", () => ({ message_id: 9001 }));

    // 1. 好友直接发私聊（不带 group_id）
    await platform.act("qq:private:50001", { kind: "repeat", messageId: "1" }, signal);
    expect(server.requests.at(-1)).toMatchObject({
      action: "send_private_msg",
      params: { user_id: 50001 },
    });
    expect((server.requests.at(-1)?.params as Record<string, unknown>)?.group_id).toBeUndefined();

    // 2. 非好友但在群 70001 见过：自动带 group_id 尝试群临时私聊
    platform.observe(
      {
        type: "message.received",
        at: 1000,
        scope: "qq:group:70001",
        chatType: "group",
        messageId: "m1",
        senderId: "50002",
        senderName: "群友甲",
        text: "你好",
        contentType: "text",
        replyToMessageId: null,
        directed: false,
      },
      emptyState,
      "live",
    );
    platform.observe(
      {
        type: "message.received",
        at: 1001,
        scope: "qq:group:70001",
        chatType: "group",
        messageId: "m2",
        senderId: "50003",
        senderName: "群友乙",
        text: "你好",
        contentType: "text",
        replyToMessageId: null,
        directed: false,
      },
      emptyState,
      "live",
    );
    server.answer("send_private_msg", () => ({
      fail: {
        retcode: 100,
        wording: "send private message rejected: result=16 err=发送失败，请先添加对方为好友",
      },
    }));
    const firstFail = await failureOf(
      platform.act("qq:private:50002", { kind: "repeat", messageId: "1" }, signal),
    );
    expect(firstFail).toMatchObject({ reason: "private_closed", dmClosed: true });
    expect(server.requests.at(-1)).toMatchObject({
      action: "send_private_msg",
      params: { user_id: 50002, group_id: 70001 },
    });

    // 3. 同一群 70001 已被记为禁止临时私聊：同群另一非好友 50003 直接本地提前拦截，不再发 send_private_msg 请求
    const reqCountBefore = server.requests.length;
    const secondFail = await failureOf(
      platform.act("qq:private:50003", { kind: "repeat", messageId: "1" }, signal),
    );
    expect(secondFail).toMatchObject({ reason: "private_closed", dmClosed: true });
    expect(server.requests.slice(reqCountBefore).some((r) => r.action === "send_private_msg")).toBe(
      false,
    );
  });

  it("reacts with set_msg_emoji_like; an emoji QQ has no face for is invalid_reaction", async () => {
    const { server, platform } = await startQQ();
    await platform.act("qq:group:300", { kind: "react", messageId: "501", emoji: "👍" }, signal);
    expect(server.requests.at(-1)).toEqual({
      action: "set_msg_emoji_like",
      params: { message_id: 501, emoji_id: "76" },
    });
    const failure = await failureOf(
      platform.act("qq:private:40004", { kind: "react", messageId: "1", emoji: "👍" }, signal),
    );
    expect(failure.reason).toBe("invalid_reaction");
  });

  it("leaves a group with set_group_leave, and marks group/private chats read via OneBot", async () => {
    const { server, platform } = await startQQ();
    platform.observe(
      {
        type: "message.received",
        at: T0,
        scope: "qq:group:300",
        chatType: "group",
        messageId: "-123456",
        senderId: "40004",
        senderName: "小明",
        text: "hi",
        contentType: "text",
        replyToMessageId: null,
        directed: false,
      },
      emptyState,
      "live",
    );
    expect(await platform.act("qq:group:300", { kind: "leave-chat" }, signal)).toEqual({
      kind: "done",
    });
    expect(await platform.act("qq:group:300", { kind: "mark-read" }, signal)).toEqual({
      kind: "done",
    });
    expect(await platform.act("qq:private:40004", { kind: "mark-read" }, signal)).toEqual({
      kind: "done",
    });
    expect(server.requests.slice(-3)).toEqual([
      { action: "set_group_leave", params: { group_id: GROUP } },
      { action: "mark_group_msg_as_read", params: { group_id: GROUP, message_id: -123456 } },
      { action: "mark_private_msg_as_read", params: { user_id: 40004 } },
    ]);
  });

  it("mark-read that OneBot does not implement (1404) or whose message is gone still counts as done", async () => {
    const { server, platform } = await startQQ();
    server.answer("mark_group_msg_as_read", () => ({
      fail: { retcode: 1404, wording: "不支持的Api" },
    }));
    expect(await platform.act("qq:group:300", { kind: "mark-read" }, signal)).toEqual({
      kind: "done",
    });
    server.answer("mark_private_msg_as_read", () => ({
      fail: { retcode: 100, wording: "消息不存在" },
    }));
    expect(await platform.act("qq:private:40004", { kind: "mark-read" }, signal)).toEqual({
      kind: "done",
    });
    // 其他拒绝照常算失败。
    server.answer("mark_group_msg_as_read", () => ({ fail: { retcode: 200, wording: "奇怪" } }));
    const failure = await failureOf(platform.act("qq:group:300", { kind: "mark-read" }, signal));
    expect(failure.reason).toBe("outcome_unknown");
  });

  it("repeat never re-sends @, @all, replies, forwards or cards — only text, faces and pictures", async () => {
    const { server, platform } = await startQQ();
    server.answer("get_msg", () => ({
      message: [
        { type: "reply", data: { id: "9" } },
        { type: "at", data: { qq: "all" } },
        { type: "text", data: { text: "开会啦" } },
        { type: "face", data: { id: "76" } },
        { type: "image", data: { file: "a.jpg" } },
        { type: "forward", data: { id: "f" } },
        { type: "json", data: { data: "{}" } },
      ],
    }));
    server.answer("send_group_msg", () => ({ message_id: 2 }));
    await platform.act("qq:group:300", { kind: "repeat", messageId: "501" }, signal);
    expect(server.requests.at(-1)).toEqual({
      action: "send_group_msg",
      params: {
        group_id: GROUP,
        message: [
          { type: "text", data: { text: "开会啦" } },
          { type: "face", data: { id: "76" } },
          { type: "image", data: { file: "a.jpg" } },
        ],
      },
    });
    server.answer("get_msg", () => ({ message: [{ type: "at", data: { qq: "all" } }] }));
    const failure = await failureOf(
      platform.act("qq:group:300", { kind: "repeat", messageId: "502" }, signal),
    );
    expect(failure.reason).toBe("message_gone");
  });

  it("an expired recall (delete_msg refused) is edit_refused, not outcome_unknown", async () => {
    const { server, platform } = await startQQ();
    server.answer("delete_msg", () => ({
      fail: { retcode: 200, wording: "消息撤回超时，超过2分钟" },
    }));
    const failure = await failureOf(
      platform.act("qq:group:300", { kind: "unsend", messageId: "777" }, signal),
    );
    expect(failure.reason).toBe("edit_refused");
  });

  it("what QQ cannot do is unavailable, and nothing is sent", async () => {
    const { server, platform } = await startQQ();
    const acts: Act[] = [
      { kind: "edit", messageId: "1", text: "x" },
      { kind: "chat-search", query: "猫" },
      { kind: "join-chat" },
      { kind: "forward", item: "f1" },
      // 没配语音合成。
      { kind: "voice", text: "喂" },
    ];
    for (const act of acts) {
      expect((await failureOf(platform.act("qq:group:300", act, signal))).reason).toBe(
        "unavailable",
      );
    }
    const query = platform.query(
      "qq:group:300",
      "chat-search",
      { kind: "chat-search", query: "猫" },
      signal,
    );
    expect((await failureOf(query)).reason).toBe("unavailable");
    expect(server.actions()).toEqual([]);
  });

  it("the burst gate stops the 7th message in a minute, counting what the journal says she sent before", async () => {
    const { server, platform } = await startQQ();
    server.answer("get_msg", () => ({ message: [{ type: "text", data: { text: "+1" } }] }));
    server.answer("send_group_msg", () => ({ message_id: 1 }));
    // 重启前她已经在这里发过 2 条（启动 fold 时恢复计数）。
    for (const at of [Date.now() - 1_000, Date.now() - 500]) {
      platform.observe(
        {
          type: "message.sent",
          at,
          scope: "qq:group:300",
          messageId: "x",
          text: "a",
          kind: "text",
        },
        emptyState,
        "fold",
      );
    }
    const repeat: Act = { kind: "repeat", messageId: "501" };
    for (let i = 0; i < 4; i++) await platform.act("qq:group:300", repeat, signal);
    const failure = await failureOf(platform.act("qq:group:300", repeat, signal));
    expect(failure.reason).toBe("outgoing_burst_limited");
    expect(server.actions().filter((a) => a === "send_group_msg")).toHaveLength(4);
  });

  it("a refusal it cannot classify is outcome_unknown and keeps OneBot's code", async () => {
    const { server, platform } = await startQQ();
    server.answer("set_group_leave", () => ({ fail: { retcode: 200, wording: "奇怪的错误" } }));
    const failure = await failureOf(platform.act("qq:group:300", { kind: "leave-chat" }, signal));
    expect(failure).toEqual({ reason: "outcome_unknown", rpc: "200 奇怪的错误" });
  });

  it("before it is connected, an act is unavailable", async () => {
    const platform = new QQPlatform(
      { name: "qq", wsUrl: "ws://127.0.0.1:3001", token: null, selfId: null },
      {
        gateway: fakeGateway(() => ({})),
        operatorId: OPERATOR,
        ignoredSenders: new Set(),
        tts: null,
      },
    );
    const failure = await failureOf(platform.act("qq:group:300", { kind: "mark-read" }, signal));
    expect(failure.reason).toBe("unavailable");
    expect(await platform.selftest()).toBe("还没连上 QQ。");
  });

  it("unsends her own recent message via delete_msg and clears it in timeline on act.done", async () => {
    const { server, platform } = await startQQ();
    expect(
      await platform.act("qq:group:300", { kind: "unsend", messageId: "777" }, signal),
    ).toEqual({ kind: "done" });
    expect(server.requests.at(-1)).toEqual({
      action: "delete_msg",
      params: { message_id: 777 },
    });

    const mechanisms = productionMechanisms(false, platform.capabilities);
    const scope = "qq:group:300";
    const s1 = step(
      emptyState,
      {
        type: "message.received",
        at: T0,
        scope,
        chatType: "group",
        messageId: "501",
        senderId: "40004",
        senderName: "小明",
        text: "hi",
        contentType: "text",
        replyToMessageId: null,
        directed: true,
      },
      mechanisms,
    ).state;
    const s2 = step(
      s1,
      {
        type: "message.sent",
        at: T0 + 1_000,
        scope,
        messageId: "777",
        text: "打错了",
        kind: "text",
      },
      mechanisms,
    ).state;
    const s3 = step(
      s2,
      {
        type: "act.done",
        at: T0 + 2_000,
        scope,
        act: { kind: "unsend", messageId: "777" },
      },
      mechanisms,
    ).state;
    const recalled = s3.chats[scope]?.timeline.find((e) => e.messageId === "777");
    expect(recalled).toMatchObject({ text: null, note: "已撤回" });
  });
});

describe("platform capability declarations", () => {
  it("QQ capabilities hide unsupported acts from speech prompt, settle, and will layer while exposing unsend", () => {
    const qq = new QQPlatform(
      { name: "qq", wsUrl: "ws://127.0.0.1:3001", token: null, selfId: null },
      {
        gateway: fakeGateway(() => ({})),
        operatorId: OPERATOR,
        ignoredSenders: new Set(),
        tts: null,
      },
    );
    const mechanisms = productionMechanisms(false, qq.capabilities);
    const groupChat = {
      ...emptyChat("qq:group:300", "group", true),
      timeline: [
        {
          at: T0,
          messageId: "777",
          sender: null,
          text: "刚发的",
          contentType: "text",
          replyToMessageId: null,
        },
      ],
    };
    const groupReq = speechRequest(
      { ...emptyState, chats: { "qq:group:300": groupChat } },
      groupChat,
      T0 + 5_000,
      null,
      mechanisms,
    );
    expect(groupReq.affordances).toContain("send");
    expect(groupReq.affordances).toContain("react");
    expect(groupReq.affordances).toContain("unsend");
    expect(groupReq.affordances).toContain("sticker");
    expect(groupReq.affordances).toContain("album-search");
    expect(groupReq.affordances).not.toContain("edit");
    expect(groupReq.affordances).not.toContain("voice");
    expect(groupReq.affordances).not.toContain("chat-search");
    expect(groupReq.affordances).not.toContain("forward");

    const dmChat = emptyChat("qq:private:40004", "private", true);
    const dmReq = speechRequest(
      { ...emptyState, chats: { "qq:private:40004": dmChat } },
      dmChat,
      T0 + 5_000,
      null,
      mechanisms,
    );
    expect(dmReq.affordances).toContain("send");
    expect(dmReq.affordances).not.toContain("react");

    // 意愿层也不给平台不支持的动作（如私聊 react、改消息）打分。
    const wake = willWake(affordances, PRODUCTION, undefined, qq.capabilities);
    const fold = worldFold(PRODUCTION);
    const world = fold(emptyWorld, {
      type: "message.received",
      at: T0,
      scope: "qq:private:40004",
      chatType: "private",
      messageId: "901",
      senderId: "40004",
      senderName: "小明",
      text: "在吗",
      contentType: "text",
      replyToMessageId: null,
      directed: true,
    });
    const scored = intentionsFor(
      world,
      wake.affordances,
      "qq:private:40004",
      T0 + 1_000,
      wake.policy,
    ).map((i) => i.affordance);
    expect(scored).toContain("send");
    expect(scored).not.toContain("edit");
    expect(scored).not.toContain("react");
  });
});

describe("QQ platform: memes and the album", () => {
  const signal = new AbortController().signal;
  afterEach(() => closeDb());

  /** 假的模型：看贴纸回一段 JSON（记下调了几次），相册重排把第一张排最前。 */
  function models() {
    const calls = { sticker: 0 };
    const gateway = fakeGateway(({ path }) => {
      if (path === "/rerank") return { results: [{ index: 0 }] };
      calls.sticker++;
      return {
        choices: [
          { message: { content: '{"summary":"猫猫捂嘴偷笑","text":"笑死","emotion":"想笑"}' } },
        ],
      };
    });
    return { gateway, calls };
  }

  const meme = (messageId: number, groupId = GROUP) =>
    groupMessage(
      [
        {
          type: "image",
          data: {
            file: "ABCDEF0123456789ABCDEF0123456789.jpg",
            url: `https://img.example/meme.jpg?rkey=${messageId}`,
            sub_type: 1,
            summary: "[动画表情]",
          },
        },
      ],
      { message_id: messageId, group_id: groupId },
    );

  it("a meme (sub_type 1) is looked at once, cached by its MD5, and lands only in the QQ palette", async () => {
    initDb(":memory:");
    const cache = new StickerCache(":memory:");
    const { gateway, calls } = models();
    const { server, platform, events } = await startQQ({
      gateway,
      sticker: perceiveSticker(gateway, cache),
    });
    server.push(meme(601));
    server.push(meme(602, 301));
    await settle();
    expect(received(events).map((e) => e.contentType)).toEqual(["sticker", "sticker"]);
    const perceived = events.flatMap((e) => (e.type === "message.perceived" ? [e.media] : []));
    expect(perceived).toHaveLength(2);
    expect(perceived[0]).toContain("猫猫捂嘴偷笑");
    // 同一张表情包在两个群里出现：只问一次看图模型。
    expect(calls.sticker).toBe(1);
    expect(cache.has("qq:abcdef0123456789abcdef0123456789")).toBe(true);
    // 收进 QQ 的贴纸库，Telegram 的贴纸库里没有。
    expect(resolveStickerFileId("笑死", "qq")).toBe("https://img.example/meme.jpg?rkey=602");
    expect(resolveStickerFileId("笑死", "telegram")).toBeNull();
    expect(platform.stickers()).toContain("猫猫捂嘴偷笑「笑死」");
    expect(platform.startupInfo()).toMatchObject({ stickers: 1 });
    cache.close();
  });

  it("the sticker act sends the meme back as an image with sub_type 1; a word with no meme fails", async () => {
    initDb(":memory:");
    const cache = new StickerCache(":memory:");
    const { gateway } = models();
    const { server, platform } = await startQQ({
      gateway,
      sticker: perceiveSticker(gateway, cache),
    });
    server.push(meme(601));
    await settle();
    server.answer("send_group_msg", () => ({ message_id: 888 }));
    const outcome = await platform.act("qq:group:300", { kind: "sticker", word: "笑死" }, signal);
    expect(outcome).toEqual({ kind: "posted", messageId: "888" });
    expect(server.requests.find((r) => r.action === "send_group_msg")?.params).toEqual({
      group_id: GROUP,
      message: [
        {
          type: "image",
          data: { file: "https://img.example/meme.jpg?rkey=601", sub_type: 1 },
        },
      ],
    });
    const failure = await failureOf(
      platform.act("qq:group:300", { kind: "sticker", word: "sad" }, signal),
    );
    expect(failure.reason).toBe("invalid_sticker_keyword");
    cache.close();
  });

  it("on connect it looks at favorite memes it has not seen, at most 10, and only once", async () => {
    initDb(":memory:");
    const cache = new StickerCache(":memory:");
    const { gateway, calls } = models();
    const favorites = Array.from(
      { length: 12 },
      (_, i) =>
        `https://p.qpic.cn/qq_expression/1/1_0_0_0_${i.toString(16).padStart(32, "0")}_0_0/0`,
    );
    const { server } = await startQQ({
      gateway,
      sticker: perceiveSticker(gateway, cache),
      prepare: (s) => s.answer("fetch_custom_face", () => favorites),
    });
    await settle();
    expect(server.requests.find((r) => r.action === "fetch_custom_face")?.params).toEqual({
      count: 30,
      return_type: "url",
    });
    expect(calls.sticker).toBe(10);
    expect(resolveStickerFileId("笑死", "qq")).toMatch(/^https:\/\/p\.qpic\.cn\//);
    cache.close();
  });

  it("album: a group photo is found by album-search and re-sent from the original message", async () => {
    const { gateway } = models();
    const { server, platform } = await startQQ({ gateway });
    server.push(
      groupMessage(
        [{ type: "image", data: { file: "cat.jpg", url: "https://img.example/cat.jpg" } }],
        { message_id: 701 },
      ),
    );
    await settle();
    const search: Act = { kind: "album-search", query: "猫" };
    const found = await platform.query("qq:group:300", "album-search", search, signal);
    const hits = found.value as Array<{ asset: string; description: string | null }>;
    expect(hits).toHaveLength(1);
    expect(hits[0]?.description).toBe("图片：看到了 https://img.example/cat.jpg");
    const asset = hits[0]?.asset ?? "";
    expect(found.result).toContain(`[${asset}]`);
    const looked = await platform.act("qq:group:300", search, signal);
    expect(looked.kind).toBe("looked");
    expect(looked.kind === "looked" ? looked.text : "").toContain(`[${asset}]`);

    server.answer("get_msg", (params) =>
      params.message_id === 701
        ? {
            message: [
              { type: "image", data: { file: "cat.jpg", url: "https://img.example/cat2.jpg" } },
            ],
          }
        : { message: [{ type: "text", data: { text: "图被撤回了" } }] },
    );
    server.answer("send_group_msg", () => ({ message_id: 999 }));
    const sent = await platform.act("qq:group:301", { kind: "album-send", asset }, signal);
    expect(sent).toEqual({ kind: "posted", messageId: "999" });
    expect(server.requests.find((r) => r.action === "get_msg")?.params).toEqual({
      message_id: 701,
    });
    expect(server.requests.find((r) => r.action === "send_group_msg")?.params).toEqual({
      group_id: 301,
      message: [{ type: "image", data: { file: "https://img.example/cat2.jpg" } }],
    });

    const missing = await failureOf(
      platform.act("qq:group:300", { kind: "album-send", asset: "p000000" }, signal),
    );
    expect(missing.reason).toBe("invalid_asset");
    server.answer("get_msg", () => ({ message: [{ type: "text", data: { text: "图没了" } }] }));
    const gone = await failureOf(
      platform.act("qq:group:300", { kind: "album-send", asset }, signal),
    );
    expect(gone.reason).toBe("message_gone");
  });

  it("the album only shows QQ photos, even if a Telegram photo reached it", async () => {
    const { gateway } = models();
    const { platform } = await startQQ({ gateway });
    platform.observe(
      {
        type: "message.received",
        at: T0,
        scope: "telegram:-100",
        chatType: "group",
        messageId: "1",
        senderId: "1",
        senderName: "A",
        text: "猫猫",
        contentType: "photo",
        replyToMessageId: null,
        directed: false,
      },
      emptyState,
      "live",
    );
    const found = await platform.query(
      "qq:group:300",
      "album-search",
      { kind: "album-search", query: "猫" },
      signal,
    );
    expect(found.value).toEqual([]);
  });
});
