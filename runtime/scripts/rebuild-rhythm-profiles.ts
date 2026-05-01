#!/usr/bin/env tsx
/**
 * ADR-261 Wave 1: rebuild rhythm_profiles projection.
 *
 * 从 SQLite 事实源重建当前节律画像投影。默认写入 runtime/alice.db；
 * 使用 --dry-run 时只打印将写入的行，不修改 DB。
 *
 * Usage:
 *   cd runtime && npx tsx scripts/rebuild-rhythm-profiles.ts --dry-run
 *   cd runtime && npx tsx scripts/rebuild-rhythm-profiles.ts --days 90 --min-samples 12
 *
 * @see docs/adr/261-rhythm-profile-projection.md
 */

import { resolve } from "node:path";
import Database from "better-sqlite3";
import {
  type RhythmProfileRebuildResult,
  rebuildRhythmProfiles,
} from "../src/diagnostics/rhythm-profile-rebuild.js";
import { explainRhythmConfidence } from "../src/diagnostics/rhythm-spectrum.js";

interface Args {
  dbPath: string;
  days: number;
  minSamples: number;
  limit: number;
  timezoneOffset: number;
  dryRun: boolean;
}

const args = parseArgs(process.argv.slice(2));
const db = new Database(args.dbPath, args.dryRun ? { readonly: true } : undefined);
const result = rebuildRhythmProfiles(db, {
  days: args.days,
  minSamples: args.minSamples,
  timezoneOffset: args.timezoneOffset,
  dryRun: args.dryRun,
});

if (args.dryRun) {
  console.log(`dry-run: would upsert ${result.profiles.length} rhythm_profiles rows`);
} else {
  console.log(`upserted ${result.profiles.length} rhythm_profiles rows`);
}
printSourceStats(result);
printProfiles(result, args.limit);

function printProfiles(result: RhythmProfileRebuildResult, limit: number): void {
  for (const profile of result.profiles.slice(0, limit)) {
    console.log(
      `${profile.entityId} ${profile.entityType} samples=${profile.sampleCount} confidence=${profile.confidence} reasons=${explainRhythmConfidence(profile).join(",")} r2=${profile.diagnostics.r2.toFixed(3)}`,
      `coverage=${profile.observedDays}d/${profile.observedSpanHours.toFixed(1)}h activeBuckets=${profile.activeBucketCount} periods=${profile.enabledPeriodsHours.join(",") || "none"}`,
    );
  }
}

function printSourceStats(result: RhythmProfileRebuildResult): void {
  const { stats } = result;
  console.log(
    `source: rows=${stats.rowsRead} channel_events=${stats.channelEvents} contact_events=${stats.contactEvents} skipped_channel_like_senders=${stats.skippedChannelLikeSenders} skipped_invalid_senders=${stats.skippedInvalidSenders}`,
  );
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dbPath: resolve(import.meta.dirname ?? ".", "../alice.db"),
    days: 90,
    minSamples: 12,
    limit: 10,
    timezoneOffset: Number(process.env.TIMEZONE_OFFSET ?? "8"),
    dryRun: false,
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
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    }
  }
  return args;
}
