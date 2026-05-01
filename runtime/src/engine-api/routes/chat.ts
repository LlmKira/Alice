/**
 * Engine API — chat history routes.
 *
 * GET /chat/:chatId/tail?limit=N
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { type ChatTailResponse, toChatTailMessageDto } from "../../core/chat-tail-contract.js";
import { getRecentMessagesByChat } from "../../db/queries.js";
import { ensureChannelId } from "../../graph/constants.js";
import type { EngineApiDeps } from "../server.js";

function parseLimit(url: string | undefined): number {
  const raw = new URL(url ?? "/", "http://alice.local").searchParams.get("limit");
  const n = raw ? Number(raw) : 20;
  if (!Number.isFinite(n)) return 20;
  return Math.min(Math.max(Math.trunc(n), 1), 50);
}

export function handleChatTail(
  chatId: string,
  req: IncomingMessage,
  res: ServerResponse,
  _deps: EngineApiDeps,
): void {
  const graphId = ensureChannelId(chatId);
  if (!graphId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid chat id" }));
    return;
  }

  const limit = parseLimit(req.url);
  const rows = getRecentMessagesByChat(graphId, limit);
  const body: ChatTailResponse = { messages: rows.map(toChatTailMessageDto) };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
