/**
 * M2 Wave 2 测试 — soul.mod 语气形式度（Tier 感知）。
 *
 * 理论基础：closeness 函数是 logistic sigmoid (Luce 1959, 选择公理)：
 *   f(tier) = 1 / (1 + exp(0.02 * (tier - 100)))
 *
 * tier 越低（亲密）→ closeness 越高（随意参数），tier 越高（疏远）→ closeness 越低（正式参数）。
 * 中心点 tier=100，斜率 0.02 使过渡平滑覆盖 Dunbar 层级。
 */
import { describe, expect, it } from "vitest";
import type { ModContext } from "../src/core/types.js";
import { WorldModel } from "../src/graph/world-model.js";
import { closeness, soulMod } from "../src/mods/soul.mod.js";

// -- closeness 纯函数测试 ----------------------------------------------------

describe("closeness — logistic sigmoid", () => {
  it("tier 5 (intimate) → high closeness ≈ 0.87 (casual/warm)", () => {
    expect(closeness(5)).toBeCloseTo(0.868, 2);
  });

  it("tier 50 (friend) → ≈ 0.73", () => {
    expect(closeness(50)).toBeCloseTo(0.731, 2);
  });

  it("tier 100 (midpoint) → 0.5", () => {
    expect(closeness(100)).toBeCloseTo(0.5, 4);
  });

  it("tier 150 (acquaintance) → ≈ 0.27 (formal)", () => {
    expect(closeness(150)).toBeCloseTo(0.269, 2);
  });

  it("tier 500 (known) → near 0 (very formal)", () => {
    expect(closeness(500)).toBeLessThan(0.001);
  });

  it("单调递减: tier↑ → closeness↓", () => {
    const tiers = [5, 15, 50, 100, 150, 500];
    for (let i = 1; i < tiers.length; i++) {
      expect(closeness(tiers[i])).toBeLessThan(closeness(tiers[i - 1]));
    }
  });

  it("值域 (0, 1)", () => {
    expect(closeness(0)).toBeLessThan(1);
    expect(closeness(0)).toBeGreaterThan(0);
    expect(closeness(10000)).toBeGreaterThan(0);
    expect(closeness(10000)).toBeLessThan(1);
  });
});

// -- contribute 语气注入测试 --------------------------------------------------

describe("soul.mod — contribute closeness guidance", () => {
  // biome-ignore lint/style/noNonNullAssertion: test — contribute 已知存在
  const contribute = soulMod.contribute!;

  function makeCtx(
    targetNodeId: string | null,
    tier: number,
    displayName: string | null = null,
    tick = 100,
  ) {
    const graph = new WorldModel();
    graph.tick = tick;
    if (targetNodeId) {
      const contactId = targetNodeId.startsWith("contact:")
        ? targetNodeId
        : targetNodeId.replace(/^channel:/, "contact:");
      const attrs: Record<string, unknown> = { tier };
      if (displayName) attrs.display_name = displayName;
      graph.addContact(contactId, attrs);
    }
    return {
      graph,
      state: { activeVoice: null },
      tick,
      getModState: (name: string) => {
        if (name === "relationships") return { targetNodeId };
        return undefined;
      },
      dispatch: () => undefined,
    };
  }

  // ADR-125: closenessGuidance 改为事实注入（"you talk often"）而非语气指令（"Tone: casual"）。
  // relationType 未设时不含名字——只有关系类型已知时才注入 "name: relation_type"。
  it("tier 5 → 'you talk often' 事实注入", () => {
    const ctx = makeCtx("contact:telegram:1001", 5, "Bob");
    const items = contribute(ctx as unknown as ModContext);
    const content = JSON.stringify(items);
    expect(content).toContain("you talk often");
    expect(content).not.toContain("Tone:");
  });

  it("tier 50 → 'you know each other' 事实注入", () => {
    const ctx = makeCtx("contact:telegram:1002", 50, "Carol");
    const items = contribute(ctx as unknown as ModContext);
    const content = JSON.stringify(items);
    expect(content).toContain("you know each other");
    expect(content).not.toContain("Tone:");
  });

  it("tier 150 → 'occasional contact' 事实注入", () => {
    const ctx = makeCtx("contact:telegram:1003", 150, "Dave");
    const items = contribute(ctx as unknown as ModContext);
    const content = JSON.stringify(items);
    expect(content).toContain("occasional contact");
    expect(content).not.toContain("Tone:");
  });

  it("tier 500 → 无关系事实注入（陌生人从信息缺失推断正式语气）", () => {
    const ctx = makeCtx("contact:telegram:1004", 500, "Eve");
    const items = contribute(ctx as unknown as ModContext);
    const content = JSON.stringify(items);
    // tier > 150: 不注入任何关系事实
    expect(content).not.toContain("closeness-guidance");
    expect(content).not.toContain("Tone:");
  });

  it("无目标 → 不注入语气指导", () => {
    const ctx = makeCtx(null, 50);
    const items = contribute(ctx as unknown as ModContext);
    const content = JSON.stringify(items);
    expect(content).not.toContain("Tone:");
    expect(content).not.toContain("closeness-guidance");
  });

  it("channel: 前缀目标正确解析为 contact:", () => {
    const graph = new WorldModel();
    graph.tick = 100;
    graph.addContact("contact:telegram:123", { tier: 5, display_name: "Test" });
    const ctx = {
      graph,
      state: { activeVoice: null },
      tick: 100,
      getModState: (name: string) => {
        if (name === "relationships") return { targetNodeId: "channel:telegram:123" };
        return undefined;
      },
      dispatch: () => undefined,
    };
    const items = contribute(ctx as unknown as ModContext);
    const content = JSON.stringify(items);
    // channel:telegram:123 → contact:telegram:123 解析成功 → 注入关系事实
    expect(content).toContain("you talk often");
    expect(content).not.toContain("Tone:");
  });
});
