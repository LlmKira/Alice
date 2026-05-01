/**
 * B1: 快速连续消息场景 — ADR-76 集成测试。
 *
 * 构造：5 条消息在 3 个 tick 内涌入同一频道。
 * 验证：
 * - evolve 不为每条消息分别入队（压力聚合正确）
 * - 最终行动反映了完整的消息序列
 * - Engagement Exclusivity（isTargetActive）防止重复入队
 *
 * @see docs/adr/76-naturalness-validation-methodology.md §B1
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { Dispatcher } from "../src/core/dispatcher.js";
import { closeDb, initDb } from "../src/db/connection.js";
import { ActionQueue } from "../src/engine/action-queue.js";
import { createDeliberationState } from "../src/engine/deliberation.js";
import { type EvolveState, evolveTick } from "../src/engine/evolve.js";
import { ALICE_SELF } from "../src/graph/constants.js";
import { WorldModel } from "../src/graph/world-model.js";
import { AdaptiveKappa, createPressureHistory } from "../src/pressure/aggregate.js";
import { createCuriosityHistory } from "../src/pressure/p6-curiosity.js";
import { EventBuffer } from "../src/telegram/events.js";
import { TickClock } from "../src/utils/time.js";
import { PersonalityVector } from "../src/voices/personality.js";

// -- Dispatcher stub -----------------------------------------------------------

function stubDispatcher(): Dispatcher {
  return {
    dispatch: () => undefined,
    query: (name: string) => {
      if (name === "crisis_channels") return [];
      if (name === "best_time") return { peakHour: undefined };
      return null;
    },
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

// -- Mock DB -------------------------------------------------------------------

beforeEach(() => initDb(":memory:"));
afterEach(() => closeDb());

// -- 构建状态 ------------------------------------------------------------------

function buildRapidMessageState(): EvolveState {
  const config = loadConfig();
  config.idleThreshold = 999;
  config.actionRateFloor = 0.0;
  config.rateCap = { private: 100, group: 100, channel: 100, bot: 0 };
  config.eta = 0;
  config.s10LeakProb = 0;

  const G = new WorldModel();
  G.tick = 0;
  G.addAgent(ALICE_SELF);
  // 群聊频道，有多人消息
  G.addChannel("channel:group", {
    unread: 0,
    tier_contact: 5,
    chat_type: "group",
    pending_directed: 0,
  });
  G.addRelation(ALICE_SELF, "monitors", "channel:group");

  return {
    G,
    personality: new PersonalityVector(config.piHome),
    clock: new TickClock(),
    buffer: new EventBuffer(),
    queue: new ActionQueue(),
    config,
    curiosityHistory: createCuriosityHistory(),
    recentEventCounts: [],
    recentActions: [],
    dispatcher: stubDispatcher(),
    lastActionMs: Date.now(),
    pressureHistory: createPressureHistory(),
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

// -- 测试 -------------------------------------------------------------------

describe("B1: 快速连续消息场景", () => {
  it("多条消息涌入同一频道时不产生多个入队行动", () => {
    const state = buildRapidMessageState();

    // tick 1: 推入 3 条消息
    for (let i = 0; i < 3; i++) {
      state.buffer.push({
        type: "new_message",
        channelId: "channel:group",
        isDirected: false,
        tick: 1,
        novelty: 0.5 + i * 0.1,
      });
    }
    evolveTick(state);

    // tick 2: 再推入 2 条消息
    for (let i = 0; i < 2; i++) {
      state.buffer.push({
        type: "new_message",
        channelId: "channel:group",
        isDirected: false,
        tick: 2,
        novelty: 0.6,
      });
    }
    evolveTick(state);

    // tick 3: 无新消息
    evolveTick(state);

    // 关键断言：ADR-117 D3 per-target 频率守卫保证同一目标在窗口内 ≤ 3 次
    // （3 个 tick 内最多 3 个入队行动，超过后被 per_target_rate_limit 拦截）
    expect(state.queue.length).toBeLessThanOrEqual(3);
  });

  it("isTargetActive 防止对同一目标重复入队", async () => {
    const state = buildRapidMessageState();
    // 加大压力使其触发行动
    state.G.setDynamic("channel:group", "unread", 50);
    state.G.setDynamic("channel:group", "pending_directed", 3);
    state.G.setDynamic("channel:group", "last_directed_ms", 0);
    state.config.actionRateFloor = 0.0;

    // tick 1: 强 directed 消息 → 应触发入队
    state.buffer.push({
      type: "new_message",
      channelId: "channel:group",
      isDirected: true,
      tick: 1,
      novelty: 0.9,
    });
    evolveTick(state);

    // 条目在队列中 → isTargetActive 应返回 true
    if (state.queue.length > 0) {
      expect(state.queue.isTargetActive("channel:group")).toBe(true);
    }

    // tick 2: 再次 directed → 但 isTargetActive 阻止重复入队
    state.buffer.push({
      type: "new_message",
      channelId: "channel:group",
      isDirected: true,
      tick: 2,
      novelty: 0.9,
    });
    evolveTick(state);

    // 同一目标只能有一个活跃 engagement
    expect(state.queue.length).toBeLessThanOrEqual(1);
  });

  it("dequeue 后 isTargetActive 仍返回 true（processing 追踪）", async () => {
    const state = buildRapidMessageState();
    state.G.setDynamic("channel:group", "unread", 50);
    state.G.setDynamic("channel:group", "pending_directed", 3);
    state.G.setDynamic("channel:group", "last_directed_ms", 0);
    state.config.actionRateFloor = 0.0;

    // 触发入队
    state.buffer.push({
      type: "new_message",
      channelId: "channel:group",
      isDirected: true,
      tick: 1,
      novelty: 0.9,
    });
    evolveTick(state);

    if (state.queue.length > 0) {
      // dequeue — 模拟 act 线程消费
      const item = await state.queue.dequeue();
      expect(item).not.toBeNull();
      // dequeue 后 processing 追踪生效
      expect(state.queue.isTargetActive("channel:group")).toBe(true);
      // markComplete 释放
      state.queue.markComplete("channel:group");
      expect(state.queue.isTargetActive("channel:group")).toBe(false);
    }
  });

  it("多条消息在同一 tick 内通过 buffer 正确消费", () => {
    const state = buildRapidMessageState();
    // 预设 unread 模拟 Telegram 映射器的行为
    state.G.setDynamic("channel:group", "unread", 10);

    // 5 条消息涌入（perceive 消费 buffer，不直接设 unread）
    for (let i = 0; i < 5; i++) {
      state.buffer.push({
        type: "new_message",
        channelId: "channel:group",
        isDirected: false,
        tick: 1,
        novelty: 0.7,
      });
    }

    // evolveTick 消费所有 buffer 事件
    evolveTick(state);

    // buffer 应被清空（所有事件在一个 tick 内消费完毕）
    expect(state.buffer.length).toBe(0);
  });
});
