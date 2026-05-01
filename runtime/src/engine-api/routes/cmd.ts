/**
 * Engine API — 统一指令/查询端点。
 *
 * POST /cmd/:name → 先查 query index，再查 instruction index。
 * CLI 只需 kebab→snake 后 POST 到 /cmd/，无需知道 query 还是 instruction。
 *
 * @see docs/adr/217-cli-unification.md
 */

import type { IncomingMessage, ServerResponse } from "node:http";
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

export async function handleCmd(
  name: string,
  req: IncomingMessage,
  res: ServerResponse,
  deps: EngineApiDeps,
): Promise<void> {
  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "body must be a JSON object" }));
    return;
  }

  const args = body as Record<string, unknown>;

  const kind = deps.resolveCommandKind?.(name);

  if (kind === "query" && deps.query) {
    try {
      const result = await deps.query(name, args);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: result ?? null }));
      return;
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : "query failed",
        }),
      );
      return;
    }
  }

  if (kind === "instruction" && deps.dispatchInstruction) {
    try {
      const result = await deps.dispatchInstruction(name, args);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: result ?? null }));
      return;
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : "command failed",
        }),
      );
      return;
    }
  }

  if (kind === undefined) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: "unknown_cmd", error: `unknown command: ${name}` }));
    return;
  }

  res.writeHead(501, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "dispatch not configured" }));
}
