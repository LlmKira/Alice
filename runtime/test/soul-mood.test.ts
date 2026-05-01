/**
 * ADR-174: Persona Facet 测试 — selectFacet + facet guidance 注入。
 *
 * 验证：
 * - selectFacet 根据压力上下文选择合理的 facet
 * - selectFacetDeterministic 在给定上下文下返回确定结果
 * - getFacetWhisper 正确区分 dm/group
 * - getFacetTags 返回标签
 * - soul.mod contribute() 注入 facet guidance
 *
 * @see docs/adr/174-persona-facets.md
 */
import { describe, expect, it } from "vitest";
import type { ModContext } from "../src/core/types.js";
import { WorldModel } from "../src/graph/world-model.js";
import { soulMod } from "../src/mods/soul.mod.js";
import {
  type FacetContext,
  getFacet,
  getFacetTags,
  getFacetWhisper,
  type NormalizedPressures,
  selectFacet,
  selectFacetDeterministic,
} from "../src/voices/palette.js";

// -- 测试工具 ------------------------------------------------------------------

/** 构造归一化压力——测试值已在 [0,1) 内。 */
function makeNormalized(overrides: Partial<NormalizedPressures> = {}): NormalizedPressures {
  return { p1: 0, p2: 0, p3: 0, p4: 0, p5: 0, p6: 0, api: 0, ...overrides };
}

function makeFacetCtx(overrides: Partial<FacetContext> = {}): FacetContext {
  return {
    normalized: makeNormalized(),
    isGroup: false,
    tier: null,
    ...overrides,
  };
}

// -- selectFacetDeterministic 测试 --------------------------------------------

describe("selectFacetDeterministic — 归一化压力驱动的 facet 选择", () => {
  it("diligence + 高 p1 → diligence:backlog", () => {
    const ctx = makeFacetCtx({ normalized: makeNormalized({ p1: 0.9, api: 0.3 }) });
    const facet = selectFacetDeterministic("diligence", ctx);
    expect(facet.id).toBe("diligence:backlog");
    expect(facet.voice).toBe("diligence");
  });

  it("diligence + 高 p5 低 p1 → diligence:engaged", () => {
    const ctx = makeFacetCtx({ normalized: makeNormalized({ p5: 0.9, p1: 0.05 }) });
    const facet = selectFacetDeterministic("diligence", ctx);
    expect(facet.id).toBe("diligence:engaged");
  });

  it("diligence + 高 p1 但线程不乱 → diligence:backlog", () => {
    const ctx = makeFacetCtx({ normalized: makeNormalized({ p1: 0.9, p4: 0.1 }) });
    const facet = selectFacetDeterministic("diligence", ctx);
    expect(facet.id).toBe("diligence:backlog");
  });

  it("diligence + 高 p1 和高 p4 → diligence:drained", () => {
    const ctx = makeFacetCtx({ normalized: makeNormalized({ p1: 0.9, p4: 0.9 }) });
    const facet = selectFacetDeterministic("diligence", ctx);
    expect(facet.id).toBe("diligence:drained");
  });

  it("curiosity + 高 p6 → curiosity:technical", () => {
    const ctx = makeFacetCtx({ normalized: makeNormalized({ p6: 0.9, p4: 0.7 }) });
    const facet = selectFacetDeterministic("curiosity", ctx);
    expect(facet.id).toBe("curiosity:technical");
  });

  it("sociability + 高 p3 → sociability:missing", () => {
    const ctx = makeFacetCtx({ normalized: makeNormalized({ p3: 0.9 }) });
    const facet = selectFacetDeterministic("sociability", ctx);
    expect(facet.id).toBe("sociability:missing");
  });

  it("sociability + 亲密 tier + 活跃对话 → sociability:warm", () => {
    const ctx = makeFacetCtx({
      normalized: makeNormalized({ p5: 0.8, p3: 0.1 }),
      tier: 15,
    });
    const facet = selectFacetDeterministic("sociability", ctx);
    expect(facet.id).toBe("sociability:warm");
  });

  it("caution + 群聊 + 陌生 → caution:observing", () => {
    const ctx = makeFacetCtx({
      normalized: makeNormalized({ api: 0.1 }),
      isGroup: true,
      tier: 200,
    });
    const facet = selectFacetDeterministic("caution", ctx);
    expect(facet.id).toBe("caution:observing");
  });

  it("caution + 低 api + 低压力 → caution:calm", () => {
    const ctx = makeFacetCtx({
      normalized: makeNormalized({ api: 0.05, p1: 0.03, p3: 0.06, p5: 0.02 }),
    });
    const facet = selectFacetDeterministic("caution", ctx);
    expect(facet.id).toBe("caution:calm");
  });
});

// -- selectFacet 随机版本测试 --------------------------------------------------

describe("selectFacet — softmax 采样", () => {
  it("返回的 facet 属于请求的声部", () => {
    const ctx = makeFacetCtx({ normalized: makeNormalized({ p1: 0.7, api: 0.5 }) });
    for (let i = 0; i < 20; i++) {
      const facet = selectFacet("diligence", ctx);
      expect(facet.voice).toBe("diligence");
    }
  });

  it("所有四个声部都能选出 facet", () => {
    const ctx = makeFacetCtx({
      normalized: makeNormalized({ p1: 0.4, p3: 0.6, p5: 0.5, p6: 0.5, api: 0.3 }),
    });
    for (const voice of ["diligence", "curiosity", "sociability", "caution"] as const) {
      const facet = selectFacet(voice, ctx);
      expect(facet.voice).toBe(voice);
      expect(facet.id).toMatch(new RegExp(`^${voice}:`));
    }
  });
});

// -- getFacet / getFacetWhisper / getFacetTags ---------------------------------

describe("facet 查找工具函数", () => {
  it("getFacet 通过 ID 获取", () => {
    const facet = getFacet("diligence:backlog");
    expect(facet).toBeDefined();
    expect(facet?.voice).toBe("diligence");
    expect(facet?.guidance).toContain("piled up");
  });

  it("getFacet 无效 ID → undefined", () => {
    expect(getFacet("nonexistent:facet")).toBeUndefined();
  });

  it("getFacetWhisper 区分 dm/group", () => {
    const dm = getFacetWhisper("diligence:backlog", "diligence", false);
    const group = getFacetWhisper("diligence:backlog", "diligence", true);
    expect(dm).not.toBe(group);
    expect(dm.length).toBeGreaterThan(0);
    expect(group.length).toBeGreaterThan(0);
  });

  it("getFacetWhisper 无效 facetId → fallback 到 voice", () => {
    const result = getFacetWhisper(null, "curiosity", false);
    expect(result).toBe("curiosity");
  });

  it("getFacetTags 返回标签数组", () => {
    const tags = getFacetTags("diligence:backlog");
    expect(tags).toBeDefined();
    expect(tags?.length).toBeGreaterThan(0);
    expect(tags).toContain("engaged");
  });

  it("getFacetTags 无效 ID → undefined", () => {
    expect(getFacetTags(null)).toBeUndefined();
    expect(getFacetTags("nonexistent")).toBeUndefined();
  });
});

// -- soul.mod contribute 集成测试 -----------------------------------------------

describe("soul.mod contribute — facet guidance 注入", () => {
  // biome-ignore lint/style/noNonNullAssertion: test — contribute 已知存在
  const contribute = soulMod.contribute!;

  it("activeFacet 存在时注入 facet guidance（priority=90）", () => {
    const graph = new WorldModel();
    graph.tick = 100;
    const ctx = {
      graph,
      state: {
        activeVoice: "diligence" as const,
        activeFacet: "diligence:backlog",
        voiceLostSince: null,
      },
      tick: 100,
      nowMs: Date.now(),
      getModState: () => undefined,
      dispatch: () => undefined,
    };
    const items = contribute(ctx as unknown as ModContext);
    const guidance = items.find((i) => i.priority === 90 && i.bucket === "header");
    expect(guidance).toBeDefined();
  });

  it("activeFacet 为 null 时不注入 facet guidance", () => {
    const graph = new WorldModel();
    graph.tick = 100;
    const ctx = {
      graph,
      state: { activeVoice: "diligence" as const, activeFacet: null, voiceLostSince: null },
      tick: 100,
      nowMs: Date.now(),
      getModState: () => undefined,
      dispatch: () => undefined,
    };
    const items = contribute(ctx as unknown as ModContext);
    const guidance = items.filter((i) => i.priority === 90 && i.bucket === "header");
    expect(guidance).toHaveLength(0);
  });

  it("SOUL_CORE 始终注入（priority=100）", () => {
    const graph = new WorldModel();
    graph.tick = 100;
    const ctx = {
      graph,
      state: { activeVoice: null, activeFacet: null, voiceLostSince: null },
      tick: 100,
      nowMs: Date.now(),
      getModState: () => undefined,
      dispatch: () => undefined,
    };
    const items = contribute(ctx as unknown as ModContext);
    const soulCore = items.find((i) => i.priority === 100 && i.bucket === "header");
    expect(soulCore).toBeDefined();
  });

  it("Instincts 只投影媒体感知边界，不包含工具命令教学", () => {
    const graph = new WorldModel();
    graph.tick = 100;
    const ctx = {
      graph,
      state: { activeVoice: null, activeFacet: null, voiceLostSince: null },
      tick: 100,
      nowMs: Date.now(),
      getModState: () => undefined,
      dispatch: () => undefined,
    };
    const items = contribute(ctx as unknown as ModContext);
    const instincts = items.find((i) => i.priority === 80 && i.bucket === "header");
    const text = instincts?.lines.join("\n") ?? "";

    expect(text).toContain("You do not receive raw pixels or raw audio");
    expect(text).toContain("media descriptions, OCR text, labels, captions, and chat context");
    expect(text).not.toContain("album search");
    expect(text).not.toContain("album send");
    expect(text).not.toContain("irc whois");
    expect(text).not.toContain("man <topic>");
    expect(text).not.toContain("You can't see images");
    expect(text).not.toContain("only text and labels");
  });
});
