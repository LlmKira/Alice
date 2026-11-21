/**
 * 自检（capabilities X04）：从外壳写进 Journal 的事件、Telegram 连接状态和错误日志里认出异常，
 * 私聊告诉操作员。只看 typed 信号（事件类型、错误码、连接状态），不读文字。告警有限频：
 * 同一类 30 分钟最多一条，所有类加起来一小时最多 6 条，被压下的次数并进下一条同类告警。
 */
import { affordanceOf } from "../mind/affordances.js";
import type { AliceEvent } from "../mind/events.js";
import { FAILURES, failureText } from "../mind/failure.js";

export type AlertKind = "speech-failing" | "send-failed" | "telegram-offline" | "error-burst";

export const WATCH = {
  /** 发言（含想一想）连续失败几次算异常。 */
  failuresInARow: 3,
  /** 断线多久才告诉操作员（短暂重连是常态）。 */
  offlineMs: 60_000,
  /** 错误日志：这么长的窗口里超过这么多条算激增。 */
  errorWindowMs: 10 * 60_000,
  errorBurst: 30,
  perKindMs: 30 * 60_000,
  perHour: 6,
  /** status 里列出的最近失败条数。 */
  recentKept: 8,
} as const;

export interface Failure {
  at: number;
  scope: string;
  what: string;
  reason: string;
}

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

export class Watch {
  private inARow = 0;
  private lastReason = "";
  private offlineSince: number | null = null;
  private errors: number[] = [];
  private readonly lastSent = new Map<AlertKind, number>();
  private readonly suppressed = new Map<AlertKind, number>();
  private sentTimes: number[] = [];
  readonly recent: Failure[] = [];

  constructor(
    private readonly now: () => number,
    private readonly send: (text: string) => void,
  ) {}

  get connected(): boolean {
    return this.offlineSince === null;
  }

  errorsInWindow(): number {
    const since = this.now() - WATCH.errorWindowMs;
    this.errors = this.errors.filter((t) => t > since);
    return this.errors.length;
  }

  /** 外壳写进 Journal 的每个事件。 */
  observe(event: AliceEvent): void {
    switch (event.type) {
      case "speech.decided":
      case "ponder.done":
        this.inARow = 0;
        return;
      case "speech.failed":
      case "ponder.failed": {
        // 停机打断、暂停：不是模型出了问题。
        if (event.reason !== "model") return;
        const error = event.error ?? event.reason;
        this.remember(
          event.at,
          event.scope,
          event.type === "speech.failed" ? "发言" : "想一想",
          error,
        );
        this.inARow++;
        this.lastReason = error;
        if (this.inARow === WATCH.failuresInARow) {
          this.alert(
            "speech-failing",
            `模型调用连续失败 ${this.inARow} 次，最近一次：${this.lastReason.slice(0, 160)}`,
          );
        }
        return;
      }
      case "act.failed": {
        if (affordanceOf(event.act.kind).via === "errand") {
          this.remember(event.at, event.scope, event.act.kind, failureText(event));
          return;
        }
        // 她自己选错了、要等审批、额度、受众规则、暂停：不是送达出了问题（mind/failure.ts）。
        if (FAILURES[event.reason].delivery === null) return;
        this.remember(event.at, event.scope, event.act.kind, event.reason);
        this.alert("send-failed", `${event.scope} 的 ${event.act.kind} 没做成：${event.reason}`);
        return;
      }
      default:
        return;
    }
  }

  /** mtcute 的连接状态（offline / connecting / updating / connected）。 */
  connection(state: string): void {
    const at = this.now();
    if (state !== "connected") {
      this.offlineSince ??= at;
      return;
    }
    const since = this.offlineSince;
    this.offlineSince = null;
    if (since !== null && at - since >= WATCH.offlineMs) {
      this.alert("telegram-offline", `Telegram 断了约 ${minutes(at - since)} 分钟，已经连上`);
    }
  }

  /** 写了一条 warn / error / fatal 日志。 */
  errorLogged(): void {
    this.errors.push(this.now());
    const n = this.errorsInWindow();
    if (n >= WATCH.errorBurst) {
      this.alert(
        "error-burst",
        `错误日志 ${minutes(WATCH.errorWindowMs)} 分钟里 ${n} 条，看 alice-errors.log`,
      );
    }
  }

  /** 限频地私聊操作员。返回是否发出。 */
  alert(kind: AlertKind, text: string): boolean {
    const at = this.now();
    this.sentTimes = this.sentTimes.filter((t) => t > at - 3_600_000);
    const last = this.lastSent.get(kind);
    if (
      (last !== undefined && at - last < WATCH.perKindMs) ||
      this.sentTimes.length >= WATCH.perHour
    ) {
      this.suppressed.set(kind, (this.suppressed.get(kind) ?? 0) + 1);
      return false;
    }
    const held = this.suppressed.get(kind) ?? 0;
    this.suppressed.delete(kind);
    this.lastSent.set(kind, at);
    this.sentTimes.push(at);
    this.send(held > 0 ? `${text}\n（之前同类还有 ${held} 次没单独报）` : text);
    return true;
  }

  private remember(at: number, scope: string, what: string, reason: string): void {
    this.recent.push({ at, scope, what, reason });
    if (this.recent.length > WATCH.recentKept) this.recent.shift();
  }
}
