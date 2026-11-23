/**
 * 执行器用的两种限流（各平台的 gates 共用）：
 * - KeyedBurstLimiter：按会话的 burst limiter。真人不会 60 秒内连发 6 条以上消息，也不会 30 秒内连点 4 个以上反应。
 *   模型在一段 script 里连发好几条（实测见过一次 4 条消息、一次 10 个 👀 反应），是"太吵被踢"最直接的原因之一。
 *   超限直接拒绝，不排队：排队只会把积压的消息推迟后一起爆发；拒绝则让这一轮按失败冷却，模型下一轮自己收敛。
 * - SlidingWindowLimiter：全局请求节流，超限时排队等待。
 */
import { createLogger } from "./logger.js";

const log = createLogger("actions");

export class KeyedBurstLimiter {
  private slots = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  tryAcquire(key: string): boolean {
    const now = this.now();
    const recent = (this.slots.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (recent.length >= this.max) return false;
    recent.push(now);
    this.slots.set(key, recent);
    return true;
  }

  /**
   * 记录一次过去的使用（重启后从 Journal 恢复计数，须按时间顺序调用）：早于这一次超过一个窗口的记录会丢掉，
   * 最多保留 max 条（判断是否超限只需要这么多），所以 fold 很长的日志也不会越积越多。
   */
  record(key: string, at: number): void {
    const kept = (this.slots.get(key) ?? []).filter((t) => t > at - this.windowMs);
    kept.push(at);
    this.slots.set(key, kept.slice(-this.max));
  }
}

/** 全局请求节流（所有会话合计每 windowMs 最多 maxRequests 次），超限时排队等待。 */
export class SlidingWindowLimiter {
  private timestamps: number[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {}

  async acquire(): Promise<void> {
    this.queue = this.queue.then(() => this.acquireSlot());
    return this.queue;
  }

  private async acquireSlot(): Promise<void> {
    const now = this.now();
    this.timestamps = this.timestamps.filter((timestamp) => timestamp > now - this.windowMs);
    const oldest = this.timestamps[0];
    if (oldest !== undefined && this.timestamps.length >= this.maxRequests) {
      const waitMs = oldest + this.windowMs - now;
      log.debug("Rate limit hit, waiting", { waitMs });
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return this.acquireSlot();
    }
    this.timestamps.push(now);
  }
}
