/**
 * 生产的 context-v2（eval-artifacts/context/gemini/out.md）每一样都送到了提示词里：card layout 的卡片、两行的回合 anchor、
 * 怎么写的一行规矩、参考里并进去的第一反应、生活和心情的写法、日记的筛法、示例池、不算机器人的 familiar。
 */
import { User } from "@mtcute/node";
import { describe, expect, it } from "vitest";
import { decodeEvent } from "../src/journal.js";
import { familiar } from "../src/mechanisms/familiar.js";
import { REGISTERS, said } from "../src/mechanisms/palette.js";
import { POOL } from "../src/mechanisms/palette-pool.js";
import { initialAffect, moodOf } from "../src/mechanisms/pressure/affect.js";
import { DIARY_VIEW, type DiaryEntry, rankedShown } from "../src/mechanisms/pressure/diary.js";
import { emptyLife, type LifeState, lifeFacts } from "../src/mechanisms/pressure/life.js";
import { mechanisms } from "../src/mechanisms/registry.js";
import type { SpeechRequest } from "../src/mind/effects.js";
import type { AliceEvent, MessageReceived } from "../src/mind/events.js";
import type { Contribution, Mechanism } from "../src/mind/mechanism.js";
import { type ChatState, emptyState } from "../src/mind/state.js";
import { speechRequest, step } from "../src/mind/step.js";
import { codeMode } from "../src/speech/decision.js";
import { renderSpeechPrompt } from "../src/speech/prompt.js";
import { bindTelegramWorldAdapter } from "../src/telegram/world-adapter.js";
import { program } from "./model-reply.js";

const MIN = 60_000;
const H = 60 * MIN;
/** 东八区 2026-11-10 15:00（她醒着、精力在常态）。 */
const T = Date.UTC(2026, 10, 10, 7, 0);
const GROUP = "telegram:-5";
const DM = "telegram:1";

const c = (kind: Contribution["kind"], text: string, more: Partial<Contribution> = {}) => ({
  mechanism: "test",
  kind,
  text,
  ...more,
});

function request(contributions: Contribution[], o: Partial<SpeechRequest> = {}): SpeechRequest {
  return {
    scope: GROUP,
    chatType: "group",
    triggerMessageId: "2",
    at: T,
    affordances: ["send", "mark-read", "delegate", "think", "sticker"],
    contributions,
    timeline: [
      {
        at: T - MIN,
        messageId: "2",
        sender: { id: "u1", name: "Вадим" },
        text: "Алиса, ты тут?",
        contentType: "text",
        replyToMessageId: null,
      },
      {
        at: T - MIN,
        messageId: "3",
        sender: { id: "u2", name: "Лиса" },
        text: null,
        contentType: "photo",
        media: "图片：一只橘猫",
        replyToMessageId: null,
      },
    ],
    ...o,
  };
}

const ALL: Contribution[] = [
  c("state", "我在看剧，暂停了一下看手机。"),
  c("self", "- 3 小时前 关于 Вадим：他好久没来了"),
  c("thought", "- 刚才想过：他回来了"),
  c("mood", "开心（2 分钟前，因为Вадим来找我）"),
  c("people", "我和在场的人：\nВадим：这个群里的朋友\nЛиса：这个群里的朋友", {
    people: [
      { id: "u1", name: "Вадим", relation: "这个群里的朋友" },
      { id: "u2", name: "Лиса", relation: "这个群里的朋友" },
    ],
  }),
  c("people", "我记得：\n- Вадим：最近换了工作", {
    people: [{ id: "u1", name: "Вадим", facts: ["最近换了工作"] }],
  }),
  c("doings", "我在这里答应过或打算做的事：\n- 给他推荐番（约在明天）"),
  c("failed", "我刚才想发的那条没发出去。"),
  c("turn", "Вадим 用俄语跟你说话。", { language: "俄语" }),
  c("reference", "", {
    examples: [{ scene: "第一反应", acts: [{ kind: "think", thought: "诶" }] }],
  }),
  c("reference", "你平时在群里的几种回法", {
    examples: [
      { scene: "有人点名问你在不在", acts: [{ kind: "send", text: "在呢", replyTo: null }] },
    ],
  }),
];

describe("card layout (context-v2)", () => {
  const { system, user } = renderSpeechPrompt("PERSONA", request(ALL));
  const [card = "", log = "", anchor = ""] = user.split("\n\n");

  it("moves the diary out of the system prompt into the card", () => {
    expect(system).not.toContain("他好久没来了");
    expect(card).toContain(
      "· 心里还记着（只有我自己知道）：\n  - 3 小时前 关于 Вадим：他好久没来了",
    );
    expect(card).toContain("  - 刚才想过：他回来了");
  });

  it("the card has its rows in order, with the year in the title and no -!- notices", () => {
    expect(card.split("\n")[0]).toBe("Telegram 群聊 · 2026年11月10日 周二");
    const rows = card
      .split("\n")
      .filter((l) => l.startsWith("· "))
      .map((l) => l.slice(2).split("：")[0]);
    expect(rows).toEqual([
      "我这边",
      "心情",
      "心里还记着（只有我自己知道）",
      "在场的人与记忆",
      "约定与刚才的动静",
    ]);
    expect(card).toContain("· 心情：开心（2 分钟前，因为Вадим来找我）");
    expect(card).toContain("我刚才想发的那条没发出去。");
    expect(user).not.toContain("-!-");
    expect(log.split("\n")[0]).toMatch(/^\d\d:\d\d \[2\] <Вадим>/);
  });

  it("only rows with content appear", () => {
    const bare = renderSpeechPrompt("P", request([c("state", "我在平行世界。")])).user;
    expect(bare.split("\n\n")[0]?.split("\n").slice(1)).toEqual(["· 我这边：我在平行世界。"]);
  });

  it("merges a person's relation and facts; a relation without facts carries the conditional note", () => {
    expect(card).toContain("  - Вадим（这个群里的朋友）：最近换了工作");
    expect(card).toMatch(
      / {2}- Лиса（这个群里的朋友；手头没记着以前的具体往事，只有对方问起过去的事时/,
    );
  });

  it("ends with a short anchor: the time and situation, then her turn naming the line and the language to use", () => {
    const lines = anchor.split("\n");
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines[1]).toContain("15:00");
    expect(lines[1]).toContain("Вадим 用俄语跟你说话。");
    expect(lines[2]?.startsWith("[2] ")).toBe(true);
    expect(lines[2]).toContain("俄语");
    const zh = renderSpeechPrompt(
      "P",
      request([c("turn", "小满 用中文跟你说话。", { language: "中文" })], {
        triggerMessageId: null,
      }),
    ).user;
    const zhTurn = zh.split("\n").at(-1) ?? "";
    expect(zhTurn.startsWith("[")).toBe(false);
    expect(zhTurn).not.toContain("请用");
    const dmForeign = renderSpeechPrompt(
      "P",
      request([c("turn", "Вадим 用俄语跟你说话。", { language: "俄语" })], {
        chatType: "private",
        scope: "telegram:2",
      }),
    ).user;
    expect(dmForeign.split("\n").at(-1)).toContain("俄语");
  });

  it("offers no mark_read and states the delegate hint once; the parser still reads mark_read", () => {
    expect(system).not.toContain("mark_read");
    expect(system.match(/Returns lookup text/g)?.length).toBe(1);
    const read = codeMode.parse(program("await tools.mark_read();"), request([]));
    expect(read.decision.acts).toEqual([{ kind: "mark-read" }]);
  });

  it("merges the untitled first-reaction examples into the head of the first group of replies", () => {
    const ref = system.slice(system.indexOf("## 参考"));
    expect(ref.indexOf("▸ 第一反应")).toBeLessThan(ref.indexOf("▸ 有人点名问你在不在"));
    expect(ref).toContain("你平时在群里的几种回法：\n  ▸ 第一反应");
  });
});

describe("life in the card (context-v2)", () => {
  const life = (social: number, energy = 0): LifeState => ({ ...emptyLife, at: T, social, energy });
  const text = (l: LifeState) =>
    lifeFacts(l, T)
      .map((x) => x.text)
      .join("\n");

  it("low sociability is a state line only past its threshold; being tired too gives one line, not two", () => {
    expect(text(life(-2))).not.toBe("");
    expect(text(life(-1.2))).toBe("");
    expect(lifeFacts(life(-2), T)[0]?.kind).toBe("state");
    const tired = lifeFacts(life(-2, -0.9), T);
    expect(tired).toHaveLength(1);
    expect(tired[0]?.text).not.toBe(text(life(-2)));
  });
});

describe("mood in the card (context-v2)", () => {
  it("writes nothing when she is only calm", () => {
    expect(moodOf(initialAffect, GROUP, "group", T)).toBeNull();
  });
});

describe("diary view (context-v2)", () => {
  const e = (text: string, at: number, about: string | null = null, scope = DM): DiaryEntry => ({
    text,
    about,
    scope,
    group: true,
    at,
    importance: 5,
    present: ["u1", "u2"],
  });
  const here = { scope: DM, group: false, target: "u1", onTimeline: (at: number) => at >= T };

  it("drops old entries not about this person after 48 hours, keeps those about them", () => {
    const old = e("那天大家去吃火锅没叫我", T - 50 * H);
    const aboutHim = e("他说要换工作", T - 60 * H, "u1");
    const shown = rankedShown([old, aboutHim], here, T, DIARY_VIEW).map((x) => x.text);
    expect(shown).toEqual(["他说要换工作"]);
    expect(rankedShown([old, aboutHim], here, T).map((x) => x.text)).toContain(old.text);
  });

  it("collapses near-duplicates from the same chat to the newest", () => {
    const a = e("虽然知道去不了，但被说反正去不了的时候还是有点小失落", T - 30 * H);
    const b = e("虽然知道去不了，被说反正去不了还是有点小失落", T - 2 * H);
    const shown = rankedShown([a, b], here, T, DIARY_VIEW).map((x) => x.at);
    expect(shown).toEqual([b.at]);
  });
});

describe("example pool (context-v2)", () => {
  it("is mostly one line, has every register in both chats, and no advice lines", () => {
    const one = POOL.filter((x) => said(x.acts).length <= 1).length;
    expect(one / POOL.length).toBeGreaterThanOrEqual(0.85);
    for (const r of REGISTERS) {
      expect(POOL.some((x) => x.chat === "private" && x.register === r)).toBe(true);
      expect(POOL.some((x) => x.chat === "group" && x.register === r)).toBe(true);
    }
    const all = POOL.map((x) => `${x.scene}|${said(x.acts).join("/")}`).join("\n");
    for (const w of ["听我的", "先去", "快去", "应该", "深呼吸", "别熬", "立刻"])
      expect(all).not.toContain(w);
  });
});

describe("bots (context-v2)", () => {
  let n = 0;
  const msg = (o: Partial<MessageReceived>): MessageReceived => ({
    type: "message.received",
    at: T - MIN + n,
    scope: GROUP,
    chatType: "group",
    messageId: `m${++n}`,
    senderId: "u1",
    senderName: "老周",
    text: "早",
    contentType: "text",
    replyToMessageId: null,
    directed: false,
    ...o,
  });
  const events: AliceEvent[] = [
    msg({}),
    msg({ senderId: "b1", senderName: "签到机器人", text: "签到成功", isBot: true }),
    msg({ senderId: "s1", senderName: "低价代充", text: "低价代充 私聊" }),
  ];
  const peopleOf = (m: Mechanism) => {
    const state = events.reduce((s, e) => step(s, e, [m]).state, emptyState);
    return m.contribute?.(state.chats[GROUP] as ChatState, T, state.mechanisms[m.name], []) ?? [];
  };

  it("familiar leaves Telegram-flagged bots out of the people here; humans (spam too) stay", () => {
    const text = peopleOf(familiar)[0]?.text ?? "";
    expect(text).toContain("老周");
    expect(text).toContain("低价代充");
    expect(text).not.toContain("签到机器人");
  });

  it("the journal keeps isBot; the adapter sets it from the Telegram user flag", () => {
    const e = msg({ isBot: true });
    expect(decodeEvent("message.received", GROUP, e)).toEqual(e);
    const got: AliceEvent[] = [];
    const { receive } = bindTelegramWorldAdapter(
      { onNewMessage: () => {}, onRawUpdate: () => {}, onChatMemberUpdate: () => {} } as never,
      {
        selfId: "42",
        now: () => 1000,
        onEvent: (x) => void got.push(x),
        admit: () => true,
        newGroup: () => false,
      },
    );
    const from = (bot: boolean) =>
      ({
        id: bot ? 5 : 6,
        chat: { id: -100, chatType: "supergroup", title: "群" },
        sender: new User({ _: "user", id: bot ? 9 : 10, firstName: "x", bot } as never),
        text: "hi",
        entities: [],
        media: null,
        action: null,
      }) as never;
    receive(from(true), {} as never);
    receive(from(false), {} as never);
    const received = got.filter((x): x is MessageReceived => x.type === "message.received");
    expect(received.map((x) => x.isBot)).toEqual([true, undefined]);
  });
});

describe("production is context-v2", () => {
  it("delivers the card end to end through step", () => {
    const list = mechanisms;
    const events: AliceEvent[] = [
      {
        type: "message.received",
        at: T - MIN,
        scope: DM,
        chatType: "private",
        messageId: "1",
        senderId: "u1",
        senderName: "小满",
        text: "你看了那个新出的番没",
        contentType: "text",
        replyToMessageId: null,
        directed: true,
      },
    ];
    const state = events.reduce((s, e) => step(s, e, list).state, emptyState);
    const req = speechRequest(state, state.chats[DM] as ChatState, T, "1", list);
    const { system, user } = renderSpeechPrompt("PERSONA", req);
    expect(user).toContain("· 我这边：我住在平行世界");
    expect(user.split("\n").at(-1)?.startsWith("[1] ")).toBe(true);
    expect(system).not.toContain("mark_read");
    expect(req.affordances).toContain("mark-read");
  });
});
