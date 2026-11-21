/**
 * Per-chat 发送突刺限流：真人不会 60 秒内连续发 6+ 条消息、或 30 秒内连点
 * 4+ 个反应。模型一个 script 里连发 N 条（实测：一次 4 条消息 + 一次 10 个
 * 👀 反应）是"太吵被踢"的直接形态之一。拒绝而非排队——排队会让积压延迟
 * 爆发；拒绝走 turn 失败冷却，模型下一轮收敛。
 */
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

  /** 记下一次过去的使用（重启后从 Journal 恢复计数）。 */
  record(key: string, at: number): void {
    this.slots.set(key, [...(this.slots.get(key) ?? []), at]);
  }
}
