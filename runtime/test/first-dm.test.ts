import { describe, expect, it } from "vitest";
import {
  delegatedFairness,
  type FairnessState,
  type FairnessWorld,
  FIRST_DM,
  firstDmCost,
  type groupDmStatsOf,
  initialFairness,
  reduceFairness,
  starvationBoost,
} from "../src/mechanisms/pressure/fairness.js";
import { PRODUCTION, reach } from "../src/mechanisms/pressure/index.js";
import { privateScopeOf } from "../src/mechanisms/pressure/reach.js";
import { feedback as rejectFeedback } from "../src/mechanisms/pressure/rejection.js";
import type { Relation } from "../src/mechanisms/pressure/relation.js";
import { type ChatNode, emptyWorld, freshChat } from "../src/mechanisms/pressure/world.js";
import type { MessageReceived, MessageSent } from "../src/mind/events.js";
import { emptyChat } from "../src/mind/state.js";

const MIN = 60_000;
const H = 60 * MIN;
const T0 = Date.UTC(2026, 10, 15, 2, 0);
const GRP_FRIENDLY = "telegram:-101";
const GRP_GUARDED = "telegram:-202";

function person(id: string, lastBondAt = T0): Relation {
  return {
    name: `User${id}`,
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

function twoGroupWorld(): FairnessWorld {
  return {
    chats: {
      [GRP_FRIENDLY]: freshChat("group"),
      [GRP_GUARDED]: freshChat("group"),
    },
    relations: {
      people: {
        f1: person("f1"),
        f2: person("f2"),
        g1: person("g1"),
        g2: person("g2"),
        g3: person("g3"),
      },
      groups: {},
      waiting: {},
    },
    willingness: {},
    reach: {
      met: {
        f1: { scope: GRP_FRIENDLY, lines: [] },
        f2: { scope: GRP_FRIENDLY, lines: [] },
        g1: { scope: GRP_GUARDED, lines: [] },
        g2: { scope: GRP_GUARDED, lines: [] },
        g3: { scope: GRP_GUARDED, lines: [] },
      },
      titles: { [GRP_FRIENDLY]: "友好群", [GRP_GUARDED]: "防备群" },
      places: {},
      info: [],
    },
  };
}

const sent = (at: number, scope: string): MessageSent => ({
  type: "message.sent",
  at,
  scope,
  messageId: `s${at}`,
  text: "hi",
  kind: "text",
});

const recv = (
  at: number,
  scope: string,
  senderId: string,
  chatType: "private" | "group" = "private",
  directed = true,
): MessageReceived => ({
  type: "message.received",
  at,
  scope,
  chatType,
  messageId: `r${at}`,
  senderId,
  senderName: `User${senderId}`,
  text: "ok",
  contentType: "text",
  replyToMessageId: null,
  directed,
});

describe("cross-dialog first-DM adaptation & protocol delegation", () => {
  it("separates first-DM cost by source group and counts privacy blocks", () => {
    let w = twoGroupWorld();
    let s: FairnessState = initialFairness;
    const dmF1 = privateScopeOf(GRP_FRIENDLY, "f1");
    const dmF2 = privateScopeOf(GRP_FRIENDLY, "f2");
    const dmG1 = privateScopeOf(GRP_GUARDED, "g1");
    const dmG2 = privateScopeOf(GRP_GUARDED, "g2");
    const dmG3 = privateScopeOf(GRP_GUARDED, "g3");

    // Friendly group member f1 replies warmly; guarded group member g1 blocks (transport_soft_permanent) and g2 ignores.
    s = reduceFairness(s, w, sent(T0, dmF1));
    s = reduceFairness(s, w, recv(T0 + 5 * MIN, dmF1, "f1"));
    s = reduceFairness(s, w, {
      type: "act.failed",
      at: T0 + 10 * MIN,
      scope: dmG1,
      act: { kind: "send", text: "hi", replyTo: null },
      reason: "transport_soft_permanent",
    });
    s = reduceFairness(s, w, sent(T0 + 3 * H, dmG2));

    const later = T0 + 24 * H;
    const costFriendly = firstDmCost(s, w, dmF2, later);
    const costGuarded = firstDmCost(s, w, dmG3, later);
    expect(costFriendly).toBeLessThan(1e-4);
    expect(costGuarded).toBeGreaterThan(0.2);

    // Source-group rejection further increases cost for members of the guarded group only.
    const guardedNode = w.chats[GRP_GUARDED] as ChatNode;
    w = {
      ...w,
      chats: {
        ...w.chats,
        [GRP_GUARDED]: {
          ...guardedNode,
          turn: {
            ...guardedNode.turn,
            rejection: rejectFeedback(guardedNode.turn.rejection, "g1", later - 10 * MIN, "stop"),
          },
        },
      },
    };
    expect(firstDmCost(s, w, dmG3, later)).toBeGreaterThan(costGuarded);
    expect(firstDmCost(s, w, dmF2, later)).toBeLessThan(1e-4);
  });

  it("applies per-group cooldown to prevent rapid-fire cold-DM bursts and withholds stranger starvationBoost", () => {
    const w = twoGroupWorld();
    const dmG1 = privateScopeOf(GRP_GUARDED, "g1");
    const dmG2 = privateScopeOf(GRP_GUARDED, "g2");
    const dmF1 = privateScopeOf(GRP_FRIENDLY, "f1");

    let s = reduceFairness(initialFairness, w, sent(T0, dmG1));
    for (let i = 0; i < 15; i++) {
      s = reduceFairness(s, w, sent(T0 + i * MIN, GRP_FRIENDLY));
    }
    const shortly = T0 + 5 * MIN;
    // Same source group g2 incurs strong cooldown right after g1; other group f1 does not.
    const sameGroupCost = firstDmCost(s, w, dmG2, shortly);
    const otherGroupCost = firstDmCost(s, w, dmF1, shortly);
    expect(sameGroupCost).toBeGreaterThan(0.8);
    expect(otherGroupCost).toBe(0);

    // Cooldown decays smoothly over FIRST_DM.groupCoolTau (2h).
    expect(firstDmCost(s, w, dmG2, T0 + 6 * H)).toBeLessThan(sameGroupCost);

    // Unopened strangers never accumulate starvationBoost.
    expect(starvationBoost(s, w, dmG2, T0 + 12 * H)).toBe(0);
  });

  it("supports PTC check_dm protocol lookup, plan_group_dm deferral, and consent clearing", () => {
    const base = twoGroupWorld();
    const world = { ...emptyWorld, ...base };
    const dmG1 = privateScopeOf(GRP_GUARDED, "g1");
    const dmG2 = privateScopeOf(GRP_GUARDED, "g2");

    // Record a failed privacy block in GRP_GUARDED so check_dm sees a guarded history.
    let f = reduceFairness(initialFairness, world, {
      type: "act.failed",
      at: T0,
      scope: dmG1,
      act: { kind: "send", text: "hi", replyTo: null },
      reason: "transport_soft_permanent",
    });

    const w1 = { ...world, fairness: f };
    const dmCheck = delegatedFairness.query?.(
      "dm-check",
      {},
      emptyChat(dmG2, "private", true),
      T0 + 5 * MIN,
      w1,
    ) as ReturnType<typeof groupDmStatsOf> & { canDmDirectly: boolean; protocol: string };
    expect(dmCheck.canDmDirectly).toBe(false);
    expect(dmCheck.protocol).toContain("防备");

    // Defer via plan_group_dm inside cold DM -> projects into GRP_GUARDED doings.
    f = reduceFairness(f, w1, {
      type: "act.done",
      at: T0 + 6 * MIN,
      scope: dmG2,
      act: { kind: "dm-defer", reason: "先问问愿不愿意私聊" },
    });
    const w2 = { ...world, fairness: f };
    const groupContribs =
      delegatedFairness.contribute?.({
        world: w2,
        chat: emptyChat(GRP_GUARDED, "group", true),
        now: T0 + 10 * MIN,
        sought: true,
        outside: false,
        offered: [],
      } as never) ?? [];
    expect(groupContribs.some((c) => c.kind === "doings" && c.text.includes("Userg2"))).toBe(true);

    // She asks in GRP_GUARDED, then g2 replies warmly -> consent granted, firstDmCost drops to 0.
    f = reduceFairness(f, w2, sent(T0 + 11 * MIN, GRP_GUARDED));
    f = reduceFairness(f, w2, recv(T0 + 12 * MIN, GRP_GUARDED, "g2", "group", true));
    const w3 = { ...world, fairness: f };
    expect(firstDmCost(f, w3, dmG2, T0 + 13 * MIN)).toBe(0);
    const afterConsent = delegatedFairness.query?.(
      "dm-check",
      { who: "Userg2" },
      emptyChat(GRP_GUARDED, "group", true),
      T0 + 13 * MIN,
      w3,
    ) as { agreedInGroup: boolean; canDmDirectly: boolean };
    expect(afterConsent.agreedInGroup).toBe(true);
    expect(afterConsent.canDmDirectly).toBe(true);
  });

  it("delegatedFairness composes cleanly with PRODUCTION + reach", () => {
    expect(delegatedFairness.name).toBe("fairness");
    expect(PRODUCTION).toBeDefined();
    expect(reach).toBeDefined();
    expect(FIRST_DM.groupCoolTau).toBe(2 * H);
  });
});
