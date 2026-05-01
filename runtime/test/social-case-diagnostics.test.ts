import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAliceDispatcher } from "../src/core/dispatcher.js";
import { closeDb, initDb } from "../src/db/connection.js";
import { writeSocialEvent } from "../src/db/social-case.js";
import {
  analyzeSocialCases,
  renderSocialCaseDiagnosticReport,
} from "../src/diagnostics/social-case.js";
import { WorldModel } from "../src/graph/world-model.js";
import { socialCaseMod } from "../src/mods/social-case.mod.js";
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

describe("ADR-262 social case pressure shadow diagnostics", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("computes read-only pressure shadows from persisted open harm", () => {
    writeSocialEvent(
      event({
        id: "e1",
        kind: "insult",
        occurredAtMs: 1,
        text: "Alice 你真的很蠢，别装懂了.",
      }),
    );

    const report = analyzeSocialCases();
    const [shadow] = report.pressureShadows;

    expect(report.eventCount).toBe(1);
    expect(report.caseCount).toBe(1);
    expect(report.openCaseCount).toBe(1);
    expect(shadow).toMatchObject({
      caseId: expect.stringMatching(/^social-case:/),
      repairState: "harm_open",
      boundaryStatus: "none",
      open: true,
      lastSignificantEventId: "e1",
    });
    expect(shadow.pressure).toBeGreaterThanOrEqual(0.75);
    expect(shadow.reason).toContain("state=harm_open");
  });

  it("keeps forgiven boundary cases low pressure but visible", () => {
    writeSocialEvent(
      event({
        id: "e1",
        kind: "insult",
        occurredAtMs: 1,
        text: "Alice 你真的很蠢，别装懂了.",
      }),
    );
    writeSocialEvent(
      event({
        id: "e2",
        kind: "apology",
        occurredAtMs: 2,
        text: "我刚才说过头了，Alice 对不起。",
        repairsEventId: "e1",
        severity: 0.9,
      }),
    );
    writeSocialEvent(
      event({
        id: "e3",
        kind: "forgiveness",
        actorId: ALICE,
        targetId: A,
        venueId: PRIVATE_A,
        visibility: "private",
        witnesses: [],
        occurredAtMs: 3,
        boundaryText: "Do not attack me like that again.",
      }),
    );

    const [shadow] = analyzeSocialCases().pressureShadows;

    expect(shadow.open).toBe(false);
    expect(shadow.repairState).toBe("forgiven_with_boundary");
    expect(shadow.boundaryStatus).toBe("set");
    expect(shadow.pressure).toBe(0.2);
    expect(shadow.reason).toContain("state=forgiven_with_boundary");
  });

  it("renders a shadow-only diagnostic contract without implying control integration", () => {
    writeSocialEvent(
      event({
        id: "e1",
        kind: "exclusion",
        occurredAtMs: 1,
        confidence: 0.35,
        text: "没人接 Alice 的话，但证据还不够.",
      }),
    );

    const report = analyzeSocialCases();
    const rendered = renderSocialCaseDiagnosticReport(report, {
      surfaceVisibility: "public",
      limit: 1,
    });

    expect(report.pressureShadows[0].reason).toContain("low_confidence=0.350");
    expect(rendered).toContain("shadow only: not fed to IAUS, target-control, prompt");
    expect(rendered).toContain("pressure shadows:");
    expect(rendered).not.toContain("winner");
  });

  it("reports persisted review candidate queue without treating candidates as facts", () => {
    const dispatcher = createAliceDispatcher({
      graph: new WorldModel(),
      mods: [socialCaseMod],
    });
    dispatcher.startTick(10, 1_000_000);
    const pending = dispatcher.dispatch("social_case_suggest_candidate", {
      kindHint: "insult",
      other: "contact:A",
      venue: TECH,
      visibility: "public",
      speaker: "contact:A",
      target: "Alice",
      text: "Alice 你真的很蠢，别装懂了。",
    }) as { success: true; candidateId: string; writesSocialEvent: false };
    const rejected = dispatcher.dispatch("social_case_suggest_candidate", {
      kindHint: "exclusion",
      other: "contact:B",
      venue: TECH,
      visibility: "public",
      speaker: "Alice",
      target: "Alice",
      text: "Alice 发言后没人回应。",
    }) as { success: true; candidateId: string; writesSocialEvent: false };

    dispatcher.dispatch("social_case_reject_candidate", {
      candidate: rejected.candidateId,
      reason: "Weak signal.",
    });
    dispatcher.saveModStatesToDb(15);

    const report = analyzeSocialCases();
    const rendered = renderSocialCaseDiagnosticReport(report, { limit: 2 });

    expect(pending.writesSocialEvent).toBe(false);
    expect(report.eventCount).toBe(0);
    expect(report.candidates).toMatchObject({
      available: true,
      total: 2,
      pending: 1,
      accepted: 0,
      rejected: 1,
      unknown: 0,
    });
    expect(report.candidates.oldestPending).toMatchObject({
      id: pending.candidateId,
      status: "pending",
      kind: "insult",
      other: "contact:A",
      venue: TECH,
      ageTicks: 5,
    });
    expect(rendered).toContain("candidate review queue:");
    expect(rendered).toContain("pending=1");
    expect(rendered).toContain(`oldest_pending=${pending.candidateId}`);
    expect(rendered).toContain("shadow only: not fed to IAUS");
  });

  it("can render the diagnostic report as JSON for tooling", () => {
    writeSocialEvent(event({ id: "e1", kind: "boundary_violation", occurredAtMs: 1 }));

    const rendered = renderSocialCaseDiagnosticReport(analyzeSocialCases(), { json: true });
    const parsed = JSON.parse(rendered) as {
      pressureShadows: Array<{ repairState: string; boundaryStatus: string; pressure: number }>;
    };

    expect(parsed.pressureShadows[0]).toMatchObject({
      repairState: "reopened",
      boundaryStatus: "violated",
      pressure: 0.9,
    });
  });
});
