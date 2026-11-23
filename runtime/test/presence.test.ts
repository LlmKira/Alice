import { describe, expect, it } from "vitest";
import { presence } from "../src/mechanisms/presence.js";
import type { ChatType } from "../src/mind/events.js";
import { type ChatState, emptyChat, type TimelineEntry } from "../src/mind/state.js";

let n = 0;
const line = (who: string | null, contentType = "text"): TimelineEntry => ({
  at: ++n,
  messageId: String(n),
  sender: who ? { id: `u-${who}`, name: who } : null,
  text: contentType === "text" ? `第 ${n} 句` : null,
  contentType,
  replyToMessageId: null,
});
const her = () => line(null);
const chat = (timeline: TimelineEntry[], chatType: ChatType = "group"): ChatState => ({
  ...emptyChat("telegram:1", chatType, true),
  timeline,
});
const fact = (timeline: TimelineEntry[], chatType?: ChatType) =>
  presence.contribute?.(chat(timeline, chatType), 0, undefined, []);

describe("how many of the last lines are hers, stated as a fact", () => {
  it("counts only her trailing run, not her earlier lines", () => {
    expect(fact([her(), her(), her(), line("阿杰"), her(), her(), her()])).toEqual([
      { mechanism: "presence", kind: "turn", text: "聊天记录最后连着 3 条都是你发的。" },
    ]);
  });

  it("says nothing once someone else speaks after her", () => {
    expect(fact([her(), her(), her(), her(), line("阿杰")])).toEqual([]);
  });

  it("says nothing for a single line of hers or an empty chat", () => {
    expect(fact([line("阿杰"), her()])).toEqual([]);
    expect(fact([])).toEqual([]);
  });

  it("counts stickers and photos she sent as lines too", () => {
    expect(fact([line("阿杰"), her(), line(null, "sticker")])?.[0]?.text).toBe(
      "聊天记录最后连着 2 条都是你发的。",
    );
  });

  it("adds that only she has been talking from four on, as a fact and never an instruction", () => {
    const text = fact([line("阿杰"), her(), her(), her(), her(), her()])?.[0]?.text;
    expect(text).toBe("聊天记录最后连着 5 条都是你发的，这一阵只有你在说。");
    expect(text).not.toMatch(/STOP|别|不要|等/);
  });

  it("says the same in a private chat as in a group (February extended it to private chats)", () => {
    const timeline = [line("小周"), her(), her()];
    expect(fact(timeline, "private")).toEqual(fact(timeline, "group"));
  });
});
