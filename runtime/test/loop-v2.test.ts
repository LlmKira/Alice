import { describe, expect, it } from "vitest";
import {
  GROUP_SILENT,
  PRIVATE_LIGHT,
  palette,
  paletteComposite,
} from "../src/mechanisms/palette.js";
import { createDesire, shownShare } from "../src/mechanisms/pressure/desire.js";
import {
  createPressure,
  PRODUCTION,
  relationTier,
  thought,
} from "../src/mechanisms/pressure/index.js";
import { INNER_EXAMPLES_COMPOSITE } from "../src/mechanisms/pressure/inner.js";
import type { World } from "../src/mechanisms/pressure/world.js";
import type { ActKind } from "../src/mind/affordances.js";
import { affordances } from "../src/mind/affordances.js";
import { emptyChat, emptyState, type TimelineEntry } from "../src/mind/state.js";
import { step } from "../src/mind/step.js";
import { renderSpeechPrompt } from "../src/speech/prompt.js";

const MIN = 60_000;
const H = 60 * MIN;
const OFFSET_MS = 8 * H;
const local = (day: number, h: number, m = 0) => Date.UTC(2026, 10, day, h, m) - OFFSET_MS;

const line = (at: number, text: string): TimelineEntry => ({
  at,
  messageId: String(at),
  sender: { id: "u1", name: "阿明" },
  text,
  contentType: "text",
  replyToMessageId: null,
});

describe("loop-v2 Slice 1: composite examples & private light actions", () => {
  it("paletteComposite trims private examples to 4 registers + PRIVATE_LIGHT (sticker, react, silence)", () => {
    const dm = emptyChat("telegram:101", "private", true);
    const offered: ActKind[] = ["send", "sticker", "react", "think"];
    const comp = paletteComposite.contribute?.(
      dm,
      local(15, 20),
      paletteComposite.initial,
      offered,
    )[0];
    const prod = palette.contribute?.(dm, local(15, 20), palette.initial, offered)[0];
    expect(comp?.examples?.length).toBeLessThan(prod?.examples?.length ?? 99);
    const scenes = new Set((comp?.examples ?? []).map((e) => e.scene));
    for (const light of PRIVATE_LIGHT) expect(scenes.has(light.scene)).toBe(true);
    expect(comp?.examples?.some((e) => e.acts.some((a) => a.kind === "sticker"))).toBe(true);
    expect(comp?.examples?.some((e) => e.acts.some((a) => a.kind === "react"))).toBe(true);
    expect(comp?.examples?.some((e) => e.acts.length === 0)).toBe(true);
  });

  it("paletteComposite prunes active group speaking examples while keeping GROUP_SILENT", () => {
    const timeline = Array.from({ length: 12 }, (_, i) => line(local(15, 19) + i * MIN, `话 ${i}`));
    const grp = { ...emptyChat("telegram:-100", "group", true), timeline };
    const comp = paletteComposite.contribute?.(grp, local(15, 19, 15), paletteComposite.initial, [
      "send",
      "sticker",
      "react",
    ])[0];
    expect(comp?.examples?.length).toBe(GROUP_SILENT.length);
  });

  it("thought({ composite: true }) avoids 1-2-3 templates and covers open_topic + feel/sticker without say", () => {
    const dm = emptyChat("telegram:101", "private", true);
    const mind = createPressure(affordances, {
      ...PRODUCTION,
      thought: thought({ examples: true, carry: true, composite: true }),
    });
    const contrib =
      mind.contribute?.(dm, local(15, 20), mind.initial, [
        "send",
        "sticker",
        "think",
        "feel",
        "topic-open",
      ]) ?? [];
    const ref = contrib.find((c) => c.kind === "reference");
    expect(ref?.style).toBe("composite");
    expect(ref?.examples).toBe(INNER_EXAMPLES_COMPOSITE);
    for (const e of INNER_EXAMPLES_COMPOSITE) {
      for (const a of e.acts) {
        if (a.kind === "think") expect(a.thought).not.toMatch(/1\.\s.*2\./);
      }
    }
    const prompt = renderSpeechPrompt("你是 Alice。", {
      at: local(15, 20),
      scope: "telegram:101",
      chatType: "private",
      affordances: ["send", "sticker", "react", "think", "feel", "topic-open"],
      contributions: contrib,
      timeline: [line(local(15, 19, 58), "对的")],
      earlier: [],
      triggerMessageId: null,
    });
    expect(prompt.system).toContain("tools.open_topic");
    expect(prompt.system).toContain("tools.feel");
    expect(prompt.system).toContain("tools.sticker");
  });
});

describe("loop-v2 Slice 4: personalUrge on dream curiosities and timed life moments", () => {
  const personalMind = createPressure(affordances, {
    ...PRODUCTION,
    relation: relationTier,
    desire: createDesire({ dreamFeed: true, personalUrge: true }),
  });

  it("surfaces a dream curiosity to a close quiet friend even with zero keyword overlap, but not to strangers", () => {
    const tWake = local(15, 9, 30);
    let state = emptyState;
    // 阿明是熟人（跨多天多次往来 -> relationTier 进 tier 50）
    for (let i = 0; i < 6; i++) {
      const day = i < 3 ? 13 : 14;
      const at = local(day, 10 + i, 0);
      state = step(
        state,
        {
          type: "message.received",
          at,
          scope: "telegram:101",
          chatType: "private",
          messageId: `dm${i}`,
          senderId: "101",
          senderName: "阿明",
          text: "今天写代码写了半天，头都晕了",
          contentType: "text",
          replyToMessageId: null,
          directed: true,
        },
        [personalMind],
      ).state;
      state = step(
        state,
        {
          type: "message.sent",
          at: at + MIN,
          scope: "telegram:101",
          messageId: `s${i}`,
          text: "歇会嘛",
          kind: "text",
        },
        [personalMind],
      ).state;
    }
    // 陌生人只发过一条无关消息，她还没熟
    state = step(
      state,
      {
        type: "message.received",
        at: local(14, 18),
        scope: "telegram:999",
        chatType: "private",
        messageId: "stranger1",
        senderId: "999",
        senderName: "路人",
        text: "你好",
        contentType: "text",
        replyToMessageId: null,
        directed: true,
      },
      [personalMind],
    ).state;
    state = step(
      state,
      {
        type: "message.sent",
        at: local(14, 18, 1),
        scope: "telegram:999",
        messageId: "s999",
        text: "你好呀",
        kind: "text",
      },
      [personalMind],
    ).state;

    // 清晨 life ponder 写下好奇点 + 下午 15 点的生活小事（和写代码毫无关键词重合）
    state = step(
      state,
      {
        type: "ponder.done",
        at: local(15, 5),
        scope: "self",
        callId: "self~life@1",
        ponder: {
          kind: "life",
          date: "2026-11-15",
          activities: { meal: "南瓜汤" },
          moments: [{ hour: 15, text: "洗干净的毛衣晾在阳台，闻起来全是太阳香味" }],
          ongoing: ["救活迷迭香"],
          curiosities: [{ topic: "冬天的被窝引力", hook: "你们那边降温了吗" }],
        },
      },
      [personalMind],
    ).state;

    const world = state.mechanisms[personalMind.name] as World;
    // 上午 10 点：熟人（阿明）能看到好奇点，陌生人看不到，15 点的小事还没到时间也不会出现
    const shownFriendMorning = shownShare(world, "telegram:101", tWake);
    const shownStrangerMorning = shownShare(world, "telegram:999", tWake);
    expect(shownFriendMorning?.channel).toContain("自己刚想到的");
    expect(shownFriendMorning?.title).toContain("冬天的被窝引力");
    expect(shownFriendMorning?.body).toContain("降温了吗");
    expect(shownStrangerMorning).toBeNull();
    // 下午 15 点后（假设阿明刚才聊了会、好奇点已看过），15 点的小事才到点出现
    const afterConsidered = step(
      state,
      {
        type: "speech.decided",
        at: local(15, 10),
        scope: "telegram:101",
        callId: "telegram:101#1",
        decision: { acts: [{ kind: "send", text: "早安", replyTo: null }] },
      },
      [personalMind],
    ).state;
    const afterReply = step(
      afterConsidered,
      {
        type: "message.received",
        at: local(15, 14),
        scope: "telegram:101",
        chatType: "private",
        messageId: "dm_noon",
        senderId: "101",
        senderName: "阿明",
        text: "午饭刚吃完",
        contentType: "text",
        replyToMessageId: null,
        directed: true,
      },
      [personalMind],
    ).state;
    const afterHerReply = step(
      afterReply,
      {
        type: "message.sent",
        at: local(15, 14, 1),
        scope: "telegram:101",
        messageId: "s_noon",
        text: "吃啥了",
        kind: "text",
      },
      [personalMind],
    ).state;
    const w15 = afterHerReply.mechanisms[personalMind.name] as World;
    // 14:30 还不到 15:00，小事未解锁；15:15 到点了，新鲜呈现
    expect(shownShare(w15, "telegram:101", local(15, 14, 30))).toBeNull();
    const shownMoment = shownShare(w15, "telegram:101", local(15, 15));
    expect(shownMoment?.title).toContain("洗干净的毛衣");
  });

  it("holds self:dream personal curiosities back during busy unrelated group chatter and reveals them once quiet", () => {
    const GROUP = "telegram:-888";
    let state = emptyState;
    for (let d = 7; d >= 1; d--) {
      const at = local(15 - d, 10);
      state = step(
        state,
        {
          type: "message.received",
          at,
          scope: GROUP,
          chatType: "group",
          messageId: `g${d}`,
          senderId: "101",
          senderName: "阿明",
          text: "今天显卡价格又涨了，真离谱",
          contentType: "text",
          replyToMessageId: null,
          directed: true,
        },
        [personalMind],
      ).state;
      state = step(
        state,
        {
          type: "message.sent",
          at: at + 20_000,
          scope: GROUP,
          messageId: `gs${d}`,
          text: "太离谱了",
          kind: "text",
        },
        [personalMind],
      ).state;
    }
    state = step(
      state,
      {
        type: "ponder.done",
        at: local(15, 8),
        scope: "self",
        callId: "self~life@2",
        ponder: {
          kind: "life",
          date: "2026-11-15",
          activities: { meal: "番茄面" },
          moments: [],
          ongoing: [],
          curiosities: [{ topic: "冬天剥栗子", hook: "为什么总有一两个壳肉不分离" }],
        },
      },
      [personalMind],
    ).state;
    // 10:00 群里正在聊无关的加密货币（非点名），个人好奇心不在此刻强插并白白消耗
    state = step(
      state,
      {
        type: "message.received",
        at: local(15, 10),
        scope: GROUP,
        chatType: "group",
        messageId: "g_busy",
        senderId: "102",
        senderName: "路人甲",
        text: "刚链上转了三千USDC",
        contentType: "text",
        replyToMessageId: null,
        directed: false,
      },
      [personalMind],
    ).state;
    const busyWorld = state.mechanisms[personalMind.name] as World;
    expect(shownShare(busyWorld, GROUP, local(15, 10, 1))).toBeNull();
    // 群安静超过 10 分钟后，冬天剥栗子依然新鲜、可以拿出来聊
    expect(shownShare(busyWorld, GROUP, local(15, 10, 15))?.title).toContain("冬天剥栗子");
  });
});
