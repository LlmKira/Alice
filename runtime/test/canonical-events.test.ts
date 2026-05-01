import { describe, expect, it } from "vitest";
import {
  canonicalFromPerturbation,
  perturbationFromCanonical,
} from "../src/telegram/canonical-events.js";
import type { GraphPerturbation } from "../src/telegram/mapper.js";

describe("CanonicalEvent seam", () => {
  it("round-trips message perturbations without mtcute or DB", () => {
    const perturbation: GraphPerturbation = {
      type: "new_message",
      tick: 12,
      nowMs: 123456,
      channelId: "channel:1",
      contactId: "contact:2",
      isDirected: true,
      isContinuation: true,
      novelty: 0.7,
      displayName: "Alice",
      chatDisplayName: "Test Chat",
      chatType: "group",
      messageText: "hello @alice",
      senderName: "Alice",
      contentType: "photo",
      senderIsBot: false,
      forwardFromChannelId: "channel:9",
      forwardFromChannelName: "Source",
      tmeLinks: ["example_channel"],
    };

    const canonical = canonicalFromPerturbation(perturbation);
    expect(canonical).toMatchObject({
      kind: "message",
      tick: 12,
      directed: true,
      text: "hello @alice",
      contentType: "photo",
    });
    expect(perturbationFromCanonical(canonical)).toMatchObject({
      type: "new_message",
      tick: 12,
      nowMs: 123456,
      channelId: "channel:1",
      contactId: "contact:2",
      isDirected: true,
      isContinuation: true,
      messageText: "hello @alice",
      contentType: "photo",
      tmeLinks: ["example_channel"],
    });
  });

  it("round-trips reaction perturbations", () => {
    const perturbation: GraphPerturbation = {
      type: "reaction",
      tick: 5,
      channelId: "channel:1",
      contactId: "contact:2",
      emoji: "👍",
      messageId: 99,
    };

    const canonical = canonicalFromPerturbation(perturbation);
    expect(canonical).toMatchObject({ kind: "reaction", emoji: "👍", messageId: 99 });
    expect(perturbationFromCanonical(canonical)).toMatchObject({
      type: "reaction",
      tick: 5,
      channelId: "channel:1",
      contactId: "contact:2",
      emoji: "👍",
      messageId: 99,
    });
  });

  it("keeps runtime-only canonical events out of GraphPerturbation", () => {
    expect(() =>
      perturbationFromCanonical({
        kind: "runtime",
        tick: 1,
        occurredAtMs: null,
        channelId: null,
        contactId: null,
        directed: false,
        novelty: null,
      }),
    ).toThrow(/cannot be converted/);
  });
});
