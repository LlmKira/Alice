import { describe, expect, it } from "vitest";
import {
  collectRhythmEventsFromMessages,
  normalizeContactSenderId,
} from "../src/diagnostics/rhythm-source.js";

describe("ADR-261 rhythm source hygiene", () => {
  it("normalizes positive Telegram sender IDs to contact IDs", () => {
    expect(normalizeContactSenderId("6571477950")).toBe("contact:6571477950");
    expect(normalizeContactSenderId("contact:6571477950")).toBe("contact:6571477950");
  });

  it("does not treat group/channel sender IDs as contacts", () => {
    expect(normalizeContactSenderId("-1002284009837")).toBeNull();
    expect(normalizeContactSenderId("channel:-1002284009837")).toBeNull();
  });

  it("collects channel events and skips channel-like sender contact events", () => {
    const { byEntity, stats } = collectRhythmEventsFromMessages([
      {
        chat_id: "channel:-1001",
        sender_id: "-1001",
        is_outgoing: 0,
        created_at: 1_700_000_000,
      },
      {
        chat_id: "channel:42",
        sender_id: "777",
        is_outgoing: 0,
        created_at: 1_700_000_100,
      },
      {
        chat_id: "channel:42",
        sender_id: "888",
        is_outgoing: 1,
        created_at: 1_700_000_200,
      },
    ]);

    expect(byEntity.has("channel:-1001")).toBe(true);
    expect(byEntity.has("contact:-1001")).toBe(false);
    expect(byEntity.has("contact:777")).toBe(true);
    expect(byEntity.has("contact:888")).toBe(false);
    expect(stats.channelEvents).toBe(3);
    expect(stats.contactEvents).toBe(1);
    expect(stats.skippedChannelLikeSenders).toBe(1);
    expect(stats.skippedOutgoingSenders).toBe(1);
  });
});
