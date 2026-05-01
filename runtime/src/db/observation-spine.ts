/**
 * ADR-258 Wave 1: typed observation spine.
 *
 * This module is an append-only diagnostic writer. It must not be read by
 * gate, pressure, queue, or action-selection code to influence behavior.
 * @see docs/adr/258-iaus-health-curve-validation/README.md
 */
import { and, desc, eq, lt } from "drizzle-orm";
import type { ExecutionObservation } from "../core/script-execution.js";
import type { PressureDims } from "../utils/math.js";
import { getDb } from "./connection.js";
import {
  actionResult,
  candidateTrace,
  factMutation,
  pressureDelta,
  queueTrace,
  tickTrace,
} from "./schema.js";

export type SpineTarget = string | null | undefined;

export interface PressureVectorSnapshot {
  p1: number;
  p2: number;
  p3: number;
  p4: number;
  p5: number;
  p6: number;
  api: number;
  apiPeak?: number | null;
}

export function pressureVectorFromDims(
  pressures: PressureDims,
  api: number,
  apiPeak?: number | null,
): PressureVectorSnapshot {
  return {
    p1: pressures[0],
    p2: pressures[1],
    p3: pressures[2],
    p4: pressures[3],
    p5: pressures[4],
    p6: pressures[5],
    api,
    apiPeak: apiPeak ?? null,
  };
}

export function makeCandidateId(tick: number, action: string, target: SpineTarget): string {
  return `candidate:${tick}:${action}:${target ?? "none"}`;
}

export function makeRankedCandidateId(
  tick: number,
  action: string,
  target: SpineTarget,
  rank: number,
): string {
  return `candidate:${tick}:${action}:${target ?? "none"}:rank:${rank}`;
}

export function makeEnqueueId(tick: number, action: string, target: SpineTarget): string {
  return `enqueue:${tick}:${action}:${target ?? "none"}`;
}

export function makeActionId(actionLogId: number): string {
  return `action:${actionLogId}`;
}

export function targetParts(target: SpineTarget): {
  targetNamespace: string;
  targetId: string | null;
} {
  if (!target) return { targetNamespace: "none", targetId: null };
  const idx = target.indexOf(":");
  if (idx <= 0) return { targetNamespace: "entity", targetId: target };
  return { targetNamespace: target.slice(0, idx), targetId: target.slice(idx + 1) };
}

function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function decodePressureVector(raw: string): PressureVectorSnapshot | null {
  try {
    const parsed = JSON.parse(raw) as Partial<PressureVectorSnapshot>;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.api !== "number") return null;
    return {
      p1: Number(parsed.p1 ?? 0),
      p2: Number(parsed.p2 ?? 0),
      p3: Number(parsed.p3 ?? 0),
      p4: Number(parsed.p4 ?? 0),
      p5: Number(parsed.p5 ?? 0),
      p6: Number(parsed.p6 ?? 0),
      api: parsed.api,
      apiPeak: typeof parsed.apiPeak === "number" ? parsed.apiPeak : null,
    };
  } catch {
    return null;
  }
}

export function writeTickTrace(input: {
  tick: number;
  occurredAtMs: number;
  pressureVector: PressureVectorSnapshot;
  schedulerPhase: string;
  selectedCandidateId?: string | null;
  silenceMarker?: string | null;
  sampleStatus?: "real" | "empty" | "partial" | "unknown_legacy";
}): void {
  getDb()
    .insert(tickTrace)
    .values({
      tick: input.tick,
      occurredAtMs: input.occurredAtMs,
      pressureVectorJson: encodeJson(input.pressureVector),
      schedulerPhase: input.schedulerPhase,
      selectedCandidateId: input.selectedCandidateId ?? null,
      silenceMarker: input.silenceMarker ?? null,
      sampleStatus: input.sampleStatus ?? "real",
    })
    .onConflictDoNothing()
    .run();
}

export function writeCandidateTrace(input: {
  candidateId: string;
  tick: number;
  target: SpineTarget;
  actionType: string;
  normalizedConsiderations?: unknown;
  deltaP?: number | null;
  socialCost?: number | null;
  netValue?: number | null;
  bottleneck?: string | null;
  gatePlane: string;
  selected: boolean;
  candidateRank?: number | null;
  silenceReason?: string | null;
  retainedImpulse?: unknown;
  sampleStatus?: "real" | "empty" | "partial" | "unknown_legacy";
}): void {
  const target = targetParts(input.target);
  getDb()
    .insert(candidateTrace)
    .values({
      candidateId: input.candidateId,
      tick: input.tick,
      targetNamespace: target.targetNamespace,
      targetId: target.targetId,
      actionType: input.actionType,
      normalizedConsiderationsJson: encodeJson(input.normalizedConsiderations ?? {}),
      deltaP: input.deltaP ?? null,
      socialCost: input.socialCost ?? null,
      netValue: input.netValue ?? null,
      bottleneck: input.bottleneck ?? null,
      gatePlane: input.gatePlane,
      selected: input.selected,
      candidateRank: input.candidateRank ?? null,
      silenceReason: input.silenceReason ?? "N/A",
      retainedImpulseJson:
        input.retainedImpulse === undefined ? null : encodeJson(input.retainedImpulse),
      sampleStatus: input.sampleStatus ?? "real",
    })
    .onConflictDoNothing()
    .run();
}

export function writeQueueTrace(input: {
  tick: number;
  candidateId: string;
  enqueueId: string;
  enqueueOutcome: string;
  fate: string;
  queueDepth?: number | null;
  activeCount?: number | null;
  saturation?: number | null;
  supersededByEnqueueId?: string | null;
  reasonCode: string;
}): void {
  const queueTraceId = `queue:${input.enqueueId}:${input.fate}:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  getDb()
    .insert(queueTrace)
    .values({
      queueTraceId,
      tick: input.tick,
      candidateId: input.candidateId,
      enqueueId: input.enqueueId,
      enqueueOutcome: input.enqueueOutcome,
      fate: input.fate,
      queueDepth: input.queueDepth ?? null,
      activeCount: input.activeCount ?? null,
      saturation: input.saturation ?? null,
      supersededByEnqueueId: input.supersededByEnqueueId ?? null,
      reasonCode: input.reasonCode,
    })
    .run();
}

export function writeActionResult(input: {
  actionId: string;
  tick: number;
  enqueueId?: string | null;
  candidateId?: string | null;
  actionLogId?: number | null;
  target: SpineTarget;
  actionType: string;
  result: "success" | "typed_failure" | "no_op" | "cancelled" | "unknown_legacy";
  failureCode?: string | null;
  externalMessageId?: string | null;
  completedActionRefs?: unknown[];
  executionObservations?: readonly ExecutionObservation[];
}): void {
  const target = targetParts(input.target);
  getDb()
    .insert(actionResult)
    .values({
      actionId: input.actionId,
      tick: input.tick,
      enqueueId: input.enqueueId ?? null,
      candidateId: input.candidateId ?? null,
      actionLogId: input.actionLogId ?? null,
      targetNamespace: target.targetNamespace,
      targetId: target.targetId,
      actionType: input.actionType,
      result: input.result,
      failureCode: input.failureCode ?? "N/A",
      externalMessageId: input.externalMessageId ?? null,
      completedActionRefsJson: encodeJson(input.completedActionRefs ?? []),
      executionObservationsJson: encodeJson(input.executionObservations ?? []),
    })
    .onConflictDoNothing()
    .run();
}

export function writeFactMutation(input: {
  mutationId: string;
  actionId?: string | null;
  sourceTick?: number | null;
  factNamespace: string;
  entityNamespace: string;
  entityId?: string | null;
  mutationKind: "create" | "update" | "close" | "expire" | "consume" | "decay" | "none";
  beforeSummary?: string | null;
  afterSummary?: string | null;
  delta?: unknown;
  authorityTable: string;
}): void {
  getDb()
    .insert(factMutation)
    .values({
      mutationId: input.mutationId,
      actionId: input.actionId ?? null,
      sourceTick: input.sourceTick ?? null,
      factNamespace: input.factNamespace,
      entityNamespace: input.entityNamespace,
      entityId: input.entityId ?? null,
      mutationKind: input.mutationKind,
      beforeSummary: input.beforeSummary ?? null,
      afterSummary: input.afterSummary ?? null,
      deltaJson: input.delta === undefined ? null : encodeJson(input.delta),
      authorityTable: input.authorityTable,
    })
    .onConflictDoNothing()
    .run();
}

function classifyDelta(
  before: number,
  after: number,
): {
  releaseClassification: "released" | "unchanged" | "accumulated";
  classificationReason: string;
} {
  const epsilon = 0.01;
  if (after < before - epsilon) {
    return { releaseClassification: "released", classificationReason: "next_window_lower" };
  }
  if (after > before + epsilon) {
    return { releaseClassification: "accumulated", classificationReason: "next_window_higher" };
  }
  return { releaseClassification: "unchanged", classificationReason: "next_window_flat" };
}

export function writePressureDeltasForPreviousTrace(
  currentTick: number,
  currentPressure: PressureVectorSnapshot,
): void {
  const db = getDb();
  const previous = db
    .select()
    .from(tickTrace)
    .where(lt(tickTrace.tick, currentTick))
    .orderBy(desc(tickTrace.tick))
    .limit(1)
    .get();
  if (!previous) return;

  const existing = db
    .select({ id: pressureDelta.id })
    .from(pressureDelta)
    .where(eq(pressureDelta.sourceTick, previous.tick))
    .limit(1)
    .get();
  if (existing) return;

  const before = decodePressureVector(previous.pressureVectorJson);
  if (!before) return;

  const action = previous.selectedCandidateId
    ? db
        .select({ actionId: actionResult.actionId })
        .from(actionResult)
        .where(eq(actionResult.candidateId, previous.selectedCandidateId))
        .orderBy(desc(actionResult.id))
        .limit(1)
        .get()
    : null;

  const dimensions = [
    ["P1", before.p1, currentPressure.p1],
    ["P2", before.p2, currentPressure.p2],
    ["P3", before.p3, currentPressure.p3],
    ["P4", before.p4, currentPressure.p4],
    ["P5", before.p5, currentPressure.p5],
    ["P6", before.p6, currentPressure.p6],
    ["API", before.api, currentPressure.api],
    ["API_peak", before.apiPeak ?? 0, currentPressure.apiPeak ?? 0],
  ] as const;

  for (const [dimension, pressureBefore, pressureAfter] of dimensions) {
    const classified = classifyDelta(pressureBefore, pressureAfter);
    db.insert(pressureDelta)
      .values({
        pressureDeltaId: `pressure_delta:${previous.tick}:${currentTick}:${dimension}`,
        sourceTick: previous.tick,
        relatedCandidateId: previous.selectedCandidateId,
        relatedActionId: action?.actionId ?? null,
        windowStartTick: previous.tick,
        windowEndTick: currentTick,
        windowSizeTicks: Math.max(1, currentTick - previous.tick),
        pressureBefore,
        pressureAfter,
        dimension,
        releaseClassification: classified.releaseClassification,
        classificationReason: classified.classificationReason,
      })
      .onConflictDoNothing()
      .run();
  }
}

export function writePressureDeltasForAction(input: {
  sourceTick: number;
  actionTick: number;
  relatedCandidateId?: string | null;
  relatedActionId: string;
  pressureBefore: PressureVectorSnapshot;
  pressureAfter: PressureVectorSnapshot;
}): void {
  const dimensions = [
    ["P1", input.pressureBefore.p1, input.pressureAfter.p1],
    ["P2", input.pressureBefore.p2, input.pressureAfter.p2],
    ["P3", input.pressureBefore.p3, input.pressureAfter.p3],
    ["P4", input.pressureBefore.p4, input.pressureAfter.p4],
    ["P5", input.pressureBefore.p5, input.pressureAfter.p5],
    ["P6", input.pressureBefore.p6, input.pressureAfter.p6],
    ["API", input.pressureBefore.api, input.pressureAfter.api],
    ["API_peak", input.pressureBefore.apiPeak ?? 0, input.pressureAfter.apiPeak ?? 0],
  ] as const;

  const db = getDb();
  for (const [dimension, pressureBefore, pressureAfter] of dimensions) {
    const classified = classifyDelta(pressureBefore, pressureAfter);
    db.insert(pressureDelta)
      .values({
        pressureDeltaId: `pressure_delta:${input.sourceTick}:${input.actionTick}:${input.relatedActionId}:${dimension}`,
        sourceTick: input.sourceTick,
        relatedCandidateId: input.relatedCandidateId ?? null,
        relatedActionId: input.relatedActionId,
        windowStartTick: input.sourceTick,
        windowEndTick: input.actionTick,
        windowSizeTicks: Math.max(1, input.actionTick - input.sourceTick),
        pressureBefore,
        pressureAfter,
        dimension,
        releaseClassification: classified.releaseClassification,
        classificationReason: "action_finalize_current_pressure",
      })
      .onConflictDoNothing()
      .run();
  }
}

export function hasReplayableActedTick(): boolean {
  const row = getDb()
    .select({ id: tickTrace.id })
    .from(tickTrace)
    .innerJoin(candidateTrace, eq(candidateTrace.candidateId, tickTrace.selectedCandidateId))
    .innerJoin(queueTrace, eq(queueTrace.candidateId, candidateTrace.candidateId))
    .innerJoin(actionResult, eq(actionResult.candidateId, candidateTrace.candidateId))
    .innerJoin(factMutation, eq(factMutation.actionId, actionResult.actionId))
    .innerJoin(pressureDelta, eq(pressureDelta.relatedActionId, actionResult.actionId))
    .where(and(eq(queueTrace.fate, "executed"), eq(actionResult.result, "success")))
    .limit(1)
    .get();
  return Boolean(row);
}
