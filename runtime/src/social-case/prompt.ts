/**
 * ADR-262 Wave 3A: prompt-facing social case replay.
 *
 * This layer keeps prompt injection target-scoped and privacy-aware. It reads
 * append-only facts, derives projections, and returns human lines for the user
 * prompt; it does not affect IAUS, target-control, or thread pressure.
 *
 * @see docs/adr/262-social-case-management/README.md
 */
import { listSocialEvents } from "../db/social-case.js";
import { resolveContactAndChannel } from "../graph/constants.js";
import { safeDisplayName } from "../graph/display.js";
import type { WorldModel } from "../graph/world-model.js";
import { ChatTarget } from "../prompt/types.js";
import { type SocialCaseWritebackEntry, socialCaseWritebackContextVars } from "./context.js";
import { makeSocialCaseHandle } from "./handle.js";
import { projectSocialCases } from "./projector.js";
import { renderSocialCaseBriefLines } from "./render.js";
import type { SocialCaseProjection, SocialEvent, SocialVisibility } from "./types.js";

const SELF_ID = "alice";
const DEFAULT_MIN_PROMPT_CONFIDENCE = 0.65;

export interface SocialCasePromptInput {
  G: WorldModel;
  target: string | null;
  chatType: string;
  limit?: number;
  minConfidence?: number;
  selfId?: string;
}

export interface SocialCasePromptSurface {
  lines: string[];
  contextVars: Record<string, string>;
}

function surfaceForChat(chatType: string): SocialVisibility {
  return ChatTarget.isPrivateChat(chatType) ? "private" : "public";
}

function addKnownEntityAliases(G: WorldModel, aliases: Set<string>, nodeId: string | null): void {
  if (!nodeId) return;
  aliases.add(nodeId);
  if (!G.has(nodeId)) return;
  aliases.add(safeDisplayName(G, nodeId));
  const displayName = G.getDynamic(nodeId, "display_name");
  if (displayName) aliases.add(String(displayName));
  const title = G.getDynamic(nodeId, "title");
  if (title) aliases.add(String(title));
}

function targetAliases(G: WorldModel, target: string): Set<string> {
  const aliases = new Set<string>([target]);
  const resolved = resolveContactAndChannel(target, (id) => G.has(id));
  addKnownEntityAliases(G, aliases, resolved.contactId);
  addKnownEntityAliases(G, aliases, resolved.channelId);
  addKnownEntityAliases(G, aliases, target);
  return aliases;
}

function addChatParticipantAliases(G: WorldModel, aliases: Set<string>, target: string): void {
  const memberIds = new Set([
    ...G.getNeighbors(target, "joined"),
    ...G.getPredecessors(target, "joined"),
  ]);
  for (const memberId of memberIds) {
    addKnownEntityAliases(G, aliases, memberId);
  }
}

function audienceAliases(G: WorldModel, target: string, chatType: string): Set<string> {
  const aliases = targetAliases(G, target);
  if (
    ChatTarget.isGroupChat(chatType) ||
    ChatTarget.isPrivateChat(chatType) ||
    (G.has(target) &&
      G.getNodeType(target) === "channel" &&
      G.getChannel(target).chat_type === "private")
  ) {
    addChatParticipantAliases(G, aliases, target);
  }
  return aliases;
}

function isPrivateChatTarget(G: WorldModel, target: string, chatType: string): boolean {
  if (ChatTarget.isPrivateChat(chatType)) return true;
  if (!G.has(target) || G.getNodeType(target) !== "channel") return false;
  return G.getChannel(target).chat_type === "private";
}

function eventTouchesTargetVenue(event: SocialEvent, aliases: ReadonlySet<string>): boolean {
  if (aliases.has(event.venueId)) return true;
  if (aliases.has(event.actorId)) return true;
  if (event.targetId && aliases.has(event.targetId)) return true;
  if (event.affectedRelation.some((id) => aliases.has(id))) return true;
  if (event.witnesses.some((id) => aliases.has(id))) return true;
  return (
    event.causes?.some((cause) => cause.venueId != null && aliases.has(cause.venueId)) ?? false
  );
}

function caseTouchesPrivateTarget(
  projection: SocialCaseProjection,
  aliases: ReadonlySet<string>,
): boolean {
  return projection.pair.some((id) => aliases.has(id));
}

function caseTouchesPublicTarget(
  projection: SocialCaseProjection,
  aliases: ReadonlySet<string>,
): boolean {
  return projection.events.some((event) => eventTouchesTargetVenue(event, aliases));
}

function isPromptRelevantCase(projection: SocialCaseProjection): boolean {
  return projection.open || projection.boundaryStatus !== "none";
}

function promptEntityLabel(G: WorldModel, selfId: string, id: string): string {
  if (id === selfId || id === "alice" || id === "self") return "Alice";
  if (G.has(id)) return safeDisplayName(G, id);
  if (id.startsWith("contact:")) return "(someone)";
  if (id.startsWith("channel:")) return "(a chat)";
  return id;
}

function promptVenueLabel(G: WorldModel, id: string): string {
  if (G.has(id)) return safeDisplayName(G, id);
  if (id.startsWith("channel:")) return "(a chat)";
  return id;
}

function writebackAboutForCase(
  G: WorldModel,
  selfId: string,
  projection: SocialCaseProjection,
  surfaceVisibility: SocialVisibility,
): string {
  const other = projection.pair.find((id) => id !== selfId) ?? projection.pair[0];
  const label = promptEntityLabel(G, selfId, other);
  const visibleEvents = projection.events.filter(
    (event) => surfaceVisibility === "private" || event.visibility !== "private",
  );
  const lastEvent = visibleEvents.at(-1);
  const kind = lastEvent?.kind?.replace(/_/g, " ") ?? "case";
  const venue = lastEvent ? promptVenueLabel(G, lastEvent.venueId) : "";
  return venue ? `${label} / ${kind} in ${venue}` : `${label} / ${kind}`;
}

export function buildSocialCasePromptSurface(
  input: SocialCasePromptInput,
): SocialCasePromptSurface {
  if (!input.target) return { lines: [], contextVars: {} };

  const limit = input.limit ?? 2;
  const minConfidence = input.minConfidence ?? DEFAULT_MIN_PROMPT_CONFIDENCE;
  const selfId = input.selfId ?? SELF_ID;
  const aliases = audienceAliases(input.G, input.target, input.chatType);
  const isPrivate = isPrivateChatTarget(input.G, input.target, input.chatType);
  const surfaceVisibility = surfaceForChat(input.chatType);

  const cases = projectSocialCases(listSocialEvents())
    .filter((projection) => isPromptRelevantCase(projection))
    .filter((projection) => projection.confidence >= minConfidence)
    .filter((projection) =>
      isPrivate
        ? caseTouchesPrivateTarget(projection, aliases)
        : caseTouchesPublicTarget(projection, aliases),
    )
    .slice(0, limit);

  const lines: string[] = [];
  const writebackEntries: SocialCaseWritebackEntry[] = [];
  const usedHandles = new Set<string>();
  for (const projection of cases) {
    const writebackAbout = writebackAboutForCase(input.G, selfId, projection, surfaceVisibility);
    const writebackHandle = makeSocialCaseHandle({
      caseId: projection.caseId,
      about: writebackAbout,
      usedHandles,
    });
    usedHandles.add(writebackHandle);
    writebackEntries.push({
      about: writebackAbout,
      caseId: projection.caseId,
      handle: writebackHandle,
    });
    if (lines.length > 0) lines.push("---");
    lines.push(
      ...renderSocialCaseBriefLines(projection, {
        selfId,
        currentVenueId: input.target,
        surfaceVisibility,
        writebackAbout,
        writebackHandle,
        labelForEntity: (id) => promptEntityLabel(input.G, selfId, id),
        labelForVenue: (id) => promptVenueLabel(input.G, id),
      }),
    );
  }
  return {
    lines,
    contextVars: socialCaseWritebackContextVars(writebackEntries),
  };
}

export function buildSocialCasePromptLines(input: SocialCasePromptInput): string[] {
  return buildSocialCasePromptSurface(input).lines;
}
