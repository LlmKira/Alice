/**
 * 她的身体（ADR-276 环节一）：睡眠压力跟着真实的睡醒走、饿改变吃饭的优先级、外面那几类的事，
 * 以及 HackerNews 热门的抓取（llm/hn.ts）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchHnTop } from "../src/llm/hn.js";
import { initialAffect, valenceAt } from "../src/mechanisms/pressure/affect.js";
import { PRODUCTION, worldFold } from "../src/mechanisms/pressure/index.js";
import type { LifeState } from "../src/mechanisms/pressure/life.js";
import {
  advanceSleep,
  awakeDurationBetween,
  bodyBusyCost,
  bodyFacts,
  bodyGlancing,
  bodyMoodNudge,
  bodyOf,
  createLifeBody,
  type DynamicSleepState,
  emptyBody,
  fallAsleep,
  hungerAt,
  isAsleepAt,
  LIFE_BODY_SLOTS,
  type LifeBodyState,
  lifeBody,
  mealPriorityBoost,
  nextWakeAt,
  reduceBody,
  sleepDepthAt,
  sleepPressureAt,
  wakeUp,
} from "../src/mechanisms/pressure/life-body.js";
import { phone } from "../src/mechanisms/pressure/phone.js";
import { emptyWorld, type World } from "../src/mechanisms/pressure/world.js";
import type { AliceEvent } from "../src/mind/events.js";
import { normalCdf } from "../src/mind/noise.js";
import { emptyChat } from "../src/mind/state.js";

const MIN = 60_000;
const H = 60 * MIN;
/** 本地（东八区）2026-02-20 0 点。 */
const MIDNIGHT = Date.parse("2026-02-20T00:00:00+08:00");
const local = (h: number, m = 0) => MIDNIGHT + h * H + m * MIN;
const DM = "telegram:1";

/** 醒着的睡眠状态：at 时刻的 S 给定，不知道之前的历史。 */
const awake = (at: number, s: number): DynamicSleepState => ({
  at,
  s,
  asleepSince: null,
  wokeAt: at,
  awakeUntil: at,
  rests: [],
});

/** 身体状态：默认醒着、两小时前吃过一点、手上没事。 */
function bodyAt(now: number, o: Partial<LifeBodyState> = {}): LifeBodyState {
  return {
    ...emptyBody,
    at: now,
    sleep: awake(now, 0.4),
    hunger: { at: now - 2 * H, hunger: 0.2, lastMealAt: now - 2 * H },
    ...o,
  };
}

const worldOf = (life: LifeBodyState): World => ({
  ...emptyWorld,
  life: life as unknown as LifeState,
});

const reduceFeature = (before: World, event: AliceEvent): World =>
  (lifeBody.reduce as (b: World, a: World, e: AliceEvent) => World)(before, before, event);

const noise = (at: number, draws: Record<string, number> = {}): AliceEvent => ({
  type: "noise.drawn",
  at,
  scope: "self",
  draws,
});

/** 一直醒着：每半小时她动一次（回过话、看过手机），所以不会在阈值上睡过去。 */
function stayingUp(state: DynamicSleepState, from: number, to: number): DynamicSleepState {
  let s = state;
  for (let t = from + 30 * MIN; t <= to; t += 30 * MIN) s = wakeUp(advanceSleep(s, t), t);
  return s;
}

describe("dynamic Borbély sleep", () => {
  it("staying up raises sleep pressure and pushes the natural wake-up later", () => {
    const base = awake(local(10), 0.25);
    // 23:00 就去睡。
    const early = fallAsleep(advanceSleep(base, local(23)), local(23));
    const earlyWake = nextWakeAt(early, local(23));
    // 聊到凌晨 3 点，每半小时动一次（她醒着，S 继续升）。
    const late = fallAsleep(
      stayingUp(advanceSleep(base, local(23)), local(23), local(27)),
      local(27),
    );
    const lateWake = nextWakeAt(late, local(27));

    expect(sleepPressureAt(late, local(27))).toBeGreaterThan(sleepPressureAt(early, local(27)));
    expect(earlyWake).not.toBeNull();
    expect(lateWake).not.toBeNull();
    expect(lateWake as number).toBeGreaterThan((earlyWake as number) + H);
  });

  it("sleeps deeper and counts only awake time as ageing", () => {
    const base = awake(local(10), 0.25);
    const early = fallAsleep(advanceSleep(base, local(23)), local(23));
    const late = fallAsleep(
      stayingUp(advanceSleep(base, local(23)), local(23), local(27)),
      local(27),
    );

    expect(sleepDepthAt(late, local(29))).toBeGreaterThan(sleepDepthAt(early, local(29)));
    expect(sleepDepthAt(base, local(12))).toBe(0);
    expect(awakeDurationBetween(base, local(12), local(13))).toBe(H);
    // 23:00 到 6:00 她睡着，消息不变旧。
    expect(awakeDurationBetween(early, local(23), local(30))).toBe(0);
    // 熬夜到 3 点的那一段都醒着。
    expect(awakeDurationBetween(late, local(23), local(27))).toBe(4 * H);
    expect(isAsleepAt(early, local(26))).toBe(true);
    expect(isAsleepAt(base, local(16))).toBe(false);
  });

  it("predicts exactly the wake-up it will take", () => {
    const early = fallAsleep(advanceSleep(awake(local(10), 0.25), local(23)), local(23));
    const wake = nextWakeAt(early, local(23)) as number;
    expect(isAsleepAt(early, wake - MIN)).toBe(true);
    expect(isAsleepAt(early, wake)).toBe(false);
  });

  it("uses sleep.ts's wording when she is asleep", () => {
    const asleep = bodyAt(local(26), {
      sleep: fallAsleep(awake(local(23), 0.6), local(23)),
    });
    const fact = bodyFacts(asleep, local(26), true)[0];
    expect(fact?.mechanism).toBe("pressure-life-body");
    expect(fact?.text).toBe("我本来在睡觉，被消息吵醒了。");
  });

  it("offers go_to_bed at any hour (a daytime nap is not locked out)", () => {
    const world = worldOf(bodyAt(local(15)));
    for (const t of [local(3), local(15), local(23)]) {
      expect(lifeBody.offers?.("bed", DM, world, t)).toBe(true);
    }
  });

  it("folds go_to_bed into the world and the body", () => {
    const before = worldOf(bodyAt(local(15), { sleep: awake(local(15), 0.6) }));
    const after = reduceFeature(before, {
      type: "act.done",
      at: local(15),
      scope: DM,
      act: { kind: "bed" },
    });
    expect(after.bedAt).toBe(local(15));
    expect(isAsleepAt(bodyOf(after.life).sleep, local(15, 10))).toBe(true);
    expect(isAsleepAt(bodyOf(before.life).sleep, local(15, 10))).toBe(false);
  });
});

describe("hunger", () => {
  it("grows over hours and raises the priority of eating", () => {
    const h = { at: local(12), hunger: 0, lastMealAt: local(12) };
    expect(hungerAt(h, local(17))).toBeCloseTo(1 - Math.exp(-1), 2);
    expect(hungerAt(h, local(20))).toBeGreaterThan(hungerAt(h, local(15)));
    expect(mealPriorityBoost(0.95)).toBeGreaterThan(mealPriorityBoost(0.6));
    expect(mealPriorityBoost(0.6)).toBeGreaterThan(0);
    expect(mealPriorityBoost(0.2)).toBe(0);
  });

  it("is reset deterministically when the meal ends", () => {
    const eating = bodyAt(local(12), {
      hunger: { at: local(12), hunger: 0.55, lastMealAt: local(7) },
      doing: { kind: "meal", from: local(12), until: local(12, 40), priority: 0.5 },
    });
    const after = reduceBody(eating, { type: "clock.tick", at: local(12, 50) });
    expect(after.hunger.lastMealAt).toBe(local(12, 40));
    expect(hungerAt(after.hunger, local(12, 50))).toBeLessThan(0.05);
    expect(hungerAt(after.hunger, local(18))).toBeGreaterThan(0.5);
    // 被叫去睡打断的那一顿不算吃完。
    const interrupted = reduceBody(eating, {
      type: "act.done",
      at: local(12, 20),
      scope: DM,
      act: { kind: "bed" },
    });
    expect(interrupted.hunger.lastMealAt).toBe(local(7));
  });

  it("starts a meal on the next grid when she is very hungry", () => {
    const idle = bodyAt(local(15), { hunger: { at: local(9), hunger: 0, lastMealAt: local(9) } });
    const hungry = hungerAt(idle.hunger, local(15));
    const fed = reduceBody(idle, noise(local(15), { life: 0.7 }));
    expect(fed.doing?.kind).toBe("meal");
    expect(fed.doing?.priority ?? 0).toBeGreaterThanOrEqual(mealPriorityBoost(hungry));
  });

  it("does not start a second meal right after eating", () => {
    const justAte = bodyAt(local(12, 5), {
      sleep: awake(local(12, 5), 0.5),
      hunger: { at: local(12), hunger: 0, lastMealAt: local(12) },
    });
    const skipped = reduceBody(justAte, noise(local(12, 10), { life: -2 }), { fill: false });
    expect(skipped.doing).toBeNull();
    // 同样一刻，但上一顿是四小时前：早午饭照常开。
    const hungryAgain = bodyAt(local(12, 5), {
      sleep: awake(local(12, 5), 0.5),
      hunger: { at: local(8), hunger: 0, lastMealAt: local(8) },
    });
    const meal = reduceBody(hungryAgain, noise(local(12, 10), { life: -2 }), { fill: false });
    expect(meal.doing?.kind).toBe("meal");
  });

  it("writes hunger and food as somatic facts", () => {
    const hungry = bodyAt(local(14), {
      hunger: { at: local(8), hunger: 0, lastMealAt: local(8) },
    });
    expect(bodyFacts(hungry, local(14), false)[0]?.text).toContain("我有点饿了");
    const very = bodyAt(local(18), {
      hunger: { at: local(8), hunger: 0, lastMealAt: local(8) },
    });
    expect(bodyFacts(very, local(18), false)[0]?.text).toContain("我饿得不行了");
    const justAte = bodyAt(local(12, 55), {
      hunger: { at: local(12, 45), hunger: 0, lastMealAt: local(12, 45) },
      done: { kind: "meal", from: local(12), until: local(12, 45), priority: 0.5 },
    });
    expect(bodyFacts(justAte, local(12, 55), false)[0]?.text).toContain("我刚吃完饭");
    const sleepy = bodyAt(local(25), { sleep: awake(local(25), 0.72) });
    const sleepyText = bodyFacts(sleepy, local(25), true)[0]?.text ?? "";
    expect(sleepyText).toContain("困得不行了");
    expect(sleepyText).not.toContain("有点累，没什么精神");
    const mildSleepy = bodyAt(local(25), { sleep: awake(local(25), 0.59) });
    const mildText = bodyFacts(mildSleepy, local(25), true)[0]?.text ?? "";
    expect(mildText).toContain("有点困了");
    expect(mildText).not.toContain("有点累，没什么精神");
  });

  it("nudges her mood down, within bounds", () => {
    const fine = bodyAt(local(14), {
      sleep: awake(local(14), 0.3),
      hunger: { at: local(13), hunger: 0, lastMealAt: local(13) },
    });
    expect(bodyMoodNudge(fine, local(14))).toBe(0);
    const drained = bodyAt(local(25), {
      sleep: awake(local(25), 0.75),
      hunger: { at: local(14), hunger: 0, lastMealAt: local(14) },
    });
    const nudge = bodyMoodNudge(drained, local(25));
    expect(nudge).toBeLessThan(0);
    expect(nudge).toBeGreaterThanOrEqual(-0.2);
  });

  it("still writes her energy and sociability", () => {
    const tired = bodyAt(local(14), { energy: -2 });
    expect(bodyFacts(tired, local(14), false)[0]?.text).toContain("有点累");
    const quiet = bodyAt(local(14), { social: -2 });
    expect(bodyFacts(quiet, local(14), false)[0]?.text).toContain("犯懒");
    const chatty = bodyAt(local(14), { social: 2 });
    expect(bodyFacts(chatty, local(14), false)[0]?.text).toContain("挺想找人聊聊天");
  });

  it("says nothing about a body that has never been folded", () => {
    expect(bodyFacts(emptyBody, local(14), false)).toEqual([]);
    expect(bodyMoodNudge(emptyBody, local(14))).toBe(0);
  });
});

describe("her parallel world", () => {
  const at = local(17);
  const textOf = (o: Partial<LifeBodyState>): string =>
    bodyFacts(bodyAt(at, { sleep: { ...awake(at, 0.4), wokeAt: local(10) }, ...o }), at, true)
      .map((c) => c.text)
      .join("\n");

  it("says where she is in her own world, outdoors included", () => {
    expect(
      textOf({
        doing: { kind: "eat_out", from: local(16, 50), until: local(17, 20), priority: 0.5 },
      }),
    ).toContain("我在外面吃饭，刚拿起手机看了一眼");
    expect(
      textOf({ doing: { kind: "walk", from: local(16, 50), until: local(17, 20), priority: 0.5 } }),
    ).toContain("我在外面散步，顺手看了一眼手机");
    expect(
      textOf({ doing: { kind: "shop", from: local(16, 50), until: local(17, 20), priority: 0.5 } }),
    ).toContain("我在逛街，顺手看了眼消息");
    expect(
      textOf({ done: { kind: "walk", from: local(16, 10), until: local(16, 40), priority: 0.5 } }),
    ).toContain("我刚在外面散完步回来");
  });

  it("keeps the time-use slots and adds the outdoor ones", () => {
    const kinds = new Set(LIFE_BODY_SLOTS.map((s) => s.kind));
    for (const kind of [
      "wash",
      "meal",
      "snack",
      "shower",
      "game",
      "show",
      "walk",
      "eat_out",
      "shop",
      "cafe",
    ] as const) {
      expect(kinds.has(kind)).toBe(true);
    }
  });

  it("never implies she can come over to the people she talks to", () => {
    const text = textOf({
      doing: { kind: "walk", from: local(16, 50), until: local(17, 20), priority: 0.5 },
    });
    for (const phrase of ["找你", "见你", "过去", "过来"]) expect(text).not.toContain(phrase);
  });
});

describe("HackerNews top stories (llm/hn.ts)", () => {
  const BASE = "https://hacker-news.firebaseio.com/v0";

  const stub = (pages: Record<string, unknown>) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const body = pages[String(input)];
        return body === undefined
          ? { ok: false, status: 404, json: async () => null }
          : { ok: true, status: 200, json: async () => body };
      }),
    );
  };

  afterEach(() => vi.unstubAllGlobals());

  it("parses top stories and skips jobs and untitled items", async () => {
    stub({
      [`${BASE}/topstories.json`]: [11, 12, 13],
      [`${BASE}/item/11.json`]: {
        type: "story",
        title: " Show HN: a thing ",
        url: "https://x.test/a",
      },
      [`${BASE}/item/12.json`]: { type: "job", title: "Hiring", url: "https://x.test/job" },
      [`${BASE}/item/13.json`]: { type: "story", title: "Ask HN: no link" },
    });
    expect(await fetchHnTop(5)).toEqual([
      { id: "11", title: "Show HN: a thing", url: "https://x.test/a" },
      { id: "13", title: "Ask HN: no link", url: "https://news.ycombinator.com/item?id=13" },
    ]);
  });

  it("returns at most limit stories", async () => {
    stub({
      [`${BASE}/topstories.json`]: [21, 22, 23],
      [`${BASE}/item/21.json`]: { type: "story", title: "one", url: "https://x.test/1" },
      [`${BASE}/item/22.json`]: { type: "story", title: "two", url: "https://x.test/2" },
      [`${BASE}/item/23.json`]: { type: "story", title: "three", url: "https://x.test/3" },
    });
    expect((await fetchHnTop(2)).map((s) => s.id)).toEqual(["21", "22"]);
  });

  it("skips an item that fails to load", async () => {
    stub({
      [`${BASE}/topstories.json`]: [31, 32],
      [`${BASE}/item/32.json`]: { type: "story", title: "only one", url: "https://x.test/2" },
    });
    expect((await fetchHnTop(1)).map((s) => s.id)).toEqual(["32"]);
  });

  it("returns [] instead of throwing on network or format errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(await fetchHnTop(3)).toEqual([]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ not: "a list" }) })),
    );
    expect(await fetchHnTop(3)).toEqual([]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("bad json");
        },
      })),
    );
    expect(await fetchHnTop(3)).toEqual([]);
  });
});

describe("the feature contract", () => {
  it("prices the thing in her hands for the will layer", () => {
    const idle = bodyAt(local(15));
    expect(lifeBody.will?.busy?.(worldOf(idle), local(15))).toBe(0);
    const showering = bodyAt(local(15), {
      doing: { kind: "shower", from: local(15), until: local(15, 30), priority: 1 },
    });
    expect(lifeBody.will?.busy?.(worldOf(showering), local(15))).toBeGreaterThan(0);
  });

  it("owns life and bedAt, and contributes her body to the prompt", () => {
    expect(lifeBody.provides).toEqual(["life", "bedAt"]);
    expect(lifeBody.affordances).toEqual(["bed"]);
    const body = bodyAt(local(14), {
      sleep: { ...awake(local(14), 0.4), wokeAt: local(10) },
      hunger: { at: local(8), hunger: 0, lastMealAt: local(8) },
    });
    const text = (
      lifeBody.contribute?.({
        world: worldOf(body),
        chat: emptyChat(DM, "private", true),
        now: local(14),
        sought: false,
        outside: false,
        offered: [],
      }) ?? []
    )
      .map((c) => c.text)
      .join("\n");
    expect(text).toContain("我有点饿了");
  });

  it("pushes hunger and sleepiness onto affect.bodyOffset via lifeBody, and lifts sociability from warm affect", () => {
    const fold = worldFold({ ...PRODUCTION, sleep: undefined, life: lifeBody });
    const t0 = local(8);
    let world = fold(emptyWorld, {
      type: "noise.drawn",
      scope: "self",
      at: t0,
      draws: { life: 0, "life-length": 0, mood: 0 },
    });
    const tHungry = t0 + 8 * H;
    world = fold(world, {
      type: "noise.drawn",
      scope: "self",
      at: tHungry,
      draws: { life: 0.99, "life-length": 0, mood: 0 },
    });
    expect(world.affect.bodyOffset ?? 0).toBeLessThan(0);
    expect(world.affect.bodyOffset ?? 0).toBeGreaterThanOrEqual(-0.2);
    expect(valenceAt(world.affect, tHungry)).toBeLessThan(world.affect.home);

    const warmWorld: World = {
      ...world,
      affect: { ...initialAffect, at: tHungry, home: 0.19, valence: 0.85 },
    };
    const warmText = (
      lifeBody.contribute?.({
        world: warmWorld,
        chat: emptyChat(DM, "private", true),
        now: tHungry,
        sought: false,
        outside: false,
        offered: [],
      }) ?? []
    )
      .map((c) => c.text)
      .join("\n");
    expect(warmText).toContain("挺想找人聊聊天");
  });

  it("glances at her phone during non-phone activities with zero busy cost and scans chats", () => {
    const t0 = local(15);
    const reading = bodyAt(t0, {
      sleep: { ...awake(t0, 0.4), wokeAt: local(10) },
      doing: { kind: "read", from: t0 - 5 * MIN, until: t0 + 25 * MIN, priority: 0.9 },
    });
    expect(bodyBusyCost(reading, t0)).toBeGreaterThan(0);
    const gAt = t0 + 2_000;
    const glancingBody = { ...reading, glanceAt: gAt };
    expect(bodyGlancing(glancingBody, gAt + 5_000)).toBe(true);
    expect(bodyBusyCost(glancingBody, gAt + 5_000)).toBe(0);
    expect(
      lifeBody.scans?.({ ...emptyWorld, life: glancingBody as unknown as LifeState }, gAt + 5_000),
    ).toBe(true);
    expect(bodyGlancing(glancingBody, gAt + 20_000)).toBe(false);
  });

  it("modulates busy cost by urgency under phi-half mode while keeping no-phone activities unscaled", () => {
    const t0 = local(15);
    const phone = bodyAt(t0, {
      doing: { kind: "phone", from: t0 - 5 * MIN, until: t0 + 10 * MIN, priority: 0.7 },
    });
    expect(bodyBusyCost(phone, t0, {}, "phi-half")).toBeGreaterThan(0);
    expect(bodyBusyCost(phone, t0, { obliged: true }, "phi-half")).toBe(0);
    expect(bodyBusyCost(phone, t0, { continuing: true }, "phi-half")).toBe(0);

    const reading = bodyAt(t0, {
      doing: { kind: "read", from: t0 - 5 * MIN, until: t0 + 25 * MIN, priority: 0.8 },
    });
    const coldRead = bodyBusyCost(reading, t0, {}, "phi-half");
    const turnRead = bodyBusyCost(reading, t0, { continuing: true }, "phi-half");
    const dirRead = bodyBusyCost(reading, t0, { obliged: true }, "phi-half");
    expect(turnRead).toBeLessThan(coldRead);
    expect(dirRead).toBe(turnRead);

    const shower = bodyAt(t0, {
      doing: { kind: "shower", from: t0 - 5 * MIN, until: t0 + 20 * MIN, priority: 1 },
    });
    expect(bodyBusyCost(shower, t0, { obliged: true }, "phi-half")).toBe(
      bodyBusyCost(shower, t0, {}, "phi-half"),
    );
  });
});

describe("phoneWeight (how often an idle moment goes to scrolling)", () => {
  /** 标准正态的分位点（二分 normalCdf）：让 life 抽样在 [0,1) 上均匀地铺开。 */
  const probit = (p: number): number => {
    let lo = -8;
    let hi = 8;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (normalCdf(mid) < p) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const GRID = Array.from({ length: 900 }, (_, i) => probit((i + 0.5) / 900));
  const FILLER_KINDS = new Set(["phone", "read", "tidy", "music"]);

  /** 下午三点手上没事：每个抽样开始哪一件；随手事里刷手机占几成。 */
  function phoneShare(o: { phoneWeight?: number }): { share: number; kinds: string[] } {
    const kinds = GRID.map(
      (z) => reduceBody(bodyAt(local(15)), noise(local(15), { life: z }), o).doing?.kind ?? "-",
    );
    const fillers = kinds.filter((k) => FILLER_KINDS.has(k));
    return { share: fillers.filter((k) => k === "phone").length / fillers.length, kinds };
  }

  it("lowers the phone share to its weight; without it the draws are unchanged", () => {
    const base = phoneShare({});
    expect(base.share).toBeCloseTo(6 / 9, 1);
    expect(phoneShare({ phoneWeight: 6 }).kinds).toEqual(base.kinds);
    const low = phoneShare({ phoneWeight: 2 });
    expect(low.share).toBeCloseTo(2 / 5, 1);
    // 只改随手事里怎么分：时段里的事、饭照旧在同样的抽样上开始。
    const scheduled = (ks: string[]) => ks.map((k) => (FILLER_KINDS.has(k) ? "filler" : k));
    expect(scheduled(low.kinds)).toEqual(scheduled(base.kinds));
  });

  it("the feature passes it through and leaves the phone mechanism's state alone", () => {
    const low = createLifeBody({ phoneWeight: 2 });
    expect(low.provides).toEqual(lifeBody.provides);
    expect(low.name).toBe(lifeBody.name);
    const run = (life: typeof lifeBody) => {
      const fold = worldFold({ life, phone });
      let w = emptyWorld;
      for (let t = local(9); t < local(21); t += 5 * MIN) {
        w = fold(w, noise(t, { life: probit(((t / MIN) % 97) / 97 + 0.005), pickup: 0 }));
      }
      return w;
    };
    const a = run(lifeBody);
    const b = run(low);
    expect(b.phone).toEqual(a.phone);
    const kindsSeen = (w: World) => bodyOf(w.life).doing?.kind;
    expect(kindsSeen(b)).toBeDefined();
    expect(createLifeBody({}).name).toBe(lifeBody.name);
  });
});
