import { describe, expect, it } from "vitest";
import { decayedAttachment } from "../src/mechanisms/pressure/attachment.js";
import {
  attachmentLoop,
  emptyWorld,
  intentionsFor,
  PRODUCTION,
  reflectDiaryEmotive,
  willOf,
  worldFold,
} from "../src/mechanisms/pressure/index.js";
import { mechanisms } from "../src/mechanisms/registry.js";
import { affordances } from "../src/mind/affordances.js";
import type { AliceEvent } from "../src/mind/events.js";
import { emptyChat, emptyState } from "../src/mind/state.js";
import { speechRequest, step } from "../src/mind/step.js";
import { arms } from "../src/sim/will-arms.js";
import { renderSpeechPrompt } from "../src/speech/prompt.js";

const T0 = 1_772_500_000_000;
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;

const COMP = { ...PRODUCTION, diary: reflectDiaryEmotive, attachment: attachmentLoop };
const fold = worldFold(COMP);
const POLICY = willOf(COMP);

function runEvents(events: AliceEvent[]) {
  return events.reduce((w, e) => fold(w, e), emptyWorld);
}

describe("ADR-299 attachmentLoop & reflectDiaryEmotive", () => {
  it("persists slow scars past 6h, resists single let-go, and heals only through repeated warm turns", () => {
    const events: AliceEvent[] = [
      {
        type: "message.received",
        at: T0,
        scope: "telegram:u1",
        chatType: "private",
        messageId: "m1",
        senderId: "u1",
        senderName: "阿然",
        text: "别来凑近乎 挺窒息的",
        contentType: "text",
        replyToMessageId: null,
        directed: true,
      },
      {
        type: "message.perceived",
        at: T0 + 1000,
        scope: "telegram:u1",
        messageId: "m1",
        tone: "hostile",
      },
    ];
    const wHurt = runEvents(events);
    const after6h = decayedAttachment(wHurt.attachment?.people.u1, T0 + 6 * H);
    expect(after6h.scar).toBeGreaterThan(0.28);

    // 口头 let-go 只微减，不立刻清零
    const wLetGo = fold(wHurt, {
      type: "act.done",
      at: T0 + 5 * MIN,
      scope: "telegram:u1",
      act: { kind: "let-go", messageId: "m1" },
    });
    const afterLetGo = decayedAttachment(wLetGo.attachment?.people.u1, T0 + 6 * H);
    expect(afterLetGo.scar).toBeGreaterThan(0.24);

    // 多次间隔真诚友好互动才逐渐软化
    let wHealed = wLetGo;
    for (let i = 1; i <= 4; i++) {
      const at = T0 + i * H;
      wHealed = fold(wHealed, {
        type: "message.received",
        at,
        scope: "telegram:u1",
        chatType: "private",
        messageId: `f${i}`,
        senderId: "u1",
        senderName: "阿然",
        text: "对不起 我认真想过了",
        contentType: "text",
        replyToMessageId: null,
        directed: true,
      });
      wHealed = fold(wHealed, {
        type: "message.perceived",
        at: at + 1000,
        scope: "telegram:u1",
        messageId: `f${i}`,
        tone: "friendly",
      });
    }
    const healed = decayedAttachment(wHealed.attachment?.people.u1, T0 + 6 * H);
    expect(healed.scar).toBeLessThan(afterLetGo.scar * 0.65);
  });

  it("cuts deeper on group humiliation than private friction, and lifts group attraction toward attached friends", () => {
    const baseMsg = (
      scope: string,
      chatType: "group" | "private",
      id: string,
      msgId: string,
    ): AliceEvent[] => [
      {
        type: "message.received",
        at: T0,
        scope,
        chatType,
        messageId: msgId,
        senderId: id,
        senderName: id,
        text: "公开嘲笑一句",
        contentType: "text",
        replyToMessageId: null,
        directed: true,
      },
      { type: "message.perceived", at: T0 + 500, scope, messageId: msgId, tone: "hostile" },
    ];
    const wGroup = runEvents(baseMsg("telegram:-1001", "group", "bad_g", "mg1"));
    const wDm = runEvents(baseMsg("telegram:bad_p", "private", "bad_p", "mp1"));
    const scarGroup = decayedAttachment(wGroup.attachment?.people.bad_g, T0 + 1000).scar;
    const scarDm = decayedAttachment(wDm.attachment?.people.bad_p, T0 + 1000).scar;
    expect(scarGroup).toBeGreaterThan(scarDm);

    // 与 uWarm 在私聊经历深刻温暖接住后，她在群里看到 uWarm 发言时会自然倾心
    const warmEvents: AliceEvent[] = [
      {
        type: "message.received",
        at: T0,
        scope: "telegram:uWarm",
        chatType: "private",
        messageId: "w1",
        senderId: "uWarm",
        senderName: "子墨",
        text: "我在呢 你慢慢说",
        contentType: "text",
        replyToMessageId: null,
        directed: true,
      },
      {
        type: "act.done",
        at: T0 + MIN,
        scope: "telegram:uWarm",
        act: { kind: "feel", mood: "心里暖暖的", why: "被人稳稳接住了" },
        valence: 0.85,
      },
      {
        type: "act.done",
        at: T0 + 2 * H,
        scope: "telegram:uWarm",
        act: { kind: "feel", mood: "很安心", why: "深夜还陪着" },
        valence: 0.9,
      },
      {
        type: "message.received",
        at: T0 + 3 * H,
        scope: "telegram:-200",
        chatType: "group",
        messageId: "g_warm",
        senderId: "uWarm",
        senderName: "子墨",
        text: "刚忙完过来冒泡",
        contentType: "text",
        replyToMessageId: null,
        directed: false,
      },
      {
        type: "message.received",
        at: T0 + 3 * H,
        scope: "telegram:-201",
        chatType: "group",
        messageId: "g_stranger",
        senderId: "uOther",
        senderName: "路人甲",
        text: "刚忙完过来冒泡",
        contentType: "text",
        replyToMessageId: null,
        directed: false,
      },
    ];
    const wWarm = runEvents(warmEvents);
    const warmRead = { scope: "telegram:-200", solicited: false } as never;
    const coldRead = { scope: "telegram:-201", solicited: false } as never;
    expect(POLICY.intrinsicGain?.(wWarm, warmRead, T0 + 3 * H + MIN)).toBeGreaterThan(
      POLICY.intrinsicGain?.(wWarm, coldRead, T0 + 3 * H + MIN) ?? 1,
    );
  });

  it("tracks proactive outreach outcome and lets fresh warmth gently dilute stale unrelated scars", () => {
    const events: AliceEvent[] = [
      {
        type: "message.received",
        at: T0,
        scope: "telegram:uA",
        chatType: "private",
        messageId: "a1",
        senderId: "uA",
        senderName: "阿然",
        text: "在吗",
        contentType: "text",
        replyToMessageId: null,
        directed: true,
      },
      {
        type: "message.sent",
        at: T0 + MIN,
        scope: "telegram:uA",
        messageId: "s1",
        text: "在呀",
        kind: "text",
      },
      // 主动发出去但一直未回
      {
        type: "message.sent",
        at: T0 + 8 * H,
        scope: "telegram:uA",
        messageId: "s2",
        text: "你忙完啦？",
        kind: "text",
      },
      {
        type: "message.sent",
        at: T0 + 16 * H,
        scope: "telegram:uA",
        messageId: "s3",
        text: "还在吗",
        kind: "text",
      },
      // 别人刺伤她留下疤，之后她在第三位朋友处得到温暖体验
      {
        type: "message.received",
        at: T0 + 17 * H,
        scope: "telegram:troll",
        chatType: "private",
        messageId: "t1",
        senderId: "troll",
        senderName: "路人刺",
        text: "你好烦",
        contentType: "text",
        replyToMessageId: null,
        directed: true,
      },
      {
        type: "message.perceived",
        at: T0 + 17 * H + 500,
        scope: "telegram:troll",
        messageId: "t1",
        tone: "hostile",
      },
    ];
    const beforeDilute = runEvents(events);
    expect(beforeDilute.attachment?.people.uA?.proactiveMissed).toBeGreaterThan(0);
    const scarBefore = beforeDilute.attachment?.people.troll?.scar ?? 0;

    const afterWarm = runEvents([
      ...events,
      {
        type: "message.received",
        at: T0 + 18 * H,
        scope: "telegram:uB",
        chatType: "private",
        messageId: "b1",
        senderId: "uB",
        senderName: "知微",
        text: "晚霞分你一半",
        contentType: "text",
        replyToMessageId: null,
        directed: true,
      },
      {
        type: "act.done",
        at: T0 + 18 * H + 1000,
        scope: "telegram:uB",
        act: { kind: "feel", mood: "很开心", why: "被人惦记真好" },
        valence: 0.85,
      },
    ]);
    const scarAfter = decayedAttachment(
      afterWarm.attachment?.people.troll,
      T0 + 18 * H + 1000,
    ).scar;
    expect(scarAfter).toBeLessThan(scarBefore);

    // 有疤的对象 approaching 代价明显高于未受伤对象（但不设为硬封锁）
    const scarDmSend = intentionsFor(
      afterWarm,
      affordances,
      "telegram:troll",
      T0 + 19 * H,
      POLICY,
    ).find((i) => i.affordance === "send");
    const warmDmSend = intentionsFor(
      afterWarm,
      affordances,
      "telegram:uB",
      T0 + 19 * H,
      POLICY,
    ).find((i) => i.affordance === "send");
    expect(scarDmSend).toBeDefined();
    expect(warmDmSend).toBeDefined();
    if (scarDmSend && warmDmSend) {
      expect(scarDmSend.socialCost).toBeGreaterThan(warmDmSend.socialCost);
    }
  });

  it("recalls high-shock memories across >48h without leaking private diaries to outsiders", () => {
    const mechs = arms({})["emergent-loop-v1"];
    expect(mechs).toBeDefined();
    if (!mechs) return;
    const events: AliceEvent[] = [
      {
        type: "message.received",
        at: T0,
        scope: "telegram:uDear",
        chatType: "private",
        messageId: "d1",
        senderId: "uDear",
        senderName: "知微",
        text: "不管你在哪 我都会记得你的",
        contentType: "text",
        replyToMessageId: null,
        directed: true,
      },
      {
        type: "ponder.done",
        at: T0 + 10 * MIN,
        scope: "telegram:uDear",
        callId: "r1",
        ponder: {
          kind: "reflect",
          scope: "telegram:uDear",
          entries: [
            {
              about: "uDear",
              text: "知微说不管我在哪都会记得我 那一刻心跳漏了一拍",
              importance: 9,
              private: true,
            },
          ],
          mood: { word: "心软心动", why: "被认真记住了", valence: 0.9, private: true },
        },
      },
      // 后续几天聊了三十多条日常，把 d1 顶出当前 30 条时间线窗口，再写一条过了 48h 的普通小事对照
      ...Array.from({ length: 32 }, (_, i) => ({
        type: "message.received" as const,
        at: T0 + D + i * 10 * MIN,
        scope: "telegram:uDear",
        chatType: "private" as const,
        messageId: `fill_${i}`,
        senderId: "uDear",
        senderName: "知微",
        text: `今天路过买了个面包 ${i}`,
        contentType: "text",
        replyToMessageId: null,
        directed: true,
      })),
      {
        type: "ponder.done",
        at: T0 + D + 33 * 10 * MIN,
        scope: "telegram:uDear",
        callId: "r2",
        ponder: {
          kind: "reflect",
          scope: "telegram:uDear",
          entries: [{ about: null, text: "路过面包店听说了新品", importance: 4 }],
          mood: { word: "平静", why: null, valence: 0.2 },
        },
      },
      // 4 天后另一群聊和当事私聊对照
      {
        type: "message.received",
        at: T0 + 4 * D,
        scope: "telegram:-500",
        chatType: "group",
        messageId: "o1",
        senderId: "stranger",
        senderName: "路人乙",
        text: "今天吃啥",
        contentType: "text",
        replyToMessageId: null,
        directed: true,
      },
      {
        type: "message.received",
        at: T0 + 4 * D + MIN,
        scope: "telegram:uDear",
        chatType: "private",
        messageId: "d2",
        senderId: "uDear",
        senderName: "知微",
        text: "睡了吗",
        contentType: "text",
        replyToMessageId: null,
        directed: true,
      },
    ];
    let state = emptyState;
    for (const e of events) state = step(state, e, mechs).state;

    const dearChat = state.chats["telegram:uDear"] ?? emptyChat("telegram:uDear", "private", true);
    const groupChat = state.chats["telegram:-500"] ?? emptyChat("telegram:-500", "group", true);
    const dearReq = speechRequest(state, dearChat, T0 + 4 * D + 2 * MIN, "d2", mechs);
    const groupReq = speechRequest(state, groupChat, T0 + 4 * D + 2 * MIN, "o1", mechs);
    const dearPrompt = renderSpeechPrompt("你是 Alice。", dearReq).user;
    const groupPrompt = renderSpeechPrompt("你是 Alice。", groupReq).user;

    expect(dearPrompt).toContain("心跳漏了一拍");
    expect(dearPrompt).not.toContain("路过面包店听说了新品");
    expect(groupPrompt).not.toContain("心跳漏了一拍");
  });

  it("accelerates bond decay when deep scar stays unresolved (Slice 3 irreversibility)", () => {
    const clean = decayedAttachment(
      { bond: 0.8, scar: 0, proactivePendingAt: 0, proactiveMissed: 0, at: T0 },
      T0 + 3 * D,
    );
    const scarred = decayedAttachment(
      { bond: 0.8, scar: 0.6, proactivePendingAt: 0, proactiveMissed: 0, at: T0 },
      T0 + 3 * D,
    );
    expect(scarred.bond).toBeLessThan(clean.bond * 0.65);
  });

  it("routes daily curiosities (self:dream) toward high-bond private chats and skips scarred/missed ones", () => {
    const events: AliceEvent[] = [
      {
        type: "message.received",
        at: T0,
        scope: "telegram:uWarm",
        chatType: "private",
        messageId: "w1",
        senderId: "uWarm",
        senderName: "知微",
        text: "在干嘛呀",
        contentType: "text",
        replyToMessageId: null,
        directed: true,
      },
      {
        type: "act.done",
        at: T0 + MIN,
        scope: "telegram:uWarm",
        act: { kind: "feel", mood: "挺安心的", why: "很投缘" },
        valence: 0.85,
      },
      {
        type: "message.received",
        at: T0 + 2 * MIN,
        scope: "telegram:uScar",
        chatType: "private",
        messageId: "s1",
        senderId: "uScar",
        senderName: "冷木",
        text: "别烦我",
        contentType: "text",
        replyToMessageId: null,
        directed: true,
      },
      {
        type: "message.perceived",
        at: T0 + 3 * MIN,
        scope: "telegram:uScar",
        messageId: "s1",
        tone: "hostile",
      },
      {
        type: "ponder.done",
        at: T0 + 4 * H,
        scope: "self:life",
        callId: "l1",
        ponder: {
          kind: "life",
          date: "2026-11-23",
          activities: { morning: "煮了一壶乌龙茶" },
          moments: [],
          ongoing: [],
          curiosities: [{ topic: "昨晚听到一首老城市民谣", hook: "想找人聊聊这首歌" }],
        },
      },
    ];
    const w = runEvents(events);
    const warmShare = intentionsFor(w, affordances, "telegram:uWarm", T0 + 5 * H, POLICY);
    const scarShare = intentionsFor(w, affordances, "telegram:uScar", T0 + 5 * H, POLICY);
    expect(warmShare.length).toBeGreaterThan(0);
    const warmSend = warmShare.find((i) => i.affordance === "send")?.nsv ?? 0;
    const scarSend = scarShare.find((i) => i.affordance === "send")?.nsv ?? -99;
    expect(warmSend).toBeGreaterThan(scarSend);
  });

  it("lets un-targeted high-shock personal diary surface softly in warm private chats without leaking private entries", () => {
    const mechs = mechanisms;
    const events: AliceEvent[] = [
      {
        type: "message.received",
        at: T0,
        scope: "telegram:uDear",
        chatType: "private",
        messageId: "d1",
        senderId: "uDear",
        senderName: "知微",
        text: "早安",
        contentType: "text",
        replyToMessageId: null,
        directed: true,
      },
      {
        type: "act.done",
        at: T0 + MIN,
        scope: "telegram:uDear",
        act: { kind: "feel", mood: "特别开心", why: "被人挂念" },
        valence: 0.9,
      },
      {
        type: "ponder.done",
        at: T0 + 2 * H,
        scope: "telegram:-100",
        callId: "r_personal",
        ponder: {
          kind: "reflect",
          scope: "telegram:-100",
          mood: { word: "被夜风吹透了", why: "忽然安静", valence: -0.65 },
          entries: [
            { text: "一个人听着雨声忽然有点发空", about: null, importance: 7 },
            { text: "某人托我绝对保密的秘密", about: null, importance: 9, private: true },
          ],
        },
      },
      {
        type: "message.received",
        at: T0 + 2 * D,
        scope: "telegram:uDear",
        chatType: "private",
        messageId: "d2",
        senderId: "uDear",
        senderName: "知微",
        text: "在忙吗",
        contentType: "text",
        replyToMessageId: null,
        directed: true,
      },
    ];
    let state = emptyState;
    for (const e of events) state = step(state, e, mechs).state;
    const dearChat = state.chats["telegram:uDear"] ?? emptyChat("telegram:uDear", "private", true);
    const prompt = renderSpeechPrompt(
      "你是 Alice。",
      speechRequest(state, dearChat, T0 + 2 * D + MIN, "d2", mechs),
    ).user;
    expect(prompt).toContain("一个人听着雨声忽然有点发空");
    expect(prompt).not.toContain("某人托我绝对保密的秘密");
  });
});
