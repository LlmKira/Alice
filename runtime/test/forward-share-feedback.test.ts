import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, initDb } from "../src/db/connection.js";
import { ALICE_SELF } from "../src/graph/constants.js";
import {
  readForwardRegistry,
  readLastSharedMs,
  recordForwardShare,
} from "../src/graph/dynamic-props.js";
import { WorldModel } from "../src/graph/world-model.js";
import { renderChannel } from "../src/prompt/renderers/channel.js";
import { buildUserPromptSnapshot } from "../src/prompt/snapshot.js";

const NOW = Date.UTC(2026, 3, 26, 3, 40, 0);

function makeGraph(): WorldModel {
  const G = new WorldModel();
  G.addAgent(ALICE_SELF);
  G.addChannel("channel:telegram:-1001104204833", {
    chat_type: "channel",
    display_name: "Solidot",
  });
  G.addContact("contact:telegram:733349448", {
    tier: 15,
    display_name: "是日落果儿",
  });
  G.addChannel("channel:telegram:733349448", {
    chat_type: "private",
    display_name: "是日落果儿",
    last_activity_ms: NOW - 10 * 60_000,
  });
  G.addRelation(ALICE_SELF, "monitors", "channel:telegram:-1001104204833");
  G.addRelation(ALICE_SELF, "monitors", "channel:telegram:733349448");
  G.addRelation("contact:telegram:733349448", "joined", "channel:telegram:733349448");
  return G;
}

describe("forward share feedback loop", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("records one forward fact for both timeline marks and recent-share projection", () => {
    const G = makeGraph();

    recordForwardShare(G, {
      fromGraphId: "channel:telegram:-1001104204833",
      msgId: 29693,
      toGraphId: "channel:telegram:733349448",
      targetName: "是日落果儿",
      nowMs: NOW,
    });

    expect(readLastSharedMs(G, "channel:telegram:-1001104204833")).toBe(NOW);
    expect(readLastSharedMs(G, "channel:telegram:733349448")).toBe(NOW);
    expect(readForwardRegistry(G, "channel:telegram:-1001104204833")).toEqual({
      "29693": ["是日落果儿"],
    });
  });

  it("renders shared recently in the real channel snapshot path", () => {
    const G = makeGraph();
    recordForwardShare(G, {
      fromGraphId: "channel:telegram:-1001104204833",
      msgId: 29693,
      toGraphId: "channel:telegram:733349448",
      targetName: "是日落果儿",
      nowMs: NOW - 20 * 60_000,
    });

    const snapshot = buildUserPromptSnapshot({
      G,
      messages: [],
      observations: [],
      item: {
        action: "channel_watch",
        target: "channel:telegram:-1001104204833",
        facetId: "core",
      } as never,
      round: 0,
      board: { maxSteps: 3, contextVars: {} },
      nowMs: NOW,
      timezoneOffset: 9,
      chatType: "channel",
      isGroup: false,
      isChannel: true,
    });
    const text = renderChannel(snapshot);

    expect(text).toContain("是日落果儿 @733349448");
    expect(text).toContain("shared recently");
  });
});
