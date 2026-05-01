/**
 * A2 声部多样性分析 — ADR-76 自动化行为验证。
 *
 * - 声部选择 Shannon 熵（H）→ 对标 HUMA Timeliness 理论最大熵
 * - 声部轮换率（连续相同声部 / 总行动）→ ADR-75 voice fatigue 效果验证
 * - 人格漂移追踪（π 变化率 vs 压力振荡周期比）→ V5 记忆慢变量
 *
 * @see docs/adr/76-naturalness-validation-methodology.md
 * @see docs/adr/74-huma-cross-pollination/74-huma-cross-pollination.md §差距1
 * @see docs/adr/75-deliberation-state/75-deliberation-state.md
 */

import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/connection.js";
import {
  actionLog,
  candidateTrace,
  decisionTrace,
  personalitySnapshots,
  tickLog,
} from "../db/schema.js";
import { VOICE_COUNT } from "../voices/personality.js";

const IAUS_ACTION_VOICE_COUNT = 3;

// ═══════════════════════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════════════════════

export interface VoiceDiversityReport {
  /** 声部选择的 Shannon 熵 H（bits）。最大值 = log2(5) ≈ 2.32。 */
  shannonEntropy: number;
  /** 理论最大熵（= log2(声部数)）。 */
  maxEntropy: number;
  /** 归一化熵 H/H_max ∈ [0, 1]。1 = 完全均匀，0 = 只用一个声部。 */
  normalizedEntropy: number;
  /** 各声部使用频率。 */
  voiceFrequencies: Record<string, number>;
  /** 连续相同声部的比率 = 连续重复次数 / (总行动数 - 1)。 */
  consecutiveRepeatRate: number;
  /** 人格漂移分析（需要 personality_snapshots 数据）。 */
  personalityDrift: PersonalityDriftReport | null;
  /** 按观测层拆开的声部序列。A2 权威面是 voice_selection_tick_log。 */
  planes: Record<string, VoiceDiversityPlaneReport>;
  /** A2 当前采用的权威观测面。 */
  authorityPlane: "voice_selection_tick_log";
}

export interface VoiceDiversityPlaneReport {
  /** 样本数。 */
  sampleCount: number;
  /** 声部选择的 Shannon 熵 H（bits）。 */
  shannonEntropy: number;
  /** 当前观测面的理论最大熵。 */
  maxEntropy: number;
  /** 归一化熵 H/H_max ∈ [0, 1]。 */
  normalizedEntropy: number;
  /** 各声部使用频率。 */
  voiceFrequencies: Record<string, number>;
  /** 连续相同声部的比率。 */
  consecutiveRepeatRate: number;
}

export interface PersonalityDriftReport {
  /** π 变化速率（每 tick 的 L2 位移平均值）。 */
  meanDriftPerTick: number;
  /** 压力振荡周期（行动间隔中位数）。 */
  pressureOscillationPeriod: number;
  /**
   * 漂移时间尺度比 = π 达到显著变化（> 0.1）所需 tick / 压力振荡周期。
   * V5 预测：此比值 >> 1（记忆是慢变量）。
   */
  driftToOscillationRatio: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// 分析函数
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 分析声部多样性。
 *
 * 从 tick_log 读取声部选择序列，计算 Shannon 熵和轮换率。
 * 从 personality_snapshots 读取 π 演化，计算漂移速率。
 */
export function analyzeVoiceDiversity(): VoiceDiversityReport {
  const db = getDb();

  // ── 1. 声部选择权威序列 ───────────────────────────────────────────────
  // ADR-124 D7: tick_log.action 是 loudness winner；action_log 是下游执行记录。
  const voiceSelections = db
    .select({ voice: tickLog.action })
    .from(tickLog)
    .orderBy(asc(tickLog.tick), asc(tickLog.id))
    .all();

  const authority = summarizeVoiceSequence(voiceSelections, VOICE_COUNT);
  const planes = buildVoiceDiversityPlanes(db, authority);

  // ── 3. 人格漂移（V5）────────────────────────────────────────────────
  const personalityDrift = analyzePersonalityDrift(db);

  return {
    shannonEntropy: authority.shannonEntropy,
    maxEntropy: authority.maxEntropy,
    normalizedEntropy: authority.normalizedEntropy,
    voiceFrequencies: authority.voiceFrequencies,
    consecutiveRepeatRate: authority.consecutiveRepeatRate,
    personalityDrift,
    planes,
    authorityPlane: "voice_selection_tick_log",
  };
}

function summarizeVoiceSequence(
  rows: Array<{ voice: string | null }>,
  expectedVoiceCount: number,
): VoiceDiversityPlaneReport {
  const voices = rows.map((row) => row.voice).filter((voice): voice is string => Boolean(voice));
  const voiceCounts: Record<string, number> = {};
  for (const voice of voices) {
    voiceCounts[voice] = (voiceCounts[voice] ?? 0) + 1;
  }

  const total = voices.length;
  const voiceFrequencies: Record<string, number> = {};
  for (const [voice, count] of Object.entries(voiceCounts)) {
    voiceFrequencies[voice] = total > 0 ? count / total : 0;
  }

  let shannonEntropy = 0;
  if (total > 0) {
    for (const freq of Object.values(voiceFrequencies)) {
      if (freq > 0) {
        shannonEntropy -= freq * Math.log2(freq);
      }
    }
  }

  let consecutiveRepeats = 0;
  for (let i = 1; i < voices.length; i++) {
    if (voices[i] === voices[i - 1]) {
      consecutiveRepeats++;
    }
  }

  const maxEntropy = Math.log2(expectedVoiceCount);
  const normalizedEntropy = maxEntropy > 0 ? shannonEntropy / maxEntropy : 0;
  return {
    sampleCount: total,
    shannonEntropy,
    maxEntropy,
    normalizedEntropy,
    voiceFrequencies,
    consecutiveRepeatRate: voices.length > 1 ? consecutiveRepeats / (voices.length - 1) : 0,
  };
}

function buildVoiceDiversityPlanes(
  db: ReturnType<typeof getDb>,
  authority: VoiceDiversityPlaneReport,
): Record<string, VoiceDiversityPlaneReport> {
  const actionLogAll = db
    .select({ voice: actionLog.voice })
    .from(actionLog)
    .orderBy(asc(actionLog.tick), asc(actionLog.id))
    .all();
  const actionLogSuccess = db
    .select({ voice: actionLog.voice })
    .from(actionLog)
    .where(eq(actionLog.success, true))
    .orderBy(asc(actionLog.tick), asc(actionLog.id))
    .all();
  const decisionEnqueue = db
    .select({ payloadJson: decisionTrace.payloadJson })
    .from(decisionTrace)
    .where(and(eq(decisionTrace.phase, "evolve"), eq(decisionTrace.finalDecision, "enqueue")))
    .orderBy(asc(decisionTrace.tick), asc(decisionTrace.id))
    .all()
    .map((row) => ({ voice: readSelectedAction(row.payloadJson) }));
  const candidateSelectedAll = db
    .select({ voice: candidateTrace.actionType })
    .from(candidateTrace)
    .where(eq(candidateTrace.selected, true))
    .orderBy(asc(candidateTrace.tick), asc(candidateTrace.id))
    .all();
  const candidateSelectedNormal = db
    .select({ voice: candidateTrace.actionType })
    .from(candidateTrace)
    .where(and(eq(candidateTrace.selected, true), eq(candidateTrace.gatePlane, "none")))
    .orderBy(asc(candidateTrace.tick), asc(candidateTrace.id))
    .all();
  const candidateSelectedDirected = db
    .select({ voice: candidateTrace.actionType })
    .from(candidateTrace)
    .where(
      and(eq(candidateTrace.selected, true), eq(candidateTrace.gatePlane, "directed_override")),
    )
    .orderBy(asc(candidateTrace.tick), asc(candidateTrace.id))
    .all();

  return {
    voice_selection_tick_log: authority,
    decision_enqueue: summarizeVoiceSequence(decisionEnqueue, IAUS_ACTION_VOICE_COUNT),
    iaus_selected_all: summarizeVoiceSequence(candidateSelectedAll, IAUS_ACTION_VOICE_COUNT),
    iaus_selected_normal: summarizeVoiceSequence(candidateSelectedNormal, IAUS_ACTION_VOICE_COUNT),
    iaus_selected_directed_override: summarizeVoiceSequence(
      candidateSelectedDirected,
      IAUS_ACTION_VOICE_COUNT,
    ),
    action_log_all: summarizeVoiceSequence(actionLogAll, IAUS_ACTION_VOICE_COUNT),
    action_log_success: summarizeVoiceSequence(actionLogSuccess, IAUS_ACTION_VOICE_COUNT),
  };
}

function readSelectedAction(payloadJson: string): string | null {
  try {
    const payload = JSON.parse(payloadJson) as { selectedAction?: unknown };
    return typeof payload.selectedAction === "string" ? payload.selectedAction : null;
  } catch {
    return null;
  }
}

/**
 * 分析人格向量漂移速率 vs 压力振荡周期。
 *
 * V5 预测：π 的演化时间尺度 >> 压力振荡时间尺度（记忆是慢变量）。
 */
function analyzePersonalityDrift(db: ReturnType<typeof getDb>): PersonalityDriftReport | null {
  const snapshots = db
    .select({ tick: personalitySnapshots.tick, weights: personalitySnapshots.weights })
    .from(personalitySnapshots)
    .orderBy(asc(personalitySnapshots.tick))
    .all();

  if (snapshots.length < 2) return null;

  // π 变化速率：相邻快照的 L2 距离 / tick 差
  const drifts: number[] = [];
  for (let i = 1; i < snapshots.length; i++) {
    const prev = z.array(z.number()).parse(JSON.parse(snapshots[i - 1].weights));
    const curr = z.array(z.number()).parse(JSON.parse(snapshots[i].weights));
    const tickDiff = snapshots[i].tick - snapshots[i - 1].tick;
    if (tickDiff <= 0) continue;

    let l2 = 0;
    for (let d = 0; d < Math.min(prev.length, curr.length); d++) {
      l2 += (curr[d] - prev[d]) ** 2;
    }
    drifts.push(Math.sqrt(l2) / tickDiff);
  }

  if (drifts.length === 0) return null;

  const meanDriftPerTick = drifts.reduce((a, b) => a + b, 0) / drifts.length;

  // 压力振荡周期 ≈ 行动间隔中位数
  const actionTicks = db
    .select({ tick: actionLog.tick })
    .from(actionLog)
    .orderBy(asc(actionLog.tick))
    .all();

  const intervals: number[] = [];
  for (let i = 1; i < actionTicks.length; i++) {
    intervals.push(actionTicks[i].tick - actionTicks[i - 1].tick);
  }
  intervals.sort((a, b) => a - b);
  const pressureOscillationPeriod =
    intervals.length > 0 ? intervals[Math.floor(intervals.length / 2)] : 1;

  // 达到 Δπ > 0.1 所需 tick 数 ≈ 0.1 / meanDriftPerTick
  const ticksToSignificantDrift = meanDriftPerTick > 0 ? 0.1 / meanDriftPerTick : Infinity;
  const driftToOscillationRatio =
    pressureOscillationPeriod > 0 ? ticksToSignificantDrift / pressureOscillationPeriod : Infinity;

  return {
    meanDriftPerTick,
    pressureOscillationPeriod,
    driftToOscillationRatio,
  };
}
