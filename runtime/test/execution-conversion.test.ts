import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, initDb } from "../src/db/connection.js";
import {
  actionLog,
  actionResult,
  candidateTrace,
  focusTransitionIntent,
  focusTransitionShadow,
  queueTrace,
  tickLog,
} from "../src/db/schema.js";
import {
  analyzeExecutionConversion,
  renderExecutionConversionReport,
} from "../src/diagnostics/execution-conversion.js";

beforeEach(() => initDb(":memory:"));
afterEach(() => closeDb());

function insertCandidate(input: { id: string; tick: number; action: string; gatePlane: string }) {
  getDb()
    .insert(candidateTrace)
    .values({
      candidateId: input.id,
      tick: input.tick,
      targetNamespace: "channel",
      targetId: "test",
      actionType: input.action,
      normalizedConsiderationsJson: "{}",
      gatePlane: input.gatePlane,
      selected: true,
      silenceReason: "N/A",
      sampleStatus: "real",
    })
    .run();
}

function insertQueue(input: {
  candidateId: string;
  tick: number;
  fate: string;
  reasonCode?: string;
}) {
  getDb()
    .insert(queueTrace)
    .values({
      queueTraceId: `queue:${input.candidateId}:${input.fate}:${input.tick}`,
      tick: input.tick,
      candidateId: input.candidateId,
      enqueueId: `enqueue:${input.candidateId}`,
      enqueueOutcome: "accepted",
      fate: input.fate,
      reasonCode: input.reasonCode ?? "test",
    })
    .run();
}

function insertResult(input: {
  candidateId: string;
  tick: number;
  action: string;
  result: "success" | "typed_failure" | "no_op" | "cancelled" | "unknown_legacy";
  actionLogId?: number;
  failureCode?: string;
  completedActionRefsJson?: string;
}) {
  getDb()
    .insert(actionResult)
    .values({
      actionId: `action:${input.candidateId}`,
      tick: input.tick,
      candidateId: input.candidateId,
      actionLogId: input.actionLogId,
      targetNamespace: "channel",
      targetId: "test",
      actionType: input.action,
      result: input.result,
      failureCode: input.failureCode ?? (input.result === "success" ? "N/A" : "test_failure"),
      completedActionRefsJson: input.completedActionRefsJson ?? "[]",
    })
    .run();
}

function insertActionLog(input: {
  tick: number;
  voice: string;
  actionType: string;
  success: boolean;
  tcAfterward?: string;
  target?: string;
  reasoning?: string;
  tcCommandLog?: string;
}): number {
  return getDb()
    .insert(actionLog)
    .values({
      tick: input.tick,
      voice: input.voice,
      target: input.target,
      actionType: input.actionType,
      reasoning: input.reasoning,
      success: input.success,
      tcAfterward: input.tcAfterward,
      tcCommandLog: input.tcCommandLog,
    })
    .returning({ id: actionLog.id })
    .get().id;
}

describe("analyzeExecutionConversion", () => {
  it("keeps normal IAUS and directed override conversion separated", () => {
    insertCandidate({ id: "c1", tick: 1, action: "curiosity", gatePlane: "none" });
    insertQueue({ candidateId: "c1", tick: 1, fate: "executed" });
    insertResult({ candidateId: "c1", tick: 1, action: "curiosity", result: "success" });

    insertCandidate({ id: "c2", tick: 2, action: "curiosity", gatePlane: "none" });
    insertQueue({ candidateId: "c2", tick: 2, fate: "executed" });
    insertResult({ candidateId: "c2", tick: 2, action: "curiosity", result: "no_op" });

    insertCandidate({ id: "c3", tick: 3, action: "diligence", gatePlane: "directed_override" });
    insertQueue({ candidateId: "c3", tick: 3, fate: "executed" });
    insertResult({ candidateId: "c3", tick: 3, action: "diligence", result: "typed_failure" });

    const report = analyzeExecutionConversion();

    const normal = report.planeSummaries.find((row) => row.gatePlane === "none");
    const directed = report.planeSummaries.find((row) => row.gatePlane === "directed_override");
    expect(normal).toMatchObject({
      selected: 2,
      executed: 2,
      success: 1,
      noOp: 1,
      typedFailure: 0,
    });
    expect(directed).toMatchObject({
      selected: 1,
      executed: 1,
      success: 0,
      noOp: 0,
      typedFailure: 1,
    });
  });

  it("does not count accepted-only queue rows as executed action results", () => {
    insertCandidate({ id: "c4", tick: 4, action: "sociability", gatePlane: "none" });
    insertQueue({ candidateId: "c4", tick: 4, fate: "accepted" });

    insertCandidate({ id: "c5", tick: 5, action: "diligence", gatePlane: "none" });

    const report = analyzeExecutionConversion();
    const normal = report.planeSummaries.find((row) => row.gatePlane === "none");

    expect(normal).toMatchObject({
      selected: 2,
      executed: 0,
      acceptedOnly: 1,
      missingQueue: 1,
      missingResult: 2,
    });
    expect(report.detailRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionType: "sociability",
          queueFate: "accepted_only",
          actionResult: "missing",
          count: 1,
        }),
        expect.objectContaining({
          actionType: "diligence",
          queueFate: "missing",
          actionResult: "missing",
          count: 1,
        }),
      ]),
    );
  });

  it("reports no-op and typed-failure causes from action_log and action_result", () => {
    const noOpActionId = insertActionLog({
      tick: 6,
      voice: "curiosity",
      actionType: "observe",
      success: true,
      tcAfterward: "watching",
    });
    insertCandidate({ id: "c6", tick: 6, action: "curiosity", gatePlane: "none" });
    insertQueue({ candidateId: "c6", tick: 6, fate: "executed" });
    insertResult({
      candidateId: "c6",
      tick: 6,
      action: "curiosity",
      result: "no_op",
      actionLogId: noOpActionId,
    });

    const failureActionId = insertActionLog({
      tick: 7,
      voice: "diligence",
      actionType: "command_misuse",
      success: false,
      target: "channel:1",
      tcAfterward: "waiting_reply",
      reasoning: "wanted to answer another chat",
      tcCommandLog: 'irc reply --in -1002 --ref 9 --text "hi"',
    });
    insertCandidate({ id: "c7", tick: 7, action: "diligence", gatePlane: "directed_override" });
    insertQueue({ candidateId: "c7", tick: 7, fate: "executed" });
    insertResult({
      candidateId: "c7",
      tick: 7,
      action: "diligence",
      result: "typed_failure",
      actionLogId: failureActionId,
      failureCode: "command_cross_chat_send",
    });

    const report = analyzeExecutionConversion();

    expect(report.outcomeRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gatePlane: "none",
          candidateAction: "curiosity",
          actionResult: "no_op",
          actionLogType: "observe",
          tcAfterward: "watching",
          completedActionKind: "empty",
          count: 1,
        }),
        expect.objectContaining({
          gatePlane: "directed_override",
          candidateAction: "diligence",
          actionResult: "typed_failure",
          actionLogType: "command_misuse",
          tcAfterward: "waiting_reply",
          failureCode: "command_cross_chat_send",
          count: 1,
        }),
      ]),
    );
    expect(report.failureUseCases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          useCase: "safety_boundary_cross_chat",
          failureCode: "command_cross_chat_send",
          actionLogType: "command_misuse",
          gatePlane: "directed_override",
          candidateAction: "diligence",
          count: 1,
          exampleTarget: "channel:1",
          exampleReasoning: "wanted to answer another chat",
        }),
      ]),
    );
  });

  it("reports cross-chat send failures as shadow transition evidence without structured requested target", () => {
    const actionLogId = insertActionLog({
      tick: 8,
      voice: "curiosity",
      actionType: "command_misuse",
      success: false,
      target: "channel:current",
      tcAfterward: "watching",
      reasoning: "wanted to answer another chat",
      tcCommandLog: 'irc reply --in -1002 --ref 9 --text "hi"',
    });
    insertCandidate({ id: "c8", tick: 8, action: "curiosity", gatePlane: "none" });
    insertQueue({ candidateId: "c8", tick: 8, fate: "executed" });
    insertResult({
      candidateId: "c8",
      tick: 8,
      action: "curiosity",
      result: "typed_failure",
      actionLogId,
      failureCode: "command_cross_chat_send",
    });

    const report = analyzeExecutionConversion();

    expect(report.transitionShadows).toEqual([
      expect.objectContaining({
        transitionClass: "switch_or_answer_other_chat",
        evidenceStatus: "requested_target_not_structured",
        sourceCommand: "",
        currentChatId: "",
        requestedChatId: "",
        gatePlane: "none",
        candidateAction: "curiosity",
        tcAfterward: "watching",
        count: 1,
        exampleCurrentTarget: "channel:current",
        exampleReasoning: "wanted to answer another chat",
      }),
    ]);
    expect(Object.keys(report.transitionShadows[0])).not.toContain("requestedTarget");
  });

  it("uses structured shadow facts when execution boundary emitted requested target", () => {
    const actionLogId = insertActionLog({
      tick: 9,
      voice: "diligence",
      actionType: "command_misuse",
      success: false,
      target: "channel:current",
      tcAfterward: "waiting_reply",
      reasoning: "needs to answer a different chat",
      tcCommandLog: 'irc reply --in -1002 --ref 9 --text "hi"',
    });
    insertCandidate({ id: "c9", tick: 9, action: "diligence", gatePlane: "directed_override" });
    insertQueue({ candidateId: "c9", tick: 9, fate: "executed" });
    insertResult({
      candidateId: "c9",
      tick: 9,
      action: "diligence",
      result: "typed_failure",
      actionLogId,
      failureCode: "command_cross_chat_send",
    });
    getDb()
      .insert(focusTransitionShadow)
      .values({
        transitionShadowId: "focus_shadow:action:c9:0",
        tick: 9,
        actionId: "action:c9",
        actionLogId,
        candidateId: "c9",
        sourceTarget: "channel:current",
        currentChatId: "-1001",
        requestedChatId: "-1002",
        sourceCommand: "irc.reply",
        transitionClass: "switch_then_send_shadow",
        evidenceStatus: "structured_requested_target",
        payloadJson: JSON.stringify({ replyTo: 9 }),
      })
      .run();

    insertCandidate({ id: "c12", tick: 12, action: "sociability", gatePlane: "none" });
    insertQueue({ candidateId: "c12", tick: 12, fate: "executed" });
    insertResult({
      candidateId: "c12",
      tick: 12,
      action: "sociability",
      result: "success",
    });

    const report = analyzeExecutionConversion();

    expect(report.transitionShadows).toEqual([
      expect.objectContaining({
        transitionClass: "switch_then_send_shadow",
        evidenceStatus: "structured_requested_target",
        sourceCommand: "irc.reply",
        currentChatId: "-1001",
        requestedChatId: "-1002",
        gatePlane: "directed_override",
        candidateAction: "diligence",
        tcAfterward: "waiting_reply",
        count: 1,
      }),
    ]);

    const rendered = renderExecutionConversionReport(report);
    expect(rendered).toContain("structured transition evidence:");
    expect(rendered).toContain("source=irc.reply");
    expect(rendered).toContain("requested=@-1002");
    expect(rendered).toContain("focus path projection:");
    expect(report.focusPathProjection.transitionRows).toEqual([
      expect.objectContaining({
        pathLength: 2,
        originChatId: "-1001",
        requestedChatId: "-1002",
        transitionClass: "switch_then_send_shadow",
        evidenceStrength: "strong",
        pathOutcome: "failed",
        contaminationFlags: "",
      }),
    ]);
  });

  it("reports structured observe and share shadow facts", () => {
    const observeLogId = insertActionLog({
      tick: 10,
      voice: "diligence",
      actionType: "observe",
      success: true,
      target: "channel:-1001",
      tcAfterward: "watching",
      reasoning: "looked at another room before deciding",
      tcCommandLog: "irc tail --in -1002 --count 5",
    });
    insertCandidate({ id: "c10", tick: 10, action: "diligence", gatePlane: "directed_override" });
    insertQueue({ candidateId: "c10", tick: 10, fate: "executed" });
    insertResult({
      candidateId: "c10",
      tick: 10,
      action: "diligence",
      result: "no_op",
      actionLogId: observeLogId,
    });
    getDb()
      .insert(focusTransitionShadow)
      .values({
        transitionShadowId: "focus_shadow:action:c10:observation:0",
        tick: 10,
        actionId: "action:c10",
        actionLogId: observeLogId,
        candidateId: "c10",
        sourceTarget: "channel:-1001",
        currentChatId: "-1001",
        requestedChatId: "-1002",
        sourceCommand: "irc.tail",
        transitionClass: "observe_shadow",
        evidenceStatus: "structured_observation_target",
        payloadJson: JSON.stringify({ kind: "new_message_context", count: 5 }),
      })
      .run();

    const shareLogId = insertActionLog({
      tick: 11,
      voice: "curiosity",
      actionType: "message",
      success: true,
      target: "channel:-1001",
      tcAfterward: "waiting_reply",
      reasoning: "shared a useful post",
      tcCommandLog: "irc forward --from -1001 --ref 7 --to -1003",
    });
    insertCandidate({ id: "c11", tick: 11, action: "curiosity", gatePlane: "none" });
    insertQueue({ candidateId: "c11", tick: 11, fate: "executed" });
    insertResult({
      candidateId: "c11",
      tick: 11,
      action: "curiosity",
      result: "success",
      actionLogId: shareLogId,
      completedActionRefsJson: JSON.stringify(["forwarded:from=-1001:to=-1003:msgId=9"]),
    });
    getDb()
      .insert(focusTransitionShadow)
      .values({
        transitionShadowId: "focus_shadow:action:c11:completed:0",
        tick: 11,
        actionId: "action:c11",
        actionLogId: shareLogId,
        candidateId: "c11",
        sourceTarget: "channel:-1001",
        currentChatId: "-1001",
        requestedChatId: "-1003",
        sourceCommand: "irc.forward",
        transitionClass: "share_shadow",
        evidenceStatus: "structured_completed_action",
        payloadJson: JSON.stringify({ fromChatId: "-1001", toChatId: "-1003", msgId: "9" }),
      })
      .run();

    insertCandidate({ id: "c12", tick: 12, action: "sociability", gatePlane: "none" });
    insertQueue({ candidateId: "c12", tick: 12, fate: "executed" });
    insertResult({
      candidateId: "c12",
      tick: 12,
      action: "sociability",
      result: "success",
    });

    const report = analyzeExecutionConversion();

    expect(report.transitionShadows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          transitionClass: "observe_shadow",
          evidenceStatus: "structured_observation_target",
          sourceCommand: "irc.tail",
          currentChatId: "-1001",
          requestedChatId: "-1002",
          gatePlane: "directed_override",
          candidateAction: "diligence",
          count: 1,
        }),
        expect.objectContaining({
          transitionClass: "share_shadow",
          evidenceStatus: "structured_completed_action",
          sourceCommand: "irc.forward",
          currentChatId: "-1001",
          requestedChatId: "-1003",
          gatePlane: "none",
          candidateAction: "curiosity",
          count: 1,
        }),
      ]),
    );

    const rendered = renderExecutionConversionReport(report);
    expect(rendered).toContain("observe_shadow");
    expect(rendered).toContain("share_shadow");
    expect(report.focusPathProjection.summaryRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pathLength: 1,
          transitionClass: "point_target",
          evidenceStrength: "strong",
          pathOutcome: "completed",
          count: 1,
        }),
        expect.objectContaining({
          pathLength: 2,
          transitionClass: "observe_shadow",
          evidenceStrength: "strong",
          pathOutcome: "completed",
          count: 1,
        }),
        expect.objectContaining({
          pathLength: 2,
          transitionClass: "share_shadow",
          evidenceStrength: "strong",
          pathOutcome: "completed",
          count: 1,
        }),
      ]),
    );
  });

  it("marks mixed and continuation-merged transition projections without authorizing behavior", () => {
    const actionLogId = insertActionLog({
      tick: 12,
      voice: "diligence",
      actionType: "message",
      success: true,
      target: "channel:-1001",
      tcAfterward: "watching",
      reasoning: "sent locally and then tried to answer another chat",
      tcCommandLog: "local send then remote attempt",
    });
    getDb()
      .update(actionLog)
      .set({ tcHostContinuationTrace: JSON.stringify(["error_recovery"]) })
      .where(eq(actionLog.id, actionLogId))
      .run();
    insertCandidate({ id: "c12", tick: 12, action: "diligence", gatePlane: "directed_override" });
    insertQueue({ candidateId: "c12", tick: 12, fate: "executed" });
    insertResult({
      candidateId: "c12",
      tick: 12,
      action: "diligence",
      result: "success",
      actionLogId,
      completedActionRefsJson: JSON.stringify(["sent:chatId=-1001:msgId=1"]),
    });
    getDb()
      .insert(focusTransitionShadow)
      .values({
        transitionShadowId: "focus_shadow:action:c12:0",
        tick: 12,
        actionId: "action:c12",
        actionLogId,
        candidateId: "c12",
        sourceTarget: "channel:-1001",
        currentChatId: "-1001",
        requestedChatId: "-1002",
        sourceCommand: "irc.reply",
        transitionClass: "switch_then_send_shadow",
        evidenceStatus: "structured_requested_target",
        payloadJson: JSON.stringify({ replyTo: 2 }),
      })
      .run();

    const report = analyzeExecutionConversion();

    expect(report.focusPathProjection.transitionRows).toEqual([
      expect.objectContaining({
        transitionClass: "switch_then_send_shadow",
        evidenceStrength: "medium",
        pathOutcome: "mixed",
        contaminationFlags: "mixed_action continuation_merge",
        completedActionKind: "sent",
      }),
    ]);
  });

  it("reports explicit read-only observe transition intents separately from shadow evidence", () => {
    getDb()
      .insert(focusTransitionIntent)
      .values({
        intentId: "attention_pull:test",
        tick: 13,
        sourceChatId: "-1001",
        requestedChatId: "-1002",
        intentKind: "observe",
        reason: "need to inspect another room before deciding",
        sourceCommand: "self.attention-pull",
        payloadJson: "{}",
      })
      .run();

    const report = analyzeExecutionConversion();

    expect(report.transitionShadows).toEqual([
      expect.objectContaining({
        transitionClass: "observe_intent",
        evidenceStatus: "structured_transition_intent",
        sourceCommand: "self.attention-pull",
        currentChatId: "-1001",
        requestedChatId: "-1002",
        gatePlane: "intent_only",
        candidateAction: "attention_pull",
        count: 1,
        exampleReasoning: "need to inspect another room before deciding",
      }),
    ]);
    expect(report.focusPathProjection.transitionRows).toEqual([
      expect.objectContaining({
        pathId: "attention_pull:test",
        pathLength: 2,
        originChatId: "-1001",
        requestedChatId: "-1002",
        transitionClass: "observe_intent",
        evidenceStrength: "strong",
        pathOutcome: "pending",
        contaminationFlags: "",
        sourceCommand: "self.attention-pull",
        gatePlane: "intent_only",
        candidateAction: "attention_pull",
        actionResult: "intent_recorded",
        completedActionKind: "empty",
      }),
    ]);
    expect(report.focusPathProjection.summaryRows).toEqual([
      expect.objectContaining({
        pathLength: 2,
        transitionClass: "observe_intent",
        evidenceStrength: "strong",
        pathOutcome: "pending",
        count: 1,
      }),
    ]);
    expect(report.attentionPullAudit).toMatchObject({
      total: 1,
      distinctSources: 1,
      distinctRequested: 1,
      topRequestedRate: 1,
      sourceRequestedRows: [
        expect.objectContaining({
          sourceChatId: "-1001",
          requestedChatId: "-1002",
          count: 1,
          latestReason: "need to inspect another room before deciding",
        }),
      ],
      reasonSamples: [
        expect.objectContaining({
          sourceChatId: "-1001",
          requestedChatId: "-1002",
          reason: "need to inspect another room before deciding",
        }),
      ],
    });
  });

  it("audits attention-pull concentration, raw cross-chat follow-up, and stale pulls", () => {
    getDb()
      .insert(focusTransitionIntent)
      .values([
        {
          intentId: "attention_pull:stale",
          tick: 10,
          sourceChatId: "-1001",
          requestedChatId: "-1002",
          intentKind: "observe",
          reason: "old pull without follow-up",
          sourceCommand: "self.attention-pull",
          payloadJson: "{}",
        },
        {
          intentId: "attention_pull:recent",
          tick: 320,
          sourceChatId: "-1001",
          requestedChatId: "-1002",
          intentKind: "observe",
          reason: "recent pull before mistaken send",
          sourceCommand: "self.attention-pull",
          payloadJson: "{}",
        },
        {
          intentId: "attention_pull:other",
          tick: 330,
          sourceChatId: "-1003",
          requestedChatId: "-1004",
          intentKind: "observe",
          reason: "another room needs a look",
          sourceCommand: "self.attention-pull",
          payloadJson: "{}",
        },
      ])
      .run();
    getDb()
      .insert(actionResult)
      .values({
        actionId: "action:cross-chat-after-pull",
        tick: 340,
        targetNamespace: "channel",
        targetId: "-1002",
        actionType: "diligence",
        result: "typed_failure",
        failureCode: "command_cross_chat_send",
        completedActionRefsJson: "[]",
      })
      .run();
    getDb()
      .insert(tickLog)
      .values({
        tick: 340,
        p1: 0,
        p2: 0,
        p3: 0,
        p4: 0,
        p5: 0,
        p6: 0,
        api: 0,
      })
      .run();

    const report = analyzeExecutionConversion();

    expect(report.attentionPullAudit).toMatchObject({
      total: 3,
      distinctSources: 2,
      distinctRequested: 2,
      topRequestedRate: 2 / 3,
    });
    expect(report.attentionPullAudit.rawCrossChatAfterRows).toEqual([
      expect.objectContaining({
        intentId: "attention_pull:recent",
        rawCrossChatFailuresWithin50Ticks: 1,
      }),
    ]);
    expect(report.attentionPullAudit.staleRows).toEqual([
      expect.objectContaining({
        intentId: "attention_pull:stale",
        ageTicks: 330,
      }),
    ]);
  });

  it("does not mark attention-pull stale when the requested chat later gets a local episode", () => {
    getDb()
      .insert(focusTransitionIntent)
      .values({
        intentId: "attention_pull:followed",
        tick: 10,
        sourceChatId: "-1001",
        requestedChatId: "-1002",
        intentKind: "observe",
        reason: "that room needs a look",
        sourceCommand: "self.attention-pull",
        payloadJson: "{}",
      })
      .run();
    getDb()
      .insert(actionLog)
      .values({
        tick: 80,
        voice: "curiosity",
        target: "channel:-1002",
        actionType: "observe",
        success: true,
      })
      .run();
    getDb()
      .insert(tickLog)
      .values({
        tick: 260,
        p1: 0,
        p2: 0,
        p3: 0,
        p4: 0,
        p5: 0,
        p6: 0,
        api: 0,
      })
      .run();

    const report = analyzeExecutionConversion();

    expect(report.attentionPullAudit.staleRows).toEqual([]);
  });

  it("audits switch requests, blocked retries, follow-up episodes, and stale requests", () => {
    getDb()
      .insert(focusTransitionIntent)
      .values([
        {
          intentId: "switch_request:followed",
          tick: 10,
          sourceChatId: "-1001",
          requestedChatId: "-1002",
          intentKind: "switch_request",
          reason: "need to answer there",
          sourceCommand: "self.switch-chat",
          payloadJson: "{}",
        },
        {
          intentId: "switch_request_blocked:retry-source",
          tick: 20,
          sourceChatId: "-1001",
          requestedChatId: "-1003",
          intentKind: "switch_request_blocked",
          reason: "Tried to send in another chat before it became current.",
          sourceCommand: "irc.reply",
          payloadJson: "{}",
        },
        {
          intentId: "switch_request_blocked:retry-later",
          tick: 40,
          sourceChatId: "-1001",
          requestedChatId: "-1003",
          intentKind: "switch_request_blocked",
          reason: "Tried to send in another chat before it became current.",
          sourceCommand: "irc.reply",
          payloadJson: "{}",
        },
        {
          intentId: "switch_request:stale",
          tick: 50,
          sourceChatId: "-1004",
          requestedChatId: "-1005",
          intentKind: "switch_request",
          reason: "old request without follow-up",
          sourceCommand: "self.switch-chat",
          payloadJson: "{}",
        },
      ])
      .run();
    getDb()
      .insert(actionLog)
      .values({
        tick: 80,
        voice: "curiosity",
        target: "channel:-1002",
        actionType: "observe",
        success: true,
      })
      .run();
    getDb()
      .insert(tickLog)
      .values({
        tick: 260,
        p1: 0,
        p2: 0,
        p3: 0,
        p4: 0,
        p5: 0,
        p6: 0,
        api: 0,
      })
      .run();

    const report = analyzeExecutionConversion();
    const rendered = renderExecutionConversionReport(report);

    expect(report.switchRequestAudit).toMatchObject({
      total: 4,
      explicitRequests: 2,
      blockedRequests: 2,
      distinctSources: 2,
      distinctRequested: 3,
    });
    expect(report.switchRequestAudit.repeatedBlockedRows).toEqual([
      expect.objectContaining({
        intentId: "switch_request_blocked:retry-source",
        blockedAgainWithin50Ticks: 1,
      }),
    ]);
    expect(report.switchRequestAudit.followedRows).toEqual([
      expect.objectContaining({
        intentId: "switch_request:followed",
        localEpisodesWithin200Ticks: 1,
        firstEpisodeTick: 80,
      }),
    ]);
    expect(report.switchRequestAudit.staleRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          intentId: "switch_request_blocked:retry-source",
          ageTicks: 240,
        }),
        expect.objectContaining({
          intentId: "switch_request_blocked:retry-later",
          ageTicks: 220,
        }),
        expect.objectContaining({ intentId: "switch_request:stale", ageTicks: 210 }),
      ]),
    );
    expect(rendered).toContain("switch request audit:");
    expect(rendered).toContain("explicit=2 blocked=2");
    expect(rendered).toContain("repeated blocked send after request within 50 ticks:");
    expect(rendered).toContain("followed by requested-chat local episode within 200 ticks:");
  });
});
