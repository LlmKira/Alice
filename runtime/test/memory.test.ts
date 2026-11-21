/**
 * 压力场记忆（memory）的性质：她记得的事有界、可从日志重建、只给在场的人；她答应的事快到时候
 * 会推动一次跟进、做了或过期之后不再推；心情会消退；SDK 认得记下的动作；没有提供这些能力的机制时，
 * 提示词里不出现它们。
 */
import { describe, expect, it } from "vitest";
import {
  createPressure,
  emptyWorld,
  memory,
  rankIntentions,
  readChat,
  relation,
  type World,
} from "../src/mechanisms/pressure/index.js";
import {
  type Commitment,
  makeCommitment,
  prospectPressure,
} from "../src/mechanisms/pressure/memory.js";
import { FACTS_PER_SUBJECT } from "../src/mechanisms/pressure/params.js";
import { learnFact } from "../src/mechanisms/pressure/people.js";
import { BARE_WILL } from "../src/mechanisms/pressure/will.js";
import { type Act, affordances } from "../src/mind/affordances.js";
import type { SpeechRequest } from "../src/mind/effects.js";
import type { AliceEvent, MessageReceived } from "../src/mind/events.js";
import { type ChatState, emptyChat, emptyState } from "../src/mind/state.js";
import { speechRequest, step } from "../src/mind/step.js";
import { parseWhen } from "../src/mind/when.js";
import { replay } from "../src/sim/replay.js";
import { codeMode } from "../src/speech/decision.js";
import { renderSpeechPrompt } from "../src/speech/prompt.js";
import { modelReply, program } from "./model-reply.js";

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
/** 2026-11-10 周二 15:00（东八区）。 */
const T = Date.UTC(2026, 10, 10, 7, 0);
/** 东八区某日某刻。 */
const local = (month: number, day: number, hour: number, minute = 0, year = 2026) =>
  Date.UTC(year, month - 1, day, hour - 8, minute);

const DM = "telegram:1";
const GROUP = "telegram:-5";

/** 只有意愿层的压力场，和只多一样记忆的压力场（名字由组成拼出：pressure、pressure-memory）。 */
const pressure = createPressure(affordances);
/** 记忆加上按人记的关系：最近几次开口的结果要写是谁（relation 折出名字和有来往）。 */
const pressureMemory = createPressure(affordances, { memory, relation });

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
    senderId: "u1",
    senderName: "池塘",
    text: "hi",
    contentType: "text",
    replyToMessageId: null,
    directed: !scope.startsWith("telegram:-"),
    ...o,
  };
}
const sent = (at: number, scope = DM, messageId = `s${++n}`): AliceEvent => ({
  type: "message.sent",
  at,
  scope,
  messageId,
  text: "嗯",
  kind: "text",
});
const done = (at: number, act: Act, scope = DM): AliceEvent => ({
  type: "act.done",
  at,
  scope,
  act,
});
/** 按记忆这一组的折叠（她心里记下的事由记忆折进世界）。 */
const fold = (events: AliceEvent[], from: World = emptyWorld) =>
  events.reduce((w, e) => pressureMemory.reduce?.(w, e) as World, from);

function chatState(scope: string, timeline: Array<[id: string, name: string]>): ChatState {
  return {
    ...emptyChat(scope, scope.startsWith("telegram:-") ? "group" : "private", true),
    timeline: timeline.map(([id, name], i) => ({
      at: T + i,
      messageId: `t${i}`,
      sender: { id, name },
      text: "…",
      contentType: "text",
      replyToMessageId: null,
    })),
  };
}
const texts = (world: World, chat: ChatState, now: number) =>
  (memory.contribute?.({ world, chat, now, sought: true, outside: false, offered: [] }) ?? [])
    .map((c) => c.text)
    .join("\n");

describe("when: her own words for a time become a deterministic window", () => {
  it("reads day words, weekdays, dates and durations in UTC+8", () => {
    expect(parseWhen("明天", T)).toEqual({ from: local(11, 11, 9), due: local(11, 11, 21) });
    expect(parseWhen("明天下午3点", T)).toEqual({
      from: local(11, 11, 14),
      due: local(11, 11, 15),
    });
    expect(parseWhen("今晚", T)).toEqual({ from: local(11, 10, 19), due: local(11, 10, 23) });
    // 只说时段是今天；"晚一点"是待会儿，不是一点钟。
    expect(parseWhen("晚上", T)).toEqual(parseWhen("今晚", T));
    expect(parseWhen("下午4点", T)?.due).toBe(local(11, 10, 16));
    expect(parseWhen("晚一点", T)).toEqual({ from: T + H / 2, due: T + 2 * H });
    expect(parseWhen("周五", T)?.due).toBe(local(11, 13, 21));
    // 今天是周二：说"周一"指下一个周一，"下周三晚上"是下周。
    expect(parseWhen("周一", T)?.due).toBe(local(11, 16, 21));
    expect(parseWhen("下周三晚上", T)).toEqual({
      from: local(11, 18, 19),
      due: local(11, 18, 23),
    });
    expect(parseWhen("周末", T)).toEqual({ from: local(11, 14, 9), due: local(11, 15, 21) });
    expect(parseWhen("下周", T)).toEqual({ from: local(11, 16, 9), due: local(11, 22, 21) });
    expect(parseWhen("11月20日", T)?.due).toBe(local(11, 20, 21));
    // 今年的这一天已经过了：指明年。
    expect(parseWhen("1月3号", T)?.due).toBe(local(1, 3, 21, 0, 2027));
    expect(parseWhen("两小时后", T)).toEqual({ from: T + H, due: T + 2 * H });
    expect(parseWhen("3天后", T)?.due).toBe(local(11, 13, 21));
  });

  it("returns no time for words it does not know, so there is no deadline", () => {
    for (const vague of ["改天", "过阵子", "有空的时候", "2月30日", "明天发你", ""]) {
      expect(parseWhen(vague, T)).toBeNull();
    }
  });
});

describe("the format reads her notes to herself", () => {
  const request: SpeechRequest = {
    scope: GROUP,
    chatType: "group",
    triggerMessageId: "2",
    at: T,
    affordances: ["send", "react", "intend", "fulfil", "feel"],
    contributions: [],
    timeline: [
      {
        at: T - MIN,
        messageId: "2",
        sender: { id: "u2", name: "小雨" },
        text: "我养了只猫，叫煤球",
        contentType: "text",
        replyToMessageId: null,
      },
    ],
  };
  const notes: Act[] = [
    { kind: "send", text: "好可爱", replyTo: null },
    { kind: "intend", when: "明天", what: "问问煤球的照片" },
    { kind: "intend", when: null, what: "给他推荐那本书" },
    { kind: "feel", mood: "开心", why: null },
    { kind: "feel", mood: "期待", why: "想看猫" },
    { kind: "fulfil", what: "问问煤球的照片" },
  ];

  it("reads back what it writes", () => {
    expect(codeMode.parse(modelReply(notes), request)).toEqual({
      decision: { acts: notes },
      defects: [],
    });
  });

  // 第 34 件以前词表外的心情（"emo"）是格式缺陷；现在是她自己的词，照样记下。空的才是缺陷。
  it("keeps colons and clock times in the text, and a mood in her own words is kept; an empty one is a defect", () => {
    const code = [
      'await tools.intend({ when: "明天15:30", what: "问问煤球：它的照片" });',
      'await tools.feel({ mood: "emo" });',
      'await tools.feel({ mood: "" });',
    ].join("\n");
    const parsed = codeMode.parse(program(code), request);
    expect(parsed.decision.acts).toEqual([
      { kind: "intend", when: "明天15:30", what: "问问煤球：它的照片" },
      { kind: "feel", mood: "emo", why: null },
    ]);
    expect(parsed.defects.map((d) => d.kind)).toEqual(["args"]);
  });

  it("does not offer or act on them when no mechanism provides them", () => {
    const plain = { ...request, affordances: request.affordances.filter((k) => k === "send") };
    const code =
      'await tools.intend({ when: "明天", what: "看猫" });\nawait tools.say({ text: "好" });';
    const parsed = codeMode.parse(program(code), plain);
    expect(parsed.decision.acts).toEqual([{ kind: "send", text: "好", replyTo: null }]);
    expect(parsed.defects.map((d) => d.kind)).toEqual(["unknown"]);
    expect(renderSpeechPrompt("p", plain).system).not.toMatch(/ {2}(feel|intend): /);
    expect(renderSpeechPrompt("p", request).system).toMatch(/ {2}intend: /);
  });

  it("only the memory candidate puts them in the request", () => {
    const events = [msg(T)];
    const stateWith = (m: typeof pressure) =>
      events.reduce((s, e) => step(s, e, [m]).state, emptyState);
    const offered = (m: typeof pressure) => {
      const s = stateWith(m);
      return speechRequest(s, s.chats[DM] as ChatState, T, null, [m]).affordances;
    };
    expect(offered(pressure)).not.toContain("intend");
    expect(offered(pressureMemory)).toContain("intend");
    // 心情不是记忆的：[心情] 由 affect 给（她只有一份心情）。
    expect(offered(pressureMemory)).not.toContain("feel");
  });
});

/** 反思记下关于 subject 的一件事（people.ts learnFact），在 scope 里、当时在场的是 present。 */
const learn = (
  w: World,
  subject: string,
  text: string,
  scope = DM,
  at = T,
  present: string[] = [subject],
  secret = false,
): World => ({
  ...w,
  facts: {
    ...w.facts,
    [subject]: learnFact(
      w.facts[subject],
      { text, when: null, replaces: null, ...(secret ? { private: true as const } : {}) },
      scope,
      present,
      at,
    ),
  },
});

describe("facts: bounded, shown only for people present", () => {
  it("keeps at most the bound per person, dropping the least retrievable, and reinforces repeats", () => {
    let w = fold([msg(T)]);
    for (let i = 0; i < 30; i++) {
      w = learn(w, "u1", `第 ${i} 件事`, DM, T + i * D);
      // 最早那件时不时又被记一次：是强化，不是新的一条，它也因此留下。
      if (i % 5 === 4) w = learn(w, "u1", "第 0 件事。", DM, T + i * D);
    }
    const facts = w.facts.u1 ?? [];
    expect(facts).toHaveLength(FACTS_PER_SUBJECT);
    expect(facts.map((f) => f.text)).toContain("第 0 件事。");
    expect(facts.find((f) => f.key === "第0件事")?.count).toBe(7);
    expect(facts.map((f) => f.text)).toContain("第 29 件事");
    expect(facts.map((f) => f.text)).not.toContain("第 1 件事");
  });

  it("rebuilds the same memory from the same events", async () => {
    const events: AliceEvent[] = [
      msg(T),
      done(T, { kind: "intend", when: "明天", what: "给他发歌单" }),
      done(T, { kind: "feel", mood: "开心", why: null }),
      msg(T + 2 * D, { scope: "telegram:2", senderId: "u9" }),
    ];
    const run = () =>
      replay(events, { mechanisms: [pressureMemory], speech: () => ({ acts: [] }), tickMs: H });
    const [a, b] = [await run(), await run()];
    expect(a.state.mechanisms[pressureMemory.name]).toEqual(
      b.state.mechanisms[pressureMemory.name],
    );
    const world = a.state.mechanisms[pressureMemory.name] as World;
    expect(world.chats[DM]?.commitments.open.map((c) => c.text)).toEqual(["给他发歌单"]);
  });

  it("speaks only of the people in the room; private things stay out of groups", () => {
    let w = fold([
      msg(T, { scope: "telegram:2", senderId: "u2", senderName: "小雨" }),
      msg(T, { scope: GROUP, senderId: "u2", senderName: "小雨", messageId: "g8" }),
      msg(T, { scope: GROUP, senderId: "u3", senderName: "阿青", messageId: "g9" }),
      msg(T, { senderId: "u1" }),
    ]);
    // 失恋是明显私密的事：反思时她标了私密（PLAN 第 33 件，只有这样的守受众规则）。
    w = learn(w, "u2", "最近失恋了", "telegram:2", T, ["u2"], true);
    w = learn(w, "u2", "在玩原神", GROUP, T, ["u2", "u3"]);
    w = learn(w, "u3", "在杭州", GROUP, T, ["u2", "u3"]);
    w = learn(w, "u1", "喜欢猫");
    w = learn(w, "u2", "下周搬家", "telegram:2");
    const group = texts(
      w,
      chatState(GROUP, [
        ["u2", "小雨"],
        ["u4", "路人"],
      ]),
      T + H,
    );
    expect(group).toContain("小雨：在玩原神");
    expect(group).not.toContain("失恋"); // 私聊里知道的私密的事不进群
    expect(group).toContain("小雨：下周搬家（和小雨私聊时知道的）"); // 平常的事带过来，注明出处
    expect(group).not.toContain("在杭州"); // 阿青不在场
    expect(group).not.toContain("喜欢猫");
    const dm = texts(w, chatState(DM, [["u1", "池塘"]]), T + H);
    expect(dm).toContain("我记得关于池塘的事：\n- 喜欢猫");
    expect(dm).not.toMatch(/失恋|杭州/);
    // 私聊里放这个私聊里知道的，和他在场时在群里知道的（注明出处）。
    const other = texts(w, chatState("telegram:2", [["u2", "小雨"]]), T + H);
    expect(other).toContain("- 在玩原神（在一个群里知道的）");
    expect(other).toContain("- 最近失恋了");
  });
});

describe("commitments: P_prospect drives a follow-up near the due time, then stops", () => {
  const tiers = () => 500 as const;
  const deliberate = affordances.filter((a) => a.deliberate);
  /** 一个弱关系的私聊：她已经回过话，没有未读、义务，冷却也几乎为 0。 */
  const base = (withPromise: boolean) =>
    fold([
      msg(T - MIN),
      sent(T),
      ...(withPromise ? [done(T, { kind: "intend", when: "明天", what: "给他发歌单" })] : []),
    ]);
  const sendNsv = (w: World, now: number) =>
    rankIntentions(w, deliberate, now, { ...BARE_WILL, tiers }).find(
      (i) => i.scope === DM && i.affordance === "send",
    )?.nsv ?? Number.NaN;

  it("is near zero long before, rises through the window, and is bounded", () => {
    const [c] = base(true).chats[DM]?.commitments.open ?? [];
    expect(c?.start).toBe(local(11, 11, 9));
    expect(c?.due).toBe(local(11, 11, 21));
    const p = (at: number) => prospectPressure([c as Commitment], at);
    expect(p(T + H)).toBeLessThan(0.01);
    expect(p(local(11, 11, 9))).toBeLessThan(0.2);
    expect(p(local(11, 11, 18))).toBeGreaterThan(1.2);
    expect(p(local(11, 11, 22))).toBeLessThanOrEqual(2);
    expect(p((c as Commitment).expireAt)).toBe(0);
  });

  it("makes reaching out worth it near the due time and not before; the control never does", () => {
    const promised = base(true);
    const control = base(false);
    for (const at of [T + H, T + 12 * H, local(11, 11, 9)]) {
      expect(sendNsv(promised, at)).toBeLessThanOrEqual(0);
    }
    for (const at of [local(11, 11, 17), local(11, 11, 20), local(11, 11, 23)]) {
      expect(sendNsv(promised, at)).toBeGreaterThan(0);
      expect(sendNsv(control, at)).toBeLessThanOrEqual(0);
    }
  });

  it("is done when she says so: outcome done, pressure gone", () => {
    const w = fold(
      [sent(local(11, 11, 18)), done(local(11, 11, 18), { kind: "fulfil", what: "歌单" })],
      base(true),
    );
    const node = w.chats[DM];
    expect(node?.commitments.open).toEqual([]);
    expect(node?.commitments.closed.map((c) => c.outcome)).toEqual(["done"]);
    expect(readChat(w, DM, local(11, 11, 20))?.raw.prospect).toBe(0);
    expect(sendNsv(w, local(11, 11, 20))).toBeLessThanOrEqual(0);
  });

  it("speaking there at the due time is not doing it: the pressure only regrows", () => {
    const w = fold([sent(T + MIN), sent(local(11, 11, 8)), sent(local(11, 11, 18))], base(true));
    expect(w.chats[DM]?.commitments.open).toHaveLength(1);
    const p = (x: World, at: number) => readChat(x, DM, at)?.raw.prospect ?? 0;
    expect(p(w, local(11, 11, 18) + 10 * MIN)).toBeLessThan(p(base(true), local(11, 11, 18)) / 4);
    expect(p(w, local(11, 11, 21))).toBeGreaterThan(p(w, local(11, 11, 18) + 10 * MIN));
  });

  it("a promise made in a group can be done in a private chat", () => {
    const w = fold([
      msg(T, { scope: GROUP, senderId: "u2", messageId: "g1" }),
      done(T, { kind: "intend", when: "明天", what: "私聊发你照片" }, GROUP),
      msg(T, { senderId: "u2" }),
      done(local(11, 11, 12), { kind: "fulfil", what: "发你照片" }),
    ]);
    expect(w.chats[GROUP]?.commitments.closed.map((c) => c.outcome)).toEqual(["done"]);
  });

  it("one squeezed out by newer plans is not told as a missed promise", () => {
    const events: AliceEvent[] = [msg(T)];
    for (let i = 0; i < 6; i++) {
      events.push(done(T, { kind: "intend", when: "下周", what: `第 ${i} 件` }));
    }
    const w = fold(events);
    expect(w.chats[DM]?.commitments.closed.map((c) => c.outcome)).toEqual(["expired"]);
    expect(texts(w, chatState(DM, [["u1", "池塘"]]), T + H)).not.toContain("第 0 件");
  });

  it("expires after the grace period: pressure stops and the lapse is remembered for a while", () => {
    const w = base(true);
    const [c] = w.chats[DM]?.commitments.open ?? [];
    const after = (c as Commitment).expireAt + MIN;
    expect(readChat(w, DM, after)?.raw.prospect).toBe(0);
    expect(sendNsv(w, after)).toBeLessThanOrEqual(0);
    const later = fold([msg(after + H), sent(after + 2 * H)], w);
    expect(later.chats[DM]?.commitments.closed.map((x) => [x.outcome, x.closedAt])).toEqual([
      ["expired", (c as Commitment).expireAt],
    ]);
    expect(texts(later, chatState(DM, [["u1", "池塘"]]), after + 3 * H)).toContain(
      "给他发歌单（约的时间过了，我没记下做完）",
    );
    expect(texts(later, chatState(DM, [["u1", "池塘"]]), after + 3 * D)).not.toContain("歌单");
  });

  it("renews the same promise instead of piling it up", () => {
    const w = fold(
      [done(T + H, { kind: "intend", when: "后天", what: "给他发歌单。" })],
      base(true),
    );
    const node = w.chats[DM];
    expect(node?.commitments.open).toHaveLength(1);
    expect(node?.commitments.open[0]?.due).toBe(local(11, 12, 21));
    expect(node?.commitments.closed.map((c) => c.outcome)).toEqual(["renewed"]);
  });

  it("an undated plan has no deadline pressure and fades after its lifetime", () => {
    const w = fold([msg(T), done(T, { kind: "intend", when: "改天", what: "一起打游戏" })]);
    const [c] = w.chats[DM]?.commitments.open ?? [];
    expect(c?.due).toBeNull();
    expect(prospectPressure([c as Commitment], T + 3 * D)).toBe(0);
    expect(texts(w, chatState(DM, [["u1", "池塘"]]), T + D)).toContain("一起打游戏（没说什么时候");
    expect(texts(w, chatState(DM, [["u1", "池塘"]]), T + 8 * D)).not.toContain("打游戏");
  });

  it("in the closed loop: the will wakes the chat near the due time, once, and not after it is done", async () => {
    // 群里有人点名她，她答应"明天"把照片发群里；之后群里没人说话（群聊存在感不增长），
    // 所以接下来能叫醒她的只有这件事。
    const promise: Act = { kind: "intend", when: "明天", what: "把照片发群里" };
    const run = (variant: "follow" | "decline" | "control") =>
      replay(
        [
          msg(T, { scope: GROUP, senderId: "u2", senderName: "小雨", directed: true }),
          msg(T + 3 * D, { scope: "telegram:-9", senderId: "u5" }),
        ],
        {
          mechanisms: [pressureMemory],
          tickMs: 10 * MIN,
          speech: (request) => {
            if (request.triggerMessageId) {
              return {
                acts: [
                  { kind: "send", text: "好", replyTo: null },
                  ...(variant === "control" ? [] : [promise]),
                ],
              };
            }
            return variant === "follow"
              ? {
                  acts: [
                    { kind: "send", text: "照片来啦", replyTo: null },
                    { kind: "fulfil", what: "照片" },
                  ],
                }
              : { acts: [] };
          },
        },
      ).then((r) =>
        r.effects
          .filter((e) => e.effect.type === "call-speech" && e.effect.scope === GROUP)
          .map((e) => e.at),
      );
    const c = makeCommitment(promise as Extract<Act, { kind: "intend" }>, T);

    const control = await run("control");
    expect(control).toEqual([T]);

    const follow = await run("follow");
    expect(follow).toHaveLength(2);
    expect(follow[1]).toBeGreaterThanOrEqual(c.start as number);
    expect(follow[1]).toBeLessThanOrEqual(c.due as number);

    // 一直决定先不：还会再想，但间隔拉开；过期之后不再被这件事叫醒。
    const decline = await run("decline");
    const asks = decline.slice(1);
    expect(asks.length).toBeGreaterThan(1);
    expect(asks.length).toBeLessThan(12);
    for (let i = 1; i < asks.length; i++) {
      expect((asks[i] as number) - (asks[i - 1] as number)).toBeGreaterThanOrEqual(30 * MIN);
    }
    expect(asks.every((at) => at < c.expireAt)).toBe(true);
  });
});

describe("how her last turns here went (M33)", () => {
  it("tells her who reacted and that her outreach went unanswered", () => {
    const w = fold([
      msg(T - D),
      sent(T - D + MIN, DM, "s-a"),
      // 第二天她主动找他（没人找她），他一天没回。
      sent(T + H, DM, "s-b"),
      msg(T + 2 * D, { scope: "telegram:2", senderId: "u9" }),
      msg(T + 2 * D + MIN),
      sent(T + 2 * D + 2 * MIN, DM, "s-c"),
      {
        type: "reaction.received",
        at: T + 2 * D + 3 * MIN,
        scope: DM,
        messageId: "s-c",
        senderId: "u1",
        emoji: "👍",
      },
    ]);
    // 时间线从第三天他那条开始：第二天她主动找他的那句已经滚出去了。
    const chat = chatState(DM, [["u1", "池塘"]]);
    const shown = { ...chat, timeline: chat.timeline.map((e) => ({ ...e, at: T + 2 * D + MIN })) };
    const text = texts(w, shown, T + 2 * D + H);
    expect(text).toContain("我最近几次在这里开口：");
    expect(text).toMatch(/池塘给我点了个👍/);
    expect(text).toMatch(/我主动找他，他没回/);
  });

  it("does not repeat a turn the timeline still shows; once it scrolls out the card says how it went", () => {
    // 群里她说了一句，别人接着聊别的，10 分钟窗口过了：没人接她的话（线上 81 行里 26 行就在时间线上）。
    const w = fold([
      msg(T, { scope: GROUP, senderId: "u2" }),
      sent(T + MIN, GROUP, "s-g"),
      msg(T + 4 * MIN, { scope: GROUP, senderId: "u2" }),
      msg(T + 15 * MIN, { scope: GROUP, senderId: "u3" }),
    ]);
    const timeline = (from: number): ChatState => ({
      ...emptyChat(GROUP, "group", true),
      timeline: [T, T + MIN, T + 4 * MIN, T + 15 * MIN]
        .filter((at) => at >= from)
        .map((at) => ({
          at,
          messageId: String(at),
          sender: at === T + MIN ? null : { id: "u2", name: "阿杰" },
          text: "…",
          contentType: "text",
          replyToMessageId: null,
        })),
    });
    const now = T + 16 * MIN;
    expect(texts(w, timeline(T), now)).not.toContain("没人接我的话");
    expect(texts(w, timeline(T + 4 * MIN), now)).toContain("没人接我的话");
  });
});
