/**
 * 能力事实（G1b，eval-artifacts/scenes/prereg-round2.md）：生产的每次发言请求里都有"她住在平行世界、只经
 * 聊天平台来往"这一条，私聊和群里都有；消融组 no-body 没有。
 */
import { describe, expect, it } from "vitest";
import {
  createPressure,
  PRODUCTION,
  pressureProduction,
} from "../src/mechanisms/pressure/index.js";
import { affordances } from "../src/mind/affordances.js";
import type { MessageReceived } from "../src/mind/events.js";
import type { Mechanism } from "../src/mind/mechanism.js";
import { type ChatState, emptyState } from "../src/mind/state.js";
import { speechRequest, step } from "../src/mind/step.js";

const T = Date.UTC(2026, 10, 10, 7, 0);

function msg(scope: string): MessageReceived {
  return {
    type: "message.received",
    at: T,
    scope,
    chatType: scope.startsWith("telegram:-") ? "group" : "private",
    messageId: "m1",
    senderId: "u1",
    senderName: "陈蔓",
    text: "我在医院楼下",
    contentType: "text",
    replyToMessageId: null,
    directed: true,
  };
}

function capability(scope: string, mechanism: Mechanism, others: readonly Mechanism[] = []) {
  const all = [mechanism, ...others];
  const state = step(emptyState, msg(scope), all).state;
  const request = speechRequest(state, state.chats[scope] as ChatState, T + 60_000, null, all);
  return request.contributions.find((c) => c.mechanism === "pressure-body")?.text;
}

describe("capability fact", () => {
  it("production states that she lives elsewhere and meets people only on the chat's platform, in private chats and groups", () => {
    const cases: Array<[string, string]> = [
      ["telegram:1", "Telegram"],
      ["telegram:-5", "Telegram"],
      ["qq:private:1", "QQ"],
      ["qq:group:5", "QQ"],
      ["sim:1", "网上"],
    ];
    for (const [scope, platform] of cases) {
      const fact = capability(scope, pressureProduction) ?? "";
      expect(fact).toContain("平行世界");
      expect(fact).toContain(platform);
    }
  });

  it("the no-body ablation leaves it out", () => {
    const noBody = createPressure(affordances, { ...PRODUCTION, body: undefined });
    expect(capability("telegram:1", noBody)).toBeUndefined();
  });
});
