/**
 * ADR-268: append-only self emotion repair fact store.
 *
 * Repair facts do not overwrite emotion episodes. Projection applies them as
 * acceleration inputs when deriving current effective intensity.
 *
 * @see docs/adr/268-emotion-episode-state/README.md
 */
import { asc, desc, gte } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { emotionRepairs } from "../db/schema.js";
import type { EmotionCause, EmotionKind, EmotionRepairEvent, EmotionRepairKind } from "./types.js";

const READ_WINDOW_MS = 24 * 60 * 60_000;
const DEFAULT_LIMIT = 128;

function encodeCause(cause: EmotionCause): string {
  return JSON.stringify(cause);
}

function decodeCause(raw: string): EmotionCause {
  const parsed = JSON.parse(raw) as EmotionCause;
  if (!parsed || typeof parsed !== "object" || !("type" in parsed) || !("summary" in parsed)) {
    throw new Error("Invalid emotion repair cause");
  }
  return parsed;
}

function toRepair(row: typeof emotionRepairs.$inferSelect): EmotionRepairEvent {
  return {
    id: row.repairId,
    repairKind: row.repairKind as EmotionRepairKind,
    emotionKind: (row.emotionKind as EmotionKind | null) ?? undefined,
    targetId: row.targetId ?? undefined,
    strength: row.strength,
    cause: decodeCause(row.causeJson),
    createdAtMs: row.createdAtMs,
    confidence: row.confidence,
  };
}

export function writeEmotionRepairEvent(repair: EmotionRepairEvent): void {
  getDb()
    .insert(emotionRepairs)
    .values({
      repairId: repair.id,
      repairKind: repair.repairKind,
      emotionKind: repair.emotionKind ?? null,
      targetId: repair.targetId ?? null,
      strength: repair.strength,
      causeType: repair.cause.type,
      causeJson: encodeCause(repair.cause),
      createdAtMs: repair.createdAtMs,
      confidence: repair.confidence,
    })
    .onConflictDoNothing()
    .run();
}

export function listRecentEmotionRepairEvents(options: {
  nowMs: number;
  sinceMs?: number;
  limit?: number;
}): EmotionRepairEvent[] {
  const sinceMs = options.sinceMs ?? options.nowMs - READ_WINDOW_MS;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const rows = getDb()
    .select()
    .from(emotionRepairs)
    .where(gte(emotionRepairs.createdAtMs, sinceMs))
    .orderBy(desc(emotionRepairs.createdAtMs), desc(emotionRepairs.id))
    .limit(limit)
    .all();
  return rows.map(toRepair).sort((a, b) => a.createdAtMs - b.createdAtMs);
}

export function listEmotionRepairEventsForReplay(limit = DEFAULT_LIMIT): EmotionRepairEvent[] {
  return getDb()
    .select()
    .from(emotionRepairs)
    .orderBy(asc(emotionRepairs.createdAtMs), asc(emotionRepairs.id))
    .limit(limit)
    .all()
    .map(toRepair);
}
