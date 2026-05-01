import { tl } from "@mtcute/node";

export const TELEGRAM_ACTION_ERROR_CODES = [
  "invalid_reply_ref",
  "invalid_reaction",
  "invalid_sticker_keyword",
  "unreachable_telegram_user",
  "voice_messages_forbidden",
  "album_asset_not_found",
  "album_source_missing",
  "album_source_inaccessible",
  "album_forward_restricted",
  "album_send_failed",
  "telegram_hard_permanent",
  "telegram_soft_permanent",
] as const;

export type TelegramActionErrorCode = (typeof TELEGRAM_ACTION_ERROR_CODES)[number];

export class TelegramActionError extends Error {
  constructor(
    readonly code: TelegramActionErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TelegramActionError";
  }
}

export function isTelegramActionError(error: unknown): error is TelegramActionError {
  return error instanceof TelegramActionError;
}

export function classifyTelegramActionFailure(error: unknown): TelegramActionErrorCode | null {
  if (
    tl.RpcError.is(error, "INPUT_USER_DEACTIVATED") ||
    tl.RpcError.is(error, "USER_DEACTIVATED") ||
    tl.RpcError.is(error, "USER_DEACTIVATED_BAN")
  ) {
    return "telegram_hard_permanent";
  }

  if (
    tl.RpcError.is(error, "PEER_ID_INVALID") ||
    tl.RpcError.is(error, "CHAT_ID_INVALID") ||
    tl.RpcError.is(error, "CHANNEL_INVALID") ||
    tl.RpcError.is(error, "CHANNEL_PRIVATE") ||
    tl.RpcError.is(error, "CHAT_FORBIDDEN") ||
    tl.RpcError.is(error, "USER_NOT_PARTICIPANT") ||
    tl.RpcError.is(error, "USER_IS_BLOCKED") ||
    tl.RpcError.is(error, "PEER_ID_BLOCKED") ||
    tl.RpcError.is(error, "USER_PRIVACY_RESTRICTED") ||
    tl.RpcError.is(error, "CHAT_WRITE_FORBIDDEN") ||
    tl.RpcError.is(error, "CHAT_RESTRICTED")
  ) {
    return "telegram_soft_permanent";
  }

  if (
    tl.RpcError.is(error, "VOICE_MESSAGES_FORBIDDEN") ||
    tl.RpcError.is(error, "VOICE_MESSAGES_FORBIDDEN_FOR_PREMIUM")
  ) {
    return "voice_messages_forbidden";
  }

  // mtcute can reject a locally unresolved peer before Telegram returns an RpcError.
  // This is an exact library exception value, not a runtime log classifier.
  if (error instanceof Error && error.message === "The provided peer id is invalid.") {
    return "telegram_soft_permanent";
  }

  return null;
}

export function rethrowTelegramActionFailure(
  error: unknown,
  action: string,
  details?: Record<string, unknown>,
): never {
  if (isTelegramActionError(error)) throw error;

  const code = classifyTelegramActionFailure(error);
  if (code) {
    throw new TelegramActionError(code, `${action} failed: telegram target is unreachable`, {
      ...details,
      originalError: error instanceof Error ? error.message : String(error),
    });
  }

  throw error;
}
