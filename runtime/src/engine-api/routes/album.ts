/**
 * Engine API — ADR-260 group photo album routes.
 *
 * GET  /album/search?query=...&limit=5
 * POST /album/send
 *
 * @see docs/adr/260-group-photo-album-affordance/README.md
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { searchAlbumPhotos } from "../../db/album.js";
import { isTelegramActionError } from "../../telegram/errors.js";
import type { EngineApiDeps } from "../server.js";

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

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function badRequest(res: ServerResponse, error: string): void {
  json(res, 400, { error });
}

function serverError(res: ServerResponse, fallback: string, err: unknown): void {
  if (isTelegramActionError(err)) {
    json(res, 400, { code: err.code, error: err.message, ...err.details });
    return;
  }
  console.error(`[Engine API] ${fallback}:`, err instanceof Error ? err.stack : err);
  json(res, 500, { error: err instanceof Error ? err.message : fallback });
}

export async function handleAlbum(
  action: string,
  req: IncomingMessage,
  res: ServerResponse,
  deps: EngineApiDeps,
): Promise<void> {
  if (action === "search" && req.method === "GET") {
    const url = new URL(req.url ?? "/", "http://localhost");
    const query = url.searchParams.get("query")?.trim() ?? "";
    const limitRaw = url.searchParams.get("limit");
    const includeUnavailable = url.searchParams.get("includeUnavailable") === "true";
    const limit = limitRaw ? Number(limitRaw) : undefined;
    if (!query) {
      badRequest(res, "query is required");
      return;
    }
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
      badRequest(res, "limit must be a positive integer");
      return;
    }
    const results = searchAlbumPhotos({ query, limit, includeUnavailable });
    json(res, 200, { results });
    return;
  }

  if (action === "send" && req.method === "POST") {
    if (!deps.telegramAlbumSend) {
      json(res, 501, { error: "telegram album send not configured" });
      return;
    }
    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      badRequest(res, "invalid JSON body");
      return;
    }
    const b = body as {
      assetId?: unknown;
      targetChatId?: unknown;
      caption?: unknown;
      replyTo?: unknown;
    } | null;
    if (
      b === null ||
      typeof b !== "object" ||
      Array.isArray(b) ||
      typeof b.assetId !== "string" ||
      typeof b.targetChatId !== "number"
    ) {
      badRequest(
        res,
        'body must be { "assetId": string, "targetChatId": number, "caption"?: string, "replyTo"?: number }',
      );
      return;
    }
    try {
      const result = await deps.telegramAlbumSend({
        assetId: b.assetId,
        targetChatId: b.targetChatId,
        caption: typeof b.caption === "string" ? b.caption : undefined,
        replyTo: typeof b.replyTo === "number" ? b.replyTo : undefined,
      });
      json(res, 200, result);
    } catch (err) {
      serverError(res, "album send failed", err);
    }
    return;
  }

  json(res, 404, { error: "not found" });
}
