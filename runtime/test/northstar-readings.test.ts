/**
 * 北极星新加的四个读数，各用一份虚构的 Journal：回来的人、私聊里连着不回、群里接她的话、她一天的总轮数。
 */
import { describe, expect, it } from "vitest";
import type { AliceEvent, MessageReceived } from "../src/mind/events.js";
import { type DayRow, northstar } from "../src/northstar.js";

/** 2026-02-17 10:00（东八区）。 */
const T0 = Date.UTC(2026, 1, 17, 2, 0, 0);
const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const D = 24 * H;

const GROUP = "telegram:-50";
const dm = (id: string) => `telegram:${id}`;

let n = 0;
function got(at: number, scope: string, senderId: string, more: Partial<MessageReceived> = {}) {
  const group = scope.startsWith("telegram:-");
  const event: MessageReceived = {
    type: "message.received",
    at,
    scope,
    chatType: group ? "group" : "private",
    messageId: `m${n++}`,
    senderId,
    senderName: senderId,
    text: "……",
    contentType: "text",
    replyToMessageId: null,
    directed: !group,
    ...more,
  };
  return event;
}

const said = (
  at: number,
  scope: string,
  messageId = `s${n++}`,
  kind: "text" | "sticker" = "text",
): AliceEvent => ({ type: "message.sent", at, scope, messageId, text: messageId, kind });

const decided = (at: number, scope: string, text: string, replyTo: string): AliceEvent => ({
  type: "speech.decided",
  at,
  scope,
  callId: `c${n++}`,
  decision: { acts: [{ kind: "send", text, replyTo }] },
});

const dayOf = (days: DayRow[], offset: number) =>
  days.find((d) => d.day === new Date(T0 + 8 * H + offset * D).toISOString().slice(0, 10));

describe("回来的人：第一次来往后第 1 到第 7 天又主动找她", () => {
  const reply = got(T0 + 30 * MIN, GROUP, "u2", { replyToMessageId: "g1" });
  const journal: AliceEvent[] = [
    // u1 私聊找她，她回；第 3 天 u1 又来（主动）：回来了。
    got(T0, dm("u1"), "u1"),
    said(T0 + MIN, dm("u1")),
    // 她在群里说话，u2 回复她：u2 第一次来往。只在群里说话、不冲着她的 u4 不算来往过。
    got(T0 + 10 * MIN, GROUP, "u4"),
    said(T0 + 20 * MIN, GROUP, "g1"),
    reply,
    // u3 当天隔 4 小时又来：同一天的不算回来。
    got(T0 + H, dm("u3"), "u3"),
    got(T0 + 5 * H, dm("u3"), "u3"),
    // u6 第 8 天才回来：过了窗口。
    got(T0 + 2 * H, dm("u6"), "u6"),
    // 第 2 天 u2 回复她的话：是回复，不是主动找她。
    said(T0 + 2 * D, GROUP, "g2"),
    got(T0 + 2 * D + MIN, GROUP, "u2", { replyToMessageId: "g2" }),
    got(T0 + 3 * D, dm("u1"), "u1"),
    got(T0 + 8 * D, dm("u6"), "u6"),
    // 第 9 天 u5 第一次来：7 天还没过完，这一天待定。
    got(T0 + 9 * D, dm("u5"), "u5"),
  ];
  const { days } = northstar(journal);

  it("counts the share of first-day people who came to her again on a later day within 7 days", () => {
    expect(dayOf(days, 0)).toMatchObject({ newPeople: 4, returned: 1, returnPending: false });
  });

  it("a day whose 7-day window has not run out is pending", () => {
    expect(dayOf(days, 9)).toMatchObject({ newPeople: 1, returned: 0, returnPending: true });
  });
});

describe("私聊里连着不回：她带着话头去找，对方连着两次没回", () => {
  const journal: AliceEvent[] = [
    // u1：两次都是自然聊完（她说最后一句，对方不回）。旧口径算两次，新口径一次也不算。
    got(T0, dm("u1"), "u1"),
    said(T0 + MIN, dm("u1")),
    got(T0 + D, dm("u1"), "u1"),
    said(T0 + D + MIN, dm("u1")),
    // u2：第 1 天、第 2 天她都隔了很久先开口，对方都没回：记在第 2 天。
    got(T0, dm("u2"), "u2"),
    said(T0 + MIN, dm("u2")),
    got(T0 + 2 * MIN, dm("u2"), "u2"),
    said(T0 + D, dm("u2")),
    said(T0 + 2 * D, dm("u2")),
    // u3：没回一次，然后对方来了，再没回一次：中间断了，不算连着。
    said(T0 + D, dm("u3")),
    got(T0 + 2 * D, dm("u3"), "u3"),
    said(T0 + 3 * D, dm("u3")),
    // u4：两次只发了贴纸，没带话头。
    said(T0 + D, dm("u4"), "k1", "sticker"),
    said(T0 + 2 * D, dm("u4"), "k2", "sticker"),
    // u5：对方问了话，她 3 小时后才回（晚回对方的话，不是去找）；第 2 天她再去找，对方没回：只连着一次。
    got(T0 + D, dm("u5"), "u5"),
    said(T0 + D + 3 * H, dm("u5")),
    said(T0 + 2 * D + 3 * H, dm("u5")),
    // u6：最后一天她去找，窗口还没过完：待定。
    said(T0 + 4 * D, dm("u6")),
    got(T0 + 4 * D + H, GROUP, "x"),
  ];
  const { days } = northstar(journal);

  it("counts a person once their second approach in a row goes unanswered", () => {
    expect(dayOf(days, 2)).toMatchObject({ dmIgnored: 1 });
    expect(days.reduce((sum, d) => sum + d.dmIgnored, 0)).toBe(1);
  });

  it("a natural end of a chat is not rejection (the old count, kept for one release, counts it)", () => {
    expect(dayOf(days, 0)).toMatchObject({ dmIgnored: 0, dmUnanswered: 1 });
  });

  it("an approach whose window has not run out is pending", () => {
    expect(dayOf(days, 4)).toMatchObject({ dmIgnored: 0, dmApproachPending: 1 });
  });
});

describe("群里接她的话：她说完一轮，10 分钟内接着说的人数和轮数", () => {
  const at = (s: number) => T0 + s * S;
  const a1 = got(at(10), GROUP, "a");
  const c2 = got(at(15), GROUP, "c");
  const a2 = got(at(40), GROUP, "a");
  const journal: AliceEvent[] = [
    got(at(0), GROUP, "c"),
    a1,
    c2,
    // 她引用回复 a1（紧挨着的上一条是 c 的）。
    decided(at(20), GROUP, "h1", a1.messageId),
    said(at(25), GROUP, "h1"),
    // a 不点回复接着说（接在自己上一句上）；b 点回复回她；d 回复 a 的这一句。
    a2,
    got(at(50), GROUP, "b", { replyToMessageId: "h1" }),
    // c 接着自己那条线说：不是在接她。
    got(at(60), GROUP, "c"),
    got(at(70), GROUP, "d", { replyToMessageId: a2.messageId }),
    // e 15 分钟后才回复她：过了窗口。
    got(at(15 * 60), GROUP, "e", { replyToMessageId: "h1" }),
  ];

  it("counts people and turns that continue her line, with or without the reply button", () => {
    const [day] = northstar(journal).days;
    expect(day).toMatchObject({ groupTurns: 1, uptakePeople: 3, uptakeTurns: 3 });
  });

  it("reads the active humans in the same group the same way, as the band", () => {
    // x 和 y 不点回复你一句我一句，每一轮都被对方下一句接住（y 的最后一轮没人接）；其余 6 人各说一句。
    const talk: AliceEvent[] = ["x", "y", "x", "y", "x", "y"].map((p, i) =>
      got(at(30 * i), GROUP, p),
    );
    const others = ["o1", "o2", "o3", "o4", "o5", "o6"].map((p, i) =>
      got(at(1000 + 300 * i), GROUP, p),
    );
    const [day] = northstar([...talk, ...others]).days;
    expect(day?.bandPeople).toEqual({ p25: 0.67, p75: 1 });
    expect(day).toMatchObject({ groupTurns: 0, uptakePeople: null });
  });
});

describe("她一天的总轮数，和跨会话真人里最多的那个", () => {
  const at = (m: number) => T0 + m * MIN;
  const base: AliceEvent[] = [
    // 群里：她连着两句是一轮，别人插话后再说是第二轮。
    said(at(0), GROUP),
    said(at(0.5), GROUP),
    got(at(1), GROUP, "p1"),
    got(at(2), GROUP, "p2"),
    got(at(3), GROUP, "p3"),
    got(at(4), GROUP, "p4"),
    said(at(5), GROUP),
    // q 只在群里，说了很多轮：不是跨会话的人。
    ...[10, 20, 30, 40, 50, 60].flatMap((m) => [
      got(at(m), GROUP, "q"),
      got(at(m + 1), GROUP, "p2"),
    ]),
    // 私聊：p1 两轮，她两轮。
    got(at(100), dm("p1"), "p1"),
    said(at(101), dm("p1")),
    got(at(102), dm("p1"), "p1"),
    said(at(110), dm("p1")),
    got(at(120), dm("p2"), "p2"),
    got(at(130), dm("p3"), "p3"),
  ];

  it("sums her turns across every chat and compares with the busiest cross-chat human", () => {
    const [day] = northstar([...base, got(at(140), dm("p4"), "p4")]).days;
    // p2：群里 1 + 6 轮（每次 q 插话后）+ 私聊 1 轮 = 8。
    expect(day).toMatchObject({ herTurns: 4, crossChatPeople: 4, crossChatTop: 8 });
  });

  it("gives no human comparison when fewer than four people are in several of her chats", () => {
    const [day] = northstar(base).days;
    expect(day).toMatchObject({ herTurns: 4, crossChatPeople: 3, crossChatTop: null });
  });
});
