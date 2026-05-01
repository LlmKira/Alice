import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAliceDispatcher } from "../src/core/dispatcher.js";
import { closeDb, initDb } from "../src/db/connection.js";
import { listSocialEventsForRelation } from "../src/db/social-case.js";
import { WorldModel } from "../src/graph/world-model.js";
import { socialCaseMod } from "../src/mods/social-case.mod.js";
import { buildSocialCasePromptSurface } from "../src/social-case/prompt.js";

const ALICE = "alice";
const A = "contact:telegram:42";
const GROUP = "channel:telegram:-1001";
const SECOND_GROUP = "channel:telegram:-1002";
const UNRELATED_GROUP = "channel:telegram:-1003";
const PRIVATE_A = "channel:telegram:42";
const CASE_ID = "case:wave5-public-harm";

function makeGraph(): WorldModel {
  const G = new WorldModel();
  G.addAgent("self");
  G.addContact(A, { display_name: "A", tier: 50 });
  G.addChannel(PRIVATE_A, { chat_type: "private", display_name: "A" });
  G.addChannel(GROUP, { chat_type: "supergroup", display_name: "技术群" });
  G.addChannel(SECOND_GROUP, { chat_type: "supergroup", display_name: "另一个群" });
  G.addChannel(UNRELATED_GROUP, { chat_type: "supergroup", display_name: "路人群" });
  G.addRelation(GROUP, "joined", A);
  G.addRelation(SECOND_GROUP, "joined", A);
  return G;
}

function makeDispatcher(G: WorldModel) {
  const dispatcher = createAliceDispatcher({
    graph: G,
    mods: [socialCaseMod],
  });
  dispatcher.startTick(500, 1_000_000);
  return dispatcher;
}

function note(
  dispatcher: ReturnType<typeof makeDispatcher>,
  args: Record<string, unknown>,
): { success: boolean; eventId?: string; error?: string; open?: boolean } {
  return dispatcher.dispatch("social_case_note", args) as {
    success: boolean;
    eventId?: string;
    error?: string;
    open?: boolean;
  };
}

function writeCanonicalCase(dispatcher: ReturnType<typeof makeDispatcher>): void {
  expect(
    note(dispatcher, {
      caseId: CASE_ID,
      kind: "insult",
      other: A,
      venue: GROUP,
      visibility: "public",
      text: "Alice 你真的很蠢，别装懂了.",
      why: "This was public, named Alice directly, and attacked ability rather than the topic.",
      severity: "high",
      confidence: "high",
    }).success,
  ).toBe(true);
  expect(
    note(dispatcher, {
      caseId: CASE_ID,
      kind: "repair_attempt",
      other: A,
      venue: PRIVATE_A,
      visibility: "private",
      text: "为什么刚才那样说我？",
      why: "A said privately that they were angry and spoke too harshly.",
      whyVisibility: "private",
      severity: "low",
      confidence: "medium",
    }).success,
  ).toBe(true);
  expect(
    note(dispatcher, {
      caseId: CASE_ID,
      kind: "apology",
      other: A,
      venue: GROUP,
      visibility: "public",
      text: "我刚才说过头了，Alice 对不起。",
      why: "A publicly repaired the public harm in the same group.",
      severity: "high",
      confidence: "high",
    }).success,
  ).toBe(true);
  expect(
    note(dispatcher, {
      caseId: CASE_ID,
      kind: "forgiveness",
      other: A,
      venue: PRIVATE_A,
      visibility: "private",
      text: "我接受道歉，但不要再这样攻击我。",
      boundary: "Do not repeat the same personal attack.",
      severity: "high",
      confidence: "high",
    }).success,
  ).toBe(true);
}

describe("ADR-262 Wave 5 real social case intake", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("projects repository-written facts into prompt surfaces with privacy and target gating", () => {
    const G = makeGraph();
    const dispatcher = makeDispatcher(G);
    writeCanonicalCase(dispatcher);

    const groupSurface = buildSocialCasePromptSurface({
      G,
      target: GROUP,
      chatType: "supergroup",
    });
    const groupText = groupSurface.lines.join("\n");

    expect(groupText).toContain("Social case with A");
    expect(groupText).toContain("Mostly repaired, with a boundary");
    expect(groupText).toContain("Alice 你真的很蠢");
    expect(groupText).toContain("我刚才说过头了");
    expect(groupText).toContain("private detail(s) exist");
    expect(groupText).toContain('self social-case-note --case "');
    expect(groupText).not.toContain("angry and spoke too harshly");
    expect(groupText).not.toContain(CASE_ID);

    const privateSurface = buildSocialCasePromptSurface({
      G,
      target: PRIVATE_A,
      chatType: "private",
    });
    expect(privateSurface.lines.join("\n")).toContain("angry and spoke too harshly");

    const secondGroupSurface = buildSocialCasePromptSurface({
      G,
      target: SECOND_GROUP,
      chatType: "supergroup",
    });
    expect(secondGroupSurface.lines.join("\n")).toContain("Social case with A");

    const unrelatedSurface = buildSocialCasePromptSurface({
      G,
      target: UNRELATED_GROUP,
      chatType: "supergroup",
    });
    expect(unrelatedSurface.lines).toEqual([]);
  });

  it("uses the prompt-visible case handle to keep a repeated insult in the same case file", () => {
    const G = makeGraph();
    const dispatcher = makeDispatcher(G);
    writeCanonicalCase(dispatcher);
    const surface = buildSocialCasePromptSurface({
      G,
      target: GROUP,
      chatType: "supergroup",
    });
    const handle = surface.contextVars.CURRENT_SOCIAL_CASE_HANDLE;

    const result = note(dispatcher, {
      kind: "boundary_violation",
      other: A,
      venue: GROUP,
      visibility: "public",
      text: "Alice 你还是很蠢。",
      why: "A repeated the same personal attack after a boundary.",
      case: handle,
      __contextVars: surface.contextVars,
    });

    expect(result.success).toBe(true);
    expect(result.open).toBe(true);
    const events = listSocialEventsForRelation([ALICE, A]);
    expect(events).toHaveLength(5);
    expect(new Set(events.map((event) => event.caseId))).toEqual(new Set([CASE_ID]));

    const reopenedSurface = buildSocialCasePromptSurface({
      G,
      target: GROUP,
      chatType: "supergroup",
    });
    const reopenedText = reopenedSurface.lines.join("\n");
    expect(reopenedText).toContain("Reopened by a repeated boundary violation");
    expect(reopenedText).toContain("Alice 你还是很蠢");
  });
});
