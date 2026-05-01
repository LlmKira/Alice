import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import type { Dispatcher } from "../src/core/dispatcher.js";
import type { ScriptExecutionResult } from "../src/core/script-execution.js";
import { closeDb, getDb, initDb } from "../src/db/connection.js";
import { listDecisionTraces } from "../src/db/decision-trace.js";
import { actionLog, focusTransitionIntent, focusTransitionShadow } from "../src/db/schema.js";
import { ActionQueue, type ActionQueueItem } from "../src/engine/action-queue.js";
import { processResult } from "../src/engine/react/feedback-arc.js";
import type { ActContext } from "../src/engine/react/orchestrator.js";
import { WorldModel } from "../src/graph/world-model.js";
import { EventBuffer } from "../src/telegram/events.js";
import { PersonalityVector } from "../src/voices/personality.js";

vi.mock("../src/llm/client.js", () => ({
  isAnyProviderHealthy: () => true,
}));

function stubDispatcher(): Dispatcher {
  return {
    dispatch: () => undefined,
    query: () => null,
    getInstructionNames: () => [],
    getInstructionDef: () => undefined,
    getQueryNames: () => [],
    getQueryDef: () => undefined,
    startTick: () => {},
    endTick: () => {},
    collectContributions: () => [],
    generateManual: async () => "",
    mods: [],
    snapshotModStates: () => new Map(),
    restoreModStates: () => {},
    saveModStatesToDb: () => {},
    loadModStatesFromDb: () => false,
    readModState: () => undefined,
  };
}

function makeContext(): ActContext {
  const config = loadConfig();
  const G = new WorldModel();
  G.addAgent("self");
  return {
    client: {} as ActContext["client"],
    G,
    config,
    queue: new ActionQueue(),
    personality: new PersonalityVector(config.piHome),
    getCurrentTick: () => 9,
    getCurrentPressures: () => [0, 0, 0, 0, 0, 0],
    onPersonalityUpdate: () => {},
    dispatcher: stubDispatcher(),
    buffer: new EventBuffer(),
    recordAction: () => {},
    reportLLMOutcome: () => {},
  };
}

function makeContextWithChannel(target: string): ActContext {
  const ctx = makeContext();
  ctx.G.addChannel(target, {
    chat_type: "private",
    consecutive_act_silences: 2,
    pending_directed: 1,
  });
  return ctx;
}

function makeItem(): ActionQueueItem {
  return {
    enqueueTick: 8,
    action: "sociability",
    target: null,
    pressureSnapshot: [0, 0, 0, 0, 0, 0],
    contributions: {},
  };
}

function makeTargetItem(target: string): ActionQueueItem {
  return {
    ...makeItem(),
    target,
  };
}

function makeResult(
  completedActions: string[] = ["sent:chatId=channel:1:msgId=2"],
): ScriptExecutionResult {
  return {
    logs: ["sent ok"],
    errors: [],
    instructionErrors: [],
    errorCodes: [],
    duration: 12,
    thinks: ["reply is useful"],
    queryLogs: [],
    observations: [],
    completedActions,
    silenceReason: null,
  };
}

describe("ACT decision_trace", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("links processResult action_log rows to decision_trace", () => {
    processResult(makeContext(), makeItem(), 9, makeResult(), 0, 1, {
      subcycles: 1,
      durationMs: 25,
      outcome: "complete",
    });

    const actionRows = getDb().select().from(actionLog).all();
    expect(actionRows).toHaveLength(1);

    const traces = listDecisionTraces({ tick: 9, phase: "act" });
    expect(traces).toHaveLength(1);
    expect(traces[0]?.actionLogId).toBe(actionRows[0]?.id);
    expect(traces[0]?.finalDecision).toBe("execute");
    expect(traces[0]?.payload.selectedAction).toBe("sociability");
  });

  it("does not clamp channel silence for provider-unavailable LLM failures", () => {
    const target = "channel:provider-down";
    const ctx = makeContextWithChannel(target);

    processResult(ctx, makeTargetItem(target), 9, makeResult([]), 0, 1, {
      subcycles: 1,
      durationMs: 25,
      outcome: "llm_failed",
      failureKind: "provider_unavailable",
    });

    const channel = ctx.G.getChannel(target);
    expect(channel.consecutive_act_silences).toBe(2);
    expect(channel.pending_directed).toBe(1);
    const actionRows = getDb().select().from(actionLog).all();
    expect(actionRows[0]?.actionType).toBe("provider_failed");
  });

  it("treats completedActions as delivered even when host continuation has errors", () => {
    const target = "channel:sent-but-error";
    const ctx = makeContextWithChannel(target);
    const result = makeResult(["sent:chatId=1:msgId=42"]);

    processResult(
      ctx,
      makeTargetItem(target),
      9,
      result,
      1,
      1,
      {
        subcycles: 1,
        durationMs: 25,
        outcome: "complete",
      },
      {
        toolCallCount: 0,
        budgetExhausted: false,
        afterward: "complete",
        commandLog: '$ irc reply --ref 42 --text "hi"\n✓ Replied to: #42: "hi"',
      },
    );

    const channel = ctx.G.getChannel(target);
    expect(channel.consecutive_act_silences).toBe(0);
    expect(channel.pending_directed).toBe(0);

    const actionRows = getDb().select().from(actionLog).all();
    expect(actionRows[0]?.success).toBe(true);
    expect(actionRows[0]?.actionType).toBe("message");

    const traces = listDecisionTraces({ tick: 9, phase: "act" });
    expect(traces[0]?.finalDecision).toBe("execute");
    const payload = traces[0]?.payload as { hostExecution?: { messageSent?: boolean } };
    expect(payload.hostExecution?.messageSent).toBe(true);
  });

  it("keeps action_type as message when a sent action is followed by llm_failed outcome", () => {
    const target = "channel:sent-before-llm-failed";
    const ctx = makeContextWithChannel(target);
    const result = makeResult(["sent:chatId=1:msgId=42"]);

    processResult(ctx, makeTargetItem(target), 9, result, 0, 1, {
      subcycles: 2,
      durationMs: 50,
      outcome: "llm_failed",
    });

    const actionRows = getDb().select().from(actionLog).all();
    expect(actionRows[0]?.actionType).toBe("message");
    expect(actionRows[0]?.success).toBe(true);
    expect(actionRows[0]?.engagementOutcome).toBe("llm_failed");
  });

  it("does not treat command misuse as social silence", () => {
    const target = "channel:command-misuse";
    const ctx = makeContextWithChannel(target);
    const result = makeResult([]);
    result.errorCodes.push("command_cross_chat_send");

    processResult(
      ctx,
      makeTargetItem(target),
      9,
      result,
      1,
      1,
      {
        subcycles: 1,
        durationMs: 25,
        outcome: "complete",
      },
      {
        toolCallCount: 0,
        budgetExhausted: false,
        afterward: "watching",
        commandLog: '$ irc say --in -1001 --text "hi"\nerror\n✗ irc: refusing cross-chat send',
      },
    );

    const channel = ctx.G.getChannel(target);
    expect(channel.consecutive_act_silences).toBe(2);
    expect(channel.pending_directed).toBe(1);
    const actionRows = getDb().select().from(actionLog).all();
    expect(actionRows[0]?.actionType).toBe("command_misuse");
    expect(actionRows[0]?.success).toBe(false);
  });

  it("marks typed Telegram soft permanent failures as unreachable and clears target-local obligations", () => {
    const target = "channel:telegram-peer-invalid";
    const ctx = makeContextWithChannel(target);
    const result = makeResult([]);
    result.errors = ["send_text failed: telegram target is unreachable"];
    result.errorCodes = ["telegram_soft_permanent"];

    processResult(ctx, makeTargetItem(target), 9, result, 1, 1, {
      subcycles: 1,
      durationMs: 25,
      outcome: "complete",
    });

    const channel = ctx.G.getChannel(target);
    expect(channel.failure_type).toBe("permanent");
    expect(channel.failure_subtype).toBe("soft");
    expect(channel.reachability_score).toBeLessThan(1);
    expect(channel.pending_directed).toBe(0);
    expect(channel.mentions_alice).toBe(false);

    const actionRows = getDb().select().from(actionLog).all();
    expect(actionRows[0]?.actionType).toBe("telegram_failed");
    expect(actionRows[0]?.success).toBe(false);
  });

  it("writes structured focus transition shadow facts for rejected cross-chat sends", () => {
    const target = "channel:command-misuse";
    const ctx = makeContextWithChannel(target);
    const result = makeResult([]);
    result.errorCodes.push("command_cross_chat_send");
    result.errorDetails = [
      {
        code: "command_cross_chat_send",
        source: "irc.reply",
        currentChatId: "-1001",
        requestedChatId: "-1002",
        payload: { replyTo: 9 },
      },
    ];

    processResult(
      ctx,
      makeTargetItem(target),
      9,
      result,
      1,
      1,
      {
        subcycles: 1,
        durationMs: 25,
        outcome: "complete",
      },
      {
        toolCallCount: 0,
        budgetExhausted: false,
        afterward: "watching",
        commandLog: '$ irc reply --in -1002 --ref 9 --text "hi"',
      },
    );

    const shadows = getDb().select().from(focusTransitionShadow).all();
    const intents = getDb().select().from(focusTransitionIntent).all();
    expect(shadows).toHaveLength(1);
    expect(shadows[0]).toMatchObject({
      tick: 9,
      candidateId: null,
      sourceTarget: target,
      currentChatId: "-1001",
      requestedChatId: "-1002",
      sourceCommand: "irc.reply",
      transitionClass: "switch_then_send_shadow",
      evidenceStatus: "structured_requested_target",
    });
    expect(JSON.parse(shadows[0]?.payloadJson ?? "{}")).toEqual({ replyTo: 9 });
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      intentId: "blocked_switch_request:action:1:0",
      tick: 9,
      sourceChatId: "-1001",
      requestedChatId: "-1002",
      intentKind: "switch_request_blocked",
      sourceCommand: "irc.reply",
    });
    expect(JSON.parse(intents[0]?.payloadJson ?? "{}")).toMatchObject({
      actionId: "action:1",
      attemptedCommand: "irc.reply",
      attemptedPayload: { replyTo: 9 },
    });
  });

  it("writes structured focus transition shadow facts for remote observations", () => {
    const target = "channel:-1001";
    const ctx = makeContextWithChannel(target);
    const result = makeResult([]);
    result.observations = [
      {
        kind: "new_message_context",
        source: "irc.tail",
        text: "[tail @-1002]",
        enablesContinuation: true,
        currentChatId: "-1001",
        targetChatId: "-1002",
        payload: { count: 5, messageCount: 2 },
      },
    ];

    processResult(
      ctx,
      makeTargetItem(target),
      9,
      result,
      1,
      1,
      {
        subcycles: 1,
        durationMs: 25,
        outcome: "complete",
      },
      {
        toolCallCount: 0,
        budgetExhausted: false,
        afterward: "watching",
        commandLog: "$ irc tail --in -1002 --count 5",
      },
    );

    const shadows = getDb().select().from(focusTransitionShadow).all();
    expect(shadows).toHaveLength(1);
    expect(shadows[0]).toMatchObject({
      currentChatId: "-1001",
      requestedChatId: "-1002",
      sourceCommand: "irc.tail",
      transitionClass: "observe_shadow",
      evidenceStatus: "structured_observation_target",
    });
    expect(JSON.parse(shadows[0]?.payloadJson ?? "{}")).toEqual({
      kind: "new_message_context",
      count: 5,
      messageCount: 2,
    });
  });

  it("writes structured focus transition shadow facts for forwarded shares", () => {
    const target = "channel:-1001";
    const ctx = makeContextWithChannel(target);
    const result = makeResult(["forwarded:from=-1001:to=-1002:msgId=42"]);

    processResult(
      ctx,
      makeTargetItem(target),
      9,
      result,
      1,
      1,
      {
        subcycles: 1,
        durationMs: 25,
        outcome: "complete",
      },
      {
        toolCallCount: 0,
        budgetExhausted: false,
        afterward: "waiting_reply",
        commandLog: "$ irc forward --from -1001 --ref 7 --to -1002",
      },
    );

    const shadows = getDb().select().from(focusTransitionShadow).all();
    expect(shadows).toHaveLength(1);
    expect(shadows[0]).toMatchObject({
      sourceTarget: target,
      currentChatId: "-1001",
      requestedChatId: "-1002",
      sourceCommand: "irc.forward",
      transitionClass: "share_shadow",
      evidenceStatus: "structured_completed_action",
    });
    expect(JSON.parse(shadows[0]?.payloadJson ?? "{}")).toEqual({
      authorizedChatId: "-1001",
      fromChatId: "-1001",
      toChatId: "-1002",
      msgId: "42",
    });
  });

  it("records terminal silence as stop, not execute", () => {
    const result = makeResult([]);
    result.silenceReason = "no_executable_script";

    processResult(makeContext(), makeItem(), 9, result, 0, 1, {
      subcycles: 1,
      durationMs: 25,
      outcome: "complete",
    });

    const actionRows = getDb().select().from(actionLog).all();
    expect(actionRows[0]?.actionType).toBe("silence");
    expect(actionRows[0]?.success).toBe(true);

    const traces = listDecisionTraces({ tick: 9, phase: "act" });
    expect(traces[0]?.finalDecision).toBe("stop");
  });
});
