import { describe, expect, it } from "vitest";
import {
  classifyIausActionRow,
  type IausActionClassifierRow,
} from "../src/diagnostics/iaus-action-classifier.js";

function row(overrides: Partial<IausActionClassifierRow>): IausActionClassifierRow {
  return {
    action_type: "observe",
    success: 1,
    tc_command_log: "",
    engagement_outcome: "complete",
    tc_afterward: "done",
    ...overrides,
  };
}

describe("classifyIausActionRow", () => {
  it("counts successful TC Telegram command logs even when action_type is observe", () => {
    const cases = [
      {
        name: "send",
        commandLog: '$ irc say --text "hi"\n\u2713 Sent: "hi"',
        effect: "send",
      },
      {
        name: "reply",
        commandLog: '$ irc reply --ref 42 --text "hi"\n\u2713 Replied to: #42: "hi"',
        effect: "reply",
      },
      {
        name: "sticker",
        commandLog: "$ irc sticker --keyword shy\n\u2713 Sent sticker: shy",
        effect: "sticker",
      },
      {
        name: "voice",
        commandLog: '$ irc voice --text "hello"\n\u2713 Sent voice: "hello"',
        effect: "voice",
      },
      {
        name: "react",
        commandLog: "$ irc react --ref 42 --emoji 👍\n\u2713 Reacted 👍 to: #42",
        effect: "react",
      },
      {
        name: "read",
        commandLog: "$ irc read\n\u2713 Marked as read",
        effect: "read",
      },
      {
        name: "forward",
        commandLog: "$ irc forward --from 1 --ref 2 --to 3\n\u2713 Forwarded: #2 -> @3",
        effect: "forward",
      },
    ] as const;

    for (const testCase of cases) {
      const classified = classifyIausActionRow(
        row({ action_type: "observe", success: 1, tc_command_log: testCase.commandLog }),
      );

      expect(classified.category, testCase.name).toBe("telegram_success");
      expect(classified.telegramSuccesses, testCase.name).toBe(1);
      expect(classified.telegramFailures, testCase.name).toBe(0);
      expect(classified.successEffects[testCase.effect], testCase.name).toBe(1);
    }
  });

  it("keeps host success separate from Telegram success", () => {
    const classified = classifyIausActionRow(
      row({
        action_type: "observe",
        success: 1,
        tc_command_log: "$ self feel --valence neutral --reason calm\nsuccess: true",
      }),
    );

    expect(classified.category).toBe("internal_action");
    expect(classified.telegramSuccesses).toBe(0);
    expect(classified.telegramFailures).toBe(0);
  });

  it("does not preserve legacy action_type compatibility without command-log evidence", () => {
    const classified = classifyIausActionRow(
      row({
        action_type: "message",
        success: 1,
        tc_command_log: "",
      }),
    );

    expect(classified.category).toBe("internal_action");
    expect(classified.telegramSuccesses).toBe(0);
    expect(classified.telegramFailures).toBe(0);
  });

  it("keeps LLM silence and LLM failure in separate categories", () => {
    expect(
      classifyIausActionRow(
        row({ action_type: "silence", success: 1, engagement_outcome: "complete" }),
      ).category,
    ).toBe("llm_silence");

    expect(
      classifyIausActionRow(
        row({ action_type: "observe", success: 0, engagement_outcome: "llm_failed" }),
      ).category,
    ).toBe("llm_failure");

    expect(
      classifyIausActionRow(row({ action_type: "provider_failed", success: 0 })).category,
    ).toBe("llm_failure");

    expect(
      classifyIausActionRow(row({ action_type: "validation_failed", success: 0 })).category,
    ).toBe("llm_failure");
  });

  it("keeps command misuse out of LLM and Telegram failure categories", () => {
    const classified = classifyIausActionRow(
      row({
        action_type: "command_misuse",
        success: 0,
        engagement_outcome: "llm_failed",
      }),
    );

    expect(classified.category).toBe("command_misuse");
    expect(classified.telegramFailures).toBe(0);
  });

  it("classifies Engine API failures as Telegram failures, not successes", () => {
    const classified = classifyIausActionRow(
      row({
        action_type: "observe",
        success: 0,
        tc_command_log: [
          "$ irc read --in @6395368305",
          "error",
          "Error: Engine API returned 500 for POST /telegram/read",
        ].join("\n"),
      }),
    );

    expect(classified.category).toBe("telegram_failure");
    expect(classified.telegramSuccesses).toBe(0);
    expect(classified.telegramFailures).toBe(1);
    expect(classified.failureEffects.read).toBe(1);
  });

  it("classifies structured telegram_failed rows as Telegram failures", () => {
    const classified = classifyIausActionRow(row({ action_type: "telegram_failed", success: 0 }));

    expect(classified.category).toBe("telegram_failure");
  });

  it("classifies Engine API timeout on a Telegram attempt as a Telegram failure", () => {
    const classified = classifyIausActionRow(
      row({
        action_type: "observe",
        success: 0,
        tc_command_log: [
          '$ irc reply --ref 42 --text "hi"',
          "error",
          "Error: Engine API timeout",
        ].join("\n"),
      }),
    );

    expect(classified.category).toBe("telegram_failure");
    expect(classified.telegramSuccesses).toBe(0);
    expect(classified.telegramFailures).toBe(1);
    expect(classified.failureEffects.reply).toBe(1);
  });
});
