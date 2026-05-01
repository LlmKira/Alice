/**
 * ADR-261: rebuildable rhythm profile projection writer.
 *
 * 这里是脚本和 runtime maintenance 的共享实现。事实源仍然是 message_log；
 * rhythm_profiles 只是可重建 projection，不是活跃事实权威。
 *
 * @see docs/adr/261-rhythm-profile-projection.md
 */

import type Database from "better-sqlite3";
import { collectRhythmEventsFromMessages } from "./rhythm-source.js";
import { buildRhythmProfile, type RhythmProfileProjection } from "./rhythm-spectrum.js";

const HOUR_MS = 3_600_000;
const DEFAULT_DAYS = 90;
const DEFAULT_MIN_SAMPLES = 12;
export const DEFAULT_RHYTHM_PROFILE_REBUILD_INTERVAL_MS = 6 * 60 * 60 * 1000;

const COVERAGE_MIGRATION_HASH = "0e7b130f1ad203d48b38da75428a3650950f3ccd91c72f11df0979f0cae05241";
const COVERAGE_MIGRATION_CREATED_AT = 1777350000000;

interface MessageRow {
  chat_id: string;
  sender_id: string | null;
  is_outgoing: number;
  created_at: number | string | Date;
}

export interface RhythmProfileRebuildOptions {
  nowMs?: number;
  days?: number;
  minSamples?: number;
  timezoneOffset: number;
  dryRun?: boolean;
}

export interface RhythmProfileRebuildResult {
  profiles: RhythmProfileProjection[];
  stats: ReturnType<typeof collectRhythmEventsFromMessages>["stats"];
  updatedAtMs: number;
  wrote: boolean;
}

export function getRhythmProfilesUpdatedAtMs(db: Database.Database): number | null {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rhythm_profiles'")
    .get() as { name: string } | undefined;
  if (!table) return null;

  const row = db.prepare("SELECT max(updated_at_ms) AS updatedAtMs FROM rhythm_profiles").get() as
    | { updatedAtMs: number | null }
    | undefined;
  return row?.updatedAtMs ?? null;
}

export function shouldRebuildRhythmProfiles(input: {
  updatedAtMs: number | null;
  nowMs: number;
  intervalMs: number;
}): boolean {
  if (input.intervalMs <= 0) return false;
  if (input.updatedAtMs == null) return true;
  return input.nowMs - input.updatedAtMs >= input.intervalMs;
}

export function rebuildRhythmProfiles(
  db: Database.Database,
  options: RhythmProfileRebuildOptions,
): RhythmProfileRebuildResult {
  const nowMs = options.nowMs ?? Date.now();
  const days = options.days ?? DEFAULT_DAYS;
  const minSamples = options.minSamples ?? DEFAULT_MIN_SAMPLES;
  const windowStartMs = nowMs - days * 24 * HOUR_MS;
  const dryRun = options.dryRun ?? false;

  if (!dryRun) ensureRhythmProfilesTable(db);

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
    .filter(([, events]) => events.length >= minSamples)
    .map(([entityId, events]) =>
      buildRhythmProfile(events, {
        entityId,
        entityType: events[0]?.entityType ?? "channel",
        nowMs,
        windowEndMs: nowMs,
        timezoneOffsetHours: options.timezoneOffset,
      }),
    );

  if (!dryRun) writeRhythmProfiles(db, profiles, nowMs);

  return { profiles, stats, updatedAtMs: nowMs, wrote: !dryRun };
}

function writeRhythmProfiles(
  db: Database.Database,
  profiles: readonly RhythmProfileProjection[],
  updatedAtMs: number,
): void {
  const upsert = db.prepare(`
    INSERT INTO rhythm_profiles (
      entity_id, entity_type, source_window_start_ms, source_window_end_ms,
      sample_count, bucket_count, active_bucket_count, observed_span_hours,
      observed_days, timezone_offset_hours, enabled_periods_json,
      active_now_score, quiet_now_score,
      unusual_activity_score, peak_windows_json, quiet_windows_json,
      confidence, stale, diagnostics_json, updated_at_ms
    )
    VALUES (
      @entityId, @entityType, @sourceWindowStartMs, @sourceWindowEndMs,
      @sampleCount, @bucketCount, @activeBucketCount, @observedSpanHours,
      @observedDays, @timezoneOffsetHours, @enabledPeriodsJson,
      @activeNowScore, @quietNowScore,
      @unusualActivityScore, @peakWindowsJson, @quietWindowsJson,
      @confidence, @stale, @diagnosticsJson, @updatedAtMs
    )
    ON CONFLICT(entity_id) DO UPDATE SET
      entity_type = excluded.entity_type,
      source_window_start_ms = excluded.source_window_start_ms,
      source_window_end_ms = excluded.source_window_end_ms,
      sample_count = excluded.sample_count,
      bucket_count = excluded.bucket_count,
      active_bucket_count = excluded.active_bucket_count,
      observed_span_hours = excluded.observed_span_hours,
      observed_days = excluded.observed_days,
      timezone_offset_hours = excluded.timezone_offset_hours,
      enabled_periods_json = excluded.enabled_periods_json,
      active_now_score = excluded.active_now_score,
      quiet_now_score = excluded.quiet_now_score,
      unusual_activity_score = excluded.unusual_activity_score,
      peak_windows_json = excluded.peak_windows_json,
      quiet_windows_json = excluded.quiet_windows_json,
      confidence = excluded.confidence,
      stale = excluded.stale,
      diagnostics_json = excluded.diagnostics_json,
      updated_at_ms = excluded.updated_at_ms
  `);
  const clearProfiles = db.prepare("DELETE FROM rhythm_profiles");

  const write = db.transaction(() => {
    clearProfiles.run();
    for (const profile of profiles) {
      upsert.run({
        entityId: profile.entityId,
        entityType: profile.entityType,
        sourceWindowStartMs: profile.sourceWindowStartMs,
        sourceWindowEndMs: profile.sourceWindowEndMs,
        sampleCount: profile.sampleCount,
        bucketCount: profile.bucketCount,
        activeBucketCount: profile.activeBucketCount,
        observedSpanHours: profile.observedSpanHours,
        observedDays: profile.observedDays,
        timezoneOffsetHours: profile.timezoneOffsetHours,
        enabledPeriodsJson: JSON.stringify(profile.enabledPeriodsHours),
        activeNowScore: profile.activeNowScore,
        quietNowScore: profile.quietNowScore,
        unusualActivityScore: profile.unusualActivityScore,
        peakWindowsJson: JSON.stringify(profile.peakWindows),
        quietWindowsJson: JSON.stringify(profile.quietWindows),
        confidence: profile.confidence,
        stale: profile.stale ? 1 : 0,
        diagnosticsJson: JSON.stringify(profile.diagnostics),
        updatedAtMs,
      });
    }
  });

  write();
}

function ensureRhythmProfilesTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rhythm_profiles (
      entity_id text PRIMARY KEY NOT NULL,
      entity_type text NOT NULL,
      source_window_start_ms integer NOT NULL,
      source_window_end_ms integer NOT NULL,
      sample_count integer NOT NULL,
      bucket_count integer NOT NULL,
      active_bucket_count integer NOT NULL DEFAULT 0,
      observed_span_hours real NOT NULL DEFAULT 0,
      observed_days integer NOT NULL DEFAULT 0,
      timezone_offset_hours real NOT NULL DEFAULT 0,
      enabled_periods_json text DEFAULT '[]' NOT NULL,
      active_now_score real NOT NULL,
      quiet_now_score real NOT NULL,
      unusual_activity_score real NOT NULL,
      peak_windows_json text DEFAULT '[]' NOT NULL,
      quiet_windows_json text DEFAULT '[]' NOT NULL,
      confidence text NOT NULL,
      stale integer DEFAULT false NOT NULL,
      diagnostics_json text DEFAULT '{}' NOT NULL,
      updated_at_ms integer NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rhythm_profiles_type ON rhythm_profiles(entity_type);
    CREATE INDEX IF NOT EXISTS idx_rhythm_profiles_confidence ON rhythm_profiles(confidence);
    CREATE INDEX IF NOT EXISTS idx_rhythm_profiles_updated ON rhythm_profiles(updated_at_ms);
  `);
  ensureColumn(db, "active_bucket_count", "integer NOT NULL DEFAULT 0");
  ensureColumn(db, "observed_span_hours", "real NOT NULL DEFAULT 0");
  ensureColumn(db, "observed_days", "integer NOT NULL DEFAULT 0");
  ensureColumn(db, "timezone_offset_hours", "real NOT NULL DEFAULT 0");
  ensureColumn(db, "enabled_periods_json", "text DEFAULT '[]' NOT NULL");
  markCoverageMigrationApplied(db);
}

function ensureColumn(db: Database.Database, name: string, ddl: string): void {
  const columns = db.pragma("table_info(rhythm_profiles)") as Array<{ name: string }>;
  if (columns.some((column) => column.name === name)) return;
  db.exec(`ALTER TABLE rhythm_profiles ADD COLUMN ${name} ${ddl}`);
}

function markCoverageMigrationApplied(db: Database.Database): void {
  const migrationTable = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
    )
    .get() as { name: string } | undefined;
  if (!migrationTable) return;

  const existing = db
    .prepare("SELECT 1 FROM __drizzle_migrations WHERE hash = ? LIMIT 1")
    .get(COVERAGE_MIGRATION_HASH);
  if (existing) return;

  db.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(
    COVERAGE_MIGRATION_HASH,
    COVERAGE_MIGRATION_CREATED_AT,
  );
}
