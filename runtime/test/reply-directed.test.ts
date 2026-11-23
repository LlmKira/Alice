/**
 * 群里回复她发过的一条，就是在找她（directed），和点名一样。
 *
 * 线上 Journal 里群里回复她的消息几乎都是 directed: false：mtcute 不派发本客户端自己发出的消息，同一个群里的回复
 * 又拿不到被回复者，适配器认不出（eval-artifacts/footprint/）。只在一处定：适配器记下回复的是哪一条，
 * 心智按会话里她发过的编号认（step.ts towardHer）。
 */
import type { Dispatcher } from "@mtcute/dispatcher";
import { describe, expect, it } from "vitest";
import { productionMechanisms } from "../src/mechanisms/registry.js";
import type { Effect, SpeechRequest } from "../src/mind/effects.js";
import type { AliceEvent, MessageReceived } from "../src/mind/events.js";
import { type AliceState, emptyState } from "../src/mind/state.js";
import { step, towardHer } from "../src/mind/step.js";
import { bindTelegramWorldAdapter } from "../src/telegram/world-adapter.js";
import { mtcuteFake } from "./mtcute-fake.js";

const G = "telegram:-1009";
// 东八区下午两点：她醒着，不在做事。
const T0 = Date.parse("2026-11-13T06:00:00Z");
const S = 1000;
const mechanisms = productionMechanisms(true);

const heard = (
  at: number,
  id: string,
  who: string,
  replyTo: string | null = null,
): MessageReceived => ({
  type: "message.received",
  at,
  scope: G,
  chatType: "group",
  messageId: id,
  senderId: who,
  senderName: who,
  text: "这个我也想知道",
  contentType: "text",
  replyToMessageId: replyTo,
  directed: false,
});

/**
 * 闭环：按时间顺序送事件；计时到点（不晚于下一个事件）就送 timer.fired，发言调用 5 秒后回"不说话"。
 * 返回 mark 那个事件引起的副作用种类，和它之后的第一次发言请求。
 */
function loop(events: readonly AliceEvent[], mark: AliceEvent) {
  let state: AliceState = emptyState;
  const queue = [...events];
  const later: AliceEvent[] = [];
  let marked: string[] = [];
  let request: SpeechRequest | null = null;
  let seen = false;
  while (queue.length > 0 || later.length > 0) {
    const next = takeNext(queue, later);
    const r = step(state, next, mechanisms);
    state = r.state;
    if (next === mark) {
      seen = true;
      marked = r.effects.map((e) => e.type);
    }
    if (seen && request === null) {
      request = r.effects.find((e) => e.type === "call-speech")?.request ?? null;
    }
    later.push(...echoes(r.effects, next.at));
  }
  return { marked, request };
}

/** 下一个事件：到点的计时器或发言结果不晚于下一个输入事件时先送它。 */
function takeNext(queue: AliceEvent[], later: AliceEvent[]): AliceEvent {
  later.sort((a, b) => a.at - b.at);
  const first = later[0];
  return first && (queue.length === 0 || first.at <= (queue[0] as AliceEvent).at)
    ? (later.shift() as AliceEvent)
    : (queue.shift() as AliceEvent);
}

/** 副作用在闭环里引起的事件：计时器到点送 timer.fired，发言调用 5 秒后回"不说话"。 */
function echoes(effects: readonly Effect[], at: number): AliceEvent[] {
  return effects.flatMap((e): AliceEvent[] => {
    if (e.type === "set-timer")
      return [{ type: "timer.fired", at: e.at, scope: e.scope, timerId: e.timerId }];
    if (e.type === "call-speech") {
      return [
        {
          type: "speech.decided",
          at: at + 5 * S,
          scope: e.scope,
          callId: e.callId,
          decision: { acts: [] },
        },
      ];
    }
    return [];
  });
}

describe("回复她的一条就是在找她（心智）", () => {
  // 热闹的群；她说了一句，别人又聊了 11 条（这段对话走过她了，dwell passed-by），然后有人回复她那一条。
  const chatter = Array.from({ length: 20 }, (_, i) =>
    heard(T0 + i * 20 * S, String(100 + i), `u${i % 4}`),
  );
  const said = T0 + 20 * 20 * S;
  const after = Array.from({ length: 11 }, (_, i) =>
    heard(said + (i + 1) * 15 * S, String(200 + i), `u${i % 4}`),
  );
  const reply = heard(said + 240 * S, "300", "u9", "s1");
  const before: AliceEvent[] = [
    ...chatter,
    {
      type: "message.sent",
      at: said,
      scope: G,
      messageId: "s1",
      kind: "text",
      text: "我觉得是这样",
    },
    ...after,
  ];
  const woke = (types: string[]) => types.some((t) => t === "set-timer" || t === "call-speech");

  it("对照：标着 directed 的同一条叫醒她，提示词里没有'没人点你'", () => {
    const directed: AliceEvent = { ...reply, directed: true };
    const { marked, request } = loop([...before, directed], directed);
    expect(woke(marked)).toBe(true);
    expect(request?.contributions.map((c) => c.mechanism)).not.toContain("pressure-unsought");
  });

  it("没标 directed、回复的是她发过的那条：一样叫醒她，提示词里没有'没人点你'", () => {
    const { marked, request } = loop([...before, reply], reply);
    expect(woke(marked)).toBe(true);
    expect(request).not.toBeNull();
    expect(request?.contributions.map((c) => c.mechanism)).not.toContain("pressure-unsought");
  });

  it("回复的是别人的话：不算找她", () => {
    const other = heard(said + 240 * S, "300", "u9", "205");
    const { marked } = loop([...before, other], other);
    expect(woke(marked)).toBe(false);
  });
});

describe("回复她的一条就是在找她（入站适配只记事实，心智来定）", () => {
  function bind() {
    const events: AliceEvent[] = [];
    const dispatcher = mtcuteFake<Dispatcher>({
      onNewMessage: () => {},
      onRawUpdate: () => {},
      onChatMemberUpdate: () => {},
    });
    const { receive } = bindTelegramWorldAdapter(dispatcher, {
      selfId: "42",
      now: () => 1000,
      onEvent: (e) => void events.push(e),
      admit: () => true,
      newGroup: () => false,
    });
    return { events, receive };
  }
  // 同一个群里的回复：mtcute 拿不到被回复者（sender 是 null）。
  const replyTo = (id: number, to: number) =>
    ({
      id,
      chat: { id: -100, chatType: "supergroup", title: "群" },
      sender: { id: 9, displayName: "阿杰" },
      text: "真的吗",
      entities: [],
      media: null,
      action: null,
      replyToMessage: { id: to, sender: null },
    }) as never;

  it("适配器记下回复的是哪一条；回复她发过的那条，心智算找她，回复别人的不算", () => {
    const { events, receive } = bind();
    receive(replyTo(12, 11), {} as never);
    receive(replyTo(13, 10), {} as never);
    expect(events.map((e) => e.type === "message.received" && e.replyToMessageId)).toEqual([
      "11",
      "10",
    ]);
    // 她的心智：群里先有人说话，她回了一句（编号 11）。
    const before: AliceEvent[] = [
      { ...heard(400, "5", "u1"), scope: "telegram:-100" },
      {
        type: "message.sent",
        at: 500,
        scope: "telegram:-100",
        messageId: "11",
        kind: "text",
        text: "好呀",
      },
    ];
    const mind = before.reduce((s, e) => step(s, e, []).state, emptyState);
    expect(events.map((e) => (towardHer(mind, e) as MessageReceived).directed)).toEqual([
      true,
      false,
    ]);
  });
});
