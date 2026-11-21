/**
 * 日记说过就过去了（2026-11-12 进生产，eval-artifacts/rehash/prereg-3.md）：在写下它的会话里，她在那里又开过口之后，
 * 这条日记不再出现在卡片上；同一件事写了几条也一样，每条只留到她下一次开口。别的会话（当时在场的人的私聊）照旧带着。
 * 只改卡片的显示：存下的日记、反思时给她看的日记都不变。
 */
import { describe, expect, it } from "vitest";
import { REFLECT } from "../src/mechanisms/pressure/params.js";
import { mechanisms } from "../src/mechanisms/registry.js";
import type { AliceEvent, MessageReceived } from "../src/mind/events.js";
import { type AliceState, type ChatState, emptyState, TIMELINE_LIMIT } from "../src/mind/state.js";
import { speechRequest, step } from "../src/mind/step.js";
import { renderSpeechPrompt } from "../src/speech/prompt.js";
import { renderReflectPrompt } from "../src/speech/reflect.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T = Date.UTC(2026, 10, 10, 7, 0);
const GROUP = "telegram:-5";
const DM = "telegram:1";

let n = 0;
const msg = (at: number, scope: string, text: string, directed = false): MessageReceived => ({
  type: "message.received",
  at,
  scope,
  chatType: scope === DM ? "private" : "group",
  messageId: `m${++n}`,
  senderId: "u1",
  senderName: "莉莉丝",
  text,
  contentType: "text",
  replyToMessageId: null,
  directed: directed || scope === DM,
});
const sent = (at: number, scope: string, text: string): AliceEvent => ({
  type: "message.sent",
  at,
  scope,
  messageId: `s${++n}`,
  text,
  kind: "text",
});
const wrote = (at: number, text: string): AliceEvent => ({
  type: "ponder.done",
  at,
  scope: "self",
  callId: `self~reflect@${at}`,
  ponder: { kind: "reflect", scope: GROUP, entries: [{ about: null, text, importance: 5 }] },
});
/** 一整屏的群聊：把更早的对话挤出时间线。 */
const scrolled = (at: number) =>
  Array.from({ length: TIMELINE_LIMIT }, (_, k) => msg(at + k * 1000, GROUP, `闲聊${k}`));

/** 同一件事，三段对话里各写了一条（换了说法，两字片段几乎不重合），每段里她都说过话。 */
const NEWS = [
  "群里在转老板辞职的消息 我也吓一跳",
  "那条大新闻大家聊了一晚上",
  "董事会那个八卦居然还在刷屏",
];
const threeEntries: AliceEvent[] = NEWS.flatMap((text, k) => {
  const at = T + k * HOUR;
  return [
    msg(at, GROUP, "Alice 你看到没", true),
    sent(at + 10_000, GROUP, "看到了 好突然"),
    wrote(at + 10_000 + REFLECT.quiet, text),
  ];
});

function run(events: AliceEvent[]): AliceState {
  let state: AliceState = emptyState;
  for (const e of events) state = step(state, e, mechanisms).state;
  return state;
}
const cardAt = (events: AliceEvent[], scope: string, at: number) => {
  const state = run(events);
  const request = speechRequest(state, state.chats[scope] as ChatState, at, null, mechanisms);
  return renderSpeechPrompt("PERSONA", request).user.split("\n\n")[0] ?? "";
};
const later = T + 4 * HOUR;

describe("a diary entry she has already had her say about stops pulling in that chat", () => {
  it("one event in three entries, and she has spoken in the group since: the group card no longer carries it", () => {
    const events = [...threeEntries, sent(later - 2 * MIN, GROUP, "我回来啦"), ...scrolled(later)];
    const card = cardAt(events, GROUP, later + 2 * MIN);
    for (const text of NEWS) expect(card).not.toContain(text);
  });

  it("an entry still pulls in its own chat until she speaks there", () => {
    // 第一段：她说过话之后才写下的那一条。
    const events = [...threeEntries.slice(0, 3), ...scrolled(T + HOUR)];
    expect(cardAt(events, GROUP, T + HOUR + 2 * MIN)).toContain(NEWS[0]);
    const spoke = [...events, sent(T + HOUR + MIN, GROUP, "嗯嗯")];
    expect(cardAt(spoke, GROUP, T + HOUR + 2 * MIN)).not.toContain(NEWS[0]);
  });

  it("another chat still carries it: a private chat with someone who was there", () => {
    const events = [
      ...threeEntries,
      sent(later - 2 * MIN, GROUP, "我回来啦"),
      msg(later, DM, "在吗"),
    ];
    expect(cardAt(events, DM, later + MIN)).toContain(NEWS[2]);
  });

  it("the diary keeps all three, and reflecting in the group she still sees what she wrote", () => {
    const events = [...threeEntries, sent(later - 2 * MIN, GROUP, "我回来啦"), ...scrolled(later)];
    const world = Object.values(run(events).mechanisms).find(
      (m) => m !== null && typeof m === "object" && "diary" in (m as object),
    ) as { diary: Array<{ text: string }> };
    expect(world.diary.map((e) => e.text)).toEqual(NEWS);
    let state: AliceState = emptyState;
    const asks: string[] = [];
    for (const e of [
      ...events,
      msg(later + MIN, GROUP, "Alice", true),
      sent(later + 2 * MIN, GROUP, "在"),
      msg(later + 3 * MIN, GROUP, "Alice 再看", true),
      sent(later + 4 * MIN, GROUP, "好"),
      { type: "clock.tick", at: later + 4 * MIN + REFLECT.quiet } as AliceEvent,
    ]) {
      const r = step(state, e, mechanisms);
      state = r.state;
      for (const f of r.effects) {
        if (f.type === "call-ponder" && f.request.kind === "reflect") {
          asks.push(renderReflectPrompt("PERSONA", f.request).user);
        }
      }
    }
    expect(asks).toHaveLength(1);
    for (const text of NEWS) expect(asks[0]).toContain(text);
  });
});
