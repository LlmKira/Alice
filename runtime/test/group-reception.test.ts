/**
 * ADR-255: group reception evidence integration tests.
 *
 * 只 mock getDb()，其余路径使用真实 in-memory SQLite + Drizzle。
 * @see docs/adr/255-intervention-outcome-truth-model/README.md
 */
import Database from "better-sqlite3";
import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as connection from "../src/db/connection.js";
import { interventionOutcomeEvidence, messageLog } from "../src/db/schema.js";
import { readEmotionEpisodes, readEmotionState } from "../src/emotion/graph.js";
import { deriveEmotionControlPatch } from "../src/emotion/state.js";
import { readSocialReception } from "../src/graph/dynamic-props.js";
import { WorldModel } from "../src/graph/world-model.js";
import {
  initGroupReceptionShadowJudge,
  isGroupReceptionShadowJudgeInitialized,
  resetGroupReceptionShadowJudge,
  updateGroupReception,
} from "../src/mods/observer/group-reception.js";

const NOW_MS = Date.UTC(2026, 3, 25, 12, 0, 0);
const GROUP_ID = "channel:-100255";
const PRIVATE_ID = "channel:255";

let sqlite: InstanceType<typeof Database>;
let db: ReturnType<typeof drizzle>;

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema: { interventionOutcomeEvidence, messageLog } });
  createTables();
  vi.spyOn(connection, "getDb").mockReturnValue(db as ReturnType<typeof connection.getDb>);
  resetGroupReceptionShadowJudge();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetGroupReceptionShadowJudge();
  sqlite.close();
});

function createTables(): void {
  sqlite.exec(`
    CREATE TABLE message_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tick INTEGER NOT NULL,
      chat_id TEXT NOT NULL,
      msg_id INTEGER,
      reply_to_msg_id INTEGER,
      sender_id TEXT,
      sender_name TEXT,
      text TEXT,
      media_type TEXT,
      is_outgoing INTEGER NOT NULL DEFAULT 0,
      is_directed INTEGER NOT NULL DEFAULT 0,
      platform TEXT NOT NULL DEFAULT 'telegram',
      native_chat_id TEXT,
      native_msg_id TEXT,
      stable_message_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_message_log_tick ON message_log (tick);
    CREATE INDEX idx_message_log_chat ON message_log (chat_id);
    CREATE INDEX idx_message_log_chat_tick ON message_log (chat_id, tick);
    CREATE INDEX idx_message_log_chat_msg ON message_log (chat_id, msg_id);
    CREATE INDEX idx_message_log_sender ON message_log (sender_id);
    CREATE INDEX idx_message_log_platform_native
      ON message_log (platform, native_chat_id, native_msg_id);
    CREATE INDEX idx_message_log_stable_message
      ON message_log (stable_message_id);

    CREATE TABLE intervention_outcome_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tick INTEGER,
      channel_id TEXT NOT NULL,
      alice_message_log_id INTEGER NOT NULL,
      alice_msg_id INTEGER,
      alice_message_at_ms INTEGER NOT NULL,
      evaluated_at_ms INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      signal REAL,
      after_message_count INTEGER NOT NULL,
      reply_to_alice_count INTEGER NOT NULL,
      hostile_match_count INTEGER NOT NULL,
      source_message_log_ids_json TEXT NOT NULL,
      previous_reception REAL,
      next_reception REAL,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_intervention_outcome_evidence_alice_message_log_id
      ON intervention_outcome_evidence (alice_message_log_id);
    CREATE INDEX idx_intervention_outcome_evidence_channel_time
      ON intervention_outcome_evidence (channel_id, alice_message_at_ms);
    CREATE INDEX idx_intervention_outcome_evidence_outcome
      ON intervention_outcome_evidence (outcome);
  `);
}

function addGraphChannel(
  channelId = GROUP_ID,
  chatType: "group" | "private" | "supergroup" = "supergroup",
) {
  const graph = new WorldModel();
  graph.addAgent("self");
  graph.addChannel(channelId, { chat_type: chatType });
  return graph;
}

function insertMessage(opts: {
  chatId?: string;
  msgId?: number;
  replyToMsgId?: number;
  text?: string;
  isOutgoing?: boolean;
  tick?: number;
  createdAtMs: number;
}): number {
  const row = db
    .insert(messageLog)
    .values({
      tick: opts.tick ?? 1,
      chatId: opts.chatId ?? GROUP_ID,
      msgId: opts.msgId ?? null,
      replyToMsgId: opts.replyToMsgId ?? null,
      senderId: opts.isOutgoing ? "self" : "user:255",
      senderName: opts.isOutgoing ? "Alice" : "群友",
      text: opts.text ?? null,
      isOutgoing: opts.isOutgoing ?? false,
      isDirected: false,
      createdAt: new Date(opts.createdAtMs),
    })
    .returning({ id: messageLog.id })
    .get();
  if (!row) throw new Error("message_log insert did not return an id");
  return row.id;
}

function insertAliceMessage(opts: { chatId?: string; msgId?: number; createdAtMs?: number } = {}) {
  return insertMessage({
    chatId: opts.chatId,
    msgId: opts.msgId ?? 2550,
    text: "我插一句",
    isOutgoing: true,
    createdAtMs: opts.createdAtMs ?? NOW_MS - 60_000,
  });
}

function insertLaterMessages(count: number, opts: { chatId?: string; startAtMs?: number } = {}) {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(
      insertMessage({
        chatId: opts.chatId,
        msgId: 3000 + i,
        text: `继续聊 ${i}`,
        createdAtMs: (opts.startAtMs ?? NOW_MS - 50_000) + i * 1000,
      }),
    );
  }
  return ids;
}

function readEvidenceRows() {
  return db
    .select()
    .from(interventionOutcomeEvidence)
    .orderBy(asc(interventionOutcomeEvidence.id))
    .all();
}

function readOnlyEvidenceRow() {
  const rows = readEvidenceRows();
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (!row) throw new Error("expected one intervention outcome evidence row");
  return row;
}

describe("updateGroupReception ADR-255 evidence", () => {
  it("group reception Ax shadow judge is opt-in and does not initialize without key", () => {
    initGroupReceptionShadowJudge({
      llmReflectModel: "gpt-4o-mini",
      llmReflectBaseUrl: "https://api.example.com/v1",
      llmReflectApiKey: "",
    } as Parameters<typeof initGroupReceptionShadowJudge>[0]);

    expect(isGroupReceptionShadowJudgeInitialized()).toBe(false);
  });

  it("group reception Ax shadow judge can initialize from Reflect Provider config", () => {
    initGroupReceptionShadowJudge({
      llmReflectModel: "gpt-4o-mini",
      llmReflectBaseUrl: "https://api.example.com/v1",
      llmReflectApiKey: "test-key",
    } as Parameters<typeof initGroupReceptionShadowJudge>[0]);

    expect(isGroupReceptionShadowJudgeInitialized()).toBe(true);
  });

  it("warm reply writes one evidence row and positive graph reception", () => {
    const graph = addGraphChannel();
    const aliceLogId = insertAliceMessage({ msgId: 7001 });
    const replyLogId = insertMessage({
      msgId: 7002,
      replyToMsgId: 7001,
      text: "这个有意思",
      createdAtMs: NOW_MS - 50_000,
    });

    updateGroupReception({ graph, nowMs: NOW_MS });

    const row = readOnlyEvidenceRow();
    expect(row).toMatchObject({
      channelId: GROUP_ID,
      aliceMessageLogId: aliceLogId,
      aliceMsgId: 7001,
      outcome: "warm_reply",
      signal: 0.3,
      afterMessageCount: 1,
      replyToAliceCount: 1,
      hostileMatchCount: 0,
      previousReception: 0,
    });
    expect(JSON.parse(row.sourceMessageLogIdsJson)).toEqual([replyLogId]);
    expect(row.nextReception).toBeGreaterThan(0);
    expect(readSocialReception(graph, GROUP_ID)).toBeGreaterThan(0);
    expect(readEmotionEpisodes(graph)).toHaveLength(0);
  });

  it("repeated tick does not duplicate row or move graph again", () => {
    const graph = addGraphChannel();
    insertAliceMessage({ msgId: 7101 });
    insertMessage({
      msgId: 7102,
      replyToMsgId: 7101,
      text: "我回你",
      createdAtMs: NOW_MS - 50_000,
    });

    updateGroupReception({ graph, nowMs: NOW_MS });
    const firstReception = readSocialReception(graph, GROUP_ID);

    updateGroupReception({ graph, nowMs: NOW_MS });

    expect(readEvidenceRows()).toHaveLength(1);
    expect(readSocialReception(graph, GROUP_ID)).toBe(firstReception);
  });

  it("cold ignored in group after 5 later messages writes negative evidence", () => {
    const graph = addGraphChannel();
    insertAliceMessage({ msgId: 7201 });
    insertLaterMessages(5);

    updateGroupReception({ graph, nowMs: NOW_MS });

    const row = readOnlyEvidenceRow();
    expect(row).toMatchObject({
      outcome: "cold_ignored",
      signal: -0.2,
      afterMessageCount: 5,
      replyToAliceCount: 0,
      hostileMatchCount: 0,
      previousReception: 0,
    });
    expect(row.nextReception).toBeLessThan(0);
    expect(readSocialReception(graph, GROUP_ID)).toBeLessThan(0);
  });

  it("hostile writes stronger negative evidence", () => {
    const graph = addGraphChannel();
    insertAliceMessage({ msgId: 7301 });
    insertMessage({
      msgId: 7302,
      text: "谁问你了，闭嘴",
      createdAtMs: NOW_MS - 50_000,
    });

    updateGroupReception({ graph, nowMs: NOW_MS });

    const row = readOnlyEvidenceRow();
    expect(row).toMatchObject({
      outcome: "hostile",
      signal: -0.5,
      afterMessageCount: 1,
      replyToAliceCount: 0,
      hostileMatchCount: 1,
      previousReception: 0,
    });
    expect(row.signal).toBeLessThan(-0.2);
    expect(readSocialReception(graph, GROUP_ID)).toBeLessThan(-0.1);

    const episodes = readEmotionEpisodes(graph);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({
      kind: "hurt",
      targetId: GROUP_ID,
      cause: { type: "feedback", evidenceId: String(row.id) },
    });
    const control = deriveEmotionControlPatch(readEmotionState(graph, NOW_MS));
    expect(control.voiceBias.caution).toBeGreaterThan(0);
    expect(control.styleBudget.avoidSelfProof).toBe(true);
  });

  it("language correction reply is negative, not warm", () => {
    const graph = addGraphChannel();
    insertAliceMessage({ msgId: 7303 });
    insertMessage({
      msgId: 7304,
      replyToMsgId: 7303,
      text: "На русском плиз",
      createdAtMs: NOW_MS - 50_000,
    });

    updateGroupReception({ graph, nowMs: NOW_MS });

    const row = readOnlyEvidenceRow();
    expect(row).toMatchObject({
      outcome: "hostile",
      signal: -0.5,
      afterMessageCount: 1,
      replyToAliceCount: 1,
      hostileMatchCount: 1,
      previousReception: 0,
    });
    expect(readSocialReception(graph, GROUP_ID)).toBeLessThan(0);
    expect(readEmotionState(graph, NOW_MS).dominant?.kind).toBe("hurt");
  });

  it("unknown timeout writes evidence but does not move graph reception", () => {
    const graph = addGraphChannel();
    graph.setDynamic(GROUP_ID, "social_reception", 0.42);
    graph.setDynamic(GROUP_ID, "social_reception_ms", NOW_MS - 60_000);
    insertAliceMessage({ msgId: 7401, createdAtMs: NOW_MS - 10 * 60_000 - 1000 });
    insertLaterMessages(2, { startAtMs: NOW_MS - 9 * 60_000 });

    updateGroupReception({ graph, nowMs: NOW_MS });

    const row = readOnlyEvidenceRow();
    expect(row).toMatchObject({
      outcome: "unknown_timeout",
      signal: null,
      afterMessageCount: 2,
      replyToAliceCount: 0,
      hostileMatchCount: 0,
      previousReception: null,
      nextReception: null,
    });
    expect(readSocialReception(graph, GROUP_ID)).toBe(0.42);
  });

  it("private channel is excluded", () => {
    const graph = addGraphChannel(PRIVATE_ID, "private");
    insertAliceMessage({ chatId: PRIVATE_ID, msgId: 7501 });
    insertMessage({
      chatId: PRIVATE_ID,
      msgId: 7502,
      text: "闭嘴",
      createdAtMs: NOW_MS - 50_000,
    });

    updateGroupReception({ graph, nowMs: NOW_MS });

    expect(readEvidenceRows()).toHaveLength(0);
    expect(readSocialReception(graph, PRIVATE_ID)).toBe(0);
  });

  it("positive channel id is excluded even when graph chat_type defaults to group", () => {
    const graph = new WorldModel();
    graph.addChannel(PRIVATE_ID);
    insertAliceMessage({ chatId: PRIVATE_ID, msgId: 7601 });
    insertMessage({
      chatId: PRIVATE_ID,
      msgId: 7602,
      text: "谁问你了",
      createdAtMs: NOW_MS - 50_000,
    });

    updateGroupReception({ graph, nowMs: NOW_MS });

    expect(readEvidenceRows()).toHaveLength(0);
    expect(readSocialReception(graph, PRIVATE_ID)).toBe(0);
  });
});
