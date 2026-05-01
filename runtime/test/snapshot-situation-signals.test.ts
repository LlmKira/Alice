import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, initDb } from "../src/db/connection.js";
import { ALICE_SELF } from "../src/graph/constants.js";
import { WorldModel } from "../src/graph/world-model.js";
import { buildUserPromptSnapshot } from "../src/prompt/snapshot.js";

function makeGraph(): WorldModel {
  const G = new WorldModel();
  G.addAgent(ALICE_SELF);
  G.addContact("contact:2", { display_name: "林秀" });
  G.addChannel("channel:1", { chat_type: "private", display_name: "Current" });
  G.addChannel("channel:2", { chat_type: "private", display_name: "林秀", pending_directed: 1 });
  G.addChannel("channel:g", { chat_type: "supergroup", display_name: "Group", pending_directed: 1 });
  G.addRelation(ALICE_SELF, "monitors", "channel:1");
  G.addRelation(ALICE_SELF, "monitors", "channel:2");
  G.addRelation(ALICE_SELF, "monitors", "channel:g");
  return G;
}

describe("snapshot situation signals", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("summarizes non-target private pending signals without exposing executable target", () => {
    const snapshot = buildUserPromptSnapshot({
      G: makeGraph(),
      messages: [],
      observations: [],
      item: { action: "conversation", target: "channel:1", facetId: "core" } as never,
      round: 0,
      board: { maxSteps: 3, contextVars: {} },
      nowMs: Date.UTC(2026, 3, 25, 5, 0, 0),
      timezoneOffset: 9,
      chatType: "private",
      isGroup: false,
      isChannel: false,
    });

    expect(snapshot.situationSignals).toContain(
      "Someone else sent you a DM; handle it in its own turn, not from this chat.",
    );
    expect(snapshot.situationSignals.join("\n")).not.toContain("林秀 @2 sent you a DM");
    expect(snapshot.situationSignals.join("\n")).not.toContain("@2");
    expect(snapshot.situationSignals.join("\n")).toContain("Group");
    expect(snapshot.situationSignals.join("\n")).toContain("is waiting for your reply");
  });
});
