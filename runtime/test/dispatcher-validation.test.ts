/**
 * ADR-70 P3 测试 — Dispatcher Zod 运行时验证。
 *
 * 验证：
 * - schema 校验失败时返回 { success: false } 而非执行 impl
 * - required/optional 由 schema 决定
 * - query 也受 schema 保护
 * - 验证错误包含字段名和原因
 * - schema 通过时正常执行
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAliceDispatcher } from "../src/core/dispatcher.js";
import { createMod } from "../src/core/mod-builder.js";
import { WorldModel } from "../src/graph/world-model.js";

// -- 测试用 Mod 定义（带 Zod schema）------------------------------------------

interface TestState {
  lastArgs: Record<string, unknown> | null;
}

const validatedMod = createMod<TestState>("validated", {
  category: "mechanic",
  description: "Zod 验证测试 Mod",
  initialState: { lastArgs: null },
})
  .instruction("TYPED_ACTION", {
    params: z.object({
      name: z.string().min(1).describe("名称"),
      score: z.number().min(0).max(100).describe("分数 [0, 100]"),
      tag: z.string().optional().describe("可选标签"),
    }),
    description: "带 Zod schema 的测试指令",
    impl(ctx, args) {
      ctx.state.lastArgs = args;
      return { success: true, received: args };
    },
  })
  .instruction("SCHEMA_REQUIRED_ACTION", {
    params: z.object({
      required_field: z.string().min(1).describe("必填字段"),
      optional_field: z.string().optional().describe("可选字段"),
    }),
    description: "schema 驱动的 required/optional 测试指令",
    impl(ctx, args) {
      ctx.state.lastArgs = args;
      return { success: true, received: args };
    },
  })
  .instruction("DERIVED_ACTION", {
    params: z.object({
      target: z.string().min(1).describe("派生目标"),
      value: z.string().min(1).describe("值"),
    }),
    deriveParams: {
      target: (cv: Record<string, unknown>) => cv.TARGET_CHAT,
    },
    description: "上下文派生参数测试指令",
    impl(ctx, args) {
      ctx.state.lastArgs = args;
      return { success: true, received: args };
    },
  })
  .query("typedQuery", {
    params: z.object({
      id: z.number().int().positive().describe("查询 ID"),
    }),
    description: "带 Zod schema 的测试查询",
    returns: "{ id: number }",
    impl(_ctx, args) {
      return { id: args.id };
    },
  })
  .query("derivedQuery", {
    params: z.object({
      chatId: z.string().min(1).describe("频道 ID"),
    }),
    deriveParams: {
      chatId: (cv: Record<string, unknown>) => cv.TARGET_CHAT,
    },
    description: "上下文派生参数测试查询",
    returns: "{ chatId: string }",
    impl(_ctx, args) {
      return { chatId: args.chatId };
    },
  })
  .query("getLastArgs", {
    params: z.object({}),
    description: "获取上次参数",
    impl(ctx) {
      return ctx.state.lastArgs;
    },
  })
  .build();

function createTestDispatcher() {
  const graph = new WorldModel();
  return createAliceDispatcher({ graph, mods: [validatedMod] });
}

// -- 测试 ---------------------------------------------------------------------

describe("Dispatcher Zod validation", () => {
  it("schema 校验失败时返回 { success: false } 而非执行 impl", () => {
    const d = createTestDispatcher();
    // name 为空字符串 → z.string().min(1) 失败
    const result = d.dispatch("TYPED_ACTION", { name: "", score: 50 }) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toContain("name");
    // impl 未执行，lastArgs 应为 null
    expect(d.query("getLastArgs", {})).toBeNull();
  });

  it("schema 数值范围校验", () => {
    const d = createTestDispatcher();
    // score = 200 → z.number().max(100) 失败
    const result = d.dispatch("TYPED_ACTION", { name: "test", score: 200 }) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toContain("score");
    expect(d.query("getLastArgs", {})).toBeNull();
  });

  it("多字段同时校验失败时包含所有错误", () => {
    const d = createTestDispatcher();
    // name 为空 + score 超范围
    const result = d.dispatch("TYPED_ACTION", { name: "", score: -1 }) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toContain("name");
    expect(result.error).toContain("score");
  });

  it("schema 驱动的 required 检查（缺失必填字段）", () => {
    const d = createTestDispatcher();
    // required_field 缺失 → z.string().min(1) 失败
    const result = d.dispatch("SCHEMA_REQUIRED_ACTION", {}) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toContain("required_field");
  });

  it("schema required 已提供 → 正常执行", () => {
    const d = createTestDispatcher();
    const result = d.dispatch("SCHEMA_REQUIRED_ACTION", { required_field: "hello" }) as {
      success: boolean;
    };
    expect(result.success).toBe(true);
  });

  it("schema optional 缺失 → 正常执行", () => {
    const d = createTestDispatcher();
    const result = d.dispatch("SCHEMA_REQUIRED_ACTION", { required_field: "hello" }) as {
      success: boolean;
    };
    expect(result.success).toBe(true);
  });

  it("query 也受 schema 保护", () => {
    const d = createTestDispatcher();
    // id = -1 → z.number().int().positive() 失败
    const result = d.query("typedQuery", { id: -1 }) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toContain("id");
  });

  it("query schema 通过时正常执行", () => {
    const d = createTestDispatcher();
    const result = d.query("typedQuery", { id: 42 }) as { id: number };
    expect(result.id).toBe(42);
  });

  it("schema 通过时正常执行 dispatch", () => {
    const d = createTestDispatcher();
    const result = d.dispatch("TYPED_ACTION", { name: "Alice", score: 85 }) as {
      success: boolean;
      received: Record<string, unknown>;
    };
    expect(result.success).toBe(true);
    expect(result.received.name).toBe("Alice");
    expect(result.received.score).toBe(85);
  });

  it("dispatch 在校验前应用 __contextVars 派生参数", () => {
    const d = createTestDispatcher();
    const result = d.dispatch("DERIVED_ACTION", {
      value: "ok",
      __contextVars: { TARGET_CHAT: "channel:123" },
    }) as {
      success: boolean;
      received: Record<string, unknown>;
    };
    expect(result.success).toBe(true);
    expect(result.received.target).toBe("channel:123");
    expect(result.received.__contextVars).toBeUndefined();
  });

  it("query 在校验前应用 __contextVars 派生参数", () => {
    const d = createTestDispatcher();
    const result = d.query("derivedQuery", {
      __contextVars: { TARGET_CHAT: "channel:456" },
    }) as { chatId: string };
    expect(result.chatId).toBe("channel:456");
  });
});
