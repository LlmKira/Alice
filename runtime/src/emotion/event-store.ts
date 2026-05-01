/**
 * ADR-268: append-only self emotion event store.
 *
 * This is the fact ledger. Graph fields such as `emotion_state` are only
 * rebuildable projections/caches.
 *
 * @see docs/adr/268-emotion-episode-state/README.md
 */
import { asc, desc, gte } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { emotionEvents } from "../db/schema.js";
import type { EmotionCause, EmotionEpisode, EmotionKind } from "./types.js";

const READ_WINDOW_MS = 24 * 60 * 60_000;
const DEFAULT_LIMIT = 128;

function encodeCause(cause: EmotionCause): string {
  return JSON.stringify(cause);
}

function decodeCause(raw: string): EmotionCause {
  const parsed = JSON.parse(raw) as EmotionCause;
  if (!parsed || typeof parsed !== "object" || !("type" in parsed) || !("summary" in parsed)) {
    throw new Error("Invalid emotion event cause");
  }
  return parsed;
}

function toEpisode(row: typeof emotionEvents.$inferSelect): EmotionEpisode {
  return {
    id: row.eventId,
    kind: row.kind as EmotionKind,
    valence: row.valence,
    arousal: row.arousal,
    intensity: row.intensity,
    targetId: row.targetId ?? undefined,
    cause: decodeCause(row.causeJson),
    createdAtMs: row.createdAtMs,
    halfLifeMs: row.halfLifeMs,
    confidence: row.confidence,
  };
}

export function writeEmotionEvent(episode: EmotionEpisode): void {
  getDb()
    .insert(emotionEvents)
    .values({
      eventId: episode.id,
      kind: episode.kind,
      valence: episode.valence,
      arousal: episode.arousal,
      intensity: episode.intensity,
      targetId: episode.targetId ?? null,
      causeType: episode.cause.type,
      causeJson: encodeCause(episode.cause),
      createdAtMs: episode.createdAtMs,
      halfLifeMs: episode.halfLifeMs,
      confidence: episode.confidence,
    })
    .onConflictDoNothing()
    .run();
}

export function listRecentEmotionEvents(options: {
  nowMs: number;
  sinceMs?: number;
  limit?: number;
}): EmotionEpisode[] {
  const sinceMs = options.sinceMs ?? options.nowMs - READ_WINDOW_MS;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const rows = getDb()
    .select()
    .from(emotionEvents)
    .where(gte(emotionEvents.createdAtMs, sinceMs))
    .orderBy(desc(emotionEvents.createdAtMs), desc(emotionEvents.id))
    .limit(limit)
    .all();
  return rows.map(toEpisode).sort((a, b) => a.createdAtMs - b.createdAtMs);
}

export function listEmotionEventsForReplay(limit = DEFAULT_LIMIT): EmotionEpisode[] {
  return getDb()
    .select()
    .from(emotionEvents)
    .orderBy(asc(emotionEvents.createdAtMs), asc(emotionEvents.id))
    .limit(limit)
    .all()
    .map(toEpisode);
}
