import { createHash } from "node:crypto";
import type { BoundaryStatus, RepairState, SocialCaseProjection, SocialEvent } from "./types.js";

const HARM_KINDS = new Set<SocialEvent["kind"]>([
  "insult",
  "exclusion",
  "betrayal",
  "boundary_violation",
  "repair_rejected",
]);

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function relationKey(relation: readonly [string, string]): string {
  const [a, b] = relation;
  return [a, b].sort().join("::");
}

function displayPairFromRelationKey(relationKeyValue: string): readonly [string, string] {
  const [a, b] = relationKeyValue.split("::");
  return [a, b] as const;
}

function legacyCaseIdForRelation(relationKeyValue: string): string {
  const hash = createHash("sha256").update(relationKeyValue).digest("hex").slice(0, 16);
  return `social-case:${hash}`;
}

function caseKey(event: SocialEvent): string {
  const explicitCaseId = event.caseId?.trim();
  return explicitCaseId
    ? `case:${explicitCaseId}`
    : `case:${legacyCaseIdForRelation(relationKey(event.affectedRelation))}`;
}

function caseIdFromKey(key: string): string {
  if (key.startsWith("case:")) return key.slice("case:".length);
  return `social_case:${key}`;
}

function isPublicHarm(event: SocialEvent): boolean {
  return event.visibility === "public" || event.visibility === "semi_public";
}

function repairMatchesHarm(repair: SocialEvent, harm: SocialEvent): boolean {
  return (
    repair.repairsEventId === harm.id ||
    relationKey(repair.affectedRelation) === relationKey(harm.affectedRelation)
  );
}

function hasLaterHarm(events: readonly SocialEvent[], atMs: number): boolean {
  return events.some((event) => event.occurredAtMs > atMs && HARM_KINDS.has(event.kind));
}

function deriveCurrentRead(input: {
  repairState: RepairState;
  boundaryStatus: BoundaryStatus;
  venueDebt: number;
  repairDebt: number;
}): string {
  if (input.repairState === "reopened") {
    return input.boundaryStatus === "violated"
      ? "Reopened by a repeated boundary violation."
      : "Reopened by a later harmful event.";
  }
  if (input.repairState === "forgiven_with_boundary") {
    return "Mostly repaired, with a boundary. A repeat of the same harm would reopen the case.";
  }
  if (input.repairState === "clarification_pending") {
    return "Harm is open and clarification is pending.";
  }
  if (input.repairState === "harm_open") {
    return "Harm is still open.";
  }
  if (input.venueDebt > 0) {
    return "Still not fully repaired in the place where the harm was visible.";
  }
  if (input.repairState === "apology_offered") {
    return "Repair has started, but closure is not established yet.";
  }
  if (input.repairDebt > 0) {
    return "There is unresolved social debt.";
  }
  return "No open social case.";
}

export function projectSocialCases(events: readonly SocialEvent[]): SocialCaseProjection[] {
  const byCase = new Map<string, SocialEvent[]>();
  for (const event of events) {
    const key = caseKey(event);
    const bucket = byCase.get(key) ?? [];
    bucket.push(event);
    byCase.set(key, bucket);
  }

  return [...byCase.entries()]
    .map(([key, caseEvents]) => projectSingleCase(key, caseEvents))
    .sort((a, b) => {
      const aLast = a.events.at(-1)?.occurredAtMs ?? 0;
      const bLast = b.events.at(-1)?.occurredAtMs ?? 0;
      return bLast - aLast;
    });
}

export function projectSingleCase(
  key: string,
  inputEvents: readonly SocialEvent[],
): SocialCaseProjection {
  const events = [...inputEvents].sort((a, b) => a.occurredAtMs - b.occurredAtMs);
  const displayRelationKey = relationKey(
    events[0]?.affectedRelation ?? displayPairFromRelationKey(key),
  );
  let repairState: RepairState = "none";
  let boundaryStatus: BoundaryStatus = "none";
  let unresolvedTension = 0;
  let repairDebt = 0;
  let venueDebt = 0;
  let lastSignificantEventId: string | null = null;
  let lastHarm: SocialEvent | null = null;
  let lastRepairAtMs = 0;
  let lastForgivenessAtMs = 0;

  for (const event of events) {
    const severity = clamp01(event.severity);
    const confidence = clamp01(event.confidence);

    switch (event.kind) {
      case "insult":
      case "exclusion":
      case "betrayal": {
        lastHarm = event;
        lastSignificantEventId = event.id;
        unresolvedTension = clamp01(unresolvedTension + severity * confidence);
        repairDebt = clamp01(repairDebt + severity * confidence);
        if (isPublicHarm(event)) venueDebt = clamp01(venueDebt + severity * confidence);
        repairState = lastForgivenessAtMs > 0 ? "reopened" : "harm_open";
        break;
      }
      case "boundary_violation": {
        lastHarm = event;
        lastSignificantEventId = event.id;
        boundaryStatus = "violated";
        repairState = "reopened";
        unresolvedTension = clamp01(Math.max(unresolvedTension, severity));
        repairDebt = clamp01(Math.max(repairDebt, severity));
        if (isPublicHarm(event)) venueDebt = clamp01(Math.max(venueDebt, severity));
        break;
      }
      case "repair_attempt": {
        lastSignificantEventId = event.id;
        repairState = event.actorId === "alice" ? "clarification_pending" : "apology_offered";
        break;
      }
      case "apology": {
        lastSignificantEventId = event.id;
        lastRepairAtMs = event.occurredAtMs;
        repairState = "apology_offered";
        const matchingPublicHarm =
          lastHarm != null && repairMatchesHarm(event, lastHarm) && isPublicHarm(lastHarm);
        const sameVenueRepair = lastHarm != null && event.venueId === lastHarm.venueId;
        const publicRepair = event.visibility === "public" || event.visibility === "semi_public";
        const repairStrength = severity * confidence;
        repairDebt = clamp01(repairDebt - repairStrength * 0.8);
        if (matchingPublicHarm && publicRepair && sameVenueRepair) {
          venueDebt = clamp01(venueDebt - repairStrength);
        }
        break;
      }
      case "forgiveness": {
        lastSignificantEventId = event.id;
        lastForgivenessAtMs = event.occurredAtMs;
        unresolvedTension = clamp01(unresolvedTension - severity * confidence);
        repairDebt = clamp01(repairDebt - severity * confidence);
        if (event.boundaryText) boundaryStatus = "set";
        if (venueDebt <= 0.05 && !hasLaterHarm(events, event.occurredAtMs)) {
          repairState = "forgiven_with_boundary";
        } else if (repairState !== "reopened") {
          repairState = venueDebt > 0 ? "apology_offered" : "forgiven_with_boundary";
        }
        break;
      }
      case "boundary_set": {
        lastSignificantEventId = event.id;
        boundaryStatus = "set";
        break;
      }
      case "repair_rejected": {
        lastSignificantEventId = event.id;
        repairState = lastRepairAtMs > 0 ? "reopened" : "harm_open";
        unresolvedTension = clamp01(Math.max(unresolvedTension, severity));
        repairDebt = clamp01(Math.max(repairDebt, severity));
        break;
      }
      case "support":
      case "obligation": {
        lastSignificantEventId = event.id;
        break;
      }
    }
  }

  if (repairState === "none" && repairDebt > 0) repairState = "harm_open";
  if (
    repairState === "apology_offered" &&
    lastForgivenessAtMs > lastRepairAtMs &&
    venueDebt <= 0.05
  ) {
    repairState = "forgiven_with_boundary";
  }

  const confidence =
    events.length === 0
      ? 0
      : events.reduce((sum, event) => sum + clamp01(event.confidence), 0) / events.length;
  const open =
    repairState === "harm_open" ||
    repairState === "clarification_pending" ||
    repairState === "apology_offered" ||
    repairState === "reopened" ||
    venueDebt > 0.05 ||
    repairDebt > 0.05;

  return {
    caseId: caseIdFromKey(key),
    pair: displayPairFromRelationKey(displayRelationKey),
    events,
    repairState,
    boundaryStatus,
    unresolvedTension: Number(unresolvedTension.toFixed(3)),
    repairDebt: Number(repairDebt.toFixed(3)),
    venueDebt: Number(venueDebt.toFixed(3)),
    confidence: Number(confidence.toFixed(3)),
    lastSignificantEventId,
    currentRead: deriveCurrentRead({ repairState, boundaryStatus, venueDebt, repairDebt }),
    open,
  };
}
