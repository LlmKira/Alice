import { describe, expect, it } from "vitest";
import { expression, voice } from "../src/mechanisms/voice.js";
import { type Act, affordances, EDIT_WINDOW_MS, postedMessage } from "../src/mind/affordances.js";
import type { Effect } from "../src/mind/effects.js";
import type { AliceEvent } from "../src/mind/events.js";
import { type AliceState, emptyState, SEND_LIMIT, SEND_WINDOW_MS } from "../src/mind/state.js";
import { step } from "../src/mind/step.js";
import { directedWake } from "./directed-wake.js";

const T0 = 1_771_000_000_000;
/** 不变量与唤醒节奏无关；用立刻开口的配置让模糊测试覆盖更多动作。 */
const mechanisms = [directedWake, voice, expression];

/** 确定性的伪随机数，让"随机"事件序列每次一样。 */
function lcg(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return s / 2_147_483_648;
  };
}

function directed(scope: string, at: number, id: string, sender = "u"): AliceEvent {
  return {
    type: "message.received",
    at,
    scope,
    chatType: scope.includes("-") ? "group" : "private",
    messageId: id,
    senderId: sender,
    senderName: sender,
    text: "hi",
    contentType: "text",
    replyToMessageId: null,
    directed: true,
  };
}

/** 一个胡乱行动的发言层：每次都想做很多事，引用和表情常常指向别的会话的消息。 */
function wildActs(rnd: () => number, maxId: number): Act[] {
  const id = () => String(Math.floor(rnd() * maxId));
  // 语音、复读也算消息，排在前面才不会总被发送上限挡掉。
  const first = rnd();
  return [
    ...(first < 0.25 ? [{ kind: "voice" as const, text: "e" }] : []),
    ...(first >= 0.25 && first < 0.5 ? [{ kind: "repeat" as const, messageId: id() }] : []),
    { kind: "send", text: "a", replyTo: id() },
    { kind: "react", messageId: id(), emoji: rnd() < 0.8 ? "👍" : "not-an-emoji" },
    { kind: "album-send", asset: "p000000" },
    { kind: "sticker", word: "laugh" },
    { kind: "mark-read" },
    { kind: "mark-read" },
    ...(rnd() < 0.3 ? [{ kind: "leave-chat" as const }] : []),
    { kind: "send", text: "c", replyTo: null },
    { kind: "join-chat" },
    { kind: "album-search", query: "猫" },
    { kind: "send", text: "d", replyTo: null },
    // 占着删掉的 [记住] 原来的位置：回执按效果的个数抽随机数，少一个效果整条随机轨迹就变了。
    { kind: "feel", mood: "平静", why: null },
    { kind: "intend", when: "明天", what: "问问他" },
    { kind: "fulfil", what: "问问他" },
    { kind: "let-go", messageId: id() },
    { kind: "feel", mood: "开心", why: null },
    { kind: "diary", about: null, entry: "今天好累" },
    { kind: "think", thought: "他是不是生气了" },
    { kind: "topic-open", title: "陪他准备面试" },
    { kind: "topic-advance", topic: "面试", beat: "约了周三" },
    { kind: "topic-close", topic: "面试" },
    { kind: "edit", messageId: rnd() < 0.5 ? `s${Math.floor(rnd() * maxId)}` : id(), text: "f" },
  ];
}

interface Produced {
  at: number;
  /** 产生这个动作的决定所在的会话。 */
  decidedIn: string;
  effect: Extract<Effect, { type: "act" }>;
  state: AliceState;
}

function drive(events: AliceEvent[], rnd: () => number) {
  let state: AliceState = emptyState;
  const produced: Produced[] = [];
  const failedReplies: Effect[] = [];
  const pending: Array<{ scope: string; callId: string }> = [];
  let sent = 0;
  const apply = (event: AliceEvent) => {
    const before = state;
    const result = step(state, event, mechanisms);
    state = result.state;
    if (event.type === "act.failed") failedReplies.push(...result.effects);
    for (const e of result.effects) {
      if (e.type === "call-speech") pending.push({ scope: e.scope, callId: e.callId });
      if (e.type === "act" && event.type === "speech.decided") {
        produced.push({ at: event.at, decidedIn: event.scope, effect: e, state: before });
      }
    }
    // 外壳的回执：表情、已读、退群算做成了；偶尔失败或结果未知。
    for (const e of result.effects) {
      if (e.type !== "act") continue;
      if (rnd() < 0.1) {
        apply({
          type: "act.failed",
          at: event.at,
          scope: e.scope,
          act: e.act,
          reason: "outcome_unknown",
        });
      } else {
        const posted = postedMessage(e.act);
        // 她发出的消息回到记录里（编号 s…），之后才有她自己的话可改。
        if (posted) {
          apply({
            type: "message.sent",
            at: event.at,
            scope: e.scope,
            messageId: `s${++sent}`,
            ...posted,
          });
        } else apply({ type: "act.done", at: event.at, scope: e.scope, act: e.act });
      }
    }
  };
  for (const [i, event] of events.entries()) {
    apply(event);
    if (pending.length > 0 && rnd() < 0.7) {
      const call = pending.shift() as { scope: string; callId: string };
      const scope = rnd() < 0.2 ? "telegram:-777" : call.scope; // 偶尔把决定送错会话
      apply({
        type: "speech.decided",
        at: event.at,
        scope,
        callId: call.callId,
        decision: { acts: wildActs(rnd, i + 1) },
      });
    }
  }
  return { produced, failedReplies };
}

describe("safety invariants", () => {
  const scopes = ["telegram:1", "telegram:2", "telegram:-10", "telegram:-20"];
  const rnd = lcg(42);
  const events: AliceEvent[] = [];
  for (let i = 0; i < 600; i++) {
    const scope = scopes[Math.floor(rnd() * scopes.length)] as string;
    // 两个人说同样的 "hi"：群里会出现复读。
    events.push(directed(scope, T0 + i * 5_000, String(i), rnd() < 0.5 ? "u" : "v"));
  }
  const { produced, failedReplies } = drive(events, lcg(13));

  it("exercises every registered action that can be available", () => {
    const kinds = new Set(produced.map((p) => p.effect.act.kind));
    // 加群只在她不在的群里可用；发图只在翻过相册之后可用（这里不回送翻相册的结果，见 album.test.ts）；
    // 交出去办事只在有执行代理时由 errands 机制提供（见 background.test.ts）；复读只在不同的人连着发
    // 同一句、她还没接话时可用，这里她几乎每条都接（见 expression.test.ts）；找群、转发只由候选 reach 提供
    // （reach.test.ts）；去睡了只由候选 bedtime 在夜里提供（bedtime.test.ts）。
    const conditional = new Set([
      "bed",
      "join-chat",
      "album-send",
      "delegate",
      "repeat",
      "chat-search",
      "forward",
      "recall",
      "note-self",
      "dm-check",
      "dm-defer",
    ]);
    for (const a of affordances) if (!conditional.has(a.kind)) expect(kinds).toContain(a.kind);
  });

  it("every action goes to the chat whose decision produced it", () => {
    expect(produced.length).toBeGreaterThan(0);
    for (const p of produced) expect(p.effect.scope).toBe(p.decidedIn);
    expect(produced.some((p) => p.effect.scope === "telegram:-777")).toBe(false);
  });

  it("actions only point at messages in that chat, and leaving happens only in groups", () => {
    for (const { effect, state } of produced) {
      const ids = new Set(state.chats[effect.scope]?.timeline.map((t) => t.messageId));
      const act = effect.act;
      if (act.kind === "react") expect(ids.has(act.messageId)).toBe(true);
      if (act.kind === "send" && act.replyTo !== null) expect(ids.has(act.replyTo)).toBe(true);
      if (act.kind === "leave-chat") expect(effect.scope).toContain("-");
      if (act.kind === "repeat") expect(ids.has(act.messageId)).toBe(true);
    }
  });

  it("edits only her own text messages in that chat, sent within the edit window", () => {
    const edits = produced.filter((p) => p.effect.act.kind === "edit");
    expect(edits.length).toBeGreaterThan(0);
    for (const { at, effect, state } of edits) {
      const act = effect.act as Extract<Act, { kind: "edit" }>;
      const target = state.chats[effect.scope]?.timeline.find((t) => t.messageId === act.messageId);
      expect(target?.sender).toBeNull();
      expect(target?.contentType).toBe("text");
      expect(at - (target?.at ?? Number.NEGATIVE_INFINITY)).toBeLessThanOrEqual(EDIT_WINDOW_MS);
    }
  });

  it(`never posts more than ${SEND_LIMIT} messages per chat within ${SEND_WINDOW_MS / 1000}s`, () => {
    const posts = produced.filter((p) => postedMessage(p.effect.act));
    for (const { at, effect } of posts) {
      const inWindow = posts.filter(
        (s) => s.effect.scope === effect.scope && s.at <= at && at - s.at < SEND_WINDOW_MS,
      );
      expect(inWindow.length).toBeLessThanOrEqual(SEND_LIMIT);
    }
  });

  it("never answers a failed or unknown action with another action", () => {
    expect(failedReplies).toEqual([]);
  });
});
