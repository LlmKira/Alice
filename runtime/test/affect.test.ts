import { describe, expect, it } from "vitest";
import {
  AFFECT,
  type AffectState,
  affect,
  initialAffect,
  moodOf,
  reduceAffect,
  valenceAt,
  type Warmth,
} from "../src/mechanisms/pressure/affect.js";
import { relation, worldFold } from "../src/mechanisms/pressure/index.js";
import { emptyWorld, type World } from "../src/mechanisms/pressure/world.js";
import type { AliceEvent, ChatType } from "../src/mind/events.js";
import { noiseSource } from "../src/noise-source.js";

const H = 3_600_000;
// 东八区下午两点：醒着。
const T0 = Date.parse("2026-11-10T14:00:00+08:00");
const GROUP = "telegram:-100";
const DM_A = "telegram:1";
const DM_B = "telegram:2";

const msg = (
  scope: string,
  chatType: ChatType,
  sender: string,
  at: number,
  directed = chatType === "private",
): AliceEvent => ({
  type: "message.received",
  at,
  scope,
  chatType,
  messageId: `${scope}:${at}`,
  senderId: sender,
  senderName: sender,
  text: "…",
  contentType: "text",
  replyToMessageId: null,
  directed,
});
/**
 * 心情的效价由外壳问判口气的模型，写在事件上（PLAN 第 34 件）。这里用它 2026-11-13 探针给这些词的数
 * （eval-artifacts 外的 scratch/knowledge/scripts/probe-valence.mts）。
 */
const PERCEIVED: Readonly<Record<string, number>> = {
  开心: 0.7,
  委屈: -0.51,
  生气: -0.92,
  难过: -0.67,
  烦: -0.5,
  无聊: -0.32,
};
/** secret：她记下时标了私密（别人托她保密的、明显私密的），原因只守受众规则（PLAN 第 33 件）。 */
const feel = (
  scope: string,
  mood: string,
  why: string | null,
  at: number,
  secret = false,
): AliceEvent => ({
  type: "act.done",
  at,
  scope,
  act: { kind: "feel", mood, why, ...(secret ? { secret: "私密" as const } : {}) },
  ...(PERCEIVED[mood] === undefined ? {} : { valence: PERCEIVED[mood] }),
});
const fold = (events: AliceEvent[], warmth?: Warmth): AffectState =>
  events.reduce((s, e) => reduceAffect(s, e, warmth), initialAffect);

describe("affect: her mood is there unless it would be stale, its reason follows the appraisal and the audience rule", () => {
  it("says nothing when she is only calm, nor where someone came to her since she last took stock", () => {
    const s = fold([msg(DM_A, "private", "a", T0), msg(GROUP, "group", "c", T0)]);
    // 平静是她的常态，不写（context-v2）。
    expect(moodOf(s, GROUP, "group", T0 + 1)).toBeNull();
    // 私聊里刚有人来找她，她还没想过：不写一句不带时间的"平静"。
    expect(moodOf(s, DM_A, "private", T0 + 1)).toBeNull();
    const later = fold([
      msg(DM_A, "private", "a", T0),
      feel(DM_A, "开心", "他记得我说过的", T0 + 60_000),
    ]);
    expect(moodOf(later, DM_A, "private", T0 + 2 * 60_000)).toContain("开心");
  });

  // PLAN 第 33 件：以前所有原因都守受众规则；现在只有她标了私密的守，其余的带到别处、注明在哪。
  const dmFirst = (secret: boolean) =>
    fold([
      msg(DM_A, "private", "a", T0),
      msg(DM_B, "private", "b", T0),
      msg(GROUP, "group", "a", T0),
      feel(DM_A, "委屈", "阿明说我只是个工具", T0 + 60_000, secret),
    ]);
  const elsewhere = [
    [DM_B, "private"],
    [GROUP, "group"],
  ] as const;

  it("a private reason from a private chat never appears in another chat; elsewhere it is only 'something elsewhere'", () => {
    const s = dmFirst(true);
    const now = T0 + 20 * 60_000;
    expect(moodOf(s, DM_A, "private", now)).toContain("阿明说我只是个工具");
    // 她自己的词也是那件事的一部分（"激动且护短"），受众之外只说好坏。
    for (const [scope, type] of elsewhere) {
      const line = moodOf(s, scope, type, now);
      expect(line).not.toContain("阿明");
      expect(line).not.toContain("委屈");
      expect(line).toBe("有点低落（19 分钟前，因为别处的一件事）");
    }
  });

  it("an ordinary reason from a private chat travels, saying where it happened", () => {
    const s = dmFirst(false);
    const now = T0 + 20 * 60_000;
    for (const [scope, type] of elsewhere) {
      expect(moodOf(s, scope, type, now)).toContain("在别的私聊里，因为阿明说我只是个工具");
    }
    const named = moodOf(s, GROUP, "group", now, () => "和a私聊时");
    expect(named).toContain("和a私聊时，因为阿明说我只是个工具");
  });

  it("a private reason from a group reaches the private chat of someone who was there, and no one else's", () => {
    const s = fold([
      msg(GROUP, "group", "a", T0),
      msg(DM_A, "private", "a", T0),
      msg(DM_B, "private", "b", T0),
      feel(GROUP, "生气", "被当成工具使唤", T0 + 60_000, true),
    ]);
    const now = T0 + 20 * 60_000;
    expect(moodOf(s, DM_A, "private", now)).toContain("在一个群里，因为被当成工具使唤");
    expect(moodOf(s, DM_B, "private", now)).not.toContain("工具");
  });

  it("does not keep a mood pinned by saying the same word again (Feb ADR-89 conditional reset)", () => {
    const once = fold([msg(DM_A, "private", "a", T0), feel(DM_A, "难过", null, T0)]);
    const again = fold([
      msg(DM_A, "private", "a", T0),
      feel(DM_A, "难过", null, T0),
      feel(DM_A, "难过", null, T0 + 0.5 * H),
      feel(DM_A, "难过", null, T0 + 1 * H),
    ]);
    // 第二、三次时心情已经回落了不止 0.15，是一份新的难过；但不会比一直说的那一刻更重。
    expect(valenceAt(again, T0 + 3 * H)).toBeGreaterThan(-0.6);
    expect(valenceAt(once, T0 + 6 * H)).toBeCloseTo(AFFECT.mu, 1);
    // 只靠回归，几个小时后回到常态，原因不再出现。
    expect(moodOf(once, DM_A, "private", T0 + 6 * H)).toBeNull();
  });

  it("a low mood hours later is noise, not the old reason coming back", () => {
    const s = fold([msg(DM_A, "private", "a", T0), feel(DM_A, "烦", "4天没理我", T0)]);
    // 九小时后波动恰好又把效价推到负的一侧。
    const later: AffectState = { ...s, valence: -0.3, at: T0 + 9 * H };
    const line = moodOf(later, GROUP, "group", T0 + 9 * H);
    expect(line).not.toContain("没理我");
    expect(line).toBe("有点闷（说不上为什么）");
  });

  it("after she lets something go there, the reason says so; the feeling itself is not erased", () => {
    const s = fold([
      msg(DM_A, "private", "a", T0),
      feel(DM_A, "生气", "他说我烦", T0),
      { type: "act.done", at: T0 + 60_000, scope: DM_A, act: { kind: "let-go", messageId: "x" } },
    ]);
    const line = moodOf(s, DM_A, "private", T0 + 10 * 60_000);
    expect(line).toContain("生气");
    expect(line).toContain("我说过这事先不追究了");
  });

  it("noise moves the mood only through journaled events, reproducibly; the calm ablation ignores them", () => {
    const draw = noiseSource(7);
    const noise: AliceEvent[] = Array.from({ length: 48 }, (_, i) => ({
      type: "noise.drawn",
      at: T0 + i * 5 * 60_000,
      scope: "self",
      draws: draw(),
    }));
    const events = [msg(DM_A, "private", "a", T0), ...noise];
    const run = (o: { noise: boolean }): World => {
      const f = affect({ ...o, lonely: true });
      return events.reduce((w, e) => f.reduce?.(w, w, e) ?? w, emptyWorld);
    };
    const a = run({ noise: true });
    expect(a).toEqual(run({ noise: true }));
    expect(a.affect.valence).not.toBe(AFFECT.mu);
    expect(run({ noise: false }).affect.valence).toBe(AFFECT.mu);
  });

  it("says nobody has come looking for her only after hours awake without anyone seeking her", () => {
    const say = (s: AffectState, now: number) =>
      (
        affect({ noise: true, lonely: true }).contribute?.({
          world: { ...emptyWorld, affect: s },
          chat: { scope: GROUP, chatType: "group" } as never,
          now,
          sought: false,
          outside: false,
          offered: [],
        }) ?? []
      ).map((c) => c.text);
    const s = fold([msg(DM_A, "private", "a", T0)]);
    expect(say(s, T0 + 2 * H).some((t) => t.includes("没有人找过我"))).toBe(false);
    expect(say(s, T0 + 5 * H).some((t) => t.includes("已经 5 小时没有人找过我了"))).toBe(true);
    // 群里别人自己聊天不算找她；被点名才算。
    const named = fold([msg(DM_A, "private", "a", T0), msg(GROUP, "group", "c", T0 + 4 * H, true)]);
    expect(say(named, T0 + 5 * H).some((t) => t.includes("没有人找过我"))).toBe(false);
  });
});

describe("warmth: being sought warms her, a bystander's boredom barely moves her, and she can still be cold", () => {
  const W: Warmth = { home: true, relevance: true, bids: true };
  const start: AffectState = { ...initialAffect, home: 0.19, valence: 0.19 };
  /** 心情读关系事实（他上次来找我、有没有过来往）：世界折叠在前、心情在后，和压力场的次序一样。 */
  const run = (events: AliceEvent[]) => {
    let world = emptyWorld;
    return events.reduce((state, event) => {
      const next = reduceAffect(state, event, W, 0, world.relations);
      world = worldFold({ relation })(world, event);
      return next;
    }, start);
  };
  const sent = (scope: string, at: number): AliceEvent => ({
    type: "message.sent",
    at,
    scope,
    messageId: `me:${at}`,
    text: "嗯",
    kind: "text",
  });
  const reflected = (scope: string, word: string, why: string, at: number): AliceEvent => ({
    type: "ponder.done",
    at,
    scope: "self",
    callId: `r${at}`,
    ponder: {
      kind: "reflect",
      scope,
      entries: [],
      mood: { word, why, ...(PERCEIVED[word] === undefined ? {} : { valence: PERCEIVED[word] }) },
    },
  });
  // 前一天和 a 聊过（a 来找她，她回了）。
  const knewA = [msg(DM_A, "private", "a", T0 - 20 * H), sent(DM_A, T0 - 20 * H + 60_000)];

  it("someone she has talked with, coming back after a while, makes her glad, with them as the reason", () => {
    const s = run([...knewA, msg(DM_A, "private", "a", T0)]);
    expect(moodOf(s, DM_A, "private", T0 + 60_000)).toContain("开心（1 分钟前，因为a来找我）");
    // 一直在聊：一分钟一条，不把她越推越高。
    const chatting = run([
      ...knewA,
      ...Array.from({ length: 10 }, (_, i) => msg(DM_A, "private", "a", T0 + i * 60_000)),
    ]);
    expect(valenceAt(chatting, T0 + 10 * 60_000)).toBeLessThanOrEqual(valenceAt(s, T0) + 1e-9);
  });

  it("someone she has never talked with does not make her glad; a low mood from elsewhere does not follow her to them", () => {
    const s = run([
      msg(GROUP, "group", "c", T0),
      feel(GROUP, "烦", "群里吵", T0 + 60_000),
      msg(DM_B, "private", "b", T0 + 2 * 60_000),
    ]);
    const line = moodOf(s, DM_B, "private", T0 + 3 * 60_000) ?? "";
    expect(line).not.toContain("开心");
    expect(line).not.toContain("别处");
    expect(valenceAt(s, T0 + 2 * 60_000)).toBeCloseTo(0.19, 2);
  });

  it("a person who upset her, following her into a private chat, does not lift that mood", () => {
    const s = run([
      ...knewA,
      msg(GROUP, "group", "a", T0, true),
      sent(GROUP, T0 + 30_000),
      feel(GROUP, "生气", "被当众挑衅", T0 + 60_000),
      msg(DM_A, "private", "a", T0 + 40 * 60_000),
    ]);
    const line = moodOf(s, DM_A, "private", T0 + 41 * 60_000) ?? "";
    expect(line).toContain("生气");
    expect(line).not.toContain("开心");
  });

  it("a reflection on a chat she only watched barely moves her; one where she was sought counts in full", () => {
    const watched = run([
      msg(GROUP, "group", "c", T0),
      reflected(GROUP, "无聊", "全是机器人刷屏", T0 + 10 * 60_000),
    ]);
    expect(moodOf(watched, GROUP, "group", T0 + 11 * 60_000)).toBeNull();
    const sought = run([
      msg(GROUP, "group", "c", T0, true),
      reflected(GROUP, "无聊", "全是机器人刷屏", T0 + 10 * 60_000),
    ]);
    expect(moodOf(sought, GROUP, "group", T0 + 11 * 60_000)).toContain("无聊");
  });
});

describe("tone: an unfriendly approach does not make her glad", () => {
  const W: Warmth = { home: true, relevance: true, bids: true };
  const WT: Warmth = { ...W, tone: true };
  const start: AffectState = { ...initialAffect, home: 0.19, valence: 0.19 };
  /** 心情读关系事实（他上次来找我、有没有过来往）：世界折叠在前、心情在后，和压力场的次序一样。 */
  const run = (events: AliceEvent[], w: Warmth) => {
    let world = emptyWorld;
    return events.reduce((state, event) => {
      const next = reduceAffect(state, event, w, 0, world.relations);
      world = worldFold({ relation })(world, event);
      return next;
    }, start);
  };
  const sent = (scope: string, at: number): AliceEvent => ({
    type: "message.sent",
    at,
    scope,
    messageId: `me:${at}`,
    text: "嗯",
    kind: "text",
  });
  const perceived = (
    scope: string,
    at: number,
    tone: "hostile" | "cold" | "friendly",
  ): AliceEvent => ({
    type: "message.perceived",
    at: at + 2_000,
    scope,
    messageId: `${scope}:${at}`,
    tone,
  });
  const knewA = [msg(DM_A, "private", "a", T0 - 20 * H), sent(DM_A, T0 - 20 * H + 60_000)];

  it("a hostile message from someone she knows no longer leaves her glad once its tone is in", () => {
    const events = [...knewA, msg(DM_A, "private", "a", T0), perceived(DM_A, T0, "hostile")];
    expect(moodOf(run(events, W), DM_A, "private", T0 + 60_000)).toContain("因为a来找我");
    expect(moodOf(run(events, WT), DM_A, "private", T0 + 60_000) ?? "").not.toContain("来找我");
    // 友好的照常推向开心。
    const friendly = [...knewA, msg(DM_A, "private", "a", T0), perceived(DM_A, T0, "friendly")];
    expect(moodOf(run(friendly, WT), DM_A, "private", T0 + 60_000)).toContain("因为a来找我");
  });

  it("only that push is undone: a newer appraisal of her own stays", () => {
    const events = [
      ...knewA,
      msg(DM_A, "private", "a", T0),
      feel(DM_A, "委屈", "他又在挖苦我", T0 + 1_000),
      perceived(DM_A, T0, "hostile"),
    ];
    expect(moodOf(run(events, WT), DM_A, "private", T0 + 60_000)).toContain("委屈");
  });

  it("answering a hostile first message does not make the sender someone she has had an exchange with", () => {
    const exchanges = (events: AliceEvent[]) =>
      events.reduce(worldFold({ relation }), emptyWorld).relations.people.b?.warmth.exchanges ?? 0;
    const hostile = [
      msg(DM_B, "private", "b", T0),
      perceived(DM_B, T0, "hostile"),
      sent(DM_B, T0 + 60_000),
    ];
    expect(exchanges([msg(DM_B, "private", "b", T0), sent(DM_B, T0 + 60_000)])).toBe(1);
    expect(exchanges(hostile)).toBe(0);
  });
});
