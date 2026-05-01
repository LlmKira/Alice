/**
 * ADR-266 Wave 4: read-then-act action closure diagnostic.
 *
 * Read-only report over typed execution facts. Runtime continuation policy must
 * keep reading ScriptExecutionResult.observations directly, not this diagnostic.
 * Legacy command-log rows are reported separately as suspicion only.
 * @see docs/adr/266-tool-result-action-closure/README.md §Wave 4
 */

import { type ExecutionObservation, isExecutionObservation } from "../core/script-execution.js";
import { getSqlite } from "../db/connection.js";

export interface ActionClosureOptions {
  limit?: number;
  json?: boolean;
}

export type ActionClosureStructuredClass =
  | "actionable_read_without_continuation"
  | "read_only_waiting_reply"
  | "album_search_candidates_without_album_send";

export type ActionClosureLegacyClass =
  | "legacy_album_search_command_log_without_typed_observation"
  | "legacy_read_query_command_log_waiting_reply";

export interface ActionClosureStructuredRow {
  classification: ActionClosureStructuredClass;
  actionId: string;
  actionLogId: number | null;
  tick: number;
  target: string;
  actionType: string;
  tcAfterward: string;
  hostContinuationTrace: readonly string[];
  completedActionKind: string;
  observationSource: string;
  observationKind: string;
  observationIntent: string | null;
  candidateAssetIds: readonly string[];
  reasoning: string;
}

export interface ActionClosureLegacyRow {
  classification: ActionClosureLegacyClass;
  actionLogId: number;
  tick: number;
  target: string;
  actionType: string;
  tcAfterward: string;
  commandHint: string;
  reasoning: string;
}

export interface ActionClosureReport {
  structuredRows: readonly ActionClosureStructuredRow[];
  legacyRows: readonly ActionClosureLegacyRow[];
  summary: {
    structuredCount: number;
    legacyCount: number;
    actionableReadWithoutContinuation: number;
    readOnlyWaitingReply: number;
    albumSearchCandidatesWithoutAlbumSend: number;
  };
  controlGate: {
    status: "diagnostic_only";
    authority: "action_result.execution_observations_json";
  };
}

interface ActionClosureSqlRow {
  actionId: string;
  actionLogId: number | null;
  tick: number;
  targetNamespace: string;
  targetId: string | null;
  actionType: string;
  result: string;
  completedActionRefsJson: string;
  executionObservationsJson: string;
  tcAfterward: string | null;
  tcHostContinuationTrace: string | null;
  reasoning: string | null;
}

interface LegacySqlRow {
  actionLogId: number;
  tick: number;
  target: string | null;
  actionType: string;
  tcAfterward: string | null;
  tcCommandLog: string | null;
  reasoning: string | null;
}

const SOCIAL_ACTION_PREFIXES = [
  "sent:",
  "voice:",
  "sticker:",
  "react:",
  "sent-file:",
  "forwarded:",
];

export function analyzeActionClosure(options: ActionClosureOptions = {}): ActionClosureReport {
  const limit = Math.max(1, options.limit ?? 20);
  const structuredRows = buildStructuredRows(limit);
  const legacyRows = buildLegacyRows(limit);

  return {
    structuredRows,
    legacyRows,
    summary: {
      structuredCount: structuredRows.length,
      legacyCount: legacyRows.length,
      actionableReadWithoutContinuation: countStructured(
        structuredRows,
        "actionable_read_without_continuation",
      ),
      readOnlyWaitingReply: countStructured(structuredRows, "read_only_waiting_reply"),
      albumSearchCandidatesWithoutAlbumSend: countStructured(
        structuredRows,
        "album_search_candidates_without_album_send",
      ),
    },
    controlGate: {
      status: "diagnostic_only",
      authority: "action_result.execution_observations_json",
    },
  };
}

export function renderActionClosureDiagnostic(options: ActionClosureOptions = {}): string {
  const report = analyzeActionClosure(options);
  if (options.json) return JSON.stringify(report, null, 2);

  const lines = [
    "Action Closure Diagnostic — ADR-266 read-then-act",
    "control gate: diagnostic_only",
    "authority: action_result.execution_observations_json",
    "",
    `structured=${report.summary.structuredCount} legacy_suspicion=${report.summary.legacyCount}`,
    `actionable_read_without_continuation=${report.summary.actionableReadWithoutContinuation} read_only_waiting_reply=${report.summary.readOnlyWaitingReply} album_search_candidates_without_album_send=${report.summary.albumSearchCandidatesWithoutAlbumSend}`,
    "",
  ];

  if (report.structuredRows.length === 0) {
    lines.push("No structured action-closure issues found.");
  } else {
    lines.push("Structured rows:");
    for (const row of report.structuredRows) {
      const assetSuffix =
        row.candidateAssetIds.length > 0 ? ` assets=${row.candidateAssetIds.join(",")}` : "";
      lines.push(
        `  [${row.classification}] tick=${row.tick} action=${row.actionId} afterward=${row.tcAfterward} completed=${row.completedActionKind} observation=${row.observationSource}:${row.observationKind} intent=${row.observationIntent ?? "none"} trace=${row.hostContinuationTrace.join(",") || "none"}${assetSuffix}`,
      );
    }
  }

  lines.push("");
  if (report.legacyRows.length === 0) {
    lines.push("No legacy command-log-only suspicion rows found.");
  } else {
    lines.push("Legacy suspicion rows:");
    for (const row of report.legacyRows) {
      lines.push(
        `  [${row.classification}] tick=${row.tick} action_log=${row.actionLogId} afterward=${row.tcAfterward} command=${row.commandHint}`,
      );
    }
  }

  return lines.join("\n");
}

function buildStructuredRows(limit: number): ActionClosureStructuredRow[] {
  const rows = getSqlite()
    .prepare(
      `SELECT
         ar.action_id AS actionId,
         ar.action_log_id AS actionLogId,
         ar.tick AS tick,
         ar.target_namespace AS targetNamespace,
         ar.target_id AS targetId,
         ar.action_type AS actionType,
         ar.result AS result,
         ar.completed_action_refs_json AS completedActionRefsJson,
         ar.execution_observations_json AS executionObservationsJson,
         al.tc_afterward AS tcAfterward,
         al.tc_host_continuation_trace AS tcHostContinuationTrace,
         al.reasoning AS reasoning
       FROM action_result ar
       LEFT JOIN action_log al ON al.id = ar.action_log_id
       WHERE ar.execution_observations_json IS NOT NULL
         AND ar.execution_observations_json <> '[]'
       ORDER BY ar.tick DESC, ar.id DESC
       LIMIT ?`,
    )
    .all(limit * 20) as ActionClosureSqlRow[];

  const issues: ActionClosureStructuredRow[] = [];
  for (const row of rows) {
    const observations = parseObservations(row.executionObservationsJson);
    if (observations.length === 0) continue;

    const completedRefs = parseStringArray(row.completedActionRefsJson);
    const completedActionKind = classifyCompletedActionKind(completedRefs);
    const hasSameTickFollowupSend = hasSameTickLaterSend(row.tick, row.actionLogId);
    const hasCompletedSocialAction = completedActionKind !== "empty" || hasSameTickFollowupSend;
    const trace = parseStringArray(row.tcHostContinuationTrace);
    const hasLocalContinuation = trace.includes("local_observation_followup");
    const target = formatTarget(row.targetNamespace, row.targetId);

    for (const observation of observations) {
      const actionable = isActionableObservation(observation);
      const candidateAssetIds = extractCandidateAssetIds(observation);
      const base = {
        actionId: row.actionId,
        actionLogId: row.actionLogId,
        tick: row.tick,
        target,
        actionType: row.actionType,
        tcAfterward: row.tcAfterward ?? "none",
        hostContinuationTrace: trace,
        completedActionKind,
        observationSource: observation.source,
        observationKind: observation.kind,
        observationIntent: readIntent(observation),
        candidateAssetIds,
        reasoning: row.reasoning ?? "",
      } satisfies Omit<ActionClosureStructuredRow, "classification">;

      if (actionable && !hasCompletedSocialAction && !hasLocalContinuation) {
        issues.push({ ...base, classification: "actionable_read_without_continuation" });
      }

      if (
        actionable &&
        row.tcAfterward === "waiting_reply" &&
        !hasCompletedSocialAction &&
        !hasLocalContinuation
      ) {
        issues.push({ ...base, classification: "read_only_waiting_reply" });
      }

      if (
        observation.source === "album.search" &&
        candidateAssetIds.length > 0 &&
        !hasAlbumSend(completedRefs) &&
        !hasSameTickFollowupSend &&
        !hasLocalContinuation
      ) {
        issues.push({
          ...base,
          classification: "album_search_candidates_without_album_send",
        });
      }
    }
  }

  return issues.slice(0, limit);
}

function buildLegacyRows(limit: number): ActionClosureLegacyRow[] {
  const rows = getSqlite()
    .prepare(
      `SELECT
         al.id AS actionLogId,
         al.tick AS tick,
         al.target AS target,
         al.action_type AS actionType,
         al.tc_afterward AS tcAfterward,
         al.tc_command_log AS tcCommandLog,
         al.reasoning AS reasoning
       FROM action_log al
       LEFT JOIN action_result ar ON ar.action_log_id = al.id
       WHERE al.tc_command_log IS NOT NULL
         AND (
           ar.id IS NULL
           OR ar.execution_observations_json IS NULL
           OR ar.execution_observations_json = '[]'
         )
         AND (
           al.tc_command_log LIKE '%album search%'
           OR al.tc_command_log LIKE '%irc tail%'
           OR al.tc_command_log LIKE '%irc whois%'
           OR al.tc_command_log LIKE '%irc download%'
         )
       ORDER BY al.tick DESC, al.id DESC
       LIMIT ?`,
    )
    .all(limit * 4) as LegacySqlRow[];

  const legacyRows: ActionClosureLegacyRow[] = [];
  for (const row of rows) {
    const commandHint = commandHintFromLog(row.tcCommandLog ?? "");
    if (!commandHint) continue;
    const classification =
      commandHint === "album search"
        ? "legacy_album_search_command_log_without_typed_observation"
        : "legacy_read_query_command_log_waiting_reply";
    if (classification === "legacy_read_query_command_log_waiting_reply") {
      if (row.tcAfterward !== "waiting_reply") continue;
    }
    legacyRows.push({
      classification,
      actionLogId: row.actionLogId,
      tick: row.tick,
      target: row.target ?? "",
      actionType: row.actionType,
      tcAfterward: row.tcAfterward ?? "none",
      commandHint,
      reasoning: row.reasoning ?? "",
    });
  }
  return legacyRows.slice(0, limit);
}

function parseObservations(raw: string): ExecutionObservation[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isExecutionObservation);
  } catch {
    return [];
  }
}

function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function isActionableObservation(observation: ExecutionObservation): boolean {
  return observation.enablesContinuation && readIntent(observation) != null;
}

function readIntent(observation: ExecutionObservation): string | null {
  const intent = observation.payload?.intent;
  return typeof intent === "string" && intent.length > 0 ? intent : null;
}

function extractCandidateAssetIds(observation: ExecutionObservation): string[] {
  const candidates = observation.payload?.candidates;
  if (!Array.isArray(candidates)) return [];
  return candidates
    .map((candidate) => {
      if (!candidate || typeof candidate !== "object") return null;
      const assetId = (candidate as Record<string, unknown>).assetId;
      return typeof assetId === "string" && assetId.length > 0 ? assetId : null;
    })
    .filter((assetId): assetId is string => assetId != null);
}

function classifyCompletedActionKind(completedRefs: readonly string[]): string {
  if (completedRefs.length === 0) return "empty";
  const socialRef = completedRefs.find((ref) =>
    SOCIAL_ACTION_PREFIXES.some((prefix) => ref.startsWith(prefix)),
  );
  if (!socialRef) return "other";
  return socialRef.slice(0, socialRef.indexOf(":"));
}

function hasAlbumSend(completedRefs: readonly string[]): boolean {
  return completedRefs.some((ref) => ref.startsWith("sent:") || ref.startsWith("forwarded:"));
}

function hasSameTickLaterSend(tick: number, actionLogId: number | null): boolean {
  const rows = getSqlite()
    .prepare(
      `SELECT ar.completed_action_refs_json AS completedActionRefsJson
       FROM action_result ar
       LEFT JOIN action_log al ON al.id = ar.action_log_id
       WHERE ar.tick = ?
         AND (? IS NULL OR al.id IS NULL OR al.id > ?)
       ORDER BY ar.id`,
    )
    .all(tick, actionLogId, actionLogId) as Array<{ completedActionRefsJson: string }>;

  return rows.some((row) => hasAlbumSend(parseStringArray(row.completedActionRefsJson)));
}

function commandHintFromLog(commandLog: string): string | null {
  if (commandLog.includes("album search")) return "album search";
  if (commandLog.includes("irc download")) return "irc download";
  if (commandLog.includes("irc tail")) return "irc tail";
  if (commandLog.includes("irc whois")) return "irc whois";
  return null;
}

function formatTarget(namespace: string, id: string | null): string {
  if (!id) return namespace;
  if (namespace === "none") return id;
  return `${namespace}:${id}`;
}

function countStructured(
  rows: readonly ActionClosureStructuredRow[],
  classification: ActionClosureStructuredClass,
): number {
  return rows.filter((row) => row.classification === classification).length;
}
