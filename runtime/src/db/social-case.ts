/**
 * ADR-262 Wave 2A: social case event fact repository.
 *
 * This is the parse boundary for `social_events`. Runtime code should write and
 * read typed `SocialEvent` values here, not parse JSON columns ad hoc.
 *
 * @see docs/adr/262-social-case-management/README.md
 */
import { asc, eq } from "drizzle-orm";
import {
  SOCIAL_CAUSE_KINDS,
  SOCIAL_EVENT_KINDS,
  type SocialCause,
  type SocialEvent,
  type SocialVisibility,
} from "../social-case/types.js";
import { getDb } from "./connection.js";
import { socialEvents } from "./schema.js";

type SocialEventRow = typeof socialEvents.$inferSelect;

const EVENT_KINDS = new Set<string>(SOCIAL_EVENT_KINDS);
const CAUSE_KINDS = new Set<string>(SOCIAL_CAUSE_KINDS);
const VISIBILITIES = new Set<string>(["private", "public", "semi_public"]);

function relationKey(relation: readonly [string, string]): string {
  const [a, b] = relation;
  return [a, b].sort().join("::");
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} is required`);
  return trimmed;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function assertVisibility(value: string): asserts value is SocialVisibility {
  if (!VISIBILITIES.has(value)) throw new Error(`invalid social visibility: ${value}`);
}

function assertEventKind(value: string): asserts value is SocialEvent["kind"] {
  if (!EVENT_KINDS.has(value)) throw new Error(`invalid social event kind: ${value}`);
}

function assertCauseKind(value: string): asserts value is SocialCause["kind"] {
  if (!CAUSE_KINDS.has(value)) throw new Error(`invalid social cause kind: ${value}`);
}

function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? []);
}

function parseJson(raw: string, field: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `invalid ${field} JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseStringArray(raw: string, field: string): string[] {
  const value = parseJson(raw, field);
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${field} must be a string array`);
  }
  return value;
}

function parseNumberArray(raw: string, field: string): number[] {
  const value = parseJson(raw, field);
  if (!Array.isArray(value) || !value.every((item) => Number.isFinite(item))) {
    throw new Error(`${field} must be a number array`);
  }
  return value;
}

function parseCauses(raw: string): SocialCause[] {
  const value = parseJson(raw, "causes_json");
  if (!Array.isArray(value)) throw new Error("causes_json must be an array");
  return value.map((item, index) => {
    if (typeof item !== "object" || item == null) {
      throw new Error(`causes_json[${index}] must be an object`);
    }
    const cause = item as Record<string, unknown>;
    if (typeof cause.kind !== "string" || !CAUSE_KINDS.has(cause.kind)) {
      throw new Error(`invalid social cause kind at causes_json[${index}]`);
    }
    if (typeof cause.text !== "string" || cause.text.trim() === "") {
      throw new Error(`causes_json[${index}].text is required`);
    }
    if (typeof cause.visibility !== "string") {
      throw new Error(`causes_json[${index}].visibility is required`);
    }
    assertVisibility(cause.visibility);
    return {
      kind: cause.kind as SocialCause["kind"],
      text: cause.text,
      visibility: cause.visibility,
      venueId: typeof cause.venueId === "string" ? cause.venueId : undefined,
      sourceEventId: typeof cause.sourceEventId === "string" ? cause.sourceEventId : undefined,
      confidence:
        typeof cause.confidence === "number" && Number.isFinite(cause.confidence)
          ? cause.confidence
          : undefined,
    };
  });
}

function normalizeCause(input: SocialCause, index: number): SocialCause {
  assertCauseKind(input.kind);
  assertVisibility(input.visibility);
  return {
    kind: input.kind,
    text: requireNonEmpty(input.text, `causes[${index}].text`),
    visibility: input.visibility,
    venueId: input.venueId?.trim() || undefined,
    sourceEventId: input.sourceEventId?.trim() || undefined,
    confidence: input.confidence == null ? undefined : clamp01(input.confidence),
  };
}

function normalizeEvent(input: SocialEvent): SocialEvent {
  assertEventKind(input.kind);
  assertVisibility(input.visibility);
  const [a, b] = input.affectedRelation;
  return {
    ...input,
    id: requireNonEmpty(input.id, "id"),
    caseId: input.caseId?.trim() || undefined,
    actorId: requireNonEmpty(input.actorId, "actorId"),
    targetId: input.targetId?.trim() || undefined,
    affectedRelation: [
      requireNonEmpty(a, "affectedRelation[0]"),
      requireNonEmpty(b, "affectedRelation[1]"),
    ],
    venueId: requireNonEmpty(input.venueId, "venueId"),
    severity: clamp01(input.severity),
    confidence: clamp01(input.confidence),
    witnesses: [...input.witnesses],
    evidenceMsgIds: [...input.evidenceMsgIds],
    causes: input.causes?.map(normalizeCause),
  };
}

function toSocialEvent(row: SocialEventRow): SocialEvent {
  assertEventKind(row.kind);
  assertVisibility(row.visibility);
  const causes = parseCauses(row.causesJson);
  return {
    id: row.eventId,
    caseId: row.caseId ?? undefined,
    kind: row.kind,
    actorId: row.actorId,
    targetId: row.targetId ?? undefined,
    affectedRelation: [row.affectedRelationA, row.affectedRelationB],
    venueId: row.venueId,
    visibility: row.visibility,
    witnesses: parseStringArray(row.witnessesJson, "witnesses_json"),
    severity: row.severity,
    confidence: row.confidence,
    evidenceMsgIds: parseNumberArray(row.evidenceMsgIdsJson, "evidence_msg_ids_json"),
    occurredAtMs: row.occurredAtMs,
    text: row.contentText ?? undefined,
    causes,
    repairsEventId: row.repairsEventId ?? undefined,
    boundaryText: row.boundaryText ?? undefined,
  };
}

export function writeSocialEvent(input: SocialEvent): SocialEvent {
  const event = normalizeEvent(input);
  const [affectedRelationA, affectedRelationB] = event.affectedRelation;
  getDb()
    .insert(socialEvents)
    .values({
      eventId: event.id,
      caseId: event.caseId ?? null,
      kind: event.kind,
      actorId: event.actorId,
      targetId: event.targetId ?? null,
      affectedRelationA,
      affectedRelationB,
      affectedRelationKey: relationKey(event.affectedRelation),
      venueId: event.venueId,
      visibility: event.visibility,
      witnessesJson: encodeJson(event.witnesses),
      severity: event.severity,
      confidence: event.confidence,
      evidenceMsgIdsJson: encodeJson(event.evidenceMsgIds),
      causesJson: encodeJson(event.causes ?? []),
      occurredAtMs: event.occurredAtMs,
      repairsEventId: event.repairsEventId ?? null,
      boundaryText: event.boundaryText ?? null,
      contentText: event.text ?? null,
    })
    .onConflictDoNothing()
    .run();
  return event;
}

export function listSocialEvents(): SocialEvent[] {
  return getDb()
    .select()
    .from(socialEvents)
    .orderBy(asc(socialEvents.occurredAtMs), asc(socialEvents.id))
    .all()
    .map(toSocialEvent);
}

export function listSocialEventsForRelation(relation: readonly [string, string]): SocialEvent[] {
  return getDb()
    .select()
    .from(socialEvents)
    .where(eq(socialEvents.affectedRelationKey, relationKey(relation)))
    .orderBy(asc(socialEvents.occurredAtMs), asc(socialEvents.id))
    .all()
    .map(toSocialEvent);
}
