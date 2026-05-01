/**
 * checkFeedbackGap 单元测试。
 *
 * ADR-214 Wave B: 基于 completedActions 检测 hasSendMessage。
 * shell-native 下 hasObserveMood/hasRateOutcome 始终为 false。
 */
import { describe, expect, it } from "vitest";
import { checkFeedbackGap } from "../src/core/action-executor.js";
import type { ScriptExecutionResult } from "../src/core/script-execution.js";

// -- 辅助 --

function makeResult(completedActions: string[] = []): ScriptExecutionResult {
  return {
    logs: [],
    errors: [],
    instructionErrors: [],
    errorCodes: [],
    duration: 0,
    thinks: [],
    queryLogs: [],
    observations: [],
    completedActions,
    silenceReason: null,
  };
}

// -- checkFeedbackGap --

describe("checkFeedbackGap (shell-native)", () => {
  it("有 sent: completedAction → hasSendMessage=true, isMissing=true", () => {
    const result = makeResult(["sent:chatId=123:msgId=456"]);
    const gap = checkFeedbackGap(result);
    expect(gap.hasSendMessage).toBe(true);
    // shell-native: hasObserveMood 始终 false → isMissing=true
    expect(gap.isMissing).toBe(true);
  });

  it("无 completedActions → hasSendMessage=false", () => {
    const result = makeResult();
    const gap = checkFeedbackGap(result);
    expect(gap.hasSendMessage).toBe(false);
    expect(gap.isMissing).toBe(false);
  });

  it("只有 sticker: completedAction → 也算出站社交动作", () => {
    const result = makeResult(["sticker:chatId=123:msgId=456"]);
    const gap = checkFeedbackGap(result);
    expect(gap.hasSendMessage).toBe(true);
    expect(gap.isMissing).toBe(true);
  });

  it("shell-native 下 hasObserveMood 始终 false", () => {
    const result = makeResult(["sent:chatId=123:msgId=456"]);
    const gap = checkFeedbackGap(result);
    expect(gap.hasObserveMood).toBe(false);
  });

  it("shell-native 下 hasRateOutcome 始终 false", () => {
    const result = makeResult(["sent:chatId=123:msgId=456"]);
    const gap = checkFeedbackGap(result);
    expect(gap.hasRateOutcome).toBe(false);
  });
});
