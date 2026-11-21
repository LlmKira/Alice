import { describe, expect, it } from "vitest";
import { pressureProduction } from "../src/mechanisms/pressure/index.js";
import type { AliceEvent } from "../src/mind/events.js";
import { type AliceState, emptyState } from "../src/mind/state.js";
import { speechRequest, step } from "../src/mind/step.js";
import { codeMode } from "../src/speech/decision.js";
import { renderSpeechPrompt } from "../src/speech/prompt.js";
import { program } from "./model-reply.js";

const T0 = Date.parse("2026-11-08T21:00:00+08:00");
const DM = "telegram:1";
const msg = (id: string, text: string): AliceEvent => ({
  type: "message.received",
  at: T0,
  scope: DM,
  chatType: "private",
  messageId: id,
  senderId: "u1",
  senderName: "阿杰",
  text,
  contentType: "text",
  replyToMessageId: null,
  directed: true,
});
const run = (events: AliceEvent[]): AliceState =>
  events.reduce((s, e) => step(s, e, [pressureProduction]).state, emptyState);

describe("letting something go: she says so herself, and that line carries a note", () => {
  it("she can write tools.let_go; it parses to a let-go of that message in this chat", () => {
    const state = run([msg("7", "你这人真没劲")]);
    const chat = state.chats[DM];
    if (!chat) throw new Error("no chat");
    const request = speechRequest(state, chat, T0 + 1, "7", [pressureProduction]);
    expect(request.affordances).toContain("let-go");
    const code = 'await tools.let_go({ messageId: "7" });\nawait tools.say({ text: "行吧" });';
    expect(codeMode.parse(program(code), request).decision.acts).toEqual([
      { kind: "let-go", messageId: "7" },
      { kind: "send", text: "行吧", replyTo: null },
    ]);
  });

  it("after it is done the line keeps its words and gets the note; a message no longer in view is left alone", () => {
    const done = (messageId: string): AliceEvent => ({
      type: "act.done",
      at: T0 + 2,
      scope: DM,
      act: { kind: "let-go", messageId },
    });
    const state = run([msg("7", "你这人真没劲"), msg("8", "开玩笑的"), done("7"), done("99")]);
    const chat = state.chats[DM];
    if (!chat) throw new Error("no chat");
    const user = renderSpeechPrompt("P", speechRequest(state, chat, T0 + 3, null, [])).user;
    expect(user).toContain("[7] <阿杰> 你这人真没劲  （你说过这事先不追究了）");
    expect(user).toMatch(/\[8\] <阿杰> 开玩笑的$/m);
  });
});
