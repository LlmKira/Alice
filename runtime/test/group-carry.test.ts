/**
 * 生产（记忆流第 3 片，docs/research/memory-stream.md）：别处想过的带到这里，写下后 DIARY.ttl 之内。
 * PLAN 第 33 件起只有她标了私密的守受众规则：不到不在场的人、不进别的群、私聊里想的不出那个私聊；其余的
 * 哪里都行，注明在哪想的。
 */
import { describe, expect, it } from "vitest";
import { DIARY } from "../src/mechanisms/pressure/params.js";
import { mechanisms } from "../src/mechanisms/registry.js";
import type { AliceEvent, MessageReceived } from "../src/mind/events.js";
import type { Mechanism } from "../src/mind/mechanism.js";
import { type ChatState, emptyState } from "../src/mind/state.js";
import { speechRequest, step } from "../src/mind/step.js";
import { renderSpeechPrompt } from "../src/speech/prompt.js";

const MIN = 60_000;
const T = Date.UTC(2026, 10, 10, 7, 0);
const GROUP = "telegram:-5";
const OTHER_GROUP = "telegram:-6";
const DM = (u: string) => `telegram:${u.slice(1)}`;
const HURT = "又把我当翻译机 有点烦";

let n = 0;
function msg(at: number, scope: string, sender: string): MessageReceived {
  n++;
  const group = scope.startsWith("telegram:-");
  return {
    type: "message.received",
    at,
    scope,
    chatType: group ? "group" : "private",
    messageId: `m${n}`,
    senderId: sender,
    senderName: `人${sender}`,
    text: "嗯嗯",
    contentType: "text",
    replyToMessageId: null,
    directed: !group,
  };
}
/** secret：她想的时候标了私密（PLAN 第 33 件：只有这样的守受众规则）。 */
const think = (at: number, scope: string, thought: string, secret = false): AliceEvent => ({
  type: "act.done",
  at,
  scope,
  act: { kind: "think", thought, ...(secret ? { secret: "私密" as const } : {}) },
});

function card(events: AliceEvent[], scope: string, at: number, list: readonly Mechanism[]) {
  const state = events.reduce((s, e) => step(s, e, list).state, emptyState);
  const request = speechRequest(state, state.chats[scope] as ChatState, at, null, list);
  return renderSpeechPrompt("PERSONA", request).user;
}

/** u1、u2 在群里说过话，她在群里想过 HURT；u3 不在群里。 */
const inGroup = (secret = false): AliceEvent[] => [
  msg(T, GROUP, "u1"),
  msg(T + MIN, GROUP, "u2"),
  think(T + 2 * MIN, GROUP, HURT, secret),
];

describe("what she thought in a group follows to the DMs of people who were there", () => {
  it("carried with its content to a person who was present, 50 minutes later", () => {
    const at = T + 52 * MIN;
    const events = [...inGroup(), msg(at - 10_000, DM("u1"), "u1")];
    expect(card(events, DM("u1"), at, mechanisms)).toContain(`在一个群里想过：${HURT}`);
  });

  // PLAN 第 33 件以前所有想法都这样；现在只有标了私密的。
  const elsewhere = (secret: boolean) => {
    const at = T + 30 * MIN;
    const events = [
      ...inGroup(secret),
      msg(T + 5 * MIN, GROUP, "u4"),
      msg(at - 30_000, OTHER_GROUP, "u1"),
      msg(at - 20_000, DM("u3"), "u3"),
      msg(at - 10_000, DM("u4"), "u4"),
    ];
    return [DM("u3"), DM("u4"), OTHER_GROUP].map((s) => card(events, s, at, mechanisms));
  };

  it("a private thought: never to someone absent, never into another group, never to someone who spoke only afterwards", () => {
    for (const user of elsewhere(true)) expect(user).not.toContain(HURT);
  });

  // 没标私密的哪里都能去（2026-11-14 起不再只放进写下时在场的人此刻也在的聊天）：u3、u4 写下时不在，也看得见。
  it("an ordinary thought goes to any chat, saying where she had it", () => {
    for (const user of elsewhere(false)) expect(user).toContain(`在一个群里想过：${HURT}`);
  });

  it("more than THOUGHT.shown from elsewhere: those about people here first, then what is being said, then the newest", () => {
    const at = T + 30 * MIN;
    const THIRD = "telegram:-7";
    const events = [
      ...inGroup(),
      msg(T + 2 * MIN, OTHER_GROUP, "u5"),
      msg(T + 2 * MIN, THIRD, "u6"),
      think(T + 3 * MIN, THIRD, "猫咪今天又打翻了水杯"),
      think(T + 4 * MIN, OTHER_GROUP, "最近大家都在聊考研的事"),
      think(T + 5 * MIN, OTHER_GROUP, "今天下雨了"),
      think(T + 6 * MIN, OTHER_GROUP, "有人请大家喝奶茶"),
    ];
    const withU1 = card([...events, msg(at - 10_000, DM("u1"), "u1")], DM("u1"), at, mechanisms);
    expect(withU1).toContain(HURT);
    expect(withU1).toMatch(/下雨[\s\S]*奶茶|奶茶[\s\S]*下雨/);
    expect(withU1).not.toMatch(/水杯|考研/);
    const cat = { ...msg(at - 10_000, DM("u3"), "u3"), text: "我家猫咪也爱打翻水杯" };
    const withU3 = card([...events, cat], DM("u3"), at, mechanisms);
    expect(withU3).toContain("猫咪今天又打翻了水杯");
    expect(withU3).not.toMatch(new RegExp(`${HURT}|考研`));
  });

  it("a private thought in a DM stays in that DM; an ordinary one reaches a group where that person is, naming the chat", () => {
    const at = T + 20 * MIN;
    const events = (secret: boolean) => [
      ...inGroup(),
      msg(T + 3 * MIN, DM("u1"), "u1"),
      think(T + 4 * MIN, DM("u1"), "只跟小满说的心里话", secret),
      msg(at - 10_000, DM("u2"), "u2"),
      msg(at - 5_000, GROUP, "u1"),
    ];
    const kept = card(events(true), DM("u2"), at, mechanisms);
    expect(kept).toContain(`在一个群里想过：${HURT}`);
    expect(kept).not.toContain("只跟小满说的心里话");
    expect(card(events(true), GROUP, at, mechanisms)).not.toContain("只跟小满说的心里话");
    expect(card(events(false), GROUP, at, mechanisms)).toContain(
      "和人u1私聊时想过：只跟小满说的心里话",
    );
    expect(card(events(false), DM("u2"), at, mechanisms)).toContain(
      "和人u1私聊时想过：只跟小满说的心里话",
    );
  });

  it("gone after DIARY.ttl", () => {
    const at = T + 2 * MIN + DIARY.ttl + MIN;
    const events = [...inGroup(), msg(at - 10_000, DM("u1"), "u1")];
    expect(card(events, DM("u1"), at, mechanisms)).not.toContain(HURT);
  });
});
