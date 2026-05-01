/**
 * ADR-225: Dormant Mode 测试。
 *
 * 验证 Alice 的睡眠节律：
 * - T1: quiet window 判断（跨午夜 + 不跨午夜）
 * - T2: patrol → dormant 入睡条件
 * - T3: dormant 中 idle gate 被抑制
 * - T4: dormant → wakeup（quiet window 结束 — 自然醒）
 * - T5: dormant → wakeup（亲密联系人 directed — 被叫醒）
 * - T6: dormant 期间压力调制 ×0.1
 * - T7: conversation 模式不会进入 dormant（不打断活跃对话）
 * - T8: dormant 中 clockGenerator 被跳过
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
import { type EvolveState, evolveTick } from "../src/engine/evolve.js";
import { WorldModel } from "../src/graph/world-model.js";
import { AdaptiveKappa, createPressureHistory } from "../src/pressure/aggregate.js";
import { createCuriosityHistory } from "../src/pressure/p6-curiosity.js";
import { DORMANT_PRESSURE_FACTOR, isInQuietWindow } from "../src/pressure/signal-decay.js";
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

function buildDormantState(
  overrides: Partial<{
    mode: EvolveState["mode"];
    lastActionMs: number;
    idleThreshold: number;
    quietWindowStart: number;
    quietWindowEnd: number;
    thetaDormantAPI: number;
    dormantWakeTier: number;
  }> = {},
): EvolveState {
  const config = loadConfig();
  config.idleThreshold = overrides.idleThreshold ?? 30;
  config.actionRateFloor = 0.05;
  config.eta = 0;
  config.quietWindowStart = overrides.quietWindowStart ?? 23;
  config.quietWindowEnd = overrides.quietWindowEnd ?? 7;
  config.thetaDormantAPI = overrides.thetaDormantAPI ?? 0.15;
  config.dormantWakeTier = overrides.dormantWakeTier ?? 150;

  const G = new WorldModel();
  G.tick = 0;
  G.addAgent("self");

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
    lastActionMs: overrides.lastActionMs ?? Date.now(),
    pressureHistory: createPressureHistory(),
    deliberation: createDeliberationState(),
    attentionDebtMap: new Map(),
    lastSelectedTarget: null,
    lastSelectedCandidate: null,
    mode: overrides.mode ?? "dormant",
    modeEnteredMs: Date.now(),
    adaptiveKappa: new AdaptiveKappa(config.kappa, config.kappaAdaptAlpha),
    channelRateEma: new Map(),
    lastChannelCounts: new Map(),
    eventCountEma: 10,
    floodTickCount: 0,
    wakeupTicksElapsed: 0,
    wakeupEngagedTargets: new Set(),
    lastAPI: 0,
    lastAPIPeak: 0,
    lastFlushMs: 0,
    currentDt: 60,
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

describe("ADR-225: Dormant Mode", () => {
  // T1: quiet window 判断
  describe("T1: isInQuietWindow", () => {
    it("跨午夜 23-7: 凌晨 2 点在 window 内", () => {
      expect(isInQuietWindow(2, 23, 7)).toBe(true);
    });

    it("跨午夜 23-7: 23 点在 window 内", () => {
      expect(isInQuietWindow(23, 23, 7)).toBe(true);
    });

    it("跨午夜 23-7: 7 点不在 window 内（半开区间）", () => {
      expect(isInQuietWindow(7, 23, 7)).toBe(false);
    });

    it("跨午夜 23-7: 中午 12 点不在 window 内", () => {
      expect(isInQuietWindow(12, 23, 7)).toBe(false);
    });

    it("跨午夜 23-7: 22 点不在 window 内", () => {
      expect(isInQuietWindow(22, 23, 7)).toBe(false);
    });

    it("不跨午夜 1-6: 3 点在 window 内", () => {
      expect(isInQuietWindow(3, 1, 6)).toBe(true);
    });

    it("不跨午夜 1-6: 0 点不在 window 内", () => {
      expect(isInQuietWindow(0, 1, 6)).toBe(false);
    });

    it("不跨午夜 1-6: 6 点不在 window 内（���开区间）", () => {
      expect(isInQuietWindow(6, 1, 6)).toBe(false);
    });
  });

  // T2: patrol → dormant 入睡条件
  it("T2: quiet window + 低 API → patrol 应转入 dormant", () => {
    // 设置时区偏移使当前 UTC 时间落在 quiet window 内
    const now = Date.now();
    const utcHour = new Date(now).getUTCHours();
    // 制造 quiet window: 让 localHour = utcHour + offset 落在 23-7 之间
    // 简化：直接用 localHour = 2（凌晨 2 点）
    const desiredLocalHour = 2;
    const offset = (((desiredLocalHour - utcHour) % 24) + 24) % 24;

    const state = buildDormantState({
      mode: "patrol",
      quietWindowStart: 23,
      quietWindowEnd: 7,
      thetaDormantAPI: 0.15,
    });
    state.config.timezoneOffset = offset;
    // 注入 utcHour 以便 circadianMultiplier 使用
    state.utcHour = utcHour;

    // 空图 + 无压力 → API ≈ 0 < 0.15
    evolveTick(state);
    expect(state.mode).toBe("dormant");
  });

  // T3: dormant 中 idle gate 被抑制
  it("T3: dormant 模态下 idle gate 不触发", () => {
    const state = buildDormantState({
      mode: "dormant",
      lastActionMs: Date.now() - 60_000, // 60 秒前
      idleThreshold: 5, // 5 秒即触发
    });
    // 让 transitionMode 保持 dormant：需要在 quiet window 内
    const utcHour = new Date().getUTCHours();
    const desiredLocalHour = 2;
    state.config.timezoneOffset = (((desiredLocalHour - utcHour) % 24) + 24) % 24;

    const triggered = evolveTick(state);
    expect(triggered).toBe(false);
    expect(state.queue.length).toBe(0);
  });

  // T4: dormant → wakeup（quiet window 结束）
  it("T4: quiet window 外 dormant 应自然醒 → wakeup", () => {
    const now = Date.now();
    const utcHour = new Date(now).getUTCHours();
    // 让 localHour = 10（上午 10 点，在 quiet window 外）
    const desiredLocalHour = 10;
    const offset = (((desiredLocalHour - utcHour) % 24) + 24) % 24;

    const state = buildDormantState({ mode: "dormant" });
    state.config.timezoneOffset = offset;

    evolveTick(state);
    expect(state.mode).toBe("wakeup");
    expect(state.wakeupTicksElapsed).toBe(0);
  });

  // T5: dormant → wakeup（亲密联系人 directed 消息）
  it("T5: 亲密联系人 directed 消息应唤醒 dormant Alice", () => {
    const now = Date.now();
    const utcHour = new Date(now).getUTCHours();
    // 保持在 quiet window 内
    const desiredLocalHour = 2;
    const offset = (((desiredLocalHour - utcHour) % 24) + 24) % 24;

    const state = buildDormantState({
      mode: "dormant",
      dormantWakeTier: 150,
    });
    state.config.timezoneOffset = offset;

    // 添加亲密联系人的频道，有 directed 消息
    state.G.addChannel("channel:telegram:bestfriend", {
      unread: 3,
      tier_contact: 5, // tier 5 = 亲密
      chat_type: "private",
      pending_directed: 2,
      last_directed_ms: Date.now() - 500,
      last_incoming_ms: Date.now(),
      last_activity_ms: Date.now(),
    });
    state.G.addContact("contact:telegram:bestfriend", {
      tier: 5,
      display_name: "BestFriend",
    });
    state.G.addRelation("self", "monitors", "channel:telegram:bestfriend");
    state.G.addRelation("channel:telegram:bestfriend", "belongs_to", "contact:telegram:bestfriend");

    evolveTick(state);
    expect(state.mode).toBe("wakeup");
  });

  // T5b: 非亲密联系人不唤醒
  it("T5b: tier 500 联系人的 directed 消息不唤醒 dormant Alice", () => {
    const now = Date.now();
    const utcHour = new Date(now).getUTCHours();
    const desiredLocalHour = 2;
    const offset = (((desiredLocalHour - utcHour) % 24) + 24) % 24;

    const state = buildDormantState({
      mode: "dormant",
      dormantWakeTier: 150,
    });
    state.config.timezoneOffset = offset;

    state.G.addChannel("channel:telegram:stranger", {
      unread: 3,
      tier_contact: 500,
      chat_type: "private",
      pending_directed: 2,
      last_directed_ms: Date.now() - 500,
      last_incoming_ms: Date.now(),
      last_activity_ms: Date.now(),
    });
    state.G.addContact("contact:telegram:stranger", {
      tier: 500,
      display_name: "Stranger",
    });
    state.G.addRelation("self", "monitors", "channel:telegram:stranger");
    state.G.addRelation("channel:telegram:stranger", "belongs_to", "contact:telegram:stranger");

    evolveTick(state);
    // 应保持 dormant
    expect(state.mode).toBe("dormant");
  });

  // T6: dormant 压力调制
  it("T6: DORMANT_PRESSURE_FACTOR 应为 0.1", () => {
    expect(DORMANT_PRESSURE_FACTOR).toBe(0.1);
  });

  // T7: conversation 模式不入 dormant
  it("T7: conversation 模式即使在 quiet window 也不入 dormant", () => {
    const now = Date.now();
    const utcHour = new Date(now).getUTCHours();
    const desiredLocalHour = 2;
    const offset = (((desiredLocalHour - utcHour) % 24) + 24) % 24;

    const state = buildDormantState({
      mode: "conversation",
    });
    state.config.timezoneOffset = offset;

    // 添加一个有 directed 消息的频道作为 focus target
    state.G.addChannel("channel:friend", {
      unread: 5,
      tier_contact: 5,
      chat_type: "private",
      pending_directed: 3,
      last_directed_ms: Date.now() - 1000,
      last_incoming_ms: Date.now(),
      last_activity_ms: Date.now(),
    });
    state.G.addRelation("self", "monitors", "channel:friend");
    state.focusTarget = "channel:friend";

    evolveTick(state);
    // conversation 模式无 dormant 入口，应保持 conversation 或转 patrol
    expect(state.mode).not.toBe("dormant");
  });
});
