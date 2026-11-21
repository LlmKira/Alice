import { describe, expect, it } from "vitest";
import { type ClosenessState, closeness, reduceCloseness } from "../src/mechanisms/closeness.js";
import type { AliceEvent } from "../src/mind/events.js";
import { type ChatState, emptyChat } from "../src/mind/state.js";

const DAY = 24 * 60 * 60_000;
const T0 = 1_771_000_000_000;
const DM = "telegram:1";

const fromThem = (at: number): AliceEvent => ({
  type: "message.received",
  at,
  scope: DM,
  chatType: "private",
  messageId: String(at),
  senderId: "u1",
  senderName: "池塘",
  text: "在吗",
  contentType: "text",
  replyToMessageId: null,
  directed: true,
});
const fromHer = (at: number): AliceEvent => ({
  type: "message.sent",
  at,
  scope: DM,
  messageId: `s${at}`,
  text: "在干嘛",
  kind: "text",
});

function factAt(events: AliceEvent[], now: number): string {
  const state = events.reduce(reduceCloseness, { people: {}, partners: {} } as ClosenessState);
  const chat: ChatState = {
    ...emptyChat(DM, "private", true),
    timeline: [
      {
        at: now,
        messageId: "x",
        sender: { id: "u1", name: "池塘" },
        text: "嗨",
        contentType: "text",
        replyToMessageId: null,
      },
    ],
  };
  return closeness.contribute?.(chat, now, state, [])[0]?.text ?? "";
}

describe("closeness also says how long they have known each other and who seeks whom", () => {
  it("says nothing extra for a new acquaintance with few exchanges", () => {
    expect(factAt([fromThem(T0), fromThem(T0 + DAY)], T0 + 2 * DAY)).toBe(
      "我和在场的人：\n池塘：很亲近，我们几乎天天聊",
    );
  });

  it("after two months of them reaching out, says so", () => {
    const events = [0, 7, 14, 30, 45, 60].map((d) => fromThem(T0 + d * DAY));
    expect(factAt(events, T0 + 61 * DAY)).toContain("认识 2 个月了，多是对方先找我");
  });

  it("when it is mostly her opening the conversation, says that instead", () => {
    const events = [fromThem(T0), ...[3, 6, 9, 12, 15].map((d) => fromHer(T0 + d * DAY))];
    expect(factAt(events, T0 + 16 * DAY)).toContain("认识 2 周了，多是我先找对方");
  });
});
