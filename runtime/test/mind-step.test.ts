import { describe, expect, it } from "vitest";
import type { AliceEvent, MessageReceived, SpeechDecision } from "../src/mind/events.js";
import type { Mechanism } from "../src/mind/mechanism.js";
import { type AliceState, emptyState } from "../src/mind/state.js";
import { step } from "../src/mind/step.js";
import { directedWake } from "./directed-wake.js";

const T0 = 1_771_000_000_000;
/** 只测核心转换：立刻开口（patience 另有测试）。 */
const mechanisms = [directedWake];

function message(overrides: Partial<MessageReceived> = {}): MessageReceived {
  return {
    type: "message.received",
    at: T0,
    scope: "telegram:1",
    chatType: "private",
    messageId: "1",
    senderId: "u1",
    senderName: "池塘",
    text: "在吗",
    contentType: "text",
    replyToMessageId: null,
    directed: true,
    ...overrides,
  };
}

function decision(reply: string[], replyTo: string | null = null): SpeechDecision {
  return {
    acts: reply.map((text, i) => ({ kind: "send", text, replyTo: i === 0 ? replyTo : null })),
  };
}

function run(events: AliceEvent[], state: AliceState = emptyState) {
  const effects = [];
  for (const event of events) {
    const result = step(state, event, mechanisms);
    state = result.state;
    effects.push(...result.effects);
  }
  return { state, effects };
}

describe("step", () => {
  it("wakes on a directed message and asks the speech layer once", () => {
    const { state, effects } = run([message()]);
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({
      type: "call-speech",
      scope: "telegram:1",
      callId: "telegram:1#1",
    });
    expect(state.chats["telegram:1"]?.mind).toMatchObject({ mode: "deciding" });
  });

  it("only listens to undirected group messages", () => {
    const { effects, state } = run([
      message({ scope: "telegram:-9", chatType: "group", directed: false }),
    ]);
    expect(effects).toEqual([]);
    expect(state.chats["telegram:-9"]?.timeline).toHaveLength(1);
  });

  it("turns a decision into sends and goes idle", () => {
    const { effects, state } = run([
      message(),
      {
        type: "speech.decided",
        at: T0 + 1000,
        scope: "telegram:1",
        callId: "telegram:1#1",
        decision: decision(["在呀", "怎么啦"], "1"),
      },
    ]);
    expect(effects.slice(1)).toEqual([
      { type: "act", scope: "telegram:1", act: { kind: "send", text: "在呀", replyTo: "1" } },
      { type: "act", scope: "telegram:1", act: { kind: "send", text: "怎么啦", replyTo: null } },
    ]);
    expect(state.chats["telegram:1"]?.mind).toEqual({ mode: "idle" });
  });

  it("stays silent on an empty reply", () => {
    const { effects } = run([
      message(),
      {
        type: "speech.decided",
        at: T0 + 1,
        scope: "telegram:1",
        callId: "telegram:1#1",
        decision: decision([]),
      },
    ]);
    expect(effects.filter((e) => e.type !== "call-speech")).toEqual([]);
  });

  it("ignores a stale decision", () => {
    const { effects } = run([
      message(),
      {
        type: "speech.decided",
        at: T0 + 1,
        scope: "telegram:1",
        callId: "telegram:1#7",
        decision: decision(["hi"]),
      },
    ]);
    expect(effects).toHaveLength(1);
  });

  it("remembers a wake that arrives while deciding and asks again afterwards", () => {
    const { effects } = run([
      message(),
      message({ messageId: "2", at: T0 + 500, text: "人呢" }),
      {
        type: "speech.decided",
        at: T0 + 1000,
        scope: "telegram:1",
        callId: "telegram:1#1",
        decision: decision(["在"]),
      },
    ]);
    expect(effects.map((e) => e.type)).toEqual(["call-speech", "act", "call-speech"]);
    const second = effects[2];
    expect(
      second?.type === "call-speech" && second.request.timeline.map((t) => t.messageId),
    ).toEqual(["1", "2"]);
  });

  it("goes idle on a failed call without retrying", () => {
    const { effects, state } = run([
      message(),
      {
        type: "speech.failed",
        at: T0 + 1,
        scope: "telegram:1",
        callId: "telegram:1#1",
        reason: "model",
        error: "502",
      },
    ]);
    expect(effects).toHaveLength(1);
    expect(state.chats["telegram:1"]?.mind).toEqual({ mode: "idle" });
  });

  it("records her own delivered messages in the timeline", () => {
    const { state } = run([
      message(),
      {
        type: "message.sent",
        at: T0 + 2,
        scope: "telegram:1",
        messageId: "9",
        text: "在呀",
        kind: "text",
      },
    ]);
    expect(state.chats["telegram:1"]?.timeline.at(-1)).toMatchObject({
      sender: null,
      text: "在呀",
    });
  });

  it("tells the speech layer what she can do here: leaving only in groups", () => {
    const dm = run([message()]).effects[0];
    const group = run([message({ scope: "telegram:-9", chatType: "group" })]).effects[0];
    expect(dm?.type === "call-speech" && dm.request.affordances).toEqual([
      "send",
      "sticker",
      "react",
      "mark-read",
      "album-search",
    ]);
    expect(group?.type === "call-speech" && group.request.affordances).toContain("leave-chat");
  });

  it("leaves a group only once it is done, and does not start another call on the way out", () => {
    const scope = "telegram:-9";
    const leave = { kind: "leave-chat" as const };
    const { state, effects } = run([
      message({ scope, chatType: "group" }),
      message({ scope, chatType: "group", messageId: "2", at: T0 + 10 }),
      {
        type: "speech.decided",
        at: T0 + 100,
        scope,
        callId: `${scope}#1`,
        decision: { acts: [{ kind: "send", text: "走了", replyTo: null }, leave] },
      },
    ]);
    expect(effects.map((e) => e.type)).toEqual(["call-speech", "act", "act"]);
    expect(state.chats[scope]?.member).toBe(true);
    const after = run([{ type: "act.done", at: T0 + 200, scope, act: leave }], state).state;
    expect(after.chats[scope]?.member).toBe(false);
    // 有人又把她拉回来、她又收到消息：她在里面。
    const back = run([message({ scope, chatType: "group", messageId: "3", at: T0 + 300 })], after);
    expect(back.state.chats[scope]?.member).toBe(true);
  });
});

describe("step: a glance that scans her chats (Mechanism.scans)", () => {
  // 一分钟以后她才有空看：之前找她的消息叫不醒她；从那一刻起的 15 秒里她扫一眼各个会话。
  const FREE = T0 + 60_000;
  const busyThenScan: Mechanism = {
    name: "busy-then-scan",
    wake: (_chat, event, now) =>
      event.type === "message.received" && event.directed && now >= FREE ? 1 : 0,
    scans: (now) => now >= FREE && now < FREE + 15_000,
  };
  const go = (events: AliceEvent[]) => {
    let state = emptyState;
    const effects = [];
    for (const event of events) {
      const r = step(state, event, [busyThenScan]);
      state = r.state;
      effects.push(...r.effects);
    }
    return effects;
  };
  const pending = [
    message({ scope: "telegram:1", messageId: "a" }),
    message({ scope: "telegram:2", messageId: "b", at: T0 + 1 }),
    message({ scope: "telegram:-9", chatType: "group", messageId: "c", directed: false }),
  ];

  it("asks every chat with something new again at the glance, and answers several with their newest message as the trigger", () => {
    const effects = go([...pending, { type: "clock.tick", at: FREE + 5_000 }]);
    const calls = effects.flatMap((e) => (e.type === "call-speech" ? [e] : []));
    expect(calls.map((c) => [c.scope, c.request.triggerMessageId])).toEqual([
      ["telegram:1", "a"],
      ["telegram:2", "b"],
    ]);
  });

  it("re-asks the newest message aimed at her when newer chatter has buried it, as a phone badges mentions", () => {
    const group = { scope: "telegram:-9", chatType: "group" as const };
    const effects = go([
      message({ ...group, messageId: "old", directed: true, at: T0 }),
      message({ ...group, messageId: "named", directed: true, at: T0 + 1 }),
      message({ ...group, messageId: "chatter", directed: false, at: T0 + 2 }),
      { type: "clock.tick", at: FREE + 5_000 },
    ]);
    expect(
      effects.flatMap((e) => (e.type === "call-speech" ? [e.request.triggerMessageId] : [])),
    ).toEqual(["named"]);
  });

  it("does nothing on a tick outside the glance, or where her own message is the newest", () => {
    expect(go([...pending, { type: "clock.tick", at: T0 + 20_000 }])).toEqual([]);
    const replied: AliceEvent = {
      type: "message.sent",
      at: T0 + 2,
      scope: "telegram:1",
      messageId: "s1",
      text: "在",
      kind: "text",
    };
    const effects = go([...pending, replied, { type: "clock.tick", at: FREE + 5_000 }]);
    expect(effects.flatMap((e) => (e.type === "call-speech" ? [e.scope] : []))).toEqual([
      "telegram:2",
    ]);
  });
});
