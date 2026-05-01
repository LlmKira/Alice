/**
 * ADR-262 Wave 5B-5E: non-polluting social case intake smoke.
 *
 * Runs the explicit social-case write path against a temporary backup of a real
 * SQLite DB. The source DB is opened read-only only for backup/count checks.
 *
 * @see docs/adr/262-social-case-management/README.md
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { createAliceDispatcher } from "../src/core/dispatcher.js";
import { closeDb, initDb } from "../src/db/connection.js";
import { listSocialEventsForRelation } from "../src/db/social-case.js";
import { analyzeSocialCases } from "../src/diagnostics/social-case.js";
import { WorldModel } from "../src/graph/world-model.js";
import { socialCaseMod } from "../src/mods/social-case.mod.js";
import { buildSocialCasePromptSurface } from "../src/social-case/prompt.js";

const ALICE = "alice";
const MARKER = "adr262-wave5b";
const OTHER = `contact:${MARKER}-clear-falcon`;
const GROUP = `channel:${MARKER}-tech-room`;
const PRIVATE = `channel:${MARKER}-private-room`;
const UNRELATED = `channel:${MARKER}-quiet-lobby`;
const CASE_ID = `case:${MARKER}-public-harm-repair`;
const REVIEW_OTHER = `contact:${MARKER}-review-candidate`;
const REVIEW_CASE_ID = `case:${MARKER}-review-candidate`;
const SUGGEST_OTHER = `contact:${MARKER}-suggest-candidate`;
const SUGGEST_CASE_ID = `case:${MARKER}-suggest-candidate`;
const RESTORED_OTHER = `contact:${MARKER}-restored-candidate`;
const RESTORED_CASE_ID = `case:${MARKER}-restored-candidate`;
const START_TICK = 262_005;
const NOW_MS = Date.UTC(2026, 4, 1, 12, 0, 0);

interface SmokeResult {
  sourceDb: string;
  tempDb: string;
  originalPreSyntheticRows: number;
  originalPostSyntheticRows: number;
  eventsWritten: number;
  cleanup: "pass" | "failed";
  checks: Record<string, "pass">;
}

interface NoteResult {
  success: boolean;
  eventId?: string;
  error?: string;
  open?: boolean;
}

interface CandidateResult {
  success: boolean;
  candidateId?: string;
  status?: string;
  writesSocialEvent?: boolean;
  error?: string;
}

function runtimeRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function parseDbArg(argv: readonly string[]): string {
  const dbIndex = argv.indexOf("--db");
  if (dbIndex >= 0) {
    const value = argv[dbIndex + 1];
    if (!value) throw new Error("--db requires a path");
    return resolve(process.cwd(), value);
  }
  return resolve(runtimeRoot(), "alice.db");
}

function sourceSyntheticRows(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const table = db
      .prepare("select name from sqlite_master where type = 'table' and name = 'social_events'")
      .get();
    if (!table) return 0;
    const row = db
      .prepare(
        `
          select count(*) as count
          from social_events
          where event_id like @marker
             or case_id like @marker
             or actor_id like @marker
             or target_id like @marker
             or affected_relation_a like @marker
             or affected_relation_b like @marker
             or venue_id like @marker
             or content_text like @marker
        `,
      )
      .get({ marker: `%${MARKER}%` }) as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

async function backupSourceDb(sourceDb: string, tempDb: string): Promise<void> {
  const db = new Database(sourceDb, { readonly: true, fileMustExist: true });
  try {
    await db.backup(tempDb);
  } finally {
    db.close();
  }
}

function makeGraph(): WorldModel {
  const G = new WorldModel();
  G.addAgent("self");
  G.addContact(OTHER, { display_name: "A", tier: 50 });
  G.addContact(REVIEW_OTHER, { display_name: "B", tier: 150 });
  G.addContact(SUGGEST_OTHER, { display_name: "C", tier: 50 });
  G.addContact(RESTORED_OTHER, { display_name: "D", tier: 150 });
  G.addChannel(PRIVATE, { chat_type: "private", display_name: "A 私聊" });
  G.addChannel(GROUP, { chat_type: "supergroup", display_name: "技术群" });
  G.addChannel(UNRELATED, { chat_type: "supergroup", display_name: "路人群" });
  G.addRelation(GROUP, "joined", OTHER);
  G.addRelation(GROUP, "joined", REVIEW_OTHER);
  G.addRelation(GROUP, "joined", SUGGEST_OTHER);
  G.addRelation(GROUP, "joined", RESTORED_OTHER);
  G.addRelation(OTHER, "joined", PRIVATE);
  return G;
}

function expect(condition: boolean, label: string): void {
  if (!condition) throw new Error(`check failed: ${label}`);
}

function expectContains(text: string, needle: string, label: string): void {
  expect(text.includes(needle), `${label}: expected to contain ${JSON.stringify(needle)}`);
}

function expectNotContains(text: string, needle: string, label: string): void {
  expect(!text.includes(needle), `${label}: expected not to contain ${JSON.stringify(needle)}`);
}

function note(
  dispatcher: ReturnType<typeof createAliceDispatcher>,
  args: Record<string, unknown>,
): NoteResult {
  return dispatcher.dispatch("social_case_note", args) as NoteResult;
}

function expectNote(
  dispatcher: ReturnType<typeof createAliceDispatcher>,
  args: Record<string, unknown>,
): NoteResult {
  const result = note(dispatcher, args);
  expect(result.success, `social_case_note failed: ${result.error ?? "unknown error"}`);
  return result;
}

function writeCanonicalCase(dispatcher: ReturnType<typeof createAliceDispatcher>): void {
  expectNote(dispatcher, {
    caseId: CASE_ID,
    kind: "insult",
    other: OTHER,
    venue: GROUP,
    visibility: "public",
    text: "Alice 你真的很蠢，别装懂了.",
    why: "This was public, named Alice directly, and attacked ability rather than the topic.",
    severity: "high",
    confidence: "high",
  });

  expectNote(dispatcher, {
    caseId: CASE_ID,
    kind: "repair_attempt",
    other: OTHER,
    venue: PRIVATE,
    visibility: "private",
    text: "为什么刚才那样说我？",
    why: "A said privately that they were angry and spoke too harshly.",
    whyVisibility: "private",
    severity: "low",
    confidence: "medium",
  });

  expectNote(dispatcher, {
    caseId: CASE_ID,
    kind: "apology",
    other: OTHER,
    venue: GROUP,
    visibility: "public",
    text: "我刚才说过头了，Alice 对不起。",
    why: "A publicly repaired the public harm in the same group.",
    severity: "high",
    confidence: "high",
  });

  expectNote(dispatcher, {
    caseId: CASE_ID,
    kind: "forgiveness",
    other: OTHER,
    venue: PRIVATE,
    visibility: "private",
    text: "我接受道歉，但不要再这样攻击我。",
    boundary: "Do not repeat the same personal attack.",
    severity: "high",
    confidence: "high",
  });
}

function writeReviewedCandidate(dispatcher: ReturnType<typeof createAliceDispatcher>): void {
  const candidate = dispatcher.dispatch("social_case_candidate", {
    caseId: REVIEW_CASE_ID,
    kind: "support",
    other: REVIEW_OTHER,
    venue: GROUP,
    visibility: "public",
    text: "我觉得 Alice 刚才说得没问题，先别攻击人。",
    why: "This may be public support for Alice, but it should be reviewed before becoming a stable case fact.",
    uncertainty:
      "Synthetic review candidate: verify that candidate write does not touch social_events.",
    severity: "moderate",
    confidence: "medium",
  }) as CandidateResult;

  expect(candidate.success, `social_case_candidate failed: ${candidate.error ?? "unknown error"}`);
  expect(typeof candidate.candidateId === "string", "candidate should have an id");
  const candidateId = candidate.candidateId ?? "";
  expect(
    candidate.writesSocialEvent === false,
    "candidate creation should not write social_events",
  );
  expect(
    listSocialEventsForRelation([ALICE, REVIEW_OTHER]).length === 0,
    "candidate should not be visible as a stable social event before accept",
  );

  const queue = dispatcher.query("social_case_candidates", {
    surface: "public",
  }) as string;
  expectContains(queue, candidateId, "candidate review queue");
  expectContains(queue, "possible support with", "candidate review queue");
  expectNotContains(
    queue,
    "Synthetic review candidate",
    "public candidate review queue should hide private review detail",
  );

  const accepted = dispatcher.dispatch("social_case_accept_candidate", {
    candidate: candidateId,
    reason: "Synthetic smoke accepts the candidate after review.",
  }) as CandidateResult & { eventId?: string };
  expect(accepted.success, `social_case_accept_candidate failed: ${accepted.error ?? "unknown"}`);
  expect(accepted.status === "accepted", "candidate should be accepted");
  expect(typeof accepted.eventId === "string", "accept should write a stable event id");

  const [event] = listSocialEventsForRelation([ALICE, REVIEW_OTHER]);
  expect(event?.caseId === REVIEW_CASE_ID, "accepted candidate should preserve caseId");
  expect(event?.kind === "support", "accepted candidate should write the reviewed event kind");
}

function writeSuggestedCandidate(dispatcher: ReturnType<typeof createAliceDispatcher>): void {
  const suggested = dispatcher.dispatch("social_case_suggest_candidate", {
    caseId: SUGGEST_CASE_ID,
    kindHint: "insult",
    other: SUGGEST_OTHER,
    venue: GROUP,
    visibility: "public",
    speaker: SUGGEST_OTHER,
    target: "Alice",
    text: "Alice 你真的很蠢，别装懂了。",
    evidence: "1262001",
  }) as CandidateResult & { candidateCreated?: boolean; kind?: string };

  expect(
    suggested.success,
    `social_case_suggest_candidate failed: ${suggested.error ?? "unknown error"}`,
  );
  expect(suggested.candidateCreated === true, "suggest should create a review candidate");
  expect(suggested.kind === "insult", "suggest should preserve explicit insult hint");
  expect(typeof suggested.candidateId === "string", "suggested candidate should have an id");
  const candidateId = suggested.candidateId ?? "";
  expect(
    suggested.writesSocialEvent === false,
    "suggested candidate creation should not write social_events",
  );
  expect(
    listSocialEventsForRelation([ALICE, SUGGEST_OTHER]).length === 0,
    "suggested candidate should not be visible as a stable social event before accept",
  );

  const ordinary = dispatcher.dispatch("social_case_suggest_candidate", {
    other: SUGGEST_OTHER,
    venue: GROUP,
    visibility: "public",
    speaker: SUGGEST_OTHER,
    target: "Alice",
    text: "Alice 我不同意这个方案，缓存策略这里可能不对。",
  }) as CandidateResult & { candidateCreated?: boolean };
  expect(ordinary.success, "ordinary disagreement suggestion should return successfully");
  expect(
    ordinary.candidateCreated === false,
    "observation without explicit kind hint should create no candidate",
  );
  expect(
    ordinary.writesSocialEvent === false,
    "ordinary disagreement suggestion should not write social_events",
  );

  const accepted = dispatcher.dispatch("social_case_accept_candidate", {
    candidate: candidateId,
    reason: "Synthetic smoke accepts the suggested candidate after review.",
  }) as CandidateResult & { eventId?: string };
  expect(accepted.success, `social_case_accept_candidate failed: ${accepted.error ?? "unknown"}`);
  expect(accepted.status === "accepted", "suggested candidate should be accepted");
  expect(typeof accepted.eventId === "string", "accept should write a stable event id");

  const [event] = listSocialEventsForRelation([ALICE, SUGGEST_OTHER]);
  expect(event?.caseId === SUGGEST_CASE_ID, "accepted suggested candidate should preserve caseId");
  expect(event?.kind === "insult", "accepted suggested candidate should write insult event");
}

function createPersistedCandidate(dispatcher: ReturnType<typeof createAliceDispatcher>): string {
  const candidate = dispatcher.dispatch("social_case_suggest_candidate", {
    caseId: RESTORED_CASE_ID,
    kindHint: "support",
    other: RESTORED_OTHER,
    venue: GROUP,
    visibility: "public",
    speaker: RESTORED_OTHER,
    target: "Alice",
    text: "Alice 刚才说得没问题，先别攻击人。",
    evidence: "1262002",
  }) as CandidateResult & { candidateCreated?: boolean };

  expect(
    candidate.success,
    `restored social_case_suggest_candidate failed: ${candidate.error ?? "unknown error"}`,
  );
  expect(candidate.candidateCreated === true, "restore candidate should be created");
  expect(typeof candidate.candidateId === "string", "restore candidate should have an id");
  expect(candidate.writesSocialEvent === false, "restore candidate should not write social_events");
  expect(
    listSocialEventsForRelation([ALICE, RESTORED_OTHER]).length === 0,
    "restore candidate should not be stable before restart",
  );
  return candidate.candidateId ?? "";
}

function acceptRestoredCandidate(
  dispatcher: ReturnType<typeof createAliceDispatcher>,
  candidateId: string,
): void {
  const queue = dispatcher.query("social_case_candidates", {
    surface: "private",
  }) as string;
  expectContains(queue, candidateId, "restored candidate queue");
  expectContains(queue, "possible support with", "restored candidate queue");
  expect(
    listSocialEventsForRelation([ALICE, RESTORED_OTHER]).length === 0,
    "restored candidate should still not be stable before accept",
  );

  const accepted = dispatcher.dispatch("social_case_accept_candidate", {
    candidate: candidateId,
    reason: "Synthetic smoke accepts restored pending candidate after restart.",
  }) as CandidateResult & { eventId?: string };
  expect(
    accepted.success,
    `restored social_case_accept_candidate failed: ${accepted.error ?? "unknown"}`,
  );
  expect(accepted.status === "accepted", "restored candidate should be accepted");
  expect(typeof accepted.eventId === "string", "restored accept should write a stable event id");

  const [event] = listSocialEventsForRelation([ALICE, RESTORED_OTHER]);
  expect(event?.caseId === RESTORED_CASE_ID, "restored candidate should preserve caseId");
  expect(event?.kind === "support", "restored candidate should write support event");
}

async function runSmoke(sourceDb: string): Promise<SmokeResult> {
  if (!existsSync(sourceDb)) throw new Error(`source DB does not exist: ${sourceDb}`);

  const originalPreSyntheticRows = sourceSyntheticRows(sourceDb);
  expect(
    originalPreSyntheticRows === 0,
    `source DB already contains ${originalPreSyntheticRows} ${MARKER} row(s)`,
  );

  const tempDir = mkdtempSync(join(tmpdir(), "alice-social-case-smoke-"));
  const tempDb = join(tempDir, basename(sourceDb));
  let cleanup: SmokeResult["cleanup"] = "failed";
  const checks: SmokeResult["checks"] = {};

  try {
    await backupSourceDb(sourceDb, tempDb);
    initDb(tempDb);

    const G = makeGraph();
    const dispatcher = createAliceDispatcher({ graph: G, mods: [socialCaseMod] });
    dispatcher.startTick(START_TICK, NOW_MS);
    writeCanonicalCase(dispatcher);
    writeReviewedCandidate(dispatcher);

    const groupSurface = buildSocialCasePromptSurface({
      G,
      target: GROUP,
      chatType: "supergroup",
    });
    const groupText = groupSurface.lines.join("\n");
    expectContains(groupText, "Social case with A", "group surface");
    expectContains(groupText, "Mostly repaired, with a boundary", "group surface");
    expectContains(groupText, "Alice 你真的很蠢", "group surface");
    expectContains(groupText, "我刚才说过头了", "group surface");
    expectContains(groupText, "private detail(s) exist", "group surface");
    expectContains(groupText, 'self social-case-note --case "', "group surface");
    expectNotContains(groupText, "angry and spoke too harshly", "group surface");
    expectNotContains(groupText, CASE_ID, "group surface");
    checks.group_surface = "pass";

    const privateSurface = buildSocialCasePromptSurface({
      G,
      target: PRIVATE,
      chatType: "private",
    });
    const privateText = privateSurface.lines.join("\n");
    expectContains(privateText, "angry and spoke too harshly", "private surface");
    checks.private_surface = "pass";

    const unrelatedSurface = buildSocialCasePromptSurface({
      G,
      target: UNRELATED,
      chatType: "supergroup",
    });
    expect(unrelatedSurface.lines.length === 0, "unrelated surface should be empty");
    checks.unrelated_surface = "pass";

    const handle = groupSurface.contextVars.CURRENT_SOCIAL_CASE_HANDLE;
    expect(
      typeof handle === "string" && handle.length > 0,
      "group surface should expose a case handle",
    );
    const repeat = expectNote(dispatcher, {
      kind: "boundary_violation",
      other: OTHER,
      venue: GROUP,
      visibility: "public",
      text: "Alice 你还是很蠢。",
      why: "A repeated the same personal attack after a boundary.",
      case: handle,
      __contextVars: groupSurface.contextVars,
    });
    expect(repeat.open === true, "repeat insult should reopen the social case");

    const events = listSocialEventsForRelation([ALICE, OTHER]);
    expect(events.length === 5, `expected 5 synthetic events, got ${events.length}`);
    expect(
      new Set(events.map((event) => event.caseId)).size === 1,
      "all events should share one caseId",
    );
    expect(
      events.every((event) => event.caseId === CASE_ID),
      "writeback should preserve hidden caseId",
    );
    checks.same_case_writeback = "pass";

    checks.candidate_review_writeback = "pass";
    writeSuggestedCandidate(dispatcher);
    checks.suggest_candidate_review = "pass";
    const restoredCandidateId = createPersistedCandidate(dispatcher);
    dispatcher.saveModStatesToDb(START_TICK);
    closeDb();
    initDb(tempDb);
    const restoredDispatcher = createAliceDispatcher({ graph: G, mods: [socialCaseMod] });
    expect(restoredDispatcher.loadModStatesFromDb(), "mod state should restore candidates");
    restoredDispatcher.startTick(START_TICK + 1, NOW_MS + 1_000);
    acceptRestoredCandidate(restoredDispatcher, restoredCandidateId);
    restoredDispatcher.saveModStatesToDb(START_TICK + 1);
    const candidateDiagnostic = analyzeSocialCases().candidates;
    expect(candidateDiagnostic.available, "candidate diagnostics should be available");
    expect(candidateDiagnostic.total >= 3, "candidate diagnostics should include review queue");
    expect(candidateDiagnostic.accepted >= 3, "candidate diagnostics should see accepted items");
    checks.candidate_state_restore = "pass";
    checks.candidate_diagnostics = "pass";

    const originalPostSyntheticRows = sourceSyntheticRows(sourceDb);
    expect(
      originalPostSyntheticRows === 0,
      "source DB should remain free of synthetic social rows",
    );
    checks.original_unchanged = "pass";

    const eventsWritten =
      events.length +
      listSocialEventsForRelation([ALICE, REVIEW_OTHER]).length +
      listSocialEventsForRelation([ALICE, SUGGEST_OTHER]).length +
      listSocialEventsForRelation([ALICE, RESTORED_OTHER]).length;

    return {
      sourceDb,
      tempDb,
      originalPreSyntheticRows,
      originalPostSyntheticRows,
      eventsWritten,
      cleanup,
      checks,
    };
  } finally {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
    cleanup = !existsSync(tempDir) ? "pass" : "failed";
  }
}

function printResult(result: SmokeResult): void {
  const lines = [
    "ADR-262 Wave 5B-5E social case intake smoke",
    `source_db=${result.sourceDb}`,
    `temp_db=${result.tempDb}`,
    `original_pre_synthetic_rows=${result.originalPreSyntheticRows}`,
    `original_post_synthetic_rows=${result.originalPostSyntheticRows}`,
    `events_written=${result.eventsWritten}`,
    ...Object.entries(result.checks).map(([name, status]) => `${name}=${status}`),
    `cleanup=${result.cleanup}`,
  ];
  console.log(lines.join("\n"));
}

async function main(): Promise<void> {
  const sourceDb = parseDbArg(process.argv.slice(2));
  const result = await runSmoke(sourceDb);
  result.cleanup = !existsSync(dirname(result.tempDb)) ? "pass" : "failed";
  expect(result.cleanup === "pass", "temporary DB directory should be removed");
  printResult(result);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
