import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeCanonicalEvent } from "../src/db/canonical-event-store.js";
import { closeDb, initDb } from "../src/db/connection.js";
import { renderDcpReplayDiagnostic } from "../src/diagnostics/dcp-replay.js";

describe("DCP replay diagnostic", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("renders canonical_events directly without legacy backfill", () => {
    writeCanonicalEvent({
      kind: "message",
      tick: 1,
      occurredAtMs: 1000,
      channelId: "channel:1",
      contactId: "contact:1",
      directed: true,
      novelty: null,
      continuation: false,
      text: "hello Alice",
      senderName: "Mika",
      displayName: "Mika",
      chatDisplayName: "Room",
      chatType: "group",
      contentType: "text",
      senderIsBot: false,
      forwardFromChannelId: null,
      forwardFromChannelName: null,
      tmeLinks: [],
    });

    const report = renderDcpReplayDiagnostic({ chatId: "channel:1" });

    expect(report).toContain("Messages: 1");
    expect(report).toContain("Directed: 1");
    expect(report).toContain("hello Alice");
    expect(report).not.toContain("Backfill:");
  });
});
