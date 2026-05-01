/**
 * System 1 双过程决策单元测试 (ADR-26 §4)。
 *
 * 测试覆盖:
 * - Caution + 低风险 → System 1 skip
 * - Caution + 高风险 → 升级 System 2
 * - Caution + alice_turn 对话 → 升级 System 2
 * - Diligence + 无 directed + 有 unread → digest (ADR-30)
 * - Diligence + 有 directed → 升级 System 2
 * - 其他声部 → 不处理
 */
import { describe, expect, it } from "vitest";
import { trySystem1 } from "../src/engine/system1.js";
import { WorldModel } from "../src/graph/world-model.js";
import type { FocalSet } from "../src/voices/focus.js";
import type { VoiceAction } from "../src/voices/personality.js";

// -- 辅助 -------------------------------------------------------------------

function makeFocalSets(
  overrides: Partial<Record<VoiceAction, Partial<FocalSet>>> = {},
): Record<VoiceAction, FocalSet> {
  const empty: FocalSet = { entities: [], primaryTarget: null, meanRelevance: 0 };
  return {
    diligence: { ...empty, ...overrides.diligence },
    curiosity: { ...empty, ...overrides.curiosity },
    sociability: { ...empty, ...overrides.sociability },
    caution: { ...empty, ...overrides.caution },
  };
}

// -- Caution skip ------------------------------------------------------------

describe("System 1: Caution skip", () => {
  it("空焦点集 → skip", () => {
    const G = new WorldModel();
    const focalSets = makeFocalSets();
    const result = trySystem1("caution", focalSets, G, 100);
    expect(result.handled).toBe(true);
    expect(result.action).toBe("skip");
  });

  it("所有实体 risk=none → skip", () => {
    const G = new WorldModel();
    G.addChannel("ch1", { risk_level: "none" });
    G.addChannel("ch2", { risk_level: "low" });
    const focalSets = makeFocalSets({
      caution: { entities: ["ch1", "ch2"], primaryTarget: "ch1", meanRelevance: 0.1 },
    });
    const result = trySystem1("caution", focalSets, G, 100);
    expect(result.handled).toBe(true);
    expect(result.action).toBe("skip");
  });

  it("有 risk=medium 实体 → 升级 System 2", () => {
    const G = new WorldModel();
    G.addChannel("ch1", { risk_level: "medium" });
    const focalSets = makeFocalSets({
      caution: { entities: ["ch1"], primaryTarget: "ch1", meanRelevance: 0.3 },
    });
    const result = trySystem1("caution", focalSets, G, 100);
    expect(result.handled).toBe(false);
  });

  it("有 risk=high 实体 → 升级 System 2", () => {
    const G = new WorldModel();
    G.addChannel("ch1", { risk_level: "high" });
    const focalSets = makeFocalSets({
      caution: { entities: ["ch1"], primaryTarget: "ch1", meanRelevance: 0.6 },
    });
    const result = trySystem1("caution", focalSets, G, 100);
    expect(result.handled).toBe(false);
  });

  it("低风险但有 alice_turn 对话 → 升级 System 2", () => {
    const G = new WorldModel();
    G.addChannel("ch1", { risk_level: "none" });
    G.addConversation("conversation:1", {
      channel: "ch1",
      state: "active",
      turn_state: "alice_turn",
    });
    const focalSets = makeFocalSets({
      caution: { entities: ["ch1"], primaryTarget: "ch1", meanRelevance: 0.1 },
    });
    const result = trySystem1("caution", focalSets, G, 100);
    expect(result.handled).toBe(false);
  });

  it("低风险 + other_turn 对话 → skip（不需要 Alice 回复）", () => {
    const G = new WorldModel();
    G.addChannel("ch1", { risk_level: "none" });
    G.addConversation("conversation:1", {
      channel: "ch1",
      state: "active",
      turn_state: "other_turn",
    });
    const focalSets = makeFocalSets({
      caution: { entities: ["ch1"], primaryTarget: "ch1", meanRelevance: 0.1 },
    });
    const result = trySystem1("caution", focalSets, G, 100);
    expect(result.handled).toBe(true);
    expect(result.action).toBe("skip");
  });

  it("ADR-268: channel mood_valence no longer upgrades System 1 by itself", () => {
    const G = new WorldModel();
    G.addChannel("ch1", {
      risk_level: "none",
      mood_valence: -0.8,
      mood_shift_ms: Date.now() - 1000,
    });
    const focalSets = makeFocalSets({
      caution: { entities: ["ch1"], primaryTarget: "ch1", meanRelevance: 0.8 },
    });
    const result = trySystem1("caution", focalSets, G, 100);
    expect(result.handled).toBe(true);
    expect(result.action).toBe("skip");
  });

  it("cooldown 对话不阻止 skip", () => {
    const G = new WorldModel();
    G.addChannel("ch1");
    G.addConversation("conversation:1", {
      channel: "ch1",
      state: "cooldown",
      turn_state: "alice_turn",
    });
    const focalSets = makeFocalSets({
      caution: { entities: ["ch1"], primaryTarget: "ch1", meanRelevance: 0.1 },
    });
    const result = trySystem1("caution", focalSets, G, 100);
    expect(result.handled).toBe(true);
    expect(result.action).toBe("skip");
  });
});

// -- Diligence digest (ADR-30: mark_read → digest) ---------------------------

describe("System 1: Diligence digest", () => {
  it("有 unread + 无 directed → digest", () => {
    const G = new WorldModel();
    // participation_ratio > 0: 避免 ADR-116 newcomer floor 干扰（此测试只验证 directed 分支）
    G.addChannel("ch1", { unread: 5, pending_directed: 0, participation_ratio: 0.1 });
    const focalSets = makeFocalSets({
      diligence: { entities: ["ch1"], primaryTarget: "ch1", meanRelevance: 10 },
    });
    const result = trySystem1("diligence", focalSets, G, 100);
    expect(result.handled).toBe(true);
    expect(result.action).toBe("digest");
    expect(result.target).toBe("ch1");
  });

  it("有 directed → 升级 System 2", () => {
    const G = new WorldModel();
    G.addChannel("ch1", { unread: 5, pending_directed: 2 });
    const focalSets = makeFocalSets({
      diligence: { entities: ["ch1"], primaryTarget: "ch1", meanRelevance: 10 },
    });
    const result = trySystem1("diligence", focalSets, G, 100);
    expect(result.handled).toBe(false);
  });

  it("无 unread → 不处理", () => {
    const G = new WorldModel();
    G.addChannel("ch1", { unread: 0, pending_directed: 0 });
    const focalSets = makeFocalSets({
      diligence: { entities: ["ch1"], primaryTarget: "ch1", meanRelevance: 5 },
    });
    const result = trySystem1("diligence", focalSets, G, 100);
    expect(result.handled).toBe(false);
  });

  it("目标不在图中 → 不处理", () => {
    const G = new WorldModel();
    const focalSets = makeFocalSets({
      diligence: { entities: ["ghost"], primaryTarget: "ghost", meanRelevance: 5 },
    });
    const result = trySystem1("diligence", focalSets, G, 100);
    expect(result.handled).toBe(false);
  });
});

// -- ADR-91: Bot 最后发送者 → 直接 digest，不泄漏到 System 2 ---------------------

describe("System 1: ADR-91 bot 消息快速 digest", () => {
  it("bot 消息（非 directed）+ leakProb=1 → 仍然 digest（ADR-91 快速路径）", () => {
    const G = new WorldModel();
    G.addChannel("channel:bot", {
      unread: 5,
      pending_directed: 0,
      last_sender_is_bot: true,
    });
    const focalSets = makeFocalSets({
      diligence: { entities: ["channel:bot"], primaryTarget: "channel:bot", meanRelevance: 10 },
    });
    // ADR-91: Bot 是最后发送者 → 直接 digest，不泄漏到 System 2
    const result = trySystem1("diligence", focalSets, G, 100, { leakProb: 1.0 });
    expect(result.handled).toBe(true);
    expect(result.action).toBe("digest");
  });

  it("人类义务残留 + bot 最后发送 → 仍升级 System 2（人类义务优先于 bot digest）", () => {
    // 场景：人类 @Alice 后 bot 也发了消息。pending_directed 来自人类，
    // last_sender_is_bot 来自 bot。人类义务应被尊重。
    const G = new WorldModel();
    G.addChannel("channel:bot_directed", {
      unread: 3,
      pending_directed: 1,
      last_sender_is_bot: true,
    });
    const focalSets = makeFocalSets({
      diligence: {
        entities: ["channel:bot_directed"],
        primaryTarget: "channel:bot_directed",
        meanRelevance: 10,
      },
    });
    const result = trySystem1("diligence", focalSets, G, 100);
    expect(result.handled).toBe(false);
  });

  it("bot directed 消息不产生义务 → bot-digest 正确兜底", () => {
    // 修复后场景：bot @Alice 时 mapper 不递增 pending_directed，
    // 因此 System 1 的 hasObligation 不触发，控制流到达 bot-digest 分支。
    const G = new WorldModel();
    G.addChannel("channel:bot_only", {
      unread: 1,
      pending_directed: 0, // 修复后：bot directed 不递增
      last_sender_is_bot: true,
    });
    const focalSets = makeFocalSets({
      diligence: {
        entities: ["channel:bot_only"],
        primaryTarget: "channel:bot_only",
        meanRelevance: 10,
      },
    });
    const result = trySystem1("diligence", focalSets, G, 100);
    expect(result.handled).toBe(true);
    expect(result.action).toBe("digest");
  });

  it("bot 消息（非 directed）+ leakProb=0 → digest", () => {
    const G = new WorldModel();
    G.addChannel("channel:bot", {
      unread: 5,
      pending_directed: 0,
      last_sender_is_bot: true,
    });
    const focalSets = makeFocalSets({
      diligence: { entities: ["channel:bot"], primaryTarget: "channel:bot", meanRelevance: 10 },
    });
    const result = trySystem1("diligence", focalSets, G, 100, { leakProb: 0 });
    expect(result.handled).toBe(true);
    expect(result.action).toBe("digest");
  });
});

// -- G7: 动态频率控制 ---------------------------------------------------------

describe("System 1: G7 participation_ratio 动态频率控制", () => {
  it("participation_ratio > 0.25 → leakProb=0 → 永不泄漏", () => {
    const G = new WorldModel();
    G.addChannel("channel:over", {
      unread: 5,
      pending_directed: 0,
      participation_ratio: 0.3,
    });
    const focalSets = makeFocalSets({
      diligence: { entities: ["channel:over"], primaryTarget: "channel:over", meanRelevance: 10 },
    });
    // 即使 leakProb=1.0（必泄漏），ratio > 0.25 仍然阻止泄漏
    const result = trySystem1("diligence", focalSets, G, 100, { leakProb: 1.0 });
    expect(result.handled).toBe(true);
    expect(result.action).toBe("digest");
  });

  it("participation_ratio < 0.05 → leakProb ×2 → 放大泄漏", () => {
    const G = new WorldModel();
    G.addChannel("channel:under", {
      unread: 5,
      pending_directed: 0,
      participation_ratio: 0.02,
    });
    const focalSets = makeFocalSets({
      diligence: { entities: ["channel:under"], primaryTarget: "channel:under", meanRelevance: 10 },
    });
    // leakProb=0.6 → ×2 → 1.2 → MAX_EFFECTIVE_LEAK_PROB 截断 → 0.7
    // Mock Math.random 返回 0.65（大于原始 0.6 但小于截断后 0.7），验证放大生效
    const origRandom = Math.random;
    Math.random = () => 0.65; // 0.65 < min(0.6*2, 0.7)=0.7 → 泄漏到 System 2
    try {
      const result = trySystem1("diligence", focalSets, G, 100, { leakProb: 0.6 });
      expect(result.handled).toBe(false); // 泄漏 → 升级 System 2
    } finally {
      Math.random = origRandom;
    }
  });

  it("正常 ratio (0.05~0.25) → 正常 leakProb", () => {
    const G = new WorldModel();
    G.addChannel("channel:normal", {
      unread: 5,
      pending_directed: 0,
      participation_ratio: 0.15,
    });
    const focalSets = makeFocalSets({
      diligence: {
        entities: ["channel:normal"],
        primaryTarget: "channel:normal",
        meanRelevance: 10,
      },
    });
    // leakProb=0 → digest（无泄漏）
    const result = trySystem1("diligence", focalSets, G, 100, { leakProb: 0 });
    expect(result.handled).toBe(true);
    expect(result.action).toBe("digest");
  });
});

// -- 对话延续信号（隐式回复检测）-----------------------------------------------

describe("System 1: 对话延续信号（隐式回复检测）", () => {
  it("Alice 近期发言（300s 内）→ boost leakProb 捕获隐式回复", () => {
    const G = new WorldModel();
    const tick = 100;
    // ADR-110: CONTINUATION_WINDOW_S = 300 秒
    G.addChannel("channel:cont", {
      unread: 5,
      pending_directed: 0,
      last_alice_action_ms: Date.now() - 60_000, // 60 秒前发过言，在 300 秒窗口内
    });
    const focalSets = makeFocalSets({
      diligence: { entities: ["channel:cont"], primaryTarget: "channel:cont", meanRelevance: 10 },
    });
    // leakProb=0.1（低），但对话延续信号 boost 到 0.7
    // Mock Math.random 返回 0.5（< 0.7 → 泄漏到 System 2）
    const origRandom = Math.random;
    Math.random = () => 0.5;
    try {
      const result = trySystem1("diligence", focalSets, G, tick, { leakProb: 0.1 });
      expect(result.handled).toBe(false); // 泄漏到 System 2
    } finally {
      Math.random = origRandom;
    }
  });

  it("Alice 长期未发言（>300s）→ 正常 digest", () => {
    const G = new WorldModel();
    const tick = 100;
    // ADR-110: CONTINUATION_WINDOW_S = 300 秒，设置为 600 秒前 → 超出窗口
    // participation_ratio > 0: 已有参与历史，避免 ADR-116 newcomer floor 干扰
    G.addChannel("channel:old", {
      unread: 5,
      pending_directed: 0,
      participation_ratio: 0.1,
      last_alice_action_ms: Date.now() - 600_000, // 600 秒前，超出 300 秒窗口
    });
    const focalSets = makeFocalSets({
      diligence: { entities: ["channel:old"], primaryTarget: "channel:old", meanRelevance: 10 },
    });
    // leakProb=0 → 无泄漏，且超出延续窗口不会 boost
    const result = trySystem1("diligence", focalSets, G, tick, { leakProb: 0 });
    expect(result.handled).toBe(true);
    expect(result.action).toBe("digest");
  });

  it("对话延续 + participation_ratio > 0.25 → continuation 以动态衰减概率泄漏（ADR-78 F4）", () => {
    const G = new WorldModel();
    const tick = 100;
    // ADR-110: last_alice_action_ms 在 300 秒窗口内
    G.addChannel("channel:over_cont", {
      unread: 5,
      pending_directed: 0,
      participation_ratio: 0.3, // 过度参与
      last_alice_action_ms: Date.now() - 30_000, // 30 秒前，在窗口内
    });
    const focalSets = makeFocalSets({
      diligence: {
        entities: ["channel:over_cont"],
        primaryTarget: "channel:over_cont",
        meanRelevance: 10,
      },
    });
    // ADR-78 F4: continuation 独立于 ratio 截断，但动态衰减。
    // ratio=0.3 → continuationProb = 0.7 * max(0, 1 - 0.3*2) = 0.7 * 0.4 = 0.28
    // 使 random 返回 0.27（<0.28）→ 应泄漏
    const origRandom = Math.random;
    Math.random = () => 0.27;
    try {
      const result = trySystem1("diligence", focalSets, G, tick, { leakProb: 0 });
      expect(result.handled).toBe(false); // continuation 触发泄漏
    } finally {
      Math.random = origRandom;
    }
  });

  it("对话延续 + participation_ratio >= 0.5 → continuation 概率归零（不泄漏）", () => {
    const G = new WorldModel();
    const tick = 100;
    // ADR-110: last_alice_action_ms 在 300 秒窗口内
    G.addChannel("channel:very_over", {
      unread: 5,
      pending_directed: 0,
      participation_ratio: 0.5, // 极度过度参与
      last_alice_action_ms: Date.now() - 30_000, // 30 秒前，在窗口内
    });
    const focalSets = makeFocalSets({
      diligence: {
        entities: ["channel:very_over"],
        primaryTarget: "channel:very_over",
        meanRelevance: 10,
      },
    });
    // ratio=0.5 → continuationProb = 0.7 * max(0, 1 - 0.5*2) = 0.7 * 0 = 0
    const result = trySystem1("diligence", focalSets, G, tick, { leakProb: 0 });
    expect(result.handled).toBe(true); // ratio 极高 → 即使 continuation 也归零
    expect(result.action).toBe("digest");
  });
});

// -- ADR-116: 新群观察期泄漏下限 -----------------------------------------------

describe("System 1: ADR-116 newcomer leak floor", () => {
  it("participation_ratio=0 → effectiveLeakProb ≥ NEWCOMER_LEAK_FLOOR(0.5)", () => {
    const G = new WorldModel();
    G.addChannel("channel:newcomer", {
      unread: 5,
      pending_directed: 0,
      participation_ratio: 0, // 从未发言
    });
    const focalSets = makeFocalSets({
      diligence: {
        entities: ["channel:newcomer"],
        primaryTarget: "channel:newcomer",
        meanRelevance: 10,
      },
    });
    // leakProb=0.15（基础），但 newcomer floor 拉到 0.50
    // Mock Math.random 返回 0.45（< 0.50 → 应泄漏到 System 2）
    const origRandom = Math.random;
    Math.random = () => 0.45;
    try {
      const result = trySystem1("diligence", focalSets, G, 100, { leakProb: 0.15 });
      expect(result.handled).toBe(false); // 泄漏到 System 2
    } finally {
      Math.random = origRandom;
    }
  });

  it("participation_ratio=0 + random > 0.5 → digest（floor 之上仍有拦截）", () => {
    const G = new WorldModel();
    G.addChannel("channel:newcomer2", {
      unread: 5,
      pending_directed: 0,
      participation_ratio: 0,
    });
    const focalSets = makeFocalSets({
      diligence: {
        entities: ["channel:newcomer2"],
        primaryTarget: "channel:newcomer2",
        meanRelevance: 10,
      },
    });
    // random=0.6 > 0.5 → 不泄漏，digest
    const origRandom = Math.random;
    Math.random = () => 0.6;
    try {
      const result = trySystem1("diligence", focalSets, G, 100, { leakProb: 0.15 });
      expect(result.handled).toBe(true);
      expect(result.action).toBe("digest");
    } finally {
      Math.random = origRandom;
    }
  });

  it("participation_ratio > 0（已参与过）→ newcomer floor 不生效", () => {
    const G = new WorldModel();
    G.addChannel("channel:active", {
      unread: 5,
      pending_directed: 0,
      participation_ratio: 0.1, // 已有参与
    });
    const focalSets = makeFocalSets({
      diligence: {
        entities: ["channel:active"],
        primaryTarget: "channel:active",
        meanRelevance: 10,
      },
    });
    // leakProb=0.15, ratio 在 0.05~0.25 范围 → 保持 0.15（不 ×2，不用 floor）
    // random=0.45 > 0.15 → digest
    const origRandom = Math.random;
    Math.random = () => 0.45;
    try {
      const result = trySystem1("diligence", focalSets, G, 100, { leakProb: 0.15 });
      expect(result.handled).toBe(true); // 不泄漏
      expect(result.action).toBe("digest");
    } finally {
      Math.random = origRandom;
    }
  });
});

// -- 其他声部 ----------------------------------------------------------------

describe("System 1: 其他声部", () => {
  it("Curiosity → 不处理", () => {
    const G = new WorldModel();
    const focalSets = makeFocalSets();
    expect(trySystem1("curiosity", focalSets, G, 100).handled).toBe(false);
  });

  it("Sociability → 不处理", () => {
    const G = new WorldModel();
    const focalSets = makeFocalSets();
    expect(trySystem1("sociability", focalSets, G, 100).handled).toBe(false);
  });

  // ADR-81: Reflection 声部已移除，不再测试。
});
