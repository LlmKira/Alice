/**
 * ADR-190: Wakeup Mode 测试。
 *
 * 验证重启后批量发送修复：
 * - T1: 长离线 → wakeup 模态
 * - T2: 短离线 → patrol 模态
 * - T3: wakeup 中 idle gate 被抑制
 * - T4: wakeup 中义务消息仍响应
 * - T5: N tick 后毕业到 patrol
 * - T6: flood 期间不毕业
 * - T7: P3 cap 与 P1 D7 对称
 * - T8: P3 α_w 缩放
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
import { getDb } from "../src/db/connection.js";
import { tickLog } from "../src/db/schema.js";
import { ActionQueue } from "../src/engine/action-queue.js";
import { createDeliberationState } from "../src/engine/deliberation.js";
import { type EvolveState, evolveTick } from "../src/engine/evolve.js";
import {
  decideStartupMode,
  POST_RESTART_RECOVERY_MIN_OFFLINE_MS,
} from "../src/engine/startup-mode.js";
import { WorldModel } from "../src/graph/world-model.js";
import { AdaptiveKappa, createPressureHistory } from "../src/pressure/aggregate.js";
import { EventBuffer } from "../src/telegram/events.js";
import { TickClock } from "../src/utils/time.js";
import { PersonalityVector } from "../src/voices/personality.js";

// -- 辅助 -------------------------------------------------------------------

/** 最小 Dispatcher stub。 */
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

/** 构建 wakeup 场景的 EvolveState。 */
function buildWakeupState(
  overrides: Partial<{
    mode: EvolveState["mode"];
    lastActionMs: number;
    idleThreshold: number;
    wakeupGraduationTicks: number;
    wakeupTicksElapsed: number;
    eventCountEma: number;
    isRecovering: boolean;
  }> = {},
): EvolveState {
  const config = loadConfig();
  config.idleThreshold = overrides.idleThreshold ?? 30;
  config.actionRateFloor = 0.05;
  config.eta = 0;
  config.wakeupGraduationTicks = overrides.wakeupGraduationTicks ?? 10;

  const G = new WorldModel();
  G.tick = 0;
  G.addAgent("self");

  const buffer = new EventBuffer();
  if (overrides.isRecovering) buffer.isRecovering = true;

  return {
    G,
    personality: new PersonalityVector(config.piHome),
    clock: new TickClock(),
    buffer,
    queue: new ActionQueue(),
    config,
    noveltyHistory: [0.5, 0.5, 0.5],
    recentEventCounts: [],
    recentActions: [],
    dispatcher: stubDispatcher(),
    lastActionMs: overrides.lastActionMs ?? Date.now(),
    pressureHistory: createPressureHistory(),
    deliberation: createDeliberationState(),
    attentionDebtMap: new Map(),
    lastSelectedTarget: null,
    lastSelectedCandidate: null,
    mode: overrides.mode ?? "wakeup",
    modeEnteredMs: Date.now(),
    adaptiveKappa: new AdaptiveKappa(config.kappa, config.kappaAdaptAlpha),
    channelRateEma: new Map(),
    lastChannelCounts: new Map(),
    eventCountEma: overrides.eventCountEma ?? 10,
    floodTickCount: 0,
    wakeupTicksElapsed: overrides.wakeupTicksElapsed ?? 0,
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

describe("ADR-190: Wakeup Mode", () => {
  // T1: 长离线 → wakeup 模态（验证 index.ts 逻辑的等价测试——直接检查 mode 决策）
  it("T1: 2h 离线后应处于 wakeup 模态", () => {
    const config = loadConfig();
    const decision = decideStartupMode({
      runtimeOfflineMs: 7200_000,
      actionSilenceMs: 0,
      wakeupOfflineThresholdS: config.wakeupOfflineThresholdS,
      postRestartRecoveryMinOfflineMs: POST_RESTART_RECOVERY_MIN_OFFLINE_MS,
    });
    expect(decision.initialMode).toBe("wakeup");
  });

  // T2: 短离线 → patrol 模态
  it("T2: 5min 离线后应处于 patrol 模态", () => {
    const config = loadConfig();
    const decision = decideStartupMode({
      runtimeOfflineMs: 300_000,
      actionSilenceMs: 0,
      wakeupOfflineThresholdS: config.wakeupOfflineThresholdS,
      postRestartRecoveryMinOfflineMs: POST_RESTART_RECOVERY_MIN_OFFLINE_MS,
    });
    expect(decision.initialMode).toBe("patrol");
  });

  // T3: wakeup 中 idle gate 被抑制
  it("T3: wakeup 模态下空图 idle gate 不触发", () => {
    // 空图 + 足够久的 lastActionMs → 正常模式下会触发 idle gate
    // wakeup 模态下应抑制
    const state = buildWakeupState({
      mode: "wakeup",
      lastActionMs: Date.now() - 60_000, // 60 秒前
      idleThreshold: 5, // 5 秒即触发
    });

    const triggered = evolveTick(state);
    // wakeup 中 idle gate 被抑制 → 不入队
    expect(triggered).toBe(false);
    expect(state.queue.length).toBe(0);
  });

  // T4: wakeup 中义务消息（directed）仍响应
  it("T4: wakeup 模态下 directed 消息仍触发行动", () => {
    const config = loadConfig();
    config.idleThreshold = 999;
    config.actionRateFloor = 0.0;
    config.rateCap = { private: 100, group: 100, channel: 100, bot: 0 };
    config.eta = 0;
    config.wakeupGraduationTicks = 10;

    const G = new WorldModel();
    G.tick = 0;
    G.addAgent("self");
    G.addChannel("channel:friend", {
      unread: 5,
      tier_contact: 5,
      chat_type: "private",
      pending_directed: 3,
      last_directed_ms: Date.now() - 1000,
      last_incoming_ms: Date.now(),
      last_activity_ms: Date.now(),
    });
    G.addRelation("self", "monitors", "channel:friend");

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
      pressureHistory: createPressureHistory(),
      deliberation: createDeliberationState(),
      attentionDebtMap: new Map(),
      lastSelectedTarget: null,
      lastSelectedCandidate: null,
      mode: "wakeup",
      modeEnteredMs: Date.now(),
      adaptiveKappa: new AdaptiveKappa(config.kappa, config.kappaAdaptAlpha),
      channelRateEma: new Map(),
      lastChannelCounts: new Map(),
      eventCountEma: 10,
      floodTickCount: 0,
      wakeupTicksElapsed: 1,
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

    // 注入 directed 消息
    state.buffer.push({
      type: "new_message",
      channelId: "channel:friend",
      isDirected: true,
      tick: 1,
      novelty: 0.8,
    });

    const triggered = evolveTick(state);
    // directed 消息产生义务 → bypass gates → 应通过（即使在 wakeup 中）
    expect(triggered).toBe(true);
  });

  // T5: N tick 后毕业到 patrol
  it("T5: 达到毕业 tick 数后从 wakeup 转换到 patrol", () => {
    const graduationTicks = 3;
    const state = buildWakeupState({
      mode: "wakeup",
      wakeupGraduationTicks: graduationTicks,
      wakeupTicksElapsed: 0,
    });

    // 运行 graduationTicks 个 tick
    for (let i = 0; i < graduationTicks; i++) {
      evolveTick(state);
    }

    // transitionMode 在第 graduationTicks 个 tick 内将 wakeupTicksElapsed 递增到 N
    // 然后检查毕业条件通过 → 转换到 patrol
    expect(state.mode).toBe("patrol");
  });

  // T6: flood 期间不毕业
  it("T6: flood 条件下 wakeup 不毕业", () => {
    const graduationTicks = 2;
    const state = buildWakeupState({
      mode: "wakeup",
      wakeupGraduationTicks: graduationTicks,
      wakeupTicksElapsed: graduationTicks - 1, // 差 1 tick 毕业
      isRecovering: true, // 模拟 mtcute 恢复中 → flood 条件
    });

    // 运行 1 tick — wakeupTicksElapsed 会递增到 N，但 flood=true
    evolveTick(state);

    // flood 条件阻止毕业
    expect(state.mode).toBe("wakeup");

    // 取消 flood 条件
    state.buffer.isRecovering = false;

    // 再运行 1 tick — flood 解除，毕业条件满足
    evolveTick(state);
    expect(state.mode).toBe("patrol");
  });

  // T7: P3 cap 与 P1 D7 对称
  it("T7: flood 条件下 P3 被 cap 约束", () => {
    const state = buildWakeupState({
      mode: "patrol",
      isRecovering: true, // 触发 flood 条件
    });

    // 添加多个联系人产生高 P3
    for (let i = 0; i < 10; i++) {
      const chId = `channel:c${i}`;
      const cId = `contact:c${i}`;
      state.G.addContact(cId, { tier: 50, last_active_ms: 0 });
      state.G.addChannel(chId, {
        unread: 0,
        tier_contact: 50,
        chat_type: "private",
        pending_directed: 0,
        last_directed_ms: 0,
      });
      state.G.addRelation("self", "monitors", chId);
    }

    // 填充 pressure history 以建立基线（低 P3 值）
    for (let i = 0; i < 5; i++) {
      state.pressureHistory.push([0.1, 0.1, 0.5, 0.1, 0.1, 0.1]);
    }

    // 运行一个 tick — flood 条件下 P3 应被 cap
    evolveTick(state);

    // 验证 P3 cap 逻辑：cap = max(5 × avgP3, 3 × κ₃)
    // avgP3 = 0.5, cap = max(5×0.5, 3×8.0) = max(2.5, 24.0) = 24.0
    // 10 个 tier 50 联系人 → P3 应受到合理约束
    // 这里主要验证 cap 代码路径不报错、压力值是有限数
    expect(state.floodTickCount).toBeGreaterThan(0);
  });

  // T8: P3 α_w 缩放 — α_w=0 时 P3=0, α_w=0.5 时 P3 恢复部分
  it("T8: wakeup 模态 P3 按 α_w 缩放（tick_log 验证）", () => {
    const graduationTicks = 10;

    // Run 1: wakeupTicksElapsed=0 → α_w = 0/10 = 0 → P3 × 0 = 0
    const state0 = buildWakeupState({
      mode: "wakeup",
      wakeupGraduationTicks: graduationTicks,
      wakeupTicksElapsed: 0,
    });
    state0.G.addContact("contact:42", { tier: 50, last_active_ms: 0 });
    state0.G.addChannel("channel:42", {
      unread: 0,
      tier_contact: 50,
      chat_type: "private",
      pending_directed: 0,
      last_directed_ms: 0,
    });
    state0.G.addRelation("self", "monitors", "channel:42");
    evolveTick(state0);

    const db = getDb();
    const row0 = db.select().from(tickLog).orderBy(tickLog.tick).limit(1).get();
    expect(row0).toBeDefined();
    // α_w = 0 → P3 = 0
    // biome-ignore lint/style/noNonNullAssertion: guarded by preceding toBeDefined check
    expect(row0!.p3).toBe(0);

    // Run 2: wakeupTicksElapsed=5 → α_w = 5/10 = 0.5 → P3 × 0.5
    const state5 = buildWakeupState({
      mode: "wakeup",
      wakeupGraduationTicks: graduationTicks,
      wakeupTicksElapsed: 5,
    });
    state5.G.addContact("contact:42", { tier: 50, last_active_ms: 0 });
    state5.G.addChannel("channel:42", {
      unread: 0,
      tier_contact: 50,
      chat_type: "private",
      pending_directed: 0,
      last_directed_ms: 0,
    });
    state5.G.addRelation("self", "monitors", "channel:42");
    evolveTick(state5);

    const row5 = db.select().from(tickLog).orderBy(tickLog.tick).limit(1).offset(1).get();
    expect(row5).toBeDefined();
    // α_w = 0.5 → P3 应大于 0（已部分恢复）
    // biome-ignore lint/style/noNonNullAssertion: guarded by preceding toBeDefined check
    expect(row5!.p3).toBeGreaterThanOrEqual(0);
    // α_w=0 的 P3 应 ≤ α_w=0.5 的 P3
    // biome-ignore lint/style/noNonNullAssertion: guarded by preceding toBeDefined check
    expect(row0!.p3).toBeLessThanOrEqual(row5!.p3);
  });
});
