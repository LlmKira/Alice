/**
 * 能力事实（G1b，eval-artifacts/scenes/prereg-round2.md）：生产的每次发言请求里都有"她只活在 Telegram 里"
 * 这一条，私聊和群里都有；消融组 no-body 没有。
 */
import { describe, expect, it } from "vitest";
import { errands } from "../src/mechanisms/errands.js";
import {
  body,
  createPressure,
  PRODUCTION,
  pressureProduction,
} from "../src/mechanisms/pressure/index.js";
import { voice } from "../src/mechanisms/voice.js";
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
  it("production states what she can and cannot do, in private chats and groups", () => {
    for (const scope of ["telegram:1", "telegram:-5"]) {
      // 平行世界（研究员 2026-11-12）：她有自己的日子，但只经 Telegram 来往、见不了面（context-v2 的短句）。
      expect(capability(scope, pressureProduction)).toBe(
        "我住在平行世界，和这边只能在 Telegram 上来往，见不了面。",
      );
    }
  });

  it("the telegram-only control names only what she is offered this turn", () => {
    const only = createPressure(affordances, { ...PRODUCTION, body: body("telegram") });
    const full = capability("telegram:1", only, [voice, errands]);
    expect(full).toContain("发语音");
    expect(full).toContain("上网查点东西");
    // 外壳没配执行代理时注册表里没有 errands：她不该被告知能上网查。
    expect(capability("telegram:1", only, [voice])).not.toContain("上网查点东西");
    // 群里也能发语音（不看别人发没发过）；没有语音合成时就不说。
    expect(capability("telegram:-5", only, [voice, errands])).toContain("发语音");
    expect(capability("telegram:-5", only, [errands])).not.toContain("发语音");
  });

  it("the no-body ablation leaves it out", () => {
    const noBody = createPressure(affordances, { ...PRODUCTION, body: undefined });
    expect(capability("telegram:1", noBody)).toBeUndefined();
  });
});
