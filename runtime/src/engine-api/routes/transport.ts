/**
 * Engine API — neutral transport syscalls.
 *
 * Telegram is the first backing adapter; non-Telegram targets return typed
 * unsupported responses until their bridges exist.
 *
 * @see docs/adr/265-multi-im-platform-strategy/README.md
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { parseTransportMessageId, parseTransportTargetId } from "../../platform/transport.js";
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

function json(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function invalidRef(
  res: ServerResponse,
  code: "invalid_target_ref" | "invalid_message_ref",
  error: string,
): void {
  json(res, 400, { code, error });
}

function unsupportedCapability(
  res: ServerResponse,
  platform: string,
  capability: "send" | "read" | "react",
): void {
  json(res, 501, {
    code: "unsupported_capability",
    error: `${platform} transport ${capability} is not supported`,
    platform,
    capability,
  });
}

function adapterFor(
  res: ServerResponse,
  deps: EngineApiDeps,
  platform: string,
  capability: "send" | "read" | "react",
) {
  const adapter = deps.transportAdapters?.[platform];
  if (!adapter || !adapter[capability]) {
    unsupportedCapability(res, platform, capability);
    return null;
  }
  return adapter;
}

function handleProviderError(res: ServerResponse, fallback: string, err: unknown): void {
  if (isTelegramActionError(err)) {
    json(res, 400, { code: err.code, error: err.message, ...err.details });
    return;
  }

  if (err instanceof Error && err.name === "OneBotActionError") {
    const details = err as Error & {
      action?: unknown;
      status?: unknown;
      retcode?: unknown;
      responseText?: unknown;
    };
    json(res, 502, {
      code: "onebot_action_failed",
      error: err.message,
      action: details.action,
      status: details.status,
      retcode: details.retcode,
      responseText: details.responseText,
    });
    return;
  }

  console.error(`[Engine API] ${fallback}:`, err instanceof Error ? err.stack : err);
  json(res, 500, { error: err instanceof Error ? err.message : fallback });
}

function parseTarget(
  res: ServerResponse,
  targetValue: unknown,
): NonNullable<ReturnType<typeof parseTransportTargetId>> | null {
  const target = parseTransportTargetId(targetValue);
  if (!target) {
    invalidRef(res, "invalid_target_ref", "invalid transport target ref");
    return null;
  }
  return target;
}

function parseReplyTo(
  res: ServerResponse,
  targetPlatform: string,
  replyTo: unknown,
): ReturnType<typeof parseTransportMessageId> | undefined | null {
  if (replyTo === undefined) return undefined;
  const ref = parseTransportMessageId(replyTo);
  if (!ref) {
    invalidRef(res, "invalid_message_ref", "invalid transport reply message ref");
    return null;
  }
  if (ref.platform !== targetPlatform) {
    invalidRef(res, "invalid_message_ref", "reply message ref platform does not match target");
    return null;
  }
  return ref;
}

function parseMessageRef(
  res: ServerResponse,
  targetPlatform: string,
  value: unknown,
): NonNullable<ReturnType<typeof parseTransportMessageId>> | null {
  const ref = parseTransportMessageId(value);
  if (!ref) {
    invalidRef(res, "invalid_message_ref", "invalid transport message ref");
    return null;
  }
  if (ref.platform !== targetPlatform) {
    invalidRef(res, "invalid_message_ref", "message ref platform does not match target");
    return null;
  }
  return ref;
}

export async function handleTransport(
  action: string,
  req: IncomingMessage,
  res: ServerResponse,
  deps: EngineApiDeps,
): Promise<void> {
  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    json(res, 400, { code: "invalid_json_body", error: "invalid JSON body" });
    return;
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    json(res, 400, { code: "invalid_body", error: "body must be an object" });
    return;
  }

  if (action === "send") {
    const { target, text, replyTo } = body as {
      target?: unknown;
      text?: unknown;
      replyTo?: unknown;
    };
    if (typeof text !== "string" || text.length === 0) {
      json(res, 400, { code: "invalid_body", error: 'body must include non-empty "text"' });
      return;
    }
    const parsedTarget = parseTarget(res, target);
    if (!parsedTarget) return;
    const adapter = adapterFor(res, deps, parsedTarget.platform, "send");
    if (!adapter?.send) return;
    const replyToRef = parseReplyTo(res, parsedTarget.platform, replyTo);
    if (replyToRef === null) return;

    try {
      const result = await adapter.send({
        target: parsedTarget,
        text,
        replyTo: replyToRef,
      });
      json(res, 200, { ...result });
    } catch (err) {
      handleProviderError(res, "transport send failed", err);
    }
    return;
  }

  if (action === "read") {
    const { target } = body as { target?: unknown };
    const parsedTarget = parseTarget(res, target);
    if (!parsedTarget) return;
    const adapter = adapterFor(res, deps, parsedTarget.platform, "read");
    if (!adapter?.read) return;

    try {
      const result = await adapter.read({ target: parsedTarget });
      json(res, 200, { ...result });
    } catch (err) {
      handleProviderError(res, "transport read failed", err);
    }
    return;
  }

  if (action === "react") {
    const { target, message, emoji } = body as {
      target?: unknown;
      message?: unknown;
      emoji?: unknown;
    };
    if (typeof emoji !== "string" || emoji.length === 0) {
      json(res, 400, { code: "invalid_body", error: 'body must include non-empty "emoji"' });
      return;
    }
    const parsedTarget = parseTarget(res, target);
    if (!parsedTarget) return;
    const adapter = adapterFor(res, deps, parsedTarget.platform, "react");
    if (!adapter?.react) return;
    const parsedMessage = parseMessageRef(res, parsedTarget.platform, message);
    if (!parsedMessage) return;

    try {
      const result = await adapter.react({
        target: parsedTarget,
        message: parsedMessage,
        emoji,
      });
      json(res, 200, { ...result });
    } catch (err) {
      handleProviderError(res, "transport react failed", err);
    }
    return;
  }

  json(res, 404, {
    code: "unknown_transport_action",
    error: `unknown transport action: ${action}`,
  });
}
