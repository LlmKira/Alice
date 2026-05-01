/**
 * D5 Social Cost 单元测试 — 验证 code review 修复点。
 *
 * @see docs/adr/62-d5-social-cost-paper-alignment.md
 */
import { describe, expect, it } from "vitest";
import { WorldModel } from "../src/graph/world-model.js";
import {
  computeSocialCost,
  DEFAULT_SOCIAL_COST_CONFIG,
  getIntrusiveness,
  type SocialCostConfig,
} from "../src/pressure/social-cost.js";
import { estimateDeltaP } from "../src/pressure/social-value.js";
import type { PressureDims } from "../src/utils/math.js";

/** 测试用 tick→ms 转换（约定：1 tick = 60s）。 */
function tickMs(tick: number): number {
  return tick * 60_000;
}

/** 构建最小可用图。 */
function minimalGraph(channelAttrs: Record<string, unknown> = {}): WorldModel {
  const G = new WorldModel();
  G.tick = 100;
  G.addAgent("self");
  G.addChannel("ch1", {
    unread: 0,
    tier_contact: 50,
    chat_type: "private",
    pending_directed: 0,
    last_directed_ms: 0,
    ...channelAttrs,
  });
  G.addRelation("self", "monitors", "ch1");
  return G;
}

const cfg: SocialCostConfig = { ...DEFAULT_SOCIAL_COST_CONFIG };

describe("P1-1: reciprocity clamp", () => {
  it("sent=100, recv=0 → reciprocity ≤ 1（不溢出）", () => {
    const G = minimalGraph({
      alice_sent_window: 100,
      contact_recv_window: 0,
    });

    const cost = computeSocialCost(G, "ch1", "send_message", 100, tickMs(100), [], cfg);
    // C_dist 的 reciprocity 子项 ∈ [0, 1] → 加权后 ≤ alpha1
    // 总成本不应超过各子项的理论上限之和
    expect(cost).toBeLessThanOrEqual(1);
    expect(cost).toBeGreaterThanOrEqual(0);
  });

  it("sent=recv → reciprocity = 0", () => {
    const G = minimalGraph({
      alice_sent_window: 50,
      contact_recv_window: 50,
    });
    const costBalanced = computeSocialCost(G, "ch1", "send_message", 100, tickMs(100), [], cfg);

    const G2 = minimalGraph({
      alice_sent_window: 50,
      contact_recv_window: 0,
    });
    const costUnbalanced = computeSocialCost(G2, "ch1", "send_message", 100, tickMs(100), [], cfg);

    // 不平衡 → 成本更高
    expect(costUnbalanced).toBeGreaterThan(costBalanced);
  });
});

describe("P3-2: sigmoid(tGap=0) 偏置修复", () => {
  it("tGap=0 时 sigmoid 接近 0（而非旧版 0.5）", () => {
    const G = minimalGraph({
      last_alice_action_ms: tickMs(100),
      last_directed_ms: tickMs(100),
    });

    // tGap = 100 - 100 = 0
    const costRecent = computeSocialCost(G, "ch1", "send_message", 100, tickMs(100), [], cfg);

    const G2 = minimalGraph({
      last_alice_action_ms: 0,
      last_directed_ms: 0,
    });
    // tGap = 100 - 0 = 100
    const costOld = computeSocialCost(G2, "ch1", "send_message", 100, tickMs(100), [], cfg);

    // 刚互动过 → 距离小 → 成本更低
    expect(costRecent).toBeLessThan(costOld);
  });

  it("sigmoid 公式验证: tGap=0, tau=60 → ~0.12", () => {
    // σ(0; 60) = 1 / (1 + exp(-(0 - 120) / 60)) = 1 / (1 + exp(2)) ≈ 0.119
    const tau = 60;
    const sig = 1 / (1 + Math.exp(-(0 - 2 * tau) / tau));
    expect(sig).toBeCloseTo(0.119, 2);
  });

  it("sigmoid 公式验证: tGap=2τ → 0.5", () => {
    const tau = 60;
    const sig = 1 / (1 + Math.exp(-(120 - 2 * tau) / tau));
    expect(sig).toBeCloseTo(0.5, 10);
  });
});

describe("P2-2: estimateDeltaP 归一化", () => {
  it("无 kappa → 原始求和（向后兼容）", () => {
    const contributions: Record<string, Record<string, number>> = {
      P1: { ch1: 10 },
      P4: { ch1: 400 },
    };
    const delta = estimateDeltaP(contributions, "ch1");
    expect(delta).toBe(410);
  });

  it("有 kappa → tanh 归一化，P4=400 不独占 ΔP", () => {
    const kappa: PressureDims = [5.0, 8.0, 8.0, 200.0, 3.0, 5.0];
    const contributions: Record<string, Record<string, number>> = {
      P1: { ch1: 10 },
      P4: { ch1: 400 },
      P6: { ch1: 0.1 },
    };
    const delta = estimateDeltaP(contributions, "ch1", kappa);

    // P1: tanh(10/5) = tanh(2) ≈ 0.964
    // P4: tanh(400/200) = tanh(2) ≈ 0.964
    // P6: tanh(0.1/5.0) = tanh(0.02) ≈ 0.020
    const expected = Math.tanh(10 / 5) + Math.tanh(400 / 200) + Math.tanh(0.1 / 5.0);
    expect(delta).toBeCloseTo(expected, 10);

    // 关键断言: P4 归一化后不再是 P1 的 40 倍
    const p1Norm = Math.tanh(10 / 5);
    const p4Norm = Math.tanh(400 / 200);
    expect(p4Norm / p1Norm).toBeLessThan(2); // 归一化后差距缩小
  });

  it("非标准维度（P_prospect）直接累加", () => {
    const kappa: PressureDims = [5.0, 8.0, 8.0, 200.0, 3.0, 5.0];
    const contributions: Record<string, Record<string, number>> = {
      P1: { ch1: 5 },
      P_prospect: { ch1: 0.8 },
    };
    const delta = estimateDeltaP(contributions, "ch1", kappa);
    expect(delta).toBeCloseTo(Math.tanh(5 / 5) + 0.8, 10);
  });

  it("目标不存在 → 返回 0", () => {
    const kappa: PressureDims = [5.0, 8.0, 8.0, 200.0, 3.0, 5.0];
    const contributions: Record<string, Record<string, number>> = {
      P1: { ch1: 10 },
    };
    expect(estimateDeltaP(contributions, "unknown", kappa)).toBe(0);
  });
});

describe("P2-1: aliceRole 从图读取", () => {
  it("alice_role=admin → aliceRank=3, 降低 C_power", () => {
    // Alice 是 admin（rank=3），target 也是 member（rank=2）
    // → rankDiff = max(0, 2-3) / 4 = 0 → C_power 最低
    const G = minimalGraph({
      alice_role: "admin",
      chat_type: "supergroup",
    });

    const costAdmin = computeSocialCost(G, "ch1", "send_message", 100, tickMs(100), [], cfg);

    // 对比: 默认 member
    const G2 = minimalGraph({
      chat_type: "supergroup",
    });
    const costMember = computeSocialCost(G2, "ch1", "send_message", 100, tickMs(100), [], cfg);

    // Admin 的权力差异更小 → 社交成本更低
    expect(costAdmin).toBeLessThanOrEqual(costMember);
  });

  it("alice_role=owner → rank=4", () => {
    const G = minimalGraph({
      alice_role: "owner",
      chat_type: "group",
    });

    // 群组中 targetRank=member=2, aliceRank=owner=4
    // rankDiff = max(0, 2-4) / 4 = 0 → C_power 中 rank 部分为 0
    const cost = computeSocialCost(G, "ch1", "send_message", 100, tickMs(100), [], cfg);
    expect(cost).toBeGreaterThanOrEqual(0);
  });

  it("未知 role 回退到 member", () => {
    const G = minimalGraph({
      alice_role: "unknown_role",
      chat_type: "group",
    });
    const costUnknown = computeSocialCost(G, "ch1", "send_message", 100, tickMs(100), [], cfg);

    const G2 = minimalGraph({
      chat_type: "group",
    });
    const costDefault = computeSocialCost(G2, "ch1", "send_message", 100, tickMs(100), [], cfg);

    // 未知 role → 回退 member → 等价于默认
    expect(costUnknown).toBeCloseTo(costDefault, 10);
  });
});

// -- L3 信号源补全 (ADR-64 Wave 2a) -----------------------------------------

describe("L3-1: 对话结束信号 — 无活跃对话", () => {
  it("无任何对话 → 冷启动，成本更高", () => {
    // 基线: 有活跃对话
    const G1 = minimalGraph();
    G1.addConversation("conversation:ch1_90", {
      channel: "ch1",
      participants: [],
      state: "active",
      start_ms: tickMs(90),
      last_activity_ms: tickMs(98),
      turn_state: "alice_turn",
      pace: 0.5,
      message_count: 5,
      alice_message_count: 2,
    });
    G1.addRelation("conversation:ch1_90", "happens_in", "ch1");
    const costWithConv = computeSocialCost(G1, "ch1", "send_message", 100, tickMs(100), [], cfg);

    // 无对话: 冷启动
    const G2 = minimalGraph();
    const costNoConv = computeSocialCost(G2, "ch1", "send_message", 100, tickMs(100), [], cfg);

    // 无活跃对话 → 信号增加 → 成本更高
    expect(costNoConv).toBeGreaterThan(costWithConv);
  });

  it("对话状态 = closing → 成本高于有活跃对话", () => {
    // 有 active 对话
    const G1 = minimalGraph();
    G1.addConversation("conversation:active", {
      channel: "ch1",
      participants: [],
      state: "active",
      start_ms: tickMs(80),
      last_activity_ms: tickMs(99),
      turn_state: "alice_turn",
      pace: 0.3,
      message_count: 6,
      alice_message_count: 3,
    });
    G1.addRelation("conversation:active", "happens_in", "ch1");
    const costActive = computeSocialCost(G1, "ch1", "send_message", 100, tickMs(100), [], cfg);

    // 对话正在 closing
    const G2 = minimalGraph();
    G2.addConversation("conversation:closing", {
      channel: "ch1",
      participants: [],
      state: "closing",
      start_ms: tickMs(70),
      last_activity_ms: tickMs(85),
      turn_state: "open",
      pace: 0.1,
      message_count: 3,
      alice_message_count: 1,
    });
    G2.addRelation("conversation:closing", "happens_in", "ch1");
    const costClosing = computeSocialCost(G2, "ch1", "send_message", 100, tickMs(100), [], cfg);

    // closing → 信号更高 → 成本更高
    expect(costClosing).toBeGreaterThan(costActive);
  });

  it("对话状态 = cooldown → 等同于无活跃对话（冷启动）", () => {
    // cooldown 不是 active，也不是 closing → findActiveConversation 返回 null
    const G = minimalGraph();
    G.addConversation("conversation:cool", {
      channel: "ch1",
      participants: [],
      state: "cooldown",
      start_ms: tickMs(50),
      last_activity_ms: tickMs(60),
      turn_state: "open",
      pace: 0,
      message_count: 2,
      alice_message_count: 1,
    });
    G.addRelation("conversation:cool", "happens_in", "ch1");
    const costCooldown = computeSocialCost(G, "ch1", "send_message", 100, tickMs(100), [], cfg);

    // 纯空图（无任何对话）
    const G2 = minimalGraph();
    const costEmpty = computeSocialCost(G2, "ch1", "send_message", 100, tickMs(100), [], cfg);

    // cooldown 等价于冷启动（0.6 信号），两者应相同
    expect(costCooldown).toBeCloseTo(costEmpty, 10);
  });
});

describe("L3-2: grief / 敏感状态检测", () => {
  const bobChannel = "channel:telegram:1001";
  const bobContact = "contact:telegram:1001";

  /** 构建使用 channel: 前缀的图，以触发 chatIdToContactId 转换。 */
  function graphWithContact(
    channelAttrs: Record<string, unknown> = {},
    contactAttrs: Record<string, unknown> = {},
  ): WorldModel {
    const G = new WorldModel();
    G.tick = 100;
    G.addAgent("self");
    G.addChannel(bobChannel, {
      unread: 0,
      tier_contact: 50,
      chat_type: "private",
      pending_directed: 0,
      last_directed_ms: 0,
      ...channelAttrs,
    });
    G.addContact(bobContact, { tier: 50, ...contactAttrs });
    G.addRelation("self", "monitors", bobChannel);
    return G;
  }

  it("contact mood_valence 负值 → 成本增加", () => {
    const G1 = graphWithContact();
    const costNormal = computeSocialCost(
      G1,
      bobChannel,
      "send_message",
      100,
      tickMs(100),
      [],
      cfg,
    );

    // mood_valence = -0.8（强烈负面情绪）→ 成本增加
    const G2 = graphWithContact({}, { mood_valence: -0.8 });
    const costGrief = computeSocialCost(
      G2,
      bobChannel,
      "send_message",
      100,
      tickMs(100),
      [],
      cfg,
    );

    expect(costGrief).toBeGreaterThan(costNormal);
  });

  it("contact mood_valence 轻微负值 → 成本增加", () => {
    const G1 = graphWithContact();
    const costNormal = computeSocialCost(
      G1,
      bobChannel,
      "send_message",
      100,
      tickMs(100),
      [],
      cfg,
    );

    // mood_valence = -0.5（中等负面情绪）→ 成本增加
    const G2 = graphWithContact({}, { mood_valence: -0.5 });
    const costUpset = computeSocialCost(
      G2,
      bobChannel,
      "send_message",
      100,
      tickMs(100),
      [],
      cfg,
    );

    expect(costUpset).toBeGreaterThan(costNormal);
  });

  it("contact mood_valence 正值 → 不增加成本", () => {
    const G1 = graphWithContact();
    const costNormal = computeSocialCost(
      G1,
      bobChannel,
      "send_message",
      100,
      tickMs(100),
      [],
      cfg,
    );

    // mood_valence = 0.6（正面情绪）→ 不触发负面信号
    const G2 = graphWithContact({}, { mood_valence: 0.6 });
    const costHappy = computeSocialCost(
      G2,
      bobChannel,
      "send_message",
      100,
      tickMs(100),
      [],
      cfg,
    );

    expect(costHappy).toBeCloseTo(costNormal, 10);
  });

  it("有 risk_reason 且无 risk_level → 成本增加", () => {
    const G1 = minimalGraph();
    const costNormal = computeSocialCost(G1, "ch1", "send_message", 100, tickMs(100), [], cfg);

    // 有 risk_reason 但 risk_level 未设为 high/medium → 额外成本
    const G2 = minimalGraph({ risk_reason: "user experiencing grief and loss" });
    const costGrief = computeSocialCost(G2, "ch1", "send_message", 100, tickMs(100), [], cfg);

    expect(costGrief).toBeGreaterThan(costNormal);
  });

  it("有 risk_reason 且 risk_level=high → 不重复加成本", () => {
    const G1 = minimalGraph({ risk_level: "high" });
    const costHighRisk = computeSocialCost(G1, "ch1", "send_message", 100, tickMs(100), [], cfg);

    // risk_level=high 已在上方 risk 分支处理，risk_reason 不额外增加
    const G2 = minimalGraph({ risk_level: "high", risk_reason: "sensitive topic" });
    const costHighRiskWithReason = computeSocialCost(
      G2,
      "ch1",
      "send_message",
      100,
      tickMs(100),
      [],
      cfg,
    );

    expect(costHighRiskWithReason).toBeCloseTo(costHighRisk, 10);
  });

  it("无 risk_reason → 不触发额外成本", () => {
    const G1 = minimalGraph();
    const costNormal = computeSocialCost(G1, "ch1", "send_message", 100, tickMs(100), [], cfg);

    // 无 risk_reason → 不触发额外成本
    const G2 = minimalGraph({ risk_reason: "" });
    const costNoReason = computeSocialCost(G2, "ch1", "send_message", 100, tickMs(100), [], cfg);

    expect(costNoReason).toBeCloseTo(costNormal, 10);
  });
});

// -- ADR-113: 群组 vs 私聊社交成本差异 ----------------------------------------

describe("ADR-113: getIntrusiveness — 群组侵入性更低", () => {
  it("proactive_message: 群组 < 私聊", () => {
    expect(getIntrusiveness("proactive_message", "group")).toBeLessThan(
      getIntrusiveness("proactive_message", "private"),
    );
  });

  it("send_message: 群组 < 私聊", () => {
    expect(getIntrusiveness("send_message", "supergroup")).toBeLessThan(
      getIntrusiveness("send_message", "private"),
    );
  });

  it("react: 群组 = 私聊（低侵入行动不变）", () => {
    expect(getIntrusiveness("react", "group")).toBeLessThanOrEqual(
      getIntrusiveness("react", "private"),
    );
  });

  it("未知 action → 0.5（两者一致）", () => {
    expect(getIntrusiveness("unknown_action", "group")).toBe(0.5);
    expect(getIntrusiveness("unknown_action", "private")).toBe(0.5);
  });

  it("chatType=undefined → 私聊基准", () => {
    expect(getIntrusiveness("send_message")).toBe(getIntrusiveness("send_message", "private"));
  });
});

describe("ADR-113: computeSocialCost — chatType 参数", () => {
  it("群组中发消息的总成本 < 私聊", () => {
    const G = minimalGraph({ chat_type: "supergroup" });
    const costGroup = computeSocialCost(
      G,
      "ch1",
      "send_message",
      100,
      tickMs(100),
      [],
      cfg,
      "supergroup",
    );

    const G2 = minimalGraph({ chat_type: "private" });
    const costPrivate = computeSocialCost(
      G2,
      "ch1",
      "send_message",
      100,
      tickMs(100),
      [],
      cfg,
      "private",
    );

    expect(costGroup).toBeLessThan(costPrivate);
  });

  it("群组中 proactive_message 成本显著降低", () => {
    const G = minimalGraph({ chat_type: "group" });
    const costGroup = computeSocialCost(
      G,
      "ch1",
      "proactive_message",
      100,
      tickMs(100),
      [],
      cfg,
      "group",
    );

    const G2 = minimalGraph({ chat_type: "private" });
    const costPrivate = computeSocialCost(
      G2,
      "ch1",
      "proactive_message",
      100,
      tickMs(100),
      [],
      cfg,
      "private",
    );

    expect(costGroup).toBeLessThan(costPrivate);
  });

  it("chatType 未传递时默认为私聊（向后兼容）", () => {
    const G = minimalGraph();
    const costDefault = computeSocialCost(G, "ch1", "send_message", 100, tickMs(100), [], cfg);
    const costPrivate = computeSocialCost(
      G,
      "ch1",
      "send_message",
      100,
      tickMs(100),
      [],
      cfg,
      "private",
    );

    expect(costDefault).toBeCloseTo(costPrivate, 10);
  });
});

describe("ADR-113: territory — 群组不再一律视为对方领地", () => {
  it("群组中长期成员: isTargetTerritory = false", () => {
    // join_ms 在 30 天前
    const G1 = minimalGraph({
      chat_type: "group",
      join_ms: tickMs(100) - 30 * 86_400_000,
    });
    const costOldMember = computeSocialCost(
      G1,
      "ch1",
      "send_message",
      100,
      tickMs(100),
      [],
      cfg,
      "group",
    );

    // 对比：私聊（无 territory）
    const G2 = minimalGraph({ chat_type: "private" });
    const costPrivate = computeSocialCost(
      G2,
      "ch1",
      "send_message",
      100,
      tickMs(100),
      [],
      cfg,
      "private",
    );

    // 群组老成员的 power 成本应接近私聊（无 territory 惩罚）
    // 总成本群组更低（因为侵入性和互惠失衡都更低）
    expect(costOldMember).toBeLessThan(costPrivate);
  });

  it("群组中新成员（< 7 天）: isTargetTerritory = true → power 更高", () => {
    // 使用真实时间量级避免 tickMs(100) 太小导致 join_ms 变负
    const nowMs = Date.now();

    // join_ms 在 1 天前（新成员）
    const GNew = minimalGraph({
      chat_type: "group",
      join_ms: nowMs - 1 * 86_400_000,
    });
    const costNewMember = computeSocialCost(
      GNew,
      "ch1",
      "send_message",
      100,
      nowMs,
      [],
      cfg,
      "group",
    );

    // join_ms 在 30 天前（老成员）
    const GOld = minimalGraph({
      chat_type: "group",
      join_ms: nowMs - 30 * 86_400_000,
    });
    const costOldMember = computeSocialCost(
      GOld,
      "ch1",
      "send_message",
      100,
      nowMs,
      [],
      cfg,
      "group",
    );

    // 新成员的 territory penalty → 成本更高
    expect(costNewMember).toBeGreaterThan(costOldMember);
  });
});

// -- ADR-116: 群组沉默陷阱修复 ------------------------------------------------

describe("ADR-116: extractContextSignal — 群组冷启动信号降低", () => {
  it("群组中无活跃对话的 contextSignal 低于私聊", () => {
    // 群组：无活跃对话，信号应为 0.2
    const GGroup = minimalGraph({ chat_type: "group" });
    const costGroup = computeSocialCost(
      GGroup,
      "ch1",
      "send_message",
      100,
      tickMs(100),
      [],
      cfg,
      "group",
    );

    // 私聊：无活跃对话，信号应为 0.6
    const GPrivate = minimalGraph({ chat_type: "private" });
    const costPrivate = computeSocialCost(
      GPrivate,
      "ch1",
      "send_message",
      100,
      tickMs(100),
      [],
      cfg,
      "private",
    );

    // 群组的 C_imp 更低 → 总成本更低
    expect(costGroup).toBeLessThan(costPrivate);
  });

  it("群组冷启动惩罚(0.2)显著低于私聊冷启动(0.6)", () => {
    // 群组无对话：冷启动信号 = 0.2
    const GGroup = minimalGraph({ chat_type: "group" });
    const costGroup = computeSocialCost(
      GGroup,
      "ch1",
      "send_message",
      100,
      tickMs(100),
      [],
      cfg,
      "group",
    );

    // 私聊无对话：冷启动信号 = 0.6
    const GPrivate = minimalGraph({ chat_type: "private" });
    const costPrivate = computeSocialCost(
      GPrivate,
      "ch1",
      "send_message",
      100,
      tickMs(100),
      [],
      cfg,
      "private",
    );

    // 群组冷启动成本应显著低于私聊（C_imp 中 contextSignal 差值 ×0.5 权重）
    expect(costGroup).toBeLessThan(costPrivate);
    // 差距应该超过 0.03（contextSignal 差 0.4 × gamma1=0.5 × wImp=0.3 ≈ 0.06）
    expect(costPrivate - costGroup).toBeGreaterThan(0.03);
  });
});

describe("ADR-116: tierDist — 群组弱化 ×0.4", () => {
  it("群组中 tier-150 的 tierDist 显著低于私聊", () => {
    // 群组 tier-150
    const GGroup = minimalGraph({ chat_type: "group", tier_contact: 150 });
    const costGroup = computeSocialCost(
      GGroup,
      "ch1",
      "send_message",
      100,
      tickMs(100),
      [],
      cfg,
      "group",
    );

    // 私聊 tier-150
    const GPrivate = minimalGraph({ chat_type: "private", tier_contact: 150 });
    const costPrivate = computeSocialCost(
      GPrivate,
      "ch1",
      "send_message",
      100,
      tickMs(100),
      [],
      cfg,
      "private",
    );

    // 群组的 C_dist.tierDist 弱化 → 总成本显著更低
    expect(costGroup).toBeLessThan(costPrivate);
  });

  it("tier-5（亲密好友）群组和私聊差距小（本来 tierDist 就低）", () => {
    const GGroup = minimalGraph({ chat_type: "group", tier_contact: 5 });
    const costGroup = computeSocialCost(
      GGroup,
      "ch1",
      "send_message",
      100,
      tickMs(100),
      [],
      cfg,
      "group",
    );

    const GPrivate = minimalGraph({ chat_type: "private", tier_contact: 5 });
    const costPrivate = computeSocialCost(
      GPrivate,
      "ch1",
      "send_message",
      100,
      tickMs(100),
      [],
      cfg,
      "private",
    );

    // 亲密好友：tierDist ≈ 1 - 5/500 = 0.99，群组弱化后 ≈ 0.396
    // 私聊 ≈ 0.99。差距存在但不如 tier-150 大
    expect(costGroup).toBeLessThan(costPrivate);
  });
});

describe("ADR-113: reciprocity — 群组中互惠失衡弱化", () => {
  it("群组中 sent>>recv 的成本增量 < 私聊", () => {
    // 群组：sent=50, recv=0
    const GGroup = minimalGraph({
      chat_type: "group",
      alice_sent_window: 50,
      contact_recv_window: 0,
    });
    const costGroupUnbalanced = computeSocialCost(
      GGroup,
      "ch1",
      "send_message",
      100,
      tickMs(100),
      [],
      cfg,
      "group",
    );
    const GGroupBalanced = minimalGraph({
      chat_type: "group",
      alice_sent_window: 25,
      contact_recv_window: 25,
    });
    const costGroupBalanced = computeSocialCost(
      GGroupBalanced,
      "ch1",
      "send_message",
      100,
      tickMs(100),
      [],
      cfg,
      "group",
    );
    const groupDelta = costGroupUnbalanced - costGroupBalanced;

    // 私聊：sent=50, recv=0
    const GPrivate = minimalGraph({
      chat_type: "private",
      alice_sent_window: 50,
      contact_recv_window: 0,
    });
    const costPrivateUnbalanced = computeSocialCost(
      GPrivate,
      "ch1",
      "send_message",
      100,
      tickMs(100),
      [],
      cfg,
      "private",
    );
    const GPrivateBalanced = minimalGraph({
      chat_type: "private",
      alice_sent_window: 25,
      contact_recv_window: 25,
    });
    const costPrivateBalanced = computeSocialCost(
      GPrivateBalanced,
      "ch1",
      "send_message",
      100,
      tickMs(100),
      [],
      cfg,
      "private",
    );
    const privateDelta = costPrivateUnbalanced - costPrivateBalanced;

    // 群组中互惠失衡造成的成本增量应更小
    expect(groupDelta).toBeLessThan(privateDelta);
  });
});
