import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listCanonicalEvents } from "../src/db/canonical-event-store.js";
import { closeDb, initDb } from "../src/db/connection.js";
import { EventBuffer, pushCanonicalPerturbation } from "../src/telegram/events.js";

describe("Telegram canonical side-write", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("writes canonical_events and still pushes to EventBuffer", () => {
    const buffer = new EventBuffer();
    pushCanonicalPerturbation(buffer, {
      type: "new_message",
      tick: 1,
      nowMs: 1000,
      channelId: "channel:1",
      contactId: "contact:1",
      isDirected: true,
      messageText: "hello",
      senderName: "Mika",
      contentType: "text",
    }, "msg:1");

    expect(buffer.drain().events).toHaveLength(1);
    const rows = listCanonicalEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "telegram", sourceId: "msg:1" });
    expect(rows[0]?.event).toMatchObject({ kind: "message", text: "hello", directed: true });
  });

  it("deduplicates stable telegram source ids", () => {
    const buffer = new EventBuffer();
    const event = {
      type: "typing" as const,
      tick: 2,
      channelId: "channel:1",
      contactId: "contact:1",
    };
    pushCanonicalPerturbation(buffer, event, "typing:1");
    pushCanonicalPerturbation(buffer, event, "typing:1");

    expect(buffer.drain().events).toHaveLength(2);
    expect(listCanonicalEvents()).toHaveLength(1);
  });
});
