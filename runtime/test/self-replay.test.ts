import { describe, expect, it } from "vitest";
import type { AliceEvent } from "../src/mind/events.js";
import type { SpeechOracle } from "../src/sim/replay.js";
import { replayChat } from "../src/sim/self-replay.js";

const T0 = 1_771_000_000_000;
const received = (id: string, at: number, text: string): AliceEvent => ({
  type: "message.received",
  at,
  scope: "telegram:1",
  chatType: "private",
  messageId: id,
  senderId: "u",
  senderName: "池塘",
  text,
  contentType: "text",
  replyToMessageId: null,
  directed: true,
});
const sent = (id: string, at: number, text: string): AliceEvent => ({
  type: "message.sent",
  at,
  scope: "telegram:1",
  messageId: id,
  text,
  kind: "text",
});

const events = [
  received("1", T0, "在吗"),
  sent("a", T0 + 10_000, "原话一"),
  sent("b", T0 + 20_000, "原话一的续句"),
  received("2", T0 + 600_000, "然后呢"),
  sent("c", T0 + 610_000, "原话二"),
];

/** 生成的话里带上它看到的自己说过的最后一句，用来检查闭环里看见的是什么。 */
const echo: SpeechOracle = (request) => {
  const mine = request.timeline.filter((t) => t.sender === null).map((t) => t.text);
  return { acts: [{ kind: "send", text: `生成(${mine.at(-1) ?? "无"})`, replyTo: null }] };
};

describe("self-replay", () => {
  it("closed loop: later turns see her generated lines, not the originals", async () => {
    const lines = await replayChat(events, "closed", echo);
    const mine = lines.filter((l) => l.speaker === "Alice");
    expect(mine.map((l) => l.text)).toEqual(["生成(无)", "生成(生成(无))"]);
    expect(mine.every((l) => l.generated)).toBe(true);
  });

  it("open loop: originals stay in the timeline and generated lines are not fed back", async () => {
    const lines = await replayChat(events, "open", echo);
    const generated = lines.filter((l) => l.generated).map((l) => l.text);
    expect(generated).toEqual(["生成(原话一)", "生成(原话二)"]);
    expect(lines.filter((l) => l.speaker === "Alice" && !l.generated)).toHaveLength(3);
  });
});
