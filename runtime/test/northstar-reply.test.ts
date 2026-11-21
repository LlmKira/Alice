/**
 * 北极星的"别人主动找她"按心智同一个判断读"冲着她"：回复她的那条在 Journal 里可能是 directed: false
 * （线上群里回复她的 70 条有 69 条是这样，eval-artifacts/footprint/）。那也是他来找她了，几分钟后再点名不算又一次主动。
 */
import { describe, expect, it } from "vitest";
import type { AliceEvent, MessageReceived } from "../src/mind/events.js";
import { northstar } from "../src/northstar.js";

/** 2026-02-17 10:00（东八区）。 */
const T0 = Date.UTC(2026, 1, 17, 2, 0, 0);
const MIN = 60_000;
const GROUP = "telegram:-50";

const got = (at: number, more: Partial<MessageReceived>): MessageReceived => ({
  type: "message.received",
  at,
  scope: GROUP,
  chatType: "group",
  messageId: `m${at}`,
  senderId: "u2",
  senderName: "u2",
  text: "……",
  contentType: "text",
  replyToMessageId: null,
  directed: false,
  ...more,
});

/** 她说了一句；70 分钟后 u2 回复她那一句；再过 5 分钟 u2 点名她。 */
function journal(replyDirected: boolean): AliceEvent[] {
  return [
    got(T0 - 5 * MIN, { senderId: "u1", senderName: "u1" }),
    { type: "message.sent", at: T0, scope: GROUP, messageId: "s1", text: "嗯", kind: "text" },
    got(T0 + 70 * MIN, { replyToMessageId: "s1", directed: replyDirected }),
    got(T0 + 75 * MIN, { directed: true }),
  ];
}

describe("北极星：回复她就是来找她", () => {
  it("对照：回复标着 directed 时，紧接着的点名不算又一次主动", () => {
    const [day] = northstar(journal(true)).days;
    expect(day).toMatchObject({ initiations: 0, repliers: 1 });
  });

  it("回复没标 directed（线上 Journal 的样子）：结果一样", () => {
    const [day] = northstar(journal(false)).days;
    expect(day).toMatchObject({ initiations: 0, repliers: 1 });
  });
});
