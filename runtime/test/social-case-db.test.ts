import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getSqlite, initDb } from "../src/db/connection.js";
import { listSocialEventsForRelation, writeSocialEvent } from "../src/db/social-case.js";
import {
  analyzeSocialCases,
  renderSocialCaseDiagnosticReport,
} from "../src/diagnostics/social-case.js";
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
    evidenceMsgIds: [1001],
    ...overrides,
  };
}

describe("ADR-262 social case DB repository", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("creates the social_events table through migrations", () => {
    const table = getSqlite()
      .prepare("select name from sqlite_master where type = 'table' and name = 'social_events'")
      .get();

    expect(table).toEqual({ name: "social_events" });
  });

  it("round-trips typed event JSON fields through the repository parse boundary", () => {
    writeSocialEvent(
      event({
        id: "e1",
        caseId: "case:public-insult",
        kind: "repair_attempt",
        actorId: ALICE,
        targetId: A,
        venueId: PRIVATE_A,
        visibility: "private",
        witnesses: [],
        evidenceMsgIds: [2001, 2002],
        occurredAtMs: 1,
        causes: [
          {
            kind: "actor_explanation",
            text: "A said privately that they were angry and spoke too harshly.",
            visibility: "private",
            venueId: PRIVATE_A,
            sourceEventId: "e0",
            confidence: 0.77,
          },
        ],
      }),
    );

    const [loaded] = listSocialEventsForRelation([A, ALICE]);

    expect(loaded).toMatchObject({
      id: "e1",
      caseId: "case:public-insult",
      kind: "repair_attempt",
      actorId: ALICE,
      targetId: A,
      venueId: PRIVATE_A,
      visibility: "private",
      witnesses: [],
      evidenceMsgIds: [2001, 2002],
    });
    expect(loaded.causes).toEqual([
      {
        kind: "actor_explanation",
        text: "A said privately that they were angry and spoke too harshly.",
        visibility: "private",
        venueId: PRIVATE_A,
        sourceEventId: "e0",
        confidence: 0.77,
      },
    ]);
  });

  it("keeps duplicate event_id writes idempotent", () => {
    writeSocialEvent(event({ id: "e1", kind: "insult", occurredAtMs: 1, text: "original" }));
    writeSocialEvent(
      event({
        id: "e1",
        kind: "insult",
        occurredAtMs: 2,
        text: "duplicate should not replace the first fact",
      }),
    );

    const events = listSocialEventsForRelation([ALICE, A]);

    expect(events).toHaveLength(1);
    expect(events[0].text).toBe("original");
    expect(events[0].occurredAtMs).toBe(1);
  });

  it("rejects invalid cause values before persistence", () => {
    expect(() =>
      writeSocialEvent(
        event({
          id: "e1",
          kind: "insult",
          occurredAtMs: 1,
          causes: [
            {
              kind: "motive_guess",
              text: "A was jealous.",
              visibility: "public",
            } as never,
          ],
        }),
      ),
    ).toThrow("invalid social cause kind");

    expect(listSocialEventsForRelation([ALICE, A])).toHaveLength(0);
  });

  it("rebuilds a social case projection from persisted facts and hides private causes on public render", () => {
    writeSocialEvent(
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
    );
    writeSocialEvent(
      event({
        id: "e2",
        kind: "repair_attempt",
        actorId: ALICE,
        targetId: A,
        venueId: PRIVATE_A,
        visibility: "private",
        witnesses: [],
        occurredAtMs: 2,
        causes: [
          {
            kind: "actor_explanation",
            text: "A said privately that they were angry and spoke too harshly.",
            visibility: "private",
          },
        ],
      }),
    );
    writeSocialEvent(
      event({
        id: "e3",
        kind: "apology",
        occurredAtMs: 3,
        text: "我刚才说过头了，Alice 对不起。",
        repairsEventId: "e1",
        severity: 0.9,
      }),
    );
    writeSocialEvent(
      event({
        id: "e4",
        kind: "forgiveness",
        actorId: ALICE,
        targetId: A,
        venueId: PRIVATE_A,
        visibility: "private",
        witnesses: [],
        occurredAtMs: 4,
        boundaryText: "Do not attack me like that again.",
      }),
    );

    const [projection] = projectSocialCases(listSocialEventsForRelation([A, ALICE]));
    const rendered = renderSocialCaseBrief(projection, { surfaceVisibility: "public" });

    expect(projection.repairState).toBe("forgiven_with_boundary");
    expect(projection.boundaryStatus).toBe("set");
    expect(rendered).toContain("Case brief:");
    expect(rendered).toContain("private detail(s) exist");
    expect(rendered).not.toContain("angry and spoke too harshly");
  });

  it("renders a diagnostic read model from persisted open cases", () => {
    writeSocialEvent(
      event({
        id: "e1",
        kind: "insult",
        occurredAtMs: 1,
        text: "Alice 你真的很蠢，别装懂了.",
      }),
    );

    const report = analyzeSocialCases();
    const rendered = renderSocialCaseDiagnosticReport(report, { surfaceVisibility: "public" });

    expect(report.eventCount).toBe(1);
    expect(report.caseCount).toBe(1);
    expect(report.openCaseCount).toBe(1);
    expect(rendered).toContain("Social case with contact:A");
    expect(rendered).toContain("Harm is still open");
  });
});
