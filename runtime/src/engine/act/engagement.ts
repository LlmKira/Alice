/**
 * ADR-107: 浏览会话辅助函数 — 压力估算、等待回复、脚本执行结果合并。
 *
 * ADR-214 Wave A: 删除 actions/instructions/lastSilenceReason（死字段）。
 * shell-native 架构下 RecordedAction 管线始终为空。
 *
 * @see docs/adr/107-engagement-session/README.md
 */
import {
  emptyScriptExecutionResult,
  mergeScriptExecutionResults,
  type ScriptExecutionResult,
} from "../../core/script-execution.js";
import { CHAT_TYPE_WEIGHTS, DUNBAR_TIER_WEIGHT, PRESSURE_SPECS } from "../../graph/constants.js";
import type { WorldModel } from "../../graph/world-model.js";
// ADR-222: CONVERSATION_INERTIA_BOOST 已删除。Continuation 使用固定系数 0.67（≈ 旧 1/1.5）。
import type { GraphPerturbation } from "../../telegram/mapper.js";
import type { ActContext } from "../react/orchestrator.js";
import type { SubcycleResult } from "../react/types.js";

// ── EngagementSession: 替代 loop.ts 中 10 个并行变量 ────────────────

/**
 * ADR-107: 浏览会话状态容器。
 * ADR-214 Wave A: 删除 actions/instructions/lastSilenceReason/pendingActions/markAllExecuted。
 */
export class EngagementSession {
  execution: ScriptExecutionResult = emptyScriptExecutionResult();
  totalDuration = 0;
  errorCount = 0;
  subcycle = 0;
  elapsed = 0;
  outcome:
    | "complete"
    | "timeout"
    | "preempted"
    | "limit"
    | "llm_failed"
    | "observation_empty"
    | "resting"
    | "fed_up"
    | "cooling_down" = "complete";
  /** 可参数化 subcycle 上限（群聊收束用）。 */
  private readonly _maxSubcycles: number;

  constructor(maxSubcycles: number = MAX_SUBCYCLES) {
    this._maxSubcycles = maxSubcycles;
  }

  /** ADR-235: 最后一次 TC 循环的可观测性元数据。 */
  lastTcMeta?: SubcycleResult["tcMeta"];
  /** 最近一次 LLM 调用失败分类。 */
  failureKind?: SubcycleResult["failureKind"];

  /** 吸收一个子周期的结果到 engagement 级累积。 */
  absorb(sub: SubcycleResult): void {
    this.execution = mergeScriptExecutionResults([this.execution, sub.execution]);
    this.errorCount += sub.execution.errors.length;
    this.totalDuration += sub.duration;
    if (sub.tcMeta) this.lastTcMeta = sub.tcMeta;
    if (sub.failureKind) this.failureKind = sub.failureKind;
  }

  /** 检查 engagement 是否可以继续（未超出子周期/时长上限）。 */
  canContinue(): boolean {
    return this.subcycle < this._maxSubcycles && this.elapsed < MAX_ENGAGEMENT_DURATION;
  }

  /** 将累积数据合并为 ScriptExecutionResult（用于 processResult 审计）。 */
  toMergedResult(): ScriptExecutionResult {
    return this.execution;
  }
}

// ── ADR-107: 浏览会话常量 ──────────────────────────────────────
// @see docs/adr/107-engagement-session/README.md §设计常量
export const MAX_ENGAGEMENT_DURATION = 180_000; // 单次浏览会话最大时长 (3 min)
export const EXPECT_REPLY_TIMEOUT = 60_000; // 单次 expect_reply 等待上限 (60s)
export const STAY_TIMEOUT = 15_000; // stay 观望最长等待 (15s)
export const PREEMPTION_FACTOR = 1.5; // 抢占阈值：新事件紧急度 / 当前 hold 的比值
const TYPING_EXTENSION = 15_000; // 每次 typing 延长 15s
const MAX_TYPING_EXTEND_FACTOR = 2; // 最多延长到原始超时的 2 倍
export const MAX_SUBCYCLES = 5; // 单次浏览会话最大子周期数

/**
 * ADR-107: 快速估算单个事件的紧急度。O(1)，不扫描全图。
 * 用于浏览会话期间判断是否被更紧急的事件抢占。
 *
 * @see paper/ §7.5 Proposition (Quick Pressure Estimate)
 * @see docs/adr/107-engagement-session/README.md §preemption
 */
export function quickPressureEstimate(G: WorldModel, event: GraphPerturbation): number {
  let wTier = DUNBAR_TIER_WEIGHT[150];
  let wResponse = CHAT_TYPE_WEIGHTS.group.response;
  let wAttention = CHAT_TYPE_WEIGHTS.group.attention;

  const channelId = event.channelId;
  if (channelId && G.has(channelId)) {
    const attrs = G.getChannel(channelId);
    wTier =
      (DUNBAR_TIER_WEIGHT as Record<number, number>)[attrs.tier_contact as number] ??
      DUNBAR_TIER_WEIGHT[150];
    const chatType = (attrs.chat_type as string) ?? "group";
    wResponse = CHAT_TYPE_WEIGHTS[chatType]?.response ?? 1.0;
    wAttention = CHAT_TYPE_WEIGHTS[chatType]?.attention ?? 1.0;
  }

  if (event.isDirected) {
    return wTier * wResponse;
  }

  if (event.isContinuation) {
    // ADR-222: continuation 权重 = directed × 0.67（保持旧 1/1.5 ≈ 0.67 的数值连续性）
    return wTier * wResponse * 0.67;
  }

  const kappaSensitivity = PRESSURE_SPECS.P5.kappaMin / PRESSURE_SPECS.P1.kappaMin;
  return wTier * wAttention * kappaSensitivity;
}

/**
 * ADR-108: Listen-First — 将 watcher 注册与 await 拆分为两阶段。
 */
export interface WatchResult {
  type: "reply" | "interrupt" | "timeout" | "activity";
  elapsed: number;
}

export function prepareEngagementWatch(
  ctx: ActContext,
  targetChannelId: string,
  holdStrength: number,
  opts?: { typingAware?: boolean },
): {
  await: (timeout: number) => Promise<WatchResult>;
  cancel: () => void;
} {
  const replyWatch = ctx.buffer.watch(
    (e) => e.type === "new_message" && e.channelId === targetChannelId && !e.senderIsBot,
  );
  const interruptWatch = ctx.buffer.watch(
    (e) =>
      e.type === "new_message" &&
      e.channelId !== targetChannelId &&
      quickPressureEstimate(ctx.G, e) > holdStrength * PREEMPTION_FACTOR,
  );

  return {
    async await(timeout: number) {
      const start = Date.now();
      let deadline = start + timeout;
      const maxDeadline = start + timeout * MAX_TYPING_EXTEND_FACTOR;

      if (!opts?.typingAware) {
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<null>((resolve) => {
          timeoutHandle = setTimeout(() => resolve(null), timeout);
        });
        try {
          const result = await Promise.race([
            replyWatch.promise.then(() => ({ type: "reply" as const })),
            interruptWatch.promise.then(() => ({ type: "interrupt" as const })),
            timeoutPromise.then(() => ({ type: "timeout" as const })),
          ]);
          return { type: result.type, elapsed: Date.now() - start };
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          replyWatch.cancel();
          interruptWatch.cancel();
        }
      }

      try {
        while (true) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) return { type: "timeout", elapsed: Date.now() - start };

          const typingWatch = ctx.buffer.watch(
            (e) => e.type === "typing" && e.channelId === targetChannelId,
          );

          let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise<null>((resolve) => {
            timeoutHandle = setTimeout(() => resolve(null), remaining);
          });

          const result = await Promise.race([
            replyWatch.promise.then(() => ({ type: "reply" as const })),
            interruptWatch.promise.then(() => ({ type: "interrupt" as const })),
            typingWatch.promise.then(() => ({ type: "typing" as const })),
            timeoutPromise.then(() => ({ type: "timeout" as const })),
          ]);

          if (timeoutHandle) clearTimeout(timeoutHandle);
          typingWatch.cancel();

          if (result.type === "typing") {
            deadline = Math.min(Date.now() + TYPING_EXTENSION, maxDeadline);
            continue;
          }

          return { type: result.type, elapsed: Date.now() - start };
        }
      } finally {
        replyWatch.cancel();
        interruptWatch.cancel();
      }
    },
    cancel() {
      replyWatch.cancel();
      interruptWatch.cancel();
    },
  };
}

export function prepareStayWatch(
  ctx: ActContext,
  targetChannelId: string,
  holdStrength: number,
): {
  await: (timeout: number) => Promise<WatchResult>;
  cancel: () => void;
} {
  const activityWatch = ctx.buffer.watch(
    // ADR-247: watching 是继续注意，不是发言授权。
    // 只有同目标 directed 新消息可以把 linger slot 重新唤醒；typing / ambient activity
    // 仍进入 EventBuffer，由外层控制器按真实压力重新评估。
    // @see docs/adr/247-block-contract-over-transport.md §P1：拆 `watching`
    (e) =>
      e.type === "new_message" &&
      e.channelId === targetChannelId &&
      e.isDirected === true &&
      !e.senderIsBot,
  );
  const interruptWatch = ctx.buffer.watch(
    (e) =>
      e.type === "new_message" &&
      e.channelId !== targetChannelId &&
      quickPressureEstimate(ctx.G, e) > holdStrength * PREEMPTION_FACTOR,
  );

  return {
    async await(timeout: number) {
      const start = Date.now();
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<null>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(null), timeout);
      });
      try {
        const result = await Promise.race([
          activityWatch.promise.then(() => ({ type: "activity" as const })),
          interruptWatch.promise.then(() => ({ type: "interrupt" as const })),
          timeoutPromise.then(() => ({ type: "timeout" as const })),
        ]);
        return { type: result.type, elapsed: Date.now() - start };
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        activityWatch.cancel();
        interruptWatch.cancel();
      }
    },
    cancel() {
      activityWatch.cancel();
      interruptWatch.cancel();
    },
  };
}
