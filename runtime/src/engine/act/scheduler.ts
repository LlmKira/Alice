/**
 * ADR-130: Engagement Interleaving — 协作式交错调度器。
 *
 * 替换 startActLoop 的串行单消费者 while 循环，引入多 engagement 交错调度。
 * subcycle（一轮 ReAct：LLM → Sandbox → Execute → Feedback）是最小不可中断单元。
 * subcycle 之间是自然的切换点——对应人类在 IM 中"回了一句，切到另一个窗口"的行为。
 *
 * 核心不变量：
 * 1. Subcycle 原子性 — subcycle 内不切换（CQRS 事务性）
 * 2. Engagement Exclusivity — 每个目标最多一个活跃 engagement（ADR-124）
 * 3. Dispatcher 目标隔离 — 切换时重新 SET_CONTACT_TARGET / SET_CHAT_TARGET
 * 4. Graph 一致性 — Node.js 单线程 + subcycle 同步修改
 *
 * ADR-142: selectNextEngagement 的泛型 BT 等价物为 tick/compose.ts::reactiveSelect。
 * 本文件保留 engagement-specific 的调度逻辑（initSlot, checkWatchers, startWatcher 等），
 * compose.ts::reactiveSelect 提供不依赖 engagement 语义的通用优先级选择器。
 *
 * @see docs/adr/130-engagement-interleaving.md
 * @see docs/adr/142-action-space-architecture/README.md
 */
import { ALICE_SELF, ensureChannelId, extractNumericId } from "../../graph/constants.js";
import { ChatTarget } from "../../prompt/types.js";
import { createLogger } from "../../utils/logger.js";
import { type ActionQueue, type ActionQueueItem, pressureScore } from "../action-queue.js";
import { captureGraphState } from "../closure-depth.js";
import type { ActContext } from "../react/orchestrator.js";
import {
  buildContextVars,
  type ContextVars,
  type ResolvedTarget,
  resolveTarget,
} from "../tick/target.js";
import {
  EngagementSession,
  EXPECT_REPLY_TIMEOUT,
  prepareEngagementWatch,
  prepareStayWatch,
  STAY_TIMEOUT,
  type WatchResult,
} from "./engagement.js";
import { fetchRecentMessages, type MessageRecord } from "./messages.js";

const log = createLogger("act:scheduler");

// ── ADR-130 常量 ──────────────────────────────────────────────────────

/** 最大并发 engagement 数（Miller 7±2 的保守端）。 */
export const MAX_CONCURRENT_ENGAGEMENTS = 3;

/** 切换到不同目标时的额外延迟（ms）——可观测的"切换思考间隙"。 */
export const SWITCH_COST_MS = 1500;

// ── EngagementSlot ─────────────────────────────────────────────────────

/** 调度槽位状态。运行时专用，不复用 LLM afterward 词汇。 */
export type SlotState = "ready" | "reply_watch" | "linger_watch" | "done";

/** 需要被非阻塞观察的 afterward 结果。 */
export type DeferredTurnOutcome = "waiting_reply" | "watching";

/** 调度器内部 watch 计划。运行时专用，不暴露给 LLM。 */
export type WatchPlan = "reply_window" | "linger_window";

export function watchPlanFromOutcome(outcome: DeferredTurnOutcome): WatchPlan {
  return outcome === "waiting_reply" ? "reply_window" : "linger_window";
}

/** Watcher 非阻塞观察器的运行时状态。 */
export interface ActiveWatcher {
  readonly plan: WatchPlan;
  readonly handle: ReturnType<typeof prepareEngagementWatch>;
  readonly promise: Promise<WatchResult>;
  readonly timeout: number;
}

function isWatchState(state: SlotState): state is "reply_watch" | "linger_watch" {
  return state === "reply_watch" || state === "linger_watch";
}

/**
 * 一个活跃 engagement 的调度槽位。
 * 每个 slot 独立持有执行上下文——切换 engagement 时无需序列化。
 *
 * 初始化阶段确定的字段标记 readonly，仅 state/urgency/liveMessages/watcher 可变。
 */
export interface EngagementSlot {
  readonly item: ActionQueueItem;
  readonly session: EngagementSession;
  state: SlotState;
  urgency: number;
  /** Prepare 阶段解析的目标信息。 */
  readonly resolved: ResolvedTarget | null;
  readonly contextVars: ContextVars | undefined;
  /** 可刷新——subcycle 间重新拉取。 */
  liveMessages: MessageRecord[];
  readonly targetChatId: number | null;
  readonly targetChannelId: string | null;
  /** engagement 粘性（用于 preemption 判断）。 */
  readonly holdStrength: number;
  /** ClosureDepth 测量用的图状态快照。 */
  readonly graphBefore: ReturnType<typeof captureGraphState>;
  /** engagement 开始时的墙钟时间（ms）。 */
  readonly startMs: number;
  /** 非阻塞 watcher 状态。null = 无活跃 watcher。 */
  watcher: ActiveWatcher | null;
  /**
   * interrupt 抢占标志。为 true 时 finalizeSlot 跳过 markComplete，
   * 因为 target 已重新入队——processing 锁应由新 engagement 持有。
   * @see C1 in adr130-review.md
   */
  preempted: boolean;
}

// ── 调度器 API ─────────────────────────────────────────────────────────

/**
 * 初始化一个 engagement slot。
 * 执行 Prepare 阶段：拉取消息、解析目标、设置 Dispatcher 目标。
 */
export async function initSlot(ctx: ActContext, item: ActionQueueItem): Promise<EngagementSlot> {
  const targetChatId = item.target ? extractNumericId(item.target) : null;
  const targetChatType =
    item.target && ctx.G.has(item.target)
      ? (ctx.G.getChannel(item.target).chat_type ?? undefined)
      : undefined;
  const recentMessages = targetChatId
    ? await fetchRecentMessages(ctx.client, targetChatId, ctx.config, {
        chatType: targetChatType,
      })
    : [];

  const resolved = item.target ? resolveTarget(ctx.G, item.target) : null;
  const contextVars = resolved ? buildContextVars(ctx, item, resolved) : undefined;
  const targetChannelId = item.target ? ensureChannelId(item.target) : null;
  const holdStrength = Math.max(...item.pressureSnapshot, 3.0);
  const graphBefore = captureGraphState(ctx.G);

  // thinking_target 可观测性信号
  const tick = ctx.getCurrentTick();
  if (item.target && ctx.G.has(ALICE_SELF)) {
    ctx.G.updateAgent(ALICE_SELF, { thinking_target: item.target });
    if (ctx.G.has(item.target)) {
      ctx.G.updateChannel(item.target, { alice_thinking_since: tick });
    }
  }

  // 群聊 subcycle 上限收束：群聊每次 engagement 最多 2 条消息（私聊保持 5）
  const maxSubcycles = ChatTarget.isGroupChat(targetChatType ?? "private") ? 2 : undefined;

  return {
    item,
    session: new EngagementSession(maxSubcycles),
    state: "ready",
    urgency: pressureScore(item),
    resolved,
    contextVars,
    liveMessages: recentMessages,
    targetChatId,
    targetChannelId,
    holdStrength,
    graphBefore,
    startMs: Date.now(),
    watcher: null,
    preempted: false,
  };
}

/**
 * ADR-130: 选择下一个 ready 的 engagement——紧急度最高者优先。
 * 单遍历 O(n)。
 */
export function selectNextEngagement(active: EngagementSlot[]): EngagementSlot | null {
  let best: EngagementSlot | null = null;
  for (const slot of active) {
    if (slot.state === "ready" && (best === null || slot.urgency > best.urgency)) {
      best = slot;
    }
  }
  return best;
}

/**
 * 检查 watch slot 是否有事件唤醒。
 * 非阻塞——只检查 watcher 是否仍然存活。
 *
 * 安全性依赖 Node.js 单线程模型：handleWatchResult 的
 * `watcher = null; state = "ready"` 是同一个微任务内的同步赋值，
 * 不会被 checkWatchers 的同步遍历中断。
 */
export function checkWatchers(active: EngagementSlot[]): void {
  for (const slot of active) {
    if (isWatchState(slot.state) && slot.watcher === null) {
      // watcher 已被消费或不存在——标记 done
      slot.state = "done";
    }
  }
}

/**
 * 等待任一 watch slot 的 watcher 完成或超时。
 * 当所有 slot 都不是 ready 时调用（阻塞直到有 slot 可调度）。
 * 同时也等待 ActionQueue 中的新 item（队列不为空时唤醒）。
 */
export async function awaitAnyWakeup(active: EngagementSlot[], _queue: ActionQueue): Promise<void> {
  const promises: Promise<unknown>[] = [];

  for (const slot of active) {
    if (isWatchState(slot.state) && slot.watcher) {
      promises.push(slot.watcher.promise);
    }
  }

  // 加入一个短暂的 timer 作为兜底（轮询）——避免所有 watcher 都永久等待。
  // 注意：此函数不直接监听队列新 item，而是靠 500ms 轮询回到主循环检测。
  let timerHandle: ReturnType<typeof setTimeout> | undefined;
  const timerPromise = new Promise<void>((resolve) => {
    timerHandle = setTimeout(resolve, 500);
  });
  promises.push(timerPromise);

  await Promise.race(promises);
  if (timerHandle != null) clearTimeout(timerHandle);
}

/** Watcher 配置：工厂函数 + 超时 + 对应 slot 状态。 */
interface WatchConfig {
  readonly slotState: "reply_watch" | "linger_watch";
  readonly timeout: number;
  readonly create: (
    ctx: ActContext,
    channelId: string,
    holdStrength: number,
  ) => ReturnType<typeof prepareEngagementWatch>;
}

/** runtime watch 计划 → 配置映射。 */
const WATCH_CONFIG: Record<WatchPlan, WatchConfig> = {
  reply_window: {
    slotState: "reply_watch",
    timeout: EXPECT_REPLY_TIMEOUT,
    create: (ctx, channelId, holdStrength) =>
      prepareEngagementWatch(ctx, channelId, holdStrength, { typingAware: true }),
  },
  linger_window: {
    slotState: "linger_watch",
    timeout: STAY_TIMEOUT,
    create: (ctx, channelId, holdStrength) => prepareStayWatch(ctx, channelId, holdStrength),
  },
};

/**
 * 为 slot 启动非阻塞 watcher。
 * watcher 结果通过 promise .then 自动流入 handleWatchResult。
 */
export function startWatcher(ctx: ActContext, slot: EngagementSlot, plan: WatchPlan): void {
  if (!slot.targetChannelId) {
    slot.state = "done";
    return;
  }

  const config = WATCH_CONFIG[plan];
  const handle = config.create(ctx, slot.targetChannelId, slot.holdStrength);
  const promise = handle.await(config.timeout).then((result) => {
    handleWatchResult(ctx, slot, result);
    return result;
  });

  slot.watcher = { plan, handle, promise, timeout: config.timeout };
  slot.state = config.slotState;
}

/**
 * 处理 watcher 结果——更新 slot 状态。
 * 在 watcher promise resolve 时自动调用。
 *
 * timeout outcome 由 `watcher.plan` 决定（而非 `slot.state`），
 * 避免 handleWatchResult 依赖 slot 当前状态——在 promise 异步 resolve 时
 * slot.state 可能已被其他路径修改。
 */
function handleWatchResult(ctx: ActContext, slot: EngagementSlot, result: WatchResult): void {
  // C3 guard: 如果 watcher 已被 releaseSlot 清除（shutdown/cleanup 路径），
  // 跳过整个 handler——避免在已 finalized 的 slot 上产生副作用。
  if (!slot.watcher) return;

  // 捕获 plan 后清除 watcher（plan 用于 timeout outcome 判断）
  const plan = slot.watcher.plan;
  slot.session.elapsed += result.elapsed;
  slot.watcher = null;

  switch (result.type) {
    case "reply":
    case "activity":
      // 回复/活动到达——重新 ready，下次 subcycle 会拉取新消息
      slot.state = "ready";
      log.info("Watcher event received", {
        target: slot.item.target,
        type: result.type,
        elapsed: result.elapsed,
      });
      break;

    case "interrupt":
      // 被更紧急的事件抢占——重新入队
      // 标记 preempted: finalizeSlot 跳过 markComplete，processing 锁由新 engagement 继承
      slot.session.outcome = "preempted";
      slot.preempted = true;
      ctx.queue.enqueue({
        action: slot.item.action,
        target: slot.item.target,
        reason: "engagement_interrupted",
        pressureSnapshot: ctx.getCurrentPressures(),
        contributions: slot.item.contributions,
        focalEntities: slot.item.focalEntities, // M8: 保留 focalEntities
        enqueueTick: ctx.getCurrentTick(),
      });
      slot.state = "done";
      log.info("Engagement preempted via watcher", { target: slot.item.target });
      break;

    case "timeout":
      // timeout outcome 取决于 runtime watch 计划：
      // reply_window 超时 = 对方未回复 → "timeout"
      // linger_window 超时 = 正常逗留结束 → "complete"
      slot.session.outcome = plan === "reply_window" ? "timeout" : "complete";
      slot.state = "done";
      log.info("Watcher timeout", {
        target: slot.item.target,
        plan,
        elapsed: result.elapsed,
      });
      break;
  }
}

/**
 * 释放 slot 的所有资源。
 * - 释放 processing 锁
 * - 清除可观测性信号
 * - 取消 watcher
 */
export function releaseSlot(ctx: ActContext, slot: EngagementSlot): void {
  // 取消 watcher（如果有）
  if (slot.watcher) {
    slot.watcher.handle.cancel();
    slot.watcher = null;
  }

  // 释放可观测性信号
  if (ctx.G.has(ALICE_SELF)) {
    // 只有当 thinking_target 指向此 slot 的目标时才清除
    const current = ctx.G.getAgent(ALICE_SELF).thinking_target;
    if (current === slot.item.target) {
      ctx.G.updateAgent(ALICE_SELF, { thinking_target: null });
    }
  }
  if (slot.item.target && ctx.G.has(slot.item.target)) {
    ctx.G.updateChannel(slot.item.target, { alice_thinking_since: null });
  }
}
