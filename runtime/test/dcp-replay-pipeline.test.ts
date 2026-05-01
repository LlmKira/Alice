import { describe, expect, it } from "vitest";
import { applyCompactionSummary } from "../src/projection/compaction/summary.js";
import { projectCanonicalEvents } from "../src/projection/event-projection.js";
import {
  mergedTimelineToText,
  mergeRenderedContextAndTurns,
  type TurnResponseRecord,
} from "../src/projection/merge/rc-tr-merge.js";
import {
  renderedContextToXml,
  renderProjectionView,
} from "../src/projection/rendering/rendered-context.js";
import type { CanonicalEvent } from "../src/telegram/canonical-events.js";

const events = (): CanonicalEvent[] => [
  {
    kind: "message",
    tick: 1,
    occurredAtMs: 1000,
    channelId: "channel:1",
    contactId: "contact:1",
    directed: true,
    novelty: null,
    continuation: false,
    text: "Alice?",
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
    occurredAtMs: 3000,
    channelId: "channel:1",
    contactId: "contact:2",
    directed: false,
    novelty: null,
    continuation: true,
    text: "follow up",
    senderName: "Nana",
    displayName: "Nana",
    chatDisplayName: "Room",
    chatType: "group",
    contentType: "text",
    senderIsBot: false,
    forwardFromChannelId: null,
    forwardFromChannelName: null,
    tmeLinks: [],
  },
];

const turns: TurnResponseRecord[] = [
  {
    requestedAtMs: 2000,
    actionLogId: 1,
    entries: [
      { kind: "block", script: "send_message('yes')", afterward: "done" },
      {
        kind: "host_restatement",
        summary: "message sent",
        observations: ["msgId=10"],
        completedActions: ["sent:chatId=channel:1:msgId=10"],
        errors: [],
      },
    ],
  },
];

describe("DCP replay fixture", () => {
  it("replays canonical events through projection, rendering, merge, and compaction deterministically", () => {
    const run = () => {
      const projection = projectCanonicalEvents(events());
      const rc = renderProjectionView(projection);
      const merged = mergeRenderedContextAndTurns(rc, turns);
      const compacted = applyCompactionSummary(merged, [
        {
          id: "s1",
          createdAtMs: 4000,
          cursorMs: 2500,
          summary: "Mika asked Alice; Alice answered yes.",
          sourceItemCount: 2,
          modelName: "fixture",
        },
      ]);
      return {
        projection,
        rcXml: renderedContextToXml(rc),
        mergedText: mergedTimelineToText(merged),
        compacted,
      };
    };

    const first = run();
    const second = run();

    expect(second).toEqual(first);
    expect(first.rcXml).toContain("Alice?");
    expect(first.mergedText).toContain("assistant:block afterward=done");
    expect(first.compacted.summary?.id).toBe("s1");
    expect(first.compacted.items.map((item) => `${item.kind}:${item.timestampMs}`)).toEqual([
      "rc:3000",
    ]);
  });
});
