/**
 * ADR-248 W3: Canonical IM event seam.
 *
 * This module is intentionally pure: it does not touch mtcute, DB, EventBuffer,
 * or WorldModel. It gives Alice a stable event fact shape before later W3 work
 * moves Telegram ingress and rendering onto replayable facts.
 *
 * @see docs/adr/248-dcp-reference-implementation-plan/README.md
 */
import type { GraphPerturbation } from "./mapper.js";

export type CanonicalEventKind =
  | "message"
  | "read_history"
  | "user_status"
  | "contact_active"
  | "reaction"
  | "chat_member_update"
  | "typing"
  | "runtime"
  | "action_result";

export type CanonicalContentType =
  | "text"
  | "sticker"
  | "photo"
  | "voice"
  | "video"
  | "document";

interface CanonicalEventBase {
  kind: CanonicalEventKind;
  tick: number;
  /** Wall-clock event time in ms. Unknown means the platform event had no trustworthy timestamp. */
  occurredAtMs: number | null;
  channelId: string | null;
  contactId: string | null;
  directed: boolean;
  novelty: number | null;
}

export interface CanonicalMessageEvent extends CanonicalEventBase {
  kind: "message";
  continuation: boolean;
  text: string | null;
  senderName: string | null;
  displayName: string | null;
  chatDisplayName: string | null;
  chatType: string | null;
  contentType: CanonicalContentType;
  senderIsBot: boolean;
  forwardFromChannelId: string | null;
  forwardFromChannelName: string | null;
  tmeLinks: string[];
}

export interface CanonicalReactionEvent extends CanonicalEventBase {
  kind: "reaction";
  emoji: string | null;
  messageId: number | null;
}

export interface CanonicalSimpleEvent extends CanonicalEventBase {
  kind: Exclude<CanonicalEventKind, "message" | "reaction">;
}

export type CanonicalEvent = CanonicalMessageEvent | CanonicalReactionEvent | CanonicalSimpleEvent;

const perturbationToKind = (type: GraphPerturbation["type"]): CanonicalEventKind => {
  if (type === "new_message") return "message";
  return type;
};

const kindToPerturbationType = (kind: CanonicalEventKind): GraphPerturbation["type"] => {
  if (kind === "message") return "new_message";
  if (kind === "runtime" || kind === "action_result") {
    throw new Error(`Canonical event kind ${kind} cannot be converted to GraphPerturbation yet`);
  }
  return kind;
};

export function canonicalFromPerturbation(event: GraphPerturbation): CanonicalEvent {
  const base = {
    kind: perturbationToKind(event.type),
    tick: event.tick,
    occurredAtMs: event.nowMs ?? null,
    channelId: event.channelId ?? null,
    contactId: event.contactId ?? null,
    directed: event.isDirected ?? false,
    novelty: event.novelty ?? null,
  } satisfies CanonicalEventBase;

  if (base.kind === "message") {
    return {
      ...base,
      kind: "message",
      continuation: event.isContinuation ?? false,
      text: event.messageText ?? null,
      senderName: event.senderName ?? null,
      displayName: event.displayName ?? null,
      chatDisplayName: event.chatDisplayName ?? null,
      chatType: event.chatType ?? null,
      contentType: event.contentType ?? "text",
      senderIsBot: event.senderIsBot ?? false,
      forwardFromChannelId: event.forwardFromChannelId ?? null,
      forwardFromChannelName: event.forwardFromChannelName ?? null,
      tmeLinks: event.tmeLinks ?? [],
    };
  }

  if (base.kind === "reaction") {
    return {
      ...base,
      kind: "reaction",
      emoji: event.emoji ?? null,
      messageId: event.messageId ?? null,
    };
  }

  return base as CanonicalSimpleEvent;
}

export function perturbationFromCanonical(event: CanonicalEvent): GraphPerturbation {
  const base: GraphPerturbation = {
    type: kindToPerturbationType(event.kind),
    tick: event.tick,
    channelId: event.channelId ?? undefined,
    contactId: event.contactId ?? undefined,
    isDirected: event.directed,
    nowMs: event.occurredAtMs ?? undefined,
    novelty: event.novelty ?? undefined,
  };

  if (event.kind === "message") {
    return {
      ...base,
      type: "new_message",
      isContinuation: event.continuation,
      messageText: event.text ?? undefined,
      senderName: event.senderName ?? undefined,
      displayName: event.displayName ?? undefined,
      chatDisplayName: event.chatDisplayName ?? undefined,
      chatType: event.chatType ?? undefined,
      contentType: event.contentType,
      senderIsBot: event.senderIsBot,
      forwardFromChannelId: event.forwardFromChannelId ?? undefined,
      forwardFromChannelName: event.forwardFromChannelName ?? undefined,
      tmeLinks: event.tmeLinks.length > 0 ? event.tmeLinks : undefined,
    };
  }

  if (event.kind === "reaction") {
    return {
      ...base,
      type: "reaction",
      emoji: event.emoji ?? undefined,
      messageId: event.messageId ?? undefined,
    };
  }

  return base;
}
