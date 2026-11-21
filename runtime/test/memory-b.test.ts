/**
 * memory-b（eval-artifacts/memory-b/）。坏掉了会很糟的几件：
 * - 生产没有 [记住]（no-remember 已上线）；她照写了也不会被说出去。
 * - 她自己说过的事（2026-11-12 进生产）：反思也问她自己说出口的事，关于人的事那一条不变；她自己的事送进卡片，
 *   受众规则和日记同一条（私聊里说的不出那个私聊，群里说的只到那个群和当时在场的人的私聊），在它自己的会话里
 *   那段对话还在时间线上时不再写；对不上了的旧的一条被换掉；结果写进 Journal 读得回来。
 */
import { describe, expect, it } from "vitest";
import { decodeEvent } from "../src/journal.js";
import { pressureProduction } from "../src/mechanisms/pressure/index.js";
import { SELF_SUBJECT } from "../src/mechanisms/pressure/people.js";
import type { World } from "../src/mechanisms/pressure/world.js";
import type { Effect, PeopleLearned, ReflectRequest } from "../src/mind/effects.js";
import type { AliceEvent, MessageReceived } from "../src/mind/events.js";
import type { Mechanism } from "../src/mind/mechanism.js";
import { type AliceState, type ChatState, emptyState } from "../src/mind/state.js";
import { speechRequest, step } from "../src/mind/step.js";
import { arms } from "../src/sim/will-arms.js";
import { codeMode } from "../src/speech/decision.js";
import { renderSpeechPrompt } from "../src/speech/prompt.js";
import { parseReflect, renderReflectPrompt } from "../src/speech/reflect.js";
import { program } from "./model-reply.js";

const MIN = 60_000;
const H = 60 * MIN;
/** 2026-11-10 周二 15:00（东八区）。 */
const T = Date.UTC(2026, 10, 10, 7, 0);
const GROUP = "telegram:-5";
const GROUP2 = "telegram:-6";
const DM_A = "telegram:1";
const DM_B = "telegram:2";
const DM_C = "telegram:3";
const NAMES: Record<string, string> = { u1: "莉莉丝", u2: "小鹿", u3: "阿豪" };

/** 候选组里的压力场（组别的第一个机制）。 */
const pressureOf = (arm: string) => arms({})[arm]?.[0] as Mechanism;
/** 消融组 people-no-self：没有她自己说过的事（生产在 2026-11-12 之前的样子）。 */
const noSelf = pressureOf("people-no-self");

let n = 0;
function msg(at: number, scope: string, senderId: string, text: string): MessageReceived {
  n++;
  const group = scope.startsWith("telegram:-");
  return {
    type: "message.received",
    at,
    scope,
    chatType: group ? "group" : "private",
    messageId: `m${n}`,
    senderId,
    senderName: NAMES[senderId] ?? senderId,
    text,
    contentType: "text",
    replyToMessageId: null,
    directed: !group,
  };
}
const reflected = (at: number, scope: string, learned: PeopleLearned): AliceEvent => ({
  type: "ponder.done",
  at,
  scope: "self",
  callId: `self~reflect@${at}`,
  ponder: { kind: "reflect", scope, entries: [], learned },
});
/** 反思读回、校验过出处的一条（said 是她原话里的几个字）。 */
const claim = (text: string, replaces: string | null = null) => ({ said: text, text, replaces });
/** 她标了私密的一条（PLAN 第 33 件：只有这样的守受众规则）。 */
const secret = (text: string) => ({ ...claim(text), private: true as const });

function run(events: AliceEvent[], m: Mechanism) {
  let state: AliceState = emptyState;
  const effects: Effect[] = [];
  for (const e of events) {
    const r = step(state, e, [m]);
    state = r.state;
    effects.push(...r.effects);
  }
  const asks = effects.flatMap((e) =>
    e.type === "call-ponder" && e.request.kind === "reflect" ? [e.request] : [],
  );
  return { state, asks };
}
function requestAt(events: AliceEvent[], scope: string, at: number, m: Mechanism) {
  const { state } = run(events, m);
  return speechRequest(state, state.chats[scope] as ChatState, at, null, [m]);
}
function promptAt(
  events: AliceEvent[],
  scope: string,
  at: number,
  m: Mechanism = pressureProduction,
) {
  const p = renderSpeechPrompt("PERSONA", requestAt(events, scope, at, m));
  return `${p.system}\n${p.user}`;
}

/** 三个会话：和莉莉丝的私聊、和小鹿的私聊、两个群。 */
const base = [
  msg(T, DM_A, "u1", "在吗"),
  msg(T + MIN, DM_B, "u2", "嗨"),
  msg(T + 2 * MIN, GROUP, "u1", "今天好冷"),
  msg(T + 3 * MIN, GROUP, "u2", "是啊"),
  msg(T + 4 * MIN, GROUP2, "u3", "另一个群"),
];

describe("remembering is gone (no-remember, in production since 2026-11-12)", () => {
  it("the prompt never mentions it, and a tools.remember she writes anyway is not said", () => {
    const at = T + 10 * MIN;
    const cand = requestAt(base, DM_A, at, pressureProduction);
    expect(promptAt(base, DM_A, at, pressureProduction)).not.toContain("tools.remember");
    // 其余心里的能力照旧。
    expect(cand.affordances).toEqual(expect.arrayContaining(["intend", "fulfil", "let-go"]));
    const code =
      'await tools.remember({ fact: "她养了只猫" });\nawait tools.say({ text: "好呀" });';
    const { decision, defects } = codeMode.parse(program(code), cand);
    expect(decision.acts).toEqual([{ kind: "send", text: "好呀", replyTo: null }]);
    expect(defects.map((d) => d.kind)).toEqual(["unknown"]);
  });
});

describe("the reflection also asks for what she said about herself", () => {
  const talk = [0, 1, 2, 3].map((k) => msg(T + k * 10_000, DM_A, "u1", `在吗${k}`));
  const tick: AliceEvent = { type: "clock.tick", at: T + 10 * MIN };

  it("asks for it in the same call, with the same rule for facts about people; the ablation does not ask", () => {
    const ask = run([...talk, tick], pressureProduction).asks[0] as ReflectRequest;
    expect(ask.learn?.self).toEqual({ known: [] });
    const prompt = renderReflectPrompt("PERSONA", ask);
    expect(prompt.system).toContain('"self": [{"said"');
    expect(prompt.system).toContain("稳定的喜好、平时的习惯、你这边真实的近况");
    expect(prompt.system).toContain("当场的玩笑和逗人的夸张话属于那一刻");
    const without = run([...talk, tick], noSelf).asks[0] as ReflectRequest;
    expect(without.learn?.self).toBeUndefined();
    const plain = renderReflectPrompt("PERSONA", without);
    expect(plain.system).not.toContain('"self"');
    const factsRule = (s: string) => s.split("\n").find((l) => l.startsWith("- facts："));
    expect(factsRule(prompt.system)).toBe(factsRule(plain.system));
    expect(prompt.maxTokens).toBeGreaterThan(plain.maxTokens ?? 0);
  });

  it("reads her self-claims back, drops empty and unsourced ones, and the event survives the Journal", () => {
    const asked = run([...talk, tick], pressureProduction).asks[0] as ReflectRequest;
    const ask = {
      ...asked,
      lines: [...asked.lines, { at: T, who: null, text: "我超讨厌香菜！今天还把汤煮溢出来了" }],
    };
    const raw = JSON.stringify({
      entries: [],
      facts: [],
      self: [
        { said: "超讨厌香菜", text: "超讨厌香菜", replaces: null },
        { said: "超讨厌香菜", text: "  " },
        { said: "把汤煮溢出来了", text: "把汤煮溢出来了" },
        "没有出处的一句",
      ],
    });
    const p = parseReflect(raw, ask);
    expect(p.learned?.self).toEqual([claim("超讨厌香菜"), claim("把汤煮溢出来了")]);
    const event: AliceEvent = { type: "ponder.done", at: T, scope: "self", callId: "c", ponder: p };
    expect(decodeEvent("ponder.done", "self", event)).toEqual(event);
    const bad = { ...event, ponder: { ...p, learned: { self: [{ replaces: null }] } } };
    expect(decodeEvent("ponder.done", "self", bad)).toBeNull();
  });
});

describe("what she said about herself", () => {
  // 下面几条测受众规则和"同一段对话不再放"：用她标了私密的（PLAN 第 33 件以前所有的都这样）。
  const inDm = reflected(T + 10 * MIN, DM_A, { self: [secret("最近在学做蛋糕，老是塌")] });
  const inGroup = reflected(T + 11 * MIN, GROUP, { self: [secret("超讨厌香菜")] });
  /** 阿豪只在另一个群里说过话：她在 GROUP 说"超讨厌香菜"时他不在场。 */
  const events = [...base, msg(T + 5 * MIN, DM_C, "u3", "在不在"), inDm, inGroup];
  const at = T + 3 * H;

  it("an ordinary one reaches every chat, saying where she said it (invariant 1 narrowed)", () => {
    const open = [
      ...base,
      msg(T + 5 * MIN, DM_C, "u3", "在不在"),
      reflected(T + 10 * MIN, DM_A, { self: [claim("最近在学做蛋糕，老是塌")] }),
      reflected(T + 11 * MIN, GROUP, { self: [claim("超讨厌香菜")] }),
    ];
    expect(promptAt(open, DM_C, at)).toContain("超讨厌香菜（3 小时前在一个群里说的）");
    expect(promptAt(open, GROUP2, at)).toContain("超讨厌香菜（3 小时前在一个群里说的）");
    expect(promptAt(open, GROUP2, at)).toContain(
      "最近在学做蛋糕，老是塌（3 小时前和莉莉丝私聊时说的）",
    );
  });

  it("a private one reaches a chat by the diary's audience rule: a DM's stays in that DM, a group's goes only to that group and to DMs with people present then (invariant 1)", () => {
    // 莉莉丝、小鹿当时都在 GROUP 里说过话。
    expect(promptAt(events, DM_A, at)).toContain(
      "我自己说过的：超讨厌香菜（3 小时前在一个群里说的）",
    );
    expect(promptAt(events, DM_B, at)).toContain(
      "我自己说过的：超讨厌香菜（3 小时前在一个群里说的）",
    );
    // 私聊里说的不出那个私聊；群里说的不进别的群，不到当时不在场的人的私聊。
    expect(promptAt(events, DM_B, at)).not.toContain("蛋糕");
    expect(promptAt(events, DM_C, at)).not.toContain("我自己说过的");
    expect(promptAt(events, GROUP2, at)).not.toContain("我自己说过的");
    // 反思里给她看的"已经说过的"也按这一条：和小鹿的私聊里反思时看不见和莉莉丝私聊里说的。
    const talk = [0, 1, 2, 3].map((k) => msg(at + k * 10_000, DM_B, "u2", `在吗${k}`));
    const { asks } = run(
      [...events, ...talk, { type: "clock.tick", at: at + 10 * MIN }],
      pressureProduction,
    );
    const ask = asks.find((a) => a.scope === DM_B) as ReflectRequest;
    expect(ask.learn?.self?.known).toEqual(["超讨厌香菜"]);
    // 消融组没有这一行。
    expect(promptAt(events, DM_A, at, noSelf)).not.toContain("我自己说过的");
  });

  it("is not shown again in the chat where she said it while that talk goes on; it comes back once the talk has ended and scrolled off", () => {
    // 那段对话还在时间线上：她在这个私聊、这个群里说过的，不再写进卡片。
    expect(promptAt(events, DM_A, at)).not.toContain("蛋糕");
    expect(promptAt(events, GROUP, at)).not.toContain("我自己说过的");
    // 热闹的群：她在一段聊天中间说了一件自己的事，之后每两分钟一条，40 条把它挤出了时间线，可那段聊天没停。
    const busy = Array.from({ length: 40 }, (_, k) =>
      msg(T + 15 * MIN + k * 2 * MIN, GROUP2, "u3", `刷屏${k}`),
    );
    const milkTea = reflected(T + 20 * MIN + 30_000, GROUP2, {
      self: [claim("每天都要喝两杯奶茶")],
    });
    const talk = [...base, ...busy, milkTea].sort((a, b) => a.at - b.at);
    const lastLine = T + 15 * MIN + 39 * 2 * MIN;
    expect(promptAt(talk, GROUP2, lastLine + MIN)).not.toContain("奶茶");
    // 安静了半小时，那段聊天结束了：这时它才是这里的新信息。
    expect(promptAt(talk, GROUP2, lastLine + 30 * MIN)).toMatch(
      /每天都要喝两杯奶茶（[^）]+在这里说的）/,
    );
    // 群里又聊了满满一屏、那段对话也早就结束了：同样回来。
    const chatter = Array.from({ length: 30 }, (_, k) =>
      msg(T + 2 * H + k * 10_000, GROUP, "u2", `闲聊${k}`),
    );
    expect(promptAt([...events, ...chatter], GROUP, at)).toContain(
      "我自己说过的：超讨厌香菜（3 小时前在这里说的）",
    );
  });

  it("what she said in a DM never reaches a group, not even the reflection there", () => {
    expect(promptAt(events, GROUP, at)).not.toContain("蛋糕");
    expect(promptAt(events, GROUP2, at)).not.toContain("蛋糕");
    const call = [0, 1, 2, 3].map((k) => ({
      ...msg(at + k * 10_000, GROUP, "u1", `Alice ${k}`),
      directed: true,
    }));
    const { asks } = run(
      [...events, ...call, { type: "clock.tick", at: at + 10 * MIN }],
      pressureProduction,
    );
    const ask = asks.find((a) => a.scope === GROUP) as ReflectRequest;
    expect(ask.learn?.self?.known).toEqual(["超讨厌香菜"]);
    const prompt = renderReflectPrompt("PERSONA", ask);
    expect(`${prompt.system}${prompt.user}`).not.toContain("蛋糕");
    expect(prompt.user).toContain("你已经说过的关于你自己的事：\n- 超讨厌香菜");
  });

  it("a changed one replaces the old; a repeated one does not pile up", () => {
    const later = [
      reflected(T + H, DM_B, { self: [claim("蛋糕终于做成功了", "最近在学做蛋糕，老是塌")] }),
      reflected(T + 2 * H, DM_A, { self: [claim("超讨厌香菜！")] }),
    ];
    const p = pressureProduction;
    const w = run([...events, ...later], p).state.mechanisms[p.name] as World;
    expect((w.facts[SELF_SUBJECT] ?? []).map((f) => [f.text, f.count])).toEqual([
      ["超讨厌香菜！", 2],
      ["蛋糕终于做成功了", 1],
    ]);
  });
});
