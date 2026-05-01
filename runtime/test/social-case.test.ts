import { describe, expect, it } from "vitest";
import { projectSocialCases, renderSocialCaseBrief } from "../src/social-case/index.js";
import type { SocialEvent } from "../src/social-case/types.js";

const A = "contact:A";
const ALICE = "alice";
const TECH = "技术群";
const PRIVATE_A = "private:A";

function event(
  overrides: Partial<SocialEvent> & Pick<SocialEvent, "id" | "kind" | "occurredAtMs">,
): SocialEvent {
  return {
    actorId: A,
    targetId: ALICE,
    affectedRelation: [ALICE, A],
    venueId: TECH,
    visibility: "public",
    witnesses: ["contact:B"],
    severity: 0.8,
    confidence: 0.95,
    evidenceMsgIds: [],
    ...overrides,
  };
}

describe("ADR-262 social case projection", () => {
  it("closes a public insult as forgiven_with_boundary only after public repair and forgiveness", () => {
    const [projection] = projectSocialCases([
      event({
        id: "e1",
        kind: "insult",
        occurredAtMs: 1,
        text: "Alice 你真的很蠢，别装懂了.",
        causes: [
          {
            kind: "social_meaning",
            text: "This was public, named Alice directly, and attacked ability rather than the topic.",
            visibility: "public",
          },
        ],
      }),
      event({
        id: "e2",
        kind: "repair_attempt",
        actorId: ALICE,
        targetId: A,
        venueId: PRIVATE_A,
        visibility: "private",
        occurredAtMs: 2,
        severity: 0.3,
        causes: [
          {
            kind: "actor_explanation",
            text: "A said privately that they were angry and spoke too harshly.",
            visibility: "private",
          },
        ],
      }),
      event({
        id: "e3",
        kind: "apology",
        occurredAtMs: 3,
        text: "我刚才说过头了，Alice 对不起。",
        repairsEventId: "e1",
        severity: 0.9,
        causes: [
          {
            kind: "repair_basis",
            text: "A apologized in the same group where the insult happened.",
            visibility: "public",
          },
        ],
      }),
      event({
        id: "e4",
        kind: "forgiveness",
        actorId: ALICE,
        targetId: A,
        venueId: PRIVATE_A,
        visibility: "private",
        occurredAtMs: 4,
        severity: 0.8,
        boundaryText: "Do not attack me like that again.",
      }),
    ]);

    expect(projection.repairState).toBe("forgiven_with_boundary");
    expect(projection.boundaryStatus).toBe("set");
    expect(projection.venueDebt).toBe(0);
    expect(projection.currentRead).toContain("Mostly repaired");
  });

  it("keeps venue debt when a public harm only receives a private apology", () => {
    const [projection] = projectSocialCases([
      event({ id: "e1", kind: "insult", occurredAtMs: 1 }),
      event({
        id: "e2",
        kind: "apology",
        venueId: PRIVATE_A,
        visibility: "private",
        occurredAtMs: 2,
        repairsEventId: "e1",
      }),
      event({
        id: "e3",
        kind: "forgiveness",
        actorId: ALICE,
        targetId: A,
        venueId: PRIVATE_A,
        visibility: "private",
        occurredAtMs: 3,
        boundaryText: "No repeat.",
      }),
    ]);

    expect(projection.repairState).toBe("apology_offered");
    expect(projection.venueDebt).toBeGreaterThan(0);
    expect(projection.open).toBe(true);
    expect(projection.currentRead).toContain("not fully repaired");
  });

  it("reopens after a pseudo-repair followed by private attack", () => {
    const [projection] = projectSocialCases([
      event({ id: "e1", kind: "insult", occurredAtMs: 1 }),
      event({ id: "e2", kind: "apology", occurredAtMs: 2, repairsEventId: "e1" }),
      event({
        id: "e3",
        kind: "insult",
        venueId: PRIVATE_A,
        visibility: "private",
        witnesses: [],
        occurredAtMs: 3,
        text: "我只是公开道歉，你别太当真。",
      }),
    ]);

    expect(projection.repairState).toBe("harm_open");
    expect(projection.open).toBe(true);
    expect(projection.lastSignificantEventId).toBe("e3");
  });

  it("marks repeated harm after forgiveness as a boundary violation", () => {
    const [projection] = projectSocialCases([
      event({ id: "e1", kind: "insult", occurredAtMs: 1 }),
      event({ id: "e2", kind: "apology", occurredAtMs: 2, repairsEventId: "e1" }),
      event({
        id: "e3",
        kind: "forgiveness",
        actorId: ALICE,
        targetId: A,
        venueId: PRIVATE_A,
        visibility: "private",
        occurredAtMs: 3,
        boundaryText: "No repeat.",
      }),
      event({
        id: "e4",
        kind: "boundary_violation",
        occurredAtMs: 4,
        text: "Alice 你还是很蠢。",
      }),
    ]);

    expect(projection.repairState).toBe("reopened");
    expect(projection.boundaryStatus).toBe("violated");
    expect(projection.open).toBe(true);
  });

  it("keeps separate case files for the same person when caseId differs", () => {
    const cases = projectSocialCases([
      event({
        id: "e1",
        caseId: "case:public-insult",
        kind: "insult",
        occurredAtMs: 1,
        text: "Alice 你真的很蠢，别装懂了.",
      }),
      event({
        id: "e2",
        caseId: "case:public-insult",
        kind: "apology",
        occurredAtMs: 2,
        repairsEventId: "e1",
        severity: 0.9,
      }),
      event({
        id: "e3",
        caseId: "case:public-insult",
        kind: "forgiveness",
        actorId: ALICE,
        targetId: A,
        venueId: PRIVATE_A,
        visibility: "private",
        occurredAtMs: 3,
        boundaryText: "No repeat.",
      }),
      event({
        id: "e4",
        caseId: "case:later-obligation",
        kind: "obligation",
        actorId: A,
        targetId: ALICE,
        venueId: PRIVATE_A,
        visibility: "private",
        witnesses: [],
        occurredAtMs: 4,
        text: "A promised to send the notes tomorrow.",
        severity: 0.3,
      }),
    ]);

    expect(cases.map((item) => item.caseId).sort()).toEqual([
      "case:later-obligation",
      "case:public-insult",
    ]);
    expect(cases.find((item) => item.caseId === "case:public-insult")?.repairState).toBe(
      "forgiven_with_boundary",
    );
    expect(cases.find((item) => item.caseId === "case:later-obligation")?.events).toHaveLength(1);
  });

  it("renders case brief plus action runbook without leaking private cause text on public surface", () => {
    const [projection] = projectSocialCases([
      event({
        id: "e1",
        kind: "insult",
        occurredAtMs: 1,
        text: "Alice 你真的很蠢，别装懂了.",
      }),
      event({
        id: "e2",
        kind: "repair_attempt",
        actorId: ALICE,
        targetId: A,
        venueId: PRIVATE_A,
        visibility: "private",
        occurredAtMs: 2,
        causes: [
          {
            kind: "actor_explanation",
            text: "A said privately that they were angry and spoke too harshly.",
            visibility: "private",
          },
        ],
      }),
    ]);

    const rendered = renderSocialCaseBrief(projection, {
      surfaceVisibility: "public",
      currentVenueId: TECH,
      threadId: 42,
    });

    expect(rendered).toContain("Case brief:");
    expect(rendered).toContain("Action runbook:");
    expect(rendered).toContain("self social-case-note");
    expect(rendered).not.toContain("caseId");
    expect(rendered).not.toContain("--caseId");
    expect(rendered).not.toContain("social-case:");
    expect(rendered).not.toContain("alice::contact:A");
    expect(rendered).toContain("irc reply --ref <msg>");
    expect(rendered).toContain("irc say --resolve-thread 42");
    expect(rendered).toContain("private detail(s) exist");
    expect(rendered).not.toContain("angry and spoke too harshly");
    expect(rendered).not.toContain("If A is normal");
  });
});
