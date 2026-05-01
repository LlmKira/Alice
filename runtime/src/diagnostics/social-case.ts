/**
 * ADR-262 Wave 2A: read-only social case diagnostics.
 *
 * Diagnostic only. This module must not influence IAUS, gates, target-control,
 * or prompt injection until prompt replay evidence exists.
 */
import { eq } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { modStates } from "../db/schema.js";
import { listSocialEvents } from "../db/social-case.js";
import { projectSocialCases, renderSocialCaseBrief } from "../social-case/index.js";
import type {
  BoundaryStatus,
  CaseRenderOptions,
  RepairState,
  SocialCaseProjection,
  SocialVisibility,
} from "../social-case/types.js";

export interface SocialCaseDiagnosticRenderOptions
  extends Omit<CaseRenderOptions, "surfaceVisibility"> {
  surfaceVisibility?: SocialVisibility;
  limit?: number;
  json?: boolean;
}

export interface SocialCasePressureShadow {
  caseId: string;
  pair: readonly [string, string];
  open: boolean;
  repairState: RepairState;
  boundaryStatus: BoundaryStatus;
  pressure: number;
  reason: string;
  unresolvedTension: number;
  repairDebt: number;
  venueDebt: number;
  confidence: number;
  lastSignificantEventId: string | null;
  latestEventAtMs: number | null;
}

export interface SocialCaseCandidateDiagnostic {
  id: string;
  status: "pending" | "accepted" | "rejected" | "unknown";
  kind: string;
  other: string;
  venue: string;
  createdTick: number | null;
  reviewedTick: number | null;
  ageTicks: number | null;
}

export interface SocialCaseCandidateDiagnosticReport {
  available: boolean;
  reason?: string;
  total: number;
  pending: number;
  accepted: number;
  rejected: number;
  unknown: number;
  oldestPending: SocialCaseCandidateDiagnostic | null;
  candidates: readonly SocialCaseCandidateDiagnostic[];
}

export interface SocialCaseDiagnosticReport {
  eventCount: number;
  caseCount: number;
  openCaseCount: number;
  pressureShadows: readonly SocialCasePressureShadow[];
  candidates: SocialCaseCandidateDiagnosticReport;
  cases: readonly SocialCaseProjection[];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round3(value: number): number {
  return Number(clamp01(value).toFixed(3));
}

function pressureFloorForRepairState(repairState: RepairState): number {
  switch (repairState) {
    case "reopened":
      return 0.9;
    case "harm_open":
      return 0.75;
    case "clarification_pending":
      return 0.65;
    case "apology_offered":
      return 0.45;
    case "forgiven_with_boundary":
      return 0.2;
    case "none":
      return 0;
  }
}

function pressureFloorForBoundaryStatus(boundaryStatus: BoundaryStatus): number {
  switch (boundaryStatus) {
    case "violated":
      return 0.9;
    case "set":
      return 0.2;
    case "none":
      return 0;
  }
}

function buildPressureReason(input: {
  projection: SocialCaseProjection;
  basePressure: number;
  stateFloor: number;
  boundaryFloor: number;
}): string {
  const reasons = [
    `state=${input.projection.repairState}`,
    `base=${input.basePressure.toFixed(3)}`,
  ];
  if (input.stateFloor > input.basePressure) {
    reasons.push(`state_floor=${input.stateFloor.toFixed(3)}`);
  }
  if (input.boundaryFloor > Math.max(input.basePressure, input.stateFloor)) {
    reasons.push(`boundary_floor=${input.boundaryFloor.toFixed(3)}`);
  }
  if (input.projection.confidence < 0.5) {
    reasons.push(`low_confidence=${input.projection.confidence.toFixed(3)}`);
  }
  return reasons.join("; ");
}

function projectPressureShadow(projection: SocialCaseProjection): SocialCasePressureShadow {
  const basePressure = Math.max(
    projection.unresolvedTension,
    projection.repairDebt,
    projection.venueDebt,
  );
  const stateFloor = pressureFloorForRepairState(projection.repairState);
  const boundaryFloor = pressureFloorForBoundaryStatus(projection.boundaryStatus);
  const latestEventAtMs = projection.events.at(-1)?.occurredAtMs ?? null;

  return {
    caseId: projection.caseId,
    pair: projection.pair,
    open: projection.open,
    repairState: projection.repairState,
    boundaryStatus: projection.boundaryStatus,
    pressure: round3(Math.max(basePressure, stateFloor, boundaryFloor)),
    reason: buildPressureReason({ projection, basePressure, stateFloor, boundaryFloor }),
    unresolvedTension: projection.unresolvedTension,
    repairDebt: projection.repairDebt,
    venueDebt: projection.venueDebt,
    confidence: projection.confidence,
    lastSignificantEventId: projection.lastSignificantEventId,
    latestEventAtMs,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return Number.isFinite(value) ? (value as number) : null;
}

function candidateStatus(value: unknown): SocialCaseCandidateDiagnostic["status"] {
  return value === "pending" || value === "accepted" || value === "rejected" ? value : "unknown";
}

function emptyCandidateReport(reason: string): SocialCaseCandidateDiagnosticReport {
  return {
    available: false,
    reason,
    total: 0,
    pending: 0,
    accepted: 0,
    rejected: 0,
    unknown: 0,
    oldestPending: null,
    candidates: [],
  };
}

function candidateFromRaw(
  raw: unknown,
  latestTick: number | null,
): SocialCaseCandidateDiagnostic | null {
  const candidate = asRecord(raw);
  if (!candidate) return null;
  const event = asRecord(candidate.event);
  const id = stringValue(candidate.id);
  if (!id || !event) return null;
  const createdTick = numberValue(candidate.createdTick);
  const reviewedTick = numberValue(candidate.reviewedTick);
  return {
    id,
    status: candidateStatus(candidate.status),
    kind: stringValue(event.kind) ?? "unknown",
    other: stringValue(candidate.other) ?? "unknown",
    venue: stringValue(event.venueId) ?? "unknown",
    createdTick,
    reviewedTick,
    ageTicks:
      createdTick != null && latestTick != null ? Math.max(0, latestTick - createdTick) : null,
  };
}

function latestModStateTick(): number | null {
  const rows = getDb().select({ updatedTick: modStates.updatedTick }).from(modStates).all();
  if (rows.length === 0) return null;
  return rows.reduce<number | null>(
    (latest, row) => (latest == null ? row.updatedTick : Math.max(latest, row.updatedTick)),
    null,
  );
}

export function analyzeSocialCaseCandidates(): SocialCaseCandidateDiagnosticReport {
  const row = getDb()
    .select({ stateJson: modStates.stateJson, updatedTick: modStates.updatedTick })
    .from(modStates)
    .where(eq(modStates.modName, "social_case"))
    .get();
  if (!row) return emptyCandidateReport("social_case mod state not persisted");

  const latestTick = latestModStateTick() ?? row.updatedTick;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.stateJson);
  } catch {
    return emptyCandidateReport("social_case mod state JSON is invalid");
  }
  const state = asRecord(parsed);
  const rawCandidates = Array.isArray(state?.candidates) ? state.candidates : [];
  const candidates = rawCandidates
    .map((candidate) => candidateFromRaw(candidate, latestTick))
    .filter((candidate): candidate is SocialCaseCandidateDiagnostic => candidate != null)
    .sort(
      (a, b) =>
        (a.createdTick ?? Number.MAX_SAFE_INTEGER) - (b.createdTick ?? Number.MAX_SAFE_INTEGER) ||
        a.id.localeCompare(b.id),
    );
  const pending = candidates.filter((candidate) => candidate.status === "pending");
  return {
    available: true,
    total: candidates.length,
    pending: pending.length,
    accepted: candidates.filter((candidate) => candidate.status === "accepted").length,
    rejected: candidates.filter((candidate) => candidate.status === "rejected").length,
    unknown: candidates.filter((candidate) => candidate.status === "unknown").length,
    oldestPending: pending[0] ?? null,
    candidates,
  };
}

export function buildSocialCasePressureShadows(
  cases: readonly SocialCaseProjection[],
): SocialCasePressureShadow[] {
  return cases
    .map(projectPressureShadow)
    .sort(
      (a, b) =>
        b.pressure - a.pressure ||
        b.confidence - a.confidence ||
        (b.latestEventAtMs ?? 0) - (a.latestEventAtMs ?? 0) ||
        a.caseId.localeCompare(b.caseId),
    );
}

export function analyzeSocialCases(): SocialCaseDiagnosticReport {
  const events = listSocialEvents();
  const cases = projectSocialCases(events);
  return {
    eventCount: events.length,
    caseCount: cases.length,
    openCaseCount: cases.filter((item) => item.open).length,
    pressureShadows: buildSocialCasePressureShadows(cases),
    candidates: analyzeSocialCaseCandidates(),
    cases,
  };
}

export function renderSocialCaseDiagnosticReport(
  report: SocialCaseDiagnosticReport,
  options: SocialCaseDiagnosticRenderOptions = {},
): string {
  if (options.json) return JSON.stringify(report, null, 2);

  const limit = Math.max(1, options.limit ?? 5);
  const renderOptions: CaseRenderOptions = {
    ...options,
    surfaceVisibility: options.surfaceVisibility ?? "private",
  };
  const lines = [
    "── Social case diagnostics ──",
    "shadow only: not fed to IAUS, target-control, prompt, or action selection",
    `events=${report.eventCount}, cases=${report.caseCount}, open=${report.openCaseCount}`,
  ];
  lines.push("pressure shadows:");
  for (const shadow of report.pressureShadows.slice(0, limit)) {
    lines.push(
      `- ${shadow.caseId} pressure=${shadow.pressure.toFixed(3)} open=${shadow.open} repair=${shadow.repairState} boundary=${shadow.boundaryStatus} confidence=${shadow.confidence.toFixed(3)} reason=${shadow.reason}`,
    );
  }
  if (report.pressureShadows.length === 0) {
    lines.push("- none");
  }

  lines.push("candidate review queue:");
  if (!report.candidates.available) {
    lines.push(`- unavailable: ${report.candidates.reason ?? "unknown"}`);
  } else {
    lines.push(
      `- total=${report.candidates.total}, pending=${report.candidates.pending}, accepted=${report.candidates.accepted}, rejected=${report.candidates.rejected}, unknown=${report.candidates.unknown}`,
    );
    if (report.candidates.oldestPending) {
      const item = report.candidates.oldestPending;
      const age = item.ageTicks == null ? "unknown" : String(item.ageTicks);
      lines.push(
        `- oldest_pending=${item.id} kind=${item.kind} other=${item.other} venue=${item.venue} age_ticks=${age}`,
      );
    } else {
      lines.push("- oldest_pending=none");
    }
  }

  for (const item of report.cases.filter((caseItem) => caseItem.open).slice(0, limit)) {
    lines.push("");
    lines.push(renderSocialCaseBrief(item, renderOptions));
  }
  return lines.join("\n");
}
