import { describe, expect, it } from "vitest";
import { withMissed } from "../src/mechanisms/missed.js";
import { type AffectState, initialAffect } from "../src/mechanisms/pressure/affect.js";
import { bedtime } from "../src/mechanisms/pressure/bedtime.js";
import { createPressure, PRODUCTION, willOf } from "../src/mechanisms/pressure/index.js";
import {
  busyCost,
  emptyLife,
  GLANCE,
  type LifeState,
  lifeFacts,
  life as lifeFeature,
  priorityCost,
  reduceLife,
  sociability,
} from "../src/mechanisms/pressure/life.js";
import { isAsleep } from "../src/mechanisms/pressure/sleep.js";
import { intentionsFor } from "../src/mechanisms/pressure/will.js";
import type { World } from "../src/mechanisms/pressure/world.js";
import { affordances } from "../src/mind/affordances.js";
import type { AliceEvent, ClockTick, MessageReceived } from "../src/mind/events.js";
import { NOISE_EVERY_MS } from "../src/mind/noise.js";
import { type ChatState, emptyChat } from "../src/mind/state.js";
import { noiseSource } from "../src/noise-source.js";

const LIFE_COMP = {
  ...PRODUCTION,
  sleep: withMissed(bedtime),
  life: lifeFeature({ warm: true }),
};
const pressureLife = createPressure(affordances, LIFE_COMP);

const MIN = 60_000;
const H = 60 * MIN;
/** 2026-02-20 本地（东八区）0 点。 */
const MIDNIGHT = Date.UTC(2026, 1, 19, 16);
const local = (h: number, m = 0) => MIDNIGHT + h * H + m * MIN;
const DM = "telegram:1";
const deliberate = affordances.filter((a) => a.deliberate);

function dm(at: number): MessageReceived {
  return {
    type: "message.received",
    at,
    scope: DM,
    chatType: "private",
    messageId: `m${at}`,
    senderId: "contact:1",
    senderName: "A",
    text: "在吗",
    contentType: "text",
    replyToMessageId: null,
    directed: true,
  };
}
const chat: ChatState = emptyChat(DM, "private", true);
const reduce = (w: World, e: AliceEvent) => pressureLife.reduce?.(w, e) as World;
const fold = (events: AliceEvent[]) => events.reduce(reduce, pressureLife.initial as World);
const wake = (w: World, e: AliceEvent) =>
  (pressureLife.wake as (c: ChatState, e: AliceEvent, now: number, w: World) => number)(
    chat,
    e,
    e.at,
    w,
  );
const tick = (at: number): ClockTick => ({ type: "clock.tick", at });
/** 一个熟人，前一天聊过。 */
const history: AliceEvent[] = [
  dm(local(-10)),
  { type: "message.sent", at: local(-10, 1), scope: DM, messageId: "s1", text: "嗯", kind: "text" },
];
const eating = (priority: number, from: number, until: number): LifeState => ({
  ...emptyLife,
  at: from,
  doing: { kind: "meal", from, until, priority },
});
const showering = (from: number, until: number): LifeState => ({
  ...emptyLife,
  at: from,
  doing: { kind: "shower", from, until, priority: 1 },
});
/** 不算手上的事时，这个会话里最好的意愿。 */
const best = (w: World, at: number) =>
  Math.max(...intentionsFor(w, deliberate, DM, at, willOf(LIFE_COMP)).map((i) => i.nsv));

/** 从一个种子过 n 天：每 5 分钟一组随机数。 */
function days(
  n: number,
  seed = 20261111,
  o: { fill?: boolean; glance?: boolean } = {},
): LifeState[] {
  const draw = noiseSource(seed);
  const out: LifeState[] = [];
  let life = emptyLife;
  for (let at = local(0); at < local(24 * n); at += NOISE_EVERY_MS) {
    life = reduceLife(life, { type: "noise.drawn", at, scope: "self", draws: draw() }, o);
    out.push(life);
  }
  return out;
}

describe("her own life (Barabási occupancy)", () => {
  it("a message that matters more than what she is doing gets through; one that matters less waits", () => {
    const at = local(19);
    const world = fold([...history]);
    const need = best(fold([...history, dm(at)]), at);
    expect(need).toBeGreaterThan(0);
    // 吃饭的优先级比这条消息低：照样被叫醒；比它高：先不叫醒；在洗澡（手机不在手边）：不叫醒。
    const x = 0.5;
    const urgent = priorityCost(x) < need;
    const meal = { ...world, life: eating(x, at - 10 * MIN, at + 30 * MIN) };
    expect(wake(reduce(meal, dm(at)), dm(at)) >= 0.5).toBe(urgent);
    const light = { ...world, life: eating(0, at - 10 * MIN, at + 30 * MIN) };
    expect(priorityCost(0)).toBeLessThan(need);
    expect(wake(reduce(light, dm(at)), dm(at))).toBeGreaterThanOrEqual(0.5);
    const shower = { ...world, life: showering(at - 10 * MIN, at + 20 * MIN) };
    expect(wake(reduce(shower, dm(at)), dm(at))).toBeLessThan(0.5);
  });

  it("a message that waited is answered once she is done, not dropped", () => {
    const at = local(19);
    const heavy = reduce(
      { ...fold([...history]), life: showering(at - 10 * MIN, at + 30 * MIN) },
      dm(at),
    );
    // 还在洗澡：时钟格也不叫醒她。洗完了：下一格就叫醒这个会话。
    expect(wake(heavy, tick(at + 20 * MIN))).toBe(0);
    expect(wake(heavy, tick(at + 31 * MIN))).toBe(1);
  });

  it("the cost rises with the activity's priority, and is zero when she is free", () => {
    expect(busyCost(emptyLife, local(19))).toBe(0);
    const life = eating(0.5, local(19), local(19, 30));
    expect(busyCost(life, local(19, 10))).toBe(priorityCost(0.5));
    expect(busyCost(life, local(19, 30))).toBe(0);
    for (let x = 0; x < 1; x += 0.1) expect(priorityCost(x + 0.1)).toBeGreaterThan(priorityCost(x));
  });

  it("only starts things while she is awake, and keeps most of her waking day free", () => {
    const states = days(30);
    let awake = 0;
    let busy = 0;
    for (const s of states) {
      if (s.doing && isAsleep(s.at)) throw new Error(`busy while asleep at ${s.at}`);
      if (isAsleep(s.at)) continue;
      awake++;
      if (s.doing) busy++;
    }
    expect(busy / awake).toBeGreaterThan(0.1);
    expect(busy / awake).toBeLessThan(0.4);
    // 没有手机的事（洗澡、洗漱）优先级最高，别的都在 (0, 1) 里。
    for (const s of states) {
      if (!s.doing) continue;
      if (s.doing.kind === "shower" || s.doing.kind === "wash") expect(s.doing.priority).toBe(1);
      else expect(s.doing.priority).toBeLessThan(1);
    }
  });

  it("the same draws give the same day (fold and replay agree)", () => {
    expect(days(3, 7)).toEqual(days(3, 7));
    expect(days(3, 7)).not.toEqual(days(3, 8));
  });
});

describe("her own life reaches the prompt as plain facts", () => {
  it("says what she is in the middle of, or just finished; nothing while asleep", () => {
    const life = eating(0.3, local(19), local(19, 40));
    const during = lifeFacts(life, local(19, 10));
    expect(during.map((c) => c.text).join()).toContain("我在吃饭");
    expect(during.every((c) => c.kind === "state")).toBe(true);
    const after = lifeFacts({ ...life, doing: null, done: life.doing }, local(19, 50));
    expect(after.map((c) => c.text).join()).toContain("我刚吃完饭");
    const later = lifeFacts({ ...life, doing: null, done: life.doing }, local(20, 30));
    expect(later.map((c) => c.text).join()).not.toContain("吃");
    expect(lifeFacts({ ...life, at: local(4) }, local(4))).toEqual([]);
  });

  it("the facts are about her own day and never say she is out or at someone's side", () => {
    const texts = new Set<string>();
    for (const s of days(30)) {
      for (const c of lifeFacts(s, s.at)) texts.add(c.text);
      if (s.doing) for (const c of lifeFacts(s, s.doing.from + MIN)) texts.add(c.text);
    }
    expect(texts.size).toBeGreaterThan(3);
    for (const t of texts) expect(t).not.toMatch(/外面|出门|楼下|路上|身边|过去找/);
  });

  it("warmth: the low-sociability line is a tail state worded as her feeling, and a warm mood lifts it", () => {
    // 60 天的波动，醒着、心情在常态：没有 warmth 时低于常态 1.5 个标准差就写（约 7%）；warmth 只在低尾（约 1%）写。
    const states = days(60).filter((s) => !isAsleep(s.at));
    const quietShare = (warm: boolean, mood: AffectState) =>
      states.filter((s) =>
        lifeFacts(s, s.at, warm ? sociability(s, mood, s.at) : undefined).some((c) =>
          /比较安静/.test(c.text),
        ),
      ).length / states.length;
    const home: AffectState = { ...initialAffect, home: 0.19, valence: 0.19, at: local(0) };
    expect(quietShare(false, home)).toBeGreaterThan(0.03);
    expect(quietShare(true, home)).toBeLessThan(0.03);
    for (const s of states) {
      const text = lifeFacts(s, s.at, sociability(s, home, s.at))
        .map((c) => c.text)
        .join();
      expect(text).not.toContain("不太想说话");
    }
    // 刚被惹烦时更想一个人待着；暖起来时一次也不写。
    const annoyed = (at: number): AffectState => ({ ...home, valence: -0.4, at });
    const glad = (at: number): AffectState => ({ ...home, valence: 0.6, at });
    const share = (mood: (at: number) => AffectState) =>
      states.filter((s) => sociability(s, mood(s.at), s.at).quiet).length / states.length;
    expect(share(annoyed)).toBeGreaterThan(quietShare(true, home));
    expect(share(glad)).toBe(0);
  });
});

describe("candidate life-l2: something is always on hand while she is awake (Barabási L = 2)", () => {
  const states = days(60, 20261111, { fill: true });
  const awake = states.filter((s) => !isAsleep(s.at));

  it("every waking sample has something on hand; nothing while asleep; the same draws give the same day", () => {
    const after = (s: LifeState) => s.at - local(0) >= H; // 第一格之前还没抽过
    for (const s of awake.filter(after)) {
      if (!s.doing || s.at < s.doing.from || s.at >= s.doing.until)
        throw new Error(`idle at ${s.at}`);
    }
    for (const s of states) if (s.doing && isAsleep(s.at)) throw new Error(`busy asleep ${s.at}`);
    expect(days(3, 7, { fill: true })).toEqual(days(3, 7, { fill: true }));
  });

  it("routine things still happen and interrupt what she picked up idly; phone time is about Andrews' 5 hours a day", () => {
    const starts: Record<string, number> = {};
    let phone = 0;
    let prev: LifeState["doing"] = null;
    for (const s of states) {
      if (s.doing && s.doing !== prev) starts[s.doing.kind] = (starts[s.doing.kind] ?? 0) + 1;
      if (s.doing?.kind === "phone" && !isAsleep(s.at)) phone += NOISE_EVERY_MS;
      prev = s.doing;
    }
    expect((starts.meal ?? 0) / 60).toBeGreaterThan(1.9);
    expect((starts.shower ?? 0) / 60).toBeGreaterThan(0.7);
    expect(phone / H / 60).toBeGreaterThan(4.5);
    expect(phone / H / 60).toBeLessThan(5.6);
    // 时段里的事打断随手的事：被打断的那件成了"刚做完"，结束在打断的那一刻。
    const cut = states.find(
      (s) =>
        s.doing &&
        ["meal", "shower", "game", "show"].includes(s.doing.kind) &&
        s.done?.until === s.doing.from &&
        ["phone", "read", "tidy", "music"].includes(s.done.kind),
    );
    expect(cut).toBeDefined();
  });

  it("each thing has its own uniform priority (phone away for shower and washing), so a message gets through with probability 1 − x", () => {
    const seen = new Set<LifeState["doing"]>();
    const xs: number[] = [];
    for (const s of awake) {
      const d = s.doing;
      if (!d || seen.has(d)) continue;
      seen.add(d);
      if (d.kind === "shower" || d.kind === "wash") expect(d.priority).toBe(1);
      else xs.push(d.priority);
    }
    const share = (lo: number, hi: number) =>
      xs.filter((x) => x >= lo && x < hi).length / xs.length;
    for (let lo = 0; lo < 1; lo += 0.25)
      expect(Math.abs(share(lo, lo + 0.25) - 0.25)).toBeLessThan(0.05);
  });

  it("a private message of NSV rank q is held back about 1 − q of her waking time (plus the phone-away minutes)", () => {
    const after = awake.filter((s) => s.at - local(0) >= H);
    const away = after.filter((s) => s.doing?.kind === "shower" || s.doing?.kind === "wash").length;
    for (const q of [0.25, 0.5, 0.75]) {
      const held = after.filter((s) => busyCost(s, s.at) > priorityCost(q)).length;
      const expected = (1 - q) * (1 - away / after.length) + away / after.length;
      expect(Math.abs(held / after.length - expected)).toBeLessThan(0.05);
    }
  });

  it("says what she has on hand, and what she just finished when she only picked something up", () => {
    const at = local(19);
    for (const [kind, words] of [
      ["phone", "我在刷手机"],
      ["read", "我在看书"],
      ["tidy", "我在收拾屋子"],
      ["music", "我在听歌"],
    ] as const) {
      const life: LifeState = {
        ...emptyLife,
        at,
        doing: { kind, from: at, until: at + 10 * MIN, priority: 0.5 },
      };
      expect(
        lifeFacts(life, at + MIN)
          .map((c) => c.text)
          .join(),
      ).toContain(words);
    }
    const meal = { kind: "meal" as const, from: at - 40 * MIN, until: at, priority: 0.3 };
    const after: LifeState = {
      ...emptyLife,
      at,
      doing: { kind: "phone", from: at, until: at + 10 * MIN, priority: 0.5 },
      done: meal,
    };
    const text = lifeFacts(after, at + MIN)
      .map((c) => c.text)
      .join();
    expect(text).toContain("我刚吃完饭");
    expect(text).toContain("我在刷手机");
  });
});

describe("candidate life-l2-glance: she glances at her phone between bits of what she is doing", () => {
  const plain = days(60, 20261111, { fill: true });
  const glancing = days(60, 20261111, { fill: true, glance: true });

  it("glances about Andrews' 46.6 times a day, only while carrying on with something she can glance from", () => {
    const seen = glancing.filter((s) => s.glanceAt !== undefined);
    expect(seen.length / 60).toBeGreaterThan(GLANCE.perDay * 0.9);
    expect(seen.length / 60).toBeLessThan(GLANCE.perDay * 1.1);
    for (const s of seen) {
      const d = s.doing;
      if (!d || ["phone", "shower", "wash"].includes(d.kind) || isAsleep(s.at))
        throw new Error(`glance while ${d?.kind ?? "idle"} at ${s.at}`);
      expect(s.glanceAt).toBeGreaterThanOrEqual(s.at);
      expect(s.glanceAt).toBeLessThan(s.at + NOISE_EVERY_MS);
    }
    // 瞄一眼不改她的一天。
    expect(glancing.map(({ glanceAt: _, ...s }) => s)).toEqual(plain);
    expect(plain.some((s) => s.glanceAt !== undefined)).toBe(false);
  });

  it("the 15 seconds of a glance cost nothing; before and after, what she is doing costs as usual", () => {
    const s = glancing.find((x) => x.glanceAt !== undefined && x.doing && x.doing.priority > 0.5);
    if (!s || s.glanceAt === undefined || !s.doing) throw new Error("no glance");
    const full = priorityCost(s.doing.priority);
    expect(busyCost(s, s.glanceAt)).toBe(0);
    expect(busyCost(s, s.glanceAt + GLANCE.ms - 1)).toBe(0);
    expect(busyCost(s, s.glanceAt + GLANCE.ms)).toBe(full);
    if (s.glanceAt > s.at) expect(busyCost(s, s.glanceAt - 1)).toBe(full);
  });
});
