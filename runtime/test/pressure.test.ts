/**
 * 压力场的忠实度性质（eval-artifacts/trigger/pressure-fidelity.md）：
 * 有界、向基线衰减、对该抬高的事件有响应、行动被压住时不积分饱和、关系层级效应、主动联系的时机窗、
 * 反应通道（冷落抬高回避、有回应的互动才缓解关系需求）、意愿的排序。
 */
import { describe, expect, it } from "vitest";
import type { WillAffordance } from "../src/mechanisms/pressure/affordances.js";
import { DRIVES } from "../src/mechanisms/pressure/drives.js";
import { createPressure, relation, worldFold } from "../src/mechanisms/pressure/index.js";
import { TIER_THETA, type Tier } from "../src/mechanisms/pressure/params.js";
import { BARE_WILL, rankIntentions, readChat } from "../src/mechanisms/pressure/will.js";
import { emptyWorld, isTurn, reduceWorld, type World } from "../src/mechanisms/pressure/world.js";
import { mechanisms } from "../src/mechanisms/registry.js";
import { affordances as standInAffordances } from "../src/mind/affordances.js";
import type { AliceEvent, MessageReceived, MessageSent } from "../src/mind/events.js";
import { emptyState } from "../src/mind/state.js";
import { step } from "../src/mind/step.js";
import { replay } from "../src/sim/replay.js";
import { directedWake } from "./directed-wake.js";

const T0 = 1_771_000_000_000;
const MIN = 60_000;
const H = 3_600_000;
const D = 24 * H;
/** 只有意愿层的压力场（没有记忆、作息这些部分）。 */
const pressure = createPressure(standInAffordances);

let n = 0;
function msg(at: number, o: Partial<MessageReceived> = {}): MessageReceived {
  n++;
  const scope = o.scope ?? "telegram:1";
  return {
    type: "message.received",
    at,
    scope,
    chatType: scope.startsWith("telegram:-") ? "group" : "private",
    messageId: `m${n}`,
    senderId: o.senderId ?? "contact:1",
    senderName: "池塘",
    text: "hi",
    contentType: "text",
    replyToMessageId: null,
    directed: !scope.startsWith("telegram:-"),
    ...o,
  };
}
function sent(at: number, scope = "telegram:1"): MessageSent {
  n++;
  return { type: "message.sent", at, scope, messageId: `s${n}`, text: "嗯", kind: "text" };
}
function silent(at: number, scope = "telegram:1"): AliceEvent {
  return {
    type: "speech.decided",
    at,
    scope,
    callId: `${scope}#x`,
    decision: { acts: [] },
  };
}
/** 世界 fold 加上按人记的关系（relation）：看见的事实与有往来都 fold 进 relations。 */
const fold = (events: AliceEvent[], from: World = emptyWorld) =>
  events.reduce(worldFold({ relation }), from);
const tiersOf = (t: Tier) => (): Tier => t;

/** 确定性的伪随机数（测试里也不用 Math.random，保证可复现）。 */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** 随机的一个事件：多是别人的消息，也有她发的、她沉默、时钟格。 */
function randomEvent(rnd: () => number, t: number, scope: string): AliceEvent {
  const r = rnd();
  if (r < 0.6)
    return msg(t, { scope, senderId: `contact:${Math.floor(rnd() * 8)}`, directed: rnd() < 0.3 });
  if (r < 0.8) return sent(t, scope);
  return r < 0.95 ? silent(t, scope) : { type: "clock.tick", at: t };
}

/** 每个候选的 NSV 有限、有界，每个会话的每个驱动归一化后在 [0,1)（回避另说）。 */
function expectBounded(w: World, t: number): void {
  for (const c of rankIntentions(w, standInAffordances, t)) {
    expect(Number.isFinite(c.nsv)).toBe(true);
    // ΔP ≤ 可缓解的驱动数；代价有上界（C_social ≤ 1 + 回避 1，C_sat ≤ 7，λ ≤ 1.5）
    expect(c.relief).toBeLessThanOrEqual(DRIVES.length);
    expect(c.nsv).toBeGreaterThan(-1.5 * (2 + 7));
  }
  for (const s of Object.keys(w.chats)) {
    const reading = readChat(w, s, t);
    for (const k of DRIVES) {
      // 回避可以低于 0（被接得多的群里她更敢开口，PLAN 第 43 件），最低 tanh(-0.5)。
      expect(reading?.normalized[k]).toBeGreaterThanOrEqual(k === "aversion" ? Math.tanh(-0.5) : 0);
      expect(reading?.normalized[k]).toBeLessThan(1);
    }
  }
}

describe("pressure field: boundedness (BIBO)", () => {
  it("keeps every normalized drive in [0,1), propensity in (0,1) and NSV bounded under random input", () => {
    const rnd = lcg(7);
    const scopes = ["telegram:1", "telegram:2", "telegram:-5", "telegram:-6"];
    let w = emptyWorld;
    let t = T0;
    for (let i = 0; i < 3000; i++) {
      t += Math.floor(rnd() * 20 * MIN);
      const scope = scopes[Math.floor(rnd() * scopes.length)] as string;
      w = reduceWorld(w, randomEvent(rnd, t, scope));
      if (i % 50 === 0) expectBounded(w, t);
    }
  });
});

describe("pressure field: decay toward baseline", () => {
  it("lets obligation fade with a one-hour half-life and attention fall back to the tonic floor", () => {
    const w = fold([msg(T0), msg(T0 + 1000)]);
    const at = (dt: number) => readChat(w, "telegram:1", T0 + dt, tiersOf(50));
    expect(at(H)?.raw.obligation).toBeCloseTo((at(0)?.raw.obligation ?? 0) / 2, 1);
    expect(at(10 * H)?.raw.obligation).toBeLessThan(0.01);
    // 未读还在：phasic 消退后剩下 tonic 地板 ln(1+2)·w·3
    expect(at(10 * H)?.raw.attention).toBeCloseTo(Math.log(3) * 1.5 * 3, 5);
  });

  it("lets saturation costs and aversion decay to zero", () => {
    const w = fold([
      msg(T0, { scope: "telegram:-5" }),
      sent(T0 + MIN, "telegram:-5"),
      ...Array.from({ length: 5 }, (_, i) =>
        msg(T0 + 4 * MIN + i * 1000, { scope: "telegram:-5", senderId: "contact:9" }),
      ),
      { type: "clock.tick", at: T0 + 15 * MIN },
    ]);
    const near = rankIntentions(w, standInAffordances, T0 + 15 * MIN).find(
      (c) => c.affordance === "send",
    );
    const far = rankIntentions(w, standInAffordances, T0 + 3 * D).find(
      (c) => c.affordance === "send",
    );
    // 没人接，按这个群平时被接的比例居中加一笔（PLAN 第 43 件；这里只有一个人的一轮，比例的先验是 1/3）。
    expect(readChat(w, "telegram:-5", T0 + 15 * MIN)?.raw.aversion).toBeGreaterThan(0.2);
    expect(readChat(w, "telegram:-5", T0 + 3 * D)?.raw.aversion).toBeLessThan(0.01);
    expect(near?.saturation.total).toBeGreaterThan(far?.saturation.total ?? 1);
    const s = far?.saturation;
    expect((s?.rate ?? 1) + (s?.cool ?? 1) + (s?.fail ?? 1)).toBeLessThan(0.05);
    // Nobody answered that line (others only chatted on, minutes later): in a group the evidence fades at the
    // group's own pace (PLAN item 43), not over weeks as in a private chat.
    expect(s?.out).toBeLessThan(0.01);
  });
});

describe("pressure field: response to the events that should raise each drive", () => {
  it("raises attention with unread messages, obligation and a thread with a directed one", () => {
    const g = fold([msg(T0, { scope: "telegram:-5" }), msg(T0 + 1000, { scope: "telegram:-5" })]);
    expect(readChat(g, "telegram:-5", T0 + 2000)?.raw.attention).toBeGreaterThan(0);
    expect(readChat(g, "telegram:-5", T0 + 2000)?.raw.obligation).toBe(0);
    const d = fold([msg(T0, { scope: "telegram:-5", directed: true })]);
    const r = readChat(d, "telegram:-5", T0 + D);
    expect(r?.raw.thread).toBeGreaterThan(0);
    // 线程超线性增长：第二天的增量大于第一天
    const r2 = readChat(d, "telegram:-5", T0 + 2 * D);
    expect((r2?.raw.thread ?? 0) - (r?.raw.thread ?? 0)).toBeGreaterThan(r?.raw.thread ?? 0);
  });

  it("raises cooling with silence; reaching out satisfies the urge for a while but not the bond", () => {
    const w = fold([msg(T0), sent(T0 + MIN)]);
    const before = readChat(w, "telegram:1", T0 + 2 * H, tiersOf(5))?.raw.cooling ?? 0;
    expect(before).toBeGreaterThan(
      readChat(w, "telegram:1", T0 + 10 * MIN, tiersOf(5))?.raw.cooling ?? 1,
    );
    // 她主动找了，对方没回：冲动从此刻重新长起（不会一分钟后再发一条），关系本身没有被满足。
    const ignoredOutreach = fold([sent(T0 + 2 * H)], w);
    expect(
      readChat(ignoredOutreach, "telegram:1", T0 + 2 * H + MIN, tiersOf(5))?.raw.cooling ?? 1,
    ).toBeLessThan(before / 2);
    expect(ignoredOutreach.relations.people["contact:1"]?.seen.lastAnswerAt).toBe(T0);
    expect(
      readChat(ignoredOutreach, "telegram:1", T0 + 4 * H, tiersOf(5))?.raw.cooling ?? 0,
    ).toBeGreaterThan(before / 2);
    const answered = fold([msg(T0 + 2 * H + 5 * MIN)], ignoredOutreach);
    expect(
      readChat(answered, "telegram:1", T0 + 2 * H + 6 * MIN, tiersOf(5))?.raw.cooling,
    ).toBeLessThan(0.1);
  });

  it("resets her unanswered streak only when someone answers her, not when the group chats on", () => {
    const g = "telegram:-5";
    const mine = sent(T0 + MIN, g);
    const talked = fold([
      msg(T0, { scope: g }),
      mine,
      msg(T0 + 4 * MIN, { scope: g, senderId: "contact:8" }),
    ]);
    expect(talked.chats[g]?.outgoing).toBe(1);
    const answered = fold(
      [msg(T0 + 5 * MIN, { scope: g, senderId: "contact:8", replyToMessageId: mine.messageId })],
      talked,
    );
    expect(answered.chats[g]?.outgoing).toBe(0);
  });

  it("classifies receptions: replied, ignored (others kept talking) and unheard (nobody there)", () => {
    const g = "telegram:-5";
    const replied = fold([
      msg(T0, { scope: g }),
      sent(T0 + MIN, g),
      msg(T0 + 2 * MIN, { scope: g, directed: true }),
    ]);
    expect(replied.chats[g]?.receptions.map((r) => r.kind)).toEqual(["replied"]);
    const ignored = fold([
      msg(T0, { scope: g }),
      sent(T0 + MIN, g),
      msg(T0 + 4 * MIN, { scope: g, senderId: "contact:7" }),
      { type: "clock.tick", at: T0 + 20 * MIN },
    ]);
    expect(ignored.chats[g]?.receptions.map((r) => r.kind)).toEqual(["ignored"]);
    // The next line right after hers, within UPTAKE_LINK, takes her up (the north-star rule, PLAN item 43).
    const adjacent = fold([
      msg(T0, { scope: g }),
      sent(T0 + MIN, g),
      msg(T0 + 2 * MIN, { scope: g, senderId: "contact:7" }),
    ]);
    expect(adjacent.chats[g]?.receptions.map((r) => r.kind)).toEqual(["taken"]);
    const unheard = fold([
      msg(T0, { scope: g }),
      sent(T0 + MIN, g),
      { type: "clock.tick", at: T0 + 20 * MIN },
    ]);
    expect(unheard.chats[g]?.receptions.map((r) => r.kind)).toEqual(["unheard"]);
    expect(unheard.chats[g]?.aversion).toBe(0);
  });
});

describe("pressure field: no windup when acting is suppressed", () => {
  it("does not wake a busy group on every tick when the model keeps choosing silence", async () => {
    const g = "telegram:-5";
    const events: AliceEvent[] = [sent(T0 - D, g)];
    for (let i = 0; i < 240; i++)
      events.push(msg(T0 + i * 30_000, { scope: g, senderId: `contact:${i % 6}` }));
    const result = await replay(events, {
      mechanisms: [pressure],
      speech: () => ({ acts: [] }),
      tickMs: MIN,
    });
    const calls = result.effects.filter((r) => r.effect.type === "call-speech").length;
    // 2 小时、240 条消息、120 个 tick：一直被拒绝时，σ_fail 与 habituation 让唤醒稀疏下来，而不是每条/每个 tick 都醒。
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThan(40);
    const firstHour = result.effects.filter(
      (r) => r.effect.type === "call-speech" && r.at < T0 + H,
    ).length;
    expect(calls - firstHour).toBeLessThanOrEqual(firstHour);
  });

  it("an explicit silent decision consumes the obligation and the thread, so nothing re-wakes", async () => {
    const g = "telegram:-5";
    const result = await replay(
      [
        msg(T0, { scope: g, directed: true }),
        msg(T0 + 3 * H, { scope: "telegram:2", senderId: "contact:2" }),
      ],
      {
        mechanisms: [pressure],
        speech: () => ({ acts: [] }),
        tickMs: MIN,
      },
    );
    const calls = result.effects.filter(
      (r) => r.effect.type === "call-speech" && r.effect.scope === g,
    );
    expect(calls.length).toBe(1);
  });

  it("paces a declined outreach softly instead of asking on every tick", async () => {
    const result = await replay(
      [msg(T0), msg(T0 + 6 * H, { scope: "telegram:2", senderId: "contact:2" })],
      {
        mechanisms: [pressure],
        speech: () => ({ acts: [] }),
        tickMs: MIN,
      },
    );
    const asks = result.effects
      .filter((r) => r.effect.type === "call-speech" && r.effect.scope === "telegram:1")
      .map((r) => r.at);
    // 关系冷却没被缓解（她没找对方），所以还会再想；但每次拒绝抬高 σ_fail，间隔至少十几分钟。
    for (let i = 1; i < asks.length; i++) {
      expect((asks[i] as number) - (asks[i - 1] as number)).toBeGreaterThanOrEqual(10 * MIN);
    }
    expect(asks.length).toBeLessThan(6 * 6);
  });
});

/** 一段私聊往来后她接了话，之后彼此沉默；按层级看主动联系的倾向随时间怎么变。 */
function outreach(tier: Tier, silence: number): number {
  const w = fold([msg(T0), sent(T0 + MIN)]);
  const send = rankIntentions(w, standInAffordances, T0 + MIN + silence, {
    ...BARE_WILL,
    tiers: tiersOf(tier),
  }).find((c) => c.affordance === "send");
  return send?.nsv ?? Number.NEGATIVE_INFINITY;
}

describe("pressure field: relationship tiers and the outreach window (calibration properties)", () => {
  it("reaches out to closer people sooner; with the current constants tiers 150/500 never do", () => {
    const firstPositive = (tier: Tier) => {
      for (let h = 0.25; h <= 24 * 30; h += 0.25) if (outreach(tier, h * H) > 0) return h;
      return null;
    };
    const t5 = firstPositive(5);
    const t15 = firstPositive(15);
    expect(t5).not.toBeNull();
    expect(t15).not.toBeNull();
    expect(t5 as number).toBeLessThan(t15 as number);
    expect(firstPositive(150)).toBeNull();
    expect(firstPositive(500)).toBeNull();
  });

  it("stays closed right after talking, opens around θ, and does not close again (no Feb goldilocks decay)", () => {
    const theta = TIER_THETA[5];
    expect(outreach(5, 0.2 * theta)).toBeLessThan(0);
    expect(outreach(5, 1.5 * theta)).toBeGreaterThan(0);
    let prev = outreach(5, theta);
    for (let k = 1.2; k <= 6; k += 0.4) {
      const v = outreach(5, k * theta);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
  });
});

describe("pressure field: habituation", () => {
  it("dampens attention to a chat she keeps looking at, but not the obligation", () => {
    const g = "telegram:-5";
    const base = fold([msg(T0, { scope: g, directed: true })]);
    const looked = fold(
      [
        silent(T0 + 1000, g),
        silent(T0 + 2000, g),
        silent(T0 + 3000, g),
        msg(T0 + 4000, { scope: g, directed: true }),
      ],
      base,
    );
    const a = readChat(fold([msg(T0 + 4000, { scope: g, directed: true })], base), g, T0 + 5000);
    const b = readChat(looked, g, T0 + 5000);
    expect(b?.habituation).toBeGreaterThan(0.5);
    expect(b?.normalized.attention).toBeLessThan(a?.normalized.attention ?? 0);
  });
});

const leave: WillAffordance = {
  kind: "leave-chat",
  appliesTo: ["chat"],
  available: (chat) => chat.chatType === "group",
  relieves: { aversion: 1 },
  intrusiveness: {
    private: { solicited: 0.5, unsolicited: 0.5 },
    group: { solicited: 0.5, unsolicited: 0.5 },
  },
  deliberate: true,
  gated: false,
};

describe("pressure field: the will over targets × affordances", () => {
  it("ranks every (chat, affordance) by NSV, highest first", () => {
    const w = fold([
      msg(T0),
      msg(T0 + 1000, { scope: "telegram:2", senderId: "contact:2" }),
      msg(T0 + 2000, { scope: "telegram:-5" }),
    ]);
    const ranked = rankIntentions(w, standInAffordances, T0 + 3000);
    expect(ranked.map((c) => c.nsv)).toEqual([...ranked.map((c) => c.nsv)].sort((a, b) => b - a));
    const positive = ranked.filter((c) => c.nsv > 0);
    expect(positive.length).toBeGreaterThan(0);
  });

  it("lets leaving a group emerge from being ignored there repeatedly, and never from warm replies", () => {
    const g = "telegram:-5";
    let ignored = fold([msg(T0, { scope: g })]);
    let warm = ignored;
    for (let i = 0; i < 6; i++) {
      const t = T0 + (i + 1) * 15 * MIN;
      ignored = fold(
        [
          sent(t, g),
          msg(t + 3 * MIN, { scope: g, senderId: "contact:8" }),
          { type: "clock.tick", at: t + 12 * MIN },
        ],
        ignored,
      );
      warm = fold(
        [sent(t, g), msg(t + MIN, { scope: g, senderId: "contact:8", directed: true })],
        warm,
      );
    }
    const at = T0 + 7 * 15 * MIN;
    const leaveOf = (w: World) =>
      rankIntentions(w, [...standInAffordances, leave], at).find(
        (c) => c.affordance === "leave-chat",
      );
    expect(leaveOf(ignored)?.nsv).toBeGreaterThan(0);
    expect(leaveOf(ignored)?.voice).toBe("caution");
    expect(leaveOf(warm)?.nsv).toBeLessThan(0);

    // Thought about leaving and stayed (said something instead): the urge regrows rather than waking her
    // again on the next rhythm step; the aversion itself, and so the cost of approaching, is unchanged.
    const stayed = fold(
      [
        {
          type: "speech.decided",
          at,
          scope: g,
          callId: `${g}#y`,
          decision: { acts: [{ kind: "send", text: "嗯", replyTo: null }] },
        },
      ],
      ignored,
    );
    expect(leaveOf(stayed)?.nsv).toBeLessThan(0);
    expect(stayed.chats[g]?.aversion).toBe(ignored.chats[g]?.aversion);
  });
});

describe("clock ticks reach mechanisms", () => {
  it("wakes only the top intention's chat on a tick and leaves message-only mechanisms untouched", () => {
    let state = emptyState;
    for (const e of [
      msg(T0),
      sent(T0 + MIN),
      msg(T0 + 2 * MIN, { scope: "telegram:2", senderId: "contact:2" }),
      sent(T0 + 3 * MIN, "telegram:2"),
    ]) {
      state = step(state, e, [pressure]).state;
    }
    const tick = step(state, { type: "clock.tick", at: T0 + 2 * D }, [pressure]);
    expect(tick.effects.filter((e) => e.type === "call-speech").length).toBeLessThanOrEqual(1);
    expect(step(state, { type: "clock.tick", at: T0 + 2 * D }, [directedWake]).effects).toEqual([]);
  });

  it("replay injects ticks at a fixed interval, in time order with timers, only between the first and last event", async () => {
    const ticks: number[] = [];
    await replay([msg(T0 + 30_000), msg(T0 + 5 * MIN)], {
      mechanisms: [directedWake],
      speech: () => null,
      tickMs: MIN,
      observe: (e) => {
        if (e.type === "clock.tick") ticks.push(e.at);
      },
    });
    expect(ticks).toEqual(
      [1, 2, 3, 4, 5]
        .map((k) => Math.ceil((T0 + 30_000) / MIN) * MIN + (k - 1) * MIN)
        .filter((t) => t <= T0 + 5 * MIN),
    );
  });
});

describe("self-regulation (will/prereg zero-cost estimate)", () => {
  it("in a group, others chatting among themselves after her line is not her turn", async () => {
    const g = "telegram:-7";
    const w = fold([msg(T0, { scope: g }), sent(T0 + MIN, g), msg(T0 + 4 * MIN, { scope: g })]);
    expect(isTurn(w.chats[g] as never)).toBe(false);
    const replied = fold([msg(T0 + 5 * MIN, { scope: g, directed: true })], w);
    expect(isTurn(replied.chats[g] as never)).toBe(true);
  });

  it("deciding not to reach out restarts the urge instead of asking again next minute", () => {
    const base = fold([msg(T0), sent(T0 + MIN)]);
    const later = T0 + 6 * H;
    const before = readChat(base, "telegram:1", later, tiersOf(5))?.raw.cooling ?? 0;
    const declined = fold([silent(later)], base);
    const after = readChat(declined, "telegram:1", later + MIN, tiersOf(5))?.raw.cooling ?? 0;
    expect(before).toBeGreaterThan(0);
    expect(after).toBeLessThan(before / 2);
  });

  it("calls follow outside demand: a busy chat gets attention sooner than a quiet one", async () => {
    const count = async (gapMs: number) => {
      const events = Array.from({ length: 40 }, (_, i) =>
        msg(T0 + i * gapMs, { scope: "telegram:-9", senderId: `contact:${i % 4}` }),
      );
      let calls = 0;
      await replay(events, {
        mechanisms: [pressure],
        tickMs: 10_000,
        speech: () => {
          calls++;
          return { acts: [] };
        },
      });
      return calls / (40 * gapMs);
    };
    expect(await count(20_000)).toBeGreaterThan(await count(10 * MIN));
  });
});

describe("perception: reactions and membership", () => {
  const g = "telegram:-6";
  it("a reaction on her line is a response, and bonds with whoever reacted", () => {
    const base = fold([msg(T0, { scope: g, senderId: "contact:8" }), sent(T0 + MIN, g)]);
    const hers = base.chats[g]?.awaiting?.ids[0] as string;
    const w = fold(
      [
        {
          type: "reaction.received",
          at: T0 + 2 * MIN,
          scope: g,
          messageId: hers,
          senderId: "contact:8",
          emoji: "👍",
        },
      ],
      base,
    );
    expect(w.chats[g]?.receptions.map((r) => r.kind)).toEqual(["replied"]);
    expect(w.relations.people["contact:8"]?.seen.lastAnswerAt).toBe(T0 + 2 * MIN);
    const elsewhere = fold(
      [
        {
          type: "reaction.received",
          at: T0 + 2 * MIN,
          scope: g,
          messageId: "other",
          senderId: "contact:8",
          emoji: "👍",
        },
      ],
      base,
    );
    expect(elsewhere.chats[g]?.receptions).toEqual([]);
  });

  it("being kicked is a rejection and she is no longer a member", () => {
    const base = fold([msg(T0, { scope: g }), sent(T0 + MIN, g)]);
    const w = fold(
      [{ type: "membership.changed", at: T0 + 2 * MIN, scope: g, member: false, reason: "kicked" }],
      base,
    );
    expect(w.chats[g]?.member).toBe(false);
    expect(w.chats[g]?.receptions.map((r) => r.kind)).toEqual(["rejected"]);
    expect(w.chats[g]?.aversion).toBeGreaterThan(0);
  });

  it("after being kicked she cannot act there", () => {
    let s = step(emptyState, msg(T0, { scope: g, directed: true }), []).state;
    s = step(
      s,
      { type: "membership.changed", at: T0 + MIN, scope: g, member: false, reason: "kicked" },
      [],
    ).state;
    expect(s.chats[g]?.member).toBe(false);
  });
});

describe("perception: being blocked", () => {
  it("a send refused by the other side is a rejection", () => {
    const base = fold([msg(T0), sent(T0 + MIN)]);
    const w = fold(
      [
        {
          type: "act.failed",
          at: T0 + 2 * MIN,
          scope: "telegram:1",
          act: { kind: "send", text: "在吗", replyTo: null },
          reason: "refused",
        },
      ],
      base,
    );
    expect(w.chats["telegram:1"]?.receptions.map((r) => r.kind)).toEqual(["rejected"]);
  });
});

describe("reactions need something to react to", () => {
  it("offers a reaction only when there is something new to react to", () => {
    const w = fold([msg(T0), sent(T0 + MIN)]);
    const kinds = (world: World, at: number) =>
      rankIntentions(world, standInAffordances, at)
        .filter((i) => i.scope === "telegram:1")
        .map((i) => i.affordance);
    expect(kinds(w, T0 + 3 * H)).not.toContain("react");
    expect(kinds(fold([msg(T0 + 3 * H)], w), T0 + 3 * H + MIN)).toContain("react");
  });
});

describe("calls do not multiply when the model keeps failing", () => {
  it("adds at most one retry per failed reply to someone waiting, never more than silence otherwise", async () => {
    const start = Date.UTC(2026, 1, 20, 4); // local noon: she is awake
    const events: AliceEvent[] = [
      msg(start, { scope: "telegram:1", directed: true }),
      ...Array.from({ length: 60 }, (_, i) =>
        msg(start + (i + 1) * 2 * MIN, {
          scope: "telegram:-5",
          senderId: `contact:${(i % 4) + 2}`,
        }),
      ),
    ];
    const run = async (fails: (k: number) => boolean) => {
      const calls: Array<{ at: number; failed: boolean; sought: boolean }> = [];
      await replay(events, {
        mechanisms,
        tickMs: 10_000,
        speech: async (request, _id, at) => {
          const failed = fails(calls.length + 1);
          // 这组事件里只有私聊 telegram:1 有人在等她（点了她）；群里没人找她。按场景分类，不看提示词措辞。
          calls.push({ at: at ?? 0, failed, sought: request.scope === "telegram:1" });
          return failed ? null : { acts: [] };
        },
      });
      return calls;
    };
    const silent = await run(() => false);
    // 时好时坏的网关（确定性地每隔几次失败一次），以及全部失败。
    for (const fails of [(k: number) => k % 4 === 0, (k: number) => k % 2 === 0, () => true]) {
      const calls = await run(fails);
      const failedSought = calls.filter((c) => c.failed && c.sought).length;
      expect(calls.length).toBeLessThanOrEqual(silent.length + failedSought);
      // 紧的那一条：没人在等她的调用，失败时不比沉默时更勤。
      const unsought = (xs: typeof calls) => xs.filter((c) => !c.sought).length;
      expect(unsought(calls)).toBeLessThanOrEqual(unsought(silent));
    }
    const failing = (await run(() => true)).map((c) => c.at);
    const gaps = failing.slice(1).map((t, i) => t - (failing[i] as number));
    const half = Math.floor(gaps.length / 2);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    expect(mean(gaps.slice(half))).toBeGreaterThan(mean(gaps.slice(0, half)));
  });
});
