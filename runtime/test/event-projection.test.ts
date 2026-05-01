import { describe, expect, it } from "vitest";
import { projectCanonicalEvents } from "../src/projection/event-projection.js";
import type { CanonicalEvent } from "../src/telegram/canonical-events.js";

const fixture = (): CanonicalEvent[] => [
  {
    kind: "message",
    tick: 1,
    occurredAtMs: 1000,
    channelId: "channel:1",
    contactId: "contact:1",
    directed: true,
    novelty: 0.5,
    continuation: false,
    text: "hi Alice",
    senderName: "Mika",
    displayName: "Mika",
    chatDisplayName: "Room",
    chatType: "group",
    contentType: "text",
    senderIsBot: false,
    forwardFromChannelId: null,
    forwardFromChannelName: null,
    tmeLinks: ["source_a"],
  },
  {
    kind: "message",
    tick: 2,
    occurredAtMs: 2000,
    channelId: "channel:1",
    contactId: "contact:2",
    directed: false,
    novelty: 0.2,
    continuation: true,
    text: null,
    senderName: "Bot",
    displayName: "Bot",
    chatDisplayName: "Room",
    chatType: "group",
    contentType: "sticker",
    senderIsBot: true,
    forwardFromChannelId: null,
    forwardFromChannelName: null,
    tmeLinks: ["source_a", "source_b"],
  },
  {
    kind: "reaction",
    tick: 3,
    occurredAtMs: 2500,
    channelId: "channel:1",
    contactId: "contact:1",
    directed: false,
    novelty: null,
    emoji: "👍",
    messageId: 2,
  },
];

describe("CanonicalEvent projection", () => {
  it("replays deterministically", () => {
    const first = projectCanonicalEvents(fixture());
    const second = projectCanonicalEvents(fixture());
    expect(second).toEqual(first);
  });

  it("projects channel, participant, message, and reaction views", () => {
    const view = projectCanonicalEvents(fixture());

    expect(view.stats).toEqual({ eventCount: 3, messageCount: 2, directedCount: 1 });
    expect(view.channels["channel:1"]).toMatchObject({
      messageCount: 2,
      directedCount: 1,
      botMessageCount: 1,
      tmeLinks: ["source_a", "source_b"],
    });
    expect(view.participants["contact:1"]).toMatchObject({ messageCount: 1, bot: false });
    expect(view.participants["contact:2"]).toMatchObject({ messageCount: 1, bot: true });
    expect(view.messages).toHaveLength(2);
    expect(view.reactions).toEqual([
      {
        tick: 3,
        occurredAtMs: 2500,
        channelId: "channel:1",
        contactId: "contact:1",
        emoji: "👍",
        messageId: 2,
      },
    ]);
  });
});
