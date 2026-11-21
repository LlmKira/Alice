import { describe, expect, it } from "vitest";
import type { AliceEvent } from "../src/mind/events.js";
import { scopeOf, toEvent } from "../src/sim/import-message-log.js";
import { replay, type SpeechOracle } from "../src/sim/replay.js";
import { directedWake } from "./directed-wake.js";

const T0 = 1_771_000_000_000;
/** 只测回放本身：立刻开口，不等对方说完（patience 另有测试）。 */
const mechanisms = [directedWake];

const events: AliceEvent[] = [
  {
    type: "message.received",
    at: T0,
    scope: "telegram:1",
    chatType: "private",
    messageId: "1",
    senderId: "u",
    senderName: "池塘",
    text: "在吗",
    contentType: "text",
    replyToMessageId: null,
    directed: true,
  },
  {
    type: "message.received",
    at: T0 + 10,
    scope: "telegram:-5",
    chatType: "group",
    messageId: "2",
    senderId: "v",
    senderName: "小雨",
    text: "显卡快 100 度了",
    contentType: "text",
    replyToMessageId: null,
    directed: false,
  },
  {
    type: "message.received",
    at: T0 + 20,
    scope: "telegram:-5",
    chatType: "group",
    messageId: "3",
    senderId: "v",
    senderName: "小雨",
    text: "@alice 你说呢",
    contentType: "text",
    replyToMessageId: null,
    directed: true,
  },
];

const oracle: SpeechOracle = (request) => ({
  acts: [
    {
      kind: "send",
      text: `看到了 ${request.timeline.length} 条`,
      replyTo: request.triggerMessageId,
    },
  ],
});

describe("replay", () => {
  it("is deterministic: the same events give byte-identical results", async () => {
    const a = await replay(events, { mechanisms, speech: oracle });
    const b = await replay(events, { mechanisms, speech: oracle });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.effects.map((r) => r.effect.type)).toEqual([
      "call-speech",
      "act",
      "call-speech",
      "act",
    ]);
  });

  it("feeds her own sends back into the timeline", async () => {
    const { state } = await replay(events, { mechanisms, speech: oracle });
    expect(state.chats["telegram:-5"]?.timeline.map((t) => t.sender?.name ?? "Alice")).toEqual([
      "小雨",
      "小雨",
      "Alice",
    ]);
  });

  it("treats a null oracle answer as a failed call", async () => {
    const { effects, state } = await replay(events.slice(0, 1), { mechanisms, speech: () => null });
    expect(effects.map((r) => r.effect.type)).toEqual(["call-speech"]);
    expect(state.chats["telegram:1"]?.mind).toEqual({ mode: "idle" });
  });
});

describe("message_log import", () => {
  it("normalises both legacy chat id spellings", () => {
    expect(scopeOf("channel:telegram:-1001")).toBe("telegram:-1001");
    expect(scopeOf("channel:5166")).toBe("telegram:5166");
  });

  it("maps outgoing rows to message.sent and incoming rows to message.received", () => {
    const base = {
      chat_id: "channel:-1001",
      msg_id: 7,
      reply_to_msg_id: 5,
      sender_id: "u",
      sender_name: "u",
      text: "hi",
      media_type: null,
      is_directed: 1,
      created_at: 1000,
    };
    expect(toEvent({ ...base, is_outgoing: 1 }, 0)).toMatchObject({
      type: "message.sent",
      at: 1_000_000,
      messageId: "7",
    });
    expect(toEvent({ ...base, is_outgoing: 0 }, 0)).toMatchObject({
      type: "message.received",
      chatType: "group",
      replyToMessageId: "5",
      directed: true,
    });
  });
});
