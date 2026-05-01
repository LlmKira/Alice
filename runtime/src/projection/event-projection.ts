/**
 * ADR-248 W3: CanonicalEvent -> ProjectionView pure reducer.
 *
 * This is not yet the live prompt path. It is the deterministic projection seam
 * that lets us replay canonical facts into a stable context view before later
 * rendering/RC work.
 *
 * @see docs/adr/248-dcp-reference-implementation-plan/README.md
 */
import type { CanonicalEvent, CanonicalMessageEvent } from "../telegram/canonical-events.js";

export interface ProjectedParticipant {
  contactId: string;
  displayName: string | null;
  senderName: string | null;
  lastActiveMs: number | null;
  messageCount: number;
  bot: boolean;
}

export interface ProjectedMessage {
  tick: number;
  occurredAtMs: number | null;
  channelId: string;
  contactId: string | null;
  directed: boolean;
  continuation: boolean;
  text: string | null;
  contentType: CanonicalMessageEvent["contentType"];
  senderName: string | null;
  senderIsBot: boolean;
}

export interface ProjectedChannel {
  channelId: string;
  chatType: string | null;
  displayName: string | null;
  lastActivityMs: number | null;
  messageCount: number;
  directedCount: number;
  botMessageCount: number;
  lastMessage: ProjectedMessage | null;
  tmeLinks: string[];
}

export interface ProjectionView {
  channels: Record<string, ProjectedChannel>;
  participants: Record<string, ProjectedParticipant>;
  messages: ProjectedMessage[];
  reactions: Array<{
    tick: number;
    occurredAtMs: number | null;
    channelId: string | null;
    contactId: string | null;
    emoji: string | null;
    messageId: number | null;
  }>;
  stats: {
    eventCount: number;
    messageCount: number;
    directedCount: number;
  };
}

export function createProjectionView(): ProjectionView {
  return {
    channels: {},
    participants: {},
    messages: [],
    reactions: [],
    stats: {
      eventCount: 0,
      messageCount: 0,
      directedCount: 0,
    },
  };
}

function ensureChannel(view: ProjectionView, event: CanonicalMessageEvent): ProjectedChannel {
  const existing = view.channels[event.channelId ?? ""];
  if (existing) {
    if (event.chatDisplayName) existing.displayName = event.chatDisplayName;
    if (event.chatType) existing.chatType = event.chatType;
    return existing;
  }

  const channelId = event.channelId;
  if (!channelId) throw new Error("message event requires channelId for projection");

  const created: ProjectedChannel = {
    channelId,
    chatType: event.chatType,
    displayName: event.chatDisplayName,
    lastActivityMs: null,
    messageCount: 0,
    directedCount: 0,
    botMessageCount: 0,
    lastMessage: null,
    tmeLinks: [],
  };
  view.channels[channelId] = created;
  return created;
}

function updateParticipant(view: ProjectionView, event: CanonicalMessageEvent): void {
  if (!event.contactId) return;
  const existing = view.participants[event.contactId];
  if (existing) {
    existing.displayName = event.displayName ?? existing.displayName;
    existing.senderName = event.senderName ?? existing.senderName;
    existing.lastActiveMs = event.occurredAtMs ?? existing.lastActiveMs;
    existing.messageCount += 1;
    existing.bot ||= event.senderIsBot;
    return;
  }

  view.participants[event.contactId] = {
    contactId: event.contactId,
    displayName: event.displayName,
    senderName: event.senderName,
    lastActiveMs: event.occurredAtMs,
    messageCount: 1,
    bot: event.senderIsBot,
  };
}

function applyMessage(view: ProjectionView, event: CanonicalMessageEvent): void {
  const channel = ensureChannel(view, event);
  updateParticipant(view, event);

  const message: ProjectedMessage = {
    tick: event.tick,
    occurredAtMs: event.occurredAtMs,
    channelId: channel.channelId,
    contactId: event.contactId,
    directed: event.directed,
    continuation: event.continuation,
    text: event.text,
    contentType: event.contentType,
    senderName: event.senderName,
    senderIsBot: event.senderIsBot,
  };

  view.messages.push(message);
  channel.lastActivityMs = event.occurredAtMs ?? channel.lastActivityMs;
  channel.messageCount += 1;
  if (event.directed) channel.directedCount += 1;
  if (event.senderIsBot) channel.botMessageCount += 1;
  channel.lastMessage = message;
  if (event.tmeLinks.length > 0) {
    channel.tmeLinks = [...new Set([...channel.tmeLinks, ...event.tmeLinks])];
  }

  view.stats.messageCount += 1;
  if (event.directed) view.stats.directedCount += 1;
}

export function projectCanonicalEvent(view: ProjectionView, event: CanonicalEvent): ProjectionView {
  view.stats.eventCount += 1;

  switch (event.kind) {
    case "message":
      applyMessage(view, event);
      return view;
    case "reaction":
      view.reactions.push({
        tick: event.tick,
        occurredAtMs: event.occurredAtMs,
        channelId: event.channelId,
        contactId: event.contactId,
        emoji: event.emoji,
        messageId: event.messageId,
      });
      return view;
    default:
      return view;
  }
}

export function projectCanonicalEvents(events: readonly CanonicalEvent[]): ProjectionView {
  const view = createProjectionView();
  for (const event of events) projectCanonicalEvent(view, event);
  return view;
}
