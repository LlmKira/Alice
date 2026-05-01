/**
 * ADR-248 W3: canonical_events store.
 *
 * Parse boundary for CanonicalEvent persistence. Downstream projection code
 * should consume typed CanonicalEvent values, not ad-hoc JSON rows.
 *
 * @see docs/adr/248-dcp-reference-implementation-plan/README.md
 */
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "./connection.js";
import { canonicalEvents } from "./schema.js";
import type { CanonicalEvent } from "../telegram/canonical-events.js";

export interface CanonicalEventSourceRef {
  source: string;
  sourceId: string;
}

export interface StoredCanonicalEvent {
  id: number;
  event: CanonicalEvent;
  source: string | null;
  sourceId: string | null;
  createdAt: Date;
}

function encodePayload(event: CanonicalEvent): string {
  return JSON.stringify(event);
}

function decodePayload(payloadJson: string): CanonicalEvent {
  const parsed = JSON.parse(payloadJson) as CanonicalEvent;
  if (!parsed || typeof parsed !== "object" || !("kind" in parsed) || !("tick" in parsed)) {
    throw new Error("Invalid canonical event payload");
  }
  return parsed;
}

function mapRow(row: typeof canonicalEvents.$inferSelect): StoredCanonicalEvent {
  return {
    id: row.id,
    event: decodePayload(row.payloadJson),
    source: row.source,
    sourceId: row.sourceId,
    createdAt: row.createdAt,
  };
}

export function writeCanonicalEvent(event: CanonicalEvent, sourceRef?: CanonicalEventSourceRef): number {
  const row = getDb()
    .insert(canonicalEvents)
    .values({
      kind: event.kind,
      tick: event.tick,
      occurredAtMs: event.occurredAtMs,
      channelId: event.channelId,
      contactId: event.contactId,
      directed: event.directed,
      novelty: event.novelty,
      source: sourceRef?.source ?? null,
      sourceId: sourceRef?.sourceId ?? null,
      payloadJson: encodePayload(event),
    })
    .returning({ id: canonicalEvents.id })
    .get();
  return row.id;
}

export function listCanonicalEvents(options: { channelId?: string; limit?: number } = {}): StoredCanonicalEvent[] {
  const query = getDb()
    .select()
    .from(canonicalEvents)
    .where(options.channelId ? eq(canonicalEvents.channelId, options.channelId) : undefined)
    .orderBy(asc(canonicalEvents.tick), asc(canonicalEvents.id))
    .limit(options.limit ?? 100);

  return query.all().map(mapRow);
}

export function findCanonicalEventBySource(sourceRef: CanonicalEventSourceRef): StoredCanonicalEvent | null {
  const row = getDb()
    .select()
    .from(canonicalEvents)
    .where(
      and(eq(canonicalEvents.source, sourceRef.source), eq(canonicalEvents.sourceId, sourceRef.sourceId)),
    )
    .limit(1)
    .get();
  return row ? mapRow(row) : null;
}

export function writeCanonicalEventOnce(
  event: CanonicalEvent,
  sourceRef: CanonicalEventSourceRef,
): { id: number; inserted: boolean } {
  const existing = findCanonicalEventBySource(sourceRef);
  if (existing) return { id: existing.id, inserted: false };
  return { id: writeCanonicalEvent(event, sourceRef), inserted: true };
}
