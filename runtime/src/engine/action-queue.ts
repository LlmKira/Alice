/**
 * 异步行动队列 — 压力优先级淘汰。
 *
 * ACT 线程从队列取出行动，按序执行。
 * 溢出时淘汰压力最低的行动（而非 FIFO 丢弃最旧），
 * 保证高优先级行动（如 directed 响应）不被低优先级行动挤掉。
 */

import { createLogger } from "../utils/logger.js";
import type { PressureDims } from "../utils/math.js";
import type { VoiceAction } from "../voices/personality.js";

const log = createLogger("action-queue");

export interface ActionQueueItem {
  enqueueTick: number;
  action: VoiceAction;
  target: string | null;
  pressureSnapshot: PressureDims;
  contributions: Record<string, Record<string, number>>;
  /** ADR-26: 赢家声部的焦点集实体 ID。 */
  focalEntities?: string[];
  /** 引擎侧结构化行动理由（机器生成，互补 LLM think()）。 */
  reason?: string;
  /** D8: V-max 评分候选（fan-out 用）。 */
  vmaxScored?: Array<{
    action: string;
    target: string | null;
    V: number;
    bypassGates: boolean;
    bottleneck: string;
  }>;
  /** D8: V-max 候选 spread（fan-out 触发条件）。 */
  vmaxSpread?: number;
  /** ADR-174: 人格面向 ID（驱动 guidance + whisper + example 选择）。 */
  facetId?: string;
  /** ADR-215: 关联 episode ID。act 线程 processResult 用此关闭 episode。 */
  episodeId?: string;
  /** ADR-215: LLM 输出的认知残留（来自 TickStepSchema.residue）。 */
  llmResidue?: import("../llm/schemas.js").LLMResidue;
  /** ADR-258: typed observation spine identity. */
  observation?: {
    candidateId: string;
    enqueueId: string;
    api: number;
    apiPeak: number | null;
  };
}

export interface ActionQueueMetrics {
  queued: number;
  processing: number;
  active: number;
  waitingConsumers: number;
  maxDepth: number;
  overflowCount: number;
  saturation: number;
}

export type ActionQueueEnqueueResult =
  | { outcome: "accepted"; delivery: "queued" | "direct"; evicted?: undefined }
  | { outcome: "rejected_overflow"; delivery: "dropped"; evicted?: undefined }
  | { outcome: "accepted"; delivery: "queued"; evicted: ActionQueueItem };

/** 聚合压力分数：六维压力之和。用于溢出淘汰和调度排序。 */
export function pressureScore(item: ActionQueueItem): number {
  return item.pressureSnapshot.reduce((s, p) => s + p, 0);
}

/**
 * Promise-based 异步优先级队列。
 * enqueue 方可从任意 async 上下文推入，dequeue 方阻塞等待。
 * 溢出时淘汰压力最低的行动（保护高优先级行动）。
 */
export class ActionQueue {
  static readonly MAX_DEPTH = 50;
  private items: ActionQueueItem[] = [];
  private waiters: ((item: ActionQueueItem | null) => void)[] = [];
  private _closed = false;
  /** 累计溢出丢弃次数（可用于运维监控）。 */
  private _overflowCount = 0;
  /**
   * 正在被 ACT 线程处理的目标集合。
   * dequeue() 原子性地将目标加入，markComplete() 释放。
   * 与 items 队列共同构成 Engagement Exclusivity 不变量。
   */
  private processing = new Set<string>();

  /** 推入一个行动。溢出时淘汰压力最低的行动。 */
  enqueue(item: ActionQueueItem): ActionQueueEnqueueResult {
    if (this._closed) return { outcome: "rejected_overflow", delivery: "dropped" };
    if (this.items.length >= ActionQueue.MAX_DEPTH) {
      // 找到队列中压力最低的行动
      let minIdx = 0;
      let minScore = pressureScore(this.items[0]);
      for (let i = 1; i < this.items.length; i++) {
        const score = pressureScore(this.items[i]);
        if (score < minScore) {
          minScore = score;
          minIdx = i;
        }
      }
      const newScore = pressureScore(item);
      this._overflowCount++;
      if (newScore <= minScore) {
        // 新行动优先级最低 → 丢弃新行动（不入队）
        log.warn("ActionQueue overflow, new item rejected (lowest priority)", {
          overflowCount: this._overflowCount,
          newTarget: item.target,
          newScore: newScore.toFixed(2),
        });
        return { outcome: "rejected_overflow", delivery: "dropped" };
      }
      // 淘汰优先级最低的已有行动
      const evicted = this.items.splice(minIdx, 1)[0];
      log.warn("ActionQueue overflow, lowest-priority item evicted", {
        overflowCount: this._overflowCount,
        evictedTick: evicted.enqueueTick,
        evictedTarget: evicted.target,
        evictedScore: minScore.toFixed(2),
        newScore: newScore.toFixed(2),
      });
      this.items.push(item);
      return { outcome: "accepted", delivery: "queued", evicted };
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      // 直接交付路径：条目跳过队列直接被 dequeue 消费者接收。
      // 原子性设置 processing（与 dequeue 的 shift+add 对称）。
      if (item.target) this.processing.add(item.target);
      waiter(item);
      return { outcome: "accepted", delivery: "direct" };
    } else {
      this.items.push(item);
      return { outcome: "accepted", delivery: "queued" };
    }
  }

  /**
   * ADR-130: 非阻塞尝试取出一个行动。队列为空时立即返回 null。
   * 原子性地将目标加入 processing 集合。
   * 用于交错调度器在已有活跃 engagement 时填充空闲槽位。
   */
  tryDequeue(): ActionQueueItem | null {
    if (this.items.length === 0 || this._closed) return null;
    const item = this.items.shift() ?? null;
    if (item?.target) this.processing.add(item.target);
    return item;
  }

  /**
   * 阻塞等待并取出一个行动。关闭后返回 null。
   * 原子性地将目标加入 processing 集合（Node.js 单线程保证同步不可中断）。
   */
  async dequeue(): Promise<ActionQueueItem | null> {
    if (this.items.length > 0) {
      const item = this.items.shift() ?? null;
      if (item?.target) this.processing.add(item.target);
      return item;
    }
    if (this._closed) return null;
    // waiter 路径：processing 在 enqueue 的 waiter(item) 调用前设置
    return new Promise<ActionQueueItem | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** 查看队首元素但不取出（ADR-54: cooldown 决策用）。 */
  peek(): ActionQueueItem | null {
    return this.items[0] ?? null;
  }

  /**
   * Engagement Exclusivity 检查：目标是否有活跃 engagement（队列中 OR 正在处理）。
   * 替代旧的 countByTarget + thinking_target 双重检查。
   */
  isTargetActive(target: string): boolean {
    return this.processing.has(target) || this.items.some((i) => i.target === target);
  }

  /** ADR-182 D3: 是否有正在处理的行动。 */
  hasActive(): boolean {
    return this.processing.size > 0;
  }

  /** ADR-186: 返回所有活跃 engagement 的 target 集合。 */
  getActiveTargets(): ReadonlySet<string> {
    return this.processing;
  }

  /** ADR-252 Wave 1: 只读队列/ACT 背压指标。 */
  getMetrics(): ActionQueueMetrics {
    const queued = this.items.length;
    const processing = this.processing.size;
    const active = queued + processing;
    const maxDepth = ActionQueue.MAX_DEPTH;
    return {
      queued,
      processing,
      active,
      waitingConsumers: this.waiters.length,
      maxDepth,
      overflowCount: this._overflowCount,
      saturation: maxDepth > 0 ? Math.min(1, active / maxDepth) : 0,
    };
  }

  /**
   * 释放 processing 锁。ACT 循环在 finally 块中调用，
   * 保证所有退出路径（staleness skip / 异常 / 正常完成）都释放。
   */
  markComplete(target: string): void {
    this.processing.delete(target);
  }

  /** 当前队列长度。 */
  get length(): number {
    return this.items.length;
  }

  /** 累计溢出次数（监控用）。 */
  get overflowCount(): number {
    return this._overflowCount;
  }

  /** 关闭队列，唤醒所有等待者。 */
  close(): void {
    this._closed = true;
    this.processing.clear();
    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];
  }

  get closed(): boolean {
    return this._closed;
  }
}
