/**
 * 内源性线程生成器 — P4 Endogenous Thread Generation。
 *
 * 在 evolve 管线的 perceive 和 pressure 之间运行，
 * 创建系统自发线程，通过已有的 P4 → 声部竞争 → 门控 → 行动管线处理。
 * 零新压力维度，零新管线。
 *
 * - Clock ρ：周期性线程（晨间简报、周度反思）
 * - Deferred δ：延迟评估（新群组试用期到期）
 *
 * ADR-191: Anomaly α 已移除。速率尖峰信号通过 tauSpike → rCaution 直接结构路径处理。
 *
 * @see docs/adr/115-evolve-observability/ — ADR-115 审计发现的行为缺口
 * @see paper/ §7.X Endogenous Thread Generation
 */

import { eq } from "drizzle-orm";
import type { Config } from "../config.js";
import { type getDb, getSqlite } from "../db/connection.js";
import { narrativeThreads } from "../db/schema.js";
import {
  recordThreadLifecycleEvent,
  threadDbId,
  threadP4Contribution,
} from "../db/thread-lifecycle.js";
import { safeDisplayName } from "../graph/display.js";
import type { ThreadWeight } from "../graph/entities.js";
import type { WorldModel } from "../graph/world-model.js";
import { createLogger } from "../utils/logger.js";

/** Drizzle DB 实例类型（与 getDb() 返回值对齐）。 */
type DrizzleDb = ReturnType<typeof getDb>;

const log = createLogger("generators");

// ═══════════════════════════════════════════════════════════════════════════
// createThreadInGraph — 线程创建共享函数
// ═══════════════════════════════════════════════════════════════════════════

/** Weight → numeric mapping。单一真相来源，threads.mod.ts 导入此常量。 */
export const WEIGHT_MAP: Record<string, number> = {
  trivial: 0.2,
  subtle: 0.2,
  minor: 0.5,
  major: 2.0,
  critical: 4.0,
};

/** DB weight string → ThreadWeight 映射。DB 保留旧字符串，图层使用新类型。 */
const GRAPH_WEIGHT: Record<string, ThreadWeight> = {
  trivial: "subtle",
  subtle: "subtle",
  minor: "minor",
  major: "major",
  critical: "major",
};

/**
 * 在 DB + 图上创建一个叙事线程。
 * 从 threads.mod self_topic_begin 提取的共享逻辑。
 *
 * @returns DB 中新线程的 ID
 */
export function createThreadInGraph(
  db: DrizzleDb,
  G: WorldModel,
  tick: number,
  nowMs: number,
  params: {
    title: string;
    weight: "trivial" | "minor" | "major" | "critical";
    deadlineMs?: number;
    involves?: Array<{ nodeId: string; role: string }>;
    source: "conversation" | "system" | "auto";
    frame?: string;
    sourceChannel?: string;
  },
): number {
  const { title, weight, deadlineMs, involves, source, frame, sourceChannel } = params;

  // FTS 同步由 SQLite 触发器自动完成。
  // @see runtime/drizzle/0017_fts5_triggers.sql
  const horizon =
    deadlineMs != null ? Math.max(1, Math.round((deadlineMs - nowMs) / 60_000)) : null;
  const deadlineTick = horizon != null ? tick + horizon : null;
  const [row] = db
    .insert(narrativeThreads)
    .values({
      title,
      tensionFrame: frame ?? null,
      tensionStake: null,
      status: "open",
      weight,
      source,
      involves: involves ? JSON.stringify(involves) : null,
      createdTick: tick,
      horizon,
      deadlineTick,
    })
    .returning({ id: narrativeThreads.id })
    .all();

  // 图节点（内存操作，不需要 DB 事务保护）
  const threadNodeId = `thread_${row.id}`;
  const w = WEIGHT_MAP[weight] ?? 0.5;
  G.addThread(threadNodeId, {
    title,
    status: "open",
    weight: GRAPH_WEIGHT[weight] ?? "minor",
    w,
    created_ms: nowMs,
    deadline: deadlineTick ?? Number.POSITIVE_INFINITY,
    source,
    source_channel: sourceChannel,
    last_activity_ms: nowMs,
    deadline_ms: deadlineMs ?? undefined,
  });

  // 关联涉及的实体
  if (involves) {
    for (const inv of involves) {
      if (G.has(inv.nodeId)) {
        G.addRelation(threadNodeId, "involves", inv.nodeId);
      }
    }
  }

  log.debug("Thread created", { id: row.id, title, source, weight });
  return row.id;
}

// ═══════════════════════════════════════════════════════════════════════════
// resolveThreadInGraph — 线程 resolve 共享函数
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 在 DB + 图上 resolve 一个叙事线程。
 * 与 createThreadInGraph 对称 — resolve 路径的单一真相来源。
 *
 * @see docs/adr/190-behavioral-audit-performative-trap.md
 */
export function resolveThreadInGraph(
  db: DrizzleDb,
  G: WorldModel,
  threadNodeId: string,
  tick: number,
  nowMs: number,
): void {
  const attrs = G.getThread(threadNodeId);
  const dbId = threadDbId(threadNodeId);
  const tx = getSqlite().transaction(() => {
    recordThreadLifecycleEvent({
      threadNodeId,
      tick,
      occurredAtMs: nowMs,
      previousStatus: attrs.status,
      outcome: "resolved",
      reason: "explicit_resolve_topic",
      deadlineMs: attrs.deadline_ms ?? null,
      p4Before: threadP4Contribution(nowMs, attrs.created_ms, attrs.w),
      metadata: { title: attrs.title ?? threadNodeId },
    });
    if (dbId != null) {
      db.update(narrativeThreads)
        .set({ status: "resolved", resolvedTick: tick })
        .where(eq(narrativeThreads.id, dbId))
        .run();
    }
  });
  tx();
  G.updateThread(threadNodeId, { status: "resolved" });
}

// ═══════════════════════════════════════════════════════════════════════════
// 生成器框架
// ═══════════════════════════════════════════════════════════════════════════

/** 生成器执行上下文。 */
export interface GeneratorContext {
  G: WorldModel;
  db: DrizzleDb;
  tick: number;
  nowMs: number;
  config: Config;
  /** perceive 返回的 per-channel 消息计数。 */
  channelCounts: Map<string, number>;
  /** 跨 tick 维护的 per-channel EMA 统计。 */
  channelRateEma: Map<string, { ema: number; variance: number }>;
  /** ADR-225: 当前 agent mode — dormant 时跳过周期性线程生成。 */
  mode?: import("../utils/time.js").AgentMode;
}

/**
 * 运行所有内源性线程生成器。
 * 在 evolve 管线的 perceive 之后、pressure 之前调用。
 *
 * 防御性监控：单 tick 创建多线程时发出警告。
 * 生成器本身已有幂等保护（hasOpenThread / hasDeferredThreadFor），
 * 此监控是可观测性补充——异常日志可触发运维告警。
 */
export function runGenerators(ctx: GeneratorContext): void {
  const threadsBefore = ctx.G.getEntitiesByType("thread").length;
  clockGenerator(ctx);
  // ADR-191: anomalyGenerator 已移除——速率尖峰信号通过 tauSpike → rCaution 直接结构路径处理
  deferredGenerator(ctx);
  const created = ctx.G.getEntitiesByType("thread").length - threadsBefore;
  if (created > 2) {
    log.warn("Generators created multiple threads in single tick", {
      tick: ctx.tick,
      threadsCreated: created,
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 共享辅助
// ═══════════════════════════════════════════════════════════════════════════

/** 幂等检查：图中是否已有同名 open thread。 */
function hasOpenThread(G: WorldModel, title: string): boolean {
  for (const tid of G.getEntitiesByType("thread")) {
    const attrs = G.getThread(tid);
    if (attrs.status === "open" && attrs.title === title) return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// Clock Generator (ρ) — 周期性线程
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 周期性线程生成器。
 * - 每天 digestHour 点创建 morning_digest 线程
 * - 每周 reflectionDay 的 reflectionHour 创建 weekly_reflection 线程
 */
function clockGenerator(ctx: GeneratorContext): void {
  // ADR-225: dormant 模式下不创建周期性线程（醒来后由自然 tick 触发）
  if (ctx.mode === "dormant") return;

  const localHour = new Date(ctx.nowMs).getHours();
  const localDay = new Date(ctx.nowMs).getDay(); // 0=Sunday

  // ADR-172: 系统线程路由到 operator 私聊
  const operatorChannel = ctx.config.operatorChannelId || undefined;

  // 晨间 Digest：每天 digestHour 点，无同名 open thread
  if (localHour === ctx.config.generators.digestHour && !hasOpenThread(ctx.G, "morning_digest")) {
    createThreadInGraph(ctx.db, ctx.G, ctx.tick, ctx.nowMs, {
      title: "morning_digest",
      weight: "major",
      deadlineMs: ctx.nowMs + 4 * 3600_000,
      source: "system",
      sourceChannel: operatorChannel,
      // ADR-172: frame 不再提 "for the operator"——路由约束由 sourceChannel 保证
      frame:
        "Summarize overnight events. Include any pending promises or commitments approaching their deadline.",
      involves: operatorChannel ? [{ nodeId: operatorChannel, role: "recipient" }] : undefined,
    });
    log.info("Clock ρ: morning_digest created", { sourceChannel: operatorChannel });
  }

  // 周度反思：每周 reflectionDay 的 reflectionHour 点
  if (
    localDay === ctx.config.generators.reflectionDay &&
    localHour === ctx.config.generators.reflectionHour &&
    !hasOpenThread(ctx.G, "weekly_reflection")
  ) {
    createThreadInGraph(ctx.db, ctx.G, ctx.tick, ctx.nowMs, {
      title: "weekly_reflection",
      weight: "major",
      deadlineMs: ctx.nowMs + 12 * 3600_000,
      source: "system",
      sourceChannel: operatorChannel,
      frame: "Review this week's interactions and extract patterns",
      involves: operatorChannel ? [{ nodeId: operatorChannel, role: "recipient" }] : undefined,
    });
    log.info("Clock ρ: weekly_reflection created", { sourceChannel: operatorChannel });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Deferred Generator (δ) — 延迟评估
// ═══════════════════════════════════════════════════════════════════════════

/** ADR-190: 幂等检查——指定频道是否已有 open evaluate thread（通过 involves 边判断）。 */
function hasDeferredThreadFor(G: WorldModel, channelId: string): boolean {
  for (const tid of G.getEntitiesByType("thread")) {
    const attrs = G.getThread(tid);
    if (attrs.status !== "open") continue;
    if (typeof attrs.title !== "string" || !attrs.title.startsWith("evaluate_")) continue;
    const neighbors = G.getNeighbors(tid, "involves");
    if (neighbors.includes(channelId)) return true;
  }
  return false;
}

/**
 * 延迟评估生成器。
 * 检查 channel 节点上的 deferred_eval_ms 属性，到期后创建 evaluate 线程。
 */
function deferredGenerator(ctx: GeneratorContext): void {
  for (const chId of ctx.G.getEntitiesByType("channel")) {
    const attrs = ctx.G.getChannel(chId);
    const evalMs = attrs.deferred_eval_ms;
    if (!evalMs || ctx.nowMs < evalMs) continue;
    // ADR-190: 幂等改用 involves 边判断
    if (hasDeferredThreadFor(ctx.G, chId)) continue;

    // ADR-190: 标题用 safeDisplayName 替代 raw channelId
    const chName = safeDisplayName(ctx.G, chId);
    createThreadInGraph(ctx.db, ctx.G, ctx.tick, ctx.nowMs, {
      title: `evaluate_${chName}`,
      weight: "minor",
      deadlineMs: ctx.nowMs + 24 * 3600_000,
      source: "system",
      frame: "Evaluate whether to stay in or leave this group",
      involves: [{ nodeId: chId, role: "evaluation_target" }],
    });

    // 清除标记（避免重复触发）
    ctx.G.updateChannel(chId, { deferred_eval_ms: null });
    log.info("Deferred δ: evaluation thread created", { chId });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Channel Rate EMA — per-channel 消息速率指数移动平均（连续时间）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ADR-166: 连续时间 EMA 时间常数（秒）。
 *
 * 离散 EMA `x[n] = α·s + (1-α)·x[n-1]` 假设均匀时间步。
 * 连续时间等价: `α(dt) = 1 - exp(-dt / τ)`
 * 由标称参数反推: τ = -dt_base / ln(1 - α_base)
 *
 * α_base = 0.1, dt_base = 60s → τ = -60 / ln(0.9) ≈ 569.6s
 *
 * 验证:
 * - dt=60s:  α(60)  = 0.100 (退化为旧行为 ✓)
 * - dt=3s:   α(3)   = 0.005 (conversation: 低灵敏度)
 * - dt=300s: α(300) = 0.410 (patrol idle: 高灵敏度)
 *
 * @see docs/adr/166-wallclock-purification.md §8
 */
const EMA_TAU_S = -60 / Math.log(1 - 0.1); // ≈ 569.6

/**
 * 更新 per-channel 消息速率 EMA。
 * 使用 Welford 在线算法跟踪均值和方差。
 *
 * ADR-166: α 按实际 tick 墙钟时长自适应，保持恒定的时间半衰期。
 *
 * @param dtS 本次 tick 的实际墙钟秒数。
 *            dt=60s 时退化为旧行为（α=0.1）；dt=3s 时 α≈0.005。
 */
export function updateChannelRateEma(
  emaMap: Map<string, { ema: number; variance: number }>,
  channelCounts: Map<string, number>,
  dtS: number,
): void {
  // 连续时间自适应 α：半衰期恒定 ≈ 395s，无论 tick 间隔如何
  const clampedDt = Math.max(1, Math.min(dtS, 600));
  const alpha = 1 - Math.exp(-clampedDt / EMA_TAU_S);

  // 更新有消息的频道
  for (const [chId, count] of channelCounts) {
    const prev = emaMap.get(chId);
    if (!prev) {
      emaMap.set(chId, { ema: count, variance: 0 });
    } else {
      const diff = count - prev.ema;
      const newEma = prev.ema + alpha * diff;
      // EMA 方差：exponential moving variance（使用相同 α(dt)）
      const newVariance = (1 - alpha) * (prev.variance + alpha * diff * diff);
      emaMap.set(chId, { ema: newEma, variance: newVariance });
    }
  }

  // 未出现在本 tick 的频道：count=0 衰减 + 清理死条目
  for (const [chId, prev] of emaMap) {
    if (!channelCounts.has(chId)) {
      const diff = 0 - prev.ema;
      const newEma = prev.ema + alpha * diff;
      const newVariance = (1 - alpha) * (prev.variance + alpha * diff * diff);
      // 均值和方差均接近零 → 清除条目（防止已 GC 频道的无限积累）
      if (Math.abs(newEma) < 0.01 && newVariance < 0.01) {
        emaMap.delete(chId);
      } else {
        emaMap.set(chId, { ema: newEma, variance: newVariance });
      }
    }
  }
}
