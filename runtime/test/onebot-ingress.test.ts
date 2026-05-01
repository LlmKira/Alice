import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listCanonicalEvents } from "../src/db/canonical-event-store.js";
import { closeDb, getDb, initDb } from "../src/db/connection.js";
import { messageLog } from "../src/db/schema.js";
import { ingestOneBotMessageEvent } from "../src/platform/onebot-ingress.js";
import { EventBuffer } from "../src/telegram/events.js";

function groupTextEvent() {
  return {
    post_type: "message",
    message_type: "group",
    time: 1_700_000_000,
    self_id: 10000,
    message_id: 456,
    group_id: 123,
    user_id: 789,
    sender: { user_id: 789, card: "同学甲" },
    message: [{ type: "text", data: { text: "hello" } }],
    raw_message: "hello",
  };
}

describe("OneBot ingress side-write", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("writes canonical_events and pushes projected events to EventBuffer", () => {
    const buffer = new EventBuffer();

    const result = ingestOneBotMessageEvent(groupTextEvent(), { tick: 1, buffer });

    expect(result).toMatchObject({
      sourceId: "message:123:456",
      stableMessageId: "message:qq:123:456",
      inserted: true,
    });
    expect(buffer.drain().events).toHaveLength(1);
    expect(listCanonicalEvents()).toHaveLength(1);
    expect(listCanonicalEvents()[0]).toMatchObject({
      source: "onebot",
      sourceId: "message:123:456",
    });
    const rows = getDb().select().from(messageLog).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      platform: "qq",
      chatId: "channel:qq:123",
      msgId: null,
      nativeChatId: "123",
      nativeMsgId: "456",
      stableMessageId: "message:qq:123:456",
      senderId: "contact:qq:789",
      senderName: "同学甲",
      text: "hello",
      isOutgoing: false,
      isDirected: false,
    });
  });

  it("deduplicates repeated OneBot source ids without suppressing EventBuffer delivery", () => {
    const buffer = new EventBuffer();

    const first = ingestOneBotMessageEvent(groupTextEvent(), { tick: 1, buffer });
    const second = ingestOneBotMessageEvent(groupTextEvent(), { tick: 1, buffer });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(buffer.drain().events).toHaveLength(2);
    expect(listCanonicalEvents()).toHaveLength(1);
  });
});
