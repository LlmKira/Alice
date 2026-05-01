/**
 * ADR-248 diagnostic: compare current prompt snapshots with DCP replay.
 *
 * Read-only. It does not change prompt routing, does not call LLM, and does not
 * persist any new facts. This is the calibration step before deciding whether
 * DCP should influence future prompt diagnostics or context construction.
 *
 * @see docs/adr/248-dcp-reference-implementation-plan/README.md
 */
import { readFileSync } from "node:fs";
import { listCanonicalEvents } from "../db/canonical-event-store.js";
import { projectCanonicalEvents } from "../projection/event-projection.js";
import {
  renderedContextToXml,
  renderProjectionView,
} from "../projection/rendering/rendered-context.js";

export interface DcpPromptCompareOptions {
  promptLogPath: string;
  chatId?: string;
  limit?: number;
  json?: boolean;
}

interface PromptLogSections {
  target: string | null;
  userPrompt: string;
  existingDcpShadow: string;
}

function extractCodeBlock(markdown: string, heading: string): string {
  const headingIndex = markdown.indexOf(`## ${heading}`);
  if (headingIndex === -1) return "";
  const afterHeading = markdown.slice(headingIndex);
  const fenceStart = afterHeading.indexOf("```");
  if (fenceStart === -1) return "";
  const contentStart = fenceStart + 3;
  const fenceEnd = afterHeading.indexOf("```", contentStart);
  if (fenceEnd === -1) return "";
  return afterHeading
    .slice(contentStart, fenceEnd)
    .replace(/^\w*\n/, "")
    .trim();
}

function extractSection(markdown: string, heading: string): string {
  const headingIndex = markdown.indexOf(`## ${heading}`);
  if (headingIndex === -1) return "";
  const afterHeading = markdown.slice(headingIndex + `## ${heading}`.length).trimStart();
  const nextHeading = afterHeading.search(/^## /m);
  return (nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading)).trim();
}

function extractTableValue(markdown: string, key: string): string | null {
  const re = new RegExp(`^\\|\\s*${key}\\s*\\|\\s*(.*?)\\s*\\|$`, "m");
  const match = markdown.match(re);
  if (!match) return null;
  const value = match[1].trim();
  return value === "(none)" ? null : value;
}

function readPromptLog(path: string): PromptLogSections {
  const markdown = readFileSync(path, "utf-8");
  return {
    target: extractTableValue(markdown, "target"),
    userPrompt: extractCodeBlock(markdown, "User Prompt"),
    existingDcpShadow: extractSection(markdown, "DCP Shadow Context"),
  };
}

function countNonEmptyLines(value: string): number {
  return value.split("\n").filter((line) => line.trim().length > 0).length;
}

function preview(value: string, maxLines = 20): string {
  const lines = value.split("\n").filter((line) => line.trim().length > 0);
  return lines.slice(0, maxLines).join("\n");
}

function inferEmptyReplayReason(userPrompt: string): string {
  const prompt = userPrompt.toLowerCase();
  if (
    prompt.includes("who needs you most") ||
    prompt.includes("waiting") ||
    prompt.includes("unread") ||
    prompt.includes("low on energy")
  ) {
    return "DCP replay is empty for selected chat, while the prompt looks like scheduler/world-state context; do not treat this as missing canonical ingress without checking target events.";
  }
  return "DCP replay is empty for selected chat; check realtime canonical ingress coverage.";
}

export function renderDcpPromptCompare(options: DcpPromptCompareOptions): string {
  const promptLog = readPromptLog(options.promptLogPath);
  const chatId = options.chatId ?? promptLog.target ?? undefined;
  const rows = listCanonicalEvents({ channelId: chatId, limit: options.limit ?? 100 });
  const events = rows.map((row) => row.event);
  const projection = projectCanonicalEvents(events);
  const rendered = renderProjectionView(projection);
  const dcpXml = renderedContextToXml(rendered);

  const report = {
    promptLogPath: options.promptLogPath,
    target: promptLog.target,
    chatId: chatId ?? null,
    userPrompt: {
      chars: promptLog.userPrompt.length,
      nonEmptyLines: countNonEmptyLines(promptLog.userPrompt),
      preview: preview(promptLog.userPrompt),
    },
    dcpReplay: {
      eventCount: events.length,
      messageCount: projection.stats.messageCount,
      directedCount: projection.stats.directedCount,
      chars: dcpXml.length,
      nonEmptyLines: countNonEmptyLines(dcpXml),
      preview: preview(dcpXml),
    },
    promptLogDcpShadowPresent: promptLog.existingDcpShadow.length > 0,
    observations: [
      events.length === 0 ? inferEmptyReplayReason(promptLog.userPrompt) : null,
      promptLog.userPrompt.length === 0 ? "User Prompt section was not found in prompt log." : null,
      promptLog.existingDcpShadow.length === 0
        ? "Prompt log has no embedded DCP Shadow Context."
        : null,
    ].filter((item): item is string => item != null),
  };

  if (options.json) return JSON.stringify(report, null, 2);

  return [
    `DCP Prompt Compare — ${report.chatId ?? "(no chat)"}`,
    "",
    `Prompt log: ${report.promptLogPath}`,
    `Prompt target: ${report.target ?? "(none)"}`,
    `DCP events: ${report.dcpReplay.eventCount}`,
    `DCP messages: ${report.dcpReplay.messageCount}`,
    `DCP directed: ${report.dcpReplay.directedCount}`,
    `User prompt: ${report.userPrompt.chars} chars / ${report.userPrompt.nonEmptyLines} non-empty lines`,
    `DCP rendered: ${report.dcpReplay.chars} chars / ${report.dcpReplay.nonEmptyLines} non-empty lines`,
    `Embedded DCP shadow: ${report.promptLogDcpShadowPresent ? "yes" : "no"}`,
    "",
    "## User Prompt Preview",
    report.userPrompt.preview || "(empty)",
    "",
    "## DCP Replay Preview",
    report.dcpReplay.preview || "(empty)",
    report.observations.length > 0 ? "" : null,
    report.observations.length > 0 ? "## Observations" : null,
    ...report.observations.map((item) => `- ${item}`),
  ]
    .filter((item): item is string => item != null)
    .join("\n");
}
