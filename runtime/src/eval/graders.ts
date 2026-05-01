/**
 * ADR-136 + ADR-138: 结构性评分器。
 *
 * ADR-214 Wave B: RecordedAction 已删除。
 * EvalTickResult 使用简化的 EvalAction 接口（fn + type + args）。
 * shell-native 架构下 actions/instructions 始终为空（TickResult 不含这些字段），
 * 但 Eval 场景需要手动注入以测试 grader 逻辑。
 *
 * @see docs/adr/136-model-eval-suite.md
 * @see docs/adr/138-social-intent-truth-model.md
 */
import type { TickResult } from "../engine/tick/types.js";
import type {
  Check,
  CheckTier,
  ExpectedBranch,
  SocialIntent,
  StructuralAssertions,
  StructuralGradeResult,
} from "./types.js";

// ── Eval 专用类型 ────────────────────────────────────────────────────────

/**
 * Eval 专用动作记录 — 替代旧 RecordedAction，仅保留 grader 需要的字段。
 */
export interface EvalAction {
  type: "telegram" | "dispatch";
  fn: string;
  args: Record<string, unknown>;
  executedAt: number;
}

/**
 * Eval 专用 TickResult — 添加 actions/instructions/silenceReason 供 graders 使用。
 * shell-native 架构下这些字段在真实运行时始终为空，Eval 场景手动注入。
 */
export interface EvalTickResult extends TickResult {
  actions: EvalAction[];
  instructions: EvalAction[];
  silenceReason: string | null;
}

/** 从 TickResult 创建 EvalTickResult（默认空值）。 */
export function toEvalTickResult(result: TickResult): EvalTickResult {
  return {
    ...result,
    actions: [],
    instructions: [],
    silenceReason: result.execution.silenceReason,
  };
}

// ── 分支分类 ─────────────────────────────────────────────────────────────

export type ActualBranch = ExpectedBranch | "no_action" | "llm_failed";

function hasMessage(actions: readonly EvalAction[]): boolean {
  return actions.some((a) => a.type === "telegram" && a.fn === "send_message");
}

/**
 * 根据 EvalTickResult 信号字段判定分支类型。
 */
export function classifyBranch(result: EvalTickResult, steps: number): ActualBranch {
  if (result.outcome === "empty") return "llm_failed";

  if (result.outcome === "waiting_reply" || result.outcome === "watching") {
    const msg = hasMessage(result.actions);
    if (!msg) {
      return result.outcome;
    }
    return steps > 1 ? "observe_then_reply" : "reply";
  }

  const msg = hasMessage(result.actions);
  if (steps > 1 && msg) return "observe_then_reply";
  if (steps > 1 && result.silenceReason !== null) return "observe_then_silence";

  if (msg) return "reply";
  if (result.silenceReason !== null) return "silence";

  if (result.actions.length > 0) return "action_only";

  return "no_action";
}

// ── Intent 分类（ADR-138）─────────────────────────────────────────────────

export const BRANCH_INTENT_MAP: Readonly<Record<ActualBranch, SocialIntent | null>> = {
  reply: "engage",
  observe_then_reply: "engage",
  action_only: "engage",
  silence: "silence",
  observe_then_silence: "silence",
  waiting_reply: "defer",
  watching: "defer",
  no_action: null,
  llm_failed: null,
};

export function classifyIntent(branch: ActualBranch): SocialIntent | null {
  return BRANCH_INTENT_MAP[branch];
}

// ── 内部工具函数 ──────────────────────────────────────────────────────────

function check(
  name: string,
  pass: boolean,
  expected: string,
  actual: string,
  tier: CheckTier,
): Check {
  return { name, pass, expected, actual, tier };
}

// ── 结构性评分 ────────────────────────────────────────────────────────────

export function gradeStructural(
  result: EvalTickResult,
  assertions: StructuralAssertions,
  steps: number,
): StructuralGradeResult {
  const checks: Check[] = [];

  const actualBranch = classifyBranch(result, steps);
  const actualIntent = classifyIntent(actualBranch);

  const acceptableIntents: readonly SocialIntent[] = Array.isArray(assertions.expectedIntent)
    ? assertions.expectedIntent
    : [assertions.expectedIntent];
  checks.push(
    check(
      "intent",
      actualIntent !== null && acceptableIntents.includes(actualIntent),
      acceptableIntents.length === 1 ? acceptableIntents[0] : acceptableIntents.join("|"),
      actualIntent ?? "null",
      "goal",
    ),
  );

  if (assertions.expectedBranch !== undefined) {
    checks.push(
      check(
        "branch",
        actualBranch === assertions.expectedBranch,
        assertions.expectedBranch,
        actualBranch,
        "process",
      ),
    );
  }

  if (assertions.expectedRounds !== undefined) {
    const er = assertions.expectedRounds;
    if (typeof er === "number") {
      checks.push(check("steps", steps === er, String(er), String(steps), "process"));
    } else {
      const [min, max] = er;
      checks.push(
        check("steps", steps >= min && steps <= max, `[${min}, ${max}]`, String(steps), "process"),
      );
    }
  }

  if (assertions.maxSteps !== undefined) {
    checks.push(
      check(
        "maxSteps",
        steps <= assertions.maxSteps,
        `<= ${assertions.maxSteps}`,
        String(steps),
        "budget",
      ),
    );
  }

  const actionFns = result.actions.map((a) => a.fn);
  if (assertions.actions?.must) {
    for (const fn of assertions.actions.must) {
      checks.push(
        check(
          `actions.must:${fn}`,
          actionFns.includes(fn),
          `actions contains "${fn}"`,
          actionFns.length > 0 ? actionFns.join(", ") : "(none)",
          "goal",
        ),
      );
    }
  }

  if (assertions.actions?.must_not) {
    for (const fn of assertions.actions.must_not) {
      checks.push(
        check(
          `actions.must_not:${fn}`,
          !actionFns.includes(fn),
          `actions does not contain "${fn}"`,
          actionFns.includes(fn) ? `found "${fn}"` : "(absent)",
          "goal",
        ),
      );
    }
  }

  if (assertions.actions?.any_of) {
    const found = assertions.actions.any_of.some((fn) => actionFns.includes(fn));
    checks.push(
      check(
        "actions.any_of",
        found,
        `at least one of [${assertions.actions.any_of.join(", ")}]`,
        actionFns.length > 0 ? actionFns.join(", ") : "(none)",
        "goal",
      ),
    );
  }

  const instrFns = result.instructions.map((i) => i.fn);
  if (assertions.instructions?.must) {
    for (const fn of assertions.instructions.must) {
      checks.push(
        check(
          `instructions.must:${fn}`,
          instrFns.includes(fn),
          `instructions contains "${fn}"`,
          instrFns.length > 0 ? instrFns.join(", ") : "(none)",
          "goal",
        ),
      );
    }
  }

  if (assertions.instructions?.must_not) {
    for (const fn of assertions.instructions.must_not) {
      checks.push(
        check(
          `instructions.must_not:${fn}`,
          !instrFns.includes(fn),
          `instructions does not contain "${fn}"`,
          instrFns.includes(fn) ? `found "${fn}"` : "(absent)",
          "goal",
        ),
      );
    }
  }

  if (assertions.queries?.must) {
    const queryFns = result.execution.queryLogs.map((q) => q.fn);
    for (const fn of assertions.queries.must) {
      checks.push(
        check(
          `queries.must:${fn}`,
          queryFns.includes(fn),
          `queryLogs contains "${fn}"`,
          queryFns.length > 0 ? queryFns.join(", ") : "(none)",
          "process",
        ),
      );
    }
  }

  if (assertions.replyDirected !== undefined) {
    const msgActions = result.actions.filter(
      (a) => a.type === "telegram" && a.fn === "send_message",
    );
    const hasReplyTo = msgActions.some((a) => a.args.replyTo != null);
    checks.push(
      check(
        "replyDirected",
        hasReplyTo === assertions.replyDirected,
        assertions.replyDirected ? "has replyTo" : "no replyTo",
        hasReplyTo ? "has replyTo" : "no replyTo",
        "goal",
      ),
    );
  }

  if (assertions.expectedNeeds !== undefined) {
    const actualNeeds = result.preparedCategories ?? [];
    for (const need of assertions.expectedNeeds) {
      checks.push(
        check(
          `preparedCategory:${need}`,
          actualNeeds.includes(need),
          `preparedCategories contains "${need}"`,
          actualNeeds.length > 0 ? actualNeeds.join(", ") : "(none)",
          "goal",
        ),
      );
    }
  }

  const goalAndBudget = checks.filter((c) => c.tier === "goal" || c.tier === "budget");
  const goalChecks = checks.filter((c) => c.tier === "goal");
  const goalPassCount = goalChecks.filter((c) => c.pass).length;

  return {
    pass: goalAndBudget.every((c) => c.pass),
    checks,
    score: goalChecks.length > 0 ? goalPassCount / goalChecks.length : 1,
  };
}
