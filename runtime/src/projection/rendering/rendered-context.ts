/**
 * ADR-248 W3: ProjectionView -> RenderedContext pure rendering seam.
 *
 * This renderer is deliberately small and provider-neutral. It is not the live
 * prompt path yet; it gives W4 an RC-shaped artifact to merge with future TRs.
 *
 * @see docs/adr/248-dcp-reference-implementation-plan/README.md
 */
import type { ProjectedMessage, ProjectionView } from "../event-projection.js";

export interface RenderedContextSegment {
  receivedAtMs: number | null;
  channelId: string;
  text: string;
  directed: boolean;
  senderIsBot: boolean;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderMessage(message: ProjectedMessage): string {
  const attrs = [
    `channel="${escapeXml(message.channelId)}"`,
    message.contactId ? `sender="${escapeXml(message.contactId)}"` : undefined,
    message.senderName ? `name="${escapeXml(message.senderName)}"` : undefined,
    `tick="${message.tick}"`,
    message.occurredAtMs != null ? `t="${message.occurredAtMs}"` : undefined,
    message.directed ? 'directed="true"' : undefined,
    message.continuation ? 'continuation="true"' : undefined,
    message.senderIsBot ? 'bot="true"' : undefined,
    message.contentType !== "text" ? `media="${message.contentType}"` : undefined,
  ].filter(Boolean);

  const body = message.text ? escapeXml(message.text) : `[${message.contentType}]`;
  return `<message ${attrs.join(" ")}>${body}</message>`;
}

export function renderProjectionView(view: ProjectionView): RenderedContextSegment[] {
  return view.messages.map((message) => ({
    receivedAtMs: message.occurredAtMs,
    channelId: message.channelId,
    text: renderMessage(message),
    directed: message.directed,
    senderIsBot: message.senderIsBot,
  }));
}

export function renderedContextToXml(segments: readonly RenderedContextSegment[]): string {
  return segments.map((segment) => segment.text).join("\n");
}
