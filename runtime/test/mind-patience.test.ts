import { describe, expect, it } from "vitest";
import { patience } from "../src/mechanisms/patience.js";
import type { Effect } from "../src/mind/effects.js";
import type { AliceEvent, MessageReceived } from "../src/mind/events.js";
import { type AliceState, emptyState, PATIENCE_CAP_MS } from "../src/mind/state.js";
import { step } from "../src/mind/step.js";
import { replay } from "../src/sim/replay.js";
import { directedWake } from "./directed-wake.js";

const T0 = 1_771_000_000_000;
const active = [directedWake, patience];

function msg(id: string, at: number, directed = true): MessageReceived {
  return {
    type: "message.received",
    at,
    scope: "telegram:1",
    chatType: "private",
    messageId: id,
    senderId: "u",
    senderName: "池塘",
    text: id,
    contentType: "text",
    replyToMessageId: null,
    directed,
  };
}

function run(events: AliceEvent[]) {
  let state: AliceState = emptyState;
  const effects: Effect[] = [];
  for (const e of events) {
    const r = step(state, e, active);
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects };
}

describe("patience", () => {
  it("waits for a quiet stretch instead of answering at once", () => {
    const { state, effects } = run([msg("1", T0)]);
    expect(effects).toEqual([
      {
        type: "set-timer",
        scope: "telegram:1",
        timerId: `telegram:1~${T0 + 15_000}`,
        at: T0 + 15_000,
      },
    ]);
    expect(state.chats["telegram:1"]?.mind.mode).toBe("waiting");
  });

  it("restarts the wait when the other side keeps typing, and ignores the stale timer", () => {
    const { effects } = run([
      msg("1", T0),
      msg("2", T0 + 5_000),
      {
        type: "timer.fired",
        at: T0 + 15_000,
        scope: "telegram:1",
        timerId: `telegram:1~${T0 + 15_000}`,
      },
      {
        type: "timer.fired",
        at: T0 + 20_000,
        scope: "telegram:1",
        timerId: `telegram:1~${T0 + 20_000}`,
      },
    ]);
    expect(effects.map((e) => e.type)).toEqual(["set-timer", "set-timer", "call-speech"]);
    const call = effects[2];
    expect(call?.type === "call-speech" && call.request.triggerMessageId).toBe("2");
    expect(call?.type === "call-speech" && call.request.timeline).toHaveLength(2);
  });

  it("never waits longer than the cap", () => {
    const events: AliceEvent[] = [];
    for (let i = 0; i < 20; i++) events.push(msg(String(i), T0 + i * 10_000));
    const { effects } = run(events);
    const last = effects.filter((e) => e.type === "set-timer").at(-1);
    expect(last?.type === "set-timer" && last.at).toBe(T0 + PATIENCE_CAP_MS);
  });

  it("turns a burst into one speech call during replay", async () => {
    const events = [msg("1", T0), msg("2", T0 + 3_000), msg("3", T0 + 6_000)];
    const result = await replay(events, {
      mechanisms: active,
      speech: () => ({ acts: [{ kind: "send", text: "嗯", replyTo: null }] }),
    });
    expect(result.effects.filter((r) => r.effect.type === "call-speech")).toHaveLength(1);
    expect(result.effects.filter((r) => r.effect.type === "act")).toHaveLength(1);
  });
});
