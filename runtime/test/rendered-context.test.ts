import { describe, expect, it } from "vitest";
import { projectCanonicalEvents } from "../src/projection/event-projection.js";
import {
  renderedContextToXml,
  renderProjectionView,
} from "../src/projection/rendering/rendered-context.js";
import type { CanonicalEvent } from "../src/telegram/canonical-events.js";

const events: CanonicalEvent[] = [
  {
    kind: "message",
    tick: 1,
    occurredAtMs: 1000,
    channelId: "channel:1",
    contactId: "contact:1",
    directed: true,
    novelty: null,
    continuation: false,
    text: "hello <Alice> & friends",
    senderName: "Mika",
    displayName: "Mika",
    chatDisplayName: "Room",
    chatType: "group",
    contentType: "text",
    senderIsBot: false,
    forwardFromChannelId: null,
    forwardFromChannelName: null,
    tmeLinks: [],
  },
  {
    kind: "message",
    tick: 2,
    occurredAtMs: 2000,
    channelId: "channel:1",
    contactId: "contact:bot",
    directed: false,
    novelty: null,
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
    tmeLinks: [],
  },
];

describe("RenderedContext seam", () => {
  it("renders projection messages into stable XML-like segments", () => {
    const view = projectCanonicalEvents(events);
    const segments = renderProjectionView(view);

    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({
      receivedAtMs: 1000,
      channelId: "channel:1",
      directed: true,
      senderIsBot: false,
    });
    expect(renderedContextToXml(segments)).toBe([
      '<message channel="channel:1" sender="contact:1" name="Mika" tick="1" t="1000" directed="true">hello &lt;Alice&gt; &amp; friends</message>',
      '<message channel="channel:1" sender="contact:bot" name="Bot" tick="2" t="2000" continuation="true" bot="true" media="sticker">[sticker]</message>',
    ].join("\n"));
  });
});
