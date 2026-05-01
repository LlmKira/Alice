/**
 * Mod Dispatcher 集成测试 — 验证 Zod 校验 + impl 完整链路。
 *
 * 与 dispatcher-validation.test.ts（泛型 Zod 校验）不同，
 * 此文件测试**真实 Mod** 通过 dispatcher 调用时的端到端行为：
 * - Zod schema 拒绝无效参数（不执行 impl）
 * - Zod .trim() 透传：impl 收到的是 trim 后的值
 * - Zod 范围校验：超出范围的数值被拒绝
 * - Zod enum 校验：非法枚举值被拒绝
 * - 合法参数正常执行 impl 并返回结果
 *
 * @see docs/adr/70-sandbox-dispatcher-zod.md
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAliceDispatcher } from "../src/core/dispatcher.js";
import { closeDb, initDb } from "../src/db/connection.js";
import { WorldModel } from "../src/graph/world-model.js";
import { diaryMod } from "../src/mods/diary.mod.js";
import { observerMod } from "../src/mods/observer.mod.js";
import { relationshipsMod } from "../src/mods/relationships.mod.js";
import { schedulerMod } from "../src/mods/scheduler.mod.js";

// -- 测试辅助 -----------------------------------------------------------------

function createIntegrationDispatcher(
  extraMods: Parameters<typeof createAliceDispatcher>[0]["mods"] = [],
) {
  const graph = new WorldModel();
  graph.addAgent("self", { mood_valence: 0, mood_arousal: 0.2 });
  graph.addContact("contact:1", { tier: 150 });
  graph.addChannel("channel:test", {});
  const mods = [observerMod, relationshipsMod, diaryMod, schedulerMod, ...extraMods];
  const dispatcher = createAliceDispatcher({ graph, mods });
  dispatcher.startTick(100);
  return { dispatcher, graph };
}

// -- self_note 集成 ------------------------------------------------------------

describe("note via dispatcher", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("空字符串被 Zod 拒绝（不执行 impl）", () => {
    const { dispatcher } = createIntegrationDispatcher();
    const result = dispatcher.dispatch("note", {
      contactId: "contact:1",
      fact: "",
      type: "general",
    }) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("fact");
  });

  it("纯空白字符串被 Zod .trim().min(1) 拒绝", () => {
    const { dispatcher } = createIntegrationDispatcher();
    const result = dispatcher.dispatch("note", {
      contactId: "contact:1",
      fact: "   ",
      type: "general",
    }) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("fact");
  });

  it("Zod .trim() 透传——impl 收到 trim 后的值", () => {
    const { dispatcher, graph } = createIntegrationDispatcher();
    const result = dispatcher.dispatch("note", {
      contactId: "contact:1",
      fact: "  likes cats  ",
      type: "preference",
    }) as { success: boolean };

    expect(result.success).toBe(true);
    // 验证图中存储的是 trim 后的值
    const facts = graph
      .getNeighbors("contact:1", "knows")
      .map((id) => graph.getFact(id).content as string);
    expect(facts).toContain("likes cats");
  });

  it("合法参数正常执行", () => {
    const { dispatcher } = createIntegrationDispatcher();
    const result = dispatcher.dispatch("note", {
      contactId: "contact:1",
      fact: "works at Google",
      type: "observation",
    }) as { success: boolean; contactId: string };

    expect(result.success).toBe(true);
    expect(result.contactId).toBe("contact:1");
  });

  it("非法 type enum 被 Zod 拒绝", () => {
    const { dispatcher } = createIntegrationDispatcher();
    const result = dispatcher.dispatch("note", {
      contactId: "contact:1",
      fact: "test",
      type: "invalid_type",
    }) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("type");
  });
});

// -- self_diary 集成 ---------------------------------------------------------------

describe("diary via dispatcher", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("空字符串被 Zod 拒绝", () => {
    const { dispatcher } = createIntegrationDispatcher();
    const result = dispatcher.dispatch("diary", {
      content: "",
    }) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("content");
  });

  it("纯空白被 Zod .trim().min(1) 拒绝", () => {
    const { dispatcher } = createIntegrationDispatcher();
    const result = dispatcher.dispatch("diary", {
      content: "   \t  ",
    }) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("content");
  });

  it("合法内容正常写入", () => {
    const { dispatcher } = createIntegrationDispatcher();
    const result = dispatcher.dispatch("diary", {
      content: "今天心情不错",
    });

    // impl 返回 undefined 时 dispatcher 不包装
    expect(result).not.toHaveProperty("success", false);
  });
});

// -- self_feel 集成 ----------------------------------------------------------------

describe("feel via dispatcher", () => {
  it("valence 使用非法枚举值被 Zod 拒绝", () => {
    const { dispatcher } = createIntegrationDispatcher();
    const result = dispatcher.dispatch("feel", {
      target: "self",
      valence: "ecstatic",
      arousal: "mild",
    }) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("valence");
  });

  it("arousal 使用非法枚举值被 Zod 拒绝", () => {
    const { dispatcher } = createIntegrationDispatcher();
    const result = dispatcher.dispatch("feel", {
      target: "self",
      valence: "positive",
      arousal: "explosive",
    }) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("arousal");
  });

  it("合法枚举值正常执行", () => {
    const { dispatcher, graph } = createIntegrationDispatcher();
    const result = dispatcher.dispatch("feel", {
      target: "self",
      valence: "positive",
      arousal: "mild",
    }) as { success: boolean; valence: number; arousal: number };

    expect(result.success).toBe(true);
    // ADR-50: 语义标签映射 — positive → 0.4, mild → 0.5
    expect(result.valence).toBe(0.4);
    expect(result.arousal).toBe(0.5);
    // ADR-268: self 情绪权威是 episode ledger，不再直接写 legacy mood_arousal 标量。
    const episodes = JSON.parse(String(graph.getDynamic("self", "emotion_episodes"))) as Array<{
      valence: number;
      arousal: number;
    }>;
    expect(episodes.at(-1)).toMatchObject({ valence: 0.4, arousal: 0.5 });
  });
});

// -- set_relation_type 集成 ---------------------------------------------------

describe("set_relation_type via dispatcher", () => {
  it("非法 relationType 被 Zod enum 拒绝", () => {
    const { dispatcher } = createIntegrationDispatcher();
    const result = dispatcher.dispatch("set_relation_type", {
      contactId: "contact:1",
      relationType: "bestie",
    }) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("relationType");
  });

  it("合法 relationType 正常执行", () => {
    const { dispatcher } = createIntegrationDispatcher();
    const result = dispatcher.dispatch("set_relation_type", {
      contactId: "contact:1",
      relationType: "friend",
    }) as { success: boolean };

    expect(result.success).toBe(true);
  });
});

// -- schedule_task 集成 -------------------------------------------------------

describe("schedule_task via dispatcher", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("非法 type 被 Zod enum 拒绝", () => {
    const { dispatcher } = createIntegrationDispatcher();
    const result = dispatcher.dispatch("schedule_task", {
      type: "maybe",
      delay: 5,
      action: "test",
    }) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("type");
  });

  it("合法 at 任务正常创建", () => {
    const { dispatcher } = createIntegrationDispatcher();
    const result = dispatcher.dispatch("schedule_task", {
      type: "at",
      delay: 10,
      action: "remind about meeting",
    });

    // impl 返回 { success: true, taskId: number }
    const r = result as { success: boolean; taskId: number };
    expect(r.success).toBe(true);
    expect(r.taskId).toBeGreaterThan(0);
  });
});
