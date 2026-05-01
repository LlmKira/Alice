export type TransportTargetKind = "channel" | "contact";

export interface TransportTargetRef {
  kind: TransportTargetKind;
  platform: string;
  nativeId: string;
  stableId: string;
  legacy: boolean;
}

export interface TransportMessageRef {
  platform: string;
  chatNativeId: string;
  messageNativeId: string;
  stableId: string;
}

export interface TransportSendParams {
  target: TransportTargetRef;
  text: string;
  replyTo?: TransportMessageRef;
}

export interface TransportSendResult {
  platform: string;
  target: string;
  messageId: string | null;
  nativeMessageId: string | number | null;
}

export interface TransportReadParams {
  target: TransportTargetRef;
}

export interface TransportReadResult {
  platform: string;
  target: string;
  ok: true;
}

export interface TransportReactParams {
  target: TransportTargetRef;
  message: TransportMessageRef;
  emoji: string;
}

export interface TransportReactResult {
  platform: string;
  target: string;
  message: string;
  ok: true;
}

export interface TransportAdapter {
  platform: string;
  send?: (params: TransportSendParams) => Promise<TransportSendResult>;
  read?: (params: TransportReadParams) => Promise<TransportReadResult>;
  react?: (params: TransportReactParams) => Promise<TransportReactResult>;
}

const TELEGRAM_NUMBER_RE = /^-?\d+$/;
// Bridge protocols are adapter paths, not target platform namespaces.
// @see docs/adr/265-multi-im-platform-strategy/README.md
const RESERVED_BRIDGE_PROTOCOL_NAMES = new Set([
  "satori",
  "onebot",
  "koishi",
  "llonebot",
  "napcat",
  "aiocqhttp",
]);

export function isReservedBridgeProtocolName(value: string): boolean {
  return RESERVED_BRIDGE_PROTOCOL_NAMES.has(value.toLowerCase());
}

function isValidTransportPlatform(value: string): boolean {
  return value.length > 0 && !isReservedBridgeProtocolName(value);
}

function normalizeStableTarget(
  kind: TransportTargetKind,
  platform: string,
  nativeId: string,
  legacy: boolean,
): TransportTargetRef {
  const normalizedPlatform = platform.toLowerCase();
  return {
    kind,
    platform: normalizedPlatform,
    nativeId,
    stableId: `${kind}:${normalizedPlatform}:${nativeId}`,
    legacy,
  };
}

export function parseTransportTargetId(value: unknown): TransportTargetRef | null {
  if (typeof value !== "string" || value.length === 0) return null;

  const parts = value.split(":");
  if (
    parts.length === 3 &&
    (parts[0] === "channel" || parts[0] === "contact") &&
    isValidTransportPlatform(parts[1]) &&
    parts[2].length > 0
  ) {
    return normalizeStableTarget(parts[0], parts[1], parts[2], false);
  }

  if (parts.length === 2 && parts[0] === "channel" && TELEGRAM_NUMBER_RE.test(parts[1])) {
    return normalizeStableTarget("channel", "telegram", parts[1], true);
  }

  return null;
}

export function parseTransportMessageId(value: unknown): TransportMessageRef | null {
  if (typeof value !== "string" || value.length === 0) return null;

  const parts = value.split(":");
  if (
    parts.length === 4 &&
    parts[0] === "message" &&
    isValidTransportPlatform(parts[1]) &&
    parts[2].length > 0 &&
    parts[3].length > 0
  ) {
    const platform = parts[1].toLowerCase();
    return {
      platform,
      chatNativeId: parts[2],
      messageNativeId: parts[3],
      stableId: `message:${platform}:${parts[2]}:${parts[3]}`,
    };
  }

  return null;
}

export function stableTransportMessageId(
  platform: string,
  chatNativeId: string,
  messageNativeId: string | number,
): string {
  return `message:${platform.toLowerCase()}:${chatNativeId}:${messageNativeId}`;
}

export function parseTelegramNativeId(value: string): number | null {
  if (!TELEGRAM_NUMBER_RE.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function requireTelegramNativeId(value: string, label: string): number {
  const parsed = parseTelegramNativeId(value);
  if (parsed === null) throw new Error(`invalid Telegram ${label} native id`);
  return parsed;
}

export function createTelegramTransportAdapter(callbacks: {
  send?: (params: {
    chatId: number;
    text: string;
    replyTo?: number;
  }) => Promise<{ msgId: number | null }>;
  markRead?: (chatId: number) => Promise<{ ok: true }>;
  react?: (params: { chatId: number; msgId: number; emoji: string }) => Promise<{ ok: true }>;
}): TransportAdapter {
  const send = callbacks.send;
  const markRead = callbacks.markRead;
  const react = callbacks.react;
  return {
    platform: "telegram",
    send: send
      ? async ({ target, text, replyTo }) => {
          const chatId = requireTelegramNativeId(target.nativeId, "target");
          let replyToMsgId: number | undefined;
          if (replyTo) {
            if (replyTo.platform !== "telegram") {
              throw new Error("reply message ref platform does not match Telegram adapter");
            }
            const replyChatId = requireTelegramNativeId(replyTo.chatNativeId, "reply chat");
            if (replyChatId !== chatId)
              throw new Error("reply message ref does not belong to target");
            replyToMsgId = requireTelegramNativeId(replyTo.messageNativeId, "reply message");
          }
          const result = await send({ chatId, text, replyTo: replyToMsgId });
          return {
            platform: "telegram",
            target: target.stableId,
            messageId:
              result.msgId == null
                ? null
                : stableTransportMessageId("telegram", String(chatId), result.msgId),
            nativeMessageId: result.msgId,
          };
        }
      : undefined,
    read: markRead
      ? async ({ target }) => {
          const chatId = requireTelegramNativeId(target.nativeId, "target");
          await markRead(chatId);
          return { platform: "telegram", target: target.stableId, ok: true };
        }
      : undefined,
    react: react
      ? async ({ target, message, emoji }) => {
          const chatId = requireTelegramNativeId(target.nativeId, "target");
          if (message.platform !== "telegram") {
            throw new Error("message ref platform does not match Telegram adapter");
          }
          const messageChatId = requireTelegramNativeId(message.chatNativeId, "message chat");
          if (messageChatId !== chatId) throw new Error("message ref does not belong to target");
          const msgId = requireTelegramNativeId(message.messageNativeId, "message");
          await react({ chatId, msgId, emoji });
          return {
            platform: "telegram",
            target: target.stableId,
            message: message.stableId,
            ok: true,
          };
        }
      : undefined,
  };
}
