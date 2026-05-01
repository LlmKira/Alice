/**
 * ADR-260: 群聊照片相册。
 *
 * 相册资产是投影；发送尝试是事实。源消息被删除时，资产状态会被标记为 missing，
 * 后续搜索默认排除，避免 Alice 反复尝试不可转发的照片。
 *
 * @see docs/adr/260-group-photo-album-affordance/README.md
 */
import { getSqlite } from "./connection.js";

export type AlbumSourceStatus = "available" | "missing" | "inaccessible";
export type AlbumSendMode = "no_author_forward" | "download_upload";

export interface AlbumPhotoAsset {
  id: number;
  assetId: string;
  fileUniqueId: string;
  sourceChatId: number;
  sourceMsgId: number;
  mediaType: "photo";
  captionText: string | null;
  description: string | null;
  wdTagsJson: string | null;
  ocrText: string | null;
  visibilityScope: "group";
  sourceStatus: AlbumSourceStatus;
  lastFailureCode: string | null;
  observedAtMs: number;
  lastIndexedAtMs: number;
  sourceMissingAtMs: number | null;
}

export interface AlbumSearchResult extends AlbumPhotoAsset {
  score: number;
  snippet: string | null;
}

interface AlbumPhotoRow {
  id: number;
  asset_id: string;
  file_unique_id: string;
  source_chat_id: number;
  source_msg_id: number;
  media_type: string;
  caption_text: string | null;
  description: string | null;
  wd_tags_json: string | null;
  ocr_text: string | null;
  visibility_scope: string;
  source_status: string;
  last_failure_code: string | null;
  observed_at_ms: number;
  last_indexed_at_ms: number;
  source_missing_at_ms: number | null;
}

function toAsset(row: AlbumPhotoRow): AlbumPhotoAsset {
  return {
    id: row.id,
    assetId: row.asset_id,
    fileUniqueId: row.file_unique_id,
    sourceChatId: row.source_chat_id,
    sourceMsgId: row.source_msg_id,
    mediaType: "photo",
    captionText: row.caption_text,
    description: row.description,
    wdTagsJson: row.wd_tags_json,
    ocrText: row.ocr_text,
    visibilityScope: "group",
    sourceStatus: row.source_status as AlbumSourceStatus,
    lastFailureCode: row.last_failure_code,
    observedAtMs: row.observed_at_ms,
    lastIndexedAtMs: row.last_indexed_at_ms,
    sourceMissingAtMs: row.source_missing_at_ms,
  };
}

function makeAssetId(fileUniqueId: string): string {
  return `photo:${fileUniqueId}`;
}

export interface RecordObservedGroupPhotoInput {
  fileUniqueId: string;
  sourceChatId: number;
  sourceMsgId: number;
  captionText?: string | null;
  description?: string | null;
  wdTagsJson?: string | null;
  ocrText?: string | null;
  observedAtMs?: number;
}

export function recordObservedGroupPhoto(input: RecordObservedGroupPhotoInput): AlbumPhotoAsset {
  const fileUniqueId = input.fileUniqueId.trim();
  if (!fileUniqueId) throw new Error("fileUniqueId is required");
  const nowMs = Date.now();
  const observedAtMs = input.observedAtMs ?? nowMs;
  const createdAtSec = Math.floor(nowMs / 1000);
  const assetId = makeAssetId(fileUniqueId);

  getSqlite()
    .prepare(`
      INSERT INTO album_photos (
        asset_id, file_unique_id, source_chat_id, source_msg_id, media_type,
        caption_text, description, wd_tags_json, ocr_text,
        visibility_scope, source_status, last_failure_code,
        observed_at_ms, last_indexed_at_ms, source_missing_at_ms, created_at
      )
      VALUES (?, ?, ?, ?, 'photo', ?, ?, ?, ?, 'group', 'available', NULL, ?, ?, NULL, ?)
      ON CONFLICT(file_unique_id) DO UPDATE SET
        source_chat_id = excluded.source_chat_id,
        source_msg_id = excluded.source_msg_id,
        caption_text = COALESCE(excluded.caption_text, album_photos.caption_text),
        description = COALESCE(excluded.description, album_photos.description),
        wd_tags_json = COALESCE(excluded.wd_tags_json, album_photos.wd_tags_json),
        ocr_text = COALESCE(excluded.ocr_text, album_photos.ocr_text),
        source_status = 'available',
        last_failure_code = NULL,
        observed_at_ms = excluded.observed_at_ms,
        last_indexed_at_ms = excluded.last_indexed_at_ms,
        source_missing_at_ms = NULL
    `)
    .run(
      assetId,
      fileUniqueId,
      input.sourceChatId,
      input.sourceMsgId,
      input.captionText ?? null,
      input.description ?? null,
      input.wdTagsJson ?? null,
      input.ocrText ?? null,
      observedAtMs,
      nowMs,
      createdAtSec,
    );

  const asset = getAlbumPhoto(assetId);
  if (!asset) throw new Error(`failed to read album asset ${assetId}`);
  return asset;
}

export function updateAlbumPhotoSemantics(
  fileUniqueId: string,
  fields: { description?: string | null; wdTagsJson?: string | null; ocrText?: string | null },
): void {
  const updates: string[] = [];
  const params: unknown[] = [];

  if (fields.description !== undefined) {
    updates.push("description = COALESCE(?, description)");
    params.push(fields.description);
  }
  if (fields.wdTagsJson !== undefined) {
    updates.push("wd_tags_json = COALESCE(?, wd_tags_json)");
    params.push(fields.wdTagsJson);
  }
  if (fields.ocrText !== undefined) {
    updates.push("ocr_text = COALESCE(?, ocr_text)");
    params.push(fields.ocrText);
  }
  if (updates.length === 0) return;

  updates.push("last_indexed_at_ms = ?");
  params.push(Date.now(), fileUniqueId);

  getSqlite()
    .prepare(`UPDATE album_photos SET ${updates.join(", ")} WHERE file_unique_id = ?`)
    .run(...params);
}

export function getAlbumPhoto(assetId: string): AlbumPhotoAsset | null {
  const row = getSqlite().prepare("SELECT * FROM album_photos WHERE asset_id = ?").get(assetId) as
    | AlbumPhotoRow
    | undefined;
  return row ? toAsset(row) : null;
}

function ftsQuery(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `"${part.replace(/"/g, '""')}"`)
    .join(" OR ");
}

export function searchAlbumPhotos(options: {
  query: string;
  limit?: number;
  includeUnavailable?: boolean;
}): AlbumSearchResult[] {
  const query = ftsQuery(options.query);
  if (!query) return [];
  const limit = Math.min(Math.max(options.limit ?? 5, 1), 20);
  const statusClause = options.includeUnavailable ? "" : "AND p.source_status = 'available'";
  const rows = getSqlite()
    .prepare(`
      SELECT p.*,
        bm25(album_photo_fts) AS score,
        snippet(album_photo_fts, 0, '»', '«', '…', 48) AS snippet
      FROM album_photo_fts fts
      JOIN album_photos p ON p.id = fts.rowid
      WHERE album_photo_fts MATCH ? ${statusClause}
      ORDER BY bm25(album_photo_fts)
      LIMIT ?
    `)
    .all(query, limit) as Array<AlbumPhotoRow & { score: number; snippet: string | null }>;

  return rows.map((row) => ({ ...toAsset(row), score: row.score, snippet: row.snippet }));
}

export function markAlbumPhotoSourceStatus(
  assetId: string,
  status: AlbumSourceStatus,
  failureCode: string,
): void {
  const missingAt = status === "missing" ? Date.now() : null;
  getSqlite()
    .prepare(`
      UPDATE album_photos
      SET source_status = ?,
          last_failure_code = ?,
          source_missing_at_ms = COALESCE(?, source_missing_at_ms),
          last_indexed_at_ms = ?
      WHERE asset_id = ?
    `)
    .run(status, failureCode, missingAt, Date.now(), assetId);
}

export function recordAlbumUsage(input: {
  assetId: string;
  targetChatId: number;
  sentMsgId?: number | null;
  sendMode: AlbumSendMode;
  failureCode?: string | null;
  actionLogId?: number | null;
  usedAtMs?: number;
}): void {
  const nowMs = Date.now();
  getSqlite()
    .prepare(`
      INSERT INTO album_usage (
        asset_id, target_chat_id, action_log_id, sent_msg_id, send_mode,
        failure_code, used_at_ms, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      input.assetId,
      input.targetChatId,
      input.actionLogId ?? null,
      input.sentMsgId ?? null,
      input.sendMode,
      input.failureCode ?? null,
      input.usedAtMs ?? nowMs,
      Math.floor(nowMs / 1000),
    );
}
