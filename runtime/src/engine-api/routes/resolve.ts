/**
 * Engine API - 名称解析路由。
 *
 * POST /resolve/name -> { ok: true, result: { nodeId, telegramId, type } }
 *
 * ADR-237: 让 LLM 能用名称（如 @林秀）指定目标，而非数字 ID。
 * 复用 display.ts 的 resolveDisplayName 函数。
 *
 * @see docs/adr/237-name-resolution.md
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { extractNumericId } from "../../graph/constants.js";
import { resolveDisplayName, safeDisplayName } from "../../graph/display.js";
import {
  isReservedBridgeProtocolName,
  parseTransportTargetId,
  type TransportTargetRef,
} from "../../platform/transport.js";
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

function json(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function normalizeNodeIdToTarget(nodeId: string): TransportTargetRef | null {
  return parseTransportTargetId(nodeId);
}

function platformOfNodeId(nodeId: string): string | null {
  return normalizeNodeIdToTarget(nodeId)?.platform ?? null;
}

function nodeLabel(deps: EngineApiDeps, nodeId: string): string {
  const label = safeDisplayName(deps.G, nodeId);
  return label.startsWith("(") ? nodeId : label;
}

function targetCandidate(deps: EngineApiDeps, nodeId: string) {
  const target = normalizeNodeIdToTarget(nodeId);
  if (!target) return null;
  return {
    target: target.stableId,
    nodeId,
    label: nodeLabel(deps, nodeId),
    platform: target.platform,
    kind: target.kind,
  };
}

function collectTargetCandidates(deps: EngineApiDeps, raw: string) {
  const [maybePlatform, ...nameParts] = raw.split("/");
  const hasPlatformPrefix = nameParts.length > 0 && maybePlatform.trim().length > 0;
  const requestedPlatform = hasPlatformPrefix ? maybePlatform.trim().toLowerCase() : null;
  const query = hasPlatformPrefix ? nameParts.join("/").trim() : raw.trim();
  const lower = query.toLowerCase();
  const candidates: Array<NonNullable<ReturnType<typeof targetCandidate>>> = [];

  for (const nodeId of deps.G.getEntitiesByType("channel")) {
    const platform = platformOfNodeId(nodeId);
    if (requestedPlatform && platform !== requestedPlatform) continue;
    const names = [
      String(deps.G.getDynamic(nodeId, "display_name") ?? ""),
      String(deps.G.getDynamic(nodeId, "title") ?? ""),
    ].filter(Boolean);
    if (names.some((name) => name.toLowerCase() === lower)) {
      const candidate = targetCandidate(deps, nodeId);
      if (candidate) candidates.push(candidate);
    }
  }

  for (const nodeId of deps.G.getEntitiesByType("contact")) {
    const platform = platformOfNodeId(nodeId);
    if (requestedPlatform && platform !== requestedPlatform) continue;
    const name = deps.G.getDynamic(nodeId, "display_name");
    if (name != null && String(name).toLowerCase() === lower) {
      const candidate = targetCandidate(deps, nodeId);
      if (candidate) candidates.push(candidate);
    }
  }

  return candidates;
}

function stableRefLikeReservedPlatform(raw: string): string | null {
  const parts = raw.split(":");
  if (
    parts.length >= 3 &&
    (parts[0] === "channel" || parts[0] === "contact" || parts[0] === "message") &&
    isReservedBridgeProtocolName(parts[1])
  ) {
    return parts[1];
  }
  return null;
}

function platformQualifierReserved(raw: string): string | null {
  const [maybePlatform, ...nameParts] = raw.split("/");
  if (nameParts.length === 0 || maybePlatform.trim().length === 0) return null;
  const platform = maybePlatform.trim();
  return isReservedBridgeProtocolName(platform) ? platform : null;
}

function bridgeProtocolError(platform: string): Record<string, unknown> {
  return {
    ok: false,
    code: "invalid_platform_ref",
    error: `${platform} is a bridge protocol, not an IM platform`,
    platform,
  };
}

/**
 * POST /resolve/name
 * Body: { name: string } 或 { name: string, type?: "contact" | "channel" }
 *
 * 返回:
 * - { ok: true, result: { nodeId, telegramId, type } } — 找到
 * - { ok: true, result: null } — 未找到
 */
export async function handleResolveName(
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

  const { name } = body as Record<string, unknown>;
  if (typeof name !== "string" || name.trim() === "") {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "name is required and must be a non-empty string" }));
    return;
  }

  // 去掉 @ 前缀（LLM 习惯写 @林秀）
  const cleanName = name.startsWith("@") ? name.slice(1) : name;

  // 调用 resolveDisplayName
  const nodeId = resolveDisplayName(deps.G, cleanName);

  if (nodeId === null) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        result: null,
        message: `no entity found with name "${cleanName}"`,
      }),
    );
    return;
  }

  // 提取 Telegram 数字 ID
  const telegramId = extractNumericId(nodeId) ?? null;

  // 判断类型
  const type = nodeId.startsWith("contact:")
    ? "contact"
    : nodeId.startsWith("channel:")
      ? "channel"
      : "unknown";

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      ok: true,
      result: {
        nodeId,
        telegramId,
        type,
        displayName: cleanName,
      },
    }),
  );
}

/**
 * POST /resolve/target
 * Body: { target: string }
 *
 * 返回 stable target ref；同名多候选返回 typed ambiguous_target。
 */
export async function handleResolveTarget(
  req: IncomingMessage,
  res: ServerResponse,
  deps: EngineApiDeps,
): Promise<void> {
  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    json(res, 400, { error: "invalid JSON body" });
    return;
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    json(res, 400, { error: "body must be a JSON object" });
    return;
  }

  const { target } = body as Record<string, unknown>;
  if (typeof target !== "string" || target.trim() === "") {
    json(res, 400, { error: "target is required and must be a non-empty string" });
    return;
  }

  const raw = target.trim();
  const stable = parseTransportTargetId(raw);
  if (stable) {
    json(res, 200, {
      ok: true,
      result: {
        target: stable.stableId,
        platform: stable.platform,
        kind: stable.kind,
        nativeId: stable.nativeId,
        legacy: stable.legacy,
      },
    });
    return;
  }
  const reservedStablePlatform = stableRefLikeReservedPlatform(raw);
  if (reservedStablePlatform) {
    json(res, 400, bridgeProtocolError(reservedStablePlatform));
    return;
  }
  const reservedQualifier = platformQualifierReserved(raw);
  if (reservedQualifier) {
    json(res, 400, bridgeProtocolError(reservedQualifier));
    return;
  }

  const candidates = collectTargetCandidates(deps, raw);
  if (candidates.length === 1) {
    json(res, 200, { ok: true, result: candidates[0] });
    return;
  }
  if (candidates.length > 1) {
    json(res, 409, {
      ok: false,
      code: "ambiguous_target",
      error: `ambiguous target: "${raw}"`,
      candidates,
    });
    return;
  }

  const nodeId = resolveDisplayName(deps.G, raw);
  const candidate = nodeId ? targetCandidate(deps, nodeId) : null;
  if (candidate) {
    json(res, 200, { ok: true, result: candidate });
    return;
  }

  json(res, 200, {
    ok: true,
    result: null,
    message: `no target found with name "${raw}"`,
  });
}
