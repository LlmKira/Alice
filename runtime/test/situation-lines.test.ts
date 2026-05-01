/**
 * situation-lines 单元测试——验证压力语义化的自然语言输出。
 */
import { describe, expect, it } from "vitest";
import { WorldModel } from "../src/graph/world-model.js";
import type { AllPressures } from "../src/pressure/aggregate.js";
import { buildSituationBriefing } from "../src/pressure/situation-lines.js";

/** 测试用 tick→ms 转换（约定：1 tick = 60s）。 */
function tickMs(tick: number): number {
  return tick * 60_000;
}

/** 构造最小 AllPressures mock（只需 contributions + API）。 */
function mockPressures(
  contributions: Record<string, Record<string, number>>,
  api = 2.0,
): AllPressures {
  return {
    P1: 0,
    P2: 0,
    P3: 0,
    P4: 0,
    P5: 0,
    P6: 0,
    P_prospect: 0,
    API: api,
    API_peak: api,
    A: 0,
    contributions,
    prospectContributions: {},
    pressureHistory: { P1: [], P2: [], P3: [], P4: [], P5: [], P6: [] },
  };
}

/** 构造一个包含多种实体的测试图。 */
function buildTestGraph(tick = 100): WorldModel {
  const G = new WorldModel();
  G.tick = tick;
  G.addAgent("self");
  G.addContact("alice", {
    display_name: "Alice",
    tier: 5,
    last_active_ms: tickMs(95),
  });
  G.addContact("bob", {
    display_name: "Bob",
    tier: 50,
    last_active_ms: tickMs(60),
  });
  G.addContact("carol", {
    display_name: "Carol",
    tier: 150,
    last_active_ms: 1,
  });
  G.addChannel("channel:tech", {
    display_name: "技术群",
    unread: 12,
    tier_contact: 150,
    chat_type: "group",
    pending_directed: 0,
  });
  G.addChannel("channel:alice", {
    display_name: "Alice Chat",
    unread: 3,
    tier_contact: 5,
    chat_type: "private",
    pending_directed: 2,
    last_directed_ms: tickMs(90),
  });
  G.addThread("thread_weekend", { title: "weekend plans", created_ms: 50 });
  return G;
}

describe("buildSituationBriefing", () => {
  it("按压力降序排列实体", () => {
    const G = buildTestGraph();
    const p = mockPressures({
      P1: {},
      P2: {},
      P3: { carol: 3.0, bob: 1.0 },
      P4: {},
      P5: { "channel:alice": 5.0 },
      P6: {},
    });
    const lines = buildSituationBriefing(p, G, 100, tickMs(100));
    // P5(channel:alice=5.0) > P3(carol=3.0) > P3(bob=1.0) → 这个顺序
    expect(lines[0]).toContain("Alice Chat");
    expect(lines[1]).toContain("Carol");
    expect(lines[2]).toContain("Bob");
  });

  it("输出中不含原始压力数字标识", () => {
    const G = buildTestGraph();
    const p = mockPressures(
      {
        P1: { "channel:tech": 8.0 },
        P2: { "channel:tech": 2.0 },
        P3: { carol: 3.0 },
        P4: { thread_weekend: 1.5 },
        P5: { "channel:alice": 2.0 },
        P6: { "channel:tech": 0.5 },
      },
      3.5,
    );
    const lines = buildSituationBriefing(p, G, 100, tickMs(100));
    const joined = lines.join("\n");
    // 不出现 P1=, P2=, P3=, P4=, P5=, P6=, API=, 百分比格式
    expect(joined).not.toMatch(/P[1-6]=/);
    expect(joined).not.toMatch(/API=/);
    expect(joined).not.toMatch(/\d+%\s*capacity/);
    expect(joined).not.toMatch(/\d+\.\d+\/6\.0/);
  });

  it("实体名字解析：contact → display_name", () => {
    const G = buildTestGraph();
    const p = mockPressures({ P1: {}, P2: {}, P3: { alice: 2.0 }, P4: {}, P5: {}, P6: {} });
    const lines = buildSituationBriefing(p, G, 100, tickMs(100));
    expect(lines[0]).toContain("Alice");
    expect(lines[0]).not.toContain("alice"); // 不含 raw id
  });

  it("实体名字解析：channel → display_name", () => {
    const G = buildTestGraph();
    const p = mockPressures({
      P1: { "channel:tech": 5.0 },
      P2: {},
      P3: {},
      P4: {},
      P5: {},
      P6: {},
    });
    const lines = buildSituationBriefing(p, G, 100, tickMs(100));
    expect(lines[0]).toContain("技术群");
  });

  it("实体名字解析：thread → title", () => {
    const G = buildTestGraph();
    const p = mockPressures({
      P1: {},
      P2: {},
      P3: {},
      P4: { thread_weekend: 2.0 },
      P5: {},
      P6: {},
    });
    const lines = buildSituationBriefing(p, G, 100, tickMs(100));
    expect(lines[0]).toContain("weekend plans");
  });

  it("零压力输出平静信息", () => {
    const G = buildTestGraph();
    const p = mockPressures({ P1: {}, P2: {}, P3: {}, P4: {}, P5: {}, P6: {} }, 0.0);
    const lines = buildSituationBriefing(p, G, 100, tickMs(100));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("Everything is calm right now.");
  });

  it("单维度 P5 高但 P3 低 → 回复义务排最前", () => {
    const G = buildTestGraph();
    const p = mockPressures({
      P1: {},
      P2: {},
      P3: { carol: 0.5 },
      P4: {},
      P5: { "channel:alice": 4.0 },
      P6: {},
    });
    const lines = buildSituationBriefing(p, G, 100, tickMs(100));
    // P5 是第一行
    expect(lines[0]).toContain("Alice Chat");
    // P3 第二行
    expect(lines[1]).toContain("Carol");
  });

  it("超过 6 个实体时只取 top-6", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addAgent("self");
    const contribs: Record<string, number> = {};
    for (let i = 0; i < 10; i++) {
      const id = `contact:${i}`;
      G.addContact(id, {
        display_name: `User ${i}`,
        tier: 50,
        last_active_ms: tickMs(50),
      });
      contribs[id] = 10 - i; // 降序
    }
    const p = mockPressures({ P1: {}, P2: {}, P3: contribs, P4: {}, P5: {}, P6: {} });
    const lines = buildSituationBriefing(p, G, 100, tickMs(100));
    // 6 entity lines + 1 overall = 7
    expect(lines).toHaveLength(7);
  });

  it("P3 高压力显示天数", () => {
    // carol last_active_ms=1ms, nowMs=tickMs(2881) → 2 days of silence
    const G = buildTestGraph(2881);
    const p = mockPressures({ P1: {}, P2: {}, P3: { carol: 3.0 }, P4: {}, P5: {}, P6: {} });
    const lines = buildSituationBriefing(p, G, 2881, tickMs(2881));
    expect(lines[0]).toMatch(/2 days/);
  });

  it("P5 高压力显示未回复消息数", () => {
    const G = buildTestGraph();
    const p = mockPressures({
      P1: {},
      P2: {},
      P3: {},
      P4: {},
      P5: { "channel:alice": 4.0 },
      P6: {},
    });
    const lines = buildSituationBriefing(p, G, 100, tickMs(100));
    expect(lines[0]).toMatch(/several messages unanswered/);
  });

  it("图中不存在的实体回退到安全泛称（ADR-172: 不泄漏 raw ID）", () => {
    const G = buildTestGraph();
    const p = mockPressures({
      P1: {},
      P2: {},
      P3: {},
      P4: {},
      P5: { unknown_entity: 3.0 },
      P6: {},
    });
    const lines = buildSituationBriefing(p, G, 100, tickMs(100));
    // ADR-172: safeDisplayName 返回 "(someone)" 而非 raw ID
    expect(lines[0]).toContain("(someone)");
  });

  it("高 API 输出环境帧总况（ADR-194: 从过载帧改为环境帧）", () => {
    const G = buildTestGraph();
    const p = mockPressures({ P1: {}, P2: {}, P3: {}, P4: {}, P5: {}, P6: {} }, 5.0);
    const lines = buildSituationBriefing(p, G, 100, tickMs(100));
    expect(lines[lines.length - 1]).toBe("The world's been busy while you're here.");
  });

  it("P1 高压力显示未读数", () => {
    const G = buildTestGraph();
    const p = mockPressures({
      P1: { "channel:tech": 8.0 },
      P2: {},
      P3: {},
      P4: {},
      P5: {},
      P6: {},
    });
    const lines = buildSituationBriefing(p, G, 100, tickMs(100));
    expect(lines[0]).toMatch(/many unread/);
  });

  it("P6 好奇心显示相关文案", () => {
    const G = buildTestGraph();
    const p = mockPressures({
      P1: {},
      P2: {},
      P3: {},
      P4: {},
      P5: {},
      P6: { "channel:tech": 0.5 },
    });
    const lines = buildSituationBriefing(p, G, 100, tickMs(100));
    expect(lines[0]).toContain("技术群");
    // 单实体 intensity=high → "A lot of fresh activity"
    expect(lines[0]).toContain("fresh activity");
  });

  // ── 支柱 ④: 反馈回写 ──────────────────────────────────────────────────

  it("P5 带 last_directed_text → 引用对方消息（CA 邻接对）", () => {
    const G = buildTestGraph();
    G.setDynamic("channel:alice", "last_directed_text", "面试怎么样？");
    const p = mockPressures({
      P1: {},
      P2: {},
      P3: {},
      P4: {},
      P5: { "channel:alice": 4.0 },
      P6: {},
    });
    const lines = buildSituationBriefing(p, G, 100, tickMs(100));
    expect(lines[0]).toContain('said "面试怎么样？"');
    expect(lines[0]).toContain("waiting for your reply");
  });

  it("P5 无 last_directed_text → 回退到原始模板", () => {
    const G = buildTestGraph();
    // last_directed_text 默认为 ""
    const p = mockPressures({
      P1: {},
      P2: {},
      P3: {},
      P4: {},
      P5: { "channel:alice": 4.0 },
      P6: {},
    });
    const lines = buildSituationBriefing(p, G, 100, tickMs(100));
    expect(lines[0]).toContain("Alice Chat");
    expect(lines[0]).toContain("several messages");
  });

  it("P3 带 last_outgoing_text → 引用 Alice 上次说的话", () => {
    const G = buildTestGraph(2880);
    // carol 的私聊 channel: contact:carol 对应的 channel 需要存在
    // 但 buildTestGraph 的 carol 没有对应 channel，需要手动添加
    G.addChannel("channel:carol", {
      display_name: "Carol Chat",
      chat_type: "private",
      last_outgoing_text: "周末愉快！",
    });
    // carol 的 id 是 "carol" 不是 "contact:carol"，所以 findLastOutgoingText 需要 contact:X → channel:X
    // buildTestGraph 里 carol id = "carol"，所以对应 channel 应该是 "channel:carol"（strip "contact:" prefix）
    // 但 "carol" 没有 "contact:" 前缀。让我用一个有正确前缀的 contact 来测试
    G.addContact("contact:telegram:999", {
      display_name: "Dave",
      tier: 150,
      last_active_ms: 1,
    });
    G.addChannel("channel:telegram:999", {
      display_name: "Dave Chat",
      chat_type: "private",
      last_outgoing_text: "周末愉快！",
    });
    const p = mockPressures({
      P1: {},
      P2: {},
      P3: { "contact:telegram:999": 3.0 },
      P4: {},
      P5: {},
      P6: {},
    });
    const lines = buildSituationBriefing(p, G, 2880, tickMs(2880));
    expect(lines[0]).toContain("Dave");
    expect(lines[0]).toContain('you said "周末愉快！"');
  });

  it("P3 无 last_outgoing_text → 不显示引用", () => {
    const G = buildTestGraph(2880);
    const p = mockPressures({ P1: {}, P2: {}, P3: { carol: 3.0 }, P4: {}, P5: {}, P6: {} });
    const lines = buildSituationBriefing(p, G, 2880, tickMs(2880));
    expect(lines[0]).toContain("Carol");
    expect(lines[0]).not.toContain("you said");
  });

  it("anti-bombing: 私聊 consecutive_outgoing >= 5 触发警告", () => {
    // ADR-189 蟑螂审计 Recal 1: outgoingCapPrivate 3→4 → BOMBING_THRESHOLD = 4+1 = 5
    const G = buildTestGraph();
    G.setDynamic("channel:alice", "consecutive_outgoing", 5);
    const p = mockPressures({ P1: {}, P2: {}, P3: {}, P4: {}, P5: {}, P6: {} }, 2.0);
    const lines = buildSituationBriefing(p, G, 100, tickMs(100));
    const joined = lines.join("\n");
    expect(joined).toContain("several messages");
    expect(joined).toContain("Alice Chat");
    expect(joined).toContain("without a reply");
  });

  it("anti-bombing: 私聊 consecutive_outgoing < 5 不触发", () => {
    // ADR-189 蟑螂审计 Recal 1: outgoingCapPrivate 3→4 → BOMBING_THRESHOLD = 4+1 = 5
    const G = buildTestGraph();
    G.setDynamic("channel:alice", "consecutive_outgoing", 4);
    const p = mockPressures({ P1: {}, P2: {}, P3: {}, P4: {}, P5: {}, P6: {} }, 2.0);
    const lines = buildSituationBriefing(p, G, 100, tickMs(100));
    const joined = lines.join("\n");
    expect(joined).not.toContain("without a reply");
  });

  it("ADR-113: 群组 anti-bombing 阈值 = 5（比私聊略高）", () => {
    const G = buildTestGraph();
    // channel:tech 是 group 类型
    G.setDynamic("channel:tech", "consecutive_outgoing", 4);
    const p = mockPressures({ P1: {}, P2: {}, P3: {}, P4: {}, P5: {}, P6: {} }, 2.0);
    const lines = buildSituationBriefing(p, G, 100, tickMs(100));
    const joined = lines.join("\n");
    // 4 < 5 → 群组中不触发
    expect(joined).not.toContain("技术群");
  });

  it("ADR-113: 群组 consecutive_outgoing >= 5 触发", () => {
    const G = buildTestGraph();
    G.setDynamic("channel:tech", "consecutive_outgoing", 5);
    const p = mockPressures({ P1: {}, P2: {}, P3: {}, P4: {}, P5: {}, P6: {} }, 2.0);
    const lines = buildSituationBriefing(p, G, 100, tickMs(100));
    const joined = lines.join("\n");
    expect(joined).toContain("技术群");
    expect(joined).toContain("without a reply");
  });

  // ── ADR-194: 双语态渲染 ───────────────────────────────────────────────

  it("ADR-194: 非当前 target 使用环境语态（P1 ambient）", () => {
    const G = buildTestGraph();
    const p = mockPressures({
      P1: { "channel:tech": 8.0, "channel:alice": 1.0 },
      P2: {},
      P3: {},
      P4: {},
      P5: {},
      P6: {},
    });
    // channel:alice 是当前 target，channel:tech 是非当前 target
    const lines = buildSituationBriefing(p, G, 100, tickMs(100), {
      actionTarget: "channel:alice",
    });
    const joined = lines.join("\n");
    // channel:tech（非当前）应使用环境语态——"pretty active" 而非 "piling up"
    expect(joined).toContain("pretty active");
    expect(joined).not.toContain("piling up");
    // channel:alice（当前 target）使用行动语态
    expect(joined).toContain("Alice Chat");
  });

  it("ADR-194: 当前 target 保留行动语态（P5 obligation）", () => {
    const G = buildTestGraph();
    const p = mockPressures({
      P1: {},
      P2: {},
      P3: {},
      P4: {},
      P5: { "channel:alice": 4.0 },
      P6: {},
    });
    const lines = buildSituationBriefing(p, G, 100, tickMs(100), {
      actionTarget: "channel:alice",
    });
    // 当前 target 的 P5 应保留 "unanswered" 行动语态
    expect(lines[0]).toContain("unanswered");
  });

  it("ADR-194: 非当前 target P5 使用环境语态", () => {
    const G = buildTestGraph();
    const p = mockPressures({
      P1: {},
      P2: {},
      P3: {},
      P4: {},
      P5: { "channel:alice": 4.0 },
      P6: {},
    });
    // channel:tech 是当前 target，所以 channel:alice 是非当前
    const lines = buildSituationBriefing(p, G, 100, tickMs(100), {
      actionTarget: "channel:tech",
    });
    // 非当前 target 的 P5 应使用 "trying to reach" 而非 "unanswered"
    expect(lines[0]).toContain("trying to reach");
    expect(lines[0]).not.toContain("unanswered");
  });

  it("ADR-194: 非当前 target P6 无 'worth checking out'", () => {
    const G = buildTestGraph();
    const p = mockPressures({
      P1: {},
      P2: {},
      P3: {},
      P4: {},
      P5: {},
      P6: { "channel:tech": 5.0 },
    });
    const lines = buildSituationBriefing(p, G, 100, tickMs(100), {
      actionTarget: "channel:alice",
    });
    expect(lines[0]).not.toContain("worth checking out");
    expect(lines[0]).toContain("A lot going on");
  });

  it("ADR-194: 无 actionTarget 时全部使用行动语态（向后兼容）", () => {
    const G = buildTestGraph();
    const p = mockPressures({
      P1: { "channel:tech": 8.0 },
      P2: {},
      P3: {},
      P4: {},
      P5: {},
      P6: {},
    });
    // 不传 actionTarget → ambient=false（全部行动语态）
    const lines = buildSituationBriefing(p, G, 100, tickMs(100));
    expect(lines[0]).toContain("piling up");
  });

  it("ADR-194: '(you're not in this chat right now)' 标注已移除", () => {
    const G = buildTestGraph();
    const p = mockPressures({
      P1: { "channel:tech": 8.0 },
      P2: {},
      P3: {},
      P4: {},
      P5: {},
      P6: {},
    });
    const lines = buildSituationBriefing(p, G, 100, tickMs(100), {
      actionTarget: "channel:alice",
    });
    const joined = lines.join("\n");
    expect(joined).not.toContain("you're not in this chat right now");
  });

  it("ADR-194: contact:X 和 channel:X 共享 numeric ID → 视为同一 target", () => {
    const G = buildTestGraph();
    // contact:alice 的 numeric ID 同 channel:alice
    const p = mockPressures({
      P1: {},
      P2: {},
      P3: { alice: 1.0 },
      P4: {},
      P5: { "channel:alice": 4.0 },
      P6: {},
    });
    const lines = buildSituationBriefing(p, G, 100, tickMs(100), {
      actionTarget: "channel:alice",
    });
    // P5 channel:alice 是当前 target → 行动语态
    expect(lines[0]).toContain("unanswered");
    // P3 alice(contact)——numeric ID 同 channel:alice → 也应为行动语态，不应 ambient
    // "Alice" 的 P3 是 contact，描述 "It's been a while..."——这是行动语态
    const aliceLine = lines.find((l) => l.includes("Alice") && !l.includes("Alice Chat"));
    if (aliceLine) {
      expect(aliceLine).not.toContain("has been active");
    }
  });

  it("ADR-194: 中等 API 输出环境帧总况", () => {
    const G = buildTestGraph();
    const p = mockPressures({ P1: {}, P2: {}, P3: {}, P4: {}, P5: {}, P6: {} }, 3.5);
    const lines = buildSituationBriefing(p, G, 100, tickMs(100));
    expect(lines[lines.length - 1]).toBe("Other chats have been active.");
  });
});
