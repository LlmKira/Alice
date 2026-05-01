/**
 * TensionVector + 贡献路由 单元测试 (ADR-26 Phase 1a + ADR-101)。
 *
 * 核心验证:
 * - buildTensionMap ↔ aggregateFromTensionMap round-trip 等价
 * - 逐实体分量与原始 contributions 一致
 * - 空输入边界
 * - routeContributions: contact→channel, thread→channel, fact→channel 路由
 */
import { describe, expect, it } from "vitest";
import {
  aggregateFromTensionMap,
  buildTensionMap,
  routeContributions,
  tensionNorm,
  ZERO_TENSION,
} from "../src/graph/tension.js";
import { WorldModel } from "../src/graph/world-model.js";

// -- 测试数据 ---------------------------------------------------------------

/** 模拟 AllPressures.contributions 格式: pk → eid → value */
const SAMPLE_CONTRIBUTIONS: Record<string, Record<string, number>> = {
  P1: { "channel:alice": 2.5, "channel:group": 0.8 },
  P2: { "channel:alice": 0.3, "channel:group": 1.2 },
  P3: { bob: 0.7, carol: 1.5 },
  P4: { t_urgent: 3.0 },
  P5: { "channel:alice": 1.8 },
  P6: { "channel:group": 0.4 },
};

/** 模拟 pProspect().contributions */
const SAMPLE_PROSPECT: Record<string, number> = {
  t_urgent: 0.9,
  t_minor: 0.2,
};

// -- 测试 -------------------------------------------------------------------

describe("TensionVector", () => {
  describe("buildTensionMap", () => {
    it("将 pk→eid 转置为 eid→TensionVector", () => {
      const map = buildTensionMap(SAMPLE_CONTRIBUTIONS, SAMPLE_PROSPECT);

      // "channel:alice": P1=2.5, P2=0.3, P5=1.8
      const chAlice = map.get("channel:alice");
      expect(chAlice).toBeDefined();
      expect(chAlice?.tau1).toBe(2.5);
      expect(chAlice?.tau2).toBe(0.3);
      expect(chAlice?.tau3).toBe(0);
      expect(chAlice?.tau4).toBe(0);
      expect(chAlice?.tau5).toBe(1.8);
      expect(chAlice?.tau6).toBe(0);
      expect(chAlice?.tauP).toBe(0);

      // t_urgent: P4=3.0, P_prospect=0.9
      const tUrgent = map.get("t_urgent");
      expect(tUrgent).toBeDefined();
      expect(tUrgent?.tau4).toBe(3.0);
      expect(tUrgent?.tauP).toBe(0.9);

      // t_minor: 只有 prospect
      const tMinor = map.get("t_minor");
      expect(tMinor).toBeDefined();
      expect(tMinor?.tau1).toBe(0);
      expect(tMinor?.tauP).toBe(0.2);
    });

    it("不传 prospectContributions 时 tauP 均为 0", () => {
      const map = buildTensionMap(SAMPLE_CONTRIBUTIONS);
      for (const t of map.values()) {
        expect(t.tauP).toBe(0);
      }
    });

    it("空 contributions → 空 Map", () => {
      const map = buildTensionMap({});
      expect(map.size).toBe(0);
    });

    it("空 contributions + 有 prospect → 只含 prospect 实体", () => {
      const map = buildTensionMap({}, { t_urgent: 0.5 });
      expect(map.size).toBe(1);
      expect(map.get("t_urgent")?.tauP).toBe(0.5);
      expect(map.get("t_urgent")?.tau1).toBe(0);
    });
  });

  describe("aggregateFromTensionMap (round-trip)", () => {
    it("反向聚合与原始全局标量一致", () => {
      const map = buildTensionMap(SAMPLE_CONTRIBUTIONS, SAMPLE_PROSPECT);
      const agg = aggregateFromTensionMap(map);

      // 手动求和验证
      const expectedP1 = 2.5 + 0.8; // channel:alice + channel:group
      const expectedP2 = 0.3 + 1.2;
      const expectedP3 = 0.7 + 1.5;
      const expectedP4 = 3.0;
      const expectedP5 = 1.8;
      const expectedP6 = 0.4;
      const expectedProspect = 0.9 + 0.2;

      expect(Math.abs(agg.P1 - expectedP1)).toBeLessThan(1e-10);
      expect(Math.abs(agg.P2 - expectedP2)).toBeLessThan(1e-10);
      expect(Math.abs(agg.P3 - expectedP3)).toBeLessThan(1e-10);
      expect(Math.abs(agg.P4 - expectedP4)).toBeLessThan(1e-10);
      expect(Math.abs(agg.P5 - expectedP5)).toBeLessThan(1e-10);
      expect(Math.abs(agg.P6 - expectedP6)).toBeLessThan(1e-10);
      expect(Math.abs(agg.P_prospect - expectedProspect)).toBeLessThan(1e-10);
    });

    it("空 Map → 全零", () => {
      const agg = aggregateFromTensionMap(new Map());
      expect(agg.P1).toBe(0);
      expect(agg.P6).toBe(0);
      expect(agg.P_prospect).toBe(0);
    });
  });

  describe("tensionNorm", () => {
    it("零向量范数为 0", () => {
      expect(tensionNorm(ZERO_TENSION)).toBe(0);
    });

    it("计算 L2 范数", () => {
      const t = {
        tau1: 3,
        tau2: 4,
        tau3: 0,
        tau4: 0,
        tau5: 0,
        tau6: 0,
        tauP: 0,
        tauRisk: 0,
        tauAttraction: 0,
        tauSpike: 0,
      };
      expect(tensionNorm(t)).toBe(5); // 3-4-5 三角
    });

    it("所有分量参与计算", () => {
      const t = {
        tau1: 1,
        tau2: 1,
        tau3: 1,
        tau4: 1,
        tau5: 1,
        tau6: 1,
        tauP: 1,
        tauRisk: 0,
        tauAttraction: 0,
        tauSpike: 0,
      };
      expect(tensionNorm(t)).toBeCloseTo(Math.sqrt(7), 10);
    });
  });

  describe("ZERO_TENSION", () => {
    it("所有分量为 0", () => {
      expect(ZERO_TENSION.tau1).toBe(0);
      expect(ZERO_TENSION.tau6).toBe(0);
      expect(ZERO_TENSION.tauP).toBe(0);
    });

    it("是 frozen 对象", () => {
      expect(Object.isFrozen(ZERO_TENSION)).toBe(true);
    });
  });

  // -- ADR-101: 贡献路由 -------------------------------------------------------

  describe("routeContributions", () => {
    it("channel 贡献直接通过（不变）", () => {
      const G = new WorldModel();
      G.addChannel("channel:telegram:1", {
        unread: 0,
        tier_contact: 150,
        chat_type: "private",
        pending_directed: 0,
        last_directed_ms: 0,
      });

      const contribs = { P1: { "channel:telegram:1": 5.0 }, P5: { "channel:telegram:1": 2.0 } };
      const routed = routeContributions(contribs, {}, G);

      expect(routed.contributions.P1?.["channel:telegram:1"]).toBe(5.0);
      expect(routed.contributions.P5?.["channel:telegram:1"]).toBe(2.0);
    });

    it("contact 路由到对应私聊频道", () => {
      const G = new WorldModel();
      G.addContact("contact:telegram:42", {
        tier: 50,
        last_active_ms: 0,
        auth_level: 0,
        interaction_count: 0,
      });
      G.addChannel("channel:telegram:42", {
        unread: 0,
        tier_contact: 50,
        chat_type: "private",
        pending_directed: 0,
        last_directed_ms: 0,
      });

      const contribs = { P3: { "contact:telegram:42": 1.5 } };
      const routed = routeContributions(contribs, {}, G);

      // P3 贡献从 contact:telegram:42 路由到 channel:telegram:42
      expect(routed.contributions.P3?.["contact:telegram:42"]).toBeUndefined();
      expect(routed.contributions.P3?.["channel:telegram:42"]).toBe(1.5);
    });

    it("无对应频道的 contact 贡献被丢弃", () => {
      const G = new WorldModel();
      G.addContact("contact:telegram:99", {
        tier: 150,
        last_active_ms: 0,
        auth_level: 0,
        interaction_count: 0,
      });
      // 没有 channel:telegram:99

      const contribs = { P3: { "contact:telegram:99": 1.0 } };
      const routed = routeContributions(contribs, {}, G);

      expect(Object.keys(routed.contributions.P3 ?? {})).toHaveLength(0);
    });

    it("多个 contact 路由到同一频道时累加", () => {
      const G = new WorldModel();
      G.addContact("contact:telegram:10", {
        tier: 50,
        last_active_ms: 0,
        auth_level: 0,
        interaction_count: 0,
      });
      G.addChannel("channel:telegram:10", {
        unread: 0,
        tier_contact: 50,
        chat_type: "private",
        pending_directed: 0,
        last_directed_ms: 0,
      });

      // P3 和 P6 都贡献到同一个 contact → 路由到同一个 channel
      const contribs = { P3: { "contact:telegram:10": 1.0 }, P6: { "contact:telegram:10": 0.5 } };
      const routed = routeContributions(contribs, {}, G);

      expect(routed.contributions.P3?.["channel:telegram:10"]).toBe(1.0);
      expect(routed.contributions.P6?.["channel:telegram:10"]).toBe(0.5);
    });

    it("thread 通过 involves 边路由到频道", () => {
      const G = new WorldModel();
      G.addContact("contact:telegram:7", {
        tier: 50,
        last_active_ms: 0,
        auth_level: 0,
        interaction_count: 0,
      });
      G.addChannel("channel:telegram:7", {
        unread: 0,
        tier_contact: 50,
        chat_type: "private",
        pending_directed: 0,
        last_directed_ms: 0,
      });
      G.addThread("thread_1", {
        status: "open",
        weight: "major",
        w: 1.0,
        created_ms: 0,
        deadline: Infinity,
      });
      G.addRelation("thread_1", "involves", "contact:telegram:7");

      const contribs = { P4: { thread_1: 3.0 } };
      const routed = routeContributions(contribs, {}, G);

      // thread_1 → involves → contact:telegram:7 → channel:telegram:7
      expect(routed.contributions.P4?.thread_1).toBeUndefined();
      expect(routed.contributions.P4?.["channel:telegram:7"]).toBe(3.0);
    });

    it("fact 通过 source_contact 路由到频道", () => {
      const G = new WorldModel();
      G.addContact("contact:telegram:5", {
        tier: 50,
        last_active_ms: 0,
        auth_level: 0,
        interaction_count: 0,
      });
      G.addChannel("channel:telegram:5", {
        unread: 0,
        tier_contact: 50,
        chat_type: "private",
        pending_directed: 0,
        last_directed_ms: 0,
      });
      G.addFact("fact_abc", {
        importance: 0.8,
        stability: 1.0,
        last_access_ms: 0,
        volatility: 0,
        tracked: false,
        created_ms: 0,
        novelty: 1.0,
        source_contact: "contact:telegram:5",
      });

      const contribs = { P2: { fact_abc: 0.5 } };
      const routed = routeContributions(contribs, {}, G);

      expect(routed.contributions.P2?.fact_abc).toBeUndefined();
      expect(routed.contributions.P2?.["channel:telegram:5"]).toBe(0.5);
    });

    it("prospectContributions 也正确路由", () => {
      const G = new WorldModel();
      G.addContact("contact:telegram:3", {
        tier: 50,
        last_active_ms: 0,
        auth_level: 0,
        interaction_count: 0,
      });
      G.addChannel("channel:telegram:3", {
        unread: 0,
        tier_contact: 50,
        chat_type: "private",
        pending_directed: 0,
        last_directed_ms: 0,
      });
      G.addThread("thread_2", {
        status: "open",
        weight: "minor",
        w: 0.5,
        created_ms: 0,
        deadline: 100,
      });
      G.addRelation("thread_2", "involves", "contact:telegram:3");

      const prospect = { thread_2: 0.9 };
      const routed = routeContributions({}, prospect, G);

      expect(routed.prospectContributions.thread_2).toBeUndefined();
      expect(routed.prospectContributions["channel:telegram:3"]).toBe(0.9);
    });

    it("thread 有 source_channel → 路由到 source_channel（ADR-104）", () => {
      const G = new WorldModel();
      G.addContact("contact:telegram:7", {
        tier: 50,
        last_active_ms: 0,
        auth_level: 0,
        interaction_count: 0,
      });
      G.addChannel("channel:telegram:7", {
        unread: 0,
        tier_contact: 50,
        chat_type: "private",
        pending_directed: 0,
        last_directed_ms: 0,
      });
      G.addChannel("channel:group_99", {
        unread: 0,
        tier_contact: 150,
        chat_type: "supergroup",
        pending_directed: 0,
        last_directed_ms: 0,
      });
      G.addThread("thread_sc", {
        status: "open",
        weight: "major",
        w: 1.0,
        created_ms: 0,
        deadline: Infinity,
        source_channel: "channel:group_99",
      });
      G.addRelation("thread_sc", "involves", "contact:telegram:7");

      const contribs = { P4: { thread_sc: 3.0 } };
      const routed = routeContributions(contribs, {}, G);

      // 有 source_channel → 路由到 channel:group_99，不走 involves → channel:telegram:7
      expect(routed.contributions.P4?.["channel:group_99"]).toBe(3.0);
      expect(routed.contributions.P4?.["channel:telegram:7"]).toBeUndefined();
    });

    it("thread 无 source_channel → 回退 involves 边（ADR-104）", () => {
      const G = new WorldModel();
      G.addContact("contact:telegram:8", {
        tier: 50,
        last_active_ms: 0,
        auth_level: 0,
        interaction_count: 0,
      });
      G.addChannel("channel:telegram:8", {
        unread: 0,
        tier_contact: 50,
        chat_type: "private",
        pending_directed: 0,
        last_directed_ms: 0,
      });
      G.addThread("thread_no_sc", {
        status: "open",
        weight: "minor",
        w: 0.5,
        created_ms: 0,
        deadline: Infinity,
        // 无 source_channel
      });
      G.addRelation("thread_no_sc", "involves", "contact:telegram:8");

      const contribs = { P4: { thread_no_sc: 2.0 } };
      const routed = routeContributions(contribs, {}, G);

      // 无 source_channel → 回退 involves → contact:telegram:8 → channel:telegram:8
      expect(routed.contributions.P4?.["channel:telegram:8"]).toBe(2.0);
    });

    it("不在图中的实体贡献被丢弃", () => {
      const G = new WorldModel();
      const contribs = { P1: { ghost_entity: 1.0 } };
      const routed = routeContributions(contribs, {}, G);

      expect(Object.keys(routed.contributions.P1 ?? {})).toHaveLength(0);
    });

    it("agent 节点贡献被丢弃（不可行动）", () => {
      const G = new WorldModel();
      G.addAgent("self");

      const contribs = { P1: { self: 1.0 } };
      const routed = routeContributions(contribs, {}, G);

      expect(Object.keys(routed.contributions.P1 ?? {})).toHaveLength(0);
    });

    it("混合场景：channel + contact + thread 路由到同一 channel 时累加", () => {
      const G = new WorldModel();
      G.addContact("contact:telegram:1", {
        tier: 5,
        last_active_ms: 0,
        auth_level: 0,
        interaction_count: 0,
      });
      G.addChannel("channel:telegram:1", {
        unread: 10,
        tier_contact: 5,
        chat_type: "private",
        pending_directed: 2,
        last_directed_ms: 0,
      });
      G.addThread("thread_1", {
        status: "open",
        weight: "major",
        w: 1.0,
        created_ms: 0,
        deadline: Infinity,
      });
      G.addRelation("thread_1", "involves", "contact:telegram:1");

      // P1→channel:telegram:1(5), P3→contact:telegram:1(1) 路由到 channel:telegram:1, P4→thread_1(3) 路由到 channel:telegram:1
      const contribs = {
        P1: { "channel:telegram:1": 5.0 },
        P3: { "contact:telegram:1": 1.0 },
        P4: { thread_1: 3.0 },
      };
      const routed = routeContributions(contribs, {}, G);

      expect(routed.contributions.P1?.["channel:telegram:1"]).toBe(5.0); // P1 直通
      expect(routed.contributions.P3?.["channel:telegram:1"]).toBe(1.0); // P3 路由
      expect(routed.contributions.P4?.["channel:telegram:1"]).toBe(3.0); // P4 路由
    });
  });
});
