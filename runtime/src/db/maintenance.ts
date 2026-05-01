/**
 * ADR-33 Phase 1: 数据库维护 + 重启恢复辅助。
 * ADR-79 M2: 图 GC（mark-sweep）。
 */
import { desc, sql } from "drizzle-orm";
import {
  getRhythmProfilesUpdatedAtMs,
  rebuildRhythmProfiles,
  shouldRebuildRhythmProfiles,
} from "../diagnostics/rhythm-profile-rebuild.js";
import { findActiveConversation } from "../graph/queries.js";
import type { WorldModel } from "../graph/world-model.js";
import { factRetrievabilityFromNode } from "../mods/relationships.mod.js";
import { createLogger } from "../utils/logger.js";
import { runAnomalyCheck } from "./anomaly.js";
import { getDb, getSqlite } from "./connection.js";
import { actionLog, tickLog } from "./schema.js";
import {
  expireLegacyAutoTopicThreads,
  expireNarrativeOnlyOpenThreads,
  expireOrphanConversationThreads,
  expireOverdueThreads,
} from "./thread-lifecycle.js";

const log = createLogger("maintenance");

// ═══════════════════════════════════════════════════════════════════════════
// ADR-79 M2: 图 GC 常量
// ═══════════════════════════════════════════════════════════════════════════

/** GC 观察窗口 — 8h（ms），容纳临时封禁恢复。 */
const GC_GRACE_MS = 8 * 3600 * 1000;

/** 可达性分数阈值 — 5+ 次失败后进入候选。 */
const GC_SCORE_THRESHOLD = 0.05;

/** 亲密联系人豁免 — tier ≤ 15 不被 GC。 */
const GC_TIER_EXEMPT = 15;

/**
 * 从 action_log 恢复 lastActionTick。
 * 启动时调用，避免重启后立即触发空闲自启动。
 */
export function recoverLastActionTick(): number {
  const db = getDb();
  const row = db
    .select({ tick: actionLog.tick })
    .from(actionLog)
    .orderBy(desc(actionLog.tick))
    .limit(1)
    .get();
  const tick = row?.tick ?? 0;
  if (tick > 0) {
    log.info("Recovered lastActionTick from action_log", { tick });
  }
  return tick;
}

/**
 * ADR-79 M2: 图垃圾回收 — mark-sweep 两阶段。
 *
 * Mark: score < GC_SCORE_THRESHOLD && failure_type === 'permanent' → 设置 gc_candidate_ms
 * Sweep: gc_candidate_ms + GC_GRACE_MS 后仍无自愈 → removeEntity()
 * 豁免: tier ≤ 15 亲密联系人、有活跃 conversation 的频道节点
 *
 * @returns 被 GC 的节点 ID 列表
 */
export function gcGraph(_currentTick: number, G: WorldModel, nowMs: number = Date.now()): string[] {
  const removed: string[] = [];

  // 扫描所有 channel 和 contact 节点
  const candidates = [...G.getEntitiesByType("channel"), ...G.getEntitiesByType("contact")];

  for (const nodeId of candidates) {
    if (!G.has(nodeId)) continue;
    const nodeType = G.getNodeType(nodeId);

    // 提取 GC 相关属性（按节点类型分派）
    let score = 1.0;
    let failureType: string | null = null;
    let gcCandidateMs: number | null = null;
    let tier = 999;

    if (nodeType === "channel") {
      const ch = G.getChannel(nodeId);
      score = ch.reachability_score ?? 1.0;
      failureType = ch.failure_type ?? null;
      gcCandidateMs = ch.gc_candidate_ms ?? null;
      tier = ch.tier_contact ?? 999;
    } else if (nodeType === "contact") {
      const ct = G.getContact(nodeId);
      tier = ct.tier;
      score = ct.reachability_score ?? 1.0;
      failureType = ct.failure_type ?? null;
      gcCandidateMs = ct.gc_candidate_ms ?? null;
    }

    // 豁免检查：亲密联系人
    if (tier <= GC_TIER_EXEMPT) continue;

    // 豁免检查：有活跃 thread 或 conversation
    if (nodeType === "channel") {
      const activeConv = findActiveConversation(G, nodeId);
      if (activeConv) continue;
    }

    // Mark 阶段：score 低 + permanent failure → 设候选 ms
    if (score < GC_SCORE_THRESHOLD && failureType === "permanent") {
      if (gcCandidateMs == null) {
        if (nodeType === "channel") G.updateChannel(nodeId, { gc_candidate_ms: nowMs });
        else if (nodeType === "contact") G.updateContact(nodeId, { gc_candidate_ms: nowMs });
        log.info("GC marked candidate", { nodeId, score, failureType });
      } else if (nowMs - gcCandidateMs >= GC_GRACE_MS) {
        // Sweep 阶段：观察窗口到期，无自愈 → 删除
        log.info("GC removing unreachable node", { nodeId, score, markedAt: gcCandidateMs });
        G.removeEntity(nodeId);
        removed.push(nodeId);
      }
    } else if (gcCandidateMs != null && score >= GC_SCORE_THRESHOLD) {
      // 已恢复但还留着 gc_candidate_ms → 清除标记
      if (nodeType === "channel") G.updateChannel(nodeId, { gc_candidate_ms: null });
      else if (nodeType === "contact") G.updateContact(nodeId, { gc_candidate_ms: null });
    }
  }

  // 孤儿 conversation 清理：channel 被 GC 后遗留的 conversation 节点
  for (const convId of G.getEntitiesByType("conversation")) {
    if (!G.has(convId)) continue;
    const convAttrs = G.getConversation(convId);
    if (convAttrs.channel && !G.has(convAttrs.channel)) {
      log.info("GC removing orphan conversation", { convId, orphanChannel: convAttrs.channel });
      G.removeEntity(convId);
      removed.push(convId);
    }
  }

  // 孤儿 info_item 清理：contact/channel 被 GC 后遗留的事实节点
  for (const itemId of G.getEntitiesByType("fact")) {
    if (!G.has(itemId)) continue;
    const itemAttrs = G.getFact(itemId);
    const sourceContact = itemAttrs.source_contact;
    if (sourceContact && !G.has(sourceContact)) {
      log.info("GC removing orphan info_item", { itemId, orphanContact: sourceContact });
      G.removeEntity(itemId);
      removed.push(itemId);
    }
  }

  if (removed.length > 0) {
    log.info("GC cycle completed", { removed: removed.length, total: G.size });
  }

  return removed;
}

/**
 * ADR-117 D6: 清理过期 fact 节点（retrievability < 0.01）。
 * 每次最多清理 10 个，避免大批量删除阻塞。
 */
export function gcExpiredFacts(G: WorldModel, nowMs: number): string[] {
  const removed: string[] = [];
  const MAX_PER_CYCLE = 10;

  for (const itemId of G.getEntitiesByType("fact")) {
    if (removed.length >= MAX_PER_CYCLE) break;
    if (!G.has(itemId)) continue;

    const attrs = G.getFact(itemId);
    const r = factRetrievabilityFromNode(attrs, nowMs);
    if (r < 0.01) {
      log.info("Fact GC: removing expired fact", { itemId, retrievability: r.toFixed(4) });
      G.removeEntity(itemId);
      removed.push(itemId);
    }
  }

  if (removed.length > 0) {
    log.info("Fact GC cycle completed", { removed: removed.length });
  }
  return removed;
}

// ═══════════════════════════════════════════════════════════════════════════
// ADR-134 D3: Thread Expiry — 幽灵线程回收
// ═══════════════════════════════════════════════════════════════════════════

/** 线程寿命：7 天后自动过期。 */
const THREAD_EXPIRY_S = 7 * 86_400;

/**
 * 标记过期 open thread（7 天未活动）→ status: "expired"。
 * P4 不计算 expired thread → 消除幽灵 P4。
 *
 * @see docs/adr/134-temporal-coherence.md §D3
 */
export function gcExpiredThreads(G: WorldModel, nowMs: number): number {
  let expired = 0;
  for (const tid of G.getEntitiesByType("thread")) {
    if (!G.has(tid)) continue;
    const attrs = G.getThread(tid);
    if (attrs.status !== "open") continue;
    // ADR-134 D3: 基于最后活动时间（advance/thread_review 更新），回退到创建时间
    const lastActivityMs = attrs.last_activity_ms ?? (attrs.created_ms || nowMs);
    const idleS = (nowMs - lastActivityMs) / 1000;
    if (idleS > THREAD_EXPIRY_S) {
      G.updateThread(tid, { status: "expired" });
      expired++;
    }
  }
  return expired;
}

/**
 * 日志生命周期管理：清理过旧记录，防止 DB 无限膨胀。
 * 建议每 100 ticks 调用一次。
 *
 * ADR-79 M2: 可选传入 WorldModel，启用图 GC。
 */
export function runMaintenance(
  currentTick: number,
  G?: WorldModel,
  options: {
    rhythmProfileRebuild?: {
      intervalMs: number;
      timezoneOffset: number;
    };
  } = {},
): ReturnType<typeof runAnomalyCheck> {
  const db = getDb();
  const TICK_RETENTION = 5000; // 保留最近 5000 ticks
  const SNAPSHOT_RETENTION = 10; // 保留最近 10 个图快照

  const cutoffTick = currentTick - TICK_RETENTION;

  maybeRebuildRhythmProfiles(options.rhythmProfileRebuild);

  // ADR-79 M2: 图 GC（即使 cutoffTick <= 0 也运行，GC 有自己的观察窗）
  if (G) {
    try {
      gcGraph(currentTick, G);
    } catch (e) {
      log.warn("Graph GC failed", e);
    }
    // ADR-262 Wave 4D: open threads leave P4 through typed lifecycle events.
    try {
      const expiredUnresolved = expireOverdueThreads(G, currentTick, Date.now());
      if (expiredUnresolved > 0)
        log.info("Expired unresolved threads", { count: expiredUnresolved });
    } catch (e) {
      log.warn("Thread lifecycle expiry failed", e);
    }
    try {
      const expiredAutoTopics = expireLegacyAutoTopicThreads(G, currentTick, Date.now());
      if (expiredAutoTopics > 0)
        log.info("Expired legacy auto topic threads", { count: expiredAutoTopics });
    } catch (e) {
      log.warn("Legacy auto topic lifecycle expiry failed", e);
    }
    try {
      const expiredOrphanConversations = expireOrphanConversationThreads(
        G,
        currentTick,
        Date.now(),
      );
      if (expiredOrphanConversations > 0)
        log.info("Expired orphan conversation threads", { count: expiredOrphanConversations });
    } catch (e) {
      log.warn("Orphan conversation lifecycle expiry failed", e);
    }
    try {
      const repairedPhantoms = expireNarrativeOnlyOpenThreads(G, currentTick, Date.now());
      if (repairedPhantoms > 0)
        log.info("Expired narrative-only threads", { count: repairedPhantoms });
    } catch (e) {
      log.warn("Thread lifecycle phantom repair failed", e);
    }
    // ADR-134 D3: legacy graph-only thread GC remains a fallback after typed lifecycle events.
    try {
      const expiredThreads = gcExpiredThreads(G, Date.now());
      if (expiredThreads > 0) log.info("Expired threads", { count: expiredThreads });
    } catch (e) {
      log.warn("Thread GC failed", e);
    }
  }

  if (cutoffTick <= 0) return runAnomalyCheck(currentTick, G); // 还没运行够，跳过清理但仍检测异常

  try {
    // 清理旧 tick_log
    db.delete(tickLog).where(sql`${tickLog.tick} < ${cutoffTick}`).run();

    // 清理旧 action_log
    db.delete(actionLog).where(sql`${actionLog.tick} < ${cutoffTick}`).run();

    // M3 修复: 单条 SQL 删除超出保留数的快照，消除 N+1 查询
    const sqlite = getSqlite();
    const result = sqlite
      .prepare(
        `DELETE FROM graph_snapshots WHERE id NOT IN (
          SELECT id FROM graph_snapshots ORDER BY tick DESC LIMIT ?
        )`,
      )
      .run(SNAPSHOT_RETENTION);

    log.debug("Maintenance completed", {
      currentTick,
      cutoffTick,
      snapshotsRemoved: result.changes,
    });
  } catch (e) {
    log.warn("Maintenance failed", e);
  }

  // 异常检测（每次维护时运行）
  return runAnomalyCheck(currentTick, G);
}

function maybeRebuildRhythmProfiles(
  options: { intervalMs: number; timezoneOffset: number } | undefined,
): void {
  if (!options || options.intervalMs <= 0) return;

  const sqlite = getSqlite();
  const nowMs = Date.now();
  const updatedAtMs = getRhythmProfilesUpdatedAtMs(sqlite);
  if (!shouldRebuildRhythmProfiles({ updatedAtMs, nowMs, intervalMs: options.intervalMs })) return;

  try {
    const result = rebuildRhythmProfiles(sqlite, {
      nowMs,
      timezoneOffset: options.timezoneOffset,
      dryRun: false,
    });
    const confident = result.profiles.filter(
      (profile) => profile.confidence === "medium" || profile.confidence === "high",
    ).length;
    log.info("Rhythm profiles rebuilt", {
      profiles: result.profiles.length,
      confident,
      sourceRows: result.stats.rowsRead,
      timezoneOffset: options.timezoneOffset,
    });
  } catch (e) {
    log.warn("Rhythm profile rebuild failed", e);
  }
}
