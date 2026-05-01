/**
 * Formative Memories 测试 — 首次互动上下文注入。
 *
 * 验证 relationships.mod contribute() 在新联系人首次互动时
 * 从 message_log 注入历史发言上下文。
 *
 * @see docs/adr/86-voyager-concordia-cross-analysis.md §C5 Formative Memories
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModContext } from "../src/core/types.js";
import { WorldModel } from "../src/graph/world-model.js";
import { type ContactProfile, relationshipsMod } from "../src/mods/relationships.mod.js";

// Mock getRecentMessagesBySender — 避免测试依赖真实 DB
vi.mock("../src/db/queries.js", () => ({
  getRecentMessagesBySender: vi.fn(() => []),
}));

import { getRecentMessagesBySender } from "../src/db/queries.js";

const mockedGetRecentMessages = vi.mocked(getRecentMessagesBySender);

// -- 测试辅助 -----------------------------------------------------------------

interface TestState {
  targetNodeId: string | null;
  contactProfiles: Record<string, ContactProfile>;
}

function makeCtx(stateOverride: Partial<TestState> = {}, tick = 100) {
  const graph = new WorldModel();
  graph.tick = tick;
  const state: TestState = {
    targetNodeId: stateOverride.targetNodeId ?? null,
    contactProfiles: stateOverride.contactProfiles ?? {},
  };
  return {
    graph,
    state,
    tick,
    getModState: () => undefined,
    dispatch: () => undefined,
  };
}

function findSection(items: Array<{ key?: string }>, key: string) {
  return items.find((i) => "key" in i && i.key === key) as
    | { key: string; lines: string[] }
    | undefined;
}

afterEach(() => {
  mockedGetRecentMessages.mockReset();
});

// -- Formative Memories contribute() 测试 -----------------------------------

describe("relationships.mod — Formative Memories (first-impression)", () => {
  it("新联系人 + 0 facts + interaction_count ≤ 2 + 有消息 → 注入 first-impression", () => {
    mockedGetRecentMessages.mockReturnValue([
      { chatId: "channel:group1", senderName: "Alice群", text: "今天天气真好", tick: 90 },
      { chatId: "channel:group2", senderName: null, text: "有人看了新电影吗", tick: 85 },
    ]);

    const ctx = makeCtx({ targetNodeId: "contact:telegram:42" });
    ctx.graph.addContact("contact:telegram:42", {
      tier: 500,
      display_name: "Bob",
      interaction_count: 1,
    });
    ctx.graph.addChannel("channel:group1", {
      display_name: "技术群",
      chat_type: "supergroup",
    });
    // channel:group2 不在图中，应使用 chatId 作为标签

    // biome-ignore lint/style/noNonNullAssertion: test
    const items = relationshipsMod.contribute!(ctx as unknown as ModContext);
    const fi = findSection(items, "first-impression");

    expect(fi).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: test — fi 已 toBeDefined
    const fiContent = fi!.lines.join("\n");
    expect(fiContent).toContain("You've seen Bob in shared chats");
    expect(fiContent).toContain("[技术群]");
    expect(fiContent).toContain("今天天气真好");
    expect(fiContent).toContain("[(someone)]"); // ADR-172: safeDisplayName 不泄漏 raw ID
    expect(fiContent).toContain("有人看了新电影吗");
    expect(fiContent).toContain("self note");
  });

  it("联系人已有 facts → 不注入 first-impression", () => {
    mockedGetRecentMessages.mockReturnValue([
      { chatId: "channel:g", senderName: null, text: "hello", tick: 50 },
    ]);

    const ctx = makeCtx({ targetNodeId: "contact:telegram:42" });
    ctx.graph.addContact("contact:telegram:42", {
      tier: 150,
      display_name: "Charlie",
      interaction_count: 1,
    });
    // 添加一条 fact
    ctx.graph.addFact("info_test_1", {
      content: "likes cats",
      fact_type: "preference",
      importance: 0.5,
      stability: 5,
      last_access_ms: 90,
      volatility: 0,
      tracked: false,
      created_ms: 10,
      novelty: 1.0,
      reinforcement_count: 1,
      source_contact: "contact:telegram:42",
    });
    ctx.graph.addRelation("contact:telegram:42", "knows", "info_test_1");

    // biome-ignore lint/style/noNonNullAssertion: test
    const items = relationshipsMod.contribute!(ctx as unknown as ModContext);
    const fi = findSection(items, "first-impression");

    expect(fi).toBeUndefined();
  });

  it("interaction_count > 2 → 不注入 first-impression", () => {
    mockedGetRecentMessages.mockReturnValue([
      { chatId: "channel:g", senderName: null, text: "hello", tick: 50 },
    ]);

    const ctx = makeCtx({ targetNodeId: "contact:telegram:42" });
    ctx.graph.addContact("contact:telegram:42", {
      tier: 150,
      display_name: "Dave",
      interaction_count: 5,
    });

    // biome-ignore lint/style/noNonNullAssertion: test
    const items = relationshipsMod.contribute!(ctx as unknown as ModContext);
    const fi = findSection(items, "first-impression");

    expect(fi).toBeUndefined();
  });

  it("message_log 无该联系人数据 → 不注入 first-impression", () => {
    mockedGetRecentMessages.mockReturnValue([]);

    const ctx = makeCtx({ targetNodeId: "contact:telegram:42" });
    ctx.graph.addContact("contact:telegram:42", {
      tier: 500,
      display_name: "Eve",
      interaction_count: 0,
    });

    // biome-ignore lint/style/noNonNullAssertion: test
    const items = relationshipsMod.contribute!(ctx as unknown as ModContext);
    const fi = findSection(items, "first-impression");

    expect(fi).toBeUndefined();
  });

  it("消息截断 — 超过 150 字符的消息被截断", () => {
    const longText = "a".repeat(200);
    mockedGetRecentMessages.mockReturnValue([
      { chatId: "channel:g", senderName: null, text: longText, tick: 90 },
    ]);

    const ctx = makeCtx({ targetNodeId: "contact:telegram:42" });
    ctx.graph.addContact("contact:telegram:42", {
      tier: 500,
      display_name: "Frank",
      interaction_count: 0,
    });

    // biome-ignore lint/style/noNonNullAssertion: test
    const items = relationshipsMod.contribute!(ctx as unknown as ModContext);
    const fi = findSection(items, "first-impression");

    expect(fi).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: test — fi 已 toBeDefined
    const msgLine = fi!.lines.find((l) => l.includes("aaa"));
    expect(msgLine).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: test — msgLine 已 toBeDefined
    expect(msgLine!).toContain("...");
    // biome-ignore lint/style/noNonNullAssertion: test
    expect(msgLine!).not.toContain("a".repeat(200));
  });

  it("DB 不可用时静默跳过 — 不崩溃", () => {
    mockedGetRecentMessages.mockImplementation(() => {
      throw new Error("Database not initialized");
    });

    const ctx = makeCtx({ targetNodeId: "contact:telegram:42" });
    ctx.graph.addContact("contact:telegram:42", {
      tier: 500,
      display_name: "Grace",
      interaction_count: 0,
    });

    // 不应抛异常
    // biome-ignore lint/style/noNonNullAssertion: test
    const items = relationshipsMod.contribute!(ctx as unknown as ModContext);
    const fi = findSection(items, "first-impression");

    expect(fi).toBeUndefined();
  });

  it("interaction_count = 2 → 仍注入（边界值）", () => {
    mockedGetRecentMessages.mockReturnValue([
      { chatId: "channel:g", senderName: null, text: "hi there", tick: 90 },
    ]);

    const ctx = makeCtx({ targetNodeId: "contact:telegram:42" });
    ctx.graph.addContact("contact:telegram:42", {
      tier: 500,
      display_name: "Helen",
      interaction_count: 2,
    });

    // biome-ignore lint/style/noNonNullAssertion: test
    const items = relationshipsMod.contribute!(ctx as unknown as ModContext);
    const fi = findSection(items, "first-impression");

    expect(fi).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: test — fi 已 toBeDefined
    expect(fi!.lines.join("\n")).toContain("You've seen Helen");
  });

  it("空 text 的消息被跳过", () => {
    mockedGetRecentMessages.mockReturnValue([
      { chatId: "channel:g", senderName: null, text: null, tick: 90 },
      { chatId: "channel:g", senderName: null, text: "valid message", tick: 85 },
    ]);

    const ctx = makeCtx({ targetNodeId: "contact:telegram:42" });
    ctx.graph.addContact("contact:telegram:42", {
      tier: 500,
      display_name: "Ivan",
      interaction_count: 0,
    });

    // biome-ignore lint/style/noNonNullAssertion: test
    const items = relationshipsMod.contribute!(ctx as unknown as ModContext);
    const fi = findSection(items, "first-impression");

    expect(fi).toBeDefined();
    // ADR-172: safeDisplayName 返回 "(someone)" 而非 raw ID 格式
    // biome-ignore lint/style/noNonNullAssertion: guarded by test assertion
    const contentLines = fi!.lines.filter((l) => l.includes("[(someone)]"));
    expect(contentLines).toHaveLength(1);
    expect(contentLines[0]).toContain("valid message");
  });
});
