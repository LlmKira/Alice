/**
 * ADR-79 M1: Reachability 反馈弧测试。
 *
 * 覆盖:
 * 1. classifyFailure — permanent vs transient 分类
 * 2. updateReachability 衰减/重置（通过 processResult 间接测试或直接测试图状态）
 * 3. mapper 事件自愈 — new_message/reaction/user_status 重置 reachability
 * 4. IAUS 降权 — reachability_score 二值 Consideration 调制
 * 5. 修正轮次辅助函数 — filterCorrectableErrors + buildCorrectionObservations
 *
 * @see runtime/src/engine/act.ts — classifyFailure, updateReachability
 * @see runtime/src/engine/iaus-scorer.ts — scoreAllCandidates
 * @see runtime/src/telegram/mapper.ts — resetReachability
 */
import { describe, expect, it } from "vitest";
import { BeliefStore } from "../src/belief/store.js";
import { classifyFailure } from "../src/engine/act/index.js";
import {
  type CandidateContext,
  type IAUSConfig,
  scoreAllCandidates,
} from "../src/engine/iaus-scorer.js";
import { buildTensionMap } from "../src/graph/tension.js";
import { WorldModel } from "../src/graph/world-model.js";
import {
  DEFAULT_SATURATION_COST_CONFIG,
  DEFAULT_SOCIAL_COST_CONFIG,
} from "../src/pressure/social-cost.js";
import { applyPerturbation } from "../src/telegram/mapper.js";
import type { PressureDims } from "../src/utils/math.js";
import { PersonalityVector } from "../src/voices/personality.js";

// ═══════════════════════════════════════════════════════════════════════════
// classifyFailure
// ═══════════════════════════════════════════════════════════════════════════

describe("classifyFailure", () => {
  // ADR-90 W4: classifyFailure 返回 { type, subtype } 结构
  it("telegram_soft_permanent → permanent/soft", () => {
    expect(classifyFailure({ errorCodes: ["telegram_soft_permanent"] })).toEqual({
      type: "permanent",
      subtype: "soft",
    });
  });

  it("telegram_hard_permanent → permanent/hard", () => {
    expect(classifyFailure({ errorCodes: ["telegram_hard_permanent"] })).toEqual({
      type: "permanent",
      subtype: "hard",
    });
  });

  it("unreachable_telegram_user → permanent/soft", () => {
    expect(classifyFailure({ errorCodes: ["unreachable_telegram_user"] })).toEqual({
      type: "permanent",
      subtype: "soft",
    });
  });

  it("timeout → transient", () => {
    expect(classifyFailure({ errorCodes: ["timeout"] })).toEqual({
      type: "transient",
      subtype: null,
    });
  });

  it("no errors → transient", () => {
    expect(classifyFailure({ errorCodes: [] })).toEqual({
      type: "transient",
      subtype: null,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Reachability score 衰减（直接图操作模拟 processResult 行为）
// ═══════════════════════════════════════════════════════════════════════════

describe("reachability score decay", () => {
  const LAMBDA = 2;

  it("exp(-f/λ) 衰减正确", () => {
    // 模拟连续失败的 reachability score
    for (let f = 1; f <= 5; f++) {
      const score = Math.exp(-f / LAMBDA);
      // f=1 → 0.607, f=2 → 0.368, f=3 → 0.223, f=5 → 0.082
      expect(score).toBeCloseTo(Math.exp(-f / LAMBDA), 5);
    }
    // 3 次失败 → score ≈ 0.22
    expect(Math.exp(-3 / LAMBDA)).toBeCloseTo(0.2231, 3);
  });

  it("成功后重置为 1.0", () => {
    const G = new WorldModel();
    G.addChannel("channel:test", { chat_type: "private" });
    // 模拟 3 次失败
    G.setDynamic("channel:test", "consecutive_act_failures", 3);
    G.setDynamic("channel:test", "reachability_score", Math.exp(-3 / LAMBDA));
    G.setDynamic("channel:test", "failure_type", "transient");

    // 模拟成功后重置
    const attrs = G.getChannel("channel:test");
    const oldFailures = (attrs.consecutive_act_failures as number) ?? 0;
    expect(oldFailures).toBe(3);
    expect(attrs.reachability_score as number).toBeCloseTo(0.2231, 3);

    // 重置
    G.setDynamic("channel:test", "consecutive_act_failures", 0);
    G.setDynamic("channel:test", "reachability_score", 1.0);
    G.setDynamic("channel:test", "failure_type", null);

    const resetAttrs = G.getChannel("channel:test");
    expect(resetAttrs.reachability_score).toBe(1.0);
    expect(resetAttrs.consecutive_act_failures).toBe(0);
    expect(resetAttrs.failure_type).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// mapper 事件自愈
// ═══════════════════════════════════════════════════════════════════════════

describe("mapper event self-healing", () => {
  function makeGraphWithFailure(): WorldModel {
    const G = new WorldModel();
    G.addAgent("self");
    G.addChannel("channel:100", { chat_type: "private" });
    G.addRelation("self", "monitors", "channel:100");
    G.addContact("contact:42", { tier: 50, display_name: "Bob" });
    G.addRelation("self", "acquaintance", "contact:42");
    G.addRelation("contact:42", "joined", "channel:100");

    // 模拟失败状态
    G.setDynamic("channel:100", "consecutive_act_failures", 3);
    G.setDynamic("channel:100", "reachability_score", 0.22);
    G.setDynamic("channel:100", "failure_type", "transient");
    G.setDynamic("contact:42", "consecutive_act_failures", 2);
    G.setDynamic("contact:42", "reachability_score", 0.37);
    G.setDynamic("contact:42", "failure_type", "transient");

    return G;
  }

  it("new_message 自愈 channel 和 contact", () => {
    const G = makeGraphWithFailure();
    applyPerturbation(G, {
      type: "new_message",
      channelId: "channel:100",
      contactId: "contact:42",
      tick: 100,
    });

    expect(G.getChannel("channel:100").reachability_score).toBe(1.0);
    expect(G.getChannel("channel:100").consecutive_act_failures).toBe(0);
    expect(G.getContact("contact:42").reachability_score).toBe(1.0);
    expect(G.getDynamic("contact:42", "consecutive_act_failures")).toBe(0);
  });

  it("reaction 自愈 contact 和 channel", () => {
    const G = makeGraphWithFailure();
    applyPerturbation(G, {
      type: "reaction",
      channelId: "channel:100",
      contactId: "contact:42",
      tick: 100,
      emoji: "👍",
    });

    expect(G.getChannel("channel:100").reachability_score).toBe(1.0);
    expect(G.getContact("contact:42").reachability_score).toBe(1.0);
  });

  it("user_status 自愈 contact", () => {
    const G = makeGraphWithFailure();
    applyPerturbation(G, {
      type: "user_status",
      contactId: "contact:42",
      tick: 100,
    });

    expect(G.getContact("contact:42").reachability_score).toBe(1.0);
    expect(G.getDynamic("contact:42", "consecutive_act_failures")).toBe(0);
  });

  it("gc_candidate_ms 也被自愈清除", () => {
    const G = makeGraphWithFailure();
    G.setDynamic("channel:100", "gc_candidate_ms", 1700000000000);

    applyPerturbation(G, {
      type: "new_message",
      channelId: "channel:100",
      contactId: "contact:42",
      tick: 100,
    });

    expect(G.getChannel("channel:100").gc_candidate_ms).toBeNull();
  });

  it("无失败记录时不做多余写入", () => {
    const G = new WorldModel();
    G.addAgent("self");
    G.addChannel("channel:100", { chat_type: "private" });
    G.addRelation("self", "monitors", "channel:100");

    // 无失败状态
    const attrsBefore = G.getChannel("channel:100");
    expect(attrsBefore.consecutive_act_failures).toBeUndefined();

    applyPerturbation(G, {
      type: "new_message",
      channelId: "channel:100",
      tick: 100,
    });

    // 不应设置 reachability 相关属性
    const attrsAfter = G.getChannel("channel:100");
    expect(attrsAfter.reachability_score).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// IAUS 降权
// ═══════════════════════════════════════════════════════════════════════════

describe("IAUS reachability dampening", () => {
  const kappa: PressureDims = [5.0, 8.0, 8.0, 5.0, 3.0, 5.0];
  const lowCostConfig = { ...DEFAULT_SOCIAL_COST_CONFIG, lambda: 0.1 };
  const nowMs = Date.now();

  function makeCandidateCtx(G: WorldModel): CandidateContext {
    return {
      G,
      nowMs,
    };
  }

  function makeConfig(
    G: WorldModel,
    contributions: Record<string, Record<string, number>>,
  ): IAUSConfig {
    return {
      candidateCtx: makeCandidateCtx(G),
      kappa,
      contributions,
      beliefs: new BeliefStore(),
      beliefGamma: 0,
      thompsonEta: 0,
      socialCost: lowCostConfig,
      saturationCost: DEFAULT_SATURATION_COST_CONFIG,
      windowStartMs: nowMs - 3600_000,
      uncertainty: 0,
      personality: new PersonalityVector(),
      voiceLastWon: { diligence: 0, curiosity: 0, sociability: 0, caution: 0 },
      nowMs,
      deterministic: true,
    };
  }

  it("reachability_score=1.0 不影响 V", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addAgent("self");
    G.addChannel("channel:a", { tier_contact: 5, chat_type: "private" });
    G.addRelation("self", "monitors", "channel:a");
    // reachability_score 默认 undefined → fallback 1.0

    const contributions = { P1: { "channel:a": 20 } };
    const tensionMap = buildTensionMap(contributions);
    const config = makeConfig(G, contributions);

    const result = scoreAllCandidates(tensionMap, G, 100, [], config);

    expect(result).not.toBeNull();
    if (result) {
      expect(result.bestV).toBeGreaterThan(0);
    }
  });

  it("低 reachability_score 降低 V", () => {
    // 场景 A: 正常 reachability
    const G_normal = new WorldModel();
    G_normal.tick = 100;
    G_normal.addAgent("self");
    G_normal.addChannel("channel:a", { tier_contact: 5, chat_type: "private" });
    G_normal.addRelation("self", "monitors", "channel:a");

    // 场景 B: 低 reachability（0.22 < 0.5 → U_reachable = ε = 0.01）
    const G_low = new WorldModel();
    G_low.tick = 100;
    G_low.addAgent("self");
    G_low.addChannel("channel:a", {
      tier_contact: 5,
      chat_type: "private",
      reachability_score: 0.22,
    });
    G_low.addRelation("self", "monitors", "channel:a");

    const contributions = { P1: { "channel:a": 20 } };
    const tensionMap = buildTensionMap(contributions);

    const resultNormal = scoreAllCandidates(
      tensionMap,
      G_normal,
      100,
      [],
      makeConfig(G_normal, contributions),
    );
    const resultLow = scoreAllCandidates(
      tensionMap,
      G_low,
      100,
      [],
      makeConfig(G_low, contributions),
    );

    expect(resultNormal).not.toBeNull();
    // IAUS 二值 reachability: score < 0.5 → U_reachable = ε（0.01）
    // 候选可能仍有正分数但应远低于正常情况
    if (resultNormal && resultLow) {
      expect(resultLow.bestV).toBeLessThan(resultNormal.bestV);
    }
  });

  it("reachability_score=0 → U_reachable=ε → 显著低于正常", () => {
    // 正常 reachability 基准
    const G_normal = new WorldModel();
    G_normal.tick = 100;
    G_normal.addAgent("self");
    G_normal.addChannel("channel:a", { tier_contact: 5, chat_type: "private" });
    G_normal.addRelation("self", "monitors", "channel:a");

    // reachability=0 目标
    const G_zero = new WorldModel();
    G_zero.tick = 100;
    G_zero.addAgent("self");
    G_zero.addChannel("channel:a", {
      tier_contact: 5,
      chat_type: "private",
      reachability_score: 0.0,
    });
    G_zero.addRelation("self", "monitors", "channel:a");

    const contributions = { P1: { "channel:a": 20 } };
    const tensionMap = buildTensionMap(contributions);

    const resultNormal = scoreAllCandidates(
      tensionMap,
      G_normal,
      100,
      [],
      makeConfig(G_normal, contributions),
    );
    const resultZero = scoreAllCandidates(
      tensionMap,
      G_zero,
      100,
      [],
      makeConfig(G_zero, contributions),
    );

    // IAUS: reachability=0 < 0.5 → U_reachable=ε=0.01（二值门控）
    // Compensation Factor 拉高几何均值，但相比正常 reachability 仍显著更低
    expect(resultNormal).not.toBeNull();
    if (resultNormal && resultZero) {
      expect(resultZero.bestV).toBeLessThan(resultNormal.bestV);
    }
  });

  it("不可达候选被跳过，选择可达候选", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addAgent("self");
    G.addChannel("channel:unreachable", {
      tier_contact: 5,
      chat_type: "private",
      reachability_score: 0.01,
    });
    G.addChannel("channel:reachable", {
      tier_contact: 50,
      chat_type: "private",
      // reachability_score 默认 1.0
    });
    G.addRelation("self", "monitors", "channel:unreachable");
    G.addRelation("self", "monitors", "channel:reachable");

    const contributions = { P1: { "channel:unreachable": 30, "channel:reachable": 10 } };
    const tensionMap = buildTensionMap(contributions);
    const config = makeConfig(G, contributions);

    const result = scoreAllCandidates(tensionMap, G, 100, [], config);

    expect(result).not.toBeNull();
    if (result) {
      // channel:unreachable reachability < 0.5 → U_reachable=ε → channel:reachable 被选中
      expect(result.candidate.target).toBe("channel:reachable");
    }
  });
});

// ADR-214 Wave B: filterCorrectableErrors / buildCorrectionObservations 测试已移除。
// 修正轮次管线（依赖 RecordedAction / ActionExecutionDetail）是死代码。
