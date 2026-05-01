/**
 * ActionQueue 单元测试 — Engagement Exclusivity 不变量。
 *
 * 核心不变量：任何时刻，每个目标最多有一个活跃 engagement（队列中 OR 正在处理）。
 * dequeue() 原子性设置 processing，markComplete() 释放。
 */

import { describe, expect, it } from "vitest";
import { ActionQueue, type ActionQueueItem } from "../src/engine/action-queue.js";
import type { PressureDims } from "../src/utils/math.js";

function makeItem(target: string | null, pressure = 1): ActionQueueItem {
  const dims: PressureDims = [pressure, 0, 0, 0, 0, 0];
  return {
    enqueueTick: 1,
    action: "sociability",
    target,
    pressureSnapshot: dims,
    contributions: {},
  };
}

describe("ActionQueue — Engagement Exclusivity", () => {
  it("isTargetActive: 队列中有条目时返回 true", () => {
    const q = new ActionQueue();
    q.enqueue(makeItem("channel:1"));
    expect(q.isTargetActive("channel:1")).toBe(true);
    expect(q.isTargetActive("channel:2")).toBe(false);
  });

  it("isTargetActive: dequeue 后仍返回 true（processing 追踪）", async () => {
    const q = new ActionQueue();
    q.enqueue(makeItem("channel:1"));

    const item = await q.dequeue();
    expect(item).not.toBeNull();
    // 条目已从 items 移除，但 processing 追踪生效
    expect(q.length).toBe(0);
    expect(q.isTargetActive("channel:1")).toBe(true);
  });

  it("isTargetActive: markComplete 后返回 false", async () => {
    const q = new ActionQueue();
    q.enqueue(makeItem("channel:1"));

    await q.dequeue();
    q.markComplete("channel:1");
    expect(q.isTargetActive("channel:1")).toBe(false);
  });

  it("isTargetActive: null target 不追踪", async () => {
    const q = new ActionQueue();
    q.enqueue(makeItem(null));

    // null target 不影响任何具体 target 的活跃状态
    expect(q.isTargetActive("channel:1")).toBe(false);

    const item = await q.dequeue();
    expect(item).not.toBeNull();
    // null target 不加入 processing
    expect(q.isTargetActive("channel:1")).toBe(false);
  });

  it("waiter 直接交付路径也正确设置 processing", async () => {
    const q = new ActionQueue();

    // 先 dequeue（注册 waiter），再 enqueue（直接交付）
    const dequeuePromise = q.dequeue();
    expect(q.getMetrics()).toMatchObject({
      queued: 0,
      processing: 0,
      active: 0,
      waitingConsumers: 1,
      maxDepth: ActionQueue.MAX_DEPTH,
      overflowCount: 0,
      saturation: 0,
    });

    q.enqueue(makeItem("channel:1"));

    const item = await dequeuePromise;
    expect(item).not.toBeNull();
    expect(item?.target).toBe("channel:1");
    // 直接交付路径也设置了 processing
    expect(q.isTargetActive("channel:1")).toBe(true);
    expect(q.getMetrics()).toMatchObject({
      queued: 0,
      processing: 1,
      active: 1,
      waitingConsumers: 0,
      saturation: 1 / ActionQueue.MAX_DEPTH,
    });

    q.markComplete("channel:1");
    expect(q.isTargetActive("channel:1")).toBe(false);
    expect(q.getMetrics()).toMatchObject({
      queued: 0,
      processing: 0,
      active: 0,
      waitingConsumers: 0,
      saturation: 0,
    });
  });

  it("engagement 抢占 requeue: processing + queue 双重追踪", async () => {
    const q = new ActionQueue();
    q.enqueue(makeItem("channel:1"));

    // act 线程 dequeue（进入 processing）
    await q.dequeue();
    expect(q.isTargetActive("channel:1")).toBe(true);

    // engagement 期间被抢占 → requeue 同一目标
    q.enqueue(makeItem("channel:1"));
    // processing + queue 双重存在
    expect(q.isTargetActive("channel:1")).toBe(true);

    // markComplete 释放 processing，但 queue 中仍有条目
    q.markComplete("channel:1");
    expect(q.isTargetActive("channel:1")).toBe(true);

    // 第二次 dequeue + markComplete 后完全释放
    await q.dequeue();
    q.markComplete("channel:1");
    expect(q.isTargetActive("channel:1")).toBe(false);
  });

  it("countByTarget 不再存在（编译级保证）", () => {
    const q = new ActionQueue();
    // @ts-expect-error — countByTarget 已删除
    expect(typeof q.countByTarget).toBe("undefined");
  });

  it("close 后 dequeue 返回 null 且不设置 processing", async () => {
    const q = new ActionQueue();
    q.close();

    // close 后 dequeue 立即返回 null
    const item = await q.dequeue();
    expect(item).toBeNull();

    // close 后 enqueue 被忽略
    q.enqueue(makeItem("channel:2"));
    expect(q.isTargetActive("channel:2")).toBe(false);
  });

  it("close 清理 processing 集合", async () => {
    const q = new ActionQueue();
    q.enqueue(makeItem("channel:1"));

    // dequeue 将 channel:1 加入 processing
    await q.dequeue();
    expect(q.isTargetActive("channel:1")).toBe(true);

    // close 清理 processing
    q.close();
    expect(q.isTargetActive("channel:1")).toBe(false);
  });
});

describe("ActionQueue — metrics", () => {
  it("getMetrics 覆盖 enqueue、dequeue、markComplete 生命周期", async () => {
    const q = new ActionQueue();

    q.enqueue(makeItem("channel:1"));
    q.enqueue(makeItem("channel:2"));
    expect(q.getMetrics()).toMatchObject({
      queued: 2,
      processing: 0,
      active: 2,
      waitingConsumers: 0,
      maxDepth: ActionQueue.MAX_DEPTH,
      overflowCount: 0,
      saturation: 2 / ActionQueue.MAX_DEPTH,
    });

    const item = await q.dequeue();
    expect(item?.target).toBe("channel:1");
    expect(q.getMetrics()).toMatchObject({
      queued: 1,
      processing: 1,
      active: 2,
      saturation: 2 / ActionQueue.MAX_DEPTH,
    });

    q.markComplete("channel:1");
    expect(q.getMetrics()).toMatchObject({
      queued: 1,
      processing: 0,
      active: 1,
      saturation: 1 / ActionQueue.MAX_DEPTH,
    });
  });

  it("getMetrics 记录 overflowCount 且饱和度封顶为 1", () => {
    const q = new ActionQueue();

    for (let i = 0; i < ActionQueue.MAX_DEPTH; i++) {
      q.enqueue(makeItem(`channel:${i}`, 2));
    }
    expect(q.getMetrics()).toMatchObject({
      queued: ActionQueue.MAX_DEPTH,
      active: ActionQueue.MAX_DEPTH,
      overflowCount: 0,
      saturation: 1,
    });

    q.enqueue(makeItem("channel:rejected", 1));
    expect(q.getMetrics()).toMatchObject({
      queued: ActionQueue.MAX_DEPTH,
      active: ActionQueue.MAX_DEPTH,
      overflowCount: 1,
      saturation: 1,
    });
  });

  it("getMetrics 覆盖 close 唤醒等待者并清理 processing", async () => {
    const q = new ActionQueue();
    q.enqueue(makeItem("channel:1"));
    await q.dequeue();
    const waiter = q.dequeue();

    expect(q.getMetrics()).toMatchObject({
      queued: 0,
      processing: 1,
      active: 1,
      waitingConsumers: 1,
    });

    q.close();
    expect(await waiter).toBeNull();
    expect(q.getMetrics()).toMatchObject({
      queued: 0,
      processing: 0,
      active: 0,
      waitingConsumers: 0,
      overflowCount: 0,
      saturation: 0,
    });
  });
});
