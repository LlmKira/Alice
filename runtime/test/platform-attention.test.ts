import { describe, expect, it } from "vitest";
import {
  PRODUCTION,
  reflectDiaryEmotive,
  thought,
  willWake,
  worldFold,
} from "../src/mechanisms/pressure/index.js";
import { emptyWorld } from "../src/mechanisms/pressure/world.js";
import { affordances } from "../src/mind/affordances.js";
import { buildAct } from "../src/mind/args.js";
import type { AliceEvent } from "../src/mind/events.js";
import { emptyChat, emptyState } from "../src/mind/state.js";
import { towardHer } from "../src/mind/step.js";
import { createQQWorldAdapter, faceOfEmoji } from "../src/qq/world-adapter.js";
import { renderSpeechPrompt } from "../src/speech/prompt.js";

const T0 = 1_795_400_000_000;

function groupMsg(scope: string, at: number, id: string, sender: string, text: string): AliceEvent {
  return {
    type: "message.received",
    at,
    scope,
    chatType: "group",
    messageId: id,
    senderId: sender,
    senderName: sender,
    text,
    contentType: "text",
    replyToMessageId: null,
    directed: false,
  };
}

describe("layered platform attention (ADR-300)", () => {
  const fold = worldFold(PRODUCTION);

  it("lets Telegram and QQ wake independently in per-platform mode while shared mode starves QQ", () => {
    let world = emptyWorld;
    // Build activity in both a Telegram group and a QQ group; Telegram has slightly higher unread.
    for (let i = 1; i <= 8; i++) {
      world = fold(
        world,
        groupMsg("telegram:-1001", T0 + i * 1000, `t${i}`, `tg_${i}`, `聊游戏 话题 ${i}`),
      );
    }
    for (let i = 1; i <= 5; i++) {
      world = fold(
        world,
        groupMsg("qq:group:2001", T0 + i * 1000, `q${i}`, `qq_${i}`, `聊音乐 话题 ${i}`),
      );
    }
    const tickAt = T0 + 10 * 60_000;
    const tick: AliceEvent = { type: "clock.tick", at: tickAt };

    const shared = willWake(affordances, PRODUCTION, undefined, undefined, { mode: "shared" });
    const perPlatform = willWake(affordances, PRODUCTION, undefined, undefined, {
      mode: "per-platform",
    });

    const sharedTg = shared.why("telegram:-1001", tick, tickAt, world);
    const sharedQq = shared.why("qq:group:2001", tick, tickAt, world);
    // In shared mode, at most ONE platform wins the single global Top-1 slot.
    expect(
      [sharedTg?.kind === "will", sharedQq?.kind === "will"].filter(Boolean).length,
    ).toBeLessThanOrEqual(1);

    const ppTg = perPlatform.why("telegram:-1001", tick, tickAt, world);
    const ppQq = perPlatform.why("qq:group:2001", tick, tickAt, world);
    // In per-platform mode, a fresh Telegram decision does NOT block QQ's own rhythm gate.
    const afterTgCall = fold(world, {
      type: "speech.decided",
      at: tickAt,
      scope: "telegram:-1001",
      callId: "telegram:-1001#1",
      decision: { acts: [{ kind: "send", text: "在看呢", replyTo: null }] },
    });
    const rightAfter = tickAt + 5_000;
    const tickAfter: AliceEvent = { type: "clock.tick", at: rightAfter };
    // Shared mode is blocked by Telegram's lastCallAt (5s < rhythm dt).
    expect(shared.why("qq:group:2001", tickAfter, rightAfter, afterTgCall)).toBeNull();
    // Per-platform mode still keeps QQ's own rhythm open if QQ had positive NSV.
    if (ppQq?.kind === "will") {
      expect(perPlatform.why("qq:group:2001", tickAfter, rightAfter, afterTgCall)?.kind).toBe(
        "will",
      );
    }
    // And Telegram itself respects its own rhythm cooldown right after speaking.
    if (ppTg?.kind === "will") {
      expect(perPlatform.why("telegram:-1001", tickAfter, rightAfter, afterTgCall)).toBeNull();
    }
  });

  it("applies per-platform lambda overrides without affecting other platforms", () => {
    let world = emptyWorld;
    for (let i = 1; i <= 5; i++) {
      world = fold(
        world,
        groupMsg("telegram:-1001", T0 + i * 1000, `t${i}`, `tg_${i}`, `聊游戏 ${i}`),
      );
      world = fold(
        world,
        groupMsg("qq:group:2001", T0 + i * 1000, `q${i}`, `qq_${i}`, `聊游戏 ${i}`),
      );
    }
    const at = T0 + 10 * 60_000;
    const base = willWake(affordances, PRODUCTION, undefined, undefined, { mode: "per-platform" });
    const tuned = willWake(affordances, PRODUCTION, undefined, undefined, {
      mode: "per-platform",
      lambda: { qq: 0.5 },
    });
    const baseTg = base.rank(world, at).find((x) => x.scope === "telegram:-1001");
    const tunedTg = tuned.rank(world, at).find((x) => x.scope === "telegram:-1001");
    const baseQq = base.rank(world, at).find((x) => x.scope === "qq:group:2001");
    const tunedQq = tuned.rank(world, at).find((x) => x.scope === "qq:group:2001");

    expect(tunedTg?.nsv).toBeCloseTo(baseTg?.nsv ?? 0, 6);
    expect(tunedQq?.nsv ?? -999).toBeGreaterThan(baseQq?.nsv ?? 999);
  });

  it("tags cross-platform diary entries with provenance while keeping same-platform entries untouched", () => {
    let world = emptyWorld;
    world = fold(world, groupMsg("telegram:-1001", T0, "t1", "u1", "今晚看电影"));
    world = fold(world, {
      type: "ponder.done",
      at: T0 + 10_000,
      scope: "self",
      callId: "self~reflect@1",
      ponder: {
        kind: "reflect",
        scope: "telegram:-1001",
        entries: [{ text: "大家聊电影很开心", about: null, importance: 0.9 }],
      },
    });
    const now = T0 + 20 * 60_000;
    const inOtherTg = reflectDiaryEmotive.contribute?.({
      world,
      chat: emptyChat("telegram:-2002", "group", true),
      now,
      sought: true,
      outside: false,
      offered: [],
    });
    const inQq = reflectDiaryEmotive.contribute?.({
      world,
      chat: emptyChat("qq:group:3001", "group", true),
      now,
      sought: true,
      outside: false,
      offered: [],
    });
    expect(inOtherTg?.[0]?.text).not.toContain("[Telegram]");
    expect(inQq?.[0]?.text).toContain("[Telegram]");
  });

  it("tags cross-platform carried thoughts with provenance while keeping same-platform thoughts untagged", () => {
    const carried = thought({ examples: false, carry: true });
    let world = emptyWorld;
    world = fold(world, groupMsg("telegram:-1001", T0, "t1", "u1", "今晚看电影"));
    world = fold(world, {
      type: "act.done",
      at: T0 + 10_000,
      scope: "telegram:-1001",
      act: { kind: "think", thought: "这部片子我之前也想看" },
    });
    const now = T0 + 15 * 60_000;
    const inOtherTg = carried.contribute?.({
      world,
      chat: emptyChat("telegram:-2002", "group", true),
      now,
      sought: true,
      outside: false,
      offered: [],
    });
    const inQq = carried.contribute?.({
      world,
      chat: emptyChat("qq:group:3001", "group", true),
      now,
      sought: true,
      outside: false,
      offered: [],
    });
    const tgText = inOtherTg?.map((c) => c.text).join("\n") ?? "";
    const qqText = inQq?.map((c) => c.text).join("\n") ?? "";
    expect(tgText).toContain("这部片子我之前也想看");
    expect(tgText).not.toContain("[Telegram]");
    expect(qqText).toContain("这部片子我之前也想看");
    expect(qqText).toContain("[Telegram]");
  });

  it("strips unmatched trailing stray quotes from tool text while preserving paired quotes", () => {
    const ctx = { timeline: [], now: T0 };
    expect(buildAct("send", { text: '捣台球好啊"' }, ctx)).toEqual({
      kind: "send",
      text: "捣台球好啊",
      replyTo: null,
    });
    expect(buildAct("send", { text: "捣台球好啊“" }, ctx)).toEqual({
      kind: "send",
      text: "捣台球好啊",
      replyTo: null,
    });
    expect(buildAct("send", { text: '他说"好啊"' }, ctx)).toEqual({
      kind: "send",
      text: '他说"好啊"',
      replyTo: null,
    });
  });

  it("tags official QQ bots with isBot and surfaces factual background observation on exclusive group ping-pong", () => {
    const emitted: AliceEvent[] = [];
    const onRaw = createQQWorldAdapter({
      selfId: "10001",
      now: () => T0,
      onEvent: (e) => emitted.push(e),
      banChanged: () => null,
    });
    onRaw({
      post_type: "message",
      message_type: "group",
      message_id: "1",
      user_id: "3889045760",
      group_id: "999",
      message: "欢迎入群",
    });
    expect(emitted[0]).toMatchObject({ type: "message.received", isBot: true, directed: false });
    const botReply = towardHer(emptyState, {
      type: "message.received",
      at: T0 + 1000,
      scope: "qq:group:999",
      chatType: "group",
      messageId: "2",
      senderId: "3889045760",
      senderName: "官机",
      isBot: true,
      text: "@Alice",
      contentType: "text",
      replyToMessageId: null,
      directed: true,
    });
    expect(botReply.type === "message.received" && botReply.directed).toBe(false);

    // 4 consecutive exclusive Alice <-> single sender quote-reply exchanges surface IRC notice; 3 or non-reply do not.
    const timeline = [1, 2, 3, 4].flatMap((i) => [
      {
        at: T0 + i * 30_000,
        messageId: `a${i}`,
        sender: null,
        text: `回 ${i}`,
        contentType: "text" as const,
        replyToMessageId: null,
      },
      {
        at: T0 + i * 30_000 + 10_000,
        messageId: `b${i}`,
        sender: { id: "bot_user", name: "疑似人机" },
        text: `接话 ${i}`,
        contentType: "text" as const,
        replyToMessageId: `a${i}`,
      },
    ]);
    const prompt3 = renderSpeechPrompt(
      "PERSONA",
      {
        scope: "qq:group:999",
        chatType: "group",
        at: T0 + 110_000,
        triggerMessageId: "b3",
        timeline: timeline.slice(0, 6),
        contributions: [],
        affordances: ["send"],
      },
      { format: "native" },
    );
    expect(prompt3.routing?.hasBotObservation).toBe(false);
    expect(prompt3.user).not.toContain("只点个表情");
    expect(faceOfEmoji("🤣")).toBe("182");

    const prompt = renderSpeechPrompt("PERSONA", {
      scope: "qq:group:999",
      chatType: "group",
      at: T0 + 140_000,
      triggerMessageId: "b4",
      timeline,
      contributions: [],
      affordances: ["send"],
    });
    expect(prompt.user).toContain("疑似人机");
    expect(prompt.routing?.hasBotObservation).toBe(true);

    // Once another group member speaks in between, no ping-pong observation is emitted.
    const withHuman = [
      ...timeline.slice(0, 4),
      {
        at: T0 + 85_000,
        messageId: "h1",
        sender: { id: "human_1", name: "路人" },
        text: "我也说一句",
        contentType: "text" as const,
        replyToMessageId: null,
      },
      ...timeline.slice(4),
    ];
    const promptWithHuman = renderSpeechPrompt("PERSONA", {
      scope: "qq:group:999",
      chatType: "group",
      at: T0 + 140_000,
      triggerMessageId: "b4",
      timeline: withHuman,
      contributions: [],
      affordances: ["send"],
    });
    expect(promptWithHuman.routing?.hasBotObservation).toBe(false);
  });
});
