import type { EventBuffer } from "../telegram/events.js";
import { createLogger } from "../utils/logger.js";
import { ingestOneBotMessageEvent } from "./onebot-ingress.js";

const log = createLogger("onebot-receiver");

const DEFAULT_RECONNECT_MIN_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 60_000;
const OPEN_STATE = 1;

export interface OneBotEventWebSocket {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  close: () => void;
}

export type OneBotEventWebSocketFactory = (
  url: string,
  protocols?: string | string[],
) => OneBotEventWebSocket;

export interface OneBotReceiverOptions {
  url: string;
  accessToken?: string;
  selfId?: string | number;
  selfDisplayName?: string;
  getTick: () => number;
  buffer: EventBuffer;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  createWebSocket?: OneBotEventWebSocketFactory;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  random?: () => number;
}

export interface OneBotReceiverController {
  close: () => void;
}

function defaultCreateWebSocket(url: string, protocols?: string | string[]): OneBotEventWebSocket {
  const WebSocketCtor = globalThis.WebSocket;
  if (!WebSocketCtor) {
    throw new Error("global WebSocket is unavailable in this runtime");
  }
  return new WebSocketCtor(url, protocols) as OneBotEventWebSocket;
}

function eventUrlWithAccessToken(rawUrl: string, accessToken: string | undefined): string {
  const token = accessToken?.trim();
  if (!token) return rawUrl;
  const url = new URL(rawUrl);
  if (!url.searchParams.has("access_token")) {
    url.searchParams.set("access_token", token);
  }
  return url.toString();
}

function sanitizeUrlForLog(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.searchParams.has("access_token")) {
    url.searchParams.set("access_token", "***");
  }
  return url.toString();
}

function decodeWebSocketData(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf-8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf-8");
  }
  if (data instanceof Blob) {
    return null;
  }
  return String(data);
}

function reconnectDelayMs(
  failures: number,
  minMs: number,
  maxMs: number,
  random: () => number,
): number {
  const exponential = Math.min(maxMs, minMs * 2 ** Math.max(0, failures - 1));
  const jitter = 0.8 + random() * 0.4;
  return Math.min(maxMs, Math.round(exponential * jitter));
}

function isMessagePost(payload: unknown): boolean {
  return (
    payload != null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    (payload as Record<string, unknown>).post_type === "message"
  );
}

/**
 * OneBot v11 事件 WebSocket 接收器。
 *
 * 这里只负责外部连接、重连和 JSON 边界；QQ 事实映射仍由 onebot-ingress 统一处理。
 *
 * @see docs/adr/264-qq-platform-support/README.md
 * @see docs/reference/AstrBot/astrbot/core/platform/sources/aiocqhttp/aiocqhttp_platform_adapter.py
 */
export function startOneBotEventReceiver(options: OneBotReceiverOptions): OneBotReceiverController {
  const url = options.url.trim();
  if (!url) throw new Error("OneBot event WebSocket URL is required");

  const reconnectMinMs = options.reconnectMinMs ?? DEFAULT_RECONNECT_MIN_MS;
  const reconnectMaxMs = Math.max(
    reconnectMinMs,
    options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS,
  );
  const createWebSocket = options.createWebSocket ?? defaultCreateWebSocket;
  const setTimer = options.setTimeoutFn ?? setTimeout;
  const clearTimer = options.clearTimeoutFn ?? clearTimeout;
  const random = options.random ?? Math.random;
  const connectUrl = eventUrlWithAccessToken(url, options.accessToken);
  const logUrl = sanitizeUrlForLog(connectUrl);

  let closed = false;
  let socket: OneBotEventWebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;

  const clearReconnectTimer = () => {
    if (!reconnectTimer) return;
    clearTimer(reconnectTimer);
    reconnectTimer = null;
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return;
    failures++;
    const delayMs = reconnectDelayMs(failures, reconnectMinMs, reconnectMaxMs, random);
    log.warn("OneBot event WebSocket disconnected, scheduling reconnect", { delayMs, failures });
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      connect();
    }, delayMs);
  };

  const handleMessage = (data: unknown) => {
    const text = decodeWebSocketData(data);
    if (text == null) {
      log.warn("Ignoring unsupported OneBot WebSocket message data");
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      log.warn("Ignoring malformed OneBot WebSocket JSON", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (!isMessagePost(payload)) return;

    try {
      ingestOneBotMessageEvent(payload, {
        tick: options.getTick(),
        selfId: options.selfId,
        selfDisplayName: options.selfDisplayName,
        buffer: options.buffer,
      });
    } catch (error) {
      log.warn("Failed to ingest OneBot message event", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  function connect() {
    if (closed) return;
    let nextSocket: OneBotEventWebSocket;
    try {
      nextSocket = createWebSocket(connectUrl);
    } catch (error) {
      log.warn("Failed to create OneBot event WebSocket", {
        error: error instanceof Error ? error.message : String(error),
      });
      scheduleReconnect();
      return;
    }

    socket = nextSocket;
    nextSocket.onopen = () => {
      failures = 0;
      log.info("OneBot event WebSocket connected", { url: logUrl });
    };
    nextSocket.onmessage = (event) => handleMessage(event.data);
    nextSocket.onerror = (event) => {
      log.warn("OneBot event WebSocket error", { event: String(event) });
    };
    nextSocket.onclose = () => {
      if (socket === nextSocket) socket = null;
      scheduleReconnect();
    };
  }

  connect();

  return {
    close: () => {
      closed = true;
      clearReconnectTimer();
      const current = socket;
      socket = null;
      if (current && current.readyState === OPEN_STATE) {
        current.close();
      } else if (current) {
        current.onclose = null;
        current.close();
      }
    },
  };
}
