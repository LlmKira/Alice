/**
 * 卡片上没有群画像那一行（2026-11-13 拿掉）：逐个拿掉时它的效应在噪声里（+0.01），它的"话题"又带着房间的口气
 * （"充满攻击性的网络对线……荤段子和互相嘲讽"），她跟着骂起来（eval-artifacts/ablation-live/results.md、
 * live-review/2026-11-13.md）。反思也不再问群印象；Journal 里旧的印象照样读得回，但不折叠、不显示。
 */
import { describe, expect, it } from "vitest";
import { decodeEvent } from "../src/journal.js";
import { REFLECT } from "../src/mechanisms/pressure/params.js";
import { productionMechanisms } from "../src/mechanisms/registry.js";
import type { ReflectRequest } from "../src/mind/effects.js";
import type { AliceEvent } from "../src/mind/events.js";
import { emptyState } from "../src/mind/state.js";
import { speechRequest, step } from "../src/mind/step.js";
import { renderReflectPrompt } from "../src/speech/reflect.js";

const G = "telegram:-1009";
const T0 = Date.parse("2026-11-12T06:00:00Z");
const D = 24 * 3_600_000;
const mechanisms = productionMechanisms(true);

const said = (at: number, id: string, name: string): AliceEvent => ({
  type: "message.received",
  at,
  scope: G,
  chatType: "group",
  messageId: String(at),
  senderId: id,
  senderName: name,
  text: "今天谁去拍照",
  contentType: "text",
  replyToMessageId: null,
  directed: false,
});

/** 两天里两个人各说很多条（以前够得上"常说话的"），再有一条旧的群印象。 */
function userPrompt(): string {
  const events: AliceEvent[] = [];
  for (const day of [0, 1])
    for (let k = 0; k < 6; k++) {
      const at = T0 + day * D + k * 600_000;
      events.push(said(at, "u1", "阿杰"), said(at + 60_000, "u2", "小周"));
    }
  events.push({
    type: "ponder.done",
    at: T0 + D + 4 * 3_600_000,
    scope: "self",
    callId: "self~reflect@1",
    ponder: {
      kind: "reflect",
      scope: G,
      entries: [],
      learned: { group: { topics: "网络对线和荤段子", tone: "极其粗鲁" } },
    } as never,
  });
  const state = events.reduce((s, e) => step(s, e, mechanisms).state, emptyState);
  const chat = state.chats[G];
  if (!chat) throw new Error("no chat");
  const request = speechRequest(state, chat, T0 + D + 5 * 3_600_000, null, mechanisms);
  return request.contributions.map((c) => c.text).join("\n");
}

describe("卡片上没有群画像", () => {
  it("存着的印象和数出来的常说话的人都不显示", () => {
    const text = userPrompt();
    expect(text).not.toContain("这个群平时聊的");
    expect(text).not.toContain("常说话的");
    expect(text).not.toContain("网络对线");
  });

  it("生产在群里的反思不问群印象", () => {
    // 四件冲着她的事（点名两次、她回了两句），安静下来，到了反思的时候（同 impression-topics 以前的做法）。
    const toHer = (at: number, text: string): AliceEvent => ({
      type: "message.received",
      at,
      scope: G,
      chatType: "group",
      messageId: String(at),
      senderId: "u1",
      senderName: "阿杰",
      text,
      contentType: "text",
      replyToMessageId: null,
      directed: true,
    });
    const mine = (at: number, text: string): AliceEvent => ({
      type: "message.sent",
      at,
      scope: G,
      messageId: `s${at}`,
      text,
      kind: "text",
    });
    const events: AliceEvent[] = [
      toHer(T0, "Alice 你看"),
      mine(T0 + 10_000, "干嘛"),
      toHer(T0 + 20_000, "Alice 看新闻"),
      mine(T0 + 30_000, "看到啦"),
      { type: "clock.tick", at: T0 + 30_000 + REFLECT.quiet },
    ];
    let state = emptyState;
    let ask: ReflectRequest | undefined;
    for (const e of events) {
      const r = step(state, e, mechanisms);
      state = r.state;
      for (const x of r.effects) {
        if (x.type === "call-ponder" && x.request.kind === "reflect") ask = x.request;
      }
    }
    if (!ask) throw new Error("no reflection asked");
    expect(ask.learn?.facts).toBe(true);
    const prompt = renderReflectPrompt("PERSONA", ask).system;
    expect(prompt).not.toContain('"group"');
    expect(prompt).not.toContain("topics");
  });

  it("Journal 里带着群印象的旧结果照样读得回", () => {
    const old = {
      type: "ponder.done",
      at: T0,
      scope: "self",
      callId: "c",
      ponder: {
        kind: "reflect",
        scope: G,
        entries: [],
        learned: { group: { topics: "胶片", tone: "随便" } },
      },
    };
    expect(decodeEvent("ponder.done", "self", old)).toEqual(old);
  });
});
