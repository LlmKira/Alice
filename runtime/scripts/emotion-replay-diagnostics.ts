/**
 * ADR-268 read-only replay diagnostics.
 *
 * This does not write emotion_events. It samples existing structured facts and
 * reports both production producer effects and coarse replay-only projections.
 *
 * @see docs/adr/268-emotion-episode-state/README.md
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";

type ReceptionOutcome = "warm_reply" | "cold_ignored" | "hostile" | "unknown_timeout";
type ProjectedKind =
  | "pleased"
  | "touched"
  | "shy"
  | "lonely"
  | "hurt"
  | "uneasy"
  | "annoyed"
  | "tired"
  | "flat";
type ProjectedRepairKind = "warm_return";

interface EvidenceRow {
  id: number;
  channel_id: string;
  outcome: ReceptionOutcome;
  signal: number | null;
  reply_to_alice_count: number;
  hostile_match_count: number;
  after_message_count: number;
  alice_message_at_ms: number;
  evaluated_at_ms: number;
}

const dbPath = resolve(process.argv[2] ?? "alice.db");
const limit = Number(process.argv[3] ?? 20);

if (!existsSync(dbPath)) {
  throw new Error(`DB not found: ${dbPath}`);
}

function projectCoarseReceptionEmotion(row: EvidenceRow): ProjectedKind[] {
  switch (row.outcome) {
    case "hostile":
      return ["hurt"];
    case "warm_reply":
      return ["pleased"];
    case "cold_ignored":
      return ["lonely"];
    case "unknown_timeout":
      return [];
  }
}

function projectProductionReceptionEffect(row: EvidenceRow): {
  emotionKinds: ProjectedKind[];
  repairKinds: ProjectedRepairKind[];
} {
  switch (row.outcome) {
    case "hostile":
      return { emotionKinds: ["hurt"], repairKinds: [] };
    case "warm_reply":
      return { emotionKinds: [], repairKinds: ["warm_return"] };
    case "cold_ignored":
    case "unknown_timeout":
      return { emotionKinds: [], repairKinds: [] };
  }
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const rows = db
  .prepare(
    `select
      id,
      channel_id,
      outcome,
      signal,
      reply_to_alice_count,
      hostile_match_count,
      after_message_count,
      alice_message_at_ms,
      evaluated_at_ms
    from intervention_outcome_evidence
    order by evaluated_at_ms desc
    limit ?`,
  )
  .all(limit) as EvidenceRow[];

const coarseCounts: Partial<Record<ProjectedKind, number>> = {};
const productionEmotionCounts: Partial<Record<ProjectedKind, number>> = {};
const productionRepairCounts: Partial<Record<ProjectedRepairKind, number>> = {};
const outcomeCounts: Partial<Record<ReceptionOutcome, number>> = {};
const samples = rows.map((row) => {
  outcomeCounts[row.outcome] = (outcomeCounts[row.outcome] ?? 0) + 1;
  const coarseProjection = projectCoarseReceptionEmotion(row);
  const productionEffects = projectProductionReceptionEffect(row);
  for (const kind of coarseProjection) coarseCounts[kind] = (coarseCounts[kind] ?? 0) + 1;
  for (const kind of productionEffects.emotionKinds) {
    productionEmotionCounts[kind] = (productionEmotionCounts[kind] ?? 0) + 1;
  }
  for (const kind of productionEffects.repairKinds) {
    productionRepairCounts[kind] = (productionRepairCounts[kind] ?? 0) + 1;
  }
  return {
    evidenceId: row.id,
    channelId: row.channel_id,
    outcome: row.outcome,
    productionEffects,
    coarseProjection,
    replyToAliceCount: row.reply_to_alice_count,
    hostileMatchCount: row.hostile_match_count,
    afterMessageCount: row.after_message_count,
  };
});

console.log(
  JSON.stringify(
    {
      dbPath,
      scanned: rows.length,
      outcomeCounts,
      productionEmotionCounts,
      productionRepairCounts,
      coarseDiagnosticEmotionCounts: coarseCounts,
      samples,
      writesDb: false,
    },
    null,
    2,
  ),
);
