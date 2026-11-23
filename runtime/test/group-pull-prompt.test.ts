/**
 * 生产的群里拉力（mechanisms/pressure/group-pull.ts）坏掉了会很糟的几条：
 * - 话题有关只进意愿：她在私聊里说过的话让群里的话"对上了"，但这些话不会出现在群的提示词里；
 * - 拿掉它时，压力场不写 turn 的话题和交情。
 */
import { describe, expect, it } from "vitest";
import {
  createPressure,
  PRODUCTION,
  pressureProduction,
} from "../src/mechanisms/pressure/index.js";
import { readChat } from "../src/mechanisms/pressure/will.js";
import { NO_TURN, type World } from "../src/mechanisms/pressure/world.js";
import { affordances } from "../src/mind/affordances.js";
import type { AliceEvent, MessageReceived, SpeechDecision } from "../src/mind/events.js";
import { replay } from "../src/sim/replay.js";

/** 当地（UTC+8，mind/when.ts）下午两点多：她醒着。 */
const T0 = 1_771_000_000_000 - 10 * 3_600_000;
const S = 1000;
const G = "telegram:-7";
const P = "telegram:8";

let n = 0;
function msg(at: number, o: Partial<MessageReceived> = {}): MessageReceived {
  n++;
  const scope = o.scope ?? G;
  return {
    type: "message.received",
    at,
    scope,
    chatType: scope.startsWith("telegram:-") ? "group" : "private",
    messageId: `m${n}`,
    senderId: o.senderId ?? "contact:1",
    senderName: "群友",
    text: "今天吃什么",
    contentType: "text",
    replyToMessageId: null,
    directed: !scope.startsWith("telegram:-"),
    ...o,
  };
}

const say = (text: string): SpeechDecision => ({ acts: [{ kind: "send", text, replyTo: null }] });
const quiet: SpeechDecision = { acts: [] };

describe("group-pull: topic relevance stays out of the prompt", () => {
  it("what she said in a private chat raises the pull in a group but never appears in the group's prompt", async () => {
    const secret = "我最近在学吉他的和弦转换";
    const chatter = ["有没有人一起吃饭", "今天好热啊", "有人在吗", "下班了没有", "这个游戏好难"];
    const events: AliceEvent[] = [
      msg(T0, { scope: P, senderId: "contact:9", text: "你最近在忙什么" }),
      ...chatter.map((text, i) => msg(T0 + (20 + i) * S, { senderId: "contact:4", text })),
      msg(T0 + 60 * S, { senderId: "contact:3", text: "有没有人会吉他和弦转换的" }),
    ];
    const prompts: string[] = [];
    let world: World | undefined;
    await replay(events, {
      mechanisms: [pressureProduction],
      speech: (request) => {
        if (request.scope === P) return say(secret);
        prompts.push(JSON.stringify(request.contributions));
        return quiet;
      },
      tickMs: 10 * S,
      observe: (event, state) => {
        if (event.type === "message.received" && event.scope === G) {
          world = state.mechanisms[pressureProduction.name] as World;
        }
      },
    });
    const reading = world && readChat(world, G, T0 + 60 * S);
    expect(reading?.raw.topic ?? 0).toBeGreaterThan(0.3);
    for (const p of prompts) expect(p).not.toContain("吉他");
  });
});

describe("group-pull: off means no topic/bond pull", () => {
  it("without topic/bond pull, the pressure field never writes turn.topic or turn.bond", async () => {
    const noPull = createPressure(affordances, { ...PRODUCTION, topic: undefined });
    let world: World | undefined;
    await replay([msg(T0, { directed: true }), msg(T0 + 30 * S), msg(T0 + 40 * S)], {
      mechanisms: [noPull],
      speech: () => say("嗯嗯好的"),
      tickMs: 10 * S,
      observe: (_, state) => {
        world = state.mechanisms[noPull.name] as World;
      },
    });
    expect({ ...world?.chats[G]?.turn, dwell: NO_TURN.dwell }).toEqual(NO_TURN);
  });
});
