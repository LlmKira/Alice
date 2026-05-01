import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMock = vi.hoisted(() => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("node:fs", () => fsMock);

const { logPromptSnapshot } = await import("../src/diagnostics/prompt-log.js");

describe("logPromptSnapshot", () => {
  beforeEach(() => {
    fsMock.mkdirSync.mockClear();
    fsMock.writeFileSync.mockClear();
    process.env.ALICE_PROMPT_LOG = "1";
  });

  afterEach(() => {
    delete process.env.ALICE_PROMPT_LOG;
  });

  it("writes transcript-level TC details without losing round structure", () => {
    logPromptSnapshot({
      tick: 42,
      target: "channel:test",
      voice: "group",
      round: 0,
      system: "sys",
      user: "usr",
      script: 'irc tail --count 8\n\nirc reply --ref 3390931 --text "我也是这么觉得"',
      execution: {
        afterward: "done",
        toolCallCount: 3,
        assistantTurnCount: 2,
        bashCallCount: 2,
        signalCallCount: 1,
        budgetExhausted: false,
        transcript: [
          {
            round: 0,
            toolChoice: "required",
            finishReason: "tool_calls",
            assistantText: "",
            toolCalls: [
              {
                sequence: 1,
                round: 0,
                toolCallId: "call_1",
                name: "bash",
                args: { command: "irc tail --count 8" },
                command: "irc tail --count 8",
                output: "[tail]\n(no messages)",
                errors: [],
                instructionErrors: [],
              },
            ],
          },
          {
            round: 1,
            toolChoice: "auto",
            finishReason: "tool_calls",
            assistantText: "",
            toolCalls: [
              {
                sequence: 2,
                round: 1,
                toolCallId: "call_2",
                name: "bash",
                args: { command: 'irc reply --ref 3390931 --text "我也是这么觉得"' },
                command: 'irc reply --ref 3390931 --text "我也是这么觉得"',
                output: '✓ Replied to: #3390931: "我也是这么觉得"',
                errors: [],
                instructionErrors: [],
              },
              {
                sequence: 3,
                round: 1,
                toolCallId: "call_3",
                name: "signal",
                args: { afterward: "done" },
                afterward: "done",
                output: "ack: done",
                errors: [],
                instructionErrors: [],
              },
            ],
          },
        ],
        commandOutput:
          '$ irc tail --count 8\n[tail]\n(no messages)\n---\n$ irc reply --ref 3390931 --text "我也是这么觉得"\n✓ Replied',
        thinks: ["前面刷太快了 我先补一下"],
        queryLogs: [],
        instructionErrors: [],
        errors: [],
        hostContinuedInTick: true,
        hostContinuationReason: "local_observation_followup",
      },
    });

    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
    const written = String(fsMock.writeFileSync.mock.calls[0][1]);

    expect(written).toContain("- assistant turns: 2");
    expect(written).toContain("- bash calls: 2");
    expect(written).toContain("- signal calls: 1");
    expect(written).toContain("- host continued in tick: yes");
    expect(written).toContain("- host continuation reason: local_observation_followup");
    expect(written).toContain("### Transcript");
    expect(written).toContain("#### Assistant Round 1");
    expect(written).toContain("#### Assistant Round 2");
    expect(written).toContain("##### bash #1 (`call_1`)");
    expect(written).toContain("irc tail --count 8");
    expect(written).toContain("##### signal #3 (`call_3`)");
    expect(written).toContain("- afterward: done");
  });

  it("keeps writing prompt snapshots when DCP shadow is unavailable", () => {
    logPromptSnapshot({
      tick: 43,
      target: "channel:missing-db",
      voice: "group",
      round: 0,
      system: "sys",
      user: "usr",
      script: "",
    });

    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
    const written = String(fsMock.writeFileSync.mock.calls[0][1]);
    expect(written).toContain("## DCP Shadow Context");
    expect(written).toContain("DCP shadow unavailable");
    expect(written).toContain("## LLM Script");
  });
});
