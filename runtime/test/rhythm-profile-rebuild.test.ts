import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getRhythmProfilesUpdatedAtMs,
  rebuildRhythmProfiles,
  shouldRebuildRhythmProfiles,
} from "../src/diagnostics/rhythm-profile-rebuild.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const START_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE message_log (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      tick integer NOT NULL,
      chat_id text NOT NULL,
      msg_id integer,
      reply_to_msg_id integer,
      sender_id text,
      sender_name text,
      text text,
      media_type text,
      is_outgoing integer DEFAULT false NOT NULL,
      is_directed integer DEFAULT false NOT NULL,
      created_at integer NOT NULL
    );
  `);
});

afterEach(() => {
  db.close();
});

describe("ADR-261 rhythm profile rebuild cadence", () => {
  it("freshness gate respects disabled, missing, fresh, and stale profiles", () => {
    expect(
      shouldRebuildRhythmProfiles({
        updatedAtMs: null,
        nowMs: 10_000,
        intervalMs: 0,
      }),
    ).toBe(false);
    expect(
      shouldRebuildRhythmProfiles({
        updatedAtMs: null,
        nowMs: 10_000,
        intervalMs: 1_000,
      }),
    ).toBe(true);
    expect(
      shouldRebuildRhythmProfiles({
        updatedAtMs: 9_500,
        nowMs: 10_000,
        intervalMs: 1_000,
      }),
    ).toBe(false);
    expect(
      shouldRebuildRhythmProfiles({
        updatedAtMs: 8_999,
        nowMs: 10_000,
        intervalMs: 1_000,
      }),
    ).toBe(true);
  });

  it("rebuilds rhythm_profiles from message_log and writes coverage fields", () => {
    insertDailyMessages(30, [21, 22], "channel:group", "12345");
    const nowMs = START_MS + 31 * DAY_MS + 22 * HOUR_MS;

    const result = rebuildRhythmProfiles(db, {
      nowMs,
      timezoneOffset: 8,
    });

    expect(result.wrote).toBe(true);
    expect(result.profiles.length).toBeGreaterThanOrEqual(2);
    expect(getRhythmProfilesUpdatedAtMs(db)).toBe(nowMs);

    const channel = db
      .prepare(
        `SELECT entity_type, sample_count, observed_days, timezone_offset_hours, enabled_periods_json, updated_at_ms
         FROM rhythm_profiles
         WHERE entity_id = ?`,
      )
      .get("channel:group") as
      | {
          entity_type: string;
          sample_count: number;
          observed_days: number;
          timezone_offset_hours: number;
          enabled_periods_json: string;
          updated_at_ms: number;
        }
      | undefined;

    expect(channel).toMatchObject({
      entity_type: "channel",
      sample_count: 60,
      observed_days: 30,
      timezone_offset_hours: 8,
      updated_at_ms: nowMs,
    });
    expect(JSON.parse(channel?.enabled_periods_json ?? "[]")).toEqual([24, 12, 168]);
  });

  it("dry-run analyzes without creating projection table", () => {
    insertDailyMessages(8, [9, 21], "channel:dry", "67890");

    const result = rebuildRhythmProfiles(db, {
      nowMs: START_MS + 9 * DAY_MS,
      timezoneOffset: 8,
      dryRun: true,
    });

    expect(result.wrote).toBe(false);
    expect(result.profiles.length).toBeGreaterThan(0);
    expect(getRhythmProfilesUpdatedAtMs(db)).toBeNull();
  });
});

function insertDailyMessages(
  days: number,
  hours: readonly number[],
  chatId: string,
  senderId: string,
): void {
  const insert = db.prepare(`
    INSERT INTO message_log (tick, chat_id, msg_id, sender_id, text, is_outgoing, is_directed, created_at)
    VALUES (@tick, @chatId, @msgId, @senderId, @text, 0, 0, @createdAt)
  `);
  let msgId = 1;
  for (let day = 0; day < days; day++) {
    for (const hour of hours) {
      insert.run({
        tick: msgId,
        chatId,
        msgId,
        senderId,
        text: "hello",
        createdAt: Math.floor((START_MS + day * DAY_MS + hour * HOUR_MS) / 1000),
      });
      msgId++;
    }
  }
}
