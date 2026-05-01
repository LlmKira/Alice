#!/usr/bin/env tsx
/**
 * ADR-261 Wave 0: rhythm profile audit.
 *
 * 只读真实 SQLite 事实，生成诊断报告；不写 DB，不影响运行时行为。
 *
 * Usage:
 *   cd runtime && npx tsx scripts/rhythm-profile-audit.ts
 *   cd runtime && npx tsx scripts/rhythm-profile-audit.ts --days 30 --min-samples 20
 *
 * @see docs/adr/261-rhythm-profile-projection.md
 */

import { resolve } from "node:path";
import Database from "better-sqlite3";
import { collectRhythmEventsFromMessages } from "../src/diagnostics/rhythm-source.js";
import {
  buildRhythmProfile,
  explainRhythmConfidence,
  renderTimingLine,
} from "../src/diagnostics/rhythm-spectrum.js";

interface Args {
  dbPath: string;
  days: number;
  minSamples: number;
  limit: number;
  timezoneOffset: number;
}

interface MessageRow {
  chat_id: string;
  sender_id: string | null;
  is_outgoing: number;
  created_at: number | string | Date;
}

const args = parseArgs(process.argv.slice(2));
const db = new Database(args.dbPath, { readonly: true });
const nowMs = Date.now();
const windowStartMs = nowMs - args.days * 24 * 3_600_000;

const rows = db
  .prepare(
    `SELECT chat_id, sender_id, is_outgoing, created_at
     FROM message_log
     WHERE created_at >= ?
     ORDER BY created_at ASC`,
  )
  .all(Math.floor(windowStartMs / 1000)) as MessageRow[];

const { byEntity, stats } = collectRhythmEventsFromMessages(rows);

const profiles = [...byEntity.entries()]
  .filter(([, events]) => events.length >= args.minSamples)
  .map(([entityId, events]) =>
    buildRhythmProfile(events, {
      entityId,
      entityType: events[0]?.entityType ?? "channel",
      nowMs,
      windowEndMs: nowMs,
      timezoneOffsetHours: args.timezoneOffset,
    }),
  )
  .sort((a, b) => {
    const aPower = Math.max(a.diagnostics.dailyStrength, a.diagnostics.weeklyStrength);
    const bPower = Math.max(b.diagnostics.dailyStrength, b.diagnostics.weeklyStrength);
    return bPower - aPower;
  })
  .slice(0, args.limit);

console.log("===============================================================");
console.log("  Rhythm Profile Audit (ADR-261 Wave 0)");
console.log("===============================================================");
console.log(`DB:          ${args.dbPath}`);
console.log(`Window:      ${args.days} days`);
console.log(`Timezone:    UTC${args.timezoneOffset >= 0 ? "+" : ""}${args.timezoneOffset}`);
console.log(`Entities:    ${byEntity.size}`);
console.log(`Reported:    ${profiles.length}`);
console.log(
  `Source:      rows=${stats.rowsRead}, channelEvents=${stats.channelEvents}, contactEvents=${stats.contactEvents}`,
);
console.log(
  `Skipped:     invalidTime=${stats.rowsSkippedInvalidTime}, outgoingSenders=${stats.skippedOutgoingSenders}, channelLikeSenders=${stats.skippedChannelLikeSenders}, invalidSenders=${stats.skippedInvalidSenders}`,
);
console.log();

for (const profile of profiles) {
  const line = renderTimingLine(profile, profile.entityId) ?? "(no timing line: not relevant now)";
  console.log(`- ${profile.entityId} [${profile.entityType}]`);
  console.log(
    `  samples=${profile.sampleCount} confidence=${profile.confidence} stale=${profile.stale} r2=${profile.diagnostics.r2.toFixed(3)}`,
  );
  console.log(
    `  coverage=${profile.observedDays}d/${profile.observedSpanHours.toFixed(1)}h activeBuckets=${profile.activeBucketCount} periods=${profile.enabledPeriodsHours.join(",") || "none"}`,
  );
  console.log(`  confidenceReasons=${explainRhythmConfidence(profile).join(",")}`);
  console.log(
    `  daily=${profile.diagnostics.dailyStrength.toFixed(3)} halfDaily=${profile.diagnostics.halfDailyStrength.toFixed(3)} weekly=${profile.diagnostics.weeklyStrength.toFixed(3)}`,
  );
  console.log(
    `  activeNow=${profile.activeNowScore.toFixed(2)} quietNow=${profile.quietNowScore.toFixed(2)}`,
  );
  console.log(`  ${line}`);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dbPath: resolve(import.meta.dirname ?? ".", "../alice.db"),
    days: 90,
    minSamples: 12,
    limit: 20,
    timezoneOffset: Number(process.env.TIMEZONE_OFFSET ?? "8"),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--db" && next) {
      args.dbPath = resolve(process.cwd(), next);
      i++;
    } else if (arg === "--days" && next) {
      args.days = Number(next);
      i++;
    } else if (arg === "--min-samples" && next) {
      args.minSamples = Number(next);
      i++;
    } else if (arg === "--limit" && next) {
      args.limit = Number(next);
      i++;
    } else if (arg === "--timezone-offset" && next) {
      args.timezoneOffset = Number(next);
      i++;
    }
  }
  return args;
}
