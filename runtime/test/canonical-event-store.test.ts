import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, initDb } from "../src/db/connection.js";
import {
  listCanonicalEvents,
  writeCanonicalEvent,
} from "../src/db/canonical-event-store.js";
import { projectCanonicalEvents } from "../src/projection/event-projection.js";
import type { CanonicalEvent } from "../src/telegram/canonical-events.js";

const event = (tick: number, text: string, channelId = "channel:1"): CanonicalEvent => ({
  kind: "message",
  tick,
  occurredAtMs: tick * 1000,
  channelId,
  contactId: `contact:${tick}`,
  directed: tick === 1,
  novelty: null,
  continuation: false,
  text,
  senderName: `User ${tick}`,
  displayName: `User ${tick}`,
  chatDisplayName: "Room",
  chatType: "group",
  contentType: "text",
  senderIsBot: false,
  forwardFromChannelId: null,
  forwardFromChannelName: null,
  tmeLinks: [],
});

describe("canonical_events store", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("stores typed canonical facts and replays them in tick order", () => {
    const second = writeCanonicalEvent(event(2, "second"));
    const first = writeCanonicalEvent(event(1, "first"));
    expect(second).toBeGreaterThan(0);
    expect(first).toBeGreaterThan(0);

    const rows = listCanonicalEvents();
    expect(rows.map((row) => row.event.tick)).toEqual([1, 2]);
    expect(rows.map((row) => row.event.kind)).toEqual(["message", "message"]);

    const projection = projectCanonicalEvents(rows.map((row) => row.event));
    expect(projection.stats).toEqual({ eventCount: 2, messageCount: 2, directedCount: 1 });
  });

  it("filters by channel", () => {
    writeCanonicalEvent(event(1, "a", "channel:1"));
    writeCanonicalEvent(event(2, "b", "channel:2"));
    expect(listCanonicalEvents({ channelId: "channel:2" }).map((row) => row.event.tick)).toEqual([2]);
  });
});
