import { describe, expect, it } from "vitest";
import {
  FAILED_SHOWN_MS,
  type FailuresState,
  failures,
  reduceFailures,
} from "../src/mechanisms/failures.js";
import { mechanisms } from "../src/mechanisms/registry.js";
import type { Act } from "../src/mind/affordances.js";
import type { AliceEvent } from "../src/mind/events.js";
import type { FailureCode } from "../src/mind/failure.js";
import {
  type AliceState,
  type ChatState,
  emptyChat,
  emptyState,
  SEND_LIMIT,
} from "../src/mind/state.js";
import { speechRequest, step } from "../src/mind/step.js";
import { renderSpeechPrompt } from "../src/speech/prompt.js";

const T0 = 1_771_000_000_000;
const A = "telegram:1";
const B = "telegram:2";

const failed = (
  at: number,
  act: Act,
  reason: Exclude<FailureCode, "errand">,
  scope = A,
): AliceEvent => ({
  type: "act.failed",
  at,
  scope,
  act,
  reason,
});
const sent = (at: number, scope = A): AliceEvent => ({
  type: "message.sent",
  at,
  scope,
  messageId: `m${at}`,
  text: "嗯嗯",
  kind: "text",
});
const react: Act = { kind: "react", messageId: "42", emoji: "🫠" };
const send: Act = { kind: "send", text: "明天见啦", replyTo: null };
const sticker: Act = { kind: "sticker", word: "开心" };

const chat = (scope: string): ChatState => emptyChat(scope, "private", true);
const fold = (events: AliceEvent[]) =>
  events.reduce(reduceFailures, failures.initial as FailuresState);
const facts = (events: AliceEvent[], now: number, scope = A) =>
  failures.contribute?.(chat(scope), now, fold(events), []).map((c) => c.text) ?? [];

describe("failures: what she tried to do outwardly and did not get done", () => {
  it("says it in plain words, in that chat only", () => {
    const events = [failed(T0, react, "invalid_reaction")];
    expect(facts(events, T0 + 1_000)).toEqual([
      "我刚才想给 [42] 点的表情 🫠 没点上（这里用不了这个表情）。",
    ]);
    expect(facts(events, T0 + 1_000, B)).toEqual([]);
    expect(failures.contribute?.(chat(A), T0, fold(events), [])[0]?.kind).toBe("failed");
  });

  it("shows each failure once; what was skipped after it is part of it, not a separate line", () => {
    const events = [
      failed(T0, sticker, "invalid_sticker_keyword"),
      failed(T0, send, "skipped_after_failure"),
      failed(T0 + 60_000, react, "invalid_reaction"),
      failed(T0 + 90_000, react, "invalid_reaction"),
    ];
    expect(facts(events, T0 + 120_000)).toEqual([
      "我刚才想发的「开心」贴纸没发出去（没有这个贴纸），那一回后面的也都没做。",
      "我刚才想给 [42] 点的表情 🫠 没点上（这里用不了这个表情）。",
    ]);
    expect(facts([failed(T0, send, "refused")], T0)).toEqual([
      "我刚才想发的「明天见啦」没发出去（被对方拉黑了）。",
    ]);
  });

  it("words an unknown outcome as uncertain, not as a failure", () => {
    expect(facts([failed(T0, send, "outcome_unknown")], T0)).toEqual([
      "我刚才想发的「明天见啦」不知道发出去没有。",
    ]);
  });

  it("says the messages the burst limit dropped, for the same window and chat", () => {
    const shown = (c: ChatState, now: number) =>
      failures.contribute?.(c, now, failures.initial, []).map((x) => x.text) ?? [];
    const dropped = (at: number, scope = A): ChatState => ({
      ...chat(scope),
      droppedSends: [{ at, act: send }],
    });
    expect(shown(dropped(T0), T0 + 1_000)).toEqual([
      `我刚才想发的「明天见啦」没发出去（一分钟内最多连发 ${SEND_LIMIT} 条）。`,
    ]);
    expect(shown(dropped(T0), T0 + FAILED_SHOWN_MS + 1)).toEqual([]);
    expect(shown(chat(B), T0 + 1_000)).toEqual([]);
  });

  it("is gone after the window, or once she has spoken there again", () => {
    const events = [failed(T0, send, "peer_unreachable")];
    expect(facts(events, T0 + FAILED_SHOWN_MS)).toHaveLength(1);
    expect(facts(events, T0 + FAILED_SHOWN_MS + 1)).toEqual([]);
    expect(facts([...events, sent(T0 + 5_000)], T0 + 6_000)).toEqual([]);
    // 在别的会话里说话不算。
    expect(facts([...events, sent(T0 + 5_000, B)], T0 + 6_000)).toHaveLength(1);
  });

  it("leaves background tasks to step(), which already reports them", () => {
    expect(facts([failed(T0, { kind: "delegate", task: "查天气" }, "interrupted")], T0)).toEqual(
      [],
    );
  });
});

describe("failures in production", () => {
  const received: AliceEvent = {
    type: "message.received",
    at: T0,
    scope: A,
    chatType: "private",
    messageId: "42",
    senderId: "u1",
    senderName: "小周",
    text: "晚安",
    contentType: "text",
    replyToMessageId: null,
    directed: true,
  };
  const run = (events: AliceEvent[]) =>
    events.reduce<{ state: AliceState; effects: unknown[] }>(
      (acc, e) => {
        const r = step(acc.state, e, mechanisms);
        return { state: r.state, effects: r.effects };
      },
      { state: emptyState, effects: [] },
    );

  it("a failure changes nothing she does by itself: no retry, no wake", () => {
    const before = run([received]).state;
    expect(
      step(before, failed(T0 + 30_000, react, "invalid_reaction"), mechanisms).effects,
    ).toEqual([]);
  });

  it("reaches her prompt in the card, with what she promised and what just happened", () => {
    const { state } = run([received, failed(T0 + 30_000, react, "invalid_reaction")]);
    const here = state.chats[A] as ChatState;
    const request = speechRequest(state, here, T0 + 60_000, "42", mechanisms);
    const user = renderSpeechPrompt("persona", request).user;
    expect(user).toContain(
      "· 约定与刚才的动静：\n  我刚才想给 [42] 点的表情 🫠 没点上（这里用不了这个表情）。",
    );
  });

  it("also shows what she wanted to say but the burst limit dropped", () => {
    const here: ChatState = { ...chat(A), droppedSends: [{ at: T0, act: send }] };
    const state: AliceState = { ...emptyState, chats: { [A]: here } };
    const request = speechRequest(state, here, T0 + 60_000, null, mechanisms);
    expect(renderSpeechPrompt("persona", request).user).toMatch(
      /我刚才想发的「明天见啦」没发出去（一分钟内最多连发 \d+ 条）。/,
    );
  });
});
