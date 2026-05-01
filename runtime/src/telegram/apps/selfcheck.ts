/**
 * use_selfcheck_app — Alice 的镜子（clean-room 替代 debug.mod）。
 *
 * 五个维度的自我感知：情绪、社交、人格、压力、行动。
 * 所有输出语义化——绝对不暴露原始数值（P1-P6、drift、mood_valence 等）。
 *
 * @see docs/adr/133-app-social-value-audit.md — Wave 5 Agent 专属 App
 * @see AGENTS.md — LLM 语义无障碍原则
 */

import { desc } from "drizzle-orm";
import { PromptBuilder } from "../../core/prompt-style.js";
import { type AnomalyAlert, runAnomalyCheck } from "../../db/anomaly.js";
import { getDb } from "../../db/connection.js";
import { actionLog, tickLog } from "../../db/schema.js";
import { readEmotionState } from "../../emotion/graph.js";
import { renderEmotionProjection } from "../../emotion/projection.js";
import { emotionStateArousalSignal, emotionStateMoodSignal } from "../../emotion/state.js";
import { ensureChannelId, tierLabel } from "../../graph/constants.js";
import type { DunbarTier } from "../../graph/entities.js";
import type { WorldModel } from "../../graph/world-model.js";
import { getSilenceThresholdS } from "../../mods/strategy/types.js";
import { computeGoldilocksUtility } from "../../pressure/goldilocks.js";
import { humanDuration, humanDurationAgo } from "../../utils/time-format.js";
import type { SelfcheckResultSchema as SelfcheckResult } from "../action-schemas.js";

export type { SelfcheckResultSchema as SelfcheckResult } from "../action-schemas.js";

// ═══════════════════════════════════════════════════════════════════════════
// 语义标签映射（代码侧完成，LLM 不接触数值）
// @see AGENTS.md — LLM 语义无障碍原则
// ═══════════════════════════════════════════════════════════════════════════

/** 数值效价 → 语义标签（复用 observer.mod 的逻辑）。 */
function valenceLabel(v: number): string {
  if (v > 0.6) return "very positive";
  if (v > 0.2) return "slightly positive";
  if (v > -0.2) return "neutral";
  if (v > -0.6) return "slightly negative";
  return "very negative";
}

/** 数值唤醒度 → 语义标签。 */
function arousalLabel(a: number): string {
  if (a > 0.7) return "intense";
  if (a > 0.35) return "mild";
  return "calm";
}

/** 人格权重百分比 → 语义强度（不暴露百分比数值）。 */
function weightStrengthLabel(pct: number): string {
  if (pct >= 35) return "dominant";
  if (pct >= 25) return "strong";
  if (pct >= 18) return "moderate";
  return "mild";
}

/** 行动成功率 → 语义标签。 */
function successRateLabel(rate: number): string {
  if (rate >= 0.8) return "most succeeded";
  if (rate >= 0.5) return "mixed results";
  return "struggling";
}

/** 压力趋势方向。 */
function trendLabel(first: number, second: number): string {
  const delta = second - first;
  const threshold = Math.max(Math.abs(first) * 0.15, 0.5);
  if (delta > threshold) return "rising";
  if (delta < -threshold) return "falling";
  return "steady";
}

/** P1-P6 的人话名称。 */
const PRESSURE_NAMES: Record<string, string> = {
  p1: "Intimacy need",
  p2: "Memory pressure",
  p3: "Social presence",
  p4: "Thread urgency",
  p5: "Response obligation",
  p6: "Exploration drive",
};

// ═══════════════════════════════════════════════════════════════════════════
// 各维度聚合函数
// ═══════════════════════════════════════════════════════════════════════════

/** 情绪快照。 */
function gatherMood(graph: WorldModel, nowMs: number): string[] {
  const m = new PromptBuilder();
  if (!graph.has("self")) {
    m.line("(no self data)");
    return m.build();
  }
  const emotionState = readEmotionState(graph, nowMs);
  const emotionProjection = renderEmotionProjection(emotionState);
  const effective = emotionStateMoodSignal(emotionState);
  const arousal = emotionStateArousalSignal(emotionState);

  let line = `${valenceLabel(effective)}, ${arousalLabel(arousal)}`;
  if (emotionState.dominant) {
    line += ` (${humanDurationAgo(emotionState.dominant.ageMs / 1000)})`;
  }
  m.line(line);
  if (emotionProjection) {
    m.line(emotionProjection);
    m.line("This mood has a recent cause and is fading over time.");
  } else {
    m.line("No active self emotion episode is carrying the current mood.");
  }
  return m.build();
}

/** 社交健康（吸收 contacts）。 */
function gatherSocial(graph: WorldModel, nowMs: number, detailed: boolean): string[] {
  const m = new PromptBuilder();
  const contacts = graph.getEntitiesByType("contact");

  // Tier 分桶
  const buckets: Record<string, number> = {
    intimate: 0,
    "close friend": 0,
    friend: 0,
    acquaintance: 0,
    known: 0,
  };
  for (const id of contacts) {
    const tier = graph.getContact(id).tier;
    const label = tierLabel(tier);
    buckets[label] = (buckets[label] ?? 0) + 1;
  }
  const summary = Object.entries(buckets)
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${n} ${label}`)
    .join(", ");
  m.line(`Social circle: ${summary}`);

  // Cooling 检测 + Goldilocks
  interface CoolingEntry {
    name: string;
    tierName: string;
    silenceDesc: string;
  }
  const cooling: CoolingEntry[] = [];
  let goldilocksCount = 0;
  const goldilocksNames: string[] = [];

  for (const id of contacts) {
    const attrs = graph.getContact(id);
    const tier = attrs.tier as DunbarTier;
    const displayName = String(graph.getDynamic(id, "display_name") ?? id);
    const chVariant = ensureChannelId(id) ?? "";
    const lastInteractionMs = Math.max(
      attrs.last_alice_action_ms ?? 0,
      attrs.last_active_ms ?? 0,
      chVariant && graph.has(chVariant)
        ? (graph.getChannel(chVariant).last_alice_action_ms ?? 0)
        : 0,
    );

    if (lastInteractionMs <= 0) continue;
    const silenceS = (nowMs - lastInteractionMs) / 1000;
    const thresholdS = getSilenceThresholdS(tier);

    // Goldilocks
    const utility = computeGoldilocksUtility(silenceS, tier);
    if (utility > 0.5) {
      goldilocksCount++;
      if (goldilocksNames.length < 3) goldilocksNames.push(displayName);
    }

    // Cooling: 超过阈值
    if (silenceS > thresholdS) {
      cooling.push({
        name: displayName,
        tierName: tierLabel(tier),
        silenceDesc: humanDuration(silenceS),
      });
    }
  }

  // 排序：沉默最久的在前
  cooling.sort((a, b) => a.silenceDesc.localeCompare(b.silenceDesc));

  const showCooling = detailed ? cooling : cooling.slice(0, 3);
  for (const c of showCooling) {
    m.line(`\u26A0 ${c.name} (${c.tierName}) — no contact in ${c.silenceDesc}`);
  }
  if (!detailed && cooling.length > 3) {
    m.line(`... and ${cooling.length - 3} more cooling contacts`);
  }

  if (goldilocksCount > 0) {
    const names = goldilocksNames.join(", ");
    const extra = goldilocksCount > goldilocksNames.length ? " and more" : "";
    m.line(`\u2713 ${goldilocksCount} in Goldilocks window (${names}${extra})`);
  }

  return m.build();
}

/** 人格健康。 */
function gatherPersonality(graph: WorldModel): string[] {
  const m = new PromptBuilder();
  if (!graph.has("self")) {
    m.line("(no self data)");
    return m.build();
  }
  const agent = graph.getAgent("self");
  const health = agent.personality_health ?? "healthy";
  const weightsRaw = agent.personality_weights;

  let line = health;
  if (weightsRaw) {
    try {
      const weights: number[] = JSON.parse(weightsRaw);
      const VOICE_NAMES = ["diligence", "curiosity", "sociability", "caution"];
      // 将权重转为占比并排序
      const total = weights.reduce((a, b) => a + b, 0) || 1;
      const ranked = weights
        .map((w, i) => ({ name: VOICE_NAMES[i] ?? `voice${i}`, pct: (w / total) * 100 }))
        .sort((a, b) => b.pct - a.pct);

      // 只展示前两位，用语义强度标签代替百分比
      const topTwo = ranked
        .slice(0, 2)
        .map((r) => `${r.name} (${weightStrengthLabel(r.pct)})`)
        .join(", ");
      line += ` — leaning ${topTwo}`;
    } catch {
      // JSON parse 失败，只显示 health
    }
  }

  m.line(line);

  if (health === "warning" || health === "alert") {
    m.line(`\u26A0 Personality health: ${health} — consider checking in`);
  }

  return m.build();
}

/** 压力趋势（绝对不暴露原始 P 值）。 */
function gatherPressureTrend(): string[] {
  const m = new PromptBuilder();
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
      .limit(20)
      .all();

    if (rows.length < 6) {
      m.line("(not enough data for trend)");
      return m.build();
    }

    // 时间正序
    const ordered = rows.reverse();
    const half = Math.floor(ordered.length / 2);
    const firstHalf = ordered.slice(0, half);
    const secondHalf = ordered.slice(half);

    const keys = ["p1", "p2", "p3", "p4", "p5", "p6"] as const;
    const trends: string[] = [];
    for (const key of keys) {
      const avg1 = firstHalf.reduce((s, r) => s + r[key], 0) / firstHalf.length;
      const avg2 = secondHalf.reduce((s, r) => s + r[key], 0) / secondHalf.length;
      const trend = trendLabel(avg1, avg2);
      const name = PRESSURE_NAMES[key] ?? key;
      trends.push(`${name} ${trend}`);
    }

    m.line(trends.join(" | "));
  } catch {
    m.line("(pressure data unavailable)");
  }
  return m.build();
}

/** 行动质量 + 异常检测。 */
function gatherActions(currentTick: number): string[] {
  const m = new PromptBuilder();
  try {
    const db = getDb();
    const rows = db
      .select({
        voice: actionLog.voice,
        success: actionLog.success,
      })
      .from(actionLog)
      .orderBy(desc(actionLog.tick))
      .limit(50)
      .all();

    if (rows.length === 0) {
      m.line("(no recent actions)");
      return m.build();
    }

    const successCount = rows.filter((r) => r.success).length;
    const rate = successCount / rows.length;
    const byVoice: Record<string, number> = {};
    for (const r of rows) {
      byVoice[r.voice] = (byVoice[r.voice] ?? 0) + 1;
    }

    // 成功率用语义标签
    const dominantVoice = Object.entries(byVoice).sort(([, a], [, b]) => b - a)[0]?.[0];
    let line = `${successRateLabel(rate)}`;
    if (dominantVoice) line += `, mostly ${dominantVoice} voice`;
    m.line(line);

    // 异常检测（语义化）
    const anomalies = runAnomalyCheck(currentTick);
    for (const a of anomalies) {
      m.line(`\u26A0 ${semanticAnomaly(a)}`);
    }
  } catch {
    m.line("(action data unavailable)");
  }
  return m.build();
}

/** 将 anomaly alert 转为语义化描述（不暴露内部数值）。 */
function semanticAnomaly(a: AnomalyAlert): string {
  switch (a.type) {
    case "api_stagnant":
      return "Pressure field may be stuck — no recent change";
    case "api_overflow":
      return "Pressure is dangerously high — system overload";
    case "pressure_dead":
      return `One pressure dimension is inactive — ${a.message.split(" ")[0]} flatlined`;
    case "pressure_extreme":
      return `One pressure dimension is unusually high — ${a.message.split(" ")[0]}`;
    case "action_failure_rate":
      return "Actions are failing frequently — something may be wrong";
    case "voice_lost":
      return "LLM calls failing repeatedly — voice may be lost";
    case "personality_drift":
      return "Personality is drifting — check in";
    case "voice_starvation": {
      // 提取声部名称，转换 tick 为人话时间
      const match = a.message.match(/声部 (\w+) 已 (\d+) tick/);
      if (match) {
        const voice = match[1];
        const ticks = Number(match[2]);
        return `${voice} hasn't been active in ${humanDuration(ticks * 60)}`;
      }
      return "A voice hasn't been active for a while";
    }
    case "voice_action_starvation": {
      const match = a.message.match(/声部 (\w+)/);
      const voice = match?.[1] ?? "A voice";
      return `${voice} keeps winning but gets blocked before acting`;
    }
    case "event_buffer_overflow":
      return "Event buffer overflowing — messages may be lost";
    case "db_bloat":
      return "Database is getting large — may need cleanup";
    default:
      return "System anomaly detected";
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 公开 API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 聚合 selfcheck 数据。
 *
 * 不依赖任何 Mod state——所有数据从 graph 和 DB 直接读取。
 *
 * @param graph 世界模型
 * @param nowMs 当前墙钟时间
 * @param currentTick 当前 tick（用于异常检测）
 * @param focus 可选聚焦维度（省略则全景概览）
 */
export function getSelfcheckData(
  graph: WorldModel,
  nowMs: number,
  currentTick: number,
  focus?: "mood" | "social" | "personality" | "pressure" | "actions",
): SelfcheckResult {
  const sections: SelfcheckResult["sections"] = [];

  const shouldInclude = (dim: string) => !focus || focus === dim;

  if (shouldInclude("mood")) {
    sections.push({
      dimension: "mood",
      label: "Mood",
      lines: gatherMood(graph, nowMs),
    });
  }

  if (shouldInclude("social")) {
    sections.push({
      dimension: "social",
      label: "Social",
      lines: gatherSocial(graph, nowMs, focus === "social"),
    });
  }

  if (shouldInclude("personality")) {
    sections.push({
      dimension: "personality",
      label: "Personality",
      lines: gatherPersonality(graph),
    });
  }

  if (shouldInclude("pressure")) {
    sections.push({
      dimension: "pressure",
      label: "Pressure trend",
      lines: gatherPressureTrend(),
    });
  }

  if (shouldInclude("actions")) {
    sections.push({
      dimension: "actions",
      label: "Recent actions",
      lines: gatherActions(currentTick),
    });
  }

  return { sections };
}
