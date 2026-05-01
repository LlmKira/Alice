import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeCanonicalEvent } from "../src/db/canonical-event-store.js";
import { closeDb, initDb } from "../src/db/connection.js";
import { renderDcpShadowContext } from "../src/diagnostics/dcp-shadow.js";

function seedMessage(): void {
  writeCanonicalEvent({
    kind: "message",
    tick: 1,
    occurredAtMs: 1000,
    channelId: "channel:1",
    contactId: "contact:1",
    directed: true,
    novelty: null,
    continuation: false,
    text: "hello shadow",
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
}

describe("DCP shadow diagnostic", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => {
    delete process.env.ALICE_PROMPT_LOG_DCP;
    closeDb();
  });

  it("renders canonical events as a prompt-log section", () => {
    seedMessage();

    const section = renderDcpShadowContext("channel:1").join("\n");

    expect(section).toContain("## DCP Shadow Context");
    expect(section).toContain("- source: canonical_events");
    expect(section).toContain("- events: 1");
    expect(section).toContain("- directed: 1");
    expect(section).toContain("hello shadow");
  });

  it("can be disabled without affecting prompt-log composition", () => {
    process.env.ALICE_PROMPT_LOG_DCP = "0";

    expect(renderDcpShadowContext("channel:1")).toEqual([]);
  });
});
