/**
 * ADR-248 W1: Decision Trace 基础框架。
 *
 * 这是审计事实写入面，不是控制状态。任何 gate/pressure/act 逻辑都不应读取它来改变行为。
 * @see docs/adr/248-dcp-reference-implementation-plan/README.md
 */
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "./connection.js";
import { decisionTrace } from "./schema.js";

export type DecisionTracePhase = "evolve" | "act";

export type DecisionTraceFinalDecision =
  | "enqueue"
  | "silence"
  | "defer"
  | "execute"
  | "continue"
  | "stop"
  | "fail";

export interface DecisionTracePayload {
  eventCursor?: number | null;
  graphVersion?: string | null;
  pressureInput?: unknown;
  pressureOutput?: unknown;
  candidates?: unknown[];
  selectedVoice?: string | null;
  selectedAction?: string | null;
  gateResults?: unknown[];
  block?: unknown;
  hostExecution?: unknown;
  observations?: unknown[];
  [key: string]: unknown;
}

export interface WriteDecisionTraceInput {
  tick: number;
  phase: DecisionTracePhase;
  finalDecision: DecisionTraceFinalDecision;
  reason: string;
  target?: string | null;
  actionLogId?: number | null;
  payload?: DecisionTracePayload;
}

export interface DecisionTraceRecord extends WriteDecisionTraceInput {
  id: number;
  target: string | null;
  actionLogId: number | null;
  payload: DecisionTracePayload;
  createdAt: Date;
}

function encodePayload(payload: DecisionTracePayload | undefined): string {
  return JSON.stringify(payload ?? {});
}

function decodePayload(payloadJson: string): DecisionTracePayload {
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as DecisionTracePayload) : {};
  } catch {
    return { decodeError: true, raw: payloadJson };
  }
}

function mapRecord(row: typeof decisionTrace.$inferSelect): DecisionTraceRecord {
  return {
    id: row.id,
    tick: row.tick,
    phase: row.phase as DecisionTracePhase,
    target: row.target,
    actionLogId: row.actionLogId,
    finalDecision: row.finalDecision as DecisionTraceFinalDecision,
    reason: row.reason,
    payload: decodePayload(row.payloadJson),
    createdAt: row.createdAt,
  };
}

export function writeDecisionTrace(input: WriteDecisionTraceInput): number {
  const row = getDb()
    .insert(decisionTrace)
    .values({
      tick: input.tick,
      phase: input.phase,
      target: input.target ?? null,
      actionLogId: input.actionLogId ?? null,
      finalDecision: input.finalDecision,
      reason: input.reason,
      payloadJson: encodePayload(input.payload),
    })
    .returning({ id: decisionTrace.id })
    .get();

  return row.id;
}

export function listDecisionTraces(options: {
  tick?: number;
  actionLogId?: number;
  phase?: DecisionTracePhase;
  limit?: number;
} = {}): DecisionTraceRecord[] {
  const filters = [];
  if (options.tick !== undefined) filters.push(eq(decisionTrace.tick, options.tick));
  if (options.actionLogId !== undefined) {
    filters.push(eq(decisionTrace.actionLogId, options.actionLogId));
  }
  if (options.phase !== undefined) filters.push(eq(decisionTrace.phase, options.phase));

  const query = getDb()
    .select()
    .from(decisionTrace)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(decisionTrace.tick), desc(decisionTrace.id))
    .limit(options.limit ?? 20);

  return query.all().map(mapRecord);
}

export function summarizeDecisionTrace(record: DecisionTraceRecord): string {
  const subject = record.target ? ` target=${record.target}` : "";
  const action = record.payload.selectedAction
    ? ` action=${String(record.payload.selectedAction)}`
    : "";
  const voice = record.payload.selectedVoice ? ` voice=${String(record.payload.selectedVoice)}` : "";
  return `#${record.id} tick=${record.tick} phase=${record.phase}${subject} decision=${record.finalDecision}${voice}${action} reason=${record.reason}`;
}
