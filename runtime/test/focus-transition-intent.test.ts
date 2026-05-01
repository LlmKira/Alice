import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModContext } from "../src/core/types.js";
import { closeDb, getDb, initDb } from "../src/db/connection.js";
import { writeFocusTransitionIntent } from "../src/db/focus-transition-intent.js";
import { focusTransitionIntent } from "../src/db/schema.js";
import { WorldModel } from "../src/graph/world-model.js";
import { observerMod } from "../src/mods/observer.mod.js";

beforeEach(() => initDb(":memory:"));
afterEach(() => closeDb());

function makeCtx(tick = 42): ModContext {
  return {
    graph: new WorldModel(),
    state: { outcomeHistory: [], impressionCounts: {} },
    tick,
    nowMs: 1777356000000,
    getModState: () => undefined,
    dispatch: () => undefined,
  };
}

describe("focus transition intent", () => {
  it("writes an append-only observe intent fact", () => {
    const written = writeFocusTransitionIntent({
      tick: 42,
      sourceChatId: "-1001",
      requestedChatId: "-1002",
      intentKind: "observe",
      reason: "need to inspect context before deciding",
      payload: { source: "test" },
    });

    const row = getDb().select().from(focusTransitionIntent).get();

    expect(row).toMatchObject({
      intentId: written.intentId,
      tick: 42,
      sourceChatId: "-1001",
      requestedChatId: "-1002",
      intentKind: "observe",
      reason: "need to inspect context before deciding",
      sourceCommand: "self.attention-pull",
    });
  });

  it("observer command records intent without mutating graph target state", () => {
    const ctx = makeCtx(43);
    const beforeNodes = ctx.graph.size;

    const result = observerMod.instructions?.attention_pull.impl(ctx, {
      to: "-1003",
      sourceChatId: "-1001",
      reason: "another room is pulling attention",
    });

    expect(result).toBe("Noted. You are still in this chat; no message was sent there.");
    expect(ctx.graph.size).toBe(beforeNodes);
    expect(getDb().select().from(focusTransitionIntent).all()).toHaveLength(1);
  });

  it("switch-chat records a request without mutating graph target state", () => {
    const ctx = makeCtx(44);
    const beforeNodes = ctx.graph.size;

    const result = observerMod.instructions?.switch_chat.impl(ctx, {
      to: "-1004",
      sourceChatId: "-1001",
      reason: "that room needs a reply",
    });

    const row = getDb().select().from(focusTransitionIntent).get();
    expect(result).toBe("Switch requested. You are still in this chat; no message was sent there.");
    expect(ctx.graph.size).toBe(beforeNodes);
    expect(row).toMatchObject({
      tick: 44,
      sourceChatId: "-1001",
      requestedChatId: "-1004",
      intentKind: "switch_request",
      reason: "that room needs a reply",
      sourceCommand: "self.switch-chat",
    });
  });
});
