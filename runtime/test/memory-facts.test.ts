/**
 * M3 Wave 3 测试 — 事实遗忘曲线（fact 图节点 + recall_fact + remember）。
 *
 * 迁移后：事实存储为 fact 图节点，通过 "knows" 边连接到 contact/agent。
 * ADR-46 F1: 遗忘曲线时间尺度修正（FACT_TIME_SCALE = 1440）。
 */
import { describe, expect, it } from "vitest";
import type { ModContext } from "../src/core/types.js";
import type { FactAttrs } from "../src/graph/entities.js";
import { WorldModel } from "../src/graph/world-model.js";
import {
  type ContactProfile,
  factRetrievabilityFromNode,
  getContactFacts,
  normalizeFactContent,
  relationshipsMod,
} from "../src/mods/relationships.mod.js";

// -- 测试辅助 -----------------------------------------------------------------

interface TestState {
  targetNodeId: string | null;
  contactProfiles: Record<string, ContactProfile>;
}

function makeCtx(stateOverride: Partial<TestState> = {}, tick = 100, nowMs?: number) {
  const graph = new WorldModel();
  graph.tick = tick;
  const state: TestState = {
    targetNodeId: stateOverride.targetNodeId ?? null,
    contactProfiles: stateOverride.contactProfiles ?? {},
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

/** 向图中直接添加 fact 事实节点（用于预填充测试数据）。 */
let _testFactCounter = 0;
function addFactToGraph(
  graph: WorldModel,
  contactId: string,
  content: string,
  opts: Partial<{
    fact_type: string;
    stability: number;
    last_access_ms: number;
    created_ms: number;
    reinforcement_count: number;
    importance: number;
  }> = {},
): string {
  const iid = `info_${contactId}_test_${_testFactCounter++}`;
  graph.addFact(iid, {
    content,
    fact_type: opts.fact_type ?? "general",
    importance: opts.importance ?? 0.5,
    stability: opts.stability ?? 1.0,
    last_access_ms: opts.last_access_ms ?? graph.tick * 60_000,
    volatility: 0,
    tracked: false,
    created_ms: opts.created_ms ?? graph.tick * 60_000,
    novelty: 1.0,
    reinforcement_count: opts.reinforcement_count ?? 1,
    source_contact: contactId,
  });
  // ADR-110: 双写墙钟时间戳
  if (opts.last_access_ms != null) {
    graph.setDynamic(iid, "last_access_ms", opts.last_access_ms);
  }
  graph.addRelation(contactId, "knows", iid);
  return iid;
}

// biome-ignore lint/style/noNonNullAssertion: test — instructions 已知存在
const instructions = relationshipsMod.instructions!;

// -- factRetrievabilityFromNode 纯函数 ----------------------------------------

describe("factRetrievabilityFromNode — 遗忘曲线", () => {
  // ADR-110: nowMs 参数为墙钟毫秒。last_access (tick) 回退为 last_access * 60_000 ms。
  // gapS = (nowMs - lastAccessMs) / 1000, scaledGap = gapS / FACT_TIME_SCALE(86400)

  it("刚创建的事实 R = 1.0", () => {
    const attrs = {
      entity_type: "fact",
      importance: 0.5,
      stability: 1.0,
      last_access_ms: 100 * 60_000,
      volatility: 0,
      tracked: false,
      created_ms: 100 * 60_000,
      novelty: 1.0,
    } as FactAttrs;
    // nowMs = lastAccessMs → gap = 0 → R = 1.0
    expect(factRetrievabilityFromNode(attrs, 100 * 60_000)).toBeCloseTo(1.0, 4);
  });

  it("经过 777600 秒 (stability=1) → R ≈ 0.707", () => {
    // ADR-110: FACT_TIME_SCALE=86400（秒），gapS=777600, scaledGap=777600/86400=9
    // R = (1 + 9 / (9 * 1))^(-0.5) = 2^(-0.5) = 1/√2 ≈ 0.707
    // last_access=0 → lastAccessMs=0, nowMs=777_600_000 → gapS=777600
    const attrs = {
      entity_type: "fact",
      importance: 0.5,
      stability: 1.0,
      last_access_ms: 0,
      volatility: 0,
      tracked: false,
      created_ms: 0,
      novelty: 1.0,
    } as FactAttrs;
    expect(factRetrievabilityFromNode(attrs, 777_600_000)).toBeCloseTo(1 / Math.sqrt(2), 3);
  });

  it("经过 6220800 秒 (stability=1) → R ≈ 0.316", () => {
    // ADR-110: FACT_TIME_SCALE=86400（秒），gapS=6220800, scaledGap=6220800/86400=72
    // R = (1 + 72 / 9)^(-0.5) = 9^(-0.5) = 1/3
    // last_access=0 → lastAccessMs=0, nowMs=6_220_800_000 → gapS=6220800
    const attrs = {
      entity_type: "fact",
      importance: 0.5,
      stability: 1.0,
      last_access_ms: 0,
      volatility: 0,
      tracked: false,
      created_ms: 0,
      novelty: 1.0,
    } as FactAttrs;
    expect(factRetrievabilityFromNode(attrs, 6_220_800_000)).toBeCloseTo(1 / 3, 3);
  });

  it("高 stability 延缓遗忘", () => {
    const attrsLow = { stability: 1.0, last_access_ms: 0 } as FactAttrs;
    const attrsHigh = { stability: 3.0, last_access_ms: 0 } as FactAttrs;
    // last_access=0 → lastAccessMs=0, nowMs=50_000_000 → gapS=50000
    const nowMs = 50_000_000;
    expect(factRetrievabilityFromNode(attrsHigh, nowMs)).toBeGreaterThan(
      factRetrievabilityFromNode(attrsLow, nowMs),
    );
  });

  it("R 单调递减（随时间增加）", () => {
    const attrs = { stability: 1.0, last_access_ms: 0 } as FactAttrs;
    // last_access=0 → lastAccessMs=0; 递增 nowMs 验证 R 单调递减
    const r0 = factRetrievabilityFromNode(attrs, 0);
    const r10 = factRetrievabilityFromNode(attrs, 10_000_000);
    const r50 = factRetrievabilityFromNode(attrs, 50_000_000);
    const r200 = factRetrievabilityFromNode(attrs, 200_000_000);
    expect(r0).toBeGreaterThan(r10);
    expect(r10).toBeGreaterThan(r50);
    expect(r50).toBeGreaterThan(r200);
  });
});

// -- self_note ----------------------------------------------------------------

describe("relationships.mod — note (graph-based)", () => {
  it("创建新的 fact 图节点", () => {
    const ctx = makeCtx({}, 50);
    // remember 需要 contactId 能在图上找到邻居（addRelation 不要求节点存在）
    const result = instructions.note.impl(ctx as unknown as ModContext, {
      contactId: "contact:telegram:1",
      fact: "Likes coffee",
      type: "preference",
    }) as { success: boolean; factCount: number };

    expect(result.success).toBe(true);
    expect(result.factCount).toBe(1);
    const facts = getContactFacts(ctx.graph, "contact:telegram:1");
    expect(facts).toHaveLength(1);
    expect(facts[0].attrs.content).toBe("Likes coffee");
    expect(facts[0].attrs.fact_type).toBe("preference");
    // 连续稳定性频谱：preference 的初始 S₀=20（在线社交校准）
    expect(facts[0].attrs.stability).toBe(20);
    expect(facts[0].attrs.created_ms).toBe(50 * 60_000);
  });

  it("去重：相同内容只更新 last_access", () => {
    const ctx = makeCtx({}, 50);
    instructions.note.impl(ctx as unknown as ModContext, {
      contactId: "contact:telegram:1",
      fact: "Likes coffee",
      type: "preference",
    });
    const result = instructions.note.impl(ctx as unknown as ModContext, {
      contactId: "contact:telegram:1",
      fact: "Likes coffee",
      type: "preference",
    }) as { isDuplicate: boolean; factCount: number };

    expect(result.isDuplicate).toBe(true);
    expect(result.factCount).toBe(1);
  });

  it("空字符串由 Zod schema 拒绝（dispatcher 层校验）", () => {
    // 空检查已从 impl 移至 Zod schema（z.string().trim().min(1)）。
    // 直接调用 impl 不经过 dispatcher，故在此验证 schema 层拒绝。
    // biome-ignore lint/style/noNonNullAssertion: test — schema 已知存在
    const schema = instructions.note.params.fact.schema!;
    // 空字符串
    expect(schema.safeParse("").success).toBe(false);
    // 纯空白
    expect(schema.safeParse("  ").success).toBe(false);
    // 正常内容
    expect(schema.safeParse("likes cats").success).toBe(true);
  });

  it("超容量时淘汰 R 最低的事实", () => {
    // ADR-110: nowMs 必须 > Date.now() 使 impl 内 Date.now() 写入的 last_access_ms
    // 相对于 ctx.nowMs 有可区分的 gap。每条事实间隔 60s nowMs 使 R 有序递减。
    const baseNowMs = Date.now() + 600_000; // 未来 10 分钟基准
    const ctx = makeCtx({}, 1000, baseNowMs);
    // 插入 21 条事实（普通联系人上限 20）
    for (let i = 0; i < 21; i++) {
      ctx.tick = 1000 + i;
      ctx.graph.tick = ctx.tick;
      ctx.nowMs = baseNowMs + i * 60_000; // 每条间隔 60 秒
      instructions.note.impl(ctx as unknown as ModContext, {
        contactId: "contact:telegram:1",
        fact: `fact_${i}`,
        type: "general",
      });
    }

    const facts = getContactFacts(ctx.graph, "contact:telegram:1");
    expect(facts).toHaveLength(20);
    // fact_0 应该被淘汰（last_access_ms 最早 → R 最低）
    const contents = facts.map((f) => f.attrs.content);
    expect(contents).not.toContain("fact_0");
    expect(contents).toContain("fact_20");
  });

  it("self 联系人容量 50", () => {
    const baseNowMs = Date.now() + 600_000;
    const ctx = makeCtx({}, 0, baseNowMs);
    // 确保 self agent 节点存在
    ctx.graph.addAgent("self", {});
    for (let i = 0; i < 51; i++) {
      ctx.tick = i;
      ctx.graph.tick = i;
      ctx.nowMs = baseNowMs + i * 60_000;
      instructions.note.impl(ctx as unknown as ModContext, {
        contactId: "self",
        fact: `self_fact_${i}`,
        type: "observation",
      });
    }
    const facts = getContactFacts(ctx.graph, "self");
    expect(facts).toHaveLength(50);
  });
});

// -- recall_fact（巩固机制）----------------------------------------------------

describe("relationships.mod — recall_fact (graph-based)", () => {
  it("巩固: stability × 1.5", () => {
    const ctx = makeCtx({}, 50);
    addFactToGraph(ctx.graph, "contact:telegram:1", "Likes coffee", {
      fact_type: "preference",
      stability: 1.0,
      last_access_ms: 0,
      created_ms: 0,
    });

    const result = instructions.recall_fact.impl(ctx as unknown as ModContext, {
      contactId: "contact:telegram:1",
      fact: "Likes coffee",
    }) as { success: boolean; oldStability: number; newStability: number };

    expect(result.success).toBe(true);
    expect(result.oldStability).toBe(1.0);
    expect(result.newStability).toBeCloseTo(1.5, 4);
    const facts = getContactFacts(ctx.graph, "contact:telegram:1");
    expect(facts[0].attrs.last_access_ms).toBe(50 * 60_000);
  });

  it("多次巩固累积", () => {
    const ctx = makeCtx({}, 100);
    addFactToGraph(ctx.graph, "contact:telegram:1", "test", {
      stability: 1.0,
      last_access_ms: 0,
      created_ms: 0,
    });

    // 3 次 recall_fact: 1.0 → 1.5 → 2.25 → 3.375（ADR-46 F1b: factor=1.5）
    for (let i = 0; i < 3; i++) {
      instructions.recall_fact.impl(ctx as unknown as ModContext, {
        contactId: "contact:telegram:1",
        fact: "test",
      });
    }

    const facts = getContactFacts(ctx.graph, "contact:telegram:1");
    expect(facts[0].attrs.stability).toBeCloseTo(3.375, 3);
  });

  it("不存在的事实返回错误", () => {
    const ctx = makeCtx({}, 50);
    addFactToGraph(ctx.graph, "contact:telegram:1", "exists", {
      stability: 1.0,
      last_access_ms: 0,
      created_ms: 0,
    });

    const result = instructions.recall_fact.impl(ctx as unknown as ModContext, {
      contactId: "contact:telegram:1",
      fact: "does not exist",
    }) as { success: boolean };
    expect(result.success).toBe(false);
  });

  it("不存在的联系人返回错误", () => {
    const ctx = makeCtx({}, 50);
    const result = instructions.recall_fact.impl(ctx as unknown as ModContext, {
      contactId: "contact:nonexistent",
      fact: "test",
    }) as { success: boolean };
    expect(result.success).toBe(false);
  });
});

// -- contribute 遗忘过滤 -----------------------------------------------------

describe("relationships.mod — contribute with memorized facts (graph-based)", () => {
  it("R >= 0.2 的事实被注入", () => {
    // ADR-110: nowMs 为墙钟毫秒。Fresh fact last_access_ms ≈ nowMs → gap ≈ 0 → R ≈ 1.0
    const nowMs = 100_000;
    const ctx = makeCtx({ targetNodeId: "contact:telegram:1" }, 100, nowMs);
    ctx.graph.addContact("contact:telegram:1", { tier: 50, display_name: "Alice" });
    addFactToGraph(ctx.graph, "contact:telegram:1", "Fresh fact", {
      fact_type: "observation",
      stability: 1.0,
      last_access_ms: nowMs - 10_000, // 10 秒前
      created_ms: 90,
    });

    // biome-ignore lint/style/noNonNullAssertion: test — contribute 已知存在
    const items = relationshipsMod.contribute!(ctx as unknown as ModContext);
    const content = JSON.stringify(items);
    expect(content).toContain("Fresh fact");
    // P1-B (ADR-55): R 值不再显示给 LLM
    expect(content).not.toContain("R=");
  });

  it("R < 0.2 的事实被过滤", () => {
    // ADR-110: FACT_TIME_SCALE=86400（秒），stability=0.1
    // gapS=2_000_000, scaledGap=2000000/86400≈23.1, R=(1+23.1/0.9)^(-0.5)≈0.19 < 0.2
    const nowMs = 2_000_000_000; // ~23 天 ms
    const ctx = makeCtx({ targetNodeId: "contact:telegram:1" }, 100, nowMs);
    ctx.graph.addContact("contact:telegram:1", { tier: 50, display_name: "Bob" });
    addFactToGraph(ctx.graph, "contact:telegram:1", "Old forgotten fact", {
      fact_type: "observation",
      stability: 0.1,
      last_access_ms: 0,
      created_ms: 0,
    });

    // biome-ignore lint/style/noNonNullAssertion: test
    const items = relationshipsMod.contribute!(ctx as unknown as ModContext);
    const content = JSON.stringify(items);
    expect(content).not.toContain("Old forgotten fact");
    expect(content).toContain("getting fuzzy");
  });

  it("self memorized facts 也被 R 过滤", () => {
    // nowMs=1_000_000_000（~11.6 天）
    // Fresh: last_access_ms=nowMs-1000（1 秒前）→ R ≈ 1.0
    // Ancient: last_access_ms=0, stability=0.05 → scaledGap≈11.57, R=(1+11.57/0.45)^(-0.5)≈0.19 < 0.2
    const nowMs = 1_000_000_000;
    const ctx = makeCtx({}, 100, nowMs);
    ctx.graph.addAgent("self", {});
    addFactToGraph(ctx.graph, "self", "I like music", {
      fact_type: "interest",
      stability: 1.0,
      last_access_ms: nowMs - 1_000, // 1 秒前
      created_ms: 95,
    });
    addFactToGraph(ctx.graph, "self", "Ancient memory", {
      fact_type: "observation", // episodic — 测试 R 过滤（semantic facts 永不遗忘）
      stability: 0.05,
      last_access_ms: 0,
      created_ms: 0,
    });

    // biome-ignore lint/style/noNonNullAssertion: test
    const items = relationshipsMod.contribute!(ctx as unknown as ModContext);
    const content = JSON.stringify(items);
    expect(content).toContain("I like music");
    expect(content).not.toContain("Ancient memory");
  });
});

// 更精确的 contribute 测试
describe("relationships.mod — contribute R threshold boundary (graph-based)", () => {
  it("边界：R 刚好 >= 0.2 被保留", () => {
    // ADR-110: gapS=288000, scaledGap=288000/86400=3.333, R=(1+3.333/9)^(-0.5)≈0.854 > 0.2 ✓
    // nowMs=288_000_000, last_access_ms=0
    const nowMs = 288_000_000;
    const ctx = makeCtx({ targetNodeId: "contact:telegram:1" }, 100, nowMs);
    ctx.graph.addContact("contact:telegram:1", { tier: 50, display_name: "Test" });
    addFactToGraph(ctx.graph, "contact:telegram:1", "Recent-ish fact", {
      fact_type: "observation", // episodic — 测试 R 阈值
      stability: 1.0,
      last_access_ms: 0,
      created_ms: 0,
    });

    // biome-ignore lint/style/noNonNullAssertion: test
    const items = relationshipsMod.contribute!(ctx as unknown as ModContext);
    const content = JSON.stringify(items);
    expect(content).toContain("Recent-ish fact");
  });

  it("边界：R 刚好 < 0.2 被过滤", () => {
    // ADR-110: gapS=19440000, scaledGap=19440000/86400=225, R=(1+225/9)^(-0.5)=(26)^(-0.5)≈0.196 < 0.2
    // nowMs=19_440_000_000, last_access_ms=0
    const nowMs = 19_440_000_000;
    const ctx = makeCtx({ targetNodeId: "contact:telegram:1" }, 100, nowMs);
    ctx.graph.addContact("contact:telegram:1", { tier: 50, display_name: "Test" });
    addFactToGraph(ctx.graph, "contact:telegram:1", "Faded fact", {
      fact_type: "observation", // episodic — 测试 R < 0.2 过滤
      stability: 1.0,
      last_access_ms: 0,
      created_ms: 0,
    });

    // biome-ignore lint/style/noNonNullAssertion: test
    const items = relationshipsMod.contribute!(ctx as unknown as ModContext);
    const content = JSON.stringify(items);
    expect(content).not.toContain("Faded fact");
    expect(content).toContain("getting fuzzy");
  });
});

// -- edge cases ---------------------------------------------------------------

describe("factRetrievabilityFromNode — edge cases", () => {
  it("lastAccessMs > nowMs（时钟漂移）→ R = 1.0", () => {
    const attrs = { stability: 1.0, last_access_ms: 50 } as FactAttrs;
    // last_access_ms=50, nowMs=40 → gap=(40-50)/1000<0 → max(0)=0 → R=1.0
    expect(factRetrievabilityFromNode(attrs, 40)).toBeCloseTo(1.0, 4);
  });
});

// -- ADR-47 G6: normalizeFactContent + 去重强化 ---------------------------------

describe("normalizeFactContent — 归一化", () => {
  it("大小写归一化", () => {
    expect(normalizeFactContent("I Like Coffee")).toBe("i like coffee");
  });

  it("trim 首尾空白", () => {
    expect(normalizeFactContent("  hello world  ")).toBe("hello world");
  });

  it("collapse 多空格/换行为单空格", () => {
    expect(normalizeFactContent("hello   world\n\tfoo")).toBe("hello world foo");
  });

  it("组合：大小写 + 空白", () => {
    expect(normalizeFactContent("  I   LIKE  Coffee  ")).toBe("i like coffee");
  });
});

describe("remember — G6 归一化去重 (graph-based)", () => {
  it("大小写不同视为重复", () => {
    const ctx = makeCtx({}, 50);
    instructions.note.impl(ctx as unknown as ModContext, {
      contactId: "contact:telegram:1",
      fact: "Likes coffee",
      type: "preference",
    });
    const result = instructions.note.impl(ctx as unknown as ModContext, {
      contactId: "contact:telegram:1",
      fact: "likes coffee",
      type: "preference",
    }) as { isDuplicate: boolean; reinforced: boolean; factCount: number };

    expect(result.isDuplicate).toBe(true);
    expect(result.reinforced).toBe(true);
    expect(result.factCount).toBe(1);
  });

  it("多空格/换行不同视为重复", () => {
    const ctx = makeCtx({}, 50);
    instructions.note.impl(ctx as unknown as ModContext, {
      contactId: "contact:telegram:1",
      fact: "likes tea and coffee",
      type: "preference",
    });
    const result = instructions.note.impl(ctx as unknown as ModContext, {
      contactId: "contact:telegram:1",
      fact: "likes  tea   and  coffee",
      type: "preference",
    }) as { isDuplicate: boolean; factCount: number };

    expect(result.isDuplicate).toBe(true);
    expect(result.factCount).toBe(1);
  });

  it("去重时 reinforcement_count 递增", () => {
    const ctx = makeCtx({}, 50);
    instructions.note.impl(ctx as unknown as ModContext, {
      contactId: "contact:telegram:1",
      fact: "Likes coffee",
      type: "preference",
    });
    let facts = getContactFacts(ctx.graph, "contact:telegram:1");
    expect(facts[0].attrs.reinforcement_count).toBe(1);

    instructions.note.impl(ctx as unknown as ModContext, {
      contactId: "contact:telegram:1",
      fact: "likes coffee",
      type: "preference",
    });
    facts = getContactFacts(ctx.graph, "contact:telegram:1");
    expect(facts[0].attrs.reinforcement_count).toBe(2);

    instructions.note.impl(ctx as unknown as ModContext, {
      contactId: "contact:telegram:1",
      fact: "LIKES COFFEE",
      type: "preference",
    });
    facts = getContactFacts(ctx.graph, "contact:telegram:1");
    expect(facts[0].attrs.reinforcement_count).toBe(3);
  });

  it("去重时 stability 乘法强化（reinforcement）", () => {
    const ctx = makeCtx({}, 50);
    addFactToGraph(ctx.graph, "contact:telegram:1", "Likes coffee", {
      fact_type: "preference",
      stability: 0.5,
      last_access_ms: 0,
      created_ms: 0,
    });
    instructions.note.impl(ctx as unknown as ModContext, {
      contactId: "contact:telegram:1",
      fact: "likes coffee",
      type: "preference",
    });
    // 连续稳定性频谱：stability × 1.2 = 0.5 × 1.2 = 0.6
    const facts = getContactFacts(ctx.graph, "contact:telegram:1");
    expect(facts[0].attrs.stability).toBeCloseTo(0.6, 10);
  });

  it("去重时 stability 累积增长（已有高 stability）", () => {
    const ctx = makeCtx({}, 50);
    addFactToGraph(ctx.graph, "contact:telegram:1", "Likes coffee", {
      fact_type: "preference",
      stability: 3.0,
      last_access_ms: 0,
      created_ms: 0,
    });
    instructions.note.impl(ctx as unknown as ModContext, {
      contactId: "contact:telegram:1",
      fact: "likes coffee",
      type: "preference",
    });
    // 连续稳定性频谱：stability × 1.2 = 3.0 × 1.2 = 3.6
    const facts = getContactFacts(ctx.graph, "contact:telegram:1");
    expect(facts[0].attrs.stability).toBeCloseTo(3.6, 10);
  });
});

// -- update_fact (ADR-47 G2) -------------------------------------------------

describe("relationships.mod — update_fact (graph-based)", () => {
  it("修改事实内容 — 保留 stability", () => {
    const ctx = makeCtx({}, 100);
    addFactToGraph(ctx.graph, "contact:telegram:1", "Likes coffee", {
      fact_type: "preference",
      stability: 2.5,
      last_access_ms: 20,
      created_ms: 10,
      reinforcement_count: 3,
    });

    const result = instructions.update_fact.impl(ctx as unknown as ModContext, {
      contactId: "contact:telegram:1",
      oldContent: "Likes coffee",
      newContent: "Likes tea",
    }) as { success: boolean; contactId: string; factCount: number };

    expect(result.success).toBe(true);
    expect(result.factCount).toBe(1);
    const facts = getContactFacts(ctx.graph, "contact:telegram:1");
    expect(facts[0].attrs.content).toBe("Likes tea");
    expect(facts[0].attrs.stability).toBe(2.5);
    expect(facts[0].attrs.created_ms).toBe(10);
  });

  it("修改事实内容 — last_access 更新", () => {
    const ctx = makeCtx({}, 200);
    addFactToGraph(ctx.graph, "contact:telegram:1", "Likes coffee", {
      fact_type: "preference",
      stability: 1.0,
      last_access_ms: 20,
      created_ms: 10,
    });

    instructions.update_fact.impl(ctx as unknown as ModContext, {
      contactId: "contact:telegram:1",
      oldContent: "Likes coffee",
      newContent: "Likes tea",
    });

    const facts = getContactFacts(ctx.graph, "contact:telegram:1");
    expect(facts[0].attrs.last_access_ms).toBe(200 * 60_000);
  });

  it("修改为已存在的事实 — 合并", () => {
    const ctx = makeCtx({}, 100);
    addFactToGraph(ctx.graph, "contact:telegram:1", "Likes coffee", {
      fact_type: "preference",
      stability: 3.0,
      last_access_ms: 20,
      created_ms: 10,
      reinforcement_count: 2,
    });
    addFactToGraph(ctx.graph, "contact:telegram:1", "Likes tea", {
      fact_type: "preference",
      stability: 1.5,
      last_access_ms: 15,
      created_ms: 5,
      reinforcement_count: 1,
    });

    const result = instructions.update_fact.impl(ctx as unknown as ModContext, {
      contactId: "contact:telegram:1",
      oldContent: "Likes coffee",
      newContent: "Likes tea",
    }) as { success: boolean; merged: boolean; factCount: number };

    expect(result.success).toBe(true);
    expect(result.merged).toBe(true);
    expect(result.factCount).toBe(1);
    // 合并后：stability = max(1.5, 3.0) = 3.0, rc = 1 + 2 = 3
    const facts = getContactFacts(ctx.graph, "contact:telegram:1");
    expect(facts[0].attrs.stability).toBe(3.0);
    expect(facts[0].attrs.reinforcement_count).toBe(3);
    expect(facts[0].attrs.last_access_ms).toBe(100 * 60_000);
  });

  it("修改不存在的事实 — 返回错误", () => {
    const ctx = makeCtx({}, 50);
    addFactToGraph(ctx.graph, "contact:telegram:1", "Likes coffee", {
      stability: 1.0,
      last_access_ms: 20,
      created_ms: 10,
    });

    const result = instructions.update_fact.impl(ctx as unknown as ModContext, {
      contactId: "contact:telegram:1",
      oldContent: "Does not exist",
      newContent: "New content",
    }) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe("fact not found");
  });

  it("修改空内容 — Zod schema 拒绝（dispatcher 层校验）", () => {
    // newContent 的 z.string().trim().min(1) 在 dispatcher 层拒绝空/纯空白输入。
    // impl 不再包含手动空检查——Zod 覆盖。
    const schema = instructions.update_fact.params.newContent.schema;
    expect(schema).toBeDefined();
    const parsed = schema?.safeParse("  ");
    expect(parsed.success).toBe(false);
  });

  it("无事实的联系人 — 返回错误", () => {
    const ctx = makeCtx({}, 50);

    const result = instructions.update_fact.impl(ctx as unknown as ModContext, {
      contactId: "contact:telegram:1",
      oldContent: "anything",
      newContent: "new",
    }) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe("no facts for contact");
  });

  it("归一化匹配旧内容（大小写不敏感）", () => {
    const ctx = makeCtx({}, 50);
    addFactToGraph(ctx.graph, "contact:telegram:1", "Likes Coffee", {
      fact_type: "preference",
      stability: 1.0,
      last_access_ms: 20,
      created_ms: 10,
    });

    const result = instructions.update_fact.impl(ctx as unknown as ModContext, {
      contactId: "contact:telegram:1",
      oldContent: "likes coffee",
      newContent: "Prefers tea",
    }) as { success: boolean };

    expect(result.success).toBe(true);
    const facts = getContactFacts(ctx.graph, "contact:telegram:1");
    expect(facts[0].attrs.content).toBe("Prefers tea");
  });
});

// -- delete_fact (ADR-47 G2) -------------------------------------------------

describe("relationships.mod — delete_fact (graph-based)", () => {
  it("删除事实 — 正确删除", () => {
    const ctx = makeCtx({}, 50);
    addFactToGraph(ctx.graph, "contact:telegram:1", "Likes coffee", {
      fact_type: "preference",
      stability: 1.0,
      last_access_ms: 20,
      created_ms: 10,
    });
    addFactToGraph(ctx.graph, "contact:telegram:1", "Lives in Tokyo", {
      stability: 1.0,
      last_access_ms: 25,
      created_ms: 15,
    });

    const result = instructions.delete_fact.impl(ctx as unknown as ModContext, {
      contactId: "contact:telegram:1",
      content: "Likes coffee",
    }) as { success: boolean; deleted: string; factCount: number };

    expect(result.success).toBe(true);
    expect(result.deleted).toBe("Likes coffee");
    expect(result.factCount).toBe(1);
    const facts = getContactFacts(ctx.graph, "contact:telegram:1");
    expect(facts[0].attrs.content).toBe("Lives in Tokyo");
  });

  it("删除不存在的事实 — 返回错误", () => {
    const ctx = makeCtx({}, 50);
    addFactToGraph(ctx.graph, "contact:telegram:1", "Likes coffee", {
      fact_type: "preference",
      stability: 1.0,
      last_access_ms: 20,
      created_ms: 10,
    });

    const result = instructions.delete_fact.impl(ctx as unknown as ModContext, {
      contactId: "contact:telegram:1",
      content: "Does not exist",
    }) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe("fact not found");
  });

  it("删除后 factCount 减少", () => {
    const ctx = makeCtx({}, 50);
    addFactToGraph(ctx.graph, "contact:telegram:1", "Fact 1", { stability: 1.0 });
    addFactToGraph(ctx.graph, "contact:telegram:1", "Fact 2", { stability: 1.0 });
    addFactToGraph(ctx.graph, "contact:telegram:1", "Fact 3", { stability: 1.0 });

    const r1 = instructions.delete_fact.impl(ctx as unknown as ModContext, {
      contactId: "contact:telegram:1",
      content: "Fact 2",
    }) as { factCount: number };
    expect(r1.factCount).toBe(2);

    const r2 = instructions.delete_fact.impl(ctx as unknown as ModContext, {
      contactId: "contact:telegram:1",
      content: "Fact 1",
    }) as { factCount: number };
    expect(r2.factCount).toBe(1);
  });

  it("归一化匹配删除（大小写不敏感）", () => {
    const ctx = makeCtx({}, 50);
    addFactToGraph(ctx.graph, "contact:telegram:1", "Likes Coffee", {
      fact_type: "preference",
      stability: 1.0,
      last_access_ms: 20,
      created_ms: 10,
    });

    const result = instructions.delete_fact.impl(ctx as unknown as ModContext, {
      contactId: "contact:telegram:1",
      content: "likes coffee",
    }) as { success: boolean; deleted: string };

    expect(result.success).toBe(true);
    expect(result.deleted).toBe("Likes Coffee");
    const facts = getContactFacts(ctx.graph, "contact:telegram:1");
    expect(facts).toHaveLength(0);
  });

  it("无事实的联系人 — 返回错误", () => {
    const ctx = makeCtx({}, 50);

    const result = instructions.delete_fact.impl(ctx as unknown as ModContext, {
      contactId: "contact:telegram:1",
      content: "anything",
    }) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe("no facts for contact");
  });
});
