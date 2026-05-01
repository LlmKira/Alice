/**
 * ADR-262 Wave 2B: explicit social case fact entry.
 *
 * This Mod is a narrow write authority. It lets Alice record typed social
 * events through a natural `self` command, while keeping state as projection.
 *
 * @see docs/adr/262-social-case-management/README.md
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { createMod } from "../core/mod-builder.js";
import {
  listSocialEvents,
  listSocialEventsForRelation,
  writeSocialEvent,
} from "../db/social-case.js";
import { appraiseSocialEventEmotion } from "../emotion/appraisal.js";
import { deriveSocialCaseIdFromContext } from "../social-case/context.js";
import { projectSocialCases, renderSocialCaseBrief } from "../social-case/index.js";
import {
  SOCIAL_EVENT_KINDS,
  type SocialEvent,
  type SocialEventKind,
  type SocialVisibility,
} from "../social-case/types.js";

const SELF_ID = "alice";
const VISIBILITIES = ["private", "public", "semi_public"] as const;
const SEVERITIES = ["low", "moderate", "high", "severe"] as const;
const CONFIDENCES = ["low", "medium", "high"] as const;
const CANDIDATE_STATUSES = ["pending", "accepted", "rejected", "all"] as const;
const MAX_CANDIDATES = 50;
const SELF_ALIASES = new Set(["alice", "self", "你", "爱丽丝"]);

type SeverityLabel = (typeof SEVERITIES)[number];
type ConfidenceLabel = (typeof CONFIDENCES)[number];
type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

interface SocialCaseState {
  candidates: SocialCaseCandidate[];
}

interface SocialCaseCandidate {
  id: string;
  status: Exclude<CandidateStatus, "all">;
  event: SocialEvent;
  other: string;
  createdTick: number;
  createdAtMs: number;
  uncertainty?: string;
  reviewedTick?: number;
  reviewedAtMs?: number;
  reviewReason?: string;
}

interface BuiltSocialEvent {
  event: SocialEvent;
  kind: SocialEventKind;
  other: string;
}

interface SuggestedCandidateDraft {
  args: Record<string, unknown>;
  uncertainty: string;
}

const ALICE_ACTOR_KINDS = new Set<SocialEventKind>([
  "forgiveness",
  "boundary_set",
  "repair_attempt",
]);

function scoreSeverity(value: SeverityLabel): number {
  switch (value) {
    case "low":
      return 0.25;
    case "moderate":
      return 0.5;
    case "high":
      return 0.8;
    case "severe":
      return 1;
  }
}

function scoreConfidence(value: ConfidenceLabel): number {
  switch (value) {
    case "low":
      return 0.35;
    case "medium":
      return 0.65;
    case "high":
      return 0.9;
  }
}

function defaultActor(kind: SocialEventKind, other: string): string {
  return ALICE_ACTOR_KINDS.has(kind) ? SELF_ID : other;
}

function socialCaseEventParams(confidenceDefault: ConfidenceLabel): z.ZodRawShape {
  return {
    kind: z
      .enum(SOCIAL_EVENT_KINDS)
      .describe(
        "social event kind. Use repair_rejected for fake apology, betrayal for cross-context betrayal, and boundary_violation only when someone repeats a harm after repair or a boundary.",
      ),
    other: z.string().trim().min(1).describe("person this Alice-centered case is with"),
    venue: z.string().trim().min(1).describe("where it happened"),
    visibility: z.enum(VISIBILITIES).describe("who could see it"),
    actor: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("who did it; use Alice when Alice caused harm or is apologizing"),
    target: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("who was affected; defaults to Alice, use the other person when Alice caused harm"),
    text: z.string().trim().min(1).max(1000).optional().describe("short observed text"),
    why: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .optional()
      .describe("why this matters or what makes it count"),
    whyVisibility: z
      .enum(VISIBILITIES)
      .optional()
      .describe("visibility of why; defaults to event visibility"),
    evidence: z
      .string()
      .trim()
      .optional()
      .describe("comma-separated visible msgIds, for example 12001,12002"),
    repairs: z.string().trim().min(1).optional().describe("event id this repairs, if known"),
    about: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("visible case phrase from the social case brief, when several cases are shown"),
    case: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("visible case handle from the social case brief, for example firm-repair"),
    caseId: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("internal case file id injected from context; do not write this by hand"),
    boundary: z.string().trim().min(1).optional().describe("boundary text, if one was set"),
    severity: z.enum(SEVERITIES).default("moderate").describe("low|moderate|high|severe"),
    confidence: z.enum(CONFIDENCES).default(confidenceDefault).describe("low|medium|high"),
  };
}

function parseEvidence(raw: string | undefined): number[] | { error: string } {
  if (!raw?.trim()) return [];
  const values = raw
    .split(",")
    .map((item) => item.trim().replace(/^#/, ""))
    .filter(Boolean);
  const ids = values.map((item) => Number(item));
  if (ids.some((item) => !Number.isSafeInteger(item) || item <= 0)) {
    return { error: "evidence must be comma-separated visible positive msgIds" };
  }
  return ids;
}

function makeEventId(input: {
  tick: number;
  kind: SocialEventKind;
  actor: string;
  other: string;
  venue: string;
  text?: string;
  occurredAtMs: number;
  scope?: string;
}): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        input.scope ?? "direct",
        input.tick,
        input.occurredAtMs,
        input.kind,
        input.actor,
        input.other,
        input.venue,
        input.text ?? "",
      ]),
    )
    .digest("hex")
    .slice(0, 16);
  return `social:${input.tick}:${hash}`;
}

function makeCandidateId(input: {
  tick: number;
  kind: SocialEventKind;
  other: string;
  venue: string;
  text?: string;
  occurredAtMs: number;
}): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        input.tick,
        input.occurredAtMs,
        input.kind,
        input.other,
        input.venue,
        input.text ?? "",
      ]),
    )
    .digest("hex")
    .slice(0, 16);
  return `social-candidate:${input.tick}:${hash}`;
}

function makeCaseId(input: { other: string; seed?: string }): string {
  const seed = input.seed?.trim();
  if (seed) return seed;
  const hash = createHash("sha256").update(input.other).digest("hex").slice(0, 16);
  return `social-case:${hash}`;
}

function buildSocialEvent(
  ctx: { tick: number; nowMs: number },
  args: Record<string, unknown>,
  scope: string,
): BuiltSocialEvent | { error: string } {
  const kind = args.kind as SocialEventKind;
  const other = args.other as string;
  const venue = args.venue as string;
  const actor = (args.actor as string | undefined) ?? defaultActor(kind, other);
  const evidence = parseEvidence(args.evidence as string | undefined);
  if ("error" in evidence) return { error: evidence.error };

  const event: SocialEvent = {
    id: makeEventId({
      tick: ctx.tick,
      kind,
      actor,
      other,
      venue,
      text: args.text as string | undefined,
      occurredAtMs: ctx.nowMs,
      scope,
    }),
    caseId: makeCaseId({ other, seed: args.caseId as string | undefined }),
    kind,
    actorId: actor,
    targetId: (args.target as string | undefined) ?? SELF_ID,
    affectedRelation: [SELF_ID, other],
    venueId: venue,
    visibility: args.visibility as SocialVisibility,
    witnesses: [],
    severity: scoreSeverity(args.severity as SeverityLabel),
    confidence: scoreConfidence(args.confidence as ConfidenceLabel),
    evidenceMsgIds: evidence,
    occurredAtMs: ctx.nowMs,
    text: args.text as string | undefined,
    repairsEventId: args.repairs as string | undefined,
    boundaryText: args.boundary as string | undefined,
    causes: args.why
      ? [
          {
            kind: "social_meaning",
            text: args.why as string,
            visibility: ((args.whyVisibility as SocialVisibility | undefined) ??
              args.visibility) as SocialVisibility,
            venueId: venue,
          },
        ]
      : undefined,
  };
  return { event, kind, other };
}

function writeEventAndProject(
  event: SocialEvent,
  other: string,
  graph?: Parameters<typeof appraiseSocialEventEmotion>[0],
): {
  success: true;
  eventId: string;
  kind: SocialEventKind;
  other: string;
  currentRead: string;
  open: boolean;
} {
  writeSocialEvent(event);
  if (graph) appraiseSocialEventEmotion(graph, event, event.occurredAtMs);
  const [projection] = projectSocialCases(listSocialEventsForRelation([SELF_ID, other]));
  return {
    success: true,
    eventId: event.id,
    kind: event.kind,
    other,
    currentRead: projection?.currentRead ?? "No open social case.",
    open: projection?.open ?? false,
  };
}

function enqueueCandidate(
  ctx: { state: SocialCaseState; tick: number; nowMs: number },
  args: Record<string, unknown>,
  scope: string,
  uncertainty?: string,
):
  | {
      success: true;
      candidateId: string;
      kind: SocialEventKind;
      other: string;
      status: SocialCaseCandidate["status"];
      writesSocialEvent: false;
      duplicate?: boolean;
    }
  | { success: false; error: string; writesSocialEvent: false } {
  if (args.case && !args.caseId) {
    return {
      success: false,
      error:
        "case handle is not available in this prompt context; read self social-cases again or omit --case",
      writesSocialEvent: false,
    };
  }
  const built = buildSocialEvent(ctx, args, scope);
  if ("error" in built) return { success: false, error: built.error, writesSocialEvent: false };
  const candidateId = makeCandidateId({
    tick: ctx.tick,
    kind: built.kind,
    other: built.other,
    venue: built.event.venueId,
    text: built.event.text,
    occurredAtMs: ctx.nowMs,
  });
  const queue = candidateQueue(ctx.state);
  const existing = queue.find((candidate) => candidate.id === candidateId);
  if (existing) {
    return {
      success: true,
      candidateId,
      kind: built.kind,
      other: built.other,
      status: existing.status,
      writesSocialEvent: false,
      duplicate: true,
    };
  }
  queue.push({
    id: candidateId,
    status: "pending",
    event: built.event,
    other: built.other,
    createdTick: ctx.tick,
    createdAtMs: ctx.nowMs,
    uncertainty,
  });
  trimCandidateQueue(ctx.state);
  return {
    success: true,
    candidateId,
    kind: built.kind,
    other: built.other,
    status: "pending",
    writesSocialEvent: false,
  };
}

function candidateQueue(state: SocialCaseState): SocialCaseCandidate[] {
  if (!Array.isArray(state.candidates)) state.candidates = [];
  return state.candidates;
}

function trimCandidateQueue(state: SocialCaseState): void {
  state.candidates = candidateQueue(state).slice(-MAX_CANDIDATES);
}

function isVisibleOnSurface(event: SocialEvent, surface: SocialVisibility): boolean {
  return surface === "private" || event.visibility !== "private";
}

function renderCandidate(candidate: SocialCaseCandidate, surface: SocialVisibility): string {
  const event = candidate.event;
  const lines = [
    `${candidate.id} [${candidate.status}]: possible ${event.kind} with ${candidate.other} in ${event.venueId}.`,
  ];
  if (isVisibleOnSurface(event, surface) && event.text) {
    lines.push(`- Observed: "${event.text}"`);
  } else if (!isVisibleOnSurface(event, surface)) {
    lines.push("- Private event text is hidden on this surface.");
  }

  let hidden = 0;
  for (const cause of event.causes ?? []) {
    if (surface === "private" || cause.visibility !== "private") {
      lines.push(`- Why: ${cause.text}`);
    } else {
      hidden++;
    }
  }
  if (candidate.uncertainty) {
    if (surface === "private") {
      lines.push(`- Review note: ${candidate.uncertainty}`);
    } else {
      hidden++;
    }
  }
  if (hidden > 0) lines.push(`- ${hidden} private review detail(s) hidden.`);
  if (candidate.status === "pending") {
    lines.push(
      `- To approve: self social-case-accept-candidate --candidate ${candidate.id}`,
      `- To reject: self social-case-reject-candidate --candidate ${candidate.id} --reason "..."`,
    );
  }
  return lines.join("\n");
}

function normalizeSelfAlias(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return SELF_ALIASES.has(trimmed.toLowerCase()) ? SELF_ID : trimmed;
}

function causeText(args: {
  kind: SocialEventKind;
  visibility: SocialVisibility;
  text: string;
  suppliedWhy?: string;
}): string {
  const supplied = args.suppliedWhy?.trim();
  if (supplied) return supplied;
  switch (args.kind) {
    case "insult":
      return args.visibility === "public"
        ? "This looks like a public personal attack on Alice rather than ordinary topic disagreement."
        : "This looks like a direct personal attack on Alice rather than ordinary topic disagreement.";
    case "apology":
      return "This looks like an apology or repair attempt directed toward Alice.";
    case "support":
      return "This looks like visible support for Alice in a socially tense exchange.";
    case "exclusion":
      return "This is only a possible exclusion signal; lack of response can have many causes.";
    case "boundary_violation":
      return "This was suggested as a possible repeat of a prior boundary problem and needs review.";
    case "forgiveness":
      return "This was suggested as possible forgiveness and needs review before becoming a stable fact.";
    case "boundary_set":
      return "This was suggested as a possible boundary and needs review before becoming a stable fact.";
    default:
      return `This was suggested as a possible ${args.kind} social case event and needs review.`;
  }
}

function suggestedUncertainty(kind: SocialEventKind, source: "hint" | "weak"): string {
  if (source === "hint") {
    return `Generated from an explicit ${kind} hint; review the observed context before accepting as a stable social fact.`;
  }
  return "Generated from a weak social signal. Review carefully; silence or non-response alone is not stable proof.";
}

function suggestionProfile(kind: SocialEventKind): {
  kind: SocialEventKind;
  severity: SeverityLabel;
  confidence: ConfidenceLabel;
  source: "hint" | "weak";
} | null {
  return {
    kind,
    severity: kind === "insult" || kind === "boundary_violation" ? "high" : "moderate",
    confidence: kind === "exclusion" ? "low" : "medium",
    source: kind === "exclusion" ? "weak" : "hint",
  };
}

function buildSuggestedCandidateDraft(
  args: Record<string, unknown>,
): SuggestedCandidateDraft | null {
  const text = args.text as string;
  const visibility = args.visibility as SocialVisibility;
  const target = normalizeSelfAlias(args.target as string | undefined);
  const kindHint = args.kindHint as SocialEventKind | undefined;
  if (!kindHint) return null;
  const suggestion = suggestionProfile(kindHint);
  if (!suggestion) return null;

  const other = args.other as string;
  const actor =
    normalizeSelfAlias(args.speaker as string | undefined) ?? defaultActor(suggestion.kind, other);
  const eventArgs: Record<string, unknown> = {
    kind: suggestion.kind,
    other,
    venue: args.venue,
    visibility,
    actor,
    target: target ?? SELF_ID,
    text,
    evidence: args.evidence,
    about: args.about,
    case: args.case,
    caseId: args.caseId,
    why: causeText({
      kind: suggestion.kind,
      visibility,
      text,
      suppliedWhy: args.why as string | undefined,
    }),
    whyVisibility: args.whyVisibility ?? visibility,
    severity: suggestion.severity,
    confidence: suggestion.confidence,
  };
  return {
    args: eventArgs,
    uncertainty: suggestedUncertainty(suggestion.kind, suggestion.source),
  };
}

export const socialCaseMod = createMod<SocialCaseState>("social_case", {
  category: "mechanic",
  description: "Alice-centered social case facts",
  topics: ["social"],
  initialState: { candidates: [] },
})
  .instruction("social_case_note", {
    params: z.object(socialCaseEventParams("high")),
    description: "Record an Alice-centered social case event fact",
    deriveParams: {
      caseId: deriveSocialCaseIdFromContext,
    },
    affordance: {
      whenToUse:
        "Record a stable social case event such as insult, apology, forgiveness, support, repair_rejected, betrayal, or boundary_violation. Use boundary_violation only for repeated harm after repair or a boundary.",
      whenNotToUse: "For ordinary memories with no social case state; use self note instead",
      priority: "capability",
      category: "social",
    },
    impl(ctx, args) {
      if (args.case && !args.caseId) {
        return {
          success: false,
          error:
            "case handle is not available in this prompt context; read self social-cases again or omit --case",
        };
      }
      const built = buildSocialEvent(ctx, args, "direct");
      if ("error" in built) return { success: false, error: built.error };
      return writeEventAndProject(built.event, built.other, ctx.graph);
    },
  })
  .instruction("social_case_candidate", {
    params: z.object({
      ...socialCaseEventParams("medium"),
      uncertainty: z
        .string()
        .trim()
        .min(1)
        .max(1000)
        .optional()
        .describe("why this should stay as a review candidate instead of a stable fact"),
    }),
    description: "Save a possible social case event for later review without writing a stable fact",
    deriveParams: {
      caseId: deriveSocialCaseIdFromContext,
    },
    affordance: {
      whenToUse:
        "Use when a social event might matter but is not stable enough to record as fact yet. This creates a review candidate only.",
      whenNotToUse: "When the event is already known and stable; use self social-case-note instead",
      priority: "capability",
      category: "social",
    },
    impl(ctx, args) {
      return enqueueCandidate(ctx, args as Record<string, unknown>, "candidate", args.uncertainty);
    },
  })
  .instruction("social_case_suggest_candidate", {
    params: z.object({
      other: z.string().trim().min(1).describe("person this Alice-centered case is with"),
      venue: z.string().trim().min(1).describe("where the observed interaction happened"),
      visibility: z.enum(VISIBILITIES).describe("who could see the observed interaction"),
      speaker: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("who produced the observed text; defaults to other"),
      target: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("who the observed text was aimed at, if known; Alice/self/你 all mean Alice"),
      text: z.string().trim().min(1).max(1000).describe("raw observed message or observation"),
      kindHint: z
        .enum(SOCIAL_EVENT_KINDS)
        .optional()
        .describe("optional explicit event kind hint; still creates only a review candidate"),
      why: z
        .string()
        .trim()
        .min(1)
        .max(1000)
        .optional()
        .describe("optional human reason for why this may matter socially"),
      whyVisibility: z.enum(VISIBILITIES).optional().describe("visibility of why"),
      evidence: z
        .string()
        .trim()
        .optional()
        .describe("comma-separated visible msgIds, for example 12001,12002"),
      about: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("visible case phrase from the social case brief, when several cases are shown"),
      case: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("visible case handle from the social case brief, for example firm-repair"),
      caseId: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("internal case file id injected from context; do not write this by hand"),
    }),
    description: "Suggest a possible social case review candidate from a raw observation",
    deriveParams: {
      caseId: deriveSocialCaseIdFromContext,
    },
    affordance: {
      whenToUse:
        "Use when a raw observation has an explicit possible social event kind such as insult, apology, support, or weak exclusion. It creates a review candidate only.",
      whenNotToUse:
        "Do not use this for ordinary disagreement or neutral chat. Without an explicit kindHint, no candidate is created.",
      priority: "capability",
      category: "social",
    },
    impl(ctx, args) {
      const rawArgs = args as Record<string, unknown>;
      const draft = buildSuggestedCandidateDraft(rawArgs);
      if (!draft) {
        return {
          success: true,
          candidateCreated: false,
          writesSocialEvent: false,
          reason: "No explicit social case kind hint was provided; no review candidate created.",
        };
      }
      const result = enqueueCandidate(ctx, draft.args, "suggested-candidate", draft.uncertainty);
      if (!result.success) return { ...result, candidateCreated: false };
      return { ...result, candidateCreated: true };
    },
  })
  .instruction("social_case_accept_candidate", {
    params: z.object({
      candidate: z.string().trim().min(1).describe("candidate id from self social-case-candidates"),
      reason: z.string().trim().min(1).max(1000).optional().describe("why it is accepted"),
    }),
    description:
      "Approve a pending social case candidate and write it as a stable social event fact",
    affordance: {
      whenToUse:
        "Use only after a pending social case candidate has been reviewed and should become a stable fact.",
      whenNotToUse:
        "Do not use for uncertain or weak signals; reject or leave the candidate pending instead",
      priority: "capability",
      category: "social",
    },
    impl(ctx, args) {
      const candidate = candidateQueue(ctx.state).find((item) => item.id === args.candidate);
      if (!candidate) return { success: false, error: "candidate not found" };
      if (candidate.status !== "pending") {
        return { success: false, error: `candidate is already ${candidate.status}` };
      }
      const result = writeEventAndProject(candidate.event, candidate.other, ctx.graph);
      candidate.status = "accepted";
      candidate.reviewedTick = ctx.tick;
      candidate.reviewedAtMs = ctx.nowMs;
      candidate.reviewReason = args.reason;
      return { ...result, candidateId: candidate.id, status: candidate.status };
    },
  })
  .instruction("social_case_reject_candidate", {
    params: z.object({
      candidate: z.string().trim().min(1).describe("candidate id from self social-case-candidates"),
      reason: z.string().trim().min(1).max(1000).optional().describe("why it is rejected"),
    }),
    description:
      "Reject a pending social case candidate without writing a stable social event fact",
    affordance: {
      whenToUse:
        "Use when a pending social case candidate is weak, mistaken, ordinary banter, or lacks enough evidence.",
      whenNotToUse: "Do not use for confirmed stable social case facts; approve instead",
      priority: "capability",
      category: "social",
    },
    impl(ctx, args) {
      const candidate = candidateQueue(ctx.state).find((item) => item.id === args.candidate);
      if (!candidate) return { success: false, error: "candidate not found" };
      if (candidate.status !== "pending") {
        return { success: false, error: `candidate is already ${candidate.status}` };
      }
      candidate.status = "rejected";
      candidate.reviewedTick = ctx.tick;
      candidate.reviewedAtMs = ctx.nowMs;
      candidate.reviewReason = args.reason;
      return {
        success: true,
        candidateId: candidate.id,
        status: candidate.status,
        writesSocialEvent: false,
      };
    },
  })
  .query("social_cases", {
    params: z.object({
      other: z.string().trim().min(1).optional().describe("person to inspect"),
      surface: z.enum(VISIBILITIES).default("private").describe("private|public|semi_public"),
      openOnly: z.boolean().default(true).describe("only show open cases"),
      limit: z.number().int().positive().max(10).default(5).describe("maximum case count"),
    }),
    description: "Inspect Alice-centered social cases",
    affordance: {
      whenToUse: "Review open social cases before responding in a socially sensitive situation",
      whenNotToUse: "When no prior social case is relevant",
      priority: "sensor",
    },
    returns: "string",
    returnHint: "Human-readable social case briefs with private details hidden on public surfaces",
    impl(_ctx, args) {
      const events = args.other
        ? listSocialEventsForRelation([SELF_ID, args.other])
        : listSocialEvents();
      let cases = projectSocialCases(events);
      if (args.openOnly) cases = cases.filter((item) => item.open);
      cases = cases.slice(0, args.limit);
      if (cases.length === 0) return "(no social cases)";
      return cases
        .map((item) =>
          renderSocialCaseBrief(item, {
            selfId: SELF_ID,
            surfaceVisibility: args.surface as SocialVisibility,
          }),
        )
        .join("\n\n---\n\n");
    },
  })
  .query("social_case_candidates", {
    params: z.object({
      status: z
        .enum(CANDIDATE_STATUSES)
        .default("pending")
        .describe("pending|accepted|rejected|all"),
      surface: z.enum(VISIBILITIES).default("private").describe("private|public|semi_public"),
      limit: z.number().int().positive().max(20).default(10).describe("maximum candidate count"),
    }),
    description: "Inspect possible social case events waiting for review",
    affordance: {
      whenToUse: "Review possible social case events before approving or rejecting them",
      whenNotToUse: "When you need stable case facts; use self social-cases instead",
      priority: "sensor",
    },
    returns: "string",
    returnHint:
      "Pending/accepted/rejected social case candidates; pending items can be approved or rejected",
    impl(ctx, args) {
      const status = args.status as CandidateStatus;
      const surface = args.surface as SocialVisibility;
      const candidates = candidateQueue(ctx.state)
        .filter((candidate) => status === "all" || candidate.status === status)
        .slice(-args.limit);
      if (candidates.length === 0) return "(no social case candidates)";
      return candidates.map((candidate) => renderCandidate(candidate, surface)).join("\n\n---\n\n");
    },
  })
  .build();
