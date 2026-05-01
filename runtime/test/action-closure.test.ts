import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, initDb } from "../src/db/connection.js";
import { actionLog, actionResult } from "../src/db/schema.js";
import {
  analyzeActionClosure,
  renderActionClosureDiagnostic,
} from "../src/diagnostics/action-closure.js";

beforeEach(() => initDb(":memory:"));
afterEach(() => closeDb());

function insertActionLog(input: {
  tick: number;
  actionType?: string;
  target?: string;
  tcAfterward?: string;
  tcCommandLog?: string;
  hostContinuationTrace?: string[];
}): number {
  return getDb()
    .insert(actionLog)
    .values({
      tick: input.tick,
      voice: "curiosity",
      target: input.target ?? "channel:test",
      actionType: input.actionType ?? "observe",
      reasoning: "test row",
      success: true,
      tcAfterward: input.tcAfterward,
      tcCommandLog: input.tcCommandLog,
      tcHostContinuationTrace: input.hostContinuationTrace
        ? JSON.stringify(input.hostContinuationTrace)
        : null,
    })
    .returning({ id: actionLog.id })
    .get().id;
}

function insertActionResult(input: {
  actionLogId: number;
  tick: number;
  actionId?: string;
  completedActionRefsJson?: string;
  executionObservationsJson?: string;
}): void {
  getDb()
    .insert(actionResult)
    .values({
      actionId: input.actionId ?? `action:${input.actionLogId}`,
      tick: input.tick,
      actionLogId: input.actionLogId,
      targetNamespace: "channel",
      targetId: "test",
      actionType: "observe",
      result: "no_op",
      failureCode: "N/A",
      completedActionRefsJson: input.completedActionRefsJson ?? "[]",
      executionObservationsJson: input.executionObservationsJson ?? "[]",
    })
    .run();
}

describe("ADR-266 action closure diagnostic", () => {
  it("reports typed actionable reads that did not close with continuation or a social action", () => {
    const actionLogId = insertActionLog({
      tick: 10,
      tcAfterward: "waiting_reply",
      tcCommandLog: 'album search --query "cat" --count 5',
    });
    insertActionResult({
      actionLogId,
      tick: 10,
      executionObservationsJson: JSON.stringify([
        {
          kind: "query_result",
          source: "album.search",
          text: "1 album photo candidate",
          enablesContinuation: true,
          payload: {
            intent: "send_album_photo",
            candidates: [{ assetId: "photo:cat", sourceChatId: -1001, sourceMsgId: 7 }],
          },
        },
      ]),
    });

    const report = analyzeActionClosure();

    expect(report.summary.actionableReadWithoutContinuation).toBe(1);
    expect(report.summary.readOnlyWaitingReply).toBe(1);
    expect(report.summary.albumSearchCandidatesWithoutAlbumSend).toBe(1);
    expect(report.structuredRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          classification: "actionable_read_without_continuation",
          observationSource: "album.search",
          observationIntent: "send_album_photo",
          candidateAssetIds: ["photo:cat"],
        }),
        expect.objectContaining({
          classification: "read_only_waiting_reply",
          completedActionKind: "empty",
        }),
        expect.objectContaining({
          classification: "album_search_candidates_without_album_send",
        }),
      ]),
    );
  });

  it("does not report actionable reads when same-tick continuation is recorded", () => {
    const actionLogId = insertActionLog({
      tick: 11,
      tcAfterward: "waiting_reply",
      hostContinuationTrace: ["local_observation_followup"],
    });
    insertActionResult({
      actionLogId,
      tick: 11,
      executionObservationsJson: JSON.stringify([
        {
          kind: "query_result",
          source: "album.search",
          text: "1 album photo candidate",
          enablesContinuation: true,
          payload: { intent: "send_album_photo", candidates: [{ assetId: "photo:cat" }] },
        },
      ]),
    });

    const report = analyzeActionClosure();

    expect(report.structuredRows).toEqual([]);
  });

  it("does not report album search when a later same-tick send is recorded", () => {
    const searchLogId = insertActionLog({
      tick: 12,
      tcAfterward: "waiting_reply",
    });
    insertActionResult({
      actionLogId: searchLogId,
      tick: 12,
      executionObservationsJson: JSON.stringify([
        {
          kind: "query_result",
          source: "album.search",
          text: "1 album photo candidate",
          enablesContinuation: true,
          payload: { intent: "send_album_photo", candidates: [{ assetId: "photo:cat" }] },
        },
      ]),
    });
    const sendLogId = insertActionLog({
      tick: 12,
      actionType: "message",
      tcAfterward: "waiting_reply",
    });
    insertActionResult({
      actionLogId: sendLogId,
      tick: 12,
      actionId: `action:${sendLogId}`,
      completedActionRefsJson: JSON.stringify(["sent:chatId=-1001:msgId=8"]),
    });

    const report = analyzeActionClosure();

    expect(report.structuredRows).toEqual([]);
  });

  it("keeps command-log-only rows in legacy suspicion instead of structured facts", () => {
    insertActionLog({
      tick: 13,
      tcAfterward: "waiting_reply",
      tcCommandLog: '$ album search --query "cat" --count 5\nphoto:cat',
    });

    const report = analyzeActionClosure();
    const renderedJson = JSON.parse(renderActionClosureDiagnostic({ json: true })) as {
      legacyRows: Array<{ classification: string; commandHint: string }>;
      structuredRows: unknown[];
    };

    expect(report.structuredRows).toEqual([]);
    expect(report.legacyRows).toEqual([
      expect.objectContaining({
        classification: "legacy_album_search_command_log_without_typed_observation",
        commandHint: "album search",
      }),
    ]);
    expect(renderedJson.structuredRows).toEqual([]);
    expect(renderedJson.legacyRows[0].classification).toBe(
      "legacy_album_search_command_log_without_typed_observation",
    );
  });
});
