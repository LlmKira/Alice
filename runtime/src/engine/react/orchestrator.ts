/**
 * ReAct 外循环 + 交错调度 — 替代旧 loop.ts:411-595 + scheduler.ts 协调。
 *
 * 保留 ADR-130 交错调度的全部语义：
 * - 多 engagement 并发（Miller 7±2 保守端 = 3）
 * - subcycle 原子性 + engagement exclusivity
 * - expect_reply/stay 非阻塞化
 * - 切换代价（SWITCH_COST_MS）
 *
 * 关键改变（vs 旧 loop.ts）：
 * - ADR-142: 内部调用 `runTickSubcycle`（Blackboard Tick + SAA 管线）
 * - subcycle 返回后调用 `evaluateAndReflect()` (D9)
 * - processItem 支持 `decideFanOut()` (D8) 条件树搜索
 *
 * @see docs/adr/140-react-efficiency-architecture.md
 * @see docs/adr/130-engagement-interleaving.md
 */
import type { TelegramClient } from "@mtcute/node";

import type { Config } from "../../config.js";
// ADR-214 Wave A: ExecutionStats, executeRecordedActions, mergeScriptExecutionResults 已删除。
// applyFeedbackArc 不再被调用。Wave B 将清理。
import type { Dispatcher } from "../../core/dispatcher.js";
import { getDb } from "../../db/connection.js";
import { PRESSURE_TYPICAL_SCALES } from "../../graph/constants.js";
import type { WorldModel } from "../../graph/world-model.js";
import type { EventBuffer } from "../../telegram/events.js";
import { isGroupOutboundBlocked } from "../../telegram/membership-guard.js";
import { createLogger } from "../../utils/logger.js";
import type { PressureDims } from "../../utils/math.js";
import type { PersonalityVector } from "../../voices/personality.js";
import { fetchRecentMessages } from "../act/messages.js";
import {
  awaitAnyWakeup,
  checkWatchers,
  type EngagementSlot,
  initSlot,
  MAX_CONCURRENT_ENGAGEMENTS,
  releaseSlot,
  SWITCH_COST_MS,
  selectNextEngagement,
  startWatcher,
  type WatchKind,
} from "../act/scheduler.js";
import type { ActionQueue, ActionQueueItem } from "../action-queue.js";
import { measureClosureDepth } from "../closure-depth.js";
import { commitActEvents } from "../consciousness.js";
import { runTickSubcycle } from "../tick/bridge.js";
import { processResult } from "./feedback-arc.js";

const log = createLogger("react:orchestrator");

// ── ActContext: 行动循环上下文（与旧 loop.ts 兼容）────────────────────────

/**
 * ACT 循环上下文 — 行动线程的运行时依赖注入。
 *
 * 与旧 loop.ts 的 ActContext 保持类型兼容。
 */
export interface ActContext {
  client: TelegramClient;
  G: WorldModel;
  config: Config;
  queue: ActionQueue;
  personality: PersonalityVector;
  getCurrentTick: () => number;
  getCurrentPressures: () => PressureDims;
  onPersonalityUpdate: (pv: PersonalityVector) => void;
  /** Mod Dispatcher。 */
  dispatcher: Dispatcher;
  /** ADR-107: EventBuffer 引用，用于浏览会话期间监听回复和抢占事件。 */
  buffer: EventBuffer;
  /** ADR-173: 记录已确认的行动到 evolve 的 recentActions（延迟记录，仅真实 Telegram 行动）。 */
  recordAction: (action: string, target: string | null) => void;
  /** ADR-190: 通知 evolve 线程 LLM 调用结果（成功/失败），驱动调度层指数退避。 */
  reportLLMOutcome: (success: boolean) => void;
}

/**
 * 过期检查：入队后压力场是否已显著变化。
 *
 * P1-2: 归一化后计算 L2 距离。裸 L2 被 P1/P4（量级~200）主导，
 * P5（量级~3）的剧变几乎无法触发 staleness。归一化到 [0,1] 后各维度等权。
 * @see .claude/sessions/review-runtime-G6oHOR/worker-2-engine-core.md §P1-2
 */
function isStale(
  item: ActionQueueItem,
  currentPressures: PressureDims,
  threshold: number,
): boolean {
  let sum = 0;
  for (let i = 0; i < 6; i++) {
    const scale = PRESSURE_TYPICAL_SCALES[i] || 1;
    const diff = (item.pressureSnapshot[i] - currentPressures[i]) / scale;
    sum += diff * diff;
  }
  return Math.sqrt(sum) > threshold;
}

// ADR-214 Wave A: applyFeedbackArc 已删除（依赖 ExecutionStats，属于死管线）。
// shell-native 架构下 Telegram 动作通过 Engine API HTTP 执行，
// pending_directed 递减和 reachability 更新由 Engine API 路由处理。

/**
 * 终结一个 engagement slot：安全网 flush + processResult + cooldown + 释放锁。
 * 从旧 startActLoop 的后处理逻辑提取。
 */
async function finalizeSlot(ctx: ActContext, slot: EngagementSlot): Promise<void> {
  const { item, session, graphBefore } = slot;
  const tick = ctx.getCurrentTick();

  try {
    // ADR-214 Wave A: 安全网 flush 已删除。
    // shell-native 架构下 pendingActions 始终为空——Telegram 动作通过容器内 Engine API HTTP 直接执行。

    // processResult: 一次性调用，传递 engagement metrics
    const mergedResult = session.toMergedResult();
    const closureResult = measureClosureDepth(graphBefore, ctx.G);
    processResult(ctx, item, tick, mergedResult, session.errorCount, closureResult.maxDepth, {
      subcycles: session.subcycle,
      durationMs: session.elapsed,
      outcome: session.outcome,
    }, session.lastTcMeta);
    // ADR-173: 延迟记录——行动确认后写入 recentActions
    // ADR-215 Wave 2: 所有行动类型（包括 observe）都计入 rateCap，防止内部循环超频
    // 区分：真实 Telegram 行动（有 completedActions）vs 内部行动（silence/observe/llm_failed）
    // 两者都消耗注意力预算，但内部行动的 socialCost 和 netValue 计算方式不同
    ctx.recordAction(item.action, item.target);
    // ADR-190: 通知 evolve 线程 LLM 调用结果，驱动调度层指数退避
    ctx.reportLLMOutcome(session.outcome !== "llm_failed");
  } finally {
    // 释放可观测性信号
    releaseSlot(ctx, slot);
    // C1 fix: preempted slot 不释放 processing 锁——target 已重新入队，
    // 锁应由新 engagement 继承，否则短暂的无锁窗口会破坏 Exclusivity。
    if (item.target && !slot.preempted) ctx.queue.markComplete(item.target);
  }

  // ADR-130: cooldown 改为非阻塞
  // 通过更新 channel 的 last_alice_action_ms 让 EVOLVE 线程的 proactive_cooldown 自然处理
  if (slot.targetChannelId && ctx.G.has(slot.targetChannelId)) {
    ctx.G.updateChannel(slot.targetChannelId, { last_alice_action_ms: Date.now() });
  }
}

/**
 * 清理所有 done 的 slot：异步终结并释放。
 * 返回过滤后的活跃 slot 数组。
 * finalization promises 注入 `pending` Set，settled 后自动移除。
 */
function cleanupDoneSlots(
  ctx: ActContext,
  active: EngagementSlot[],
  pending: Set<Promise<void>>,
): EngagementSlot[] {
  const remaining: EngagementSlot[] = [];

  for (const slot of active) {
    if (slot.state !== "done") {
      remaining.push(slot);
      continue;
    }
    // 异步终结（不阻塞 scheduler 继续调度其他 engagement）
    const p = finalizeSlot(ctx, slot).catch((err) => {
      log.error("Failed to finalize engagement slot", {
        target: slot.item.target,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    pending.add(p);
    // settled 后自动从 Set 中移除，防止无限增长
    p.then(
      () => pending.delete(p),
      () => pending.delete(p),
    );
  }

  return remaining;
}

/**
 * ADR-140: 启动 ReAct 循环 — 交错调度版（替代旧 startActLoop）。
 *
 * 整体结构与旧 startActLoop 几乎相同——交错调度、slot 管理、switch cost、
 * staleness check 都保留。区别在于：
 * - ADR-142: 内部调用 `runTickSubcycle`（Blackboard Tick + SAA 两层过滤）
 * - subcycle 返回后支持 D8 fan-out + D9 reflection（由 orchestrator 协调）
 *
 * @see docs/adr/140-react-efficiency-architecture.md
 * @see docs/adr/130-engagement-interleaving.md
 */
export async function startReActLoop(ctx: ActContext): Promise<void> {
  let active: EngagementSlot[] = [];
  let lastTarget: string | null = null;
  /** 异步 finalization 追踪——关闭时 await 所有 pending finalization。settled 后自动移除。 */
  const pendingFinalizations = new Set<Promise<void>>();

  while (!ctx.queue.closed) {
    // ── 1. 吸收新 item（不阻塞，最多填充到 MAX_CONCURRENT） ──
    while (active.length < MAX_CONCURRENT_ENGAGEMENTS) {
      const item =
        active.length === 0
          ? await ctx.queue.dequeue() // 空时阻塞等待
          : ctx.queue.tryDequeue(); // 非空时非阻塞尝试
      if (!item) break;

      // Staleness check
      // directed_override 豁免：义务驱动行动的决策基于 pending_directed（缓变信号），
      // 不应被无关压力维度（P1/P3/P6）的自然漂移作废。
      const tick = ctx.getCurrentTick();
      const currentP = ctx.getCurrentPressures();
      if (
        item.reason !== "directed_override" &&
        isStale(item, currentP, ctx.config.stalenessThreshold)
      ) {
        log.info("Action stale → skip", {
          tick,
          enqueueTick: item.enqueueTick,
          action: item.action,
        });
        // 义务安全阀：stale 跳过也消耗一次 directed 义务，防止无限循环
        if (item.target && ctx.G.has(item.target)) {
          const pd = Number(ctx.G.getChannel(item.target).pending_directed ?? 0);
          if (pd > 0) {
            ctx.G.updateChannel(item.target, { pending_directed: pd - 1 });
          }
        }
        if (item.target) ctx.queue.markComplete(item.target);
        continue;
      }

      // 群组成员校验——在 initSlot（fetchRecentMessages + prompt 组装）之前拦截，
      // 避免为已离开的群浪费 LLM token。
      if (item.target) {
        const rawId = item.target.replace(/^channel:/, "");
        if (await isGroupOutboundBlocked(ctx.client, ctx.G, item.target, rawId)) {
          log.info("Engagement skipped: not a group member", { target: item.target });
          ctx.queue.markComplete(item.target);
          continue;
        }
      }

      const slot = await initSlot(ctx, item);
      active.push(slot);
      log.info("Engagement slot created", {
        target: item.target,
        activeSlots: active.length,
        urgency: slot.urgency.toFixed(2),
      });
    }

    if (active.length === 0) continue;

    // ── 2. 检查 waiting/watching 的 slot 是否有事件唤醒 ──
    checkWatchers(active);

    // ── 3. 选择下一个 ready 的 engagement ──
    const next = selectNextEngagement(active);
    if (!next) {
      // 所有 slot 都在 waiting/watching — await 任意一个唤醒
      await awaitAnyWakeup(active, ctx.queue);
      // 唤醒后继续循环（checkWatchers 会更新状态）
      // 清理 done 的 slot
      active = cleanupDoneSlots(ctx, active, pendingFinalizations);
      continue;
    }

    // ── 4. 切换代价（切换到不同目标时的认知间隙）──
    if (lastTarget && lastTarget !== next.item.target) {
      await new Promise((resolve) => setTimeout(resolve, SWITCH_COST_MS));
      log.info("Switch cost applied", {
        from: lastTarget,
        to: next.item.target,
        costMs: SWITCH_COST_MS,
      });
    }
    lastTarget = next.item.target;

    // ── 5. 设置 Dispatcher 目标 ──
    ctx.dispatcher.dispatch("SET_CONTACT_TARGET", { nodeId: next.item.target ?? "" });
    ctx.dispatcher.dispatch("SET_CHAT_TARGET", {
      chatId: next.item.target ?? "",
      liveMessageCount: next.liveMessages.length,
    });

    // ── 6. 执行一个 subcycle ──
    next.session.subcycle++;

    // 拉取最新消息（可能在其他 engagement 执行期间有新消息到达）
    if (next.session.subcycle > 1 && next.targetChatId) {
      const prevMessageCount = next.liveMessages.length;
      next.liveMessages = await fetchRecentMessages(ctx.client, next.targetChatId, ctx.config);

      // D2: Observation Quality Gate — 如果没有新消息，跳过 LLM 调用
      // expect_reply/stay 唤醒后如果观察环境无变化，继续调用 LLM 只是浪费 token。
      if (next.liveMessages.length <= prevMessageCount) {
        log.info("D2: No new messages since last subcycle → terminate", {
          target: next.item.target,
          subcycle: next.session.subcycle,
          prevCount: prevMessageCount,
          newCount: next.liveMessages.length,
        });
        next.session.outcome = "observation_empty";
        next.state = "done";
        active = cleanupDoneSlots(ctx, active, pendingFinalizations);
        continue;
      }
    }

    const tick = ctx.getCurrentTick();

    // D8: fan-out 决策点（未来由 decideFanOut() 驱动，当前走单路径）
    // D9: reflection 评估点（未来由 evaluateAndReflect() 驱动）
    const sub = await runTickSubcycle(
      ctx,
      next.item,
      tick,
      next.targetChatId,
      next.liveMessages,
      next.resolved,
      next.contextVars,
      next.session,
    );
    next.session.absorb(sub);

    // ADR-204: 意识流事件 emit（执行级）
    try {
      // ADR-214 Wave A: SubcycleResult 不再有 actions/instructions。
      // 传递空数组维持 consciousness 接口。completedActions 暂未传递（SubcycleResult 无此字段）。
      commitActEvents(
        getDb(),
        tick,
        Date.now(),
        { instructions: [], actions: [] },
        next.item.target ?? null,
      );
    } catch (e) {
      log.warn("consciousness act-emit failed", e);
    }

    // ADR-214 Wave A: SPEAK 阶段已删除。
    // shell-native 架构下 pendingActions 始终为空——Telegram 动作通过容器内 Engine API HTTP 直接执行。
    // executeRecordedActions 和 correction tick 不再被调用。

    // ── 8. BRANCH — 更新 slot 状态 ──
    // ADR-169: 查询解析和错误驱动续轮已内化到 tick() 核心循环。
    // sub.outcome 是 tick 循环的最终意图，不需要外层续轮修正。
    if (
      sub.outcome === "terminal" ||
      sub.outcome === "empty" ||
      sub.outcome === "fed_up" ||
      sub.outcome === "cooling_down"
    ) {
      if (sub.outcome === "empty") {
        next.session.outcome = "llm_failed";
      } else if (sub.outcome === "fed_up" || sub.outcome === "cooling_down") {
        next.session.outcome = sub.outcome;
        // 告别承诺：将 target 的活跃 conversation 转为 closing + turn_state: closed。
        // LLM 决定离开（语义），代码执行结构性后果（状态机）。
        if (next.targetChannelId) {
          const { findActiveConversation } = await import("../../graph/queries.js");
          const convId = findActiveConversation(ctx.G, next.targetChannelId);
          if (convId && ctx.G.has(convId)) {
            ctx.G.updateConversation(convId, {
              state: "closing",
              turn_state: "closed",
              closing_since_ms: Date.now(),
            });
            log.info("leave: conversation → closing", {
              target: next.targetChannelId,
              convId,
            });
          }
          // ADR-217: 社交回避——写 aversion 属性，在 IAUS 层乘性调制目标价值。
          // 不再注入 act_silences（那是基础设施故障通道，语义不同）。
          // 恢复由时间指数衰减驱动（群聊 τ=2h，私聊 τ=8h），不被 directed 消息重置。
          // @see docs/adr/217-pressure-field-aversion-gap.md §方案 D
          if (ctx.G.has(next.targetChannelId)) {
            const patch: Partial<import("../../graph/entities.js").ChannelAttrs> = {
              pending_directed: 0,
              aversion: sub.outcome === "cooling_down" ? 1.0 : 0.8,
              aversion_ms: Date.now(),
            };
            ctx.G.updateChannel(next.targetChannelId, patch);
          }
        }
      }
      next.state = "done";
    } else if (sub.outcome === "waiting_reply" || sub.outcome === "watching") {
      // ADR-130: waiting_reply/watching 非阻塞化
      // 将 slot 标记为 waiting/watching，scheduler 跳过它处理其他 engagement
      startWatcher(ctx, next, sub.outcome as WatchKind);
      log.info(`Engagement ${sub.outcome}`, {
        target: next.item.target,
        subcycle: next.session.subcycle,
        elapsed: next.session.elapsed,
        activeSlots: active.length,
      });
    }

    // 检查 engagement 是否已耗尽
    if (next.state === "ready" && !next.session.canContinue()) {
      next.session.outcome = "limit";
      next.state = "done";
    }

    // ── 10. 清理 done 的 slot ──
    active = cleanupDoneSlots(ctx, active, pendingFinalizations);
  }

  // 关闭时：等待所有异步 finalization 完成 + 清理残留 slot
  await Promise.allSettled([...pendingFinalizations]);
  for (const slot of active) {
    await finalizeSlot(ctx, slot);
  }

  log.info("ReAct loop stopped");
}
