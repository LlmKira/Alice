/**
 * Engine API — 图路由。
 *
 * GET  /graph/:entity/:attr → { "value": ... }
 * POST /graph/:entity/:attr → body { "value": ... }
 *
 * entity 格式：self, contact:<platform>:xxx, channel:<platform>:xxx
 *
 * @see docs/adr/202-engine-api.md
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EngineApiDeps } from "../server.js";

/** entity 格式白名单：self | contact:<platform>:id | channel:<platform>:id。 */
const ENTITY_PATTERN = /^(?:self|(?:contact|channel):[a-z][a-z0-9_-]*:.+)$/u;

/** 将 URL 中的 entity 段解析为 graph nodeId。格式不合法返回 null。 */
function resolveEntityId(entity: string): string | null {
  if (!ENTITY_PATTERN.test(entity)) return null;
  return entity;
}

/** Body 大小上限（1 MB）——防止恶意/异常客户端 OOM。 */
const MAX_BODY = 1024 * 1024;

/** 从 request body 收集 JSON。超过 MAX_BODY 时 reject。 */
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/**
 * 处理 GET /graph/:entity/:attr。
 */
export function handleGraphGet(
  entity: string,
  attr: string,
  _req: IncomingMessage,
  res: ServerResponse,
  deps: EngineApiDeps,
): void {
  const nodeId = resolveEntityId(entity);
  if (!nodeId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid entity format" }));
    return;
  }
  if (!deps.G.has(nodeId)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "node not found" }));
    return;
  }
  const value = deps.G.getDynamic(nodeId, attr);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ value }));
}

/**
 * 处理 POST /graph/:entity/:attr。
 *
 * 写入限制：attr 必须以 `last_` 开头（编译器生成的 resultAttrKey 都以此为前缀）。
 * 防止 Skill 覆盖内部图属性（display_name、trust_tier 等）。
 */
export async function handleGraphSet(
  entity: string,
  attr: string,
  req: IncomingMessage,
  res: ServerResponse,
  deps: EngineApiDeps,
): Promise<void> {
  const nodeId = resolveEntityId(entity);
  if (!nodeId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid entity format" }));
    return;
  }
  // 写入白名单：只允许 last_* 前缀（编译器生成的 resultAttrKey）
  if (!attr.startsWith("last_")) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "write restricted to last_* attributes" }));
    return;
  }
  if (!deps.G.has(nodeId)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "node not found" }));
    return;
  }

  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }

  if (body === null || typeof body !== "object" || !("value" in body)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: 'body must be { "value": ... }' }));
    return;
  }

  deps.G.setDynamic(nodeId, attr, (body as { value: unknown }).value);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}
