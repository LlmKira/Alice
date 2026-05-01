/**
 * ADR-64 V-1 + V-3 测试 — 外部反馈锚 + Growth 保底。
 *
 * ADR-110: 全部使用 ms 时间戳。computeExternalFeedback(G, target, actionMs, nowMs)。
 * 无回复判定阈值 = 600 秒 = 600_000 ms。
 */
import { describe, expect, it } from "vitest";
import type { ModContext } from "../src/core/types.js";
import { WorldModel } from "../src/graph/world-model.js";
import { computeExternalFeedback } from "../src/mods/observer/external-feedback.js";
import { observerMod } from "../src/mods/observer.mod.js";

// biome-ignore lint/style/noNonNullAssertion: test — instructions 已知存在
const instructions = observerMod.instructions!;

/** ADR-110: 固定基准墙钟时间。 */
const BASE_MS = 1_000_000_000;

/** 创建简单的 ModContext mock。 */
function makeCtx<T>(state: T, tick = 100): ModContext<T> & { graph: WorldModel } {
  const graph = new WorldModel();
  graph.tick = tick;
  return {
    graph,
    state,
    tick,
    nowMs: BASE_MS,
    getModState: () => undefined,
    dispatch: () => undefined,
  };
}

// ── computeExternalFeedback 单元测试 ────────────────────────────────────

describe("computeExternalFeedback", () => {
  it("对方回复后 → 正分数 + replied 信号", () => {
    const G = new WorldModel();
    const actionMs = BASE_MS;
    const nowMs = BASE_MS + 300_000; // 300s later
    G.addContact("contact:telegram:123", { tier: 50, last_active_ms: BASE_MS + 200_000 });
    G.addChannel("channel:telegram:123");

    const result = computeExternalFeedback(G, "contact:telegram:123", actionMs, nowMs);
    expect(result.signals).toContain("replied");
    expect(result.score).toBeGreaterThan(0);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("超过 600 秒无回复 → 负分数 + no_reply 信号", () => {
    const G = new WorldModel();
    const actionMs = BASE_MS;
    const nowMs = BASE_MS + 700_000; // 700s > 600s threshold
    G.addContact("contact:telegram:123", { tier: 50, last_active_ms: BASE_MS - 100_000 });
    G.addChannel("channel:telegram:123");

    const result = computeExternalFeedback(G, "contact:telegram:123", actionMs, nowMs);
    expect(result.signals).toContain("no_reply");
    expect(result.score).toBeLessThan(0);
  });

  it("不到 600 秒无回复 → 不计入（还在等）", () => {
    const G = new WorldModel();
    const actionMs = BASE_MS;
    const nowMs = BASE_MS + 300_000; // 300s < 600s
    G.addContact("contact:telegram:123", { tier: 50, last_active_ms: BASE_MS - 100_000 });
    G.addChannel("channel:telegram:123");

    const result = computeExternalFeedback(G, "contact:telegram:123", actionMs, nowMs);
    // 没有 reply 和 no_reply 信号（还在等）
    expect(result.signals).not.toContain("replied");
    expect(result.signals).not.toContain("no_reply");
  });

  it("收到 reaction → 正信号", () => {
    const G = new WorldModel();
    const actionMs = BASE_MS;
    const nowMs = BASE_MS + 300_000;
    G.addContact("contact:telegram:123", {
      tier: 50,
      last_active_ms: BASE_MS + 200_000,
      last_reaction_ms: BASE_MS + 150_000,
    });
    G.addChannel("channel:telegram:123");

    const result = computeExternalFeedback(G, "contact:telegram:123", actionMs, nowMs);
    expect(result.signals).toContain("replied");
    expect(result.signals).toContain("reaction");
    expect(result.score).toBeGreaterThan(0);
  });

  it("对话活跃 → 正信号", () => {
    const G = new WorldModel();
    const actionMs = BASE_MS;
    const nowMs = BASE_MS + 300_000;
    G.addContact("contact:telegram:123", { tier: 50, last_active_ms: BASE_MS + 200_000 });
    G.addChannel("channel:telegram:123");
    G.addConversation("conversation:1", {
      channel: "channel:telegram:123",
      participants: ["contact:telegram:123"],
      state: "active",
      start_ms: BASE_MS - 300_000,
      last_activity_ms: BASE_MS + 200_000,
      turn_state: "other_turn",
      pace: 1,
      message_count: 5,
      alice_message_count: 2,
    });

    const result = computeExternalFeedback(G, "contact:telegram:123", actionMs, nowMs);
    expect(result.signals).toContain("conversation_active");
  });

  it("对话关闭中 → 负信号", () => {
    const G = new WorldModel();
    const actionMs = BASE_MS;
    const nowMs = BASE_MS + 700_000; // > 600s for no_reply
    G.addContact("contact:telegram:123", { tier: 50, last_active_ms: BASE_MS - 600_000 });
    G.addChannel("channel:telegram:123");
    G.addConversation("conversation:1", {
      channel: "channel:telegram:123",
      participants: ["contact:telegram:123"],
      state: "closing",
      start_ms: BASE_MS - 1200_000,
      last_activity_ms: BASE_MS - 600_000,
      turn_state: "open",
      pace: 1,
      message_count: 3,
      alice_message_count: 2,
    });

    const result = computeExternalFeedback(G, "contact:telegram:123", actionMs, nowMs);
    expect(result.signals).toContain("conversation_ending");
  });

  it("有 pending_directed → 正信号", () => {
    const G = new WorldModel();
    const actionMs = BASE_MS;
    const nowMs = BASE_MS + 300_000;
    G.addContact("contact:telegram:123", { tier: 50, last_active_ms: BASE_MS + 200_000 });
    G.addChannel("channel:telegram:123", { pending_directed: 2 });

    const result = computeExternalFeedback(G, "contact:telegram:123", actionMs, nowMs);
    expect(result.signals).toContain("directed_message");
  });

  it("所有正信号 → confidence = 1.0", () => {
    const G = new WorldModel();
    const actionMs = BASE_MS;
    const nowMs = BASE_MS + 300_000;
    G.addContact("contact:telegram:123", {
      tier: 50,
      last_active_ms: BASE_MS + 200_000,
      last_reaction_ms: BASE_MS + 150_000,
    });
    G.addChannel("channel:telegram:123", { pending_directed: 1 });
    G.addConversation("conversation:1", {
      channel: "channel:telegram:123",
      participants: ["contact:telegram:123"],
      state: "active",
      start_ms: BASE_MS - 300_000,
      last_activity_ms: BASE_MS + 200_000,
      turn_state: "other_turn",
      pace: 1,
      message_count: 5,
      alice_message_count: 2,
    });

    const result = computeExternalFeedback(G, "contact:telegram:123", actionMs, nowMs);
    expect(result.confidence).toBe(1.0);
    expect(result.signals).toHaveLength(4);
    expect(result.score).toBeGreaterThan(0.5);
  });

  it("无任何信号 → score=0, confidence=0", () => {
    const G = new WorldModel();
    // target 不存在
    const result = computeExternalFeedback(G, "contact:telegram:999", BASE_MS, BASE_MS + 300_000);
    expect(result.score).toBe(0);
    expect(result.confidence).toBe(0);
    expect(result.signals).toHaveLength(0);
  });

  it("channel: 前缀的 target 也能解析 contact", () => {
    const G = new WorldModel();
    const actionMs = BASE_MS;
    const nowMs = BASE_MS + 300_000;
    G.addContact("contact:telegram:456", { tier: 50, last_active_ms: BASE_MS + 200_000 });
    G.addChannel("channel:telegram:456");

    const result = computeExternalFeedback(G, "channel:telegram:456", actionMs, nowMs);
    expect(result.signals).toContain("replied");
  });
});

// ── rate_outcome 外部反馈融合测试 ──────────────────────────────────────

describe("rate_outcome — V-1 外部反馈融合", () => {
  it("对方回复时 LLM 自评被稀释（α=0.4）", () => {
    const ctx = makeCtx({ outcomeHistory: [] as unknown[] });
    ctx.nowMs = BASE_MS + 300_000; // 300s after action
    const G = ctx.graph;
    G.addContact("contact:telegram:123", { tier: 50, last_active_ms: BASE_MS + 200_000 });
    G.addChannel("channel:telegram:123");
    // 创建活跃对话增加 confidence
    G.addConversation("conversation:1", {
      channel: "channel:telegram:123",
      participants: ["contact:telegram:123"],
      state: "active",
      start_ms: BASE_MS - 600_000,
      last_activity_ms: BASE_MS + 200_000,
      turn_state: "other_turn",
      pace: 1,
      message_count: 5,
      alice_message_count: 2,
    });

    const impl = instructions.rate_outcome.impl;
    const result = impl(ctx as unknown as ModContext, {
      target: "contact:telegram:123",
      action_ms: BASE_MS,
      quality: "excellent",
      reason: "good response",
    }) as {
      success: boolean;
      quality: number;
      alpha: number;
      externalConfidence: number;
      externalSignals: string[];
    };

    expect(result.success).toBe(true);
    // 有 2+ 信号 → confidence > 0.3 → α=0.4
    expect(result.alpha).toBe(0.4);
    expect(result.externalConfidence).toBeGreaterThan(0.3);
    // quality 不应再等于纯自评（QUALITY_MAP["excellent"]=0.9 * 0.8 = 0.72, α=0.8 时 0.576）
    expect(result.quality).not.toBeCloseTo(0.576, 5);
    // 外部分数为正 → 最终 quality > 0（positive bias）
    expect(result.quality).toBeGreaterThan(0);
  });

  it("无外部信号时 LLM 自评权重保持高（α=0.8）", () => {
    const ctx = makeCtx({ outcomeHistory: [] as unknown[] });
    ctx.nowMs = BASE_MS + 300_000;
    ctx.graph.addContact("target_999", { tier: 150 });

    const impl = instructions.rate_outcome.impl;
    const result = impl(ctx as unknown as ModContext, {
      target: "target_999",
      action_ms: BASE_MS,
      quality: "good",
    }) as {
      success: boolean;
      quality: number;
      alpha: number;
      externalConfidence: number;
    };

    expect(result.success).toBe(true);
    // 无外部信号 → confidence = 0 → α=0.8
    expect(result.alpha).toBe(0.8);
    expect(result.externalConfidence).toBe(0);
    // quality ≈ 0.8 * (QUALITY_MAP["good"]=0.5 * 0.8) + 0.2 * 0 = 0.32
    expect(result.quality).toBeCloseTo(0.32, 5);
  });

  it("外部负反馈拉低过高的 LLM 自评", () => {
    const actionMs = BASE_MS;
    const nowMs = BASE_MS + 700_000; // 700s > 600s → no_reply threshold
    const ctx = makeCtx({ outcomeHistory: [] as unknown[] }, 120);
    ctx.nowMs = nowMs;
    const G = ctx.graph;
    // 对方没回复（last_active_ms 在 actionMs 之前），对话 closing
    G.addContact("contact:telegram:789", { tier: 50, last_active_ms: BASE_MS - 1200_000 });
    G.addChannel("channel:telegram:789");
    G.addConversation("conversation:1", {
      channel: "channel:telegram:789",
      participants: ["contact:telegram:789"],
      state: "closing",
      start_ms: BASE_MS - 3000_000,
      last_activity_ms: BASE_MS - 1200_000,
      turn_state: "open",
      pace: 1,
      message_count: 3,
      alice_message_count: 2,
    });

    const impl = instructions.rate_outcome.impl;
    const result = impl(ctx as unknown as ModContext, {
      target: "contact:telegram:789",
      action_ms: actionMs,
      quality: "excellent", // LLM 自评最高
    }) as {
      success: boolean;
      quality: number;
      externalScore: number;
      alpha: number;
    };

    expect(result.success).toBe(true);
    expect(result.externalScore).toBeLessThan(0); // 外部负反馈
    // 最终 quality 应低于纯自评 (QUALITY_MAP["excellent"]=0.9 * 0.8 = 0.72)
    expect(result.quality).toBeLessThan(0.72);
  });
});
