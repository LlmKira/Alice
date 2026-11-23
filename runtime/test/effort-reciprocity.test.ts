/**
 * 投入度加权的互惠（will.ts socialCost 的 byEffort，world.ts effort）：对方只回"1""好的"、贴纸时，轮数打平但投入不平，
 * 互惠代价应当抬起来；对方第一次来找她（"在吗""救命"）时不收这笔。关掉时和按轮数算的一模一样。
 */
import { describe, expect, it } from "vitest";
import {
  BARE_WILL,
  intentionsFor,
  socialCost,
  type WillPolicy,
} from "../src/mechanisms/pressure/will.js";
import {
  effortAt,
  effortWeight,
  emptyWorld,
  reduceWorld,
  type World,
} from "../src/mechanisms/pressure/world.js";
import { affordances } from "../src/mind/affordances.js";
import type { AliceEvent, MessageReceived, MessageSent } from "../src/mind/events.js";

const T0 = 1_771_000_000_000;
const MIN = 60_000;
const DM = "telegram:1";
const EFFORT: WillPolicy = { ...BARE_WILL, effortReciprocity: true };

let n = 0;
function msg(at: number, text: string | null, contentType = "text"): MessageReceived {
  n++;
  return {
    type: "message.received",
    at,
    scope: DM,
    chatType: "private",
    messageId: `m${n}`,
    senderId: "contact:1",
    senderName: "池塘",
    text,
    contentType,
    replyToMessageId: null,
    directed: true,
  };
}
function sent(at: number, text: string): MessageSent {
  n++;
  return { type: "message.sent", at, scope: DM, messageId: `s${n}`, text, kind: "text" };
}
const fold = (events: AliceEvent[]): World =>
  events.reduce<World>((w, e) => reduceWorld(w, e), emptyWorld);

function reciprocityCost(w: World, at: number, byEffort: boolean): number {
  const chat = w.chats[DM];
  if (!chat) throw new Error("no chat");
  return socialCost(w, chat, 15, 0, at, byEffort);
}

const LONG = "今天下班路上看到一只橘猫蹲在便利店门口，好可爱，你那边呢";

/** 对方先开口，之后五轮：她每轮说一段长话，对方回一个短词，每轮隔 3 分钟。 */
function terseRounds(replies: readonly (string | null)[]): { events: AliceEvent[]; end: number } {
  const events: AliceEvent[] = [msg(T0, "在吗")];
  let at = T0;
  for (const r of replies) {
    at += 3 * MIN;
    events.push(sent(at, LONG));
    at += MIN;
    events.push(r === null ? msg(at, null, "sticker") : msg(at, r));
  }
  return { events, end: at + MIN };
}

describe("effortWeight", () => {
  it("weighs by substance: long or a question is full, short scales, no text is the floor", () => {
    expect(effortWeight(LONG)).toBe(1);
    expect(effortWeight("在吗？")).toBe(1);
    expect(effortWeight("1")).toBe(0.25);
    expect(effortWeight("好的")).toBe(0.25);
    expect(effortWeight("我刚到家了先洗个澡")).toBeCloseTo(9 / 12);
    expect(effortWeight(null)).toBe(0.25);
    expect(effortWeight("   ")).toBe(0.25);
  });
});

describe("effort reciprocity", () => {
  it("a first DM ('在吗', '救命') carries no reciprocity cost and still wakes her", () => {
    for (const text of ["在吗", "救命"]) {
      const w = fold([msg(T0, text)]);
      const at = T0 + MIN;
      expect(reciprocityCost(w, at, true)).toBe(reciprocityCost(w, at, false));
      const send = intentionsFor(w, affordances, DM, at, EFFORT).find(
        (i) => i.affordance === "send",
      );
      const bare = intentionsFor(w, affordances, DM, at, BARE_WILL).find(
        (i) => i.affordance === "send",
      );
      expect(send?.nsv).toBe(bare?.nsv);
      expect(send?.nsv ?? 0).toBeGreaterThan(0);
    }
  });

  it("five long turns against '1'/'好的'/stickers raise the cost of sending, not by turn count", () => {
    const { events, end } = terseRounds(["1", "好的", "对的", null, "1"]);
    const w = fold(events);
    const chat = w.chats[DM];
    expect([chat?.turns.length, chat?.incoming.length]).toEqual([5, 6]);
    const byTurns = reciprocityCost(w, end, false);
    const byEffort = reciprocityCost(w, end, true);
    // 她 5 轮、对方 6 条：按轮数互惠是 0；按投入（淡掉后约 4.0 对 1.2）是 0.56，乘 dist 0.5 和权重 0.3。
    const e = effortAt(chat as NonNullable<typeof chat>, end);
    expect(e.hers - e.theirs).toBeGreaterThan(2.5);
    expect(byEffort - byTurns).toBeCloseTo(0.5 * 0.3 * Math.min(1, (e.hers - e.theirs) / 5));

    const bare = intentionsFor(w, affordances, DM, end, BARE_WILL);
    const eff = intentionsFor(w, affordances, DM, end, EFFORT);
    const nsv = (xs: typeof bare, kind: string) => xs.find((i) => i.affordance === kind)?.nsv;
    const sendDrop = (nsv(bare, "send") ?? 0) - (nsv(eff, "send") ?? 0);
    expect(sendDrop).toBeGreaterThan(0);
    // 互惠是会话上的代价，发消息和点表情一样付：两者的差不变，压低的是"再发一条"本身的净值。
    const react = nsv(eff, "react");
    if (react !== undefined) {
      expect((nsv(eff, "send") ?? 0) - react).toBeCloseTo(
        (nsv(bare, "send") ?? 0) - (nsv(bare, "react") ?? 0),
      );
    }
  });

  it("matching effort (full replies) keeps the cost where turn counting puts it", () => {
    const { events, end } = terseRounds([LONG, LONG, LONG, LONG, LONG]);
    const w = fold(events);
    expect(reciprocityCost(w, end, true)).toBe(reciprocityCost(w, end, false));
  });
});
