import { describe, expect, it } from "vitest";
import { decodeEvent } from "../src/journal.js";
import type { MessageReceived } from "../src/mind/events.js";
import { emptyState, type TimelineEntry } from "../src/mind/state.js";
import { step } from "../src/mind/step.js";
import { describeMedia, mediaLabel } from "../src/speech/media.js";
import { logLines } from "../src/speech/prompt.js";

const entry = (over: Partial<TimelineEntry>): TimelineEntry => ({
  at: 0,
  messageId: "1",
  sender: { id: "u1", name: "阿杰" },
  text: null,
  contentType: "text",
  replyToMessageId: null,
  ...over,
});

describe("what she sees of a non-text message", () => {
  it("keeps what Telegram already tells: the sticker's emoji, a link's title and summary, a voice note's length", () => {
    expect(describeMedia({ type: "sticker", emoji: "😂" })).toBe("贴纸 😂");
    expect(describeMedia({ type: "voice", seconds: 7.6 })).toBe("语音 8 秒");
    expect(
      describeMedia({
        type: "webpage",
        title: "台风今晚登陆",
        description: "气象台发布红色预警，沿海地区停课停工。",
        siteName: "新闻网",
      }),
    ).toBe("链接：台风今晚登陆——气象台发布红色预警，沿海地区停课停工。");
    expect(describeMedia({ type: "webpage", title: null, description: null, siteName: null })).toBe(
      "链接",
    );
  });

  it("a captioned photo still reads as a photo, and old data without a description gets a plain Chinese label", () => {
    const [captioned, oldSticker] = logLines([
      entry({ contentType: "photo", media: "图片", text: "看我家猫" }),
      entry({ messageId: "2", contentType: "sticker" }),
    ]);
    expect(captioned).toMatch(/ \[1\] <阿杰> \[图片\] 看我家猫$/);
    expect(oldSticker).toMatch(/ \[2\] <阿杰> \[贴纸\]$/);
  });

  it("an image description that arrives later replaces that message's line, never her own, and a stale id changes nothing", () => {
    const photo: MessageReceived = {
      type: "message.received",
      at: 1,
      scope: "telegram:1",
      chatType: "private",
      messageId: "7",
      senderId: "u1",
      senderName: "阿杰",
      text: "看",
      contentType: "photo",
      media: "图片",
      replyToMessageId: null,
      directed: true,
    };
    let state = step(emptyState, photo, []).state;
    state = step(
      state,
      {
        type: "message.sent",
        at: 2,
        scope: "telegram:1",
        messageId: "8",
        text: "嗯",
        kind: "text",
      },
      [],
    ).state;
    const seen = (messageId: string, media: string) =>
      step(state, { type: "message.perceived", at: 3, scope: "telegram:1", messageId, media }, []);
    const after = seen("7", "图片：一只橘猫趴在键盘上");
    expect(logLines(after.state.chats["telegram:1"]?.timeline ?? [])[0]).toMatch(
      / \[7\] <阿杰> \[图片：一只橘猫趴在键盘上\] 看$/,
    );
    expect(after.effects).toEqual([]);
    expect(seen("8", "图片：x").state).toBe(state);
    expect(seen("99", "图片：x").state).toBe(state);
    expect(
      decodeEvent("message.perceived", "telegram:1", {
        type: "message.perceived",
        at: 3,
        scope: "telegram:1",
        messageId: "7",
        media: "图片：猫",
      }),
    ).not.toBeNull();
  });

  it("journal rows with and without the description both read back", () => {
    const base = {
      type: "message.received",
      at: 1,
      scope: "telegram:1",
      chatType: "group",
      messageId: "1",
      senderId: "u1",
      senderName: "阿杰",
      text: null,
      contentType: "sticker",
      replyToMessageId: null,
      directed: false,
    };
    expect(decodeEvent("message.received", "telegram:1", base)).not.toBeNull();
    expect(
      decodeEvent("message.received", "telegram:1", { ...base, media: "贴纸 😂" }),
    ).toMatchObject({ media: "贴纸 😂" });
    expect(decodeEvent("message.received", "telegram:1", { ...base, media: 3 })).toBeNull();
  });
});

describe("names that exist on every object are not known types", () => {
  it("a message type such as constructor reads as a plain message", () => {
    expect(mediaLabel("constructor")).toBe("消息");
    expect(mediaLabel("sticker")).toBe("贴纸");
  });
  it("a journal row whose type is toString is not an event", () => {
    expect(
      decodeEvent("toString", "telegram:1", { type: "toString", scope: "telegram:1" }),
    ).toBeNull();
  });
});
