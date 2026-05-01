/**
 * ADR-248 diagnostics: DCP replay dump from canonical_events.
 *
 * @see docs/adr/248-dcp-reference-implementation-plan/README.md
 */
import { listCanonicalEvents } from "../db/canonical-event-store.js";
import { projectCanonicalEvents } from "../projection/event-projection.js";
import {
  renderedContextToXml,
  renderProjectionView,
} from "../projection/rendering/rendered-context.js";

export interface DcpReplayDiagnosticOptions {
  chatId?: string;
  limit?: number;
  json?: boolean;
}

export function renderDcpReplayDiagnostic(options: DcpReplayDiagnosticOptions = {}): string {
  const rows = listCanonicalEvents({ channelId: options.chatId, limit: options.limit ?? 100 });
  const events = rows.map((row) => row.event);
  const projection = projectCanonicalEvents(events);
  const rc = renderProjectionView(projection);

  if (options.json) {
    return JSON.stringify({ eventCount: events.length, projection, renderedContext: rc }, null, 2);
  }

  const title = options.chatId ? `DCP Replay — ${options.chatId}` : "DCP Replay";
  const lines = [title, ""];
  lines.push(
    `Events: ${events.length}`,
    `Channels: ${Object.keys(projection.channels).length}`,
    `Participants: ${Object.keys(projection.participants).length}`,
    `Messages: ${projection.stats.messageCount}`,
    `Directed: ${projection.stats.directedCount}`,
    "",
    renderedContextToXml(rc) || "(empty rendered context)",
  );
  return lines.join("\n");
}
