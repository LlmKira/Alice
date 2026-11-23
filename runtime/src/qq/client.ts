/**
 * OneBot v11 正向 WebSocket 客户端（NapCat、Lagrange、go-cqhttp 都支持这种连法）：同一条连接既收事件、
 * 也发动作请求，请求和回复靠 echo 字段配对。断线后按退避重连；断线时还在等回复的请求以普通错误结束
 * （结果未知，外壳不会重做）。
 * 鉴权只用 Authorization 头。v11 规范也允许用 access_token 查询参数，但地址会写进日志，所以不把 token 放进去。
 * 不引入 SDK：v11 协议就是 JSON 一来一回。测试替身从 WebSocket 这一层换（connect 可以换成假的）。
 */
import { Failed } from "../mind/failure.js";

/** 客户端用到的 WebSocket 接口子集（Node 22 自带的 WebSocket 就满足）。 */
export interface SocketLike {
  send: (data: string) => void;
  close: () => void;
  /** 事件类型是 open、close、error、message；只有 message 事件带 data。 */
  addEventListener: (type: string, listener: (event: { data?: unknown }) => void) => void;
}

export type Connect = (url: string, headers: Record<string, string>) => SocketLike;

/**
 * Node 自带的 WebSocket（undici）第二个参数接受 { headers }；但 tsconfig 用的是 DOM 类型，那里第二个参数
 * 只能是子协议，所以用 Reflect.construct 绕过类型检查。
 */
const defaultConnect: Connect = (url, headers): SocketLike =>
  Reflect.construct(WebSocket, [url, { headers }]) as SocketLike;

/** OneBot 明确回复 failed：带上它给的 retcode 和说明（wording 或 message）。 */
export class OneBotError extends Error {
  constructor(
    readonly action: string,
    readonly retcode: number,
    readonly wording: string,
  ) {
    super(`${action} failed: ${retcode} ${wording}`);
    this.name = "OneBotError";
  }
}

export interface OneBotClientOptions {
  url: string;
  token: string | null;
  /** 收到事件时调用（只转发 post_type 为 message、notice、request 的；心跳和生命周期事件不转发）。 */
  onEvent: (event: Record<string, unknown>) => void;
  /** 连接状态变化时调用：connected 或 offline。 */
  onState: (state: "connected" | "offline") => void;
  warn: (message: string, error?: unknown) => void;
  connect?: Connect;
  /** 单个请求等待回复的超时。 */
  timeoutMs?: number;
  /** 第 n 次重连前的等待时长。 */
  backoffMs?: (attempt: number) => number;
}

interface Pending {
  action: string;
  resolve: (data: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

const TIMEOUT_MS = 30_000;
const backoff = (attempt: number) => Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class OneBotClient {
  private socket: SocketLike | null = null;
  private open = false;
  private closed = false;
  private attempt = 0;
  private echo = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly options: OneBotClientOptions) {}

  get connected(): boolean {
    return this.open;
  }

  /** 开始连接：立即返回，不等连上；连不上就按退避一直重试，直到调用 close。连上和断开都经 onState 通知。 */
  start(): void {
    this.dial();
  }

  /**
   * 发一个动作请求并等它的回复（data）。没连上时确定没发出去，抛 Failed unavailable。
   * signal 只在发出前有效：一旦发出，就一直等到回复、超时或断线（后两种结果未知）。
   */
  async call<T = unknown>(
    action: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const socket = this.socket;
    if (!this.open || !socket) {
      throw new Failed({ reason: "unavailable" }, `OneBot is not connected (${action})`);
    }
    const echo = `alice-${++this.echo}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`${action} timed out`));
      }, this.options.timeoutMs ?? TIMEOUT_MS);
      this.pending.set(echo, {
        action,
        resolve: (data) => resolve(data as T),
        reject,
        timer,
      });
      try {
        socket.send(JSON.stringify({ action, params, echo }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(error);
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.dropPending("OneBot connection closed");
  }

  private dial(): void {
    if (this.closed) return;
    const { url, token } = this.options;
    let socket: SocketLike;
    try {
      socket = (this.options.connect ?? defaultConnect)(
        url,
        token ? { Authorization: `Bearer ${token}` } : {},
      );
    } catch (error) {
      this.options.warn("OneBot connect failed", error);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.open = true;
      this.attempt = 0;
      this.options.onState("connected");
    });
    socket.addEventListener("message", (event) => {
      if (this.socket === socket) this.receive(event.data);
    });
    socket.addEventListener("error", () => {
      // 之后一定会收到 close，在那里重连。
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      const wasOpen = this.open;
      this.open = false;
      this.socket = null;
      this.dropPending("OneBot connection closed");
      if (wasOpen) this.options.onState("offline");
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = (this.options.backoffMs ?? backoff)(this.attempt++);
    this.reconnectTimer = setTimeout(() => this.dial(), delay);
    this.reconnectTimer.unref?.();
  }

  private dropPending(why: string): void {
    for (const [echo, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`${why} before ${p.action} answered`));
      this.pending.delete(echo);
    }
  }

  private receive(data: unknown): void {
    let message: unknown;
    try {
      message = JSON.parse(typeof data === "string" ? data : String(data));
    } catch (error) {
      this.options.warn("OneBot sent something that is not JSON", error);
      return;
    }
    if (!isRecord(message)) return;
    const echo = typeof message.echo === "string" ? message.echo : null;
    const waiting = echo === null ? undefined : this.pending.get(echo);
    if (echo !== null && waiting) {
      this.pending.delete(echo);
      clearTimeout(waiting.timer);
      if (message.status === "failed") {
        const wording = [message.wording, message.message].find((w) => typeof w === "string");
        waiting.reject(
          new OneBotError(waiting.action, Number(message.retcode ?? -1), String(wording ?? "")),
        );
      } else {
        waiting.resolve(message.data);
      }
      return;
    }
    const post = message.post_type;
    if (post === "message" || post === "notice" || post === "request") {
      this.options.onEvent(message);
    }
  }
}
