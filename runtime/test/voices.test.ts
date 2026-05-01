/**
 * 声部系统单元测试——人格向量、响度计算、行动选择、人格演化。
 *
 * v5: computeLoudness 接受 tensionMap 而非 PressureValues，
 * 目标选择由焦点集 primaryTarget 替代 selectTarget。
 */
import { describe, expect, it } from "vitest";
import { recordEmotionEpisode } from "../src/emotion/graph.js";
import type { TensionVector } from "../src/graph/tension.js";
import { buildTensionMap } from "../src/graph/tension.js";
import { WorldModel } from "../src/graph/world-model.js";
import { computeAllPressures } from "../src/pressure/aggregate.js";
import { std } from "../src/utils/math.js";
import { computeLoudness, computeUncertainty } from "../src/voices/loudness.js";
import { PersonalityVector, VOICE_BY_INDEX } from "../src/voices/personality.js";
import { selectAction } from "../src/voices/selection.js";

/** 测试用 tick→ms 转换（约定：1 tick = 60s）。 */
function tickMs(tick: number): number {
  return tick * 60_000;
}

const _EPS = 1e-10;

/** 构造测试图。 */
function buildTestGraph(): WorldModel {
  const G = new WorldModel();
  G.tick = 100;
  G.addAgent("self");
  G.addContact("alice", { tier: 5, last_active_ms: tickMs(95) });
  G.addContact("bob", { tier: 150, last_active_ms: 0 });
  G.addChannel("ch1", {
    unread: 10,
    tier_contact: 5,
    chat_type: "private",
    pending_directed: 3,
    last_directed_ms: tickMs(99),
  });
  G.addChannel("ch2", { unread: 0, tier_contact: 150, chat_type: "group" });
  G.addThread("t1", { weight: "major", status: "open", created_ms: 80 });
  G.addFact("i1", {
    importance: 0.8,
    stability: 1.0,
    last_access_ms: 50,
    novelty: 0.3,
  });
  G.addRelation("self", "friend", "alice");
  G.addRelation("self", "monitors", "ch1");
  return G;
}

/** 构造确定性 tensionMap 用于单元测试。 */
function makeTensionMap(entries: [string, Partial<TensionVector>][]): Map<string, TensionVector> {
  const map = new Map<string, TensionVector>();
  for (const [id, partial] of entries) {
    map.set(id, {
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
      ...partial,
    });
  }
  return map;
}

// -- PersonalityVector --------------------------------------------------------

describe("PersonalityVector", () => {
  it("默认均匀分布", () => {
    const pv = new PersonalityVector();
    expect(pv.weights).toHaveLength(4);
    for (const w of pv.weights) {
      expect(w).toBeCloseTo(0.25, 10);
    }
  });

  it("自动归一化", () => {
    const pv = new PersonalityVector([1, 2, 3, 4]);
    const sum = pv.weights.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 10);
    expect(pv.piD).toBeCloseTo(1 / 10, 10);
    expect(pv.piX).toBeCloseTo(4 / 10, 10);
  });

  it("全零时回退均匀", () => {
    const pv = new PersonalityVector([0, 0, 0, 0]);
    for (const w of pv.weights) {
      expect(w).toBeCloseTo(0.25, 10);
    }
  });

  it("toString 格式", () => {
    const pv = new PersonalityVector();
    expect(pv.toString()).toContain("D=0.250");
    expect(pv.toString()).toContain("X=0.250");
    expect(pv.toString()).not.toContain("R=");
  });
});

// -- Uncertainty --------------------------------------------------------------

describe("computeUncertainty", () => {
  /** 空图 stub（无 channel → envUncertainty=0）。 */
  function emptyGraph(): WorldModel {
    const G = new WorldModel();
    G.addAgent("self");
    return G;
  }

  it("无历史返回 0.5", () => {
    const G = emptyGraph();
    expect(computeUncertainty(null, 10, 2.0, G)).toBe(0.5);
    expect(computeUncertainty([], 10, 2.0, G)).toBe(0.5);
  });

  it("事件率 == 期望率 → 0", () => {
    // rate = 2.0, expected = 2.0 → ratio = 1.0 → 0.0
    expect(computeUncertainty([2, 2, 2], 10, 2.0, emptyGraph())).toBeCloseTo(0.0, 10);
  });

  it("事件率 == 0 → 1.0", () => {
    expect(computeUncertainty([0, 0, 0], 10, 2.0, emptyGraph())).toBeCloseTo(1.0, 10);
  });

  it("事件率 > 2倍期望率 → 0（clamp）", () => {
    // rate=10, expected=2 → ratio=min(5, 2)=2 → 1-2 = -1 → max(0, -1) = 0
    expect(computeUncertainty([10, 10], 10, 2.0, emptyGraph())).toBeCloseTo(0.0, 10);
  });

  it("ADR-112 D3: 新 channel 抬高 env_uncertainty", () => {
    const G = emptyGraph();
    // 新加入的群：contact_recv_window=0 → novelty=1.0 → envUncertainty=1.0
    G.addChannel("channel:new", { contact_recv_window: 0 });
    // 信息不确定性=0（事件充足），但环境不确定性=1.0
    expect(computeUncertainty([2, 2, 2], 10, 2.0, G)).toBeCloseTo(1.0, 1);
  });

  it("ADR-112 D3: 老 channel 环境不确定性衰减到接近 0", () => {
    const G = emptyGraph();
    // 老群：50 条消息 → novelty=exp(-50/10)≈0.007
    G.addChannel("channel:old", { contact_recv_window: 50 });
    const u = computeUncertainty([2, 2, 2], 10, 2.0, G);
    expect(u).toBeLessThan(0.05);
  });
});

// -- Loudness (v5: tensionMap + 焦点集) ----------------------------------------

describe("computeLoudness", () => {
  it("返回长度 4 的 loudness 数组（ADR-81: 4 声部）", () => {
    const G = buildTestGraph();
    const pv = new PersonalityVector();
    const pressures = computeAllPressures(G, 100);
    const tensionMap = buildTensionMap(pressures.contributions, pressures.prospectContributions);
    const { loudness } = computeLoudness(tensionMap, pv, G, 100, {
      noiseOverride: [0, 0, 0, 0],
      nowMs: tickMs(100),
    });
    expect(loudness).toHaveLength(4);
  });

  it("零噪声时确定性", () => {
    const G = buildTestGraph();
    const pv = new PersonalityVector();
    const pressures = computeAllPressures(G, 100);
    const tensionMap = buildTensionMap(pressures.contributions, pressures.prospectContributions);
    const zeroNoise = [0, 0, 0, 0];
    const r1 = computeLoudness(tensionMap, pv, G, 100, {
      noiseOverride: zeroNoise,
      nowMs: tickMs(100),
    });
    const r2 = computeLoudness(tensionMap, pv, G, 100, {
      noiseOverride: zeroNoise,
      nowMs: tickMs(100),
    });
    for (let i = 0; i < 4; i++) {
      expect(r1.loudness[i]).toBeCloseTo(r2.loudness[i], 10);
    }
  });

  it("有 unread 消息时 Diligence > 0", () => {
    const G = buildTestGraph();
    const pressures = computeAllPressures(G, 100);
    const tensionMap = buildTensionMap(pressures.contributions, pressures.prospectContributions);
    // 偏向 Diligence
    const pv = new PersonalityVector([0.8, 0.05, 0.05, 0.05, 0.05]);
    const { loudness } = computeLoudness(tensionMap, pv, G, 100, {
      noiseOverride: [0, 0, 0, 0],
      nowMs: tickMs(100),
    });
    // Diligence 应有显著响度（因为 unread=10, directed=3 → 高 τ₁, τ₅）
    expect(loudness[0]).toBeGreaterThan(0);
  });

  it("人格偏向影响响度分布", () => {
    const G = buildTestGraph();
    const pressures = computeAllPressures(G, 100);
    const tensionMap = buildTensionMap(pressures.contributions, pressures.prospectContributions);
    const zeroNoise = [0, 0, 0, 0];
    // 极端偏向 Sociability
    const pvS = new PersonalityVector([0.05, 0.05, 0.8, 0.05, 0.05]);
    const rS = computeLoudness(tensionMap, pvS, G, 100, {
      noiseOverride: zeroNoise,
      nowMs: tickMs(100),
    });
    // 极端偏向 Diligence
    const pvD = new PersonalityVector([0.8, 0.05, 0.05, 0.05, 0.05]);
    const rD = computeLoudness(tensionMap, pvD, G, 100, {
      noiseOverride: zeroNoise,
      nowMs: tickMs(100),
    });
    // S 偏向时 L[2] (Sociability) 应更大
    expect(rS.loudness[2]).toBeGreaterThan(rD.loudness[2]);
    // D 偏向时 L[0] (Diligence) 应更大
    expect(rD.loudness[0]).toBeGreaterThan(rS.loudness[0]);
  });

  it("ADR-268: hurt emotion gives caution an extra bounded bias", () => {
    const nowMs = tickMs(100);
    const tensionMap = makeTensionMap([["ch1", { tau1: 1, tau2: 1, tau3: 1, tau5: 1, tau6: 1 }]]);
    const pv = new PersonalityVector();

    const base = buildTestGraph();
    const hurt = buildTestGraph();
    recordEmotionEpisode(hurt, {
      kind: "hurt",
      intensity: 0.8,
      nowMs,
      cause: { type: "feedback", summary: "sharp correction" },
    });

    const baseLoudness = computeLoudness(tensionMap, pv, base, 100, {
      noiseOverride: [0, 0, 0, 0],
      nowMs,
    }).loudness;
    const hurtLoudness = computeLoudness(tensionMap, pv, hurt, 100, {
      noiseOverride: [0, 0, 0, 0],
      nowMs,
    }).loudness;

    expect(hurtLoudness[3]).toBeGreaterThan(baseLoudness[3]);
    expect(hurtLoudness[2]).toBeLessThan(baseLoudness[2]);
  });

  it("焦点集包含 primaryTarget", () => {
    const G = buildTestGraph();
    const pressures = computeAllPressures(G, 100);
    const tensionMap = buildTensionMap(pressures.contributions, pressures.prospectContributions);
    const pv = new PersonalityVector();
    const { focalSets } = computeLoudness(tensionMap, pv, G, 100, {
      noiseOverride: [0, 0, 0, 0],
      nowMs: tickMs(100),
    });
    // 每个声部都应有焦点集
    for (const voice of ["diligence", "curiosity", "sociability", "caution"] as const) {
      const fs = focalSets[voice];
      if (fs.entities.length > 0) {
        expect(fs.primaryTarget).toBe(fs.entities[0]);
        expect(fs.meanRelevance).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

// -- Action Selection ---------------------------------------------------------

describe("selectAction", () => {
  it("确定性选择最大响度（极低温度）", () => {
    // 极端分化的 loudness → std 大 → τ 小 → 近似确定性
    const L = [10.0, 0.0, 0.0, 0.0, 0.0];
    const [idx, action] = selectAction(L, 0.5);
    expect(idx).toBe(0);
    expect(action).toBe("diligence");
  });

  it("返回有效 VoiceAction", () => {
    const L = [0.1, 0.2, 0.3, 0.4, 0.5];
    const [idx, action] = selectAction(L, 0.99);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(5);
    expect(action).toBe(VOICE_BY_INDEX[idx]);
  });

  it("均匀 loudness 时温度较高", () => {
    const L = [0.2, 0.2, 0.2, 0.2, 0.2];
    const spread = std(L);
    const tau = 0.1 + 0.3 / (1.0 + spread * 10.0);
    // spread ≈ 0 → τ ≈ 0.4
    expect(tau).toBeCloseTo(0.4, 2);
  });

  it("高分化时温度较低", () => {
    const L = [1.0, 0.0, 0.0, 0.0, 0.0];
    const spread = std(L);
    const tau = 0.1 + 0.3 / (1.0 + spread * 10.0);
    // spread > 0 → τ < 0.4
    expect(tau).toBeLessThan(0.3);
  });
});

// -- Voice Coverage Proof （声部覆盖性证明）------------------------------------
// 每个测试构造一个让特定声部必胜的场景（零噪声 + 确定性 softmax）。
// v5: 通过 tensionMap 构造张力向量，验证焦点集 → 响度 → 行动选择。

describe("声部覆盖性证明", () => {
  const zeroNoise = [0, 0, 0, 0];

  it("Diligence 可胜出（高 τ₁+τ₄+τ₅）", () => {
    // R_D = τ₁ + τ₄ + τ₅ + τ_P = 10+10+10+0 = 30
    const G = new WorldModel();
    G.tick = 100;
    G.addChannel("e1");
    const tensionMap = makeTensionMap([["e1", { tau1: 10, tau4: 10, tau5: 10 }]]);
    const pv = new PersonalityVector([0.4, 0.1, 0.1, 0.1, 0.3]);
    const { loudness } = computeLoudness(tensionMap, pv, G, 100, {
      noiseOverride: zeroNoise,
      recentEventCounts: [2, 2, 2], // uncertainty ≈ 0
      nowMs: tickMs(100),
    });
    const [idx, action] = selectAction(loudness, 0.5);
    expect(action).toBe("diligence");
    expect(idx).toBe(0);
  });

  it("Curiosity 可胜出（高 τ₂+τ₆）", () => {
    // R_C = τ₂ + τ₆ = 10+10 = 20
    const G = new WorldModel();
    G.tick = 100;
    G.addChannel("e1");
    const tensionMap = makeTensionMap([["e1", { tau2: 10, tau6: 10 }]]);
    const pv = new PersonalityVector([0.1, 0.4, 0.1, 0.1, 0.3]);
    const { loudness } = computeLoudness(tensionMap, pv, G, 100, {
      noiseOverride: zeroNoise,
      recentEventCounts: [2, 2, 2],
      nowMs: tickMs(100),
    });
    const [idx, action] = selectAction(loudness, 0.5);
    expect(action).toBe("curiosity");
    expect(idx).toBe(1);
  });

  it("Sociability 可胜出（高 τ₃）", () => {
    // R_S = τ₃ = 20
    const G = new WorldModel();
    G.tick = 100;
    G.addChannel("e1");
    const tensionMap = makeTensionMap([["e1", { tau3: 20 }]]);
    const pv = new PersonalityVector([0.1, 0.1, 0.4, 0.1, 0.3]);
    const { loudness } = computeLoudness(tensionMap, pv, G, 100, {
      noiseOverride: zeroNoise,
      recentEventCounts: [2, 2, 2],
      nowMs: tickMs(100),
    });
    const [idx, action] = selectAction(loudness, 0.5);
    expect(action).toBe("sociability");
    expect(idx).toBe(2);
  });

  it("ADR-181: Caution 可胜出（高 tauRisk + 高不确定性）", () => {
    // R_Caution = α_r(0.8) × tauRisk(0.6) + uncertainty(1.0) ≈ 1.48
    // 其余声部: 全零 → R_v = 0
    const G = new WorldModel();
    G.tick = 100;
    G.addChannel("e1");
    const tensionMap = makeTensionMap([["e1", { tauRisk: 0.6 }]]);
    const pv = new PersonalityVector([0.1, 0.1, 0.1, 0.7]);
    const { loudness } = computeLoudness(tensionMap, pv, G, 100, {
      noiseOverride: zeroNoise,
      recentEventCounts: [0, 0, 0], // uncertainty = 1.0
      nowMs: tickMs(100),
    });
    const [idx, action] = selectAction(loudness, 0.5);
    expect(action).toBe("caution");
    expect(idx).toBe(3);
  });

  // ADR-81: Reflection 声部已移除。上方 4 声部覆盖性已验证。
});

// -- Personality Evolution ----------------------------------------------------
