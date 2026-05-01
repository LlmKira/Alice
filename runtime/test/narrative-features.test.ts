/**
 * ADR-64 VI-2/3/4 测试 — Thread Summary + Living Portrait + Group Portrait。
 */
import { describe, expect, it } from "vitest";
import type { ModContext } from "../src/core/types.js";
import { WorldModel } from "../src/graph/world-model.js";
import {
  type ContactProfile,
  type GroupProfile,
  relationshipsMod,
} from "../src/mods/relationships.mod.js";
import { threadsMod } from "../src/mods/threads.mod.js";

// -- 测试辅助 -----------------------------------------------------------------

function makeRelCtx(
  stateOverride: Partial<{
    targetNodeId: string | null;
    contactProfiles: Record<string, ContactProfile>;
    tierTrackers: Record<string, unknown>;
    groupProfiles: Record<string, GroupProfile>;
  }> = {},
  tick = 100,
) {
  const graph = new WorldModel();
  graph.tick = tick;
  const state = {
    targetNodeId: stateOverride.targetNodeId ?? null,
    contactProfiles: stateOverride.contactProfiles ?? {},
    tierTrackers: stateOverride.tierTrackers ?? {},
    groupProfiles: stateOverride.groupProfiles ?? {},
  };
  return {
    graph,
    state,
    tick,
    getModState: (_name: string) => undefined as unknown,
    dispatch: () => undefined,
  };
}

// biome-ignore lint/style/noNonNullAssertion: test — instructions 已知存在
const relInstructions = relationshipsMod.instructions!;
// biome-ignore lint/style/noNonNullAssertion: test — instructions 已知存在
const threadInstructions = threadsMod.instructions!;

// =============================================================================
// VI-2: Thread Summary — thread_review
// =============================================================================

describe("threads.mod — thread_review (VI-2)", () => {
  it("更新线程 summary 和 summaryTick", () => {
    // thread_review 需要 DB — 跳过 DB 相关测试，验证指令定义存在
    expect(threadInstructions.thread_review).toBeDefined();
    expect(threadInstructions.thread_review.params.threadId).toBeDefined();
    expect(threadInstructions.thread_review.params.summary).toBeDefined();
    expect(threadInstructions.thread_review.description).toContain("摘要");
  });

  it("空 summary 被 Zod schema 拒绝（z.string().trim().min(1)）", () => {
    const schema = threadInstructions.thread_review.params.summary.schema;
    expect(schema).toBeDefined();
    // 空白字符串经 trim 后长度为 0，触发 min(1) 校验失败
    const result = schema?.safeParse("   ");
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// VI-3: Living Portrait — synthesize_portrait
// =============================================================================

describe("relationships.mod — synthesize_portrait (VI-3)", () => {
  it("为联系人生成综合印象", () => {
    const ctx = makeRelCtx();
    ctx.graph.addContact("contact:alice");

    const result = relInstructions.synthesize_portrait.impl(ctx as unknown as ModContext, {
      contactId: "contact:alice",
      portrait: "A cheerful 25-year-old software engineer who loves cats and tea.",
    }) as { success: boolean; contactId: string; portraitTick: number };

    expect(result.success).toBe(true);
    expect(result.portraitTick).toBe(100);
    expect(ctx.state.contactProfiles["contact:alice"].portrait).toBe(
      "A cheerful 25-year-old software engineer who loves cats and tea.",
    );
    expect(ctx.state.contactProfiles["contact:alice"].portraitTick).toBe(100);
  });

  it("空 portrait 由 Zod schema 拒绝（dispatcher 层校验）", () => {
    // portrait 的 z.string().trim().min(1) 在 dispatcher 层拒绝空/纯空白输入。
    const schema = relInstructions.synthesize_portrait.params.portrait.schema;
    expect(schema).toBeDefined();
    const parsed = schema?.safeParse("  ");
    expect(parsed.success).toBe(false);
  });

  it("自动创建 profile 如果不存在", () => {
    const ctx = makeRelCtx();
    ctx.graph.addContact("contact:new");
    expect(ctx.state.contactProfiles["contact:new"]).toBeUndefined();

    relInstructions.synthesize_portrait.impl(ctx as unknown as ModContext, {
      contactId: "contact:new",
      portrait: "Someone I just met at a party.",
    });

    expect(ctx.state.contactProfiles["contact:new"]).toBeDefined();
    expect(ctx.state.contactProfiles["contact:new"].portrait).toBe(
      "Someone I just met at a party.",
    );
    // 其他字段应为默认值
    expect(ctx.state.contactProfiles["contact:new"].interests).toEqual([]);
  });

  it("更新已有 portrait", () => {
    const ctx = makeRelCtx({
      contactProfiles: {
        "contact:eve": {
          activeHours: new Array(24).fill(0),
          interests: ["coding"],
          lastUpdatedTick: 50,
          previousPeakHour: null,
          scheduleShift: null,
          portrait: "Old impression.",
          portraitTick: 50,
          traits: {},
        },
      },
    });
    ctx.graph.addContact("contact:eve");

    relInstructions.synthesize_portrait.impl(ctx as unknown as ModContext, {
      contactId: "contact:eve",
      portrait: "Updated impression — she started learning Rust.",
    });

    expect(ctx.state.contactProfiles["contact:eve"].portrait).toBe(
      "Updated impression — she started learning Rust.",
    );
    expect(ctx.state.contactProfiles["contact:eve"].portraitTick).toBe(100);
    // 不应覆盖其他字段
    expect(ctx.state.contactProfiles["contact:eve"].interests).toEqual(["coding"]);
  });
});

// =============================================================================
// VI-4: Group Portrait — update_group_profile
// =============================================================================

describe("relationships.mod — update_group_profile (VI-4)", () => {
  it("创建新群组画像", () => {
    const ctx = makeRelCtx();

    const result = relInstructions.update_group_profile.impl(ctx as unknown as ModContext, {
      channelId: "channel:group1",
      topic: "TypeScript and web dev",
      atmosphere: "Friendly and technical",
      aliceRole: "Active participant",
      memberHighlights: "Bob is the admin, Eve often shares articles",
    }) as { success: boolean; channelId: string; profile: GroupProfile };

    expect(result.success).toBe(true);
    expect(result.profile.topic).toBe("TypeScript and web dev");
    expect(result.profile.atmosphere).toBe("Friendly and technical");
    expect(result.profile.aliceRole).toBe("Active participant");
    expect(result.profile.memberHighlights).toBe("Bob is the admin, Eve often shares articles");
    expect(result.profile.portraitTick).toBe(100);
  });

  it("部分更新 — 只更新 topic", () => {
    const ctx = makeRelCtx({
      groupProfiles: {
        "channel:group2": {
          topic: "Old topic",
          atmosphere: "Chill",
          aliceRole: "Lurker",
          memberHighlights: null,
          portraitTick: 50,
        },
      },
    });

    relInstructions.update_group_profile.impl(ctx as unknown as ModContext, {
      channelId: "channel:group2",
      topic: "New topic: AI and ML",
    });

    const gp = ctx.state.groupProfiles["channel:group2"];
    expect(gp.topic).toBe("New topic: AI and ML");
    // 未传入的字段应保持不变
    expect(gp.atmosphere).toBe("Chill");
    expect(gp.aliceRole).toBe("Lurker");
    expect(gp.portraitTick).toBe(100); // tick 已更新
  });

  it("空字符串值设为 null（Zod trim 后 → 空字符串 → null）", () => {
    const ctx = makeRelCtx();

    // 模拟 Zod .trim() 后的值传入 impl（dispatcher 会先 trim）
    relInstructions.update_group_profile.impl(ctx as unknown as ModContext, {
      channelId: "channel:group3",
      topic: "", // Zod .trim().optional() 会将 "   " trim 为 ""
      atmosphere: "Lively",
    });

    const gp = ctx.state.groupProfiles["channel:group3"];
    expect(gp.topic).toBeNull(); // "" || null → null
    expect(gp.atmosphere).toBe("Lively");
  });

  it("自动创建群组画像", () => {
    const ctx = makeRelCtx();
    expect(ctx.state.groupProfiles["channel:new_group"]).toBeUndefined();

    relInstructions.update_group_profile.impl(ctx as unknown as ModContext, {
      channelId: "channel:new_group",
      atmosphere: "Noisy",
    });

    expect(ctx.state.groupProfiles["channel:new_group"]).toBeDefined();
    expect(ctx.state.groupProfiles["channel:new_group"].atmosphere).toBe("Noisy");
    expect(ctx.state.groupProfiles["channel:new_group"].topic).toBeNull();
  });
});

// =============================================================================
// Contribute 增强验证
// =============================================================================

describe("relationships.mod — contribute (VI-3/VI-4 增强)", () => {
  it("展示 portrait（如果有）", () => {
    const ctx = makeRelCtx({
      targetNodeId: "contact:telegram:1001",
      contactProfiles: {
        "contact:telegram:1001": {
          activeHours: new Array(24).fill(0),
          interests: [],
          lastUpdatedTick: 50,
          previousPeakHour: null,
          scheduleShift: null,
          portrait: "A warm and curious person who loves photography.",
          portraitTick: 90,
          traits: {},
        },
      },
    });
    ctx.graph.addContact("contact:telegram:1001");

    // biome-ignore lint/style/noNonNullAssertion: test
    const items = relationshipsMod.contribute!(ctx as unknown as ModContext<unknown>);
    const profileItem = items.find((i) => i.key === "contact-profile");
    expect(profileItem).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: test — expect above guarantees defined
    const joined = profileItem!.lines.join("\n");
    expect(joined).toContain("Portrait: A warm and curious person");
  });

  it("群组频道展示 group profile", () => {
    const ctx = makeRelCtx({
      targetNodeId: "channel:mygroup",
      groupProfiles: {
        "channel:mygroup": {
          topic: "Anime discussion",
          atmosphere: "Passionate",
          aliceRole: "Moderator",
          memberHighlights: "Senpai leads most discussions",
          portraitTick: 80,
        },
      },
    });
    ctx.graph.addChannel("channel:mygroup", {
      chat_type: "supergroup",
      unread: 5,
      pending_directed: 0,
      last_directed_ms: 0,
      tier_contact: 50,
    });

    // biome-ignore lint/style/noNonNullAssertion: test
    const items = relationshipsMod.contribute!(ctx as unknown as ModContext<unknown>);
    const channelItem = items.find((i) => i.key === "channel-info");
    expect(channelItem).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: test — expect above guarantees defined
    const joined = channelItem!.lines.join("\n");
    expect(joined).toContain("Topic: Anime discussion");
    expect(joined).toContain("Atmosphere: Passionate");
    expect(joined).toContain("Role here: Moderator");
    expect(joined).toContain("Key members: Senpai leads most discussions");
  });

  it("群组无 profile 时 Reflection 路径提示描述", () => {
    const ctx = makeRelCtx({
      targetNodeId: "channel:newgroup",
    });
    ctx.graph.addChannel("channel:newgroup", {
      chat_type: "group",
      unread: 0,
      pending_directed: 0,
      last_directed_ms: 0,
      tier_contact: 150,
    });
    // ADR-66 F13: 指令性提示限制到 Reflection 路径
    // 设置 soul mod state 为 reflection 以触发提示
    ctx.getModState = (name: string) => {
      if (name === "soul") return { activeVoice: "reflection" };
      return undefined;
    };

    // biome-ignore lint/style/noNonNullAssertion: test
    const items = relationshipsMod.contribute!(ctx as unknown as ModContext<unknown>);
    const channelItem = items.find((i) => i.key === "channel-info");
    expect(channelItem).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: test — expect above guarantees defined
    const joined = channelItem!.lines.join("\n");
    // ADR-66: 改为事实性描述，不暴露函数名
    expect(joined).toContain("group profile");
  });

  it("私聊频道不展示群组画像提示", () => {
    const ctx = makeRelCtx({
      targetNodeId: "channel:private",
    });
    ctx.graph.addChannel("channel:private", {
      chat_type: "private",
      unread: 0,
      pending_directed: 0,
      last_directed_ms: 0,
      tier_contact: 50,
    });

    // biome-ignore lint/style/noNonNullAssertion: test
    const items = relationshipsMod.contribute!(ctx as unknown as ModContext<unknown>);
    const channelItem = items.find((i) => i.key === "channel-info");
    expect(channelItem).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: test — expect above guarantees defined
    const joined = channelItem!.lines.join("\n");
    expect(joined).not.toContain("update_group_profile");
    expect(joined).not.toContain("Topic:");
  });
});
