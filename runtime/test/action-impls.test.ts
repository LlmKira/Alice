/**
 * Telegram action impl 单元测试 — 22 个动作的核心行为验证。
 *
 * 测试覆盖：
 * - 19 个写操作 impl（sendMessageImpl → createInviteLinkImpl）
 * - 8 个读操作 impl（listStickersImpl → readNotesImpl）
 * 每个 impl 至少验证：正常路径、缺失参数、图副作用、dispatcher 调用。
 *
 * @see src/telegram/action-defs.ts — impl 定义
 * @see src/core/action-executor.ts — ActionImplContext 构建
 */

import { Long } from "@mtcute/node";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionImplContext } from "../src/telegram/action-types.js";
import { setExplorationGuard, TELEGRAM_ACTION_MAP } from "../src/telegram/actions/index.js";
import * as actions from "../src/telegram/actions.js";
import { ExplorationGuard } from "../src/telegram/exploration-guard.js";

// ── Mock telegram/actions.js ────────────────────────────────────────────────

vi.mock("../src/telegram/actions.js", () => ({
  sendText: vi.fn().mockResolvedValue(undefined),
  markRead: vi.fn().mockResolvedValue(undefined),
  sendReaction: vi.fn().mockResolvedValue(undefined),
  editMessage: vi.fn().mockResolvedValue(undefined),
  forwardMessage: vi.fn().mockResolvedValue(undefined),
  sendSticker: vi.fn().mockResolvedValue(undefined),
  pinMessage: vi.fn().mockResolvedValue(undefined),
  sendMedia: vi.fn().mockResolvedValue(undefined),
  deleteMessages: vi.fn().mockResolvedValue(undefined),
  joinChat: vi.fn().mockResolvedValue({ pending: false }),
  leaveChat: vi.fn().mockResolvedValue(undefined),
  unpinMessage: vi.fn().mockResolvedValue(undefined),
  getCallbackAnswer: vi.fn().mockResolvedValue({ message: "OK", url: null, alert: false }),
  getInlineBotResults: vi.fn().mockResolvedValue({
    queryId: Long.fromNumber(12345),
    results: [{ id: "r1", title: "Result 1", description: "desc", type: "article" }],
  }),
  sendInlineBotResult: vi.fn().mockResolvedValue(undefined),
  getInstalledStickers: vi.fn().mockResolvedValue([
    { shortName: "cats", title: "Funny Cats", count: 30 },
    { shortName: "dogs", title: "Happy Dogs", count: 20 },
  ]),
  getStickerSet: vi.fn().mockResolvedValue({
    shortName: "cats",
    title: "Funny Cats",
    isFull: true,
    stickers: [{ sticker: { fileId: "abc123" }, alt: "😺" }],
  }),
  searchPublicChats: vi.fn().mockResolvedValue({
    users: [{ id: 1, name: "User1" }],
    chats: [{ id: 2, title: "Chat1" }],
  }),
  getChatPreview: vi.fn().mockResolvedValue({
    title: "Test Group",
    type: "supergroup",
    memberCount: 100,
    withApproval: false,
  }),
  getSimilarChannels: vi.fn().mockResolvedValue([
    { id: 201, title: "Channel A" },
    { id: 202, title: "Channel B" },
  ]),
  getBotCommands: vi.fn().mockResolvedValue([
    { command: "start", description: "Start the bot" },
    { command: "help", description: "Show help" },
  ]),
  updateProfile: vi.fn().mockResolvedValue(undefined),
  readSavedMessages: vi.fn().mockResolvedValue([
    { id: 1, text: "My note", date: new Date("2025-01-15") },
    { id: 2, text: "Another note", date: new Date("2025-01-14") },
  ]),
  createInviteLink: vi.fn().mockResolvedValue({ link: "https://t.me/+abc123" }),
  translateMessage: vi.fn().mockResolvedValue({ text: "Hello" }),
  getCommonChats: vi.fn().mockResolvedValue([]),
  getHistory: vi.fn().mockResolvedValue([]),
  getMessages: vi.fn().mockResolvedValue([]),
  setTyping: vi.fn().mockResolvedValue(undefined),
}));

// ── Mock sticker-palette（send_sticker impl 依赖）──────────────────────────
vi.mock("../src/telegram/apps/sticker-palette.js", () => ({
  resolveLabel: vi.fn().mockReturnValue(null),
  resolveByEmoji: vi.fn().mockReturnValue(null),
  KEYWORD_TO_EMOJI: {},
  getAvailableKeywords: vi.fn().mockReturnValue("Emotions: happy, sad. Actions: hug, laugh"),
}));

// ── Mock db/connection（send_sticker impl 调用 getDb）──────────────────────
vi.mock("../src/db/connection.js", () => ({
  getDb: vi.fn().mockReturnValue({}),
}));

// ── Mock context 工厂 ────────────────────────────────────────────────────────

function createMockContext(overrides?: Partial<ActionImplContext>): ActionImplContext {
  const mockG = {
    has: vi.fn().mockReturnValue(true),
    setDynamic: vi.fn(),
    getDynamic: vi.fn().mockReturnValue(undefined),
    getChannel: vi.fn().mockReturnValue({
      entity_type: "channel",
      unread: 0,
      tier_contact: 150,
      chat_type: "group",
      pending_directed: 0,
      last_directed_ms: 0,
    }),
    getContact: vi.fn().mockReturnValue({
      entity_type: "contact",
      tier: 150,
      last_active_ms: 0,
      auth_level: 0,
      interaction_count: 0,
    }),
    getAgent: vi.fn().mockReturnValue({ entity_type: "agent", mood_valence: 0, mood_set_ms: 0 }),
    getConversation: vi.fn().mockReturnValue({
      entity_type: "conversation",
      channel: "",
      participants: [],
      state: "pending",
      start_ms: 0,
      last_activity_ms: 0,
      turn_state: "open",
      pace: 0,
      message_count: 0,
      alice_message_count: 0,
    }),
    getPredecessors: vi.fn().mockReturnValue([]),
  };
  return {
    client: {},
    G: mockG,
    dispatcher: { dispatch: vi.fn() },
    tick: 42,
    log: { info: vi.fn(), warn: vi.fn() },
    parseChatId: (id: string | number) => {
      if (typeof id === "number") return id;
      if (id.startsWith("channel:")) return Number(id.slice(8));
      if (id.startsWith("contact:")) return Number(id.slice(8));
      return Number(id);
    },
    ensureGraphId: (id: string | number) =>
      typeof id === "number"
        ? `channel:${id}`
        : id.startsWith("channel:") || id.startsWith("contact:")
          ? id
          : `channel:${id}`,
    ttsConfig: { ttsBaseUrl: "", ttsApiKey: "", ttsModel: "tts-1", ttsVoice: "" },
    exaApiKey: "",
    musicApiBaseUrl: "",
    youtubeApiKey: "",
    timezoneOffset: 8,
    ...overrides,
  } as unknown as ActionImplContext;
}

/** 从注册表获取 impl 函数。 */
function getImpl(name: string) {
  const def = TELEGRAM_ACTION_MAP.get(name);
  if (!def) throw new Error(`Action "${name}" not found in TELEGRAM_ACTION_MAP`);
  return def.impl;
}

// 注入全通 ExplorationGuard，避免 guard 影响 impl 测试
// （所有 budget/cooldown 设为极大值，不会触发拦截）
beforeEach(() => {
  setExplorationGuard(
    new ExplorationGuard({
      maxJoinsPerDay: 9999,
      maxSearchPerHour: 9999,
      joinCooldownMs: 0,
      searchCooldownMs: 0,
      postJoinSearchCooldownMs: 0,
      silentDurationS: 0,
      apprenticeDurationS: 0,
      apprenticeMaxMessages: 9999,
      circuitBreakerThreshold: 9999,
      circuitBreakerOpenMs: 0,
    }),
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 写操作 impl（15 个）
// ═══════════════════════════════════════════════════════════════════════════

describe("sendMessageImpl", () => {
  const impl = getImpl("send_message");
  let ctx: ActionImplContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockContext();
  });

  it("正常调用 → 返回 ActionImplResult + 调用 sendText", async () => {
    const ok = await impl(ctx, { chatId: 123, text: "hello" });
    expect(ok).toEqual({ success: true, msgId: undefined, obligationsConsumed: 1 });
    expect(actions.sendText).toHaveBeenCalledWith(ctx.client, 123, "hello", {
      replyToMsgId: undefined,
      mentions: undefined,
    });
  });

  it("缺失 chatId → 返回 false", async () => {
    expect(await impl(ctx, { text: "hello" })).toBe(false);
    expect(actions.sendText).not.toHaveBeenCalled();
  });

  it("缺失 text → 返回 false", async () => {
    expect(await impl(ctx, { chatId: 1 })).toBe(false);
    expect(actions.sendText).not.toHaveBeenCalled();
  });

  it("图副作用：last_outgoing_text 存储（pending_directed 递减移至 loop.ts applyFeedbackArc）", async () => {
    await impl(ctx, { chatId: 1, text: "hi" });
    // Pillar 4: pending_directed 不在 impl 中清零，由 applyFeedbackArc 在 Telegram 确认后统一递减
    expect(ctx.G.setDynamic).not.toHaveBeenCalledWith("channel:1", "pending_directed", 0);
    expect(ctx.G.setDynamic).toHaveBeenCalledWith("channel:1", "last_outgoing_text", "hi");
  });

  it("dispatcher: SEND_MESSAGE + DECLARE_ACTION", async () => {
    await impl(ctx, { chatId: 1, text: "hi" });
    expect(ctx.dispatcher.dispatch).toHaveBeenCalledWith("SEND_MESSAGE", {
      chatId: "channel:1",
      text: "hi",
      msgId: undefined,
    });
    expect(ctx.dispatcher.dispatch).toHaveBeenCalledWith("DECLARE_ACTION", { target: "channel:1" });
  });

  it("replyTo + mentions 正确传递", async () => {
    const mentions = [{ offset: 0, length: 5, userId: 999 }];
    await impl(ctx, { chatId: 1, text: "@user hello", replyTo: 42, mentions });
    expect(actions.sendText).toHaveBeenCalledWith(ctx.client, 1, "@user hello", {
      replyToMsgId: 42,
      mentions,
    });
  });

  it("图节点不存在时跳过 setNodeAttr", async () => {
    (ctx.G.has as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await impl(ctx, { chatId: 1, text: "hi" });
    expect(ctx.G.setDynamic).not.toHaveBeenCalled();
  });
});

describe("markReadImpl", () => {
  const impl = getImpl("mark_read");
  let ctx: ActionImplContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockContext();
  });

  it("正常调用 → 返回 true", async () => {
    expect(await impl(ctx, { chatId: 5 })).toBe(true);
    expect(actions.markRead).toHaveBeenCalledWith(ctx.client, 5);
  });

  it("缺失 chatId → 返回 false", async () => {
    expect(await impl(ctx, {})).toBe(false);
    expect(actions.markRead).not.toHaveBeenCalled();
  });

  it("图副作用：unread/mentions_alice 清零（pending_directed 不清零）", async () => {
    await impl(ctx, { chatId: 10 });
    expect(ctx.G.setDynamic).toHaveBeenCalledWith("channel:10", "unread", 0);
    // pending_directed 不随 mark_read 清零——已读 ≠ 已回复
    // 回复义务由 send_message 等实际回复动作递减消解
    expect(ctx.G.setDynamic).not.toHaveBeenCalledWith("channel:10", "pending_directed", 0);
    expect(ctx.G.setDynamic).toHaveBeenCalledWith("channel:10", "mentions_alice", false);
  });
});

describe("reactImpl", () => {
  const impl = getImpl("react");
  let ctx: ActionImplContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockContext();
  });

  it("正常调用 → 返回 true", async () => {
    expect(await impl(ctx, { chatId: 1, msgId: 100, emoji: "👍" })).toBe(true);
    expect(actions.sendReaction).toHaveBeenCalledWith(ctx.client, 1, 100, "👍");
  });

  it("缺失 emoji → 返回 false", async () => {
    expect(await impl(ctx, { chatId: 1, msgId: 100 })).toBe(false);
  });

  it("缺失 msgId → 返回 false", async () => {
    expect(await impl(ctx, { chatId: 1, emoji: "👍" })).toBe(false);
  });

  it("dispatcher: DECLARE_ACTION", async () => {
    await impl(ctx, { chatId: 1, msgId: 100, emoji: "👍" });
    expect(ctx.dispatcher.dispatch).toHaveBeenCalledWith("DECLARE_ACTION", {
      target: "channel:1",
      isMessage: false,
    });
  });
});

describe("editMessageImpl", () => {
  const impl = getImpl("edit_message");
  let ctx: ActionImplContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockContext();
  });

  it("正常调用 → 返回 true", async () => {
    expect(await impl(ctx, { chatId: 1, msgId: 200, text: "edited" })).toBe(true);
    expect(actions.editMessage).toHaveBeenCalledWith(ctx.client, 1, 200, "edited");
  });

  it("缺失 text → 返回 false", async () => {
    expect(await impl(ctx, { chatId: 1, msgId: 200 })).toBe(false);
  });

  it("缺失 msgId → 返回 false", async () => {
    expect(await impl(ctx, { chatId: 1, text: "edited" })).toBe(false);
  });
});

describe("forwardMessageImpl", () => {
  const impl = getImpl("forward_message");
  let ctx: ActionImplContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockContext();
  });

  it("正常调用 → 返回 ActionImplResult", async () => {
    const result = await impl(ctx, { fromChatId: 1, msgId: 50, toChatId: 2 });
    expect(result).toEqual({ success: true, obligationsConsumed: 1 });
    expect(actions.forwardMessage).toHaveBeenCalledWith(ctx.client, 1, 50, 2);
  });

  it("缺失 toChatId → 返回 false", async () => {
    expect(await impl(ctx, { fromChatId: 1, msgId: 50 })).toBe(false);
  });

  it("Pillar 4: pending_directed 不在 impl 中清零", async () => {
    await impl(ctx, { fromChatId: 1, msgId: 50, toChatId: 2 });
    expect(ctx.G.setDynamic).not.toHaveBeenCalledWith("channel:2", "pending_directed", 0);
  });

  it("DECLARE_ACTION 指向目标", async () => {
    await impl(ctx, { fromChatId: 1, msgId: 50, toChatId: 2 });
    expect(ctx.dispatcher.dispatch).toHaveBeenCalledWith("DECLARE_ACTION", { target: "channel:2" });
  });
});

describe("sendStickerImpl", () => {
  const impl = getImpl("send_sticker");
  let ctx: ActionImplContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockContext();
  });

  it("正常调用 → 返回 ActionImplResult", async () => {
    const result = await impl(ctx, { chatId: 1, sticker: "CAACAgIAAxkBAAI" });
    expect(result).toEqual({ success: true, obligationsConsumed: 1 });
    expect(actions.sendSticker).toHaveBeenCalledWith(ctx.client, 1, "CAACAgIAAxkBAAI", {
      replyToMsgId: undefined,
    });
  });

  it("缺失 sticker → 返回 ActionImplResult with error", async () => {
    const result = await impl(ctx, { chatId: 1 });
    expect(result).toMatchObject({ success: false });
    expect((result as { error?: string }).error).toBeTruthy();
  });

  it("非法 sticker 标签且非 raw fileId → 结构化失败 + 可操作指引", async () => {
    const result = await impl(ctx, { chatId: 1, sticker: "nonexistent_label" });
    expect(result).toMatchObject({ success: false });
    expect((result as { error?: string }).error).toContain("nonexistent_label");
  });

  it("replyTo 正确传递", async () => {
    await impl(ctx, { chatId: 1, sticker: "CAACAgIAAxkBAAJ", replyTo: 99 });
    expect(actions.sendSticker).toHaveBeenCalledWith(ctx.client, 1, "CAACAgIAAxkBAAJ", {
      replyToMsgId: 99,
    });
  });

  it("Pillar 4: pending_directed 不在 impl 中清零 + dispatcher", async () => {
    await impl(ctx, { chatId: 1, sticker: "CAACAgIAAxkBAAK" });
    expect(ctx.G.setDynamic).not.toHaveBeenCalledWith("channel:1", "pending_directed", 0);
    expect(ctx.dispatcher.dispatch).toHaveBeenCalledWith("DECLARE_ACTION", { target: "channel:1" });
  });
});

describe("pinMessageImpl", () => {
  const impl = getImpl("pin_message");
  let ctx: ActionImplContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockContext();
  });

  it("正常调用 → 返回 true", async () => {
    expect(await impl(ctx, { chatId: 1, msgId: 300 })).toBe(true);
    expect(actions.pinMessage).toHaveBeenCalledWith(ctx.client, 1, 300);
  });

  it("缺失 msgId → 返回 false", async () => {
    expect(await impl(ctx, { chatId: 1 })).toBe(false);
  });

  it("缺失 chatId → 返回 false", async () => {
    expect(await impl(ctx, { msgId: 300 })).toBe(false);
  });
});

describe("sendMediaImpl", () => {
  const impl = getImpl("send_media");
  let ctx: ActionImplContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockContext();
  });

  it("正常调用 → 返回 ActionImplResult", async () => {
    const result = await impl(ctx, { chatId: 1, fileId: "media_1" });
    expect(result).toEqual({ success: true, obligationsConsumed: 1 });
    expect(actions.sendMedia).toHaveBeenCalledWith(ctx.client, 1, "media_1", {
      caption: undefined,
      replyTo: undefined,
    });
  });

  it("缺失 fileId → 返回 false", async () => {
    expect(await impl(ctx, { chatId: 1 })).toBe(false);
  });

  it("caption + replyTo 正确传递", async () => {
    await impl(ctx, { chatId: 1, fileId: "m1", caption: "look!", replyTo: 10 });
    expect(actions.sendMedia).toHaveBeenCalledWith(ctx.client, 1, "m1", {
      caption: "look!",
      replyTo: 10,
    });
  });

  it("Pillar 4: pending_directed 不在 impl 中清零 + dispatcher", async () => {
    await impl(ctx, { chatId: 1, fileId: "m1" });
    expect(ctx.G.setDynamic).not.toHaveBeenCalledWith("channel:1", "pending_directed", 0);
    expect(ctx.dispatcher.dispatch).toHaveBeenCalledWith("DECLARE_ACTION", { target: "channel:1" });
  });
});

describe("deleteMessageImpl", () => {
  const impl = getImpl("delete_message");
  let ctx: ActionImplContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockContext();
  });

  it("正常调用 → 返回 true", async () => {
    expect(await impl(ctx, { chatId: 1, msgId: 500 })).toBe(true);
    expect(actions.deleteMessages).toHaveBeenCalledWith(ctx.client, 1, [500]);
  });

  it("缺失 msgId → 返回 false", async () => {
    expect(await impl(ctx, { chatId: 1 })).toBe(false);
  });

  it("缺失 chatId → 返回 false", async () => {
    expect(await impl(ctx, { msgId: 500 })).toBe(false);
  });
});

describe("joinChatImpl", () => {
  const impl = getImpl("join_chat");
  let ctx: ActionImplContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockContext();
  });

  it("正常调用 → 返回 true", async () => {
    expect(await impl(ctx, { chatIdOrLink: "https://t.me/+abc" })).toBe(true);
    expect(actions.joinChat).toHaveBeenCalledWith(ctx.client, "https://t.me/+abc");
  });

  it("缺失 chatIdOrLink → 返回 false", async () => {
    expect(await impl(ctx, {})).toBe(false);
    expect(actions.joinChat).not.toHaveBeenCalled();
  });

  it("pending 审批 → 仍返回 true", async () => {
    vi.mocked(actions.joinChat).mockResolvedValueOnce({ pending: true });
    const ok = await impl(ctx, { chatIdOrLink: "@group" });
    expect(ok).toBe(true);
    expect(ctx.log.info).toHaveBeenCalledWith("join_chat: request sent, pending approval", {
      chatIdOrLink: "@group",
    });
  });
});

describe("leaveChatImpl", () => {
  const impl = getImpl("leave_chat");
  let ctx: ActionImplContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockContext();
  });

  it("正常调用 → 返回 true", async () => {
    expect(await impl(ctx, { chatId: 1 })).toBe(true);
    expect(actions.leaveChat).toHaveBeenCalledWith(ctx.client, 1);
  });

  it("缺失 chatId → 返回 false", async () => {
    expect(await impl(ctx, {})).toBe(false);
  });
});

describe("unpinMessageImpl", () => {
  const impl = getImpl("unpin_message");
  let ctx: ActionImplContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockContext();
  });

  it("正常调用 → 返回 true", async () => {
    expect(await impl(ctx, { chatId: 1, msgId: 600 })).toBe(true);
    expect(actions.unpinMessage).toHaveBeenCalledWith(ctx.client, 1, 600);
  });

  it("缺失 msgId → 返回 false", async () => {
    expect(await impl(ctx, { chatId: 1 })).toBe(false);
  });

  it("缺失 chatId → 返回 false", async () => {
    expect(await impl(ctx, { msgId: 600 })).toBe(false);
  });
});

describe("clickInlineButtonImpl", () => {
  const impl = getImpl("click_inline_button");
  let ctx: ActionImplContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockContext();
  });

  it("正常调用 → 返回 true + 存储回调应答", async () => {
    expect(await impl(ctx, { chatId: 1, msgId: 10, data: "btn_1" })).toBe(true);
    expect(actions.getCallbackAnswer).toHaveBeenCalledWith(ctx.client, 1, 10, "btn_1");
    expect(ctx.G.setDynamic).toHaveBeenCalledWith("channel:1", "last_callback_answer", {
      msgId: 10,
      message: "OK",
      url: null,
      alert: false,
    });
  });

  it("缺失 data → 返回 false", async () => {
    expect(await impl(ctx, { chatId: 1, msgId: 10 })).toBe(false);
  });

  it("缺失 msgId → 返回 false", async () => {
    expect(await impl(ctx, { chatId: 1, data: "btn_1" })).toBe(false);
  });

  it("无 message 且无 url → 不存储回调应答", async () => {
    vi.mocked(actions.getCallbackAnswer).mockResolvedValueOnce({
      message: undefined,
      url: undefined,
      alert: false,
    });
    await impl(ctx, { chatId: 1, msgId: 10, data: "btn_1" });
    expect(ctx.G.setDynamic).not.toHaveBeenCalled();
  });
});

describe("inlineQueryImpl", () => {
  const impl = getImpl("inline_query");
  let ctx: ActionImplContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockContext();
  });

  it("正常调用 → 返回 true + 存储查询结果", async () => {
    expect(await impl(ctx, { botUsername: "@gif", query: "cat", chatId: 1 })).toBe(true);
    expect(actions.getInlineBotResults).toHaveBeenCalledWith(ctx.client, "@gif", 1, "cat");
    expect(ctx.G.setDynamic).toHaveBeenCalledWith("channel:1", "last_inline_query", {
      botUsername: "@gif",
      query: "cat",
      queryId: "12345",
      results: [{ id: "r1", title: "Result 1", description: "desc" }],
    });
  });

  it("缺失 botUsername → 返回 false", async () => {
    expect(await impl(ctx, { query: "cat", chatId: 1 })).toBe(false);
  });

  it("缺失 query → 返回 false", async () => {
    expect(await impl(ctx, { botUsername: "@gif", chatId: 1 })).toBe(false);
  });

  it("缺失 chatId → 返回 false", async () => {
    expect(await impl(ctx, { botUsername: "@gif", query: "cat" })).toBe(false);
  });
});

describe("sendInlineResultImpl", () => {
  const impl = getImpl("send_inline_result");
  let ctx: ActionImplContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockContext();
  });

  it("正常调用 → 返回 ActionImplResult", async () => {
    const result = await impl(ctx, { chatId: 1, queryId: "12345", resultId: "r1" });
    expect(result).toEqual({ success: true, obligationsConsumed: 1 });
    expect(actions.sendInlineBotResult).toHaveBeenCalled();
    // 验证 Long 参数
    const callArgs = vi.mocked(actions.sendInlineBotResult).mock.calls[0];
    expect(callArgs[1]).toBe(1); // rawId
    expect(callArgs[2]).toBeInstanceOf(Long);
    expect(callArgs[3]).toBe("r1");
  });

  it("缺失 queryId → 返回 false", async () => {
    expect(await impl(ctx, { chatId: 1, resultId: "r1" })).toBe(false);
  });

  it("缺失 resultId → 返回 false", async () => {
    expect(await impl(ctx, { chatId: 1, queryId: "123" })).toBe(false);
  });

  it("图副作用：last_inline_query 清除（pending_directed 递减移至 applyFeedbackArc）", async () => {
    await impl(ctx, { chatId: 1, queryId: "123", resultId: "r1" });
    expect(ctx.G.setDynamic).not.toHaveBeenCalledWith("channel:1", "pending_directed", 0);
    expect(ctx.G.setDynamic).toHaveBeenCalledWith("channel:1", "last_inline_query", null);
  });

  it("dispatcher: DECLARE_ACTION", async () => {
    await impl(ctx, { chatId: 1, queryId: "123", resultId: "r1" });
    expect(ctx.dispatcher.dispatch).toHaveBeenCalledWith("DECLARE_ACTION", { target: "channel:1" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 读操作 impl（7 个）
// ═══════════════════════════════════════════════════════════════════════════

describe("listStickersImpl", () => {
  const impl = getImpl("list_stickers");
  let ctx: ActionImplContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockContext();
  });

  it("正常调用 → 返回 true + 存储到 self 节点", async () => {
    expect(await impl(ctx, {})).toBe(true);
    expect(actions.getInstalledStickers).toHaveBeenCalledWith(ctx.client);
    expect(ctx.G.setDynamic).toHaveBeenCalledWith("self", "installed_stickers", [
      { shortName: "cats", title: "Funny Cats", count: 30 },
      { shortName: "dogs", title: "Happy Dogs", count: 20 },
    ]);
  });

  it("无参数也能调用（params 为空）", async () => {
    expect(await impl(ctx, {})).toBe(true);
  });

  it("self 节点不存在时跳过 setNodeAttr", async () => {
    (ctx.G.has as ReturnType<typeof vi.fn>).mockImplementation((id: string) => id !== "self");
    await impl(ctx, {});
    expect(ctx.G.setDynamic).not.toHaveBeenCalled();
  });

  it("限制最多 30 个贴纸集", async () => {
    const manySets = Array.from({ length: 50 }, (_, i) => ({
      shortName: `set${i}`,
      title: `Set ${i}`,
      count: i,
    }));
    // biome-ignore lint/suspicious/noExplicitAny: test — 部分 mock 数据
    vi.mocked(actions.getInstalledStickers).mockResolvedValueOnce(manySets as any);
    await impl(ctx, {});
    const storedValue = (ctx.G.setDynamic as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(storedValue).toHaveLength(30);
  });
});

describe("getStickerSetImpl", () => {
  const impl = getImpl("get_sticker_set");
  let ctx: ActionImplContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockContext();
  });

  it("正常调用 → 返回 true + 存储到 self 节点", async () => {
    expect(await impl(ctx, { setName: "cats" })).toBe(true);
    expect(actions.getStickerSet).toHaveBeenCalledWith(ctx.client, "cats");
    expect(ctx.G.setDynamic).toHaveBeenCalledWith("self", "last_sticker_set", {
      shortName: "cats",
      title: "Funny Cats",
      stickers: [{ fileId: "abc123", emoji: "😺" }],
    });
  });

  it("缺失 setName → 返回 false", async () => {
    expect(await impl(ctx, {})).toBe(false);
    expect(actions.getStickerSet).not.toHaveBeenCalled();
  });

  it("isFull=false → stickers 为空数组", async () => {
    const emptySet = {
      shortName: "empty",
      title: "Empty Set",
      isFull: false,
      stickers: [],
    } as unknown;
    vi.mocked(actions.getStickerSet).mockResolvedValueOnce(
      emptySet as Awaited<ReturnType<typeof actions.getStickerSet>>,
    );
    await impl(ctx, { setName: "empty" });
    const storedValue = (ctx.G.setDynamic as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(storedValue.stickers).toEqual([]);
  });
});

// ADR-145: searchMessagesImpl / searchGlobalImpl 已删除——由 searchLocalImpl (FTS5) 替代。
// searchLocalImpl 的测试在 test/fts.test.ts 中（数据库集成测试更合适）。

describe("searchPublicImpl", () => {
  const impl = getImpl("search_public");
  let ctx: ActionImplContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockContext();
  });

  it("正常调用 → 返回 true + 存储到 self 节点", async () => {
    expect(await impl(ctx, { query: "crypto" })).toBe(true);
    expect(actions.searchPublicChats).toHaveBeenCalledWith(ctx.client, "crypto");
    expect(ctx.G.setDynamic).toHaveBeenCalledWith("self", "last_search_public", {
      query: "crypto",
      users: [{ id: 1, name: "User1" }],
      chats: [{ id: 2, title: "Chat1" }],
    });
  });

  it("缺失 query → 返回 false", async () => {
    expect(await impl(ctx, {})).toBe(false);
  });

  it("log 输出用户和聊天数量", async () => {
    await impl(ctx, { query: "test" });
    expect(ctx.log.info).toHaveBeenCalledWith("search_public executed", {
      query: "test",
      users: 1,
      chats: 1,
    });
  });
});

describe("previewChatImpl", () => {
  const impl = getImpl("preview_chat");
  let ctx: ActionImplContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockContext();
  });

  it("正常调用 → 返回 true + 存储到 self 节点", async () => {
    expect(await impl(ctx, { inviteLink: "https://t.me/+abc" })).toBe(true);
    expect(actions.getChatPreview).toHaveBeenCalledWith(ctx.client, "https://t.me/+abc");
    expect(ctx.G.setDynamic).toHaveBeenCalledWith("self", "last_chat_preview", {
      link: "https://t.me/+abc",
      title: "Test Group",
      type: "supergroup",
      memberCount: 100,
      withApproval: false,
    });
  });

  it("缺失 inviteLink → 返回 false", async () => {
    expect(await impl(ctx, {})).toBe(false);
  });

  it("self 节点不存在时跳过 setNodeAttr", async () => {
    (ctx.G.has as ReturnType<typeof vi.fn>).mockImplementation((id: string) => id !== "self");
    await impl(ctx, { inviteLink: "https://t.me/+abc" });
    expect(ctx.G.setDynamic).not.toHaveBeenCalled();
  });
});

describe("getSimilarChannelsImpl", () => {
  const impl = getImpl("get_similar_channels");
  let ctx: ActionImplContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockContext();
  });

  it("正常调用 → 返回 true + 存储到 chat 节点", async () => {
    expect(await impl(ctx, { chatId: 1 })).toBe(true);
    expect(actions.getSimilarChannels).toHaveBeenCalledWith(ctx.client, 1);
    expect(ctx.G.setDynamic).toHaveBeenCalledWith("channel:1", "similar_channels", [
      { id: 201, title: "Channel A" },
      { id: 202, title: "Channel B" },
    ]);
  });

  it("缺失 chatId → 返回 false", async () => {
    expect(await impl(ctx, {})).toBe(false);
  });

  it("结果限制 20 个", async () => {
    const manyChannels = Array.from({ length: 30 }, (_, i) => ({
      id: i,
      title: `Ch ${i}`,
    }));
    // biome-ignore lint/suspicious/noExplicitAny: test — 部分 mock 数据
    vi.mocked(actions.getSimilarChannels).mockResolvedValueOnce(manyChannels as any);
    await impl(ctx, { chatId: 1 });
    const stored = (ctx.G.setDynamic as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(stored).toHaveLength(20);
  });

  it("chat 节点不存在时跳过 setNodeAttr", async () => {
    (ctx.G.has as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await impl(ctx, { chatId: 999 });
    expect(ctx.G.setDynamic).not.toHaveBeenCalled();
  });
});

describe("getBotCommandsImpl", () => {
  const impl = getImpl("get_bot_commands");
  let ctx: ActionImplContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockContext();
  });

  it("正常调用 → 返回 true + 存储到 self 节点", async () => {
    expect(await impl(ctx, { botId: "@testbot" })).toBe(true);
    expect(actions.getBotCommands).toHaveBeenCalledWith(ctx.client, "@testbot");
    expect(ctx.G.setDynamic).toHaveBeenCalledWith("self", "last_bot_commands", {
      botId: "@testbot",
      commands: [
        { command: "start", description: "Start the bot" },
        { command: "help", description: "Show help" },
      ],
    });
  });

  it("缺失 botId → 返回 false", async () => {
    expect(await impl(ctx, {})).toBe(false);
  });

  it("self 节点不存在时跳过 setNodeAttr", async () => {
    (ctx.G.has as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await impl(ctx, { botId: "@testbot" });
    expect(ctx.G.setDynamic).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// M5 账户管理 + 收藏夹 + 邀请链接（4 个）
// ═══════════════════════════════════════════════════════════════════════════

describe("updateProfileImpl", () => {
  const impl = getImpl("update_profile");
  let ctx: ActionImplContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockContext();
  });

  it("修改 firstName → 返回 true + 调用 updateProfile", async () => {
    expect(await impl(ctx, { firstName: "Alice2" })).toBe(true);
    expect(actions.updateProfile).toHaveBeenCalledWith(ctx.client, {
      firstName: "Alice2",
      lastName: undefined,
      about: undefined,
    });
  });

  it("修改 about → 返回 true + 同步到图", async () => {
    await impl(ctx, { about: "New bio" });
    expect(ctx.G.setDynamic).toHaveBeenCalledWith("self", "bio", "New bio");
  });

  it("修改 firstName → 同步 display_name 到图", async () => {
    await impl(ctx, { firstName: "NewName" });
    expect(ctx.G.setDynamic).toHaveBeenCalledWith("self", "display_name", "NewName");
  });

  it("全空参数 → 返回 false", async () => {
    expect(await impl(ctx, {})).toBe(false);
    expect(actions.updateProfile).not.toHaveBeenCalled();
  });

  it("self 节点不存在时跳过 setNodeAttr", async () => {
    (ctx.G.has as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await impl(ctx, { firstName: "X" });
    expect(ctx.G.setDynamic).not.toHaveBeenCalled();
  });
});

describe("saveNoteImpl", () => {
  const impl = getImpl("save_note");
  let ctx: ActionImplContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockContext();
  });

  it("正常调用 → 返回 true + sendText to 'me'", async () => {
    expect(await impl(ctx, { text: "Remember this" })).toBe(true);
    expect(actions.sendText).toHaveBeenCalledWith(ctx.client, "me", "Remember this");
  });

  it("空 text → 返回 false", async () => {
    expect(await impl(ctx, { text: "" })).toBe(false);
    expect(actions.sendText).not.toHaveBeenCalled();
  });

  it("缺失 text → 返回 false", async () => {
    expect(await impl(ctx, {})).toBe(false);
  });
});

describe("readNotesImpl", () => {
  const impl = getImpl("read_notes");
  let ctx: ActionImplContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockContext();
  });

  it("正常调用 → 返回 true + 存储到 self 节点", async () => {
    expect(await impl(ctx, {})).toBe(true);
    expect(actions.readSavedMessages).toHaveBeenCalledWith(ctx.client, 10);
    expect(ctx.G.setDynamic).toHaveBeenCalledWith("self", "last_notes", [
      { id: 1, text: "My note", date: expect.any(String) },
      { id: 2, text: "Another note", date: expect.any(String) },
    ]);
  });

  it("limit 上限 20", async () => {
    await impl(ctx, { limit: 50 });
    expect(actions.readSavedMessages).toHaveBeenCalledWith(ctx.client, 20);
  });

  it("self 节点不存在时跳过 setNodeAttr", async () => {
    (ctx.G.has as ReturnType<typeof vi.fn>).mockImplementation((id: string) => id !== "self");
    await impl(ctx, {});
    expect(ctx.G.setDynamic).not.toHaveBeenCalled();
  });

  it("长文本截断到 200 字符", async () => {
    const longText = "x".repeat(300);
    vi.mocked(actions.readSavedMessages).mockResolvedValueOnce([
      { id: 1, text: longText, date: new Date() },
    ] as Awaited<ReturnType<typeof actions.readSavedMessages>>);
    await impl(ctx, {});
    const stored = (ctx.G.setDynamic as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(stored[0].text).toBe(`${"x".repeat(200)}...`);
  });
});

describe("createInviteLinkImpl", () => {
  const impl = getImpl("create_invite_link");
  let ctx: ActionImplContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockContext();
  });

  it("正常调用 → 返回 true + 存储到 chat 节点", async () => {
    expect(await impl(ctx, { chatId: 100 })).toBe(true);
    expect(actions.createInviteLink).toHaveBeenCalledWith(ctx.client, 100);
    expect(ctx.G.setDynamic).toHaveBeenCalledWith(
      "channel:100",
      "last_invite_link",
      "https://t.me/+abc123",
    );
  });

  it("缺失 chatId → 返回 false", async () => {
    expect(await impl(ctx, {})).toBe(false);
    expect(actions.createInviteLink).not.toHaveBeenCalled();
  });

  it("chat 节点不存在时跳过 setNodeAttr", async () => {
    (ctx.G.has as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await impl(ctx, { chatId: 999 });
    expect(ctx.G.setDynamic).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// send_dm（注意力交叉转移：群聊→私聊）
// ═══════════════════════════════════════════════════════════════════════════

describe("sendDmImpl", () => {
  const impl = getImpl("send_dm");
  let ctx: ActionImplContext;

  /** 创建支持 send_dm guard 的 mock context。 */
  function createDmContext(
    overrides?: Partial<{
      contactExists: boolean;
      channelExists: boolean;
      interactionCount: number;
      tier: number;
      chatType: string;
    }>,
  ): ActionImplContext {
    const opts = {
      contactExists: true,
      channelExists: true,
      interactionCount: 5,
      tier: 150,
      chatType: "private",
      ...overrides,
    };
    const mockG = {
      has: vi.fn().mockImplementation((id: string) => {
        if (id.startsWith("contact:")) return opts.contactExists;
        if (id.startsWith("channel:")) return opts.channelExists;
        return true;
      }),
      setDynamic: vi.fn(),
      getContact: vi.fn().mockReturnValue({
        entity_type: "contact",
        tier: opts.tier,
        last_active_ms: 0,
        auth_level: 0,
        interaction_count: opts.interactionCount,
      }),
      getChannel: vi.fn().mockReturnValue({
        entity_type: "channel",
        unread: 0,
        tier_contact: opts.tier,
        chat_type: opts.chatType,
        pending_directed: 0,
        last_directed_ms: 0,
      }),
      getAgent: vi.fn().mockReturnValue({ entity_type: "agent", mood_valence: 0, mood_set_ms: 0 }),
      getPredecessors: vi.fn().mockReturnValue([]),
    };
    return {
      client: {},
      G: mockG,
      dispatcher: { dispatch: vi.fn() },
      tick: 42,
      log: { info: vi.fn(), warn: vi.fn() },
      parseChatId: (id: string | number) => {
        if (typeof id === "number") return id;
        if (id.startsWith("channel:")) return Number(id.slice(8));
        if (id.startsWith("contact:")) return Number(id.slice(8));
        return Number(id);
      },
      ensureGraphId: (id: string | number) =>
        typeof id === "number"
          ? `channel:${id}`
          : id.startsWith("channel:") || id.startsWith("contact:")
            ? id
            : `channel:${id}`,
      ttsConfig: { ttsBaseUrl: "", ttsApiKey: "", ttsModel: "tts-1", ttsVoice: "" },
      exaApiKey: "",
      musicApiBaseUrl: "",
      youtubeApiKey: "",
      timezoneOffset: 8,
    } as unknown as ActionImplContext;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createDmContext();
  });

  it("正常发送 → 返回 success + obligationsConsumed=0", async () => {
    const result = await impl(ctx, { who: "~12345", text: "你好" });
    expect(result).toEqual({ success: true, msgId: undefined, obligationsConsumed: 0 });
    expect(actions.sendText).toHaveBeenCalledWith(ctx.client, 12345, "你好");
  });

  it("contact:telegram:12345 格式也能正常解析", async () => {
    const result = await impl(ctx, { who: "contact:telegram:12345", text: "hi" });
    expect(result).toEqual({ success: true, msgId: undefined, obligationsConsumed: 0 });
    expect(actions.sendText).toHaveBeenCalled();
  });

  it("无效 who → error: invalid contact", async () => {
    const result = await impl(ctx, { who: "", text: "hello" });
    expect(result).toMatchObject({ success: false, error: "invalid contact" });
    expect(actions.sendText).not.toHaveBeenCalled();
  });

  it("图中不存在 contact → error: unknown contact", async () => {
    ctx = createDmContext({ contactExists: false });
    const result = await impl(ctx, { who: "~99999", text: "hello" });
    expect(result).toMatchObject({ success: false, error: "unknown contact" });
  });

  it("interaction_count=0 → error: never interacted", async () => {
    ctx = createDmContext({ interactionCount: 0 });
    const result = await impl(ctx, { who: "~12345", text: "hello" });
    expect(result).toMatchObject({ success: false, error: "never interacted" });
  });

  it("tier=500 → error: too distant", async () => {
    ctx = createDmContext({ tier: 500 });
    const result = await impl(ctx, { who: "~12345", text: "hello" });
    expect(result).toMatchObject({ success: false, error: "too distant" });
  });

  it("chat_type 非 private → error: not private", async () => {
    ctx = createDmContext({ chatType: "group" });
    const result = await impl(ctx, { who: "~12345", text: "hello" });
    expect(result).toMatchObject({ success: false, error: "not private" });
  });

  it("空 text → 返回 false", async () => {
    expect(await impl(ctx, { who: "~12345", text: "" })).toBe(false);
    expect(actions.sendText).not.toHaveBeenCalled();
  });

  it("图更新：last_outgoing_text + 事件分派", async () => {
    await impl(ctx, { who: "~12345", text: "hello" });
    expect(ctx.G.setDynamic).toHaveBeenCalledWith(
      "channel:telegram:12345",
      "last_outgoing_text",
      "hello",
    );
    expect(ctx.dispatcher.dispatch).toHaveBeenCalledWith("SEND_MESSAGE", {
      chatId: "channel:telegram:12345",
      text: "hello",
      msgId: undefined,
    });
    expect(ctx.dispatcher.dispatch).toHaveBeenCalledWith("DECLARE_ACTION", {
      target: "channel:telegram:12345",
    });
  });

  it("typing 在发送前后调用", async () => {
    await impl(ctx, { who: "~12345", text: "hi" });
    // typing 开始 + 取消 = 2 次调用
    expect(actions.setTyping).toHaveBeenCalledTimes(2);
    expect(actions.setTyping).toHaveBeenCalledWith(ctx.client, 12345);
    expect(actions.setTyping).toHaveBeenCalledWith(ctx.client, 12345, true);
  });

  it("DM channel 不在图中时跳过 chat_type 检查和 setDynamic", async () => {
    ctx = createDmContext({ channelExists: false });
    const result = await impl(ctx, { who: "~12345", text: "hello" });
    expect(result).toEqual({ success: true, msgId: undefined, obligationsConsumed: 0 });
    expect(ctx.G.setDynamic).not.toHaveBeenCalled();
  });
});
