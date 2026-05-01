/**
 * IAUS 评分器单元测试 — ADR-180 Phase 2。
 *
 * 覆盖:
 * 1. Response Curve 数学正确性（每种 curve type）
 * 2. Entity-Gated Dormancy（τ=0 + 无实体 → 1.0）
 * 3. Compensation Factor（n=1 直传，n=10 几何均值校正）
 * 4. Directed 场景：高义务 → diligence 得分优先
 * 5. Proactive 场景：τ₅≈0 → diligence/curiosity 竞争
 * 6. Idle growth：τ₁ 单调增长 → diligence 得分单调增长
 * 7. computeCandidateBypass 正确性
 * 8. assembleIAUSReason 输出格式
 *
 * @see runtime/src/engine/iaus-scorer.ts
 */
import { describe, expect, it } from "vitest";
import { BeliefStore } from "../src/belief/store.js";
import type { Desire } from "../src/engine/desire.js";
import {
  assembleIAUSReason,
  type CandidateContext,
  compensate,
  computeCandidateBypass,
  computeEmotionActionUtility,
  computeEmotionProactiveCapUtility,
  computeInactivityStaleUtility,
  computeProactivePacingUtility,
  computeTimingShadowUtility,
  evalCurve,
  type IAUSCandidate,
  type IAUSConfig,
  modulateCurve,
  type ResponseCurve,
  scoreAllCandidates,
} from "../src/engine/iaus-scorer.js";
import type { ChatType, DunbarTier } from "../src/graph/entities.js";
import type { TensionVector } from "../src/graph/tension.js";
import { WorldModel } from "../src/graph/world-model.js";
import {
  DEFAULT_SATURATION_COST_CONFIG,
  DEFAULT_SOCIAL_COST_CONFIG,
} from "../src/pressure/social-cost.js";
import type { PressureDims } from "../src/utils/math.js";
import { PersonalityVector } from "../src/voices/personality.js";

// ═══════════════════════════════════════════════════════════════════════════
// 辅助
// ═══════════════════════════════════════════════════════════════════════════

const EQUAL_PI = new PersonalityVector([0.25, 0.25, 0.25, 0.25]);
const kappa: PressureDims = [5.0, 8.0, 8.0, 5.0, 3.0, 5.0];
const BASE_NOW_MS = 600_000_000; // 足够大的基准时间

/** 构建张力向量，未指定的维度默认为 0。 */
function tension(overrides: Partial<TensionVector> = {}): TensionVector {
  return {
    tau1: 0,
    tau2: 0,
    tau3: 0,
    tau4: 0,
    tau5: 0,
    tau6: 0,
    tauP: 0,
    tauRisk: 0,
    tauAttraction: 0,
    tauSpike: 0,
    ...overrides,
  };
}

function buildGraph(
  channels: Array<{
    id: string;
    tierContact?: DunbarTier;
    pendingDirected?: number;
    chatType?: ChatType;
    reachabilityScore?: number;
  }>,
): WorldModel {
  const G = new WorldModel();
  G.tick = 100;
  G.addAgent("self");
  for (const ch of channels) {
    G.addChannel(ch.id, {
      unread: 5,
      tier_contact: ch.tierContact ?? 150,
      chat_type: ch.chatType ?? "private",
      pending_directed: ch.pendingDirected ?? 0,
      last_directed_ms: 0,
      reachability_score: ch.reachabilityScore ?? 1.0,
    });
    G.addRelation("self", "monitors", ch.id);
  }
  return G;
}

function buildCandidateCtx(
  G: WorldModel,
  nowMs: number,
  overrides?: Partial<Omit<CandidateContext, "G" | "nowMs">>,
): CandidateContext {
  return {
    G,
    nowMs,
    ...overrides,
  };
}

function buildIAUSConfig(
  G: WorldModel,
  _tensionMap: Map<string, TensionVector>,
  overrides?: Partial<IAUSConfig>,
): IAUSConfig {
  const nowMs = overrides?.nowMs ?? BASE_NOW_MS;
  return {
    candidateCtx: buildCandidateCtx(G, nowMs),
    kappa,
    contributions: {},
    beliefs: new BeliefStore(),
    beliefGamma: 0.1,
    thompsonEta: 0, // 确定性测试：关闭 Thompson Sampling
    socialCost: DEFAULT_SOCIAL_COST_CONFIG,
    saturationCost: DEFAULT_SATURATION_COST_CONFIG,
    windowStartMs: nowMs - 600_000, // 10 分钟窗口
    uncertainty: 0.5,
    personality: EQUAL_PI,
    voiceLastWon: {
      diligence: -Infinity,
      curiosity: -Infinity,
      sociability: -Infinity,
      caution: -Infinity,
    },
    nowMs,
    ...overrides,
  };
}

function setObligation(G: WorldModel, channelId: string, count: number, nowMs: number): void {
  G.setDynamic(channelId, "pending_directed", count);
  G.setDynamic(channelId, "last_directed_ms", nowMs - 1000);
}

function addConversation(
  G: WorldModel,
  channelId: string,
  state: "pending" | "opening" | "active" | "closing" | "cooldown",
  turnState: "alice_turn" | "other_turn" | "open" | "closed",
): void {
  const convId = `conversation:${channelId}_${state}`;
  G.addConversation(convId, {
    channel: channelId,
    state,
    turn_state: turnState,
    start_ms: Date.now() - 60_000,
    last_activity_ms: Date.now(),
    participants: [],
    pace: 0,
    message_count: 0,
    alice_message_count: 0,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Response Curve 数学正确性
// ═══════════════════════════════════════════════════════════════════════════

describe("evalCurve", () => {
  it("sigmoid: x << midpoint → ≈ min", () => {
    const curve: ResponseCurve = { type: "sigmoid", midpoint: 0.5, slope: 10, min: 0.01, max: 1 };
    expect(evalCurve(curve, -5)).toBeCloseTo(0.01, 1);
  });

  it("sigmoid: x >> midpoint → ≈ max", () => {
    const curve: ResponseCurve = { type: "sigmoid", midpoint: 0.5, slope: 10, min: 0.01, max: 1 };
    expect(evalCurve(curve, 5)).toBeCloseTo(1.0, 1);
  });

  it("sigmoid: x = midpoint → ≈ (min + max) / 2", () => {
    const curve: ResponseCurve = { type: "sigmoid", midpoint: 0.5, slope: 10, min: 0.0, max: 1 };
    // sigmoid(0) = 0.5, scaled to [0, 1] = 0.5
    expect(evalCurve(curve, 0.5)).toBeCloseTo(0.5, 1);
  });

  it("inv_sigmoid: x << midpoint → ≈ max", () => {
    const curve: ResponseCurve = {
      type: "inv_sigmoid",
      midpoint: 0.5,
      slope: 10,
      min: 0.01,
      max: 1,
    };
    expect(evalCurve(curve, -5)).toBeCloseTo(1.0, 1);
  });

  it("inv_sigmoid: x >> midpoint → ≈ min", () => {
    const curve: ResponseCurve = {
      type: "inv_sigmoid",
      midpoint: 0.5,
      slope: 10,
      min: 0.01,
      max: 1,
    };
    expect(evalCurve(curve, 5)).toBeCloseTo(0.01, 1);
  });

  it("linear: x ≤ midpoint → min", () => {
    const curve: ResponseCurve = { type: "linear", midpoint: 0, slope: 1, min: 0.01, max: 1 };
    expect(evalCurve(curve, -1)).toBeCloseTo(0.01, 2);
    expect(evalCurve(curve, 0)).toBeCloseTo(0.01, 2);
  });

  it("linear: x = midpoint + slope → max", () => {
    const curve: ResponseCurve = { type: "linear", midpoint: 0, slope: 1, min: 0.01, max: 1 };
    expect(evalCurve(curve, 1)).toBeCloseTo(1.0, 2);
  });

  it("linear: x = midpoint + slope/2 → (min + max) / 2", () => {
    const curve: ResponseCurve = { type: "linear", midpoint: 0, slope: 1, min: 0, max: 1 };
    expect(evalCurve(curve, 0.5)).toBeCloseTo(0.5, 2);
  });

  it("linear_dec: x ≤ midpoint → max", () => {
    const curve: ResponseCurve = { type: "linear_dec", midpoint: 0, slope: 1, min: 0.01, max: 1 };
    expect(evalCurve(curve, 0)).toBeCloseTo(1.0, 2);
  });

  it("linear_dec: x = midpoint + slope → min", () => {
    const curve: ResponseCurve = { type: "linear_dec", midpoint: 0, slope: 1, min: 0.01, max: 1 };
    expect(evalCurve(curve, 1)).toBeCloseTo(0.01, 2);
  });

  it("log: x = 0 → min", () => {
    const curve: ResponseCurve = { type: "log", midpoint: 1, slope: 0.5, min: 0.01, max: 1 };
    expect(evalCurve(curve, 0)).toBeCloseTo(0.01, 2);
  });

  it("log: 单调递增", () => {
    const curve: ResponseCurve = { type: "log", midpoint: 1, slope: 0.5, min: 0.01, max: 1 };
    const v1 = evalCurve(curve, 0.1);
    const v2 = evalCurve(curve, 0.5);
    const v3 = evalCurve(curve, 1.0);
    expect(v2).toBeGreaterThan(v1);
    expect(v3).toBeGreaterThan(v2);
  });

  it("exp_recovery: x ≤ midpoint → min", () => {
    const curve: ResponseCurve = { type: "exp_recovery", midpoint: 0, slope: 2, min: 0.01, max: 1 };
    expect(evalCurve(curve, 0)).toBeCloseTo(0.01, 2);
  });

  it("exp_recovery: x >> midpoint → ≈ max", () => {
    const curve: ResponseCurve = { type: "exp_recovery", midpoint: 0, slope: 2, min: 0.01, max: 1 };
    expect(evalCurve(curve, 10)).toBeCloseTo(1.0, 1);
  });

  it("所有 curve 输出 clamp 到 [min, max]", () => {
    const types: ResponseCurve["type"][] = [
      "sigmoid",
      "inv_sigmoid",
      "linear",
      "linear_dec",
      "log",
      "exp_recovery",
    ];
    for (const type of types) {
      const curve: ResponseCurve = { type, midpoint: 0.5, slope: 5, min: 0.05, max: 0.95 };
      for (const x of [-100, -1, 0, 0.5, 1, 100]) {
        const v = evalCurve(curve, x);
        expect(v).toBeGreaterThanOrEqual(0.05 - 1e-10);
        expect(v).toBeLessThanOrEqual(0.95 + 1e-10);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Compensation Factor
// ═══════════════════════════════════════════════════════════════════════════

describe("compensate", () => {
  it("n=1 → 直传 rawScore", () => {
    expect(compensate(0.5, 1, 0.4)).toBe(0.5);
  });

  it("n=0 → 直传 rawScore", () => {
    expect(compensate(0.5, 0, 0.4)).toBe(0.5);
  });

  it("rawScore=0 → 0", () => {
    expect(compensate(0, 10, 0.4)).toBe(0);
  });

  it("CF=0 → 几何均值（无补偿）", () => {
    const raw = 0.5 ** 10; // 约 0.000977
    const geomMean = raw ** (1 / 10); // = 0.5
    expect(compensate(raw, 10, 0)).toBeCloseTo(geomMean, 5);
  });

  it("CF=0.4 → 几何均值 + 补偿提升", () => {
    const raw = 0.5 ** 10;
    const geomMean = raw ** (1 / 10); // 0.5
    const expected = geomMean * (1 + (1 - geomMean) * 0.4);
    expect(compensate(raw, 10, 0.4)).toBeCloseTo(expected, 5);
  });

  it("rawScore=1 → 1（完美分数不变）", () => {
    // geomMean(1, n) = 1, CF 项 = 1 * (1 + 0 * cf) = 1
    expect(compensate(1, 10, 0.4)).toBeCloseTo(1, 5);
  });

  it("更多 considerations → CF 补偿越大", () => {
    // 相同 rawScore，n 越大，几何均值越接近 rawScore^(1/n)
    const raw5 = 0.5 ** 5;
    const raw10 = 0.5 ** 10;
    const comp5 = compensate(raw5, 5, 0.4);
    const comp10 = compensate(raw10, 10, 0.4);
    // 两者几何均值都是 0.5，CF 补偿后结果相同
    expect(comp5).toBeCloseTo(comp10, 5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. computeCandidateBypass
// ═══════════════════════════════════════════════════════════════════════════

describe("computeCandidateBypass", () => {
  const nowMs = BASE_NOW_MS;

  it("directed target (高义务) → bypass=true", () => {
    const G = buildGraph([{ id: "channel:obl", pendingDirected: 2 }]);
    setObligation(G, "channel:obl", 2, nowMs);
    const ctx = buildCandidateCtx(G, nowMs);
    expect(computeCandidateBypass(ctx, "channel:obl")).toBe(true);
  });

  it("conversation continuation → bypass=true", () => {
    const G = buildGraph([{ id: "channel:conv" }]);
    addConversation(G, "channel:conv", "active", "alice_turn");
    const ctx = buildCandidateCtx(G, nowMs);
    expect(computeCandidateBypass(ctx, "channel:conv")).toBe(true);
  });

  it("无义务无对话延续 → bypass=false", () => {
    const G = buildGraph([{ id: "channel:plain" }]);
    const ctx = buildCandidateCtx(G, nowMs);
    expect(computeCandidateBypass(ctx, "channel:plain")).toBe(false);
  });

  it("permanent failure + directed → bypass=false", () => {
    const G = buildGraph([{ id: "channel:dead", pendingDirected: 2 }]);
    setObligation(G, "channel:dead", 2, nowMs);
    G.setDynamic("channel:dead", "failure_type", "permanent");
    const ctx = buildCandidateCtx(G, nowMs);
    expect(computeCandidateBypass(ctx, "channel:dead")).toBe(false);
  });

  it("不在图中的 target → bypass=false", () => {
    const G = buildGraph([]);
    const ctx = buildCandidateCtx(G, nowMs);
    expect(computeCandidateBypass(ctx, "nonexistent")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. scoreAllCandidates
// ═══════════════════════════════════════════════════════════════════════════

describe("scoreAllCandidates", () => {
  const nowMs = BASE_NOW_MS;

  it("空 channel 列表 → null", () => {
    const G = buildGraph([]);
    const tensionMap = new Map<string, TensionVector>();
    const config = buildIAUSConfig(G, tensionMap, { nowMs });
    const result = scoreAllCandidates(tensionMap, G, 100, [], config);
    expect(result).toBeNull();
  });

  it("self resting 期间不产生普通行动候选", () => {
    const G = buildGraph([{ id: "channel:a", tierContact: 5, pendingDirected: 3 }]);
    G.updateAgent("self", {
      resting_since_ms: nowMs - 1_000,
      resting_until_ms: nowMs + 30_000,
      resting_reason: "test",
    });
    const tensionMap = new Map<string, TensionVector>([
      ["channel:a", tension({ tau5: 3.0, tau1: 1.0 })],
    ]);
    const config = buildIAUSConfig(G, tensionMap, { nowMs });

    const result = scoreAllCandidates(tensionMap, G, 100, [], config);
    expect(result).toBeNull();
  });

  it("targetWhitelist 只允许白名单 target 进入候选池", () => {
    const G = buildGraph([
      { id: "channel:a", tierContact: 5 },
      { id: "channel:b", tierContact: 5 },
    ]);
    const tensionMap = new Map<string, TensionVector>([
      ["channel:a", tension({ tau1: 3.0, tau3: 2.0 })],
      ["channel:b", tension({ tau1: 0.5, tau3: 0.5 })],
    ]);

    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      targetWhitelist: new Set(["channel:b"]),
      contributions: {
        P1: { "channel:a": 10, "channel:b": 1 },
        P3: { "channel:a": 5, "channel:b": 1 },
      },
    });
    const result = scoreAllCandidates(tensionMap, G, 100, [], config);

    expect(result).not.toBeNull();
    expect(result?.candidate.target).toBe("channel:b");
    expect(result?.scored.every((entry) => entry.target === "channel:b")).toBe(true);
  });

  it("targetWhitelist 过滤掉全部 channel 时返回 null", () => {
    const G = buildGraph([{ id: "channel:a", tierContact: 5 }]);
    const tensionMap = new Map<string, TensionVector>([
      ["channel:a", tension({ tau1: 1.0, tau3: 0.5 })],
    ]);

    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      targetWhitelist: new Set(["channel:missing"]),
      contributions: { P1: { "channel:a": 10 } },
    });
    const result = scoreAllCandidates(tensionMap, G, 100, [], config);

    expect(result).toBeNull();
  });

  it("单个 channel + 非零张力 → 返回结果", () => {
    const G = buildGraph([{ id: "channel:a", tierContact: 5 }]);
    const tensionMap = new Map([["channel:a", tension({ tau1: 1.0, tau3: 0.5 })]]);

    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:a": 10 } },
    });
    const result = scoreAllCandidates(tensionMap, G, 100, [], config);

    expect(result).not.toBeNull();
    if (result) {
      expect(result.candidateCount).toBeGreaterThanOrEqual(1);
      expect(result.bestV).toBeGreaterThan(0);
      expect(result.candidate.target).toBe("channel:a");
      // IAUS 只生成 diligence/curiosity/sociability，不生成 caution
      expect(["diligence", "curiosity", "sociability"]).toContain(result.candidate.action);
    }
  });

  it("Caution 不作为独立 action_type 出现", () => {
    const G = buildGraph([{ id: "channel:a", tierContact: 5 }]);
    const tensionMap = new Map([["channel:a", tension({ tau1: 0.5, tauRisk: 2.0 })]]);

    const config = buildIAUSConfig(G, tensionMap, { nowMs });
    const result = scoreAllCandidates(tensionMap, G, 100, [], config);

    if (result) {
      for (const s of result.scored) {
        expect(s.action).not.toBe("caution");
      }
    }
  });

  it("高 tauRisk → 所有候选 U_conflict_avoidance 被抑制", () => {
    const G = buildGraph([{ id: "channel:a", tierContact: 5 }]);

    // 低风险
    const tmLow = new Map([["channel:a", tension({ tau1: 1.0 })]]);
    const configLow = buildIAUSConfig(G, tmLow, {
      nowMs,
      uncertainty: 0.1,
      contributions: { P1: { "channel:a": 10 } },
    });
    const resultLow = scoreAllCandidates(tmLow, G, 100, [], configLow);

    // 高风险
    const tmHigh = new Map([["channel:a", tension({ tau1: 1.0, tauRisk: 3.0 })]]);
    const configHigh = buildIAUSConfig(G, tmHigh, {
      nowMs,
      uncertainty: 0.9,
      contributions: { P1: { "channel:a": 10 } },
    });
    const resultHigh = scoreAllCandidates(tmHigh, G, 100, [], configHigh);

    // 高风险版本的最佳 V 应该更低（U_conflict_avoidance 抑制）
    if (resultLow && resultHigh) {
      expect(resultHigh.bestV).toBeLessThan(resultLow.bestV);
    }
  });

  it("reachability_score ≈ 0 → 得分显著低于可达 target", () => {
    // 不可达 target
    const G1 = buildGraph([{ id: "channel:dead", tierContact: 5, reachabilityScore: 0 }]);
    const tm1 = new Map([["channel:dead", tension({ tau1: 1.0 })]]);
    const config1 = buildIAUSConfig(G1, tm1, {
      nowMs,
      contributions: { P1: { "channel:dead": 10 } },
    });
    const result1 = scoreAllCandidates(tm1, G1, 100, [], config1);

    // 可达 target（其他条件相同）
    const G2 = buildGraph([{ id: "channel:live", tierContact: 5, reachabilityScore: 1.0 }]);
    const tm2 = new Map([["channel:live", tension({ tau1: 1.0 })]]);
    const config2 = buildIAUSConfig(G2, tm2, {
      nowMs,
      contributions: { P1: { "channel:live": 10 } },
    });
    const result2 = scoreAllCandidates(tm2, G2, 100, [], config2);

    // IAUS CF 补偿使得单个 ε 不能绝对否决（这是设计意图），
    // 但不可达 target 的得分应显著低于可达的
    expect(result2).not.toBeNull();
    if (result1 && result2) {
      expect(result1.bestV).toBeLessThan(result2.bestV);
    }
  });

  it("excludeTargets 排除指定目标", () => {
    const G = buildGraph([
      { id: "channel:a", tierContact: 5 },
      { id: "channel:b", tierContact: 5 },
    ]);
    const t = tension({ tau1: 1.0 });
    const tensionMap = new Map([
      ["channel:a", t],
      ["channel:b", t],
    ]);

    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:a": 20, "channel:b": 10 } },
      excludeTargets: new Set(["channel:a"]),
    });
    const result = scoreAllCandidates(tensionMap, G, 100, [], config);

    if (result) {
      expect(result.candidate.target).toBe("channel:b");
      // scored 中不应出现 channel:a
      for (const s of result.scored) {
        expect(s.target).not.toBe("channel:a");
      }
    }
  });

  it("IAUSCandidate 字段完整性", () => {
    const G = buildGraph([{ id: "channel:test", tierContact: 15 }]);
    const tensionMap = new Map([["channel:test", tension({ tau1: 0.8, tau3: 0.3 })]]);

    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:test": 15 } },
    });
    const result = scoreAllCandidates(tensionMap, G, 100, [], config);

    expect(result).not.toBeNull();
    if (result) {
      const c = result.candidate;
      expect(c.target).toBe("channel:test");
      expect(typeof c.netValue).toBe("number");
      expect(typeof c.deltaP).toBe("number");
      expect(typeof c.socialCost).toBe("number");
      expect(c.focalEntities).toEqual(["channel:test"]);
      expect(typeof c.bypassGates).toBe("boolean");
      expect(typeof c.considerations).toBe("object");
      // considerations 应含共享项
      expect("U_conflict_avoidance" in c.considerations).toBe(true);
      expect("U_freshness" in c.considerations).toBe(true);
      expect("U_fatigue" in c.considerations).toBe(true);
      // ADR-183: U_personality 已移除——其效果通过 modulateCurve 编码到专属 Consideration 曲线中
      expect("U_personality" in c.considerations).toBe(false);
    }
  });

  // ── 行为场景测试 ──────────────────────────────────────────────────────

  it("directed 场景：高义务 target 得分高于空闲 target", () => {
    const G = buildGraph([
      { id: "channel:obl", tierContact: 50, pendingDirected: 3 },
      { id: "channel:idle", tierContact: 50 },
    ]);
    setObligation(G, "channel:obl", 3, nowMs);

    const tensionMap = new Map([
      ["channel:obl", tension({ tau1: 0.8, tau5: 1.0 })],
      ["channel:idle", tension({ tau3: 0.3 })],
    ]);

    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:obl": 15, "channel:idle": 5 } },
      candidateCtx: buildCandidateCtx(G, nowMs),
    });
    const result = scoreAllCandidates(tensionMap, G, 100, [], config);

    expect(result).not.toBeNull();
    if (result) {
      // 验证 scored 数组中 channel:obl 的最高得分 > channel:idle 的最高得分
      const oblScores = result.scored.filter((s) => s.target === "channel:obl");
      const idleScores = result.scored.filter((s) => s.target === "channel:idle");
      const maxObl = Math.max(...oblScores.map((s) => s.V));
      const maxIdle = Math.max(...idleScores.map((s) => s.V));
      expect(maxObl).toBeGreaterThan(maxIdle);
      // 至少有一个 bypass 候选
      expect(oblScores.some((s) => s.bypassGates)).toBe(true);
    }
  });

  it("idle growth：τ₁ 单调增长 → diligence 得分单调增长", () => {
    const G = buildGraph([{ id: "channel:a", tierContact: 5 }]);

    const scores: number[] = [];
    for (const tau1Val of [0.1, 0.3, 0.5, 0.8, 1.5]) {
      const tensionMap = new Map([["channel:a", tension({ tau1: tau1Val })]]);

      const config = buildIAUSConfig(G, tensionMap, {
        nowMs,
        contributions: { P1: { "channel:a": 10 } },
      });
      const result = scoreAllCandidates(tensionMap, G, 100, [], config);

      if (result) {
        // 找出 diligence 候选的得分
        const diligenceEntry = result.scored.find(
          (s) => s.action === "diligence" && s.target === "channel:a",
        );
        if (diligenceEntry) scores.push(diligenceEntry.V);
      }
    }

    // 验证单调递增
    expect(scores.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThan(scores[i - 1]);
    }
  });

  it("声部疲劳：刚获胜的声部得分被抑制", () => {
    const G = buildGraph([{ id: "channel:a", tierContact: 5 }]);
    const tensionMap = new Map([["channel:a", tension({ tau1: 0.8, tau3: 0.5 })]]);

    // 无疲劳：所有声部 voiceLastWon = -Infinity
    const configFresh = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:a": 10 } },
    });
    const resultFresh = scoreAllCandidates(tensionMap, G, 100, [], configFresh);

    // diligence 刚获胜（1 秒前）→ 完全疲劳
    const configTired = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:a": 10 } },
      voiceLastWon: {
        diligence: nowMs - 1000, // 1 秒前
        curiosity: -Infinity,
        sociability: -Infinity,
        caution: -Infinity,
      },
    });
    const resultTired = scoreAllCandidates(tensionMap, G, 100, [], configTired);

    if (resultFresh && resultTired) {
      const freshDiligence = resultFresh.scored.find((s) => s.action === "diligence");
      const tiredDiligence = resultTired.scored.find((s) => s.action === "diligence");
      if (freshDiligence && tiredDiligence) {
        expect(tiredDiligence.V).toBeLessThan(freshDiligence.V);
      }
    }
  });

  it("ADR-116: 群组 silence damping 有下限保护", () => {
    const G = buildGraph([{ id: "channel:grp", tierContact: 50, chatType: "group" }]);
    G.setDynamic("channel:grp", "consecutive_act_silences", 10);

    const tensionMap = new Map([["channel:grp", tension({ tau1: 1.0 })]]);

    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:grp": 20 } },
    });
    const result = scoreAllCandidates(tensionMap, G, 100, [], config);

    // 群组 silence damping floor=0.3 → 不会被完全压死
    expect(result).not.toBeNull();
    if (result) {
      expect(result.bestV).toBeGreaterThan(0);
    }
  });

  it("多 channel 竞争：压力更高的 channel 得分更高", () => {
    const G = buildGraph([
      { id: "channel:hot", tierContact: 5 },
      { id: "channel:cold", tierContact: 5 },
    ]);

    const tensionMap = new Map([
      ["channel:hot", tension({ tau1: 2.0, tau3: 1.0 })],
      ["channel:cold", tension({ tau1: 0.1 })],
    ]);

    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:hot": 30, "channel:cold": 1 } },
    });
    const result = scoreAllCandidates(tensionMap, G, 100, [], config);

    expect(result).not.toBeNull();
    if (result) {
      const hotMax = Math.max(
        ...result.scored.filter((s) => s.target === "channel:hot").map((s) => s.V),
      );
      const coldMax = Math.max(
        ...result.scored.filter((s) => s.target === "channel:cold").map((s) => s.V),
      );
      expect(hotMax).toBeGreaterThan(coldMax);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Entity-Gated Dormancy（通过 scoreAllCandidates 间接测试）
// ═══════════════════════════════════════════════════════════════════════════

describe("entity-gated dormancy", () => {
  const nowMs = BASE_NOW_MS;

  it("τ₄=0（无线程）不否决 diligence", () => {
    const G = buildGraph([{ id: "channel:a", tierContact: 5 }]);

    // τ₁ > 0 但 τ₄=0（无线程）→ U_thread_age 应为 1.0 而非 ε
    const tensionMap = new Map([["channel:a", tension({ tau1: 1.0 })]]);

    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:a": 10 } },
    });
    const result = scoreAllCandidates(tensionMap, G, 100, [], config);

    expect(result).not.toBeNull();
    if (result) {
      const diligence = result.scored.find((s) => s.action === "diligence");
      expect(diligence).toBeDefined();
      if (diligence) {
        expect(diligence.V).toBeGreaterThan(0.01); // 不被 ε 压死
      }
    }
  });

  it("τ_P=0（无前景）不否决 diligence", () => {
    const G = buildGraph([{ id: "channel:a", tierContact: 5 }]);
    // τ_P = 0 → dormantNeutral → 1.0
    const tensionMap = new Map([["channel:a", tension({ tau1: 1.0 })]]);

    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:a": 10 } },
    });
    const result = scoreAllCandidates(tensionMap, G, 100, [], config);

    if (result) {
      const diligence = result.scored.find((s) => s.action === "diligence");
      expect(diligence).toBeDefined();
      if (diligence) {
        expect(diligence.V).toBeGreaterThan(0.01);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. assembleIAUSReason
// ═══════════════════════════════════════════════════════════════════════════

describe("assembleIAUSReason", () => {
  it("基本输出格式正确", () => {
    const candidate: IAUSCandidate = {
      action: "diligence",
      target: "channel:test",
      focalEntities: ["channel:test"],
      netValue: 0.6,
      deltaP: 0.5,
      socialCost: 0.3,
      considerations: {},
      bypassGates: false,
    };

    const reason = assembleIAUSReason(candidate, 0.8, 0.05, 0.75);

    expect(reason).toContain("pressure=");
    expect(reason).toContain("value=");
    expect(reason).toContain("p=75%");
  });

  it("高 voiNull 时包含 waiting 提示", () => {
    const candidate: IAUSCandidate = {
      action: "sociability",
      target: "channel:test",
      focalEntities: [],
      netValue: 0.3,
      deltaP: 0.2,
      socialCost: 0.1,
      considerations: {},
      bypassGates: false,
    };

    const reason = assembleIAUSReason(candidate, 0.5, 0.2);
    expect(reason).toContain("waiting may help");
  });

  it("无 deltaP/socialCost 时不包含 relief/cost", () => {
    const candidate: IAUSCandidate = {
      action: "curiosity",
      target: "channel:test",
      focalEntities: [],
      netValue: 0.1,
      deltaP: 0,
      socialCost: 0,
      considerations: {},
      bypassGates: false,
    };

    const reason = assembleIAUSReason(candidate, 0.3);
    expect(reason).not.toContain("relief=");
    expect(reason).not.toContain("cost=");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. D1: Momentum Bonus — ADR-182
// ═══════════════════════════════════════════════════════════════════════════

describe("D1: Momentum Bonus", () => {
  const nowMs = BASE_NOW_MS;

  it("lastWinner 同 (action, target) → 得分提升", () => {
    const G = buildGraph([{ id: "channel:a", tierContact: 5 }]);
    const tensionMap = new Map([["channel:a", tension({ tau1: 1.0 })]]);

    // 无 momentum
    const configBase = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:a": 10 } },
      deterministic: true,
    });
    const resultBase = scoreAllCandidates(tensionMap, G, 100, [], configBase);

    // 有 momentum：diligence + channel:a 刚赢过
    const configMomentum = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:a": 10 } },
      deterministic: true,
      lastWinner: { action: "diligence", target: "channel:a" },
      lastActionMs: nowMs - 10_000, // 10 秒前
      momentumBonus: 0.2,
      momentumDecayMs: 300_000,
    });
    const resultMomentum = scoreAllCandidates(tensionMap, G, 100, [], configMomentum);

    expect(resultBase).not.toBeNull();
    expect(resultMomentum).not.toBeNull();
    if (resultBase && resultMomentum) {
      const baseDiligence = resultBase.scored.find(
        (s) => s.action === "diligence" && s.target === "channel:a",
      );
      const momentumDiligence = resultMomentum.scored.find(
        (s) => s.action === "diligence" && s.target === "channel:a",
      );
      expect(baseDiligence).toBeDefined();
      expect(momentumDiligence).toBeDefined();
      if (baseDiligence && momentumDiligence) {
        expect(momentumDiligence.V).toBeGreaterThan(baseDiligence.V);
      }
    }
  });

  it("不同 action → 无 bonus", () => {
    const G = buildGraph([{ id: "channel:a", tierContact: 5 }]);
    const tensionMap = new Map([["channel:a", tension({ tau1: 1.0, tau3: 0.5 })]]);

    // lastWinner 是 sociability，但 diligence 不应获得 bonus
    const configBase = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:a": 10 } },
      deterministic: true,
    });
    const resultBase = scoreAllCandidates(tensionMap, G, 100, [], configBase);

    const configMismatch = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:a": 10 } },
      deterministic: true,
      lastWinner: { action: "sociability", target: "channel:a" },
      lastActionMs: nowMs - 10_000,
      momentumBonus: 0.2,
      momentumDecayMs: 300_000,
    });
    const resultMismatch = scoreAllCandidates(tensionMap, G, 100, [], configMismatch);

    if (resultBase && resultMismatch) {
      const baseDiligence = resultBase.scored.find(
        (s) => s.action === "diligence" && s.target === "channel:a",
      );
      const mismatchDiligence = resultMismatch.scored.find(
        (s) => s.action === "diligence" && s.target === "channel:a",
      );
      if (baseDiligence && mismatchDiligence) {
        // diligence 得分应相同（无 bonus）
        expect(mismatchDiligence.V).toBeCloseTo(baseDiligence.V, 10);
      }
    }
  });

  it("距上次行动 > decayMs → 无 bonus", () => {
    const G = buildGraph([{ id: "channel:a", tierContact: 5 }]);
    const tensionMap = new Map([["channel:a", tension({ tau1: 1.0 })]]);

    const configBase = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:a": 10 } },
      deterministic: true,
    });
    const resultBase = scoreAllCandidates(tensionMap, G, 100, [], configBase);

    // 超过 decayMs
    const configExpired = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:a": 10 } },
      deterministic: true,
      lastWinner: { action: "diligence", target: "channel:a" },
      lastActionMs: nowMs - 400_000, // 400 秒前，超过 300_000
      momentumBonus: 0.2,
      momentumDecayMs: 300_000,
    });
    const resultExpired = scoreAllCandidates(tensionMap, G, 100, [], configExpired);

    if (resultBase && resultExpired) {
      const baseDiligence = resultBase.scored.find(
        (s) => s.action === "diligence" && s.target === "channel:a",
      );
      const expiredDiligence = resultExpired.scored.find(
        (s) => s.action === "diligence" && s.target === "channel:a",
      );
      if (baseDiligence && expiredDiligence) {
        expect(expiredDiligence.V).toBeCloseTo(baseDiligence.V, 10);
      }
    }
  });

  it("lastWinner=null → 无 bonus", () => {
    const G = buildGraph([{ id: "channel:a", tierContact: 5 }]);
    const tensionMap = new Map([["channel:a", tension({ tau1: 1.0 })]]);

    const configBase = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:a": 10 } },
      deterministic: true,
    });
    const resultBase = scoreAllCandidates(tensionMap, G, 100, [], configBase);

    const configNull = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:a": 10 } },
      deterministic: true,
      lastWinner: null,
      lastActionMs: nowMs - 10_000,
      momentumBonus: 0.2,
      momentumDecayMs: 300_000,
    });
    const resultNull = scoreAllCandidates(tensionMap, G, 100, [], configNull);

    if (resultBase && resultNull) {
      const baseDiligence = resultBase.scored.find(
        (s) => s.action === "diligence" && s.target === "channel:a",
      );
      const nullDiligence = resultNull.scored.find(
        (s) => s.action === "diligence" && s.target === "channel:a",
      );
      if (baseDiligence && nullDiligence) {
        expect(nullDiligence.V).toBeCloseTo(baseDiligence.V, 10);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. D2: Rank Gate — ADR-182
// ═══════════════════════════════════════════════════════════════════════════

describe("D2: Rank Gate", () => {
  const nowMs = BASE_NOW_MS;

  it("有 urgent 候选时 winner 从 urgent 池选（即使 normal 得分更高）", () => {
    // channel:obl 有义务（bypass=true），channel:hot 无义务但压力更高
    const G = buildGraph([
      { id: "channel:obl", tierContact: 50, pendingDirected: 3 },
      { id: "channel:hot", tierContact: 5 },
    ]);
    setObligation(G, "channel:obl", 3, nowMs);

    const tensionMap = new Map([
      ["channel:obl", tension({ tau1: 0.3, tau5: 0.5 })],
      ["channel:hot", tension({ tau1: 3.0, tau3: 2.0, tau6: 1.0 })],
    ]);

    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:obl": 5, "channel:hot": 50 } },
      candidateCtx: buildCandidateCtx(G, nowMs),
      deterministic: true,
    });
    const result = scoreAllCandidates(tensionMap, G, 100, [], config);

    expect(result).not.toBeNull();
    if (result) {
      // winner 必须来自 urgent 池（channel:obl）
      expect(result.candidate.target).toBe("channel:obl");
      expect(result.winnerBypassGates).toBe(true);
    }
  });

  it("无 urgent 候选时从 normal 池选", () => {
    const G = buildGraph([
      { id: "channel:a", tierContact: 5 },
      { id: "channel:b", tierContact: 5 },
    ]);

    const tensionMap = new Map([
      ["channel:a", tension({ tau1: 2.0 })],
      ["channel:b", tension({ tau1: 0.5 })],
    ]);

    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:a": 30, "channel:b": 5 } },
      deterministic: true,
    });
    const result = scoreAllCandidates(tensionMap, G, 100, [], config);

    expect(result).not.toBeNull();
    if (result) {
      // 无 urgent → 从 normal 池选，winner 不 bypass
      expect(result.winnerBypassGates).toBe(false);
    }
  });

  it("scored 仍包含全部候选（审计完整性）", () => {
    const G = buildGraph([
      { id: "channel:obl", tierContact: 50, pendingDirected: 2 },
      { id: "channel:normal", tierContact: 5 },
    ]);
    setObligation(G, "channel:obl", 2, nowMs);

    const tensionMap = new Map([
      ["channel:obl", tension({ tau1: 0.5, tau5: 0.5 })],
      ["channel:normal", tension({ tau1: 1.0 })],
    ]);

    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:obl": 10, "channel:normal": 15 } },
      candidateCtx: buildCandidateCtx(G, nowMs),
      deterministic: true,
    });
    const result = scoreAllCandidates(tensionMap, G, 100, [], config);

    expect(result).not.toBeNull();
    if (result) {
      // scored 包含两个 channel 的候选
      const targets = new Set(result.scored.map((s) => s.target));
      expect(targets.has("channel:obl")).toBe(true);
      expect(targets.has("channel:normal")).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. D5: Bottleneck Logging — ADR-182
// ═══════════════════════════════════════════════════════════════════════════

describe("D5: Bottleneck Logging", () => {
  const nowMs = BASE_NOW_MS;

  it("scored 中每个候选有非空 bottleneck 字段", () => {
    const G = buildGraph([{ id: "channel:a", tierContact: 5 }]);
    const tensionMap = new Map([["channel:a", tension({ tau1: 1.0, tau3: 0.5 })]]);

    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:a": 10 } },
    });
    const result = scoreAllCandidates(tensionMap, G, 100, [], config);

    expect(result).not.toBeNull();
    if (result) {
      for (const s of result.scored) {
        expect(typeof s.bottleneck).toBe("string");
        expect(s.bottleneck.length).toBeGreaterThan(0);
      }
    }
  });

  it("scored 保留反事实诊断需要的数值和 considerations", () => {
    const G = buildGraph([{ id: "channel:a", tierContact: 5 }]);
    const tensionMap = new Map([["channel:a", tension({ tau1: 1.0, tau3: 0.5 })]]);

    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:a": 10 } },
    });
    const result = scoreAllCandidates(tensionMap, G, 100, [], config);

    expect(result).not.toBeNull();
    if (result) {
      for (const s of result.scored) {
        expect(typeof s.deltaP).toBe("number");
        expect(typeof s.socialCost).toBe("number");
        expect(typeof s.netValue).toBe("number");
        expect(s.considerations).toEqual(expect.any(Object));
        expect(Object.keys(s.considerations).length).toBeGreaterThan(0);
      }
    }
  });

  it("bottleneck 是最低分 Consideration 的 key", () => {
    const G = buildGraph([{ id: "channel:a", tierContact: 5 }]);
    const tensionMap = new Map([["channel:a", tension({ tau1: 0.5, tau3: 0.3 })]]);

    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:a": 10 } },
    });
    const result = scoreAllCandidates(tensionMap, G, 100, [], config);

    expect(result).not.toBeNull();
    if (result) {
      // 检查 bottleneck 确实是候选的 considerations 中最低分的 key
      const candidate = result.candidate;
      const minEntry = Object.entries(candidate.considerations).reduce(
        (min, [k, v]) => (v < min[1] ? [k, v] : min),
        ["", Infinity] as [string, number],
      );
      // bottleneck 在 scored 中
      const scoredEntry = result.scored.find(
        (s) => s.action === candidate.action && s.target === candidate.target,
      );
      expect(scoredEntry).toBeDefined();
      if (scoredEntry) {
        expect(scoredEntry.bottleneck).toBe(minEntry[0]);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. ADR-183: Per-Personality Curve Modulation
// ═══════════════════════════════════════════════════════════════════════════

describe("modulateCurve", () => {
  const baseSigmoid: ResponseCurve = {
    type: "sigmoid",
    midpoint: 0.3,
    slope: 8,
    min: 0.01,
    max: 1,
  };

  it("等权人格（π=0.25）→ 曲线不变", () => {
    const modulated = modulateCurve(baseSigmoid, 0.25, 0.5);
    expect(modulated.midpoint).toBeCloseTo(0.3, 10);
    expect(modulated.slope).toBeCloseTo(8, 10);
  });

  it("高 π → 更低 midpoint + 更陡 slope", () => {
    const modulated = modulateCurve(baseSigmoid, 0.5, 0.5);
    expect(modulated.midpoint).toBeLessThan(baseSigmoid.midpoint);
    expect(modulated.slope).toBeGreaterThan(baseSigmoid.slope);
  });

  it("低 π → 更高 midpoint + 更平 slope", () => {
    const modulated = modulateCurve(baseSigmoid, 0.05, 0.5);
    expect(modulated.midpoint).toBeGreaterThan(baseSigmoid.midpoint);
    expect(modulated.slope).toBeLessThan(baseSigmoid.slope);
  });

  it("strength=0 → 曲线不变", () => {
    const modulated = modulateCurve(baseSigmoid, 0.5, 0);
    expect(modulated.midpoint).toBe(baseSigmoid.midpoint);
    expect(modulated.slope).toBe(baseSigmoid.slope);
  });

  it("稳定性：π∈[0.05,0.5] + strength∈[0,1] → midpoint>0 且 slope>0", () => {
    for (const piV of [0.05, 0.1, 0.25, 0.4, 0.5]) {
      for (const strength of [0, 0.3, 0.5, 0.7, 1.0]) {
        const modulated = modulateCurve(baseSigmoid, piV, strength);
        expect(modulated.midpoint).toBeGreaterThan(0);
        expect(modulated.slope).toBeGreaterThan(0);
      }
    }
  });

  it("min/max/type 不变", () => {
    const modulated = modulateCurve(baseSigmoid, 0.5, 1.0);
    expect(modulated.type).toBe(baseSigmoid.type);
    expect(modulated.min).toBe(baseSigmoid.min);
    expect(modulated.max).toBe(baseSigmoid.max);
  });
});

describe("ADR-183: curve modulation 行为影响", () => {
  const nowMs = BASE_NOW_MS;

  it("高 π_D 人格 → diligence 在较低 τ₁ 时就有较高得分", () => {
    const G = buildGraph([{ id: "channel:a", tierContact: 5 }]);
    // 中等张力——人格差异在此区间最显著
    const tensionMap = new Map([["channel:a", tension({ tau1: 0.3 })]]);

    // 高 Diligence 人格
    const configHighD = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:a": 10 } },
      deterministic: true,
      personality: new PersonalityVector([0.45, 0.2, 0.2, 0.15]),
    });
    const resultHighD = scoreAllCandidates(tensionMap, G, 100, [], configHighD);

    // 低 Diligence 人格
    const configLowD = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:a": 10 } },
      deterministic: true,
      personality: new PersonalityVector([0.1, 0.3, 0.3, 0.3]),
    });
    const resultLowD = scoreAllCandidates(tensionMap, G, 100, [], configLowD);

    expect(resultHighD).not.toBeNull();
    expect(resultLowD).not.toBeNull();
    if (resultHighD && resultLowD) {
      const highDiligence = resultHighD.scored.find(
        (s) => s.action === "diligence" && s.target === "channel:a",
      );
      const lowDiligence = resultLowD.scored.find(
        (s) => s.action === "diligence" && s.target === "channel:a",
      );
      expect(highDiligence).toBeDefined();
      expect(lowDiligence).toBeDefined();
      if (highDiligence && lowDiligence) {
        // 高 Diligence 人格在中等张力下 diligence 得分更高
        expect(highDiligence.V).toBeGreaterThan(lowDiligence.V);
      }
    }
  });

  it("高 π_S 人格 → sociability 在较低 τ₃ 时就有较高得分", () => {
    const G = buildGraph([{ id: "channel:a", tierContact: 5 }]);
    const tensionMap = new Map([["channel:a", tension({ tau3: 0.3 })]]);

    const configHighS = buildIAUSConfig(G, tensionMap, {
      nowMs,
      deterministic: true,
      personality: new PersonalityVector([0.2, 0.15, 0.45, 0.2]),
    });
    const resultHighS = scoreAllCandidates(tensionMap, G, 100, [], configHighS);

    const configLowS = buildIAUSConfig(G, tensionMap, {
      nowMs,
      deterministic: true,
      personality: new PersonalityVector([0.3, 0.3, 0.1, 0.3]),
    });
    const resultLowS = scoreAllCandidates(tensionMap, G, 100, [], configLowS);

    expect(resultHighS).not.toBeNull();
    expect(resultLowS).not.toBeNull();
    if (resultHighS && resultLowS) {
      const highSoc = resultHighS.scored.find(
        (s) => s.action === "sociability" && s.target === "channel:a",
      );
      const lowSoc = resultLowS.scored.find(
        (s) => s.action === "sociability" && s.target === "channel:a",
      );
      expect(highSoc).toBeDefined();
      expect(lowSoc).toBeDefined();
      if (highSoc && lowSoc) {
        expect(highSoc.V).toBeGreaterThan(lowSoc.V);
      }
    }
  });

  it("curveModulationStrength=0 → 人格不影响 specialist 曲线（退化测试）", () => {
    const G = buildGraph([{ id: "channel:a", tierContact: 5 }]);
    const tensionMap = new Map([["channel:a", tension({ tau1: 0.5, tau3: 0.3 })]]);

    const configA = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:a": 10 } },
      deterministic: true,
      personality: new PersonalityVector([0.45, 0.2, 0.2, 0.15]),
      curveModulationStrength: 0,
    });
    const resultA = scoreAllCandidates(tensionMap, G, 100, [], configA);

    const configB = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:a": 10 } },
      deterministic: true,
      personality: new PersonalityVector([0.1, 0.3, 0.3, 0.3]),
      curveModulationStrength: 0,
    });
    const resultB = scoreAllCandidates(tensionMap, G, 100, [], configB);

    expect(resultA).not.toBeNull();
    expect(resultB).not.toBeNull();
    if (resultA && resultB) {
      // strength=0 时，不同人格的 diligence 得分应相同（因为 U_personality 已移除，
      // 且曲线调制强度为 0）
      const dA = resultA.scored.find((s) => s.action === "diligence" && s.target === "channel:a");
      const dB = resultB.scored.find((s) => s.action === "diligence" && s.target === "channel:a");
      expect(dA).toBeDefined();
      expect(dB).toBeDefined();
      if (dA && dB) {
        expect(dA.V).toBeCloseTo(dB.V, 5);
      }
    }
  });

  it("U_personality 不在 considerations 中", () => {
    const G = buildGraph([{ id: "channel:a", tierContact: 5 }]);
    const tensionMap = new Map([["channel:a", tension({ tau1: 0.5 })]]);
    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:a": 10 } },
    });
    const result = scoreAllCandidates(tensionMap, G, 100, [], config);

    expect(result).not.toBeNull();
    if (result) {
      // winner candidate 不含 U_personality
      expect("U_personality" in result.candidate.considerations).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. ADR-185 §1: Desire Boost
// ═══════════════════════════════════════════════════════════════════════════

describe("ADR-185: Desire Boost", () => {
  const nowMs = BASE_NOW_MS;

  it("有匹配 desire → 得分提升", () => {
    const G = buildGraph([{ id: "channel:a", tierContact: 5 }]);
    const tensionMap = new Map([["channel:a", tension({ tau1: 1.0 })]]);

    // 无 desire
    const configBase = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:a": 10 } },
      deterministic: true,
    });
    const resultBase = scoreAllCandidates(tensionMap, G, 100, [], configBase);

    // 有匹配 desire
    const desires: Desire[] = [
      { type: "reduce_backlog", targetId: "channel:a", urgency: 0.8, label: "reduce backlog" },
    ];
    const configDesire = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:a": 10 } },
      deterministic: true,
      desires,
      desireBoost: 0.15,
    });
    const resultDesire = scoreAllCandidates(tensionMap, G, 100, [], configDesire);

    expect(resultBase).not.toBeNull();
    expect(resultDesire).not.toBeNull();
    if (resultBase && resultDesire) {
      // 所有 action types 对 channel:a 的得分都应提升
      for (const action of ["diligence", "curiosity", "sociability"]) {
        const base = resultBase.scored.find((s) => s.action === action && s.target === "channel:a");
        const boosted = resultDesire.scored.find(
          (s) => s.action === action && s.target === "channel:a",
        );
        if (base && boosted) {
          expect(boosted.V).toBeGreaterThan(base.V);
        }
      }
    }
  });

  it("desireBoost=0 → 无影响", () => {
    const G = buildGraph([{ id: "channel:a", tierContact: 5 }]);
    const tensionMap = new Map([["channel:a", tension({ tau1: 1.0 })]]);

    const configBase = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:a": 10 } },
      deterministic: true,
    });
    const resultBase = scoreAllCandidates(tensionMap, G, 100, [], configBase);

    const desires: Desire[] = [
      { type: "reduce_backlog", targetId: "channel:a", urgency: 1.0, label: "reduce backlog" },
    ];
    const configZero = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:a": 10 } },
      deterministic: true,
      desires,
      desireBoost: 0,
    });
    const resultZero = scoreAllCandidates(tensionMap, G, 100, [], configZero);

    expect(resultBase).not.toBeNull();
    expect(resultZero).not.toBeNull();
    if (resultBase && resultZero) {
      const baseDiligence = resultBase.scored.find(
        (s) => s.action === "diligence" && s.target === "channel:a",
      );
      const zeroDiligence = resultZero.scored.find(
        (s) => s.action === "diligence" && s.target === "channel:a",
      );
      if (baseDiligence && zeroDiligence) {
        expect(zeroDiligence.V).toBeCloseTo(baseDiligence.V, 10);
      }
    }
  });

  it("无匹配 desire → 无影响", () => {
    const G = buildGraph([{ id: "channel:a", tierContact: 5 }]);
    const tensionMap = new Map([["channel:a", tension({ tau1: 1.0 })]]);

    const configBase = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:a": 10 } },
      deterministic: true,
    });
    const resultBase = scoreAllCandidates(tensionMap, G, 100, [], configBase);

    // desire 指向不同 target
    const desires: Desire[] = [
      {
        type: "reconnect",
        targetId: "channel:nonexistent",
        urgency: 1.0,
        label: "reconnect with X",
      },
    ];
    const configMismatch = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:a": 10 } },
      deterministic: true,
      desires,
      desireBoost: 0.15,
    });
    const resultMismatch = scoreAllCandidates(tensionMap, G, 100, [], configMismatch);

    expect(resultBase).not.toBeNull();
    expect(resultMismatch).not.toBeNull();
    if (resultBase && resultMismatch) {
      const baseDiligence = resultBase.scored.find(
        (s) => s.action === "diligence" && s.target === "channel:a",
      );
      const mismatchDiligence = resultMismatch.scored.find(
        (s) => s.action === "diligence" && s.target === "channel:a",
      );
      if (baseDiligence && mismatchDiligence) {
        expect(mismatchDiligence.V).toBeCloseTo(baseDiligence.V, 10);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 13. assembleIAUSReason with desire — ADR-185 §1
// ═══════════════════════════════════════════════════════════════════════════

describe("assembleIAUSReason with desire", () => {
  const baseCandidate: IAUSCandidate = {
    action: "diligence",
    target: "channel:test",
    focalEntities: ["channel:test"],
    netValue: 0.6,
    deltaP: 0.5,
    socialCost: 0.3,
    considerations: {},
    bypassGates: false,
  };

  it("有 desire → reason 首项含 desire 标签", () => {
    const desire: Desire = {
      type: "fulfill_duty",
      targetId: "channel:test",
      urgency: 0.8,
      label: "reply to 小明",
    };
    const reason = assembleIAUSReason(baseCandidate, 0.8, 0.05, 0.75, desire);
    expect(reason).toMatch(/^desire: reply to 小明/);
    expect(reason).toContain("urgency=");
    expect(reason).toContain("pressure=");
  });

  it("无 desire → reason 不含 desire 前缀", () => {
    const reason = assembleIAUSReason(baseCandidate, 0.8, 0.05, 0.75);
    expect(reason).not.toContain("desire:");
    expect(reason).toMatch(/^pressure=/);
  });

  it("无 desire（undefined 参数）→ reason 不变", () => {
    const reason = assembleIAUSReason(baseCandidate, 0.8, 0.05, 0.75, undefined);
    expect(reason).not.toContain("desire:");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 14. ADR-218 Phase 2: U_fairness — CFS-inspired 服务比例公平
// ═══════════════════════════════════════════════════════════════════════════

describe("ADR-218 Phase 2: U_fairness — service-ratio fairness", () => {
  const nowMs = BASE_NOW_MS;

  it("冷启动（无服务历史）→ U_fairness 不应用", () => {
    const G = buildGraph([{ id: "channel:a", tierContact: 5 }]);
    const tensionMap = new Map([["channel:a", tension({ tau1: 1.0 })]]);

    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:a": 10 } },
      deterministic: true,
    });
    // 空 recentActions → totalService < min threshold → 跳过
    const result = scoreAllCandidates(tensionMap, G, 100, [], config);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.candidate.considerations.U_fairness).toBeUndefined();
    }
  });

  it("过服务目标被惩罚：同等 tension 下 overserved V < starved V", () => {
    const G = buildGraph([
      { id: "channel:overserved", tierContact: 50 },
      { id: "channel:starved", tierContact: 50 },
    ]);
    const t = tension({ tau1: 1.0 });
    const tensionMap = new Map([
      ["channel:overserved", t],
      ["channel:starved", t],
    ]);

    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:overserved": 10, "channel:starved": 10 } },
      deterministic: true,
    });

    // overserved: 8 次, starved: 2 次 (total=10 >= threshold=5)
    const wMs = config.windowStartMs;
    const recentActions = [
      ...Array.from({ length: 8 }, (_, i) => ({
        tick: 90 + i,
        action: "sociability" as const,
        ms: wMs + 1000 * (i + 1),
        target: "channel:overserved",
      })),
      ...Array.from({ length: 2 }, (_, i) => ({
        tick: 98 + i,
        action: "sociability" as const,
        ms: wMs + 9000 + 1000 * i,
        target: "channel:starved",
      })),
    ];

    const result = scoreAllCandidates(tensionMap, G, 100, recentActions, config);
    expect(result).not.toBeNull();
    if (result) {
      const overV = Math.max(
        ...result.scored.filter((s) => s.target === "channel:overserved").map((s) => s.V),
      );
      const starV = Math.max(
        ...result.scored.filter((s) => s.target === "channel:starved").map((s) => s.V),
      );
      // starved 获得 U_fairness boost，overserved 获得 penalty
      expect(starV).toBeGreaterThan(overV);
    }
  });

  it("U_fairness 幂律强度：8:2 服务比下 V 差距 > 3x", () => {
    const G = buildGraph([
      { id: "channel:a", tierContact: 50 },
      { id: "channel:b", tierContact: 50 },
    ]);
    const t = tension({ tau1: 1.0 });
    const tensionMap = new Map([
      ["channel:a", t],
      ["channel:b", t],
    ]);
    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:a": 10, "channel:b": 10 } },
      deterministic: true,
    });

    const wMs = config.windowStartMs;
    const recentActions = [
      ...Array.from({ length: 8 }, (_, i) => ({
        tick: 90 + i,
        action: "sociability" as const,
        ms: wMs + 1000 * (i + 1),
        target: "channel:a",
      })),
      ...Array.from({ length: 2 }, (_, i) => ({
        tick: 98 + i,
        action: "sociability" as const,
        ms: wMs + 9000 + 1000 * i,
        target: "channel:b",
      })),
    ];

    const result = scoreAllCandidates(tensionMap, G, 100, recentActions, config);
    expect(result).not.toBeNull();
    if (result) {
      const aV = result.scored.find((s) => s.target === "channel:a")?.V ?? 0;
      const bV = result.scored.find((s) => s.target === "channel:b")?.V ?? 0;
      // b 欠服务 (ratio≈0.4) → U_fairness=4.0, a 过服务 (ratio≈1.6) → U_fairness≈0.39
      // 差距 ≈ 4.0/0.39 ≈ 10x，但被 V_raw 缓冲后至少 3x
      expect(bV / Math.max(aV, 1e-6)).toBeGreaterThan(3);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 14b. ADR-219 D1: U_voice_affinity — cross-voice inhibition
// ═══════════════════════════════════════════════════════════════════════════

describe("ADR-219 D1: U_voice_affinity — cross-voice pressure dominance", () => {
  const nowMs = BASE_NOW_MS;

  it("high τ₅ target → diligence 的 U_voice_affinity 最高", () => {
    const G = buildGraph([{ id: "channel:obligated", tierContact: 50 }]);
    // τ₅ 高（义务），τ₃/τ₆ 低
    const tensionMap = new Map([
      ["channel:obligated", tension({ tau5: 2.0, tau3: 0.1, tau6: 0.1, tau1: 0.5, tau2: 0.1 })],
    ]);

    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P5: { "channel:obligated": 10 } },
      deterministic: true,
    });
    const result = scoreAllCandidates(tensionMap, G, 100, [], config);
    expect(result).not.toBeNull();
    if (result) {
      const diligence = result.scored.find(
        (s) => s.target === "channel:obligated" && s.action === "diligence",
      );
      const sociability = result.scored.find(
        (s) => s.target === "channel:obligated" && s.action === "sociability",
      );
      const curiosity = result.scored.find(
        (s) => s.target === "channel:obligated" && s.action === "curiosity",
      );
      expect(diligence).toBeDefined();
      expect(sociability).toBeDefined();
      expect(curiosity).toBeDefined();
      // diligence 应因 U_voice_affinity 而得分最高
      if (diligence && sociability && curiosity) {
        expect(diligence.V).toBeGreaterThan(sociability.V);
        expect(diligence.V).toBeGreaterThan(curiosity.V);
      }
    }
  });

  it("high τ₃ target → sociability 的 U_voice_affinity 最高", () => {
    const G = buildGraph([{ id: "channel:cooling", tierContact: 50 }]);
    const tensionMap = new Map([
      ["channel:cooling", tension({ tau3: 2.0, tau5: 0.05, tau6: 0.1, tau1: 0.05, tau2: 0.1 })],
    ]);

    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P3: { "channel:cooling": 10 } },
      deterministic: true,
    });
    const result = scoreAllCandidates(tensionMap, G, 100, [], config);
    expect(result).not.toBeNull();
    if (result) {
      const soc = result.scored.find(
        (s) => s.target === "channel:cooling" && s.action === "sociability",
      );
      const dil = result.scored.find(
        (s) => s.target === "channel:cooling" && s.action === "diligence",
      );
      expect(soc).toBeDefined();
      expect(dil).toBeDefined();
      if (soc && dil) {
        expect(soc.V).toBeGreaterThan(dil.V);
      }
    }
  });

  it("均匀压力 → U_voice_affinity 接近中性（不过度偏向某 voice）", () => {
    const G = buildGraph([{ id: "channel:balanced", tierContact: 50 }]);
    // 三个 voice 的主要维度信号相当
    const tensionMap = new Map([
      ["channel:balanced", tension({ tau5: 0.5, tau3: 0.5, tau6: 0.5, tau1: 0.5, tau2: 0.5 })],
    ]);

    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:balanced": 5 }, P3: { "channel:balanced": 5 } },
      deterministic: true,
    });
    const result = scoreAllCandidates(tensionMap, G, 100, [], config);
    expect(result).not.toBeNull();
    if (result) {
      const voices = result.scored.filter((s) => s.target === "channel:balanced");
      const scores = voices.map((v) => v.V);
      // 最高分和最低分之间差距不应超过 3x（均匀时 U_voice_affinity 接近 0.5）
      expect(Math.max(...scores) / Math.max(Math.min(...scores), 1e-6)).toBeLessThan(3);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 15. ADR-251: 热聊安全的 proactive pacing
// ═══════════════════════════════════════════════════════════════════════════

describe("ADR-251: computeProactivePacingUtility — hot-chat-safe damping", () => {
  const nowMs = BASE_NOW_MS;

  it("directed/bypass → 不阻尼", () => {
    expect(
      computeProactivePacingUtility({
        chatType: "private",
        bypassGates: true,
        nowMs,
        lastProactiveOutreachMs: nowMs - 1_000,
        consecutiveOutgoing: 5,
      }),
    ).toBe(1.0);
  });

  it("private hot chat: 对方最后发言晚于 Alice 最后发言 → 不阻尼", () => {
    expect(
      computeProactivePacingUtility({
        chatType: "private",
        bypassGates: false,
        nowMs,
        lastIncomingMs: nowMs - 10_000,
        lastOutgoingMs: nowMs - 30_000,
        lastProactiveOutreachMs: nowMs - 20_000,
        consecutiveOutgoing: 3,
      }),
    ).toBe(1.0);
  });

  it("unsolicited private proactive: 60s 内重复主动外展 → 闭环软阻尼", () => {
    expect(
      computeProactivePacingUtility({
        chatType: "private",
        bypassGates: false,
        nowMs,
        lastIncomingMs: nowMs - 300_000,
        lastOutgoingMs: nowMs - 30_000,
        lastProactiveOutreachMs: nowMs - 30_000,
        consecutiveOutgoing: 1,
      }),
    ).toBeCloseTo(0.4, 6);
  });

  it("unsolicited private proactive: 单方连续输出 >= 2 → 连续软阻尼", () => {
    expect(
      computeProactivePacingUtility({
        chatType: "private",
        bypassGates: false,
        nowMs,
        lastIncomingMs: nowMs - 300_000,
        lastOutgoingMs: nowMs - 90_000,
        lastProactiveOutreachMs: nowMs - 120_000,
        consecutiveOutgoing: 2,
      }),
    ).toBeCloseTo(1 / 3.5, 6);
  });

  it("group/channel → 不阻尼", () => {
    expect(
      computeProactivePacingUtility({
        chatType: "supergroup",
        bypassGates: false,
        nowMs,
        lastProactiveOutreachMs: nowMs - 1_000,
        consecutiveOutgoing: 3,
      }),
    ).toBe(1.0);
    expect(
      computeProactivePacingUtility({
        chatType: "channel",
        bypassGates: false,
        nowMs,
        lastProactiveOutreachMs: nowMs - 1_000,
        consecutiveOutgoing: 3,
      }),
    ).toBe(1.0);
  });
});

describe("ADR-251: scoreAllCandidates integrates U_proactive_pacing post-CF", () => {
  const nowMs = BASE_NOW_MS;

  it("hot chat target beats otherwise equal recent unsolicited proactive target", () => {
    const G = buildGraph([
      { id: "channel:hot", tierContact: 50, chatType: "private" },
      { id: "channel:cold", tierContact: 50, chatType: "private" },
    ]);
    G.setDynamic("channel:hot", "last_outgoing_ms", nowMs - 30_000);
    G.setDynamic("channel:hot", "last_incoming_ms", nowMs - 10_000);
    G.setDynamic("channel:hot", "last_proactive_outreach_ms", nowMs - 20_000);
    G.setDynamic("channel:cold", "last_outgoing_ms", nowMs - 30_000);
    G.setDynamic("channel:cold", "last_incoming_ms", nowMs - 300_000);
    G.setDynamic("channel:cold", "last_proactive_outreach_ms", nowMs - 20_000);

    const t = tension({ tau1: 1.0, tau3: 1.0, tau6: 0.5 });
    const tensionMap = new Map([
      ["channel:hot", t],
      ["channel:cold", t],
    ]);
    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:hot": 10, "channel:cold": 10 } },
      deterministic: true,
    });

    const result = scoreAllCandidates(tensionMap, G, 100, [], config);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.candidate.target).toBe("channel:hot");
      expect(result.candidate.considerations.U_proactive_pacing).toBe(1.0);

      const hotV = Math.max(
        ...result.scored.filter((s) => s.target === "channel:hot").map((s) => s.V),
      );
      const coldV = Math.max(
        ...result.scored.filter((s) => s.target === "channel:cold").map((s) => s.V),
      );
      expect(hotV).toBeGreaterThan(coldV * 2);
    }
  });

  it("directed candidate keeps U_proactive_pacing=1 even with recent proactive timestamp", () => {
    const G = buildGraph([
      { id: "channel:directed", tierContact: 50, chatType: "private", pendingDirected: 1 },
    ]);
    setObligation(G, "channel:directed", 1, nowMs);
    G.setDynamic("channel:directed", "last_outgoing_ms", nowMs - 30_000);
    G.setDynamic("channel:directed", "last_incoming_ms", nowMs - 300_000);
    G.setDynamic("channel:directed", "last_proactive_outreach_ms", nowMs - 10_000);
    G.setDynamic("channel:directed", "consecutive_outgoing", 5);

    const tensionMap = new Map([["channel:directed", tension({ tau1: 1.0, tau5: 1.5 })]]);
    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P5: { "channel:directed": 10 } },
      candidateCtx: buildCandidateCtx(G, nowMs),
      deterministic: true,
    });

    const result = scoreAllCandidates(tensionMap, G, 100, [], config);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.candidate.target).toBe("channel:directed");
      expect(result.winnerBypassGates).toBe(true);
      expect(result.candidate.considerations.U_proactive_pacing).toBe(1.0);
    }
  });
});

describe("IAUS inactivity stale utility", () => {
  const nowMs = 2_000_000_000;

  it("keeps bypass, group, and unknown-last-incoming candidates neutral", () => {
    expect(
      computeInactivityStaleUtility({
        chatType: "private",
        bypassGates: true,
        nowMs,
        lastIncomingMs: nowMs - 30 * 24 * 3600_000,
      }),
    ).toBe(1.0);
    expect(
      computeInactivityStaleUtility({
        chatType: "supergroup",
        bypassGates: false,
        nowMs,
        lastIncomingMs: nowMs - 30 * 24 * 3600_000,
      }),
    ).toBe(1.0);
    expect(
      computeInactivityStaleUtility({
        chatType: "private",
        bypassGates: false,
        nowMs,
      }),
    ).toBe(1.0);
  });

  it("softly downranks long-inactive private chats without making them unreachable", () => {
    expect(
      computeInactivityStaleUtility({
        chatType: "private",
        bypassGates: false,
        nowMs,
        lastIncomingMs: nowMs - 12 * 3600_000,
      }),
    ).toBe(1.0);
    expect(
      computeInactivityStaleUtility({
        chatType: "private",
        bypassGates: false,
        nowMs,
        lastIncomingMs: nowMs - 8 * 24 * 3600_000,
      }),
    ).toBeCloseTo(0.15, 6);
  });

  it("fresh private chat beats otherwise equal stale private chat", () => {
    const G = buildGraph([
      { id: "channel:fresh", tierContact: 50, chatType: "private" },
      { id: "channel:stale", tierContact: 50, chatType: "private" },
    ]);
    G.setDynamic("channel:fresh", "last_incoming_ms", nowMs - 12 * 3600_000);
    G.setDynamic("channel:stale", "last_incoming_ms", nowMs - 8 * 24 * 3600_000);

    const t = tension({ tau1: 1.0, tau3: 1.0 });
    const tensionMap = new Map([
      ["channel:fresh", t],
      ["channel:stale", t],
    ]);
    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:fresh": 10, "channel:stale": 10 } },
      deterministic: true,
    });

    const result = scoreAllCandidates(tensionMap, G, 100, [], config);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.candidate.target).toBe("channel:fresh");
      const stale = result.scored.find((entry) => entry.target === "channel:stale");
      expect(stale?.considerations.U_inactivity_stale).toBeCloseTo(0.15, 6);
    }
  });
});

describe("ADR-268: emotion proactive cap", () => {
  const nowMs = BASE_NOW_MS;

  it("keeps bypass and hot private chats neutral", () => {
    expect(
      computeEmotionProactiveCapUtility({
        chatType: "private",
        bypassGates: true,
        proactiveCap: 1,
        consecutiveOutgoing: 5,
      }),
    ).toBe(1.0);
    expect(
      computeEmotionProactiveCapUtility({
        chatType: "private",
        bypassGates: false,
        proactiveCap: 1,
        consecutiveOutgoing: 5,
        lastIncomingMs: nowMs - 1_000,
        lastOutgoingMs: nowMs - 5_000,
      }),
    ).toBe(1.0);
  });

  it("downranks unsolicited private outreach after lonely cap is exceeded", () => {
    expect(
      computeEmotionProactiveCapUtility({
        chatType: "private",
        bypassGates: false,
        proactiveCap: 1,
        consecutiveOutgoing: 1,
        lastIncomingMs: nowMs - 60_000,
        lastOutgoingMs: nowMs - 10_000,
      }),
    ).toBe(1.0);
    expect(
      computeEmotionProactiveCapUtility({
        chatType: "private",
        bypassGates: false,
        proactiveCap: 1,
        consecutiveOutgoing: 2,
        lastIncomingMs: nowMs - 60_000,
        lastOutgoingMs: nowMs - 10_000,
      }),
    ).toBeCloseTo(0.2, 6);
  });

  it("scoreAllCandidates records U_emotion_proactive_cap and prefers non-chasing target", () => {
    const G = buildGraph([
      { id: "channel:waiting", tierContact: 50, chatType: "private" },
      { id: "channel:fresh", tierContact: 50, chatType: "private" },
    ]);
    G.setDynamic("channel:waiting", "last_outgoing_ms", nowMs - 10_000);
    G.setDynamic("channel:waiting", "last_incoming_ms", nowMs - 300_000);
    G.setDynamic("channel:waiting", "consecutive_outgoing", 2);
    G.setDynamic("channel:fresh", "last_outgoing_ms", nowMs - 20_000);
    G.setDynamic("channel:fresh", "last_incoming_ms", nowMs - 5_000);
    G.addContact("contact:friend", { display_name: "Friend" });
    G.setDynamic(
      "self",
      "emotion_episodes",
      JSON.stringify([
        {
          id: "lonely",
          kind: "lonely",
          valence: -0.45,
          arousal: 0.35,
          intensity: 0.8,
          cause: { type: "silence", targetId: "contact:friend", summary: "waiting after check-in" },
          createdAtMs: nowMs,
          halfLifeMs: 2 * 60 * 60_000,
          confidence: 0.8,
        },
      ]),
    );

    const t = tension({ tau1: 1.0, tau3: 1.0 });
    const tensionMap = new Map([
      ["channel:waiting", t],
      ["channel:fresh", t],
    ]);
    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:waiting": 10, "channel:fresh": 10 } },
      deterministic: true,
    });

    const result = scoreAllCandidates(tensionMap, G, 100, [], config);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.candidate.target).toBe("channel:fresh");
      const waiting = result.scored.find((entry) => entry.target === "channel:waiting");
      expect(waiting?.considerations.U_emotion_proactive_cap).toBeCloseTo(0.2, 6);
    }
  });
});

describe("ADR-268: emotion action utility", () => {
  const nowMs = BASE_NOW_MS;
  const hurtControl = {
    voiceBias: { sociability: -0.08, caution: 0.2, reflection: 0.08 },
    actionCaps: { proactiveMessages: null },
    styleBudget: {
      maxCharsMultiplier: 0.75,
      preferShort: true,
      allowVulnerability: false,
      avoidSelfProof: true,
      avoidCruelty: true,
    },
  };

  it("keeps bypass obligations neutral and softly downranks non-obligatory sociability", () => {
    expect(
      computeEmotionActionUtility({
        actionType: "sociability",
        chatType: "private",
        bypassGates: true,
        control: hurtControl,
      }),
    ).toBe(1.0);
    expect(
      computeEmotionActionUtility({
        actionType: "sociability",
        chatType: "private",
        bypassGates: false,
        control: hurtControl,
      }),
    ).toBeLessThan(1.0);
  });

  it("scoreAllCandidates records U_emotion_action for active hurt state", () => {
    const G = buildGraph([{ id: "channel:social", tierContact: 50, chatType: "private" }]);
    G.setDynamic(
      "self",
      "emotion_episodes",
      JSON.stringify([
        {
          id: "hurt",
          kind: "hurt",
          valence: -0.6,
          arousal: 0.45,
          intensity: 0.8,
          cause: { type: "feedback", evidenceId: "1", summary: "sharp pushback" },
          createdAtMs: nowMs,
          halfLifeMs: 3 * 60 * 60_000,
          confidence: 0.8,
        },
      ]),
    );

    const t = tension({ tau3: 1.0 });
    const tensionMap = new Map([["channel:social", t]]);
    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P3: { "channel:social": 10 } },
      deterministic: true,
    });

    const result = scoreAllCandidates(tensionMap, G, 100, [], config);
    expect(result).not.toBeNull();
    const social = result?.scored.find(
      (entry) => entry.target === "channel:social" && entry.action === "sociability",
    );
    expect(social?.considerations.U_emotion_action).toBeLessThan(1.0);
  });
});

describe("ADR-261 Wave 3: rhythm timing shadow utility", () => {
  const nowMs = BASE_NOW_MS;

  it("eligible profile computes shadow utility without changing IAUS score", () => {
    const G = buildGraph([{ id: "channel:quiet", tierContact: 50, chatType: "private" }]);
    const tensionMap = new Map([["channel:quiet", tension({ tau1: 1.0, tau3: 1.0 })]]);
    const baseConfig = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:quiet": 10 } },
      deterministic: true,
    });
    const shadowConfig = buildIAUSConfig(G, tensionMap, {
      ...baseConfig,
      candidateCtx: buildCandidateCtx(G, nowMs, {
        getRhythmTimingProfile: () => ({
          activeNowScore: 0.05,
          quietNowScore: 0.95,
          confidence: "high",
          stale: false,
        }),
      }),
    });

    const base = scoreAllCandidates(tensionMap, G, 100, [], baseConfig);
    const shadow = scoreAllCandidates(tensionMap, G, 100, [], shadowConfig);

    expect(base).not.toBeNull();
    expect(shadow).not.toBeNull();
    if (base && shadow) {
      expect(shadow.bestV).toBeCloseTo(base.bestV, 8);
      expect(shadow.candidate.diagnostics?.timingShadow?.reason).toBe("eligible");
      expect(shadow.candidate.diagnostics?.timingShadow?.utility).toBeLessThan(1);
      expect(shadow.candidate.diagnostics?.timingShadow?.shadowNetValue).toBeLessThan(shadow.bestV);
    }
  });

  it("directed / continuation bypass keeps timing shadow neutral", () => {
    const G = buildGraph([
      { id: "channel:directed", tierContact: 50, chatType: "private", pendingDirected: 1 },
    ]);
    setObligation(G, "channel:directed", 1, nowMs);

    const tensionMap = new Map([["channel:directed", tension({ tau1: 1.0, tau5: 1.5 })]]);
    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P5: { "channel:directed": 10 } },
      candidateCtx: buildCandidateCtx(G, nowMs, {
        getRhythmTimingProfile: () => ({
          activeNowScore: 0,
          quietNowScore: 1,
          confidence: "high",
          stale: false,
        }),
      }),
      deterministic: true,
    });

    const result = scoreAllCandidates(tensionMap, G, 100, [], config);

    expect(result).not.toBeNull();
    if (result) {
      const timing = result.candidate.diagnostics?.timingShadow;
      expect(result.winnerBypassGates).toBe(true);
      expect(timing?.reason).toBe("bypass");
      expect(timing?.utility).toBe(1.0);
      expect(timing?.shadowNetValue).toBeCloseTo(result.bestV, 8);
    }
  });

  it("low confidence, stale, missing profile, and group chat stay neutral", () => {
    expect(
      computeTimingShadowUtility({
        chatType: "private",
        bypassGates: false,
        profile: { activeNowScore: 1, quietNowScore: 0, confidence: "low", stale: false },
      }),
    ).toMatchObject({ utility: 1.0, applied: false, reason: "low_confidence" });

    expect(
      computeTimingShadowUtility({
        chatType: "private",
        bypassGates: false,
        profile: { activeNowScore: 1, quietNowScore: 0, confidence: "high", stale: true },
      }),
    ).toMatchObject({ utility: 1.0, applied: false, reason: "stale" });

    expect(
      computeTimingShadowUtility({ chatType: "private", bypassGates: false, profile: null }),
    ).toMatchObject({ utility: 1.0, applied: false, reason: "missing_profile" });

    expect(
      computeTimingShadowUtility({
        chatType: "supergroup",
        bypassGates: false,
        profile: { activeNowScore: 1, quietNowScore: 0, confidence: "high", stale: false },
      }),
    ).toMatchObject({ utility: 1.0, applied: false, reason: "unsupported_chat_type" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 16. ADR-186: computeCandidateBypass — @ signal guarantee
// ═══════════════════════════════════════════════════════════════════════════

describe("ADR-186: computeCandidateBypass — @ signal guarantee", () => {
  const nowMs = BASE_NOW_MS;

  it("pending_directed > 0 → bypass=true（即使义务已衰减到 0.1）", () => {
    const G = buildGraph([{ id: "channel:grp", chatType: "group", pendingDirected: 1 }]);
    // 设置很久以前的 last_directed_ms → 义务衰减到接近 0
    G.setDynamic("channel:grp", "last_directed_ms", nowMs - 10_000_000);
    const ctx = buildCandidateCtx(G, nowMs);
    // 即使义务已衰减，但 raw pending_directed > 0 → bypass
    expect(computeCandidateBypass(ctx, "channel:grp")).toBe(true);
  });

  it("pending_directed = 0 + 高衰减义务 → bypass=true（原有路径）", () => {
    const G = buildGraph([{ id: "channel:conv" }]);
    // 无 pending_directed 但有活跃对话
    addConversation(G, "channel:conv", "active", "alice_turn");
    const ctx = buildCandidateCtx(G, nowMs);
    expect(computeCandidateBypass(ctx, "channel:conv")).toBe(true);
  });

  it("pending_directed = 0 + 低衰减义务 + 无对话延续 → bypass=false", () => {
    const G = buildGraph([{ id: "channel:plain" }]);
    const ctx = buildCandidateCtx(G, nowMs);
    expect(computeCandidateBypass(ctx, "channel:plain")).toBe(false);
  });

  it("permanent failure → bypass=false（即使有 pending_directed）", () => {
    const G = buildGraph([{ id: "channel:dead", pendingDirected: 3 }]);
    G.setDynamic("channel:dead", "failure_type", "permanent");
    setObligation(G, "channel:dead", 3, nowMs);
    const ctx = buildCandidateCtx(G, nowMs);
    expect(computeCandidateBypass(ctx, "channel:dead")).toBe(false);
  });

  it("conversation continuation → bypass=true", () => {
    const G = buildGraph([{ id: "channel:active" }]);
    addConversation(G, "channel:active", "active", "alice_turn");
    const ctx = buildCandidateCtx(G, nowMs);
    expect(computeCandidateBypass(ctx, "channel:active")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 16. ADR-189: Bot scope rate cap
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// ADR-189 蟑螂审计 Test 4: Crisis mode IAUS pre-filter (GAP-5, P1)
// ═══════════════════════════════════════════════════════════════════════════

describe("ADR-189 蟑螂审计: Crisis mode pre-filter (GAP-5, P1)", () => {
  const nowMs = BASE_NOW_MS;

  it("(a) crisisChannels 包含 target + bypass=false → 候选被过滤", () => {
    const G = buildGraph([{ id: "channel:crisis", tierContact: 5 }]);
    const tensionMap = new Map([["channel:crisis", tension({ tau1: 1.0, tau3: 0.5 })]]);

    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:crisis": 20 } },
      crisisChannels: ["channel:crisis"],
      deterministic: true,
    });
    const result = scoreAllCandidates(tensionMap, G, 100, [], config);

    // 无义务 → bypass=false → crisis pre-filter 拦截所有候选
    expect(result).toBeNull();
  });

  it("(b) crisisChannels 包含 target + bypass=true(pending_directed) → 候选存活", () => {
    const G = buildGraph([{ id: "channel:crisis", tierContact: 5, pendingDirected: 2 }]);
    setObligation(G, "channel:crisis", 2, nowMs);
    const tensionMap = new Map([["channel:crisis", tension({ tau1: 1.0, tau5: 0.8 })]]);

    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:crisis": 20 } },
      candidateCtx: buildCandidateCtx(G, nowMs),
      crisisChannels: ["channel:crisis"],
      deterministic: true,
    });
    const result = scoreAllCandidates(tensionMap, G, 100, [], config);

    // 有义务 → bypass=true → crisis pre-filter 放行
    expect(result).not.toBeNull();
    if (result) {
      expect(result.candidate.target).toBe("channel:crisis");
      expect(result.winnerBypassGates).toBe(true);
    }
  });

  it("(c) crisisChannels 不包含 target → 候选存活", () => {
    const G = buildGraph([{ id: "channel:safe", tierContact: 5 }]);
    const tensionMap = new Map([["channel:safe", tension({ tau1: 1.0, tau3: 0.5 })]]);

    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:safe": 20 } },
      crisisChannels: ["channel:other-crisis"],
      deterministic: true,
    });
    const result = scoreAllCandidates(tensionMap, G, 100, [], config);

    // target 不在 crisisChannels → 不受影响
    expect(result).not.toBeNull();
    if (result) {
      expect(result.candidate.target).toBe("channel:safe");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ADR-189 蟑螂审计 Test 5: Class rate cap cross-class isolation (GAP-6, P1)
// ═══════════════════════════════════════════════════════════════════════════

describe("ADR-189 蟑螂审计: Class rate cap cross-class isolation (GAP-6, P1)", () => {
  const nowMs = BASE_NOW_MS;

  it("private 满额 + group 未满额 → private 候选被过滤，group 存活，winner 来自 group", () => {
    // 3 private + 2 group channels
    const G = buildGraph([
      { id: "channel:pm1", tierContact: 5, chatType: "private" },
      { id: "channel:pm2", tierContact: 5, chatType: "private" },
      { id: "channel:pm3", tierContact: 5, chatType: "private" },
      { id: "channel:grp1", tierContact: 50, chatType: "group" },
      { id: "channel:grp2", tierContact: 50, chatType: "group" },
    ]);

    const tensionMap = new Map([
      ["channel:pm1", tension({ tau1: 2.0, tau3: 1.0 })],
      ["channel:pm2", tension({ tau1: 1.5, tau3: 0.8 })],
      ["channel:pm3", tension({ tau1: 1.0 })],
      ["channel:grp1", tension({ tau1: 0.8, tau3: 0.5 })],
      ["channel:grp2", tension({ tau1: 0.5 })],
    ]);

    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: {
        P1: {
          "channel:pm1": 30,
          "channel:pm2": 20,
          "channel:pm3": 10,
          "channel:grp1": 15,
          "channel:grp2": 8,
        },
      },
      deterministic: true,
      // private 已满额，group 未满额
      classRateCaps: { private: 8, group: 8, channel: 8, bot: 0 },
      classActionCounts: { private: 10, group: 2, channel: 0, bot: 0 },
    });
    const result = scoreAllCandidates(tensionMap, G, 100, [], config);

    expect(result).not.toBeNull();
    if (result) {
      // private 候选全部被 class rate cap 过滤，winner 来自 group
      expect(
        result.candidate.target === "channel:grp1" || result.candidate.target === "channel:grp2",
      ).toBe(true);

      // scored 中不应有 private 候选（全被过滤）
      const privateScored = result.scored.filter((s) => s.target?.startsWith("channel:pm"));
      expect(privateScored.length).toBe(0);

      // group 候选应存在
      const groupScored = result.scored.filter((s) => s.target?.startsWith("channel:grp"));
      expect(groupScored.length).toBeGreaterThan(0);
    }
  });
});

describe("ADR-189: Bot scope rate cap", () => {
  const nowMs = BASE_NOW_MS;

  it("bot channel + rateCap.bot=0 → 被 pre-filter 跳过", () => {
    const G = buildGraph([{ id: "channel:bot", chatType: "private" }]);
    // 添加 bot contact
    G.addContact("contact:bot", { is_bot: true, tier: 150 });

    const tensionMap = new Map([["channel:bot", tension({ tau1: 1.0, tau3: 0.5 })]]);

    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:bot": 20 } },
      deterministic: true,
      classRateCaps: { private: 10, group: 8, channel: 8, bot: 0 },
      classActionCounts: { private: 0, group: 0, channel: 0, bot: 0 },
    });
    const result = scoreAllCandidates(tensionMap, G, 100, [], config);

    // bot scope rateCap=0，0 >= 0 恒 true → 所有 non-bypass bot 候选跳过
    expect(result).toBeNull();
  });

  it("bot channel + bypass(directed) → 仍可通过评分", () => {
    const G = buildGraph([{ id: "channel:bot", chatType: "private", pendingDirected: 2 }]);
    G.addContact("contact:bot", { is_bot: true, tier: 150 });
    setObligation(G, "channel:bot", 2, nowMs);

    const tensionMap = new Map([["channel:bot", tension({ tau1: 1.0, tau5: 0.8 })]]);

    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:bot": 20 } },
      candidateCtx: buildCandidateCtx(G, nowMs),
      deterministic: true,
      classRateCaps: { private: 10, group: 8, channel: 8, bot: 0 },
      classActionCounts: { private: 0, group: 0, channel: 0, bot: 0 },
    });
    const result = scoreAllCandidates(tensionMap, G, 100, [], config);

    // bypass 候选穿透 rateCap 限制
    expect(result).not.toBeNull();
    if (result) {
      expect(result.candidate.target).toBe("channel:bot");
      expect(result.winnerBypassGates).toBe(true);
    }
  });

  it("bot channel 不影响同时存在的 private channel", () => {
    const G = buildGraph([
      { id: "channel:bot", chatType: "private" },
      { id: "channel:human", chatType: "private" },
    ]);
    G.addContact("contact:bot", { is_bot: true, tier: 150 });
    G.addContact("contact:human", { is_bot: false, tier: 5 });

    const tensionMap = new Map([
      ["channel:bot", tension({ tau1: 2.0, tau3: 1.0 })],
      ["channel:human", tension({ tau1: 1.0, tau3: 0.5 })],
    ]);

    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P1: { "channel:bot": 30, "channel:human": 10 } },
      deterministic: true,
      classRateCaps: { private: 10, group: 8, channel: 8, bot: 0 },
      classActionCounts: { private: 0, group: 0, channel: 0, bot: 0 },
    });
    const result = scoreAllCandidates(tensionMap, G, 100, [], config);

    // bot 被过滤，human 仍有候选
    expect(result).not.toBeNull();
    if (result) {
      expect(result.candidate.target).toBe("channel:human");
    }
  });

  // ADR-206: 频道 action-type 门控
  it("channel 实体只能被 curiosity 选中，不能被 sociability 选中", () => {
    const G = buildGraph([{ id: "channel:feed", tierContact: 150, chatType: "channel" }]);
    // 高 tau3 → sociability 应该赢，但频道被门控
    const tensionMap = new Map([["channel:feed", tension({ tau1: 0.1, tau3: 5.0, tau5: 0.1 })]]);

    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P3: { "channel:feed": 50 } },
      deterministic: true,
      classRateCaps: { private: 10, group: 8, channel: 8, bot: 0 },
      classActionCounts: { private: 0, group: 0, channel: 0, bot: 0 },
    });
    const result = scoreAllCandidates(tensionMap, G, 100, [], config);

    // 如果有候选，一定是 curiosity（不是 sociability 或 diligence）
    if (result) {
      expect(result.candidate.action).toBe("curiosity");
    }
  });

  it("channel 实体的 sociability 候选被过滤", () => {
    // 只有频道，且只有 tau3 贡献 → sociability 被门控 → 应无 diligence 候选
    // 可能产生 curiosity 候选（如果 tau6 有值）
    const G = buildGraph([{ id: "channel:feed", tierContact: 150, chatType: "channel" }]);
    const tensionMap = new Map([["channel:feed", tension({ tau3: 5.0 })]]);

    const config = buildIAUSConfig(G, tensionMap, {
      nowMs,
      contributions: { P3: { "channel:feed": 50 } },
      deterministic: true,
      classRateCaps: { private: 10, group: 8, channel: 8, bot: 0 },
      classActionCounts: { private: 0, group: 0, channel: 0, bot: 0 },
    });
    const result = scoreAllCandidates(tensionMap, G, 100, [], config);

    // 纯 tau3 → sociability 被门控 → curiosity tau6=0 得分极低
    // 结果应为 null 或 curiosity（绝不是 sociability）
    if (result) {
      expect(result.candidate.action).not.toBe("sociability");
      expect(result.candidate.action).not.toBe("diligence");
    }
  });
});
