/**
 * 注意力公平（ADR-218 的 U_fairness）和第一次私聊的节奏（PLAN 第 45 件）：只测坏掉了会很糟的几件事——
 * 安静的私聊在热闹的群旁边攒得出有界的服务债、她一想一说就清零；第一次私聊回得少时慢慢加价；
 * Telegram 的 PEER_FLOOD 出现一次就不再开新的第一次私聊。
 */
import { describe, expect, it } from "vitest";
import {
  FAIRNESS,
  type FairnessState,
  type FairnessWorld,
  FIRST_DM,
  type FirstDmAttempt,
  fairnessCostDiscount,
  firstDmBlocked,
  firstDmCost,
  initialFairness,
  reduceFairness,
  starvationBoost,
} from "../src/mechanisms/pressure/fairness.js";
import { PRODUCTION, willAffordances, willOf } from "../src/mechanisms/pressure/index.js";
import { TURN_GAP } from "../src/mechanisms/pressure/params.js";
import { privateScopeOf, type ReachState } from "../src/mechanisms/pressure/reach.js";
import type { Relation } from "../src/mechanisms/pressure/relation.js";
import { intention, readChat } from "../src/mechanisms/pressure/will.js";
import {
  type ChatNode,
  emptyWorld,
  freshChat,
  type World,
} from "../src/mechanisms/pressure/world.js";
import { affordances } from "../src/mind/affordances.js";
import type {
  ActFailed,
  ChatType,
  MessageReceived,
  MessageSent,
  SpeechDecided,
} from "../src/mind/events.js";

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
/** 东八区 2026-11-12 10:00。 */
const T0 = Date.UTC(2026, 10, 12, 2, 0);
const GROUP = "telegram:-100";
const OTHER = "telegram:-200";

/** 一个有过来往的人（relation 的那一条记录）：最近回应过一次。 */
function person(name: string, lastBondAt = T0): Relation {
  return {
    name,
    bot: false,
    seen: {
      firstAt: lastBondAt,
      lastAt: lastBondAt,
      count: 1,
      toHerDays: [],
      lastToHerAt: lastBondAt,
      lastAnswerAt: lastBondAt,
      theirs: 1,
      hers: 0,
      herAt: -Infinity,
      rooms: {},
    },
    warmth: {
      score: 1,
      scoreAt: lastBondAt,
      lastExchangeAt: lastBondAt,
      firstAt: lastBondAt,
      opened: null,
      exchanges: 1,
    },
    hurts: [],
  };
}

function chatOf(
  chatType: ChatType,
  partner: string | null,
  over: Partial<ChatNode> = {},
): ChatNode {
  return { ...freshChat(chatType), partner, ...over };
}

function testWorld(
  o: {
    chats?: Record<string, ChatNode>;
    people?: Record<string, Relation>;
    met?: ReachState["met"];
  } = {},
): FairnessWorld {
  return {
    chats: o.chats ?? {},
    relations: { people: o.people ?? {}, groups: {}, waiting: {} },
    willingness: {},
    reach: { met: o.met ?? {}, titles: {}, places: {}, info: [] },
  };
}

/** 她在一个群里，另外有几个在群里认识、还没私聊过的人。 */
function groupWorld(ids: readonly string[]): FairnessWorld {
  return testWorld({
    chats: { [GROUP]: chatOf("group", null) },
    people: Object.fromEntries(ids.map((id) => [id, person(id)] as const)),
    met: Object.fromEntries(ids.map((id) => [id, { scope: GROUP, lines: [] }] as const)),
  });
}

function sent(at: number, scope: string): MessageSent {
  return { type: "message.sent", at, scope, messageId: `m${at}`, text: "嗯", kind: "text" };
}

function received(at: number, scope: string, senderId = "1"): MessageReceived {
  return {
    type: "message.received",
    at,
    scope,
    chatType: "private",
    messageId: `i${at}`,
    senderId,
    senderName: "小林",
    text: "在吗",
    contentType: "text",
    replyToMessageId: null,
    directed: true,
  };
}

function decided(at: number, scope: string): SpeechDecided {
  return { type: "speech.decided", at, scope, callId: `c${at}`, decision: { acts: [] } };
}

/** 她先给这个安静的人说过一次，之后在别的两个群里说了 30 轮。 */
function quietScene(): { world: FairnessWorld; scope: string; state: FairnessState } {
  const scope = privateScopeOf(GROUP, "1");
  const world = testWorld({
    chats: {
      [GROUP]: chatOf("group", null),
      [OTHER]: chatOf("group", null),
      [scope]: chatOf("private", "1"),
    },
    people: { "1": person("小林") },
    met: { "1": { scope: GROUP, lines: [] } },
  });
  let state = reduceFairness(initialFairness, world, sent(T0, scope));
  for (let i = 0; i < 30; i++) {
    const at = T0 + (i + 1) * 2 * MIN;
    state = reduceFairness(state, world, sent(at, i % 2 === 0 ? GROUP : OTHER));
  }
  return { world, scope, state };
}

describe("attention fairness", () => {
  it("accumulates a bounded uplift for a quiet DM while loud groups get turns", () => {
    const { world, scope, state } = quietScene();
    const now = T0 + 12 * H;
    const boost = starvationBoost(state, world, scope, now);
    expect(boost).toBeGreaterThan(0.2);
    expect(boost).toBeLessThanOrEqual(FAIRNESS.maxBoost);
    expect(fairnessCostDiscount(state, world, scope, now)).toBeLessThan(1);
    expect(fairnessCostDiscount(state, world, scope, now)).toBeGreaterThanOrEqual(
      1 - FAIRNESS.maxBoost,
    );
    // 群不是"安静的私聊"，不打折。
    expect(starvationBoost(state, world, GROUP, now)).toBe(0);
    expect(fairnessCostDiscount(state, world, GROUP, now)).toBe(1);
  });

  it("resets the debt as soon as she considers or speaks in that chat", () => {
    const { world, scope, state } = quietScene();
    const now = T0 + 12 * H;
    expect(starvationBoost(state, world, scope, now)).toBeGreaterThan(0);

    const considered = reduceFairness(state, world, decided(now, scope));
    expect(starvationBoost(considered, world, scope, now)).toBe(0);

    const spoke = reduceFairness(state, world, sent(now, scope));
    expect(starvationBoost(spoke, world, scope, now)).toBe(0);
  });

  it("counts messages within TURN_GAP as one turn, like world turns", () => {
    const world = testWorld({ chats: { [GROUP]: chatOf("group", null) } });
    const at = T0 + H;
    let state = reduceFairness(initialFairness, world, sent(at, GROUP));
    state = reduceFairness(state, world, sent(at + 30 * 1000, GROUP));
    expect(state.served).toHaveLength(1);
    state = reduceFairness(state, world, sent(at + TURN_GAP + 1, GROUP));
    expect(state.served).toHaveLength(2);
  });

  it("does not lift a quiet DM when she has been quiet everywhere", () => {
    const scope = privateScopeOf(GROUP, "1");
    const world = testWorld({
      chats: { [scope]: chatOf("private", "1") },
      people: { "1": person("小林") },
      met: { "1": { scope: GROUP, lines: [] } },
    });
    const state: FairnessState = {
      ...initialFairness,
      lastServedAt: { [scope]: T0 },
      served: [{ at: T0, scope }],
    };
    expect(starvationBoost(state, world, scope, T0 + 12 * H)).toBe(0);
  });

  it("does not lift a chat with an active rejection", () => {
    const { world, scope, state } = quietScene();
    const now = T0 + 12 * H;
    const rejected: FairnessWorld = {
      ...world,
      chats: {
        ...world.chats,
        [scope]: chatOf("private", "1", { aversion: 1, aversionAt: now }),
      },
    };
    expect(starvationBoost(state, rejected, scope, now)).toBe(0);
    expect(fairnessCostDiscount(state, rejected, scope, now)).toBe(1);
  });
});

describe("first-DM pacing", () => {
  it("slows smoothly when first DMs from the same group go unanswered and leaves the prior pace alone", () => {
    const world = groupWorld(["fresh"]);
    const fresh = privateScopeOf(GROUP, "fresh");
    const now = T0 + D;
    // 按来源群学：这几笔都是在 GROUP 认识的人（reduceFairness 记的就是这个形状）。
    const attempt = (id: string, sentAt: number, replied: boolean): FirstDmAttempt => ({
      scope: privateScopeOf(GROUP, id),
      sourceGroup: GROUP,
      sentAt,
      replied,
    });
    const state = (replied: number, unanswered: number): FairnessState => {
      const firstDmAttempts: Record<string, readonly FirstDmAttempt[]> = {};
      for (let i = 0; i < replied; i++) firstDmAttempts[`r${i}`] = [attempt(`r${i}`, T0 + 1, true)];
      for (let i = 0; i < unanswered; i++) {
        firstDmAttempts[`u${i}`] = [attempt(`u${i}`, T0 + 2, false)];
      }
      return { ...initialFairness, firstDmAttempts };
    };

    // 先验 2/4：正常节奏，不多收。
    expect(firstDmCost(state(2, 2), world, fresh, now)).toBe(0);
    // 回得多的更轻，没人回的一直加重，但有界。
    const good = firstDmCost(state(4, 0), world, fresh, now);
    const bad = firstDmCost(state(0, 4), world, fresh, now);
    const worse = firstDmCost(state(0, 12), world, fresh, now);
    expect(good).toBe(0);
    expect(bad).toBeGreaterThan(good);
    expect(worse).toBeGreaterThan(bad);
    expect(worse).toBeLessThanOrEqual(FIRST_DM.cost);
    // 已经开过的会话、群，都不收第一次私聊的代价。
    const opened: FairnessWorld = {
      ...world,
      chats: { ...world.chats, [fresh]: chatOf("private", "fresh") },
    };
    expect(firstDmCost(state(0, 12), opened, fresh, now)).toBe(0);
    expect(firstDmCost(state(0, 12), world, GROUP, now)).toBe(0);
  });

  it("records a cold private opening and marks it replied when the person answers", () => {
    const scope = privateScopeOf(GROUP, "1");
    const world = testWorld({
      chats: { [GROUP]: chatOf("group", null), [scope]: chatOf("private", "1") },
      people: { "1": person("小林") },
      met: { "1": { scope: GROUP, lines: [] } },
    });
    const opened = reduceFairness(initialFairness, world, sent(T0 + H, scope));
    expect(opened.firstDmAttempts["1"]).toEqual([
      { scope, sourceGroup: GROUP, sentAt: T0 + H, replied: false },
    ]);

    // fold 之后（lastAliceAt 已是这条的时刻）也记同一笔：这里不读她上次开口的时刻。
    const afterFold: FairnessWorld = {
      ...world,
      chats: { ...world.chats, [scope]: chatOf("private", "1", { lastAliceAt: T0 + H }) },
    };
    const same = reduceFairness(initialFairness, afterFold, sent(T0 + H, scope));
    expect(same.firstDmAttempts["1"]).toHaveLength(1);

    const answered = reduceFairness(opened, world, received(T0 + 2 * H, scope, "1"));
    expect(answered.firstDmAttempts["1"]?.[0]?.replied).toBe(true);

    // 同一个私聊只记一笔：后来再说的话不是新的第一次私聊。
    const again = reduceFairness(answered, world, sent(T0 + 3 * H, scope));
    expect(again.firstDmAttempts["1"]).toHaveLength(1);

    // 别人先来找她的私聊是回应，不是她主动开的第一句。
    const wroteFirst: FairnessWorld = {
      ...world,
      chats: { ...world.chats, [scope]: chatOf("private", "1", { lastIncomingAt: T0 }) },
    };
    const reply = reduceFairness(initialFairness, wroteFirst, sent(T0 + H, scope));
    expect(reply.firstDmAttempts).toEqual({});
  });

  it("halts new first-DM openings at the first Telegram peer flood warning", () => {
    const world = groupWorld(["fresh"]);
    const scope = privateScopeOf(GROUP, "fresh");
    const failed: ActFailed = {
      type: "act.failed",
      at: T0,
      scope,
      act: { kind: "send", text: "在吗", replyTo: null },
      reason: "peer_flood",
    };
    const stopped = reduceFairness(initialFairness, world, failed);
    expect(stopped.peerFloodStoppedAt).toBe(T0);
    expect(firstDmBlocked(stopped)).toBe(true);

    // 冷却没过完，照旧停着。
    const soon = reduceFairness(stopped, world, { type: "clock.tick", at: T0 + H });
    expect(firstDmBlocked(soon)).toBe(true);

    // 冷却过后放开。
    const cooled = reduceFairness(stopped, world, {
      type: "clock.tick",
      at: T0 + FIRST_DM.floodCool,
    });
    expect(firstDmBlocked(cooled)).toBe(false);

    // 又一次警告把冷却从这一次重新计时，不是从第一次算。
    const renewed = reduceFairness(stopped, world, { ...failed, at: T0 + 23 * H });
    const dayAfter = reduceFairness(renewed, world, { type: "clock.tick", at: T0 + D });
    expect(firstDmBlocked(dayAfter)).toBe(true);
  });

  it("applies fairnessCostDiscount multiplicatively so socialCost stays non-negative and lambda0 never inverts", () => {
    const { world: fw, scope, state } = quietScene();
    const now = T0 + 18 * H;
    const dm = chatOf("private", "1", { lastAliceAt: T0, member: true });
    const world: World = {
      ...emptyWorld,
      chats: { ...fw.chats, [scope]: dm },
      relations: fw.relations,
      willingness: fw.willingness,
      reach: fw.reach,
      fairness: state,
    };
    const all = willAffordances(affordances);
    const react = all.find((a) => a.kind === "react");
    expect(react).toBeDefined();
    if (!react) return;
    const comp = PRODUCTION;
    const reading = readChat(world, scope, now);
    expect(reading).not.toBeNull();
    if (!reading) return;
    const low = intention(world, reading, react, now, willOf(comp, 0.5));
    const mid = intention(world, reading, react, now, willOf(comp, 1.5));
    const high = intention(world, reading, react, now, willOf(comp, 3.0));
    expect(low.socialCost).toBeGreaterThanOrEqual(0);
    expect(mid.nsv).toBeLessThan(low.nsv);
    expect(high.nsv).toBeLessThan(mid.nsv);
  });
});
