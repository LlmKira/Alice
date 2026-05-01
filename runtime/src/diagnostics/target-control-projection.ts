/**
 * ADR-254 / ADR-255: target control projection shadow diagnostics.
 *
 * 只读诊断面：从 intervention_outcome_evidence 解释 target receptionScore。
 * 不参与 IAUS / P5 / prompt 控制路径。
 *
 * @see docs/adr/254-target-control-projection/README.md
 * @see docs/adr/255-intervention-outcome-truth-model/README.md
 */
import { desc, eq } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { interventionOutcomeEvidence } from "../db/schema.js";

export interface TargetControlProjectionOptions {
  target?: string;
  limit?: number;
  json?: boolean;
}

export interface TargetReceptionProjection {
  target: string;
  evidenceCount: number;
  warmCount: number;
  coldCount: number;
  hostileCount: number;
  unknownCount: number;
  noReplyCount: number;
  timeoutCount: number;
  receptionScore: number;
  latestOutcome: string | null;
  latestEvidenceAtMs: number | null;
  latestAliceMessageAtMs: number | null;
  latestSourceMessageLogIds: number[];
}

type EvidenceRow = typeof interventionOutcomeEvidence.$inferSelect;

export function buildTargetReceptionProjections(
  options: TargetControlProjectionOptions = {},
): TargetReceptionProjection[] {
  const limit = options.limit ?? 20;
  const query = getDb()
    .select()
    .from(interventionOutcomeEvidence)
    .orderBy(desc(interventionOutcomeEvidence.evaluatedAtMs), desc(interventionOutcomeEvidence.id))
    .limit(Math.max(1, limit * 20));

  const rows = options.target
    ? query.where(eq(interventionOutcomeEvidence.channelId, options.target)).all()
    : query.all();

  const byTarget = new Map<string, EvidenceRow[]>();
  for (const row of rows) {
    const targetRows = byTarget.get(row.channelId) ?? [];
    targetRows.push(row);
    byTarget.set(row.channelId, targetRows);
  }

  return [...byTarget.entries()]
    .map(([target, targetRows]) => projectTarget(target, targetRows))
    .sort((a, b) => (b.latestEvidenceAtMs ?? 0) - (a.latestEvidenceAtMs ?? 0))
    .slice(0, limit);
}

export function renderTargetControlProjectionDiagnostic(
  options: TargetControlProjectionOptions = {},
): string {
  const projections = buildTargetReceptionProjections(options);
  if (options.json) return JSON.stringify(projections, null, 2);

  const title = options.target
    ? `Target Control Projection — ${options.target}`
    : "Target Control Projection — reception evidence";
  const lines = [title, ""];

  if (projections.length === 0) {
    lines.push("No intervention_outcome_evidence rows found.");
    return lines.join("\n");
  }

  for (const projection of projections) {
    lines.push(
      `${projection.target} receptionScore=${projection.receptionScore.toFixed(3)} evidence=${projection.evidenceCount} latest=${projection.latestOutcome ?? "none"}`,
    );
    lines.push(
      `  warm=${projection.warmCount} cold=${projection.coldCount} hostile=${projection.hostileCount} unknown=${projection.unknownCount} noReply=${projection.noReplyCount} timeout=${projection.timeoutCount}`,
    );
    if (projection.latestSourceMessageLogIds.length > 0) {
      lines.push(`  source_message_log_ids=${projection.latestSourceMessageLogIds.join(",")}`);
    }
  }

  return lines.join("\n");
}

function projectTarget(target: string, rows: EvidenceRow[]): TargetReceptionProjection {
  let warmCount = 0;
  let coldCount = 0;
  let hostileCount = 0;
  let unknownCount = 0;
  let weightedSignal = 0;
  let signalWeight = 0;

  rows.forEach((row, index) => {
    if (row.outcome === "warm_reply") warmCount++;
    if (row.outcome === "cold_ignored") coldCount++;
    if (row.outcome === "hostile") hostileCount++;
    if (row.outcome === "unknown_timeout") unknownCount++;

    if (row.signal != null) {
      const weight = 1 / (index + 1);
      weightedSignal += row.signal * weight;
      signalWeight += weight;
    }
  });

  const latest = rows[0] ?? null;
  return {
    target,
    evidenceCount: rows.length,
    warmCount,
    coldCount,
    hostileCount,
    unknownCount,
    noReplyCount: coldCount,
    timeoutCount: unknownCount,
    receptionScore: signalWeight > 0 ? weightedSignal / signalWeight : 0,
    latestOutcome: latest?.outcome ?? null,
    latestEvidenceAtMs: latest?.evaluatedAtMs ?? null,
    latestAliceMessageAtMs: latest?.aliceMessageAtMs ?? null,
    latestSourceMessageLogIds: latest ? parseSourceIds(latest.sourceMessageLogIdsJson) : [],
  };
}

function parseSourceIds(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is number => Number.isInteger(id)) : [];
  } catch {
    return [];
  }
}
