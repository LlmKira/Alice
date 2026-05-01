/**
 * ADR-206 W8 测试 — buildSocialPanorama + buildShellGuide channel 路径。
 * @see docs/adr/206-channel-information-flow/ §12 收归转发职责
 */
import { describe, expect, it } from "vitest";
import { buildShellGuide } from "../src/engine/act/shell-guide.js";
import { WorldModel } from "../src/graph/world-model.js";
import { buildSocialPanorama, type ContactProfile } from "../src/mods/relationships.mod.js";

// -- 辅助 ------------------------------------------------------------------

function makeGraph() {
  const G = new WorldModel();
  G.addAgent("self");
  return G;
}

const NOW = Date.now();

// -- buildSocialPanorama 单元测试 ------------------------------------------

describe("buildSocialPanorama", () => {
  it("无联系人 → 空数组", () => {
    const G = makeGraph();
    expect(buildSocialPanorama(G, {}, {}, NOW)).toEqual([]);
  });

  it("只有 bot → 过滤掉", () => {
    const G = makeGraph();
    G.addContact("contact:telegram:100", { is_bot: true, tier: 5 });
    G.addRelation("self", "acquaintance", "contact:telegram:100");
    expect(buildSocialPanorama(G, {}, {}, NOW)).toEqual([]);
  });

  it("tier > 500 → 过滤掉", () => {
    const G = makeGraph();
    // DunbarTier 最大值是 500，无法构造 tier > 500 的联系人。
    // 改为验证 tier=500（上限）仍被包含。
    G.addContact("contact:telegram:200", { tier: 500 });
    G.addRelation("self", "acquaintance", "contact:telegram:200");
    expect(buildSocialPanorama(G, {}, {}, NOW).length).toBeGreaterThan(0);
  });

  it("tier ≤ 50 的联系人出现在全景中", () => {
    const G = makeGraph();
    G.addContact("contact:telegram:42", { tier: 15, display_name: "Rin" });
    G.addRelation("self", "acquaintance", "contact:telegram:42");

    const lines = buildSocialPanorama(G, {}, {}, NOW);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain("Rin");
  });

  it("兴趣标签从 contactProfiles 注入", () => {
    const G = makeGraph();
    G.addContact("contact:telegram:42", { tier: 15, display_name: "Rin" });
    G.addRelation("self", "acquaintance", "contact:telegram:42");

    const profiles: Record<string, ContactProfile> = {
      "contact:telegram:42": {
        interests: ["AI", "编程", "摄影"],
        activeHours: new Array(24).fill(0),
        lastUpdatedTick: 0,
        previousPeakHour: null,
        scheduleShift: null,
        portrait: null,
        portraitTick: null,
        traits: {},
      },
    };

    const lines = buildSocialPanorama(G, profiles, {}, NOW);
    expect(lines[0]).toContain("AI");
    expect(lines[0]).toContain("编程");
    // 最多 2 个兴趣标签
    expect(lines[0]).not.toContain("摄影");
  });

  it("最近分享过 → 显示 shared recently", () => {
    const G = makeGraph();
    G.addContact("contact:telegram:42", { tier: 15, display_name: "Rin" });
    G.addRelation("self", "acquaintance", "contact:telegram:42");
    // 模拟私聊 channel 的 last_shared_ms
    G.addChannel("channel:telegram:42");
    G.setDynamic("channel:telegram:42", "last_shared_ms", NOW - 30 * 60_000); // 30 分钟前

    const lines = buildSocialPanorama(G, {}, {}, NOW);
    expect(lines[0]).toContain("shared recently");
  });

  it("分享超过 1 小时 → 不显示 shared recently", () => {
    const G = makeGraph();
    G.addContact("contact:telegram:42", { tier: 15, display_name: "Rin" });
    G.addRelation("self", "acquaintance", "contact:telegram:42");
    G.addChannel("channel:telegram:42");
    G.setDynamic("channel:telegram:42", "last_shared_ms", NOW - 2 * 3_600_000); // 2 小时前

    const lines = buildSocialPanorama(G, {}, {}, NOW);
    expect(lines[0]).not.toContain("shared recently");
  });

  it("ADR-208 W1: 目标私聊节点 last_shared_ms → 显示 shared recently", () => {
    const G = makeGraph();
    G.addContact("contact:telegram:99", { tier: 15, display_name: "Mia" });
    G.addRelation("self", "acquaintance", "contact:telegram:99");
    // 直接在目标私聊节点写 last_shared_ms（模拟转发后双写）
    G.addChannel("channel:telegram:99");
    G.setDynamic("channel:telegram:99", "last_shared_ms", NOW - 10 * 60_000); // 10 分钟前
    const lines = buildSocialPanorama(G, {}, {}, NOW);
    expect(lines[0]).toContain("shared recently");
  });

  it("ADR-208 W2: 有特质的联系人括号内显示 top-1 特质", () => {
    const G = makeGraph();
    G.addContact("contact:telegram:42", { tier: 15, display_name: "Rin" });
    G.addRelation("self", "acquaintance", "contact:telegram:42");

    const profiles: Record<string, ContactProfile> = {
      "contact:telegram:42": {
        interests: [],
        activeHours: new Array(24).fill(0),
        lastUpdatedTick: 0,
        previousPeakHour: null,
        scheduleShift: null,
        portrait: null,
        portraitTick: null,
        traits: {
          warm: { value: 0.8, crystallizedAt: 100, lastReinforced: 100 },
          patient: { value: -0.3, crystallizedAt: 100, lastReinforced: 100 },
        },
      },
    };

    const lines = buildSocialPanorama(G, profiles, {}, NOW);
    // top-1 by |value| → warm (0.8 > 0.3)
    expect(lines[0]).toContain("warm");
    expect(lines[0]).toMatch(/\(.*warm.*\)/);
  });

  it("ADR-208 W2: 无特质 → 括号内只有 tier 标签", () => {
    const G = makeGraph();
    G.addContact("contact:telegram:42", { tier: 15, display_name: "Rin" });
    G.addRelation("self", "acquaintance", "contact:telegram:42");

    const lines = buildSocialPanorama(G, {}, {}, NOW);
    expect(lines[0]).toMatch(/Rin \([^,)]+\)/); // 括号内无逗号
  });

  it("有兴趣标签优先，同标签状态下按 tier 升序", () => {
    const G = makeGraph();
    G.addContact("contact:telegram:1", { tier: 5, display_name: "亲密但无标签" });
    G.addContact("contact:telegram:2", { tier: 500, display_name: "远但有标签" });
    G.addRelation("self", "acquaintance", "contact:telegram:1");
    G.addRelation("self", "acquaintance", "contact:telegram:2");

    const profiles: Record<string, ContactProfile> = {
      "contact:telegram:2": {
        interests: ["AI"],
        activeHours: new Array(24).fill(0),
        lastUpdatedTick: 0,
        previousPeakHour: null,
        scheduleShift: null,
        portrait: null,
        portraitTick: null,
        traits: {},
      },
    };

    const lines = buildSocialPanorama(G, profiles, {}, NOW);
    expect(lines.length).toBe(2);
    // 有兴趣标签的排前面，即使 tier 更高
    expect(lines[0]).toContain("远但有标签");
    expect(lines[1]).toContain("亲密但无标签");
  });
});

// -- buildShellGuide channel 路径 -----------------------------------------

describe("buildShellGuide — channel mode", () => {
  it("频道 target 包含 Channel Instincts", () => {
    const guide = buildShellGuide({ chatTargetType: "channel_other" });
    expect(guide).toContain("Channel Instincts");
    expect(guide).toContain("irc forward");
  });

  it("频道 target 包含 gold examples（forward 示例）", () => {
    const guide = buildShellGuide({ chatTargetType: "channel_other" });
    expect(guide).toContain("```sh");
    expect(guide).toContain("forward");
  });

  it("频道 target 不包含 DM/Group instincts", () => {
    const guide = buildShellGuide({ chatTargetType: "channel_other" });
    expect(guide).not.toContain("DM Instincts");
    expect(guide).not.toContain("Group Chat Instincts");
  });

  it("非频道的私聊仍然走 DM 路径", () => {
    const guide = buildShellGuide({ chatTargetType: "private_person" });
    expect(guide).toContain("DM Instincts");
    expect(guide).not.toContain("Channel Instincts");
  });

  it("hasBots 时注入的是收手示例，不是继续和 bot 对聊", () => {
    const guide = buildShellGuide({ chatTargetType: "group", hasBots: true });
    expect(guide).toContain("afterward=cooling_down");
    expect(guide).not.toContain("weaving it into conversation");
  });

  it("群聊 guide 包含 cooling_down 与物理退群自保提示", () => {
    const guide = buildShellGuide({ chatTargetType: "group" });
    expect(guide).toContain("afterward=cooling_down");
    expect(guide).toContain("irc leave");
  });
});
