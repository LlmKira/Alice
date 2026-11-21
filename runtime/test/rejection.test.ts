/**
 * 群里的人嫌她（生产，mechanisms/pressure/rejection.ts；PLAN 第 7 件）的性质：
 * - P-R1 挖苦、试探不是嫌她：人还在跟她说话时的敌意不加嫌弃，叫醒和没有这些口气时一样；
 * - P-R2 叫停不被别人盖掉：有人叫她别回，旁边的人再怎么对她友好，嫌弃也不减，别人的闲聊不再叫醒她；
 * - P-R3 负面表情不算亲近：她的话上的 👎 不算回应、不续关系，记一份嫌弃；❤ 照旧是回应、不记；
 * - P-R4 她收手，也能和好：两个人冷淡地回她，闲聊不再叫醒她、点她名也多付一笔；他们都好好找她以后，这笔没有了；
 *   没人和好时，代价按时间淡掉，几个小时内点她名照样叫醒她；
 * - 自适应：常态冷的群里一句冷淡算得轻；嫌她的人回心转意得快的群，嫌弃淡得快。
 * 去掉 rejection 的对照上"嫌弃让她收手"的几条不成立（it.fails 记下）。
 */
import { describe, expect, it } from "vitest";
import {
  dwell,
  emptyWorld,
  intentionsFor,
  PRODUCTION,
  type PressureFeatures,
  type World,
  wakeScore,
  willOf,
  willWake,
  worldFold,
} from "../src/mechanisms/pressure/index.js";
import { AVERSION_TAU } from "../src/mechanisms/pressure/params.js";
import {
  feedback,
  recoveryTau,
  rejectionAt,
  rejectionCost,
  usualCold,
} from "../src/mechanisms/pressure/rejection.js";
import { NO_REJECTION } from "../src/mechanisms/pressure/world.js";
import { affordances } from "../src/mind/affordances.js";
import type {
  AliceEvent,
  MessagePerceived,
  MessageReceived,
  MessageSent,
  ReactionReceived,
  Tone,
} from "../src/mind/events.js";

/** 当地（UTC+8，mind/when.ts）下午两点多：她醒着。 */
const T0 = 1_771_000_000_000 - 10 * 3_600_000;
const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const G = "telegram:-7";

const CONFIGS: ReadonlyArray<{ name: string; composition: PressureFeatures }> = [
  { name: "production", composition: PRODUCTION },
  { name: "no-rejection", composition: { ...PRODUCTION, floor: dwell() } },
];

let n = 0;
function msg(at: number, senderId: string, o: Partial<MessageReceived> = {}): MessageReceived {
  n++;
  return {
    type: "message.received",
    at,
    scope: G,
    chatType: "group",
    messageId: `r${n}`,
    senderId,
    senderName: senderId,
    text: "今天吃什么",
    contentType: "text",
    replyToMessageId: null,
    directed: false,
    ...o,
  };
}
const toHer = (at: number, senderId: string, her: MessageSent) =>
  msg(at, senderId, { directed: true, replyToMessageId: her.messageId });
function sent(at: number): MessageSent {
  n++;
  return {
    type: "message.sent",
    at,
    scope: G,
    messageId: `s${n}`,
    text: "我也想知道",
    kind: "text",
  };
}
const tone = (at: number, line: MessageReceived, t: Tone, stop = false): MessagePerceived => ({
  type: "message.perceived",
  at,
  scope: G,
  messageId: line.messageId,
  tone: t,
  ...(stop ? { stop: true as const } : {}),
});
const react = (at: number, her: MessageSent, who: string, emoji: string): ReactionReceived => ({
  type: "reaction.received",
  at,
  scope: G,
  messageId: her.messageId,
  senderId: who,
  emoji,
});

for (const { name, composition } of CONFIGS) {
  const reduce = worldFold(composition);
  const wake = willWake(affordances, composition);
  const policy = willOf(composition);
  const fold = (events: readonly AliceEvent[], from: World = emptyWorld) =>
    events.reduce(reduce, from);
  const wakes = (world: World, line: MessageReceived) =>
    wakeScore(wake.why(G, line, line.at, reduce(world, line))) > 0.5;
  const best = (world: World, line: MessageReceived) =>
    Math.max(
      ...intentionsFor(reduce(world, line), affordances, G, line.at, policy, line.senderId).map(
        (i) => i.nsv,
      ),
    );
  const level = (world: World, at: number) => {
    const chat = world.chats[G];
    return chat ? rejectionAt(chat, at) : 0;
  };
  /**
   * 这条话来时，这个群里最好的意愿比没人嫌她时低多少（在对话里时 λ = 0.75）。连续的代价不保证某一条一定叫不醒她，
   * 保证的是叫醒她的那份值少了这么多；线上重算里看实际少醒了几次（eval-artifacts/rejection/prereg.md）。
   */
  const drop = (world: World, line: MessageReceived) => {
    const chat = world.chats[G];
    if (!chat) throw new Error("no chat");
    const calm = {
      ...world,
      chats: { ...world.chats, [G]: { ...chat, turn: { ...chat.turn, rejection: NO_REJECTION } } },
    };
    return best(calm, line) - best(world, line);
  };
  const cut = name === "no-rejection" ? it.fails : it;

  /** 群里聊着，她接了一句，有人接着说（她在这段对话里）。 */
  const opened = () => {
    const her = sent(T0 + 30 * S);
    const events: AliceEvent[] = [
      msg(T0, "rumun"),
      msg(T0 + 10 * S, "angel"),
      her,
      msg(T0 + 40 * S, "rumun"),
    ];
    return { her, events };
  };

  describe(`[${name}]`, () => {
    it("P-R1: mockery and testing while people keep talking to her add nothing", () => {
      const { her, events } = opened();
      const a1 = toHer(T0 + 50 * S, "ani", her);
      const r1 = toHer(T0 + 60 * S, "rumun", her);
      const world = fold([
        ...events,
        a1,
        r1,
        tone(T0 + 70 * S, a1, "hostile"),
        tone(T0 + 70 * S, r1, "hostile"),
      ]);
      expect(level(world, T0 + 2 * MIN)).toBe(0);
      const plain = fold([...events, a1, r1]);
      const line = msg(T0 + 2 * MIN, "angel");
      expect(wakes(world, line)).toBe(wakes(plain, line));
      expect(wakes(world, line)).toBe(true);
    });

    describe("P-R2: a stop is not masked by the people laughing along", () => {
      const { her, events } = opened();
      const stop = toHer(T0 + 50 * S, "ani", her);
      const r1 = toHer(T0 + 70 * S, "rumun", her);
      const stopped = [...events, stop, tone(T0 + 60 * S, stop, "hostile", true)];
      const world = fold([
        ...stopped,
        r1,
        msg(T0 + 75 * S, "angel"),
        tone(T0 + 80 * S, r1, "friendly"),
      ]);
      cut("another person's friendliness does not lower it", () => {
        expect(level(world, T0 + 90 * S)).toBeGreaterThan(0.9);
        expect(level(world, T0 + 90 * S)).toBeCloseTo(level(fold(stopped), T0 + 90 * S), 9);
      });
      cut("other people's chatter wakes her less: worth λ·rejectionCost less", () => {
        expect(drop(world, msg(T0 + 2 * MIN, "angel"))).toBeGreaterThan(0.3);
      });
    });

    cut("being told to shut up counts; the same line only hostile does not", () => {
      const { her, events } = opened();
      const line = toHer(T0 + 50 * S, "ani", her);
      const said = (p: Partial<MessagePerceived>) =>
        level(fold([...events, line, { ...tone(T0 + 60 * S, line, "hostile"), ...p }]), T0 + MIN);
      expect(said({})).toBe(0);
      expect(said({ hush: true })).toBeGreaterThan(0.9);
    });

    describe("P-R3: a negative reaction is not closeness", () => {
      const { her, events } = opened();
      // 表情点在她这一轮还在等反应的时候（rumun 紧接着说的那句会把她这一轮算成有人接，PLAN 第 43 件）。
      const down = fold([
        ...events.slice(0, 3),
        react(T0 + 35 * S, her, "ani", "👎"),
        ...events.slice(3),
      ]);
      const heart = fold([
        ...events.slice(0, 3),
        react(T0 + 35 * S, her, "ani", "❤"),
        ...events.slice(3),
      ]);
      it("👎 is not a reply and not a bond; ❤ is both", () => {
        expect(down.chats[G]?.receptions.at(-1)?.kind).toBe("cold");
        expect(down.relations.people.ani?.seen.lastAnswerAt ?? 0).toBe(0);
        expect(heart.chats[G]?.receptions.at(-1)?.kind).toBe("replied");
        expect(level(heart, T0 + MIN)).toBe(0);
      });
      cut("👎 counts as being unwelcome", () => {
        expect(level(down, T0 + MIN)).toBeGreaterThan(0.4);
      });
    });

    describe("P-R4: she withdraws when people go cold on her, and comes back when they warm up", () => {
      const { her, events } = opened();
      const a1 = toHer(T0 + 50 * S, "ani", her);
      const g1 = toHer(T0 + 55 * S, "angel", her);
      const cold = fold([
        ...events,
        a1,
        g1,
        { ...tone(T0 + 70 * S, a1, "cold"), aloof: true },
        { ...tone(T0 + 70 * S, g1, "cold"), aloof: true },
      ]);
      const a2 = toHer(T0 + 10 * MIN, "ani", her);
      const g2 = toHer(T0 + 11 * MIN, "angel", her);
      const warm = fold(
        [a2, g2, tone(T0 + 12 * MIN, a2, "friendly"), tone(T0 + 12 * MIN, g2, "neutral")],
        cold,
      );

      cut("withdraws: chatter wakes her less", () => {
        expect(drop(cold, msg(T0 + 2 * MIN, "rumun"))).toBeGreaterThan(0.3);
      });

      it("withdraws: answering someone there costs λ·rejectionCost more", () => {
        const line = toHer(T0 + 3 * MIN, "rumun", her);
        const chat = cold.chats[G];
        if (!chat) throw new Error("no chat");
        const calm = {
          ...cold,
          chats: {
            ...cold.chats,
            [G]: { ...chat, turn: { ...chat.turn, rejection: NO_REJECTION } },
          },
        };
        const extra = best(calm, line) - best(cold, line);
        // 被点名时 λ = 0.45（PHI_DIRECTED）；对照里没有这一项。
        const expected = name === "no-rejection" ? 0 : 0.45 * rejectionCost(chat, line.at);
        expect(extra).toBeCloseTo(expected, 6);
      });

      it("comes back: once both talk to her kindly, nothing is left and being named wakes her", () => {
        expect(level(warm, T0 + 13 * MIN)).toBe(0);
        expect(wakes(warm, toHer(T0 + 13 * MIN, "rumun", her))).toBe(true);
      });

      cut("only the people who went cold can lift it: a bystander's kind line does not", () => {
        const r1 = toHer(T0 + 10 * MIN, "rumun", her);
        const bystander = fold([r1, tone(T0 + 12 * MIN, r1, "friendly")], cold);
        expect(level(bystander, T0 + 13 * MIN)).toBeCloseTo(level(cold, T0 + 13 * MIN), 9);
        expect(level(bystander, T0 + 13 * MIN)).toBeGreaterThan(0);
      });

      it("no deadlock: without making up, it fades and being named wakes her again within hours", () => {
        const later = (h: number) => toHer(T0 + h * H, "rumun", her);
        expect([0.5, 1, 2, 3].find((h) => wakes(cold, later(h)))).toBeDefined();
      });
    });
  });
}

describe("rejection adapts to the group", () => {
  it("a cold line weighs less where people are usually cold to her", () => {
    let usual = NO_REJECTION;
    for (let i = 0; i < 20; i++)
      usual = feedback(usual, `p${i % 4}`, T0 + i * MIN, i % 2 ? "cold" : "warm");
    const fresh = feedback(NO_REJECTION, "x", T0 + H, "cold");
    const there = feedback({ ...usual, people: {} }, "x", T0 + H, "cold");
    expect(usualCold(usual)).toBeGreaterThan(usualCold(NO_REJECTION));
    expect(there.people.x?.level ?? 0).toBeLessThan(fresh.people.x?.level ?? 0);
  });

  it("it fades faster where the people who went cold usually come round quickly", () => {
    let quick = NO_REJECTION;
    for (let i = 0; i < 6; i++) {
      quick = feedback(quick, "ani", T0 + i * H, "cold");
      quick = feedback(quick, "ani", T0 + i * H + 10 * MIN, "warm");
    }
    expect(recoveryTau(NO_REJECTION)).toBe(AVERSION_TAU.group);
    expect(recoveryTau(quick)).toBeLessThan(AVERSION_TAU.group / 2);
  });
});
