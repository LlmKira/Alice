import { describe, expect, it } from "vitest";
import {
  type ClosenessState,
  closeness,
  rankOf,
  reduceCloseness,
} from "../src/mechanisms/closeness.js";
import { examples } from "../src/mechanisms/examples.js";
import type { AliceEvent, MessageReceived } from "../src/mind/events.js";
import { type ChatState, emptyChat, emptyState } from "../src/mind/state.js";
import { step } from "../src/mind/step.js";
import { renderSpeechPrompt } from "../src/speech/prompt.js";
import { directedWake } from "./directed-wake.js";

const T0 = 1_771_000_000_000;
const DAY = 24 * 60 * 60_000;

function msg(senderId: string, at: number, extra: Partial<MessageReceived> = {}): MessageReceived {
  return {
    type: "message.received",
    at,
    scope: "telegram:-1",
    chatType: "group",
    messageId: `${senderId}-${at}`,
    senderId,
    senderName: senderId.toUpperCase(),
    text: "hi",
    contentType: "text",
    replyToMessageId: null,
    directed: true,
    ...extra,
  };
}

function fold(events: AliceEvent[]): ClosenessState {
  return events.reduce(reduceCloseness, closeness.initial as ClosenessState);
}

const chatWith = (ids: string[], chatType: "group" | "private" = "group"): ChatState => ({
  ...emptyChat("telegram:-1", chatType, true),
  timeline: ids.map((id, i) => ({
    at: T0 + i,
    messageId: String(i),
    sender: { id, name: id.toUpperCase() },
    text: "hi",
    contentType: "text",
    replyToMessageId: null,
  })),
});

describe("closeness", () => {
  it("ranks people by how often they talk with her, merging bursts into one episode", () => {
    const s = fold([
      msg("a", T0),
      msg("a", T0 + DAY),
      msg("a", T0 + 2 * DAY),
      msg("b", T0),
      msg("b", T0 + 60_000), // same episode as the previous one
      msg("b", T0 + 120_000),
    ]);
    expect(rankOf(s, "a", T0 + 2 * DAY)).toBe(1);
    expect(rankOf(s, "b", T0 + 2 * DAY)).toBe(2);
    expect(rankOf(s, "nobody", T0)).toBeNull();
  });

  it("lets old closeness fade", () => {
    const s = fold([msg("a", T0), msg("a", T0 + 1), msg("b", T0 + 60 * DAY)]);
    expect(rankOf(s, "b", T0 + 60 * DAY)).toBe(1);
  });

  it("ignores undirected chatter", () => {
    expect(rankOf(fold([msg("a", T0, { directed: false })]), "a", T0)).toBeNull();
  });

  it("is kept up by reciprocity: her own unanswered bids add nothing, her replies extend the episode", () => {
    const said = (at: number): AliceEvent => ({
      type: "message.sent",
      at,
      scope: "telegram:9",
      messageId: `x${at}`,
      text: "hey",
      kind: "text",
    });
    const opened = fold([msg("p", T0, { scope: "telegram:9", chatType: "private" })]);
    const bids = [1, 2, 3].map((d) => said(T0 + d * DAY)).reduce(reduceCloseness, opened);
    expect(bids.people.p?.score).toBeLessThanOrEqual(opened.people.p?.score ?? 0);
    // she answers within the episode, he answers her 9 min later: still one episode
    const talk = [
      said(T0 + 5 * 60_000),
      msg("p", T0 + 14 * 60_000, { scope: "telegram:9", chatType: "private" }),
    ];
    expect(talk.reduce(reduceCloseness, opened).people.p?.score).toBe(1);
  });

  it("states facts only about people present, and nothing about strangers", () => {
    const s = fold([msg("a", T0)]);
    const out = closeness.contribute?.(chatWith(["a", "stranger"]), T0, s, []) ?? [];
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toContain("A：很亲近");
    expect(out[0]?.text).not.toContain("STRANGER");
    expect(closeness.contribute?.(chatWith(["stranger"]), T0, s, [])).toEqual([]);
  });
});

describe("examples", () => {
  it("shows group examples in groups, mostly silent, with the output shape", () => {
    const [out] = examples.contribute?.(chatWith([]), T0, undefined, []) ?? [];
    expect(out?.text).toContain("在群里");
    const prompt = renderSpeechPrompt("p", {
      scope: "telegram:-1",
      chatType: "group",
      timeline: [],
      contributions: out ? [out] : [],
      triggerMessageId: null,
      at: T0,
      affordances: ["send", "sticker"],
    }).system;
    expect(prompt).toContain("  ▸ 大家在聊一个你没玩过的游戏\n    （不调用 run_code）");
    expect(prompt).toContain('text: "bridge 模式试试？容器间通信走 docker0", replyTo: "12" });');
    expect(prompt).toContain('await tools.sticker({ word: "laugh" });');
  });

  it("shows private examples in private chats", () => {
    const [out] = examples.contribute?.(chatWith([], "private"), T0, undefined, []) ?? [];
    expect(out?.text).toContain("私聊时");
  });
});

describe("step with stateful mechanisms", () => {
  it("folds mechanism state and passes contributions into the speech request", () => {
    const active = [directedWake, closeness];
    let state = emptyState;
    state = step(state, msg("a", T0, { directed: false }), active).state;
    state = step(state, msg("a", T0 + DAY, { directed: false }), active).state;
    const { effects } = step(state, msg("a", T0 + 2 * DAY), active);
    const call = effects[0];
    expect(call?.type).toBe("call-speech");
    expect(call?.type === "call-speech" && call.request.contributions[0]?.text).toContain("A：");
  });
});
