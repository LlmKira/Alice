import { describe, expect, it } from "vitest";
import { isGroupAttentionWorthy } from "../src/mechanisms/pressure/group-filter.js";
import type { MessageReceived } from "../src/mind/events.js";

const T0 = 1_771_000_000_000;

const msg = (overrides: Partial<MessageReceived> = {}): MessageReceived => ({
  type: "message.received",
  at: T0,
  scope: "telegram:-100",
  chatType: "group",
  messageId: "1",
  senderId: "u1",
  senderName: "小周",
  text: "在聊什么",
  contentType: "text",
  replyToMessageId: null,
  directed: false,
  ...overrides,
});

describe("isGroupAttentionWorthy: which group messages are worth her attention", () => {
  it("keeps ordinary group chatter; private chat is always worth it", () => {
    expect(isGroupAttentionWorthy(msg())).toBe(true);
    expect(isGroupAttentionWorthy(msg({ chatType: "private" }))).toBe(true);
    expect(isGroupAttentionWorthy(msg({ chatType: "private", isBot: true }))).toBe(true);
    expect(
      isGroupAttentionWorthy(msg({ chatType: "private", text: null, contentType: "sticker" })),
    ).toBe(true);
  });

  it("keeps anything aimed at her, whatever its shape", () => {
    expect(
      isGroupAttentionWorthy(msg({ directed: true, text: null, contentType: "sticker" })),
    ).toBe(true);
    expect(isGroupAttentionWorthy(msg({ directed: true, text: "@someone 你好" }))).toBe(true);
    expect(isGroupAttentionWorthy(msg({ directed: true, isBot: true }))).toBe(true);
  });

  it("drops bot chatter in groups", () => {
    expect(isGroupAttentionWorthy(msg({ isBot: true }))).toBe(false);
  });

  it("drops bare stickers, photos, videos and voice notes with no caption", () => {
    for (const contentType of ["sticker", "photo", "video", "voice"]) {
      expect(isGroupAttentionWorthy(msg({ contentType, text: null }))).toBe(false);
      expect(isGroupAttentionWorthy(msg({ contentType, text: "   " }))).toBe(false);
      // 有配文就是有人在说话。
      expect(isGroupAttentionWorthy(msg({ contentType, text: "看这个" }))).toBe(true);
    }
  });

  it("drops messages that @ someone else", () => {
    expect(isGroupAttentionWorthy(msg({ text: "@bob 晚上打游戏吗" }))).toBe(false);
    expect(isGroupAttentionWorthy(msg({ text: "问一下 @bob 的意见" }))).toBe(false);
    expect(isGroupAttentionWorthy(msg({ text: "问一下，@bob 的意见" }))).toBe(false);
    // 不是 @ 用户名（邮件、话题标签）照旧算有人在说话。
    expect(isGroupAttentionWorthy(msg({ text: "mail me at bob@example.com" }))).toBe(true);
    expect(isGroupAttentionWorthy(msg({ text: "#今天也很困" }))).toBe(true);
  });

  it("drops a message the platform marked as @ someone else, even when the name is not a username", () => {
    // QQ 的 at 段：名字是中文，文字里的 @ 认不出来，适配器标了 mentionsOther。
    expect(isGroupAttentionWorthy(msg({ text: "@小李 明天几点", mentionsOther: true }))).toBe(
      false,
    );
    expect(isGroupAttentionWorthy(msg({ text: "@小李 明天几点" }))).toBe(true);
    // 冲着她的照旧算（点了她也点了别人）。
    expect(
      isGroupAttentionWorthy(
        msg({ text: "@小李 @Alice 你们", mentionsOther: true, directed: true }),
      ),
    ).toBe(true);
  });

  it("keeps a text message with no text (nothing to filter on)", () => {
    expect(isGroupAttentionWorthy(msg({ text: null }))).toBe(true);
  });
});
