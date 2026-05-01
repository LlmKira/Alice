/**
 * Engine API — Telegram syscall routes.
 *
 * POST /telegram/send    → { msgId: number | null }
 * POST /telegram/read    → { ok: true }
 * POST /telegram/react   → { ok: true }
 * POST /telegram/sticker → { msgId: number | null }
 * POST /telegram/join    → { ok: true }
 * POST /telegram/leave   → { ok: true }
 * POST /telegram/forward → { forwardedMsgId: number | null }
 *
 * LLM-facing surface should stay IRC-like (`irc`); these are syscalls.
 */

import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ALLOWED_REACTIONS, normalizeReactionEmoji } from "../../telegram/actions/shared.js";
import { isTelegramActionError } from "../../telegram/errors.js";
import type { EngineApiDeps } from "../server.js";

// ── 去重缓存：防止 LLM 重试轮重发已成功的消息 ──

const DEDUPE_TTL_MS = 30_000;
const DEDUPE_MAX_SIZE = 1000;

interface DedupeEntry {
  msgId: number;
  ts: number;
}

const recentSends = new Map<string, DedupeEntry>();

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** 清理阈值 = 2×TTL，留 grace period 避免竞态删除刚过期条目 */
const DEDUPE_CLEANUP_MS = DEDUPE_TTL_MS * 2;

function dedupeCleanup(): void {
  const now = Date.now();
  for (const [key, entry] of recentSends) {
    if (now - entry.ts > DEDUPE_CLEANUP_MS) recentSends.delete(key);
  }
}

setInterval(dedupeCleanup, DEDUPE_CLEANUP_MS).unref();

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw.length > 0 ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function badRequest(res: ServerResponse, error: string): void {
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error }));
}

function notConfigured(res: ServerResponse, action: string): void {
  res.writeHead(501, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: `telegram ${action} not configured` }));
}

function typedInputError(
  res: ServerResponse,
  code: string,
  error: string,
  details?: Record<string, unknown>,
): void {
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ code, error, ...details }));
}

function allowedReactionList(): string[] {
  return Array.from(ALLOWED_REACTIONS);
}

function serverError(res: ServerResponse, fallback: string, err: unknown): void {
  if (isTelegramActionError(err)) {
    typedInputError(res, err.code, err.message, err.details);
    return;
  }

  // ADR-237: 记录完整错误堆栈便于排查
  console.error(`[Engine API] ${fallback}:`, err instanceof Error ? err.stack : err);
  res.writeHead(500, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: err instanceof Error ? err.message : fallback }));
}

export async function handleTelegramForward(
  action: string,
  req: IncomingMessage,
  res: ServerResponse,
  deps: EngineApiDeps,
): Promise<void> {
  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    badRequest(res, "invalid JSON body");
    return;
  }

  if (action === "send") {
    if (!deps.telegramSend) {
      notConfigured(res, "send");
      return;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      badRequest(res, 'body must be { "chatId": number, "text": string, "replyTo"?: number }');
      return;
    }
    const { chatId, text, replyTo } = body as {
      chatId?: number;
      text?: string;
      replyTo?: number;
    };
    if (typeof chatId !== "number" || typeof text !== "string" || text.length === 0) {
      badRequest(res, 'body must be { "chatId": number, "text": string, "replyTo"?: number }');
      return;
    }
    // 去重：30 秒内相同 chatId + text → 返回缓存结果
    const dedupeKey = `${chatId}:${hashText(text)}`;
    const cached = recentSends.get(dedupeKey);
    if (cached && Date.now() - cached.ts < DEDUPE_TTL_MS) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ msgId: cached.msgId, deduplicated: true }));
      return;
    }
    // LRU 溢出保护
    if (recentSends.size >= DEDUPE_MAX_SIZE) dedupeCleanup();
    try {
      const result = await deps.telegramSend({ chatId, text, replyTo });
      if (result.msgId != null) {
        recentSends.set(dedupeKey, { msgId: result.msgId, ts: Date.now() });
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      serverError(res, "send failed", err);
    }
    return;
  }

  if (action === "read") {
    if (!deps.telegramMarkRead) {
      notConfigured(res, "read");
      return;
    }
    if (
      body === null ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof (body as { chatId?: unknown }).chatId !== "number"
    ) {
      badRequest(res, 'body must be { "chatId": number }');
      return;
    }
    try {
      const result = await deps.telegramMarkRead((body as { chatId: number }).chatId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      serverError(res, "read failed", err);
    }
    return;
  }

  if (action === "react") {
    if (!deps.telegramReact) {
      notConfigured(res, "react");
      return;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      badRequest(res, 'body must be { "chatId": number, "msgId": number, "emoji": string }');
      return;
    }
    const { chatId, msgId, emoji } = body as {
      chatId?: number;
      msgId?: number;
      emoji?: string;
    };
    if (typeof chatId !== "number" || typeof msgId !== "number" || typeof emoji !== "string") {
      badRequest(res, 'body must be { "chatId": number, "msgId": number, "emoji": string }');
      return;
    }
    const normalizedEmoji = normalizeReactionEmoji(emoji);
    if (!ALLOWED_REACTIONS.has(normalizedEmoji)) {
      typedInputError(res, "invalid_reaction", "invalid reaction: use a Telegram-supported emoji", {
        allowed: allowedReactionList(),
      });
      return;
    }
    try {
      const result = await deps.telegramReact({ chatId, msgId, emoji: normalizedEmoji });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      serverError(res, "react failed", err);
    }
    return;
  }

  if (action === "join") {
    if (!deps.telegramJoin) {
      notConfigured(res, "join");
      return;
    }
    if (
      body === null ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof (body as { chatIdOrLink?: unknown }).chatIdOrLink !== "string"
    ) {
      badRequest(res, 'body must be { "chatIdOrLink": string }');
      return;
    }
    try {
      const result = await deps.telegramJoin((body as { chatIdOrLink: string }).chatIdOrLink);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      serverError(res, "join failed", err);
    }
    return;
  }

  if (action === "leave") {
    if (!deps.telegramLeave) {
      notConfigured(res, "leave");
      return;
    }
    if (
      body === null ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof (body as { chatId?: unknown }).chatId !== "number"
    ) {
      badRequest(res, 'body must be { "chatId": number }');
      return;
    }
    try {
      const result = await deps.telegramLeave((body as { chatId: number }).chatId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      serverError(res, "leave failed", err);
    }
    return;
  }

  if (action === "sticker") {
    if (!deps.telegramSticker) {
      notConfigured(res, "sticker");
      return;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      badRequest(res, 'body must be { "chatId": number, "sticker": string }');
      return;
    }
    const { chatId, sticker } = body as {
      chatId?: number;
      sticker?: string;
    };
    if (typeof chatId !== "number" || typeof sticker !== "string" || sticker.length === 0) {
      badRequest(res, 'body must be { "chatId": number, "sticker": string }');
      return;
    }
    try {
      const result = await deps.telegramSticker({ chatId, sticker });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      serverError(res, "sticker failed", err);
    }
    return;
  }

  if (action === "download") {
    if (!deps.telegramDownload) {
      notConfigured(res, "download");
      return;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      badRequest(res, 'body must be { "chatId": number, "msgId": number, "output": string }');
      return;
    }
    const { chatId, msgId, output } = body as {
      chatId?: number;
      msgId?: number;
      output?: string;
    };
    if (
      typeof chatId !== "number" ||
      typeof msgId !== "number" ||
      typeof output !== "string" ||
      output.length === 0
    ) {
      badRequest(res, 'body must be { "chatId": number, "msgId": number, "output": string }');
      return;
    }
    try {
      const result = await deps.telegramDownload({ chatId, msgId, output });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      serverError(res, "download failed", err);
    }
    return;
  }

  if (action === "upload") {
    if (!deps.telegramUpload) {
      notConfigured(res, "upload");
      return;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      badRequest(
        res,
        'body must be { "chatId": number, "path": string, "caption"?: string, "replyTo"?: number }',
      );
      return;
    }
    const { chatId, path, caption, replyTo } = body as {
      chatId?: number;
      path?: string;
      caption?: string;
      replyTo?: number;
    };
    if (typeof chatId !== "number" || typeof path !== "string" || path.length === 0) {
      badRequest(res, 'body must be { "chatId": number, "path": string }');
      return;
    }
    try {
      const result = await deps.telegramUpload({ chatId, path, caption, replyTo });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      serverError(res, "upload failed", err);
    }
    return;
  }

  if (action === "voice") {
    if (!deps.telegramVoice) {
      notConfigured(res, "voice");
      return;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      badRequest(
        res,
        'body must be { "chatId": number, "text": string, "emotion"?: string, "replyTo"?: number }',
      );
      return;
    }
    const { chatId, text, emotion, replyTo } = body as {
      chatId?: number;
      text?: string;
      emotion?: string;
      replyTo?: number;
    };
    if (typeof chatId !== "number" || typeof text !== "string" || text.length === 0) {
      badRequest(res, 'body must be { "chatId": number, "text": string }');
      return;
    }
    try {
      const result = await deps.telegramVoice({ chatId, text, emotion, replyTo });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      serverError(res, "voice failed", err);
    }
    return;
  }

  if (action === "forward") {
    if (!deps.telegramForward) {
      notConfigured(res, "forward");
      return;
    }
    // ADR-206 W8: 跨聊天转发（fromChatId → toChatId）+ 可选评论
    const b = body as {
      fromChatId?: unknown;
      msgId?: unknown;
      toChatId?: unknown;
      comment?: unknown;
    } | null;
    if (
      b === null ||
      typeof b !== "object" ||
      Array.isArray(b) ||
      typeof b.fromChatId !== "number" ||
      typeof b.msgId !== "number" ||
      typeof b.toChatId !== "number"
    ) {
      badRequest(
        res,
        'body must be { "fromChatId": number, "msgId": number, "toChatId": number, "comment"?: string }',
      );
      return;
    }
    try {
      const result = await deps.telegramForward({
        fromChatId: b.fromChatId,
        msgId: b.msgId,
        toChatId: b.toChatId,
        comment: typeof b.comment === "string" ? b.comment : undefined,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      serverError(res, "forward failed", err);
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
}
