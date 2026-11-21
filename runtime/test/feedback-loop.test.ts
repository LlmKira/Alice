/**
 * 她开口之后的结果当下回到心里（ADR-276 环节五 + ADR-267）。
 * 只测坏掉了会很糟的：意外定推多少（安静群里被接推得更暖）、口气冷或叫她停时绝不推暖、没人接绝不推负、
 * 分享口味在这个会话里学、心情的倍数只乘内在的劲。
 */
import { describe, expect, it } from "vitest";
import { DRIVES } from "../src/mechanisms/pressure/drives.js";
import {
  EXTRINSIC_DRIVES,
  type FeedbackAppraisal,
  INTRINSIC_DRIVES,
  INTRINSIC_GAIN_MAX,
  INTRINSIC_GAIN_MIN,
  initialFeedback,
  intrinsicGain,
  MOOD_LIFT_MAX,
  pendingMoodBoost,
  type ReceptionFeedbackState,
  reduceFeedback,
  shareTaste,
  splitRelief,
  TASTE_MAX,
  TASTE_MIN,
} from "../src/mechanisms/pressure/feedback.js";
import type {
  MessagePerceived,
  MessageReceived,
  MessageSent,
  ReactionReceived,
  Tone,
} from "../src/mind/events.js";
import { replay } from "../src/sim/replay.js";
import { arms } from "../src/sim/will-arms.js";

const MIN = 60_000;
/** 本地（UTC+8）11 月 14 日中午，醒着。 */
const T0 = Date.UTC(2026, 10, 14, 4, 0);
const GROUP = "telegram:-100";
const CHAT = "装机群";

let seq = 0;
const id = (prefix: string) => `${prefix}-${++seq}`;

function received(o: Partial<MessageReceived> & { at: number }): MessageReceived {
  const scope = o.scope ?? GROUP;
  const chatType = o.chatType ?? (scope === GROUP ? "group" : "private");
  const base: MessageReceived = {
    type: "message.received",
    at: o.at,
    scope,
    chatType,
    messageId: id("m"),
    senderId: "u1",
    senderName: "小林",
    text: "…",
    contentType: "text",
    replyToMessageId: null,
    directed: false,
    ...(chatType === "group" ? { chatTitle: CHAT } : {}),
  };
  return { ...base, ...o, type: "message.received", scope, chatType, at: o.at };
}

function sent(at: number, o: Partial<MessageSent> = {}): MessageSent {
  const base: MessageSent = {
    type: "message.sent",
    at,
    scope: GROUP,
    messageId: id("alice"),
    text: "…",
    kind: "text",
  };
  return { ...base, ...o, type: "message.sent", at };
}

function perceived(
  at: number,
  messageId: string,
  o: Partial<MessagePerceived> = {},
): MessagePerceived {
  const base: MessagePerceived = { type: "message.perceived", at, scope: GROUP, messageId };
  return { ...base, ...o, type: "message.perceived", at, messageId };
}

function reaction(
  at: number,
  messageId: string,
  emoji: string,
  o: Partial<ReactionReceived> = {},
): ReactionReceived {
  const base: ReactionReceived = {
    type: "reaction.received",
    at,
    scope: GROUP,
    messageId,
    senderId: "u1",
    emoji,
  };
  return { ...base, ...o, type: "reaction.received", at, messageId, emoji };
}

/**
 * 她先说一句，一个人回复她，口气晚到。usualUptake 是那个群平时别人一轮被接的比例
 * （world.ts usualUptake；不给按先验 1/2）。
 */
function uptake(o: {
  tone?: Tone;
  extra?: Partial<MessagePerceived>;
  usualUptake?: number;
  channel?: string;
}): {
  state: ReceptionFeedbackState;
  boost: FeedbackAppraisal | null;
  mine: string;
  reply: string;
} {
  const mine = id("mine");
  const reply = id("reply");
  let state = reduceFeedback(initialFeedback, received({ at: T0 - MIN }));
  state = reduceFeedback(state, sent(T0, { messageId: mine }), { channel: o.channel });
  state = reduceFeedback(
    state,
    received({
      at: T0 + 30_000,
      messageId: reply,
      senderId: "u1",
      senderName: "小林",
      directed: true,
      replyToMessageId: mine,
    }),
    { usualUptake: o.usualUptake },
  );
  state = reduceFeedback(
    state,
    perceived(T0 + 31_000, reply, {
      ...(o.tone ? { tone: o.tone } : {}),
      ...(o.extra ?? {}),
    }),
  );
  return { state, boost: pendingMoodBoost(state), mine, reply };
}

describe("positive reception appraisals", () => {
  it("scales a warm uptake by surprise (1 − usualUptake), not by a fixed amount", () => {
    const quiet = uptake({ tone: "friendly", usualUptake: 0.1 });
    const busy = uptake({ tone: "friendly", usualUptake: 0.9 });
    expect(quiet.boost).not.toBeNull();
    expect(busy.boost).not.toBeNull();
    // 意外 = 1 − 0.9 = 0.9 和 1 − 0.1 = 0.1；同一次"有人接"在少有人被接的群里推得暖得多。
    expect(quiet.boost?.valence ?? 0).toBeCloseTo(MOOD_LIFT_MAX * 0.9);
    expect(busy.boost?.valence ?? 0).toBeCloseTo(MOOD_LIFT_MAX * 0.1);
    expect(quiet.boost?.valence ?? 0).toBeGreaterThan(busy.boost?.valence ?? 0);
  });

  it("carries the word, the concrete reason, the scope and who was there", () => {
    const { boost, mine, reply } = uptake({ tone: "friendly", usualUptake: 0.5 });
    expect(boost?.word).toBe("被接纳");
    expect(boost?.why).toContain(CHAT);
    expect(boost?.why).toContain("接住");
    expect(boost?.scope).toBe(GROUP);
    expect(boost?.present).toContain("u1");
    expect(boost?.by).toBe("u1");
    expect(boost?.turnId).toBe(mine);
    expect(boost?.replyId).toBe(reply);
  });

  it("counts a group 'taken' (129 s) once its tone is judged", () => {
    const mine = id("mine");
    const taken = id("taken");
    let state = reduceFeedback(initialFeedback, received({ at: T0 - MIN }));
    state = reduceFeedback(state, sent(T0, { messageId: mine }));
    state = reduceFeedback(
      state,
      received({ at: T0 + 10_000, messageId: taken, senderId: "u2", directed: false }),
      { usualUptake: 0.1 },
    );
    expect(pendingMoodBoost(state)).toBeNull();
    state = reduceFeedback(state, perceived(T0 + 11_000, taken, { tone: "friendly" }));
    expect(pendingMoodBoost(state)).not.toBeNull();
  });

  it("waits for the judged tone before it pushes anything", () => {
    const mine = id("mine");
    const reply = id("reply");
    let state = reduceFeedback(initialFeedback, received({ at: T0 - MIN }));
    state = reduceFeedback(state, sent(T0, { messageId: mine }));
    state = reduceFeedback(
      state,
      received({
        at: T0 + 30_000,
        messageId: reply,
        directed: true,
        replyToMessageId: mine,
      }),
      { usualUptake: 0.1 },
    );
    expect(pendingMoodBoost(state)).toBeNull();
    state = reduceFeedback(state, perceived(T0 + 31_000, reply, { tone: "friendly" }));
    expect(pendingMoodBoost(state)).not.toBeNull();
  });
});

describe("ADR-267: a structural reply is not warm semantics", () => {
  it("never pushes positive mood for cold, hostile, stop, hush or aloof", () => {
    const cases: Array<{ tone?: Tone; extra?: Partial<MessagePerceived> }> = [
      { tone: "cold" },
      // 俄语群里那句"请说俄语"：回复了她，但口气是敌意，不能记成热情的回复。
      { tone: "hostile" },
      { tone: "hostile", extra: { stop: true } },
      { tone: "friendly", extra: { stop: true } },
      { tone: "neutral", extra: { hush: true } },
      { tone: "neutral", extra: { aloof: true } },
    ];
    for (const c of cases) {
      const { boost } = uptake({ tone: c.tone, extra: c.extra, usualUptake: 0.1 });
      expect(boost).toBeNull();
    }
  });

  it("treats an unjudged tone as structure only, not as warmth", () => {
    const { boost } = uptake({ usualUptake: 0.1 });
    expect(boost).toBeNull();
  });
});

describe("ignored turns", () => {
  it("never pushes mood negative and never invents a boost", () => {
    const mine = id("mine");
    let state = reduceFeedback(initialFeedback, received({ at: T0 - MIN }));
    state = reduceFeedback(state, sent(T0, { messageId: mine }));
    // 群里别人自己接着聊，没有冲着她，也没有回复她。
    state = reduceFeedback(state, received({ at: T0 + 20_000, messageId: id("other") }));
    expect(pendingMoodBoost(state)).toBeNull();
    // 等反应的窗口过了。
    state = reduceFeedback(state, received({ at: T0 + 11 * MIN, messageId: id("later") }));
    expect(pendingMoodBoost(state)).toBeNull();
    expect(state.open[GROUP]).toBeUndefined();
    expect(state.boost).toBeNull();
  });
});

describe("channel-share taste", () => {
  it("starts at 1.0 with the Beta prior and stays bounded", () => {
    expect(shareTaste(initialFeedback, GROUP, "games")).toBe(1);
    const maxed = {
      ...initialFeedback,
      taste: { [`${GROUP}:games`]: { pos: 100, total: 100 } },
    };
    expect(shareTaste(maxed, GROUP, "games")).toBe(TASTE_MAX);
    const floored = {
      ...initialFeedback,
      taste: { [`${GROUP}:games`]: { pos: 0, total: 100 } },
    };
    expect(shareTaste(floored, GROUP, "games")).toBe(TASTE_MIN);
  });

  it("learns up when the share is taken up warmly and gently down when it is ignored", () => {
    const channel = "games";
    const share = id("share");
    const reply = id("reply");

    let up = reduceFeedback(initialFeedback, received({ at: T0 - MIN }));
    up = reduceFeedback(up, sent(T0, { messageId: share }), { channel });
    up = reduceFeedback(
      up,
      received({
        at: T0 + 30_000,
        messageId: reply,
        directed: true,
        replyToMessageId: share,
      }),
      { usualUptake: 0.5 },
    );
    up = reduceFeedback(up, perceived(T0 + 31_000, reply, { tone: "friendly" }));
    // Beta(2, 2) 后验除以先验均值：一条被接 (2+1)/(4+1) ÷ 1/2 = 1.2。
    expect(shareTaste(up, GROUP, channel)).toBeCloseTo(1.2);

    let down = reduceFeedback(initialFeedback, received({ at: T0 - MIN }));
    down = reduceFeedback(down, sent(T0, { messageId: id("share") }), { channel });
    down = reduceFeedback(down, received({ at: T0 + 11 * MIN, messageId: id("noise") }));
    // 一条没人接 (2+0)/(4+1) ÷ 1/2 = 0.8，一条观测只挪一点。
    expect(shareTaste(down, GROUP, channel)).toBeCloseTo(0.8);
  });

  it("does not learn when the tone cannot be judged (structure only)", () => {
    const channel = "games";
    const { state } = uptake({ usualUptake: 0.5, channel });
    expect(shareTaste(state, GROUP, channel)).toBe(1);
  });
});

describe("reactions on her awaiting message", () => {
  it("counts a positive emoji as acceptance and a negative one as no warmth", () => {
    const mine = id("mine");
    let good = reduceFeedback(initialFeedback, received({ at: T0 - MIN }));
    good = reduceFeedback(good, sent(T0, { messageId: mine }), { channel: "games" });
    good = reduceFeedback(good, reaction(T0 + 10_000, mine, "🔥"), { usualUptake: 0.5 });
    expect(pendingMoodBoost(good)?.turnId).toBe(mine);
    expect(shareTaste(good, GROUP, "games")).toBeGreaterThan(1);

    let bad = reduceFeedback(initialFeedback, received({ at: T0 - MIN }));
    bad = reduceFeedback(bad, sent(T0, { messageId: mine }), { channel: "games" });
    bad = reduceFeedback(bad, reaction(T0 + 10_000, mine, "👎"), { usualUptake: 0.5 });
    expect(pendingMoodBoost(bad)).toBeNull();
    expect(shareTaste(bad, GROUP, "games")).toBeLessThan(1);
  });
});

describe("mood-to-will intrinsic gain", () => {
  it("multiplies only intrinsic drives and leaves obligation and aversion at 1.0", () => {
    const terms = DRIVES.map((key) => [key, 1] as const);
    const split = splitRelief(terms, INTRINSIC_DRIVES, 1.3);
    expect(split.intrinsic).toBeCloseTo(INTRINSIC_DRIVES.length * 1.3);
    expect(split.extrinsic).toBeCloseTo(EXTRINSIC_DRIVES.length);
    expect(split.total).toBeCloseTo(INTRINSIC_DRIVES.length * 1.3 + EXTRINSIC_DRIVES.length);
    for (const key of INTRINSIC_DRIVES) {
      expect(split.terms.find(([k]) => k === key)?.[1] ?? 0).toBeCloseTo(1.3);
    }
    for (const key of EXTRINSIC_DRIVES) {
      expect(split.terms.find(([k]) => k === key)?.[1] ?? 0).toBe(1);
    }

    const low = splitRelief(terms, INTRINSIC_DRIVES, 0.65);
    for (const key of EXTRINSIC_DRIVES) {
      expect(low.terms.find(([k]) => k === key)?.[1] ?? 0).toBe(1);
    }
  });

  it("is monotone in mood and clamped, so low mood quiets her but never disables replies", () => {
    expect(intrinsicGain(0)).toBe(1);
    expect(intrinsicGain(0.6)).toBeGreaterThan(1);
    expect(intrinsicGain(-0.6)).toBeLessThan(1);
    expect(intrinsicGain(1)).toBe(INTRINSIC_GAIN_MAX);
    expect(intrinsicGain(-1)).toBe(INTRINSIC_GAIN_MIN);
    // BIBO：再低落，倍数也大于 0；义务和回避本身在 splitRelief 里不乘。
    expect(intrinsicGain(-1)).toBeGreaterThan(0);
    expect(intrinsicGain(0, -2)).toBe(INTRINSIC_GAIN_MIN);
    expect(intrinsicGain(0, 2)).toBe(INTRINSIC_GAIN_MAX);
  });
});

describe("production loop guardrails (PLAN item 56)", () => {
  it("stays bounded when someone replies warmly every single turn", async () => {
    const mechs = arms({}).production;
    if (!mechs) throw new Error("missing production arm");
    // 连续 40 轮（80 分钟，每 2 分钟有人点名她并带正面口气），每次叫醒她都回复一句，查饱和代价仍封顶、不滚雪球
    const events = Array.from({ length: 40 }, (_, i) => {
      const at = T0 + i * 2 * MIN;
      return [
        received({
          at,
          messageId: `u-${i}`,
          senderId: "u1",
          directed: true,
          text: "真的吗快多说点",
        }),
        perceived(at + 1_000, `u-${i}`, { tone: "friendly" }),
      ];
    }).flat();
    const result = await replay(events, {
      mechanisms: mechs,
      tickMs: 15_000,
      speech: (req) =>
        req.scope === GROUP
          ? { acts: [{ kind: "send", text: "是呀", replyTo: null }] }
          : { acts: [] },
    });
    const groupCalls = result.effects.filter(
      (r) => r.effect.type === "call-speech" && r.effect.scope === GROUP,
    );
    expect(groupCalls.length).toBeGreaterThan(0);
    expect(groupCalls.length).toBeLessThan(25);
  });

  it("produces zero wakes in a group right after being told to stop", async () => {
    const mechs = arms({}).production;
    if (!mechs) throw new Error("missing production arm");
    const stopAt = T0 + 20_000;
    const events = [
      received({ at: T0, messageId: "m1", senderId: "u1", directed: true, text: "在吗" }),
      sent(T0 + 5_000, { messageId: "a1", text: "在呀" }),
      received({
        at: stopAt,
        messageId: "m2",
        senderId: "u1",
        directed: true,
        replyToMessageId: "a1",
        text: "闭嘴别说话了",
      }),
      perceived(stopAt + 1_000, "m2", { tone: "hostile", stop: true, hush: true }),
      ...Array.from({ length: 15 }, (_, idx) =>
        received({
          at: stopAt + (idx + 1) * MIN,
          messageId: `other-${idx}`,
          senderId: "u2",
          directed: false,
          text: "大家继续聊",
        }),
      ),
    ];
    const result = await replay(events, {
      mechanisms: mechs,
      tickMs: 15_000,
      speech: () => ({ acts: [] }),
    });
    // m2 自己带 directed=true，她看一眼选择沉默后，接下来 14 条群里别人的闲聊 0 次叫醒她
    const afterStop = result.effects.filter(
      (r) => r.effect.type === "call-speech" && r.effect.scope === GROUP && r.at > stopAt + 2 * MIN,
    );
    expect(afterStop).toHaveLength(0);
  });

  it("does not wake as a newsbot when channel posts arrive without matching conversation", async () => {
    const mechs = arms({}).production;
    if (!mechs) throw new Error("missing production arm");
    const events = [
      received({ at: T0, messageId: "g1", senderId: "u1", text: "今晚红烧肉炖得真香" }),
      ...Array.from({ length: 5 }, (_, i) => ({
        type: "post.received" as const,
        at: T0 + (i + 1) * MIN,
        scope: "telegram:-100999",
        messageId: `p-${i}`,
        title: "科技新闻",
        text: `量子芯片工艺突破第 ${i} 期基准测试数据公布`,
      })),
    ];
    const result = await replay(events, {
      mechanisms: mechs,
      tickMs: 15_000,
      speech: () => ({ acts: [] }),
    });
    const wakes = result.effects.filter(
      (r) => r.effect.type === "call-speech" && r.effect.scope === GROUP && r.at > T0 + MIN,
    );
    expect(wakes).toHaveLength(0);
  });
});
