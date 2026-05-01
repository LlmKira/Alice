/**
 * ADR-172: Information Visibility Layer — 认知隐私边界测试。
 *
 * 验证：
 * 1. 群聊中 GROUP_REDACTED keys 被整体删除
 * 2. 群聊中 ENTITY_SCOPED keys 逐行过滤，只保留当前群相关实体
 * 3. 私聊中所有内容放行
 * 4. header/footer 始终放行
 * 5. safeDisplayName() 永不返回 raw graph ID
 * 6. thread 块过滤基于 involves 关系
 *
 * @see runtime/src/core/visibility.ts
 * @see runtime/src/graph/display.ts
 * @see docs/adr/172-information-visibility-layer.md
 */
import { describe, expect, it } from "vitest";
import { PromptBuilder } from "../src/core/prompt-style.js";
import { section } from "../src/core/types.js";
import {
  type AudienceContext,
  applyVisibilityFilter,
  buildAudienceContext,
} from "../src/core/visibility.js";
import { resolveDisplayName, safeDisplayName } from "../src/graph/display.js";
import { WorldModel } from "../src/graph/world-model.js";

// ═══════════════════════════════════════════════════════════════════════════
// 辅助
// ═══════════════════════════════════════════════════════════════════════════

/** 构建最小测试图。 */
function buildTestGraph(): WorldModel {
  const G = new WorldModel();
  G.tick = 100;
  G.addAgent("self");

  // 群聊 — Alice 当前在此
  G.addChannel("channel:telegram:-1009900000002", {
    unread: 0,
    tier_contact: 50,
    chat_type: "supergroup",
    display_name: "万人群",
    pending_directed: 0,
    last_directed_ms: 0,
  });

  // 另一个群（不应在群聊 prompt 中可见）
  G.addChannel("channel:telegram:-1009900000003", {
    unread: 5,
    tier_contact: 50,
    chat_type: "supergroup",
    display_name: "技术讨论群",
    pending_directed: 0,
    last_directed_ms: 0,
  });

  // 私聊联系人（也是万人群成员）
  G.addContact("contact:telegram:1000000001", {
    tier: 5,
    display_name: "Kurisu",
    last_active_ms: 60000,
  });
  G.addChannel("channel:telegram:1000000001", {
    unread: 2,
    tier_contact: 5,
    chat_type: "private",
    display_name: "Kurisu",
    pending_directed: 0,
    last_directed_ms: 0,
  });
  // Kurisu是万人群成员
  G.addRelation("channel:telegram:-1009900000002", "joined", "contact:telegram:1000000001");

  // 非群成员联系人（只在技术讨论群）
  G.addContact("contact:telegram:9999999", {
    tier: 150,
    display_name: "路人甲",
    last_active_ms: 30000,
  });
  G.addRelation("channel:telegram:-1009900000003", "joined", "contact:telegram:9999999");

  // 线程：关联到当前群
  G.addThread("thread_42", {
    title: "群里的话题",
    status: "open",
    weight: "minor",
    w: 0.5,
    created_ms: 80000,
    source: "conversation",
  });
  G.addRelation("thread_42", "involves", "channel:telegram:-1009900000002");

  // 线程：关联到私聊（不应在群聊中可见）
  G.addThread("thread_43", {
    title: "私聊承诺",
    status: "open",
    weight: "minor",
    w: 0.5,
    created_ms: 80000,
    source: "conversation",
  });
  G.addRelation("thread_43", "involves", "contact:telegram:1000000001");

  // 系统线程
  G.addThread("thread_99", {
    title: "morning_digest",
    status: "open",
    weight: "major",
    w: 2.0,
    created_ms: 80000,
    source: "system",
  });

  return G;
}

/** 群聊 audience。 */
function groupAudience(): AudienceContext {
  return {
    targetChat: "channel:telegram:-1009900000002",
    chatType: "supergroup",
    targetContact: null,
    targetTier: null,
  };
}

/** 私聊 audience。 */
function privateAudience(): AudienceContext {
  return {
    targetChat: "channel:telegram:1000000001",
    chatType: "private",
    targetContact: "contact:telegram:1000000001",
    targetTier: 5,
  };
}

/** 快捷创建 ContributionItem。 */
function makeSection(key: string, ...texts: string[]) {
  return section(
    key,
    texts.map((t) => PromptBuilder.of(t)),
    key,
  );
}

/** 快捷创建 header item。 */
function makeHeader(...texts: string[]) {
  return {
    bucket: "header" as const,
    key: "personality",
    lines: texts.map((t) => PromptBuilder.of(t)),
  };
}

/** 快捷创建 footer item。 */
function makeFooter(...texts: string[]) {
  return {
    bucket: "footer" as const,
    lines: texts.map((t) => PromptBuilder.of(t)),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// safeDisplayName
// ═══════════════════════════════════════════════════════════════════════════

describe("safeDisplayName", () => {
  it("返回 display_name 如果存在", () => {
    const G = buildTestGraph();
    expect(safeDisplayName(G, "contact:telegram:1000000001")).toBe("Kurisu");
  });

  it("节点不存在时返回 '(someone)'", () => {
    const G = buildTestGraph();
    expect(safeDisplayName(G, "contact:telegram:99999")).toBe("(someone)");
  });

  it("contact 无 display_name 时返回 '(someone)'", () => {
    const G = new WorldModel();
    G.addContact("contact:telegram:111", { tier: 50 });
    expect(safeDisplayName(G, "contact:telegram:111")).toBe("(someone)");
  });

  it("group channel 无 display_name 时返回 '(a group)'", () => {
    const G = new WorldModel();
    G.addChannel("channel:telegram:-100999", {
      unread: 0,
      tier_contact: 50,
      chat_type: "supergroup",
      pending_directed: 0,
      last_directed_ms: 0,
    });
    expect(safeDisplayName(G, "channel:telegram:-100999")).toBe("(a group)");
  });

  it("private channel 无 display_name 时返回 '(a private chat)'", () => {
    const G = new WorldModel();
    G.addChannel("channel:telegram:222", {
      unread: 0,
      tier_contact: 50,
      chat_type: "private",
      pending_directed: 0,
      last_directed_ms: 0,
    });
    expect(safeDisplayName(G, "channel:telegram:222")).toBe("(a private chat)");
  });

  it("永不返回 raw graph ID 格式", () => {
    const G = buildTestGraph();
    // 测试图中所有实体
    for (const nodeId of [
      "channel:telegram:-1009900000002",
      "channel:telegram:-1009900000003",
      "contact:telegram:1000000001",
      "channel:telegram:1000000001",
      "thread_42",
      "thread_43",
    ]) {
      const name = safeDisplayName(G, nodeId);
      expect(name).not.toMatch(/^channel:[+-]?\d+$/);
      expect(name).not.toMatch(/^contact:\d+$/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// buildAudienceContext
// ═══════════════════════════════════════════════════════════════════════════

describe("buildAudienceContext", () => {
  it("群聊 → chatType=supergroup, targetContact=null", () => {
    const G = buildTestGraph();
    const ctx = buildAudienceContext(G, "channel:telegram:-1009900000002", "supergroup");
    expect(ctx.chatType).toBe("supergroup");
    expect(ctx.targetContact).toBeNull();
  });

  it("私聊 → chatType=private, targetContact 解析", () => {
    const G = buildTestGraph();
    const ctx = buildAudienceContext(G, "channel:telegram:1000000001", "private");
    expect(ctx.chatType).toBe("private");
    expect(ctx.targetContact).toBe("contact:telegram:1000000001");
    expect(ctx.targetTier).toBe(5);
  });

  it("null target → 安全降级", () => {
    const G = buildTestGraph();
    const ctx = buildAudienceContext(G, null, "private");
    expect(ctx.targetChat).toBeNull();
    expect(ctx.targetContact).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// applyVisibilityFilter — 群聊
// ═══════════════════════════════════════════════════════════════════════════

describe("applyVisibilityFilter — 群聊", () => {
  it("GROUP_REDACTED 内务 keys 被整体删除", () => {
    const G = buildTestGraph();
    const audience = groupAudience();
    const items = [
      makeSection("consolidation-hint", "可以整理记忆了"),
      makeSection("memory-housekeeping", "3 条记忆即将衰减"),
    ];
    const filtered = applyVisibilityFilter(items, audience, G);
    expect(filtered).toHaveLength(0);
  });

  it("群成员的社交认知在群聊中保留（ENTITY_SCOPED）", () => {
    const G = buildTestGraph();
    const audience = groupAudience();
    // Kurisu是万人群成员 → 她的 mood/reflection 应保留
    const items = [
      makeSection("contact-mood", "Kurisu: mood positive — listen first, tease later"),
      makeSection(
        "strategy-reflection",
        "Looking back at recent interactions:",
        "Kurisu: went well",
      ),
    ];
    const filtered = applyVisibilityFilter(items, audience, G);
    expect(filtered).toHaveLength(2);
  });

  it("非群成员的社交认知在群聊中过滤", () => {
    const G = buildTestGraph();
    const audience = groupAudience();
    // 路人甲不在万人群 → 她的 mood 应过滤
    const items = [
      makeSection("contact-mood", "路人甲: mood negative"),
      makeSection(
        "strategy-reflection",
        "Looking back at recent interactions:",
        "路人甲: didn't land",
      ),
    ];
    const filtered = applyVisibilityFilter(items, audience, G);
    // contact-mood: 单行关于路人甲 → 过滤掉整个 section
    // strategy-reflection: 通用首行保留，路人甲行过滤
    expect(filtered).toHaveLength(1); // 只剩 strategy-reflection
    const reflection = filtered[0];
    expect(reflection.lines).toHaveLength(1); // 只剩通用行
  });

  // ADR-191: self-awareness 和 personality-drift 只含 Alice 自身语义标签，群聊中可见
  it("Alice 自身信息（self-awareness, personality-drift）群聊中放行", () => {
    const G = buildTestGraph();
    const audience = groupAudience();
    const items = [
      makeSection("self-awareness", "Lately in diligence mode"),
      makeSection("personality-drift", "Personality: within normal range"),
    ];
    const filtered = applyVisibilityFilter(items, audience, G);
    expect(filtered).toHaveLength(2);
  });

  it("ALWAYS_VISIBLE keys 放行", () => {
    const G = buildTestGraph();
    const audience = groupAudience();
    const items = [
      makeSection("wall-clock", "现在是上午 8 点"),
      makeSection("self-mood", "心情平静"),
      makeSection("conversation", "[08:00] Alice: 早上好"),
      makeSection("channel-info", "群聊信息"),
    ];
    const filtered = applyVisibilityFilter(items, audience, G);
    expect(filtered).toHaveLength(4);
  });

  it("header 和 footer 始终放行", () => {
    const G = buildTestGraph();
    const audience = groupAudience();
    const items = [
      makeHeader("You are Alice."),
      makeFooter("Decide what to do."),
      makeSection("consolidation-hint", "不应该出现"),
    ];
    const filtered = applyVisibilityFilter(items, audience, G);
    expect(filtered).toHaveLength(2);
    expect(filtered[0].bucket).toBe("header");
    expect(filtered[1].bucket).toBe("footer");
  });

  it("group-dynamics-* keys 放行（天然 scoped）", () => {
    const G = buildTestGraph();
    const audience = groupAudience();
    const items = [makeSection("group-dynamics-channel:telegram:-1009900000002", "活跃发言者: 张三, 李四")];
    const filtered = applyVisibilityFilter(items, audience, G);
    expect(filtered).toHaveLength(1);
  });

  it("ENTITY_SCOPED: situation 逐行过滤（群成员保留）", () => {
    const G = buildTestGraph();
    const audience = groupAudience();
    const items = [
      makeSection(
        "situation",
        "Several things happening at once.", // 通用行 → 保留
        "万人群 has high activity.", // 提及当前群 → 保留
        "技术讨论群 needs attention.", // 提及其他群 → 删除
        "Kurisu is waiting.", // 群成员 → 保留
        "路人甲 sent a message.", // 非群成员 → 删除
      ),
    ];
    const filtered = applyVisibilityFilter(items, audience, G);
    expect(filtered).toHaveLength(1);
    // 通用行 + 当前群 + 群成员Kurisu = 3 行
    expect(filtered[0].lines).toHaveLength(3);
  });

  it("ENTITY_SCOPED: strategy-hints 逐行过滤（群成员保留）", () => {
    const G = buildTestGraph();
    const audience = groupAudience();
    const items = [
      makeSection(
        "strategy-hints",
        "万人群 atmosphere is energetic.", // 当前群 → 保留
        "Kurisu hasn't replied in a while.", // 群成员 → 保留
        "路人甲 is losing interest.", // 非群成员 → 删除
      ),
    ];
    const filtered = applyVisibilityFilter(items, audience, G);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].lines).toHaveLength(2);
  });

  it("未分类 key 默认放行（保守策略）", () => {
    const G = buildTestGraph();
    const audience = groupAudience();
    const items = [makeSection("new-future-mod", "未来新模块的贡献")];
    const filtered = applyVisibilityFilter(items, audience, G);
    expect(filtered).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// applyVisibilityFilter — 私聊
// ═══════════════════════════════════════════════════════════════════════════

describe("applyVisibilityFilter — 私聊", () => {
  it("私聊中所有内容放行", () => {
    const G = buildTestGraph();
    const audience = privateAudience();
    const items = [
      makeSection("contact-profile", "tier: 5, 亲密好友"),
      makeSection("self-awareness", "最近主要在某聊天"),
      makeSection("strategy-hints", "Kurisu hasn't replied"),
      makeSection("situation", "技术讨论群 needs attention."),
      makeSection("wall-clock", "现在是上午 8 点"),
    ];
    const filtered = applyVisibilityFilter(items, audience, G);
    expect(filtered).toHaveLength(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// applyVisibilityFilter — thread 块过滤
// ═══════════════════════════════════════════════════════════════════════════

describe("applyVisibilityFilter — threads", () => {
  it("群聊中：关联到当前群的 thread 可见", () => {
    const G = buildTestGraph();
    const audience = groupAudience();
    const items = [
      makeSection(
        "threads",
        '[#42] "群里的话题" — open', // involves 当前群 → 可见
        "  beat: 讨论进展",
        '[#43] "私聊承诺" — open', // involves 私聊联系人 → 不可见
        "  beat: 等待回复",
      ),
    ];
    const filtered = applyVisibilityFilter(items, audience, G);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].lines).toHaveLength(2); // #42 标头 + beat
  });

  it("群聊中：系统线程 [system] 不可见", () => {
    const G = buildTestGraph();
    const audience = groupAudience();
    const items = [
      makeSection("threads", '[#99] "morning_digest" [system] — open', "  frame: 总结昨晚事件"),
    ];
    const filtered = applyVisibilityFilter(items, audience, G);
    // 整个 section 被删除（无可见行）
    expect(filtered).toHaveLength(0);
  });

  it("私聊中：所有 thread 可见（包括系统线程）", () => {
    const G = buildTestGraph();
    const audience = privateAudience();
    const items = [
      makeSection(
        "threads",
        '[#42] "群里的话题" — open',
        "  beat: 讨论进展",
        '[#43] "私聊承诺" — open',
        "  beat: 等待回复",
        '[#99] "morning_digest" [system] — open',
        "  frame: 总结昨晚事件",
      ),
    ];
    const filtered = applyVisibilityFilter(items, audience, G);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].lines).toHaveLength(6); // 全部保留
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 集成场景：开盒重现测试
// ═══════════════════════════════════════════════════════════════════════════

describe("开盒防护 — 集成场景", () => {
  it("群聊 prompt 中：群成员信息保留，非成员/其他群信息过滤", () => {
    const G = buildTestGraph();
    const audience = groupAudience();

    // 模拟完整 prompt contribution
    const items = [
      makeHeader("You are Alice."),
      makeSection("wall-clock", "Time: 08:00 UTC+8"),
      makeSection("self-mood", "Mood: calm"),
      // Kurisu是群成员 → profile 保留（ENTITY_SCOPED 逐行过滤）
      makeSection("contact-profile", "Kurisu: close friend, 最近在聊猫猫"),
      // 路人甲不在群 → profile 过滤
      makeSection("contact-profile", "路人甲: acquaintance"),
      // ADR-191: self-awareness 只含 Alice 自身语义标签
      makeSection("self-awareness", "Lately in diligence mode. Attention focused on one person."),
      makeSection(
        "strategy-hints",
        "万人群 has energetic discussion.",
        "Kurisu commitment about 泡粉 is expiring.", // 群成员 → 保留
        "技术讨论群 needs your attention.", // 其他群 → 过滤
      ),
      makeSection(
        "situation",
        "Several things are happening.",
        "万人群 is very active.",
        "Kurisu is waiting for a reply.", // 群成员 → 保留
        "路人甲 sent something.", // 非群成员 → 过滤
      ),
      makeSection(
        "threads",
        '[#42] "群里的话题" — open',
        "  beat: 讨论进展",
        '[#43] "和Kurisu去吃泡粉" — open',
        "  beat: 承诺即将过期",
      ),
      makeSection("consolidation-hint", "可以整理记忆了"), // 内务 → 过滤
      makeFooter("Decide what to do."),
    ];

    const filtered = applyVisibilityFilter(items, audience, G);

    // 收集所有 filtered lines 的文本
    const allText = filtered.flatMap((item) => item.lines.map((l) => l.toString())).join("\n");

    // 不应出现：
    // 1. 联系人 raw ID
    expect(allText).not.toContain("1000000001");
    // 2. 非群成员的信息
    expect(allText).not.toContain("路人甲");
    // 3. 其他群的信息
    expect(allText).not.toContain("技术讨论群");
    // 4. 内务信息
    expect(filtered.find((i) => i.key === "consolidation-hint")).toBeUndefined();

    // 应该保留：
    // 1. header 和 footer
    expect(filtered.find((i) => i.bucket === "header")).toBeDefined();
    expect(filtered.find((i) => i.bucket === "footer")).toBeDefined();
    // 2. 基础 context
    expect(filtered.find((i) => i.key === "wall-clock")).toBeDefined();
    expect(filtered.find((i) => i.key === "self-mood")).toBeDefined();
    expect(filtered.find((i) => i.key === "self-awareness")).toBeDefined();
    // 3. 群成员Kurisu的信息保留
    expect(allText).toContain("Kurisu");
    // 4. 当前群相关的 thread (#42)
    const threadItem = filtered.find((i) => i.key === "threads");
    if (threadItem) {
      const threadText = threadItem.lines.map((l) => l.toString()).join("\n");
      expect(threadText).toContain("群里的话题");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ADR-204 C10: resolveDisplayName（safeDisplayName 的逆操作）
// ═══════════════════════════════════════════════════════════════════════════

describe("resolveDisplayName", () => {
  it("已是 contact:xxx 格式且存在 → 直接返回", () => {
    const G = buildTestGraph();
    expect(resolveDisplayName(G, "contact:telegram:1000000001")).toBe("contact:telegram:1000000001");
  });

  it("已是 channel:xxx 格式且存在 → 直接返回", () => {
    const G = buildTestGraph();
    expect(resolveDisplayName(G, "channel:telegram:-1009900000002")).toBe("channel:telegram:-1009900000002");
  });

  it("nodeId 格式但不存在 → null", () => {
    const G = buildTestGraph();
    expect(resolveDisplayName(G, "contact:telegram:999999")).toBeNull();
  });

  it("display_name 匹配 contact → 返回 nodeId", () => {
    const G = buildTestGraph();
    expect(resolveDisplayName(G, "Kurisu")).toBe("contact:telegram:1000000001");
  });

  it("display_name 大小写不敏感匹配", () => {
    const G = new WorldModel();
    G.addContact("contact:telegram:1", { display_name: "David", tier: 50 });
    expect(resolveDisplayName(G, "david")).toBe("contact:telegram:1");
    expect(resolveDisplayName(G, "DAVID")).toBe("contact:telegram:1");
  });

  it("display_name 匹配 channel → 返回 nodeId", () => {
    const G = buildTestGraph();
    expect(resolveDisplayName(G, "万人群")).toBe("channel:telegram:-1009900000002");
  });

  it("channel title 匹配 → 返回 nodeId", () => {
    const G = new WorldModel();
    G.addChannel("channel:telegram:-100123", {
      chat_type: "supergroup",
      tier_contact: 50,
    });
    G.setDynamic("channel:telegram:-100123", "title", "Dev Team");
    expect(resolveDisplayName(G, "dev team")).toBe("channel:telegram:-100123");
  });

  it("'self' → 返回 'self'", () => {
    const G = buildTestGraph();
    expect(resolveDisplayName(G, "self")).toBe("self");
    expect(resolveDisplayName(G, "Self")).toBe("self");
  });

  it("'alice' → 返回 'self'", () => {
    const G = buildTestGraph();
    expect(resolveDisplayName(G, "alice")).toBe("self");
    expect(resolveDisplayName(G, "Alice")).toBe("self");
  });

  it("无匹配 → null", () => {
    const G = buildTestGraph();
    expect(resolveDisplayName(G, "不存在的人")).toBeNull();
  });
});
