import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeCanonicalEvent } from "../src/db/canonical-event-store.js";
import { closeDb, initDb } from "../src/db/connection.js";
import { renderDcpPromptCompare } from "../src/diagnostics/dcp-prompt-compare.js";

function writePromptLog(): string {
  const dir = mkdtempSync(join(tmpdir(), "alice-dcp-compare-"));
  const path = join(dir, "prompt.md");
  writeFileSync(
    path,
    [
      "# Prompt Snapshot — tick 1, round 0",
      "",
      "| Key | Value |",
      "|-----|-------|",
      "| tick | 1 |",
      "| round | 0 |",
      "| target | channel:1 |",
      "| voice | group |",
      "| time | 2026-04-25T00:00:00.000Z |",
      "| script | SILENT (0 tools) |",
      "",
      "## System Prompt",
      "",
      "```",
      "system text",
      "```",
      "",
      "## User Prompt",
      "",
      "```",
      "old prompt line",
      "relationship hint",
      "```",
      "",
      "## DCP Shadow Context",
      "",
      "> existing shadow",
      "",
      "## LLM Script",
      "",
      "**模型未调用任何工具（静默）**",
      "",
    ].join("\n"),
  );
  return path;
}

function writeSchedulerPromptLog(): string {
  const dir = mkdtempSync(join(tmpdir(), "alice-dcp-compare-scheduler-"));
  const path = join(dir, "prompt.md");
  writeFileSync(
    path,
    [
      "# Prompt Snapshot — tick 2, round 0",
      "",
      "| Key | Value |",
      "|-----|-------|",
      "| tick | 2 |",
      "| round | 0 |",
      "| target | channel:2 |",
      "| voice | friend |",
      "| time | 2026-04-25T00:00:00.000Z |",
      "| script | SILENT (0 tools) |",
      "",
      "## User Prompt",
      "",
      "```",
      "12:40 PM. Talking to Lin (friend).",
      "You're low on energy right now",
      "```",
      "",
      "## DCP Shadow Context",
      "",
      "> existing shadow",
      "",
    ].join("\n"),
  );
  return path;
}

function seedCanonicalEvent(): void {
  writeCanonicalEvent({
    kind: "message",
    tick: 1,
    occurredAtMs: 1000,
    channelId: "channel:1",
    contactId: "contact:1",
    directed: true,
    novelty: null,
    continuation: false,
    text: "canonical hello",
    senderName: "Mika",
    displayName: "Mika",
    chatDisplayName: "Room",
    chatType: "group",
    contentType: "text",
    senderIsBot: false,
    forwardFromChannelId: null,
    forwardFromChannelName: null,
    tmeLinks: [],
  });
}

describe("DCP prompt compare diagnostic", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("compares a prompt snapshot against canonical replay", () => {
    seedCanonicalEvent();
    const report = renderDcpPromptCompare({ promptLogPath: writePromptLog() });

    expect(report).toContain("DCP Prompt Compare — channel:1");
    expect(report).toContain("User prompt:");
    expect(report).toContain("DCP events: 1");
    expect(report).toContain("DCP directed: 1");
    expect(report).toContain("old prompt line");
    expect(report).toContain("canonical hello");
    expect(report).toContain("Embedded DCP shadow: yes");
  });

  it("can emit machine-readable JSON", () => {
    seedCanonicalEvent();
    const raw = renderDcpPromptCompare({ promptLogPath: writePromptLog(), json: true });
    const parsed = JSON.parse(raw) as {
      chatId: string;
      dcpReplay: { eventCount: number; messageCount: number };
      promptLogDcpShadowPresent: boolean;
    };

    expect(parsed.chatId).toBe("channel:1");
    expect(parsed.dcpReplay).toMatchObject({ eventCount: 1, messageCount: 1 });
    expect(parsed.promptLogDcpShadowPresent).toBe(true);
  });

  it("does not classify scheduler prompts as ingress loss by default", () => {
    const report = renderDcpPromptCompare({ promptLogPath: writeSchedulerPromptLog() });

    expect(report).toContain("DCP events: 0");
    expect(report).toContain("scheduler/world-state context");
    expect(report).not.toContain("check realtime canonical ingress coverage");
  });
});
