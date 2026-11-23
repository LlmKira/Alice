/**
 * 候选 people（people.ts）：坏掉了会很糟的几件——
 * - 受众：私聊里知道的事只在那个私聊；群里知道的只在那个群、和当时在场的人的私聊；反思时给她看的已知事实也守这条。
 *   社交周边视觉只用对方本人在群里公开说话的日子。
 * - 送达：反思记下的事在那个人的会话里出现；对不上了的旧事被换掉；有时间的事过了就写"已经过了"，不再写"明天"。
 * - 生产不变：生产的反思请求里没有这一项，提示词和以前逐字相同。
 * - 话题相关度：她喜欢的东西在话题里出现时分数高，无关的为 0。
 */
import { describe, expect, it } from "vitest";
import { decodeEvent } from "../src/journal.js";
import {
  createPressure,
  PRODUCTION,
  pressureProduction,
} from "../src/mechanisms/pressure/index.js";
import type { World } from "../src/mechanisms/pressure/world.js";
import { affordances } from "../src/mind/affordances.js";
import type { Effect, PeopleLearned, ReflectRequest } from "../src/mind/effects.js";
import type { AliceEvent, MessageReceived } from "../src/mind/events.js";
import type { Mechanism } from "../src/mind/mechanism.js";
import { type AliceState, type ChatState, emptyState } from "../src/mind/state.js";
import { speechRequest, step } from "../src/mind/step.js";
import { renderSpeechPrompt } from "../src/speech/prompt.js";
import { parseReflect, renderReflectPrompt } from "../src/speech/reflect.js";

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
/** 2026-11-10 周二 15:00（东八区）。 */
const T = Date.UTC(2026, 10, 10, 7, 0);
const GROUP = "telegram:-5";
const GROUP2 = "telegram:-6";
const DM_A = "telegram:1";
const DM_B = "telegram:2";
const NAMES: Record<string, string> = { u1: "莉莉丝", u2: "小鹿", u3: "阿豪" };

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
/** 反思读回、校验过出处的一条（said 是他原话里的几个字）。 */
const fact = (about: string, text: string, when: string | null = null, replaces = null) => ({
  about,
  said: text,
  text,
  when,
  replaces: replaces as string | null,
});

/** 生产去掉 people（消融组 no-people）。 */
const withoutPeople = createPressure(affordances, { ...PRODUCTION, people: undefined });

function run(events: AliceEvent[], mechanism: Mechanism = pressureProduction) {
  let state: AliceState = emptyState;
  const effects: Effect[] = [];
  for (const e of events) {
    const r = step(state, e, [mechanism]);
    state = r.state;
    effects.push(...r.effects);
  }
  const asks = effects.flatMap((e) =>
    e.type === "call-ponder" && e.request.kind === "reflect" ? [e.request] : [],
  );
  return { state, asks };
}
const world = (state: AliceState, m: Mechanism = pressureProduction) =>
  state.mechanisms[m.name] as World;
/** 那个会话在 at 时刻的发言提示词（用户提示里有背景事实）。 */
function promptAt(
  events: AliceEvent[],
  scope: string,
  at: number,
  m: Mechanism = pressureProduction,
) {
  const { state } = run(events, m);
  const p = renderSpeechPrompt(
    "PERSONA",
    speechRequest(state, state.chats[scope] as ChatState, at, null, [m]),
  );
  return `${p.system}\n${p.user}`;
}

/** 三个会话：和莉莉丝的私聊、和小鹿的私聊、一个群（莉莉丝和小鹿都在说话）。 */
const base = [
  msg(T, DM_A, "u1", "在吗"),
  msg(T + MIN, DM_B, "u2", "嗨"),
  msg(T + 2 * MIN, GROUP, "u1", "今天好冷"),
  msg(T + 3 * MIN, GROUP, "u2", "是啊"),
  msg(T + 4 * MIN, GROUP2, "u3", "另一个群"),
];

describe("audience of what she learned about people", () => {
  // 托付的事：反思时她标了私密（PLAN 第 33 件：只有这样的守受众规则）。
  const secret = reflected(T + 10 * MIN, DM_A, {
    facts: [{ ...fact("u1", "辞职了，还没告诉家里"), private: true }],
  });
  const open = reflected(T + 11 * MIN, GROUP, { facts: [fact("u1", "养了一只叫年糕的猫")] });
  const events = [...base, secret, open];
  const at = T + 20 * MIN;

  it("an ordinary thing she learned in a DM is there wherever he is, saying where she learned it", () => {
    const plain = reflected(T + 12 * MIN, DM_B, { facts: [fact("u2", "周末去爬山")] });
    expect(promptAt([...events, plain], GROUP, at)).toContain("周末去爬山（和小鹿私聊时知道的）");
  });

  // 私密只看那一条自己标没标（2026-11-14 起）：托付过的私聊里后来记下的普通事照常走，托付的那一条不走。
  it("after something was entrusted in a DM, an unmarked thing she learns there later goes like any other", () => {
    const later = reflected(T + 12 * MIN, DM_A, { facts: [fact("u1", "周末去爬山")] });
    expect(promptAt([...events, later], DM_A, at)).toContain("周末去爬山");
    const group = promptAt([...events, later], GROUP, at);
    expect(group).toContain("周末去爬山（和莉莉丝私聊时知道的）");
    expect(group).not.toContain("辞职了");
  });

  it("a private thing she learned in a DM stays in that DM", () => {
    expect(promptAt(events, DM_A, at)).toContain("辞职了");
    expect(promptAt(events, GROUP, at)).not.toContain("辞职了");
    expect(promptAt(events, GROUP2, at)).not.toContain("辞职了");
    expect(promptAt(events, DM_B, at)).not.toContain("辞职了");
  });

  it("what she learned in a group shows there and in the DM of the person it is about, who was there", () => {
    expect(promptAt(events, GROUP, at)).toContain("年糕");
    expect(promptAt(events, DM_A, at)).toContain("年糕");
    expect(promptAt(events, DM_A, at)).toContain("养了一只叫年糕的猫（在一个群里知道的）");
    expect(promptAt(events, GROUP2, at)).not.toContain("年糕");
  });

  it("the reflection in a group is not shown what she knows from a DM", () => {
    const talk = [
      msg(at, GROUP, "u1", "Alice 你在吗"),
      msg(at + 10_000, GROUP, "u1", "Alice 理我"),
      msg(at + 20_000, GROUP, "u1", "Alice!!"),
      msg(at + 30_000, GROUP, "u1", "Alice 快出来"),
    ].map((e) => ({ ...e, directed: true }));
    const { asks } = run([...events, ...talk, { type: "clock.tick", at: at + 10 * MIN }]);
    const ask = asks.find((a) => a.scope === GROUP);
    expect(ask?.learn?.known.flatMap((k) => k.facts)).toEqual(["养了一只叫年糕的猫"]);
    const prompt = renderReflectPrompt("PERSONA", ask as ReflectRequest);
    expect(`${prompt.system}${prompt.user}`).not.toContain("辞职");
  });

  it("peripheral vision uses only her friend's own public lines, never DMs", () => {
    // 莉莉丝在群里天天说话，然后 4 天没说；她在私聊里说的事不出现在这条事实里。
    const days = Array.from({ length: 6 }, (_, k) => msg(T + k * D, GROUP, "u1", `第${k}天`));
    const later = T + 9 * D;
    const dm = [msg(later, DM_A, "u1", "我心情不好，别告诉群里")];
    const text = promptAt([...base, ...days, ...dm], DM_A, later + MIN);
    expect(text).toContain("莉莉丝在我们都在的群里已经 4 天没说话了（之前常说）");
    // 在群里不写这一条；小鹿的私聊里也不写莉莉丝的。
    expect(promptAt([...base, ...days, ...dm], GROUP, later + MIN)).not.toContain("没说话了");
    expect(promptAt([...base, ...days, ...dm], DM_B, later + MIN)).not.toContain("莉莉丝在");
    // 她已经退了那个群：不写。
    const left: AliceEvent = {
      type: "membership.changed",
      at: later - H,
      scope: GROUP,
      member: false,
      reason: "left",
    };
    expect(promptAt([...base, ...days, left, ...dm], DM_A, later + MIN)).not.toContain("没说话了");
  });
});

describe("what she learned stays right", () => {
  it("a changed fact replaces the old one; a rephrased one does not pile up", () => {
    const events = [
      ...base,
      reflected(T + 10 * MIN, DM_A, { facts: [fact("u1", "在杭州工作")] }),
      reflected(T + D, DM_A, {
        facts: [fact("u1", "搬到上海了，在上海工作", null, "在杭州工作" as never)],
      }),
      reflected(T + 2 * D, DM_A, { facts: [fact("u1", "搬到了上海，在上海工作")] }),
    ];
    const facts = world(run(events).state).facts.u1 ?? [];
    expect(facts.map((f) => f.text)).toEqual(["搬到了上海，在上海工作"]);
    expect(facts[0]?.count).toBe(2);
  });

  it("a dated fact says how far off it is, and that it is past once it is", () => {
    // 周二下午说"明天考雅思"。
    const events = [
      ...base,
      reflected(T + 10 * MIN, DM_A, { facts: [fact("u1", "考雅思", "明天")] }),
    ];
    expect(promptAt(events, DM_A, T + H)).toContain("考雅思（明天");
    expect(promptAt(events, DM_A, T + 3 * D)).toContain("考雅思（2 天前，已经过了");
  });

  it("a fact or a self-claim needs its source in that person's own words; portraits and old unsourced ones never reach the card (live 11-13)", () => {
    const request = {
      kind: "reflect",
      at: T,
      scope: GROUP,
      chatType: "group",
      lines: [
        { at: T, who: 0, text: "我下周去成都出差，烦死了" },
        { at: T + 1, who: 1, text: "哈哈哈你又来" },
        { at: T + 2, who: null, text: "我最近在学做蛋糕，第一个就烤糊了" },
      ],
      people: [
        { id: "u1", name: "莉莉丝" },
        { id: "u2", name: "阿杰" },
      ],
      mood: null,
      diary: [],
      examples: [],
      learn: { facts: true, known: [], self: { known: [] } },
    } as ReflectRequest;
    const raw = JSON.stringify({
      entries: [],
      facts: [
        {
          about: "p1",
          said: "下周去成都出差",
          text: "下周去成都出差",
          when: "下周",
          replaces: null,
        },
        // 画像：没有一句原话是这么说的。
        { about: "p2", said: "满嘴跑火车", text: "满嘴跑火车，没人损他会觉得没意思" },
        // 出处是别人的话。
        { about: "p2", said: "下周去成都出差", text: "要去成都" },
        { about: "p2", text: "喜欢在网上吵架找乐子" },
      ],
      self: [
        { said: "在学做蛋糕", text: "最近在学做蛋糕", replaces: null },
        { said: "反应极快", text: "在对线时反应极快，能精准地辛辣反击" },
      ],
    });
    const p = parseReflect(raw, request);
    expect(p.learned?.facts?.map((f) => f.text)).toEqual(["下周去成都出差"]);
    expect(p.learned?.self?.map((s) => s.text)).toEqual(["最近在学做蛋糕"]);
    // Journal 里旧的、没有出处的不 fold 进来：卡片上看不到。
    const old = reflected(T + 10 * MIN, DM_A, {
      facts: [{ about: "u1", text: "满嘴跑火车", when: null, replaces: null }],
      self: [{ text: "会说乌克兰语", replaces: null }],
    });
    const prompt = promptAt([...base, old], DM_A, T + H);
    expect(prompt).not.toContain("满嘴跑火车");
    expect(prompt).not.toContain("乌克兰语");
  });

  it("an unknown person or an empty line is dropped, not guessed", () => {
    const request = {
      kind: "reflect",
      at: T,
      scope: DM_A,
      chatType: "private",
      lines: [{ at: T, who: 0, text: "最近在学吉他，手指好疼" }],
      people: [{ id: "u1", name: "莉莉丝" }],
      mood: null,
      diary: [],
      examples: [],
      learn: { facts: true, known: [] },
    } as ReflectRequest;
    const raw = JSON.stringify({
      entries: [],
      facts: [
        { about: "p1", said: "在学吉他", text: "在学吉他", when: null, replaces: null },
        { about: "p9", said: "在学吉他", text: "不知道是谁" },
        { about: "p1", said: "在学吉他", text: "  " },
      ],
      // 不再问兴趣（R07 已拿掉）：模型照写了也不读。
      likes: [{ about: "p1", what: "吉他" }],
    });
    const p = parseReflect(raw, request);
    expect(p.learned).toEqual({
      facts: [{ about: "u1", said: "在学吉他", text: "在学吉他", when: null, replaces: null }],
    });
    // 写回日志、读得回来。
    const event: AliceEvent = { type: "ponder.done", at: T, scope: "self", callId: "c", ponder: p };
    expect(decodeEvent("ponder.done", "self", event)).toEqual(event);
    const bad = { ...event, ponder: { ...p, learned: { facts: [{ about: "u1" }] } } };
    expect(decodeEvent("ponder.done", "self", bad)).toBeNull();
    // 以前的行把这几样平铺在 ponder 上：读回时收进 learned，记下的事不丢；兴趣丢掉。
    const { learned, ...flat } = p;
    const likes = [{ about: "u1", what: "吉他" }];
    const old = { ...event, ponder: { ...flat, ...learned, likes } };
    expect(decodeEvent("ponder.done", "self", old)).toEqual(event);
  });
});

describe("the no-people ablation is untouched", () => {
  it("without people the reflection asks for nothing about people, and its prompt has no such rules", () => {
    const talk = [0, 1, 2, 3].map((k) => msg(T + k * 10_000, DM_A, "u1", `在吗${k}`));
    const tick: AliceEvent = { type: "clock.tick", at: T + 10 * MIN };
    const prod = run([...talk, tick], withoutPeople).asks[0];
    expect(prod).toBeDefined();
    expect(prod?.learn).toBeUndefined();
    const prompt = renderReflectPrompt("PERSONA", prod as ReflectRequest);
    expect(prompt.system).not.toContain("facts");
    const cand = run([...talk, tick]).asks[0];
    expect(cand?.learn?.facts).toBe(true);
  });
});

describe("selfText prefers same-script self claims", () => {
  it("ranks Chinese self claims ahead of Russian ones in a Chinese group without hiding fallback", () => {
    const r1 = reflected(T + 10 * MIN, DM_B, {
      self: [1, 2, 3, 4].map((k) => ({
        said: `спадть ${k}`,
        text: `Я хочу спать ${k}`,
        replaces: null,
      })),
    });
    const r2 = reflected(T + 11 * MIN, GROUP2, {
      self: [{ said: "泡面泡坨了", text: "今天又把泡面泡坨了", replaces: null }],
    });
    const events: AliceEvent[] = [
      ...base,
      msg(T + 5 * MIN, DM_B, "u2", "спадть 1 спадть 2 спадть 3 спадть 4"),
      r1,
      r2,
      msg(T + 12 * MIN, GROUP, "u1", "今晚吃什么"),
    ];
    const prompt = promptAt(events, GROUP, T + 30 * MIN);
    expect(prompt).toContain("今天又把泡面泡坨了");
  });
});
