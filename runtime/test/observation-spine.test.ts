import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, initDb } from "../src/db/connection.js";
import {
  makeActionId,
  makeCandidateId,
  makeEnqueueId,
  makeRankedCandidateId,
  writeActionResult,
  writeCandidateTrace,
  writeFactMutation,
  writePressureDeltasForPreviousTrace,
  writeQueueTrace,
  writeTickTrace,
} from "../src/db/observation-spine.js";
import {
  actionResult,
  candidateTrace,
  factMutation,
  pressureDelta,
  queueTrace,
  tickTrace,
} from "../src/db/schema.js";

describe("ADR-258 observation spine", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("writes a replayable acted tick without parsing prose logs", () => {
    const candidateId = makeCandidateId(10, "diligence", "channel:1");
    const enqueueId = makeEnqueueId(10, "diligence", "channel:1");
    const actionId = makeActionId(7);

    writeTickTrace({
      tick: 10,
      occurredAtMs: 1_000,
      pressureVector: { p1: 1, p2: 2, p3: 3, p4: 4, p5: 5, p6: 6, api: 21, apiPeak: 6 },
      schedulerPhase: "enqueue",
      selectedCandidateId: candidateId,
      sampleStatus: "real",
    });
    writeCandidateTrace({
      candidateId,
      tick: 10,
      target: "channel:1",
      actionType: "diligence",
      normalizedConsiderations: { V: 0.8, bottleneck: "U_cooling" },
      deltaP: 1.2,
      socialCost: 0.3,
      netValue: 0.8,
      bottleneck: "U_cooling",
      gatePlane: "none",
      selected: true,
      silenceReason: "N/A",
    });
    writeQueueTrace({
      tick: 10,
      candidateId,
      enqueueId,
      enqueueOutcome: "accepted",
      fate: "executed",
      reasonCode: "slot_created",
    });
    writeActionResult({
      actionId,
      tick: 11,
      enqueueId,
      candidateId,
      actionLogId: 7,
      target: "channel:1",
      actionType: "message",
      result: "success",
      completedActionRefs: ["sent:chatId=1:msgId=2"],
      executionObservations: [
        {
          kind: "query_result",
          source: "album.search",
          text: "1 album photo candidate",
          enablesContinuation: true,
          payload: { intent: "send_album_photo", candidates: [{ assetId: "photo:cat" }] },
        },
      ],
      externalMessageId: "1:2",
    });
    writeFactMutation({
      mutationId: "mutation:action:7:auto_writeback",
      actionId,
      sourceTick: 11,
      factNamespace: "graph",
      entityNamespace: "channel",
      entityId: "channel:1",
      mutationKind: "update",
      delta: { feel: "positive" },
      authorityTable: "graph_nodes",
    });
    writePressureDeltasForPreviousTrace(11, {
      p1: 1,
      p2: 2,
      p3: 3,
      p4: 3,
      p5: 1,
      p6: 6,
      api: 16,
      apiPeak: 6,
    });
    writeTickTrace({
      tick: 11,
      occurredAtMs: 2_000,
      pressureVector: { p1: 1, p2: 2, p3: 3, p4: 3, p5: 1, p6: 6, api: 16, apiPeak: 6 },
      schedulerPhase: "silent",
      selectedCandidateId: null,
      silenceMarker: "all_candidates_negative",
      sampleStatus: "real",
    });

    const replay = getDb()
      .select({ actionId: actionResult.actionId, mutationKind: factMutation.mutationKind })
      .from(tickTrace)
      .innerJoin(candidateTrace, eq(candidateTrace.candidateId, tickTrace.selectedCandidateId))
      .innerJoin(queueTrace, eq(queueTrace.candidateId, candidateTrace.candidateId))
      .innerJoin(actionResult, eq(actionResult.candidateId, candidateTrace.candidateId))
      .innerJoin(factMutation, eq(factMutation.actionId, actionResult.actionId))
      .where(eq(tickTrace.tick, 10))
      .get();

    expect(replay).toEqual({ actionId, mutationKind: "update" });
    const deltas = getDb()
      .select()
      .from(pressureDelta)
      .where(eq(pressureDelta.sourceTick, 10))
      .all();
    expect(
      deltas.some((row) => row.dimension === "API" && row.releaseClassification === "released"),
    ).toBe(true);
    const resultRow = getDb()
      .select({ observations: actionResult.executionObservationsJson })
      .from(actionResult)
      .where(eq(actionResult.actionId, actionId))
      .get();
    expect(JSON.parse(resultRow?.observations ?? "[]")).toEqual([
      expect.objectContaining({
        kind: "query_result",
        source: "album.search",
        enablesContinuation: true,
      }),
    ]);
  });

  it("writes a typed silent tick candidate authority", () => {
    const candidateId = makeCandidateId(20, "curiosity", "channel:2");

    writeTickTrace({
      tick: 20,
      occurredAtMs: 1_000,
      pressureVector: { p1: 1, p2: 1, p3: 1, p4: 1, p5: 0, p6: 1, api: 5, apiPeak: 1 },
      schedulerPhase: "silent",
      selectedCandidateId: candidateId,
      silenceMarker: "voi_deferred",
      sampleStatus: "real",
    });
    writeCandidateTrace({
      candidateId,
      tick: 20,
      target: "channel:2",
      actionType: "curiosity",
      deltaP: 0.5,
      socialCost: 0.1,
      netValue: 0.4,
      bottleneck: "voi_deferred",
      gatePlane: "policy",
      selected: false,
      silenceReason: "voi_deferred",
      retainedImpulse: { action: "curiosity", target: "channel:2" },
    });

    const row = getDb()
      .select()
      .from(candidateTrace)
      .where(eq(candidateTrace.candidateId, candidateId))
      .get();
    expect(row?.silenceReason).toBe("voi_deferred");
    expect(row?.deltaP).toBe(0.5);
    expect(row?.socialCost).toBe(0.1);
  });

  it("creates distinct ids for ranked losing candidates", () => {
    const selectedId = makeCandidateId(30, "sociability", "channel:3");
    const losingId = makeRankedCandidateId(30, "sociability", "channel:3", 1);

    expect(losingId).not.toBe(selectedId);
    expect(losingId).toBe("candidate:30:sociability:channel:3:rank:1");
  });
});
