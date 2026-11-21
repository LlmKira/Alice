/**
 * 候选 follow（她看着这段对话，mechanisms/pressure/turn.ts）坏掉了会很糟的几条：
 * - 她没看过的群、她已经不在的群，别人没点她名的话不因为它叫醒她；
 * - 看着的时候别人的话叫醒她，提示词里她是旁观者（"没人找你"），在对话里（dwell）时不是；
 * - 从开始看起别人又说了 K 条、或对话冷下来，就不再叫醒她——热闹的群不会一直叫；
 * - 睡着时看着的群也叫不醒她（看一眼不收对别人的代价，但她自己的状态照算）；
 * - 状态只从事件折叠出来（折叠两遍相同）。
 */
import { describe, expect, it } from "vitest";
import {
  createPressure,
  dwell,
  follow,
  PRODUCTION,
  willWake,
} from "../src/mechanisms/pressure/index.js";
import { GROUP_ABSENCE_ROUNDS } from "../src/mechanisms/pressure/params.js";
import type { World } from "../src/mechanisms/pressure/world.js";
import { affordances } from "../src/mind/affordances.js";
import type { SpeechRequest } from "../src/mind/effects.js";
import type { AliceEvent, MessageReceived, SpeechDecision } from "../src/mind/events.js";
import { replay } from "../src/sim/replay.js";

/** 当地（UTC+8，mind/when.ts）下午两点多：她醒着。 */
const T0 = 1_771_000_000_000 - 10 * 3_600_000;
const S = 1000;
const M = 60 * S;
const H = 60 * M;
const G = "telegram:-7";

const composition = {
  ...PRODUCTION,
  floor: dwell({ passBy: true, rejection: true, share: true }),
  follow: follow(),
};
const pressure = createPressure(affordances, composition);
const lens = willWake(affordances, composition);

let n = 0;
function msg(at: number, o: Partial<MessageReceived> = {}): MessageReceived {
  n++;
  return {
    type: "message.received",
    at,
    scope: G,
    chatType: "group",
    messageId: `f${n}`,
    senderId: `contact:${(n % 3) + 1}`,
    senderName: "群友",
    text: "今天吃什么",
    contentType: "text",
    replyToMessageId: null,
    directed: false,
    ...o,
  };
}

/** 她在群里看过、决定不说。 */
const looked = (at: number): AliceEvent => ({
  type: "speech.decided",
  at,
  scope: G,
  callId: `${G}#look${at}`,
  decision: { acts: [] },
});

function fold(events: readonly AliceEvent[]): World {
  const reduce = pressure.reduce as (w: World, e: AliceEvent) => World;
  return events.reduce(reduce, pressure.initial as World);
}

/** 折叠到最后一条之前，问最后一条（别人的话）叫不叫醒她、为什么。 */
function wakeOn(events: readonly AliceEvent[]) {
  const last = events.at(-1) as MessageReceived;
  const world = fold(events);
  return lens.why(G, last, last.at, world);
}

const chatter = (from: number, count: number, every = 20 * S): MessageReceived[] =>
  Array.from({ length: count }, (_, i) => msg(from + (i + 1) * every));

describe("follow: what wakes her", () => {
  it("a group she has not looked at is not woken by plain messages", () => {
    expect(wakeOn([msg(T0), ...chatter(T0, 3)])).toBeNull();
  });

  it("after a look, the next plain message wakes her as a bystander", () => {
    const r = wakeOn([msg(T0), looked(T0 + 10 * S), msg(T0 + 30 * S)]);
    expect(r?.kind).toBe("follow");
    expect(r && "score" in r ? r.score : 0).toBeGreaterThan(0.5);
  });

  it("K messages after the look, plain messages no longer wake her", () => {
    const events = [
      msg(T0),
      looked(T0 + 10 * S),
      ...chatter(T0 + 10 * S, GROUP_ABSENCE_ROUNDS + 2),
    ];
    expect(fold(events).chats[G]?.turn.watch.ended?.why).toBe("passed-by");
    expect(wakeOn(events)).toBeNull();
  });

  it("a silence longer than the group's own rhythm ends it", () => {
    const events = [msg(T0), looked(T0 + 10 * S), msg(T0 + 20 * S), msg(T0 + 6 * H)];
    expect(fold(events).chats[G]?.turn.watch.ended?.why).toBe("cooled");
    expect(wakeOn(events)).toBeNull();
  });

  it("a group she has left does not wake her", () => {
    const left: AliceEvent = {
      type: "act.done",
      at: T0 + 15 * S,
      scope: G,
      act: { kind: "leave-chat" },
    };
    expect(wakeOn([msg(T0), looked(T0 + 10 * S), left, msg(T0 + 30 * S)])).toBeNull();
  });

  it("asleep, a group she was watching does not wake her", () => {
    // 当地夜里三点：看过之后有人接着说。
    const night = T0 + 13 * H;
    const r = wakeOn([msg(night), looked(night + 10 * S), msg(night + 30 * S)]);
    expect(r === null || ("score" in r && r.score < 0.5)).toBe(true);
  });

  it("the state comes only from events: folding twice gives the same world", () => {
    const events = [msg(T0), looked(T0 + 10 * S), ...chatter(T0 + 10 * S, 4)];
    expect(fold(events)).toEqual(fold(events));
  });
});

describe("follow: what she is told", () => {
  const told = async (mechanism: typeof pressure) => {
    const events: AliceEvent[] = [msg(T0, { directed: true, senderId: "contact:9" })];
    for (let i = 1; i <= 6; i++) events.push(msg(T0 + i * 20 * S));
    const seen: Array<{ unsought: boolean; trigger: string | null }> = [];
    let k = 0;
    const speech = async (r: SpeechRequest): Promise<SpeechDecision> => {
      if (r.scope !== G) return { acts: [] };
      seen.push({
        unsought: r.contributions.some((c) => c.mechanism === "pressure-unsought"),
        trigger: r.triggerMessageId,
      });
      k++;
      // 被点名时不说（她开始看着），第三次叫醒时说一句（成了参与者）。
      return k === 3 ? { acts: [{ kind: "send", text: "我也是", replyTo: null }] } : { acts: [] };
    };
    await replay(events, { mechanisms: [mechanism], speech, tickMs: 10 * S });
    return seen.filter((s) => s.trigger !== null).slice(1);
  };

  it("woken while watching she is told nobody is looking for her; after she joins, she is not", async () => {
    const plain = await told(pressure);
    expect(plain.length).toBeGreaterThanOrEqual(3);
    // 第二、三次是旁观（没人找你）；她说了之后下一次在对话里。
    expect(plain[0]?.unsought).toBe(true);
    expect(plain[1]?.unsought).toBe(true);
    expect(plain[2]?.unsought).toBe(false);
  });

  it("as a reader she is told nobody is looking for her even after she joins", async () => {
    const reader = createPressure(affordances, {
      ...composition,
      follow: follow({ skip: true, gate: "look", reader: true }),
    });
    const plain = await told(reader);
    expect(plain.length).toBeGreaterThanOrEqual(3);
    expect(plain.every((s) => s.unsought)).toBe(true);
  });
});
