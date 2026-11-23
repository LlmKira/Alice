/**
 * 反思结果里旧的群印象（learned.group）：现在不 fold、不显示，但 Journal 里带着它的旧行必须照样读得回，
 * 否则同一行里的日记条目也跟着丢了。
 */
import { describe, expect, it } from "vitest";
import { decodeEvent } from "../src/journal.js";

describe("old group impressions in the journal", () => {
  it("a reflection result that still carries a group impression reads back", () => {
    const old = {
      type: "ponder.done",
      at: Date.parse("2026-11-12T06:00:00Z"),
      scope: "self",
      callId: "c",
      ponder: {
        kind: "reflect",
        scope: "telegram:-1009",
        entries: [],
        learned: { group: { topics: "胶片", tone: "随便" } },
      },
    };
    expect(decodeEvent("ponder.done", "self", old)).toEqual(old);
  });
});
