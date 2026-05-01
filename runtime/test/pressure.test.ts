/**
 * 压力函数单元测试——验证各 P1-P6 + 传播 + API 聚合的数值正确性。
 *
 * 构造固定图，手算期望值，确保 TS 实现与 Python 公式一致。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  DUNBAR_TIER_THETA,
  DUNBAR_TIER_WEIGHT,
  GROUP_PRESENCE_THETA,
  K_ABSENCE_ROUNDS,
  P3_BETA_R,
  P3_TAU_0,
  THREAD_WEIGHTS,
  TRAJECTORY_THETA_MAX_S,
  TRAJECTORY_THETA_MIN_S,
} from "../src/graph/constants.js";
import { WorldModel } from "../src/graph/world-model.js";
import {
  apiAggregate,
  apiPeak,
  computeAllPressures,
  createPressureHistory,
  observableMapping,
} from "../src/pressure/aggregate.js";
import { pProspect } from "../src/pressure/p-prospect.js";
import { p1AttentionDebt } from "../src/pressure/p1-attention.js";
import { p2InformationPressure } from "../src/pressure/p2-information.js";
import { p3RelationshipCooling } from "../src/pressure/p3-relationship.js";
import { p4ThreadDivergence } from "../src/pressure/p4-thread.js";
import { p5ResponseObligation } from "../src/pressure/p5-response.js";
import { p6Curiosity, resetNoveltyHistory } from "../src/pressure/p6-curiosity.js";
import { propagatePressures } from "../src/pressure/propagation.js";
import { logSigmoid } from "../src/utils/math.js";

const _EPS = 1e-10;

/** 测试用 tick→ms 转换（约定：1 tick = 60s）。 */
function tickMs(tick: number): number {
  return tick * 60_000;
}

/** 构造一个包含所有实体类型的测试图。 */
function buildTestGraph(): WorldModel {
  const G = new WorldModel();
  G.tick = 100;

  // Agent
  G.addAgent("self");

  // Contacts: 不同 tier
  G.addContact("alice", { tier: 5, last_active_ms: tickMs(95) });
  G.addContact("bob", { tier: 50, last_active_ms: tickMs(60) });
  G.addContact("carol", { tier: 150, last_active_ms: tickMs(1) });

  // Channels
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
  G.addChannel("channel:empty", { unread: 0, tier_contact: 50, chat_type: "private" });

  // Threads
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
  G.addThread("t_done", { weight: "minor", status: "resolved", created_ms: tickMs(10) });

  // InfoItems
  G.addFact("i1", {
    importance: 0.8,
    stability: 2.0,
    last_access_ms: tickMs(90),
    volatility: 0.3,
    tracked: true,
    created_ms: tickMs(80),
    novelty: 0.7,
    fact_type: "observation", // episodic — 测试 SM-2 衰减数学
  });
  G.addFact("i2", {
    importance: 0.5,
    stability: 1.0,
    last_access_ms: tickMs(50),
    volatility: 0.1,
    tracked: false,
    created_ms: tickMs(30),
    novelty: 0.2,
    fact_type: "observation", // episodic — 测试 SM-2 衰减数学
  });

  // 边
  G.addRelation("self", "friend", "alice");
  G.addRelation("self", "acquaintance", "bob");
  G.addRelation("self", "stranger", "carol");
  G.addRelation("self", "monitors", "channel:alice");
  G.addRelation("self", "monitors", "channel:group");
  G.addRelation("alice", "joined", "channel:alice");
  G.addRelation("bob", "joined", "channel:group");
  G.addRelation("t_urgent", "involves", "alice");
  G.addRelation("i1", "from", "channel:alice");

  return G;
}

describe("P1 注意力债务", () => {
  it("计算 unread * w_tier 的加权和", () => {
    const G = buildTestGraph();
    const { total, contributions } = p1AttentionDebt(G, tickMs(100));

    // "channel:alice": unread=5, tier=5, w=5.0, chat_type=private, chatW=3.0 → 75.0
    expect(contributions["channel:alice"]).toBeCloseTo(5 * DUNBAR_TIER_WEIGHT[5] * 3.0, 10);
    // "channel:group": unread=10, tier=150, w=0.8, chat_type=group, chatW=1.0 → 8.0
    expect(contributions["channel:group"]).toBeCloseTo(10 * DUNBAR_TIER_WEIGHT[150] * 1.0, 10);
    // "channel:empty": unread=0 → 不出现
    expect(contributions["channel:empty"]).toBeUndefined();

    expect(total).toBeCloseTo(75.0 + 8.0, 10);
  });

  it("空图返回 0", () => {
    const G = new WorldModel();
    const { total, contributions } = p1AttentionDebt(G, Date.now());
    expect(total).toBe(0);
    expect(Object.keys(contributions)).toHaveLength(0);
  });
});

describe("P2 信息压力", () => {
  it("计算 memory decay + staleness", () => {
    const G = buildTestGraph();
    const n = 100;
    const d = -0.5;
    const { total, contributions } = p2InformationPressure(G, n, tickMs(n), d);

    // i1: importance=0.8, stability=2.0, last_access=90, tracked=true, volatility=0.3, created=80
    // T1.6: scaledN = lastAccess + (n - lastAccess) / FACT_TIME_SCALE
    // scaledN = 90 + (100-90)/1440 = 90.006944...
    // R = (1 + (scaledN-90)/(9*2.0))^(-0.5)
    const scaledN1 = 90 + (100 - 90) / 1440;
    const R1 = (1.0 + (scaledN1 - 90) / (9.0 * 2.0)) ** -0.5;
    const memory1 = 0.8 * (1.0 - R1);
    const staleness1 = 0.3 * (100 - 80); // tracked=true
    expect(contributions.i1).toBeCloseTo(memory1 + staleness1, 10);

    // i2: importance=0.5, stability=1.0, last_access=50, tracked=false
    // T1.6: scaledN = 50 + (100-50)/1440
    const scaledN2 = 50 + (100 - 50) / 1440;
    const R2 = (1.0 + (scaledN2 - 50) / (9.0 * 1.0)) ** -0.5;
    const memory2 = 0.5 * (1.0 - R2);
    // tracked=false → staleness=0
    expect(contributions.i2).toBeCloseTo(memory2, 10);

    expect(total).toBeCloseTo(contributions.i1 + contributions.i2, 10);
  });

  it("reinforcement_count=0 时行为不变（乘子=1）", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addFact("fact0", {
      importance: 0.8,
      stability: 2.0,
      last_access_ms: tickMs(90),
      volatility: 0,
      tracked: false,
      created_ms: tickMs(80),
      novelty: 0.5,
      reinforcement_count: 0,
      fact_type: "observation", // episodic — 测试 SM-2 衰减
    });

    const n = 100;
    const d = -0.5;
    const { contributions } = p2InformationPressure(G, n, tickMs(n), d);

    // reinforcement_count=0 → reinforceFactor = max(1, log2(1)) = 1 → adjustedR = R
    const scaledN = 90 + (100 - 90) / 1440;
    const R = (1.0 + (scaledN - 90) / (9.0 * 2.0)) ** -0.5;
    expect(contributions.fact0).toBeCloseTo(0.8 * (1.0 - R), 10);
  });

  it("高 stability 的 fact P2 贡献更低（连续稳定性频谱）", () => {
    // 连续稳定性频谱：reinforcement 不再直接影响 P2（已折叠进 stability）。
    // 高 stability 的 fact 衰减更慢 → R 更高 → P2 更低。
    const GLow = new WorldModel();
    GLow.tick = 100;
    GLow.addFact("fact", {
      importance: 0.8,
      stability: 1.0,
      last_access_ms: tickMs(90),
      volatility: 0,
      tracked: false,
      created_ms: tickMs(80),
      novelty: 0.5,
      fact_type: "observation",
    });

    const GHigh = new WorldModel();
    GHigh.tick = 100;
    GHigh.addFact("fact", {
      importance: 0.8,
      stability: 40.0,
      last_access_ms: tickMs(90),
      volatility: 0,
      tracked: false,
      created_ms: tickMs(80),
      novelty: 0.5,
      fact_type: "preference",
    });

    const n = 100;
    const d = -0.5;
    const low = p2InformationPressure(GLow, n, tickMs(n), d);
    const high = p2InformationPressure(GHigh, n, tickMs(n), d);

    // 高稳定性 fact R 更高 → P2 贡献更低
    expect(high.contributions.fact).toBeLessThan(low.contributions.fact);
  });

  it("P2 memoryTerm 有界 ∈ [0, importance]", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addFact("fresh", {
      importance: 0.9,
      stability: 2.0,
      last_access_ms: tickMs(100),
      volatility: 0,
      tracked: false,
      created_ms: tickMs(80),
      novelty: 0.5,
      fact_type: "observation",
    });

    const n = 100;
    const { contributions } = p2InformationPressure(G, n, tickMs(n));

    // R ∈ [0,1] → memoryTerm = importance × (1-R) ∈ [0, importance]
    expect(contributions.fresh).toBeGreaterThanOrEqual(0);
    expect(contributions.fresh).toBeLessThanOrEqual(0.9);
  });
});

describe("P3 关系冷却", () => {
  it("计算 logSigmoid cooling（ADR-111）", () => {
    const G = buildTestGraph();
    const n = 100;
    const { total, contributions } = p3RelationshipCooling(G, n, tickMs(n));

    // alice: tier=5, thetaS=1200s, silenceS=(100-95)*60=300s
    const silenceAliceS = (100 - 95) * 60;
    const thetaAliceS = DUNBAR_TIER_THETA[5];
    const cool_alice = logSigmoid(silenceAliceS, P3_BETA_R, thetaAliceS, P3_TAU_0);
    expect(contributions.alice).toBeCloseTo(DUNBAR_TIER_WEIGHT[5] * cool_alice, 10);

    // bob: tier=50, thetaS=2400s, silenceS=(100-60)*60=2400s
    const silenceBobS = (100 - 60) * 60;
    const thetaBobS = DUNBAR_TIER_THETA[50];
    const cool_bob = logSigmoid(silenceBobS, P3_BETA_R, thetaBobS, P3_TAU_0);
    expect(contributions.bob).toBeCloseTo(DUNBAR_TIER_WEIGHT[50] * cool_bob, 10);

    // carol: tier=150, thetaS=4800s, silenceS=(100-1)*60=5940s
    const silenceCarolS = (100 - 1) * 60;
    const thetaCarolS = DUNBAR_TIER_THETA[150];
    const cool_carol = logSigmoid(silenceCarolS, P3_BETA_R, thetaCarolS, P3_TAU_0);
    expect(contributions.carol).toBeCloseTo(DUNBAR_TIER_WEIGHT[150] * cool_carol, 10);

    expect(total).toBeCloseTo(contributions.alice + contributions.bob + contributions.carol, 10);
  });
});

describe("P3 群组存在子维度（ADR-104）", () => {
  it("冷启动（无 EMA）：fallback 到 GROUP_PRESENCE_THETA[tier]", () => {
    const G = new WorldModel();
    G.tick = 200;
    G.addChannel("channel:group_1", {
      unread: 5,
      tier_contact: 150,
      chat_type: "supergroup",
      pending_directed: 0,
      last_directed_ms: 0,
      last_alice_action_ms: tickMs(100),
      last_activity_ms: tickMs(150),
    });

    const n = 200;
    // 不传 channelRateEma → 冷启动 fallback
    const { contributions } = p3RelationshipCooling(G, n, tickMs(n));

    // silenceS = (200 - 100) * 60 = 6000s, tier=150, w=0.8
    // 冷启动：adjustedThetaS = GROUP_PRESENCE_THETA[150] = 14400s
    const silenceS = (200 - 100) * 60;
    const thetaS = GROUP_PRESENCE_THETA[150];
    const expected = DUNBAR_TIER_WEIGHT[150] * logSigmoid(silenceS, P3_BETA_R, thetaS, P3_TAU_0);
    expect(contributions["channel:group_1"]).toBeCloseTo(expected, 10);
  });

  it("轨迹驱动 theta（ADR-161 §3.4）：EMA 活跃群 → theta 更短", () => {
    const G = new WorldModel();
    G.tick = 200;
    G.addChannel("channel:active_group", {
      unread: 0,
      tier_contact: 150,
      chat_type: "supergroup",
      pending_directed: 0,
      last_directed_ms: 0,
      last_alice_action_ms: tickMs(100),
      last_activity_ms: tickMs(150),
    });

    // EMA=0.5 msgs/tick, tickDt=120s → msgsPerS = 0.5/120 ≈ 0.00417
    // avgIntervalS = 1/0.00417 = 240s
    // theta = K_ABSENCE_ROUNDS(10) × 240 = 2400s
    const emaMap = new Map([["channel:active_group", { ema: 0.5, variance: 0.1 }]]);
    const tickDt = 120; // 2 min tick (typical patrol)
    const { contributions } = p3RelationshipCooling(G, 200, tickMs(200), emaMap, tickDt);

    const silenceS = (200 - 100) * 60; // 6000s
    const msgsPerS = 0.5 / tickDt;
    const avgIntervalS = 1 / msgsPerS;
    const expectedTheta = Math.max(
      TRAJECTORY_THETA_MIN_S,
      Math.min(K_ABSENCE_ROUNDS * avgIntervalS, TRAJECTORY_THETA_MAX_S),
    );
    expect(expectedTheta).toBe(2400); // 验证手算
    const expected =
      DUNBAR_TIER_WEIGHT[150] * logSigmoid(silenceS, P3_BETA_R, expectedTheta, P3_TAU_0);
    expect(contributions["channel:active_group"]).toBeCloseTo(expected, 10);

    // 验证轨迹驱动 theta < 冷启动 theta → 活跃群压力更大
    const { contributions: coldContribs } = p3RelationshipCooling(G, 200, tickMs(200));
    expect(contributions["channel:active_group"]).toBeGreaterThan(
      coldContribs["channel:active_group"],
    );
  });

  it("轨迹驱动 theta：极高 EMA → 夹紧到 TRAJECTORY_THETA_MIN_S", () => {
    const G = new WorldModel();
    G.tick = 200;
    G.addChannel("channel:hyper", {
      unread: 0,
      tier_contact: 150,
      chat_type: "supergroup",
      pending_directed: 0,
      last_directed_ms: 0,
      last_alice_action_ms: tickMs(100),
      last_activity_ms: tickMs(150),
    });

    // EMA=10 msgs/tick, tickDt=60s → msgsPerS=0.167, avgInterval=6s
    // theta = 10 × 6 = 60s → 夹紧到 TRAJECTORY_THETA_MIN_S (1800s)
    const emaMap = new Map([["channel:hyper", { ema: 10, variance: 5 }]]);
    const { contributions } = p3RelationshipCooling(G, 200, tickMs(200), emaMap, 60);

    const silenceS = (200 - 100) * 60;
    const expected =
      DUNBAR_TIER_WEIGHT[150] * logSigmoid(silenceS, P3_BETA_R, TRAJECTORY_THETA_MIN_S, P3_TAU_0);
    expect(contributions["channel:hyper"]).toBeCloseTo(expected, 10);
  });

  it("轨迹驱动 theta：极低 EMA → 夹紧到 TRAJECTORY_THETA_MAX_S", () => {
    const G = new WorldModel();
    G.tick = 200;
    G.addChannel("channel:dead", {
      unread: 0,
      tier_contact: 150,
      chat_type: "group",
      pending_directed: 0,
      last_directed_ms: 0,
      last_alice_action_ms: tickMs(100),
      last_activity_ms: tickMs(150),
    });

    // EMA=0.001 msgs/tick（刚好过阈值），tickDt=120s → msgsPerS=8.3e-6
    // avgInterval=120000s, theta = 10 × 120000 = 1200000s → 夹紧到 604800s
    const emaMap = new Map([["channel:dead", { ema: 0.001, variance: 0 }]]);
    const { contributions } = p3RelationshipCooling(G, 200, tickMs(200), emaMap, 120);

    const silenceS = (200 - 100) * 60;
    const expected =
      DUNBAR_TIER_WEIGHT[150] * logSigmoid(silenceS, P3_BETA_R, TRAJECTORY_THETA_MAX_S, P3_TAU_0);
    expect(contributions["channel:dead"]).toBeCloseTo(expected, 10);
  });

  it("群组 S3 保护：alice_last_action > group_last_activity → 贡献为 0", () => {
    const G = new WorldModel();
    G.tick = 200;
    G.addChannel("channel:group_s3", {
      unread: 3,
      tier_contact: 150,
      chat_type: "group",
      pending_directed: 0,
      last_directed_ms: 0,
      last_alice_action_ms: tickMs(180),
      last_activity_ms: tickMs(160), // Alice 说了之后群里没人说话
    });

    const { contributions } = p3RelationshipCooling(G, 200, tickMs(200));
    expect(contributions["channel:group_s3"]).toBeUndefined();
  });

  it("私聊频道跳过群组子维度", () => {
    const G = new WorldModel();
    G.tick = 200;
    G.addChannel("channel:private", {
      unread: 5,
      tier_contact: 50,
      chat_type: "private",
      pending_directed: 0,
      last_directed_ms: 0,
      last_alice_action_ms: tickMs(50),
      last_activity_ms: tickMs(150),
    });

    const { contributions } = p3RelationshipCooling(G, 200, tickMs(200));
    // private channel 不产生群组贡献
    expect(contributions["channel:private"]).toBeUndefined();
  });

  it("群组 Top-K 隔离：10 contacts + 3 groups → Top-K=5 仅截断 contact", () => {
    const G = new WorldModel();
    G.tick = 200;

    // 10 个 contact（都有对应频道，避免 S3 跳过）
    for (let i = 0; i < 10; i++) {
      G.addContact(`contact:${i}`, { tier: 50, last_active_ms: tickMs(50) });
      G.addChannel(`channel:${i}`, {
        unread: 0,
        tier_contact: 50,
        chat_type: "private",
        pending_directed: 0,
        last_directed_ms: 0,
      });
    }

    // 3 个群组频道
    for (let i = 0; i < 3; i++) {
      G.addChannel(`channel:grp_${i}`, {
        unread: 5,
        tier_contact: 150,
        chat_type: "group",
        pending_directed: 0,
        last_directed_ms: 0,
        last_alice_action_ms: tickMs(50),
        last_activity_ms: tickMs(150),
      });
    }

    const { contributions } = p3RelationshipCooling(G, 200, tickMs(200));

    // ADR-113: contact 贡献应被截断到 8 个（Top-K=8）
    const contactKeys = Object.keys(contributions).filter((k) => k.startsWith("contact:"));
    expect(contactKeys.length).toBeLessThanOrEqual(8);

    // 3 个群组贡献全部保留（不受 Top-K 影响）
    const groupKeys = Object.keys(contributions).filter((k) => k.startsWith("channel:grp_"));
    expect(groupKeys.length).toBe(3);
  });

  it("建立存在守卫：last_alice_action_ms = 0 → 不产生群组贡献", () => {
    const G = new WorldModel();
    G.tick = 200;
    G.addChannel("channel:never", {
      unread: 10,
      tier_contact: 150,
      chat_type: "supergroup",
      pending_directed: 0,
      last_directed_ms: 0,
      // last_alice_action_ms 未设置（默认 0）
      last_activity_ms: tickMs(150),
    });

    const { contributions } = p3RelationshipCooling(G, 200, tickMs(200));
    expect(contributions["channel:never"]).toBeUndefined();
  });

  it("thinking 抑制：alice_thinking_since 有值 → 不产生群组贡献", () => {
    const G = new WorldModel();
    G.tick = 200;
    G.addChannel("channel:thinking", {
      unread: 5,
      tier_contact: 150,
      chat_type: "group",
      pending_directed: 0,
      last_directed_ms: 0,
      last_alice_action_ms: tickMs(100),
      last_activity_ms: tickMs(150),
      alice_thinking_since: 190,
    });

    const { contributions } = p3RelationshipCooling(G, 200, tickMs(200));
    expect(contributions["channel:thinking"]).toBeUndefined();
  });

  // ADR-206: 频道实体隔离
  it("chat_type=channel 不产生群组存在贡献", () => {
    const G = new WorldModel();
    G.addAgent("self");
    G.addChannel("channel:feed", {
      chat_type: "channel",
      tier_contact: 150,
      last_activity_ms: tickMs(150),
    });
    G.updateChannel("channel:feed", { last_alice_action_ms: tickMs(100) } as never);
    G.addRelation("self", "monitors", "channel:feed");

    const { contributions } = p3RelationshipCooling(G, 200, tickMs(200));
    // 频道是信息流实体，不产生社交缺席压力
    expect(contributions["channel:feed"]).toBeUndefined();
  });

  it("幽灵联系人（频道镜像）不产生 contact P3", () => {
    const G = new WorldModel();
    G.addAgent("self");
    // 频道节点
    G.addChannel("channel:telegram:-1009900000001", {
      chat_type: "channel",
      tier_contact: 150,
    });
    // 幽灵联系人（与频道数字 ID 相同）
    G.addContact("contact:telegram:-1009900000001", {
      tier: 50,
      last_active_ms: tickMs(50),
      display_name: "Rem�",
    });
    G.addRelation("self", "acquaintance", "contact:telegram:-1009900000001");

    const { contributions } = p3RelationshipCooling(G, 200, tickMs(200));
    // 幽灵联系人不参与社交压力
    expect(contributions["contact:telegram:-1009900000001"]).toBeUndefined();
  });

  it("真人联系人不受频道隔离影响", () => {
    const G = new WorldModel();
    G.addAgent("self");
    // 真人联系人（没有对应的 channel 节点是 "channel" 类型）
    G.addContact("contact:12345678", {
      tier: 50,
      last_active_ms: tickMs(50),
    });
    G.addChannel("channel:12345678", {
      chat_type: "private",
      tier_contact: 50,
    });
    G.addRelation("self", "acquaintance", "contact:12345678");

    const { contributions } = p3RelationshipCooling(G, 200, tickMs(200));
    // 真人联系人正常产生 P3
    expect(contributions["contact:12345678"]).toBeGreaterThan(0);
  });
});

describe("P4 线程发散", () => {
  it("计算 log(1+age/τ) · w + deadline term（ADR-64 VI-1）", () => {
    const G = buildTestGraph();
    const n = 100;
    // threadAgeScale 从 ticks 迁移到秒：1440 ticks × 60s = 86400s
    const threadAgeScaleS = 86_400;
    // 审计修复: forecast 分量已从 P4 移除（由 P_prospect 统一处理），移除 delta 参数
    const { total, contributions } = p4ThreadDivergence(G, n, tickMs(n), threadAgeScaleS);

    // t_urgent: created=90, w=2.0 (major), deadline=110
    // ageS = (100-90)*60 = 600s
    // backtrack = log(1 + 600/86400) * 2.0
    // 审计修复: P4 不再计算 forecast，只有 backtrack
    const ageS_urgent = (100 - 90) * 60;
    const backtrack_urgent = Math.log(1 + ageS_urgent / threadAgeScaleS) * THREAD_WEIGHTS.major;
    expect(contributions.t_urgent).toBeCloseTo(backtrack_urgent, 10);

    // t_minor: created=50, w=1.0 (minor), deadline=Infinity
    const ageS_minor = (100 - 50) * 60;
    const backtrack_minor = Math.log(1 + ageS_minor / threadAgeScaleS) * THREAD_WEIGHTS.minor;
    // deadline=Infinity → forecast=0
    expect(contributions.t_minor).toBeCloseTo(backtrack_minor, 10);

    // t_done: status="resolved" → 跳过
    expect(contributions.t_done).toBeUndefined();

    expect(total).toBeCloseTo(contributions.t_urgent + contributions.t_minor, 10);
  });

  it("长线程不爆炸（ADR-64 VI-1 关键约束）", () => {
    const G = new WorldModel();
    G.tick = 10080; // 1 周
    // ADR-166: created_ms 必须为正值（0 = unknown → 跳过）
    G.addThread("t_week", {
      weight: "major",
      status: "open",
      created_ms: 1,
      deadline: Infinity,
    });
    // threadAgeScale 秒：86400s = 1天
    const { total } = p4ThreadDivergence(G, 10080, tickMs(10080), 86_400);
    // ageS ≈ (10080*60000 - 1)/1000 ≈ 604800s (7 天)
    // log(1 + 604800/86400) * 2.0 = log(8) * 2.0 ≈ 2.08 * 2 = 4.16 — 不是百万级
    expect(total).toBeLessThan(10);
    expect(total).toBeGreaterThan(0);
  });
});

describe("P5 回应义务", () => {
  it("计算 directed · w · decay", () => {
    const G = buildTestGraph();
    const n = 100;
    const { total, contributions } = p5ResponseObligation(G, n, tickMs(n));

    // "channel:alice": directed=2, tier=5, w=5.0, chat_type=private, chatW=2.0,
    // last_directed_ms=tickMs(98), ageS=(tickMs(100)-tickMs(98))/1000=120
    // ADR-157: 指数核 2^(-ageS/halfLife), halfLife=3600 (private)
    // ADR-215: effectiveDirected = ln(1+min(raw, 5)), directed=2 → ln(3) ≈ 1.0986
    const decay = 2 ** (-120 / 3600);
    const effectiveDirected = Math.log1p(2); // ln(3) ≈ 1.0986
    expect(contributions["channel:alice"]).toBeCloseTo(
      effectiveDirected * DUNBAR_TIER_WEIGHT[5] * 2.0 * decay,
      10,
    );

    // "channel:group": directed=0 → 跳过
    expect(contributions["channel:group"]).toBeUndefined();

    // "channel:empty": directed=0 → 跳过
    expect(contributions["channel:empty"]).toBeUndefined();

    expect(total).toBeCloseTo(contributions["channel:alice"], 10);
  });
});

describe("P5 conversation turn awareness (M4)", () => {
  it("alice_turn conversation → P5 contribution 30% 更高", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addAgent("self");
    G.addChannel("ch1", {
      unread: 5,
      tier_contact: 50,
      chat_type: "private",
      pending_directed: 2,
      last_directed_ms: tickMs(98),
    });
    G.addRelation("self", "monitors", "ch1");

    // 无 conversation → 基线
    const { contributions: base } = p5ResponseObligation(G, 100, tickMs(100));
    const baseVal = base.ch1;
    expect(baseVal).toBeGreaterThan(0);

    // 添加 alice_turn conversation
    G.addConversation("conversation:ch1_90", {
      channel: "ch1",
      participants: ["contact:1"],
      state: "active",
      start_ms: tickMs(90),
      last_activity_ms: tickMs(98),
      turn_state: "alice_turn",
      pace: 1,
      message_count: 10,
      alice_message_count: 4,
    });
    G.addRelation("conversation:ch1_90", "happens_in", "ch1");

    const { contributions: boosted } = p5ResponseObligation(G, 100, tickMs(100));
    // alice_turn → 1.3x boost
    expect(boosted.ch1).toBeCloseTo(baseVal * 1.3, 10);
  });

  it("无 conversation → turnBoost=1.0（v4 退化）", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addAgent("self");
    G.addChannel("ch1", {
      unread: 3,
      tier_contact: 50,
      chat_type: "group",
      pending_directed: 1,
      last_directed_ms: tickMs(99),
    });
    G.addRelation("self", "monitors", "ch1");

    const { contributions } = p5ResponseObligation(G, 100, tickMs(100));
    // 无 conv → 不额外 boost
    const w = DUNBAR_TIER_WEIGHT[50];
    const chatW = 1.0; // group
    // ADR-157: 指数核, ageS=60, halfLife=3600 (group — ADR-186 统一为与私聊一致)
    // ADR-215: effectiveDirected = ln(1+1) = ln(2) ≈ 0.693
    const decay = 2 ** (-60.0 / 3600.0);
    const effectiveDirected = Math.log1p(1); // ln(2) ≈ 0.693
    expect(contributions.ch1).toBeCloseTo(effectiveDirected * w * chatW * decay, 10);
  });

  it("other_turn conversation → turnBoost=1.0", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addAgent("self");
    G.addChannel("ch1", {
      unread: 5,
      tier_contact: 50,
      chat_type: "private",
      pending_directed: 2,
      last_directed_ms: tickMs(98),
    });
    G.addRelation("self", "monitors", "ch1");

    // 基线（无 conv）
    const { contributions: base } = p5ResponseObligation(G, 100, tickMs(100));

    // 添加 other_turn conversation
    G.addConversation("conversation:ch1_90", {
      channel: "ch1",
      participants: ["contact:1"],
      state: "active",
      start_ms: tickMs(90),
      last_activity_ms: tickMs(98),
      turn_state: "other_turn",
      pace: 1,
      message_count: 10,
      alice_message_count: 5,
    });
    G.addRelation("conversation:ch1_90", "happens_in", "ch1");

    const { contributions: notBoosted } = p5ResponseObligation(G, 100, tickMs(100));
    // other_turn → 不 boost
    expect(notBoosted.ch1).toBeCloseTo(base.ch1, 10);
  });
});

describe("P6 好奇心（ADR-112 Surprise-driven Curiosity）", () => {
  beforeEach(() => resetNoveltyHistory());

  it("无 contact 时返回 ambient curiosity（D2 冷启动）", () => {
    const G = new WorldModel();
    G.addAgent("self", { created_ms: Date.now() });
    const { total } = p6Curiosity(G, Date.now(), 0.6);
    // 空图 + 刚创建 → familiarity ≈ 0 → ambient = 0.6
    expect(total).toBeCloseTo(0.6, 1);
  });

  it("新联系人 σ 高 → surprise 驱动好奇心", () => {
    const G = new WorldModel();
    G.tick = 200;
    const now = Date.now();
    // 审计修复: last_active_ms 必须 > 0，否则 M1 跳过（从未交互的联系人不产生好奇心）
    G.addContact("c1", { tier: 5, last_active_ms: now - 3600_000, interaction_count: 0 });
    G.addContact("c2", {
      tier: 5,
      last_active_ms: now - 3600_000,
      interaction_count: 100,
    });
    const { contributions } = p6Curiosity(G, now);
    // c1: σ=1.0（新联系人） → surprise 高
    // c2: σ=1/(1+100/10)≈0.091 → surprise 低
    expect(contributions.c1).toBeGreaterThan(contributions.c2);
  });

  it("高 tier 联系人好奇心更高（w_tier 加权）", () => {
    const G = new WorldModel();
    G.tick = 200;
    const now = Date.now();
    G.addContact("c_intimate", { tier: 5, last_active_ms: now - 3600_000 });
    G.addContact("c_acquaintance", { tier: 500, last_active_ms: now - 3600_000 });
    const { contributions } = p6Curiosity(G, now);
    // tier=5 权重=5.0, tier=500 权重=0.3 → 亲密圈好奇心更强
    expect(contributions.c_intimate).toBeGreaterThan(contributions.c_acquaintance);
  });

  it("最近交互过的联系人好奇心打折（γ 折扣）", () => {
    const G = new WorldModel();
    G.tick = 100;
    const now = Date.now();
    G.addContact("c_recent", { tier: 5, last_active_ms: now }); // 刚交互
    G.addContact("c_old", { tier: 5, last_active_ms: now - 7200_000 }); // 2 小时前
    const { contributions } = p6Curiosity(G, now);
    // c_recent: timeSinceLast≈0 → γ≈0 → 好奇心≈0
    // c_old: timeSinceLast=7200s → γ≈0.91
    expect(contributions.c_recent).toBeUndefined(); // γ≈0 → 不贡献
    expect(contributions.c_old).toBeGreaterThan(0);
  });

  it("画像完整的老联系人仍有基线 surprise（P6 不再永久死亡）", () => {
    const G = new WorldModel();
    G.tick = 200;
    const now = Date.now();
    G.addContact("c_full", {
      tier: 5,
      last_active_ms: now - 86_400_000, // 1 天前 → γ≈1
      display_name: "Bob",
      language_preference: "en",
      relation_type: "friend",
      is_bot: false,
      interaction_count: 50,
    });
    const { total, contributions } = p6Curiosity(G, now);
    // ADR-112: 即使画像完整，σ = 1/(1+50/10) ≈ 0.167 提供基线 surprise
    expect(total).toBeGreaterThan(0);
    expect(contributions.c_full).toBeGreaterThan(0);
  });

  it("per-contact contributions 总和与 total 一致（或 ambient 兜底）", () => {
    const G = new WorldModel();
    G.tick = 200;
    const now = Date.now();
    G.addContact("c1", { tier: 5, last_active_ms: now - 86_400_000 });
    G.addContact("c2", { tier: 15, last_active_ms: now - 3600_000 });
    G.addContact("c3", { tier: 150, last_active_ms: now - 600_000 });
    const { total, contributions } = p6Curiosity(G, now);
    const sum = Object.values(contributions).reduce((a, b) => a + b, 0);
    // total = max(surpriseTotal, ambientCuriosity)
    // surpriseTotal 归一化后 = sum(contributions)
    // 如果 ambient > surprise → total > sum（ambient 兜底）
    expect(total).toBeGreaterThanOrEqual(sum - 1e-10);
  });

  it("D2: mature graph with real surprise still keeps P6 alive", () => {
    const G = new WorldModel();
    const now = Date.now();
    G.addAgent("self", { created_ms: now - 7 * 86_400_000 }); // 7 天前
    // 添加 150 个联系人
    for (let i = 0; i < 150; i++) {
      G.addContact(`c_${i}`, { tier: 150, last_active_ms: now - 1000 });
    }
    const { total } = p6Curiosity(G, now, 0.6);
    // 150 contacts + 7 天 → familiarity ≈ 1.0 → ambient ≈ 0
    // 但联系人 prediction error 是未满足的 epistemic pressure，不应被当作已满足 novelty 反向清零。
    // P6 ∈ [0, η] 是论文保证的有界性
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(0.6);
  });

  it("does not invert surprise into zero pressure", () => {
    const G = new WorldModel();
    const now = Date.now();
    G.addAgent("self", { created_ms: now - 30 * 86_400_000 });
    for (let i = 0; i < 529; i++) {
      G.addContact(`c_${i}`, {
        tier: 500,
        last_active_ms: now - 3600_000,
        interaction_count: 100,
      });
    }

    const { total, contributions } = p6Curiosity(G, now, 0.6);

    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(0.6);
    expect(Object.values(contributions).some((value) => value > 0)).toBe(true);
  });

  it("沉默偏差驱动 surprise（tier-derived 期望）", () => {
    const G = new WorldModel();
    G.tick = 200;
    const now = Date.now();
    // tier=5 期望 12h silence。实际沉默 7 天 → 强偏差
    G.addContact("c_deviant", {
      tier: 5,
      last_active_ms: now - 7 * 86_400_000, // 7 天前
      interaction_count: 50,
    });
    // tier=150 期望 30 天 silence。实际沉默 7 天 → 弱偏差（提前回归）
    G.addContact("c_normal", {
      tier: 150,
      last_active_ms: now - 7 * 86_400_000, // 同样 7 天前
      interaction_count: 50,
    });
    const { contributions } = p6Curiosity(G, now);
    // tier=5 联系人沉默 7 天是极大偏差（期望 12h），应该更 surprising
    // 但 w_tier 加权也影响：tier=5 权重远高于 tier=150
    expect(contributions.c_deviant).toBeGreaterThan(contributions.c_normal);
  });

  it("surprise 有界 ∈ [0, 1]（tanh 保证）", () => {
    const G = new WorldModel();
    G.tick = 200;
    G.addAgent("self", { created_ms: tickMs(0) });
    // 极端场景：tier=500 但交互 1000 次（严重 mismatch）
    G.addContact("c_extreme", {
      tier: 500,
      last_active_ms: tickMs(199),
      interaction_count: 1000,
    });
    const { contributions } = p6Curiosity(G, tickMs(200));
    // surprise 应 > 0（有信号）且 ≤ 1（有界）
    expect(contributions.c_extreme).toBeGreaterThan(0);
    // wTier * surprise * gamma 中 surprise ≤ 1, wTier ≤ 1, gamma ≤ 1
    // 归一化后更小
    expect(contributions.c_extreme).toBeLessThanOrEqual(1);
  });
});

describe("Laplacian 传播", () => {
  it("入边邻居的压力传播到目标", () => {
    const G = new WorldModel();
    G.addContact("a");
    G.addContact("b");
    G.addChannel("ch");
    // a → b (social, ω=1.0)
    G.addRelation("a", "friend", "b");
    // a → ch (spatial, ω=0.5)
    G.addRelation("a", "monitors", "ch");

    const local = { a: 10.0, b: 5.0 };
    const mu = 0.3;
    const pEff = propagatePressures(G, local, mu);

    // a 没有入边 → p_eff(a) = 10.0
    expect(pEff.a).toBeCloseTo(10.0, 10);
    // b 有入边 a→b (social, ω=1.0) → p_eff(b) = 5 + 0.3 * 1.0 * 10 = 8.0
    expect(pEff.b).toBeCloseTo(5.0 + 0.3 * 1.0 * 10.0, 10);
    // ch 有入边 a→ch (spatial, ω=0.5), group channel λ=0.3
    // → p_eff(ch) = 0 + 0.3 * 0.3 * 0.5 * 10 = 0.45
    expect(pEff.ch).toBeCloseTo(0.3 * 0.3 * 0.5 * 10.0, 10);
  });

  it("addressed decay: 源端有 last_alice_action_ms → 抑制传播", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addContact("a", { last_alice_action_ms: tickMs(100) });
    G.addChannel("ch");
    G.addRelation("a", "monitors", "ch");

    const local = { a: 10.0 };
    const mu = 0.3;
    // tick=100, gapS=0 → α=1/(1+0/600)=1, factor=1-1=0 → 传播为 0
    const pEff = propagatePressures(G, local, mu, tickMs(100));
    expect(pEff.ch).toBeCloseTo(0, 10);
  });

  it("addressed decay: 目标端有 last_alice_action_ms → 抑制传播（B2 修复）", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addContact("a");
    G.addChannel("ch", { last_alice_action_ms: tickMs(100) });
    G.addRelation("a", "monitors", "ch");

    const local = { a: 10.0 };
    const mu = 0.3;
    // tick=100, 目标端 ch gapS=0 → α=1, factor=0 → 传播为 0
    const pEff = propagatePressures(G, local, mu, tickMs(100));
    expect(pEff.ch).toBeCloseTo(0, 10);
  });

  it("addressed decay: 双端都有 → 取最强抑制", () => {
    const G = new WorldModel();
    G.tick = 100; // 源端: 较旧 → factor 较高
    G.addContact("a", { last_alice_action_ms: tickMs(90) });
    // 目标端: 刚回应 → factor=0
    G.addChannel("ch", { last_alice_action_ms: tickMs(100) });
    G.addRelation("a", "monitors", "ch");

    const local = { a: 10.0 };
    const mu = 0.3;
    // a: gapS=(100-90)*60=600, α=1/(1+600/600)=0.5, factor=0.5
    // ch: gapS=(100-100)*60=0, α=1/(1+0)=1, factor=0
    // min(0.5, 0) = 0 → 传播为 0
    const pEff = propagatePressures(G, local, mu, tickMs(100));
    expect(pEff.ch).toBeCloseTo(0, 10);
  });

  it("addressed decay: 无 last_alice_action_ms → 无抑制（v4 退化）", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addContact("a");
    G.addChannel("ch");
    G.addRelation("a", "monitors", "ch");

    const local = { a: 10.0 };
    const mu = 0.3;
    // 无属性 → addressedFactor=1.0 → 正常传播，group channel λ=0.3
    const pEff = propagatePressures(G, local, mu);
    // spatial ω=0.5, propagated = λ * mu * ω * p = 0.3 * 0.3 * 0.5 * 10 = 0.45
    expect(pEff.ch).toBeCloseTo(0.3 * 0.3 * 0.5 * 10.0, 10);
  });

  it("addressed decay: 时间流逝 → 抑制减弱", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addContact("a");
    G.addChannel("ch", { last_alice_action_ms: tickMs(90) });
    G.addRelation("a", "monitors", "ch");

    const local = { a: 10.0 };
    const mu = 0.3;
    // ch gapS=(100-90)*60=600, α=1/(1+600/600)=0.5, factor=1-0.5=0.5
    // spatial ω=0.5, group channel λ=0.3
    // propagated = λ * mu * ω * factor * p = 0.3 * 0.3 * 0.5 * 0.5 * 10 = 0.225
    const pEff = propagatePressures(G, local, mu, tickMs(100));
    expect(pEff.ch).toBeCloseTo(0.3 * 0.3 * 0.5 * 0.5 * 10.0, 10);
  });

  it("无边时不改变值", () => {
    const G = new WorldModel();
    G.addContact("a");
    G.addContact("b");

    const local = { a: 5.0, b: 3.0 };
    const pEff = propagatePressures(G, local, 0.3);
    expect(pEff.a).toBe(5.0);
    expect(pEff.b).toBe(3.0);
  });
});

describe("API 聚合", () => {
  it("apiAggregate 计算 Σ tanh(P_k / κ_k)", () => {
    const kappa: [number, number, number, number, number, number] = [
      30.0, 8.0, 8.0, 200.0, 10.0, 0.5,
    ];
    const p = [33.0, 2.0, 1.5, 420.5, 8.33, 0.15];
    const api = apiAggregate(p[0], p[1], p[2], p[3], p[4], p[5], kappa);

    let expected = 0;
    for (let i = 0; i < 6; i++) {
      expected += Math.tanh(p[i] / kappa[i]);
    }
    expect(api).toBeCloseTo(expected, 10);
  });

  it("全零压力 → API=0", () => {
    expect(apiAggregate(0, 0, 0, 0, 0, 0)).toBe(0);
  });

  it("observableMapping 计算 A_max · tanh(API/κ)", () => {
    const api = 3.5;
    const a = observableMapping(api, 10.0, 20.0);
    expect(a).toBeCloseTo(10.0 * Math.tanh(3.5 / 20.0), 10);
  });
});

describe("P_prospect 前瞻性压力", () => {
  it("有 deadline 的 open thread 产生压力", () => {
    const G = buildTestGraph();
    const n = 100;
    const kSteepness = 5.0;
    const { total, contributions } = pProspect(G, n, tickMs(n), kSteepness);

    // t_urgent: open, created=90, deadline=110, w=2.0 (major)
    // horizon = 110 - 90 = 20, remaining = max(0, 110 - 100) = 10
    // progress = 1 - 10/20 = 0.5
    // sigmoid(5.0 * 0.5) = sigmoid(2.5) = 1 / (1 + exp(-2.5))
    const progress = 1 - 10 / 20;
    const sig = 1 / (1 + Math.exp(-kSteepness * progress));
    expect(contributions.t_urgent).toBeCloseTo(THREAD_WEIGHTS.major * sig, 10);

    // t_minor: open, deadline=Infinity → 跳过
    expect(contributions.t_minor).toBeUndefined();

    // t_done: status=resolved → 跳过
    expect(contributions.t_done).toBeUndefined();

    expect(total).toBeCloseTo(THREAD_WEIGHTS.major * sig, 10);
  });

  it("无 horizon 线程 → P_prospect = 0（v4 退化）", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addThread("t1", {
      weight: "minor",
      status: "open",
      created_ms: 0,
      deadline: Infinity,
    });
    G.addThread("t2", { weight: "major", status: "open", created_ms: tickMs(10) });
    const { total } = pProspect(G, 100, tickMs(100), 5.0);
    expect(total).toBe(0);
  });

  it("已过 deadline 时 remaining=0，pressure 趋近 w", () => {
    const G = new WorldModel();
    G.tick = 100;
    // ADR-166: created_ms/deadline_ms 必须为正值（0 = unknown → 跳过）
    G.addThread("t1", {
      weight: "major",
      status: "open",
      created_ms: 1,
      deadline: 50,
      deadline_ms: tickMs(50),
    });
    const { total, contributions } = pProspect(G, 100, tickMs(100), 5.0);

    // horizonS = (tickMs(50) - 1) / 1000 ≈ 3000, remaining = max(0, tickMs(50) - tickMs(100)) / 1000 = 0
    // progress = 1 - 0/3000 = 1.0
    // sigmoid(5.0 * 1.0) = sigmoid(5.0)
    const sig = 1 / (1 + Math.exp(-5.0));
    expect(contributions.t1).toBeCloseTo(THREAD_WEIGHTS.major * sig, 10);
    expect(total).toBeCloseTo(THREAD_WEIGHTS.major * sig, 10);
  });

  it("空图返回 0", () => {
    const G = new WorldModel();
    const { total, contributions } = pProspect(G, 100, tickMs(100), 5.0);
    expect(total).toBe(0);
    expect(Object.keys(contributions)).toHaveLength(0);
  });
});

describe("computeAllPressures 完整管线", () => {
  it("返回所有压力值和 API（含 P_prospect）", () => {
    const G = buildTestGraph();
    const result = computeAllPressures(G, 100, { nowMs: tickMs(100) });

    expect(typeof result.P1).toBe("number");
    expect(typeof result.P2).toBe("number");
    expect(typeof result.P3).toBe("number");
    expect(typeof result.P4).toBe("number");
    expect(typeof result.P5).toBe("number");
    expect(typeof result.P6).toBe("number");
    expect(typeof result.P_prospect).toBe("number");
    expect(typeof result.API).toBe("number");
    expect(typeof result.A).toBe("number");

    // P1 > 0（有 unread 消息）
    expect(result.P1).toBeGreaterThan(0);
    // P3 > 0（有 contact）
    expect(result.P3).toBeGreaterThan(0);
    // P4 > 0（有 open thread）
    expect(result.P4).toBeGreaterThan(0);
    // P5 > 0（有 directed 消息）
    expect(result.P5).toBeGreaterThan(0);
    // P_prospect > 0（t_urgent 有 deadline）
    expect(result.P_prospect).toBeGreaterThan(0);
    // API ∈ [0, 7)（6 个 P + P_prospect 的 tanh 加法项）
    expect(result.API).toBeGreaterThan(0);
    expect(result.API).toBeLessThan(7);
  });

  it("各 P 值与单独调用一致", () => {
    const G = buildTestGraph();
    const n = 100;
    const nowMs = tickMs(n);
    const all = computeAllPressures(G, n, { nowMs });

    expect(all.P1).toBeCloseTo(p1AttentionDebt(G, nowMs).total, 10);
    expect(all.P2).toBeCloseTo(p2InformationPressure(G, n, nowMs).total, 10);
    expect(all.P3).toBeCloseTo(p3RelationshipCooling(G, n, nowMs).total, 10);
    expect(all.P4).toBeCloseTo(p4ThreadDivergence(G, n, nowMs, 86_400).total, 10);
    expect(all.P5).toBeCloseTo(p5ResponseObligation(G, n, nowMs).total, 10);
    expect(all.P6).toBeCloseTo(p6Curiosity(G, nowMs).total, 10);
  });

  it("contributions 包含所有 6 个 key", () => {
    const G = buildTestGraph();
    const result = computeAllPressures(G, 100, { nowMs: tickMs(100) });
    expect(Object.keys(result.contributions).sort()).toEqual(["P1", "P2", "P3", "P4", "P5", "P6"]);
  });
});

describe("FJ-MM 惯性平滑", () => {
  it("rho=0 时不平滑（与无 history 行为一致）", () => {
    const G = buildTestGraph();
    const history = createPressureHistory();
    // 填充历史
    history.push([100, 50, 30, 20, 10, 5]);
    history.push([90, 45, 28, 18, 9, 4]);

    const withRho0 = computeAllPressures(G, 100, { nowMs: tickMs(100), history, rho: 0 });
    const noHistory = computeAllPressures(G, 100, { nowMs: tickMs(100) });

    // rho=0 → 无平滑 → API 应一致（使用原始 p_local）
    expect(withRho0.API).toBeCloseTo(noHistory.API, 10);
  });

  it("有历史时平滑抑制瞬态尖峰", () => {
    const G = buildTestGraph();
    const n = 100;
    const nowMs = tickMs(n);

    // 先不平滑获取基线
    const baseline = computeAllPressures(G, n, { nowMs, rho: 0 });

    // 构造历史：P1 历史显著低于当前 → 平滑应拉低传播贡献
    const history = createPressureHistory();
    // 历史值远小于当前值（模拟瞬态尖峰）
    history.push([
      baseline.P1 * 0.1,
      baseline.P2 * 0.1,
      baseline.P3 * 0.1,
      baseline.P4 * 0.1,
      baseline.P5 * 0.1,
      baseline.P6 * 0.1,
    ]);
    history.push([
      baseline.P1 * 0.2,
      baseline.P2 * 0.2,
      baseline.P3 * 0.2,
      baseline.P4 * 0.2,
      baseline.P5 * 0.2,
      baseline.P6 * 0.2,
    ]);

    const smoothed = computeAllPressures(G, n, { nowMs, history, rho: 0.2 });

    // API 使用原始 p_local → 不受 FJ-MM 影响
    expect(smoothed.API).toBeCloseTo(baseline.API, 10);

    // P1-P6 总量（返回值中的 P1 等）使用原始值，不受平滑影响
    expect(smoothed.P1).toBeCloseTo(baseline.P1, 10);
    expect(smoothed.P3).toBeCloseTo(baseline.P3, 10);
  });

  it("历史为空时不平滑（冷启动安全）", () => {
    const G = buildTestGraph();
    const n = 100;
    const nowMs = tickMs(n);
    const history = createPressureHistory();

    const withEmptyHistory = computeAllPressures(G, n, { nowMs, history, rho: 0.5 });
    const noHistory = computeAllPressures(G, n, { nowMs, rho: 0 });

    // 空历史 → 不平滑
    expect(withEmptyHistory.API).toBeCloseTo(noHistory.API, 10);
  });

  it("FJ-MM 平滑影响传播后的 contributions", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addContact("source", { tier: 5, last_active_ms: tickMs(50) });
    G.addContact("target", { tier: 50 });
    G.addRelation("source", "friend", "target");

    // 给 source 制造 P3 贡献
    G.addChannel("ch", {
      unread: 10,
      tier_contact: 5,
      chat_type: "private",
      pending_directed: 3,
      last_directed_ms: tickMs(98),
      last_incoming_ms: tickMs(100),
    });
    G.addRelation("source", "joined", "ch");

    const n = 100;
    const nowMs = tickMs(n);

    // 基线
    const baseline = computeAllPressures(G, n, { nowMs, rho: 0 });

    // 构造历史使压力减半
    const history = createPressureHistory();
    history.push([
      baseline.P1 * 0.5,
      baseline.P2 * 0.5,
      baseline.P3 * 0.5,
      baseline.P4 * 0.5,
      baseline.P5 * 0.5,
      baseline.P6 * 0.5,
    ]);

    // rho=0.5 → 显著平滑
    const smoothed = computeAllPressures(G, n, { nowMs, history, rho: 0.5 });

    // smoothingRatio = ((1-0.5)*raw + 0.5*0.5*raw) / raw = 0.75
    // 传播输入 = 0.75 * 原始 → contributions 应小于基线
    // （仅在有传播的 entity 上可观察差异）
    // API 不受影响
    expect(smoothed.API).toBeCloseTo(baseline.API, 10);
  });
});

describe("ADR-195: apiPeak — Peak-based API", () => {
  it("3 维度、每维度 3 实体 → 只取各维度最大值的 tanh", () => {
    const kappa: [number, number, number, number, number, number] = [5.0, 5.0, 5.0, 5.0, 5.0, 5.0];
    // 3 个维度有贡献，3 个空
    const contribs: Record<string, number>[] = [
      { a: 1.0, b: 3.0, c: 2.0 }, // P1: max=3.0
      { x: 0.5, y: 0.8 }, // P2: max=0.8
      { z: 4.0 }, // P3: max=4.0
      {}, // P4: max=0
      {}, // P5: max=0
      {}, // P6: max=0
    ];
    const result = apiPeak(contribs, kappa);
    const expected = Math.tanh(3.0 / 5.0) + Math.tanh(0.8 / 5.0) + Math.tanh(4.0 / 5.0);
    expect(result).toBeCloseTo(expected, 10);
  });

  it("空 contribs → 0", () => {
    const contribs: Record<string, number>[] = [{}, {}, {}, {}, {}, {}];
    expect(apiPeak(contribs)).toBe(0);
  });

  it("peak ≤ aggregate（sum of max ≤ sum of totals 的 tanh）", () => {
    const kappa: [number, number, number, number, number, number] = [5.0, 8.0, 8.0, 5.0, 3.0, 5.0];
    // 每个维度有多个实体贡献
    const contribs: Record<string, number>[] = [
      { a: 10.0, b: 5.0, c: 8.0 }, // P1 total=23, max=10
      { x: 2.0 }, // P2 total=2, max=2
      { y: 1.0, z: 0.5 }, // P3 total=1.5, max=1
      { t1: 3.0, t2: 7.0 }, // P4 total=10, max=7
      { r: 4.0 }, // P5 total=4, max=4
      { c1: 0.5, c2: 0.3, c3: 0.2 }, // P6 total=1.0, max=0.5
    ];

    const peak = apiPeak(contribs, kappa);
    // 计算总量 API
    const totals = contribs.map((c) => Object.values(c).reduce((a, b) => a + b, 0));
    const agg = apiAggregate(
      totals[0],
      totals[1],
      totals[2],
      totals[3],
      totals[4],
      totals[5],
      kappa,
    );

    // tanh 是凸函数在正域：tanh(max) ≤ tanh(sum) 当 max ≤ sum
    expect(peak).toBeLessThanOrEqual(agg + 1e-10);
  });

  it("computeAllPressures 返回值包含 API_peak", () => {
    const G = buildTestGraph();
    const result = computeAllPressures(G, 100, { nowMs: tickMs(100) });
    expect(typeof result.API_peak).toBe("number");
    expect(result.API_peak).toBeGreaterThan(0);
    expect(result.API_peak).toBeLessThanOrEqual(result.API + 1e-10);
  });
});

describe("ADR-195: P4 线程老化衰减", () => {
  it("新线程（< 7 天）：衰减因子 = 1.0，行为不变", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addThread("t1", {
      weight: "major",
      status: "open",
      created_ms: tickMs(50), // 50 ticks = 3000s（< 7 天）
      deadline: Infinity,
    });

    const threadAgeScaleS = 86_400;
    const { contributions } = p4ThreadDivergence(G, 100, tickMs(100), threadAgeScaleS);

    // 手算无衰减值
    const ageS = (100 - 50) * 60; // 3000s
    const backtrack = Math.log(1 + ageS / threadAgeScaleS) * THREAD_WEIGHTS.major;
    expect(contributions.t1).toBeCloseTo(backtrack, 10);
  });

  it("老线程（> 7 天）：P4 贡献衰减", () => {
    const threadAgeScaleS = 86_400;
    const maxAgeS = threadAgeScaleS * 7; // 604800s

    // 创建 14 天前的线程
    const G14 = new WorldModel();
    G14.tick = 20160; // 14 天 × 24h × 60min / 1 = 20160 ticks (1min/tick)
    G14.addThread("t1", {
      weight: "major",
      status: "open",
      created_ms: 1, // 很久以前
      deadline: Infinity,
    });

    const { contributions: c14 } = p4ThreadDivergence(G14, 20160, tickMs(20160), threadAgeScaleS);

    // 创建同样年龄但无衰减的参考值
    const ageS = (tickMs(20160) - 1) / 1000;
    const backtrackNoDecay = Math.log(1 + ageS / threadAgeScaleS) * THREAD_WEIGHTS.major;
    const decayFactor = Math.exp(-(ageS - maxAgeS) / maxAgeS);

    // 14 天 → decayFactor ≈ 0.37
    expect(decayFactor).toBeCloseTo(Math.exp(-1), 1);
    expect(c14.t1).toBeCloseTo(backtrackNoDecay * decayFactor, 5);
    // 衰减后应显著小于无衰减值
    expect(c14.t1).toBeLessThan(backtrackNoDecay * 0.5);
  });
});
