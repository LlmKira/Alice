/**
 * ADR-76 诊断 CLI — 从 alice.db 生成完整行为验证报告。
 *
 * 用法：pnpm run diagnose [db-path]
 *
 * @see docs/adr/76-naturalness-validation-methodology.md
 */

import { closeDb, getSqlite, initDb } from "../db/connection.js";
import { ALICE_DB_PATH } from "../runtime-paths.js";
import type { SocialVisibility } from "../social-case/types.js";
import { renderActionClosureDiagnostic } from "./action-closure.js";
import { counterfactualD5 } from "./counterfactual.js";
import { renderDcpPromptCompare } from "./dcp-prompt-compare.js";
import { renderDcpReplayDiagnostic } from "./dcp-replay.js";
import { renderDecisionTraceDiagnostic } from "./decision-trace.js";
import { analyzeVoiceDiversity } from "./diversity.js";
import {
  analyzeExecutionConversion,
  renderExecutionConversionReport,
} from "./execution-conversion.js";
import { renderExecutionGrainReport } from "./execution-grain.js";
import { analyzeP4ThreadLifecycle, renderP4ThreadLifecycleReport } from "./p4-thread-lifecycle.js";
import { analyzeRhythm } from "./rhythm.js";
import { analyzeSilenceQuality } from "./silence-quality.js";
import { analyzeSocialCases, renderSocialCaseDiagnosticReport } from "./social-case.js";
import { renderSocialCaseThreadContrastDiagnostic } from "./social-case-thread-contrast.js";
import { renderTargetControlProjectionDiagnostic } from "./target-control-projection.js";

const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
const command = args[0];

function parseNumberFlag(name: string): number | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const raw = args[index + 1];
  if (!raw) throw new Error(`Missing value for ${name}`);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) throw new Error(`Invalid integer for ${name}: ${raw}`);
  return parsed;
}

function parseStringFlag(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const raw = args[index + 1];
  if (!raw) throw new Error(`Missing value for ${name}`);
  return raw;
}

function parseSurfaceFlag(): SocialVisibility {
  const raw = parseStringFlag("--surface") ?? "private";
  if (raw === "private" || raw === "public" || raw === "semi_public") return raw;
  throw new Error(`Invalid --surface value: ${raw}`);
}

const dbPath =
  command === "action-closure" ||
  command === "decision" ||
  command === "dcp" ||
  command === "dcp-compare" ||
  command === "grain" ||
  command === "p4-thread-lifecycle" ||
  command === "social-case" ||
  command === "social-case-thread-contrast" ||
  command === "target-control"
    ? (parseStringFlag("--db") ?? ALICE_DB_PATH)
    : (process.argv[2] ?? ALICE_DB_PATH);

if (command === "action-closure") {
  try {
    initDb(dbPath);
    console.log(
      renderActionClosureDiagnostic({
        limit: parseNumberFlag("--limit") ?? 20,
        json: args.includes("--json"),
      }),
    );
  } catch (e) {
    console.error("action closure 诊断失败:", e);
    process.exit(1);
  } finally {
    closeDb();
  }
  process.exit(0);
}

if (command === "p4-thread-lifecycle") {
  try {
    initDb(dbPath);
    console.log(
      renderP4ThreadLifecycleReport(analyzeP4ThreadLifecycle(getSqlite()), {
        limit: parseNumberFlag("--limit") ?? 12,
      }),
    );
  } catch (e) {
    console.error("P4 thread lifecycle 诊断失败:", e);
    process.exit(1);
  } finally {
    closeDb();
  }
  process.exit(0);
}

if (command === "social-case-thread-contrast") {
  try {
    initDb(dbPath);
    console.log(
      renderSocialCaseThreadContrastDiagnostic({
        limit: parseNumberFlag("--limit") ?? 20,
        json: args.includes("--json"),
      }),
    );
  } catch (e) {
    console.error("social case thread contrast 诊断失败:", e);
    process.exit(1);
  } finally {
    closeDb();
  }
  process.exit(0);
}

if (command === "social-case") {
  try {
    initDb(dbPath);
    console.log(
      renderSocialCaseDiagnosticReport(analyzeSocialCases(), {
        surfaceVisibility: parseSurfaceFlag(),
        limit: parseNumberFlag("--limit") ?? 5,
        json: args.includes("--json"),
      }),
    );
  } catch (e) {
    console.error("social case 诊断失败:", e);
    process.exit(1);
  } finally {
    closeDb();
  }
  process.exit(0);
}

if (command === "target-control") {
  try {
    initDb(dbPath);
    console.log(
      renderTargetControlProjectionDiagnostic({
        target: parseStringFlag("--target"),
        limit: parseNumberFlag("--limit") ?? 20,
        json: args.includes("--json"),
      }),
    );
  } catch (e) {
    console.error("target control projection 诊断失败:", e);
    process.exit(1);
  } finally {
    closeDb();
  }
  process.exit(0);
}

if (command === "grain") {
  try {
    initDb(dbPath);
    console.log(
      renderExecutionGrainReport({
        promptLogsDir: parseStringFlag("--prompt-logs") ?? "prompt-logs",
        limit: parseNumberFlag("--limit") ?? 50,
        since: parseStringFlag("--since"),
        json: args.includes("--json"),
      }),
    );
  } catch (e) {
    console.error("execution grain 诊断失败:", e);
    process.exit(1);
  } finally {
    closeDb();
  }
  process.exit(0);
}

if (command === "decision") {
  try {
    initDb(dbPath);
    console.log(
      renderDecisionTraceDiagnostic({
        tick: parseNumberFlag("--tick"),
        actionLogId: parseNumberFlag("--action-log-id"),
        limit: parseNumberFlag("--limit") ?? 20,
        json: args.includes("--json"),
      }),
    );
  } catch (e) {
    console.error("decision trace 诊断失败:", e);
    process.exit(1);
  } finally {
    closeDb();
  }
  process.exit(0);
}

if (command === "dcp-compare") {
  try {
    const promptLogPath = parseStringFlag("--prompt-log");
    if (!promptLogPath) throw new Error("Missing --prompt-log <path>");
    initDb(dbPath);
    console.log(
      renderDcpPromptCompare({
        promptLogPath,
        chatId: parseStringFlag("--chat-id"),
        limit: parseNumberFlag("--limit") ?? 100,
        json: args.includes("--json"),
      }),
    );
  } catch (e) {
    console.error("DCP prompt compare 诊断失败:", e);
    process.exit(1);
  } finally {
    closeDb();
  }
  process.exit(0);
}

if (command === "dcp") {
  try {
    initDb(dbPath);
    console.log(
      renderDcpReplayDiagnostic({
        chatId: parseStringFlag("--chat-id"),
        limit: parseNumberFlag("--limit") ?? 100,
        json: args.includes("--json"),
      }),
    );
  } catch (e) {
    console.error("DCP replay 诊断失败:", e);
    process.exit(1);
  } finally {
    closeDb();
  }
  process.exit(0);
}

console.log(`\n═══ ADR-76 行为验证报告 ═══`);
console.log(`数据库: ${dbPath}\n`);

try {
  initDb(dbPath);

  // A1: 节律分析
  console.log("── A1: 行动/沉默节律 ──");
  const rhythm = analyzeRhythm();
  console.log(
    `行动间隔: 中位数=${rhythm.actionIntervals.median} P90=${rhythm.actionIntervals.p90} (n=${rhythm.actionIntervals.count})`,
  );
  console.log(
    `锯齿波: ${rhythm.sawtoothDetection.cycleCount} 周期, 中位长度=${rhythm.sawtoothDetection.medianCycleLength}, 符合率=${(rhythm.sawtoothDetection.sawtoothRatio * 100).toFixed(1)}%`,
  );
  console.log("Circadian 热图 (UTC):");
  const maxHourCount = Math.max(1, ...Object.values(rhythm.circadianHeatmap));
  for (let h = 0; h < 24; h++) {
    const count = rhythm.circadianHeatmap[h];
    const bar = "█".repeat(Math.round((count / maxHourCount) * 20));
    console.log(`  ${String(h).padStart(2, "0")}:00  ${bar} ${count}`);
  }
  if (Object.keys(rhythm.actionIntervals.byTarget).length > 0) {
    console.log("按目标分组:");
    for (const [target, stats] of Object.entries(rhythm.actionIntervals.byTarget)) {
      const label = target.length > 20 ? `${target.slice(0, 17)}...` : target;
      console.log(`  ${label.padEnd(20)} 中位=${stats.median} P90=${stats.p90} (n=${stats.count})`);
    }
  }

  // A2: 声部多样性
  console.log("\n── A2: 声部多样性 ──");
  const diversity = analyzeVoiceDiversity();
  console.log(`权威面: ${diversity.authorityPlane} (loudness winner，不是 action_log 执行面)`);
  console.log(
    `Shannon 熵: H=${diversity.shannonEntropy.toFixed(3)} / H_max=${diversity.maxEntropy.toFixed(3)} (归一化=${(diversity.normalizedEntropy * 100).toFixed(1)}%)`,
  );
  console.log(
    `连续重复率: ${(diversity.consecutiveRepeatRate * 100).toFixed(1)}% (ADR-75 voice fatigue 目标: < 50%)`,
  );
  console.log("声部频率:");
  for (const [voice, freq] of Object.entries(diversity.voiceFrequencies)) {
    const bar = "█".repeat(Math.round(freq * 30));
    console.log(`  ${voice.padEnd(12)} ${bar} ${(freq * 100).toFixed(1)}%`);
  }
  console.log("分层观测:");
  for (const [plane, stats] of Object.entries(diversity.planes)) {
    console.log(
      `  ${plane.padEnd(32)} n=${String(stats.sampleCount).padStart(4)} H/Hmax=${(stats.normalizedEntropy * 100).toFixed(1)}% repeat=${(stats.consecutiveRepeatRate * 100).toFixed(1)}%`,
    );
  }
  if (diversity.personalityDrift) {
    const pd = diversity.personalityDrift;
    console.log(
      `人格漂移: ${pd.meanDriftPerTick.toExponential(2)}/tick, 振荡周期=${pd.pressureOscillationPeriod}, 比值=${pd.driftToOscillationRatio.toFixed(1)} (V5 预测: >> 1)`,
    );
  }

  console.log();
  console.log(renderExecutionConversionReport(analyzeExecutionConversion()));

  // A3: 不行动质量
  console.log("\n── A3: 不行动质量 ──");
  const silence = analyzeSilenceQuality();
  console.log(`沉默总数: ${silence.totalSilences}`);
  console.log("原因分布:");
  for (const [reason, stats] of Object.entries(silence.reasonDistribution)) {
    console.log(`  ${reason.padEnd(28)} ${stats.count} (${(stats.ratio * 100).toFixed(1)}%)`);
  }
  if (Object.keys(silence.silenceLevelDistribution).length > 0) {
    console.log("D5 五级谱:");
    for (const [level, stats] of Object.entries(silence.silenceLevelDistribution)) {
      console.log(`  ${level.padEnd(20)} ${stats.count} (${(stats.ratio * 100).toFixed(1)}%)`);
    }
  }
  const voi = silence.voiDeferredFollowup;
  console.log(
    `VoI-deferred: ${voi.count} 次, 后续行动延迟中位=${voi.medianDelayToAction} P90=${voi.p90DelayToAction}`,
  );
  const runs = silence.consecutiveSilenceRuns;
  console.log(
    `连续沉默: ${runs.runCount} 段, 最长=${runs.maxRunLength}, 均长=${runs.meanRunLength.toFixed(1)}`,
  );

  // A4: D5 反事实
  console.log("\n── A4: D5 反事实分析 ──");
  const cf = counterfactualD5();
  console.log(
    `样本来源: ${cf.source}, 状态: ${cf.sampleStatus}, 总样本: ${cf.totalSilenceSamples}, N/A: ${cf.nonApplicableSilences}, applicable: ${cf.applicableSilences}, partial: ${cf.partialSilences}`,
  );
  console.log(
    `可分析沉默: ${cf.analyzableSilences}, 翻转: ${cf.flippedActions} (${(cf.flipRate * 100).toFixed(1)}%)`,
  );
  console.log(
    `行动总数: ${cf.totalActions}, 无 D5 时行动频率倍数: ${cf.frequencyMultiplier.toFixed(2)}x`,
  );
  console.log(
    `cooling_gate_counterfactual: analyzable=${cf.coolingGate.analyzable}, flipped=${cf.coolingGate.flipped} (${(cf.coolingGate.flipRate * 100).toFixed(1)}%), freq=${cf.coolingGate.frequencyMultiplier.toFixed(2)}x`,
  );
  console.log(
    `social_cost_counterfactual: analyzable=${cf.socialCost.analyzable}, flipped=${cf.socialCost.flipped} (${(cf.socialCost.flipRate * 100).toFixed(1)}%), freq=${cf.socialCost.frequencyMultiplier.toFixed(2)}x`,
  );
  console.log(
    `social_safety_rank_ablation: pools=${cf.socialSafetyRankAblation.analyzablePools}/${cf.socialSafetyRankAblation.totalPools}, changed=${cf.socialSafetyRankAblation.changedTop} (${(cf.socialSafetyRankAblation.changeRate * 100).toFixed(1)}%), meanU=${cf.socialSafetyRankAblation.meanSocialSafety.toFixed(3)}, meanLift=${cf.socialSafetyRankAblation.meanLift.toFixed(2)}x`,
  );
  if (cf.socialSafetyRankAblation.topChanges.length > 0) {
    console.log("social_safety_rank_ablation examples:");
    for (const change of cf.socialSafetyRankAblation.topChanges.slice(0, 5)) {
      console.log(
        `  tick=${change.tick} ${change.original.action}@${change.original.target ?? "none"} ${change.original.score.toFixed(3)} -> ${change.counterfactual.action}@${change.counterfactual.target ?? "none"} ${change.counterfactual.score.toFixed(3)}`,
      );
    }
  }
  if (Object.keys(cf.sampleQualityByReason).length > 0) {
    console.log("样本质量:");
    for (const [reason, stats] of Object.entries(cf.sampleQualityByReason)) {
      console.log(
        `  ${reason.padEnd(28)} total=${stats.total} N/A=${stats.nonApplicable} applicable=${stats.applicable} partial=${stats.partial} analyzable=${stats.analyzable}`,
      );
    }
  }
  if (Object.keys(cf.flipsByReason).length > 0) {
    console.log("按原因的翻转率（combined）:");
    for (const [reason, stats] of Object.entries(cf.flipsByReason)) {
      console.log(
        `  ${reason.padEnd(28)} ${stats.flipped}/${stats.total} (${(stats.rate * 100).toFixed(1)}%)`,
      );
    }
  }

  // A4b: ADR-258 typed observation spine
  console.log("\n── A4b: ADR-258 typed observation spine ──");
  const sqlite = getSqlite();
  const spineCounts = sqlite
    .prepare(
      `SELECT
        (SELECT count(*) FROM tick_trace) AS tickTrace,
        (SELECT count(*) FROM candidate_trace) AS candidateTrace,
        (SELECT count(*) FROM queue_trace) AS queueTrace,
        (SELECT count(*) FROM action_result) AS actionResult,
        (SELECT count(*) FROM fact_mutation) AS factMutation,
        (SELECT count(*) FROM pressure_delta) AS pressureDelta`,
    )
    .get() as {
    tickTrace: number;
    candidateTrace: number;
    queueTrace: number;
    actionResult: number;
    factMutation: number;
    pressureDelta: number;
  };
  const actedReplay = sqlite
    .prepare(
      `SELECT count(*) AS count
       FROM tick_trace tt
       JOIN candidate_trace ct ON ct.candidate_id = tt.selected_candidate_id
       JOIN queue_trace qt ON qt.candidate_id = ct.candidate_id AND qt.fate = 'executed'
       JOIN action_result ar ON ar.candidate_id = ct.candidate_id
       JOIN fact_mutation fm ON fm.action_id = ar.action_id
       JOIN pressure_delta pd ON pd.related_action_id = ar.action_id
       WHERE ar.result != 'unknown_legacy'`,
    )
    .get() as { count: number };
  const silentReplay = sqlite
    .prepare(
      `SELECT count(*) AS count
       FROM tick_trace tt
       JOIN candidate_trace ct ON ct.candidate_id = tt.selected_candidate_id
       JOIN pressure_delta pd ON pd.source_tick = tt.tick
       WHERE tt.silence_marker IS NOT NULL
         AND ct.silence_reason NOT IN ('unknown_legacy', 'N/A')`,
    )
    .get() as { count: number };
  console.log(
    `rows: tick=${spineCounts.tickTrace}, candidate=${spineCounts.candidateTrace}, queue=${spineCounts.queueTrace}, action=${spineCounts.actionResult}, fact=${spineCounts.factMutation}, pressure_delta=${spineCounts.pressureDelta}`,
  );
  console.log(`acted replayable: ${actedReplay.count}`);
  console.log(`silent replayable: ${silentReplay.count}`);

  // A4c: P4 thread lifecycle audit
  console.log();
  console.log(renderP4ThreadLifecycleReport(analyzeP4ThreadLifecycle(sqlite)));

  // 总结
  console.log("\n═══ 验证结论 ═══");
  const dataVolume = rhythm.actionIntervals.count + 1;
  console.log(`数据量: ${dataVolume} 行动${dataVolume < 200 ? " ⚠️ 不足（需 ≥ 200）" : " ✅ 充足"}`);
  console.log(
    `V1 锯齿波: ${rhythm.sawtoothDetection.cycleCount > 5 ? "✅" : "⏳"} ${rhythm.sawtoothDetection.cycleCount} 周期`,
  );
  console.log(
    `V2 cooling gate: ${cf.coolingGate.flipRate > 0.3 ? "✅" : "⏳"} 翻转率 ${(cf.coolingGate.flipRate * 100).toFixed(1)}%${cf.coolingGate.flipRate > 0.3 ? " (节奏抑制有效)" : ""}`,
  );
  console.log(
    `V2 social cost: ${cf.socialCost.analyzable > 0 && cf.socialCost.flipRate > 0.3 ? "✅" : "⏳"} analyzable=${cf.socialCost.analyzable} 翻转率 ${(cf.socialCost.flipRate * 100).toFixed(1)}%`,
  );
  console.log(
    `V2 social safety rank: ${cf.socialSafetyRankAblation.analyzablePools > 0 && cf.socialSafetyRankAblation.changeRate > 0.05 ? "✅" : "⏳"} changed=${cf.socialSafetyRankAblation.changedTop}/${cf.socialSafetyRankAblation.analyzablePools} (${(cf.socialSafetyRankAblation.changeRate * 100).toFixed(1)}%)`,
  );
  console.log(
    `V3 Tier 节律: ${Object.keys(rhythm.actionIntervals.byTarget).length >= 3 ? "✅" : "⏳"} ${Object.keys(rhythm.actionIntervals.byTarget).length} 个目标分组`,
  );
  console.log(
    `V5 慢变量: ${diversity.personalityDrift ? (diversity.personalityDrift.driftToOscillationRatio > 10 ? "✅" : "⏳") : "⏳"} ${diversity.personalityDrift ? `比值=${diversity.personalityDrift.driftToOscillationRatio.toFixed(1)}` : "无数据"}`,
  );
  console.log(
    `声部多样性: ${diversity.normalizedEntropy > 0.7 ? "✅" : "⚠️"} H/H_max=${(diversity.normalizedEntropy * 100).toFixed(1)}%`,
  );

  console.log();
} catch (e) {
  console.error("诊断失败:", e);
  process.exit(1);
} finally {
  closeDb();
}
