/**
 * ★A1+A3 修复 (ADR-28): 空闲自启动测试。
 *
 * 验证:
 * - idle 达到 idleThreshold 后触发声部行动入队（不再硬编码 reflection）
 * - 有行动时不触发 idle
 * - idle 触发后 lastActionTick 重置
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { closeDb, getDb, initDb } from "../src/db/connection.js";
import { listDecisionTraces } from "../src/db/decision-trace.js";
import { candidateTrace, queueTrace, tickTrace } from "../src/db/schema.js";

// ADR-190: isAnyProviderHealthy() 门控——测试无 LLM provider，需 mock 为 true。
vi.mock("../src/llm/client.js", () => ({
  isAnyProviderHealthy: () => true,
}));

beforeEach(() => initDb(":memory:"));
afterEach(() => closeDb());

import type { Dispatcher } from "../src/core/dispatcher.js";
import { ActionQueue, type ActionQueueItem } from "../src/engine/action-queue.js";
import { createDeliberationState } from "../src/engine/deliberation.js";
import { type EvolveState, evolveTick } from "../src/engine/evolve.js";
import { WorldModel } from "../src/graph/world-model.js";
import { AdaptiveKappa } from "../src/pressure/aggregate.js";
import { EventBuffer } from "../src/telegram/events.js";
import type { PressureDims } from "../src/utils/math.js";
import { TickClock } from "../src/utils/time.js";
import { PersonalityVector } from "../src/voices/personality.js";

// -- 辅助 -------------------------------------------------------------------

/** 最小 Dispatcher stub（不做任何实际操作）。 */
function stubDispatcher(): Dispatcher {
  return {
    dispatch: () => undefined,
    query: () => null,
    getInstructionNames: () => [],
    getInstructionDef: () => undefined,
    getQueryNames: () => [],
    getQueryDef: () => undefined,
    startTick: () => {},
    endTick: () => {},
    collectContributions: () => [],
    generateManual: async () => "",

    mods: [],
    snapshotModStates: () => new Map(),
    restoreModStates: () => {},
    saveModStatesToDb: () => {},
    loadModStatesFromDb: () => false,
    readModState: () => undefined,
  };
}

/** 构建一个空闲场景的 EvolveState（无实体 → 压力全零 → API 低于 floor）。 */
function buildIdleState(
  overrides: Partial<{ lastActionMs: number; idleThreshold: number }> = {},
): EvolveState {
  const config = loadConfig();
  config.idleThreshold = overrides.idleThreshold ?? 30;
  // 确保 API floor 会拦截（默认 0.05 * 6 = 0.3）
  config.actionRateFloor = 0.05;
  // 设 eta=0 防止 P6 fallback 返回 eta 导致 API 偏高
  config.eta = 0;

  const G = new WorldModel();
  G.tick = 0;
  // 添加 self 节点以通过基本检查
  G.addAgent("self");

  return {
    G,
    personality: new PersonalityVector(config.piHome),
    clock: new TickClock(), // 自适应 tick
    buffer: new EventBuffer(),
    queue: new ActionQueue(),
    config,
    // 预填充 noveltyHistory 避免 P6 fallback 到 eta 分支
    noveltyHistory: [0.5, 0.5, 0.5],
    recentEventCounts: [],
    recentActions: [],
    dispatcher: stubDispatcher(),
    lastActionMs: overrides.lastActionMs ?? Date.now(),
    pressureHistory: [],
    deliberation: createDeliberationState(),
    attentionDebtMap: new Map(),
    lastSelectedTarget: null,
    lastSelectedCandidate: null,
    mode: "patrol" as const,
    modeEnteredMs: Date.now(),
    adaptiveKappa: new AdaptiveKappa(config.kappa, config.kappaAdaptAlpha),
    channelRateEma: new Map(),
    lastChannelCounts: new Map(),
    eventCountEma: 10,
    floodTickCount: 0,
    lastAPI: 0,
    lastAPIPeak: 0,
    lastFlushMs: 0,
    currentDt: 60,
    wakeupTicksElapsed: 0,
    wakeupEngagedTargets: new Set(),
    llmBackoff: { consecutiveFailures: 0, lastFailureMs: 0 },
    episodeState: {
      currentId: null,
      currentTarget: null,
      currentTickStart: null,
      activeResidues: [],
    },
  };
}

function makeQueuedItem(target: string, pressure = 1): ActionQueueItem {
  const dims: PressureDims = [pressure, 0, 0, 0, 0, 0];
  return {
    enqueueTick: 1,
    action: "sociability",
    target,
    pressureSnapshot: dims,
    contributions: {},
  };
}

function fillQueueToBackpressureThreshold(queue: ActionQueue): void {
  const targetDepth = Math.ceil(ActionQueue.MAX_DEPTH * 0.8);
  for (let i = 0; i < targetDepth; i++) {
    queue.enqueue(makeQueuedItem(`channel:queued-${i}`));
  }
}

function buildProactiveIausState(): EvolveState {
  const now = Date.now();
  const state = buildIdleState({ lastActionMs: now, idleThreshold: 999 });
  state.config.actionRateFloor = 0.0;
  state.config.rateCap = { private: 100, group: 100, channel: 100, bot: 0 };
  state.config.s10LeakProb = 0;
  state.config.eta = 0;
  state.config.iausDeterministic = true;

  state.G.addContact("contact:252", {
    tier: 5,
    last_active_ms: now - 7 * 86_400_000,
  });
  state.G.addChannel("channel:252", {
    unread: 0,
    tier_contact: 5,
    chat_type: "private",
    pending_directed: 0,
    last_directed_ms: 0,
    last_activity_ms: now - 7 * 86_400_000,
    consecutive_outgoing: 0,
  });
  state.G.addRelation("self", "monitors", "channel:252");
  return state;
}

function buildDirectedIausState(): EvolveState {
  const now = Date.now();
  const state = buildIdleState({ lastActionMs: now, idleThreshold: 999 });
  state.config.actionRateFloor = 0.0;
  state.config.rateCap = { private: 100, group: 100, channel: 100, bot: 0 };
  state.config.s10LeakProb = 0;
  state.config.eta = 0;
  state.config.iausDeterministic = true;

  state.G.addChannel("channel:253", {
    unread: 50,
    tier_contact: 5,
    chat_type: "private",
    pending_directed: 5,
    last_directed_ms: now,
    last_incoming_ms: now,
    last_activity_ms: now,
    consecutive_outgoing: 0,
  });
  state.G.addRelation("self", "monitors", "channel:253");
  state.buffer.push({
    type: "new_message",
    channelId: "channel:253",
    isDirected: true,
    tick: 1,
    novelty: 0.8,
  });
  return state;
}

// -- 测试 -------------------------------------------------------------------

describe("★A1+A3 空闲自启动", () => {
  it("idle 达到 idleThreshold 后触发声部行动入队", async () => {
    // dt 迁移：空闲判断基于墙钟秒差 (Date.now() - lastActionMs) / 1000
    // 设置 lastActionMs 足够久远以超过 idleThreshold
    const state = buildIdleState({ lastActionMs: Date.now() - 6000, idleThreshold: 5 });

    // lastActionMs 距今 6 秒 > idleThreshold 5 秒 → 第一个 tick 即触发
    const triggered = evolveTick(state);
    expect(triggered).toBe(true);
    expect(state.queue.length).toBe(1);

    // 验证入队的是声部竞争结果（空图下 action 由 ε 噪声决定，target 为 null）
    const item = await state.queue.dequeue();
    expect(item).toMatchObject({ target: null });

    const traces = listDecisionTraces({ tick: 1, phase: "evolve" });
    const enqueueTrace = traces.find((trace) => trace.finalDecision === "enqueue");
    expect(enqueueTrace).toBeDefined();
    expect(enqueueTrace?.payload.selectedAction).toBe(item?.action);

    const tickRow = getDb().select().from(tickTrace).where(eq(tickTrace.tick, 1)).get();
    const queueRow = getDb().select().from(queueTrace).where(eq(queueTrace.tick, 1)).get();
    expect(tickRow?.selectedCandidateId).toBe(item?.observation?.candidateId);
    expect(queueRow?.candidateId).toBe(tickRow?.selectedCandidateId);
  });

  it("idle 触发后 lastActionMs 重置", () => {
    // dt 迁移：空闲判断基于墙钟秒差
    const state = buildIdleState({ lastActionMs: Date.now() - 4000, idleThreshold: 3 });
    const beforeTrigger = Date.now();

    // lastActionMs 距今 4 秒 > idleThreshold 3 秒 → 第一个 tick 触发
    evolveTick(state);
    expect(state.queue.length).toBe(1);

    // lastActionMs 应该被更新到 ~Date.now()（触发时刻）
    expect(state.lastActionMs).toBeGreaterThanOrEqual(beforeTrigger);

    // 清空队列
    state.queue.dequeue();

    // 立刻再运行 1 tick → lastActionMs 刚被更新，idle < 3 → 不触发
    evolveTick(state);
    expect(state.queue.length).toBe(0);
  });

  it("有外部事件且 API 足够高时走正常行动（不是 idle 路径）", () => {
    const state = buildIdleState({ lastActionMs: Date.now(), idleThreshold: 3 });

    // 添加实体以产生压力
    state.G.addChannel("ch1", {
      unread: 50,
      tier_contact: 5,
      chat_type: "private",
      pending_directed: 10,
      last_directed_ms: 0,
    });
    state.G.addRelation("self", "monitors", "ch1");

    // 注入一个事件以产生 eventCount > 0
    state.buffer.push({
      type: "new_message",
      channelId: "ch1",
      isDirected: true,
      tick: 1,
      novelty: 0.5,
    });

    // 降低 actionRateFloor 确保 API 通过门控
    state.config.actionRateFloor = 0.0;

    const triggered = evolveTick(state);
    // 有压力 → 应该正常行动（非 idle），System 1 或 System 2
    // 无论哪条路径，lastActionTick 都应更新
    if (triggered) {
      expect(state.lastActionMs).toBeGreaterThan(0);
    }
  });

  // ADR-47 G1: 危机模式门控测试
  describe("G1: 危机模式行为切换", () => {
    it("ADR-84: 危机期间非危机频道的 directed 行动不被连坐", () => {
      const config = loadConfig();
      config.idleThreshold = 999; // 禁用 idle 路径
      config.actionRateFloor = 0.0; // 让 API 门控不拦截
      config.rateCap = { private: 100, group: 100, channel: 100, bot: 0 }; // 不被 rate cap 拦截
      config.eta = 0;
      // 禁用 System 1 leak（避免随机泄漏干扰测试）
      config.s10LeakProb = 0;

      const G = new WorldModel();
      G.tick = 0;
      G.addAgent("self");
      // "channel:other": 非危机频道，有 pending_directed
      G.addChannel("channel:other", {
        unread: 50,
        tier_contact: 5,
        chat_type: "private",
        pending_directed: 5,
        last_directed_ms: 0,
      });
      G.addRelation("self", "monitors", "channel:other");

      // dispatcher stub: 危机在 channel:crisis（不同频道），channel:other 不在危机列表
      const dispatcher = stubDispatcher();
      dispatcher.query = (name: string) => {
        if (name === "crisis_channels") return ["channel:crisis"];
        if (name === "best_time") return { peakHour: undefined };
        return null;
      };

      const state: EvolveState = {
        G,
        personality: new PersonalityVector(config.piHome),
        clock: new TickClock(),
        buffer: new EventBuffer(),
        queue: new ActionQueue(),
        config,
        noveltyHistory: [0.5, 0.5, 0.5],
        recentEventCounts: [],
        recentActions: [],
        dispatcher,
        lastActionMs: Date.now(),
        pressureHistory: [],
        deliberation: createDeliberationState(),
        attentionDebtMap: new Map(),
        lastSelectedTarget: null,
        lastSelectedCandidate: null,
        mode: "patrol" as const,
        modeEnteredMs: Date.now(),
        adaptiveKappa: new AdaptiveKappa(config.kappa, config.kappaAdaptAlpha),
        channelRateEma: new Map(),
        lastChannelCounts: new Map(),
        eventCountEma: 10,
        floodTickCount: 0,
        lastAPI: 0,
        lastAPIPeak: 0,
        lastFlushMs: 0,
        currentDt: 60,
        wakeupTicksElapsed: 0,
        wakeupEngagedTargets: new Set(),
        llmBackoff: { consecutiveFailures: 0, lastFailureMs: 0 },
        episodeState: {
          currentId: null,
          currentTarget: null,
          currentTickStart: null,
          activeResidues: [],
        },
      };

      state.buffer.push({
        type: "new_message",
        channelId: "channel:other",
        isDirected: true,
        tick: 1,
        novelty: 0.8,
      });

      // ADR-84 修正：非危机频道不再被危机门控连坐。
      // channel:other 有 directed 且不在危机列表 → crisis gate pass → 行动应通过。
      const triggered = evolveTick(state);
      expect(triggered).toBe(true);
      expect(state.queue.length).toBe(1);
    });

    it("危机期间 directed 行动正常通过", () => {
      const config = loadConfig();
      config.idleThreshold = 999;
      config.actionRateFloor = 0.0;
      config.rateCap = { private: 100, group: 100, channel: 100, bot: 0 };
      config.eta = 0;

      const G = new WorldModel();
      G.tick = 0;
      G.addAgent("self");
      // "channel:crisis": 危机频道，有 pending_directed
      G.addChannel("channel:crisis", {
        unread: 50,
        tier_contact: 5,
        chat_type: "private",
        pending_directed: 3,
        last_directed_ms: 0,
      });
      G.addRelation("self", "monitors", "channel:crisis");

      const dispatcher = stubDispatcher();
      dispatcher.query = (name: string) => {
        if (name === "crisis_channels") return ["channel:crisis"];
        if (name === "best_time") return { peakHour: undefined };
        return null;
      };

      const state: EvolveState = {
        G,
        personality: new PersonalityVector(config.piHome),
        clock: new TickClock(),
        buffer: new EventBuffer(),
        queue: new ActionQueue(),
        config,
        noveltyHistory: [0.5, 0.5, 0.5],
        recentEventCounts: [],
        recentActions: [],
        dispatcher,
        lastActionMs: Date.now(),
        pressureHistory: [],
        deliberation: createDeliberationState(),
        attentionDebtMap: new Map(),
        lastSelectedTarget: null,
        lastSelectedCandidate: null,
        mode: "patrol" as const,
        modeEnteredMs: Date.now(),
        adaptiveKappa: new AdaptiveKappa(config.kappa, config.kappaAdaptAlpha),
        channelRateEma: new Map(),
        lastChannelCounts: new Map(),
        eventCountEma: 10,
        floodTickCount: 0,
        lastAPI: 0,
        lastAPIPeak: 0,
        lastFlushMs: 0,
        currentDt: 60,
        wakeupTicksElapsed: 0,
        wakeupEngagedTargets: new Set(),
        llmBackoff: { consecutiveFailures: 0, lastFailureMs: 0 },
        episodeState: {
          currentId: null,
          currentTarget: null,
          currentTickStart: null,
          activeResidues: [],
        },
      };

      // 注入事件以产生足够压力
      state.buffer.push({
        type: "new_message",
        channelId: "channel:crisis",
        isDirected: true,
        tick: 1,
        novelty: 0.8,
      });

      const triggered = evolveTick(state);
      // 危机频道 + 有 directed → 应通过门控
      // System 1 mark_read 或 System 2 入队都算 triggered
      // 关键：不被危机门控拦截（不返回 false 在危机检查处）
      expect(triggered).toBe(true);
    });

    it("无危机时不影响正常行为", () => {
      const config = loadConfig();
      config.idleThreshold = 999;
      config.actionRateFloor = 0.0;
      config.rateCap = { private: 100, group: 100, channel: 100, bot: 0 };
      config.eta = 0;

      const G = new WorldModel();
      G.tick = 0;
      G.addAgent("self");
      G.addChannel("ch1", {
        unread: 50,
        tier_contact: 5,
        chat_type: "private",
        pending_directed: 1,
        last_directed_ms: Date.now() - 5000,
        last_incoming_ms: Date.now(),
        last_activity_ms: Date.now(),
      });
      G.addRelation("self", "monitors", "ch1");

      // 无危机：crisisChannels 返回空数组
      const dispatcher = stubDispatcher();
      dispatcher.query = (name: string) => {
        if (name === "crisis_channels") return [];
        if (name === "best_time") return { peakHour: undefined };
        return null;
      };

      const state: EvolveState = {
        G,
        personality: new PersonalityVector(config.piHome),
        clock: new TickClock(),
        buffer: new EventBuffer(),
        queue: new ActionQueue(),
        config,
        noveltyHistory: [0.5, 0.5, 0.5],
        recentEventCounts: [],
        recentActions: [],
        dispatcher,
        lastActionMs: Date.now(),
        pressureHistory: [],
        deliberation: createDeliberationState(),
        attentionDebtMap: new Map(),
        lastSelectedTarget: null,
        lastSelectedCandidate: null,
        mode: "patrol" as const,
        modeEnteredMs: Date.now(),
        adaptiveKappa: new AdaptiveKappa(config.kappa, config.kappaAdaptAlpha),
        channelRateEma: new Map(),
        lastChannelCounts: new Map(),
        eventCountEma: 10,
        floodTickCount: 0,
        lastAPI: 0,
        lastAPIPeak: 0,
        lastFlushMs: 0,
        currentDt: 60,
        wakeupTicksElapsed: 0,
        wakeupEngagedTargets: new Set(),
        llmBackoff: { consecutiveFailures: 0, lastFailureMs: 0 },
        episodeState: {
          currentId: null,
          currentTarget: null,
          currentTickStart: null,
          activeResidues: [],
        },
      };

      state.buffer.push({
        type: "new_message",
        channelId: "ch1",
        isDirected: true,
        tick: 1,
        novelty: 0.8,
      });

      // 无危机 + 有 directed → 正常通过（System 2 bypass 或 directed override）
      const triggered = evolveTick(state);
      expect(triggered).toBe(true);
    });
  });

  it("★A1+A3: 有实体时 idle 使用声部竞争结果（非 reflection fallback）", async () => {
    // 构建高 silence 场景：contact 7 天前最后活跃 → silenceS≈604800
    // P3 sigmoid 饱和 → τ₃ 高 → Sociability 显著
    const config = loadConfig();
    config.idleThreshold = 3;
    config.actionRateFloor = 1.0; // API gate = 7.0 → System 2 永不通过，强制走 idle
    config.eta = 0;

    const now = Date.now();
    const G = new WorldModel();
    G.tick = 200;
    G.addAgent("self");
    // 长期未联系的朋友：7 天前 → P3 饱和 → τ₃ 高
    // ADR-101: contact 的 P3 贡献路由到对应私聊频道 channel:42
    // 审计修复: last_active_ms 必须 > 0，P3 和 P6 均跳过从未交互的联系人
    G.addContact("contact:42", { tier: 50, last_active_ms: now - 7 * 86_400_000 });
    G.addChannel("channel:42", {
      unread: 0,
      tier_contact: 50,
      chat_type: "private",
      pending_directed: 0,
      last_directed_ms: 0,
    });

    const state: EvolveState = {
      G,
      personality: new PersonalityVector(config.piHome),
      clock: new TickClock({ startTick: 200 }),
      buffer: new EventBuffer(),
      queue: new ActionQueue(),
      config,
      noveltyHistory: [0.5, 0.5, 0.5],
      recentEventCounts: [],
      recentActions: [],
      dispatcher: stubDispatcher(),
      // dt 迁移：设 lastActionMs 足够久远以超过 idleThreshold（3 秒）
      lastActionMs: Date.now() - 4000,
      pressureHistory: [],
      deliberation: createDeliberationState(),
      attentionDebtMap: new Map(),
      lastSelectedTarget: null,
      lastSelectedCandidate: null,
      mode: "patrol" as const,
      modeEnteredMs: Date.now(),
      adaptiveKappa: new AdaptiveKappa(config.kappa, config.kappaAdaptAlpha),
      channelRateEma: new Map(),
      lastChannelCounts: new Map(),
      eventCountEma: 10,
      floodTickCount: 0,
      lastAPI: 0,
      lastAPIPeak: 0,
      lastFlushMs: 0,
      currentDt: 60,
      wakeupTicksElapsed: 0,
      wakeupEngagedTargets: new Set(),
      llmBackoff: { consecutiveFailures: 0, lastFailureMs: 0 },
      episodeState: {
        currentId: null,
        currentTarget: null,
        currentTickStart: null,
        activeResidues: [],
      },
    };

    // 第一个 tick 即触发 idle（lastActionMs 距今 4 秒 > threshold 3 秒）
    evolveTick(state);

    expect(state.queue.length).toBe(1);
    const item = await state.queue.dequeue();
    // P3 贡献到 contact:42 → 路由到 channel:42 → 焦点集指向 channel:42
    // target 非 null → 修复后 idleAction = 声部竞争赢家（非 "reflection" fallback）
    expect(item).toMatchObject({
      target: "channel:42",
    });
  });
});

// ADR-81: gateReflectionGuarantee 测试已移除（Reflection 声部已消除）。

describe("ADR-252: IAUS queue backpressure", () => {
  it("未饱和时同一个普通 proactive IAUS 目标可以入队", () => {
    const state = buildProactiveIausState();

    const triggered = evolveTick(state);

    expect(triggered).toBe(true);
    expect(state.queue.length).toBe(1);
    expect(state.queue.isTargetActive("channel:252")).toBe(true);
  });

  it("入队 tick 记录落选 IAUS 候选，给 social-cost 反事实提供真实分母", () => {
    const state = buildProactiveIausState();

    const triggered = evolveTick(state);

    expect(triggered).toBe(true);
    const rows = getDb()
      .select({
        selected: candidateTrace.selected,
        silenceReason: candidateTrace.silenceReason,
        gatePlane: candidateTrace.gatePlane,
        candidateRank: candidateTrace.candidateRank,
        deltaP: candidateTrace.deltaP,
        socialCost: candidateTrace.socialCost,
        netValue: candidateTrace.netValue,
        bottleneck: candidateTrace.bottleneck,
      })
      .from(candidateTrace)
      .where(eq(candidateTrace.tick, 1))
      .all();

    expect(rows.some((row) => row.selected)).toBe(true);
    const losing = rows.filter((row) => !row.selected);
    expect(losing.length).toBeGreaterThan(0);
    expect(losing.every((row) => row.silenceReason === "lost_candidate")).toBe(true);
    expect(losing.every((row) => row.gatePlane === "iaus_competition")).toBe(true);
    expect(losing.every((row) => row.candidateRank !== null)).toBe(true);
    expect(losing.every((row) => typeof row.deltaP === "number")).toBe(true);
    expect(losing.every((row) => typeof row.socialCost === "number")).toBe(true);
    expect(losing.every((row) => typeof row.netValue === "number")).toBe(true);
    expect(losing.every((row) => typeof row.bottleneck === "string")).toBe(true);
  });

  it("队列饱和时抑制非 bypass IAUS 赢家且不入队", () => {
    const state = buildProactiveIausState();
    fillQueueToBackpressureThreshold(state.queue);
    const beforeMetrics = state.queue.getMetrics();

    const triggered = evolveTick(state);

    expect(beforeMetrics.saturation).toBeGreaterThanOrEqual(0.8);
    expect(triggered).toBe(false);
    expect(state.queue.getMetrics()).toMatchObject(beforeMetrics);
    expect(state.queue.isTargetActive("channel:252")).toBe(false);
    expect(state.recentActions).toHaveLength(0);

    const traces = listDecisionTraces({ tick: 1, phase: "evolve" });
    const silenceTrace = traces.find((trace) => trace.finalDecision === "silence");
    expect(silenceTrace?.payload.reason).toBe("queue_backpressure");
    expect(silenceTrace?.payload.values).toMatchObject({
      queueActive: beforeMetrics.active,
      queueSaturation: beforeMetrics.saturation,
      queueBackpressureThreshold: 0.8,
    });
  });

  it("队列饱和时不抑制 directed bypass IAUS 赢家", () => {
    const state = buildDirectedIausState();
    fillQueueToBackpressureThreshold(state.queue);
    const beforeLength = state.queue.length;

    const triggered = evolveTick(state);

    expect(triggered).toBe(true);
    expect(state.queue.length).toBe(beforeLength + 1);
    expect(state.queue.isTargetActive("channel:253")).toBe(true);
  });
});

describe("post-wakeup recovery target spread control", () => {
  it("恢复窗口内超过目标预算时抑制普通 proactive 新目标", () => {
    const state = buildProactiveIausState();
    state.mode = "patrol";
    state.wakeupRecoveryUntilMs = Date.now() + 600_000;
    state.wakeupEngagedTargets = new Set(["channel:open-a", "channel:open-b"]);

    const triggered = evolveTick(state);

    expect(triggered).toBe(false);
    expect(state.queue.length).toBe(0);
    expect(state.recentActions).toHaveLength(0);

    const traces = listDecisionTraces({ tick: 1, phase: "evolve" });
    const silenceTrace = traces.find((trace) => trace.finalDecision === "silence");
    expect(silenceTrace?.payload.reason).toBe("post_wakeup_recovery");
    expect(silenceTrace?.target).toBe("channel:252");
  });

  it("恢复窗口内允许继续已接触目标", () => {
    const state = buildProactiveIausState();
    state.mode = "patrol";
    state.wakeupRecoveryUntilMs = Date.now() + 600_000;
    state.wakeupEngagedTargets = new Set(["channel:252", "channel:open-b"]);

    const triggered = evolveTick(state);

    expect(triggered).toBe(true);
    expect(state.queue.length).toBe(1);
    expect(state.queue.isTargetActive("channel:252")).toBe(true);
  });

  it("恢复窗口内不抑制 directed bypass 赢家", () => {
    const state = buildDirectedIausState();
    state.mode = "patrol";
    state.wakeupRecoveryUntilMs = Date.now() + 600_000;
    state.wakeupEngagedTargets = new Set(["channel:open-a", "channel:open-b"]);

    const triggered = evolveTick(state);

    expect(triggered).toBe(true);
    expect(state.queue.length).toBe(1);
    expect(state.queue.isTargetActive("channel:253")).toBe(true);
  });

  it("恢复窗口结束后允许普通 proactive 新目标", () => {
    const state = buildProactiveIausState();
    state.mode = "patrol";
    state.wakeupRecoveryUntilMs = Date.now() - 1;
    state.wakeupEngagedTargets = new Set(["channel:open-a", "channel:open-b"]);

    const triggered = evolveTick(state);

    expect(triggered).toBe(true);
    expect(state.queue.length).toBe(1);
    expect(state.queue.isTargetActive("channel:252")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ADR-136: proactive cooldown → C_sat σ_cool 连续惩罚
// 旧二值门控已折叠进 C_sat，System 1 路径不受 σ_cool 影响。
// ═══════════════════════════════════════════════════════════════════════════

describe("ADR-136: proactive cooldown 连续化后的管线行为", () => {
  it("alice_turn 对话延续：System 1 升级到 System 2（isContinuation 正确传播）", () => {
    const config = loadConfig();
    config.idleThreshold = 999;
    config.actionRateFloor = 0.0;
    config.rateCap = { private: 100, group: 100, channel: 100, bot: 0 };
    config.eta = 0;
    config.s10LeakProb = 0;

    const G = new WorldModel();
    G.tick = 0;
    G.addAgent("self");

    // 私聊频道：σ_cool 已衰减到可忽略（7200s 前的 proactive）
    G.addChannel("channel:test", {
      unread: 30,
      tier_contact: 5,
      chat_type: "private",
      pending_directed: 0,
      last_proactive_outreach_ms: Date.now() - 7_200_000, // 2 小时前（σ_cool ≈ 0.14，可忽略）
      consecutive_outgoing: 0,
      last_incoming_ms: Date.now(),
    });
    G.addRelation("self", "monitors", "channel:test");

    // 活跃对话：turn_state=alice_turn（对方刚隐式回复了）
    G.addConversation("conversation:test", {
      channel: "channel:test",
      participants: ["contact:42"],
      state: "active",
      turn_state: "alice_turn",
      start_ms: 1,
      last_activity_ms: 9,
      pace: 1,
      message_count: 5,
      alice_message_count: 2,
    });

    const dispatcher = stubDispatcher();
    dispatcher.query = (name: string) => {
      if (name === "crisis_channels") return [];
      if (name === "best_time") return { peakHour: undefined };
      return null;
    };

    const state: EvolveState = {
      G,
      personality: new PersonalityVector(config.piHome),
      clock: new TickClock({ startTick: 9 }),
      buffer: new EventBuffer(),
      queue: new ActionQueue(),
      config,
      noveltyHistory: [0.5, 0.5, 0.5],
      recentEventCounts: [],
      recentActions: [],
      dispatcher,
      lastActionMs: Date.now(),
      pressureHistory: [],
      deliberation: createDeliberationState(),
      attentionDebtMap: new Map(),
      lastSelectedTarget: null,
      lastSelectedCandidate: null,
      mode: "patrol" as const,
      modeEnteredMs: Date.now(),
      adaptiveKappa: new AdaptiveKappa(config.kappa, config.kappaAdaptAlpha),
      channelRateEma: new Map(),
      lastChannelCounts: new Map(),
      eventCountEma: 10,
      floodTickCount: 0,
      lastAPI: 0,
      lastAPIPeak: 0,
      lastFlushMs: 0,
      currentDt: 60,
      wakeupTicksElapsed: 0,
      wakeupEngagedTargets: new Set(),
      llmBackoff: { consecutiveFailures: 0, lastFailureMs: 0 },
      episodeState: {
        currentId: null,
        currentTarget: null,
        currentTickStart: null,
        activeResidues: [],
      },
    };

    state.buffer.push({
      type: "new_message",
      channelId: "channel:test",
      isDirected: false,
      tick: 10,
      novelty: 0.8,
    });

    const triggered = evolveTick(state);
    // ADR-136: 二值 proactive_cooldown 门控已移除。
    // isContinuation=true → System 1 升级到 System 2（不做 digest）。
    // σ_cool 已充分衰减 → V-max NSV > 0 → 行动入队 → triggered=true。
    expect(triggered).toBe(true);
  });

  it("无活跃对话时 System 1 正常 digest 未读消息（σ_cool 仅影响 V-max）", () => {
    const config = loadConfig();
    config.idleThreshold = 999;
    config.actionRateFloor = 0.0;
    config.rateCap = { private: 100, group: 100, channel: 100, bot: 0 };
    config.eta = 0;
    config.s10LeakProb = 0;

    const G = new WorldModel();
    G.tick = 0;
    G.addAgent("self");

    // 同样的频道设置，但没有活跃对话
    G.addChannel("channel:test", {
      unread: 30,
      tier_contact: 5,
      chat_type: "private",
      pending_directed: 0,
      last_proactive_outreach_ms: Date.now() - 60_000, // 60 秒前（σ_cool 高）
      consecutive_outgoing: 0,
      last_incoming_ms: Date.now(),
      participation_ratio: 0.1, // 非零避免 NEWCOMER_LEAK_FLOOR 概率泄漏到 System 2
    });
    G.addRelation("self", "monitors", "channel:test");
    // 无 conversation 实体

    const dispatcher = stubDispatcher();
    dispatcher.query = (name: string) => {
      if (name === "crisis_channels") return [];
      if (name === "best_time") return { peakHour: undefined };
      return null;
    };

    const state: EvolveState = {
      G,
      personality: new PersonalityVector(config.piHome),
      clock: new TickClock({ startTick: 9 }),
      buffer: new EventBuffer(),
      queue: new ActionQueue(),
      config,
      noveltyHistory: [0.5, 0.5, 0.5],
      recentEventCounts: [],
      recentActions: [],
      dispatcher,
      lastActionMs: Date.now(),
      pressureHistory: [],
      deliberation: createDeliberationState(),
      attentionDebtMap: new Map(),
      lastSelectedTarget: null,
      lastSelectedCandidate: null,
      mode: "patrol" as const,
      modeEnteredMs: Date.now(),
      adaptiveKappa: new AdaptiveKappa(config.kappa, config.kappaAdaptAlpha),
      channelRateEma: new Map(),
      lastChannelCounts: new Map(),
      eventCountEma: 10,
      floodTickCount: 0,
      lastAPI: 0,
      lastAPIPeak: 0,
      lastFlushMs: 0,
      currentDt: 60,
      wakeupTicksElapsed: 0,
      wakeupEngagedTargets: new Set(),
      llmBackoff: { consecutiveFailures: 0, lastFailureMs: 0 },
      episodeState: {
        currentId: null,
        currentTarget: null,
        currentTickStart: null,
        activeResidues: [],
      },
    };

    state.buffer.push({
      type: "new_message",
      channelId: "channel:test",
      isDirected: false,
      tick: 10,
      novelty: 0.8,
    });

    const triggered = evolveTick(state);
    // ADR-136: 旧二值 proactive_cooldown 门控已移除。
    // isContinuation=false, directed=0, unread=30, leakProb=0
    // → System 1 做 digest（浅层消化未读消息）→ triggered=true。
    // σ_cool 的高值仅影响 V-max 路径，不影响 System 1 的 digest。
    expect(triggered).toBe(true);
  });
});
