/**
 * 发言上下文的写法（eval-artifacts/presentation/）：卡片是她自己记的事，机制写成"我……"，她自己写下的话原样；
 * 标题不补横线（## 怎么写、## 参考、开头一行"Telegram 私聊 · 日期"、anchor 上面 ---）；记录里同一天隔了 30 分钟以上插一行。
 */
import { describe, expect, it } from "vitest";
import { mechanisms } from "../src/mechanisms/registry.js";
import type { SpeechRequest } from "../src/mind/effects.js";
import type { AliceEvent } from "../src/mind/events.js";
import type { Contribution } from "../src/mind/mechanism.js";
import { type AliceState, emptyState, type TimelineEntry } from "../src/mind/state.js";
import { speechRequest, step } from "../src/mind/step.js";
import { logLines, renderSpeechPrompt } from "../src/speech/prompt.js";

const MIN = 60_000;
/** 东八区 2026-11-10 15:00。 */
const T = Date.UTC(2026, 10, 10, 7, 0);
const DM = "telegram:1";

const c = (kind: Contribution["kind"], text: string, more: Partial<Contribution> = {}) => ({
  mechanism: "test",
  kind,
  text,
  ...more,
});

const said = (at: number, id: string, text: string): TimelineEntry => ({
  at,
  messageId: id,
  sender: { id: "u1", name: "小满" },
  text,
  contentType: "text",
  replyToMessageId: null,
});

function request(contributions: Contribution[], o: Partial<SpeechRequest> = {}): SpeechRequest {
  return {
    scope: DM,
    chatType: "private",
    triggerMessageId: "2",
    at: T,
    affordances: ["send", "think", "sticker"],
    contributions,
    timeline: [said(T - MIN, "2", "在吗")],
    ...o,
  };
}

const card = (r: SpeechRequest) => renderSpeechPrompt("P", r).user.split("\n\n")[0];

describe("first-person card", () => {
  it("from production's own mechanisms: her state, the bid as a cause, her promise in her words, letting go — no 你 in the templates", () => {
    const at = (m: number) => T + m * MIN;
    const from = (m: number, id: string): AliceEvent => ({
      type: "message.received",
      at: at(m),
      scope: DM,
      chatType: "private",
      messageId: id,
      senderId: "u1",
      senderName: "小满",
      text: "在吗",
      contentType: "text",
      replyToMessageId: null,
      directed: true,
    });
    // 先有过来往（她回过一次），三小时后小满又来找她。
    const events: AliceEvent[] = [
      from(-180, "0"),
      { type: "message.sent", at: at(-179), scope: DM, messageId: "s0", text: "在", kind: "text" },
      from(0, "1"),
      {
        type: "act.done",
        at: at(1),
        scope: DM,
        act: { kind: "intend", when: "明天", what: "陪你看番" },
      },
    ];
    const state = events.reduce<AliceState>((s, e) => step(s, e, mechanisms).state, emptyState);
    const chat = state.chats[DM];
    if (!chat) throw new Error("no chat");
    const text = card(speechRequest(state, chat, at(2), "1", mechanisms));
    expect(text).toContain("· 我这边：");
    expect(text).toContain("我住在平行世界");
    expect(text).toContain("因为小满来找我");
    expect(text).toContain("  我在这里答应过或打算做的事：\n  - 陪你看番（");
    expect(text?.replace("陪你看番", "")).not.toContain("你");

    const sad: AliceEvent[] = [
      {
        type: "act.done",
        at: at(3),
        scope: DM,
        act: { kind: "feel", mood: "委屈", why: "你们都不理我" },
        // 效价由外壳判出、写在事件上（PLAN 第 34 件；判口气的模型 2026-11-13 给"委屈"的数）。
        valence: -0.51,
      },
      { type: "act.done", at: at(4), scope: DM, act: { kind: "let-go", messageId: "1" } },
    ];
    const later = sad.reduce<AliceState>((s, e) => step(s, e, mechanisms).state, state);
    const again = later.chats[DM];
    if (!again) throw new Error("no chat");
    expect(card(speechRequest(later, again, at(5), null, mechanisms))).toMatch(
      /· 心情：委屈（\d+ 分钟前，因为你们都不理我，我说过这事先不追究了）/,
    );
  });

  it("what she wrote herself keeps its words: thoughts, diary, facts about people", () => {
    const text = card(
      request([
        c("thought", "- 刚才想过：哼，明明是你先失踪的"),
        c("self", "- 1 小时前 关于 小满：你这个笨蛋"),
        c("people", "", { people: [{ id: "u1", name: "小满", facts: ["说你像只猫"] }] }),
      ]),
    );
    expect(text).toContain("· 心里还记着（只有我自己知道）：");
    expect(text).toContain("  - 刚才想过：哼，明明是你先失踪的");
    expect(text).toContain("  - 1 小时前 关于 小满：你这个笨蛋");
    expect(text).toContain("：说你像只猫");
  });
});

describe("time gaps in the timeline", () => {
  const at = (h: number, m: number) => Date.UTC(2026, 10, 10, h - 8, m);

  it("marks neighbours on the same day 30 minutes or more apart, and only those", () => {
    expect(
      logLines([
        said(at(17, 50), "1", "下班了"),
        said(at(18, 19), "2", "在干嘛"),
        said(at(19, 5), "3", "人呢"),
      ]),
    ).toEqual([
      "17:50 [1] <小满> 下班了",
      "18:19 [2] <小满> 在干嘛",
      "··· 过了 46 分钟 ···",
      "19:05 [3] <小满> 人呢",
    ]);
    expect(logLines([said(at(13, 0), "1", "午饭"), said(at(17, 0), "2", "下班")])[1]).toBe(
      "··· 过了 4 小时 ···",
    );
  });

  it("the card title is today's date even when the timeline starts on an earlier day, and the log opens with that day", () => {
    const twoDaysAgo = Date.UTC(2026, 10, 8, 13, 0);
    const { user } = renderSpeechPrompt(
      "P",
      request([], { timeline: [said(twoDaysAgo, "1", "晚安"), said(T - MIN, "2", "在吗")] }),
    );
    const [title, log] = user.split("\n\n");
    expect(title?.split("\n")[0]).toBe("Telegram 私聊 · 2026年11月10日 周二");
    expect(log?.split("\n").slice(0, 3)).toEqual([
      "── 11月8日 周日 ──",
      "21:00 [1] <小满> 晚安",
      "── 11月10日 周二 ──",
    ]);
  });

  it("a day change gets a short day line instead of a gap line", () => {
    const next = Date.UTC(2026, 10, 11, 3, 0);
    expect(logLines([said(at(23, 0), "1", "晚安"), said(next, "2", "早")])).toEqual([
      "23:00 [1] <小满> 晚安",
      "── 11月11日 周三 ──",
      "11:00 [2] <小满> 早",
    ]);
  });
});

describe("state card conflict reconciliation and budget (PLAN item 18)", () => {
  it("suppresses stale cheerful mood when someone in the room recently told her to stop", () => {
    const text = card(
      request([
        c("mood", "兴奋（因为对线赢了）"),
        c("people", "", {
          people: [{ id: "u1", name: "Ani", facts: ["5 分钟前叫我别回 Ta 的消息"] }],
        }),
      ]),
    );
    expect(text).toContain("Ani");
    expect(text).toContain("叫我别回");
    expect(text).not.toContain("心情：兴奋");

    const upset = card(
      request([
        c("mood", "委屈（被说了）"),
        c("people", "", {
          people: [{ id: "u1", name: "Ani", facts: ["5 分钟前叫我别回 Ta 的消息"] }],
        }),
      ]),
    );
    expect(upset).toContain("· 心情：委屈");
  });

  it("caps oversized card sections cleanly", () => {
    const manyThoughts = Array.from({ length: 12 }, (_, i) => `想法 ${i + 1}`).join("\n");
    const text = card(request([c("thought", manyThoughts)])) ?? "";
    expect(text).toContain("想法 6");
    expect(text).not.toContain("想法 7");
  });
});
