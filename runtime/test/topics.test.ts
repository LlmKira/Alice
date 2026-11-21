/**
 * 候选 topics（R04，2 月 threads.mod）：她自己开始、推进、了结的事从 act.done 确定性地折进每个会话，
 * 提示词里最多 3 件、每件一行；同一件事不重复记；每个会话最多 8 件；两周没动过的不显示；
 * 私聊里开的事只在那个私聊里出现。
 */
import { describe, expect, it } from "vitest";
import {
  createPressure,
  emptyWorld,
  PRODUCTION,
  pressureProduction,
  topics,
  type World,
} from "../src/mechanisms/pressure/index.js";
import { OPEN_TOPICS, TOPIC_QUIET } from "../src/mechanisms/pressure/params.js";
import { topicsFact } from "../src/mechanisms/pressure/recall.js";
import { type Act, affordanceOf, affordances } from "../src/mind/affordances.js";
import type { SpeechRequest } from "../src/mind/effects.js";
import type { AliceEvent } from "../src/mind/events.js";
import { type ChatState, emptyChat } from "../src/mind/state.js";
import { codeMode } from "../src/speech/decision.js";
import { modelReply } from "./model-reply.js";

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const T = Date.UTC(2026, 10, 10, 7, 0);

const DM = "telegram:1";
const GROUP = "telegram:-5";

const hello = (scope: string, at = T): AliceEvent => ({
  type: "message.received",
  at,
  scope,
  chatType: scope.startsWith("telegram:-") ? "group" : "private",
  messageId: `m${at}`,
  senderId: "u1",
  senderName: "池塘",
  text: "hi",
  contentType: "text",
  replyToMessageId: null,
  directed: false,
});
const done = (at: number, act: Act, scope = DM): AliceEvent => ({
  type: "act.done",
  at,
  scope,
  act,
});
const open = (at: number, title: string, scope = DM) =>
  done(at, { kind: "topic-open", title }, scope);
const advance = (at: number, topic: string, beat: string, scope = DM) =>
  done(at, { kind: "topic-advance", topic, beat }, scope);
const close = (at: number, topic: string, scope = DM) =>
  done(at, { kind: "topic-close", topic }, scope);

/** 组 topics 的压力场：生产加上她跟着的事。 */
const pressureTopics = createPressure(affordances, { ...PRODUCTION, topics });
const fold = (events: AliceEvent[], from: World = emptyWorld) =>
  events.reduce((w, e) => pressureTopics.reduce?.(w, e) as World, from);

function chat(scope: string): ChatState {
  return emptyChat(scope, scope.startsWith("telegram:-") ? "group" : "private", true);
}
const shown = (world: World, scope: string, now: number) =>
  topicsFact(world, chat(scope), now)
    .map((c) => c.text)
    .join("\n");
const titles = (world: World, scope = DM) => world.chats[scope]?.topics.map((t) => t.title);

describe("topics: her own threads fold from act.done", () => {
  it("opens, advances and closes; the fact shows her words and when she last moved it", () => {
    const w = fold([
      hello(DM),
      open(T + MIN, "陪她准备面试"),
      open(T + 2 * MIN, "听他推荐的歌"),
      advance(T + H, "面试", "她说这周很忙"),
    ]);
    expect(shown(w, DM, T + 4 * H)).toBe(
      [
        "我在这里跟着的事：",
        "- 陪她准备面试（上次：她说这周很忙，3 小时前）",
        "- 听他推荐的歌（开了个头，4 小时前）",
      ].join("\n"),
    );
    const after = fold([close(T + 5 * H, "陪她准备面试")], w);
    expect(titles(after)).toEqual(["听他推荐的歌"]);
    // 只剩一件时，写得含糊也认得是它。
    expect(titles(fold([close(T + 6 * H, "那件事")], after))).toEqual([]);
    expect(shown(fold([close(T + 6 * H, "那件事")], after), DM, T + 7 * H)).toBe("");
  });

  it("advancing something she never opened starts it with that step", () => {
    const w = fold([hello(DM), advance(T + MIN, "帮他改简历", "改完第一段了")]);
    expect(w.chats[DM]?.topics).toEqual([
      {
        title: "帮他改简历",
        key: "帮他改简历",
        openedAt: T + MIN,
        touchedAt: T + MIN,
        beat: { text: "改完第一段了", at: T + MIN },
      },
    ]);
    // 有别的事开着时，认不出的推进不会记到那件上去。
    const two = fold([advance(T + 2 * MIN, "周末去看展", "他说想去")], w);
    expect(titles(two)).toEqual(["帮他改简历", "周末去看展"]);
    expect(two.chats[DM]?.topics[0]?.beat?.text).toBe("改完第一段了");
  });

  it("dedupes by the normalized title: opening the same thing again only brings it up", () => {
    const w = fold([
      hello(DM),
      open(T + MIN, "陪她准备面试"),
      advance(T + 2 * MIN, "陪她准备面试", "约了周三模拟"),
      open(T + H, "陪她 准备面试。"),
    ]);
    expect(w.chats[DM]?.topics).toHaveLength(1);
    expect(w.chats[DM]?.topics[0]).toMatchObject({
      openedAt: T + MIN,
      touchedAt: T + H,
      beat: { text: "约了周三模拟", at: T + 2 * MIN },
    });
  });

  it("keeps at most OPEN_TOPICS per chat, dropping the one untouched the longest", () => {
    const events: AliceEvent[] = [hello(DM)];
    for (let i = 0; i < OPEN_TOPICS; i++) events.push(open(T + (i + 1) * MIN, `事${i}`));
    // 最早开的那件刚推进过：放下的是第二早的。
    events.push(advance(T + H, "事0", "有进展"));
    events.push(open(T + 2 * H, "新的事"));
    const w = fold(events);
    expect(w.chats[DM]?.topics).toHaveLength(OPEN_TOPICS);
    expect(titles(w)).not.toContain("事1");
    expect(titles(w)).toContain("事0");
    expect(titles(w)).toContain("新的事");
    // 提示词里只有最近动过的 3 件。
    expect(shown(w, DM, T + 3 * H).split("\n")).toEqual([
      "我在这里跟着的事：",
      "- 新的事（开了个头，1 小时前）",
      "- 事0（上次：有进展，2 小时前）",
      `- 事${OPEN_TOPICS - 1}（开了个头，3 小时前）`,
    ]);
  });

  it("hides a thread not moved for two weeks without forgetting it; moving it brings it back", () => {
    const w = fold([hello(DM), open(T, "答应要听他推荐的歌")]);
    expect(shown(w, DM, T + TOPIC_QUIET - MIN)).toContain("答应要听他推荐的歌");
    expect(shown(w, DM, T + TOPIC_QUIET)).toBe("");
    expect(titles(w)).toEqual(["答应要听他推荐的歌"]);
    const back = fold([advance(T + 20 * D, "听他推荐的歌", "听完了第一首")], w);
    expect(shown(back, DM, T + 20 * D + H)).toBe(
      "我在这里跟着的事：\n- 答应要听他推荐的歌（上次：听完了第一首，1 小时前）",
    );
  });

  it("a thread opened in a private chat shows only there", () => {
    const w = fold([hello(DM), hello(GROUP), open(T + MIN, "陪她准备面试", DM)]);
    expect(shown(w, DM, T + H)).toContain("陪她准备面试");
    expect(shown(w, GROUP, T + H)).toBe("");
    // 在群里写同一件事的进展，不会改到私聊那一份上。
    const g = fold([advance(T + 2 * MIN, "陪她准备面试", "群里有人也在面试", GROUP)], w);
    expect(g.chats[DM]?.topics[0]?.beat).toBeNull();
    expect(shown(g, DM, T + H)).not.toContain("群里");
    expect(titles(g, GROUP)).toEqual(["陪她准备面试"]);
    // 在群里了结它，私聊那件也还在。
    expect(titles(fold([close(T + 3 * MIN, "陪她准备面试", GROUP)], g))).toEqual(["陪她准备面试"]);
  });

  it("clips long titles and steps to one line", () => {
    const long = "这".repeat(80);
    const w = fold([hello(DM), advance(T, long, long)]);
    const line = shown(w, DM, T + H).split("\n")[1] as string;
    expect(line).toBe(`- ${"这".repeat(40)}…（上次：${"这".repeat(60)}…，1 小时前）`);
  });
});

describe("topics: offered by production and absent in no-topics ablation", () => {
  it("production provides the three rows and contributes the scene fact; without topics it does not", () => {
    const withoutTopics = createPressure(affordances, { ...PRODUCTION, topics: undefined });
    expect(pressureProduction.affordances).toEqual(
      expect.arrayContaining(["topic-open", "topic-advance", "topic-close"]),
    );
    expect(withoutTopics.affordances ?? []).not.toContain("topic-open");
    const w = fold([hello(DM), open(T + MIN, "陪她准备面试")]);
    const facts = pressureProduction.contribute?.(chat(DM), T + H, w, []) ?? [];
    expect(facts).toContainEqual({
      mechanism: "pressure-topics",
      kind: "scene",
      text: "我在这里跟着的事：\n- 陪她准备面试（开了个头，59 分钟前）",
    });
    const off = withoutTopics.contribute?.(chat(DM), T + H, w, []) ?? [];
    expect(off.some((c) => c.mechanism === "pressure-topics")).toBe(false);
  });
});

describe("topics: every format reads the new markers", () => {
  const request: SpeechRequest = {
    scope: DM,
    chatType: "private",
    triggerMessageId: null,
    at: T,
    affordances: ["send", "topic-open", "topic-advance", "topic-close"],
    contributions: [],
    timeline: [],
  };
  const notes: Act[] = [
    { kind: "send", text: "加油", replyTo: null },
    { kind: "topic-open", title: "陪她准备面试" },
    { kind: "topic-advance", topic: "陪她准备面试", beat: "她说这周很忙，周三再练" },
    { kind: "topic-close", topic: "听他推荐的歌" },
  ];

  it("round-trips", () => {
    expect(codeMode.parse(modelReply(notes), request)).toEqual({
      decision: { acts: notes },
      defects: [],
    });
  });

  it("lists the three in the SDK with their arguments", () => {
    const rules = codeMode.rules(request.affordances.map(affordanceOf));
    expect(rules).toContain("  open_topic: {");
    expect(rules).toMatch(/ {2}advance_topic: \{[\s\S]*topic: string;[\s\S]*beat: string;/);
    expect(rules).toContain("  close_topic: {");
  });
});
