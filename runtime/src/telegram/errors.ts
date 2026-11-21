import { tl } from "@mtcute/node";
import { Failed, type FailureCode } from "../mind/failure.js";

/** 执行器确定没做成时用的码（各码的意思见 mind/failure.ts）。其他错误一律记为结果未知。 */
export type TelegramActionErrorCode = Exclude<
  FailureCode,
  "outcome_unknown" | "skipped_after_failure" | "paused" | "interrupted" | "unavailable" | "errand"
>;

/** 和码一起写进 act.failed 的事实（mind/failure.ts Failure 的 rpc、dmClosed）。 */
export interface TelegramFacts {
  rpc?: string;
  dmClosed?: true;
}

export class TelegramActionError extends Failed {
  constructor(
    readonly code: TelegramActionErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    facts: TelegramFacts = {},
  ) {
    super({ reason: code, ...facts }, message);
    this.name = "TelegramActionError";
  }
}

/** Telegram 原样给的错误码（RPC 错误的文字）；不是 RPC 错误时没有。 */
export function rpcOf(error: unknown): string | undefined {
  return tl.RpcError.is(error) ? error.text : undefined;
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
    return "transport_hard_permanent";
  }

  if (tl.RpcError.is(error, "USER_IS_BLOCKED") || tl.RpcError.is(error, "PEER_ID_BLOCKED")) {
    return "refused";
  }

  if (tl.RpcError.is(error, "REACTION_INVALID")) return "invalid_reaction";

  // 第一次私聊群友时才会遇到的两种（A10）。
  if (tl.RpcError.is(error, "PRIVACY_PREMIUM_REQUIRED")) return "private_closed";
  if (tl.RpcError.is(error, "PEER_FLOOD")) return "peer_flood";
  // 找群、加群（A18、A08）。
  if (tl.RpcError.is(error, "INVITE_REQUEST_SENT")) return "join_requested";
  if (tl.RpcError.is(error, "FLOOD_WAIT_%d") || tl.RpcError.is(error, "CHANNELS_TOO_MUCH")) {
    return "too_often";
  }
  if (
    tl.RpcError.is(error, "INVITE_HASH_EXPIRED") ||
    tl.RpcError.is(error, "INVITE_HASH_INVALID") ||
    tl.RpcError.is(error, "USERNAME_NOT_OCCUPIED") ||
    tl.RpcError.is(error, "USERNAME_INVALID")
  ) {
    return "peer_unreachable";
  }

  if (
    tl.RpcError.is(error, "MESSAGE_AUTHOR_REQUIRED") ||
    tl.RpcError.is(error, "MESSAGE_EDIT_TIME_EXPIRED")
  ) {
    return "edit_refused";
  }
  // 那条消息不在了（被删了）：点表情、改、转发都可能碰上，不只是改消息（线上第一天：点表情记成了"改不了"）。
  if (tl.RpcError.is(error, "MESSAGE_ID_INVALID")) return "message_gone";

  // 群里禁止转发（复读用的是不带原作者的转发）。
  if (tl.RpcError.is(error, "CHAT_FORWARDS_RESTRICTED")) return "transport_soft_permanent";

  // 这十种并成一个码；是哪一种看 act.failed 的 rpc。
  if (
    tl.RpcError.is(error, "PEER_ID_INVALID") ||
    tl.RpcError.is(error, "CHAT_ID_INVALID") ||
    tl.RpcError.is(error, "CHANNEL_INVALID") ||
    tl.RpcError.is(error, "CHANNEL_PRIVATE") ||
    tl.RpcError.is(error, "CHAT_FORBIDDEN") ||
    tl.RpcError.is(error, "USER_NOT_PARTICIPANT") ||
    tl.RpcError.is(error, "USER_PRIVACY_RESTRICTED") ||
    tl.RpcError.is(error, "CHAT_WRITE_FORBIDDEN") ||
    tl.RpcError.is(error, "CHAT_ADMIN_REQUIRED") ||
    tl.RpcError.is(error, "CHAT_RESTRICTED")
  ) {
    return "transport_soft_permanent";
  }

  return null;
}

/**
 * Telegram 的明确拒绝改成带类型的失败，原样带上它的错误码（rpc）；dmClosed 由调用方判断（first-dm.ts closesDm）。
 * 已经是带类型的失败（停机中止、执行器自己确定的）照原样抛。
 */
export function rethrowTelegramActionFailure(
  error: unknown,
  action: string,
  details?: Record<string, unknown>,
  facts: Pick<TelegramFacts, "dmClosed"> = {},
): never {
  if (error instanceof Failed) throw error;

  const rpc = rpcOf(error);
  const code = classifyTelegramActionFailure(error);
  if (code) {
    throw new TelegramActionError(
      code,
      `${action} failed: ${rpc}`,
      { ...details, originalError: error instanceof Error ? error.message : String(error) },
      { ...(rpc ? { rpc } : {}), ...facts },
    );
  }
  // 没归类的 RPC 错误照旧是结果未知，只是把码也记下（act.failed 的 rpc）。
  if (rpc) throw new Failed({ reason: "outcome_unknown", rpc }, `${action} failed: ${rpc}`);

  throw error;
}

/** 只是"看不到"的码：目标不在了、对普通成员藏着的权限、那条消息被删了。多一项少一项不改变这一轮成没成。 */
const MISSING: Partial<Record<TelegramActionErrorCode, true>> = {
  transport_soft_permanent: true,
  peer_unreachable: true,
  message_gone: true,
};

/**
 * 只让描述更完整的一次请求（找群的预览、群里的人数和管理员）：要不到就让那一项缺着（fallback）。
 * 停机中止和"这一轮明显没成"的错误（限流、发太多、被拒、结果未知）照原样抛——半份事实不能盖住它们，
 * 也不能让外壳把这轮当成做完了。
 */
export async function optionalFact<T>(
  signal: AbortSignal,
  request: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    if (error instanceof TelegramActionError && MISSING[error.code]) return fallback;
    throw error;
  }
}
