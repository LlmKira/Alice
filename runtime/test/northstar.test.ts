import { describe, expect, it } from "vitest";
import type { AliceEvent, MessageReceived } from "../src/mind/events.js";
import { northstar } from "../src/northstar.js";

/** 2026-02-17 10:00（东八区）。 */
const T0 = Date.UTC(2026, 1, 17, 2, 0, 0);
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;

const DM1 = "telegram:1";
const GROUP = "telegram:-50";

function got(at: number, scope: string, senderId: string, more: Partial<MessageReceived> = {}) {
  const event: MessageReceived = {
    type: "message.received",
    at,
    scope,
    chatType: scope.startsWith("telegram:-") ? "group" : "private",
    messageId: `m${at}`,
    senderId,
    senderName: senderId,
    text: "……",
    contentType: "text",
    replyToMessageId: null,
    directed: !scope.startsWith("telegram:-"),
    ...more,
  };
  return event;
}

const said = (at: number, scope: string, messageId: string): AliceEvent => ({
  type: "message.sent",
  at,
  scope,
  messageId,
  text: "嗯",
  kind: "text",
});

describe("north star readings", () => {
  const journal: AliceEvent[] = [
    // 第一天：私聊里 u1 先来找她，她回，对方接着说。
    got(T0, DM1, "u1"),
    said(T0 + MIN, DM1, "s1"),
    got(T0 + 2 * MIN, DM1, "u1"),
    // 群里 u2 点名她（主动），5 分钟后再点一次（同一段，不算第二次）。
    got(T0 + 10 * MIN, GROUP, "u2", { directed: true }),
    said(T0 + 11 * MIN, GROUP, "s2"),
    got(T0 + 12 * MIN, GROUP, "u3", { directed: true, replyToMessageId: "s2" }),
    got(T0 + 15 * MIN, GROUP, "u2", { directed: true }),
    {
      type: "reaction.received",
      at: T0 + 13 * MIN,
      scope: GROUP,
      messageId: "s2",
      senderId: "u4",
      emoji: "👍",
    },
    {
      type: "reaction.received",
      at: T0 + 13 * MIN,
      scope: GROUP,
      messageId: "s2",
      senderId: "u5",
      emoji: "👎",
    },
    // 群里别人之间的闲聊，以及点在别人消息上的表情：都不是冲她来的。
    got(T0 + 16 * MIN, GROUP, "u3"),
    {
      type: "reaction.received",
      at: T0 + 17 * MIN,
      scope: GROUP,
      messageId: "m1",
      senderId: "u4",
      emoji: "❤",
    },
    // 操作员的话不计。
    got(T0 + 20 * MIN, "telegram:900", "900"),
    // 她主动私聊 u6，对方一直没回。
    said(T0 + 10 * H, "telegram:6", "s3"),
    // 发给 u7 被拒（拉黑）；被踢出另一个群。
    {
      type: "act.failed",
      at: T0 + 11 * H,
      scope: "telegram:7",
      act: { kind: "send", text: "在吗", replyTo: null },
      reason: "refused",
    },
    {
      type: "membership.changed",
      at: T0 + 11 * H,
      scope: "telegram:-60",
      member: false,
      reason: "kicked",
    },
    // 第二天：u1 隔了一天又来（主动）；她说完 3 小时后 u1 才回（晚到的回复，不是主动）。
    got(T0 + D + 2 * H, DM1, "u1"),
    said(T0 + D + 3 * H, DM1, "s4"),
    got(T0 + D + 6 * H, DM1, "u1"),
    { type: "speech.failed", at: T0 + D + 7 * H, scope: DM1, callId: "c", reason: "paused" },
    // 第十天：日志延到这里，u1（两天里说过话）满 7 天没出现。
    got(T0 + 10 * D, "telegram:8", "u8"),
  ];
  const { days, stopCandidates } = northstar(journal, { exclude: new Set(["900"]) });
  const day = (offset: number) =>
    days.find((d) => d.day === new Date(T0 + 8 * H + offset * D).toISOString().slice(0, 10));

  it("counts who came to her first after a quiet spell, not replies to her", () => {
    expect(day(0)).toMatchObject({ initiations: 2, initiators: 2 });
    expect(day(1)).toMatchObject({ initiations: 1, initiators: 1 });
  });

  it("counts the breadth of warm responses by distinct people", () => {
    // u1 接她的话、u3 回复她、u4 点了 👍（点在别人消息上的不算）。
    expect(day(0)).toMatchObject({ repliers: 2, positiveReactors: 1, warmPeople: 3 });
    expect(day(1)).toMatchObject({ repliers: 1 });
  });

  it("counts typed signs of being unwanted", () => {
    expect(day(0)).toMatchObject({
      refusedChats: 1,
      kickedChats: 1,
      negativeReactors: 1,
      dmUnanswered: 1,
      dmUnansweredPeople: 1,
      inbound: 6,
    });
    expect(day(1)).toMatchObject({ dmUnanswered: 0, pausedCalls: 1 });
    // u1 最后一次出现在第二天，第九天满 7 天；u2、u3 只在一天里说过话。
    expect(day(8)).toMatchObject({ lapsedPeople: 1 });
  });

  it("an unanswered private chat whose window has not run out is pending, not counted", () => {
    const { days: open } = northstar([
      said(T0, "telegram:6", "s1"),
      got(T0 + H, "telegram:9", "u9"),
    ]);
    expect(open[0]).toMatchObject({ dmUnanswered: 0, dmPending: 1 });
  });

  it("exports what follows her words for an offline yes/no judgement, without judging it", () => {
    expect(stopCandidates.map((c) => c.senderId)).toEqual(["u1", "u3", "u1"]);
    expect(stopCandidates[0]?.question).toContain("只答");
    expect(stopCandidates[0]?.her).toEqual(["嗯"]);
  });
});
