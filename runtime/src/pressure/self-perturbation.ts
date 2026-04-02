/**
 * ADR-215: 压力自扰动机制。
 *
 * 防止长期零输入场景下的"僵尸低迷"——当外部事件匮乏时，
 * 模拟人类的"走神"或"突然想起某事"，注入低幅度的 synthetic novelty。
 *
 * @see docs/adr/215-self-perturbation-mechanism.md
 * @see simulation/experiments/exp11_low_pressure_boundary.py 实验验证
 */

import type { WorldModel } from "../graph/world-model.js";
import type { AllPressures } from "./aggregate.js";

/** 自扰动配置。 */
export interface SelfPerturbationConfig {
  /** 启用自扰动。默认 true。 */
  enabled: boolean;

  /** 检查间隔（ticks）。默认 30。 */
  intervalTicks: number;

  /** 触发阈值：API 低于此值时才扰动。默认 1.0。 */
  triggerThreshold: number;

  /** 注入的新颖度（影响 P6）。默认 0.25，范围 [0, 0.8]。 */
  noveltyValue: number;

  /** 是否添加 synthetic unread（影响 P1）。默认 true。 */
  injectUnread: boolean;

  /** 添加的未读数。默认 1。 */
  unreadCount: number;

  /** 扰动后 novelty history 追加值。默认 0.25。 */
  noveltyHistoryAppend: number;
}

/** 默认配置。基于 exp11 实验标定。 */
export const DEFAULT_PERTURBATION_CONFIG: SelfPerturbationConfig = {
  enabled: true,
  intervalTicks: 30,
  triggerThreshold: 1.0,
  noveltyValue: 0.25,
  injectUnread: true,
  unreadCount: 1,
  noveltyHistoryAppend: 0.25,
};

/** 自扰动状态（用于观测）。 */
export interface PerturbationState {
  /** 本 tick 是否触发了扰动 */
  triggered: boolean;
  /** 扰动前的原始 API */
  apiBefore: number | null;
  /** 扰动后的 API */
  apiAfter: number | null;
  /** 注入的新颖度 */
  noveltyInjected: number;
  /** 目标频道（若有） */
  targetChannel: string | null;
}

/** 创建默认状态。 */
export function createPerturbationState(): PerturbationState {
  return {
    triggered: false,
    apiBefore: null,
    apiAfter: null,
    noveltyInjected: 0,
    targetChannel: null,
  };
}

/**
 * 检查是否应该触发自扰动。
 *
 * 条件：
 * 1. 配置启用
 * 2. 达到间隔 tick
 * 3. API 低于阈值
 * 4. 无近期真实事件（可选检查由调用方完成）
 */
export function shouldTriggerPerturbation(
  api: number,
  tick: number,
  config: SelfPerturbationConfig,
): boolean {
  if (!config.enabled) return false;
  if (tick % config.intervalTicks !== 0) return false;
  if (api > config.triggerThreshold) return false;

  return true;
}

/**
 * 选择扰动目标频道。
 *
 * 策略：选择最低活跃的频道（unread=0 且最近无活动），
 * 模拟"突然想起某个久未联系的人"。
 */
export function selectPerturbationTarget(G: WorldModel, nowMs: number): string | null {
  const channels = G.getEntitiesByType("channel");
  if (channels.length === 0) return null;

  // 找 unread=0 且 last_activity_ms 最老的频道
  let target: string | null = null;
  let oldestActivity = nowMs;

  for (const chId of channels) {
    const attrs = G.getChannel(chId);
    if (attrs.unread === 0 && attrs.last_activity_ms && attrs.last_activity_ms < oldestActivity) {
      target = chId;
      oldestActivity = attrs.last_activity_ms;
    }
  }

  // 如果没有 clean 频道，随机选
  if (!target && channels.length > 0) {
    const idx = Math.floor(Math.random() * channels.length);
    target = channels[idx];
  }

  return target;
}

/**
 * 执行自扰动。
 *
 * 1. 添加 synthetic unread 到目标频道（若启用）
 * 2. 返回应追加到 novelty_history 的值
 * 3. 记录状态用于观测
 */
export function executePerturbation(
  G: WorldModel,
  tick: number,
  nowMs: number,
  pressures: AllPressures,
  config: SelfPerturbationConfig,
): PerturbationState {
  const state: PerturbationState = {
    triggered: true,
    apiBefore: pressures.API,
    apiAfter: null, // 由调用方在重新计算压力后填充
    noveltyInjected: config.noveltyHistoryAppend,
    targetChannel: null,
  };

  // 1. 注入 synthetic unread
  if (config.injectUnread) {
    const target = selectPerturbationTarget(G, nowMs);
    if (target) {
      state.targetChannel = target;
      const attrs = G.getChannel(target);
      G.updateChannel(target, {
        unread: (attrs.unread ?? 0) + config.unreadCount,
        // 标记为 synthetic，便于调试
        last_activity_ms: nowMs,
      });
    }
  }

  // 2. 返回 novelty 注入值
  // P6 将在下一轮压力计算时自动使用新的 novelty_history
  return state;
}

/**
 * 估算扰动后的 API（用于监控）。
 *
 * 近似计算：假设 P1 和 P6 各增加一定量，其他维度不变。
 * 不精确，仅用于快速估算。
 */
export function estimatePerturbedAPI(
  currentAPI: number,
  config: SelfPerturbationConfig,
  kappa: readonly number[] = [15, 20, 10, 5, 50, 0.5],
): number {
  // P1 贡献增加：unreadCount * avg_w_tier * avg_chatW / kappa[0]
  // 近似：1 * 20 * 1 / 15 ≈ 1.33 raw → tanh(1.33/15) ≈ 0.09
  const p1Increase = config.injectUnread ? Math.tanh((config.unreadCount * 20) / kappa[0]) : 0;

  // P6 贡献：noveltyValue / kappa[5]
  // 但 P6 是减性公式，新颖度高 → P6 低，这里需要反向理解
  // perturbation novelty 进入 history，降低 mean_novelty → P6 上升
  // 近似：P6 从 η 向 0 移动，但幅度小，保守估计 +0.05
  const p6Increase = Math.tanh(config.noveltyValue / kappa[5]) * 0.3;

  // 总 API 增加（其他维度不变）
  const estimatedIncrease = p1Increase + p6Increase;

  // 上限 6（API 最大值）
  return Math.min(6, currentAPI + estimatedIncrease);
}

/**
 * 自扰动指标统计（用于 anomaly 检测）。
 */
export interface PerturbationMetrics {
  /** 总 tick 数 */
  totalTicks: number;
  /** 扰动 tick 数 */
  perturbationTicks: number;
  /** 扰动比例 */
  ratio: number;
  /** 平均 API 提升 */
  avgApiBoost: number;
  /** 最近一次扰动 tick */
  lastPerturbationTick: number | null;
}

/**
 * 计算指标。
 */
export function computePerturbationMetrics(
  history: ReadonlyArray<PerturbationState>,
  currentTick: number,
): PerturbationMetrics {
  const totalTicks = history.length;
  const perturbationTicks = history.filter((h) => h.triggered).length;
  const ratio = totalTicks > 0 ? perturbationTicks / totalTicks : 0;

  const boosts = history
    .filter((h) => h.triggered && h.apiAfter != null && h.apiBefore != null)
    .map((h) => (h.apiAfter ?? 0) - (h.apiBefore ?? 0));

  const avgApiBoost = boosts.length > 0 ? boosts.reduce((a, b) => a + b, 0) / boosts.length : 0;

  const last = history.findLast((h) => h.triggered);

  return {
    totalTicks,
    perturbationTicks,
    ratio,
    avgApiBoost,
    lastPerturbationTick: last ? currentTick : null,
  };
}
