import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAliceDispatcher } from "../src/core/dispatcher.js";
import { closeDb, initDb } from "../src/db/connection.js";
import { listSocialEventsForRelation } from "../src/db/social-case.js";
import { WorldModel } from "../src/graph/world-model.js";
import { socialCaseMod } from "../src/mods/social-case.mod.js";

function makeDispatcher() {
  const dispatcher = createAliceDispatcher({
    graph: new WorldModel(),
    mods: [socialCaseMod],
  });
  dispatcher.startTick(42, 1_000_000);
  return dispatcher;
}

describe("ADR-262 social case self commands", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("records a typed social event through the explicit self command authority", () => {
    const dispatcher = makeDispatcher();

    const result = dispatcher.dispatch("social_case_note", {
      kind: "insult",
      other: "contact:A",
      venue: "技术群",
      visibility: "public",
      text: "Alice 你真的很蠢，别装懂了.",
      why: "This was public and attacked Alice's ability rather than the topic.",
      evidence: "1001, #1002",
      severity: "high",
      confidence: "high",
    }) as { success: true; eventId: string; currentRead: string; open: boolean };

    expect(result.success).toBe(true);
    expect(result.eventId).toMatch(/^social:42:/);
    expect(result.currentRead).toBe("Harm is still open.");
    expect(result.open).toBe(true);

    const [event] = listSocialEventsForRelation(["alice", "contact:A"]);
    expect(event).toMatchObject({
      id: result.eventId,
      caseId: expect.stringMatching(/^social-case:/),
      kind: "insult",
      actorId: "contact:A",
      targetId: "alice",
      venueId: "技术群",
      visibility: "public",
      evidenceMsgIds: [1001, 1002],
      severity: 0.8,
      confidence: 0.9,
    });
    expect(event.causes?.[0]).toMatchObject({
      kind: "social_meaning",
      text: "This was public and attacked Alice's ability rather than the topic.",
      visibility: "public",
    });
  });

  it("keeps explicit caseId when Alice records separate case files for the same person", () => {
    const dispatcher = makeDispatcher();

    dispatcher.dispatch("social_case_note", {
      caseId: "case:public-insult",
      kind: "insult",
      other: "contact:A",
      venue: "技术群",
      visibility: "public",
      text: "Alice 你真的很蠢，别装懂了.",
    });
    dispatcher.dispatch("social_case_note", {
      caseId: "case:later-obligation",
      kind: "obligation",
      other: "contact:A",
      venue: "private:A",
      visibility: "private",
      text: "A promised to send notes later.",
    });

    const events = listSocialEventsForRelation(["alice", "contact:A"]);

    expect(events.map((event) => event.caseId).sort()).toEqual([
      "case:later-obligation",
      "case:public-insult",
    ]);
  });

  it("uses hidden prompt context to keep notes attached to the visible case", () => {
    const dispatcher = makeDispatcher();

    dispatcher.dispatch("social_case_note", {
      kind: "insult",
      other: "contact:A",
      venue: "技术群",
      visibility: "public",
      text: "Alice 你真的很蠢，别装懂了.",
      __contextVars: {
        CURRENT_SOCIAL_CASE_ID: "case:visible-public-insult",
      },
    });

    dispatcher.dispatch("social_case_note", {
      kind: "boundary_violation",
      other: "contact:A",
      venue: "技术群",
      visibility: "public",
      text: "Alice 你还是很蠢。",
      __contextVars: {
        SOCIAL_CASE_0_ABOUT: "A / insult in 技术群",
        SOCIAL_CASE_0_HANDLE: "firm-repair",
        SOCIAL_CASE_0_ID: "case:visible-public-insult",
      },
      case: "firm-repair",
    });

    const events = listSocialEventsForRelation(["alice", "contact:A"]);

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.caseId)).toEqual([
      "case:visible-public-insult",
      "case:visible-public-insult",
    ]);
  });

  it("keeps legacy about phrase writeback for older prompt surfaces", () => {
    const dispatcher = makeDispatcher();

    dispatcher.dispatch("social_case_note", {
      kind: "insult",
      other: "contact:A",
      venue: "技术群",
      visibility: "public",
      text: "Alice 你真的很蠢，别装懂了.",
      __contextVars: {
        CURRENT_SOCIAL_CASE_ID: "case:visible-public-insult",
      },
    });

    dispatcher.dispatch("social_case_note", {
      kind: "boundary_violation",
      other: "contact:A",
      venue: "技术群",
      visibility: "public",
      text: "Alice 你还是很蠢。",
      __contextVars: {
        SOCIAL_CASE_0_ABOUT: "A / insult in 技术群",
        SOCIAL_CASE_0_ID: "case:visible-public-insult",
      },
      about: "A / insult in 技术群",
    });

    expect(
      listSocialEventsForRelation(["alice", "contact:A"]).map((event) => event.caseId),
    ).toEqual(["case:visible-public-insult", "case:visible-public-insult"]);
  });

  it("rejects an unmatched visible case handle instead of writing to the wrong case", () => {
    const dispatcher = makeDispatcher();

    const result = dispatcher.dispatch("social_case_note", {
      kind: "boundary_violation",
      other: "contact:A",
      venue: "技术群",
      visibility: "public",
      text: "Alice 你还是很蠢。",
      case: "missing-handle",
      __contextVars: {
        SOCIAL_CASE_0_HANDLE: "firm-repair",
        SOCIAL_CASE_0_ID: "case:visible-public-insult",
      },
    }) as { success: false; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("case handle");
    expect(listSocialEventsForRelation(["alice", "contact:A"])).toHaveLength(0);
  });

  it("rejects invalid evidence before writing a fact", () => {
    const dispatcher = makeDispatcher();

    const result = dispatcher.dispatch("social_case_note", {
      kind: "support",
      other: "contact:A",
      venue: "技术群",
      visibility: "public",
      evidence: "latest",
    }) as { success: false; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("evidence");
    expect(listSocialEventsForRelation(["alice", "contact:A"])).toHaveLength(0);
  });

  it("keeps possible social case events as review candidates until accepted", () => {
    const dispatcher = makeDispatcher();

    const candidate = dispatcher.dispatch("social_case_candidate", {
      kind: "insult",
      other: "contact:A",
      venue: "技术群",
      visibility: "public",
      text: "Alice 你真的很蠢，别装懂了.",
      why: "This may be a public personal attack, but it still needs review.",
      uncertainty: "Only one message is visible; review before writing a stable fact.",
      severity: "high",
      confidence: "medium",
    }) as { success: true; candidateId: string; writesSocialEvent: false };

    expect(candidate.success).toBe(true);
    expect(candidate.candidateId).toMatch(/^social-candidate:42:/);
    expect(candidate.writesSocialEvent).toBe(false);
    expect(listSocialEventsForRelation(["alice", "contact:A"])).toHaveLength(0);

    const publicQueue = dispatcher.query("social_case_candidates", {
      surface: "public",
    }) as string;
    expect(publicQueue).toContain(candidate.candidateId);
    expect(publicQueue).toContain("possible insult with contact:A in 技术群");
    expect(publicQueue).toContain("This may be a public personal attack");
    expect(publicQueue).not.toContain("Only one message is visible");

    const accepted = dispatcher.dispatch("social_case_accept_candidate", {
      candidate: candidate.candidateId,
      reason: "The public wording is a direct personal attack.",
    }) as {
      success: true;
      candidateId: string;
      eventId: string;
      currentRead: string;
      open: boolean;
    };

    expect(accepted.success).toBe(true);
    expect(accepted.candidateId).toBe(candidate.candidateId);
    expect(accepted.eventId).toMatch(/^social:42:/);
    expect(accepted.currentRead).toBe("Harm is still open.");
    expect(accepted.open).toBe(true);

    const [event] = listSocialEventsForRelation(["alice", "contact:A"]);
    expect(event).toMatchObject({
      id: accepted.eventId,
      kind: "insult",
      confidence: 0.65,
    });
  });

  it("rejects possible social case events without writing stable facts", () => {
    const dispatcher = makeDispatcher();

    const candidate = dispatcher.dispatch("social_case_candidate", {
      kind: "exclusion",
      other: "contact:A",
      venue: "技术群",
      visibility: "public",
      text: "No one replied to Alice yet.",
      why: "This is a weak exclusion signal.",
      confidence: "low",
    }) as { success: true; candidateId: string };

    const rejected = dispatcher.dispatch("social_case_reject_candidate", {
      candidate: candidate.candidateId,
      reason: "Too weak; silence alone is not a stable social case fact.",
    }) as { success: true; status: "rejected"; writesSocialEvent: false };

    expect(rejected.success).toBe(true);
    expect(rejected.status).toBe("rejected");
    expect(rejected.writesSocialEvent).toBe(false);
    expect(listSocialEventsForRelation(["alice", "contact:A"])).toHaveLength(0);

    const accepted = dispatcher.dispatch("social_case_accept_candidate", {
      candidate: candidate.candidateId,
    }) as { success: false; error: string };
    expect(accepted.success).toBe(false);
    expect(accepted.error).toContain("already rejected");
  });

  it("accepts a candidate into the hidden case selected by prompt handle", () => {
    const dispatcher = makeDispatcher();

    const candidate = dispatcher.dispatch("social_case_candidate", {
      kind: "boundary_violation",
      other: "contact:A",
      venue: "技术群",
      visibility: "public",
      text: "Alice 你还是很蠢。",
      case: "firm-repair",
      __contextVars: {
        SOCIAL_CASE_0_HANDLE: "firm-repair",
        SOCIAL_CASE_0_ID: "case:visible-public-insult",
      },
    }) as { success: true; candidateId: string };

    dispatcher.dispatch("social_case_accept_candidate", {
      candidate: candidate.candidateId,
    });

    const [event] = listSocialEventsForRelation(["alice", "contact:A"]);
    expect(event.caseId).toBe("case:visible-public-insult");
    expect(event.kind).toBe("boundary_violation");
  });

  it("suggests an explicitly hinted insult as a review candidate without writing facts", () => {
    const dispatcher = makeDispatcher();

    const suggested = dispatcher.dispatch("social_case_suggest_candidate", {
      kindHint: "insult",
      other: "contact:A",
      venue: "技术群",
      visibility: "public",
      speaker: "contact:A",
      target: "Alice",
      text: "你真的很蠢，别装懂了。",
      evidence: "1001",
    }) as {
      success: true;
      candidateCreated: true;
      candidateId: string;
      kind: "insult";
      writesSocialEvent: false;
    };

    expect(suggested.success).toBe(true);
    expect(suggested.candidateCreated).toBe(true);
    expect(suggested.candidateId).toMatch(/^social-candidate:42:/);
    expect(suggested.kind).toBe("insult");
    expect(suggested.writesSocialEvent).toBe(false);
    expect(listSocialEventsForRelation(["alice", "contact:A"])).toHaveLength(0);

    const queue = dispatcher.query("social_case_candidates", {
      surface: "public",
    }) as string;
    expect(queue).toContain("possible insult with contact:A in 技术群");
    expect(queue).toContain("public personal attack on Alice");

    const accepted = dispatcher.dispatch("social_case_accept_candidate", {
      candidate: suggested.candidateId,
      reason: "The wording directly attacked Alice.",
    }) as { success: true; eventId: string };

    expect(accepted.success).toBe(true);
    const [event] = listSocialEventsForRelation(["alice", "contact:A"]);
    expect(event).toMatchObject({
      id: accepted.eventId,
      kind: "insult",
      actorId: "contact:A",
      targetId: "alice",
      evidenceMsgIds: [1001],
      confidence: 0.65,
    });
  });

  it("does not infer a suggested candidate without an explicit kind hint", () => {
    const dispatcher = makeDispatcher();

    const suggested = dispatcher.dispatch("social_case_suggest_candidate", {
      other: "contact:A",
      venue: "技术群",
      visibility: "public",
      speaker: "contact:A",
      target: "Alice",
      text: "Alice 我不同意这个方案，缓存策略这里可能不对。",
    }) as {
      success: true;
      candidateCreated: false;
      writesSocialEvent: false;
      reason: string;
    };

    expect(suggested.success).toBe(true);
    expect(suggested.candidateCreated).toBe(false);
    expect(suggested.writesSocialEvent).toBe(false);
    expect(suggested.reason).toContain("No explicit");
    expect(dispatcher.query("social_case_candidates", {})).toBe("(no social case candidates)");
    expect(listSocialEventsForRelation(["alice", "contact:A"])).toHaveLength(0);
  });

  it("keeps weak exclusion suggestions pending and out of stable facts", () => {
    const dispatcher = makeDispatcher();

    const suggested = dispatcher.dispatch("social_case_suggest_candidate", {
      kindHint: "exclusion",
      other: "contact:A",
      venue: "技术群",
      visibility: "public",
      speaker: "Alice",
      target: "Alice",
      text: "Alice 发言后没人回复，过了一会儿大家回复了复述者。",
      evidence: "1201,1202",
    }) as {
      success: true;
      candidateCreated: true;
      candidateId: string;
      kind: "exclusion";
      writesSocialEvent: false;
    };

    expect(suggested.success).toBe(true);
    expect(suggested.kind).toBe("exclusion");
    expect(suggested.writesSocialEvent).toBe(false);
    expect(listSocialEventsForRelation(["alice", "contact:A"])).toHaveLength(0);

    const queue = dispatcher.query("social_case_candidates", {
      surface: "private",
    }) as string;
    expect(queue).toContain(suggested.candidateId);
    expect(queue).toContain("possible exclusion with contact:A in 技术群");
    expect(queue).toContain("weak social signal");
  });

  it("suggested candidates keep hidden prompt case writeback", () => {
    const dispatcher = makeDispatcher();

    const suggested = dispatcher.dispatch("social_case_suggest_candidate", {
      kindHint: "boundary_violation",
      other: "contact:A",
      venue: "技术群",
      visibility: "public",
      speaker: "contact:A",
      target: "Alice",
      text: "你还是很蠢。",
      case: "firm-repair",
      __contextVars: {
        SOCIAL_CASE_0_HANDLE: "firm-repair",
        SOCIAL_CASE_0_ID: "case:visible-public-insult",
      },
    }) as { success: true; candidateCreated: true; candidateId: string };

    dispatcher.dispatch("social_case_accept_candidate", {
      candidate: suggested.candidateId,
    });

    const [event] = listSocialEventsForRelation(["alice", "contact:A"]);
    expect(event.caseId).toBe("case:visible-public-insult");
    expect(event.kind).toBe("boundary_violation");
  });

  it("restores pending review candidates from persisted mod state before writing facts", () => {
    const first = makeDispatcher();

    const suggested = first.dispatch("social_case_suggest_candidate", {
      caseId: "case:restart-review",
      kindHint: "support",
      other: "contact:B",
      venue: "技术群",
      visibility: "public",
      speaker: "contact:B",
      target: "Alice",
      text: "Alice 刚才说得没问题，先别攻击人。",
      evidence: "2001",
    }) as {
      success: true;
      candidateCreated: true;
      candidateId: string;
      writesSocialEvent: false;
    };

    expect(suggested.success).toBe(true);
    expect(suggested.writesSocialEvent).toBe(false);
    expect(listSocialEventsForRelation(["alice", "contact:B"])).toHaveLength(0);
    first.saveModStatesToDb(42);

    const second = createAliceDispatcher({
      graph: new WorldModel(),
      mods: [socialCaseMod],
    });
    expect(second.loadModStatesFromDb()).toBe(true);
    second.startTick(43, 1_001_000);

    const queue = second.query("social_case_candidates", {
      surface: "private",
    }) as string;
    expect(queue).toContain(suggested.candidateId);
    expect(queue).toContain("possible support with contact:B in 技术群");
    expect(listSocialEventsForRelation(["alice", "contact:B"])).toHaveLength(0);

    const accepted = second.dispatch("social_case_accept_candidate", {
      candidate: suggested.candidateId,
      reason: "Recovered pending candidate after restart.",
    }) as { success: true; eventId: string; status: "accepted" };

    expect(accepted.success).toBe(true);
    expect(accepted.status).toBe("accepted");
    const [event] = listSocialEventsForRelation(["alice", "contact:B"]);
    expect(event).toMatchObject({
      id: accepted.eventId,
      caseId: "case:restart-review",
      kind: "support",
      actorId: "contact:B",
      targetId: "alice",
      evidenceMsgIds: [2001],
    });
  });

  it("shows public case briefs without leaking private cause text", () => {
    const dispatcher = makeDispatcher();
    dispatcher.dispatch("social_case_note", {
      kind: "repair_attempt",
      other: "contact:A",
      venue: "private:A",
      visibility: "private",
      why: "A said privately that they were angry and spoke too harshly.",
      whyVisibility: "private",
      severity: "low",
      confidence: "medium",
    });

    const rendered = dispatcher.query("social_cases", {
      other: "contact:A",
      surface: "public",
      openOnly: true,
    }) as string;

    expect(rendered).toContain("Social case with contact:A");
    expect(rendered).toContain("private detail(s) exist");
    expect(rendered).not.toContain("angry and spoke too harshly");
  });
});
