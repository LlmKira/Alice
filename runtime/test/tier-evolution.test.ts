/**
 * M4 Wave 4 测试 — Tier 演化引擎。
 *
 * 四维评分: TierScore = 0.35F + 0.25Q + 0.25D + 0.15T (ADR-47 G9)
 * 连续阈值: 3 次 > 0.7 升级, 5 次 < 0.3 降级（非对称）
 * Dunbar 阶梯: 500 → 150 → 50 → 15 → 5
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModContext } from "../src/core/types.js";
import { closeDb, getDb, initDb } from "../src/db/connection.js";
import { actionLog } from "../src/db/schema.js";
import { WorldModel } from "../src/graph/world-model.js";
import {
  type ContactProfile,
  DUNBAR_TIERS,
  nextCloserTier,
  nextFartherTier,
  relationshipsMod,
  TIER_CONSECUTIVE_REQUIRED,
  TIER_DOWNGRADE_CONSECUTIVE,
  TIER_DOWNGRADE_THRESHOLD,
  TIER_EVAL_INTERVAL,
  TIER_UPGRADE_THRESHOLD,
  tierScore,
} from "../src/mods/relationships.mod.js";

// -- tierScore 纯函数测试 ---------------------------------------------------

describe("tierScore — 四维评分 (ADR-47 G9)", () => {
  // ADR-47 G9: TierScore = 0.35F + 0.25Q + 0.25D + 0.15T (trust 默认 0.5)
  it("全满分 (trust=1.0) → ≈ 1.0", () => {
    const score = tierScore(
      20, // interactionCount (tier 5 期望 6/day)
      5, // tier
      1.0, // avgQuality (max)
      20, // factCount
      20, // maxFacts
      15, // threadInvolvement
      15, // maxThreads
      1.0, // trust (max)
    );
    expect(score).toBeCloseTo(1.0, 1);
  });

  it("全零分 (默认 trust=0.5) → 0.2", () => {
    // Frequency = 0, Quality = (0+1)/2 = 0.5, Depth = 0, Trust = 0.5
    // TierScore = 0.35*0 + 0.25*0.5 + 0.25*0 + 0.15*0.5 = 0.125 + 0.075 = 0.2
    const score = tierScore(0, 150, 0, 0, 20, 0, 15);
    expect(score).toBeCloseTo(0.2, 2);
  });

  it("仅高频交互 → 0.55", () => {
    // Frequency = 1.0, Quality = 0.5 (baseline), Depth = 0, Trust = 0.5
    // TierScore = 0.35*1 + 0.25*0.5 + 0.25*0 + 0.15*0.5 = 0.35 + 0.125 + 0 + 0.075 = 0.55
    const score = tierScore(20, 5, 0, 0, 20, 0, 15);
    expect(score).toBeCloseTo(0.55, 2);
  });

  it("仅高质量 → 0.325", () => {
    // Frequency = 0, Quality = (1+1)/2 = 1.0, Depth = 0, Trust = 0.5
    // TierScore = 0.35*0 + 0.25*1.0 + 0.25*0 + 0.15*0.5 = 0 + 0.25 + 0 + 0.075 = 0.325
    const score = tierScore(0, 150, 1.0, 0, 20, 0, 15);
    expect(score).toBeCloseTo(0.325, 2);
  });

  it("交互频率超过期望值被 clamp 到 1", () => {
    // tier 150 期望 0.3 次/day, 传入 100 → frequency = min(1, 100/0.3) → 1.0
    const score1 = tierScore(100, 150, 0, 0, 20, 0, 15);
    // tier 150 期望 0.3, 传入 1 → frequency = min(1, 1/0.3) = min(1, 3.33) = 1.0
    const score2 = tierScore(1, 150, 0, 0, 20, 0, 15);
    // 都是 0.35*1 + 0.125 + 0 + 0.075 = 0.55
    expect(score1).toBeCloseTo(0.55, 2);
    expect(score2).toBeCloseTo(0.55, 2);
    expect(score1).toBeCloseTo(score2, 2);
  });
});

// -- Dunbar 阶梯导航 ---------------------------------------------------------

describe("nextCloserTier — Dunbar 阶梯升级", () => {
  it("500 → 150", () => expect(nextCloserTier(500)).toBe(150));
  it("150 → 50", () => expect(nextCloserTier(150)).toBe(50));
  it("50 → 15", () => expect(nextCloserTier(50)).toBe(15));
  it("15 → 5", () => expect(nextCloserTier(15)).toBe(5));
  it("5 → null (已最亲密)", () => expect(nextCloserTier(5)).toBeNull());
});

describe("nextFartherTier — Dunbar 阶梯降级", () => {
  it("5 → 15", () => expect(nextFartherTier(5)).toBe(15));
  it("15 → 50", () => expect(nextFartherTier(15)).toBe(50));
  it("50 → 150", () => expect(nextFartherTier(50)).toBe(150));
  it("150 → 500", () => expect(nextFartherTier(150)).toBe(500));
  it("500 → null (已最疏远)", () => expect(nextFartherTier(500)).toBeNull());
});

describe("非标准 tier 处理", () => {
  it("tier 100 (不在阶梯上) → nextCloserTier 找到 50", () => {
    expect(nextCloserTier(100)).toBe(50);
  });

  it("tier 100 → nextFartherTier 找到 150", () => {
    expect(nextFartherTier(100)).toBe(150);
  });

  it("tier 3 (比 5 更亲密) → nextCloserTier 返回 null", () => {
    expect(nextCloserTier(3)).toBeNull();
  });

  it("tier 1000 (比 500 更疏远) → nextFartherTier 返回 null", () => {
    expect(nextFartherTier(1000)).toBeNull();
  });
});

// -- 常量验证 -----------------------------------------------------------------

describe("Tier 演化常量", () => {
  it("Dunbar 阶梯: [500, 150, 50, 15, 5]", () => {
    expect([...DUNBAR_TIERS]).toEqual([500, 150, 50, 15, 5]);
  });

  it("升级阈值 > 降级阈值", () => {
    expect(TIER_UPGRADE_THRESHOLD).toBeGreaterThan(TIER_DOWNGRADE_THRESHOLD);
  });

  it("升级连续次数 >= 2", () => {
    expect(TIER_CONSECUTIVE_REQUIRED).toBeGreaterThanOrEqual(2);
  });

  it("降级连续次数 > 升级连续次数（非对称保护）", () => {
    expect(TIER_DOWNGRADE_CONSECUTIVE).toBeGreaterThan(TIER_CONSECUTIVE_REQUIRED);
    expect(TIER_DOWNGRADE_CONSECUTIVE).toBe(5);
  });

  it("不跳级: 500 不能直接到 50", () => {
    // 验证每次只能移动一步
    let tier = 500;
    const path: number[] = [tier];
    while (true) {
      const next = nextCloserTier(tier);
      if (next === null) break;
      tier = next;
      path.push(tier);
    }
    expect(path).toEqual([500, 150, 50, 15, 5]);
  });
});

// -- onTickEnd 集成测试 -------------------------------------------------------

interface TierTracker {
  consecutiveHigh: number;
  consecutiveLow: number;
  lastEvalTick: number;
}

interface TestRelState {
  targetNodeId: string | null;
  contactProfiles: Record<string, ContactProfile>;
  tierTrackers: Record<string, TierTracker>;
}

function makeCtx(
  stateOverride: Partial<TestRelState> = {},
  tick = TIER_EVAL_INTERVAL,
  nowMs?: number,
) {
  const graph = new WorldModel();
  graph.tick = tick;
  const state: TestRelState = {
    targetNodeId: stateOverride.targetNodeId ?? null,
    contactProfiles: stateOverride.contactProfiles ?? {},
    tierTrackers: stateOverride.tierTrackers ?? {},
  };
  return {
    graph,
    state,
    tick,
    nowMs: nowMs ?? Date.now(),
    getModState: (name: string): unknown => {
      if (name === "observer")
        return { outcomeHistory: [] as { target: string; quality: number }[] };
      return undefined;
    },
    dispatch: () => undefined,
  };
}

describe("relationships.mod — onTickEnd Tier 演化", () => {
  // P1-mods-1 修复后 Frequency 使用 DB 窗口计数（非累积图属性）。
  // 需要初始化 in-memory DB 让 getDb() 可用。
  beforeEach(() => {
    initDb(":memory:");
  });
  afterEach(() => {
    closeDb();
  });

  /** 在 action_log 中插入 N 条记录来模拟交互频率。 */
  function insertActionRecords(chatId: string, count: number, baseTick: number) {
    const db = getDb();
    for (let i = 0; i < count; i++) {
      db.insert(actionLog)
        .values({
          tick: baseTick + i,
          voice: "test",
          actionType: "send_message",
          chatId,
          success: true,
        })
        .run();
    }
  }

  it("tick 非 TIER_EVAL_INTERVAL 整数倍时不评估", () => {
    const ctx = makeCtx({}, TIER_EVAL_INTERVAL + 1);
    ctx.graph.addContact("contact:telegram:1", { tier: 150 });

    // biome-ignore lint/style/noNonNullAssertion: test
    relationshipsMod.onTickEnd!(ctx as unknown as ModContext);

    expect(ctx.state.tierTrackers["contact:telegram:1"]).toBeUndefined();
  });

  it("tick=0 时不评估", () => {
    const ctx = makeCtx({}, 0);
    ctx.graph.addContact("contact:telegram:1", { tier: 150 });

    // biome-ignore lint/style/noNonNullAssertion: test
    relationshipsMod.onTickEnd!(ctx as unknown as ModContext);

    expect(ctx.state.tierTrackers["contact:telegram:1"]).toBeUndefined();
  });

  it("初始化 tracker", () => {
    const ctx = makeCtx({}, TIER_EVAL_INTERVAL);
    ctx.graph.addContact("contact:telegram:1", { tier: 150 });

    // biome-ignore lint/style/noNonNullAssertion: test
    relationshipsMod.onTickEnd!(ctx as unknown as ModContext);

    expect(ctx.state.tierTrackers["contact:telegram:1"]).toBeDefined();
    expect(ctx.state.tierTrackers["contact:telegram:1"].lastEvalTick).toBe(TIER_EVAL_INTERVAL);
  });

  it("连续 3 次高分 → 升级 150 → 50", () => {
    const ctx = makeCtx(
      {
        tierTrackers: {
          "contact:telegram:1": { consecutiveHigh: 2, consecutiveLow: 0, lastEvalTick: 0 },
        },
      },
      TIER_EVAL_INTERVAL,
    );
    ctx.graph.addContact("contact:telegram:1", {
      tier: 150,
      interaction_count: 20,
    });
    // 添加 15 条 fact 图节点作为 facts（替代旧 memorizedFacts）
    for (let i = 0; i < 15; i++) {
      const iid = `info_contact:telegram:1_test_${i}`;
      ctx.graph.addFact(iid, {
        content: `fact_${i}`,
        fact_type: "observation",
        importance: 0.5,
        stability: 5.0,
        last_access_ms: TIER_EVAL_INTERVAL - 1,
        volatility: 0,
        tracked: false,
        created_ms: 0,
        novelty: 1.0,
        reinforcement_count: 1,
        source_contact: "contact:telegram:1",
      });
      ctx.graph.addRelation("contact:telegram:1", "knows", iid);
    }
    // P1-mods-1: Frequency 现在从 DB 窗口计数获取，需要插入记录
    // tier=150 的 EXPECTED_FREQUENCY=0.3/day，插入 5 条 → frequency=min(1,5/0.3)=1.0
    insertActionRecords("channel:telegram:1", 5, TIER_EVAL_INTERVAL - 10);
    ctx.getModState = (name: string) => {
      if (name === "observer") {
        return {
          outcomeHistory: Array.from({ length: 10 }, () => ({
            target: "contact:telegram:1",
            quality: 0.9,
          })),
        };
      }
      return undefined;
    };

    // biome-ignore lint/style/noNonNullAssertion: test
    relationshipsMod.onTickEnd!(ctx as unknown as ModContext);

    expect(ctx.graph.getContact("contact:telegram:1").tier).toBe(50);
    expect(ctx.graph.getContact("contact:telegram:1").tier_direction).toBe("upgrade");
    expect(ctx.state.tierTrackers["contact:telegram:1"].consecutiveHigh).toBe(0);
  });

  it("连续 5 次低分 → 降级 50 → 150（非对称：降级需 5 次）", () => {
    const ctx = makeCtx(
      {
        tierTrackers: {
          // 已经连续 4 次低分，再加 1 次 = 5 → 触发降级
          "contact:telegram:1": { consecutiveHigh: 0, consecutiveLow: 4, lastEvalTick: 0 },
        },
      },
      TIER_EVAL_INTERVAL,
    );
    ctx.graph.addContact("contact:telegram:1", { tier: 50 });
    ctx.getModState = (name: string) => {
      if (name === "observer") {
        return {
          outcomeHistory: Array.from({ length: 5 }, () => ({
            target: "contact:telegram:1",
            quality: -0.8,
          })),
        };
      }
      return undefined;
    };

    // biome-ignore lint/style/noNonNullAssertion: test
    relationshipsMod.onTickEnd!(ctx as unknown as ModContext);

    expect(ctx.graph.getContact("contact:telegram:1").tier).toBe(150);
    expect(ctx.graph.getContact("contact:telegram:1").tier_direction).toBe("downgrade");
  });

  it("连续 3 次低分不足以降级（需 5 次）", () => {
    const ctx = makeCtx(
      {
        tierTrackers: {
          "contact:telegram:1": { consecutiveHigh: 0, consecutiveLow: 2, lastEvalTick: 0 },
        },
      },
      TIER_EVAL_INTERVAL,
    );
    ctx.graph.addContact("contact:telegram:1", { tier: 50 });
    ctx.getModState = (name: string) => {
      if (name === "observer") {
        return { outcomeHistory: [] };
      }
      return undefined;
    };

    // biome-ignore lint/style/noNonNullAssertion: test
    relationshipsMod.onTickEnd!(ctx as unknown as ModContext);

    // consecutiveLow 增加到 3，但未达到 5 次阈值，tier 保持不变
    expect(ctx.graph.getContact("contact:telegram:1").tier).toBe(50);
    expect(ctx.state.tierTrackers["contact:telegram:1"].consecutiveLow).toBe(3);
  });

  it("最亲密 tier (5) 不再升级", () => {
    const ctx = makeCtx(
      {
        tierTrackers: {
          "contact:telegram:1": { consecutiveHigh: 2, consecutiveLow: 0, lastEvalTick: 0 },
        },
      },
      TIER_EVAL_INTERVAL,
    );
    ctx.graph.addContact("contact:telegram:1", { tier: 5, interaction_count: 50 });
    // 添加 20 条 fact 图节点作为 facts
    for (let i = 0; i < 20; i++) {
      const iid = `info_contact:telegram:1_test_${i}`;
      ctx.graph.addFact(iid, {
        content: `f${i}`,
        fact_type: "observation",
        importance: 0.5,
        stability: 10.0,
        last_access_ms: TIER_EVAL_INTERVAL - 1,
        volatility: 0,
        tracked: false,
        created_ms: 0,
        novelty: 1.0,
        reinforcement_count: 1,
        source_contact: "contact:telegram:1",
      });
      ctx.graph.addRelation("contact:telegram:1", "knows", iid);
    }
    ctx.getModState = (name: string) => {
      if (name === "observer") {
        return {
          outcomeHistory: Array.from({ length: 10 }, () => ({
            target: "contact:telegram:1",
            quality: 1.0,
          })),
        };
      }
      return undefined;
    };

    // biome-ignore lint/style/noNonNullAssertion: test
    relationshipsMod.onTickEnd!(ctx as unknown as ModContext);

    expect(ctx.graph.getContact("contact:telegram:1").tier).toBe(5);
  });

  it("最疏远 tier (500) 不再降级", () => {
    const ctx = makeCtx(
      {
        tierTrackers: {
          "contact:telegram:1": { consecutiveHigh: 0, consecutiveLow: 4, lastEvalTick: 0 },
        },
      },
      TIER_EVAL_INTERVAL,
    );
    ctx.graph.addContact("contact:telegram:1", { tier: 500 });
    ctx.getModState = (name: string) => {
      if (name === "observer") {
        return {
          outcomeHistory: Array.from({ length: 5 }, () => ({
            target: "contact:telegram:1",
            quality: -1.0,
          })),
        };
      }
      return undefined;
    };

    // biome-ignore lint/style/noNonNullAssertion: test
    relationshipsMod.onTickEnd!(ctx as unknown as ModContext);

    // consecutiveLow = 5 → 降级触发，但 tier 500 已是最疏远，无法再降
    expect(ctx.graph.getContact("contact:telegram:1").tier).toBe(500);
  });
});

// -- ADR-47 G9: trust 独立建模 ------------------------------------------------

describe("tierScore — G9 trust 影响", () => {
  it("trust=1.0 提升 TierScore", () => {
    // F=0, Q=0.5, D=0, T=1.0
    // 0.35*0 + 0.25*0.5 + 0.25*0 + 0.15*1.0 = 0.125 + 0.15 = 0.275
    const scoreHigh = tierScore(0, 150, 0, 0, 20, 0, 15, 1.0);
    // F=0, Q=0.5, D=0, T=0.0
    // 0.35*0 + 0.25*0.5 + 0.25*0 + 0.15*0.0 = 0.125
    const scoreLow = tierScore(0, 150, 0, 0, 20, 0, 15, 0.0);
    expect(scoreHigh).toBeGreaterThan(scoreLow);
    expect(scoreHigh).toBeCloseTo(0.275, 2);
    expect(scoreLow).toBeCloseTo(0.125, 2);
  });

  it("trust=0.5 (默认) 与旧行为一致", () => {
    // 默认 trust=0.5 → 0.15*0.5 = 0.075 额外加成
    const scoreDefault = tierScore(0, 150, 0, 0, 20, 0, 15);
    const scoreExplicit = tierScore(0, 150, 0, 0, 20, 0, 15, 0.5);
    expect(scoreDefault).toBeCloseTo(scoreExplicit, 4);
  });
});

// ADR-198: update_trust 测试已删除。trust 统一由 rv_trust（图属性）管理。
