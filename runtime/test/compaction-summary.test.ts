import { describe, expect, it } from "vitest";
import {
  applyCompactionSummary,
  latestApplicableSummary,
  renderCompactedTimeline,
  type CompactionSummary,
} from "../src/projection/compaction/summary.js";
import type { MergedTimelineItem } from "../src/projection/merge/rc-tr-merge.js";

const items: MergedTimelineItem[] = [
  {
    kind: "rc",
    timestampMs: 1000,
    segment: {
      receivedAtMs: 1000,
      channelId: "channel:1",
      text: "m1",
      directed: false,
      senderIsBot: false,
    },
  },
  {
    kind: "tr",
    timestampMs: 2000,
    turn: { requestedAtMs: 2000, entries: [{ role: "assistant", text: "r1" }] },
  },
  {
    kind: "rc",
    timestampMs: 3000,
    segment: {
      receivedAtMs: 3000,
      channelId: "channel:1",
      text: "m2",
      directed: true,
      senderIsBot: false,
    },
  },
];

const summaries: CompactionSummary[] = [
  {
    id: "old",
    createdAtMs: 10,
    cursorMs: 1500,
    summary: "old summary",
    sourceItemCount: 1,
    modelName: "test",
  },
  {
    id: "new",
    createdAtMs: 20,
    cursorMs: 2500,
    summary: "new summary",
    sourceItemCount: 2,
    modelName: "test",
  },
];

describe("append-only compaction summary", () => {
  it("chooses the latest summary without mutating source items", () => {
    const before = structuredClone(items);
    expect(latestApplicableSummary(summaries)?.id).toBe("new");

    const compacted = applyCompactionSummary(items, summaries);
    expect(items).toEqual(before);
    expect(compacted.summary?.id).toBe("new");
    expect(compacted.items.map((item) => item.timestampMs)).toEqual([3000]);
  });

  it("rollback is ignoring the latest summary", () => {
    const compacted = applyCompactionSummary(items, summaries.slice(0, 1));
    expect(compacted.summary?.id).toBe("old");
    expect(compacted.items.map((item) => item.timestampMs)).toEqual([2000, 3000]);
  });

  it("renders summary plus retained timeline", () => {
    expect(renderCompactedTimeline(applyCompactionSummary(items, summaries))).toBe([
      '<summary cursor="2500" items="2">new summary</summary>',
      "rc:3000",
    ].join("\n"));
  });
});
