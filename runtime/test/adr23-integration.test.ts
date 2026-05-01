/**
 * ADR-23 集成测试 — 验证全管线正确性和 v4 退化保证。
 *
 * ADR-214 Wave B: ScriptExecutionResult 替代 ExecutableResult。
 * shell-native 下 extractBeatFeedback 始终返回 null，
 * 但 BEAT_FEEDBACK_MAP 映射仍有效（直接测试 MAP 而非通过 ExecutableResult）。
 */
import { describe, expect, it } from "vitest";
import type { ScriptExecutionResult } from "../src/core/script-execution.js";
import type { ModContext } from "../src/core/types.js";
import { THREAD_WEIGHTS } from "../src/graph/constants.js";
import { WorldModel } from "../src/graph/world-model.js";
import { observerMod } from "../src/mods/observer.mod.js";
import { computeAllPressures } from "../src/pressure/aggregate.js";
import { pProspect } from "../src/pressure/p-prospect.js";
import { p1AttentionDebt } from "../src/pressure/p1-attention.js";
import { BEAT_FEEDBACK_MAP, extractBeatFeedback } from "../src/voices/beat-feedback.js";

/** 测试用 tick→ms 转换（约定：1 tick = 60s）。 */
function tickMs(tick: number): number {
  return tick * 60_000;
}

// -- 辅助 -------------------------------------------------------------------

function makeCtx(state: unknown, tick = 100): ModContext & { graph: WorldModel } {
  const graph = new WorldModel();
  graph.tick = tick;
  return {
    graph,
    state,
    tick,
    nowMs: Date.now(),
    getModState: () => undefined,
    dispatch: () => undefined,
  };
}

function buildV4Graph(): WorldModel {
  const G = new WorldModel();
  G.tick = 100;
  G.addAgent("self");
  G.addContact("alice", { tier: 5, last_active_ms: tickMs(95) });
  G.addContact("bob", { tier: 50, last_active_ms: tickMs(60) });
  G.addChannel("channel:alice", {
    unread: 5,
    tier_contact: 5,
    chat_type: "private",
    pending_directed: 2,
    last_directed_ms: tickMs(98),
    last_incoming_ms: tickMs(100),
  });
  G.addChannel("channel:group", {
    unread: 10,
    tier_contact: 150,
    chat_type: "group",
    pending_directed: 0,
    last_incoming_ms: tickMs(100),
  });
  G.addThread("t_urgent", {
    weight: "major",
    status: "open",
    created_ms: tickMs(90),
    deadline: 110,
    deadline_ms: tickMs(110),
  });
  G.addThread("t_minor", {
    weight: "minor",
    status: "open",
    created_ms: tickMs(50),
    deadline: Infinity,
  });
  G.addFact("i1", {
    importance: 0.8,
    stability: 2.0,
    last_access_ms: tickMs(90),
    volatility: 0.3,
    tracked: true,
    created_ms: tickMs(80),
    novelty: 0.7,
  });
  G.addFact("i2", {
    importance: 0.5,
    stability: 1.0,
    last_access_ms: tickMs(50),
    novelty: 0.2,
  });
  G.addRelation("self", "friend", "alice");
  G.addRelation("self", "acquaintance", "bob");
  G.addRelation("self", "monitors", "channel:alice");
  G.addRelation("self", "monitors", "channel:group");
  G.addRelation("alice", "joined", "channel:alice");
  G.addRelation("bob", "joined", "channel:group");
  G.addRelation("t_urgent", "involves", "alice");
  G.addRelation("i1", "from", "channel:alice");
  return G;
}

function makeResult(completedActions: string[] = []): ScriptExecutionResult {
  return {
    logs: [],
    errors: [],
    instructionErrors: [],
    errorCodes: [],
    duration: 0,
    thinks: [],
    queryLogs: [],
    observations: [],
    completedActions,
    silenceReason: null,
  };
}

// -- v4 退化测试 --------------------------------------------------------------

describe("v4 退化保证", () => {
  it("无 LLM 标注时 P_prospect = 0 for 无 horizon 线程", () => {
    const G = new WorldModel();
    G.addThread("t1", {
      weight: "minor",
      status: "open",
      created_ms: 0,
      deadline: Infinity,
    });
    const result = pProspect(G, 100, tickMs(100));
    expect(result.total).toBe(0);
  });

  it("无 activity_relevance 时 P1 不变", () => {
    const G = buildV4Graph();
    const r1 = p1AttentionDebt(G, tickMs(100));
    // "channel:alice": 5 * 5.0 * 3.0 = 75, "channel:group": 10 * 0.8 * 1.0 = 8
    expect(r1.total).toBeCloseTo(83.0, 6);
  });

  it("无 Beat 时 extractBeatFeedback 返回 null（v4 退化）", () => {
    // shell-native: extractBeatFeedback 始终返回 null
    const result = makeResult(["sent:chatId=123:msgId=1"]);
    expect(extractBeatFeedback(result)).toBeNull();
  });
});

// -- 全管线测试 ---------------------------------------------------------------

describe("ADR-23 全管线", () => {
  it("feel → flag_risk → 图属性正确写入", () => {
    const ctx = makeCtx({ outcomeHistory: [] });
    ctx.graph.addChannel("channel:1");

    const moodImpl = observerMod.instructions?.feel.impl;
    moodImpl?.(ctx as unknown as ModContext, {
      target: "channel:1",
      valence: "negative",
      arousal: "intense",
      reason: "frustrated",
    });

    const attrs1 = ctx.graph.getChannel("channel:1");
    expect(attrs1.mood_valence).toBe(-0.4);
    expect(ctx.graph.getDynamic("channel:1", "mood_arousal")).toBe(0.9);
    expect(attrs1.mood_shift).toBe("frustrated");

    const riskImpl = observerMod.instructions?.flag_risk.impl;
    riskImpl?.(ctx as unknown as ModContext, {
      chatId: "channel:1",
      level: "high",
      reason: "user seems angry",
    });

    const attrs2 = ctx.graph.getChannel("channel:1");
    expect(attrs2.risk_level).toBe("high");
    expect(attrs2.risk_reason).toBe("user seems angry");
  });

  it("observe_activity 设置 relevance → P1 调制", () => {
    const nowMs = Date.now();
    const G = new WorldModel();
    G.addChannel("channel:test", {
      unread: 10,
      tier_contact: 50,
      chat_type: "group",
      activity_relevance: 0.5,
      last_incoming_ms: nowMs,
    });

    const r1 = p1AttentionDebt(G, nowMs);
    expect(r1.total).toBeCloseTo(7.5, 10);
  });

  it("有 horizon 的 Thread 产生 P_prospect", () => {
    const G = buildV4Graph();
    const all = computeAllPressures(G, 100, { nowMs: tickMs(100) });

    expect(all.P_prospect).toBeGreaterThan(0);

    const sig = 1 / (1 + Math.exp(-2.5));
    expect(all.P_prospect).toBeCloseTo(THREAD_WEIGHTS.major * sig, 6);
  });

  it("Beat feedback MAP 正确映射 assistance → Diligence", () => {
    // 直接测试 BEAT_FEEDBACK_MAP 而非通过 ExecutableResult
    const feedback = BEAT_FEEDBACK_MAP.assistance;
    expect(feedback).not.toBeNull();
    expect(feedback).toHaveLength(1);
    expect(feedback[0].voice).toBe(0); // Diligence
    expect(feedback[0].magnitude).toBe(0.3);
  });

  it("intend 门控 15 个活跃线程", () => {
    const ctx = makeCtx({ outcomeHistory: [] });

    for (let i = 0; i < 15; i++) {
      ctx.graph.addThread(`t_${i}`, { status: "open", weight: "minor", created_ms: 0 });
    }

    const impl = observerMod.instructions?.intend.impl;
    const result = impl?.(ctx as unknown as ModContext, {
      description: "overflow intent",
      horizon: 50,
    }) as { created: boolean; reason?: string };

    expect(result.created).toBe(false);
    expect(result.reason).toBe("too_many_active_threads");
  });
});
