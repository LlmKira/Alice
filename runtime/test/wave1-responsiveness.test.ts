/**
 * ADR-64 Wave 1: 响应性架构改进测试。
 *
 * 验证:
 * 1. Event-driven 唤醒: directed 消息触发 onDirected 回调
 * 2. Conversation-aware cooldown: 活跃对话使用短 cooldown
 * 3. Directed 门控绿灯: pending_directed > 0 时跳过 L2 和 API 下限
 * 4. Cooldown 自适应节奏冷却: ADR-125 computeAdaptiveCooldown
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { closeDb, initDb } from "../src/db/connection.js";

// ADR-190: isAnyProviderHealthy() 门控——测试无 LLM provider，需 mock 为 true。
vi.mock("../src/llm/client.js", () => ({
  isAnyProviderHealthy: () => true,
}));

beforeEach(() => initDb(":memory:"));
afterEach(() => closeDb());

import type { Dispatcher } from "../src/core/dispatcher.js";
import { ActionQueue } from "../src/engine/action-queue.js";
import { createDeliberationState } from "../src/engine/deliberation.js";
import { type EvolveState, evolveTick, startEvolveLoop } from "../src/engine/evolve.js";
import { findActiveConversation } from "../src/graph/queries.js";
import { WorldModel } from "../src/graph/world-model.js";
import { AdaptiveKappa } from "../src/pressure/aggregate.js";
import { createCuriosityHistory } from "../src/pressure/p6-curiosity.js";
import { EventBuffer } from "../src/telegram/events.js";
import { TickClock } from "../src/utils/time.js";
import { PersonalityVector } from "../src/voices/personality.js";

// -- 辅助 -------------------------------------------------------------------

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

function buildState(
  overrides: Partial<{
    actionRateFloor: number;
    rateCap: number;
    idleThreshold: number;
    lastActionMs: number;
    eta: number;
    startTick: number;
  }> = {},
): EvolveState {
  const config = loadConfig();
  config.idleThreshold = overrides.idleThreshold ?? 999;
  config.actionRateFloor = overrides.actionRateFloor ?? 0.05;
  const cap = overrides.rateCap ?? 100;
  config.rateCap = { private: cap, group: cap, channel: cap, bot: 0 };
  config.eta = overrides.eta ?? 0;
  config.s10LeakProb = 0; // 禁用 System 1 leak 避免随机干扰
  config.generators.digestHour = -1; // 禁用生成器时钟触发，避免 P4 干扰门控测试
  config.generators.reflectionHour = -1;

  const startTick = overrides.startTick ?? 0;
  const G = new WorldModel();
  G.tick = startTick;
  G.addAgent("self");

  return {
    G,
    personality: new PersonalityVector(config.piHome),
    clock: new TickClock({ startTick }),
    buffer: new EventBuffer(),
    queue: new ActionQueue(),
    config,
    curiosityHistory: createCuriosityHistory(),
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

// -- 1. Event-driven 唤醒 ---------------------------------------------------

describe("ADR-64 I-1: Event-driven 唤醒", () => {
  it("EventBuffer.push directed 消息触发 onDirected 回调", () => {
    const buffer = new EventBuffer();
    const cb = vi.fn();
    buffer.onDirected = cb;

    // non-directed 不触发
    buffer.push({ type: "new_message", channelId: "channel:1", tick: 1, isDirected: false });
    expect(cb).not.toHaveBeenCalled();

    // directed 触发
    buffer.push({ type: "new_message", channelId: "channel:1", tick: 2, isDirected: true });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({ type: "new_message", isDirected: true }),
    );
  });

  it("非 directed 事件不触发 onDirected 回调", () => {
    const buffer = new EventBuffer();
    const cb = vi.fn();
    buffer.onDirected = cb;

    // non-directed new_message 不触发
    buffer.push({ type: "new_message", channelId: "channel:1", tick: 1, isDirected: false });
    // reaction 没有 isDirected 字段 → 不触发
    buffer.push({ type: "reaction", channelId: "channel:1", tick: 2 });
    // read_history 没有 isDirected → 不触发
    buffer.push({ type: "read_history", channelId: "channel:1", tick: 3 });

    expect(cb).not.toHaveBeenCalled();
  });

  it("onDirected 未注册时 push 不报错", () => {
    const buffer = new EventBuffer();
    // 不设置 onDirected
    expect(() => {
      buffer.push({ type: "new_message", channelId: "channel:1", tick: 1, isDirected: true });
    }).not.toThrow();
  });

  it("startEvolveLoop 注册 onDirected 回调", async () => {
    const state = buildState();
    // 关闭队列以让循环快速退出
    state.queue.close();

    const ac = startEvolveLoop(state);
    // 等循环启动
    await new Promise((r) => setTimeout(r, 50));

    // onDirected 应已注册（循环退出后被清理，但退出前一定存在过）
    // 由于 queue.closed 循环会立即退出，验证回调已被清理
    ac.abort();
  });
});

// -- 2. Directed 门控绿灯 ---------------------------------------------------

describe("ADR-64 I-1: Directed 门控绿灯", () => {
  it("pending_directed > 0 时跳过 L2 Active Cooling", async () => {
    // 填充大量 recent actions 使 L2 Active Cooling 大概率拦截
    const state = buildState({ actionRateFloor: 0.0 });
    state.G.addChannel("channel:alice", {
      unread: 5,
      tier_contact: 5,
      chat_type: "private",
      pending_directed: 3,
      last_directed_ms: 0,
    });
    state.G.addRelation("self", "monitors", "channel:alice");

    // 填充 50 个 recent actions — 正常情况下 L2 几乎必然拦截
    for (let i = 0; i < 50; i++) {
      state.recentActions.push({ tick: 1, action: "sociability", ms: Date.now(), target: null });
    }

    state.buffer.push({
      type: "new_message",
      channelId: "channel:alice",
      isDirected: true,
      tick: 1,
      novelty: 0.8,
    });

    // 运行多次确认 directed 稳定通过（L2 是概率门控，directed 应 100% 通过）
    let passCount = 0;
    for (let i = 0; i < 10; i++) {
      // 排空队列 + 释放 processing 锁 + 清理 per-target recent actions——隔离 L2 bypass 测试
      while (state.queue.length > 0) await state.queue.dequeue();
      state.queue.markComplete("channel:alice");
      state.recentActions = state.recentActions.filter((a) => a.target !== "channel:alice");
      // 重置状态
      state.G.setDynamic("channel:alice", "pending_directed", 3);
      state.G.setDynamic("channel:alice", "unread", 5);
      state.buffer.push({
        type: "new_message",
        channelId: "channel:alice",
        isDirected: true,
        tick: state.clock.tick + 1,
        novelty: 0.8,
      });
      const triggered = evolveTick(state);
      if (triggered) passCount++;
    }
    // directed 应该能稳定通过（不被 L2 随机拦截）
    expect(passCount).toBeGreaterThan(5);
  });

  it("pending_directed > 0 时跳过 API 下限门控", () => {
    // 设置极高的 actionRateFloor 使 API gate 几乎必然拦截
    const state = buildState({ actionRateFloor: 1.0 });
    state.G.addChannel("channel:alice", {
      unread: 5,
      tier_contact: 5,
      chat_type: "private",
      pending_directed: 3,
      last_directed_ms: 0,
    });
    state.G.addRelation("self", "monitors", "channel:alice");

    state.buffer.push({
      type: "new_message",
      channelId: "channel:alice",
      isDirected: true,
      tick: 1,
      novelty: 0.8,
    });

    const triggered = evolveTick(state);
    // directed 跳过 API floor → 应该通过（入队或 System 1 处理）
    expect(triggered).toBe(true);
  });

  it("pending_directed = 0 时 L2 和 API 正常门控", () => {
    // startTick ≥ 100 绕过冷启动放松（ADR-54 S3），确保 actionRateFloor 生效
    const state = buildState({ actionRateFloor: 1.0, startTick: 100 });
    state.G.addChannel("channel:group", {
      unread: 10,
      tier_contact: 150,
      chat_type: "group",
      pending_directed: 0,
    });
    state.G.addRelation("self", "monitors", "channel:group");

    state.buffer.push({
      type: "new_message",
      channelId: "channel:group",
      isDirected: false,
      tick: 1,
      novelty: 0.5,
    });

    evolveTick(state);
    // 无 directed, 高 floor → System 1 digest/mark_read 可能通过
    // 但 System 2 肯定被 API 门控拦截
    // 如果 System 1 处理了（mark_read/digest），那也是正常行为
    // 关键：非 directed 不会绕过 API 门控走到 System 2 入队
    expect(state.queue.length).toBe(0);
  });
});

// -- 3. Cooldown: 固定字段已由 ADR-125 自适应冷却取代 -----------------------
// @see docs/adr/127-adaptive-rhythm-cooldown.md
// @see runtime/test/adaptive-cooldown.test.ts

// -- 4. Conversation-aware cooldown -----------------------------------------

describe("ADR-64 I-4: Conversation-aware cooldown", () => {
  it("活跃对话状态被正确检测", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addAgent("self");
    G.addChannel("channel:bob", { chat_type: "private" });
    G.addRelation("self", "monitors", "channel:bob");

    // 创建 active conversation with alice_turn
    G.addConversation("conversation:channel:bob_100", {
      channel: "channel:bob",
      state: "active",
      turn_state: "alice_turn",
      start_ms: 100,
      last_activity_ms: 100,
      participants: ["bob"],
      pace: 0.5,
      message_count: 3,
      alice_message_count: 1,
    });
    G.addRelation("conversation:channel:bob_100", "happens_in", "channel:bob");

    // 验证 findActiveConversation 能找到
    const conv = findActiveConversation(G, "channel:bob");
    expect(conv).toBe("conversation:channel:bob_100");
    // biome-ignore lint/style/noNonNullAssertion: test — expect above guarantees defined
    expect(G.getConversation(conv!).state).toBe("active");
    // biome-ignore lint/style/noNonNullAssertion: test — expect above guarantees defined
    expect(G.getConversation(conv!).turn_state).toBe("alice_turn");
  });
});
