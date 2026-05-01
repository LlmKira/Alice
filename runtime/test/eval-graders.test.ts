/**
 * ADR-136 + ADR-138: graders.ts 单元测试。
 *
 * ADR-214 Wave B: EvalAction 替代 RecordedAction。
 *
 * 覆盖：
 * - classifyBranch（9 种分支）
 * - classifyIntent（Branch → SocialIntent 映射）
 * - gradeStructural（结构性评分：Intent primary + Branch secondary）
 */
import { describe, expect, it } from "vitest";
import { emptyScriptExecutionResult } from "../src/core/script-execution.js";
import {
  BRANCH_INTENT_MAP,
  classifyBranch,
  classifyIntent,
  type EvalAction,
  type EvalTickResult,
  gradeStructural,
} from "../src/eval/graders.js";
import type { StructuralAssertions } from "../src/eval/types.js";

// ── 辅助工厂 ─────────────────────────────────────────────────────────────

/** 创建默认 EvalTickResult，可按需覆盖字段。 */
function makeTickResult(overrides: Partial<EvalTickResult> = {}): EvalTickResult {
  return {
    outcome: "terminal",
    actions: [],
    instructions: [],
    observations: [],
    execution: emptyScriptExecutionResult(),
    silenceReason: null,
    stepsUsed: 1,
    preparedCategories: [],
    duration: 100,
    episodeRounds: 0,
    ...overrides,
  };
}

/** 创建一条 Telegram send_message 动作。 */
function makeSendMessage(extra: Record<string, unknown> = {}): EvalAction {
  return {
    type: "telegram",
    fn: "send_message",
    args: { chatId: "channel:123", text: "hello", ...extra },
    executedAt: Date.now(),
  };
}

/** 创建一条 Telegram 动作（非 send_message）。 */
function makeAction(fn: string, args: Record<string, unknown> = {}): EvalAction {
  return {
    type: "telegram",
    fn,
    args,
    executedAt: Date.now(),
  };
}

/** 创建一条 dispatch 指令记录。 */
function makeInstruction(fn: string, args: Record<string, unknown> = {}): EvalAction {
  return {
    type: "dispatch",
    fn,
    args,
    executedAt: Date.now(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// classifyBranch
// ═══════════════════════════════════════════════════════════════════════════

describe("classifyBranch", () => {
  it('outcome "empty" → "llm_failed"', () => {
    const result = makeTickResult({ outcome: "empty" });
    expect(classifyBranch(result, 1)).toBe("llm_failed");
  });

  it('outcome "waiting_reply" → "waiting_reply"', () => {
    const result = makeTickResult({ outcome: "waiting_reply" });
    expect(classifyBranch(result, 1)).toBe("waiting_reply");
  });

  it('outcome "watching" → "watching"', () => {
    const result = makeTickResult({ outcome: "watching" });
    expect(classifyBranch(result, 1)).toBe("watching");
  });

  it('有 send_message + 1 轮 → "reply"', () => {
    const result = makeTickResult({ actions: [makeSendMessage()] });
    expect(classifyBranch(result, 1)).toBe("reply");
  });

  it('有 silenceReason + 1 轮 → "silence"', () => {
    const result = makeTickResult({ silenceReason: "群聊无关消息" });
    expect(classifyBranch(result, 1)).toBe("silence");
  });

  it('有 send_message + 2 轮 → "observe_then_reply"', () => {
    const result = makeTickResult({ actions: [makeSendMessage()] });
    expect(classifyBranch(result, 2)).toBe("observe_then_reply");
  });

  it('有 silenceReason + 3 轮 → "observe_then_silence"', () => {
    const result = makeTickResult({ silenceReason: "观察后决定沉默" });
    expect(classifyBranch(result, 3)).toBe("observe_then_silence");
  });

  it('有 react 动作但无 send_message → "action_only"', () => {
    const result = makeTickResult({
      actions: [makeAction("react", { emoji: "👍" })],
    });
    expect(classifyBranch(result, 1)).toBe("action_only");
  });

  it('无任何动作和 silenceReason → "no_action"', () => {
    const result = makeTickResult();
    expect(classifyBranch(result, 1)).toBe("no_action");
  });

  it("outcome 优先级高于 actions（empty 覆盖 send_message）", () => {
    const result = makeTickResult({
      outcome: "empty",
      actions: [makeSendMessage()],
    });
    expect(classifyBranch(result, 1)).toBe("llm_failed");
  });

  // ── ADR-139: reply + expect_reply = engage ──

  it('ADR-139: expect_reply + send_message → "reply"（参与优先于暂缓）', () => {
    const result = makeTickResult({
      outcome: "waiting_reply",
      actions: [makeSendMessage()],
    });
    expect(classifyBranch(result, 1)).toBe("reply");
  });

  it('ADR-139: expect_reply + send_message + 2 轮 → "observe_then_reply"', () => {
    const result = makeTickResult({
      outcome: "waiting_reply",
      actions: [makeSendMessage()],
    });
    expect(classifyBranch(result, 2)).toBe("observe_then_reply");
  });

  it('ADR-139: stay + send_message → "reply"', () => {
    const result = makeTickResult({
      outcome: "watching",
      actions: [makeSendMessage()],
    });
    expect(classifyBranch(result, 1)).toBe("reply");
  });

  it('ADR-139: expect_reply + react（无 send_message）→ 仍然 "waiting_reply"', () => {
    const result = makeTickResult({
      outcome: "waiting_reply",
      actions: [makeAction("react", { emoji: "👍" })],
    });
    expect(classifyBranch(result, 1)).toBe("waiting_reply");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// classifyIntent（ADR-138）
// ═══════════════════════════════════════════════════════════════════════════

describe("classifyIntent", () => {
  it("reply → engage", () => {
    expect(classifyIntent("reply")).toBe("engage");
  });

  it("observe_then_reply → engage", () => {
    expect(classifyIntent("observe_then_reply")).toBe("engage");
  });

  it("action_only → engage", () => {
    expect(classifyIntent("action_only")).toBe("engage");
  });

  it("silence → silence", () => {
    expect(classifyIntent("silence")).toBe("silence");
  });

  it("observe_then_silence → silence", () => {
    expect(classifyIntent("observe_then_silence")).toBe("silence");
  });

  it("expect_reply → defer", () => {
    expect(classifyIntent("waiting_reply")).toBe("defer");
  });

  it("stay → defer", () => {
    expect(classifyIntent("watching")).toBe("defer");
  });

  it("no_action → null", () => {
    expect(classifyIntent("no_action")).toBeNull();
  });

  it("llm_failed → null", () => {
    expect(classifyIntent("llm_failed")).toBeNull();
  });

  it("BRANCH_INTENT_MAP 覆盖所有 9 种分支", () => {
    expect(Object.keys(BRANCH_INTENT_MAP)).toHaveLength(9);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// gradeStructural
// ═══════════════════════════════════════════════════════════════════════════

describe("gradeStructural", () => {
  // ── Intent check（ADR-138 primary）──

  it("intent 匹配 → pass（无 expectedBranch 时只检查 intent）", () => {
    const result = makeTickResult({ actions: [makeSendMessage()] });
    const assertions: StructuralAssertions = {
      expectedIntent: "engage",
      actions: { must: ["send_message"] },
    };
    const grade = gradeStructural(result, assertions, 1);
    expect(grade.pass).toBe(true);
    expect(grade.checks.find((c) => c.name === "intent")?.pass).toBe(true);
    // 无 branch check
    expect(grade.checks.find((c) => c.name === "branch")).toBeUndefined();
  });

  it("intent 不匹配 → fail", () => {
    const result = makeTickResult({ actions: [makeSendMessage()] });
    const assertions: StructuralAssertions = {
      expectedIntent: "silence",
      actions: { must: ["send_message"] },
    };
    const grade = gradeStructural(result, assertions, 1);
    expect(grade.pass).toBe(false);
    const intentCheck = grade.checks.find((c) => c.name === "intent");
    expect(intentCheck?.pass).toBe(false);
    expect(intentCheck?.actual).toBe("engage");
    expect(intentCheck?.expected).toBe("silence");
  });

  it("no_action → intent=null → 任何 expectedIntent 都失败", () => {
    const result = makeTickResult();
    const assertions: StructuralAssertions = { expectedIntent: "engage" };
    const grade = gradeStructural(result, assertions, 1);
    expect(grade.pass).toBe(false);
    expect(grade.checks.find((c) => c.name === "intent")?.actual).toBe("null");
  });

  it("observe_then_reply 满足 engage intent（过程差异被容忍）", () => {
    const result = makeTickResult({ actions: [makeSendMessage()] });
    const assertions: StructuralAssertions = {
      expectedIntent: "engage",
      actions: { must: ["send_message"] },
    };
    // 2 rounds → observe_then_reply → engage intent
    const grade = gradeStructural(result, assertions, 2);
    expect(grade.pass).toBe(true);
    expect(grade.checks.find((c) => c.name === "intent")?.pass).toBe(true);
  });

  it("stay 满足 defer intent", () => {
    const result = makeTickResult({ outcome: "watching" });
    const assertions: StructuralAssertions = {
      expectedIntent: "defer",
      actions: { must_not: ["send_message"] },
    };
    const grade = gradeStructural(result, assertions, 1);
    expect(grade.pass).toBe(true);
  });

  it("expect_reply 满足 defer intent", () => {
    const result = makeTickResult({ outcome: "waiting_reply" });
    const assertions: StructuralAssertions = {
      expectedIntent: "defer",
      actions: { must_not: ["send_message"] },
    };
    const grade = gradeStructural(result, assertions, 1);
    expect(grade.pass).toBe(true);
  });

  it("observe_then_silence 满足 silence intent", () => {
    const result = makeTickResult({ silenceReason: "已有人回答" });
    const assertions: StructuralAssertions = {
      expectedIntent: "silence",
      actions: { must_not: ["send_message"] },
    };
    // 3 rounds → observe_then_silence
    const grade = gradeStructural(result, assertions, 3);
    expect(grade.pass).toBe(true);
  });

  // ── ADR-139: reply + expect_reply = engage ──

  it("ADR-139: reply + expect_reply 满足 engage intent", () => {
    const result = makeTickResult({
      outcome: "waiting_reply",
      actions: [makeSendMessage()],
    });
    const assertions: StructuralAssertions = {
      expectedIntent: "engage",
      actions: { must: ["send_message"] },
    };
    const grade = gradeStructural(result, assertions, 1);
    expect(grade.pass).toBe(true);
    expect(grade.checks.find((c) => c.name === "intent")?.actual).toBe("engage");
  });

  it("ADR-139: reply + expect_reply + expectedBranch=reply → branch=reply", () => {
    const result = makeTickResult({
      outcome: "waiting_reply",
      actions: [makeSendMessage()],
    });
    const assertions: StructuralAssertions = {
      expectedIntent: "engage",
      expectedBranch: "reply",
      actions: { must: ["send_message"] },
    };
    const grade = gradeStructural(result, assertions, 1);
    expect(grade.pass).toBe(true);
    expect(grade.checks.find((c) => c.name === "branch")?.actual).toBe("reply");
  });

  // ── Intent 可接受集（ADR-138 扩展）──

  it("intent 可接受集 — actual 在集合中 → pass", () => {
    const result = makeTickResult({ silenceReason: "半句话，等对方说完" });
    const assertions: StructuralAssertions = {
      expectedIntent: ["defer", "silence"],
      actions: { must_not: ["send_message"] },
    };
    const grade = gradeStructural(result, assertions, 1);
    expect(grade.pass).toBe(true);
    expect(grade.checks.find((c) => c.name === "intent")?.pass).toBe(true);
  });

  it("intent 可接受集 — actual 不在集合中 → fail", () => {
    const result = makeTickResult({ actions: [makeSendMessage()] });
    const assertions: StructuralAssertions = {
      expectedIntent: ["defer", "silence"],
    };
    const grade = gradeStructural(result, assertions, 1);
    expect(grade.pass).toBe(false);
    const intentCheck = grade.checks.find((c) => c.name === "intent");
    expect(intentCheck?.pass).toBe(false);
    expect(intentCheck?.expected).toBe("defer|silence");
    expect(intentCheck?.actual).toBe("engage");
  });

  it("intent 可接受集 — expected 字段格式为 'a|b'", () => {
    const result = makeTickResult({ outcome: "waiting_reply" });
    const assertions: StructuralAssertions = {
      expectedIntent: ["defer", "silence"],
      actions: { must_not: ["send_message"] },
    };
    const grade = gradeStructural(result, assertions, 1);
    const intentCheck = grade.checks.find((c) => c.name === "intent");
    expect(intentCheck?.expected).toBe("defer|silence");
  });

  it("intent 单值 — 向后兼容（expected 字段不含 '|'）", () => {
    const result = makeTickResult({ actions: [makeSendMessage()] });
    const assertions: StructuralAssertions = {
      expectedIntent: "engage",
      actions: { must: ["send_message"] },
    };
    const grade = gradeStructural(result, assertions, 1);
    const intentCheck = grade.checks.find((c) => c.name === "intent");
    expect(intentCheck?.expected).toBe("engage");
  });

  // ── Intent + Branch（dual check）──

  it("intent + branch 都匹配 → pass", () => {
    const result = makeTickResult({ actions: [makeSendMessage()] });
    const assertions: StructuralAssertions = {
      expectedIntent: "engage",
      expectedBranch: "reply",
      actions: { must: ["send_message"] },
    };
    const grade = gradeStructural(result, assertions, 1);
    expect(grade.pass).toBe(true);
    expect(grade.checks.find((c) => c.name === "intent")?.pass).toBe(true);
    expect(grade.checks.find((c) => c.name === "branch")?.pass).toBe(true);
  });

  it("intent 匹配但 branch 不匹配 → pass（branch 是 process tier，仅诊断）", () => {
    const result = makeTickResult({ actions: [makeSendMessage()] });
    const assertions: StructuralAssertions = {
      expectedIntent: "engage",
      expectedBranch: "reply",
      actions: { must: ["send_message"] },
    };
    const grade = gradeStructural(result, assertions, 2);
    expect(grade.pass).toBe(true);
    expect(grade.checks.find((c) => c.name === "intent")?.pass).toBe(true);
    expect(grade.checks.find((c) => c.name === "branch")?.pass).toBe(false);
    expect(grade.checks.find((c) => c.name === "branch")?.tier).toBe("process");
    expect(grade.checks.find((c) => c.name === "branch")?.actual).toBe("observe_then_reply");
  });

  // ── rounds ──

  it("rounds 精确匹配", () => {
    const result = makeTickResult({ actions: [makeSendMessage()] });
    const assertions: StructuralAssertions = {
      expectedIntent: "engage",
      expectedBranch: "observe_then_reply",
      expectedRounds: 2,
    };
    const grade = gradeStructural(result, assertions, 2);
    expect(grade.checks.find((c) => c.name === "steps")?.pass).toBe(true);
  });

  it("rounds 范围匹配 — 范围内通过", () => {
    const result = makeTickResult({ actions: [makeSendMessage()] });
    const assertions: StructuralAssertions = {
      expectedIntent: "engage",
      expectedBranch: "observe_then_reply",
      expectedRounds: [2, 4],
    };
    const grade = gradeStructural(result, assertions, 3);
    expect(grade.checks.find((c) => c.name === "steps")?.pass).toBe(true);
  });

  it("rounds 范围匹配 — 范围外失败", () => {
    const result = makeTickResult({ actions: [makeSendMessage()] });
    const assertions: StructuralAssertions = {
      expectedIntent: "engage",
      expectedBranch: "reply",
      expectedRounds: [2, 4],
    };
    const grade = gradeStructural(result, assertions, 1);
    const roundsCheck = grade.checks.find((c) => c.name === "steps");
    expect(roundsCheck?.pass).toBe(false);
    expect(roundsCheck?.actual).toBe("1");
  });

  // ── actions ──

  it("actions.must 通过", () => {
    const result = makeTickResult({
      actions: [makeSendMessage(), makeAction("react", { emoji: "👍" })],
    });
    const assertions: StructuralAssertions = {
      expectedIntent: "engage",
      expectedBranch: "reply",
      actions: { must: ["send_message", "react"] },
    };
    const grade = gradeStructural(result, assertions, 1);
    expect(
      grade.checks.filter((c) => c.name.startsWith("actions.must:")).every((c) => c.pass),
    ).toBe(true);
  });

  it("actions.must 失败 — 缺少函数", () => {
    const result = makeTickResult({ actions: [makeSendMessage()] });
    const assertions: StructuralAssertions = {
      expectedIntent: "engage",
      expectedBranch: "reply",
      actions: { must: ["send_message", "react"] },
    };
    const grade = gradeStructural(result, assertions, 1);
    expect(grade.pass).toBe(false);
    expect(grade.checks.find((c) => c.name === "actions.must:react")?.pass).toBe(false);
  });

  it("actions.must_not 违反", () => {
    const result = makeTickResult({
      actions: [makeSendMessage(), makeAction("send_sticker")],
    });
    const assertions: StructuralAssertions = {
      expectedIntent: "engage",
      expectedBranch: "reply",
      actions: { must_not: ["send_sticker"] },
    };
    const grade = gradeStructural(result, assertions, 1);
    expect(grade.pass).toBe(false);
    expect(grade.checks.find((c) => c.name === "actions.must_not:send_sticker")?.pass).toBe(false);
  });

  it("actions.any_of 至少一个存在", () => {
    const result = makeTickResult({
      actions: [makeAction("react", { emoji: "😂" })],
    });
    const assertions: StructuralAssertions = {
      expectedIntent: "engage",
      expectedBranch: "action_only",
      actions: { any_of: ["send_sticker", "react"] },
    };
    const grade = gradeStructural(result, assertions, 1);
    expect(grade.checks.find((c) => c.name === "actions.any_of")?.pass).toBe(true);
  });

  // ── instructions ──

  it("instructions.must 通过", () => {
    const result = makeTickResult({
      actions: [makeSendMessage()],
      instructions: [makeInstruction("feel"), makeInstruction("note")],
    });
    const assertions: StructuralAssertions = {
      expectedIntent: "engage",
      expectedBranch: "reply",
      instructions: { must: ["feel", "note"] },
    };
    const grade = gradeStructural(result, assertions, 1);
    expect(
      grade.checks.filter((c) => c.name.startsWith("instructions.must:")).every((c) => c.pass),
    ).toBe(true);
  });

  it("instructions.must 失败", () => {
    const result = makeTickResult({
      actions: [makeSendMessage()],
      instructions: [makeInstruction("feel")],
    });
    const assertions: StructuralAssertions = {
      expectedIntent: "engage",
      expectedBranch: "reply",
      instructions: { must: ["feel", "note"] },
    };
    const grade = gradeStructural(result, assertions, 1);
    expect(grade.checks.find((c) => c.name === "instructions.must:note")?.pass).toBe(false);
  });

  // ── queries ──

  it("queries.must 通过", () => {
    const result = makeTickResult({
      actions: [makeSendMessage()],
      execution: emptyScriptExecutionResult({
        queryLogs: [
          { fn: "get_profile", result: '{"name":"Alice"}' },
          { fn: "get_chat_history", result: "[]" },
        ],
      }),
    });
    const assertions: StructuralAssertions = {
      expectedIntent: "engage",
      expectedBranch: "reply",
      queries: { must: ["get_profile"] },
    };
    const grade = gradeStructural(result, assertions, 1);
    expect(grade.checks.find((c) => c.name === "queries.must:get_profile")?.pass).toBe(true);
  });

  // ── replyDirected ──

  it("replyDirected = true — 有 replyTo 通过", () => {
    const result = makeTickResult({
      actions: [makeSendMessage({ replyTo: 42 })],
    });
    const assertions: StructuralAssertions = {
      expectedIntent: "engage",
      expectedBranch: "reply",
      replyDirected: true,
    };
    const grade = gradeStructural(result, assertions, 1);
    expect(grade.checks.find((c) => c.name === "replyDirected")?.pass).toBe(true);
  });

  it("replyDirected = false — 无 replyTo 通过", () => {
    const result = makeTickResult({
      actions: [makeSendMessage()],
    });
    const assertions: StructuralAssertions = {
      expectedIntent: "engage",
      expectedBranch: "reply",
      replyDirected: false,
    };
    const grade = gradeStructural(result, assertions, 1);
    expect(grade.checks.find((c) => c.name === "replyDirected")?.pass).toBe(true);
  });

  // ── score 反映通过比例 ──

  it("score 反映通过比例（仅 goal tier 参与）", () => {
    const result = makeTickResult({ actions: [makeSendMessage()] });
    const assertions: StructuralAssertions = {
      expectedIntent: "engage",
      expectedBranch: "reply",
      actions: { must: ["send_message", "react"] },
    };
    const grade = gradeStructural(result, assertions, 1);
    // 4 checks total: intent(goal,pass) + branch(process,pass) + must:send_message(goal,pass) + must:react(goal,fail)
    // score = goal 通过率 = 2/3（branch 是 process tier，不参与 score）
    expect(grade.score).toBeCloseTo(2 / 3);
    expect(grade.pass).toBe(false); // must:react 是 goal tier 且失败
  });
});
