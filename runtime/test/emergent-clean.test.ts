import { describe, expect, it } from "vitest";
import { createPressure, PRODUCTION } from "../src/mechanisms/pressure/index.js";
import { thought } from "../src/mechanisms/pressure/inner.js";
import { affordances } from "../src/mind/affordances.js";
import type { SpeechRequest } from "../src/mind/effects.js";
import { composeMind } from "../src/mind/mechanism.js";
import { createFold } from "../src/shell.js";
import { renderSpeechPrompt } from "../src/speech/prompt.js";

describe("emergent-clean-v1 theoretical properties", () => {
  it("Contextual Integrity: keepDmInDm prevents private-DM thoughts from leaking into public group cards", () => {
    const T0 = 1_772_400_000_000;
    const dm = "telegram:42";
    const group = "telegram:-1001";
    const p = createPressure(affordances, {
      ...PRODUCTION,
      thought: thought({ examples: false, carry: true, keepDmInDm: true }),
    });
    const mind = composeMind([p], []).mechanisms;
    const fold = createFold(mind);

    fold.feed({
      type: "message.received",
      at: T0,
      scope: dm,
      chatType: "private",
      messageId: "1",
      senderId: "42",
      senderName: "Влад",
      text: "刚才在防空洞里玩铁拳",
      contentType: "text",
      replyToMessageId: null,
      directed: true,
    });
    fold.feed({
      type: "act.done",
      at: T0 + 1_000,
      scope: dm,
      act: { kind: "think", thought: "他在防空洞里居然这么平静，好揪心" },
    });
    fold.feed({
      type: "message.received",
      at: T0 + 60_000,
      scope: group,
      chatType: "group",
      messageId: "2",
      senderId: "42",
      senderName: "Влад",
      text: "大家晚上好",
      contentType: "text",
      replyToMessageId: null,
      directed: false,
    });

    const state = fold.result().state;
    const chat = state.chats[group];
    if (!chat) throw new Error("missing group chat");
    const contributions =
      p.contribute?.(chat, T0 + 61_000, state.mechanisms[p.name], ["send"]) ?? [];
    const thoughtText = contributions
      .filter((c) => c.kind === "thought")
      .map((c) => c.text)
      .join("\n");
    expect(thoughtText).not.toContain("防空洞");
  });

  it("Cognitive Load & Prompt Honesty: concisePeople drops 34-char boilerplate and avoids contradicting diary/thought", () => {
    const req: SpeechRequest = {
      scope: "telegram:-1001",
      chatType: "group",
      timeline: [],
      contributions: [
        {
          mechanism: "pressure-diary",
          kind: "self",
          text: "- 2 小时前 和Влад私聊时：聊了 MGS2 原声带很开心",
        },
        {
          mechanism: "familiar",
          kind: "people",
          text: "",
          people: [
            { id: "42", name: "Влад", relation: "常聊，也是这个群里的朋友" },
            { id: "99", name: "路人甲", relation: "这个群里的朋友" },
          ],
        },
      ],
      triggerMessageId: null,
      at: 1_772_430_000_000,
      affordances: ["send"],
    };

    const clean = renderSpeechPrompt("你是 Alice。", req, {
      format: "native",
      concisePeople: true,
    });
    expect(clean.user).toContain("- Влад（常聊，也是这个群里的朋友）");
    expect(clean.user).not.toContain("手头没记着以前的具体往事");
    expect(clean.user).toContain("- 路人甲（这个群里的朋友；暂未记下往事）");
  });
});
