/**
 * ADR-130: Engagement Interleaving 单元测试。
 *
 * 测试覆盖：
 * 1. selectNextEngagement 按紧急度排序
 * 2. checkWatchers 正确清理无活跃 watcher 的 slot
 * 3. MAX_CONCURRENT_ENGAGEMENTS 限制
 * 4. tryDequeue 非阻塞语义
 * 5. 切换代价常量
 * 6. 单 engagement 退化为串行
 * 7. expect_reply 释放调度权
 *
 * @see docs/adr/130-engagement-interleaving.md §Verification
 */

import { describe, expect, it } from "vitest";
import { EngagementSession } from "../src/engine/act/engagement.js";
import {
  checkWatchers,
  type EngagementSlot,
  MAX_CONCURRENT_ENGAGEMENTS,
  SWITCH_COST_MS,
  selectNextEngagement,
  watchPlanFromOutcome,
} from "../src/engine/act/scheduler.js";
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

/** 创建最小 mock EngagementSlot（仅用于调度逻辑测试）。 */
function makeSlot(
  target: string,
  urgency: number,
  state: EngagementSlot["state"] = "ready",
): EngagementSlot {
  return {
    item: makeItem(target, urgency),
    session: new EngagementSession(),
    state,
    urgency,
    resolved: null,
    contextVars: undefined,
    liveMessages: [],
    targetChatId: null,
    targetChannelId: null,
    holdStrength: 3.0,
    graphBefore: { nodeIds: new Set(), attrs: new Map(), edgeCount: 0 },
    startMs: Date.now(),
    watcher: null,
    preempted: false,
  };
}

/** 创建一个 mock ActiveWatcher（不执行真实观察）。 */
function mockWatcher(
  plan: "reply_window" | "linger_window" = "reply_window",
): EngagementSlot["watcher"] {
  return {
    plan,
    handle: { await: () => Promise.resolve({ type: "timeout", elapsed: 0 }), cancel: () => {} },
    promise: new Promise(() => {}), // 永不 resolve
    timeout: 60_000,
  };
}

describe("ADR-130: selectNextEngagement", () => {
  it("从多个 ready slot 中选择紧急度最高的", () => {
    const slots = [makeSlot("channel:a", 3), makeSlot("channel:b", 8), makeSlot("channel:c", 5)];

    const next = selectNextEngagement(slots);
    expect(next).not.toBeNull();
    expect(next?.item.target).toBe("channel:b");
    expect(next?.urgency).toBe(8);
  });

  it("跳过 runtime watch / done 的 slot", () => {
    const slots = [
      makeSlot("channel:a", 10, "reply_watch"),
      makeSlot("channel:b", 5, "done"),
      makeSlot("channel:c", 3, "ready"),
    ];

    const next = selectNextEngagement(slots);
    expect(next).not.toBeNull();
    expect(next?.item.target).toBe("channel:c");
  });

  it("所有 slot 都不是 ready 时返回 null", () => {
    const slots = [makeSlot("channel:a", 10, "reply_watch"), makeSlot("channel:b", 5, "linger_watch")];

    expect(selectNextEngagement(slots)).toBeNull();
  });

  it("单个 slot：退化为串行（行为不变）", () => {
    const slots = [makeSlot("channel:a", 5)];

    const next = selectNextEngagement(slots);
    expect(next).not.toBeNull();
    expect(next?.item.target).toBe("channel:a");
  });

  it("空数组返回 null", () => {
    expect(selectNextEngagement([])).toBeNull();
  });
});

describe("ADR-130: checkWatchers", () => {
  it("无活跃 watcher 的 runtime watch slot 标记为 done", () => {
    const slot = makeSlot("channel:a", 5, "reply_watch");
    // slot.watcher 默认就是 null

    const slots = [slot];
    checkWatchers(slots);

    expect(slot.state).toBe("done");
  });

  it("有活跃 watcher 的 runtime watch slot 保持不变", () => {
    const slot = makeSlot("channel:a", 5, "reply_watch");
    slot.watcher = mockWatcher();

    const slots = [slot];
    checkWatchers(slots);

    expect(slot.state).toBe("reply_watch");
  });

  it("ready 和 done 的 slot 不受影响", () => {
    const readySlot = makeSlot("channel:a", 5, "ready");
    const doneSlot = makeSlot("channel:b", 3, "done");

    const slots = [readySlot, doneSlot];
    checkWatchers(slots);

    expect(readySlot.state).toBe("ready");
    expect(doneSlot.state).toBe("done");
  });
});

describe("ADR-130: watch plan mapping", () => {
  it("waiting_reply → reply_window", () => {
    expect(watchPlanFromOutcome("waiting_reply")).toBe("reply_window");
  });

  it("watching → linger_window", () => {
    expect(watchPlanFromOutcome("watching")).toBe("linger_window");
  });
});

describe("ADR-130: tryDequeue 非阻塞语义", () => {
  it("队列有条目时立即返回", () => {
    const q = new ActionQueue();
    q.enqueue(makeItem("channel:1", 5));

    const item = q.tryDequeue();
    expect(item).not.toBeNull();
    expect(item?.target).toBe("channel:1");
    // processing 追踪生效
    expect(q.isTargetActive("channel:1")).toBe(true);
  });

  it("队列为空时立即返回 null（不阻塞）", () => {
    const q = new ActionQueue();
    const item = q.tryDequeue();
    expect(item).toBeNull();
  });

  it("close 后返回 null", () => {
    const q = new ActionQueue();
    q.enqueue(makeItem("channel:1", 5));
    q.close();

    const item = q.tryDequeue();
    expect(item).toBeNull();
  });

  it("多次 tryDequeue 依次取出", () => {
    const q = new ActionQueue();
    q.enqueue(makeItem("channel:1", 5));
    q.enqueue(makeItem("channel:2", 3));

    const first = q.tryDequeue();
    const second = q.tryDequeue();
    const third = q.tryDequeue();

    expect(first?.target).toBe("channel:1");
    expect(second?.target).toBe("channel:2");
    expect(third).toBeNull();
  });
});

describe("ADR-130: 常量语义", () => {
  it("MAX_CONCURRENT_ENGAGEMENTS = 3", () => {
    expect(MAX_CONCURRENT_ENGAGEMENTS).toBe(3);
  });

  it("SWITCH_COST_MS = 1500", () => {
    expect(SWITCH_COST_MS).toBe(1500);
  });
});

describe("ADR-130: 交错调度行为", () => {
  it("多个 engagement 按紧急度交错", () => {
    // 模拟 3 个群同时 directed
    const slots = [
      makeSlot("channel:a", 8), // 最紧急
      makeSlot("channel:b", 3), // 最不紧急
      makeSlot("channel:c", 5), // 中等
    ];

    // 第一轮：选择最紧急的
    const r1 = selectNextEngagement(slots);
    expect(r1?.item.target).toBe("channel:a");

    // 模拟 channel:a 进入 expect_reply → reply_watch
    r1!.state = "reply_watch";
    r1!.watcher = mockWatcher();

    // 第二轮：跳过 runtime watch 中的 channel:a，选择次紧急的 channel:c
    const r2 = selectNextEngagement(slots);
    expect(r2?.item.target).toBe("channel:c");

    // 模拟 channel:c 完成 → done
    r2!.state = "done";

    // 第三轮：只剩 channel:b 是 ready
    const r3 = selectNextEngagement(slots);
    expect(r3?.item.target).toBe("channel:b");
  });

  it("expect_reply 释放调度权：reply_watch slot 被跳过", () => {
    const waiting = makeSlot("channel:a", 10, "reply_watch");
    waiting.watcher = mockWatcher();
    const ready = makeSlot("channel:b", 2, "ready");

    const next = selectNextEngagement([waiting, ready]);
    // 即使 channel:a 紧急度更高，但它处于 runtime watch，所以选择 channel:b
    expect(next?.item.target).toBe("channel:b");
  });

  it("所有 slot 都在 runtime watch → 无可调度的 engagement", () => {
    const a = makeSlot("channel:a", 10, "reply_watch");
    a.watcher = mockWatcher();
    const b = makeSlot("channel:b", 5, "linger_watch");
    b.watcher = mockWatcher("linger_window");

    expect(selectNextEngagement([a, b])).toBeNull();
  });

  it("done slot 不会被选中", () => {
    const slots = [makeSlot("channel:a", 100, "done"), makeSlot("channel:b", 1, "ready")];

    const next = selectNextEngagement(slots);
    expect(next?.item.target).toBe("channel:b");
  });
});
