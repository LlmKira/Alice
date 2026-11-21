import { describe, expect, it } from "vitest";
import { createDesire } from "../src/mechanisms/pressure/desire.js";
import {
  createPressure,
  PRODUCTION,
  recallTools,
  topics,
} from "../src/mechanisms/pressure/index.js";
import { createLifeBody } from "../src/mechanisms/pressure/life-body.js";
import { SELF_SUBJECT } from "../src/mechanisms/pressure/people.js";
import type { World } from "../src/mechanisms/pressure/world.js";
import { affordances } from "../src/mind/affordances.js";
import type { LifeDayRequest } from "../src/mind/effects.js";
import type { AliceEvent } from "../src/mind/events.js";
import { emptyState } from "../src/mind/state.js";
import { step } from "../src/mind/step.js";
import { createFold, Shell } from "../src/shell.js";
import { auditLongRun } from "../src/sim/long-audit.js";
import { arms } from "../src/sim/will-arms.js";
import { parseLifeDay, renderLifeDayPrompt } from "../src/speech/life-day.js";

const MIN = 60_000;
const H = 60 * MIN;
const OFFSET_MS = 8 * H;
const local = (day: number, h: number, m = 0) => Date.UTC(2026, 10, day, h, m) - OFFSET_MS;

const DM_A = "telegram:101";
const DM_B = "telegram:202";

const dreamMind = createPressure(affordances, {
  ...PRODUCTION,
  sleep: undefined,
  life: createLifeBody({ busyMode: "phi-half", dailyContent: true, dream: true }),
  desire: createDesire({ dreamFeed: true }),
  topics,
  recallTools,
});

describe("sleep dream -> endogenous desire & PTC self-coherence", () => {
  it("generates a chat-isolated dream ponder during sleep and turns curiosities into endogenous desire", () => {
    const tNight = local(14, 23, 50);
    let state = emptyState;
    // 先经历一段真实的私聊与群聊（含真实用户名，验证绝不进 dream 请求）
    state = step(
      state,
      {
        type: "message.received",
        at: tNight - 2 * H,
        scope: DM_A,
        chatType: "private",
        messageId: "m1",
        senderId: "u1",
        senderName: "阿明",
        text: "今晚看动画了吗",
        contentType: "text",
        replyToMessageId: null,
        directed: true,
      },
      [dreamMind],
    ).state;
    state = step(
      state,
      { type: "noise.drawn", at: tNight, scope: "self", draws: { life: 0, "life-length": 0 } },
      [dreamMind],
    ).state;
    // 去睡
    state = step(
      state,
      { type: "act.done", at: tNight + 5 * MIN, scope: DM_A, act: { kind: "bed" } },
      [dreamMind],
    ).state;

    // 睡着 35 分钟后触发睡眠期 dream ponder
    const tick = step(state, { type: "clock.tick", at: tNight + 40 * MIN }, [dreamMind]);
    state = tick.state;
    const ask = tick.effects.find((e) => e.type === "call-ponder");
    expect(ask).toBeDefined();
    if (!ask || ask.type !== "call-ponder" || ask.request.kind !== "life") {
      throw new Error("expected dream life ponder");
    }
    const req: LifeDayRequest = ask.request;
    expect(req.dream?.moodHint).toBeDefined();
    const prompt = renderLifeDayPrompt("你是 Alice。", req);
    expect(prompt.system).toContain("做梦复盘");
    expect(`${prompt.system}\n${prompt.user}`).not.toContain("阿明");

    // 梦里长出一个好奇点："芙莉莲"，第二天白天对话聊到动画/芙莉莲时直接触发内生分享欲
    const parsed = parseLifeDay(
      JSON.stringify({
        activities: { watch: "《葬送的芙莉莲》", meal: "葱油拌面" },
        moments: [{ hour: 11, text: "早起煮咖啡忘了放滤纸" }],
        ongoing: ["追《葬送的芙莉莲》"],
        curiosities: [
          { topic: "芙莉莲 时间", hook: "昨天看到芙莉莲说人类生命短暂那段突然好有感触" },
        ],
      }),
      req,
    );
    expect(parsed.curiosities).toHaveLength(1);

    state = step(
      state,
      {
        type: "ponder.done",
        at: tNight + 41 * MIN,
        scope: "self",
        callId: ask.callId,
        ponder: parsed,
      },
      [dreamMind],
    ).state;

    const world = state.mechanisms[dreamMind.name] as World;
    expect(
      world.posts?.items.some((i) => i.scope === "self:dream" && i.title.includes("芙莉莲")),
    ).toBe(true);
  });

  it("executes tools.recall and tools.note_self inline in Shell PTC while enforcing privacy boundaries", async () => {
    const mechs = arms({}).production;
    if (!mechs) throw new Error("missing production arm");
    const events: AliceEvent[] = [];
    const t0 = local(14, 14, 0);
    // 在 DM_B 收到一条她标为私密的日记，在 DM_A 记下普通日记 + 自我习惯 + 话头 + 承诺 + 日程
    const seed: AliceEvent[] = [
      {
        type: "message.received",
        at: t0,
        scope: DM_B,
        chatType: "private",
        messageId: "b1",
        senderId: "u2",
        senderName: "小红",
        text: "其实我下周要去做一个小手术，先别跟别人说",
        contentType: "text",
        replyToMessageId: null,
        directed: true,
      },
      {
        type: "ponder.done",
        at: t0 + MIN,
        scope: "self",
        callId: "r-b",
        ponder: {
          kind: "reflect",
          scope: DM_B,
          entries: [
            { about: "u2", text: "小红下周要去做手术，让我保密", importance: 8, private: true },
          ],
        },
      },
      {
        type: "message.received",
        at: t0 + 2 * MIN,
        scope: DM_A,
        chatType: "private",
        messageId: "a1",
        senderId: "u1",
        senderName: "阿明",
        text: "最近在读什么书呀",
        contentType: "text",
        replyToMessageId: null,
        directed: true,
      },
      {
        type: "ponder.done",
        at: t0 + 3 * MIN,
        scope: "self",
        callId: "r-a",
        ponder: {
          kind: "reflect",
          scope: DM_A,
          entries: [{ about: "u1", text: "阿明最近也在看科幻小说", importance: 6 }],
          learned: {
            self: [{ said: "喜欢喝美式", text: "平时只喝冰美式", replaces: null }],
          },
        },
      },
      {
        type: "ponder.done",
        at: t0 + 4 * MIN,
        scope: "self",
        callId: "l-1",
        ponder: {
          kind: "life",
          date: "2026-11-14",
          activities: { read: "《沙丘》" },
          moments: [{ hour: 11, text: "把猫薄荷洒了一地" }],
          ongoing: ["在看《沙丘》"],
        },
      },
    ];
    const fold = createFold(mechs);
    for (const e of seed) fold.feed(e);

    let now = t0 + 15 * MIN;
    let recalledJson = "";
    const timers: Array<() => void> = [];
    const shell = new Shell(
      {
        now: () => now,
        append: (e) => events.push(e),
        journaled: () => {},
        schedule: (_ms, fire) => {
          timers.push(fire);
          return () => {};
        },
        callModel: async () =>
          JSON.stringify({
            content: "",
            calls: [
              {
                name: "run_code",
                arguments: JSON.stringify({
                  code: [
                    'const mem = await tools.recall({ query: "" });',
                    "const hasPrivate = mem.diary.some((d) => d.text.includes('手术'));",
                    "const hasPublic = mem.diary.some((d) => d.text.includes('科幻'));",
                    "const book = mem.schedule?.activities?.read ?? '';",
                    'await tools.note_self({ text: "现在改喝热拿铁了", replaces: "平时只喝冰美式" });',
                    'await tools.open_topic({ title: "一起聊《沙丘》" });',
                    'await tools.say({ text: "翻到：" + hasPublic + "/" + hasPrivate + "/" + book });',
                  ].join("\n"),
                }),
              },
            ],
          }),
        act: async () => ({ kind: "posted", messageId: "out-1" }),
        background: async () => ({ result: "" }),
        log: () => {},
        fatal: (err) => {
          throw err;
        },
        paused: () => false,
      },
      mechs,
      "你是 Alice。",
      fold.result(),
    );

    shell.dispatch({
      type: "message.received",
      at: now,
      scope: DM_A,
      chatType: "private",
      messageId: "a2",
      senderId: "u1",
      senderName: "阿明",
      text: "你记得我们聊过啥不",
      contentType: "text",
      replyToMessageId: null,
      directed: true,
    });
    now += 20_000;
    for (const fire of timers) fire();
    await new Promise((r) => setTimeout(r, 30));
    await shell.stop();
    const decided = events.find((e) => e.type === "speech.decided");
    expect(decided).toBeDefined();
    if (decided && decided.type === "speech.decided") {
      const sayAct = decided.decision.acts.find((a) => a.kind === "send");
      recalledJson = sayAct && sayAct.kind === "send" ? sayAct.text : "";
    }
    // 验证：公开日记与日程查到了，DM_B 的私密日记绝不泄漏到 DM_A！
    expect(recalledJson).toBe("翻到：true/false/《沙丘》");
    // 验证：note_self 与 open_topic 都已经折叠进最终状态
    const mechState = shell.current.mechanisms[mechs[0].name] as World;
    expect(mechState.facts[SELF_SUBJECT]?.map((f) => f.text)).toContain("现在改喝热拿铁了");
    expect(mechState.facts[SELF_SUBJECT]?.map((f) => f.text)).not.toContain("平时只喝冰美式");
    expect(mechState.chats[DM_A]?.topics.map((t) => t.title)).toContain("一起聊《沙丘》");

    const audit = auditLongRun([...seed, ...events], []);
    expect(audit.lifeDays).toBe(1);
    expect(audit.lifeLeaks).toEqual([]);
    expect(audit.recalls).toBe(1);
    expect(audit.selfNotes).toBe(1);
    expect(audit.selfReplacements).toBe(1);
    expect(audit.topicOpens).toBe(1);
  });
});
