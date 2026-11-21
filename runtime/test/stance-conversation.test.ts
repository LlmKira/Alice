/**
 * 生产的内心独白读回（记忆流第 1 片，docs/research/memory-stream.md）：她写下的想法读回到这段对话结束，
 * 不按 10 分钟，每个会话都开。群里的界线是 dwell（她开口后的那段会话），私聊里是"更早的聊天"分段的 10 分钟。
 * 对照是 inner（每个会话都开、读回 10 分钟）。
 */
import { describe, expect, it } from "vitest";
import { mechanisms } from "../src/mechanisms/registry.js";
import type { AliceEvent, MessageReceived } from "../src/mind/events.js";
import type { Mechanism } from "../src/mind/mechanism.js";
import { type ChatState, emptyState } from "../src/mind/state.js";
import { speechRequest, step } from "../src/mind/step.js";
import { arms } from "../src/sim/will-arms.js";
import { renderSpeechPrompt } from "../src/speech/prompt.js";

const MIN = 60_000;
const T = Date.UTC(2026, 10, 10, 7, 0);
const DM = "telegram:1";
const GROUP = "telegram:-5";
const candidate = mechanisms;
const window = arms({}).inner as readonly Mechanism[];

let n = 0;
function msg(at: number, scope: string, sender = "u1"): MessageReceived {
  n++;
  return {
    type: "message.received",
    at,
    scope,
    chatType: scope.startsWith("telegram:-") ? "group" : "private",
    messageId: `m${n}`,
    senderId: sender,
    senderName: sender === "u1" ? "小满" : `路人${sender}`,
    text: "嗯嗯",
    contentType: "text",
    replyToMessageId: null,
    directed: !scope.startsWith("telegram:-"),
  };
}
const think = (at: number, scope: string, thought: string): AliceEvent => ({
  type: "act.done",
  at,
  scope,
  act: { kind: "think", thought },
});
const said = (at: number, scope: string): AliceEvent => ({
  type: "message.sent",
  at,
  scope,
  messageId: `s${++n}`,
  text: "我觉得不对",
  kind: "text",
});

function card(events: AliceEvent[], scope: string, at: number, mechanisms: readonly Mechanism[]) {
  const state = events.reduce((s, e) => step(s, e, mechanisms).state, emptyState);
  const request = speechRequest(state, state.chats[scope] as ChatState, at, null, mechanisms);
  return renderSpeechPrompt("PERSONA", request).user;
}

describe("stance readback for the length of the conversation", () => {
  it("group: still read back 25 minutes later while she is in the conversation, gone once it passes her by", () => {
    const events: AliceEvent[] = [
      msg(T, GROUP, "u2"),
      think(T + MIN, GROUP, "这个说法不对，我得站出来"),
      said(T + MIN, GROUP),
      msg(T + 8 * MIN, GROUP, "u2"),
      msg(T + 16 * MIN, GROUP, "u3"),
      msg(T + 24 * MIN, GROUP, "u2"),
    ];
    const at = T + 25 * MIN;
    expect(card(events, GROUP, at, candidate)).toContain("想过：这个说法不对，我得站出来");
    // 对照：10 分钟的窗口早过了。
    expect(card(events, GROUP, at, window)).not.toContain("想过：");
    // 她开口之后别人又说了 K 条以上：这段对话从她身边过去了。
    const passed = [...events];
    for (let i = 0; i < 12; i++) passed.push(msg(T + 24 * MIN + (i + 1) * 10_000, GROUP, "u2"));
    expect(card(passed, GROUP, T + 27 * MIN, candidate)).not.toContain("想过：");
  });

  it("group: a thought she had while only watching (no conversation of hers) is not read back", () => {
    const events: AliceEvent[] = [
      msg(T, GROUP, "u2"),
      think(T + MIN, GROUP, "先看看"),
      msg(T + 3 * MIN, GROUP, "u3"),
    ];
    expect(card(events, GROUP, T + 4 * MIN, candidate)).not.toContain("想过：");
  });

  it("private: read back while no gap reaches 10 minutes, gone after the conversation went quiet", () => {
    const events: AliceEvent[] = [
      msg(T, DM),
      think(T + MIN, DM, "其实我只是想要一点尊重"),
      said(T + MIN, DM),
      msg(T + 9 * MIN, DM),
      msg(T + 18 * MIN, DM),
    ];
    expect(card(events, DM, T + 19 * MIN, candidate)).toContain("想过：其实我只是想要一点尊重");
    expect(card(events, DM, T + 19 * MIN, window)).not.toContain("想过：");
    const quiet = [...events, msg(T + 40 * MIN, DM)];
    expect(card(quiet, DM, T + 41 * MIN, candidate)).not.toContain("想过：");
  });

  it("keeps the newest three per chat, and only this chat's", () => {
    const events: AliceEvent[] = [msg(T, DM), said(T, DM), msg(T, "telegram:2")];
    for (let i = 0; i < 4; i++) events.push(think(T + (i + 1) * MIN, DM, `想${i}`));
    events.push(think(T + 2 * MIN, "telegram:2", "别处想的"));
    const user = card(events, DM, T + 6 * MIN, candidate);
    expect(user).toContain("想过：想3");
    expect(user).toContain("想过：想1");
    expect(user).not.toContain("想过：想0");
    // 别处想的不算这里的读回；PLAN 第 33 件起没标私密的作为带过来的想法出现，注明在哪想的。
    expect(user).toMatch(/私聊时想过：别处想的/);
  });
});
