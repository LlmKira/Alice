import { beforeEach, describe, expect, it } from "vitest";
import { createOneBotTransportAdapter, type OneBotHttpFetch } from "../src/platform/onebot.js";
import {
  cacheOneBotOutgoingMsg,
  clearOneBotOutgoingMsgCacheForTest,
  mapOneBotMessageEventToCanonical,
  mapOneBotMessageEventToPerturbation,
  parseOneBotMessageEvent,
} from "../src/platform/onebot-events.js";

function groupTextEvent(overrides: Record<string, unknown> = {}) {
  return {
    post_type: "message",
    message_type: "group",
    time: 1_700_000_000,
    self_id: 10000,
    message_id: 456,
    group_id: 123,
    user_id: 789,
    sender: { user_id: 789, card: "同学甲", nickname: "甲" },
    message: [{ type: "text", data: { text: "hello" } }],
    raw_message: "hello",
    ...overrides,
  };
}

function privateTextEvent(overrides: Record<string, unknown> = {}) {
  return {
    post_type: "message",
    message_type: "private",
    time: 1_700_000_001,
    self_id: 10000,
    message_id: "p-1",
    user_id: 789,
    sender: { user_id: 789, nickname: "同学乙" },
    message: [{ type: "text", data: { text: "私聊" } }],
    raw_message: "私聊",
    ...overrides,
  };
}

describe("OneBot message event mapper", () => {
  beforeEach(() => {
    clearOneBotOutgoingMsgCacheForTest();
  });

  it("maps QQ group text to canonical message without directed pressure", () => {
    const mapped = mapOneBotMessageEventToCanonical(groupTextEvent(), { tick: 42 });

    expect(mapped.event).toMatchObject({
      kind: "message",
      tick: 42,
      occurredAtMs: 1_700_000_000_000,
      channelId: "channel:qq:123",
      contactId: "contact:qq:789",
      directed: false,
      text: "hello",
      senderName: "同学甲",
      displayName: "同学甲",
      chatType: "group",
      contentType: "text",
    });
    expect(mapped.sourceId).toBe("message:123:456");
    expect(mapped.stableMessageId).toBe("message:qq:123:456");
  });

  it("marks QQ group @self as directed and keeps platform=qq, not OneBot", () => {
    const mapped = mapOneBotMessageEventToCanonical(
      groupTextEvent({
        message: [
          { type: "at", data: { qq: "10000" } },
          { type: "text", data: { text: " 来一下" } },
        ],
      }),
      { tick: 7, selfId: "10000", selfDisplayName: "Alice" },
    );

    expect(mapped.event.directed).toBe(true);
    expect(mapped.event.text).toBe("@Alice 来一下");
    expect(mapped.event.channelId).toBe("channel:qq:123");
    expect(mapped.event.contactId).toBe("contact:qq:789");
    expect(mapped.stableMessageId).not.toContain("onebot");
    expect(mapped.stableMessageId).not.toContain("napcat");
  });

  it("marks private QQ messages as directed", () => {
    const mapped = mapOneBotMessageEventToCanonical(privateTextEvent(), { tick: 3 });

    expect(mapped.event).toMatchObject({
      channelId: "channel:qq:789",
      contactId: "contact:qq:789",
      directed: true,
      chatDisplayName: "同学乙",
      chatType: "private",
      text: "私聊",
    });
    expect(mapped.stableMessageId).toBe("message:qq:789:p-1");
  });

  it("marks replies to cached outgoing OneBot messages as directed", () => {
    cacheOneBotOutgoingMsg("123", "321");

    const mapped = mapOneBotMessageEventToCanonical(
      groupTextEvent({
        message: [
          { type: "reply", data: { id: 321 } },
          { type: "text", data: { text: "接上句" } },
        ],
      }),
      { tick: 8 },
    );

    expect(mapped.event.directed).toBe(true);
    expect(mapped.event.text).toBe("接上句");
  });

  it("uses readable placeholders for common media segments", () => {
    const mapped = mapOneBotMessageEventToCanonical(
      groupTextEvent({
        message: [
          { type: "image", data: { url: "https://example.test/a.png" } },
          { type: "record", data: { file: "voice.amr" } },
          { type: "file", data: { name: "report.pdf" } },
        ],
      }),
      { tick: 9 },
    );

    expect(mapped.event.contentType).toBe("photo");
    expect(mapped.event.text).toBe("[图片][语音][文件:report.pdf]");
  });

  it("falls back to raw string messages when post-format is not array", () => {
    const mapped = mapOneBotMessageEventToCanonical(
      groupTextEvent({ message: "plain from raw", raw_message: "plain from raw" }),
      { tick: 10 },
    );

    expect(mapped.event.text).toBe("plain from raw");
    expect(mapped.event.contentType).toBe("text");
  });

  it("rejects non-message OneBot payloads at the parse boundary", () => {
    expect(() => parseOneBotMessageEvent({ post_type: "notice" })).toThrow();
  });

  it("can project OneBot canonical messages to current GraphPerturbation shape", () => {
    const mapped = mapOneBotMessageEventToPerturbation(groupTextEvent(), { tick: 11 });

    expect(mapped.event).toMatchObject({
      type: "new_message",
      tick: 11,
      channelId: "channel:qq:123",
      contactId: "contact:qq:789",
      messageText: "hello",
      isDirected: false,
    });
    expect(mapped.sourceId).toBe("message:123:456");
  });

  it("caches OneBot outbound message ids returned by transport send", async () => {
    const fetch = (async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 321 } }),
    })) satisfies OneBotHttpFetch;
    const adapter = createOneBotTransportAdapter({ apiBaseUrl: "http://onebot.local", fetch });

    await adapter.send?.({
      target: {
        kind: "channel",
        platform: "qq",
        nativeId: "123",
        stableId: "channel:qq:123",
        legacy: false,
      },
      text: "out",
    });
    const mapped = mapOneBotMessageEventToCanonical(
      groupTextEvent({
        message: [
          { type: "reply", data: { id: 321 } },
          { type: "text", data: { text: "reply" } },
        ],
      }),
      { tick: 12 },
    );

    expect(mapped.event.directed).toBe(true);
  });
});
