/**
 * 她的发言替身（src/sim/surrogate.ts）坏掉了会很糟的几条：
 * - 条件读错（群/私聊、有没有人找她、被消息叫醒还是节律、夜里能不能睡），分组就全错了；
 * - 没见过的分组要退回上一级，不能退成 0 或 1；
 * - 同一个输入永远同一个决定，抽出来的频率要和估计一致；
 * - 动作只用这轮能做的，引用和点表情指向记录里真有的消息。
 */
import { describe, expect, it } from "vitest";
import type { Act } from "../src/mind/affordances.js";
import type { SpeechRequest } from "../src/mind/effects.js";
import { decide, estimate, features, fitSurrogate } from "../src/sim/surrogate.js";

const group = (anchor: string, extra = "") => ({
  system: "## 怎么写\n  [去睡了]  去睡觉\n  [表情 编号 👍]",
  user: [
    "Telegram 群聊 · 2026年2月24日 周二",
    `· 我这边：我刚睡醒。${extra}`,
    "",
    "23:30 [1] <甲> 在吗",
    "23:30 [2] <乙> 在",
    "23:31 [3] <丙> 哈哈",
    "23:31 [4] <丁> 睡了",
    "23:32 [5] <你> 我也在",
    "23:32 [6] <你> 晚上好",
    "",
    "---",
    anchor,
  ].join("\n"),
});

const UNSOUGHT =
  "现在是 23:50（离最后一条已经过了 18 分钟）。这会儿没人点你，大家在自己聊，你在旁边看着；如要说话请用英语。";
const SOUGHT = "现在是 23:33。甲 用中文跟你说话。\n[4] 之后，轮到你了（默认回一行）：";

const request = (o: Partial<SpeechRequest> = {}): SpeechRequest => ({
  scope: "telegram:-7",
  chatType: "group",
  timeline: [
    {
      at: 1,
      messageId: "4",
      sender: { id: "contact:1", name: "丁" },
      text: "睡了",
      contentType: "text",
      replyToMessageId: null,
    },
  ],
  contributions: [],
  triggerMessageId: null,
  at: 1_771_950_000_000,
  affordances: ["send", "sticker", "react", "feel", "bed"],
  ...o,
});

const say: Act[] = [{ kind: "send", text: "嗯", replyTo: null }];

describe("surrogate: the conditions it reads", () => {
  it("reads chat, sought, trigger, crowd, her trailing lines, gap, state, language, night and bed", () => {
    const f = features(group(UNSOUGHT));
    expect(f).toMatchObject({
      chat: "group",
      sought: "unsought",
      triggered: "clock",
      crowd: "crowd",
      own: "2+",
      gap: "long",
      energy: "woke",
      foreign: "yes",
      night: true,
      canBed: true,
    });
    expect(features(group(SOUGHT))).toMatchObject({ sought: "sought", triggered: "message" });
  });
});

describe("surrogate: estimates", () => {
  it("a seen cell follows its own counts, an unseen one backs off to the parent", () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      prompt: group(SOUGHT),
      acts: i < 54 ? say : [],
    }));
    rows.push(...Array.from({ length: 60 }, () => ({ prompt: group(UNSOUGHT), acts: [] })));
    const model = fitSurrogate(rows);
    expect(estimate(model, features(group(SOUGHT))).spoke).toBeGreaterThan(0.8);
    expect(estimate(model, features(group(UNSOUGHT))).spoke).toBeLessThan(0.1);
    // 同一个"有人找她"分组里没见过的状态（不是刚睡醒）：退回这一级，不是 0 或 1。
    const unseen = features(group(SOUGHT));
    const e = estimate(model, { ...unseen, energy: "low" });
    expect(e.spoke).toBeGreaterThan(0.7);
    expect(e.spoke).toBeLessThan(1);
  });
});

describe("surrogate: decisions", () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({
    prompt: group(SOUGHT),
    acts: (i % 2 === 0
      ? [
          { kind: "send", text: "嗯", replyTo: "4" },
          { kind: "react", messageId: "4", emoji: "👍" },
        ]
      : []) as Act[],
  }));
  const model = fitSurrogate(rows);

  it("is deterministic and its frequency matches the estimate", () => {
    const r = request({ triggerMessageId: "4" });
    expect(decide(model, group(SOUGHT), r, 5)).toEqual(decide(model, group(SOUGHT), r, 5));
    let spoke = 0;
    for (let at = 0; at < 2000; at++)
      spoke += decide(model, group(SOUGHT), r, at).acts.some((a) => a.kind === "send") ? 1 : 0;
    expect(spoke / 2000).toBeCloseTo(estimate(model, features(group(SOUGHT))).spoke, 1);
  });

  it("only uses offered acts, and quotes and reactions point at a message in the log", () => {
    const r = request({ triggerMessageId: "4", affordances: ["send"] });
    for (let at = 0; at < 300; at++) {
      const acts = decide(model, group(SOUGHT), r, at).acts;
      expect(acts.every((a) => a.kind === "send")).toBe(true);
      for (const a of acts) if (a.kind === "send" && a.replyTo) expect(a.replyTo).toBe("4");
    }
  });
});
