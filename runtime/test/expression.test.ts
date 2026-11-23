/**
 * 表达的方式（capabilities A16 发语音、A13 改自己的消息、A17 正在输入、A27 跟着复读、A28 提醒）：
 * 只在用得上时出现、只作用于做决定的会话、不改别人的话、失败是 typed 的、到点会想起答应的提醒。
 */
import type { TelegramClient } from "@mtcute/node";
import { tl } from "@mtcute/node";
import { describe, expect, it } from "vitest";
import { Album } from "../src/album.js";
import { pressureProduction } from "../src/mechanisms/pressure/index.js";
import { makeCommitment } from "../src/mechanisms/pressure/memory.js";
import { expression, voice } from "../src/mechanisms/voice.js";
import {
  type Act,
  availableKinds,
  EDIT_WINDOW_MS,
  postedMessage,
} from "../src/mind/affordances.js";
import { explainInvalidArgs } from "../src/mind/args.js";
import { chatView } from "../src/mind/chat-view.js";
import type { AliceEvent, MessageReceived } from "../src/mind/events.js";
import { settleDecision } from "../src/mind/settle.js";
import { type ChatState, emptyChat, emptyState, type TimelineEntry } from "../src/mind/state.js";
import { speechRequest, step } from "../src/mind/step.js";
import { parseWhen } from "../src/mind/when.js";
import { replay } from "../src/sim/replay.js";
import { codeMode } from "../src/speech/decision.js";
import { renderSpeechPrompt } from "../src/speech/prompt.js";
import { type ActContext, executeAct } from "../src/telegram/acts.js";
import { TelegramActionError } from "../src/telegram/errors.js";
import { Gates, Telegram } from "../src/telegram/gates.js";
import { Shelf } from "../src/telegram/shelf.js";
import { typingMs } from "../src/utils/typing.js";
import { program } from "./model-reply.js";
import { mtcuteFake } from "./mtcute-fake.js";

const MIN = 60_000;
const H = 60 * MIN;
/** 2026-11-10 周二 15:00（东八区）。 */
const T = Date.UTC(2026, 10, 10, 7, 0);
const local = (day: number, hour: number, minute = 0) => Date.UTC(2026, 10, day, hour - 8, minute);

const DM = "telegram:1";
const GROUP = "telegram:-5";

const line = (
  messageId: string,
  at: number,
  from: string | null,
  text: string | null,
  contentType = "text",
): TimelineEntry => ({
  at,
  messageId,
  sender: from === null ? null : { id: from, name: from },
  text,
  contentType,
  replyToMessageId: null,
});

function chat(scope: string, timeline: TimelineEntry[]): ChatState {
  return {
    ...emptyChat(scope, scope.startsWith("telegram:-") ? "group" : "private", true),
    timeline,
  };
}

const offered = (c: ChatState, at: number, provided: string[] = ["edit", "repeat"]) =>
  availableKinds(chatView(c), at, new Set(provided as never[]));

describe("voice (A16): only when synthesis is provided, in private chats or groups that use voice", () => {
  const dm = chat(DM, [line("1", T, "u1", "想听你的声音")]);
  const quietGroup = chat(GROUP, [line("1", T, "u1", "早"), line("2", T, "u2", "早啊")]);
  const voiceGroup = chat(GROUP, [line("1", T, "u1", null, "voice"), line("2", T, "u2", "哈哈")]);

  it("is offered only when a mechanism provides it, in private chats and groups alike", () => {
    expect(offered(dm, T)).not.toContain("voice");
    expect(offered(dm, T, ["voice"])).toContain("voice");
    // 群里没人发过语音也能发：跟不跟群里的习惯由她定（研究员 2026-11-12）。
    expect(offered(quietGroup, T, ["voice"])).toContain("voice");
    expect(offered(voiceGroup, T, ["voice"])).toContain("voice");
    const request = speechRequest({ ...emptyState, chats: { [DM]: dm } }, dm, T, "1", [voice]);
    expect(request.affordances).toContain("voice");
  });

  it("counts toward the send cap like any message of hers", () => {
    const acts: Act[] = Array.from({ length: 7 }, (_, i) =>
      i % 2 === 0
        ? { kind: "voice", text: String(i) }
        : { kind: "send", text: String(i), replyTo: null },
    );
    expect(settleDecision(dm, { acts }, T).acts).toHaveLength(6);
  });

  it("reads tools.voice from her program and keeps what she said in her own timeline", () => {
    const request = speechRequest({ ...emptyState, chats: { [DM]: dm } }, dm, T, "1", [voice]);
    const rules = renderSpeechPrompt("persona", request).system;
    expect(rules).toContain("  voice: {");
    const { decision } = codeMode.parse(
      program(
        'await tools.voice({ text: "哼，才不是特意给你发的呢" });\nawait tools.say({ text: "好啦" });',
      ),
      request,
    );
    expect(decision.acts).toEqual([
      { kind: "voice", text: "哼，才不是特意给你发的呢" },
      { kind: "send", text: "好啦", replyTo: null },
    ]);
    const posted = postedMessage({ kind: "voice", text: "晚安" });
    expect(posted).toEqual({ text: "晚安", kind: "voice" });
    const state = step({ ...emptyState, chats: { [DM]: dm } }, sentEvent("s1", T, posted), []);
    const mine = state.state.chats[DM]?.timeline.at(-1);
    expect(mine).toMatchObject({ sender: null, text: "晚安", contentType: "voice" });
  });
});

function sentEvent(
  messageId: string,
  at: number,
  posted: ReturnType<typeof postedMessage>,
  scope = DM,
): AliceEvent {
  if (!posted) throw new Error("not a posted act");
  return { type: "message.sent", at, scope, messageId, ...posted };
}

describe("edit (A13): only her own text, only within the window", () => {
  const timeline = [
    line("1", T - EDIT_WINDOW_MS - MIN, null, "两天多以前说的"),
    line("2", T - 2 * MIN, "u1", "你说啥"),
    line("3", T - MIN, null, "我明天早上去图书管"),
    line("4", T - 30_000, null, null, "voice"),
  ];
  const dm = chat(DM, timeline);
  const edit = (messageId: string): Act => ({
    kind: "edit",
    messageId,
    text: "我明天早上去图书馆",
  });

  it("is offered only while she has a text message of her own within Telegram's edit window", () => {
    expect(offered(dm, T)).toContain("edit");
    expect(offered(dm, T, [])).not.toContain("edit");
    expect(offered(dm, T + EDIT_WINDOW_MS)).not.toContain("edit");
    expect(offered(chat(DM, [line("2", T, "u1", "在吗")]), T)).not.toContain("edit");
  });

  it("never edits someone else's message, an old one of hers, or a voice message", () => {
    expect(settleDecision(dm, { acts: [edit("3")] }, T).acts).toEqual([edit("3")]);
    for (const id of ["1", "2", "4", "99"]) {
      expect(settleDecision(dm, { acts: [edit(id)] }, T).acts).toEqual([]);
    }
  });

  it("after it is done her line reads the new words, marked as edited; not a second message", () => {
    expect(postedMessage(edit("3"))).toBeNull();
    const state = { ...emptyState, chats: { [DM]: dm } };
    const after = step(state, { type: "act.done", at: T, scope: DM, act: edit("3") }, []);
    const lines = after.state.chats[DM]?.timeline ?? [];
    expect(lines).toHaveLength(timeline.length);
    expect(lines.find((l) => l.messageId === "3")).toMatchObject({
      text: "我明天早上去图书馆",
      note: "改过",
    });
  });

  it("reads tools.edit from her program", () => {
    const request = speechRequest({ ...emptyState, chats: { [DM]: dm } }, dm, T, "2", [expression]);
    expect(renderSpeechPrompt("persona", request).system).toContain("  edit: {");
    const { decision } = codeMode.parse(
      program('await tools.edit({ messageId: "3", text: "我明天早上去图书馆" });'),
      request,
    );
    expect(decision.acts).toEqual([edit("3")]);
  });
});

describe("unsend: only her own messages from the last two minutes", () => {
  const timeline = [
    line("1", T - 5 * MIN, null, "五分钟前说的"),
    line("2", T - 30_000, "u1", "你说啥"),
    line("3", T - 10_000, null, "十秒前说的"),
  ];
  const dm = chat(DM, timeline);
  const unsend = (messageId: string): Act => ({ kind: "unsend", messageId });

  it("rejects a message older than two minutes even when another one was sent ten seconds ago", () => {
    expect(settleDecision(dm, { acts: [unsend("3")] }, T).acts).toEqual([unsend("3")]);
    for (const id of ["1", "2", "99"]) {
      expect(settleDecision(dm, { acts: [unsend(id)] }, T).acts).toEqual([]);
    }
    expect(explainInvalidArgs("unsend", { messageId: "1" }, { timeline, now: T })).toContain(
      "last 2 minutes",
    );
  });
});

describe("repeat (A27): appears only while different people echo the same line", () => {
  const echoing = chat(GROUP, [
    line("1", T, "u1", "今天谁请奶茶"),
    line("2", T, "u2", "v我50"),
    line("3", T, "u3", "v我50"),
  ]);

  it("needs two different people sending the same text in a row, in a group", () => {
    expect(offered(echoing, T)).toContain("repeat");
    const oneSender = chat(GROUP, [line("2", T, "u2", "v我50"), line("3", T, "u2", "v我50")]);
    expect(offered(oneSender, T)).not.toContain("repeat");
    const broken = chat(GROUP, [...echoing.timeline, line("4", T, "u4", "哈哈")]);
    expect(offered(broken, T)).not.toContain("repeat");
    const joined = chat(GROUP, [...echoing.timeline, line("5", T, null, "v我50")]);
    expect(offered(joined, T)).not.toContain("repeat");
    const dm = chat(DM, [line("2", T, "u2", "v我50"), line("3", T, "u3", "v我50")]);
    expect(offered(dm, T)).not.toContain("repeat");
  });

  it("posts the original words as her own line", () => {
    const find = (id: string) => echoing.timeline.find((t) => t.messageId === id);
    expect(postedMessage({ kind: "repeat", messageId: "3" }, find)).toEqual({
      text: "v我50",
      kind: "text",
    });
    const request = speechRequest(
      { ...emptyState, chats: { [GROUP]: echoing } },
      echoing,
      T,
      null,
      [expression],
    );
    const { decision } = codeMode.parse(
      program('await tools.repeat({ messageId: "3" });'),
      request,
    );
    expect(decision.acts).toEqual([{ kind: "repeat", messageId: "3" }]);
  });
});

/** 只记录调用的假 Telegram 客户端。 */
function fakeClient(fail: Partial<Record<string, Error>> = {}) {
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
    editMessage: method("editMessage"),
    forwardMessagesById: method("forwardMessagesById", [{ id: 43 }]),
    setTyping: method("setTyping"),
    readHistory: method("readHistory"),
    readReactions: method("readReactions"),
  });
  return { client, calls };
}

const ctx = (client: TelegramClient, extra: Partial<ActContext> = {}): ActContext => ({
  telegram: new Telegram(client, new Gates()),
  target: { chatId: -100123 },
  scope: "telegram:-100123",
  shelf: new Shelf(),
  stickerFileId: () => null,
  album: new Album(async () => []),
  now: () => 0,
  speak: async () => {
    throw new Error("tts: 503");
  },
  pause: async () => {},
  ...extra,
});

describe("executing them on Telegram", () => {
  it("voice: shows recording, sends the synthesized ogg, fails typed when synthesis is missing or fails", async () => {
    const { client, calls } = fakeClient();
    const speak = async () => ({ ogg: new Uint8Array([1, 2, 3]), seconds: 2.4 });
    await expect(
      executeAct(ctx(client, { speak }), { kind: "voice", text: "嗯" }),
    ).resolves.toEqual({ kind: "posted", messageId: "42" });
    expect(calls.find(([n]) => n === "setTyping")?.[1]).toEqual([
      { peerId: -100123, status: "record_voice" },
    ]);
    const media = calls.find(([n]) => n === "sendMedia")?.[1]?.[1] as Record<string, unknown>;
    expect(media).toMatchObject({ type: "voice", duration: 2 });

    const broken = fakeClient();
    const failing = async () => {
      throw new Error("tts: 503");
    };
    await expect(
      executeAct(ctx(broken.client, { speak: failing }), { kind: "voice", text: "嗯" }),
    ).rejects.toMatchObject({ code: "voice_failed" });
    expect(broken.calls.map(([n]) => n)).not.toContain("sendMedia");
    expect(broken.calls.at(-1)).toEqual(["setTyping", [{ peerId: -100123, status: "cancel" }]]);
  });

  it("edit: edits in the same chat; unchanged text is fine; Telegram's refusal is typed", async () => {
    const { client, calls } = fakeClient();
    const act: Act = { kind: "edit", messageId: "9", text: "图书馆" };
    await expect(executeAct(ctx(client), act)).resolves.toEqual({ kind: "done" });
    expect(calls).toEqual([["editMessage", [{ chatId: -100123, message: 9, text: "图书馆" }]]]);
    const same = fakeClient({ editMessage: new tl.RpcError(400, "MESSAGE_NOT_MODIFIED") });
    await expect(executeAct(ctx(same.client), act)).resolves.toEqual({ kind: "done" });
    const refused = fakeClient({ editMessage: new tl.RpcError(403, "MESSAGE_AUTHOR_REQUIRED") });
    await expect(executeAct(ctx(refused.client), act)).rejects.toMatchObject({
      code: "edit_refused",
    });
  });

  it("repeat: copies that message into the same chat without the original author", async () => {
    const { client, calls } = fakeClient();
    await expect(executeAct(ctx(client), { kind: "repeat", messageId: "3" })).resolves.toEqual({
      kind: "posted",
      messageId: "43",
    });
    expect(calls).toEqual([
      [
        "forwardMessagesById",
        [{ fromChatId: -100123, messages: [3], toChatId: -100123, noAuthor: true }],
      ],
    ]);
  });

  it("typing (A17): shows typing for as long as the words take, then sends", async () => {
    const { client, calls } = fakeClient();
    const waited: number[] = [];
    const pause = async (ms: number) => {
      waited.push(ms);
    };
    await executeAct(ctx(client, { pause }), { kind: "send", text: "好的好的", replyTo: null });
    expect(calls.map(([n]) => n)).toEqual([
      "readHistory",
      "readReactions",
      "setTyping",
      "sendText",
    ]);
    expect(waited).toHaveLength(1);
    expect(waited[0]).toBeGreaterThanOrEqual(1_000);
    expect(waited[0]).toBeLessThanOrEqual(15_000);

    const failed = fakeClient({ sendText: new tl.RpcError(403, "CHAT_WRITE_FORBIDDEN") });
    await expect(
      executeAct(ctx(failed.client, { pause }), { kind: "send", text: "好", replyTo: null }),
    ).rejects.toBeInstanceOf(TelegramActionError);
    expect(failed.calls.at(-1)).toEqual(["setTyping", [{ peerId: -100123, status: "cancel" }]]);
  });

  it("typing time matches measured live human median (~740ms/CJK) with wide dispersion within 1–15 seconds", () => {
    expect(typingMs("嗯", 1)).toBe(1_000);
    expect(typingMs("我明天早上去图书馆", 1)).toBe(6_667);
    expect(typingMs("ok see you", 1)).toBe(2_000);
    expect(typingMs("很长".repeat(40), 1)).toBe(15_000);
    const varied = typingMs("我明天早上去图书馆");
    expect(varied).toBeGreaterThanOrEqual(3_600);
    expect(varied).toBeLessThanOrEqual(10_400);
  });
});

describe("reminders (A28): a promise to remind someone at a time wakes her near that time", () => {
  it("reads a bare clock or period as the next one coming", () => {
    // 15:00 说"8点"：今晚 20:00；"下午3点半"：今天 15:30；"晚上"：今晚；"9点"在 21:30 说：明早 9:00。
    expect(parseWhen("8点", T)?.due).toBe(local(10, 20));
    expect(parseWhen("下午3点半", T)?.due).toBe(local(10, 15, 30));
    expect(parseWhen("20:30", T)?.due).toBe(local(10, 20, 30));
    expect(parseWhen("晚上", T)).toEqual({ from: local(10, 19), due: local(10, 23) });
    expect(parseWhen("9点", local(10, 21, 30))?.due).toBe(local(11, 9));
    expect(parseWhen("早上7点", local(10, 21, 30))?.due).toBe(local(11, 7));
    for (const words of ["晚饭后", "三个人", "早点睡"]) expect(parseWhen(words, T)).toBeNull();
  });

  it("keeps the exact time she said instead of pushing a near one half an hour later", () => {
    const soon = makeCommitment({ when: "10分钟后", what: "提醒他关火" }, T);
    expect(soon.due).toBe(T + 10 * MIN);
    expect(soon.precise).toBe(true);
    const evening = makeCommitment({ when: "8点", what: "叫他看直播" }, T);
    expect(evening.due).toBe(local(10, 20));
    expect(evening.precise).toBe(true);
  });

  /** 私聊里对方让她提醒；她答应、记下（或不记）；之后谁也不说话，她每次醒来都决定先不说。 */
  async function remind(when: string | null, after: number) {
    const ask: MessageReceived = {
      type: "message.received",
      at: T,
      scope: DM,
      chatType: "private",
      messageId: "m1",
      senderId: "u1",
      senderName: "池塘",
      text: `${when}提醒我一下`,
      contentType: "text",
      replyToMessageId: null,
      directed: true,
    };
    const end: MessageReceived = { ...ask, at: T + after, scope: "telegram:9", messageId: "z" };
    const promise: Act[] = when ? [{ kind: "intend", when, what: "提醒他" }] : [];
    const { effects } = await replay([ask, end], {
      mechanisms: [pressureProduction],
      tickMs: MIN,
      speech: (request) =>
        request.triggerMessageId
          ? { acts: [{ kind: "send", text: "好", replyTo: null }, ...promise] }
          : { acts: [] },
    });
    return effects
      .filter((e) => e.effect.type === "call-speech" && e.effect.scope === DM)
      .map((e) => e.at);
  }
  const between = (calls: number[], from: number, to: number) =>
    calls.filter((at) => at >= from && at < to);

  it("ten minutes later: woken at that minute, once, and not before; the control is not", async () => {
    const calls = await remind("10分钟后", 2 * H);
    expect(between(calls, T + MIN, T + 10 * MIN)).toEqual([]);
    expect(between(calls, T + 10 * MIN, T + 20 * MIN)).toHaveLength(1);
    expect(between(calls, T + 10 * MIN, T + 11 * MIN)).toHaveLength(1);
    expect(between(await remind(null, 2 * H), T + MIN, T + 20 * MIN)).toEqual([]);
  });
});
