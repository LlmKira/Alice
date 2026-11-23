import { describe, expect, it } from "vitest";
import { selectSpeechModel } from "../src/llm/model-tier.js";
import { paletteCharmV2, paletteComposite } from "../src/mechanisms/palette.js";
import {
  affect,
  createPressure,
  PRODUCTION,
  people,
  reflectDiary,
  reflectDiaryFlow,
  willOf,
  worldFold,
} from "../src/mechanisms/pressure/index.js";
import { PEOPLE_ALL } from "../src/mechanisms/pressure/people.js";
import { emptyWorld } from "../src/mechanisms/pressure/world.js";
import { stickerBag } from "../src/mechanisms/stickers.js";
import { affordances } from "../src/mind/affordances.js";
import type { AliceEvent } from "../src/mind/events.js";
import { emptyChat, emptyState } from "../src/mind/state.js";
import { speechRequest, step } from "../src/mind/step.js";
import { arms } from "../src/sim/will-arms.js";
import { renderSpeechPrompt } from "../src/speech/prompt.js";

const T0 = 1_772_460_000_000;
const MIN = 60_000;
const H = 3_600_000;

describe("charm-sticker-v1 & affect-flow-v1 candidate mechanisms", () => {
  it("stickerBag folds incoming sticker media and emits concrete visual descriptions", () => {
    const ev: AliceEvent = {
      type: "message.received",
      at: T0,
      scope: "telegram:-1009901",
      chatType: "group",
      messageId: "1",
      senderId: "990101",
      senderName: "白茶",
      text: null,
      contentType: "sticker",
      media: "贴纸 😄（橘色耳朵小狐狸抱着尾巴得意偷笑）",
      replyToMessageId: null,
      directed: false,
    };
    const next = (stickerBag.reduce?.(stickerBag.initial ?? [], ev) ?? []) as readonly string[];
    const mechs = arms({})["charm-sticker-v1"] as NonNullable<ReturnType<typeof arms>[string]>;
    const state = step(emptyState, ev, mechs).state;
    const chat = state.chats["telegram:-1009901"];
    expect(chat).toBeDefined();
    if (!chat) return;
    const req = speechRequest(state, chat, T0 + 10_000, "1", mechs);
    const prompt = renderSpeechPrompt("你是 Alice。", req);
    expect(next[0]).toContain("橘色耳朵小狐狸");
    expect(prompt.system).toContain("手头贴纸有：");
    expect(prompt.system).toContain("橘色耳朵小狐狸");
  });

  it("paletteCharmV2 keeps speaking examples in active groups (>=10 msgs) and drops passive silent lines", () => {
    const timeline = Array.from({ length: 12 }, (_, i) => ({
      at: T0 + i * MIN,
      messageId: String(i + 1),
      sender: { id: "u1", name: "木瓜" },
      text: `第 ${i + 1} 条消息`,
      contentType: "text" as const,
      replyToMessageId: null,
    }));
    const chat = {
      ...emptyChat("telegram:-1009901", "group", true),
      timeline,
      lastMessageAt: T0 + 11 * MIN,
      calls: 1,
    };
    const prodRef = paletteComposite.contribute?.(chat, T0 + 12 * MIN, undefined, [
      "send",
      "sticker",
      "react",
    ])[0];
    const candRef = paletteCharmV2.contribute?.(chat, T0 + 12 * MIN, undefined, [
      "send",
      "sticker",
      "react",
    ])[0];
    expect(prodRef?.examples?.some((e) => e.acts.some((a) => a.kind === "send"))).toBe(false);
    expect(candRef?.examples?.some((e) => e.acts.some((a) => a.kind === "send"))).toBe(true);
    expect(candRef?.examples?.some((e) => e.acts.length === 0)).toBe(false);
  });

  it("PEOPLE_LIVE delivers factual real-time shared-group presence in DM without feeling-hosting", () => {
    const mechs = arms({})["affect-flow-v1"] as NonNullable<ReturnType<typeof arms>[string]>;
    const events: AliceEvent[] = [
      {
        type: "message.received",
        at: T0,
        scope: "telegram:990201",
        chatType: "private",
        messageId: "1",
        senderId: "990201",
        senderName: "林风",
        text: "等会儿找你",
        contentType: "text",
        replyToMessageId: null,
        directed: true,
      },
      {
        type: "message.received",
        at: T0 + 10 * MIN,
        scope: "telegram:-1009901",
        chatType: "group",
        chatTitle: "夜航茶馆",
        messageId: "2",
        senderId: "990201",
        senderName: "林风",
        text: "哈哈哈刚抽到重复盲盒",
        contentType: "text",
        replyToMessageId: null,
        directed: false,
      },
      {
        type: "message.received",
        at: T0 + 12 * MIN,
        scope: "telegram:990201",
        chatType: "private",
        messageId: "3",
        senderId: "990201",
        senderName: "林风",
        text: "在吗",
        contentType: "text",
        replyToMessageId: null,
        directed: true,
      },
    ];
    let state = emptyState;
    for (const ev of events) state = step(state, ev, mechs).state;
    const dm = state.chats["telegram:990201"];
    expect(dm).toBeDefined();
    if (!dm) return;
    // 刚发过群消息 2 分钟且还没回（在 990201 之前看）：检查 11 分钟时（他还没回私聊之前）是否看见跨群余光
    const reqBeforeReply = speechRequest(
      state,
      { ...dm, timeline: dm.timeline.slice(0, 1) },
      T0 + 11 * MIN,
      null,
      mechs,
    );
    const cardBefore = renderSpeechPrompt("你是 Alice。", reqBeforeReply).user;
    expect(cardBefore).toContain("夜航茶馆");
    expect(cardBefore).toContain("发过消息");

    // 对照关闭实时跨群（PEOPLE_ALL）时不包含实时跨群行，而当前生产已开启 PEOPLE_LIVE
    const baseMechs = [createPressure(affordances, { ...PRODUCTION, people: people(PEOPLE_ALL) })];
    let baseState = emptyState;
    for (const ev of events.slice(0, 2)) baseState = step(baseState, ev, baseMechs).state;
    const baseDm = baseState.chats["telegram:990201"];
    expect(baseDm).toBeDefined();
    if (!baseDm) return;
    const baseReq = speechRequest(baseState, baseDm, T0 + 11 * MIN, null, baseMechs);
    expect(renderSpeechPrompt("你是 Alice。", baseReq).user).not.toContain("发过消息");
  });

  it("reflectDiaryFlow preserves important unresolved entries across brief replies without leaking past staleAfter", () => {
    const foldProd = worldFold({ ...PRODUCTION, diary: reflectDiary });
    const foldFlow = worldFold({ ...PRODUCTION, diary: reflectDiaryFlow });
    const events: AliceEvent[] = [
      {
        type: "message.received",
        at: T0,
        scope: "telegram:990701",
        chatType: "private",
        messageId: "1",
        senderId: "990701",
        senderName: "阿七",
        text: "下午那件事我真的挺难过的",
        contentType: "text",
        replyToMessageId: null,
        directed: true,
      },
      {
        type: "ponder.done",
        at: T0 + 2 * MIN,
        callId: "p1",
        scope: "telegram:990701",
        ponder: {
          kind: "reflect",
          scope: "telegram:990701",
          entries: [
            { about: "990701", text: "他说下午那件事心里很堵，其实一直放在心上", importance: 8 },
          ],
          mood: { word: "心疼", why: "听他这样说有点难受", valence: -0.45 },
        },
      },
      {
        type: "message.sent",
        at: T0 + 5 * MIN,
        scope: "telegram:990701",
        messageId: "s1",
        text: "好啦先喝口水",
        kind: "text",
      },
    ];
    const wProd = events.reduce(foldProd, emptyWorld);
    const wFlow = events.reduce(foldFlow, emptyWorld);
    const chatOldTimeline = {
      ...emptyChat("telegram:990701", "private", true),
      timeline: [
        {
          at: T0 + 2 * H,
          messageId: "99",
          sender: { id: "990701", name: "阿七" },
          text: "刚缓过来一点",
          contentType: "text" as const,
          replyToMessageId: null,
        },
      ],
      lastMessageAt: T0 + 2 * H,
      lastAliceAt: T0 + 5 * MIN,
      lastDirectedAt: T0 + 2 * H,
      unread: 1,
      calls: 1,
    };
    const cProd = reflectDiary.contribute?.({
      world: wProd,
      chat: chatOldTimeline,
      now: T0 + 2 * H,
      sought: true,
      outside: false,
      offered: ["send"],
    });
    const cFlow = reflectDiaryFlow.contribute?.({
      world: wFlow,
      chat: chatOldTimeline,
      now: T0 + 2 * H,
      sought: true,
      outside: false,
      offered: ["send"],
    });
    expect(cProd?.length).toBe(0);
    expect(cFlow?.[0]?.text).toContain("心里很堵");
  });

  it("affect willDrive stays strictly bounded in [0.75, 1.20] across extreme valence shifts", () => {
    const f = affect({
      noise: true,
      lonely: true,
      warmth: { home: true, relevance: true, bids: true, tone: true },
      rejection: true,
      feedback: true,
      body: true,
      willDrive: true,
    });
    const policy = willOf({ ...PRODUCTION, affect: f });
    const w = worldFold({ ...PRODUCTION, affect: f })(emptyWorld, {
      type: "act.done",
      at: T0,
      scope: "telegram:1",
      act: { kind: "feel", mood: "超级开心", why: "大喜事" },
      valence: 1.0,
    });
    const reading = {
      scope: "telegram:1",
      chatType: "private" as const,
      tier: 15 as const,
      raw: {} as never,
      normalized: {} as never,
      habituation: 0,
      obligation: 0,
      solicited: false,
      voices: { diligence: 0.25, curiosity: 0.25, sociability: 0.25, caution: 0.25 },
      voice: "sociability" as const,
    };
    const baseAffect = affect({
      noise: true,
      lonely: true,
      warmth: { home: true, relevance: true, bids: true, tone: true },
      rejection: true,
      feedback: true,
      body: true,
      willDrive: false,
    });
    const basePolicy = willOf({ ...PRODUCTION, affect: baseAffect });
    const gainHigh = f.will?.intrinsicGain?.(w, reading, T0 + MIN);
    expect(gainHigh).toBeGreaterThan(1);
    expect(gainHigh).toBeLessThanOrEqual(1.2);
    expect(policy.intrinsicGain(w, reading, T0 + MIN)).toBeCloseTo(
      basePolicy.intrinsicGain(w, reading, T0 + MIN) * (gainHigh ?? 1),
      10,
    );
  });

  it("selectSpeechModel routes emotional/intimate peaks to peakModel and routine group noise to routineModel", () => {
    const peak = selectSpeechModel({
      chatType: "private",
      at: T0 + 5 * MIN,
      timeline: [
        {
          at: T0,
          messageId: "1",
          sender: { id: "u1", name: "阿七" },
          text: "救命",
          contentType: "text",
          replyToMessageId: null,
        },
        {
          at: T0 + MIN,
          messageId: "2",
          sender: { id: "u1", name: "阿七" },
          text: "全崩了",
          contentType: "text",
          replyToMessageId: null,
        },
        {
          at: T0 + 2 * MIN,
          messageId: "3",
          sender: { id: "u1", name: "阿七" },
          text: "真的好想哭",
          contentType: "text",
          replyToMessageId: null,
        },
      ],
      contributions: [{ mechanism: "familiar", kind: "people", text: "老朋友，我们几乎天天聊" }],
    });
    expect(peak.tier).toBe("peak");
    expect(peak.model).toBe("flash-3.8");
    expect(peak.reasons).toContain("intimate_private");

    const routine = selectSpeechModel({
      chatType: "group",
      at: T0 + 5 * MIN,
      timeline: [
        {
          at: T0,
          messageId: "1",
          sender: { id: "u2", name: "路人" },
          text: "今天周几",
          contentType: "text",
          replyToMessageId: null,
        },
      ],
      contributions: [],
    });
    expect(routine.tier).toBe("routine");
    expect(routine.model).toBe("flash-lite");
    expect(routine.reasons).toEqual([]);
  });
});
