/**
 * 候选 dwell-look（mechanisms/pressure/turn.ts dwell({ look })）坏掉了会很糟的几条：
 * - 她在对话里时，别人没点她名的话叫得醒她（生产按 NSV 的门叫不醒）；
 * - 只看过、没开口的群不因为它叫醒她（旁观不变，没有 follow）；
 * - 在对话里被叫醒时提示词照旧是"没人点你"，被点名时不是。
 */
import { describe, expect, it } from "vitest";
import {
  createPressure,
  dwell,
  PRODUCTION,
  pressureProduction,
  willWake,
} from "../src/mechanisms/pressure/index.js";
import type { World } from "../src/mechanisms/pressure/world.js";
import { affordances } from "../src/mind/affordances.js";
import type { SpeechRequest } from "../src/mind/effects.js";
import type {
  AliceEvent,
  MessageReceived,
  MessageSent,
  SpeechDecision,
} from "../src/mind/events.js";
import { WAKE_THRESHOLD } from "../src/mind/mechanism.js";
import { replay } from "../src/sim/replay.js";

/** 当地（UTC+8，mind/when.ts）下午两点多：她醒着。 */
const T0 = 1_771_000_000_000 - 10 * 3_600_000;
const S = 1000;
const G = "telegram:-7";

const candidate = { ...PRODUCTION, floor: dwell({ passBy: true, look: true }) };
const pressure = createPressure(affordances, candidate);
const lens = willWake(affordances, candidate);
const production = willWake(affordances, PRODUCTION);

let n = 0;
function msg(at: number, o: Partial<MessageReceived> = {}): MessageReceived {
  n++;
  return {
    type: "message.received",
    at,
    scope: G,
    chatType: "group",
    messageId: `l${n}`,
    senderId: `contact:${(n % 3) + 1}`,
    senderName: "群友",
    text: "今天吃什么",
    contentType: "text",
    replyToMessageId: null,
    directed: false,
    ...o,
  };
}

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

function fold(events: readonly AliceEvent[]): World {
  const reduce = pressure.reduce as (w: World, e: AliceEvent) => World;
  return events.reduce(reduce, pressure.initial as World);
}

const score = (r: ReturnType<typeof lens.why>) => (r && "score" in r ? r.score : 0);

describe("dwell-look: what wakes her", () => {
  it("inside the conversation a plain message wakes her without the cost to others", () => {
    const events = [msg(T0), sent(T0 + 20 * S), msg(T0 + 40 * S)];
    const last = events.at(-1) as MessageReceived;
    const world = fold(events);
    const r = lens.why(G, last, last.at, world);
    expect(r?.kind).toBe("floor");
    expect(score(r)).toBeGreaterThan(0.5);
    // 生产的门收 C_social：同一状态下分数更低（这个小场景里第一条约 0.52 对 0.84）。
    expect(score(r)).toBeGreaterThan(score(production.why(G, last, last.at, world)) + 0.1);
  });

  it("a group she has only looked at is not woken by plain messages", () => {
    const looked: AliceEvent = {
      type: "speech.decided",
      at: T0 + 10 * S,
      scope: G,
      callId: `${G}#look`,
      decision: { acts: [] },
    };
    const events = [msg(T0), looked, msg(T0 + 30 * S)];
    const last = events.at(-1) as MessageReceived;
    expect(lens.why(G, last, last.at, fold(events))).toBeNull();
  });
});

/**
 * 闭环性质（dwell 应该留下的足迹）：她在群里开过口、还在对话里时，别人没点她名的新消息能叫醒她（kind floor），
 * 不必等对话走过她 K 条。事件流照 2 月 B 回放里的常态：热闹的群里她看过多次、早先说的一句没人接。
 * 生产是红的：早先没人接的那句抬高了回避（aversion 约 0.32），接近类动作多付 AVERSION_COST·aversion，
 * 最好的意愿（点表情）NSV 在 10 条里一直为负（−0.11 到 −0.15，分数最高 0.21），对话走过她就结束了。
 * look 的门不收对别人的打扰（imposition 约 0.22·λ），第 8 条到 0.53。回避的代价两边都照收。
 */
describe("dwell property: a plain message inside the conversation can wake her", () => {
  const busyHour = (): AliceEvent[] => {
    const es: AliceEvent[] = [];
    let t = T0;
    for (let i = 0; i < 360; i++) {
      t += 10 * S;
      es.push(msg(t, { senderId: `contact:${(i % 20) + 1}` }));
      es.push({ type: "clock.tick", at: t + 5 * S });
      if (i % 36 === 0)
        es.push({
          type: "speech.decided",
          at: t + 1,
          scope: G,
          callId: `${G}#${t}`,
          decision: { acts: [] },
        });
      if (i === 7) es.push(sent(t + 2));
    }
    es.push(sent(t + 10 * S));
    return es;
  };
  const wakesInside = (configured: ReturnType<typeof willWake>) => {
    const es = busyHour();
    const spoke = (es.at(-1) as MessageSent).at;
    for (let j = 1; j <= 10; j++) {
      const m = msg(spoke + j * 10 * S, { senderId: `contact:${(j % 20) + 1}` });
      es.push(m);
      const r = configured.why(G, m, m.at, fold(es));
      if (r?.kind === "floor" && score(r) >= WAKE_THRESHOLD) return true;
    }
    return false;
  };

  // PLAN 第 43 件之后：被接得多的群里回避低、没人接的连发按群的节奏淡掉，生产在对话里也会被下一条叫醒。
  it("production: one of the next K plain messages wakes her", () => {
    expect(wakesInside(production)).toBe(true);
  });

  it("dwell-look: one of the next K plain messages wakes her", () => {
    expect(wakesInside(lens)).toBe(true);
  });
});

/**
 * 闭环性质（轮流）：小群里两个人慢慢聊，她被点名接了一句，之后每次被叫醒都开口。她在这段对话里的轮次份额
 * 不超过这个群自己说得最多的人的份额（PLAN 第 43 件：和这个群自己的带比；两个人各一半时，三个人平分是 1/3）。
 * 一段对话里人人都有轮次，她不比最能说的人说得多（Sacks、Schegloff、Jefferson 1974）。
 */
async function turnShare(mechanism: ReturnType<typeof createPressure>): Promise<number> {
  const events: AliceEvent[] = [msg(T0, { directed: true, senderId: "contact:1" })];
  for (let i = 1; i <= 30; i++)
    events.push(msg(T0 + i * 40 * S, { senderId: `contact:${(i % 2) + 1}` }));
  const speech = async (r: SpeechRequest): Promise<SpeechDecision> =>
    r.scope === G ? { acts: [{ kind: "send", text: "嗯", replyTo: null }] } : { acts: [] };
  const result = await replay(events, { mechanisms: [mechanism], speech, tickMs: 10 * S });
  const hers = result.effects.filter(
    (r) => r.effect.type === "act" && r.effect.scope === G && r.effect.act.kind === "send",
  ).length;
  // 别人每条都是一轮（两个人交替说），她每次开口一轮。
  return hers / (hers + 31);
}

/** 这段对话里说得最多的那个人的份额（两个人交替说，各 15、16 轮）。 */
async function topShare(mechanism: ReturnType<typeof createPressure>): Promise<number> {
  const her = await turnShare(mechanism);
  const hers = (her * 31) / (1 - her);
  return 16 / (hers + 31);
}

describe("turn-taking property: she does not hold the floor of a small conversation", () => {
  it.fails("dwell-look: she takes about a third of the turns", async () => {
    expect(await turnShare(pressure)).toBeLessThanOrEqual(0.31);
  });

  it("production keeps her turn share at or below the group's own top speaker", async () => {
    const share = await turnShare(pressureProduction);
    expect(share).toBeLessThanOrEqual((await topShare(pressureProduction)) + 0.01);
    // 不是不让她说：这段对话里她仍有好几轮。
    expect(share).toBeGreaterThan(0.1);
  });
});

describe("dwell-look: what she is told", () => {
  it("woken inside the conversation she is told nobody pinged her; pinged, she is not", async () => {
    const events: AliceEvent[] = [msg(T0, { directed: true })];
    for (let i = 1; i <= 3; i++) events.push(msg(T0 + i * 20 * S));
    events.push(msg(T0 + 90 * S, { directed: true }));
    const seen: Array<{ unsought: boolean; trigger: string | null }> = [];
    let k = 0;
    const speech = async (r: SpeechRequest): Promise<SpeechDecision> => {
      if (r.scope !== G) return { acts: [] };
      seen.push({
        unsought: r.contributions.some((c) => c.mechanism === "pressure-unsought"),
        trigger: r.triggerMessageId,
      });
      k++;
      // 每次都说一句：一直在对话里。
      return { acts: [{ kind: "send", text: `嗯${k}`, replyTo: null }] };
    };
    await replay(events, { mechanisms: [pressure], speech, tickMs: 10 * S });
    const woken = seen.filter((s) => s.trigger !== null);
    const directed = new Set(
      [events[0], events.at(-1)].map((e) => (e as MessageReceived).messageId),
    );
    const inside = woken.filter((s) => !directed.has(s.trigger as string));
    expect(inside.length).toBeGreaterThanOrEqual(1);
    expect(inside.every((s) => s.unsought)).toBe(true);
    expect(woken.filter((s) => directed.has(s.trigger as string)).every((s) => !s.unsought)).toBe(
      true,
    );
  });
});
