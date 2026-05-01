import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getSqlite, initDb } from "../src/db/connection.js";
import { writeSocialEvent } from "../src/db/social-case.js";
import {
  analyzeSocialCaseThreadContrast,
  renderSocialCaseThreadContrastDiagnostic,
  type ThreadWithoutCaseSampleClass,
} from "../src/diagnostics/social-case-thread-contrast.js";
import type { SocialEvent } from "../src/social-case/types.js";

const ALICE = "alice";
const TECH = "技术群";
const PRIVATE = "private";

function event(
  other: string,
  overrides: Partial<SocialEvent> & Pick<SocialEvent, "id" | "kind" | "occurredAtMs">,
): SocialEvent {
  return {
    actorId: other,
    targetId: ALICE,
    affectedRelation: [ALICE, other],
    venueId: TECH,
    visibility: "public",
    witnesses: ["contact:witness"],
    severity: 0.8,
    confidence: 0.95,
    evidenceMsgIds: [1001],
    ...overrides,
  };
}

function writeForgivenCase(other: string, idPrefix: string): void {
  writeSocialEvent(event(other, { id: `${idPrefix}-harm`, kind: "insult", occurredAtMs: 1 }));
  writeSocialEvent(
    event(other, {
      id: `${idPrefix}-apology`,
      kind: "apology",
      occurredAtMs: 2,
      repairsEventId: `${idPrefix}-harm`,
      severity: 0.9,
    }),
  );
  writeSocialEvent(
    event(other, {
      id: `${idPrefix}-forgiveness`,
      kind: "forgiveness",
      actorId: ALICE,
      targetId: other,
      venueId: `${PRIVATE}:${other}`,
      visibility: "private",
      witnesses: [],
      occurredAtMs: 3,
      boundaryText: "No repeat.",
    }),
  );
}

function insertThread(input: {
  id: number;
  title: string;
  status: string;
  involves: readonly string[];
  source?: string;
  createdTick?: number;
  lastBeatTick?: number | null;
  horizon?: number | null;
  deadlineTick?: number | null;
}): void {
  getSqlite()
    .prepare(
      `INSERT INTO narrative_threads
       (id, title, status, weight, source, involves, created_tick, last_beat_tick, horizon,
        deadline_tick, created_at)
       VALUES (?, ?, ?, 'minor', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.title,
      input.status,
      input.source ?? "conversation",
      JSON.stringify(input.involves.map((nodeId) => ({ nodeId, role: "participant" }))),
      input.createdTick ?? 1,
      input.lastBeatTick ?? null,
      input.horizon ?? null,
      input.deadlineTick ?? null,
      Date.now(),
    );
}

function insertBeat(threadId: number, tick: number): void {
  getSqlite()
    .prepare(
      `INSERT INTO narrative_beats (thread_id, tick, content, beat_type, created_at)
       VALUES (?, ?, 'beat', 'ambient', ?)`,
    )
    .run(threadId, tick, Date.now());
}

function insertGraphThread(input: {
  id: number;
  status?: string;
  source?: string;
  createdMs: number;
  lastActivityMs?: number | null;
  deadlineMs?: number | null;
}): void {
  const attrs: Record<string, unknown> = {
    title: `thread ${input.id}`,
    status: input.status ?? "open",
    source: input.source ?? "conversation",
    weight: "minor",
    w: 1,
    created_ms: input.createdMs,
  };
  if (input.lastActivityMs !== undefined) attrs.last_activity_ms = input.lastActivityMs;
  if (input.deadlineMs !== undefined) attrs.deadline_ms = input.deadlineMs;
  getSqlite()
    .prepare("INSERT INTO graph_nodes (id, entity_type, attrs, updated_tick) VALUES (?, ?, ?, ?)")
    .run(`thread_${input.id}`, "thread", JSON.stringify(attrs), 1);
}

function insertTick(tick: number): void {
  getSqlite()
    .prepare(
      `INSERT INTO tick_log (tick, p1, p2, p3, p4, p5, p6, api, created_at)
       VALUES (?, 0, 0, 0, 0, 0, 0, 0, ?)`,
    )
    .run(tick, Date.now());
}

function sampleClasses(): Record<number, ThreadWithoutCaseSampleClass> {
  return Object.fromEntries(
    analyzeSocialCaseThreadContrast().threadWithoutCaseSamples.map((sample) => [
      sample.threadId,
      sample.classification,
    ]),
  );
}

describe("ADR-262 social case / thread contrast diagnostics", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => {
    vi.useRealTimers();
    closeDb();
  });

  it("contrasts social case pressure with structural thread involvement", () => {
    writeSocialEvent(event("contact:A", { id: "a-harm", kind: "insult", occurredAtMs: 10 }));
    insertThread({
      id: 1,
      title: "A conflict follow-up",
      status: "open",
      involves: ["contact:A"],
    });

    writeSocialEvent(event("contact:B", { id: "b-harm", kind: "insult", occurredAtMs: 20 }));
    insertThread({
      id: 2,
      title: "B old topic",
      status: "resolved",
      involves: ["contact:B"],
    });

    writeForgivenCase("contact:C", "c");
    insertThread({
      id: 3,
      title: "C already repaired",
      status: "open",
      involves: ["contact:C"],
    });

    writeSocialEvent(event("contact:E", { id: "e-harm", kind: "insult", occurredAtMs: 30 }));
    insertThread({
      id: 4,
      title: "Unrelated open topic",
      status: "open",
      involves: ["contact:D"],
    });

    const report = analyzeSocialCaseThreadContrast();

    expect(report.counts.case_with_open_thread).toBe(1);
    expect(report.counts.thread_closed_but_case_open).toBe(1);
    expect(report.counts.case_closed_thread_open).toBe(1);
    expect(report.counts.case_without_thread).toBe(1);
    expect(report.counts.thread_without_case).toBe(1);
    expect(report.controlGate.status).toBe("shadow_only");
  });

  it("renders explicit kill criteria and never implies control readiness", () => {
    writeSocialEvent(
      event("contact:A", {
        id: "a-harm",
        kind: "boundary_violation",
        occurredAtMs: 10,
      }),
    );

    const rendered = renderSocialCaseThreadContrastDiagnostic({ limit: 5 });

    expect(rendered).toContain("shadow only: not fed to IAUS");
    expect(rendered).toContain("control gate: shadow_only");
    expect(rendered).toContain("kill criteria before control integration");
    expect(rendered).toContain("case_without_thread");
    expect(rendered).not.toContain("control_ready");
  });

  it("can render JSON for diagnostic tooling", () => {
    insertThread({
      id: 1,
      title: "Unrelated open topic",
      status: "open",
      involves: ["contact:D"],
    });

    const rendered = renderSocialCaseThreadContrastDiagnostic({ json: true });
    const parsed = JSON.parse(rendered) as {
      openNarrativeThreadCount: number;
      counts: { thread_without_case: number };
      controlGate: { status: string };
    };

    expect(parsed.openNarrativeThreadCount).toBe(1);
    expect(parsed.counts.thread_without_case).toBe(1);
    expect(parsed.controlGate.status).toBe("shadow_only");
  });

  it("classifies thread_without_case samples from structured thread fields only", () => {
    insertTick(16_000);
    insertThread({
      id: 1,
      title: "Old auto topic",
      status: "open",
      source: "auto",
      involves: [],
      createdTick: 100,
      lastBeatTick: 1_000,
    });
    insertBeat(1, 1_000);
    insertThread({
      id: 2,
      title: "Recent auto topic",
      status: "open",
      source: "auto",
      involves: [],
      createdTick: 15_500,
    });
    insertThread({
      id: 3,
      title: "Wait for reply",
      status: "open",
      source: "conversation",
      involves: [],
      createdTick: 15_800,
      horizon: 168,
      deadlineTick: 15_968,
    });
    insertThread({
      id: 4,
      title: "Person involved but no social event",
      status: "open",
      source: "conversation",
      involves: ["contact:D"],
      createdTick: 15_900,
    });

    const report = analyzeSocialCaseThreadContrast();
    const classes = sampleClasses();

    expect(report.currentTick).toBe(16_000);
    expect(report.threadWithoutCaseSampleCounts.stale_lifecycle_debt).toBe(1);
    expect(report.threadWithoutCaseSampleCounts.topic_cluster).toBe(1);
    expect(report.threadWithoutCaseSampleCounts.wait_thread_candidate).toBe(1);
    expect(report.threadWithoutCaseSampleCounts.orphan_conversation_lifecycle_debt).toBe(0);
    expect(report.threadWithoutCaseSampleCounts.missing_social_event_candidate).toBe(1);
    expect(classes[1]).toBe("stale_lifecycle_debt");
    expect(classes[2]).toBe("topic_cluster");
    expect(classes[3]).toBe("wait_thread_candidate");
    expect(classes[4]).toBe("missing_social_event_candidate");
  });

  it("renders sample classification as shadow diagnostics without title-text semantics", () => {
    insertTick(16_000);
    insertThread({
      id: 1,
      title: "Wait for reply",
      status: "open",
      source: "conversation",
      involves: [],
      createdTick: 15_800,
      horizon: 168,
      deadlineTick: 15_968,
    });

    const rendered = renderSocialCaseThreadContrastDiagnostic({ limit: 5 });

    expect(rendered).toContain("thread_without_case sample classes");
    expect(rendered).toContain("wait_thread_candidate thread:1");
    expect(rendered).toContain("sample classification uses structured thread fields only");
    expect(rendered).toContain("shadow only: not fed to IAUS");
    expect(rendered).not.toContain("control_ready");
  });

  it("classifies orphan conversation lifecycle debt without guessing title semantics", () => {
    const nowMs = 100_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    insertTick(16_000);
    insertThread({
      id: 1,
      title: "Orphan conversation topic",
      status: "open",
      source: "conversation",
      involves: [],
      createdTick: 15_990,
    });
    insertGraphThread({
      id: 1,
      createdMs: nowMs - 5 * 60 * 60_000,
      lastActivityMs: nowMs - 5 * 60 * 60_000,
    });

    const report = analyzeSocialCaseThreadContrast();
    const [sample] = report.threadWithoutCaseSamples;
    const rendered = renderSocialCaseThreadContrastDiagnostic({ limit: 5 });

    expect(report.threadWithoutCaseSampleCounts.orphan_conversation_lifecycle_debt).toBe(1);
    expect(sample).toMatchObject({
      threadId: 1,
      classification: "orphan_conversation_lifecycle_debt",
      tickAge: 10,
      graphIdleMs: 5 * 60 * 60_000,
    });
    expect(sample.reasons).toContain("conversation_thread_without_deadline_involves_or_beats");
    expect(rendered).toContain("orphan_conversation_lifecycle_debt=1");
    expect(rendered).toContain("orphan_conversation_lifecycle_debt thread:1");
    expect(rendered).toContain("sample classification uses structured thread fields only");
  });

  it("reports social case closure against stale open attention surfaces", () => {
    insertTick(16_000);
    writeForgivenCase("contact:C", "c");
    insertThread({
      id: 1,
      title: "C already repaired but thread stayed open",
      status: "open",
      source: "conversation",
      involves: ["contact:C"],
      createdTick: 100,
      lastBeatTick: 1_000,
    });
    insertBeat(1, 1_000);

    const report = analyzeSocialCaseThreadContrast();
    const [shadow] = report.attentionSurfaceShadows;

    expect(report.counts.case_closed_thread_open).toBe(1);
    expect(report.attentionSurfaceCounts.closed_case_stale_attention_surface).toBe(1);
    expect(report.attentionSurfaceCounts.closed_case_open_attention_surface).toBe(0);
    expect(shadow).toMatchObject({
      classification: "closed_case_stale_attention_surface",
      caseOpen: false,
      threadId: 1,
      threadTickAge: 15_000,
    });
    expect(shadow.reason).toContain("social_case_closed_but_stale_open_attention_surface");
    expect(shadow.reason).toContain("stale_threshold_ticks=2000");
  });

  it("reports missing and orphan stale attention surfaces without enabling control", () => {
    insertTick(16_000);
    writeSocialEvent(event("contact:A", { id: "a-harm", kind: "insult", occurredAtMs: 10 }));
    insertThread({
      id: 1,
      title: "Old unrelated attention surface",
      status: "open",
      source: "auto",
      involves: [],
      createdTick: 100,
      lastBeatTick: 1_000,
    });
    insertBeat(1, 1_000);

    const report = analyzeSocialCaseThreadContrast();
    const classes = report.attentionSurfaceShadows.map((shadow) => shadow.classification);
    const rendered = renderSocialCaseThreadContrastDiagnostic({ limit: 5 });

    expect(report.attentionSurfaceCounts.open_case_missing_attention_surface).toBe(1);
    expect(report.attentionSurfaceCounts.orphan_stale_attention_surface).toBe(1);
    expect(classes).toContain("open_case_missing_attention_surface");
    expect(classes).toContain("orphan_stale_attention_surface");
    expect(rendered).toContain("attention surface shadows");
    expect(rendered).toContain("open_case_missing_attention_surface");
    expect(rendered).toContain("orphan_stale_attention_surface");
    expect(rendered).toContain("control gate: shadow_only");
    expect(rendered).not.toContain("control_ready");
  });
});
