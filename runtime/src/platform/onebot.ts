import { cacheOneBotOutgoingMsg } from "./onebot-events.js";
import {
  stableTransportMessageId,
  type TransportAdapter,
  type TransportMessageRef,
} from "./transport.js";

export type OneBotHttpFetch = (
  input: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

export interface OneBotTransportConfig {
  apiBaseUrl: string;
  accessToken?: string;
  timeoutMs?: number;
  fetch?: OneBotHttpFetch;
}

class OneBotActionError extends Error {
  readonly action: OneBotAction;
  readonly status?: number;
  readonly retcode?: number;
  readonly responseText: string;

  constructor(
    action: OneBotAction,
    message: string,
    options: { status?: number; retcode?: number; responseText?: string } = {},
  ) {
    super(message);
    this.name = "OneBotActionError";
    this.action = action;
    this.status = options.status;
    this.retcode = options.retcode;
    this.responseText = options.responseText ?? "";
  }
}

type OneBotAction = "send_group_msg" | "send_private_msg";
type OneBotMessageSegment =
  | { type: "reply"; data: { id: string | number } }
  | { type: "text"; data: { text: string } };

const NUMERIC_ID_RE = /^-?\d+$/;

function oneBotIdValue(value: string): string | number {
  if (!NUMERIC_ID_RE.test(value)) return value;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
}

function oneBotTextMessage(text: string, replyTo?: TransportMessageRef): OneBotMessageSegment[] {
  const message: OneBotMessageSegment[] = [];
  if (replyTo) {
    message.push({ type: "reply", data: { id: oneBotIdValue(replyTo.messageNativeId) } });
  }
  message.push({ type: "text", data: { text } });
  return message;
}

function parseOneBotJsonResponse(text: string): Record<string, unknown> {
  if (text.length === 0) return {};
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OneBot response body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function oneBotMessageIdFromResponse(body: Record<string, unknown>): string | number | null {
  const data = body.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const messageId = (data as Record<string, unknown>).message_id;
    if (typeof messageId === "string" || typeof messageId === "number") return messageId;
  }
  const messageId = body.message_id;
  return typeof messageId === "string" || typeof messageId === "number" ? messageId : null;
}

async function postOneBotAction(
  config: Required<Pick<OneBotTransportConfig, "apiBaseUrl" | "timeoutMs" | "fetch">> &
    Pick<OneBotTransportConfig, "accessToken">,
  action: OneBotAction,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.accessToken) headers.Authorization = `Bearer ${config.accessToken}`;
    const response = await config.fetch(`${config.apiBaseUrl}/${action}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const bodyText = await response.text();
    if (!response.ok) {
      throw new OneBotActionError(action, `OneBot ${action} failed with HTTP ${response.status}`, {
        status: response.status,
        responseText: bodyText,
      });
    }
    const body = parseOneBotJsonResponse(bodyText);
    const retcode = body.retcode;
    if (body.status === "failed" || (typeof retcode === "number" && retcode !== 0)) {
      throw new OneBotActionError(action, `OneBot ${action} failed`, {
        retcode: typeof retcode === "number" ? retcode : undefined,
        responseText: bodyText,
      });
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * QQ 第一接入路线：OneBot v11 action API。
 *
 * OneBot 覆盖 QQ M1 核心闭环（群/私聊文本、reply、常见消息段），但不声明
 * reaction/read/media 等能力；缺失能力由 transport route 返回 unsupported_capability。
 *
 * @see docs/adr/264-qq-platform-support/README.md
 * @see docs/reference/LangBot/src/langbot/pkg/platform/sources/aiocqhttp.py
 * @see docs/reference/AstrBot/astrbot/core/platform/sources/aiocqhttp/aiocqhttp_message_event.py
 */
export function createOneBotTransportAdapter(config: OneBotTransportConfig): TransportAdapter {
  const apiBaseUrl = config.apiBaseUrl.replace(/\/+$/u, "");
  const oneBotConfig = {
    apiBaseUrl,
    accessToken: config.accessToken,
    timeoutMs: config.timeoutMs ?? 10_000,
    fetch: config.fetch ?? fetch,
  };
  return {
    platform: "qq",
    send: async ({ target, text, replyTo }) => {
      if (target.platform !== "qq") {
        throw new Error("target platform does not match QQ OneBot adapter");
      }
      if (replyTo && replyTo.chatNativeId !== target.nativeId) {
        throw new Error("reply message ref does not belong to target");
      }

      const action = target.kind === "channel" ? "send_group_msg" : "send_private_msg";
      const payload =
        target.kind === "channel"
          ? {
              group_id: oneBotIdValue(target.nativeId),
              message: oneBotTextMessage(text, replyTo),
            }
          : {
              user_id: oneBotIdValue(target.nativeId),
              message: oneBotTextMessage(text, replyTo),
            };
      const body = await postOneBotAction(oneBotConfig, action, payload);
      const nativeMessageId = oneBotMessageIdFromResponse(body);
      if (nativeMessageId != null) {
        cacheOneBotOutgoingMsg(target.nativeId, nativeMessageId);
      }
      return {
        platform: "qq",
        target: target.stableId,
        messageId:
          nativeMessageId == null
            ? null
            : stableTransportMessageId("qq", target.nativeId, nativeMessageId),
        nativeMessageId,
      };
    },
  };
}
