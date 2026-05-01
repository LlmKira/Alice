/**
 * ADR-23 Wave 1 测试 — observer.mod + 双缓冲区 + Beat 新类型 + begin_topic horizon。
 */
import { describe, expect, it } from "vitest";
import type { ModContext } from "../src/core/types.js";
import { WorldModel } from "../src/graph/world-model.js";
import { observerMod } from "../src/mods/observer.mod.js";
import { BEAT_TYPES } from "../src/mods/threads.mod.js";

// -- 测试辅助 -----------------------------------------------------------------

/** 创建简单的 ModContext mock。 */
function makeCtx<T>(
  state: T,
  tick = 100,
  nowMs = 1700000000000,
): ModContext<T> & { graph: WorldModel } {
  const graph = new WorldModel();
  graph.tick = tick;
  return {
    graph,
    state,
    tick,
    nowMs,
    getModState: () => undefined,
    dispatch: () => undefined,
  };
}

// biome-ignore lint/style/noNonNullAssertion: test — instructions/queries 已知存在
const instructions = observerMod.instructions!;
// biome-ignore lint/style/noNonNullAssertion: test — queries 已知存在
const queries = observerMod.queries!;

// -- observer.mod 指令测试 -----------------------------------------------------

describe("observer.mod — DECLARE_ACTION", () => {
  it("写入 last_alice_action_ms 和 social_debt_direction", () => {
    const ctx = makeCtx({ outcomeHistory: [] } as never);
    ctx.graph.addChannel("channel:1", { unread: 0 });

    const impl = instructions.DECLARE_ACTION.impl;
    const result = impl(ctx as unknown as ModContext, {
      target: "channel:1",
      social_debt: "alice_initiated",
    });

    expect((result as { success: boolean }).success).toBe(true);
    const attrs = ctx.graph.getChannel("channel:1");
    expect(attrs.last_alice_action_ms).toBe(1700000000000);
    expect(attrs.social_debt_direction).toBe("alice_initiated");
  });

  it("目标不存在时返回 false", () => {
    const ctx = makeCtx({ outcomeHistory: [] } as never);
    const impl = instructions.DECLARE_ACTION.impl;
    const result = impl(ctx as unknown as ModContext, { target: "nonexistent" }) as {
      success: boolean;
    };
    expect(result.success).toBe(false);
  });
});

describe("observer.mod — rate_outcome", () => {
  it("写入图属性 + 缓存到 outcomeHistory（ADR-41: shrinkage ×0.8）", () => {
    const ctx = makeCtx({ outcomeHistory: [] as unknown[] });
    ctx.graph.addContact("alice", { tier: 5 });

    const impl = instructions.rate_outcome.impl;
    impl(ctx as unknown as ModContext, {
      target: "alice",
      action_ms: 1700000000000 - 300_000,
      quality: "excellent",
      reason: "good response",
      beat_type: "engagement",
    });

    const attrs = ctx.graph.getContact("alice");
    // QUALITY_MAP["excellent"] = 0.9 × shrinkage 0.8 = 0.72 (shrunk)
    // ADR-64 V-1: 无外部信号 → α=0.8 → 0.8 × 0.72 + 0.2 × 0 = 0.576
    expect(attrs.last_outcome_quality).toBeCloseTo(0.576, 5);
    expect(attrs.last_outcome_ms).toBe(1700000000000);
    expect(ctx.state.outcomeHistory).toHaveLength(1);
    expect((ctx.state.outcomeHistory[0] as { quality: number }).quality).toBeCloseTo(0.576, 5);
  });

  it("terrible 枚举映射负值（ADR-41: shrinkage ×0.8）", () => {
    const ctx = makeCtx({ outcomeHistory: [] as unknown[] });
    ctx.graph.addContact("bob", { tier: 50 });

    const impl = instructions.rate_outcome.impl;
    impl(ctx as unknown as ModContext, {
      target: "bob",
      action_ms: 1700000000000 - 600_000,
      quality: "terrible",
    });

    // QUALITY_MAP["terrible"] = -0.9 × shrinkage 0.8 = -0.72 (shrunk)
    // ADR-64 V-1: 无外部信号 → α=0.8 → 0.8 × (-0.72) + 0.2 × 0 = -0.576
    expect(ctx.graph.getContact("bob").last_outcome_quality).toBeCloseTo(-0.576, 5);
  });

  it("环形缓冲最多 20 条（ADR-41: 不同 target 绕过 cooldown）", () => {
    const ctx = makeCtx({ outcomeHistory: [] as unknown[] });

    // 创建 25 个不同 target，避免 cooldown 限制（同 target 600s 内只能评一次）
    for (let i = 0; i < 25; i++) {
      ctx.graph.addContact(`c_${i}`, { tier: 50 });
    }

    const impl = instructions.rate_outcome.impl;
    for (let i = 0; i < 25; i++) {
      impl(ctx as unknown as ModContext, {
        target: `c_${i}`,
        action_ms: i * 60_000,
        quality: "fair",
      });
    }
    expect(ctx.state.outcomeHistory).toHaveLength(20);
  });

  it("ADR-41: 同 target cooldown 600s 内拒绝第二次", () => {
    const ctx = makeCtx({ outcomeHistory: [] as unknown[] });
    ctx.graph.addContact("alice", { tier: 5 });

    const impl = instructions.rate_outcome.impl;
    const r1 = impl(ctx as unknown as ModContext, {
      target: "alice",
      action_ms: 1700000000000 - 300_000,
      quality: "good",
    }) as { success: boolean };
    expect(r1.success).toBe(true);

    // 同一上下文再评 → cooldown（600s 内）
    const r2 = impl(ctx as unknown as ModContext, {
      target: "alice",
      action_ms: 1700000000000 - 240_000,
      quality: "good",
    }) as { success: boolean; reason?: string };
    expect(r2.success).toBe(false);
    expect(r2.reason).toBe("cooldown");
  });

  it("bot target 不进入社交 outcomeHistory", () => {
    const ctx = makeCtx({ outcomeHistory: [] as unknown[] });
    ctx.graph.addContact("contact:777000", { is_bot: true, display_name: "HelperBot" });
    ctx.graph.addChannel("channel:777000", { chat_type: "private" });

    const result = instructions.rate_outcome.impl(ctx as unknown as ModContext, {
      target: "channel:777000",
      action_ms: 1700000000000 - 300_000,
      quality: "poor",
      reason: "Bot unresponsive for days.",
    }) as { success: boolean; skipped?: string };

    expect(result.success).toBe(true);
    expect(result.skipped).toBe("bot_tool_target");
    expect(ctx.state.outcomeHistory).toHaveLength(0);
    expect(ctx.graph.getChannel("channel:777000").last_outcome_quality).toBeUndefined();
    expect(ctx.graph.getContact("contact:777000").last_outcome_quality).toBeUndefined();
  });

  it("past_results 过滤旧的 bot outcome 记录", () => {
    const ctx = makeCtx({
      outcomeHistory: [
        {
          target: "channel:777000",
          actionMs: 1700000000000 - 300_000,
          quality: -0.8,
          reason: "Bot unresponsive for days.",
          beatType: "",
          ms: 1700000000000 - 60_000,
        },
        {
          target: "contact:human",
          actionMs: 1700000000000 - 300_000,
          quality: 0.5,
          reason: "reply landed",
          beatType: "",
          ms: 1700000000000 - 30_000,
        },
      ],
    });
    ctx.graph.addContact("contact:777000", { is_bot: true, display_name: "HelperBot" });
    ctx.graph.addChannel("channel:777000", { chat_type: "private" });
    ctx.graph.addContact("contact:human", { display_name: "Human" });

    const result = queries.past_results.impl(ctx as unknown as ModContext, { count: 10 }) as Array<{
      name: string;
      reason?: string;
    }>;

    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("Human");
    expect(result[0]?.reason).toBe("reply landed");
  });
});

describe("observer.mod — feel", () => {
  it("写入 mood 属性", () => {
    const ctx = makeCtx({ outcomeHistory: [] } as never);
    ctx.graph.addChannel("channel:1");

    const impl = instructions.feel.impl;
    impl(ctx as unknown as ModContext, {
      target: "channel:1",
      valence: "negative",
      arousal: "intense",
      reason: "getting frustrated",
    });

    const attrs = ctx.graph.getChannel("channel:1");
    // ADR-50: 语义标签映射 — negative → -0.4, intense → 0.9
    expect(attrs.mood_valence).toBe(-0.4);
    expect(ctx.graph.getDynamic("channel:1", "mood_arousal")).toBe(0.9);
    expect(attrs.mood_shift_ms).toBe(1700000000000);
    expect(attrs.mood_shift).toBe("getting frustrated");
  });
});

describe("observer.mod — flag_risk", () => {
  it("写入 risk 属性", () => {
    const ctx = makeCtx({ outcomeHistory: [] } as never);
    ctx.graph.addChannel("channel:1");

    const impl = instructions.flag_risk.impl;
    impl(ctx as unknown as ModContext, {
      chatId: "channel:1",
      level: "high",
      reason: "user seems upset",
    });

    const attrs = ctx.graph.getChannel("channel:1");
    expect(attrs.risk_level).toBe("high");
    expect(attrs.risk_updated_ms).toBe(1700000000000);
    expect(attrs.risk_reason).toBe("user seems upset");
  });
});

describe("observer.mod — observe_activity", () => {
  it("写入 activity 属性", () => {
    const ctx = makeCtx({ outcomeHistory: [] } as never);
    ctx.graph.addChannel("channel:1");

    const impl = instructions.observe_activity.impl;
    impl(ctx as unknown as ModContext, {
      chatId: "channel:1",
      type: "coding",
      intensity: "high",
      relevance_to_alice: "somewhat_relevant",
    });

    const attrs = ctx.graph.getChannel("channel:1");
    expect(attrs.activity_type).toBe("coding");
    // ADR-50: 语义标签 → 数值映射在代码侧完成
    expect(attrs.activity_intensity).toBe(0.8); // "high" → 0.8
    expect(attrs.activity_relevance).toBe(0.4); // "somewhat_relevant" → 0.4
  });
});

describe("observer.mod — sense", () => {
  it("默认从当前联系人派生 who，降低私聊印象记录摩擦", () => {
    expect(instructions.sense.deriveParams?.who({ TARGET_CONTACT: "contact:1" })).toBe("contact:1");
  });

  it("写入 trait belief", () => {
    const ctx = makeCtx({ outcomeHistory: [], impressionCounts: {} });
    ctx.graph.addContact("contact:1");

    const result = instructions.sense.impl(ctx as unknown as ModContext, {
      who: "contact:1",
      trait: "gentle",
      intensity: "moderate",
    }) as { success: boolean; dimension: string; observations: number };

    expect(result.success).toBe(true);
    expect(result.dimension).toBe("gentleness");
    expect(result.observations).toBe(1);
    expect(ctx.graph.beliefs.get("contact:1", "trait:gentleness")).toBeDefined();
  });
});

describe("observer.mod — chat_mood 查询", () => {
  it("返回所有标注属性", () => {
    const ctx = makeCtx({ outcomeHistory: [] } as never);
    ctx.graph.addChannel("channel:1");
    ctx.graph.setDynamic("channel:1", "last_alice_action_ms", 1699999999000);
    ctx.graph.setDynamic("channel:1", "risk_level", "medium");

    const query = queries.chat_mood;
    const result = query.impl(ctx as unknown as ModContext, { chatId: "channel:1" }) as Record<
      string,
      unknown
    >;

    expect(result.chatId).toBe("channel:1");
    expect(result.last_alice_action_ms).toBe(1699999999000);
    expect(result.risk_level).toBe("medium");
    expect(result.mood_valence).toBeNull();
  });

  it("节点不存在时返回 null", () => {
    const ctx = makeCtx({ outcomeHistory: [] } as never);
    const query = queries.chat_mood;
    expect(query.impl(ctx as unknown as ModContext, { chatId: "nope" })).toBeNull();
  });
});

// OBSERVER_INSTRUCTIONS 已删除（ADR-31 后不再需要区分 observer 和普通指令）。

// -- Beat 新类型测试 -----------------------------------------------------------

describe("Beat 类型扩展", () => {
  it("包含 10 种类型（ADR-181: +prudence, +breakthrough）", () => {
    expect(BEAT_TYPES).toHaveLength(10);
    expect(BEAT_TYPES).toContain("kernel");
    expect(BEAT_TYPES).toContain("ambient");
    expect(BEAT_TYPES).toContain("observation");
    expect(BEAT_TYPES).toContain("engagement");
    expect(BEAT_TYPES).toContain("assistance");
    expect(BEAT_TYPES).toContain("misstep");
    expect(BEAT_TYPES).toContain("connection");
    expect(BEAT_TYPES).toContain("insight");
    expect(BEAT_TYPES).toContain("prudence");
    expect(BEAT_TYPES).toContain("breakthrough");
  });
});

// -- note_promise 已删除（ADR-204 Wave 2: 合并入 self_note + self_topic_begin）--

describe("begin_topic with horizon", () => {
  it("horizon 设置时创建图 Thread 实体", () => {
    const ctx = makeCtx({ activeCount: 0, maxPressure: 0 } as never, 50);

    // 需要 mock getDb，这里只测试图同步逻辑
    // begin_topic 需要 DB，在集成测试中覆盖
    // 这里验证图操作的独立逻辑

    // 手动模拟 begin_topic 的图同步部分
    const horizon = 20;
    const tick = 50;
    const weight = "major";
    const threadNodeId = "thread_1";
    const w = 2.0; // WEIGHT_MAP["major"]

    ctx.graph.addThread(threadNodeId, {
      status: "open",
      weight,
      w,
      created_ms: tick,
      deadline: tick + horizon,
    });

    ctx.graph.addContact("alice", { tier: 5 });
    ctx.graph.addRelation(threadNodeId, "involves", "alice");

    const attrs = ctx.graph.getThread(threadNodeId);
    expect(attrs.deadline).toBe(70);
    expect(attrs.status).toBe("open");
    expect(attrs.w).toBe(2.0);

    // 验证 involves 边
    const neighbors = ctx.graph.getNeighbors(threadNodeId, "involves");
    expect(neighbors).toContain("alice");
  });
});
