/**
 * ADR-142 测试 — collectAllTools + Blackboard。
 *
 * ADR-214 Wave A: 删除 actions/instructions/silenceReason/rolledBack 相关断言。
 */
import { describe, expect, it } from "vitest";
import type { ScriptExecutionResult } from "../src/core/script-execution.js";
import type { ModDefinition } from "../src/core/types.js";
import { collectAllTools } from "../src/engine/tick/affordance-filter.js";
import {
  createBlackboard,
  drainBoard,
  isTerminal,
  updateBoard,
} from "../src/engine/tick/blackboard.js";
import type {
  AffordanceDeclaration,
  Blackboard,
  FeatureFlags,
  ToolCategory,
} from "../src/engine/tick/types.js";
import type { TelegramActionDef } from "../src/telegram/action-types.js";

// ── Mock 工厂 ────────────────────────────────────────────────────────────

function makeAffordance(
  priority: "sensor" | "core" | "capability" | "on-demand",
  category?: ToolCategory,
  requires?: keyof FeatureFlags,
): AffordanceDeclaration {
  const base = { whenToUse: "test", whenNotToUse: "test", ...(requires && { requires }) };
  switch (priority) {
    case "sensor":
      return { ...base, priority: "sensor" };
    case "core":
      return { ...base, priority: "core" };
    case "capability":
      // biome-ignore lint/style/noNonNullAssertion: guarded by test assertion
      return { ...base, priority: "capability", category: category! };
    case "on-demand":
      return { ...base, priority: "on-demand", ...(category && { category }) };
  }
}

function makeTelegramAction(name: string, affordance?: AffordanceDeclaration): TelegramActionDef {
  return {
    name,
    description: ["test action"],
    params: [],
    impl: async () => true,
    affordance,
  } as unknown as TelegramActionDef;
}

function makeMod(
  name: string,
  instructions?: Record<string, { affordance?: AffordanceDeclaration }>,
  queries?: Record<string, { affordance?: AffordanceDeclaration }>,
): ModDefinition {
  const instDefs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(instructions ?? {})) {
    instDefs[k] = {
      params: {},
      description: "test",
      impl: () => {},
      ...v,
    };
  }
  const queryDefs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(queries ?? {})) {
    queryDefs[k] = {
      params: {},
      description: "test",
      impl: () => {},
      ...v,
    };
  }
  return {
    meta: { name, category: "mechanic" },
    initialState: {},
    instructions: instDefs,
    queries: queryDefs,
  } as unknown as ModDefinition;
}

function makeFeatureFlags(overrides: Partial<FeatureFlags> = {}): FeatureFlags {
  return {
    hasWeather: false,
    hasMusic: false,
    hasBrowser: false,
    hasTTS: false,
    hasStickers: false,
    hasBots: false,
    hasSystemThreads: false,
    hasVideo: false,
    ...overrides,
  };
}

function makeScriptExecutionResult(
  overrides: Partial<ScriptExecutionResult> = {},
): ScriptExecutionResult {
  return {
    logs: [],
    errors: [],
    instructionErrors: [],
    errorCodes: [],
    duration: 10,
    thinks: [],
    queryLogs: [],
    observations: [],
    completedActions: [],
    silenceReason: null,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// collectAllTools
// ═══════════════════════════════════════════════════════════════════════════

describe("collectAllTools", () => {
  it("只收集有 affordance 的 Telegram actions", () => {
    const actions = [
      makeTelegramAction("send_message", makeAffordance("core")),
      makeTelegramAction("internal_noop"), // 无 affordance
    ];
    const tools = collectAllTools([], actions);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("send_message");
  });

  it("收集 Mod instructions 和 queries 的 affordance", () => {
    const mod = makeMod(
      "test-mod",
      {
        feel: { affordance: makeAffordance("sensor") },
        internal_cmd: {}, // 无 affordance
      },
      {
        get_weather: { affordance: makeAffordance("capability", "weather") },
      },
    );
    const tools = collectAllTools([mod], []);
    expect(tools).toHaveLength(2);
    expect(tools.find((t) => t.name === "feel")).toBeDefined();
    expect(tools.find((t) => t.name === "get_weather")).toBeDefined();
  });

  it("多个 Mod + 多个 Telegram actions 统一收集", () => {
    const mod1 = makeMod("mod1", { a: { affordance: makeAffordance("core") } });
    const mod2 = makeMod("mod2", {}, { b: { affordance: makeAffordance("on-demand") } });
    const actions = [makeTelegramAction("c", makeAffordance("capability", "music"))];
    const tools = collectAllTools([mod1, mod2], actions);
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name).sort()).toEqual(["a", "b", "c"]);
  });

  it("Mod 无 instructions/queries 时返回空", () => {
    const mod = makeMod("empty");
    const tools = collectAllTools([mod], []);
    expect(tools).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// createBlackboard
// ═══════════════════════════════════════════════════════════════════════════

describe("createBlackboard", () => {
  it("初始状态正确", () => {
    const board = createBlackboard({
      pressures: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
      voice: "curious",
      target: "channel:123",
      features: makeFeatureFlags(),
      contextVars: { TARGET_CHAT: 123 },
    });

    expect(board.pressures).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
    expect(board.voice).toBe("curious");
    expect(board.target).toBe("channel:123");
    expect(board.observations).toEqual([]);
    expect(board.execution.errors).toEqual([]);
    expect(board.preparedCategories.size).toBe(0);
    expect(board.execution.thinks).toEqual([]);
    expect(board.execution.queryLogs).toEqual([]);
    expect(board.budget).toEqual({ maxSteps: 3, usedSteps: 0 });
  });

  it("自定义 maxSteps", () => {
    const board = createBlackboard({
      pressures: [0, 0, 0, 0, 0, 0],
      voice: "default",
      target: null,
      features: makeFeatureFlags(),
      contextVars: {},
      maxSteps: 5,
    });
    expect(board.budget.maxSteps).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// updateBoard
// ═══════════════════════════════════════════════════════════════════════════

describe("updateBoard", () => {
  function freshBoard(): Blackboard {
    return createBlackboard({
      pressures: [0, 0, 0, 0, 0, 0],
      voice: "default",
      target: null,
      features: makeFeatureFlags(),
      contextVars: {},
    });
  }

  it("合并脚本执行结果到 board", () => {
    const board = freshBoard();

    updateBoard(
      board,
      makeScriptExecutionResult({
        logs: ["visible output"],
        thinks: ["I should reply"],
        queryLogs: [{ fn: "get_weather", result: "sunny" }],
        errors: ["minor warning"],
        errorCodes: ["command_invalid_target"],
        completedActions: ["sent:chatId=1:msgId=2"],
        silenceReason: "not now",
      }),
    );

    expect(board.execution.logs).toEqual(["visible output"]);
    expect(board.execution.thinks).toEqual(["I should reply"]);
    expect(board.execution.queryLogs).toEqual([{ fn: "get_weather", result: "sunny" }]);
    expect(board.execution.errors).toEqual(["minor warning"]);
    expect(board.execution.errorCodes).toEqual(["command_invalid_target"]);
    expect(board.execution.completedActions).toEqual(["sent:chatId=1:msgId=2"]);
    expect(board.execution.silenceReason).toBe("not now");
    expect(board.budget.usedSteps).toBe(1);
  });

  it("多次 update 累积步数", () => {
    const board = freshBoard();
    updateBoard(board, makeScriptExecutionResult());
    updateBoard(board, makeScriptExecutionResult());
    expect(board.budget.usedSteps).toBe(2);
  });

  it("instructionErrors 累积到内部追踪", () => {
    const board = freshBoard();
    updateBoard(board, makeScriptExecutionResult({ instructionErrors: ["feel: invalid valence"] }));
    const result = drainBoard(board, "terminal", 100);
    expect(result.execution.instructionErrors).toEqual(["feel: invalid valence"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// isTerminal
// ═══════════════════════════════════════════════════════════════════════════

describe("isTerminal", () => {
  function freshBoard(maxSteps = 3): Blackboard {
    return createBlackboard({
      pressures: [0, 0, 0, 0, 0, 0],
      voice: "default",
      target: null,
      features: makeFeatureFlags(),
      contextVars: {},
      maxSteps,
    });
  }

  it("初始状态返回 null（可继续）", () => {
    const board = freshBoard();
    expect(isTerminal(board)).toBeNull();
  });

  it("预算耗尽 → terminal（不触发 llm_failed）", () => {
    const board = freshBoard(1);
    board.budget.usedSteps = 1;
    expect(isTerminal(board)).toBe("terminal");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// drainBoard
// ═══════════════════════════════════════════════════════════════════════════

describe("drainBoard", () => {
  it("输出完整 TickResult 结构", () => {
    const board = createBlackboard({
      pressures: [0, 0, 0, 0, 0, 0],
      voice: "default",
      target: null,
      features: makeFeatureFlags(),
      contextVars: {},
    });

    board.execution.thinks.push("reasoning");
    board.observations.push("user is happy");
    board.execution.logs.push("visible output");
    board.execution.errorCodes.push("command_invalid_target");
    board.execution.completedActions.push("sent:chatId=1:msgId=2");
    board.execution.silenceReason = "not now";
    board.preparedCategories.add("weather");
    board.budget.usedSteps = 2;

    const result = drainBoard(board, "terminal", 150);

    expect(result.outcome).toBe("terminal");
    expect(result.execution.thinks).toEqual(["reasoning"]);
    expect(result.observations).toEqual(["user is happy"]);
    expect(result.execution.logs).toEqual(["visible output"]);
    expect(result.execution.errors).toEqual([]);
    expect(result.execution.errorCodes).toEqual(["command_invalid_target"]);
    expect(result.execution.completedActions).toEqual(["sent:chatId=1:msgId=2"]);
    expect(result.execution.silenceReason).toBe("not now");
    expect(result.execution.instructionErrors).toEqual([]);
    expect(result.stepsUsed).toBe(2);
    expect(result.preparedCategories).toEqual(["weather"]);
    expect(result.duration).toBe(150);
  });

  it("preparedCategories 从 Set 转为数组", () => {
    const board = createBlackboard({
      pressures: [0, 0, 0, 0, 0, 0],
      voice: "default",
      target: null,
      features: makeFeatureFlags(),
      contextVars: {},
    });
    board.preparedCategories.add("weather");
    board.preparedCategories.add("music");

    const result = drainBoard(board, "empty", 0);
    expect(Array.isArray(result.preparedCategories)).toBe(true);
    expect(result.preparedCategories).toContain("weather");
    expect(result.preparedCategories).toContain("music");
  });
});
