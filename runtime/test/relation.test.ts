/**
 * 回避按人记（src/mechanisms/pressure/relation.ts，生产）：谁在等她、私聊里的拒绝记在对方身上、意愿层按动作的对象
 * 读哪一个数。闭环性质（A1–A3）在 test/pressure-properties.test.ts，线上足迹在 src/sim/addressed.ts。
 */
import { describe, expect, it } from "vitest";
import {
  PRODUCTION,
  relation,
  willOf,
  willWake,
  worldFold,
} from "../src/mechanisms/pressure/index.js";
import { AVERSION_TAU } from "../src/mechanisms/pressure/params.js";
import {
  aversionToward,
  familiarityTier,
  personAversion,
  relationTier,
  relationView,
  STOP,
  stopNotes,
  stopToward,
} from "../src/mechanisms/pressure/relation.js";
import { emptyWorld, tierOf, type World } from "../src/mechanisms/pressure/world.js";
import { affordanceOf, affordances } from "../src/mind/affordances.js";
import type { AliceEvent, MessageReceived } from "../src/mind/events.js";

const T0 = 1_771_000_000_000;
const MIN = 60_000;
const GROUP = "telegram:-100";
const DM = "telegram:1";
const fold = (events: AliceEvent[], from: World = emptyWorld) =>
  events.reduce(worldFold({ relation }), from);

let n = 0;
function msg(at: number, o: Partial<MessageReceived> = {}): MessageReceived {
  n++;
  const scope = o.scope ?? GROUP;
  const group = scope.startsWith("telegram:-");
  return {
    type: "message.received",
    at,
    scope,
    chatType: group ? "group" : "private",
    messageId: `m${n}`,
    senderId: "contact:1",
    senderName: "池塘",
    text: "hi",
    contentType: "text",
    replyToMessageId: null,
    directed: !group,
    ...o,
  };
}
const sent = (at: number, scope = GROUP): AliceEvent => ({
  type: "message.sent",
  at,
  scope,
  messageId: `s${++n}`,
  text: "嗯",
  kind: "text",
});
const refused = (at: number, scope: string): AliceEvent => ({
  type: "act.failed",
  at,
  scope,
  act: { kind: "send", text: "嗯", replyTo: null },
  reason: "refused",
});

describe("who is waiting on her", () => {
  it("is everyone who addressed her since she last spoke or decided there", () => {
    const w = fold([
      msg(T0, { senderId: "contact:2" }),
      msg(T0 + MIN, { senderId: "contact:2", directed: true }),
      msg(T0 + 2 * MIN, { senderId: "contact:3", directed: true }),
      msg(T0 + 3 * MIN, { senderId: "contact:2", directed: true }),
    ]);
    expect(w.relations.waiting[GROUP]).toEqual(["contact:2", "contact:3"]);
    expect(fold([sent(T0 + 4 * MIN)], w).relations.waiting[GROUP]).toEqual([]);
    const decided: AliceEvent = {
      type: "speech.decided",
      at: T0 + 4 * MIN,
      scope: GROUP,
      callId: "c1",
      decision: { acts: [] },
    };
    expect(fold([decided], w).relations.waiting[GROUP]).toEqual([]);
  });
});

describe("hurts are held per person", () => {
  it("a refusal in a private chat is the partner's, and fades with the private time constant", () => {
    const w = fold([msg(T0, { scope: DM }), sent(T0 + MIN, DM), refused(T0 + 2 * MIN, DM)]);
    const at = T0 + 2 * MIN + AVERSION_TAU.private;
    expect(aversionToward(w.relations, "contact:1", at)).toBeCloseTo(Math.exp(-1), 12);
    expect(w.relations.people["contact:1"]?.hurts[0]).toMatchObject({ why: "refused", scope: DM });
  });

  it("a refusal in a group is the room's, not a person's", () => {
    const w = fold([
      msg(T0, { senderId: "contact:2" }),
      sent(T0 + MIN),
      refused(T0 + 2 * MIN, GROUP),
    ]);
    expect(Object.values(w.relations.people).flatMap((r) => r.hurts)).toEqual([]);
  });
});

describe("the will reads the person for person-directed acts", () => {
  const blocked = fold([
    msg(T0, { scope: DM }),
    sent(T0 + MIN, DM),
    refused(T0 + 2 * MIN, DM),
    msg(T0 + 3 * MIN, { senderId: "contact:2" }),
  ]);
  const send = affordanceOf("send");
  const leave = affordanceOf("leave-chat");

  it("nobody waiting: the room term (null)", () => {
    expect(personAversion(blocked, GROUP, send, T0 + 4 * MIN)).toBeNull();
  });

  it("someone waiting: the least avoided of them", () => {
    const one = fold([msg(T0 + 4 * MIN, { senderId: "contact:1", directed: true })], blocked);
    const a = personAversion(one, GROUP, send, T0 + 5 * MIN) as number;
    expect(a).toBeGreaterThan(0.5);
    const two = fold([msg(T0 + 4 * MIN, { senderId: "contact:2", directed: true })], one);
    expect(personAversion(two, GROUP, send, T0 + 5 * MIN)).toBe(0);
  });

  it("leaving is a room act even when someone is waiting", () => {
    const one = fold([msg(T0 + 4 * MIN, { senderId: "contact:2", directed: true })], blocked);
    expect(personAversion(one, GROUP, leave, T0 + 5 * MIN)).toBeNull();
  });

  it("production reads it; without relation the will reads only the room term", () => {
    expect(willOf(PRODUCTION).aversion).toBe(personAversion);
    expect(willOf({ ...PRODUCTION, relation: undefined }).aversion).toBeUndefined();
  });
});

describe("a negative reaction on her line is a light rejection, not a reply or a bond", () => {
  const line = (at: number): AliceEvent => ({
    type: "message.sent",
    at,
    scope: GROUP,
    messageId: "her-1",
    text: "嗯",
    kind: "text",
  });
  const react = (at: number, emoji: string): AliceEvent => ({
    type: "reaction.received",
    at,
    scope: GROUP,
    messageId: "her-1",
    senderId: "contact:9",
    emoji,
  });
  const start = [msg(T0, { senderId: "contact:9" }), line(T0 + MIN)];

  it("👎 reaches the reception as cold and the person as a small hurt; ❤ stays a reply and a bond", () => {
    const down = fold([...start, react(T0 + 2 * MIN, "👎")]);
    const chat = down.chats[GROUP];
    expect(chat?.receptions.at(-1)).toMatchObject({ kind: "cold", by: "contact:9", emoji: "👎" });
    expect(chat?.lastBondAt).toBe(0);
    expect(chat?.outgoing).toBeGreaterThan(0);
    expect(relationView(down, "contact:9")?.lastBondAt).toBe(0);
    expect(chat?.aversion).toBeGreaterThan(0);
    expect(down.relations.people["contact:9"]?.hurts).toEqual([
      expect.objectContaining({ why: "cold", scope: GROUP }),
    ]);
    const up = fold([...start, react(T0 + 2 * MIN, "❤")]);
    expect(up.chats[GROUP]?.receptions.at(-1)).toMatchObject({ kind: "replied", emoji: "❤" });
    expect(up.chats[GROUP]?.outgoing).toBe(0);
    expect(relationView(up, "contact:9")?.lastBondAt).toBe(T0 + 2 * MIN);
    expect(up.relations.people["contact:9"]?.hurts ?? []).toEqual([]);
  });
});

describe("told to stop: that person's lines no longer wake her by themselves (live 2026-11-13, Ani)", () => {
  const H = 3_600_000;
  const D = 24 * H;
  // 东八区下午三点（醒着）。
  const at0 = T0 - ((T0 + 8 * H) % D) + D + 15 * H;
  const wake = willWake(affordances, PRODUCTION);
  const ani = (at: number, id: string) =>
    msg(at, { senderId: "ani", senderName: "Ani", directed: true, messageId: id });
  const stop = (at: number, id: string): AliceEvent => ({
    type: "message.perceived",
    at,
    scope: GROUP,
    messageId: id,
    tone: "hostile",
    stop: true,
  });
  /** 吵了几句，Ani 说"别回我的消息"，她 42 秒后照样回了（外壳的判断和那次发言并发，那一轮看不到）。 */
  const quarrel = (told: boolean): AliceEvent[] => [
    msg(at0 - 10 * 60_000, { senderId: "rumun" }),
    ani(at0, "a1"),
    sent(at0 + 30_000),
    ani(at0 + 60_000, "a2"),
    ...(told ? [stop(at0 + 75_000, "a2")] : []),
    sent(at0 + 102_000),
  ];
  const score = (events: AliceEvent[], last: MessageReceived, at = last.at) => {
    const world = fold([...events, last]);
    const r = wake.why(GROUP, last, at, world);
    return r && "score" in r ? r.score : 0;
  };

  it("the request is kept as Ani's own stop hurt, with its cause", () => {
    const w = fold(quarrel(true));
    expect(w.relations.people.ani?.hurts).toEqual([
      expect.objectContaining({ why: "stop", scope: GROUP }),
    ]);
    expect(stopToward(w.relations, "ani", at0 + 75_000 + STOP.tau)).toBeCloseTo(
      STOP.gain * Math.exp(-1),
      9,
    );
  });

  it("red without it, green with it: her next line within hours does not wake her", () => {
    const next = ani(at0 + 3 * 60_000, "a3");
    expect(score(quarrel(false), next)).toBeGreaterThan(0.5);
    expect(score(quarrel(true), next)).toBeLessThan(0.5);
    // 两个小时后还是不叫醒（代价按小时淡掉）。
    const later = ani(at0 + 2 * H, "a4");
    expect(score(quarrel(true), later)).toBeLessThan(0.5);
  });

  it("she knows it: the card in that chat carries it under Ani's name, it fades, other chats never see it", () => {
    const aniDm = "telegram:777";
    const otherDm = "telegram:778";
    const otherGroup = "telegram:-200";
    const base = [
      msg(at0 - 20 * 60_000, { scope: aniDm, senderId: "ani", senderName: "Ani" }),
      msg(at0 - 20 * 60_000, { scope: otherDm, senderId: "rumun", senderName: "Rumun" }),
      msg(at0 - 20 * 60_000, { scope: otherGroup, senderId: "ani", senderName: "Ani" }),
    ];
    const told = fold([...base, ...quarrel(true)]);
    const untold = fold([...base, ...quarrel(false)]);
    const card = (w: World, scope: string, now: number) =>
      (
        relation.contribute?.({
          world: w,
          chat: { scope, chatType: scope.startsWith("telegram:-") ? "group" : "private" } as never,
          now,
          sought: true,
          outside: false,
          offered: [],
        }) ?? []
      )
        .map((c) => c.text)
        .join("\n");
    const soon = at0 + 30 * 60_000;
    expect(card(untold, GROUP, soon)).toBe("");
    expect(card(told, GROUP, soon)).toMatch(/^Ani：\d+ 分钟前叫我别回 Ta 的消息$/);
    expect(card(told, aniDm, soon)).toContain("Ani：");
    expect(card(told, otherDm, soon)).toBe("");
    expect(card(told, otherGroup, soon)).toBe("");
    // 写的是她知道的事（谁、多久前、说了什么），不是对她的指令：句子由时间开头，不以"别、不要"开头。
    expect(stopNotes(told, GROUP, soon)[0]?.facts?.[0]).toMatch(/^\d+ 分钟前/);
    // 和那一笔同一个时间常数淡掉：剩到 STOP_SHOWN 以下（约 4.2 小时）就不写了。
    expect(card(told, GROUP, at0 + 4 * H)).not.toBe("");
    expect(card(told, GROUP, at0 + 4.5 * H)).toBe("");
  });

  it("someone else waiting does not let the stopper's line wake her (the 11:24 re-wake)", () => {
    const rumunWaits = [
      ...quarrel(true),
      msg(at0 + 2 * 60_000, { senderId: "rumun", senderName: "Rumun", directed: true }),
    ];
    const next = ani(at0 + 3 * 60_000, "a3");
    const w = fold([...rumunWaits, next]);
    const send = affordanceOf("send");
    // 节律到点时（不是哪条消息叫醒她）读在等她的人里她不躲的那个；Ani 的这条叫醒她时读 Ani 自己。
    expect(personAversion(w, GROUP, send, next.at)).toBe(0);
    expect(personAversion(w, GROUP, send, next.at, "ani") as number).toBeGreaterThan(5);
    expect(score(rumunWaits, next)).toBeLessThan(0.5);
  });

  it("someone else in the group can still wake her", () => {
    const rumun = msg(at0 + 3 * 60_000, { senderId: "rumun", senderName: "Rumun", directed: true });
    expect(score([...quarrel(true), ani(at0 + 2 * 60_000, "a3")], rumun)).toBeGreaterThan(0.5);
  });

  it("in a private chat, stop hurt still holds after she already replied and clock ticks hours later", () => {
    const dmEvents: AliceEvent[] = [
      msg(at0, { scope: DM, senderId: "ani", senderName: "Ani", directed: true, messageId: "d1" }),
      {
        type: "message.perceived",
        at: at0 + 10_000,
        scope: DM,
        messageId: "d1",
        tone: "cold",
        stop: true,
      },
      {
        type: "speech.decided",
        at: at0 + 15_000,
        scope: DM,
        callId: "dm#1",
        decision: { acts: [] },
      },
      sent(at0 + 20_000, DM),
    ];
    const w = fold(dmEvents);
    const send = affordanceOf("send");
    const twoHoursLater = at0 + 2 * H;
    expect(personAversion(w, DM, send, twoHoursLater) as number).toBeGreaterThan(3);
    expect(wake.why(DM, { type: "clock.tick", at: twoHoursLater }, twoHoursLater, w)).toBeNull();
  });
});

/**
 * 第 4 片的候选（docs/research/relationship.md）：层级从校准过的联系频率分档，而不是排名。
 * 生产保持排名（`relation`），候选是 `relationTier`；量过之前 production 的 tier 不变。
 */
describe("candidate: tiers from familiarity, not from an unstable rank", () => {
  const DAY = 24 * 60 * MIN;
  const G = "telegram:-101";
  let k = 0;
  const said = (at: number, o: Partial<MessageReceived> = {}): MessageReceived => {
    k++;
    const scope = o.scope ?? G;
    return {
      type: "message.received",
      at,
      scope,
      chatType: scope.startsWith("telegram:-") ? "group" : "private",
      messageId: `d${k}`,
      senderId: "contact:1",
      senderName: "池塘",
      text: "hi",
      contentType: "text",
      replyToMessageId: null,
      directed: true,
      ...o,
    };
  };
  const tiered = (events: AliceEvent[], now = events.at(-1)?.at ?? T0, id = "contact:1") => {
    const w = fold(events, emptyWorld);
    const c = events.reduce(worldFold({ relation: relationTier }), emptyWorld);
    return {
      candidate: familiarityTier(c.relations, id, now),
      production: tierOf(w, id, now),
      world: c,
    };
  };

  it("week one: nobody is in tier ≤ 15, so the tier-unbacked footprint is 0", () => {
    // 空库开张，一周里每天都有不同的人来找她（有来有往、有回应）。
    const events: AliceEvent[] = [];
    for (let day = 0; day < 6; day++) {
      for (let who = 0; who < 4; who++)
        events.push(
          said(T0 + day * DAY + who * MIN, { senderId: `c${who}` }),
          sent(T0 + day * DAY + who * MIN + 30_000, G),
        );
    }
    const { world } = tiered(events);
    const now = T0 + 5 * DAY;
    const early = Object.keys(world.relations.people).filter(
      (id) => familiarityTier(world.relations, id, now) <= 15,
    );
    expect(early).toEqual([]);
  });

  it("the bands follow the calibrated frequency: 5, 15, 50, 150, and 500 under a week", () => {
    const daily = Array.from({ length: 9 }, (_, d) => said(T0 + d * DAY));
    expect(tiered(daily, T0 + 8 * DAY).candidate).toBe(5);
    const three = [0, 2, 4].map((d) => said(T0 + d * DAY));
    expect(tiered(three, T0 + 7 * DAY).candidate).toBe(15);
    const twice = [0, 7].map((d) => said(T0 + d * DAY));
    expect(tiered(twice, T0 + 13 * DAY).candidate).toBe(50);
    const stale = [0, 1].map((d) => said(T0 + d * DAY));
    expect(tiered(stale, T0 + 40 * DAY).candidate).toBe(150);
    const week = [0, 1, 2, 3, 4, 5].map((d) => said(T0 + d * DAY));
    expect(tiered(week, T0 + 5 * DAY).candidate).toBe(500);
  });

  it("production keeps the rank tier until it is measured: the first person to talk is tier 5 half an hour in", () => {
    const events = [said(T0), said(T0 + 5 * MIN)];
    const now = T0 + 30 * MIN;
    expect(tiered(events, now).production).toBe(5);
    expect(tiered(events, now).candidate).toBe(500);
    // 候选只改读法：关系本身的折叠和生产是同一份。
    const prod = fold(events, emptyWorld);
    expect(tiered(events, now).world.relations.people).toEqual(prod.relations.people);
  });
});
