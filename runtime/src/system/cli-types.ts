/**
 * CLI 类型定义 — IO 接口抽象（ADR-235 FP 改进）。
 *
 * 将命令逻辑与 IO 实现解耦，使命令处理可单元测试。
 *
 * @see docs/adr/235-cli-human-readable-output.md
 */

// ── Engine Client 接口 ──

/** Engine API 客户端接口。 */
export interface EngineClient {
  /** POST 请求，返回解析后的 JSON 或 null。 */
  post: (path: string, body: unknown) => Promise<unknown | null>;

  /** GET 请求，返回解析后的 JSON 或 null。 */
  get: (path: string) => Promise<unknown | null>;

  /** Query 端点专用 POST（自动解包 {ok, result}）。 */
  query: (path: string, body: unknown) => Promise<unknown | null>;
}

// ── Output 接口 ──

/** 输出接口。 */
export interface Output {
  /** 标准输出。 */
  log: (msg: string) => void;

  /** 标准错误。 */
  error: (msg: string) => void;

  /** 退出进程。 */
  exit: (code: number) => never;
}

// ── Structured Error Protocol ──

export const CLI_ERROR_PREFIX = "__ALICE_ERROR__:";
export const CLI_ERROR_DETAIL_PREFIX = "__ALICE_ERROR_DETAIL__:";

export const CLI_ERROR_CODES = [
  "command_cross_chat_send",
  "command_invalid_target",
  "command_invalid_message_id",
  "command_invalid_reply_ref",
  "command_missing_argument",
  "command_arg_format",
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
  "timeout",
] as const;

export type CliErrorCode = (typeof CLI_ERROR_CODES)[number];

export interface CliErrorDetail {
  code: CliErrorCode;
  source: string;
  currentChatId?: string | null;
  requestedChatId?: string | null;
  payload?: Record<string, unknown>;
}

export function isCliErrorCode(value: string): value is CliErrorCode {
  return (CLI_ERROR_CODES as readonly string[]).includes(value);
}

export class CliExecutionError extends Error {
  constructor(
    readonly code: CliErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CliExecutionError";
  }
}

export function emitCliErrorCode(output: Output, code: CliErrorCode): void {
  output.error(`${CLI_ERROR_PREFIX}${code}`);
}

export function emitCliErrorDetail(output: Output, detail: CliErrorDetail): void {
  output.error(`${CLI_ERROR_DETAIL_PREFIX}${JSON.stringify(detail)}`);
}

// ── Target Resolver 接口 ──

/** 解析目标聊天 ID（返回 number 供 Engine API 使用）。 */
export type TargetResolver = (target: string | undefined) => Promise<number>;

// ── Command Context ──

/** 命令执行上下文 — 包含所有 IO 依赖。 */
export interface CliContext {
  engine: EngineClient;
  output: Output;
  resolveTarget: TargetResolver;
  /** 当前执行上下文的聊天 ID；发送类命令用它阻止跨聊天主动发话。 */
  currentChatId?: number;
}

// ── Result Types ──

/** 发送消息结果。 */
export interface SendResult {
  msgId?: number;
  deliveredAs?: "voice" | "text";
  fallbackReason?: string;
}

/** 下载结果。 */
export interface DownloadResult {
  path?: string;
  mime?: string;
  size?: number;
}

/** 转发结果。 */
export interface ForwardResult {
  forwardedMsgId?: number;
  commentMsgId?: number;
}

// ── Error Formatting ──

/** 格式化 CLI 错误（纯函数）。 */
export function formatCliError(cliName: string, msg: string): string {
  return `✗ ${cliName}: ${msg}`;
}

/** 构造错误退出函数（闭包）。 */
export function makeDie(
  output: Output,
  cliName: string,
): (msg: string, code?: CliErrorCode, detail?: CliErrorDetail) => never {
  return (msg: string, code?: CliErrorCode, detail?: CliErrorDetail): never => {
    if (code) emitCliErrorCode(output, code);
    if (detail) emitCliErrorDetail(output, detail);
    output.error(formatCliError(cliName, msg));
    output.exit(1);
  };
}

// ── Re-export Command Args Types ──

// 这些类型在 cli-commands.ts 中定义，这里 re-export 方便使用
export type {
  CommandResult,
  JoinArgs,
  LeaveArgs,
  MotdArgs,
  ReactArgs,
  ReadArgs,
  ReplyArgs,
  SayArgs,
  StickerArgs,
  TailArgs,
  ThreadsArgs,
  VoiceArgs,
  WhoisArgs,
} from "./cli-commands.js";
