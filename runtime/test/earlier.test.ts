import { describe, expect, it } from "vitest";
import type { AliceEvent } from "../src/mind/events.js";
import { type AliceState, emptyState, SEGMENTS_KEPT, TIMELINE_LIMIT } from "../src/mind/state.js";
import { speechRequest, step } from "../src/mind/step.js";
import { renderSpeechPrompt } from "../src/speech/prompt.js";

const MIN = 60_000;
const T0 = Date.parse("2026-11-06T21:00:00+08:00");
const DM = "telegram:1";
let n = 0;
const said = (at: number, text: string): AliceEvent => ({
  type: "message.received",
  at,
  scope: DM,
  chatType: "private",
  messageId: String(++n),
  senderId: "u1",
  senderName: "池塘",
  text,
  contentType: "text",
  replyToMessageId: null,
  directed: false,
});

function run(events: AliceEvent[]): AliceState {
  return events.reduce((s, e) => step(s, e, []).state, emptyState);
}

describe("earlier conversation that scrolled off the timeline", () => {
  it("keeps the timeline at its limit and folds what fell off into segments split by gaps", () => {
    const events: AliceEvent[] = [];
    // 第一段 5 条（间隔 1 分钟），隔 2 小时，第二段 TIMELINE_LIMIT 条。
    for (let i = 0; i < 5; i++) events.push(said(T0 + i * MIN, `早先第${i}句`));
    for (let i = 0; i < TIMELINE_LIMIT + 3; i++)
      events.push(said(T0 + 2 * 60 * MIN + i * MIN, `后来第${i}句`));
    const chat = run(events).chats[DM];
    expect(chat?.timeline).toHaveLength(TIMELINE_LIMIT);
    expect(chat?.earlier?.map((s) => s.count)).toEqual([5, 3]);
    expect(chat?.earlier?.[0]?.first.text).toBe("早先第0句");
    expect(chat?.earlier?.[0]?.last.text).toBe("早先第4句");
  });

  it("renders each segment as one line with its time span, count, and first and last line, above the log", () => {
    const events: AliceEvent[] = [];
    for (let i = 0; i < 5; i++) events.push(said(T0 + i * MIN, `早先第${i}句`));
    for (let i = 0; i < TIMELINE_LIMIT; i++)
      events.push(said(T0 + 120 * MIN + i * MIN, `后来第${i}句`));
    const state = run(events);
    const chat = state.chats[DM];
    if (!chat) throw new Error("no chat");
    const user = renderSpeechPrompt("P", speechRequest(state, chat, T0 + 200 * MIN, null, [])).user;
    expect(user).toContain(
      "[更早的聊天 · 11月6日 周五 21:00–21:04，5 条：<池塘> 早先第0句 …… <池塘> 早先第4句]",
    );
    expect(user.indexOf("更早的聊天")).toBeLessThan(user.indexOf("<池塘> 后来第0句"));
  });

  it("keeps only the most recent few segments", () => {
    const events: AliceEvent[] = [];
    for (let s = 0; s < SEGMENTS_KEPT + 3; s++) events.push(said(T0 + s * 60 * MIN, `段${s}`));
    for (let i = 0; i < TIMELINE_LIMIT; i++) events.push(said(T0 + 1000 * MIN + i * MIN, "x"));
    const earlier = run(events).chats[DM]?.earlier ?? [];
    expect(earlier).toHaveLength(SEGMENTS_KEPT);
    expect(earlier.at(-1)?.first.text).toBe(`段${SEGMENTS_KEPT + 2}`);
  });
});
