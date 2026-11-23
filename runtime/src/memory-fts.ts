/**
 * 本地聊天原文全文检索（PLAN 第 58 件，SQLite FTS5）：
 * 从 Journal 增量索引 message.received 与 message.sent，毫秒级返回更早的原话与出处。
 * 受众规则在 SQL 层先过滤：只返回当前会话自身的历史或公开群聊的历史，绝不跨会话泄漏其他私聊。
 */
import type Database from "better-sqlite3";
import { platformPrefix } from "./mind/platform.js";

export interface ArchivedLine {
  at: number;
  scope: string;
  chatType: "private" | "group";
  who: string;
  text: string;
}

export interface ArchiveSearchOptions {
  /** 当前会话 scope（用于受众隔离：其他私聊绝不返回）。 */
  scope: string;
  query: string | null;
  subject: string | null;
  limit?: number;
}

const DEFAULT_LIMIT = 8;
const MAX_TEXT_CHARS = 180;

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_fts_meta (
      k TEXT PRIMARY KEY,
      v INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chat_fts USING fts5(
      text,
      sender,
      scope UNINDEXED,
      chat_type UNINDEXED,
      at UNINDEXED,
      event_id UNINDEXED,
      tokenize='trigram'
    );
  `);
}

interface JournalRow {
  id: number;
  type: string;
  scope: string;
  payload: string;
  ts: number | null;
}

interface FtsEntry {
  text: string;
  sender: string;
  scope: string;
  chatType: "private" | "group";
  at: number;
  eventId: number;
}

function extractFtsEntry(
  r: JournalRow,
  scopeType: Map<string, "private" | "group">,
): FtsEntry | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(r.payload) as Record<string, unknown>;
  } catch {
    return null;
  }
  const rawText = typeof parsed.text === "string" ? parsed.text.trim() : "";
  if (!rawText) return null;

  let chatType: "private" | "group";
  if (parsed.chatType === "group" || parsed.chatType === "private") {
    chatType = parsed.chatType;
    scopeType.set(r.scope, chatType);
  } else {
    const inferred =
      r.scope.startsWith("telegram:-") || r.scope.startsWith("qq:group:") ? "group" : "private";
    chatType = scopeType.get(r.scope) ?? inferred;
  }

  const rawSender = typeof parsed.senderName === "string" ? parsed.senderName.trim() : "";
  const sender = r.type === "message.sent" ? "Alice" : rawSender || "unknown";
  const at = typeof parsed.at === "number" ? parsed.at : (r.ts ?? 0);
  return { text: rawText.slice(0, 500), sender, scope: r.scope, chatType, at, eventId: r.id };
}

/** 将 journal_events 中尚未索引的聊天消息增量同步到 chat_fts。 */
export function syncChatFts(db: Database.Database): number {
  ensureSchema(db);
  const row = db.prepare("SELECT v FROM chat_fts_meta WHERE k = 'last_event_id'").get() as
    | { v: number }
    | undefined;
  const lastId = row?.v ?? 0;

  const pending = db
    .prepare(
      `SELECT id, type, scope, payload, ts FROM journal_events
       WHERE id > ? AND type IN ('message.received', 'message.sent')
       ORDER BY id ASC`,
    )
    .all(lastId) as JournalRow[];

  if (pending.length === 0) return 0;

  const insert = db.prepare(
    `INSERT INTO chat_fts (text, sender, scope, chat_type, at, event_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const upsertMeta = db.prepare(
    `INSERT INTO chat_fts_meta (k, v) VALUES ('last_event_id', ?)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
  );

  const scopeType = new Map<string, "private" | "group">();
  let indexed = 0;
  let maxId = lastId;

  const tx = db.transaction(() => {
    for (const r of pending) {
      maxId = r.id;
      const entry = extractFtsEntry(r, scopeType);
      if (!entry) continue;
      insert.run(entry.text, entry.sender, entry.scope, entry.chatType, entry.at, entry.eventId);
      indexed++;
    }
    upsertMeta.run(maxId);
  });

  tx();
  return indexed;
}

function escapeFtsPhrase(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

function formatRow(r: {
  at: number;
  scope: string;
  chat_type: string;
  sender: string;
  text: string;
}): ArchivedLine {
  return {
    at: Number(r.at),
    scope: r.scope,
    chatType: r.chat_type === "group" ? "group" : "private",
    who: r.sender,
    text: r.text.length > MAX_TEXT_CHARS ? `${r.text.slice(0, MAX_TEXT_CHARS)}…` : r.text,
  };
}

/**
 * 毫秒级全文检索更早的聊天原文。
 * 受众与平台硬过滤：只查当前会话自身（scope = opts.scope）或同平台公开群聊，
 * 绝不返回其他私聊的原话，也不跨 App 翻出另一个平台的群聊记录。
 */
export function searchChatArchive(
  db: Database.Database,
  opts: ArchiveSearchOptions,
): ArchivedLine[] {
  syncChatFts(db);
  const limit = Math.max(1, Math.min(20, opts.limit ?? DEFAULT_LIMIT));
  const q = opts.query?.trim() ?? "";
  const subj = opts.subject?.trim() ?? "";
  if (!q && !subj) return [];

  const prefix = platformPrefix(opts.scope);
  const audienceSql = prefix
    ? "(scope = ? OR (chat_type = 'group' AND scope LIKE ?))"
    : "(scope = ? OR chat_type = 'group')";
  const audienceParams: unknown[] = prefix ? [opts.scope, `${prefix}%`] : [opts.scope];

  interface RawHit {
    at: number;
    scope: string;
    chat_type: string;
    sender: string;
    text: string;
  }

  // trigram 要求查询词长度 ≥ 3；较短的词（如 1–2 个汉字）退回到受众过滤后的 LIKE 查询
  const useFts = q.length >= 3 || (!q && subj.length >= 3);
  if (useFts) {
    const matchExpr = q.length >= 3 ? escapeFtsPhrase(q) : `sender : ${escapeFtsPhrase(subj)}`;
    const params: unknown[] = [matchExpr, ...audienceParams];
    let subjectSql = "";
    if (subj && q.length >= 3) {
      subjectSql = "AND (sender LIKE ? OR text LIKE ?)";
      params.push(`%${subj}%`, `%${subj}%`);
    }
    params.push(limit);
    const rows = db
      .prepare(
        `SELECT at, scope, chat_type, sender, text FROM chat_fts
         WHERE chat_fts MATCH ?
           AND ${audienceSql}
           ${subjectSql}
         ORDER BY at DESC
         LIMIT ?`,
      )
      .all(...params) as RawHit[];
    return rows.map(formatRow);
  }

  const clauses: string[] = [audienceSql];
  const params: unknown[] = [...audienceParams];
  if (q) {
    clauses.push("text LIKE ?");
    params.push(`%${q}%`);
  }
  if (subj) {
    clauses.push("(sender LIKE ? OR text LIKE ?)");
    params.push(`%${subj}%`, `%${subj}%`);
  }
  params.push(limit);
  const rows = db
    .prepare(
      `SELECT at, scope, chat_type, sender, text FROM chat_fts
       WHERE ${clauses.join(" AND ")}
       ORDER BY at DESC
       LIMIT ?`,
    )
    .all(...params) as RawHit[];
  return rows.map(formatRow);
}
