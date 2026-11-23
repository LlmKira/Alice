/**
 * 她够得着的人（A10，mechanisms/pressure/reach.ts）：在群里认识、还没私聊过的人。
 * 只测坏掉了会很糟的：送达（选中时在那个私聊里叫醒她、知道你们在哪认识的）、受众（只写那个人在群里公开说的话）、
 * 不串会话（动作只发往做决定的私聊）、不刷人（考虑过就消耗、对方不回时 30 天里的连找不超过 2 月真人的上限）。
 */
import { describe, expect, it } from "vitest";
import {
  createPressure,
  PRODUCTION,
  pressureProduction,
  reach as reachFeature,
} from "../src/mechanisms/pressure/index.js";
import {
  foundText,
  itemId,
  joinCost,
  mayForward,
  privateScopeOf,
} from "../src/mechanisms/pressure/reach.js";
import { emptyWorld, reduceWorld, type World } from "../src/mechanisms/pressure/world.js";
import { mechanisms } from "../src/mechanisms/registry.js";
import { affordanceOf, affordances } from "../src/mind/affordances.js";
import type { SpeechRequest } from "../src/mind/effects.js";
import type {
  AliceEvent,
  FoundPlace,
  MessageReceived,
  SpeechDecision,
} from "../src/mind/events.js";
import { emptyState } from "../src/mind/state.js";
import { step } from "../src/mind/step.js";
import { replay } from "../src/sim/replay.js";
import { arms } from "../src/sim/will-arms.js";

/** 本地（UTC+8）11 月 12 日 10:00，醒着。 */
const T0 = Date.UTC(2026, 10, 12, 2, 0);
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const GROUP = "telegram:-100";
/** 2 月真人对不回应的人最多连着开口 3 次（与 pressure-properties S2 同一个上限）。 */
const FEB_MAX_BIDS = 3;

const reach = createPressure(affordances, { ...PRODUCTION, reach: reachFeature });
const withReach = [reach, ...mechanisms.filter((m) => m !== pressureProduction)];

let n = 0;
function msg(at: number, o: Partial<MessageReceived> = {}): MessageReceived {
  n++;
  const scope = o.scope ?? GROUP;
  return {
    type: "message.received",
    at,
    scope,
    chatType: scope.startsWith("telegram:-") ? "group" : "private",
    messageId: `m${n}`,
    senderId: "100",
    senderName: "小林",
    text: "hi",
    contentType: "text",
    replyToMessageId: null,
    directed: false,
    ...(scope.startsWith("telegram:-") ? { chatTitle: "周末爬山群" } : {}),
    ...o,
  };
}

/** 一个群：小林对她说过几句（认识），阿树只是在群里说话（不认识）；另有一个私聊里别人说了句私事。 */
function world(): AliceEvent[] {
  return [
    msg(T0 - D, { text: "爱丽丝周末去爬山吗", directed: true }),
    {
      type: "message.sent",
      at: T0 - D + 30_000,
      scope: GROUP,
      messageId: "s0",
      text: "好呀",
      kind: "text",
    },
    msg(T0, { text: "爱丽丝你周末去爬山吗", directed: true }),
    {
      type: "message.sent",
      at: T0 + 20_000,
      scope: GROUP,
      messageId: "s1",
      text: "几点出发",
      kind: "text",
    },
    msg(T0 + MIN, { text: "我带了新的登山杖", directed: true }),
    msg(T0 + 2 * MIN, { senderId: "200", senderName: "阿树", text: "阿树的群里闲话" }),
    msg(T0 + 3 * MIN, {
      scope: "telegram:300",
      senderId: "300",
      senderName: "小雨",
      text: "小雨的私事别说出去",
    }),
  ];
}

/** 让时钟走到 until：在另一个群里放一条无关的消息（回放只在第一条到最后一条事件之间走时钟）。 */
const until = (at: number) => msg(at, { scope: "telegram:-999", senderId: "999", text: "." });

type Oracle = (request: SpeechRequest) => SpeechDecision;
const quiet: Oracle = () => ({ acts: [] });
const sayInPrivate: Oracle = (r) =>
  r.chatType === "private" && r.triggerMessageId === null
    ? { acts: [{ kind: "send", text: "嗨", replyTo: null }] }
    : { acts: [] };

async function run(events: AliceEvent[], oracle: Oracle, tickMs = 60_000) {
  const requests: SpeechRequest[] = [];
  const result = await replay(events, {
    mechanisms: withReach,
    tickMs,
    speech: (request) => {
      requests.push(request);
      return oracle(request);
    },
  });
  return { requests, result };
}

const DM = privateScopeOf(GROUP, "100");

// 这几条要回放一到三天、每 10 秒一格（单跑 1.5–4 秒）；全套并行、机器忙时会超过默认的 5 秒。
describe(
  "reach: a private chat with someone she knows from a group (A10)",
  { timeout: 60_000 },
  () => {
    let cachedQuietDay: ReturnType<typeof run> | null = null;
    const quietDay = () => (cachedQuietDay ??= run([...world(), until(T0 + D)], quiet));

    it("opens the private chat in that person's own scope, and says where they met", async () => {
      expect(DM).toBe("telegram:100");
      const { requests } = await quietDay();
      const first = requests.find((r) => r.scope === DM);
      expect(first).toBeDefined();
      expect(first?.chatType).toBe("private");
      expect(first?.timeline).toEqual([]);
      const met = first?.contributions.find((c) => c.mechanism === "pressure-reach")?.text ?? "";
      expect(met).toContain("周末爬山群");
      expect(met).toContain("我带了新的登山杖");
    });

    it("puts only that person's public lines from the group into the private chat", async () => {
      const { requests } = await quietDay();
      const all = requests
        .filter((r) => r.scope === DM)
        .flatMap((r) => r.contributions.map((c) => c.text))
        .join("\n");
      expect(all).not.toContain("阿树的群里闲话");
      expect(all).not.toContain("小雨的私事");
    });

    it("never opens a private chat with someone she has only watched talk in the group", async () => {
      const { requests } = await run([...world(), until(T0 + 3 * D)], sayInPrivate);
      expect(requests.some((r) => r.scope === privateScopeOf(GROUP, "200"))).toBe(false);
    });

    it("acts only in the private chat that made the decision, and cannot quote the group there", async () => {
      // 她在新私聊里想引用群里那条消息（m2）、给它点表情：引用丢掉、表情不成立，话照说，只发往这个私聊。
      const quoting: Oracle = (r) =>
        r.scope === DM
          ? {
              acts: [
                { kind: "send", text: "你说的登山杖", replyTo: "m2" },
                { kind: "react", messageId: "m2", emoji: "👍" },
              ],
            }
          : { acts: [] };
      const { result } = await run([...world(), until(T0 + D)], quoting);
      const acts = result.effects.flatMap((r) => (r.effect.type === "act" ? [r.effect] : []));
      expect(acts.length).toBeGreaterThan(0);
      for (const a of acts) {
        expect(a.scope).toBe(DM);
        expect(a.act).toEqual({ kind: "send", text: "你说的登山杖", replyTo: null });
      }
    });

    it("does not open a second chat with someone she already has a private chat with", async () => {
      const events = [
        ...world(),
        msg(T0 + 4 * MIN, { scope: "telegram:100", text: "私聊里说句话", directed: true }),
        until(T0 + D),
      ];
      const { result } = await run(events, quiet);
      const scopes = Object.keys(result.state.chats).filter((s) => !s.startsWith("telegram:-"));
      expect(scopes.sort()).toEqual(["telegram:100", "telegram:300"]);
    });

    it("thinking it over and deciding not to is consumed like any private chat", async () => {
      const { requests, result } = await quietDay();
      const times = requests.filter((r) => r.scope === DM).map((r) => r.at);
      const w = result.state.mechanisms[reach.name] as World;
      expect(w.chats[DM]?.partner).toBe("100");
      // 想过、决定先不：不是每个节律格都再问一遍（隔开至少半小时）。
      for (let i = 1; i < times.length; i++) {
        expect((times[i] as number) - (times[i - 1] as number)).toBeGreaterThanOrEqual(30 * MIN);
      }
    });

    it("after an unanswered first message, at most Feb's bids in 30 days (as S2 after her reply)", async () => {
      // 和 pressure-properties 的 S2 同一个口径：S2 从她回了对方一句之后数主动开口；这里从她开场的那一句之后数。
      // 按 2 月"连找"的口径（开场那句也算主动）会多数一次，见 eval-artifacts/social/prereg.md。
      const { result } = await run([...world(), until(T0 + 30 * D)], sayInPrivate, 60_000);
      const messages = result.effects.filter(
        (r) => r.effect.type === "act" && r.effect.scope === DM && r.effect.act.kind === "send",
      );
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.length - 1).toBeLessThanOrEqual(FEB_MAX_BIDS);
    });

    it("is off in no-reach ablation: no private chat appears that nobody started, and no group search", async () => {
      const noReach = arms({})["no-reach"] ?? [];
      const requests: SpeechRequest[] = [];
      await replay([...world(), until(T0 + D)], {
        mechanisms: noReach,
        tickMs: 60_000,
        speech: (r) => {
          requests.push(r);
          return { acts: [] };
        },
      });
      expect(requests.some((r) => r.scope === DM)).toBe(false);
      expect(requests.flatMap((r) => r.affordances)).not.toContain("chat-search");
    });
  },
);

describe("reach: groups and channels she has looked at (A18, A08)", () => {
  const LINK = "https://t.me/+abcDEF";
  const PLACE: FoundPlace = {
    scope: "telegram:+abcDEF",
    kind: "group",
    title: "胶片冲洗互助",
    about: "冲洗、扫描、器材交流",
    members: 230,
    recent: ["今天的卷子出来了"],
  };
  const FRIEND = "telegram:300";
  /** 小雨在私聊里发来一个群链接；之后很久都安静（她不缺事做时就不会想去新群）。 */
  const invited = (): AliceEvent[] => [
    msg(T0, {
      scope: FRIEND,
      senderId: "300",
      senderName: "小雨",
      text: `这个群你可能喜欢 ${LINK}`,
      directed: true,
    }),
    until(T0 + D),
  ];
  const look = (_scope: string, act: { kind: string }) =>
    act.kind === "chat-search" ? { result: foundText(LINK, [PLACE]), found: [PLACE] } : null;
  /** 在私聊里看一眼链接；去那个群时：想加就加。 */
  const oracle =
    (join: boolean): Oracle =>
    (r) => {
      if (r.scope === FRIEND && r.triggerMessageId !== null)
        return { acts: [{ kind: "chat-search", query: LINK }] };
      if (r.scope === PLACE.scope) return join ? { acts: [{ kind: "join-chat" }] } : { acts: [] };
      return { acts: [] };
    };

  async function runPlaces(events: AliceEvent[], o: Oracle) {
    const requests: SpeechRequest[] = [];
    const result = await replay(events, {
      mechanisms: withReach,
      tickMs: 60_000,
      look,
      speech: (request) => {
        requests.push(request);
        return o(request);
      },
    });
    return { requests, result };
  }

  let cachedDeclined: ReturnType<typeof runPlaces> | null = null;
  const declinedRun = () => (cachedDeclined ??= runPlaces(invited(), oracle(false)));

  it("offers looking for groups where the reach candidate runs", async () => {
    const { requests } = await declinedRun();
    expect(requests.find((r) => r.scope === FRIEND)?.affordances).toContain("chat-search");
  });

  it("the preview comes back into the chat where she looked", async () => {
    const { requests } = await declinedRun();
    const after = requests.filter((r) => r.scope === FRIEND && (r.looked?.length ?? 0) > 0);
    expect(after[0]?.looked?.[0]?.text).toContain("胶片冲洗互助");
  });

  it("visits the group in its own chat, where joining is the only thing she can do", async () => {
    const { requests } = await declinedRun();
    const visit = requests.find((r) => r.scope === PLACE.scope);
    expect(visit).toBeDefined();
    const outward = (visit?.affordances ?? []).filter((k) => affordanceOf(k).via !== "mind");
    expect(outward).toEqual(["join-chat"]);
    const scene = visit?.contributions.map((c) => c.text).join("\n") ?? "";
    expect(scene).toContain("胶片冲洗互助");
    expect(scene).toContain("230 人");
    // 那个群的会话里不写是谁在私聊里发来的。
    expect(scene).not.toContain("小雨");
  });

  it("joins only the group whose chat made the decision; afterwards it is not a candidate", async () => {
    const { requests, result } = await runPlaces(invited(), oracle(true));
    const joins = result.effects.flatMap((r) =>
      r.effect.type === "act" && r.effect.act.kind === "join-chat" ? [r.effect] : [],
    );
    expect(joins.length).toBe(1);
    expect(joins[0]?.scope).toBe(PLACE.scope);
    expect(result.state.chats[PLACE.scope]?.member).toBe(true);
    const visits = requests.filter((r) => r.scope === PLACE.scope);
    expect(visits.length).toBe(1);
  });

  it("deciding not to join is consumed: she does not reconsider at every beat", async () => {
    const { requests } = await declinedRun();
    const times = requests.filter((r) => r.scope === PLACE.scope).map((r) => r.at);
    expect(times.length).toBeGreaterThan(0);
    for (let i = 1; i < times.length; i++) {
      expect((times[i] as number) - (times[i - 1] as number)).toBeGreaterThanOrEqual(30 * MIN);
    }
  });

  it("joining costs more the more groups she is already active in", () => {
    const groups = (k: number): World => {
      let w = emptyWorld;
      for (let i = 0; i < k; i++) w = reduceWorld(w, msg(T0, { scope: `telegram:-${i + 1}` }));
      return w;
    };
    expect(joinCost(groups(0), T0)).toBe(0);
    expect(joinCost(groups(8), T0)).toBeGreaterThan(joinCost(groups(2), T0));
  });
});

describe(
  "reach: what she sees in channels, sharing it and forwarding (P02, M03, B04, A14)",
  { timeout: 60_000 },
  () => {
    const CHANNEL = "telegram:-1009";
    const FRIEND = "telegram:300";
    const OTHER = "telegram:400";
    const post = (at: number, text: string): AliceEvent => ({
      type: "post.received",
      at,
      scope: CHANNEL,
      messageId: "77",
      title: "冷知识日报",
      text,
    });
    /** 两个常来私聊的朋友（下午聊过），晚上频道来了一条新帖。 */
    const friends = (): AliceEvent[] => {
      const ev: AliceEvent[] = [];
      for (let d = 7; d >= 0; d--) {
        const at = T0 - d * D;
        ev.push(
          msg(at, {
            scope: FRIEND,
            senderId: "300",
            senderName: "小雨",
            text: "今天天气真不错，你那边怎么样呀？",
            directed: true,
          }),
          {
            type: "message.sent",
            at: at + 20_000,
            scope: FRIEND,
            messageId: `sf${d}`,
            text: "还挺好的",
            kind: "text",
          },
          msg(at + MIN, {
            scope: OTHER,
            senderId: "400",
            senderName: "阿树",
            text: "刚下班回来，今天忙坏了",
            directed: true,
          }),
          {
            type: "message.sent",
            at: at + 2 * MIN,
            scope: OTHER,
            messageId: `so${d}`,
            text: "辛苦啦",
            kind: "text",
          },
        );
      }
      ev.push(
        msg(T0 + 2 * MIN, { scope: GROUP, senderId: "500", senderName: "老周", text: "群里说话" }),
        post(T0 + 3 * H, "章鱼有三颗心脏"),
        until(T0 + D),
      );
      return ev;
    };
    const ID = itemId(CHANNEL, "77");
    let cachedFriendsQuiet: ReturnType<typeof run> | null = null;
    const friendsQuiet = () => (cachedFriendsQuiet ??= run(friends(), quiet));

    it("a post never wakes her by itself and never enters a chat's timeline", () => {
      const r = step(emptyState, post(T0, "章鱼有三颗心脏"), withReach);
      expect(r.effects).toEqual([]);
      expect(r.state.chats).toEqual({});
    });

    it("is put before her in private chats, with a number to forward; offered only there", async () => {
      const { requests } = await friendsQuiet();
      const later = requests.filter((r) => r.at > T0 + 3 * H);
      const inPrivate = later.find(
        (r) => r.chatType === "private" && r.contributions.some((c) => c.text.includes(ID)),
      );
      expect(inPrivate).toBeDefined();
      expect(inPrivate?.affordances).toContain("forward");
      for (const r of later.filter((x) => x.chatType === "group")) {
        expect(r.contributions.map((c) => c.text).join("\n")).not.toContain("章鱼");
        expect(r.affordances).not.toContain("forward");
      }
    });

    it("the urge to share wakes her in a private chat after the post (information has a source)", async () => {
      // 帖子来了之后，她第一次主动去私聊的时刻比没有这条帖子时早（早出来的就是想分享）。
      const firstFrom = (rs: readonly SpeechRequest[]) =>
        rs.find(
          (r) => r.at >= T0 + 3 * H && r.chatType === "private" && r.triggerMessageId === null,
        )?.at ?? Number.POSITIVE_INFINITY;
      const without = friends().filter((e) => e.type !== "post.received");
      expect(firstFrom((await friendsQuiet()).requests)).toBeLessThan(
        firstFrom((await run(without, quiet)).requests),
      );
    });

    it("thinking it over with one friend uses it up for that friend only", async () => {
      const { requests } = await friendsQuiet();
      const shownTo = (scope: string) =>
        requests.filter(
          (r) => r.scope === scope && r.contributions.some((c) => c.text.includes(ID)),
        ).length;
      // 跟每个朋友最多摆一次；跟一个人想过了，不挡着另一个人。
      expect(shownTo(FRIEND)).toBeLessThanOrEqual(1);
      expect(shownTo(OTHER)).toBeLessThanOrEqual(1);
      expect(shownTo(FRIEND) + shownTo(OTHER)).toBeGreaterThan(0);
    });

    it("a forward goes only to the chat that decided it", async () => {
      const forwarding: Oracle = (r) =>
        r.chatType === "private" && r.affordances.includes("forward")
          ? { acts: [{ kind: "forward", item: ID }] }
          : { acts: [] };
      const { result } = await run(friends(), forwarding);
      const forwards = result.effects.flatMap((r) =>
        r.effect.type === "act" && r.effect.act.kind === "forward" ? [r.effect] : [],
      );
      expect(forwards.length).toBeGreaterThan(0);
      const decided = result.effects.flatMap((r) =>
        r.effect.type === "call-speech" ? [r.effect.scope] : [],
      );
      for (const f of forwards) expect(decided).toContain(f.scope);
    });

    // PLAN 第 33 件以前群里的只转回原群或给当时在场的人；当众说的不算托付的事，现在转到哪都行。
    it("the audience rule: private never leaves; a group's message may go anywhere", () => {
      const dm = (partner: string) => ({
        scope: `telegram:${partner}`,
        chatType: "private" as const,
        partner,
      });
      expect(mayForward({ kind: "channel" }, dm("1"))).toBe(true);
      expect(mayForward({ kind: "private", scope: "telegram:2" }, dm("1"))).toBe(false);
      expect(
        mayForward({ kind: "private", scope: "telegram:2" }, { ...dm("2"), scope: "telegram:2" }),
      ).toBe(false);
      const fromGroup = { kind: "group" as const, scope: GROUP, present: ["1"] };
      expect(mayForward(fromGroup, { scope: GROUP, chatType: "group", partner: null })).toBe(true);
      expect(
        mayForward(fromGroup, { scope: "telegram:-7", chatType: "group", partner: null }),
      ).toBe(true);
      expect(mayForward(fromGroup, dm("1"))).toBe(true);
      expect(mayForward(fromGroup, dm("3"))).toBe(true);
    });
  },
);

describe("privateScopeOf: the private chat with someone met in a group", () => {
  it("Telegram: the group id is replaced by the person's id", () => {
    expect(privateScopeOf("telegram:-100123", "456")).toBe("telegram:456");
  });

  it("platforms that write the chat kind into the id: group becomes private", () => {
    expect(privateScopeOf("qq:group:123", "456")).toBe("qq:private:456");
  });
});
