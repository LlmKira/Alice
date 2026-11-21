/**
 * 别人的回应模型（src/sim/responders.ts）坏掉了会很糟的几条：
 * - 数错轮或数错"被回复"，回复率就错了；热闹程度和"是不是在接人"分开数；
 * - 回她的那条要像平台送来的一样：引用她那条、directed 为 false（认不认得出是心智的事）；
 * - 回的人是刚说过话的人，一轮只回一次，同一输入同一结果。
 */
import { describe, expect, it } from "vitest";
import type { AliceEvent, MessageReceived, MessageSent } from "../src/mind/events.js";
import { emptyState } from "../src/mind/state.js";
import { fitHer, fitResponders, heatOf, replyChance, responders } from "../src/sim/responders.js";

const G = "telegram:-7";
const T0 = 1_771_000_000_000;
const S = 1000;
let n = 0;
const msg = (at: number, sender: string, re: string | null = null): MessageReceived => ({
  type: "message.received",
  at,
  scope: G,
  chatType: "group",
  messageId: `m${++n}`,
  senderId: sender,
  senderName: sender,
  text: "嗯",
  contentType: "text",
  replyToMessageId: re,
  directed: false,
});

describe("responders: fitting", () => {
  it("counts turns and the replies to them, by heat and by whether the turn answered someone", () => {
    const a = msg(T0, "a");
    const b = msg(T0 + 20 * S, "b", a.messageId); // 回 a：a 这一轮被回了；b 在接人
    const c = msg(T0 + 40 * S, "c"); // 没人回
    const events: AliceEvent[] = [a, b, c, msg(T0 + 20 * 60 * S, "a")];
    const model = fitResponders(events);
    expect(model.cells["quiet|false"]).toEqual({ turns: 3, replied: 1 });
    expect(model.cells["quiet|true"]).toEqual({ turns: 1, replied: 0 });
    expect(model.delays.quiet).toEqual([20 * S]);
    expect(heatOf(4)).toBe("quiet");
    expect(heatOf(5)).toBe("mid");
    expect(heatOf(20)).toBe("hot");
  });
});

describe("responders: replies to her in the live journal", () => {
  it("counts her group turns and the quote replies to them, and uses those rates for her", () => {
    const mine = (at: number, id: string): MessageSent => ({
      type: "message.sent",
      at,
      scope: G,
      messageId: id,
      text: "嗯",
      kind: "text",
    });
    const events: AliceEvent[] = [
      msg(T0, "a"),
      mine(T0 + 10 * S, "h1"),
      mine(T0 + 20 * S, "h2"),
      msg(T0 + 60 * S, "a", "h2"),
      mine(T0 + 30 * 60 * S, "h3"),
    ];
    const her = fitHer(events);
    expect(her.quiet).toEqual({ turns: 2, replied: 1 });
    const model = { ...fitResponders([]), her };
    expect(replyChance(model, "quiet", false)).toBe(0.5);
  });

  it("a line of hers more than 90 s after her last starts its own turn and is not counted twice", () => {
    const mine = (at: number, id: string): MessageSent => ({
      type: "message.sent",
      at,
      scope: G,
      messageId: id,
      text: "嗯",
      kind: "text",
    });
    // 她说完，三分钟没人接，她又说一句；别人回的是第二句。
    const events: AliceEvent[] = [
      msg(T0, "a"),
      mine(T0 + 10 * S, "h1"),
      mine(T0 + 190 * S, "h2"),
      msg(T0 + 220 * S, "a", "h2"),
    ];
    expect(fitHer(events).quiet).toEqual({ turns: 2, replied: 1 });
  });
});

describe("responders: replies to her", () => {
  const history = [msg(T0, "a"), msg(T0 + 10 * S, "b"), msg(T0 + 20 * S, "a")];
  const model = {
    version: 1 as const,
    cells: { "quiet|true": { turns: 1, replied: 999 } },
    delays: { quiet: [30 * S], mid: [], hot: [] },
    last: { n: 10, hits: 10 },
  };
  const sent = (at: number): MessageSent => ({
    type: "message.sent",
    at,
    scope: G,
    messageId: `sim:${at}`,
    text: "嗯",
    kind: "text",
  });

  it("quotes her message from someone who just spoke, as the platform would deliver it", () => {
    const respond = responders(model, history, () => true);
    const [reply] = respond(sent(T0 + 30 * S), emptyState);
    expect(reply).toMatchObject({
      type: "message.received",
      replyToMessageId: `sim:${T0 + 30 * S}`,
      directed: false,
      senderId: "a",
      at: T0 + 60 * S,
    });
  });

  it("answers a round once and is deterministic", () => {
    const one = responders(model, history, () => true);
    const two = responders(model, history, () => true);
    const s = sent(T0 + 30 * S);
    expect(one(s, emptyState)).toEqual(two(s, emptyState));
    expect(one(s, emptyState)).toEqual([]);
  });

  it("uses the smoothed rate of its cell", () => {
    expect(replyChance(model, "quiet", true)).toBeGreaterThan(0.99);
    expect(replyChance(model, "hot", false)).toBe(0.5);
  });
});
