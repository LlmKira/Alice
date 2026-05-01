/**
 * 运行时异常检测模块。
 *
 * 从 tick_log / action_log / personality_snapshots 检测异常模式，
 * 建议每 50 tick 调用一次。每项检测独立 try-catch，一项失败不影响其他项。
 */
import fs from "node:fs";
import path from "node:path";
import { desc, sql } from "drizzle-orm";
import { classifyIausActionRow } from "../diagnostics/iaus-action-classifier.js";
import type { WorldModel } from "../graph/world-model.js";
import { effectiveUnread } from "../pressure/signal-decay.js";
import { createLogger } from "../utils/logger.js";
import { getDb, getDbPath } from "./connection.js";
import { actionLog, auditEvents, personalitySnapshots, tickLog } from "./schema.js";

const log = createLogger("anomaly");

export interface AnomalyAlert {
  level: "warn" | "error";
  type: string;
  message: string;
  tick: number;
}

/**
 * 运行异常检测。建议每 50 tick 调用一次。
 *
 * @param G - 可选 WorldModel，启用 graph-level 不变量检测（INV-1）。
 * @see docs/adr/177-pressure-field-structural-audit.md §P0
 */
export function runAnomalyCheck(currentTick: number, G?: WorldModel): AnomalyAlert[] {
  const alerts: AnomalyAlert[] = [];

  // api_stagnant: 最近 20 tick API 标准差 < 0.01
  try {
    const db = getDb();
    const rows = db
      .select({ api: tickLog.api })
      .from(tickLog)
      .orderBy(desc(tickLog.tick))
      .limit(20)
      .all();
    if (rows.length >= 10) {
      const values = rows.map((r) => r.api);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
      const std = Math.sqrt(variance);
      if (std < 0.01) {
        alerts.push({
          level: "warn",
          type: "api_stagnant",
          message: `API 标准差 ${std.toFixed(6)} < 0.01（最近 ${rows.length} tick），压力场可能卡住`,
          tick: currentTick,
        });
      }
    }
  } catch (e) {
    log.warn("api_stagnant 检测失败", e);
  }

  // api_overflow: API > 50.0
  try {
    const db = getDb();
    const row = db
      .select({ api: tickLog.api })
      .from(tickLog)
      .orderBy(desc(tickLog.tick))
      .limit(1)
      .get();
    if (row && row.api > 50.0) {
      alerts.push({
        level: "error",
        type: "api_overflow",
        message: `API = ${row.api.toFixed(2)} > 50.0，压力失控`,
        tick: currentTick,
      });
    }
  } catch (e) {
    log.warn("api_overflow 检测失败", e);
  }

  // pressure_dead: 任意 Pi = 0.00 持续 100+ tick
  try {
    const db = getDb();
    const rows = db
      .select({
        p1: tickLog.p1,
        p2: tickLog.p2,
        p3: tickLog.p3,
        p4: tickLog.p4,
        p5: tickLog.p5,
        p6: tickLog.p6,
      })
      .from(tickLog)
      .orderBy(desc(tickLog.tick))
      .limit(100)
      .all();
    if (rows.length >= 100) {
      const names = ["P1", "P2", "P3", "P4", "P5", "P6"] as const;
      const keys = ["p1", "p2", "p3", "p4", "p5", "p6"] as const;
      for (let i = 0; i < 6; i++) {
        const allZero = rows.every((r) => Math.abs(r[keys[i]]) < 1e-6);
        if (allZero) {
          alerts.push({
            level: "warn",
            type: "pressure_dead",
            message: `${names[i]} = 0.00 持续 100+ tick，压力源缺失`,
            tick: currentTick,
          });
        }
      }
    }
  } catch (e) {
    log.warn("pressure_dead 检测失败", e);
  }

  // pressure_extreme: 任意 Pi > 200
  try {
    const db = getDb();
    const row = db
      .select({
        p1: tickLog.p1,
        p2: tickLog.p2,
        p3: tickLog.p3,
        p4: tickLog.p4,
        p5: tickLog.p5,
        p6: tickLog.p6,
      })
      .from(tickLog)
      .orderBy(desc(tickLog.tick))
      .limit(1)
      .get();
    if (row) {
      const names = ["P1", "P2", "P3", "P4", "P5", "P6"] as const;
      const vals = [row.p1, row.p2, row.p3, row.p4, row.p5, row.p6];
      for (let i = 0; i < 6; i++) {
        if (vals[i] > 200) {
          alerts.push({
            level: "warn",
            type: "pressure_extreme",
            message: `${names[i]} = ${vals[i].toFixed(2)} > 200，单维度异常`,
            tick: currentTick,
          });
        }
      }
    }
  } catch (e) {
    log.warn("pressure_extreme 检测失败", e);
  }

  // action_failure_rate: 最近 20 次真实 Telegram 尝试失败 > 50%
  // ADR-254: action_log.success 是整行 host 结果，会把“已发送但等待回复超时”
  // 和后续 self 命令失败混进硬失败率。告警必须基于 tc_command_log 派生的行动事实。
  try {
    const db = getDb();
    const rows = db
      .select({
        actionType: actionLog.actionType,
        success: actionLog.success,
        engagementOutcome: actionLog.engagementOutcome,
        tcAfterward: actionLog.tcAfterward,
        tcCommandLog: actionLog.tcCommandLog,
      })
      .from(actionLog)
      .orderBy(desc(actionLog.tick))
      .limit(20)
      .all();
    if (rows.length >= 5) {
      const classifications = rows.map((r) =>
        classifyIausActionRow({
          action_type: r.actionType,
          success: r.success,
          engagement_outcome: r.engagementOutcome,
          tc_afterward: r.tcAfterward,
          tc_command_log: r.tcCommandLog,
        }),
      );
      const attempts = classifications.filter(
        (c) => c.category === "telegram_success" || c.category === "telegram_failure",
      );
      const failures = attempts.filter((c) => c.category === "telegram_failure").length;
      const rate = attempts.length > 0 ? failures / attempts.length : 0;
      if (rate > 0.5) {
        alerts.push({
          level: "error",
          type: "action_failure_rate",
          message: `Telegram 行动失败率 ${(rate * 100).toFixed(0)}%（最近 ${rows.length} 行中 ${attempts.length} 次 Telegram 尝试，${failures} 次失败）`,
          tick: currentTick,
        });
      }
    }
  } catch (e) {
    log.warn("action_failure_rate 检测失败", e);
  }

  // voice_lost: 最近 10 条 action_log 中 LLM 产出失败超过 50%
  // command_misuse / telegram_failed 是执行或工具面问题，不计入 LLM 失语。
  // @see docs/adr/129-llm-voice-loss-awareness.md
  try {
    const db = getDb();
    const rows = db
      .select({ actionType: actionLog.actionType })
      .from(actionLog)
      .orderBy(desc(actionLog.tick))
      .limit(10)
      .all();
    if (rows.length >= 3) {
      const llmFailures = rows.filter(
        (r) =>
          r.actionType === "llm_failed" ||
          r.actionType === "provider_failed" ||
          r.actionType === "validation_failed",
      ).length;
      const rate = llmFailures / rows.length;
      if (rate > 0.5) {
        alerts.push({
          level: "error",
          type: "voice_lost",
          message: `LLM 失语：最近 ${rows.length} 次行动中 ${llmFailures} 次 LLM 调用失败（${(rate * 100).toFixed(0)}%）`,
          tick: currentTick,
        });
      }
    }
  } catch (e) {
    log.warn("voice_lost 检测失败", e);
  }

  // personality_drift: 相邻快照 π 向量欧氏距离 > 0.3
  try {
    const db = getDb();
    const rows = db
      .select({ tick: personalitySnapshots.tick, weights: personalitySnapshots.weights })
      .from(personalitySnapshots)
      .orderBy(desc(personalitySnapshots.tick))
      .limit(2)
      .all();
    if (rows.length === 2) {
      const w0: number[] = JSON.parse(rows[0].weights);
      const w1: number[] = JSON.parse(rows[1].weights);
      if (w0.length === w1.length) {
        let sumSq = 0;
        for (let i = 0; i < w0.length; i++) {
          sumSq += (w0[i] - w1[i]) ** 2;
        }
        const dist = Math.sqrt(sumSq);
        if (dist > 0.3) {
          alerts.push({
            level: "warn",
            type: "personality_drift",
            message: `人格漂移 ${dist.toFixed(4)} > 0.3（tick ${rows[1].tick} → ${rows[0].tick}）`,
            tick: currentTick,
          });
        }
      }
    }
  } catch (e) {
    log.warn("personality_drift 检测失败", e);
  }

  // voice_starvation: 某声部 200+ tick 未被选为 loudness winner
  // ADR-124 §D7: 使用 tick_log（声部选择记录）替代 action_log（仅成功行动）
  // tick_log.action 列记录 loudness 胜出的声部名称
  // @see docs/adr/126-obligation-field-decay.md §D7
  try {
    const db = getDb();
    const voices = ["diligence", "curiosity", "sociability", "caution"];
    for (const voice of voices) {
      const row = db
        .select({ tick: tickLog.tick })
        .from(tickLog)
        .where(sql`${tickLog.action} = ${voice}`)
        .orderBy(desc(tickLog.tick))
        .limit(1)
        .get();
      const lastTick = row?.tick ?? 0;
      if (currentTick - lastTick > 200) {
        alerts.push({
          level: "warn",
          type: "voice_starvation",
          message: `声部 ${voice} 已 ${currentTick - lastTick} tick 未被选为 loudness winner（上次 tick ${lastTick}）`,
          tick: currentTick,
        });
      }
    }
  } catch (e) {
    log.warn("voice_starvation 检测失败", e);
  }

  // voice_action_starvation: 某声部 loudness 赢面 > 50 次但 action 转化率 < 5%
  // ADR-131 D3: 让声部饥饿问题可观测。声部赢了竞争但被门控拦截的模式。
  // Caution 的主要合法产物是 system1:skip，不是 System 2 行动；System 1 已处理的 tick
  // 也不应进入“应转化为 action”的分母。
  // @see docs/adr/131-feedback-loop-integrity.md §D3
  try {
    const db = getDb();
    const voices = ["diligence", "curiosity", "sociability"];
    for (const voice of voices) {
      // 最近 500 tick 内需要 System 2 消化的 loudness 赢面数。
      const loudnessRow = db
        .select({ cnt: sql<number>`count(*)` })
        .from(tickLog)
        .where(sql`
          ${tickLog.action} = ${voice}
          AND ${tickLog.tick} > ${currentTick - 500}
          AND (
            ${tickLog.gateVerdict} IS NULL
            OR ${tickLog.gateVerdict} NOT IN ('system1:skip', 'system1:mark_read', 'system1:digest')
          )
        `)
        .get();
      const loudnessWins = loudnessRow?.cnt ?? 0;
      if (loudnessWins < 50) continue; // 样本不足

      // 同期 action_log 行动数
      const actionRow = db
        .select({ cnt: sql<number>`count(*)` })
        .from(actionLog)
        .where(sql`${actionLog.voice} = ${voice} AND ${actionLog.tick} > ${currentTick - 500}`)
        .get();
      const actionCount = actionRow?.cnt ?? 0;
      const ratio = actionCount / loudnessWins;

      if (ratio < 0.05) {
        alerts.push({
          level: "warn",
          type: "voice_action_starvation",
          message: `声部 ${voice} 行动饥饿：最近 500 tick 赢得 ${loudnessWins} 次 loudness 竞争但仅 ${actionCount} 次行动（${(ratio * 100).toFixed(1)}%）`,
          tick: currentTick,
        });
      }
    }
  } catch (e) {
    log.warn("voice_action_starvation 检测失败", e);
  }

  // ADR-147 D1: event_buffer_overflow — 最近 50 tick 内 EventBuffer 溢出次数 > 5
  // @see docs/adr/147-flood-backlog-recovery.md §D1
  try {
    const db = getDb();
    const row = db
      .select({ cnt: sql<number>`count(*)` })
      .from(auditEvents)
      .where(
        sql`${auditEvents.source} = 'events'
        AND ${auditEvents.message} LIKE '%overflow%'
        AND ${auditEvents.tick} > ${currentTick - 50}`,
      )
      .get();
    if (row && row.cnt > 5) {
      alerts.push({
        level: "warn",
        type: "event_buffer_overflow",
        message: `EventBuffer 最近 50 tick 溢出 ${row.cnt} 次，可能存在积压洪水`,
        tick: currentTick,
      });
    }
  } catch (e) {
    log.warn("event_buffer_overflow 检测失败", e);
  }

  // db_bloat: WAL 文件 > 50MB
  try {
    const walPath = path.resolve(`${getDbPath()}-wal`);
    if (fs.existsSync(walPath)) {
      const stat = fs.statSync(walPath);
      const sizeMB = stat.size / (1024 * 1024);
      if (sizeMB > 50) {
        alerts.push({
          level: "warn",
          type: "db_bloat",
          message: `WAL 文件 ${sizeMB.toFixed(1)}MB > 50MB，数据库膨胀`,
          tick: currentTick,
        });
      }
    }
  } catch (e) {
    log.warn("db_bloat 检测失败", e);
  }

  // INV-1: rawUnread > 50 但 effectiveUnread ≈ 0 — ADR-176 的蟑螂检测器
  // 如果有频道积累了大量未读但 effectiveUnread 近零，说明信号衰减层有设计盲区。
  // @see docs/adr/177-pressure-field-structural-audit.md §P0 INV-1
  if (G) {
    try {
      const nowMs = Date.now();
      const violations: string[] = [];
      for (const hid of G.getEntitiesByType("channel")) {
        const rawUnread = G.getChannel(hid).unread ?? 0;
        if (rawUnread <= 50) continue;
        const eu = effectiveUnread(G, hid, nowMs);
        // rawUnread > 50 但 effectiveUnread < 1.0 — 信号几乎不可见
        if (eu < 1.0) {
          violations.push(`${hid}(raw=${rawUnread},eu=${eu.toFixed(2)})`);
        }
      }
      if (violations.length > 0) {
        alerts.push({
          level: "error",
          type: "unread_signal_blind",
          message: `${violations.length} 个频道有 >50 未读但 effectiveUnread < 1.0: ${violations.slice(0, 3).join(", ")}${violations.length > 3 ? "..." : ""}`,
          tick: currentTick,
        });
      }
    } catch (e) {
      log.warn("unread_signal_blind 检测失败", e);
    }
  }

  // INV-3: V-max 目标覆盖率 — 有压力的频道是否在 200 ticks 内被选中过
  // @see docs/adr/177-pressure-field-structural-audit.md §P0 INV-3
  if (G) {
    try {
      const db = getDb();
      // 收集最近 200 tick 内 V-max 选中过的 target
      const actionRows = db
        .select({ target: actionLog.chatId })
        .from(actionLog)
        .where(sql`${actionLog.tick} > ${currentTick - 200} AND ${actionLog.chatId} IS NOT NULL`)
        .all();
      const coveredTargets = new Set(actionRows.map((r) => r.target).filter(Boolean));

      // 收集当前有未读 >0 的活跃频道
      const activeChannels: string[] = [];
      for (const hid of G.getEntitiesByType("channel")) {
        if ((G.getChannel(hid).unread ?? 0) > 0) {
          activeChannels.push(hid);
        }
      }

      if (activeChannels.length > 0) {
        const uncovered = activeChannels.filter((hid) => !coveredTargets.has(hid));
        const coverageRate = 1 - uncovered.length / activeChannels.length;
        if (coverageRate < 0.5 && activeChannels.length >= 3) {
          alerts.push({
            level: "warn",
            type: "vmax_coverage_low",
            message: `V-max 目标覆盖率 ${(coverageRate * 100).toFixed(0)}%（${activeChannels.length} 个活跃频道中 ${uncovered.length} 个最近 200 tick 未被选中）`,
            tick: currentTick,
          });
        }
      }
    } catch (e) {
      log.warn("vmax_coverage_low 检测失败", e);
    }
  }

  // INV-4: tanh 饱和检测 — 某个 P_k 对 >50% 的 tick 饱和在 >0.99
  // 自适应 κ 应该防止这种情况，但如果发生说明 κ 跟不上。
  // @see docs/adr/177-pressure-field-structural-audit.md §P0 INV-4
  try {
    const db = getDb();
    const rows = db
      .select({
        p1: tickLog.p1,
        p2: tickLog.p2,
        p3: tickLog.p3,
        p4: tickLog.p4,
        p5: tickLog.p5,
        p6: tickLog.p6,
      })
      .from(tickLog)
      .orderBy(desc(tickLog.tick))
      .limit(100)
      .all();
    if (rows.length >= 50) {
      const kappa = [5.0, 8.0, 8.0, 5.0, 3.0, 5.0];
      const names = ["P1", "P2", "P3", "P4", "P5", "P6"] as const;
      const keys = ["p1", "p2", "p3", "p4", "p5", "p6"] as const;
      for (let i = 0; i < 6; i++) {
        const saturatedCount = rows.filter((r) => Math.tanh(r[keys[i]] / kappa[i]) > 0.99).length;
        if (saturatedCount > rows.length * 0.5) {
          alerts.push({
            level: "warn",
            type: "pressure_saturated",
            message: `${names[i]} tanh 饱和率 ${((saturatedCount / rows.length) * 100).toFixed(0)}%（${saturatedCount}/${rows.length} tick），κ₍${i + 1}₎=${kappa[i]} 可能不足`,
            tick: currentTick,
          });
        }
      }
    }
  } catch (e) {
    log.warn("pressure_saturated 检测失败", e);
  }

  // 输出结果
  for (const alert of alerts) {
    if (alert.level === "error") {
      log.error(`[${alert.type}] ${alert.message}`);
    } else {
      log.warn(`[${alert.type}] ${alert.message}`);
    }
  }

  return alerts;
}
