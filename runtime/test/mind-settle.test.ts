import { describe, expect, it } from "vitest";
import { mechanisms } from "../src/mechanisms/registry.js";
import type { Act } from "../src/mind/affordances.js";
import { settleDecision } from "../src/mind/settle.js";
import {
  type AliceState,
  type ChatState,
  DROPPED_MS,
  emptyChat,
  emptyState,
  SEND_LIMIT,
  SEND_WINDOW_MS,
} from "../src/mind/state.js";
import { step } from "../src/mind/step.js";

const T0 = 1_771_000_000_000;

function chat(recentSends: number[] = [], overrides: Partial<ChatState> = {}): ChatState {
  return {
    ...emptyChat("telegram:-1", "group", true),
    timeline: [
      {
        at: T0 - 1000,
        messageId: "7",
        sender: { id: "u", name: "u" },
        text: "hi",
        contentType: "text",
        replyToMessageId: null,
      },
    ],
    recentSends,
    calls: 1,
    ...overrides,
  };
}

const say = (text: string, replyTo: string | null = null): Act => ({ kind: "send", text, replyTo });
const settle = (c: ChatState, acts: Act[]) => settleDecision(c, { acts }, T0).acts;

describe("settleDecision", () => {
  it("keeps the model's own choices about quoting, stickers and reactions, in order", () => {
    const acts: Act[] = [
      { kind: "react", messageId: "7", emoji: "👍" },
      say("嗯", "7"),
      { kind: "sticker", word: "laugh" },
    ];
    expect(settle(chat(), acts)).toEqual(acts);
  });

  it("caps messages per window, counting earlier sends still inside it; reactions are not messages", () => {
    const earlier = Array.from(
      { length: SEND_LIMIT - 1 },
      (_, i) => T0 - SEND_WINDOW_MS + (i + 1) * 1_000,
    );
    const settled = settle(chat(earlier), [
      say("a"),
      say("b"),
      { kind: "sticker", word: "laugh" },
      { kind: "react", messageId: "7", emoji: "👍" },
    ]);
    expect(settled).toEqual([say("a"), { kind: "react", messageId: "7", emoji: "👍" }]);
    expect(settled.filter((a) => a.kind === "send" || a.kind === "sticker")).toHaveLength(
      SEND_LIMIT - earlier.length,
    );
  });

  it("forgets sends that left the window", () => {
    const batch = Array.from({ length: SEND_LIMIT }, (_, i) => say(String(i)));
    expect(settle(chat([T0 - SEND_WINDOW_MS - 1]), batch)).toHaveLength(SEND_LIMIT);
  });

  it("drops a quote or reaction that points at a message outside this chat", () => {
    expect(
      settle(chat(), [say("嗯", "99"), { kind: "react", messageId: "99", emoji: "👍" }]),
    ).toEqual([say("嗯")]);
  });

  it("does nothing more in a chat after deciding to leave it", () => {
    expect(settle(chat(), [say("拜拜"), { kind: "leave-chat" }, say("还有")])).toEqual([
      say("拜拜"),
      { kind: "leave-chat" },
    ]);
  });

  it("cannot leave a private chat or act in a chat she already left", () => {
    expect(settle(chat([], { chatType: "private" }), [{ kind: "leave-chat" }])).toEqual([]);
    expect(settle(chat([], { member: false }), [say("在吗"), { kind: "mark-read" }])).toEqual([]);
  });

  it("does the same non-message action once per decision", () => {
    expect(settle(chat(), [{ kind: "mark-read" }, { kind: "mark-read" }])).toEqual([
      { kind: "mark-read" },
    ]);
  });

  it("reports the messages it dropped over the burst limit, so she can be told", () => {
    const earlier = Array.from({ length: SEND_LIMIT - 1 }, (_, i) => T0 - (i + 1) * 1_000);
    const settled = settleDecision(
      chat(earlier),
      { acts: [say("a"), say("b"), { kind: "sticker", word: "laugh" }] },
      T0,
    );
    expect(settled.acts).toEqual([say("a")]);
    expect(settled.dropped).toEqual([say("b"), { kind: "sticker", word: "laugh" }]);
    expect(settled.recentSends).toEqual([...earlier, T0]);
  });
});

describe("the chat remembers what the burst limit dropped", () => {
  const SCOPE = "telegram:-1";
  const deciding = (c: ChatState): AliceState => ({
    ...emptyState,
    chats: {
      [SCOPE]: {
        ...c,
        mind: { mode: "deciding", callId: "c1", since: T0, wakeAgain: false, waking: null },
      },
    },
  });
  const decided = (state: AliceState, at: number, acts: Act[]): AliceState =>
    step(
      state,
      { type: "speech.decided", at, scope: SCOPE, callId: "c1", decision: { acts } },
      mechanisms,
    ).state;

  it("keeps them on the chat, and clears them once she speaks there", () => {
    const full = Array.from({ length: SEND_LIMIT }, (_, i) => T0 - (i + 1) * 1_000);
    const state = decided(deciding(chat(full)), T0, [say("a")]);
    expect(state.chats[SCOPE]?.droppedSends).toEqual([{ at: T0, act: say("a") }]);
    const spoken = step(
      state,
      {
        type: "message.sent",
        at: T0 + 1_000,
        scope: SCOPE,
        messageId: "m1",
        text: "嗯",
        kind: "text",
      },
      mechanisms,
    ).state;
    expect(spoken.chats[SCOPE]?.droppedSends).toEqual([]);
  });

  it("drops the ones older than DROPPED_MS on the next decision", () => {
    const stale: ChatState = { ...chat(), droppedSends: [{ at: T0, act: say("a") }] };
    const state = decided(deciding(stale), T0 + DROPPED_MS + 1, []);
    expect(state.chats[SCOPE]?.droppedSends).toEqual([]);
  });
});
