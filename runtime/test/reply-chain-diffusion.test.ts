/**
 * ADR-97: 回复链逸散上下文 — 单元测试。
 *
 * 测试 diffuseReplyChain 算法的各种场景：
 * - 无回复消息 → 返回空
 * - 回复目标在窗口内 → 不触发追溯
 * - 回复目标在 DB 中 → 从 messageLog 拉入 + radius 邻近
 * - 回复目标不在 DB 中 → 返回空（graceful degradation）
 * - 递归深度 2 → 深度 1 cluster 中的回复触发深度 2
 * - 预算耗尽 → DIFFUSION_BUDGET 硬帽生效
 * - 重叠去重 → 逸散消息与窗口消息 ID 重叠时去重
 * - 环形回复 → visited Set 防止无限循环
 *
 * @see docs/adr/97-reply-chain-diffusion-context.md
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock DB queries — 避免测试依赖真实数据库
vi.mock("../src/db/queries.js", () => ({
  getRecentMessagesBySender: vi.fn(() => []),
  getMessageByMsgId: vi.fn(() => null),
  getMessageCluster: vi.fn(() => []),
}));

import { getMessageCluster } from "../src/db/queries.js";
import { diffuseReplyChain } from "../src/engine/act/index.js";

const mockedGetCluster = vi.mocked(getMessageCluster);

// -- 测试辅助 -------------------------------------------------------------------

type MessageRecord = Parameters<typeof diffuseReplyChain>[0][number];

/** 创建测试用 MessageRecord。 */
function makeMsg(overrides: Partial<MessageRecord> & { id: number }): MessageRecord {
  return {
    senderName: "User",
    isOutgoing: false,
    text: `Message #${overrides.id}`,
    date: new Date(1700000000000 + overrides.id * 60000),
    ...overrides,
  };
}

/** 创建测试用 DbMessageRecord（getMessageCluster 返回值）。 */
function makeDbRecord(
  msgId: number,
  opts: {
    replyToMsgId?: number | null;
    text?: string | null;
    senderId?: string | null;
    senderName?: string | null;
  } = {},
) {
  return {
    platform: "telegram",
    msgId,
    nativeChatId: "123",
    nativeMsgId: String(msgId),
    stableMessageId: `message:telegram:123:${msgId}`,
    tick: msgId,
    senderId: opts.senderId ?? null,
    senderName: opts.senderName ?? "User",
    text: (opts.text !== undefined ? opts.text : `DB Message #${msgId}`) as string | null,
    mediaType: null,
    isOutgoing: false,
    replyToMsgId: opts.replyToMsgId ?? null,
    createdAt: new Date(1700000000000 + msgId * 60000),
  };
}

const CHAT_ID = "channel:123";

// -- 测试 -----------------------------------------------------------------------

beforeEach(() => {
  mockedGetCluster.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("diffuseReplyChain", () => {
  it("无回复消息 → 返回空", () => {
    const seeds = [makeMsg({ id: 100 }), makeMsg({ id: 101 }), makeMsg({ id: 102 })];
    const result = diffuseReplyChain(seeds, CHAT_ID);
    expect(result).toEqual([]);
    expect(mockedGetCluster).not.toHaveBeenCalled();
  });

  it("回复目标在窗口内 → 不触发追溯", () => {
    const seeds = [
      makeMsg({ id: 100 }),
      makeMsg({ id: 101, replyToId: 100 }),
      makeMsg({ id: 102 }),
    ];
    const result = diffuseReplyChain(seeds, CHAT_ID);
    expect(result).toEqual([]);
    expect(mockedGetCluster).not.toHaveBeenCalled();
  });

  it("回复目标在 DB 中 → 从 messageLog 拉入 + radius 邻近", () => {
    // seed #110 回复了窗口外的 #50
    const seeds = [makeMsg({ id: 108 }), makeMsg({ id: 109 }), makeMsg({ id: 110, replyToId: 50 })];

    // DB 返回 #49, #50, #51（center=50, radius=1）
    mockedGetCluster.mockReturnValue([
      makeDbRecord(49, { text: "before context" }),
      makeDbRecord(50, { text: "the replied message" }),
      makeDbRecord(51, { text: "after context" }),
    ]);

    const result = diffuseReplyChain(seeds, CHAT_ID);
    expect(mockedGetCluster).toHaveBeenCalledWith(CHAT_ID, 50, 1);
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.id)).toEqual([49, 50, 51]);
    // 所有逸散消息标记 isDiffused
    for (const r of result) {
      expect(r.isDiffused).toBe(true);
    }
  });

  it("回复目标不在 DB 中 → 返回空（graceful degradation）", () => {
    const seeds = [makeMsg({ id: 200, replyToId: 10 })];
    mockedGetCluster.mockReturnValue([]);

    const result = diffuseReplyChain(seeds, CHAT_ID);
    expect(mockedGetCluster).toHaveBeenCalledWith(CHAT_ID, 10, 1);
    expect(result).toEqual([]);
  });

  it("递归深度 2 — cluster 中的回复触发第二轮", () => {
    // seed #110 回复了 #50，#50 又回复了 #20
    const seeds = [makeMsg({ id: 110, replyToId: 50 })];

    // 第一轮：获取 #50 的 cluster
    mockedGetCluster.mockImplementation((_chatId, centerMsgId, _radius) => {
      if (centerMsgId === 50) {
        return [makeDbRecord(50, { replyToMsgId: 20, text: "mid chain" })];
      }
      if (centerMsgId === 20) {
        return [makeDbRecord(20, { text: "chain origin" })];
      }
      return [];
    });

    const result = diffuseReplyChain(seeds, CHAT_ID);
    // 应该有两轮调用：#50 和 #20
    expect(mockedGetCluster).toHaveBeenCalledWith(CHAT_ID, 50, 1);
    expect(mockedGetCluster).toHaveBeenCalledWith(CHAT_ID, 20, 1);
    expect(result.map((r) => r.id)).toEqual([20, 50]);
  });

  it("预算耗尽 → DIFFUSION_BUDGET 硬帽生效", () => {
    // seed 回复了 #1，cluster 返回大量消息
    const seeds = [makeMsg({ id: 100, replyToId: 1 })];

    // 返回 20 条（超过默认 budget 15）
    const bigCluster = Array.from({ length: 20 }, (_, i) => makeDbRecord(i + 1));
    mockedGetCluster.mockReturnValue(bigCluster);

    const result = diffuseReplyChain(seeds, CHAT_ID);
    expect(result.length).toBeLessThanOrEqual(15);
  });

  it("重叠去重 — 逸散消息与窗口消息 ID 重叠时跳过", () => {
    // seed 包含 #50，回复链也包含 #50
    const seeds = [makeMsg({ id: 50 }), makeMsg({ id: 60, replyToId: 49 })];

    mockedGetCluster.mockReturnValue([
      makeDbRecord(48),
      makeDbRecord(49, { text: "reply target" }),
      makeDbRecord(50), // 与 seed 重叠
    ]);

    const result = diffuseReplyChain(seeds, CHAT_ID);
    // #50 已在 seeds 中，不应出现在逸散结果中
    const ids = result.map((r) => r.id);
    expect(ids).not.toContain(50);
    expect(ids).toContain(48);
    expect(ids).toContain(49);
  });

  it("环形回复 — visited Set 防止无限循环", () => {
    // #100 回复 #50，#50 回复 #100（循环）
    const seeds = [makeMsg({ id: 100, replyToId: 50 })];

    mockedGetCluster.mockImplementation((_chatId, centerMsgId, _radius) => {
      if (centerMsgId === 50) {
        return [makeDbRecord(50, { replyToMsgId: 100 })]; // 回复 #100 = 环
      }
      return [];
    });

    const result = diffuseReplyChain(seeds, CHAT_ID);
    // 不应无限循环，只返回 #50
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(50);
  });

  it("多个 seed 回复同一个窗口外消息 → 只追溯一次", () => {
    const seeds = [makeMsg({ id: 100, replyToId: 50 }), makeMsg({ id: 101, replyToId: 50 })];

    mockedGetCluster.mockReturnValue([makeDbRecord(50, { text: "shared target" })]);

    const result = diffuseReplyChain(seeds, CHAT_ID);
    // getMessageCluster 只调用一次（frontier 去重）
    expect(mockedGetCluster).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(50);
  });

  it("逸散消息按时间排序", () => {
    const seeds = [makeMsg({ id: 200, replyToId: 10 }), makeMsg({ id: 201, replyToId: 150 })];

    mockedGetCluster.mockImplementation((_chatId, centerMsgId, _radius) => {
      if (centerMsgId === 10) {
        return [makeDbRecord(10, { text: "old message" })];
      }
      if (centerMsgId === 150) {
        return [makeDbRecord(150, { text: "newer message" })];
      }
      return [];
    });

    const result = diffuseReplyChain(seeds, CHAT_ID);
    expect(result.length).toBe(2);
    // #10 的 date < #150 的 date（由 makeDbRecord 构造保证）
    expect(result[0].id).toBe(10);
    expect(result[1].id).toBe(150);
  });

  it("DB 记录正确转换为 MessageRecord", () => {
    const seeds = [makeMsg({ id: 100, replyToId: 50 })];
    mockedGetCluster.mockReturnValue([
      makeDbRecord(50, {
        senderId: "contact:789",
        senderName: "Fang",
        text: "hello",
        replyToMsgId: 30,
      }),
    ]);

    const result = diffuseReplyChain(seeds, CHAT_ID);
    expect(result).toHaveLength(1);
    const msg = result[0];
    expect(msg.id).toBe(50);
    expect(msg.senderName).toBe("Fang");
    expect(msg.senderId).toBe(789);
    expect(msg.text).toBe("hello");
    expect(msg.replyToId).toBe(30);
    expect(msg.isDiffused).toBe(true);
    expect(msg.isOutgoing).toBe(false);
  });

  it("DB 记录无 senderId → senderId 为 undefined", () => {
    const seeds = [makeMsg({ id: 100, replyToId: 50 })];
    mockedGetCluster.mockReturnValue([makeDbRecord(50)]);

    const result = diffuseReplyChain(seeds, CHAT_ID);
    expect(result[0].senderId).toBeUndefined();
  });

  it("DB 记录无 text → text 为 '(no text)'", () => {
    const seeds = [makeMsg({ id: 100, replyToId: 50 })];
    mockedGetCluster.mockReturnValue([makeDbRecord(50, { text: null })]);

    const result = diffuseReplyChain(seeds, CHAT_ID);
    expect(result[0].text).toBe("(no text)");
  });
});
