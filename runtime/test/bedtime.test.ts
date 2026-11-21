import { describe, expect, it } from "vitest";
import { withMissed } from "../src/mechanisms/missed.js";
import {
  bedtime,
  bedUntil,
  createBedtime,
  depthIn,
  inBed,
  NAP,
  NIGHT,
  nextWake,
} from "../src/mechanisms/pressure/bedtime.js";
import {
  createPressure,
  PRODUCTION,
  pressureProduction,
  willOf,
} from "../src/mechanisms/pressure/index.js";
import { life } from "../src/mechanisms/pressure/life.js";
import {
  awakeBetween,
  isAsleep,
  SLEEP_WINDOW,
  sleep,
  sleepDepth,
} from "../src/mechanisms/pressure/sleep.js";
import { intentionsFor } from "../src/mechanisms/pressure/will.js";
import { emptyWorld, reduceWorld, type World } from "../src/mechanisms/pressure/world.js";
import { affordanceOf, affordances } from "../src/mind/affordances.js";
import { isAct } from "../src/mind/args.js";
import type { AliceEvent } from "../src/mind/events.js";
import type { Mechanism } from "../src/mind/mechanism.js";
import { type AliceState, emptyState } from "../src/mind/state.js";
import { speechRequest, step } from "../src/mind/step.js";
import { arms } from "../src/sim/will-arms.js";
import { codeMode } from "../src/speech/decision.js";
import { renderSpeechPrompt } from "../src/speech/prompt.js";
import { program as reply } from "./model-reply.js";

const MIN = 60_000;
const H = 60 * MIN;
/** 本地（东八区）2026-02-20 0 点。 */
const MIDNIGHT = Date.parse("2026-02-20T00:00:00+08:00");
const local = (h: number, m = 0) => MIDNIGHT + h * H + m * MIN;
const DM = "telegram:1";

let n = 0;
const msg = (at: number, text = "还在吗"): AliceEvent => ({
  type: "message.received",
  at,
  scope: DM,
  chatType: "private",
  messageId: `m${++n}`,
  senderId: "contact:1",
  senderName: "小周",
  text,
  contentType: "text",
  replyToMessageId: null,
  directed: true,
});
const sent = (at: number, text: string): AliceEvent => ({
  type: "message.sent",
  at,
  scope: DM,
  messageId: `s${++n}`,
  text,
  kind: "text",
});
const toBed = (at: number): AliceEvent => ({
  type: "act.done",
  at,
  scope: DM,
  act: { kind: "bed" },
});

/** 前一晚 23:50 起聊着，0:14 她道了晚安。 */
const evening = (): AliceEvent[] => [
  msg(local(-1, 50), "睡不着"),
  sent(local(0, 1), "我也是"),
  msg(local(0, 10), "你困不困"),
  sent(local(0, 14), "困了 晚安"),
];

const run = (events: AliceEvent[], mechanisms: readonly Mechanism[]): AliceState =>
  events.reduce((s, e) => step(s, e, mechanisms).state, emptyState);

const userAt = (state: AliceState, at: number, mechanisms: readonly Mechanism[]) => {
  const chat = state.chats[DM];
  if (!chat) throw new Error("no chat");
  return renderSpeechPrompt("P", speechRequest(state, chat, at, null, mechanisms)).user;
};

/** 压力场的世界：生产的折叠加上 bedtime 那一样的折叠。 */
const BED_COMP = {
  ...PRODUCTION,
  sleep: withMissed(bedtime),
  life: life({ occupies: true, warm: true }),
};
const withBedtime = createPressure(affordances, BED_COMP);

const fold = (events: AliceEvent[]): World =>
  events.reduce((w, e) => {
    const after = reduceWorld(w, e);
    return bedtime.reduce ? bedtime.reduce(w, after, e) : after;
  }, emptyWorld);
const deliberate = affordances.filter((a) => a.deliberate);
const best = (w: World, at: number) =>
  Math.max(
    ...intentionsFor(w, deliberate, DM, at, {
      ...willOf(BED_COMP),
      tiers: () => 5,
    }).map((i) => i.nsv),
  );

describe("bedtime: saying she goes to sleep is folded into her being asleep", () => {
  it("offers go_to_bed in bedtime at night only and anytime in production, and parses it", () => {
    const state = run(evening(), [withBedtime]);
    const chat = state.chats[DM];
    if (!chat) throw new Error("no chat");
    const night = speechRequest(state, chat, local(0, 14), null, [withBedtime]);
    expect(night.affordances).toContain("bed");
    const program = 'await tools.say({ text: "晚安" });\nawait tools.go_to_bed();';
    expect(codeMode.parse(reply(program), night).decision.acts).toEqual([
      { kind: "send", text: "晚安", replyTo: null },
      { kind: "bed" },
    ]);
    const afternoon = speechRequest(state, chat, local(15), null, [withBedtime]);
    expect(afternoon.affordances).not.toContain("bed");
    // 生产已切为 lifeBody，白天晚上随时都能去睡。
    const prodAfternoon = speechRequest(
      run(evening(), [pressureProduction]),
      chat,
      local(15),
      null,
      [pressureProduction],
    );
    expect(prodAfternoon.affordances).toContain("bed");
    // 它是一个可以写进 Journal、再读回来的动作。
    expect(isAct({ kind: "bed" })).toBe(true);
    // 说明告诉她：道晚安就是去睡了（第一轮剩下的宣布都在她选它之前）。
    const rules = codeMode.rules(night.affordances.map(affordanceOf));
    expect(rules).toMatch(
      /\/\*\* （只有你自己看得到，不会发出去）道晚安、要去睡觉的时候：说了晚安，你就是去睡了 \*\/\n {2}go_to_bed: /,
    );
    // 消融组 no-bedtime 没有这个动作。
    const has = (arm: string) => arms({})[arm]?.some((m) => m.affordances?.includes("bed"));
    expect(has("production")).toBe(true);
    expect(has("no-bedtime")).toBe(false);
  });

  it("keeps her asleep from the act until the schedule's next wake", () => {
    const w = fold([...evening(), toBed(local(0, 14))]);
    expect(inBed(w, local(0, 15))).toBe(true);
    expect(inBed(w, local(0, SLEEP_WINDOW.wake - 1))).toBe(true);
    expect(inBed(w, local(0, SLEEP_WINDOW.wake + 1))).toBe(false);
    expect(nextWake(local(0, 14))).toBe(local(0, SLEEP_WINDOW.wake));
    expect(nextWake(local(21, 40)) - local(21, 40)).toBeLessThanOrEqual(NIGHT);
    // 不选这个动作，0:14 照作息还醒着。
    expect(inBed(fold(evening()), local(0, 15))).toBe(false);
  });

  it("charges the waking cost of someone just fallen asleep until the schedule's sleep begins, then the schedule's", () => {
    const right = local(0, 15);
    const w = fold([...evening(), toBed(local(0, 14)), msg(right)]);
    expect(isAsleep(right)).toBe(false);
    expect(depthIn(w, right)).toBe(1);
    expect(depthIn(w, local(4))).toBe(sleepDepth(local(4)));
    expect(depthIn(fold(evening()), right)).toBe(0);
    // 一分钟后的一条私聊叫不醒她；没选这个动作时叫得醒。
    expect(best(w, right)).toBeLessThan(0);
    expect(best(fold([...evening(), msg(right)]), right)).toBeGreaterThan(0);
  });

  it("says she was asleep when woken in bed, with the schedule's own words", () => {
    const mechanisms = [withBedtime];
    const woken = run([...evening(), toBed(local(0, 14)), msg(local(0, 34))], mechanisms);
    expect(userAt(woken, local(0, 34), mechanisms)).toContain("我本来在睡觉，被消息吵醒了。");
    // 只说了"晚安"、没选 [去睡了]：照作息她醒着。
    const said = run([...evening(), msg(local(0, 34))], mechanisms);
    expect(userAt(said, local(0, 34), mechanisms)).not.toContain("在睡觉");
  });

  it("is the schedule in everything else", () => {
    expect(BED_COMP.sleep?.will).toBe(bedtime.will);
    expect(BED_COMP.sleep?.affordances).toBe(bedtime.affordances);
    expect(BED_COMP.sleep?.offers).toBe(bedtime.offers);
    expect(bedtime.outside).toBe(sleep.outside);
    expect(willOf(BED_COMP).age).toBe(awakeBetween);
  });
});

describe("createBedtime({ anytime })：白天也说得出 #39 那一觉", () => {
  const nap = createBedtime({ anytime: true });

  it("offers going to bed all day, and a day nap ends by itself", () => {
    const at = local(15);
    // 生产的门还在：下午不给；候选给。
    expect(bedtime.offers?.("bed", DM, emptyWorld, at)).toBe(false);
    expect(nap.offers?.("bed", DM, emptyWorld, at)).toBe(true);
    expect(bedUntil(at, true)).toBe(at + NAP);
    expect(bedUntil(at)).toBe(nextWake(at));
    const w = { ...emptyWorld, bedAt: at };
    expect(nap.asleep?.(w, at + NAP - 1)).toBe(true);
    expect(nap.asleep?.(w, at + NAP)).toBe(false);
    // 生产 helper 不动：inBed 仍睡到作息的下一次醒来。
    expect(inBed(w, at + NAP)).toBe(true);
  });

  it("still sleeps through the night to the schedule's wake", () => {
    const night = local(23, 50);
    expect(nextWake(night) - night).toBeLessThanOrEqual(NIGHT);
    expect(bedUntil(night, true)).toBe(nextWake(night));
    const w = { ...emptyWorld, bedAt: night };
    expect(nap.asleep?.(w, night + 30 * MIN)).toBe(true);
    expect(nap.asleep?.(w, nextWake(night))).toBe(false);
  });

  it("folds a daytime go_to_bed only in the anytime candidate", () => {
    const at = local(15);
    const decided: AliceEvent = {
      type: "speech.decided",
      at,
      scope: DM,
      callId: "c1",
      decision: { acts: [{ kind: "bed" }] },
    };
    expect(bedtime.reduce?.(emptyWorld, emptyWorld, decided).bedAt).toBeUndefined();
    expect(nap.reduce?.(emptyWorld, emptyWorld, decided).bedAt).toBe(at);
  });
});
