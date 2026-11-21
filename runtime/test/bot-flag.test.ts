/**
 * Telegram 标着的机器人不是在场的人：只要有一条消息带着这个标记，就一直算机器人。
 * 较早的消息可能没有标记（适配器加上标记之前写的 Journal、补拉的旧消息）；以前 familiar 只在第一次见到这个人时
 * 读标记，于是一个机器人永远是"这个群里的朋友"，people 的"常说话的"也把它排在第一（eval-artifacts/footprint/）。
 */
import { describe, expect, it } from "vitest";
import { productionMechanisms } from "../src/mechanisms/registry.js";
import type { AliceEvent } from "../src/mind/events.js";
import { emptyState } from "../src/mind/state.js";
import { speechRequest, step } from "../src/mind/step.js";

const G = "telegram:-1009";
const H = 3_600_000;
// 东八区下午：她醒着。
const T0 = Date.parse("2026-11-12T06:00:00Z");
const mechanisms = productionMechanisms(true);

const said = (at: number, id: string, name: string, isBot = false): AliceEvent => ({
  type: "message.received",
  at,
  scope: G,
  chatType: "group",
  messageId: String(at),
  senderId: id,
  senderName: name,
  text: isBot ? "已保存 1 个过滤器" : "今天好冷",
  contentType: "text",
  replyToMessageId: null,
  directed: false,
  ...(isBot ? { isBot: true as const } : {}),
});

/** 两天里机器人和一个真人各说几条，读最后那一刻的在场的人。 */
function present(botFlagged: (day: number, k: number) => boolean): { familiar: string } {
  const events: AliceEvent[] = [];
  for (const day of [0, 1]) {
    for (let k = 0; k < 4; k++) {
      const at = T0 + day * 24 * H + k * 10 * 60_000;
      events.push(said(at, "bot", "Rose", botFlagged(day, k)), said(at + 60_000, "u1", "Олег"));
    }
  }
  const state = events.reduce((s, e) => step(s, e, mechanisms).state, emptyState);
  const chat = state.chats[G];
  if (!chat) throw new Error("no chat");
  const at = (events.at(-1) as AliceEvent).at + 60_000;
  const cs = speechRequest(state, chat, at, null, mechanisms).contributions;
  return { familiar: cs.find((c) => c.mechanism === "familiar")?.text ?? "" };
}

describe("机器人的标记是单调的", () => {
  it("对照：每条都带标记的机器人不在在场的人里", () => {
    const { familiar } = present(() => true);
    expect(familiar).toContain("Олег");
    expect(familiar).not.toContain("Rose");
  });

  it("先有几条没标记、后来才标上：照样不在在场的人里", () => {
    const { familiar } = present((day) => day === 1);
    expect(familiar).toContain("Олег");
    expect(familiar).not.toContain("Rose");
  });
});
