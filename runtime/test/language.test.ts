import { describe, expect, it } from "vitest";
import { language } from "../src/mechanisms/language.js";
import { pressureProduction } from "../src/mechanisms/pressure/index.js";
import { emptyWorld, reduceWorld } from "../src/mechanisms/pressure/world.js";
import type { SpeechRequest } from "../src/mind/effects.js";
import type { AliceEvent } from "../src/mind/events.js";
import { type ChatState, emptyChat, emptyState, type TimelineEntry } from "../src/mind/state.js";
import { step } from "../src/mind/step.js";
import { renderSpeechPrompt } from "../src/speech/prompt.js";

let n = 0;
const line = (name: string | null, text: string): TimelineEntry => ({
  at: ++n,
  messageId: String(n),
  sender: name ? { id: `u-${name}`, name } : null,
  text,
  contentType: "text",
  replyToMessageId: null,
});
const chat = (timeline: TimelineEntry[]): ChatState => ({
  ...emptyChat("telegram:1", "group", true),
  timeline,
});
const fact = (timeline: TimelineEntry[]) =>
  language.contribute?.(chat(timeline), 0, undefined, []).map((c) => c.text);

describe("who speaks which language, stated as a fact", () => {
  it("names the language each recent speaker uses, judged from their last few lines together", () => {
    expect(
      fact([line("Миша", "привет"), line("Миша", "я так устал сегодня, работа просто убивает")]),
    ).toEqual(["Миша 用俄语跟你说话。"]);
    expect(
      fact([
        line("阿杰", "今晚谁打游戏"),
        line("小周", "我九点上线 yysy 这个确实"),
        line("Tom", "@alice do you play any games? I'm new here"),
      ]),
    ).toEqual(["Tom 用英语跟你说话；小周、阿杰 用中文跟你说话。"]);
  });

  it("says nothing for text too short to tell (a wrong language fact is worse than none)", () => {
    expect(fact([line("老周", "Alice，早。")])).toEqual([]);
  });

  it("never counts her own lines, and says nothing when nobody else has spoken", () => {
    expect(
      fact([line(null, "привет"), line("Jake", "hey alice, how was your day? mine was rough")]),
    ).toEqual(["Jake 用英语跟你说话。"]);
    expect(fact([line(null, "在吗")])).toEqual([]);
  });

  it("never counts bots as people speaking to her (live: 'Rose 用俄语跟你说话', Rose is the group's bot)", () => {
    const bot: TimelineEntry = {
      ...line("Rose", "Прекрати флудить! Бобер был muted for 2 минут."),
      sender: { id: "u-Rose", name: "Rose", isBot: true },
    };
    expect(fact([line("Миша", "я так устал сегодня, работа просто убивает"), bot])).toEqual([
      "Миша 用俄语跟你说话。",
    ]);
  });
  it("bot commands, hashtags and replies to a bot are not someone speaking a language (live: a '!' bot command read as Belarusian)", () => {
    const rose: TimelineEntry = {
      ...line("Rose", "Добро пожаловать в чат, гость!"),
      sender: { id: "u-Rose", name: "Rose", isBot: true },
    };
    const toBot: TimelineEntry = {
      ...line("Oleg", "покажи ещё одну картинку пожалуйста"),
      replyToMessageId: rose.messageId,
    };
    const timeline = [
      line("Миша", "я так устал сегодня, работа просто убивает"),
      rose,
      toBot,
      line("Ника", "!погода"),
      line("Ника", "!погода"),
      line("Ника", "/погода@WeatherBot"),
      line("Сева", "#кино #чайник"),
      line("Сева", "#кино"),
      line("Сева", "#чайник #чайник"),
    ];
    expect(fact(timeline)).toEqual(["Миша 用俄语跟你说话。"]);
  });

  it("a person's language is what most of their lines are in: one long pasted English prompt does not make a Chinese speaker English (live 11-13)", () => {
    const paste = `@小周 ${"The girl with fox ears in <Picture 1> is <Subject 1>. The ribbon above her head in <Picture 1> is <Subject 2>. Keep the watercolor style, soft light, a river bank and a melting ice cream. ".repeat(8)}`;
    expect(
      fact([
        line("阿杰", "用第一帧呢。"),
        line("阿杰", "太卡了"),
        line("阿杰", paste),
        line("阿杰", "就这张图改"),
        line("阿杰", "这个模型能补对么"),
      ]),
    ).toEqual(["阿杰 用中文跟你说话。"]);
  });

  it("an English picture description is what she saw, not what the sender said: it never sets their language", () => {
    const photo = (id: string, caption: string | null): AliceEvent => ({
      type: "message.received",
      at: Number(id),
      scope: "telegram:-1",
      chatType: "group",
      messageId: id,
      senderId: "u-阿杰",
      senderName: "阿杰",
      text: caption,
      contentType: "photo",
      media: "图片",
      replyToMessageId: null,
      directed: false,
    });
    const seen = (id: string): AliceEvent => ({
      type: "message.perceived",
      at: Number(id) + 1,
      scope: "telegram:-1",
      messageId: id,
      media: `图片：${"A girl with fox ears stands on a river bank holding a melting ice cream; the caption reads 'SUMMER IS OVER'. ".repeat(3)}`,
    });
    const events = [
      photo("10", "今天下午画的，狐狸耳朵那里改了好几遍"),
      seen("10"),
      photo("20", null),
      seen("20"),
      photo("30", "这张是昨天的草稿"),
      seen("30"),
    ];
    const state = events.reduce((s, e) => step(s, e, []).state, emptyState);
    const group = state.chats["telegram:-1"];
    expect(group?.timeline.every((e) => e.media?.startsWith("图片：A girl"))).toBe(true);
    expect(language.contribute?.(group as ChatState, 0, undefined, []).map((c) => c.text)).toEqual([
      "阿杰 用中文跟你说话。",
    ]);
  });

  it("on a group wake nobody sought she speaks the room's language; when someone seeks her, that person's", () => {
    const timeline = [
      line("小周", "今晚谁打游戏，我九点上线"),
      line("小米", "我也来，带我一个吧，上次输惨了"),
      line("Tom", "anyone up for ranked tonight? I'm new here and looking for a team"),
    ];
    const told = language.contribute?.(chat(timeline), 0, undefined, []) ?? [];
    const request = (unsought: boolean): SpeechRequest => ({
      scope: "telegram:-1",
      chatType: "group",
      triggerMessageId: null,
      at: 60_000,
      affordances: ["send"],
      timeline,
      contributions: [
        {
          mechanism: "pressure-unsought",
          kind: "turn",
          text: "这会儿没人点你。",
          ...(unsought ? { unsought: true as const } : {}),
        },
        ...told,
      ],
    });
    const anchor = (r: SpeechRequest) => renderSpeechPrompt("P", r).user.split("\n").at(-1) ?? "";
    expect(anchor(request(true))).not.toContain("英语");
    expect(anchor(request(false))).toContain("请用英语");
  });

  it("when nobody sought her in a group they are not speaking to her: the anchor says what they speak", () => {
    const timeline = [line("阿杰", "今晚谁打游戏"), line("小周", "我九点上线 yysy 这个确实")];
    const told = language.contribute?.(chat(timeline), 0, undefined, []) ?? [];
    expect(told[0]?.unsoughtText).toBe("小周、阿杰 在说中文。");
    const request = (unsought: boolean): SpeechRequest => ({
      scope: "telegram:-1",
      chatType: "group",
      triggerMessageId: null,
      at: 60_000,
      affordances: ["send"],
      timeline,
      contributions: [
        {
          mechanism: "pressure-unsought",
          kind: "turn",
          text: "这会儿没人点你。",
          ...(unsought ? { unsought: true as const } : {}),
        },
        ...told,
      ],
    });
    const anchor = (r: SpeechRequest) => renderSpeechPrompt("P", r).user.split("\n").at(-2);
    expect(anchor(request(true))).toContain("这会儿没人点你。小周、阿杰 在说中文。");
    expect(anchor(request(true))).not.toContain("跟你说话");
    // 有人找她时仍写"用……跟你说话"。
    expect(anchor(request(false))).toContain("小周、阿杰 用中文跟你说话。");
  });

  it("marks both group and private unsought wakes so quiet DMs do not falsely say speaking to you", () => {
    const received = (scope: string, chatType: "group" | "private"): AliceEvent => ({
      type: "message.received",
      at: 1_771_000_000_000,
      scope,
      chatType,
      messageId: "1",
      senderId: "contact:1",
      senderName: "阿杰",
      text: "今晚谁打游戏",
      contentType: "text",
      replyToMessageId: null,
      directed: false,
    });
    const unsought = (scope: string, chatType: "group" | "private") =>
      pressureProduction
        .contribute?.(
          emptyChat(scope, chatType, true),
          1_771_000_000_000 + 6 * 3_600_000 + 60_000,
          reduceWorld(emptyWorld, received(scope, chatType)),
          [],
        )
        .find((c) => c.mechanism === "pressure-unsought");
    expect(unsought("telegram:-1", "group")?.unsought).toBe(true);
    expect(unsought("telegram:1", "private")?.unsought).toBe(true);
    const dmChat = emptyChat("telegram:1", "private", true);
    dmChat.timeline = [line("Ваня", "привет, как дела у тебя сегодня")];
    const told = language.contribute?.(dmChat, 0, undefined, []) ?? [];
    expect(told[0]?.unsoughtText).toBe("Ваня 平时说俄语。");
    expect(told[0]?.unsoughtLanguage).toBe("俄语");
  });
});
