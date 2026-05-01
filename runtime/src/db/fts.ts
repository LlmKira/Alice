/**
 * FTS5 全文检索查询 + 启动时索引补全。
 *
 * **写入同步由 SQLite 触发器自动完成**（migration 0017_fts5_triggers.sql）——
 * 源表 INSERT/UPDATE/DELETE 自动同步 FTS 索引，应用层无需手动调用任何写入函数。
 *
 * 本模块只负责：
 * 1. 查询：searchMessagesFts / searchDiaryFts / searchThreadsFts
 * 2. 启动补全：ftsEnsurePopulated（处理触发器部署前的历史数据）
 *
 * @see docs/adr/145-local-fulltext-search.md
 * @see runtime/drizzle/0017_fts5_triggers.sql
 */
import { getSqlite } from "./connection.js";
import type { DbMessageRecord } from "./queries.js";

// ── FTS5 查询 ──────────────────────────────────────────────────────────────

/** FTS5 搜索的 raw row 形状（与 better-sqlite3 的 .all() 返回对齐）。 */
interface FtsSearchRow {
  id: number;
  platform: string;
  msg_id: number | null;
  native_chat_id: string | null;
  native_msg_id: string | null;
  stable_message_id: string | null;
  tick: number;
  chat_id: string;
  sender_id: string | null;
  sender_name: string | null;
  text: string | null;
  media_type: string | null;
  is_outgoing: number;
  reply_to_msg_id: number | null;
  /** Drizzle mode:"timestamp" 存储为秒级 Unix 时间戳。 */
  created_at: number;
  /** FTS5 snippet() 辅助函数返回的上下文片段（仅查询时存在）。 */
  snippet: string | null;
}

/** FTS 搜索返回类型——在 DbMessageRecord 基础上增加 snippet。 */
export type FtsMessageResult = DbMessageRecord & { chatId: string; snippet: string | null };

/** raw row → FtsMessageResult 映射。 */
function mapRow(r: FtsSearchRow): FtsMessageResult {
  return {
    platform: r.platform,
    msgId: r.msg_id ?? null,
    nativeChatId: r.native_chat_id,
    nativeMsgId: r.native_msg_id,
    stableMessageId: r.stable_message_id,
    tick: r.tick,
    chatId: r.chat_id,
    senderId: r.sender_id,
    senderName: r.sender_name,
    text: r.text,
    mediaType: r.media_type,
    isOutgoing: !!r.is_outgoing,
    replyToMsgId: r.reply_to_msg_id,
    // created_at 是秒级时间戳，Date 构造器需要毫秒
    createdAt: new Date(r.created_at * 1000),
    snippet: r.snippet,
  };
}

/** SELECT 列投影——所有查询共用。 */
const COLUMNS = `m.id, m.platform, m.msg_id, m.native_chat_id, m.native_msg_id, m.stable_message_id,
  m.tick, m.chat_id, m.sender_id, m.sender_name,
  m.text, m.media_type, m.is_outgoing, m.reply_to_msg_id, m.created_at`;

/** 搜索选项。 */
export interface FtsSearchOptions {
  /** 限定聊天 ID（省略则跨所有聊天搜索）。 */
  chatId?: string;
  /** 限定发送者 ID（精确匹配 sender_id 列）。 */
  senderId?: string;
  /** 只返回此日期之后的消息（秒级 Unix 时间戳）。 */
  afterTs?: number;
  /** 只返回此日期之前的消息（秒级 Unix 时间戳）。 */
  beforeTs?: number;
  /** 最大返回条数（默认 20，上限 20）。 */
  limit?: number;
}

/**
 * FTS5 全文搜索 messageLog（BM25 排序）。
 *
 * trigram tokenizer 天然支持 CJK——无需分词器，任何 3+ 字符的子串均可命中。
 * expression 直接传给 FTS5 MATCH——支持完整的 FTS5 查询语法：
 *   - 隐式 AND：`天气 旅行`（空格分隔 = 两个都要匹配）
 *   - OR：`天气 OR 下雨`
 *   - NOT：`天气 NOT 下雨`
 *   - 短语：`"hello world"`
 *   - 前缀：`hel*`
 *
 * 查询 SQL 动态拼接（条件数有限，better-sqlite3 内部 prepare 缓存复用 statement）。
 *
 * @param expression FTS5 MATCH 表达式
 * @param opts 可选过滤条件
 */
export function searchMessagesFts(expression: string, opts?: FtsSearchOptions): FtsMessageResult[] {
  const matchExpr = expression.trim();
  if (!matchExpr) return [];

  const conditions = ["message_log_fts MATCH ?"];
  const params: unknown[] = [matchExpr];

  if (opts?.chatId) {
    conditions.push("m.chat_id = ?");
    params.push(opts.chatId);
  }
  if (opts?.senderId) {
    conditions.push("m.sender_id = ?");
    params.push(opts.senderId);
  }
  if (opts?.afterTs != null) {
    conditions.push("m.created_at >= ?");
    params.push(opts.afterTs);
  }
  if (opts?.beforeTs != null) {
    conditions.push("m.created_at <= ?");
    params.push(opts.beforeTs);
  }

  const limit = Math.min(opts?.limit ?? 20, 20);
  params.push(limit);

  // snippet(table, column_index, open, close, ellipsis, max_tokens)
  // column 0 = text（message_log_fts 只有一列）
  const sql = `SELECT ${COLUMNS},
  snippet(message_log_fts, 0, '»', '«', '…', 64) as snippet
FROM message_log_fts fts
JOIN message_log m ON m.id = fts.rowid
WHERE ${conditions.join(" AND ")}
ORDER BY bm25(message_log_fts) LIMIT ?`;

  const rows = getSqlite()
    .prepare(sql)
    .all(...params) as FtsSearchRow[];
  return rows.map(mapRow);
}

// ── Diary FTS5 查询 ────────────────────────────────────────────────────────

export interface FtsDiaryRecord {
  id: number;
  tick: number;
  content: string;
  about: string | null;
  createdAt: Date;
}

/**
 * FTS5 全文搜索 diary_entries（BM25 排序）。
 *
 * @param expression FTS5 MATCH 表达式
 * @param opts 可选过滤条件（about 实体、时间范围）
 */
export function searchDiaryFts(
  expression: string,
  opts?: { about?: string; afterTs?: number; beforeTs?: number; limit?: number },
): FtsDiaryRecord[] {
  const matchExpr = expression.trim();
  if (!matchExpr) return [];

  const conditions = ["diary_fts MATCH ?"];
  const params: unknown[] = [matchExpr];

  if (opts?.about) {
    conditions.push("d.about = ?");
    params.push(opts.about);
  }
  if (opts?.afterTs != null) {
    conditions.push("d.created_at >= ?");
    params.push(opts.afterTs);
  }
  if (opts?.beforeTs != null) {
    conditions.push("d.created_at <= ?");
    params.push(opts.beforeTs);
  }

  const limit = Math.min(opts?.limit ?? 20, 20);
  params.push(limit);

  const sql = `SELECT d.id, d.tick, d.content, d.about, d.created_at
FROM diary_fts fts
JOIN diary_entries d ON d.id = fts.rowid
WHERE ${conditions.join(" AND ")}
ORDER BY bm25(diary_fts) LIMIT ?`;

  const rows = getSqlite()
    .prepare(sql)
    .all(...params) as Array<{
    id: number;
    tick: number;
    content: string;
    about: string | null;
    created_at: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    tick: r.tick,
    content: r.content,
    about: r.about,
    createdAt: new Date(r.created_at * 1000),
  }));
}

// ── Threads FTS5 查询 ──────────────────────────────────────────────────────

export interface FtsThreadRecord {
  id: number;
  title: string;
  status: string;
  weight: string;
  tensionFrame: string | null;
  summary: string | null;
  involves: string | null;
  createdTick: number;
  lastBeatTick: number | null;
}

/**
 * FTS5 全文搜索 narrative_threads（BM25 排序）。
 *
 * @param expression FTS5 MATCH 表达式
 * @param opts 可选过滤条件（status 筛选）
 */
export function searchThreadsFts(
  expression: string,
  opts?: { status?: string; limit?: number },
): FtsThreadRecord[] {
  const matchExpr = expression.trim();
  if (!matchExpr) return [];

  const conditions = ["threads_fts MATCH ?"];
  const params: unknown[] = [matchExpr];

  if (opts?.status) {
    conditions.push("t.status = ?");
    params.push(opts.status);
  }

  const limit = Math.min(opts?.limit ?? 20, 20);
  params.push(limit);

  const sql = `SELECT t.id, t.title, t.status, t.weight, t.tension_frame, t.summary,
       t.involves, t.created_tick, t.last_beat_tick
FROM threads_fts fts
JOIN narrative_threads t ON t.id = fts.rowid
WHERE ${conditions.join(" AND ")}
ORDER BY bm25(threads_fts) LIMIT ?`;

  const rows = getSqlite()
    .prepare(sql)
    .all(...params) as Array<{
    id: number;
    title: string;
    status: string;
    weight: string;
    tension_frame: string | null;
    summary: string | null;
    involves: string | null;
    created_tick: number;
    last_beat_tick: number | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    weight: r.weight,
    tensionFrame: r.tension_frame,
    summary: r.summary,
    involves: r.involves,
    createdTick: r.created_tick,
    lastBeatTick: r.last_beat_tick,
  }));
}

// ── 启动时索引补全 ─────────────────────────────────────────────────────────

/**
 * 启动时条件 rebuild：FTS 索引为空但源表有数据时全量重建。
 *
 * 场景：
 * 1. migration 0017 部署后首次启动——历史数据先于触发器存在。
 * 2. FTS 索引意外损坏——rebuild 从源表恢复。
 *
 * 触发器部署后，后续 INSERT/UPDATE/DELETE 自动同步。
 * 此函数只处理"触发器还不存在时写入的"历史数据。
 *
 * **重要实现细节**：content= 外部内容 FTS 表的 `SELECT count(*) FROM fts`
 * 会代理到源表（返回源表行数），不反映 FTS 索引真实状态。
 * 必须查询 `_docsize` 影子表获取实际索引行数。
 * @see https://www.sqlite.org/fts5.html#the_docsize_table
 */
export function ftsEnsurePopulated(): void {
  const sqlite = getSqlite();

  const check = (ftsTable: string, sourceTable: string) => {
    // _docsize 影子表的行数 = FTS 索引中的实际文档数
    // 不能用 count(*) on fts 表本身——content= 模式下它代理到源表
    const indexedCount = (
      sqlite.prepare(`SELECT count(*) as n FROM ${ftsTable}_docsize`).get() as { n: number }
    ).n;
    if (indexedCount > 0) return; // 已有索引数据，跳过
    const srcCount = (
      sqlite.prepare(`SELECT count(*) as n FROM ${sourceTable}`).get() as { n: number }
    ).n;
    if (srcCount === 0) return; // 源表也为空，无需 rebuild
    sqlite.exec(`INSERT INTO ${ftsTable}(${ftsTable}) VALUES('rebuild')`);
  };

  check("message_log_fts", "message_log");
  check("diary_fts", "diary_entries");
  check("threads_fts", "narrative_threads");
}
