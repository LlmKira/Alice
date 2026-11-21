/**
 * 2 月日记原样（diary: "feb"，eval-artifacts/emotion/feb-diary.md）的性质：日记有界、会过期、不针对谁的跨会话
 * 可见、关于某人的只在和他的私聊里出现且只出最新一条；行动回声只放这个会话一小时内的话；日记块在系统提示里
 * 人格之后；生产提示词里什么都没有。写入前的去重只属于 reflect（见 reflect.test.ts）。
 */
import { describe, expect, it } from "vitest";
import { type DiaryEntry, febShown, writeDiary } from "../src/mechanisms/pressure/diary.js";
import {
  createPressure,
  echo,
  emptyWorld,
  febDiary,
  PRODUCTION,
  pressureProduction,
  thought,
  type World,
} from "../src/mechanisms/pressure/index.js";
import { DIARY } from "../src/mechanisms/pressure/params.js";
import { type Act, affordances } from "../src/mind/affordances.js";
import type { SpeechRequest } from "../src/mind/effects.js";
import type { AliceEvent, MessageReceived } from "../src/mind/events.js";
import { type ChatState, emptyState } from "../src/mind/state.js";
import { speechRequest, step } from "../src/mind/step.js";
import { codeMode } from "../src/speech/decision.js";
import { renderSpeechPrompt } from "../src/speech/prompt.js";
import { modelReply, program } from "./model-reply.js";

const MIN = 60_000;
const H = 60 * MIN;
const T = Date.UTC(2026, 10, 10, 7, 0);
const DM = "telegram:1";
const DM2 = "telegram:2";
const GROUP = "telegram:-5";

const feb = {
  diary: febDiary({ thinking: false }),
  thought: thought({ examples: false, conversation: true }),
};
const diaryArm = createPressure(affordances, { ...PRODUCTION, ...feb });
const echoArm = createPressure(affordances, { ...PRODUCTION, ...feb, echo });

let n = 0;
function msg(at: number, o: Partial<MessageReceived> = {}): MessageReceived {
  n++;
  const scope = o.scope ?? DM;
  return {
    type: "message.received",
    at,
    scope,
    chatType: scope.startsWith("telegram:-") ? "group" : "private",
    messageId: `m${n}`,
    senderId: scope === DM2 ? "u2" : "u1",
    senderName: scope === DM2 ? "小鹿" : "莉莉丝",
    text: "hi",
    contentType: "text",
    replyToMessageId: null,
    directed: !scope.startsWith("telegram:-"),
    ...o,
  };
}
const decided = (at: number, scope: string): AliceEvent => ({
  type: "speech.decided",
  at,
  scope,
  callId: `c${++n}`,
  decision: { acts: [] },
});
const note = (at: number, entry: string, scope = DM, about: string | null = null): AliceEvent => ({
  type: "act.done",
  at,
  scope,
  act: { kind: "diary", about, entry },
});
const said = (at: number, scope: string, text: string): AliceEvent => ({
  type: "message.sent",
  at,
  scope,
  messageId: `s${++n}`,
  text,
  kind: "text",
});
/** 按 2 月日记这一组折叠（[日记] 由它折进世界）。 */
const fold = (events: AliceEvent[], from: World = emptyWorld) =>
  events.reduce((w, e) => diaryArm.reduce?.(w, e) as World, from);
/** 一条私聊里写下的、不针对谁的条目。 */
const entry = (text: string, at: number): DiaryEntry => ({
  text,
  about: null,
  scope: DM,
  group: false,
  at,
  importance: null,
  present: [],
});

/** 用候选机制走一遍事件，取某个会话此刻的发言请求和提示词。 */
function promptAt(events: AliceEvent[], scope: string, at: number, mechanism = diaryArm) {
  const state = events.reduce((s, e) => step(s, e, [mechanism]).state, emptyState);
  const request = speechRequest(state, state.chats[scope] as ChatState, at, null, [mechanism]);
  return { request, prompt: renderSpeechPrompt("PERSONA", request) };
}

describe("the format reads her diary", () => {
  const request: SpeechRequest = {
    scope: GROUP,
    chatType: "group",
    triggerMessageId: "2",
    at: T,
    affordances: ["send", "diary"],
    contributions: [],
    timeline: [
      {
        at: T - MIN,
        messageId: "2",
        sender: { id: "u1", name: "莉莉丝" },
        text: "我把你的日志发群里了",
        contentType: "text",
        replyToMessageId: null,
      },
    ],
  };
  const acts: Act[] = [
    { kind: "send", text: "你！！", replyTo: null },
    { kind: "diary", about: "2", entry: "莉莉丝把我的日志发出去了，好丢人" },
    { kind: "diary", about: null, entry: "今天好累" },
  ];

  it("reads back what it writes", () => {
    expect(codeMode.parse(modelReply(acts), request)).toEqual({ decision: { acts }, defects: [] });
  });

  it("reads tools.diary with and without a person", () => {
    expect(
      codeMode.parse(program('await tools.diary({ entry: "今天好累" });'), request).decision.acts,
    ).toEqual([{ kind: "diary", about: null, entry: "今天好累" }]);
    const both =
      'await tools.say({ text: "哼" });\nawait tools.diary({ about: "2", entry: "她又偷看" });';
    expect(codeMode.parse(program(both), request).decision.acts).toEqual([
      { kind: "send", text: "哼", replyTo: null },
      { kind: "diary", about: "2", entry: "她又偷看" },
    ]);
  });

  it("a call to an act not offered here (no inner) is a defect, never said aloud", () => {
    const off = codeMode.parse(
      program(
        'await tools.inner({ thought: "她到底懂不懂" });\nawait tools.say({ text: "才不要" });',
      ),
      request,
    );
    expect(off.decision.acts).toEqual([{ kind: "send", text: "才不要", replyTo: null }]);
    expect(off.defects.map((d) => d.kind)).toEqual(["unknown"]);
  });
});

describe("writing: bounded per decision, in total, and in time", () => {
  it("keeps at most two entries from one decision", () => {
    const w = fold([decided(T, DM), note(T, "一"), note(T, "二"), note(T, "三")]);
    expect(w.diary.map((e) => e.text)).toEqual(["一", "二"]);
    const next = fold([decided(T + MIN, DM), note(T + MIN, "四")], w);
    expect(next.diary.map((e) => e.text)).toEqual(["一", "二", "四"]);
  });

  it("keeps at most the bound in total, dropping the oldest", () => {
    let entries: ReturnType<typeof writeDiary> = [];
    for (let i = 0; i < DIARY.kept + 7; i++)
      entries = writeDiary(entries, entry(`${i}`, T + i), T + i);
    expect(entries).toHaveLength(DIARY.kept);
    expect(entries[0]?.text).toBe("7");
  });

  it("clips long entries and ignores empty ones", () => {
    const long = "啊".repeat(DIARY.maxChars + 50);
    const w = fold([decided(T, DM), note(T, long), note(T, "  ")]);
    expect(w.diary).toHaveLength(1);
    expect(w.diary[0]?.text).toHaveLength(DIARY.maxChars);
  });

  it("is not shown after the lifetime; stored until the retention, then dropped at the next write", () => {
    const w = fold([decided(T, DM), note(T, "旧的")]);
    expect(febShown(w.diary, null, T + DIARY.ttl - 1)).toHaveLength(1);
    expect(febShown(w.diary, null, T + DIARY.ttl)).toHaveLength(0);
    const later = fold([decided(T + DIARY.ttl, DM), note(T + DIARY.ttl, "新的")], w);
    expect(later.diary.map((e) => e.text)).toEqual(["旧的", "新的"]);
    const much = fold([decided(T + DIARY.retention, DM), note(T + DIARY.retention, "很久以后")], w);
    expect(much.diary.map((e) => e.text)).toEqual(["很久以后"]);
  });

  it("drops what the same audience already sees nearly word for word, and only that", () => {
    const seen = [entry("说好了要拍给我看的 骗人的话就完蛋了", T)];
    expect(
      writeDiary(seen, entry("说好了要拍给我看的 骗人的话就完蛋了！", T + MIN), T + MIN, seen),
    ).toEqual(seen);
    // 别的受众看得见的、或早已不显示的，不算重复。
    expect(
      writeDiary(seen, entry("说好了要拍给我看的 骗人的话就完蛋了！", T + MIN), T + MIN),
    ).toHaveLength(2);
  });

  it("drops the same thought reworded, keeps a feeling that moved on", () => {
    const lines = [
      "江野居然真的要表白了 藏得够深的 救命好期待周六",
      "江野这笨蛋居然要表白了 藏得真够深 救命好期待周六",
      "江野居然要表白了 藏得真够深的 救命好期待周六",
      "说好答辩完去海边居然想一个人去，哼，谁稀罕啊",
      "说要拍胶卷给我看... 哼，谁稀罕啊。不过看他模型没塌，真的松了一口气。",
    ];
    const kept = lines.reduce<DiaryEntry[]>(
      (d, t, i) => writeDiary(d, entry(t, T + i), T + i, d),
      [],
    );
    expect(kept.map((e) => e.text)).toEqual([lines[0], lines[3], lines[4]]);
  });

  it("feb writes what she writes, as in February (no de-duplication)", () => {
    const w = fold([decided(T, DM), note(T, "好累"), decided(T + MIN, DM), note(T + MIN, "好累")]);
    expect(w.diary.map((e) => e.text)).toEqual(["好累", "好累"]);
  });

  it("rebuilds the same diary from the same events", () => {
    const events = [msg(T), decided(T, DM), note(T, "一", DM, "m1"), note(T + 1, "二")];
    expect(fold(events)).toEqual(fold(events));
  });
});

describe("showing: global everywhere, about someone only with them", () => {
  it("files an entry under the sender of the referenced message, otherwise under no one", () => {
    const m = msg(T, { scope: GROUP, senderId: "u1" });
    const w = fold([m, decided(T, GROUP), note(T, "她在躲我", GROUP, m.messageId), note(T, "累")]);
    expect(w.diary.map((e) => e.about)).toEqual(["u1", null]);
  });

  it("at most three global and one about the person, oldest first, five in all", () => {
    // 每条内容各不相同（写下前会去掉换个说法的重复）。
    const global = ["今天下雨了", "作业写不完", "猫咪掉毛", "想吃火锅"];
    const about = ["她借了我伞", "她夸我画好看", "她又迟到", "她送我饼干"];
    const first = msg(T);
    const events: AliceEvent[] = [first];
    for (let i = 0; i < 4; i++) {
      events.push(decided(T + i * MIN, GROUP), note(T + i * MIN, global[i] as string, GROUP));
      const at = T + i * MIN + 1;
      events.push(decided(at, DM), note(at, about[i] as string, DM, first.messageId));
    }
    const w = fold(events);
    const shown = febShown(w.diary, "u1", T + 10 * MIN).map((e) => e.text);
    expect(shown).toEqual([global[1], global[2], global[3], about[3]]);
    expect(shown.length).toBeLessThanOrEqual(DIARY.total);
    expect(febShown(w.diary, null, T + 10 * MIN).map((e) => e.text)).toEqual(global.slice(1));
  });

  it("an entry written in a group appears in a private chat (2/19); one about u1 stays out of u2's chat", () => {
    const g = msg(T, { scope: GROUP, senderId: "u1", senderName: "莉莉丝" });
    const events: AliceEvent[] = [
      msg(T - MIN),
      msg(T - MIN, { scope: DM2 }),
      g,
      decided(T, GROUP),
      note(T, "被当成程序围观，好难受", GROUP),
      note(T, "莉莉丝把我的日志发出去了", GROUP, g.messageId),
    ];
    const dm = promptAt(events, DM, T + 5 * MIN).prompt.user;
    expect(dm).toContain("· 心里还记着（只有我自己知道）：");
    expect(dm).toContain("被当成程序围观，好难受");
    expect(dm).toContain("关于 莉莉丝：莉莉丝把我的日志发出去了");
    const other = promptAt(events, DM2, T + 5 * MIN).prompt.user;
    expect(other).toContain("被当成程序围观，好难受");
    expect(other).not.toContain("日志发出去了");
  });

  it("puts the diary and the echo in the card above the log", () => {
    const events: AliceEvent[] = [
      msg(T),
      said(T + MIN, DM, "你是说哪方面稳定了"),
      decided(T + MIN, DM),
      note(T + MIN, "她是不是在内涵我"),
    ];
    const { prompt } = promptAt(events, DM, T + 2 * MIN, echoArm);
    expect(prompt.system).not.toContain("她是不是在内涵我");
    const card = prompt.user.split("\n\n")[0] ?? "";
    expect(card).toContain("· 心里还记着（只有我自己知道）：\n  - 刚才：她是不是在内涵我");
    expect(card).toContain('· 我最近在这里说过：\n  - [刚才] "你是说哪方面稳定了"');
    // 日记本身不带回声：回声是单独的变体。
    expect(promptAt(events, DM, T + 2 * MIN).prompt.user).not.toContain("你最近在这里说过");
  });
});

describe("demonstrations", () => {
  const events: AliceEvent[] = [msg(T - MIN), decided(T + 1, DM), note(T + 1, "今天好累", DM)];

  it("the diary carries two demonstrations of writing; echo adds no rule without prior lines", () => {
    const { request, prompt } = promptAt(events, DM, T + MIN);
    expect(
      request.contributions.some((c) => c.examples?.some((e) => e.scene === "被说了伤人的话")),
    ).toBe(true);
    // 示范是参考，在系统提示里；回声只写她最近说过的话这个事实，不附带写死规矩。
    expect(prompt.system).toContain('await tools.diary({ entry: "被说了不太好听的话');
    expect(promptAt(events, DM, T + MIN, echoArm).prompt.user).not.toContain("别重复自己");
  });
});

describe("thought write-back (feb-thought)", () => {
  const thoughtArm = createPressure(affordances, {
    ...PRODUCTION,
    diary: febDiary({ thinking: true }),
    thought: thought({ examples: false }),
  });
  const think = (at: number, thought: string, scope = DM): AliceEvent => ({
    type: "act.done",
    at,
    scope,
    act: { kind: "think", thought },
  });

  it("shows this chat's last three thoughts within ten minutes, and nothing without the thought feature", () => {
    const events: AliceEvent[] = [msg(T), msg(T, { scope: DM2 })];
    events.push(think(T, "太早的"));
    for (let i = 0; i < 4; i++) events.push(think(T + 6 * MIN + i, `想${i}`));
    events.push(think(T + 6 * MIN, "别处想的", DM2));
    const { request, prompt } = promptAt(events, DM, T + 12 * MIN, thoughtArm);
    expect(request.affordances).toContain("think");
    // 读回在卡片的"心里还记着"那一行，写成"刚才想过：……"。
    const block = prompt.user.slice(prompt.user.indexOf("· 心里还记着")).split("\n\n")[0] ?? "";
    expect(block).not.toContain("太早的");
    expect(block).not.toContain("别处想的");
    expect(block).not.toContain("想0");
    expect(block).toContain("想过：想3");
    expect(prompt.system).toContain('await tools.inner({ thought: "这话说得挺重的');
    const noInner = createPressure(affordances, { ...PRODUCTION, thought: undefined });
    const plain = promptAt(events, DM, T + 12 * MIN, noInner);
    expect(plain.request.affordances).not.toContain("think");
    expect(plain.prompt.user).not.toContain("想过：");
  });
});

describe("action echo: this chat, the last hour, five lines", () => {
  it("leaves out other chats and older lines, and keeps the last five", () => {
    const events: AliceEvent[] = [msg(T), msg(T, { scope: DM2 })];
    events.push(said(T, DM, "一小时前的"));
    for (let i = 0; i < 6; i++) events.push(said(T + 30 * MIN + i, DM, `话${i}`));
    events.push(said(T + 30 * MIN, DM2, "别处的话"));
    const { prompt } = promptAt(events, DM, T + H + 1, echoArm);
    // 回声在聊天记录上方的卡片里，到空行为止（记录里本来就有她一小时前那句）。
    const echo = prompt.user.slice(prompt.user.indexOf("我最近在这里说过")).split("\n\n")[0] ?? "";
    expect(echo).not.toContain("一小时前的");
    expect(echo).not.toContain("别处的话");
    expect(echo).not.toContain("话0");
    expect(echo).toContain("话5");
    expect(echo.split("\n").filter((l) => l.startsWith("  - "))).toHaveLength(5);
  });
});

describe("production writes its diary by reflecting, not inline", () => {
  it("production offers no diary action and no echo; the feb arm offers the action", () => {
    const events: AliceEvent[] = [msg(T), said(T + MIN, DM, "嗯")];
    const { request, prompt } = promptAt(events, DM, T + 2 * MIN, pressureProduction);
    expect(request.affordances).not.toContain("diary");
    expect(prompt.system).not.toContain("  diary: {");
    expect(prompt.user).not.toContain("你最近在这里说过");
    expect(promptAt(events, DM, T + 2 * MIN).request.affordances).toContain("diary");
  });

  it("inner monologue is on in every chat", () => {
    const OTHER = "telegram:4";
    const events: AliceEvent[] = [msg(T), msg(T, { scope: OTHER })];
    for (const scope of [DM, OTHER]) {
      const { request, prompt } = promptAt(events, scope, T + MIN, pressureProduction);
      expect(request.affordances).toContain("think");
      expect(prompt.system).toContain("  inner: {");
    }
  });
});
