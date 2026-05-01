/**
 * ADR-248 diagnostic projection for prompt logs.
 *
 * This module owns the DCP shadow read path so prompt-log remains a markdown
 * snapshot writer, not a DCP diagnostics orchestrator.
 *
 * @see docs/adr/248-dcp-reference-implementation-plan/simplicity-abstraction-audit.md
 */
import { listCanonicalEvents } from "../db/canonical-event-store.js";
import { projectCanonicalEvents } from "../projection/event-projection.js";
import {
  renderedContextToXml,
  renderProjectionView,
} from "../projection/rendering/rendered-context.js";

function isDcpShadowEnabled(): boolean {
  return process.env.ALICE_PROMPT_LOG_DCP !== "false" && process.env.ALICE_PROMPT_LOG_DCP !== "0";
}

export function renderDcpShadowContext(target: string | null, limit = 50): string[] {
  if (!isDcpShadowEnabled()) return [];

  const parts = [
    "## DCP Shadow Context",
    "",
    "> ADR-248 shadow only: this is not fed to the LLM and does not affect control flow.",
    "",
  ];

  if (!target) {
    parts.push("(no target; DCP shadow skipped)", "");
    return parts;
  }

  try {
    const rows = listCanonicalEvents({ channelId: target, limit });
    const events = rows.map((row) => row.event);
    const projection = projectCanonicalEvents(events);
    const rendered = renderProjectionView(projection);
    parts.push(
      `- source: canonical_events`,
      `- target: ${target}`,
      `- events: ${events.length}`,
      `- messages: ${projection.stats.messageCount}`,
      `- directed: ${projection.stats.directedCount}`,
      "",
      "```xml",
      renderedContextToXml(rendered) || "(empty rendered context)",
      "```",
      "",
    );
  } catch (e) {
    parts.push(`(DCP shadow unavailable: ${e instanceof Error ? e.message : String(e)})`, "");
  }

  return parts;
}
