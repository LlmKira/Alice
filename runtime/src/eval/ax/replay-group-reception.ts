/**
 * ADR-263 Wave 4.7: offline replay for group reception Ax shadow judge.
 *
 * This reads existing intervention_outcome_evidence rows and replays the Ax
 * shadow judge without touching runtime control, DB facts, or PM2.
 *
 * @see docs/adr/263-ax-llm-program-optimization/README.md
 * @see docs/adr/255-intervention-outcome-truth-model/README.md
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { AxAI, ax } from "@ax-llm/ax";
import Database from "better-sqlite3";
import { loadConfig } from "../../config.js";
import {
  GROUP_RECEPTION_SHADOW_RULES,
  GROUP_RECEPTION_SHADOW_SIGNATURE,
  ReceptionShadowPredictionSchema,
} from "../../mods/observer/group-reception.js";
import { ALICE_DB_PATH } from "../../runtime-paths.js";
import { type AxForwardProgram, forwardWithFailure } from "./judge.js";

const rawArgs = process.argv.slice(2);
if (rawArgs[0] === "--") rawArgs.shift();

const { values } = parseArgs({
  args: rawArgs,
  options: {
    db: { type: "string", default: ALICE_DB_PATH },
    limit: { type: "string", default: "50" },
    "since-id": { type: "string" },
    "output-dir": { type: "string", default: "eval-artifacts/ax-group-reception-replay" },
  },
  strict: false,
  allowPositionals: true,
});

type ReceptionOutcome = "warm_reply" | "cold_ignored" | "hostile" | "unknown_timeout";

type GroupReceptionPrediction = {
  outcome?: unknown;
  confidence?: unknown;
  rationale?: unknown;
};

type EvidenceRow = {
  id: number;
  tick: number | null;
  channelId: string;
  aliceMessageLogId: number;
  aliceMsgId: number | null;
  aliceMessageAtMs: number;
  evaluatedAtMs: number;
  outcome: string;
  afterMessageCount: number;
  replyToAliceCount: number;
  hostileMatchCount: number;
  sourceMessageLogIdsJson: string;
  aliceText: string | null;
};

type LaterMessageRow = {
  id: number;
  text: string | null;
  replyToMsgId: number | null;
};

type ReplayRecord = {
  schemaVersion: 1;
  generatedAt: string;
  kind: "sample" | "mismatch";
  evidenceId: number;
  tick: number | null;
  aliceMessageLogId: number;
  channelId: string;
  deterministicOutcome: ReceptionOutcome;
  shadowOutcome: ReceptionOutcome;
  confidence: number;
  rationale: string;
  afterMessageCount: number;
  replyToAliceCount: number;
  hostileMatchCount: number;
  sourceMessageLogIds: number[];
  error?: string;
};

function makeAxAI() {
  const config = loadConfig();
  if (!config.llmReflectApiKey) {
    throw new Error("LLM_REFLECT_API_KEY or LLM_API_KEY is required for group reception replay.");
  }
  return {
    ai: AxAI.create({
      name: "openai",
      apiKey: config.llmReflectApiKey,
      apiURL: config.llmReflectBaseUrl,
      config: { model: config.llmReflectModel as never, stream: false, temperature: 0 },
    } as never),
    provider: {
      name: "reflect",
      model: config.llmReflectModel,
      baseUrl: config.llmReflectBaseUrl,
    },
  };
}

function parseSourceMessageLogIds(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is number => Number.isInteger(id));
  } catch {
    return [];
  }
}

function normalizePrediction(prediction: GroupReceptionPrediction): {
  outcome: ReceptionOutcome;
  confidence: number;
  rationale: string;
  error?: string;
} {
  const parsed = ReceptionShadowPredictionSchema.safeParse({
    ...prediction,
    outcome:
      typeof prediction.outcome === "string"
        ? prediction.outcome.trim().toLowerCase()
        : prediction.outcome,
  });
  if (!parsed.success) {
    return {
      outcome: "unknown_timeout",
      confidence: 0,
      rationale: "schema validation failed",
      error: parsed.error.message,
    };
  }
  return parsed.data;
}

function normalizeOutcome(value: string): ReceptionOutcome {
  if (
    value === "warm_reply" ||
    value === "cold_ignored" ||
    value === "hostile" ||
    value === "unknown_timeout"
  ) {
    return value;
  }
  return "unknown_timeout";
}

function formatAliceMessage(row: EvidenceRow): string {
  return [
    `db_id=${row.aliceMessageLogId}`,
    `telegram_msg_id=${row.aliceMsgId ?? "unknown"}`,
    `created_at_ms=${row.aliceMessageAtMs}`,
    `text=${row.aliceText ?? ""}`,
  ].join("\n");
}

function formatFollowUpMessages(aliceMsgId: number | null, messages: readonly LaterMessageRow[]) {
  if (messages.length === 0) return "(no follow-up messages)";
  return messages
    .map((msg) => {
      const replyMarker =
        aliceMsgId !== null && msg.replyToMsgId === aliceMsgId ? "reply_to_alice" : "not_reply";
      return `db_id=${msg.id} ${replyMarker}: ${msg.text ?? ""}`;
    })
    .join("\n");
}

function loadEvidenceRows(
  sqlite: Database.Database,
  limit: number,
  sinceId?: number,
): EvidenceRow[] {
  const where = sinceId != null ? "where ioe.id > @sinceId" : "";
  return sqlite
    .prepare(`
      select
        ioe.id,
        ioe.tick,
        ioe.channel_id as channelId,
        ioe.alice_message_log_id as aliceMessageLogId,
        ioe.alice_msg_id as aliceMsgId,
        ioe.alice_message_at_ms as aliceMessageAtMs,
        ioe.evaluated_at_ms as evaluatedAtMs,
        ioe.outcome,
        ioe.after_message_count as afterMessageCount,
        ioe.reply_to_alice_count as replyToAliceCount,
        ioe.hostile_match_count as hostileMatchCount,
        ioe.source_message_log_ids_json as sourceMessageLogIdsJson,
        m.text as aliceText
      from intervention_outcome_evidence ioe
      left join message_log m on m.id = ioe.alice_message_log_id
      ${where}
      order by ioe.id desc
      limit @limit
    `)
    .all({ limit, sinceId }) as EvidenceRow[];
}

function loadLaterMessages(
  sqlite: Database.Database,
  sourceMessageLogIds: readonly number[],
): LaterMessageRow[] {
  if (sourceMessageLogIds.length === 0) return [];
  const placeholders = sourceMessageLogIds.map(() => "?").join(",");
  return sqlite
    .prepare(`
      select id, text, reply_to_msg_id as replyToMsgId
      from message_log
      where id in (${placeholders})
      order by created_at, id
    `)
    .all(...sourceMessageLogIds) as LaterMessageRow[];
}

async function main(): Promise<void> {
  const dbPath = values.db as string;
  const limit = Number.parseInt(values.limit as string, 10) || 50;
  const sinceId =
    typeof values["since-id"] === "string"
      ? Number.parseInt(values["since-id"] as string, 10)
      : undefined;
  const outputDir = values["output-dir"] as string;
  const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
  const { ai, provider } = makeAxAI();
  const program = ax(
    GROUP_RECEPTION_SHADOW_SIGNATURE,
  ) as unknown as AxForwardProgram<GroupReceptionPrediction>;
  const rows = loadEvidenceRows(sqlite, limit, Number.isFinite(sinceId) ? sinceId : undefined);
  const records: ReplayRecord[] = [];

  console.log("ADR-263 Ax group reception replay");
  console.log(`  db=${dbPath}`);
  console.log(`  rows=${rows.length}`);
  console.log(`  provider=${provider.model}`);

  for (const row of rows) {
    const sourceMessageLogIds = parseSourceMessageLogIds(row.sourceMessageLogIdsJson);
    const followUps = loadLaterMessages(sqlite, sourceMessageLogIds);
    const result = await forwardWithFailure(
      program,
      ai,
      {
        aliceMessage: formatAliceMessage(row),
        followUpMessages: formatFollowUpMessages(row.aliceMsgId, followUps),
        observation: [
          `afterMessageCount=${row.afterMessageCount}`,
          `replyToAliceCount=${row.replyToAliceCount}`,
          `hostileMatchCount=${row.hostileMatchCount}`,
          `elapsedMs=${Math.max(0, row.evaluatedAtMs - row.aliceMessageAtMs)}`,
        ].join("\n"),
        rules: GROUP_RECEPTION_SHADOW_RULES,
      },
      { outcome: "unknown_timeout", confidence: 0, rationale: "judge failed" },
    );
    const actual = normalizePrediction(result.prediction);
    if (result.error) actual.error = result.error;
    const deterministicOutcome = normalizeOutcome(row.outcome);
    const kind =
      actual.outcome !== deterministicOutcome && actual.confidence >= 0.6 ? "mismatch" : "sample";
    records.push({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      kind,
      evidenceId: row.id,
      tick: row.tick,
      aliceMessageLogId: row.aliceMessageLogId,
      channelId: row.channelId,
      deterministicOutcome,
      shadowOutcome: actual.outcome,
      confidence: actual.confidence,
      rationale: actual.rationale,
      afterMessageCount: row.afterMessageCount,
      replyToAliceCount: row.replyToAliceCount,
      hostileMatchCount: row.hostileMatchCount,
      sourceMessageLogIds,
      ...(actual.error ? { error: actual.error } : {}),
    });
    console.log(
      `  #${row.id}: deterministic=${deterministicOutcome} shadow=${actual.outcome} confidence=${actual.confidence.toFixed(2)} ${kind.toUpperCase()}`,
    );
  }

  const generatedAt = new Date().toISOString();
  const timestamp = generatedAt.replace(/[:.]/g, "-");
  mkdirSync(outputDir, { recursive: true });
  const jsonlPath = join(outputDir, `ax-group-reception-replay-${timestamp}.jsonl`);
  const summaryPath = join(outputDir, `ax-group-reception-replay-${timestamp}.summary.json`);
  writeFileSync(jsonlPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  const mismatchCount = records.filter((record) => record.kind === "mismatch").length;
  const summary = {
    schemaVersion: 1,
    adr: "ADR-263",
    task: "group_reception_shadow_replay",
    generatedAt,
    provider,
    dbPath,
    limit,
    sinceId: Number.isFinite(sinceId) ? sinceId : null,
    total: records.length,
    mismatches: mismatchCount,
    mismatchRate: records.length > 0 ? mismatchCount / records.length : 0,
    byDeterministicOutcome: Object.fromEntries(
      ["warm_reply", "cold_ignored", "hostile", "unknown_timeout"].map((outcome) => [
        outcome,
        records.filter((record) => record.deterministicOutcome === outcome).length,
      ]),
    ),
    jsonlPath,
  };
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  sqlite.close();

  console.log(`\nReplay complete: total=${records.length}, mismatches=${mismatchCount}`);
  console.log(`JSONL written: ${jsonlPath}`);
  console.log(`Summary written: ${summaryPath}`);
}

main().catch((error) => {
  console.error("Ax group reception replay failed:", error);
  process.exit(1);
});
