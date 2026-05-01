import { describe, expect, it } from "vitest";
import {
  mergedTimelineToText,
  mergeRenderedContextAndTurns,
  type TurnResponseRecord,
} from "../src/projection/merge/rc-tr-merge.js";
import type { RenderedContextSegment } from "../src/projection/rendering/rendered-context.js";

const rc: RenderedContextSegment[] = [
  {
    receivedAtMs: 1000,
    channelId: "channel:1",
    text: '<message tick="1">hello</message>',
    directed: true,
    senderIsBot: false,
  },
  {
    receivedAtMs: 2000,
    channelId: "channel:1",
    text: '<message tick="2">follow-up</message>',
    directed: false,
    senderIsBot: false,
  },
];

const trs: TurnResponseRecord[] = [
  {
    requestedAtMs: 2000,
    actionLogId: 7,
    entries: [{ role: "assistant", text: "I saw that." }],
  },
  {
    requestedAtMs: 1500,
    entries: [
      { role: "assistant", text: "Thinking" },
      { role: "tool", text: "sent" },
    ],
  },
];

describe("RC/TR merge", () => {
  it("orders by unified timestamp with RC before TR on ties", () => {
    const merged = mergeRenderedContextAndTurns(rc, trs);
    expect(merged.map((item) => `${item.kind}:${item.timestampMs}`)).toEqual([
      "rc:1000",
      "tr:1500",
      "rc:2000",
      "tr:2000",
    ]);
  });

  it("renders a provider-neutral merged timeline", () => {
    const merged = mergeRenderedContextAndTurns(rc, trs);
    expect(mergedTimelineToText(merged)).toBe([
      'user:<message tick="1">hello</message>',
      "assistant:Thinking\ntool:sent",
      'user:<message tick="2">follow-up</message>',
      "assistant:I saw that.",
    ].join("\n"));
  });
  it("renders block result and host restatement entries", () => {
    const merged = mergeRenderedContextAndTurns([], [
      {
        requestedAtMs: 3000,
        actionLogId: 8,
        entries: [
          { kind: "block", script: "send_message('hi')", afterward: "done" },
          { kind: "tool_result", name: "send_message", output: "msgId=10", ok: true },
          {
            kind: "host_restatement",
            summary: "block completed",
            observations: ["message sent"],
            completedActions: ["sent:chatId=channel:1:msgId=10"],
            errors: [],
          },
        ],
      },
    ]);

    expect(mergedTimelineToText(merged)).toBe([
      "assistant:block afterward=done\nsend_message('hi')",
      "tool:send_message ok=true\nmsgId=10",
      'system:host block completed observations=["message sent"] completed=["sent:chatId=channel:1:msgId=10"]',
    ].join("\n"));
  });

});
