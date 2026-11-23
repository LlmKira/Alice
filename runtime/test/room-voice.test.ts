/**
 * 这个群的人平时怎么打字（room-voice.ts）：过了冷启动才写，群友的原话只回到同一个群。
 */
import { describe, expect, it } from "vitest";
import { GROUP_SILENT, palette } from "../src/mechanisms/palette.js";
import { mechanisms } from "../src/mechanisms/registry.js";
import {
  type RoomState,
  reduceRoom,
  roomVoice,
  roomVoiceGolden,
} from "../src/mechanisms/room-voice.js";
import type { ActKind } from "../src/mind/affordances.js";
import type { AliceEvent } from "../src/mind/events.js";
import { emptyChat, type TimelineEntry } from "../src/mind/state.js";

const T0 = 1_771_000_000_000;
const DAY = 24 * 60 * 60_000;
const OFFERED: ActKind[] = ["send", "sticker", "react", "think", "voice"];

describe("group examples", () => {
  it("include a reaction only", () => {
    expect(GROUP_SILENT.some((e) => e.acts.some((a) => a.kind === "react"))).toBe(true);
    const shown = (
      palette.contribute?.(emptyChat("telegram:-1", "group", true), T0, undefined, OFFERED) ?? []
    ).flatMap((c) => c.examples ?? []);
    expect(shown.some((e) => e.acts.some((a) => a.kind === "react"))).toBe(true);
  });
});

/** 一个群里 n 条群友的消息：六个人轮流说（说得多的前一半是三个人），每隔一条引用上一条。 */
function room(scope: string, n: number, text: (i: number) => string): AliceEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    type: "message.received" as const,
    at: T0 + i * 10_000,
    scope,
    chatType: "group" as const,
    messageId: `${scope}:${i}`,
    senderId: `u${i % 6}`,
    senderName: `成员${i % 6}`,
    text: text(i),
    contentType: "text",
    replyToMessageId: i % 2 ? `${scope}:${i - 1}` : null,
    directed: false,
  }));
}
const fold = (events: AliceEvent[]) =>
  events.reduce<RoomState>(reduceRoom, roomVoice.initial as RoomState);
const shownIn = (
  scope: string,
  state: RoomState,
  chatType: "group" | "private" = "group",
  timeline: TimelineEntry[] = [],
) =>
  (
    roomVoice.contribute?.(
      { ...emptyChat(scope, chatType, true), timeline },
      T0 + DAY,
      state,
      OFFERED,
    ) ?? []
  )
    .map((c) => c.text)
    .join("\n");

describe("room-voice: how this room types", () => {
  const A = "telegram:-100";
  const B = "telegram:-200";
  const words = ["ну да", "кто знает", "я тоже так", "а что там", "да ладно тебе"];
  const events = room(A, 80, (i) => `${words[i % 5]} n${i}`);

  it("is in production, last", () => {
    expect(mechanisms.at(-1)).toBe(roomVoiceGolden);
  });

  it("says nothing before the cold-start threshold", () => {
    expect(shownIn(A, fold(room(A, 40, (i) => words[i % 5] as string)))).toBe("");
  });

  it("states the room's scale, quoting by situation, sentences and turns once past it", () => {
    const text = shownIn(A, fold(events));
    expect(text).toContain("这个群的人平时怎么打字");
    expect(text).toMatch(/一条文字通常 \S+ 个词/);
    expect(text).toMatch(
      /多半只有一句话，两句以上的\S+；想多说时常分成几条接着发（平均一轮 [\d.]+ 条）/,
    );
    expect(text).toContain("群友的引用回复里，挂在紧挨着的上一条上的约 100%");
    expect(text).toContain(
      "有人回复了某个群友，这个群友接着说话时，约 100% 没有把那条回复再引用回去",
    );
    expect(text).toContain("群友之间的几段接话（看他们怎么断句和接话，不照抄具体词句）");
    expect(text).toContain("（回复成员B）");
  });

  it("adds her own recent exclamations from 10 lines on", () => {
    const mine = (n: number): AliceEvent[] =>
      Array.from({ length: n }, (_, i) => ({
        type: "message.sent" as const,
        at: T0 + 900_000 + i,
        scope: A,
        messageId: `me${i}`,
        text: i < 5 ? "好耶！" : "嗯",
        kind: "text" as const,
      }));
    expect(shownIn(A, fold([...events, ...mine(12)]))).toContain(
      "（你最近在这里发的 12 句里有 5 句带感叹号）",
    );
    expect(shownIn(A, fold([...events, ...mine(9)]))).not.toContain("你最近在这里发的");
  });

  it("never shows a line she can already see in the record", () => {
    const seen = events
      .filter((e): e is AliceEvent & { type: "message.received" } => e.type === "message.received")
      .map((e) => ({
        at: e.at,
        messageId: e.messageId,
        sender: { id: e.senderId, name: e.senderName },
        text: e.text,
        contentType: e.contentType,
        replyToMessageId: e.replyToMessageId,
      }));
    expect(shownIn(A, fold(events), "group", seen)).not.toContain("群友之间的几段接话");
  });

  it("never carries one room's lines into another room or a private chat", () => {
    const state = fold([
      ...room(A, 80, (i) => `${words[i % 5]} alpha${i}`),
      ...room(B, 80, (i) => `${words[i % 5]} beta${i}`),
    ]);
    expect(shownIn(A, state)).toContain("alpha");
    expect(shownIn(A, state)).not.toContain("beta");
    expect(shownIn(B, state)).not.toContain("alpha");
    expect(shownIn(A, state, "private")).toBe("");
  });

  it("keeps bots, commands, profanity and lines at her out of the shown exchanges", () => {
    const evs = room(A, 80, (i) =>
      i % 8 === 1 ? "да ебать ты" : i % 8 === 3 ? "алиса ты где" : (words[i % 5] as string),
    );
    const bot: AliceEvent = {
      ...(evs[0] as AliceEvent & { type: "message.received" }),
      messageId: "b",
      senderId: "bot",
      text: "Сохранен 1 фильтр",
      isBot: true,
    };
    const text = shownIn(A, fold([...evs, bot]));
    expect(text).not.toContain("ебать");
    expect(text).not.toContain("алиса");
    expect(text).not.toContain("фильтр");
  });
});
