/**
 * Gate 函数边界测试 — 每个 gate 的返回值、边界条件和语义正确性。
 *
 * @see runtime/src/engine/gates.ts
 * @see paper-five-dim §4.2 "Action Gating Pipeline"
 */
import { describe, expect, it } from "vitest";
import {
  classifyChatType,
  countActionsByClass,
  gateActiveCooling,
  gateAPIFloor,
  gateConversationAware,
  gateCrisisMode,
  gateIdleSelfStart,
  gateRateCap,
  resolveIsBot,
} from "../src/engine/gates.js";
import { WorldModel } from "../src/graph/world-model.js";

// -- 辅助：构建带 channel + conversation 的最小图 ----------------------------

/** 构建最小可用图，包含 self + 一个 channel。 */
function minGraph(
  channelId = "channel:telegram:100",
  channelAttrs: Record<string, unknown> = {},
): WorldModel {
  const G = new WorldModel();
  G.tick = 100;
  G.addAgent("self");
  G.addChannel(channelId, {
    unread: 0,
    tier_contact: 50,
    chat_type: "private",
    pending_directed: 0,
    last_directed_ms: 0,
    ...channelAttrs,
  });
  G.addRelation("self", "monitors", channelId);
  return G;
}

/** 向图中添加对话会话节点。 */
function addConversation(
  G: WorldModel,
  convId: string,
  channelId: string,
  overrides: Record<string, unknown> = {},
): void {
  G.addConversation(convId, {
    channel: channelId,
    participants: [],
    state: "active",
    start_ms: 80,
    last_activity_ms: 95,
    turn_state: "open",
    pace: 0.5,
    message_count: 6,
    alice_message_count: 3,
    ...overrides,
  });
  G.addRelation(convId, "happens_in", channelId);
}

// ═══════════════════════════════════════════════════════════════════════════
// gateIdleSelfStart
// ═══════════════════════════════════════════════════════════════════════════

describe("gateIdleSelfStart", () => {
  it("idle 时间达到阈值 → act (使用传入的 selectedAction)", () => {
    const v = gateIdleSelfStart(50, 50, "diligence", "channel:telegram:100", ["channel:telegram:100"]);
    expect(v.type).toBe("act");
    if (v.type === "act") {
      expect(v.candidate.action).toBe("diligence");
      expect(v.candidate.target).toBe("channel:telegram:100");
      expect(v.candidate.focalEntities).toEqual(["channel:telegram:100"]);
    }
  });

  it("idle 时间未达阈值 → pass", () => {
    const v = gateIdleSelfStart(20, 50, "diligence", "channel:telegram:100", ["channel:telegram:100"]);
    expect(v.type).toBe("pass");
  });

  it("刚好等于阈值 → act（>= 语义）", () => {
    // idleSinceActionS = 50，thresholdS = 50
    const v = gateIdleSelfStart(50, 50, "curiosity", "channel:telegram:100", ["channel:telegram:100"]);
    expect(v.type).toBe("act");
  });

  it("target 为 null 时 focalEntities 为空数组", () => {
    const v = gateIdleSelfStart(200, 50, "sociability", null, ["channel:telegram:100", "channel:telegram:200"]);
    expect(v.type).toBe("act");
    if (v.type === "act") {
      expect(v.candidate.target).toBeNull();
      expect(v.candidate.focalEntities).toEqual([]);
    }
  });

  it("netValue、deltaP、socialCost 均为 0（idle 无价值判定）", () => {
    const v = gateIdleSelfStart(200, 50, "caution", "channel:telegram:100", ["channel:telegram:100"]);
    if (v.type === "act") {
      expect(v.candidate.netValue).toBe(0);
      expect(v.candidate.deltaP).toBe(0);
      expect(v.candidate.socialCost).toBe(0);
    }
  });
});

// ADR-81: gateReflectionGuarantee 测试已移除（Reflection 声部已消除）。

// ═══════════════════════════════════════════════════════════════════════════
// gateCrisisMode
// ═══════════════════════════════════════════════════════════════════════════

describe("gateCrisisMode", () => {
  it("无危机（空危机频道列表）→ pass", () => {
    const G = minGraph();
    const v = gateCrisisMode(G, "channel:telegram:100", [], false);
    expect(v.type).toBe("pass");
  });

  it("有危机频道列表但 target 为 null → pass", () => {
    const G = minGraph();
    const v = gateCrisisMode(G, null, ["channel:crisis"], false);
    expect(v.type).toBe("pass");
  });

  it("ADR-84: 目标非危机频道 → pass（不再连坐）", () => {
    const G = minGraph("channel:telegram:100");
    const v = gateCrisisMode(G, "channel:telegram:100", ["channel:crisis"], false);
    expect(v.type).toBe("pass");
  });

  it("危机频道 + 无 bypass → CRISIS_OVERRIDE", () => {
    const G = minGraph("channel:crisis", { pending_directed: 0 });
    const v = gateCrisisMode(G, "channel:crisis", ["channel:crisis"], false);
    expect(v.type).toBe("silent");
    if (v.type === "silent") {
      expect(v.level).toBe("CRISIS_OVERRIDE");
      expect(v.reason).toBe("crisis_mode");
    }
  });

  it("危机频道 + shouldBypassGates → pass（directed/continuation 穿透）", () => {
    const G = minGraph("channel:crisis", { pending_directed: 3 });
    const v = gateCrisisMode(G, "channel:crisis", ["channel:crisis"], true);
    expect(v.type).toBe("pass");
  });

  it("危机频道不在图中 + 无 bypass → CRISIS_OVERRIDE", () => {
    const G = minGraph("channel:telegram:100");
    // channel:crisis 不在图中但在危机列表中
    const v = gateCrisisMode(G, "channel:crisis", ["channel:crisis"], false);
    expect(v.type).toBe("silent");
    if (v.type === "silent") {
      expect(v.level).toBe("CRISIS_OVERRIDE");
    }
  });

  it("危机频道不在图中 + shouldBypassGates → pass", () => {
    const G = minGraph("channel:telegram:100");
    const v = gateCrisisMode(G, "channel:crisis", ["channel:crisis"], true);
    expect(v.type).toBe("pass");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// gateRateCap
// ═══════════════════════════════════════════════════════════════════════════

describe("gateRateCap", () => {
  it("超过 cap → silent L2", () => {
    const v = gateRateCap(10, 5, 0.8, false);
    expect(v.type).toBe("silent");
    if (v.type === "silent") {
      expect(v.level).toBe("L2_ACTIVE_COOLING");
      expect(v.reason).toBe("rate_cap");
      expect(v.values?.apiValue).toBe(0.8);
    }
  });

  it("未超过 cap → pass", () => {
    const v = gateRateCap(3, 10, 0.8, false);
    expect(v.type).toBe("pass");
  });

  it("刚好等于 cap → silent（>= 语义）", () => {
    const v = gateRateCap(5, 5, 0.5, false);
    expect(v.type).toBe("silent");
  });

  it("cap = 0 → 任何行动率都超限", () => {
    const v = gateRateCap(0, 0, 0, false);
    expect(v.type).toBe("silent");
  });

  it("shouldBypassGates=true → 始终 pass（即使超限）", () => {
    const v = gateRateCap(999, 1, 0.8, true);
    expect(v.type).toBe("pass");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// gateActiveCooling
// ═══════════════════════════════════════════════════════════════════════════

describe("gateActiveCooling", () => {
  it("有 directed → 始终 pass", () => {
    // 即使 recentActionsCount 很大，directed 直接通过
    const v = gateActiveCooling(999, 1.0, true, 0.5, () => 0);
    expect(v.type).toBe("pass");
  });

  it("无 directed 且 recentActionsCount = 0 → 必定 pass（exp(0)=1）", () => {
    // actionProb = exp(-0/lambda) = exp(0) = 1 → rng() < 1 → 始终 pass
    const v = gateActiveCooling(0, 3.0, false, 0.5, () => 0.99);
    expect(v.type).toBe("pass");
  });

  it("无 directed 且 rng > actionProb → silent（确定性）", () => {
    // actionProb = exp(-1000/3) ≈ 0，rng=0.01 > 0 → silent
    const v = gateActiveCooling(1000, 3.0, false, 0.5, () => 0.01);
    expect(v.type).toBe("silent");
  });

  it("silent 时返回 L2_ACTIVE_COOLING + apiValue", () => {
    // rng=0.99 远大于 actionProb ≈ 0 → 确定性 silent
    const v = gateActiveCooling(500, 1.0, false, 0.42, () => 0.99);
    expect(v.type).toBe("silent");
    if (v.type === "silent") {
      expect(v.level).toBe("L2_ACTIVE_COOLING");
      expect(v.reason).toBe("active_cooling");
      expect(v.values?.apiValue).toBe(0.42);
    }
  });

  it("rng < actionProb → pass（确定性）", () => {
    // recentActionsCount=1, lambdaC=10 → actionProb = exp(-0.1) ≈ 0.905
    // rng=0.5 < 0.905 → pass
    const v = gateActiveCooling(1, 10.0, false, 0.5, () => 0.5);
    expect(v.type).toBe("pass");
  });

  it("lambdaC 接近 0 时受 max(lambdaC, 0.01) 保护", () => {
    // lambdaC = 0 → 实际使用 0.01，不会除以零
    const v = gateActiveCooling(0, 0, false, 0.5, () => 0.5);
    // recentActionsCount=0 → exp(0)=1 → pass
    expect(v.type).toBe("pass");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// gateAPIFloor
// ═══════════════════════════════════════════════════════════════════════════

describe("gateAPIFloor", () => {
  it("有 directed → 始终 pass（跳过 API 门控）", () => {
    const v = gateAPIFloor(0, 1.0, 1.0, true, 0);
    expect(v.type).toBe("pass");
  });

  it("API 低于 floor → silent L1", () => {
    // effectiveFloor * 6 * circadian = 1.0 * 6 * 1.0 = 6.0
    // apiValue = 3.0 < 6.0 → silent
    const v = gateAPIFloor(3.0, 1.0, 1.0, false, 0);
    expect(v.type).toBe("silent");
    if (v.type === "silent") {
      expect(v.level).toBe("L1_LOW_PRESSURE");
      expect(v.reason).toBe("api_floor");
      expect(v.values?.apiValue).toBe(3.0);
      expect(v.values?.netValue).toBe(0);
    }
  });

  it("API 高于 floor → pass", () => {
    // effectiveFloor * 6 * circadian = 0.1 * 6 * 1.0 = 0.6
    // apiValue = 5.0 > 0.6 → pass
    const v = gateAPIFloor(5.0, 0.1, 1.0, false, 0);
    expect(v.type).toBe("pass");
  });

  it("circadian 调制——夜间 circadian 低使 floor 更容易满足", () => {
    // 白天: effectiveFloor * 6 * 1.5 = 1.0 * 6 * 1.5 = 9.0
    const vDay = gateAPIFloor(5.0, 1.0, 1.5, false, 0);
    expect(vDay.type).toBe("silent");

    // 夜间: effectiveFloor * 6 * 0.3 = 1.0 * 6 * 0.3 = 1.8
    const vNight = gateAPIFloor(5.0, 1.0, 0.3, false, 0);
    expect(vNight.type).toBe("pass");
  });

  it("bestV 值透传到 values.netValue", () => {
    const v = gateAPIFloor(0, 1.0, 1.0, false, 42.5);
    if (v.type === "silent") {
      expect(v.values?.netValue).toBe(42.5);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// classifyChatType
// ═══════════════════════════════════════════════════════════════════════════

describe("classifyChatType", () => {
  it("private → private", () => {
    expect(classifyChatType("private")).toBe("private");
  });

  it("group → group", () => {
    expect(classifyChatType("group")).toBe("group");
  });

  it("supergroup → group", () => {
    expect(classifyChatType("supergroup")).toBe("group");
  });

  // ADR-206: channel 独立分类，不再归入 group
  it("channel → channel", () => {
    expect(classifyChatType("channel")).toBe("channel");
  });

  it("undefined → private（保守回退）", () => {
    expect(classifyChatType(undefined)).toBe("private");
  });

  // ADR-189: 三元 ChannelClass — bot scope
  it("private + isBot=true → bot", () => {
    expect(classifyChatType("private", true)).toBe("bot");
  });

  it("group + isBot=true → group（群聊属性不变）", () => {
    expect(classifyChatType("group", true)).toBe("group");
  });

  it("supergroup + isBot=true → group（群聊属性不变）", () => {
    expect(classifyChatType("supergroup", true)).toBe("group");
  });

  it("undefined + isBot=true → bot", () => {
    expect(classifyChatType(undefined, true)).toBe("bot");
  });

  it("private + isBot=false → private", () => {
    expect(classifyChatType("private", false)).toBe("private");
  });

  it("private + isBot=undefined → private", () => {
    expect(classifyChatType("private", undefined)).toBe("private");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// countActionsByClass
// ═══════════════════════════════════════════════════════════════════════════

describe("countActionsByClass", () => {
  it("正确分类统计 private / group", () => {
    const G = minGraph("channel:pm", { chat_type: "private" });
    G.addChannel("channel:grp", {
      unread: 0,
      tier_contact: 50,
      chat_type: "supergroup",
      pending_directed: 0,
      last_directed_ms: 0,
    });
    G.addRelation("self", "monitors", "channel:grp");

    const actions = [
      { target: "channel:pm" },
      { target: "channel:pm" },
      { target: "channel:grp" },
      { target: null }, // 忽略
    ];
    const counts = countActionsByClass(actions, G);
    expect(counts.private).toBe(2);
    expect(counts.group).toBe(1);
  });

  it("不在图中的 target → 回退 private", () => {
    const G = minGraph();
    const actions = [{ target: "channel:unknown" }, { target: "channel:unknown" }];
    const counts = countActionsByClass(actions, G);
    expect(counts.private).toBe(2);
    expect(counts.group).toBe(0);
  });

  it("空列表 → 全零", () => {
    const G = minGraph();
    const counts = countActionsByClass([], G);
    expect(counts.private).toBe(0);
    expect(counts.group).toBe(0);
  });

  it("chat-type-aware rate cap 核心场景：私聊爆发不消耗群聊配额", () => {
    const G = minGraph("channel:pm", { chat_type: "private" });
    G.addChannel("channel:grp", {
      unread: 0,
      tier_contact: 50,
      chat_type: "group",
      pending_directed: 0,
      last_directed_ms: 0,
    });
    G.addRelation("self", "monitors", "channel:grp");

    // 9 条私聊行动
    const actions = Array.from({ length: 9 }, () => ({ target: "channel:pm" }));
    const counts = countActionsByClass(actions, G);

    // 群聊配额（cap=8）完全未被消耗
    expect(counts.group).toBe(0);
    expect(counts.private).toBe(9);

    // 群聊 rate_cap 应 pass
    const groupVerdict = gateRateCap(counts.group, 8, 0.5, false);
    expect(groupVerdict.type).toBe("pass");

    // 私聊 rate_cap 应 silent（9 >= 8 时）
    const privateVerdict = gateRateCap(counts.private, 8, 0.5, false);
    expect(privateVerdict.type).toBe("silent");
  });

  // ADR-189: bot channel 分类
  it("bot channel 被计入 bot 类别", () => {
    const G = minGraph("channel:telegram:100", { chat_type: "private" });
    // 添加 bot contact
    G.addContact("contact:telegram:100", { is_bot: true, tier: 150 });
    // 添加 bot channel
    G.addChannel("channel:telegram:9001", {
      unread: 0,
      tier_contact: 150,
      chat_type: "private",
      pending_directed: 0,
      last_directed_ms: 0,
    });
    G.addContact("contact:telegram:9001", { is_bot: true, tier: 150 });
    G.addRelation("self", "monitors", "channel:telegram:9001");

    const actions = [
      { target: "channel:telegram:100" }, // is_bot=true → bot
      { target: "channel:telegram:9001" }, // is_bot=true → bot
    ];
    const counts = countActionsByClass(actions, G);
    expect(counts.bot).toBe(2);
    expect(counts.private).toBe(0);
    expect(counts.group).toBe(0);
  });

  it("bot 在群聊中不影响群聊分类", () => {
    const G = minGraph("channel:grp", { chat_type: "group" });
    G.addContact("contact:grp", { is_bot: true, tier: 150 });

    const actions = [{ target: "channel:grp" }];
    const counts = countActionsByClass(actions, G);
    expect(counts.group).toBe(1);
    expect(counts.bot).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// gateConversationAware
// ═══════════════════════════════════════════════════════════════════════════

describe("gateConversationAware", () => {
  it("target 为 null → 默认值", () => {
    const G = minGraph();
    const result = gateConversationAware(G, null);
    expect(result.lambdaMultiplier).toBe(1.0);
    expect(result.silenceBoost).toBe(false);
  });

  it("target 不在图中 → 默认值", () => {
    const G = minGraph();
    const result = gateConversationAware(G, "channel:not_exist");
    expect(result.lambdaMultiplier).toBe(1.0);
    expect(result.silenceBoost).toBe(false);
  });

  it("target 在图中但无活跃对话 → 默认值", () => {
    const G = minGraph();
    const result = gateConversationAware(G, "channel:telegram:100");
    expect(result.lambdaMultiplier).toBe(1.0);
    expect(result.silenceBoost).toBe(false);
  });

  it("active + alice_turn → lambda 降低（更容易通过）", () => {
    const G = minGraph();
    addConversation(G, "conversation:1", "channel:telegram:100", {
      state: "active",
      turn_state: "alice_turn",
    });
    const result = gateConversationAware(G, "channel:telegram:100");
    expect(result.lambdaMultiplier).toBe(0.5);
    expect(result.silenceBoost).toBe(false);
  });

  it("active + other_turn → 默认值（不是 alice_turn）", () => {
    const G = minGraph();
    addConversation(G, "conversation:1", "channel:telegram:100", {
      state: "active",
      turn_state: "other_turn",
    });
    const result = gateConversationAware(G, "channel:telegram:100");
    expect(result.lambdaMultiplier).toBe(1.0);
    expect(result.silenceBoost).toBe(false);
  });

  it("closing → silenceBoost = true", () => {
    const G = minGraph();
    // ADR-135 C2: gateConversationAware 改用 findConversationForChannel，
    // closing 对话现在可被发现 → silenceBoost 分支可达。
    addConversation(G, "conversation:closing", "channel:telegram:100", { state: "closing" });
    const result = gateConversationAware(G, "channel:telegram:100");
    expect(result.lambdaMultiplier).toBe(1.0);
    expect(result.silenceBoost).toBe(true);
  });

  it("cooldown → lambda 升高（阻止主动发起）", () => {
    const G = minGraph();
    // ADR-135 C2: cooldown 对话现在可被发现 → lambdaMultiplier: 2.0 分支可达。
    addConversation(G, "conversation:cool", "channel:telegram:100", { state: "cooldown" });
    const result = gateConversationAware(G, "channel:telegram:100");
    expect(result.lambdaMultiplier).toBe(2.0);
    expect(result.silenceBoost).toBe(false);
  });

  it("pending 对话 → findActiveConversation 找到，进入状态判定", () => {
    const G = minGraph();
    addConversation(G, "conversation:pending", "channel:telegram:100", {
      state: "pending",
      turn_state: "open",
    });
    const result = gateConversationAware(G, "channel:telegram:100");
    // pending + open → 不匹配 active+alice_turn / closing / cooldown → 走 fallback
    expect(result.lambdaMultiplier).toBe(1.0);
    expect(result.silenceBoost).toBe(false);
  });

  it("opening + alice_turn → 不触发 lambda 降低（只有 active 才降低）", () => {
    const G = minGraph();
    addConversation(G, "conversation:opening", "channel:telegram:100", {
      state: "opening",
      turn_state: "alice_turn",
    });
    const result = gateConversationAware(G, "channel:telegram:100");
    // opening ≠ active → 不匹配第一个分支 → 也不匹配 closing/cooldown → fallback
    expect(result.lambdaMultiplier).toBe(1.0);
    expect(result.silenceBoost).toBe(false);
  });

  it("多个对话时只返回第一个活跃对话的状态", () => {
    const G = minGraph();
    // 第一个：active + alice_turn
    addConversation(G, "conversation:1", "channel:telegram:100", {
      state: "active",
      turn_state: "alice_turn",
    });
    // 第二个：也是 active 但 other_turn（不应影响结果）
    addConversation(G, "conversation:2", "channel:telegram:100", {
      state: "active",
      turn_state: "other_turn",
    });
    const result = gateConversationAware(G, "channel:telegram:100");
    // findActiveConversation 返回第一个匹配的
    expect(result.lambdaMultiplier).toBe(0.5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// resolveIsBot — ADR-189
// ═══════════════════════════════════════════════════════════════════════════

describe("resolveIsBot", () => {
  it("channel 对应的 contact 是 bot → true", () => {
    const G = minGraph("channel:telegram:100");
    G.addContact("contact:telegram:100", { is_bot: true, tier: 150 });
    expect(resolveIsBot(G, "channel:telegram:100")).toBe(true);
  });

  it("channel 对应的 contact 不是 bot → false", () => {
    const G = minGraph("channel:telegram:100");
    G.addContact("contact:telegram:100", { is_bot: false, tier: 50 });
    expect(resolveIsBot(G, "channel:telegram:100")).toBe(false);
  });

  it("channel 无对应 contact → undefined", () => {
    const G = minGraph("channel:telegram:100");
    // 不添加 contact:telegram:100
    expect(resolveIsBot(G, "channel:telegram:100")).toBeUndefined();
  });

  it("channel 不在图中 → undefined", () => {
    const G = minGraph("channel:telegram:100");
    expect(resolveIsBot(G, "channel:telegram:999")).toBeUndefined();
  });
});
