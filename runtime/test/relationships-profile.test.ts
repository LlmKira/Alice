/**
 * M2 Wave 1 测试 — relationships.mod 结构化画像（ContactProfile）。
 */
import { describe, expect, it } from "vitest";
import type { ModContext } from "../src/core/types.js";
import { WorldModel } from "../src/graph/world-model.js";
import {
  type ContactProfile,
  relationshipsMod,
  TIER_EVAL_INTERVAL,
} from "../src/mods/relationships.mod.js";

// -- 测试辅助 -----------------------------------------------------------------

interface TestState {
  targetNodeId: string | null;
  contactProfiles: Record<string, ContactProfile>;
  groupProfiles: Record<string, unknown>;
  interestObsCounts: Record<string, number>;
}

function makeCtx(stateOverride: Partial<TestState> = {}, tick = 100, nowMs?: number) {
  const graph = new WorldModel();
  graph.tick = tick;
  const state: TestState = {
    targetNodeId: stateOverride.targetNodeId ?? null,
    contactProfiles: stateOverride.contactProfiles ?? {},
    groupProfiles: stateOverride.groupProfiles ?? {},
    interestObsCounts: stateOverride.interestObsCounts ?? {},
  };
  return {
    graph,
    state,
    tick,
    nowMs: nowMs ?? tick * 60_000,
    getModState: () => undefined,
    dispatch: () => undefined,
  };
}

// biome-ignore lint/style/noNonNullAssertion: test — instructions 已知存在
const instructions = relationshipsMod.instructions!;

// -- note_active_hour (ADR-198: 替代 update_contact_profile) -------------------

describe("relationships.mod — note_active_hour", () => {
  it("EMA 更新活跃时段", () => {
    const ctx = makeCtx();
    ctx.graph.addContact("contact:telegram:1");

    instructions.note_active_hour.impl(ctx as unknown as ModContext, {
      contactId: "contact:telegram:1",
      hour: 14,
    });

    const profile = ctx.state.contactProfiles["contact:telegram:1"];
    expect(profile.activeHours[14]).toBeCloseTo(0.1, 4);
    // 其他小时应接近 0
    expect(profile.activeHours[0]).toBeCloseTo(0, 4);
  });

  it("自动创建空白画像", () => {
    const ctx = makeCtx();
    ctx.graph.addContact("contact:telegram:1");
    expect(ctx.state.contactProfiles["contact:telegram:1"]).toBeUndefined();

    instructions.note_active_hour.impl(ctx as unknown as ModContext, {
      contactId: "contact:telegram:1",
      hour: 10,
    });

    expect(ctx.state.contactProfiles["contact:telegram:1"]).toBeDefined();
    expect(ctx.state.contactProfiles["contact:telegram:1"].interests).toEqual([]);
    expect(ctx.state.contactProfiles["contact:telegram:1"].activeHours).toHaveLength(24);
  });

  it("把 @id 归一化到 contact:id，避免写入不可读 profile key", () => {
    const ctx = makeCtx();
    ctx.graph.addContact("contact:telegram:7691227179");

    const result = instructions.note_active_hour.impl(ctx as unknown as ModContext, {
      contactId: "@7691227179",
      hour: 18,
    }) as { success: boolean; contactId: string };

    expect(result.success).toBe(true);
    expect(result.contactId).toBe("contact:telegram:7691227179");
    expect(ctx.state.contactProfiles["contact:telegram:7691227179"]).toBeDefined();
    expect(ctx.state.contactProfiles["@7691227179"]).toBeUndefined();
  });

  it("接受 display_name 并写入规范 contact key", () => {
    const ctx = makeCtx();
    ctx.graph.addContact("contact:telegram:42", { display_name: "Rin" });

    const result = instructions.note_active_hour.impl(ctx as unknown as ModContext, {
      contactId: "Rin",
      hour: 22,
    }) as { success: boolean; contactId: string };

    expect(result.success).toBe(true);
    expect(result.contactId).toBe("contact:telegram:42");
    expect(ctx.state.contactProfiles["contact:telegram:42"].activeHours[22]).toBeCloseTo(0.1, 4);
    expect(ctx.state.contactProfiles.Rin).toBeUndefined();
  });
});

// -- tag_interest (ADR-208: BeliefStore + 结晶管线) -------------------------

describe("relationships.mod — tag_interest (ADR-208)", () => {
  it("单次观察写入 BeliefStore（未结晶）", () => {
    const ctx = makeCtx();
    ctx.graph.addContact("contact:telegram:1");

    const result = instructions.tag_interest.impl(ctx as unknown as ModContext, {
      who: "contact:telegram:1",
      interest: "Programming",
    }) as { success: boolean; crystallized: boolean; label: string };

    expect(result.success).toBe(true);
    expect(result.label).toBe("programming"); // 归一化 lowercase
    // 单次观察不够结晶（需要 ≥ 2 次）
    expect(result.crystallized).toBe(false);
    expect(ctx.state.interestObsCounts["contact:telegram:1::interest:programming"]).toBe(1);
  });

  it("多次观察后结晶（contact）", () => {
    const ctx = makeCtx();
    ctx.graph.addContact("contact:telegram:1");

    // EMA σ² 从 1.0 开始，每次 update: σ²' = 0.49·σ² + 0.009
    // 需要 ~5 次观察才能收敛到 < 0.06（结晶阈值）
    for (let i = 0; i < 4; i++) {
      const r = instructions.tag_interest.impl(ctx as unknown as ModContext, {
        who: "contact:telegram:1",
        interest: "ai",
      }) as { crystallized: boolean };
      expect(r.crystallized).toBe(false);
    }
    // 第 5 次 → σ² ≈ 0.045 < 0.06，结晶
    const result = instructions.tag_interest.impl(ctx as unknown as ModContext, {
      who: "contact:telegram:1",
      interest: "ai",
    }) as { crystallized: boolean; observations: number };

    expect(result.crystallized).toBe(true);
    expect(result.observations).toBe(5);
    const ci = ctx.state.contactProfiles["contact:telegram:1"]?.crystallizedInterests;
    expect(ci).toBeDefined();
    expect(ci!.ai).toBeDefined();
    expect(ci!.ai.confidence).toBeGreaterThan(0);
  });

  it("接受群组 channel entityId", () => {
    const ctx = makeCtx();
    ctx.graph.addChannel("channel:telegram:100", { chat_type: "supergroup" });

    // 需要 5 次观察才能结晶（EMA σ² 收敛）
    for (let i = 0; i < 5; i++) {
      instructions.tag_interest.impl(ctx as unknown as ModContext, {
        who: "channel:telegram:100",
        interest: "编程",
      });
    }

    const gp = ctx.state.groupProfiles["channel:telegram:100"] as {
      crystallizedInterests?: Record<string, unknown>;
    };
    expect(gp?.crystallizedInterests?.["编程"]).toBeDefined();
  });

  it("标签归一化（空格 → 下划线）", () => {
    const ctx = makeCtx();
    ctx.graph.addContact("contact:telegram:1");

    const result = instructions.tag_interest.impl(ctx as unknown as ModContext, {
      who: "contact:telegram:1",
      interest: "Machine Learning",
    }) as { label: string };

    expect(result.label).toBe("machine_learning");
  });

  it("display_name 被解析为 nodeId", () => {
    const ctx = makeCtx();
    ctx.graph.addContact("contact:telegram:1", { display_name: "Rin" });

    const result = instructions.tag_interest.impl(ctx as unknown as ModContext, {
      who: "Rin",
      interest: "reading",
    }) as { success: boolean; entityId: string };

    expect(result.success).toBe(true);
    expect(result.entityId).toBe("contact:telegram:1");
  });

  it("强化已结晶兴趣刷新 lastReinforcedMs", () => {
    const ctx = makeCtx({}, 100, 1000000);
    ctx.graph.addContact("contact:telegram:1");

    // 先结晶（需要 5 次观察）
    for (let i = 0; i < 5; i++) {
      instructions.tag_interest.impl(ctx as unknown as ModContext, {
        who: "contact:telegram:1",
        interest: "ai",
      });
    }
    expect(ctx.state.contactProfiles["contact:telegram:1"]?.crystallizedInterests?.ai).toBeDefined();

    // 推进时间后强化
    const ctx2 = { ...ctx, nowMs: 2000000, tick: 200 };
    const result = instructions.tag_interest.impl(ctx2 as unknown as ModContext, {
      who: "contact:telegram:1",
      interest: "ai",
    }) as { reinforced: boolean };

    expect(result.reinforced).toBe(true);
    expect(
      ctx.state.contactProfiles["contact:telegram:1"]?.crystallizedInterests?.ai?.lastReinforcedMs,
    ).toBe(2000000);
  });

  it("实体不存在 → 返回 error", () => {
    const ctx = makeCtx();

    const result = instructions.tag_interest.impl(ctx as unknown as ModContext, {
      who: "contact:999",
      interest: "music",
    }) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("空字符串由 Zod schema 拒绝", () => {
    const schema = instructions.tag_interest.params.interest.schema;
    expect(schema).toBeDefined();
    const parsed = schema?.safeParse("  ");
    expect(parsed.success).toBe(false);
  });
});

// -- contactProfile 返回画像 -----------------------------------------------

describe("relationships.mod — contactProfile with profile", () => {
  it("返回结构化画像", () => {
    const ctx = makeCtx({
      contactProfiles: {
        "contact:telegram:1": {
          activeHours: new Array(24).fill(0),
          interests: ["cooking", "travel"],
          lastUpdatedTick: 50,
          previousPeakHour: null,
          scheduleShift: null,
          portrait: null,
          portraitTick: null,
          traits: {},
        },
      },
    });
    ctx.graph.addContact("contact:telegram:1", { tier: 50, display_name: "Bob" });

    // biome-ignore lint/style/noNonNullAssertion: test
    const query = relationshipsMod.queries!.contact_profile;
    const result = query.impl(ctx as unknown as ModContext, { contactId: "contact:telegram:1" }) as {
      profile: ContactProfile;
      tier: number;
      trustLabel: string;
    };

    expect(result.profile).toBeDefined();
    expect(result.profile.interests).toEqual(["cooking", "travel"]);
    expect(result.tier).toBe(50);
    // ADR-198: trustLabel 从 rv_trust 预计算
    expect(result.trustLabel).toBe("cautious"); // INITIAL_RV.trust = 0.3 → cautious
  });

  it("无画像时 profile = null", () => {
    const ctx = makeCtx();
    ctx.graph.addContact("contact:telegram:1");

    // biome-ignore lint/style/noNonNullAssertion: test
    const query = relationshipsMod.queries!.contact_profile;
    const result = query.impl(ctx as unknown as ModContext, { contactId: "contact:telegram:1" }) as {
      profile: ContactProfile | null;
    };

    expect(result.profile).toBeNull();
  });

  it("读取画像时迁移旧 @id key 到 contact:id", () => {
    const ctx = makeCtx({
      contactProfiles: {
        "@7691227179": {
          activeHours: (() => {
            const h = new Array(24).fill(0);
            h[18] = 0.1;
            return h;
          })(),
          interests: [],
          lastUpdatedTick: 50,
          previousPeakHour: null,
          scheduleShift: null,
          portrait: null,
          portraitTick: null,
          traits: {},
        },
      },
    });
    ctx.graph.addContact("contact:telegram:7691227179");

    // biome-ignore lint/style/noNonNullAssertion: test
    const query = relationshipsMod.queries!.contact_profile;
    const result = query.impl(ctx as unknown as ModContext, {
      contactId: "contact:telegram:7691227179",
    }) as { profile: ContactProfile | null };

    expect(result.profile?.activeHours[18]).toBeCloseTo(0.1, 4);
    expect(ctx.state.contactProfiles["contact:telegram:7691227179"]).toBeDefined();
    expect(ctx.state.contactProfiles["@7691227179"]).toBeUndefined();
  });
});

// -- contribute 叙事画像 (ADR-55 P1-A/B) --------------------------------------

describe("relationships.mod — contribute narrative profile", () => {
  it("P1-A: 叙事散文格式 — 包含 You're talking to", () => {
    const ctx = makeCtx({
      targetNodeId: "contact:telegram:1",
      contactProfiles: {
        "contact:telegram:1": {
          activeHours: (() => {
            const h = new Array(24).fill(0);
            h[22] = 0.5;
            return h;
          })(),
          interests: ["ai", "music"],
          lastUpdatedTick: 50,
          previousPeakHour: null,
          scheduleShift: null,
          portrait: null,
          portraitTick: null,
          traits: {},
        },
      },
    });
    ctx.graph.addContact("contact:telegram:1", {
      tier: 50,
      display_name: "Charlie",
      interaction_count: 42,
    });

    // biome-ignore lint/style/noNonNullAssertion: test — contribute 已知存在
    const items = relationshipsMod.contribute!(ctx as unknown as ModContext);
    const profileItem = items.find(
      (i) => "key" in i && (i as { key: string }).key === "contact-profile",
    );
    expect(profileItem).toBeDefined();

    const content = JSON.stringify(profileItem);
    // 叙事开头
    expect(content).toContain("Talking to Charlie");
    // ADR-66 F14: 交互次数改为自然语言
    expect(content).toContain("Plenty of conversation history");
    // 兴趣
    expect(content).toContain("Into ai, music");
    // 活跃时段
    expect(content).toContain("22:00");
  });

  it("P1-B: 记忆引用 — 不包含 R= 数值", () => {
    const ctx = makeCtx({
      targetNodeId: "contact:telegram:1",
    });
    ctx.graph.addContact("contact:telegram:1", {
      tier: 50,
      display_name: "Dave",
    });
    // 添加 fact 图节点作为 facts
    ctx.graph.addFact("info_ts", {
      content: "likes TypeScript",
      fact_type: "interest",
      importance: 0.5,
      stability: 5,
      last_access_ms: 90,
      volatility: 0,
      tracked: false,
      created_ms: 10,
      novelty: 1.0,
      reinforcement_count: 1,
      source_contact: "contact:telegram:1",
    });
    ctx.graph.addRelation("contact:telegram:1", "knows", "info_ts");
    ctx.graph.addFact("info_dm", {
      content: "prefers dark mode",
      fact_type: "preference",
      importance: 0.5,
      stability: 4,
      last_access_ms: 85,
      volatility: 0,
      tracked: false,
      created_ms: 20,
      novelty: 1.0,
      reinforcement_count: 1,
      source_contact: "contact:telegram:1",
    });
    ctx.graph.addRelation("contact:telegram:1", "knows", "info_dm");

    // biome-ignore lint/style/noNonNullAssertion: test — contribute 已知存在
    const items = relationshipsMod.contribute!(ctx as unknown as ModContext);
    const profileItem = items.find(
      (i) => "key" in i && (i as { key: string }).key === "contact-profile",
    );
    expect(profileItem).toBeDefined();

    const content = JSON.stringify(profileItem);
    // 自然句子格式
    // ADR-69: 归因渲染
    expect(content).toContain("notes:");
    expect(content).toContain("likes TypeScript");
    expect(content).toContain("prefers dark mode");
    // 不包含机器语言
    expect(content).not.toContain("R=");
    expect(content).not.toContain("reinforced");
    expect(content).not.toContain("[interest]");
    expect(content).not.toContain("[preference]");
  });

  it("P1-B: 无 facts 时的自然提示", () => {
    const ctx = makeCtx({
      targetNodeId: "contact:telegram:1",
    });
    ctx.graph.addContact("contact:telegram:1", {
      tier: 150,
      display_name: "Eve",
    });

    // biome-ignore lint/style/noNonNullAssertion: test — contribute 已知存在
    const items = relationshipsMod.contribute!(ctx as unknown as ModContext);
    const profileItem = items.find(
      (i) => "key" in i && (i as { key: string }).key === "contact-profile",
    );
    const content = JSON.stringify(profileItem);
    expect(content).toContain("Not much known about them yet");
  });

  it("P1-B: fading facts 提示措辞", () => {
    // 所有 facts 的 R 值低于阈值 → 全部 fading
    // ADR-110: nowMs=2_000_000_000（~23 天 ms），stability=0.1, last_access_ms=0
    // gapS=2000000, scaledGap≈23.1, R=(1+23.1/0.9)^(-0.5)≈0.19 < 0.2
    const nowMs = 2_000_000_000;
    const ctx = makeCtx(
      {
        targetNodeId: "contact:telegram:1",
      },
      100,
      nowMs,
    );
    ctx.graph.addContact("contact:telegram:1", {
      tier: 50,
      display_name: "Frank",
    });
    // 添加低 stability 的 fact 图节点
    ctx.graph.addFact("info_cook", {
      content: "used to like cooking",
      fact_type: "observation", // episodic — 测试 fading 提示（semantic facts 永不 fade）
      importance: 0.5,
      stability: 0.1,
      last_access_ms: 0,
      volatility: 0,
      tracked: false,
      created_ms: 0,
      novelty: 1.0,
      reinforcement_count: 1,
      source_contact: "contact:telegram:1",
    });
    ctx.graph.setDynamic("info_cook", "last_access_ms", 0);
    ctx.graph.addRelation("contact:telegram:1", "knows", "info_cook");

    // biome-ignore lint/style/noNonNullAssertion: test — contribute 已知存在
    const items = relationshipsMod.contribute!(ctx as unknown as ModContext);
    const profileItem = items.find(
      (i) => "key" in i && (i as { key: string }).key === "contact-profile",
    );
    const content = JSON.stringify(profileItem);
    // 全 fading 时的自然提示
    expect(content).toContain("getting fuzzy");
    expect(content).toContain("recalling important ones");
  });
});

// -- ADR-151 T3: 动态礼貌 prompt 注入 ----------------------------------------

describe("relationships.mod — tier-based tone guidance", () => {
  it("tier 5 → 亲密语气", () => {
    const ctx = makeCtx({ targetNodeId: "contact:telegram:1" });
    ctx.graph.addContact("contact:telegram:1", { tier: 5, display_name: "Amy" });

    const items = relationshipsMod.contribute?.(ctx as unknown as ModContext) ?? [];
    const profileItem = items.find(
      (i) => "key" in i && (i as { key: string }).key === "contact-profile",
    );
    const content = JSON.stringify(profileItem);
    expect(content).toContain("tone: 跟Amy说话随意亲密，像最亲的人");
  });

  it("tier 500 → 礼貌得体", () => {
    const ctx = makeCtx({ targetNodeId: "contact:telegram:1" });
    ctx.graph.addContact("contact:telegram:1", { tier: 500, display_name: "Bob" });

    const items = relationshipsMod.contribute?.(ctx as unknown as ModContext) ?? [];
    const profileItem = items.find(
      (i) => "key" in i && (i as { key: string }).key === "contact-profile",
    );
    const content = JSON.stringify(profileItem);
    expect(content).toContain("tone: 跟Bob保持礼貌得体");
  });

  it("tier 50 → 轻松自然", () => {
    const ctx = makeCtx({ targetNodeId: "contact:telegram:1" });
    ctx.graph.addContact("contact:telegram:1", { tier: 50, display_name: "Charlie" });

    const items = relationshipsMod.contribute?.(ctx as unknown as ModContext) ?? [];
    const profileItem = items.find(
      (i) => "key" in i && (i as { key: string }).key === "contact-profile",
    );
    const content = JSON.stringify(profileItem);
    expect(content).toContain("tone: 跟Charlie说话轻松自然，像日常朋友");
  });

  it("无 target 时不注入语气指导", () => {
    const ctx = makeCtx({ targetNodeId: null });
    ctx.graph.addContact("contact:telegram:1", { tier: 5, display_name: "Amy" });

    const items = relationshipsMod.contribute?.(ctx as unknown as ModContext) ?? [];
    const content = JSON.stringify(items);
    expect(content).not.toContain("tone:");
  });

  it("bot 联系人不注入语气指导", () => {
    const ctx = makeCtx({ targetNodeId: "contact:telegram:9001" });
    ctx.graph.addContact("contact:telegram:9001", { tier: 500, display_name: "BotHelper", is_bot: true });

    const items = relationshipsMod.contribute?.(ctx as unknown as ModContext) ?? [];
    const content = JSON.stringify(items);
    expect(content).not.toContain("tone:");
    // bot 应渲染功能性描述
    expect(content).toContain("is a bot");
  });
});

// -- 活跃模式变化检测（场景 5: 长期陪伴增强） --------------------------------

/**
 * 构建一个 activeHours 数组，在指定小时有显著活跃度。
 * 模拟经过多次 EMA 更新后某小时成为峰值的结果。
 */
function hoursWithPeak(peakHour: number, peakValue = 0.5): number[] {
  const h = new Array(24).fill(0);
  h[peakHour] = peakValue;
  return h;
}

/**
 * 构建可运行 onTickEnd 的上下文（含 tierTrackers + contactProfiles）。
 * DB 不可用时 frequency=0，不影响模式变化检测逻辑。
 */
function makeTierCtx(contactId: string, profile: ContactProfile, tick: number, nowMs?: number) {
  const graph = new WorldModel();
  graph.tick = tick;
  graph.addContact(contactId, { tier: 150 });

  const state = {
    targetNodeId: null,
    contactProfiles: { [contactId]: profile } as Record<string, ContactProfile>,
    tierTrackers: {
      [contactId]: { consecutiveHigh: 0, consecutiveLow: 0, lastEvalTick: 0 },
    },
  };

  return {
    graph,
    state,
    tick,
    nowMs: nowMs ?? tick * 60_000,
    getModState: () => undefined,
    dispatch: () => undefined,
  };
}

describe("relationships.mod — 活跃模式变化检测 (scheduleShift)", () => {
  it("峰值从 14:00 变到 22:00（+8h）→ 检测到日程变化", () => {
    const tick = TIER_EVAL_INTERVAL; // 必须是 TIER_EVAL_INTERVAL 的倍数且非 0
    const profile: ContactProfile = {
      activeHours: hoursWithPeak(22),
      interests: [],
      lastUpdatedTick: 0,
      previousPeakHour: 14,
      scheduleShift: null,
      portrait: null,
      portraitTick: null,
      traits: {},
    };

    const ctx = makeTierCtx("contact:telegram:1", profile, tick);
    relationshipsMod.onTickEnd?.(ctx as unknown as ModContext);

    // 14→22: 两者都 > 12，不属于 night owl / early bird 的跨半天变化
    expect(profile.scheduleShift).toBe("shifted from afternoon to evening");
    expect(profile.previousPeakHour).toBe(22);
  });

  it("峰值从 23:00 变到 1:00（跨午夜 2h）→ 不触发（< 3h）", () => {
    const tick = TIER_EVAL_INTERVAL;
    const profile: ContactProfile = {
      activeHours: hoursWithPeak(1),
      interests: [],
      lastUpdatedTick: 0,
      previousPeakHour: 23,
      scheduleShift: "old shift that should be cleared",
      portrait: null,
      portraitTick: null,
      traits: {},
    };

    const ctx = makeTierCtx("contact:telegram:1", profile, tick);
    relationshipsMod.onTickEnd?.(ctx as unknown as ModContext);

    expect(profile.scheduleShift).toBeNull();
    expect(profile.previousPeakHour).toBe(1);
  });

  it("峰值从 2:00 变到 22:00（跨午夜 4h）→ 触发", () => {
    const tick = TIER_EVAL_INTERVAL;
    const profile: ContactProfile = {
      activeHours: hoursWithPeak(22),
      interests: [],
      lastUpdatedTick: 0,
      previousPeakHour: 2,
      scheduleShift: null,
      portrait: null,
      portraitTick: null,
      traits: {},
    };

    const ctx = makeTierCtx("contact:telegram:1", profile, tick);
    relationshipsMod.onTickEnd?.(ctx as unknown as ModContext);

    // circularShift = min(20, 4) = 4 >= 3 → 触发
    // 22 > 12 && 2 <= 12 → "shifted later (possible night owl pattern)"
    expect(profile.scheduleShift).toBe("shifted later (possible night owl pattern)");
    expect(profile.previousPeakHour).toBe(22);
  });

  it("首次评估（previousPeakHour=null）→ 不触发，仅记录峰值", () => {
    const tick = TIER_EVAL_INTERVAL;
    const profile: ContactProfile = {
      activeHours: hoursWithPeak(14),
      interests: [],
      lastUpdatedTick: 0,
      previousPeakHour: null,
      scheduleShift: null,
      portrait: null,
      portraitTick: null,
      traits: {},
    };

    const ctx = makeTierCtx("contact:telegram:1", profile, tick);
    relationshipsMod.onTickEnd?.(ctx as unknown as ModContext);

    expect(profile.scheduleShift).toBeNull();
    expect(profile.previousPeakHour).toBe(14);
  });

  it("峰值不变 → scheduleShift 清除", () => {
    const tick = TIER_EVAL_INTERVAL;
    const profile: ContactProfile = {
      activeHours: hoursWithPeak(14),
      interests: [],
      lastUpdatedTick: 0,
      previousPeakHour: 14,
      scheduleShift: "old shift that should be cleared",
      portrait: null,
      portraitTick: null,
      traits: {},
    };

    const ctx = makeTierCtx("contact:telegram:1", profile, tick);
    relationshipsMod.onTickEnd?.(ctx as unknown as ModContext);

    expect(profile.scheduleShift).toBeNull();
    expect(profile.previousPeakHour).toBe(14);
  });

  it("scheduleShift 注入到 contribute() 的联系人画像中", () => {
    const ctx = makeCtx({
      targetNodeId: "contact:telegram:1",
      contactProfiles: {
        "contact:telegram:1": {
          activeHours: hoursWithPeak(22),
          interests: [],
          lastUpdatedTick: 50,
          previousPeakHour: 10,
          scheduleShift: "shifted later (possible night owl pattern)",
          portrait: null,
          portraitTick: null,
          traits: {},
        },
      },
    });
    ctx.graph.addContact("contact:telegram:1", { tier: 50, display_name: "Eve" });

    const items = relationshipsMod.contribute?.(ctx as unknown as ModContext) ?? [];
    const profileItem = items.find(
      (i) => "key" in i && (i as { key: string }).key === "contact-profile",
    );
    expect(profileItem).toBeDefined();

    const content = JSON.stringify(profileItem);
    expect(content).toContain("Schedule change detected");
    expect(content).toContain("shifted later (possible night owl pattern)");
  });

  it("shifted earlier — 峰值从 22:00 变到 6:00", () => {
    const tick = TIER_EVAL_INTERVAL;
    const profile: ContactProfile = {
      activeHours: hoursWithPeak(6),
      interests: [],
      lastUpdatedTick: 0,
      previousPeakHour: 22,
      scheduleShift: null,
      portrait: null,
      portraitTick: null,
      traits: {},
    };

    const ctx = makeTierCtx("contact:telegram:1", profile, tick);
    relationshipsMod.onTickEnd?.(ctx as unknown as ModContext);

    // 6 <= 12 && 22 > 12 → "shifted earlier (possible early bird pattern)"
    expect(profile.scheduleShift).toBe("shifted earlier (possible early bird pattern)");
    expect(profile.previousPeakHour).toBe(6);
  });
});

describe("relationships.mod — trait crystallization", () => {
  it("self sense 只写 BeliefStore 时也能创建 ContactProfile 并结晶", () => {
    const tick = TIER_EVAL_INTERVAL;
    const nowMs = tick * 60_000;
    const graph = new WorldModel();
    graph.tick = tick;
    graph.addContact("contact:telegram:1", { tier: 150 });

    const impressionCounts: Record<string, number> = {};
    for (let i = 0; i < 5; i++) {
      graph.beliefs.update("contact:telegram:1", "trait:warmth", 0.9, "semantic", nowMs + i);
      impressionCounts["contact:telegram:1::trait:warmth"] =
        (impressionCounts["contact:telegram:1::trait:warmth"] ?? 0) + 1;
    }

    const ctx = {
      graph,
      state: {
        targetNodeId: null,
        contactProfiles: {} as Record<string, ContactProfile>,
        tierTrackers: {},
      },
      tick,
      nowMs: nowMs + 5,
      getModState: (name: string) => (name === "observer" ? { impressionCounts } : undefined),
      dispatch: () => undefined,
    };

    relationshipsMod.onTickEnd?.(ctx as unknown as ModContext);

    expect(ctx.state.contactProfiles["contact:telegram:1"]).toBeDefined();
    expect(ctx.state.contactProfiles["contact:telegram:1"].traits.warmth).toBeDefined();
    expect(ctx.state.contactProfiles["contact:telegram:1"].traits.warmth.value).toBeGreaterThan(0);
  });
});
