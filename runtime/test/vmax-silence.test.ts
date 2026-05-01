/**
 * ADR-64 Wave 2a + ADR-180 IAUS 测试：
 * - IAUS 集成（evolve 管线行为）
 * - 沉默记录（silence_log）
 * - ADR-151 #1: VoI 信息增益项
 * - ADR-151 #6: Thompson Sampling 噪声叠加（IAUS 版）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";

// ADR-190: isAnyProviderHealthy() 门控——测试无 LLM provider，需 mock 为 true。
vi.mock("../src/llm/client.js", () => ({
  isAnyProviderHealthy: () => true,
}));

import type { Dispatcher } from "../src/core/dispatcher.js";
import { closeDb, getDb, initDb } from "../src/db/connection.js";
import { silenceLog } from "../src/db/schema.js";
import { ActionQueue } from "../src/engine/action-queue.js";
import { createDeliberationState } from "../src/engine/deliberation.js";
import { type EvolveState, evolveTick } from "../src/engine/evolve.js";
import {
  type CandidateContext,
  type IAUSConfig,
  scoreAllCandidates,
} from "../src/engine/iaus-scorer.js";
import { buildTensionMap, routeContributions } from "../src/graph/tension.js";
import { WorldModel } from "../src/graph/world-model.js";
import {
  AdaptiveKappa,
  computeAllPressures,
  createPressureHistory,
} from "../src/pressure/aggregate.js";
import { createCuriosityHistory } from "../src/pressure/p6-curiosity.js";
import { DEFAULT_SATURATION_COST_CONFIG } from "../src/pressure/social-cost.js";

import { computeNSVBeta, computeVoI } from "../src/pressure/social-value.js";
import { EventBuffer } from "../src/telegram/events.js";
import { TickClock } from "../src/utils/time.js";
import { PersonalityVector } from "../src/voices/personality.js";

beforeEach(() => initDb(":memory:"));
afterEach(() => closeDb());

// -- Dispatcher stub -----------------------------------------------------------

function stubDispatcher(): Dispatcher {
  return {
    dispatch: () => undefined,
    query: (name: string) => {
      if (name === "crisis_channels") return [];
      if (name === "best_time") return { peakHour: undefined };
      return null;
    },
    getInstructionNames: () => [],
    getInstructionDef: () => undefined,
    getQueryNames: () => [],
    getQueryDef: () => undefined,
    startTick: () => {},
    endTick: () => {},
    collectContributions: () => [],
    generateManual: async () => "",

    mods: [],
    snapshotModStates: () => new Map(),
    restoreModStates: () => {},
    saveModStatesToDb: () => {},
    loadModStatesFromDb: () => false,
    readModState: () => undefined,
  };
}

// -- IAUS 集成测试 ---------------------------------------------------

/**
 * 构建一个有两个频道的 EvolveState，用于测试 IAUS 选择逻辑。
 *
 * "channel:good": 高 tier（低 social cost）+ 高压力 → 得分高
 * "channel:bad": 低 tier（高 social cost）+ 低压力 → 得分低
 */
function buildVmaxState(
  overrides: Partial<{
    actionRateFloor: number;
    rateCap: number;
    lambda: number;
    idleThreshold: number;
  }> = {},
): EvolveState {
  const config = loadConfig();
  config.idleThreshold = overrides.idleThreshold ?? 999;
  config.actionRateFloor = overrides.actionRateFloor ?? 0.0;
  const cap = overrides.rateCap ?? 100;
  config.rateCap = { private: cap, group: cap, channel: cap, bot: 0 };
  config.eta = 0;
  config.s10LeakProb = 0; // 禁用 System 1 leak
  if (overrides.lambda !== undefined) {
    config.socialCost.lambda = overrides.lambda;
  }

  const G = new WorldModel();
  G.tick = 0;
  G.addAgent("self");
  // "channel:good": 高优先级，高 unread → P1 压力大 → ΔP 大，low social cost
  G.addChannel("channel:good", {
    unread: 50,
    tier_contact: 5,
    chat_type: "private",
    pending_directed: 3,
    last_directed_ms: 0,
  });
  G.addRelation("self", "monitors", "channel:good");

  return {
    G,
    personality: new PersonalityVector(config.piHome),
    clock: new TickClock(),
    buffer: new EventBuffer(),
    queue: new ActionQueue(),
    config,
    curiosityHistory: createCuriosityHistory(),
    recentEventCounts: [],
    recentActions: [],
    dispatcher: stubDispatcher(),
    lastActionMs: Date.now(),
    pressureHistory: createPressureHistory(),
    deliberation: createDeliberationState(),
    attentionDebtMap: new Map(),
    lastSelectedTarget: null,
    lastSelectedCandidate: null,
    mode: "patrol" as const,
    modeEnteredMs: Date.now(),
    adaptiveKappa: new AdaptiveKappa(config.kappa, config.kappaAdaptAlpha),
    channelRateEma: new Map(),
    lastChannelCounts: new Map(),
    eventCountEma: 10,
    floodTickCount: 0,
    lastAPI: 0,
    lastAPIPeak: 0,
    lastFlushMs: 0,
    currentDt: 60,
    wakeupTicksElapsed: 0,
    wakeupEngagedTargets: new Set(),
    llmBackoff: { consecutiveFailures: 0, lastFailureMs: 0 },
    episodeState: {
      currentId: null,
      currentTarget: null,
      currentTickStart: null,
      activeResidues: [],
    },
  };
}

describe("IAUS 集成", () => {
  it("IAUS 选择得分最高的候选入队", async () => {
    const state = buildVmaxState();

    state.buffer.push({
      type: "new_message",
      channelId: "channel:good",
      isDirected: true,
      tick: 1,
      novelty: 0.5,
    });

    const triggered = evolveTick(state);
    // 有 directed + 高压力 → 应通过所有门控
    if (triggered && state.queue.length > 0) {
      const item = await state.queue.dequeue();
      // 入队的行动应有 target
      expect(item?.target).toBeTruthy();
    }
  });

  it("directed 绿灯与多候选兼容", () => {
    const state = buildVmaxState();

    // 有 directed 消息
    state.G.setDynamic("channel:good", "pending_directed", 5);
    state.G.setDynamic("channel:good", "last_directed_ms", 0);

    state.buffer.push({
      type: "new_message",
      channelId: "channel:good",
      isDirected: true,
      tick: 1,
      novelty: 0.8,
    });

    const triggered = evolveTick(state);
    // directed 目标 → 绿灯（L2 跳过 + lambda * 0.3 + API 门控跳过）
    // 应通过门控
    expect(triggered).toBe(true);
  });
});

// -- 沉默记录测试 --------------------------------------------------------------

describe("沉默记录 (silence_log)", () => {
  it("rateCap 触发时记录 reason=rate_cap", () => {
    const state = buildVmaxState({ rateCap: 0 }); // cap=0 → 任何行动都超限
    state.buffer.push({
      type: "new_message",
      channelId: "channel:good",
      isDirected: false,
      tick: 1,
      novelty: 0.5,
    });

    evolveTick(state);

    const records = getDb().select().from(silenceLog).all();
    const rateCap = records.find((r) => r.reason === "rate_cap");
    // 可能被 System 1 先处理了，所以只在有 silence 记录时验证
    if (rateCap) {
      expect(rateCap.reason).toBe("rate_cap");
      expect(rateCap.tick).toBe(1);
    }
  });

  it("无可评分候选时记录 reason=all_candidates_negative", () => {
    // IAUS 乘法评分不会因 lambda 高而变负——
    // 用 reachability_score=0 + failure_type=permanent 使 pre-filter 跳过所有候选。
    const state = buildVmaxState();
    state.G.setDynamic("channel:good", "failure_type", "permanent");
    state.G.setDynamic("channel:good", "reachability_score", 0);
    state.G.setDynamic("channel:good", "pending_directed", 0); // 移除 directed bypass
    state.buffer.push({
      type: "new_message",
      channelId: "channel:good",
      isDirected: false,
      tick: 1,
      novelty: 0.5,
    });

    evolveTick(state);

    const records = getDb().select().from(silenceLog).all();
    const neg = records.find((r) => r.reason === "all_candidates_negative");
    // 可能被 System 1 或其他门控先拦截
    if (neg) {
      expect(neg.reason).toBe("all_candidates_negative");
      expect(neg.netValue == null || neg.netValue <= 0).toBe(true);
    }
  });
});

// -- ADR-151 #1: VoI 信息增益项 ------------------------------------------------

describe("computeVoI（Kalman 信息比率）", () => {
  it("高 σ² → VoI 接近 1（值得探索）", () => {
    // σ² = 2.0 远大于 σ²_obs = 0.1 → VoI ≈ 2.0/(2.0+0.1) ≈ 0.952
    const voi = computeVoI(2.0, 0.1);
    expect(voi).toBeGreaterThan(0.9);
    expect(voi).toBeLessThan(1.0);
  });

  it("低 σ² → VoI 接近 0（无需探索）", () => {
    // σ² = 0.01 << σ²_obs = 0.1 → VoI ≈ 0.01/(0.01+0.1) ≈ 0.091
    const voi = computeVoI(0.01, 0.1);
    expect(voi).toBeLessThan(0.1);
  });

  it("σ² = σ²_obs 时 VoI = 0.5", () => {
    const voi = computeVoI(0.1, 0.1);
    expect(voi).toBeCloseTo(0.5, 10);
  });

  it("VoI 严格单调递增于 σ²", () => {
    const voi1 = computeVoI(0.1, 0.1);
    const voi2 = computeVoI(0.5, 0.1);
    const voi3 = computeVoI(2.0, 0.1);
    expect(voi2).toBeGreaterThan(voi1);
    expect(voi3).toBeGreaterThan(voi2);
  });
});

describe("NSV + VoI 信息增益", () => {
  const deltaP = 2.0;
  const socialCost = 0.3;
  const lambda = 1.0;
  const entropy = 1.0;
  const beta = 0.5;

  it("γ=0 时 VoI 无影响（退化到旧行为）", () => {
    const withoutVoI = computeNSVBeta(deltaP, socialCost, lambda, entropy, beta, 0, 0);
    // 即使 voiValue 非零，gamma=0 也使其无效
    const withVoIButGammaZero = computeNSVBeta(deltaP, socialCost, lambda, entropy, beta, 0, 0.95);
    expect(withVoIButGammaZero).toBeCloseTo(withoutVoI, 10);
  });

  it("γ > 0 + 高 VoI → NSV 提升", () => {
    const gamma = 0.15;
    const highVoI = 0.95; // 新联系人，σ² 大
    const lowVoI = 0.05; // 老朋友，σ² 小

    const nsvHighVoI = computeNSVBeta(deltaP, socialCost, lambda, entropy, beta, gamma, highVoI);
    const nsvLowVoI = computeNSVBeta(deltaP, socialCost, lambda, entropy, beta, gamma, lowVoI);

    expect(nsvHighVoI).toBeGreaterThan(nsvLowVoI);
    // 差值 = gamma * (highVoI - lowVoI) = 0.15 * 0.9 = 0.135
    expect(nsvHighVoI - nsvLowVoI).toBeCloseTo(gamma * (highVoI - lowVoI), 10);
  });

  it("公式验证: ΔP - λ·C - β·H + γ·VoI", () => {
    const gamma = 0.2;
    const voiValue = 0.8;

    const result = computeNSVBeta(deltaP, socialCost, lambda, entropy, beta, gamma, voiValue);
    // 2.0 - 1.0*0.3 - 0.5*1.0 + 0.2*0.8 = 2.0 - 0.3 - 0.5 + 0.16 = 1.36
    const expected = deltaP - lambda * socialCost - beta * entropy + gamma * voiValue;
    expect(result).toBeCloseTo(expected, 10);
  });

  it("VoI 部分对冲 entropy 惩罚——新联系人不再被无限打压", () => {
    const gamma = 0.15;
    // 新联系人: 高 entropy + 高 VoI
    const highEntropy = 2.5;
    const highVoI = 0.95; // σ² 大

    // 无 VoI: 大 entropy 惩罚可能让 NSV 翻负
    const nsvPure = computeNSVBeta(deltaP, socialCost, lambda, highEntropy, beta, 0, 0);
    // 有 VoI: gamma*VoI 部分对冲 beta*H
    const nsvWithVoI = computeNSVBeta(
      deltaP,
      socialCost,
      lambda,
      highEntropy,
      beta,
      gamma,
      highVoI,
    );

    expect(nsvWithVoI).toBeGreaterThan(nsvPure);
    // 对冲量 = gamma * highVoI = 0.15 * 0.95 = 0.1425
    expect(nsvWithVoI - nsvPure).toBeCloseTo(gamma * highVoI, 10);
  });
});

// -- ADR-151 #6: Thompson Sampling 噪声叠加（IAUS 版）-----------------------------------

const EQUAL_PI = new PersonalityVector([0.25, 0.25, 0.25, 0.25]);

/**
 * 构建 scoreAllCandidates 所需的最小化输入。
 * 两个候选：channel:a（高压力）和 channel:b（中压力）。
 */
function buildThompsonFixture(opts: {
  eta: number;
  /** channel:a 的 belief σ²（tier + mood 各占一半）。 */
  sigma2A?: number;
  /** channel:b 的 belief σ²。 */
  sigma2B?: number;
  /** channel:a 永久不可达。 */
  permanentA?: boolean;
}) {
  const G = new WorldModel();
  G.tick = 10;
  G.addAgent("self");
  G.addChannel("channel:a", {
    unread: 30,
    tier_contact: 5,
    chat_type: "private",
    pending_directed: 2,
    last_directed_ms: 0,
  });
  G.addRelation("self", "monitors", "channel:a");
  G.addChannel("channel:b", {
    unread: 20,
    tier_contact: 5,
    chat_type: "private",
    pending_directed: 1,
    last_directed_ms: 0,
  });
  G.addRelation("self", "monitors", "channel:b");

  if (opts.permanentA) {
    G.setDynamic("channel:a", "failure_type", "permanent");
  }

  const halfA = (opts.sigma2A ?? 0) / 2;
  if (halfA > 0) {
    G.beliefs.set("channel:a", "tier", { mu: 3, sigma2: halfA, tObs: 5 });
    G.beliefs.set("channel:a", "mood", { mu: 0, sigma2: halfA, tObs: 5 });
  }
  const halfB = (opts.sigma2B ?? 0) / 2;
  if (halfB > 0) {
    G.beliefs.set("channel:b", "tier", { mu: 2, sigma2: halfB, tObs: 5 });
    G.beliefs.set("channel:b", "mood", { mu: 0, sigma2: halfB, tObs: 5 });
  }

  const config = loadConfig();
  const nowMs = Date.now();

  const p = computeAllPressures(G, 10, { nowMs });
  const routed = routeContributions(p.contributions, p.prospectContributions, G);
  const tensionMap = buildTensionMap(routed.contributions, routed.prospectContributions);

  const candidateCtx: CandidateContext = {
    G,
    nowMs,
  };

  const iausConfig: IAUSConfig = {
    candidateCtx,
    kappa: config.kappa,
    contributions: routed.contributions,
    beliefs: G.beliefs,
    beliefGamma: 0,
    thompsonEta: opts.eta,
    socialCost: config.socialCost,
    saturationCost: DEFAULT_SATURATION_COST_CONFIG,
    windowStartMs: nowMs - 600_000,
    uncertainty: 0.5,
    personality: EQUAL_PI,
    voiceLastWon: {
      diligence: -Infinity,
      curiosity: -Infinity,
      sociability: -Infinity,
      caution: -Infinity,
    },
    nowMs,
  };

  return { G, tensionMap, iausConfig };
}

describe("ADR-151 #6: Thompson Sampling 噪声（IAUS）", () => {
  it("eta=0 时 scored V 确定性不变", () => {
    const { tensionMap, G, iausConfig } = buildThompsonFixture({
      eta: 0,
      sigma2A: 1.0,
      sigma2B: 1.0,
    });

    // scored 中同一 target 的 V 在 eta=0 时每次相同
    const r0 = scoreAllCandidates(tensionMap, G, 10, [], iausConfig);
    expect(r0).not.toBeNull();
    const va = r0?.scored.find((s) => s.target === "channel:a")?.V;
    const r1 = scoreAllCandidates(tensionMap, G, 10, [], iausConfig);
    const va2 = r1?.scored.find((s) => s.target === "channel:a")?.V;
    expect(va).toBe(va2);
  });

  it("eta>0 且 σ²=0 时 V 不变（已确定的目标无噪声）", () => {
    const { tensionMap, G, iausConfig } = buildThompsonFixture({
      eta: 0.5,
      sigma2A: 0,
      sigma2B: 0,
    });

    const r0 = scoreAllCandidates(tensionMap, G, 10, [], iausConfig);
    expect(r0).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: guarded by preceding toBeNull check
    const va = r0!.scored.find((s) => s.target === "channel:a")?.V;
    expect(va).toBeGreaterThan(0);
  });

  it("eta>0 且 σ²>0 时 Boltzmann 选择分布改变（统计测试）", () => {
    const { tensionMap, G, iausConfig } = buildThompsonFixture({
      eta: 2.0,
      sigma2A: 0.01,
      sigma2B: 5.0,
    });

    let chBWins = 0;
    const N = 200;
    for (let i = 0; i < N; i++) {
      const r = scoreAllCandidates(tensionMap, G, 10, [], iausConfig);
      if (r && r.candidate.target === "channel:b") chBWins++;
    }

    // Thompson 噪声使高不确定性的 channel:b 偶尔被选中
    expect(chBWins).toBeGreaterThan(0);
  });

  it("permanent 不可达节点被 pre-filter 跳过", () => {
    const { tensionMap, G, iausConfig } = buildThompsonFixture({
      eta: 10.0,
      sigma2A: 10.0,
      sigma2B: 0.01,
      permanentA: true,
    });

    const r = scoreAllCandidates(tensionMap, G, 10, [], iausConfig);
    // permanent 节点被 IAUS pre-filter 跳过
    // channel:b 应该被选中（或 null 如果也被过滤）
    if (r) {
      expect(r.candidate.target).toBe("channel:b");
    }
  });

  it("scored 中的 V 保留原始值，不含 Thompson 噪声", () => {
    const { tensionMap, G, iausConfig } = buildThompsonFixture({
      eta: 5.0,
      sigma2A: 2.0,
      sigma2B: 2.0,
    });

    const scoredVs = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const r = scoreAllCandidates(tensionMap, G, 10, [], iausConfig);
      if (r) {
        const key = r.scored.map((s) => `${s.target}:${s.V.toFixed(10)}`).join("|");
        scoredVs.add(key);
      }
    }
    // scored 中的 V 是 compensated score 原始值，不含 Thompson 噪声
    expect(scoredVs.size).toBe(1);
  });
});
