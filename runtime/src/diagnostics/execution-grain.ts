/**
 * ADR-249: execution grain regression report.
 *
 * Read-only diagnostic. It correlates prompt snapshots with action_log rows to
 * measure whether a tick was solved in one block or split into same-tick rounds.
 *
 * @see docs/adr/249-execution-grain-regression-evidence.md
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { desc, inArray } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { actionLog } from "../db/schema.js";

export interface ExecutionGrainReportOptions {
  promptLogsDir: string;
  limit?: number;
  since?: string;
  json?: boolean;
}

interface PromptExecutionSnapshot {
  tick: number;
  round: number;
  target: string;
  path: string;
  mtimeMs: number;
  script: string;
  afterward: string | null;
  hostContinuedInTick: boolean | null;
  hostContinuationReason: string | null;
  dcpEvents: number | null;
  dcpMessages: number | null;
  commandCount: number;
  socialActionCount: number;
  usedLegacyTail: boolean;
  completedSocialAction: boolean;
}

interface ActionLogSnapshot {
  id: number;
  tick: number;
  target: string | null;
  success: boolean;
  tcAfterward: string | null;
  hostContinuationTrace: string[];
  commandLog: string | null;
  failureClass: FailureClass;
}

type FailureClass = "none" | "provider_failure" | "engine_failure" | "contract_failure" | "strategy_failure";
type ContinuationAuditClass =
  | "read_then_act_needed"
  | "action_already_completed"
  | "command_noise"
  | "error_recovery"
  | "cross_target_distraction";

const PROMPT_LOG_RE = /^(\d+)-r(\d+)-(.+)-\d{4}-\d{2}-\d{2}T.*\.md$/;
const COMMAND_RE = /^(?!#|\s*$)([a-zA-Z0-9_-]+)(?:\s|$)/;
const SOCIAL_COMMAND_RE = /^(irc\s+(say|reply|react|sticker|voice|forward)\b|self\s+feel\b)/;

function extractSection(markdown: string, heading: string): string {
  const headingIndex = markdown.indexOf(`## ${heading}`);
  if (headingIndex === -1) return "";
  const afterHeading = markdown.slice(headingIndex + `## ${heading}`.length).trimStart();
  const nextHeading = afterHeading.search(/^## /m);
  return (nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading)).trim();
}

function extractCodeBlock(markdown: string, heading: string): string {
  const section = extractSection(markdown, heading);
  const fenceStart = section.indexOf("```");
  if (fenceStart === -1) return "";
  const contentStart = fenceStart + 3;
  const fenceEnd = section.indexOf("```", contentStart);
  if (fenceEnd === -1) return "";
  return section.slice(contentStart, fenceEnd).replace(/^\w*\n/, "").trim();
}

function extractBullet(section: string, key: string): string | null {
  const re = new RegExp(`^- ${key}:\\s*(.+)$`, "m");
  return section.match(re)?.[1]?.trim() ?? null;
}

function parseNullableNumber(value: string | null): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function countCommands(script: string): { commandCount: number; socialActionCount: number; usedLegacyTail: boolean } {
  let commandCount = 0;
  let socialActionCount = 0;
  let usedLegacyTail = false;
  for (const rawLine of script.split("\n")) {
    const line = rawLine.trim();
    if (!COMMAND_RE.test(line)) continue;
    commandCount++;
    if (SOCIAL_COMMAND_RE.test(line)) socialActionCount++;
    if (/^irc\s+tail\b/.test(line)) usedLegacyTail = true;
  }
  return { commandCount, socialActionCount, usedLegacyTail };
}

function parseSinceMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`Invalid --since value: ${value}`);
  return parsed;
}

function readPromptSnapshot(path: string): PromptExecutionSnapshot | null {
  const filename = path.split("/").at(-1) ?? path;
  const match = PROMPT_LOG_RE.exec(filename);
  if (!match) return null;

  const markdown = readFileSync(path, "utf-8");
  const execution = extractSection(markdown, "Execution");
  const dcp = extractSection(markdown, "DCP Shadow Context");
  const script = extractCodeBlock(markdown, "LLM Script");
  const commandStats = countCommands(script);
  const hostContinued = extractBullet(execution, "host continued in tick");

  return {
    tick: Number(match[1]),
    round: Number(match[2]),
    target: match[3].replace(/^channel_/, "channel:"),
    path,
    mtimeMs: statSync(path).mtimeMs,
    script,
    afterward: extractBullet(execution, "afterward"),
    hostContinuedInTick: hostContinued == null ? null : hostContinued === "yes",
    hostContinuationReason: extractBullet(execution, "host continuation reason"),
    dcpEvents: parseNullableNumber(extractBullet(dcp, "events")),
    dcpMessages: parseNullableNumber(extractBullet(dcp, "messages")),
    ...commandStats,
    completedSocialAction: commandStats.socialActionCount > 0,
  };
}

function listPromptSnapshots(dir: string, limit: number, sinceMs: number | null): PromptExecutionSnapshot[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(dir, name))
    .map(readPromptSnapshot)
    .filter((item): item is PromptExecutionSnapshot => item != null)
    .filter((item) => sinceMs == null || item.mtimeMs >= sinceMs)
    .sort((a, b) => (b.mtimeMs - a.mtimeMs) || (b.tick - a.tick) || (b.round - a.round))
    .slice(0, limit);
}

function safeTrace(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function classifyFailure(row: typeof actionLog.$inferSelect): FailureClass {
  if (row.success) return "none";
  const text = `${row.tcCommandLog ?? ""}\n${row.reasoning ?? ""}`.toLowerCase();
  if (text.includes("cloudflare") || text.includes("llm") || text.includes("gateway time-out")) {
    return "provider_failure";
  }
  if (text.includes("engine api returned") || text.includes("engine api timeout")) {
    return "engine_failure";
  }
  if (text.includes("structured block validation failed") || text.includes("unknown command")) {
    return "contract_failure";
  }
  return "strategy_failure";
}

function listActionLogs(ticks: number[]): ActionLogSnapshot[] {
  if (ticks.length === 0) return [];
  return getDb()
    .select()
    .from(actionLog)
    .where(inArray(actionLog.tick, [...new Set(ticks)]))
    .orderBy(desc(actionLog.tick))
    .all()
    .map((row) => ({
      id: row.id,
      tick: row.tick,
      target: row.target,
      success: row.success,
      tcAfterward: row.tcAfterward,
      hostContinuationTrace: safeTrace(row.tcHostContinuationTrace),
      commandLog: row.tcCommandLog,
      failureClass: classifyFailure(row),
    }));
}

function percent(numerator: number, denominator: number): string {
  if (denominator === 0) return "0.0%";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function countBy<T extends string>(items: readonly T[]): Record<T, number> {
  const counts = {} as Record<T, number>;
  for (const item of items) counts[item] = (counts[item] ?? 0) + 1;
  return counts;
}

function classifyContinuation(
  current: PromptExecutionSnapshot,
  next: PromptExecutionSnapshot | undefined,
): ContinuationAuditClass | null {
  if (current.hostContinuedInTick !== true) return null;
  if (current.hostContinuationReason === "error_recovery") return "error_recovery";
  if (!next) return "command_noise";

  const nextTargetIsDifferent = next.target !== current.target;
  if (nextTargetIsDifferent && next.usedLegacyTail) return "cross_target_distraction";
  if (current.completedSocialAction) return "action_already_completed";
  if (next.completedSocialAction) return "read_then_act_needed";
  return "command_noise";
}

export function renderExecutionGrainReport(options: ExecutionGrainReportOptions): string {
  const limit = options.limit ?? 50;
  const sinceMs = parseSinceMs(options.since);
  const prompts = listPromptSnapshots(options.promptLogsDir, limit, sinceMs);
  const ticks = [...new Set(prompts.map((prompt) => prompt.tick))];
  const actions = listActionLogs(ticks);
  const promptsByTick = new Map<number, PromptExecutionSnapshot[]>();
  for (const prompt of prompts) {
    const bucket = promptsByTick.get(prompt.tick) ?? [];
    bucket.push(prompt);
    promptsByTick.set(prompt.tick, bucket);
  }

  const r0 = prompts.filter((prompt) => prompt.round === 0);
  const r0SingleCommand = r0.filter((prompt) => prompt.commandCount === 1).length;
  const ticksWithMultiRound = [...promptsByTick.values()].filter((items) => items.length > 1).length;
  const continuationReasons = prompts
    .map((prompt) => prompt.hostContinuationReason)
    .filter((item): item is string => item != null);
  const failureClasses = actions.map((action) => action.failureClass);
  const dcpCoverageDrift = prompts.filter(
    (prompt) => prompt.usedLegacyTail && (prompt.dcpMessages ?? 0) === 0,
  ).length;
  const continuationAuditClasses: ContinuationAuditClass[] = [];
  for (const tickPrompts of promptsByTick.values()) {
    const ordered = [...tickPrompts].sort((a, b) => a.round - b.round);
    for (let i = 0; i < ordered.length; i++) {
      const classification = classifyContinuation(ordered[i], ordered[i + 1]);
      if (classification) continuationAuditClasses.push(classification);
    }
  }

  const report = {
    promptLogsDir: options.promptLogsDir,
    since: options.since ?? null,
    promptCount: prompts.length,
    tickCount: ticks.length,
    actionCount: actions.length,
    metrics: {
      ticksWithMultiRound,
      r0Count: r0.length,
      r0SingleCommand,
      r0SingleCommandRatio: r0.length === 0 ? 0 : r0SingleCommand / r0.length,
      dcpCoverageDrift,
      dcpCoverageDriftRatio: prompts.length === 0 ? 0 : dcpCoverageDrift / prompts.length,
      continuationReasons: countBy(continuationReasons),
      continuationAuditClasses: countBy(continuationAuditClasses),
      failureClasses: countBy(failureClasses),
    },
    ticks: ticks.map((tick) => {
      const tickPrompts = promptsByTick.get(tick) ?? [];
      const action = actions.find((item) => item.tick === tick) ?? null;
      return {
        tick,
        llmCallCount: tickPrompts.length,
        maxRound: Math.max(...tickPrompts.map((prompt) => prompt.round)),
        target: tickPrompts[0]?.target ?? action?.target ?? null,
        commandCounts: tickPrompts.map((prompt) => prompt.commandCount),
        socialActionCounts: tickPrompts.map((prompt) => prompt.socialActionCount),
        afterwards: tickPrompts.map((prompt) => prompt.afterward),
        hostContinuationTrace: action?.hostContinuationTrace ?? [],
        dcpMessages: tickPrompts.map((prompt) => prompt.dcpMessages),
        usedLegacyTail: tickPrompts.some((prompt) => prompt.usedLegacyTail),
        continuationAuditClasses: tickPrompts
          .sort((a, b) => a.round - b.round)
          .map((prompt, index, ordered) => classifyContinuation(prompt, ordered[index + 1]))
          .filter((item): item is ContinuationAuditClass => item != null),
        success: action?.success ?? null,
        failureClass: action?.failureClass ?? null,
      };
    }),
  };

  if (options.json) return JSON.stringify(report, null, 2);

  const lines = [
    "Execution Grain Report",
    "",
    `Prompt logs: ${report.promptCount}`,
    options.since ? `Since: ${options.since}` : null,
    `Ticks: ${report.tickCount}`,
    `Action logs: ${report.actionCount}`,
    `Ticks with >1 LLM call: ${ticksWithMultiRound}/${ticks.length} (${percent(ticksWithMultiRound, ticks.length)})`,
    `r0 single-command blocks: ${r0SingleCommand}/${r0.length} (${percent(r0SingleCommand, r0.length)})`,
    `DCP coverage drift (tail used, DCP messages=0): ${dcpCoverageDrift}/${prompts.length} (${percent(dcpCoverageDrift, prompts.length)})`,
    "",
    "Continuation reasons:",
  ];

  for (const [reason, count] of Object.entries(report.metrics.continuationReasons)) {
    lines.push(`  ${reason}: ${count}`);
  }
  if (Object.keys(report.metrics.continuationReasons).length === 0) lines.push("  (none)");

  lines.push("", "Continuation audit classes:");
  for (const [reason, count] of Object.entries(report.metrics.continuationAuditClasses)) {
    lines.push(`  ${reason}: ${count}`);
  }
  if (Object.keys(report.metrics.continuationAuditClasses).length === 0) lines.push("  (none)");

  lines.push("", "Failure classes:");
  for (const [reason, count] of Object.entries(report.metrics.failureClasses)) {
    lines.push(`  ${reason}: ${count}`);
  }
  if (Object.keys(report.metrics.failureClasses).length === 0) lines.push("  (none)");

  lines.push("", "Recent ticks:");
  for (const tick of report.ticks.slice(0, 20)) {
    lines.push(
      `  tick=${tick.tick} calls=${tick.llmCallCount} target=${tick.target ?? "(none)"} commands=${tick.commandCounts.join("/")} social=${tick.socialActionCounts.join("/")} dcp=${tick.dcpMessages.join("/")} success=${tick.success ?? "?"} failure=${tick.failureClass ?? "?"}`,
    );
    if (tick.continuationAuditClasses.length > 0) {
      lines.push(`    continuation: ${tick.continuationAuditClasses.join(", ")}`);
    }
  }

  return lines.filter((line): line is string => line != null).join("\n");
}
