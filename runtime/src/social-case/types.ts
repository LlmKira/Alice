/**
 * ADR-262: Alice-centered social case facts and projections.
 *
 * This module is deliberately pure. `SocialEvent` is the append-only fact shape;
 * every state shown to Alice must be reconstructed from these facts.
 *
 * @see docs/adr/262-social-case-management/README.md
 */

export const SOCIAL_EVENT_KINDS = [
  "insult",
  "support",
  "apology",
  "forgiveness",
  "boundary_set",
  "boundary_violation",
  "exclusion",
  "betrayal",
  "obligation",
  "repair_attempt",
  "repair_rejected",
] as const;

export type SocialEventKind = (typeof SOCIAL_EVENT_KINDS)[number];

export type SocialVisibility = "private" | "public" | "semi_public";

export const SOCIAL_CAUSE_KINDS = [
  "evidence",
  "social_meaning",
  "actor_explanation",
  "repair_basis",
  "boundary_basis",
] as const;

export type SocialCauseKind = (typeof SOCIAL_CAUSE_KINDS)[number];

export interface SocialCause {
  kind: SocialCauseKind;
  text: string;
  visibility: SocialVisibility;
  venueId?: string;
  sourceEventId?: string;
  confidence?: number;
}

export interface SocialEvent {
  id: string;
  /**
   * Stable case-file handle. When absent, legacy rows are projected as one
   * relation-scoped case for compatibility with pre-case-file facts.
   */
  caseId?: string;
  kind: SocialEventKind;
  actorId: string;
  targetId?: string;
  affectedRelation: readonly [string, string];
  venueId: string;
  visibility: SocialVisibility;
  witnesses: readonly string[];
  severity: number;
  confidence: number;
  evidenceMsgIds: readonly number[];
  occurredAtMs: number;
  text?: string;
  causes?: readonly SocialCause[];
  repairsEventId?: string;
  boundaryText?: string;
}

export type RepairState =
  | "none"
  | "harm_open"
  | "clarification_pending"
  | "apology_offered"
  | "forgiven_with_boundary"
  | "reopened";

export type BoundaryStatus = "none" | "set" | "violated";

export interface SocialCaseProjection {
  caseId: string;
  pair: readonly [string, string];
  events: readonly SocialEvent[];
  repairState: RepairState;
  boundaryStatus: BoundaryStatus;
  unresolvedTension: number;
  repairDebt: number;
  venueDebt: number;
  confidence: number;
  lastSignificantEventId: string | null;
  currentRead: string;
  open: boolean;
}

export interface CaseRunbookAction {
  label: string;
  command: string;
  meaning: string;
}

export interface CaseRenderOptions {
  /** Alice/self entity ID in the projected relation. Defaults to `alice` for fixtures. */
  selfId?: string;
  /** Current prompt target. Used only to describe the action surface. */
  currentVenueId?: string;
  /** Public surfaces must not expose private cause text. */
  surfaceVisibility: SocialVisibility;
  /** Optional human label mapper for actor/target IDs. Prompt surfaces should hide raw graph IDs. */
  labelForEntity?: (id: string) => string;
  /** Optional human label mapper for venue IDs. Prompt surfaces should hide raw graph IDs. */
  labelForVenue?: (id: string) => string;
  /** Optional legacy thread handle during migration. */
  threadId?: number | string;
  /**
   * Natural prompt-visible phrase used to disambiguate writeback when several
   * social cases are rendered. This is not the stable case-file handle.
   */
  writebackAbout?: string;
  /**
   * Short prompt-visible handle used in `self social-case-note --case ...`.
   * Hidden execution context maps this back to the stable caseId.
   */
  writebackHandle?: string;
  actions?: readonly CaseRunbookAction[];
}
