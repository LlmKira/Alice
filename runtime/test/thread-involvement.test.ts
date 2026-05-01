import { describe, expect, it } from "vitest";
import {
  hasEffectiveThreadInvolvement,
  isEffectiveThreadInvolvementNodeId,
  parseThreadInvolvementNodeIds,
} from "../src/graph/thread-involvement.js";

describe("thread involvement parsing", () => {
  it("distinguishes effective graph node IDs from raw display handles", () => {
    const raw = JSON.stringify([
      { nodeId: "contact:A", role: "participant" },
      { nodeId: "channel:-1001", role: "venue" },
      { nodeId: "@6822668883", role: "romantic_interest" },
      { nodeId: "undefined", role: "bad" },
      { nodeId: "", role: "empty" },
    ]);

    expect(parseThreadInvolvementNodeIds(raw)).toEqual([
      "@6822668883",
      "channel:-1001",
      "contact:A",
    ]);
    expect(hasEffectiveThreadInvolvement(raw)).toBe(true);
    expect(isEffectiveThreadInvolvementNodeId("@6822668883")).toBe(false);
    expect(isEffectiveThreadInvolvementNodeId("contact:A")).toBe(true);
  });

  it("does not treat legacy raw handles as effective involvement", () => {
    expect(
      hasEffectiveThreadInvolvement(
        JSON.stringify([{ nodeId: "@6822668883", role: "romantic_interest" }]),
      ),
    ).toBe(false);
    expect(hasEffectiveThreadInvolvement(JSON.stringify(["@6822668883"]))).toBe(false);
  });
});
