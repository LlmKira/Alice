/**
 * 日记的写入（diary.ts writeDiary，反思写下的条目都走它）：一次决定里有界、总数有界、过了保留期就丢；
 * 同一受众已经看得见的几乎一样的话不再写。内心独白在每个会话都开。
 * 写入前的去重、显示的打分和受众规则见 reflect.test.ts。
 */
import { describe, expect, it } from "vitest";
import { type DiaryEntry, writeDiary } from "../src/mechanisms/pressure/diary.js";
import { pressureProduction } from "../src/mechanisms/pressure/index.js";
import { DIARY } from "../src/mechanisms/pressure/params.js";
import type { AliceEvent, MessageReceived } from "../src/mind/events.js";
import { type ChatState, emptyState } from "../src/mind/state.js";
import { speechRequest, step } from "../src/mind/step.js";
import { renderSpeechPrompt } from "../src/speech/prompt.js";

const MIN = 60_000;
const T = Date.UTC(2026, 10, 10, 7, 0);
const DM = "telegram:1";

let n = 0;
function msg(at: number, scope = DM): MessageReceived {
  n++;
  return {
    type: "message.received",
    at,
    scope,
    chatType: "private",
    messageId: `m${n}`,
    senderId: "u1",
    senderName: "小满",
    text: "在吗",
    contentType: "text",
    replyToMessageId: null,
    directed: true,
  };
}

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

function promptAt(events: AliceEvent[], scope: string, at: number) {
  const state = events.reduce((s, e) => step(s, e, [pressureProduction]).state, emptyState);
  const request = speechRequest(state, state.chats[scope] as ChatState, at, null, [
    pressureProduction,
  ]);
  return { request, prompt: renderSpeechPrompt("PERSONA", request) };
}

describe("writing: bounded per decision, in total, and in time", () => {
  it("keeps at most two entries from one decision", () => {
    let d: DiaryEntry[] = [];
    for (const t of ["一", "二", "三"]) d = writeDiary(d, entry(t, T), T);
    expect(d.map((e) => e.text)).toEqual(["一", "二"]);
    expect(writeDiary(d, entry("四", T + MIN), T + MIN).map((e) => e.text)).toEqual([
      "一",
      "二",
      "四",
    ]);
  });

  it("keeps at most the bound in total, dropping the oldest", () => {
    let entries: DiaryEntry[] = [];
    for (let i = 0; i < DIARY.kept + 7; i++)
      entries = writeDiary(entries, entry(`${i}`, T + i), T + i);
    expect(entries).toHaveLength(DIARY.kept);
    expect(entries[0]?.text).toBe("7");
  });

  it("clips long entries and ignores empty ones", () => {
    const long = "啊".repeat(DIARY.maxChars + 50);
    const d = writeDiary(writeDiary([], entry(long, T), T), entry("  ", T + 1), T);
    expect(d).toHaveLength(1);
    expect(d[0]?.text).toHaveLength(DIARY.maxChars);
  });

  it("stored until the retention, then dropped at the next write", () => {
    const d = writeDiary([], entry("旧的", T), T);
    const later = T + DIARY.retention;
    expect(writeDiary(d, entry("很久以后", later), later).map((e) => e.text)).toEqual(["很久以后"]);
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
});

describe("production: inner monologue", () => {
  it("inner monologue is on in every chat", () => {
    const OTHER = "telegram:4";
    const events: AliceEvent[] = [msg(T), msg(T, OTHER)];
    for (const scope of [DM, OTHER]) {
      const { request, prompt } = promptAt(events, scope, T + MIN);
      expect(request.affordances).toContain("think");
      expect(prompt.system).toContain("  inner: {");
    }
  });
});
