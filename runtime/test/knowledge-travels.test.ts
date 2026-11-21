/**
 * 她知道的事能带到哪些聊天（PLAN 第 33 件，北极星不变量 1 收窄）：写下时标出别人托她保密的、明显私密的，
 * 标在本来就有的那次调用里（反思的 private，发言里 [inner]、[心情] 的 secret），不另调模型。只有标了的守受众规则；
 * 其余的到哪个聊天都想得起来，注明出处。各处显示的性质在 reflect、memory-b、people、memory、affect、group-carry、
 * missed 的测试里；这里测标记本身：怎么问、怎么读回、怎么进 Journal。
 */
import { describe, expect, it } from "vitest";
import { decodeEvent } from "../src/journal.js";
import { mechanisms } from "../src/mechanisms/registry.js";
import { affordances } from "../src/mind/affordances.js";
import type { ReflectRequest } from "../src/mind/effects.js";
import type { AliceEvent } from "../src/mind/events.js";
import { emptyState } from "../src/mind/state.js";
import { speechRequest, step } from "../src/mind/step.js";
import { codeMode } from "../src/speech/decision.js";
import { renderSpeechPrompt } from "../src/speech/prompt.js";
import { parseReflect, renderReflectPrompt } from "../src/speech/reflect.js";
import { program } from "./model-reply.js";

const T = Date.UTC(2026, 10, 12, 12, 0);
const DM = "telegram:1";

const request: ReflectRequest = {
  kind: "reflect",
  at: T,
  scope: DM,
  chatType: "private",
  lines: [
    { at: T, who: 0, text: "周六我要跟江野表白，你不许告诉任何人" },
    { at: T, who: 0, text: "我家猫叫年糕" },
    { at: T, who: null, text: "我最近在学做蛋糕" },
  ],
  people: [{ id: "u1", name: "唐小满" }],
  mood: null,
  diary: [],
  examples: [],
  learn: { facts: true, known: [], self: { known: [] } },
};

describe("the reflection marks what was entrusted or plainly private, in the same call", () => {
  it("asks for private on every kind of item it writes", () => {
    const p = renderReflectPrompt("PERSONA", request);
    expect(p.system).toContain(
      "- private：这一条是别人托你保密的事，或明显私密的事（健康、感情、要给谁的惊喜），写 true；其余写 false。",
    );
    for (const field of ['"entries"', '"mood"', '"facts"', '"self"']) {
      const line = p.system.split("\n").find((l) => l.includes(field));
      expect(line).toContain('"private": true或false');
    }
  });

  it("reads the mark back: only true counts", () => {
    const raw = JSON.stringify({
      entries: [
        { about: "p1", text: "小满周六要表白", importance: 8, private: true },
        { about: "p1", text: "小满家的猫叫年糕", importance: 3, private: false },
      ],
      mood: { word: "紧张", why: "小满要表白", private: true },
      facts: [
        { about: "p1", said: "跟江野表白", text: "周六要向江野表白", private: true },
        { about: "p1", said: "我家猫叫年糕", text: "养了一只叫年糕的猫" },
      ],
      self: [{ said: "在学做蛋糕", text: "在学做蛋糕", private: "yes" }],
    });
    const r = parseReflect(raw, request);
    expect(r.entries.map((e) => e.private)).toEqual([true, undefined]);
    expect(r.mood?.private).toBe(true);
    expect(r.learned?.facts?.map((f) => f.private)).toEqual([true, undefined]);
    expect(r.learned?.self?.[0]?.private).toBeUndefined();
  });

  it("the mark travels in the Journal", () => {
    const done: AliceEvent = {
      type: "ponder.done",
      at: T,
      scope: "self",
      callId: "r1",
      ponder: {
        kind: "reflect",
        scope: DM,
        entries: [{ about: "u1", text: "小满周六要表白", importance: 8, private: true }],
        mood: { word: "紧张", why: "小满要表白", valence: -0.23, private: true },
        learned: {
          facts: [
            {
              about: "u1",
              said: "跟江野表白",
              text: "周六要向江野表白",
              when: null,
              replaces: null,
              private: true,
            },
          ],
        },
      },
    };
    expect(decodeEvent("ponder.done", "self", JSON.parse(JSON.stringify(done)))).toEqual(done);
  });
});

describe("privacy is the item's own mark, not the chat's", () => {
  // 2026-11-13 到 11-14：一个会话里标过私密之后，那里写下的都守受众规则（留出集 v2-02 上后来没标的[心情]、想法
  // 把"表白"带到了别处）。研究员 2026-11-14"宁可真实""不要太防御"：只看那一条自己标没标。
  const GROUP = "telegram:-9";
  const msg = (at: number, scope: string, sender: string, name: string): AliceEvent => ({
    type: "message.received",
    at,
    scope,
    chatType: scope.startsWith("telegram:-") ? "group" : "private",
    messageId: `m${at}`,
    senderId: sender,
    senderName: name,
    text: "嗯",
    contentType: "text",
    replyToMessageId: null,
    directed: !scope.startsWith("telegram:-"),
  });
  const confided: AliceEvent = {
    type: "ponder.done",
    at: T + 5 * 60_000,
    scope: "self",
    callId: "r1",
    ponder: {
      kind: "reflect",
      scope: DM,
      entries: [{ about: null, text: "小满周六要表白", importance: 8, private: true }],
    },
  };
  const later: AliceEvent[] = [
    {
      type: "act.done",
      at: T + 6 * 60_000,
      scope: DM,
      act: { kind: "feel", mood: "激动", why: "小满要跟江野表白了，我得帮她保守秘密" },
      valence: 0.9,
    },
    {
      type: "act.done",
      at: T + 6 * 60_000,
      scope: DM,
      act: { kind: "think", thought: "表白大作战！" },
    },
  ];
  const card = (events: AliceEvent[], scope: string, at: number) => {
    const state = events.reduce((s, e) => step(s, e, mechanisms).state, emptyState);
    const chat = state.chats[scope];
    if (!chat) throw new Error("no chat");
    return renderSpeechPrompt("P", speechRequest(state, chat, at, null, mechanisms)).user;
  };
  const opening = [msg(T, DM, "u1", "唐小满"), msg(T + 60_000, GROUP, "u2", "阿豪")];
  const at = T + 10 * 60_000;

  it("the marked entry does not leave that DM; an unmarked mood and thought written there afterwards do", () => {
    const events = [...opening, confided, ...later, msg(at - 1000, GROUP, "u2", "阿豪")];
    const group = card(events, GROUP, at);
    expect(group).not.toContain("小满周六要表白");
    expect(group).toContain("和唐小满私聊时想过：表白大作战！");
    expect(group).toContain("和唐小满私聊时，因为小满要跟江野表白了");
  });
});

describe("what she thinks or feels while speaking can be marked too", () => {
  const speech = {
    scope: DM,
    chatType: "private" as const,
    at: T,
    timeline: [],
    affordances: affordances.map((a) => a.kind),
  } as never;

  it("[inner] and [心情] offer an optional secret, described once", () => {
    const sdk = codeMode.rules(affordances.filter((a) => a.kind === "think" || a.kind === "feel"));
    expect(sdk.match(/ {4}secret\?: "私密";/g)).toHaveLength(2);
    expect(sdk.match(/健康、感情、要给谁的惊喜/g)).toHaveLength(2);
  });

  it("reads secret as 私密 (or true); anything else, or nothing, leaves no field", () => {
    const code = [
      'await tools.inner({ thought: "小满要表白了", secret: "私密" });',
      'await tools.inner({ thought: "今天好冷", secret: true });',
      'await tools.inner({ thought: "想吃火锅" });',
      'await tools.feel({ mood: "紧张", why: "小满要表白", secret: false });',
    ].join("\n");
    const { decision, defects } = codeMode.parse(program(code), speech);
    expect(defects).toEqual([]);
    expect(decision.acts).toEqual([
      { kind: "think", thought: "小满要表白了", secret: "私密" },
      { kind: "think", thought: "今天好冷", secret: "私密" },
      { kind: "think", thought: "想吃火锅" },
      { kind: "feel", mood: "紧张", why: "小满要表白" },
    ]);
  });

  it("an act with the mark survives the Journal; one without it still reads back", () => {
    const act = (a: object): AliceEvent =>
      ({ type: "act.done", at: T, scope: DM, act: a }) as never;
    for (const a of [
      { kind: "think", thought: "小满要表白了", secret: "私密" },
      { kind: "think", thought: "想吃火锅" },
    ]) {
      expect(decodeEvent("act.done", DM, JSON.parse(JSON.stringify(act(a))))).toEqual(act(a));
    }
    expect(
      decodeEvent("act.done", DM, act({ kind: "think", thought: "x", secret: "yes" })),
    ).toBeNull();
  });
});

describe("invariant 1: nothing she marked private shows up outside its audience", () => {
  // 每个会话里各写一样标了私密的（日记、心情、关于人的事、她自己的事、想法、发言时的心情）和一样普通的，
  // 再看每个会话的卡片：标了私密的只能在写下它的会话，或者群里写下时在场的人的私聊里。
  const G1 = "telegram:-1";
  const G2 = "telegram:-2";
  const dm = (u: string) => `telegram:${u.slice(1)}`;
  const people = ["u1", "u2", "u3", "u4"];
  const chats = [G1, G2, ...people.map(dm)];
  const isGroup = (s: string) => s.startsWith("telegram:-");
  let n = 0;
  const msg = (at: number, scope: string, sender: string): AliceEvent => ({
    type: "message.received",
    at,
    scope,
    chatType: isGroup(scope) ? "group" : "private",
    messageId: `m${++n}`,
    senderId: sender,
    senderName: `人${sender}`,
    text: "嗯嗯",
    contentType: "text",
    replyToMessageId: null,
    directed: !isGroup(scope),
  });
  const MIN = 60_000;
  // 写下时：G1 里 u1、u2 说过话，G2 里 u3；u4 只在之后才进 G1。
  const opening = [
    msg(T, G1, "u1"),
    msg(T + MIN, G1, "u2"),
    msg(T + 2 * MIN, G2, "u3"),
    ...people.map((u, i) => msg(T + (3 + i) * MIN, dm(u), u)),
  ];
  const tag = (kind: string, scope: string) => `密${kind}${chats.indexOf(scope)}号`;
  const writes = chats.flatMap((scope, i): AliceEvent[] => {
    const at = T + (10 + i) * MIN;
    const about = isGroup(scope) ? (scope === G1 ? "u2" : "u3") : `u${scope.slice(9)}`;
    return [
      {
        type: "ponder.done",
        at,
        scope: "self",
        callId: `r${i}`,
        ponder: {
          kind: "reflect",
          scope,
          entries: [
            { about, text: `${tag("日记", scope)}的事`, importance: 9, private: true },
            { about: null, text: `普通日记${i}号的事`, importance: 5 },
          ],
          mood: { word: "紧张", why: `${tag("心情", scope)}的事`, valence: -0.3, private: true },
          learned: {
            facts: [
              {
                about,
                said: "嗯嗯",
                text: `${tag("事实", scope)}的事`,
                when: null,
                replaces: null,
                private: true,
              },
            ],
            self: [
              { said: "嗯嗯", text: `${tag("自述", scope)}的事`, replaces: null, private: true },
            ],
          },
        },
      },
      {
        type: "act.done",
        at: at + 1000,
        scope,
        act: { kind: "think", thought: `${tag("想法", scope)}的事`, secret: "私密" },
      },
      {
        type: "act.done",
        at: at + 2000,
        scope,
        act: { kind: "feel", mood: "担心", why: `${tag("发言心情", scope)}的事`, secret: "私密" },
        valence: -0.2,
      },
      { type: "act.done", at: at + 3000, scope, act: { kind: "think", thought: `普通想法${i}号` } },
    ];
  });
  const later = T + 40 * MIN;
  const after = [
    msg(later, G1, "u4"),
    ...people.flatMap((u, i) => [msg(later + i * 1000, G1, u), msg(later + i * 1000, G2, u)]),
    ...people.map((u, i) => msg(later + (10 + i) * 1000, dm(u), u)),
  ];
  const state = [...opening, ...writes, ...after].reduce(
    (s, e) => step(s, e, mechanisms).state,
    emptyState,
  );
  const at = later + MIN;
  const cards = chats.map((scope) => {
    const chat = state.chats[scope];
    if (!chat) throw new Error(`no ${scope}`);
    return {
      scope,
      text: renderSpeechPrompt("P", speechRequest(state, chat, at, null, mechanisms)).user,
    };
  });
  const allowed = (source: string, here: string) =>
    source === here ||
    (source === G1 && (here === dm("u1") || here === dm("u2"))) ||
    (source === G2 && here === dm("u3"));

  it("on every card, every private item is from that chat or from a group the person here was in", () => {
    const seen: string[] = [];
    for (const { scope, text } of cards) {
      for (const source of chats) {
        for (const kind of ["日记", "心情", "事实", "自述", "想法", "发言心情"]) {
          if (!text.includes(tag(kind, source))) continue;
          seen.push(`${kind} ${source} → ${scope}`);
          expect(allowed(source, scope), `${kind} from ${source} on ${scope}`).toBe(true);
        }
      }
    }
    // 不是空测：群里标了私密的确实到了当时在场的人的私聊。
    expect(seen.some((s) => s.endsWith(`${G1} → ${dm("u1")}`))).toBe(true);
  });

  it("ordinary ones do travel, to chats whose people were not there", () => {
    expect(cards.find((c) => c.scope === dm("u4"))?.text).toMatch(/普通(日记|想法)\d号/);
  });
});
