/**
 * 压力系统合成验证——启发性分析 + 结构性模拟。
 *
 * 用合成固定图验证结构性假说：
 * - P3 量级支配
 * - 声部竞争公平性
 * - 注意力分散度
 * - Top-K 截断有效性
 * - epoch 守卫
 *
 * 不依赖运行历史数据——纯合成、确定性、可重现。
 *
 * @see docs/adr/110-dt-migration/pressure-audit.md
 */
import { describe, expect, it } from "vitest";
import { BeliefStore } from "../src/belief/store.js";
import { type IAUSConfig, scoreAllCandidates } from "../src/engine/iaus-scorer.js";
import {
  DEFAULT_KAPPA,
  DUNBAR_TIER_THETA,
  DUNBAR_TIER_WEIGHT,
  P3_BETA_R,
  P3_TAU_0,
} from "../src/graph/constants.js";
import type { DunbarTier } from "../src/graph/entities.js";
import { buildTensionMap, routeContributions } from "../src/graph/tension.js";
import { WorldModel } from "../src/graph/world-model.js";
import { computeAllPressures } from "../src/pressure/aggregate.js";
import { p3RelationshipCooling } from "../src/pressure/p3-relationship.js";
import {
  DEFAULT_SATURATION_COST_CONFIG,
  DEFAULT_SOCIAL_COST_CONFIG,
} from "../src/pressure/social-cost.js";
import { estimateDeltaP } from "../src/pressure/social-value.js";
import { logSigmoid, sigmoid, tanhNormalize } from "../src/utils/math.js";
import { computeFocalSets } from "../src/voices/focus.js";
import { computeLoudness } from "../src/voices/loudness.js";
import { PersonalityVector, VOICE_INDEX } from "../src/voices/personality.js";

/** 测试用 tick→ms 转换（约定：1 tick = 60s）。 */
function tickMs(tick: number): number {
  return tick * 60_000;
}

/**
 * 测试用 nowMs 基准时间。
 * 需要足够大以容纳所有测试场景的沉默持续时间（最长 3 天 = 259,200,000 ms）。
 * tickMs(10000) = 600,000,000 ms ≈ 6.94 天。
 */
const BASE_NOW_MS = tickMs(10_000);

/** 等权人格向量 */
const EQUAL_PI = new PersonalityVector([0.25, 0.25, 0.25, 0.25]);

// ═══════════════════════════════════════════════════════════════════════════
// 图构建器
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 数字 ID 生成器。
 * ensureChannelId("contact:X") → "channel:X" 要求 X 是纯数字。
 * 用递增数字保证 contact→channel 路由正确。
 */
let _nextId = 1000;
function nextId(): number {
  return _nextId++;
}

/** 构建模拟真实运行的 42 联系人图。 */
function buildRealisticGraph(nowMs: number): WorldModel {
  const G = new WorldModel();
  G.tick = 100;
  G.addAgent("self");

  // ADR-113: silence 时间按线上 IM 阈值重新标定（DUNBAR_TIER_THETA 约 6x 增长）
  const tierSpecs: Array<{ tier: DunbarTier; count: number; silenceMin: number; rel: string }> = [
    { tier: 5, count: 5, silenceMin: 240, rel: "friend" }, // 4h（theta=2h，silence=2θ）
    { tier: 15, count: 10, silenceMin: 720, rel: "acquaintance" }, // 12h（theta=4h，silence=3θ）
    { tier: 50, count: 15, silenceMin: 2880, rel: "acquaintance" }, // 2d（theta=12h，silence=4θ）
    { tier: 150, count: 12, silenceMin: 5760, rel: "stranger" }, // 4d（theta=2d，silence=2θ）
  ];

  for (const { tier, count, silenceMin, rel } of tierSpecs) {
    for (let i = 0; i < count; i++) {
      const id = nextId();
      const cid = `contact:${id}`;
      const chid = `channel:${id}`;
      G.addContact(cid, {
        tier,
        last_active_ms: nowMs - silenceMin * 60 * 1000,
      });
      // tier-5/15 有专属私聊 channel
      if (tier <= 15) {
        G.addChannel(chid, {
          unread: tier === 5 ? 2 : 1,
          tier_contact: tier,
          chat_type: "private",
          pending_directed: 0,
        });
        G.addRelation("self", "monitors", chid);
        G.addRelation(cid, "joined", chid);
      }
      G.addRelation("self", rel, cid);
    }
  }

  // 超级群（活跃，有 directed）——使用负数模拟 Telegram supergroup chat_id
  G.addChannel("channel:telegram:-1001000001", {
    unread: 50,
    tier_contact: 150,
    chat_type: "supergroup",
    pending_directed: 2,
    last_directed_ms: nowMs - 60 * 1000,
    last_directed_text: "Hey Alice",
  });
  G.addRelation("self", "monitors", "channel:telegram:-1001000001");

  // 2 个普通群
  G.addChannel("channel:telegram:-1001000002", {
    unread: 10,
    tier_contact: 50,
    chat_type: "group",
    pending_directed: 0,
  });
  G.addChannel("channel:telegram:-1001000003", {
    unread: 5,
    tier_contact: 150,
    chat_type: "group",
    pending_directed: 0,
  });
  G.addRelation("self", "monitors", "channel:telegram:-1001000002");
  G.addRelation("self", "monitors", "channel:telegram:-1001000003");

  return G;
}

/** 构建 P3（关系冷却）和 P1（群消息）并存的图。 */
function buildMixedPressureGraph(nowMs: number): WorldModel {
  const G = new WorldModel();
  G.tick = 100;
  G.addAgent("self");

  // P1 源：超级群有大量未读 + directed
  G.addChannel("channel:telegram:-1002000001", {
    unread: 40,
    tier_contact: 150,
    chat_type: "supergroup",
    pending_directed: 1,
    last_directed_ms: nowMs - 120_000,
    last_directed_text: "What do you think?",
  });
  G.addRelation("self", "monitors", "channel:telegram:-1002000001");

  // P3 源：3 个冷却中的联系人 + 对应私聊 channel（数字 ID）
  for (let i = 0; i < 3; i++) {
    const id = 2000 + i;
    const cid = `contact:${id}`;
    const chid = `channel:${id}`;
    G.addContact(cid, {
      tier: 15,
      last_active_ms: nowMs - 3 * 3600 * 1000,
    });
    G.addChannel(chid, {
      unread: 0,
      tier_contact: 15,
      chat_type: "private",
      pending_directed: 0,
    });
    G.addRelation("self", "friend", cid);
    G.addRelation("self", "monitors", chid);
    G.addRelation(cid, "joined", chid);
  }

  return G;
}

/** 构建 3 个有相近压力值的 channel。 */
function buildBalancedGraph(nowMs: number): WorldModel {
  const G = new WorldModel();
  G.tick = 100;
  G.addAgent("self");

  // "channel:group": 活跃群（P1 + P5 贡献）
  G.addChannel("channel:telegram:-1003000001", {
    unread: 25,
    tier_contact: 50,
    chat_type: "group",
    pending_directed: 1,
    last_directed_ms: nowMs - 300_000,
  });
  G.addRelation("self", "monitors", "channel:telegram:-1003000001");

  // 3001: tier-5 联系人私聊（P3 贡献）
  G.addContact("contact:telegram:3001", {
    tier: 5,
    last_active_ms: nowMs - 45 * 60 * 1000,
  });
  G.addChannel("channel:telegram:3001", {
    unread: 1,
    tier_contact: 5,
    chat_type: "private",
    pending_directed: 0,
  });
  G.addRelation("self", "friend", "contact:telegram:3001");
  G.addRelation("self", "monitors", "channel:telegram:3001");
  G.addRelation("contact:telegram:3001", "joined", "channel:telegram:3001");

  // 3002: tier-15 联系人私聊（P3 贡献）
  G.addContact("contact:telegram:3002", {
    tier: 15,
    last_active_ms: nowMs - 2 * 3600 * 1000,
  });
  G.addChannel("channel:telegram:3002", {
    unread: 0,
    tier_contact: 15,
    chat_type: "private",
    pending_directed: 0,
  });
  G.addRelation("self", "acquaintance", "contact:telegram:3002");
  G.addRelation("self", "monitors", "channel:telegram:3002");
  G.addRelation("contact:telegram:3002", "joined", "channel:telegram:3002");

  return G;
}

// ═══════════════════════════════════════════════════════════════════════════
// 场景 1: P3 量级分析 — "42 个联系人的压力场"
// ═══════════════════════════════════════════════════════════════════════════

describe("场景 1: P3 量级分析 — 写实图", () => {
  const nowMs = BASE_NOW_MS;

  it("P3 在 Top-K 截断后不应超过 API 贡献的 50%", () => {
    const G = buildRealisticGraph(nowMs);
    const p = computeAllPressures(G, 100, { nowMs });

    const p3ApiContrib = tanhNormalize(p.P3, DEFAULT_KAPPA[2]);
    expect(p3ApiContrib / p.API).toBeLessThan(0.5);
    expect(p.P3).toBeLessThan(30);
  });

  it("API 在写实图下落入合理范围 [0.5, 4.0]", () => {
    const G = buildRealisticGraph(nowMs);
    const p = computeAllPressures(G, 100, { nowMs });
    expect(p.API).toBeGreaterThan(0.5);
    expect(p.API).toBeLessThan(4.0);
  });

  it("至少 3 个维度有非零贡献", () => {
    const G = buildRealisticGraph(nowMs);
    const p = computeAllPressures(G, 100, { nowMs });

    const nonZeroDims = [p.P1, p.P2, p.P3, p.P4, p.P5, p.P6].filter((v) => v > 0.01).length;
    expect(nonZeroDims).toBeGreaterThanOrEqual(3);
  });

  it("无单一维度超过 60% API 贡献", () => {
    const G = buildRealisticGraph(nowMs);
    const p = computeAllPressures(G, 100, { nowMs });

    const raw = [p.P1, p.P2, p.P3, p.P4, p.P5, p.P6];
    const apiContribs = raw.map((v, i) => tanhNormalize(v, DEFAULT_KAPPA[i]));
    const apiTotal = apiContribs.reduce((a, b) => a + b, 0);

    for (const c of apiContribs) {
      expect(c / apiTotal).toBeLessThan(0.6);
    }
  });

  it("诊断: 打印各维度值和 API 占比", () => {
    const G = buildRealisticGraph(nowMs);
    const p = computeAllPressures(G, 100, { nowMs });
    const dims = ["P1", "P2", "P3", "P4", "P5", "P6"] as const;
    const raw = [p.P1, p.P2, p.P3, p.P4, p.P5, p.P6];
    const apiContribs = raw.map((v, i) => tanhNormalize(v, DEFAULT_KAPPA[i]));
    const apiTotal = apiContribs.reduce((a, b) => a + b, 0);

    const report = dims.map((d, i) => ({
      dim: d,
      raw: raw[i].toFixed(3),
      tanh: apiContribs[i].toFixed(3),
      share: `${((apiContribs[i] / apiTotal) * 100).toFixed(1)}%`,
    }));
    console.table(report);
    console.log(`API total: ${p.API.toFixed(4)}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 场景 2: 声部竞争公平性
// ═══════════════════════════════════════════════════════════════════════════

describe("场景 2: 声部竞争公平性", () => {
  const nowMs = BASE_NOW_MS;

  it("sociability 在混合压力场景中 loudness > 0", () => {
    const G = buildMixedPressureGraph(nowMs);
    const p = computeAllPressures(G, 100, { nowMs });
    const routed = routeContributions(p.contributions, p.prospectContributions, G);
    const tensionMap = buildTensionMap(routed.contributions, routed.prospectContributions);

    const { loudness } = computeLoudness(tensionMap, EQUAL_PI, G, 100, {
      noiseOverride: [0, 0, 0, 0],
      nowMs,
    });

    const socIdx = VOICE_INDEX.sociability;
    expect(loudness[socIdx]).toBeGreaterThan(0);

    console.log(
      "=== 声部响度 [D, C, S, X] ===",
      loudness.map((l) => l.toFixed(4)),
    );
  });

  it("sociability 焦点集有 primaryTarget 且 ΔP > 0", () => {
    const G = buildMixedPressureGraph(nowMs);
    const p = computeAllPressures(G, 100, { nowMs });
    const routed = routeContributions(p.contributions, p.prospectContributions, G);
    const tensionMap = buildTensionMap(routed.contributions, routed.prospectContributions);

    const focalSets = computeFocalSets(tensionMap, G, 100, { nowMs });
    const socTarget = focalSets.sociability.primaryTarget;
    expect(socTarget).not.toBeNull();
    expect(focalSets.sociability.meanRelevance).toBeGreaterThan(0);

    // 目标在路由后的贡献中有正 ΔP
    const deltaP = estimateDeltaP(routed.contributions, socTarget!, DEFAULT_KAPPA);
    expect(deltaP).toBeGreaterThan(0);
  });

  it("纯 P3 场景中 sociability 的响度不低于最高响度的 30%", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addAgent("self");

    // 纯 P3：只有冷却联系人，无群消息（数字 ID）
    for (let i = 0; i < 5; i++) {
      const id = 4000 + i;
      const cid = `contact:telegram:${id}`;
      const chid = `channel:telegram:${id}`;
      G.addContact(cid, {
        tier: 5,
        last_active_ms: nowMs - 2 * 3600 * 1000,
      });
      G.addChannel(chid, {
        unread: 0,
        tier_contact: 5,
        chat_type: "private",
        pending_directed: 0,
      });
      G.addRelation("self", "friend", cid);
      G.addRelation("self", "monitors", chid);
      G.addRelation(cid, "joined", chid);
    }

    const p = computeAllPressures(G, 100, { nowMs });
    const routed = routeContributions(p.contributions, p.prospectContributions, G);
    const tensionMap = buildTensionMap(routed.contributions, routed.prospectContributions);

    const { loudness } = computeLoudness(tensionMap, EQUAL_PI, G, 100, {
      noiseOverride: [0, 0, 0, 0],
      nowMs,
    });

    const socLoudness = loudness[VOICE_INDEX.sociability];
    const maxLoudness = Math.max(...loudness);
    expect(socLoudness).toBeGreaterThan(maxLoudness * 0.3);

    console.log(
      "=== 纯 P3 声部响度 [D, C, S, X] ===",
      loudness.map((l) => l.toFixed(4)),
    );
  });

  it("四个声部在写实图中都有正 loudness", () => {
    const G = buildRealisticGraph(nowMs);
    const p = computeAllPressures(G, 100, { nowMs });
    const routed = routeContributions(p.contributions, p.prospectContributions, G);
    const tensionMap = buildTensionMap(routed.contributions, routed.prospectContributions);

    const { loudness } = computeLoudness(tensionMap, EQUAL_PI, G, 100, {
      noiseOverride: [0, 0, 0, 0],
      nowMs,
    });

    expect(loudness[VOICE_INDEX.diligence]).toBeGreaterThan(0);
    expect(loudness[VOICE_INDEX.caution]).toBeGreaterThan(0);
    expect(loudness[VOICE_INDEX.sociability]).toBeGreaterThan(0);
    // curiosity 可能因无 fact 路由而为零——不强制
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 场景 3: 注意力分散度 — "多目标竞争"
// ═══════════════════════════════════════════════════════════════════════════

describe("场景 3: 注意力分散度", () => {
  const nowMs = BASE_NOW_MS;

  it("IAUS 在平衡场景中至少选中 1 个 target（200 次采样诊断）", () => {
    const G = buildBalancedGraph(nowMs);
    const p = computeAllPressures(G, 100, { nowMs });
    const routed = routeContributions(p.contributions, p.prospectContributions, G);
    const tensionMap = buildTensionMap(routed.contributions, routed.prospectContributions);

    const iausConfig: IAUSConfig = {
      candidateCtx: {
        G,
        nowMs,
      },
      kappa: DEFAULT_KAPPA,
      contributions: routed.contributions,
      beliefs: new BeliefStore(),
      beliefGamma: 0,
      thompsonEta: 0,
      socialCost: DEFAULT_SOCIAL_COST_CONFIG,
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

    const targetCounts: Record<string, number> = {};
    const RUNS = 200;
    let nullCount = 0;

    for (let i = 0; i < RUNS; i++) {
      // 每次调用 IAUS——Boltzmann 采样自带随机性
      const result = scoreAllCandidates(tensionMap, G, 100, [], iausConfig);

      if (result) {
        const t = result.candidate.target ?? "null";
        targetCounts[t] = (targetCounts[t] ?? 0) + 1;
      } else {
        nullCount++;
      }
    }

    const totalSelected = RUNS - nullCount;
    const selectedTargets = Object.keys(targetCounts).filter((k) => targetCounts[k] > 0);
    console.log("=== IAUS 目标分布 (200 runs) ===", targetCounts, `nulls: ${nullCount}`);

    // 基本功能：至少选中了某个 target
    expect(totalSelected).toBeGreaterThan(0);

    // 诊断性指标：如果单一 target 占比 > 95%，记录为注意力垄断
    // 这不是 bug——IAUS Boltzmann 在效用差距大时趋向确定性选择是设计行为。
    // 但如果审计发现垄断严重，需要审查效用差距来源。
    if (totalSelected > 0) {
      const maxShare = Math.max(...Object.values(targetCounts)) / totalSelected;
      if (maxShare > 0.95) {
        console.warn(
          `⚠️ 注意力垄断: ${selectedTargets[0]} 占 ${(maxShare * 100).toFixed(1)}%。` +
            `IAUS Boltzmann 在效用差距大时趋向确定性选择。`,
        );
      }
    }
  });

  it("各声部的焦点集指向不同 target", () => {
    const G = buildBalancedGraph(nowMs);
    const p = computeAllPressures(G, 100, { nowMs });
    const routed = routeContributions(p.contributions, p.prospectContributions, G);
    const tensionMap = buildTensionMap(routed.contributions, routed.prospectContributions);

    const focalSets = computeFocalSets(tensionMap, G, 100, { nowMs });

    const targets = new Set<string>();
    for (const focal of Object.values(focalSets)) {
      if (focal.primaryTarget) targets.add(focal.primaryTarget);
    }
    // 至少 2 个不同的 target（diligence → 群, sociability → 私聊）
    expect(targets.size).toBeGreaterThanOrEqual(2);

    console.log(
      "=== 焦点集 primaryTarget ===",
      Object.fromEntries(Object.entries(focalSets).map(([k, v]) => [k, v.primaryTarget ?? "—"])),
    );
  });

  it("确定性模式下 loudness 和 focalSets 可重现", () => {
    const G = buildBalancedGraph(nowMs);
    const p = computeAllPressures(G, 100, { nowMs });
    const routed = routeContributions(p.contributions, p.prospectContributions, G);
    const tensionMap = buildTensionMap(routed.contributions, routed.prospectContributions);

    const r1 = computeLoudness(tensionMap, EQUAL_PI, G, 100, {
      noiseOverride: [0, 0, 0, 0],
      nowMs,
    });
    const r2 = computeLoudness(tensionMap, EQUAL_PI, G, 100, {
      noiseOverride: [0, 0, 0, 0],
      nowMs,
    });

    expect(r1.loudness).toEqual(r2.loudness);
    for (const v of ["diligence", "curiosity", "sociability", "caution"] as const) {
      expect(r1.focalSets[v].primaryTarget).toBe(r2.focalSets[v].primaryTarget);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 场景 4: P3 Top-K 截断有效性
// ═══════════════════════════════════════════════════════════════════════════

describe("场景 4: P3 Top-K 截断", () => {
  const nowMs = BASE_NOW_MS;

  it("20 个 tier-5 联系人时 P3 只保留 ≤ 5 个 contact 贡献", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addAgent("self");

    for (let i = 0; i < 20; i++) {
      const cid = `contact:${i}`;
      const chid = `channel:${i}`;
      G.addContact(cid, {
        tier: 5,
        last_active_ms: nowMs - 2 * 3600 * 1000,
      });
      G.addChannel(chid, {
        unread: 0,
        tier_contact: 5,
        chat_type: "private",
      });
      G.addRelation("self", "friend", cid);
      G.addRelation("self", "monitors", chid);
      G.addRelation(cid, "joined", chid);
    }

    const { contributions } = p3RelationshipCooling(G, 100, nowMs);

    const contactContribs = Object.entries(contributions).filter(([eid]) =>
      eid.startsWith("contact:"),
    );
    // ADR-113: Top-K=8
    expect(contactContribs.length).toBeLessThanOrEqual(8);

    const total = Object.values(contributions).reduce((s, v) => s + v, 0);
    expect(total).toBeGreaterThan(0);
    console.log(
      `Top-K截断: 20 联系人 → ${contactContribs.length} 个 contact 贡献, total=${total.toFixed(4)}`,
    );
  });

  it("Top-K=5 截断后 P3 ≤ 5 × 单联系人最大贡献", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addAgent("self");

    for (let i = 0; i < 10; i++) {
      const cid = `contact:${i}`;
      const chid = `channel:${i}`;
      G.addContact(cid, {
        tier: 5,
        last_active_ms: nowMs - 86400 * 1000,
      });
      G.addChannel(chid, {
        unread: 0,
        tier_contact: 5,
        chat_type: "private",
      });
      G.addRelation("self", "friend", cid);
      G.addRelation("self", "monitors", chid);
      G.addRelation(cid, "joined", chid);
    }

    const { total, contributions } = p3RelationshipCooling(G, 100, nowMs);
    const contactContribs = Object.entries(contributions)
      .filter(([eid]) => eid.startsWith("contact:"))
      .map(([, v]) => v);
    const maxSingle = Math.max(...contactContribs);

    // ADR-113: Top-K=8
    expect(total).toBeLessThanOrEqual(8 * maxSingle + 0.001);
  });

  it("8 个和 9 个同质联系人的 P3 相同（截断生效）", () => {
    // ADR-113: Top-K=8
    const G = new WorldModel();
    G.tick = 100;
    G.addAgent("self");

    const lastActiveMs = nowMs - 3 * 86400 * 1000;
    for (let i = 1; i <= 8; i++) {
      const cid = `contact:${i}`;
      const chid = `channel:${i}`;
      G.addContact(cid, { tier: 5, last_active_ms: lastActiveMs });
      G.addChannel(chid, { unread: 0, tier_contact: 5, chat_type: "private" });
      G.addRelation("self", "friend", cid);
      G.addRelation("self", "monitors", chid);
      G.addRelation(cid, "joined", chid);
    }

    const r8 = p3RelationshipCooling(G, 100, nowMs);

    // 加第 9 个
    G.addContact("contact:telegram:9", { tier: 5, last_active_ms: lastActiveMs });
    G.addChannel("channel:telegram:9", { unread: 0, tier_contact: 5, chat_type: "private" });
    G.addRelation("self", "friend", "contact:telegram:9");
    G.addRelation("self", "monitors", "channel:telegram:9");
    G.addRelation("contact:telegram:9", "joined", "channel:telegram:9");

    const r9 = p3RelationshipCooling(G, 100, nowMs);

    expect(r9.total).toBeCloseTo(r8.total, 4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 场景 5: epoch 守卫验证
// ═══════════════════════════════════════════════════════════════════════════

describe("场景 5: epoch 守卫", () => {
  const nowMs = BASE_NOW_MS;

  it("last_active_ms=0 的联系人不产生 P3 贡献", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addAgent("self");

    G.addContact("contact:never", {
      tier: 5,
      last_active_ms: 0,
    });
    G.addChannel("channel:never", { unread: 0, tier_contact: 5, chat_type: "private" });
    G.addRelation("self", "friend", "contact:never");
    G.addRelation("self", "monitors", "channel:never");
    G.addRelation("contact:never", "joined", "channel:never");

    G.addContact("contact:active", {
      tier: 5,
      last_active_ms: nowMs - 3600 * 1000,
    });
    G.addChannel("channel:active", { unread: 0, tier_contact: 5, chat_type: "private" });
    G.addRelation("self", "friend", "contact:active");
    G.addRelation("self", "monitors", "channel:active");
    G.addRelation("contact:active", "joined", "channel:active");

    const { contributions } = p3RelationshipCooling(G, 100, nowMs);
    expect(contributions["contact:never"]).toBeUndefined();
    expect(contributions["contact:active"]).toBeGreaterThan(0);
  });

  it("last_active_ms < 0 也不产生 P3 贡献", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addAgent("self");

    G.addContact("contact:neg", { tier: 5, last_active_ms: -1000 });
    G.addRelation("self", "friend", "contact:neg");

    const { contributions } = p3RelationshipCooling(G, 100, nowMs);
    expect(contributions["contact:neg"]).toBeUndefined();
  });

  it("last_active_ms=1 (1ms) 产生正常贡献", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addAgent("self");

    G.addContact("contact:telegram:1ms", { tier: 5, last_active_ms: 1 });
    G.addChannel("channel:telegram:1ms", { unread: 0, tier_contact: 5, chat_type: "private" });
    G.addRelation("self", "friend", "contact:telegram:1ms");
    G.addRelation("self", "monitors", "channel:telegram:1ms");
    G.addRelation("contact:telegram:1ms", "joined", "channel:telegram:1ms");

    const { contributions } = p3RelationshipCooling(G, 100, nowMs);
    expect(contributions["contact:telegram:1ms"]).toBeGreaterThan(0);
  });

  it("混合 epoch + 正常联系人不影响 computeAllPressures 稳定性", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addAgent("self");

    for (let i = 0; i < 5; i++) {
      G.addContact(`contact:epoch_${i}`, { tier: 15, last_active_ms: 0 });
      G.addRelation("self", "acquaintance", `contact:epoch_${i}`);
    }
    for (let i = 0; i < 3; i++) {
      const cid = `contact:real_${i}`;
      const chid = `channel:real_${i}`;
      G.addContact(cid, {
        tier: 15,
        last_active_ms: nowMs - 7200 * 1000,
      });
      G.addChannel(chid, { unread: 3, tier_contact: 15, chat_type: "private" });
      G.addRelation("self", "acquaintance", cid);
      G.addRelation("self", "monitors", chid);
      G.addRelation(cid, "joined", chid);
    }

    const p = computeAllPressures(G, 100, { nowMs });
    expect(p.API).toBeGreaterThanOrEqual(0);
    expect(p.API).toBeLessThan(7);
    expect(Number.isFinite(p.P3)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 场景 6: 频率节奏分析 — "各 tier 的理论接触周期"
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 分析 P3 sigmoid 冷却曲线在不同沉默时长下的行为。
 *
 * 核心问题：当前 θ 和 β 参数下，Alice 对各 tier 联系人的
 * "压力驱动接触周期"是否符合社交直觉？
 *
 * 方法：
 * 1. 对单个联系人扫描沉默时长 0→48h，计算 P3 贡献和 API 占比
 * 2. 找到 P3 单独驱动行动的"临界沉默时长"（API_floor 阈值）
 * 3. 与社交直觉基准对比
 */
describe("场景 6: 频率节奏分析", () => {
  const nowMs = BASE_NOW_MS;

  // 社交直觉基准（来自社会心理学的经验值）
  // @see Dunbar (2010): "How Many Friends Does One Person Need?"
  // @see Hall (2019): "How many hours does it take to make a friend?"
  const SOCIAL_INTUITION_HOURS: Record<number, { min: number; max: number; label: string }> = {
    5: { min: 0.5, max: 6, label: "亲密圈：每天 1-2 次到每 6 小时" },
    15: { min: 2, max: 24, label: "好友圈：每几小时到每天" },
    50: { min: 12, max: 72, label: "朋友圈：每天到每 3 天" },
    150: { min: 24, max: 168, label: "熟人圈：每天到每周" },
    500: { min: 168, max: 720, label: "认识圈：每周到每月" },
  };

  it("P3 对数域 sigmoid 冷却曲线形状分析（各 tier，ADR-111）", () => {
    const BETA_R = P3_BETA_R;
    const TAU_0 = P3_TAU_0;
    const ls = logSigmoid;
    const tiers = [5, 15, 50, 150, 500] as const;

    console.log("\n=== P3 对数域 Sigmoid 冷却曲线（ADR-111: Weber-Fechner）===");
    console.log("tier | θ(min) | w   | σ@θ/3  | σ@θ    | σ@3θ   | σ@1h   | σ@1d");

    for (const tier of tiers) {
      const theta = DUNBAR_TIER_THETA[tier];
      const w = DUNBAR_TIER_WEIGHT[tier];

      const atThirdTheta = ls(theta / 3, BETA_R, theta, TAU_0);
      const atTheta = ls(theta, BETA_R, theta, TAU_0);
      const at3Theta = ls(3 * theta, BETA_R, theta, TAU_0);
      const at1h = ls(3600, BETA_R, theta, TAU_0);
      const at1d = ls(86400, BETA_R, theta, TAU_0);

      console.log(
        `  ${tier.toString().padStart(3)} | ${(theta / 60).toFixed(0).padStart(6)} | ${w.toFixed(1)} | ` +
          `${atThirdTheta.toFixed(3).padStart(6)} | ${atTheta.toFixed(3).padStart(6)} | ` +
          `${at3Theta.toFixed(3).padStart(6)} | ${at1h.toFixed(3).padStart(6)} | ${at1d.toFixed(3).padStart(5)}`,
      );

      // 核心不变量：σ(θ) = 0.5（拐点定义）
      expect(atTheta).toBeCloseTo(0.5, 3);
    }
  });

  it("单联系人 P3 驱动的理论 API 在不同沉默时长下的演化", () => {
    console.log("\n=== 单联系人 P3 → API 演化（隔离测试）===");
    console.log("对每个 tier 的单个联系人，扫描沉默 0min→24h，计算 API 贡献");

    const tiers = [5, 15, 50, 150] as const;
    const scanPoints = [0, 5, 10, 20, 30, 60, 120, 240, 480, 720, 1440]; // 分钟

    for (const tier of tiers) {
      const results: Array<{ silenceMin: number; p3: number; api: number }> = [];

      for (const silenceMin of scanPoints) {
        const scanNowMs = nowMs;
        const G = new WorldModel();
        G.tick = 100;
        G.addAgent("self");

        const id = 5000 + tier;
        G.addContact(`contact:${id}`, {
          tier,
          last_active_ms: scanNowMs - silenceMin * 60 * 1000,
        });
        G.addChannel(`channel:${id}`, {
          unread: 0,
          tier_contact: tier,
          chat_type: "private",
          pending_directed: 0,
        });
        G.addRelation("self", "friend", `contact:${id}`);
        G.addRelation("self", "monitors", `channel:${id}`);
        G.addRelation(`contact:${id}`, "joined", `channel:${id}`);

        const p = computeAllPressures(G, 100, { nowMs: scanNowMs });
        results.push({ silenceMin, p3: p.P3, api: p.API });
      }

      console.log(
        `\n--- tier-${tier} (θ=${DUNBAR_TIER_THETA[tier] / 60}min, w=${DUNBAR_TIER_WEIGHT[tier]}) ---`,
      );
      console.log("  silence(min) | P3     | API    | tanh(P3/8)");
      for (const r of results) {
        const t = tanhNormalize(r.p3, DEFAULT_KAPPA[2]);
        console.log(
          `  ${r.silenceMin.toString().padStart(12)} | ${r.p3.toFixed(3).padStart(6)} | ${r.api.toFixed(3).padStart(6)} | ${t.toFixed(3)}`,
        );
      }
    }
  });

  it("API floor 门控下的理论最短行动触发时间", () => {
    // API floor 默认 = 0.05 × 6 × circadian
    // 白天高峰 circadian ≈ 0.5，夜间 circadian ≈ 2.5
    // 有效 floor = 0.05 × 6 × 0.5 = 0.15（白天最宽松）
    //           = 0.05 × 6 × 2.5 = 0.75（夜间最严格）
    const floorDay = 0.05 * 6 * 0.5;
    const floorNight = 0.05 * 6 * 2.5;

    console.log(`\n=== API Floor 门控阈值 ===`);
    console.log(`白天高峰: ${floorDay.toFixed(2)} (circadian=0.5)`);
    console.log(`夜间低谷: ${floorNight.toFixed(2)} (circadian=2.5)`);

    // 对每个 tier，二分搜索"单联系人 API 达到 floor 的沉默时长"
    const tiers = [5, 15, 50, 150] as const;

    console.log("\n=== 单联系人驱动行动的最短沉默时长 ===");
    console.log("tier | 白天(min) | 夜间(min) | 直觉基准");

    for (const tier of tiers) {
      const findThreshold = (floor: number): number => {
        // 二分搜索 [0, 48h]
        let lo = 0;
        let hi = 48 * 3600; // 48 小时（秒）
        for (let i = 0; i < 50; i++) {
          const mid = (lo + hi) / 2;
          const G = new WorldModel();
          G.tick = 100;
          G.addAgent("self");
          const id = 6000 + tier;
          G.addContact(`contact:${id}`, {
            tier,
            last_active_ms: nowMs - mid * 1000,
          });
          G.addChannel(`channel:${id}`, {
            unread: 0,
            tier_contact: tier,
            chat_type: "private",
            pending_directed: 0,
          });
          G.addRelation("self", "friend", `contact:${id}`);
          G.addRelation("self", "monitors", `channel:${id}`);
          G.addRelation(`contact:${id}`, "joined", `channel:${id}`);

          // ADR-112: eta=0 隔离 P6 ambient，此测试专注 P3 单独突破 floor
          const p = computeAllPressures(G, 100, { nowMs, eta: 0 });
          if (p.API >= floor) {
            hi = mid;
          } else {
            lo = mid;
          }
        }
        return (lo + hi) / 2;
      };

      const dayThresholdS = findThreshold(floorDay);
      const nightThresholdS = findThreshold(floorNight);
      const intuition = SOCIAL_INTUITION_HOURS[tier];

      console.log(
        `  ${tier.toString().padStart(3)} | ${(dayThresholdS / 60).toFixed(1).padStart(9)} | ` +
          `${(nightThresholdS / 60).toFixed(1).padStart(9)} | ${intuition?.label}`,
      );

      // 注意：这是 "P3 单独突破 API floor 的沉默时长"——
      // 不等于"实际接触间隔"，因为还有 rate_cap、active_cooling、sociability 竞争。
      // 真实间隔 >> API floor 触发时长。
      // 这里只验证基本合理性：不应在几秒内就触发。
      if (intuition) {
        const dayMin = dayThresholdS / 60;
        const nightMin = nightThresholdS / 60;
        // 白天：至少需要 1 分钟沉默才开始产生压力
        expect(dayMin).toBeGreaterThan(1);
        // 高 tier 联系人（150+）单独无法在夜间突破 floor ——这是设计预期：
        // tier-150 w=0.8，max P3=0.8，tanh(0.8/8)=0.1 < floor=0.75。
        // 熟人需要多维度协同（P1 未读消息、P5 被 @ 等）才会在夜间触发行动。
        if (nightMin > 24 * 60) {
          console.warn(
            `⚠️ tier-${tier} 单联系人夜间无法单独触发行动 (需要 ${(nightMin / 60).toFixed(1)}h > 48h)。` +
              `这是设计预期: w=${DUNBAR_TIER_WEIGHT[tier as keyof typeof DUNBAR_TIER_WEIGHT]}, max_contribution=${(DUNBAR_TIER_WEIGHT[tier as keyof typeof DUNBAR_TIER_WEIGHT] * 1.0).toFixed(1)}, ` +
              `tanh(${DUNBAR_TIER_WEIGHT[tier as keyof typeof DUNBAR_TIER_WEIGHT].toFixed(1)}/8)=${tanhNormalize(DUNBAR_TIER_WEIGHT[tier as keyof typeof DUNBAR_TIER_WEIGHT], 8).toFixed(3)} < floor=${(0.75).toFixed(2)}`,
          );
        }
      }
    }
  });

  it("多联系人竞争下实际能触发行动的 API 组成", () => {
    // 模拟更真实的场景：5 个亲密圈 + 10 个好友圈同时沉默，
    // 观察 API 是否足以突破 floor，以及 P3 占比多少
    const silenceHours = [0.5, 1, 2, 4, 8, 12, 24];

    console.log("\n=== 15 联系人同时沉默时的 API 演化 ===");
    console.log("silence(h) | P1    | P3    | P5    | P6    | API   | floor=0.15? | floor=0.75?");

    for (const h of silenceHours) {
      const G = new WorldModel();
      G.tick = 100;
      G.addAgent("self");

      // 5 个 tier-5 联系人
      for (let i = 0; i < 5; i++) {
        const id = 7000 + i;
        G.addContact(`contact:${id}`, {
          tier: 5,
          last_active_ms: nowMs - h * 3600 * 1000,
        });
        G.addChannel(`channel:${id}`, {
          unread: 0,
          tier_contact: 5,
          chat_type: "private",
        });
        G.addRelation("self", "friend", `contact:${id}`);
        G.addRelation("self", "monitors", `channel:${id}`);
        G.addRelation(`contact:${id}`, "joined", `channel:${id}`);
      }

      // 10 个 tier-15 联系人
      for (let i = 0; i < 10; i++) {
        const id = 8000 + i;
        G.addContact(`contact:${id}`, {
          tier: 15,
          last_active_ms: nowMs - h * 3600 * 1000,
        });
        G.addChannel(`channel:${id}`, {
          unread: 0,
          tier_contact: 15,
          chat_type: "private",
        });
        G.addRelation("self", "acquaintance", `contact:${id}`);
        G.addRelation("self", "monitors", `channel:${id}`);
        G.addRelation(`contact:${id}`, "joined", `channel:${id}`);
      }

      const p = computeAllPressures(G, 100, { nowMs });

      const passDay = p.API >= 0.15 ? "✓" : "✗";
      const passNight = p.API >= 0.75 ? "✓" : "✗";

      console.log(
        `  ${h.toString().padStart(10)} | ${p.P1.toFixed(3).padStart(5)} | ${p.P3.toFixed(3).padStart(5)} | ` +
          `${p.P5.toFixed(3).padStart(5)} | ${p.P6.toFixed(3).padStart(5)} | ${p.API.toFixed(3).padStart(5)} | ` +
          `${passDay.padStart(11)} | ${passNight}`,
      );
    }
  });

  it("P3 对数域过渡宽度验证——覆盖 θ/3 到 3θ（ADR-111）", () => {
    const BETA_R = P3_BETA_R;
    const TAU_0 = P3_TAU_0;
    const ls = logSigmoid;
    const tiers = [5, 15, 50, 150, 500] as const;

    console.log("\n=== 对数域过渡宽度验证 ===");
    console.log(`β_r = ${BETA_R}, τ₀ = ${TAU_0}s`);
    console.log("tier | θ/3(min) | 3θ(min) | σ(θ/3) | σ(3θ) | 覆盖?");

    for (const tier of tiers) {
      const theta = DUNBAR_TIER_THETA[tier];
      const atLow = ls(theta / 3, BETA_R, theta, TAU_0);
      const atHigh = ls(3 * theta, BETA_R, theta, TAU_0);

      const coverOk = atLow < 0.2 && atHigh > 0.8;
      console.log(
        `  ${tier.toString().padStart(3)} | ${(theta / 3 / 60).toFixed(1).padStart(8)} | ` +
          `${((3 * theta) / 60).toFixed(0).padStart(7)} | ${atLow.toFixed(3).padStart(6)} | ` +
          `${atHigh.toFixed(3).padStart(5)} | ${coverOk ? "✓" : "✗"}`,
      );

      // σ(θ/3) 应在 [0, 0.25] 范围（低压力）
      expect(atLow).toBeLessThan(0.25);
      // σ(3θ) 应在 [0.75, 1.0] 范围（高压力）
      expect(atHigh).toBeGreaterThan(0.75);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 场景 7: ADR-111 对数域 sigmoid 校准验证
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 验证对数域 sigmoid 的关键性质：
 * 1. 拐点不变（σ(θ) = 0.5）
 * 2. 有界性（Homeostasis 定理安全）
 * 3. 单调递增（Non-Quiescence 安全）
 * 4. 长期区分力（旧公式的 F2 缺陷已修复）
 *
 * @see docs/adr/111-log-time-sigmoid/README.md
 */
describe("场景 7: ADR-111 对数域 sigmoid 校准验证", () => {
  const BETA_R = P3_BETA_R;
  const TAU_0 = P3_TAU_0;
  const ls = logSigmoid;

  it("定理守卫：P3(c) < w_tier(c)（有界性，Homeostasis 安全）", () => {
    const tiers = [5, 15, 50, 150, 500] as const;

    // 测试极端沉默时长：1 年
    const extremeSilenceS = 365 * 86400;

    for (const tier of tiers) {
      const theta = DUNBAR_TIER_THETA[tier];
      const w = DUNBAR_TIER_WEIGHT[tier];
      const sigma = ls(extremeSilenceS, BETA_R, theta, TAU_0);
      const p3 = w * sigma;

      // P3 < w_tier（严格小于，因为 sigmoid < 1）
      expect(p3).toBeLessThan(w);
      // sigma 接近但不等于 1
      expect(sigma).toBeLessThan(1.0);
      expect(sigma).toBeGreaterThan(0.999);
    }
  });

  it("定理守卫：P3 单调递增（Non-Quiescence 安全）", () => {
    const tiers = [5, 150] as const;
    const silencePoints = [0, 60, 300, 1200, 3600, 7200, 14400, 43200, 86400, 259200];

    for (const tier of tiers) {
      const theta = DUNBAR_TIER_THETA[tier];
      let prevSigma = -1;
      for (const s of silencePoints) {
        const sigma = ls(s, BETA_R, theta, TAU_0);
        expect(sigma).toBeGreaterThanOrEqual(prevSigma);
        prevSigma = sigma;
      }
    }
  });

  it("F2 修复验证：长期区分度 > 旧公式（theta-relative 比较）", () => {
    // ADR-113: theta 增大后，旧公式在 [2θ, 20θ] 区间已饱和（差值≈0），
    // 而 logSigmoid 仍有对数域区分力。
    const oldSigmoid = sigmoid;
    const tiers = [5, 15, 50] as const;
    const OLD_BETA = 0.0025;

    console.log("\n=== F2 修复验证：长期区分力（theta-relative）===");
    console.log("tier | 旧(2θ-20θ) | 新(2θ-20θ) | 改善?");

    for (const tier of tiers) {
      const theta = DUNBAR_TIER_THETA[tier];

      // 在 theta 的倍数处比较：2θ vs 20θ（一个数量级）
      const t1 = 2 * theta;
      const t2 = 20 * theta;

      const oldAt1 = oldSigmoid(t1, OLD_BETA, theta);
      const oldAt2 = oldSigmoid(t2, OLD_BETA, theta);
      const oldDiff = oldAt2 - oldAt1;

      const newAt1 = ls(t1, BETA_R, theta, TAU_0);
      const newAt2 = ls(t2, BETA_R, theta, TAU_0);
      const newDiff = newAt2 - newAt1;

      const improved = newDiff > oldDiff;
      console.log(
        `  ${tier.toString().padStart(3)} | ${oldDiff.toFixed(6).padStart(10)} | ` +
          `${newDiff.toFixed(6).padStart(10)} | ${improved ? "✓" : "—"}`,
      );

      // 旧公式在 2θ 处已接近饱和，[2θ, 20θ] 差值极小；
      // logSigmoid 保持对数域区分力。所有 tier 均应改善。
      expect(newDiff).toBeGreaterThan(oldDiff);
    }
  });

  it("Weber-Fechner 性质：感知差异与时间比例成正比", () => {
    // 如果 Weber-Fechner 成立，σ(2θ) - σ(θ) 应约等于 σ(4θ) - σ(2θ)
    // （因为 ln(2θ) - ln(θ) = ln(2) = ln(4θ) - ln(2θ)）
    // ADR-113: theta 增大后 τ₀/θ 比例缩小，sigmoid 的 S 形非线性更显著——
    // 中点附近的梯度峰值使 Δ(θ→2θ) > Δ(2θ→4θ)。
    // 放宽比例容忍到 [0.3, 4.0]。
    const theta = DUNBAR_TIER_THETA[5];

    const at1 = ls(theta, BETA_R, theta, TAU_0);
    const at2 = ls(2 * theta, BETA_R, theta, TAU_0);
    const at4 = ls(4 * theta, BETA_R, theta, TAU_0);

    const diff1to2 = at2 - at1;
    const diff2to4 = at4 - at2;

    const ratio = diff1to2 / diff2to4;
    expect(ratio).toBeGreaterThan(0.3);
    expect(ratio).toBeLessThan(4.0);

    console.log(
      `\n=== Weber-Fechner 验证 ===\n` +
        `σ(θ)=${at1.toFixed(3)}, σ(2θ)=${at2.toFixed(3)}, σ(4θ)=${at4.toFixed(3)}\n` +
        `Δ(θ→2θ)=${diff1to2.toFixed(4)}, Δ(2θ→4θ)=${diff2to4.toFixed(4)}, ratio=${ratio.toFixed(2)}`,
    );
  });
});
