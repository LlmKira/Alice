/**
 * strategy.mod 测试 — 行为策略层纯逻辑验证。
 *
 * 测试策略提示的生成逻辑（listen → onTickEnd → contribute）。
 * DB 依赖的提示（thread_stale、voice distribution）在无 DB 时优雅退化。
 */
import { describe, expect, it, vi } from "vitest";
import type { ModContext } from "../src/core/types.js";
import { WorldModel } from "../src/graph/world-model.js";

// 隔离真实 DB — 此文件是纯逻辑单元测试，不依赖 alice.db
vi.mock("../src/db/connection.js", () => ({
  getDb: () => {
    throw new Error("no db in test");
  },
  getSqlite: () => {
    throw new Error("no db in test");
  },
}));

import {
  DRIFT_ALERT_THRESHOLD,
  DRIFT_AUDIT_INTERVAL,
  DRIFT_WARNING_THRESHOLD,
  extractKeywords,
  type GroupChatState,
  type PersonalityDriftState,
} from "../src/mods/strategy/types.js";
import { strategyMod } from "../src/mods/strategy.mod.js";

// -- 测试辅助 -----------------------------------------------------------------

interface StrategyState {
  recentActions: Array<{ target: string | null; tick: number; ms?: number; intent: string }>;
  activeHints: Array<{ type: string; message: string }>;
  messageFrequency: Record<
    string,
    { recentCount: number; baseline: number; variance?: number; lastTick: number; lastMs?: number }
  >;
  crisisChannels: Record<string, number>;
  crisisChannelsMs?: Record<string, number>;
  groupStates: Record<string, GroupChatState>;
  personalityDrift: PersonalityDriftState;
}

/** ADR-110: 固定基准墙钟时间，避免 Date.now() 漂移。 */
const BASE_MS = 1_000_000_000;
function tickMs(tick: number): number {
  return tick * 60_000;
}

function makeCtx(
  state: StrategyState,
  tick = 100,
): ModContext<StrategyState> & { graph: WorldModel } {
  const graph = new WorldModel();
  graph.tick = tick;
  return {
    graph,
    state,
    tick,
    nowMs: BASE_MS + tickMs(tick),
    getModState: () => undefined,
    dispatch: () => undefined,
  };
}

function freshState(): StrategyState {
  return {
    recentActions: [],
    activeHints: [],
    messageFrequency: {},
    crisisChannels: {},
    groupStates: {},
    personalityDrift: {
      lastAuditTick: 0,
      previousWeights: null,
      drift: 0,
      velocity: 0,
      health: "healthy",
    },
  };
}

// biome-ignore lint/style/noNonNullAssertion: test
const listen = strategyMod.listen!;
// biome-ignore lint/style/noNonNullAssertion: test
const onTickEnd = strategyMod.onTickEnd!;
// biome-ignore lint/style/noNonNullAssertion: test
const contribute = strategyMod.contribute!;

// -- listen 测试 ---------------------------------------------------------------

describe("strategy.mod — listen", () => {
  it("DECLARE_ACTION 记录到 recentActions", () => {
    const state = freshState();
    const ctx = makeCtx(state, 50);

    listen.DECLARE_ACTION(
      ctx as unknown as ModContext,
      { target: "channel:telegram:123", intent: "greet" },
      undefined,
    );

    expect(state.recentActions).toHaveLength(1);
    expect(state.recentActions[0].target).toBe("channel:telegram:123");
    expect(state.recentActions[0].tick).toBe(50);
  });

  it("recentActions 环形缓冲 20 条", () => {
    const state = freshState();
    for (let i = 0; i < 25; i++) {
      const ctx = makeCtx(state, i);
      listen.DECLARE_ACTION(ctx as unknown as ModContext, { target: `channel:${i}` }, undefined);
    }
    expect(state.recentActions).toHaveLength(20);
    // 最老的 5 条被淘汰
    expect(state.recentActions[0].tick).toBe(5);
  });

  it("SEND_MESSAGE 更新群聊状态", () => {
    const state = freshState();
    const ctx = makeCtx(state, 80);

    listen.SEND_MESSAGE(
      ctx as unknown as ModContext,
      { chatId: "channel:telegram:456", text: "hello", senderName: "Alice", isOutgoing: true },
      undefined,
    );

    // SEND_MESSAGE 不再写 contactLastInteraction（已移除冗余字段），
    // 但仍更新 groupStates。
    expect(state.groupStates["channel:telegram:456"]).toBeDefined();
    expect(state.groupStates["channel:telegram:456"].totalMessages).toBe(1);
  });
});

// -- onTickEnd 策略提示生成测试 -------------------------------------------------

describe("strategy.mod — relationship_cooling", () => {
  it("亲密联系人沉默超阈值 → 生成提示", () => {
    const state = freshState();
    const ctx = makeCtx(state, 100);
    ctx.graph.addContact("contact:bob", {
      display_name: "Bob",
      tier: 15, // ADR-113: close friend → threshold 86400s (1 day)
      last_alice_action_ms: BASE_MS + tickMs(100) - 90_000_000, // silence = 90000s > 86400s
    });

    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    expect(state.activeHints.length).toBeGreaterThanOrEqual(1);
    const hint = state.activeHints.find((h) => h.type === "relationship_cooling");
    expect(hint).toBeTruthy();
    expect(hint?.message).toContain("Bob");
    expect(hint?.message).toContain("close friend");
  });

  it("沉默未超阈值 → 不生成提示", () => {
    const state = freshState();
    const ctx = makeCtx(state, 100);
    ctx.graph.addContact("contact:bob", {
      display_name: "Bob",
      tier: 15, // threshold 3600s
      last_alice_action_ms: BASE_MS + tickMs(50), // silence = (100-50)*60 = 3000s < 3600s
    });

    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    const hint = state.activeHints.find((h) => h.type === "relationship_cooling");
    expect(hint).toBeUndefined();
  });

  it("从未互动的联系人（lastInteraction=0） → 不生成提示", () => {
    const state = freshState();
    const ctx = makeCtx(state, 100);
    ctx.graph.addContact("contact:new", { display_name: "NewPerson", tier: 50 });

    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    const hint = state.activeHints.find((h) => h.type === "relationship_cooling");
    expect(hint).toBeUndefined();
  });
});

describe("strategy.mod — attention_imbalance", () => {
  it("行动集中度 > 60% → 生成提示", () => {
    const state = freshState();
    // 10 次行动中 7 次集中在同一目标
    for (let i = 0; i < 7; i++) {
      state.recentActions.push({ target: "channel:same", tick: i, intent: "" });
    }
    for (let i = 0; i < 3; i++) {
      state.recentActions.push({ target: `channel:other_${i}`, tick: 10 + i, intent: "" });
    }

    const ctx = makeCtx(state, 100);
    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    const hint = state.activeHints.find((h) => h.type === "attention_imbalance");
    expect(hint).toBeTruthy();
    // ADR-172: safeDisplayName 返回 "(someone)" 而非 raw graph ID
    expect(hint?.message).toContain("(someone)");
    expect(hint?.message).toContain("Most of");
  });

  it("行动分散 → 不生成提示", () => {
    const state = freshState();
    for (let i = 0; i < 10; i++) {
      state.recentActions.push({ target: `channel:${i}`, tick: i, intent: "" });
    }

    const ctx = makeCtx(state, 100);
    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    const hint = state.activeHints.find((h) => h.type === "attention_imbalance");
    expect(hint).toBeUndefined();
  });

  it("行动不足 5 条 → 不触发检测", () => {
    const state = freshState();
    state.recentActions.push({ target: "channel:same", tick: 1, intent: "" });
    state.recentActions.push({ target: "channel:same", tick: 2, intent: "" });

    const ctx = makeCtx(state, 100);
    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    const hint = state.activeHints.find((h) => h.type === "attention_imbalance");
    expect(hint).toBeUndefined();
  });
});

describe("strategy.mod — opportunity", () => {
  it("联系人刚上线（5 tick 内） → 生成提示", () => {
    const state = freshState();
    const ctx = makeCtx(state, 100);
    ctx.graph.addContact("contact:alice", {
      display_name: "Alice_friend",
      returning_ms: BASE_MS + tickMs(97), // silence = (100-97)*60 = 180s <= 300s
    });

    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    const hint = state.activeHints.find((h) => h.type === "opportunity");
    expect(hint).toBeTruthy();
    expect(hint?.message).toContain("Alice_friend");
  });

  it("联系人上线太久（> 5 tick） → 不生成提示", () => {
    const state = freshState();
    const ctx = makeCtx(state, 100);
    ctx.graph.addContact("contact:alice", {
      display_name: "Alice_friend",
      returning_ms: BASE_MS + tickMs(90), // silence = (100-90)*60 = 600s > 300s
    });

    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    const hint = state.activeHints.find((h) => h.type === "opportunity");
    expect(hint).toBeUndefined();
  });
});

describe("strategy.mod — conversation_pending", () => {
  it("轮到 Alice 的对话 → 生成提示", () => {
    const state = freshState();
    const ctx = makeCtx(state, 100);
    ctx.graph.addContact("contact:bob", { display_name: "Bob" });
    ctx.graph.addConversation("conversation:1", {
      turn_state: "alice_turn",
      state: "active",
      participants: ["contact:bob"],
    });

    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    const hint = state.activeHints.find((h) => h.type === "conversation_pending");
    expect(hint).toBeTruthy();
    // 无障碍：hint 使用 display_name 而非 raw ID
    expect(hint?.message).toContain("Bob");
    expect(hint?.message).not.toContain("conversation:1");
  });

  it("对方回合 → 不生成提示", () => {
    const state = freshState();
    const ctx = makeCtx(state, 100);
    ctx.graph.addConversation("conversation:1", {
      turn_state: "other_turn",
      state: "active",
    });

    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    const hint = state.activeHints.find((h) => h.type === "conversation_pending");
    expect(hint).toBeUndefined();
  });
});

// -- contribute 测试 -----------------------------------------------------------

describe("strategy.mod — contribute", () => {
  it("有策略提示 → 输出 strategy-hints section", () => {
    const state = freshState();
    state.activeHints = [{ type: "opportunity", message: "Bob just came back online." }];
    // 需要至少 3 个 recentActions 才输出 self-awareness
    state.recentActions = [
      { target: "a", tick: 1, intent: "" },
      { target: "b", tick: 2, intent: "" },
      { target: "c", tick: 3, intent: "" },
    ];

    const ctx = makeCtx(state, 100);
    const items = contribute(ctx as unknown as ModContext<StrategyState>);

    const hints = items.find((i) => i.key === "strategy-hints");
    expect(hints).toBeTruthy();
    expect(hints?.lines.some((l) => l.includes("Bob"))).toBe(true);
  });

  it("无提示 → 不输出 strategy-hints section", () => {
    const state = freshState();
    const ctx = makeCtx(state, 100);
    const items = contribute(ctx as unknown as ModContext<StrategyState>);

    const hints = items.find((i) => i.key === "strategy-hints");
    expect(hints).toBeUndefined();
  });

  it("空图无 recentActions → 优雅退化，不崩溃", () => {
    const state = freshState();
    const ctx = makeCtx(state, 100);

    // onTickEnd 也不应崩溃
    onTickEnd(ctx as unknown as ModContext<StrategyState>);
    expect(state.activeHints).toHaveLength(0);

    // contribute 也不应崩溃
    const items = contribute(ctx as unknown as ModContext<StrategyState>);
    expect(items).toHaveLength(0);
  });

  it("每类型最多 3 条提示（防止 context 膨胀）", () => {
    const state = freshState();
    state.recentActions = [
      { target: "a", tick: 1, intent: "" },
      { target: "b", tick: 2, intent: "" },
      { target: "c", tick: 3, intent: "" },
    ];
    // 5 条同类型提示
    for (let i = 0; i < 5; i++) {
      state.activeHints.push({
        type: "relationship_cooling",
        message: `Contact ${i} is cooling`,
      });
    }

    const ctx = makeCtx(state, 100);
    const items = contribute(ctx as unknown as ModContext<StrategyState>);

    const hints = items.find((i) => i.key === "strategy-hints");
    expect(hints).toBeTruthy();
    // 最多 3 条（5 条被截断为 3）
    expect(hints?.lines.length).toBeLessThanOrEqual(3);
  });
});

// -- 场景 6: 危机检测测试 -------------------------------------------------------

describe("strategy.mod — crisis_detected", () => {
  it("频道消息突增 Z-score > 2.5 → 生成 crisis_detected 提示", () => {
    const state = freshState();
    // 预设基线：频道平均 3 条 unread（无 variance → 首次更新后建立）
    state.messageFrequency["channel:crisis"] = { recentCount: 3, baseline: 3, lastTick: 90 };

    const ctx = makeCtx(state, 100);
    ctx.graph.addChannel("channel:crisis", {
      display_name: "CrisisRoom",
      // Z-score 路径：diff=22, baseline→5.2, variance→43.56
      // Z = (25-5.2)/√43.56 ≈ 3.0 > 2.5 → crisis
      unread: 25,
      chat_type: "group",
    });

    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    const hint = state.activeHints.find((h) => h.type === "crisis_detected");
    expect(hint).toBeTruthy();
    expect(hint?.message).toContain("CrisisRoom");
    expect(state.crisisChannels["channel:crisis"]).toBe(100);
  });

  it("频道消息未超阈值 → 不生成提示", () => {
    const state = freshState();
    state.messageFrequency["channel:normal"] = { recentCount: 3, baseline: 3, lastTick: 90 };

    const ctx = makeCtx(state, 100);
    ctx.graph.addChannel("channel:normal", {
      unread: 5, // variance=0.36 < 1.0 → fallback ratio: 5 > 5 false → no crisis
      chat_type: "group",
    });

    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    const hint = state.activeHints.find((h) => h.type === "crisis_detected");
    expect(hint).toBeUndefined();
  });

  it("危机恢复 → 清除 crisisChannels + 生成恢复提示", () => {
    const state = freshState();
    // ADR-110: messageFrequency 需要 lastMs 字段，crisisChannelsMs 需要设置
    const crisisDetectedMs = Date.now() - 1200 * 1000; // 危机 20 分钟前检测到
    const nowMs = Date.now();
    state.messageFrequency["channel:recover"] = {
      recentCount: 10,
      baseline: 3,
      lastTick: 90,
      lastMs: crisisDetectedMs + 600_000, // 中间更新
    };
    state.crisisChannels["channel:recover"] = 80; // 危机在 tick 80 检测到
    state.crisisChannelsMs = { "channel:recover": crisisDetectedMs };

    const ctx = makeCtx(state, 100);
    ctx.nowMs = nowMs;
    ctx.graph.addChannel("channel:recover", {
      display_name: "RecoverRoom",
      unread: 2, // variance=0.09 < 1.0 → fallback ratio: 2/2.9 = 0.69 < 1.5 → 恢复
      chat_type: "group",
    });

    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    const hint = state.activeHints.find((h) => h.type === "crisis_detected");
    expect(hint).toBeTruthy();
    expect(hint?.message).toContain("calmed down");
    expect(hint?.message).toContain("about 20 minutes");
    expect(state.crisisChannels["channel:recover"]).toBeUndefined();
  });

  it("Z-score 路径：有积累 variance 时使用 Z-score 而非频率比", () => {
    const state = freshState();
    const prevMs = BASE_MS + tickMs(90);
    // 预设：已积累 variance（稳态基线=10, σ=2）
    state.messageFrequency["channel:zscore"] = {
      recentCount: 10,
      baseline: 10,
      variance: 4.0, // σ = 2
      lastTick: 90,
      lastMs: prevMs,
    };

    const ctx = makeCtx(state, 100);
    ctx.graph.addChannel("channel:zscore", {
      display_name: "ZScoreRoom",
      // diff=50-10=40, baseline→10+0.1*40=14, variance→0.9*(4+0.1*1600)=147.6
      // Z = (50-14)/√147.6 ≈ 36/12.15 ≈ 2.96 > 2.5 → crisis
      unread: 50,
      chat_type: "group",
    });
    onTickEnd(ctx as unknown as ModContext<StrategyState>);
    const hint = state.activeHints.find((h) => h.type === "crisis_detected");
    expect(hint).toBeTruthy();
    expect(hint?.message).toContain("ZScoreRoom");
  });

  it("Z-score 恢复：已有 variance 且 Z 降到 < 1.0 → 恢复", () => {
    const state = freshState();
    const nowMs = BASE_MS + tickMs(100);
    const prevMs = BASE_MS + tickMs(90);
    const crisisDetectedMs = BASE_MS + tickMs(85);
    state.messageFrequency["channel:zrecover"] = {
      recentCount: 30,
      baseline: 15,
      variance: 25.0, // σ = 5
      lastTick: 90,
      lastMs: prevMs,
    };
    state.crisisChannels["channel:zrecover"] = 85;
    state.crisisChannelsMs = { "channel:zrecover": crisisDetectedMs };

    const ctx = makeCtx(state, 100);
    ctx.graph.addChannel("channel:zrecover", {
      display_name: "ZRecoverRoom",
      // diff=16-15=1, baseline≈15.1, variance≈(0.9*(25+0.1*1))≈22.59
      // Z = (16-15.1)/√22.59 ≈ 0.9/4.75 ≈ 0.19 < 1.0 → 恢复
      unread: 16,
      chat_type: "group",
    });

    onTickEnd(ctx as unknown as ModContext<StrategyState>);
    const hint = state.activeHints.find((h) => h.type === "crisis_detected");
    expect(hint).toBeTruthy();
    expect(hint?.message).toContain("calmed down");
    expect(state.crisisChannels["channel:zrecover"]).toBeUndefined();
  });
});

// -- 场景 4: 群聊氛围检测测试 ---------------------------------------------------

describe("strategy.mod — group_atmosphere", () => {
  it("活跃群聊 Alice 长时间沉默 → 生成提示", () => {
    const state = freshState();
    const ctx = makeCtx(state, 100);
    ctx.graph.addChannel("channel:group", {
      display_name: "FunGroup",
      chat_type: "group",
      unread: 12,
      last_alice_action_ms: BASE_MS + tickMs(70), // silence = (100-70)*60 = 1800s > 900s
    });

    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    const hint = state.activeHints.find((h) => h.type === "group_atmosphere");
    expect(hint).toBeTruthy();
    expect(hint?.message).toContain("FunGroup");
    expect(hint?.message).toContain("about 30 minutes");
  });

  it("私聊 → 不触发群聊氛围提示", () => {
    const state = freshState();
    const ctx = makeCtx(state, 100);
    ctx.graph.addChannel("channel:private", {
      chat_type: "private",
      unread: 15,
      last_alice_action_ms: BASE_MS + tickMs(50),
    });

    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    const hint = state.activeHints.find((h) => h.type === "group_atmosphere");
    expect(hint).toBeUndefined();
  });

  it("群聊不活跃（unread < 5） → 不生成提示", () => {
    const state = freshState();
    const ctx = makeCtx(state, 100);
    ctx.graph.addChannel("channel:quiet", {
      chat_type: "group",
      unread: 2,
      last_alice_action_ms: BASE_MS + tickMs(50),
    });

    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    const hint = state.activeHints.find((h) => h.type === "group_atmosphere");
    expect(hint).toBeUndefined();
  });
});

// -- 场景 5: 行为模式识别测试 ---------------------------------------------------

describe("strategy.mod — behavior_pattern", () => {
  it("同一 intent 重复 6+/10 次 → 生成提示", () => {
    const state = freshState();
    for (let i = 0; i < 7; i++) {
      state.recentActions.push({ target: `channel:${i}`, tick: i, intent: "greet" });
    }
    for (let i = 0; i < 3; i++) {
      state.recentActions.push({ target: `channel:${i}`, tick: 10 + i, intent: "reply" });
    }

    const ctx = makeCtx(state, 100);
    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    const hint = state.activeHints.find((h) => h.type === "behavior_pattern");
    expect(hint).toBeTruthy();
    expect(hint?.message).toContain("greet");
    expect(hint?.message).toContain("most of");
  });

  it("intent 分散 → 不生成提示", () => {
    const state = freshState();
    const intents = [
      "greet",
      "reply",
      "share",
      "ask",
      "observe",
      "joke",
      "help",
      "react",
      "ping",
      "wave",
    ];
    // tick 间隔不规律 → 不触发节奏检测 (CV > 0.3)
    const ticks = [0, 3, 5, 12, 14, 25, 27, 40, 41, 60];
    for (let i = 0; i < 10; i++) {
      state.recentActions.push({ target: `channel:${i}`, tick: ticks[i], intent: intents[i] });
    }

    const ctx = makeCtx(state, 100);
    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    const hint = state.activeHints.find((h) => h.type === "behavior_pattern");
    expect(hint).toBeUndefined();
  });

  it("行动不足 10 条 → 不触发模式检测", () => {
    const state = freshState();
    for (let i = 0; i < 5; i++) {
      state.recentActions.push({ target: "channel:telegram:1", tick: i, intent: "greet" });
    }

    const ctx = makeCtx(state, 100);
    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    const hint = state.activeHints.find((h) => h.type === "behavior_pattern");
    expect(hint).toBeUndefined();
  });
});

// -- 场景 1: 守夜人简报测试 -----------------------------------------------------

describe("strategy.mod — overnight_briefing", () => {
  it("Alice 静默 60+ ticks + 有累积消息 → 生成简报提示", () => {
    const state = freshState();
    // 最后一次行动在 tick 30
    state.recentActions.push({ target: "channel:telegram:1", tick: 30, intent: "reply" });

    const ctx = makeCtx(state, 100); // 静默 70 ticks > 60
    ctx.graph.addChannel("channel:morning", {
      unread: 8,
      pending_directed: 2,
    });

    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    const hint = state.activeHints.find((h) => h.type === "overnight_briefing");
    expect(hint).toBeTruthy();
    expect(hint?.message).toContain("about 1 hours");
    expect(hint?.message).toContain("a few messages");
    // W2 增强后格式改为 "@mention/reply"
    expect(hint?.message).toMatch(/a couple of (directed|@mention\/reply)/);
  });

  it("Alice 刚活跃（静默 < 60 ticks） → 不生成简报", () => {
    const state = freshState();
    state.recentActions.push({ target: "channel:telegram:1", tick: 80, intent: "reply" });

    const ctx = makeCtx(state, 100); // 静默 20 ticks < 60
    ctx.graph.addChannel("channel:active", { unread: 10 });

    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    const hint = state.activeHints.find((h) => h.type === "overnight_briefing");
    expect(hint).toBeUndefined();
  });

  it("静默但无累积消息 → 不生成简报", () => {
    const state = freshState();
    state.recentActions.push({ target: "channel:telegram:1", tick: 30, intent: "reply" });

    const ctx = makeCtx(state, 100); // 静默 70 ticks
    // 没有频道 → 没有 unread

    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    const hint = state.activeHints.find((h) => h.type === "overnight_briefing");
    expect(hint).toBeUndefined();
  });
});

// -- M2: extractKeywords 纯函数测试 -------------------------------------------

describe("extractKeywords", () => {
  it("提取英文关键词（排除 stop words）", () => {
    const kw = extractKeywords("The machine learning model is training");
    expect(kw).toContain("machine");
    expect(kw).toContain("learning");
    expect(kw).toContain("model");
    expect(kw).toContain("training");
    expect(kw).not.toContain("the");
    expect(kw).not.toContain("is");
  });

  it("提取中文关键词", () => {
    const kw = extractKeywords("今天讨论了机器学习的应用");
    expect(kw.length).toBeGreaterThan(0);
    // 应该提取出 2+ 字符的 CJK 片段
    const joined = kw.join(" ");
    expect(joined).toContain("今天");
  });

  it("空文本返回空数组", () => {
    expect(extractKeywords("")).toEqual([]);
    expect(extractKeywords("   ")).toEqual([]);
  });
});

// -- M2: 群聊 SEND_MESSAGE 追踪测试 -------------------------------------------

describe("strategy.mod — group chat tracking", () => {
  it("SEND_MESSAGE 追踪发言者", () => {
    const state = freshState();
    const ctx = makeCtx(state, 100);

    listen.SEND_MESSAGE(
      ctx as unknown as ModContext<StrategyState>,
      {
        chatId: "channel:group1",
        senderName: "Bob",
        text: "Hello everyone",
        isOutgoing: false,
      },
      undefined,
    );

    const gs = state.groupStates["channel:group1"];
    expect(gs).toBeDefined();
    expect(gs.recentSpeakers).toContain("Bob");
    expect(gs.totalMessages).toBe(1);
    expect(gs.aliceMessages).toBe(0);
  });

  it("SEND_MESSAGE 追踪 Alice 消息", () => {
    const state = freshState();
    const ctx = makeCtx(state, 100);

    listen.SEND_MESSAGE(
      ctx as unknown as ModContext<StrategyState>,
      {
        chatId: "channel:group1",
        senderName: "Alice",
        text: "Hi there",
        isOutgoing: true,
      },
      undefined,
    );

    const gs = state.groupStates["channel:group1"];
    expect(gs.aliceMessages).toBe(1);
    expect(gs.participationRatio).toBe(1); // 1/1 = 100%
  });

  it("参与率正确计算", () => {
    const state = freshState();
    const ctx = makeCtx(state, 100);

    // 3 条他人消息
    for (let i = 0; i < 3; i++) {
      listen.SEND_MESSAGE(
        ctx as unknown as ModContext<StrategyState>,
        {
          chatId: "channel:group1",
          senderName: `User${i}`,
          text: "msg",
          isOutgoing: false,
        },
        undefined,
      );
    }
    // 1 条 Alice 消息
    listen.SEND_MESSAGE(
      ctx as unknown as ModContext<StrategyState>,
      {
        chatId: "channel:group1",
        senderName: "Alice",
        text: "reply",
        isOutgoing: true,
      },
      undefined,
    );

    const gs = state.groupStates["channel:group1"];
    expect(gs.totalMessages).toBe(4);
    expect(gs.aliceMessages).toBe(1);
    expect(gs.participationRatio).toBeCloseTo(0.25, 4);
  });

  it("发言者环形缓冲去重 + 上限 10", () => {
    const state = freshState();
    const ctx = makeCtx(state, 100);

    // 12 个不同的发言者
    for (let i = 0; i < 12; i++) {
      listen.SEND_MESSAGE(
        ctx as unknown as ModContext<StrategyState>,
        {
          chatId: "channel:group1",
          senderName: `Speaker${i}`,
          text: "msg",
          isOutgoing: false,
        },
        undefined,
      );
    }

    const gs = state.groupStates["channel:group1"];
    expect(gs.recentSpeakers.length).toBeLessThanOrEqual(10);
    // 最早两个被淘汰
    expect(gs.recentSpeakers).not.toContain("Speaker0");
    expect(gs.recentSpeakers).not.toContain("Speaker1");
    expect(gs.recentSpeakers).toContain("Speaker11");
  });

  it("SEND_MESSAGE 提取关键词到 topicKeywords", () => {
    const state = freshState();
    const ctx = makeCtx(state, 100);

    listen.SEND_MESSAGE(
      ctx as unknown as ModContext<StrategyState>,
      {
        chatId: "channel:group1",
        senderName: "Bob",
        text: "Machine learning is fascinating",
        isOutgoing: false,
      },
      undefined,
    );

    const gs = state.groupStates["channel:group1"];
    expect(gs.topicKeywords.length).toBeGreaterThan(0);
    expect(gs.topicKeywords).toContain("machine");
  });
});

// -- M2: 话题漂移 + contribute 测试 -------------------------------------------

describe("strategy.mod — topic drift detection", () => {
  it("话题完全不同 → 不生成漂移提示（ADR-46 F2: Jaccard 检测已移除）", () => {
    // ADR-46 F2: Jaccard 在中文环境下 mean=0.016，100% 误报。
    // 已移除 Jaccard topic drift 检测，等 M3 LLM-based EST 分词。
    const state = freshState();
    state.groupStates["channel:drift"] = {
      recentSpeakers: ["Alice", "Bob"],
      topicKeywords: ["quantum", "physics", "entanglement", "photon", "experiment", "theory"],
      participationRatio: 0.3,
      totalMessages: 10,
      aliceMessages: 3,
    };

    const ctx = makeCtx(state, 200);
    ctx.graph.addChannel("channel:drift", {
      chat_type: "group",
      unread: 8,
      last_alice_action_ms: BASE_MS + tickMs(180),
      display_name: "SciGroup",
    });

    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    const shiftHint = state.activeHints.find(
      (h) => h.type === "group_atmosphere" && h.message.includes("Topic shift"),
    );
    // ADR-46: Jaccard 移除后不再生成 topic shift 提示
    expect(shiftHint).toBeUndefined();
  });

  it("话题高度重叠 (Jaccard >= 0.3) → 不生成漂移提示", () => {
    const state = freshState();
    state.groupStates["channel:stable"] = {
      recentSpeakers: ["Alice"],
      topicKeywords: ["machine", "learning", "data", "model", "training", "neural"],
      participationRatio: 0.5,
      totalMessages: 10,
      aliceMessages: 5,
    };

    const ctx = makeCtx(state, 200);
    ctx.graph.addChannel("channel:stable", {
      chat_type: "group",
      unread: 8,
      last_alice_action_ms: BASE_MS + tickMs(180),
      display_name: "MLGroup",
    });

    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    const shiftHint = state.activeHints.find(
      (h) => h.type === "group_atmosphere" && h.message.includes("Topic shift"),
    );
    expect(shiftHint).toBeUndefined();
  });
});

describe("strategy.mod — M2 group-dynamics contribute", () => {
  it("活跃群聊注入 group-dynamics section", () => {
    const state = freshState();
    state.groupStates["channel:active"] = {
      recentSpeakers: ["Alice", "Bob", "Carol"],
      topicKeywords: ["typescript", "testing"],
      participationRatio: 0.4,
      totalMessages: 10,
      aliceMessages: 4,
    };
    state.recentActions = [
      { target: "a", tick: 1, intent: "" },
      { target: "b", tick: 2, intent: "" },
      { target: "c", tick: 3, intent: "" },
    ];

    const ctx = makeCtx(state, 100);
    ctx.graph.addChannel("channel:active", { display_name: "ActiveGroup" });
    const items = contribute(ctx as unknown as ModContext<StrategyState>);
    const groupItem = items.find((i) => i.key?.startsWith("group-dynamics-"));
    expect(groupItem).toBeTruthy();
    const content = JSON.stringify(groupItem);
    expect(content).toContain("Alice");
    expect(content).toContain("You've been somewhat active");
    // display_name 解析——不暴露 raw channelId
    expect(content).toContain("ActiveGroup (group):");
    // ADR-83 D7: topicKeywords 不再注入（改用图中 LLM 生成的 topic）
    expect(content).not.toContain("typescript");
  });

  it("低活跃群 (totalMessages < 3) → 不注入", () => {
    const state = freshState();
    state.groupStates["channel:quiet"] = {
      recentSpeakers: ["Bob"],
      topicKeywords: ["hello"],
      participationRatio: 0,
      totalMessages: 2,
      aliceMessages: 0,
    };

    const ctx = makeCtx(state, 100);
    const items = contribute(ctx as unknown as ModContext<StrategyState>);
    const groupItem = items.find((i) => i.key?.startsWith("group-dynamics-"));
    expect(groupItem).toBeUndefined();
  });
});

// -- M4: 人格漂移审计测试 -------------------------------------------------------

describe("strategy.mod — personality drift audit", () => {
  it("常量: DRIFT_WARNING_THRESHOLD < DRIFT_ALERT_THRESHOLD", () => {
    expect(DRIFT_WARNING_THRESHOLD).toBeLessThan(DRIFT_ALERT_THRESHOLD);
    expect(DRIFT_AUDIT_INTERVAL).toBeGreaterThan(0);
  });

  it("tick 非 DRIFT_AUDIT_INTERVAL 整数倍时不审计", () => {
    const state = freshState();
    const ctx = makeCtx(state, DRIFT_AUDIT_INTERVAL + 1);
    ctx.graph.addAgent("self");
    ctx.graph.setDynamic("self", "personality_weights", JSON.stringify([0.4, 0.1, 0.2, 0.2, 0.1]));
    ctx.graph.setDynamic("self", "pi_home", JSON.stringify([0.2, 0.2, 0.2, 0.2, 0.2]));

    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    expect(state.personalityDrift.lastAuditTick).toBe(0);
  });

  it("tick=0 时不审计", () => {
    const state = freshState();
    const ctx = makeCtx(state, 0);
    ctx.graph.addAgent("self");

    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    expect(state.personalityDrift.lastAuditTick).toBe(0);
  });

  it("轻微漂移 → healthy", () => {
    const state = freshState();
    const ctx = makeCtx(state, DRIFT_AUDIT_INTERVAL);
    ctx.graph.addAgent("self");
    // ADR-81: 4 维。微小偏移: [0.26, 0.24, 0.26, 0.24] vs home [0.25, 0.25, 0.25, 0.25]
    // l2 = sqrt(0.01^2 * 4) = 0.02 → healthy
    ctx.graph.setDynamic("self", "personality_weights", JSON.stringify([0.26, 0.24, 0.26, 0.24]));
    ctx.graph.setDynamic("self", "pi_home", JSON.stringify([0.25, 0.25, 0.25, 0.25]));

    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    expect(state.personalityDrift.health).toBe("healthy");
    expect(state.personalityDrift.drift).toBeLessThan(DRIFT_WARNING_THRESHOLD);
    expect(state.personalityDrift.lastAuditTick).toBe(DRIFT_AUDIT_INTERVAL);
    // healthy → 不生成 hint
    const hint = state.activeHints.find((h) => h.type === "personality_drift");
    expect(hint).toBeUndefined();
  });

  it("中等漂移 → warning", () => {
    const state = freshState();
    const ctx = makeCtx(state, DRIFT_AUDIT_INTERVAL);
    ctx.graph.addAgent("self");
    // ADR-81: 4 维。需要 l2Distance >= 0.1 (WARNING) 且 < 0.15 (ALERT)
    // [0.33, 0.19, 0.25, 0.23] vs [0.25, 0.25, 0.25, 0.25]
    // l2 = sqrt(0.08^2 + 0.06^2 + 0 + 0.02^2) = sqrt(0.0064+0.0036+0+0.0004) = sqrt(0.0104) ≈ 0.102
    ctx.graph.setDynamic("self", "personality_weights", JSON.stringify([0.33, 0.19, 0.25, 0.23]));
    ctx.graph.setDynamic("self", "pi_home", JSON.stringify([0.25, 0.25, 0.25, 0.25]));

    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    expect(state.personalityDrift.health).toBe("warning");
    expect(state.personalityDrift.drift).toBeGreaterThanOrEqual(DRIFT_WARNING_THRESHOLD);
    expect(state.personalityDrift.drift).toBeLessThan(DRIFT_ALERT_THRESHOLD);
    const hint = state.activeHints.find((h) => h.type === "personality_drift");
    expect(hint).toBeTruthy();
    expect(hint?.message).toContain("drifted slightly");
  });

  it("大幅漂移 → alert", () => {
    const state = freshState();
    const ctx = makeCtx(state, DRIFT_AUDIT_INTERVAL);
    ctx.graph.addAgent("self");
    // ADR-81: 4 维。需要 l2Distance >= 0.15
    // [0.5, 0.1, 0.2, 0.2] vs [0.25, 0.25, 0.25, 0.25]
    // l2 = sqrt(0.25^2 + 0.15^2 + 0.05^2 + 0.05^2) = sqrt(0.0625+0.0225+0.0025+0.0025) = sqrt(0.09) = 0.3
    ctx.graph.setDynamic("self", "personality_weights", JSON.stringify([0.5, 0.1, 0.2, 0.2]));
    ctx.graph.setDynamic("self", "pi_home", JSON.stringify([0.25, 0.25, 0.25, 0.25]));

    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    expect(state.personalityDrift.health).toBe("alert");
    expect(state.personalityDrift.drift).toBeGreaterThanOrEqual(DRIFT_ALERT_THRESHOLD);
    const hint = state.activeHints.find((h) => h.type === "personality_drift");
    expect(hint).toBeTruthy();
    expect(hint?.message).toContain("shifted significantly");
    // 写入图属性
    expect(ctx.graph.getAgent("self").personality_health).toBe("alert");
  });

  it("velocity 正确计算 (两次审计之间)", () => {
    const state = freshState();
    // ADR-81: 4 维。模拟第一次审计
    state.personalityDrift = {
      lastAuditTick: DRIFT_AUDIT_INTERVAL,
      previousWeights: [0.25, 0.25, 0.25, 0.25],
      drift: 0,
      velocity: 0,
      health: "healthy",
    };

    const ctx = makeCtx(state, DRIFT_AUDIT_INTERVAL * 2);
    ctx.graph.addAgent("self");
    // 第二次审计时人格有变化
    ctx.graph.setDynamic("self", "personality_weights", JSON.stringify([0.3, 0.22, 0.25, 0.23]));
    ctx.graph.setDynamic("self", "pi_home", JSON.stringify([0.25, 0.25, 0.25, 0.25]));

    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    // velocity = l2Distance([0.30,0.22,0.25,0.23], [0.25,0.25,0.25,0.25]) / 100
    // = sqrt(0.05^2 + 0.03^2 + 0 + 0.02^2) / 100 = sqrt(0.0038) / 100 ≈ 0.000616
    expect(state.personalityDrift.velocity).toBeGreaterThan(0);
    expect(state.personalityDrift.previousWeights).toEqual([0.3, 0.22, 0.25, 0.23]);
  });

  it("无 self 节点时不审计", () => {
    const state = freshState();
    const ctx = makeCtx(state, DRIFT_AUDIT_INTERVAL);
    // 不添加 self 节点

    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    expect(state.personalityDrift.lastAuditTick).toBe(0);
  });

  it("contribute 注入 personality-drift section", () => {
    const state = freshState();
    state.personalityDrift = {
      lastAuditTick: 100,
      previousWeights: [0.2, 0.2, 0.2, 0.2, 0.2],
      drift: 0.15,
      velocity: 0.001,
      health: "warning",
    };
    state.recentActions = [
      { target: "a", tick: 1, intent: "" },
      { target: "b", tick: 2, intent: "" },
      { target: "c", tick: 3, intent: "" },
    ];

    const ctx = makeCtx(state, 200);
    const items = contribute(ctx as unknown as ModContext<StrategyState>);

    // 人格漂移审计不再注入 LLM 可见 prompt（内部监控行为）
    const driftItem = items.find((i) => i.key === "personality-drift");
    expect(driftItem).toBeUndefined();
  });
});

// -- M4: 行为模式增强测试 -------------------------------------------------------

describe("strategy.mod — enhanced behavior patterns", () => {
  it("8b: 节奏模式检测 — 高度规律的行动间隔", () => {
    const state = freshState();
    // 每 10 tick 一次行动 → CV 接近 0 → 规律
    for (let i = 0; i < 10; i++) {
      state.recentActions.push({ target: `channel:${i}`, tick: i * 10, intent: "reply" });
    }

    const ctx = makeCtx(state, 100);
    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    const rhythmHint = state.activeHints.find(
      (h) => h.type === "behavior_pattern" && h.message.includes("Rhythmic"),
    );
    expect(rhythmHint).toBeTruthy();
    expect(rhythmHint?.message).toContain("about 10 minutes");
  });

  it("8b: 不规律间隔 → 不生成节奏提示", () => {
    const state = freshState();
    // 随机间隔
    const ticks = [0, 3, 15, 18, 40, 42, 60, 63, 90, 91];
    for (let i = 0; i < 10; i++) {
      state.recentActions.push({ target: `channel:${i}`, tick: ticks[i], intent: "reply" });
    }

    const ctx = makeCtx(state, 100);
    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    const rhythmHint = state.activeHints.find(
      (h) => h.type === "behavior_pattern" && h.message.includes("Rhythmic"),
    );
    expect(rhythmHint).toBeUndefined();
  });

  it("8c: 跨联系人重复 — 同一 intent 对 3+ 不同目标", () => {
    const state = freshState();
    for (let i = 0; i < 10; i++) {
      state.recentActions.push({
        target: `channel:${i}`,
        tick: i,
        intent: i < 5 ? "greet" : "reply",
      });
    }

    const ctx = makeCtx(state, 100);
    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    const formulaicHint = state.activeHints.find(
      (h) => h.type === "behavior_pattern" && h.message.includes("Same approach"),
    );
    expect(formulaicHint).toBeTruthy();
    expect(formulaicHint?.message).toContain("greet");
    expect(formulaicHint?.message).toContain("5");
  });

  it("8c: 同一 intent 对 < 3 目标 → 不生成 formulaic 提示", () => {
    const state = freshState();
    for (let i = 0; i < 10; i++) {
      state.recentActions.push({
        target: i < 2 ? `channel:${i}` : `channel:${i}`,
        tick: i,
        intent: i < 2 ? "greet" : `intent_${i}`,
      });
    }

    const ctx = makeCtx(state, 100);
    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    const formulaicHint = state.activeHints.find(
      (h) => h.type === "behavior_pattern" && h.message.includes("Formulaic"),
    );
    expect(formulaicHint).toBeUndefined();
  });
});

// -- G7: participation_ratio 图属性暴露测试 ------------------------------------

describe("strategy.mod — G7 participation_ratio 图属性", () => {
  it("onTickEnd 将 participationRatio 写入图属性", () => {
    const state = freshState();
    state.groupStates["channel:group1"] = {
      recentSpeakers: ["Alice", "Bob"],
      topicKeywords: [],
      participationRatio: 0.3,
      totalMessages: 10,
      aliceMessages: 3,
    };

    const ctx = makeCtx(state, 100);
    ctx.graph.addChannel("channel:group1", { chat_type: "group" });

    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    const attrs = ctx.graph.getChannel("channel:group1");
    expect(attrs.participation_ratio).toBeCloseTo(0.3, 4);
  });

  it("频道不在图中 → 不崩溃", () => {
    const state = freshState();
    state.groupStates["channel:ghost"] = {
      recentSpeakers: [],
      topicKeywords: [],
      participationRatio: 0.5,
      totalMessages: 5,
      aliceMessages: 2,
    };

    const ctx = makeCtx(state, 100);
    // channel:ghost 不在图中

    // 不应抛异常
    onTickEnd(ctx as unknown as ModContext<StrategyState>);
  });
});

// -- Bot 工具感知测试 ----------------------------------------------------------

describe("strategy.mod — bot 工具感知", () => {
  it("is_bot=true 的联系人（有 tier）→ 生成工具提示", () => {
    const state = freshState();
    const ctx = makeCtx(state, 100);
    ctx.graph.addContact("contact:bot", {
      display_name: "TranslateBot",
      is_bot: true,
      tier: 500,
      last_active_ms: ctx.nowMs, // ADR-196 F5: 需要近期活跃才生成 hint
    });

    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    const hint = state.activeHints.find(
      (h) => h.type === "opportunity" && h.message.includes("bot"),
    );
    expect(hint).toBeTruthy();
    expect(hint?.message).toContain("TranslateBot");
    expect(hint?.message).toContain("tool");
  });

  it("is_bot=true 无 tier → 仍生成工具提示", () => {
    const state = freshState();
    const ctx = makeCtx(state, 100);
    ctx.graph.addContact("contact:bot2", {
      display_name: "UnknownBot",
      is_bot: true,
      last_active_ms: ctx.nowMs, // ADR-196 F5: 需要近期活跃才生成 hint
    });

    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    const hint = state.activeHints.find(
      (h) => h.type === "opportunity" && h.message.includes("bot"),
    );
    expect(hint).toBeTruthy();
    expect(hint?.message).toContain("UnknownBot");
  });

  it("普通联系人 → 不生成 bot 提示", () => {
    const state = freshState();
    const ctx = makeCtx(state, 100);
    ctx.graph.addContact("contact:human", {
      display_name: "Alice",
      tier: 50,
    });

    onTickEnd(ctx as unknown as ModContext<StrategyState>);

    const hint = state.activeHints.find(
      (h) => h.type === "opportunity" && h.message.includes("bot"),
    );
    expect(hint).toBeUndefined();
  });
});

// -- ADR-47 G8: 承诺上下文关联触发 -----------------------------------------------

describe("strategy.mod — G8 contextual_commitment", () => {
  it("目标联系人关联活跃 thread → contextual_commitment hint", () => {
    const state = freshState();
    state.recentActions = [
      { target: "a", tick: 1, intent: "" },
      { target: "b", tick: 2, intent: "" },
      { target: "c", tick: 3, intent: "" },
    ];

    const ctx = makeCtx(state, 100);
    // 设置 relationships mod 的 targetNodeId
    ctx.getModState = ((name: string) => {
      if (name === "relationships") return { targetNodeId: "channel:telegram:123" };
      return undefined;
    }) as typeof ctx.getModState;

    // 创建 thread 实体，involves contact:telegram:123
    ctx.graph.addThread("thread_1", {
      status: "open",
      title: "Help with project",
    });
    ctx.graph.addContact("contact:telegram:123", { tier: 50 });
    ctx.graph.addRelation("thread_1", "involves", "contact:telegram:123");

    const items = contribute(ctx as unknown as ModContext<StrategyState>);
    const hints = items.find((i) => i.key === "strategy-hints");
    expect(hints).toBeTruthy();
    const content = JSON.stringify(hints);
    expect(content).toContain("Help with project");
    expect(content).toContain("active commitment");
  });

  it("目标联系人无关联 thread → 无 contextual_commitment hint", () => {
    const state = freshState();
    state.recentActions = [
      { target: "a", tick: 1, intent: "" },
      { target: "b", tick: 2, intent: "" },
      { target: "c", tick: 3, intent: "" },
    ];

    const ctx = makeCtx(state, 100);
    ctx.getModState = ((name: string) => {
      if (name === "relationships") return { targetNodeId: "channel:telegram:123" };
      return undefined;
    }) as typeof ctx.getModState;

    // thread involves 另一个联系人
    ctx.graph.addThread("thread_1", {
      status: "open",
      title: "Unrelated thread",
    });
    ctx.graph.addContact("contact:telegram:456", { tier: 50 });
    ctx.graph.addRelation("thread_1", "involves", "contact:telegram:456");

    const items = contribute(ctx as unknown as ModContext<StrategyState>);
    const content = JSON.stringify(items);
    expect(content).not.toContain("active commitment");
  });

  it("thread 已 resolved → 不触发", () => {
    const state = freshState();
    state.recentActions = [
      { target: "a", tick: 1, intent: "" },
      { target: "b", tick: 2, intent: "" },
      { target: "c", tick: 3, intent: "" },
    ];

    const ctx = makeCtx(state, 100);
    ctx.getModState = ((name: string) => {
      if (name === "relationships") return { targetNodeId: "channel:telegram:123" };
      return undefined;
    }) as typeof ctx.getModState;

    ctx.graph.addThread("thread_1", {
      status: "resolved",
      title: "Done thread",
    });
    ctx.graph.addContact("contact:telegram:123", { tier: 50 });
    ctx.graph.addRelation("thread_1", "involves", "contact:telegram:123");

    const items = contribute(ctx as unknown as ModContext<StrategyState>);
    const content = JSON.stringify(items);
    expect(content).not.toContain("active commitment");
  });

  it("无 actionTarget 时不触发", () => {
    const state = freshState();
    const ctx = makeCtx(state, 100);
    // getModState 默认返回 undefined → 无 actionTarget
    ctx.graph.addThread("thread_1", {
      status: "open",
      title: "Some thread",
    });

    const items = contribute(ctx as unknown as ModContext<StrategyState>);
    const content = JSON.stringify(items);
    expect(content).not.toContain("active commitment");
  });
});
