/**
 * Blackboard Tick + Stigmergic Affordance Architecture 类型定义。
 *
 * 核心概念：
 * - AffordanceDeclaration: 每个 LLM 可见工具的可发现性元数据
 * - Blackboard: tick 循环的共享状态黑板（读写分离）
 * - TickResult: tick() 循环的完整输出
 * - UnifiedTool: Telegram action 和 Mod instruction/query 的统一视图
 *
 * @see docs/adr/142-action-space-architecture/README.md
 */

// Re-export sandbox types for tick pipeline consumers
export type { ScriptExecutionResult } from "../../core/script-execution.js";

// ═══════════════════════════════════════════════════════════════════════════
// Affordance 声明
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 工具可见性优先级（discriminated union 判别字段）。
 *
 * - sensor: 基础感知器——压力场/图的必要输入，签名始终可见
 * - core: 核心交互工具——始终可见（send_message, react, search...）
 * - capability: 能力工具——通过 man <category> 激活后可见
 * - on-demand: 按需工具——仅通过 man <category> 激活后可见
 */
export type AffordancePriority = "sensor" | "core" | "capability" | "on-demand";

/**
 * 工具族类别 — LLM 通过 man <category> 激活的工具族标签。
 *
 * sensor/core 工具无需 category（始终可见）。
 * capability 工具必须指定 category，通过 man <category> 激活后可见。
 * on-demand 工具仅通过 man <category> 激活后可见。
 */
export type ToolCategory =
  // App 工具
  | "weather"
  | "music"
  | "video"
  | "news"
  | "trending"
  | "calendar"
  | "timer"
  | "browser"
  | "fun"
  // 知识查询
  | "contact_info"
  | "chat_history"
  | "reminders"
  // 创作/表达
  | "sticker"
  | "media"
  // 内省/记忆
  | "diary"
  | "scheduler"
  // 管理
  | "moderation"
  | "group_admin"
  | "account"
  // 高级指令（通过 man <category> 激活）
  | "social"
  | "threads"
  | "mood"
  | "memory"
  | "skills";

/**
 * ToolCategory 全量列表（运行时枚举验证用）。
 * 改为 mutable 数组——Skill 包可注册新 category。
 * @see src/skills/hot-loader.ts registerToolCategory()
 */
export const TOOL_CATEGORIES: string[] = [
  "weather",
  "music",
  "video",
  "news",
  "trending",
  "calendar",
  "timer",
  "browser",
  "fun",
  "contact_info",
  "chat_history",
  "reminders",
  "sticker",
  "media",
  "diary",
  "scheduler",
  "moderation",
  "group_admin",
  "account",
  "social",
  "threads",
  "mood",
  "memory",
  "skills",
];

/** 运行时注册新 ToolCategory（Skill 包热加载时调用）。 */
export function registerToolCategory(category: string): void {
  if (!TOOL_CATEGORIES.includes(category)) {
    TOOL_CATEGORIES.push(category);
  }
}

/** 运行时注销 ToolCategory。 */
export function unregisterToolCategory(category: string): void {
  const idx = TOOL_CATEGORIES.indexOf(category);
  if (idx >= 0) TOOL_CATEGORIES.splice(idx, 1);
}

/**
 * Affordance 声明基础字段 — 所有 priority 变体共享。
 */
interface AffordanceBase {
  /** 何时使用此工具（写入 Capability Guide，LLM 可读）。 */
  whenToUse: string;
  /** 何时不使用此工具。 */
  whenNotToUse: string;
  /**
   * 硬门禁 — 需要的 FeatureFlags key。
   * 特性未启用时工具完全不可见（即使 LLM 请求了对应 category）。
   */
  requires?: keyof FeatureFlags;
}

/** 基础感知器 — 压力场/图的必要输入，签名始终可见。 */
export interface SensorAffordance extends AffordanceBase {
  priority: "sensor";
}

/** 核心交互工具 — 始终可见（send_message, react, search...）。 */
export interface CoreAffordance extends AffordanceBase {
  priority: "core";
}

/** 能力工具 — 通过 man <category> 激活后可见。category 必填。 */
export interface CapabilityAffordance extends AffordanceBase {
  priority: "capability";
  category: ToolCategory;
}

/** 按需工具 — 仅通过 man <category> 激活后可见（moderation, group_admin...）。 */
export interface OnDemandAffordance extends AffordanceBase {
  priority: "on-demand";
  category?: ToolCategory;
}

/**
 * Affordance 声明 — 每个 LLM 可见工具的可发现性元数据（discriminated union）。
 *
 * SAA（Stigmergic Affordance Architecture）两层过滤：
 * 1. sensor/core 工具始终可见
 * 2. capability 工具由 man <category> 激活
 * 3. on-demand 工具仅通过 man <category> 激活后可见
 *
 * @see docs/adr/142-action-space-architecture/README.md §Architecture
 */
export type AffordanceDeclaration =
  | SensorAffordance
  | CoreAffordance
  | CapabilityAffordance
  | OnDemandAffordance;

// ═══════════════════════════════════════════════════════════════════════════
// Feature Flags
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 运行时特性标志 — 从配置 + 环境推导。
 * 用于 affordance hardgate：特性未启用时相关工具不可见。
 */
export interface FeatureFlags {
  hasWeather: boolean;
  hasMusic: boolean;
  hasBrowser: boolean;
  hasTTS: boolean;
  hasStickers: boolean;
  hasBots: boolean;
  hasSystemThreads: boolean;
  hasVideo: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Blackboard
// ═══════════════════════════════════════════════════════════════════════════

/** 预算约束。 */
export interface TickBudget {
  maxSteps: number;
  usedSteps: number;
}

/**
 * Blackboard — tick 循环的共享状态黑板。
 *
 * 每次 engagement 创建一个 Blackboard，tick 循环内读写。
 * 不可变部分（pressures/voice/target/features）为创建时设置的初始值。
 * 可变部分（observations/errors/preparedCategories/...）在 tick 步进中累积。
 */
export interface Blackboard {
  // ── 不可变初始值 ──
  readonly pressures: readonly [number, number, number, number, number, number];
  readonly voice: string;
  readonly target: string | null;
  readonly features: Readonly<FeatureFlags>;
  readonly contextVars: Readonly<Record<string, unknown>>;

  // ── 可变累积（tick 步进中更新）──
  observations: string[];
  errors: string[];
  preparedCategories: Set<ToolCategory>;
  thinks: string[];
  queryLogs: Array<{ fn: string; result: string }>;

  // ── 预算 ──
  budget: TickBudget;
}

// ═══════════════════════════════════════════════════════════════════════════
// Tick 结果
// ═══════════════════════════════════════════════════════════════════════════

/** tick 循环退出原因。 */
export type TickOutcome =
  | "terminal"
  | "waiting_reply"
  | "watching"
  | "empty"
  | "fed_up"
  | "cooling_down"
  /** ADR-232: episode 内 TC 续轮预算耗尽（maxSteps 内 watching 消耗完）。 */
  | "tc_budget_exhausted";

/**
 * tick() 循环的完整输出 — 从 Blackboard drain 的最终结果。
 * 替代旧 SubcycleResult。
 */
export interface TickResult {
  outcome: TickOutcome;
  thinks: string[];
  queryLogs: Array<{ fn: string; result: string }>;
  observations: string[];
  errors: string[];
  instructionErrors: string[];
  stepsUsed: number;
  preparedCategories: ToolCategory[];
  duration: number;
  /** ADR-215: LLM 最后一步输出的认知残留（来自 TickStepSchema.residue）。 */
  llmResidue?: import("../../llm/schemas.js").LLMResidue;
  /** @deprecated ADR-233: TC 循环已接管续轮，episodeRounds 不再使用，保留为 0 */
  episodeRounds: number;
  /** ADR-235: TC 循环可观测性元数据。 */
  tcMeta?: {
    toolCallCount: number;
    budgetExhausted: boolean;
    afterward: string;
    /** 聚合的 $ cmd\noutput 块（截断到 4KB）。 */
    commandLog: string;
  };
}

/**
 * 单步 LLM 输出 — TickStepSchema 解析后的结构。
 * 从 Zod schema 推导，保证类型与 schema 一致。
 */
export type { TickStep as TickStepOutput } from "../../llm/schemas.js";

// ═══════════════════════════════════════════════════════════════════════════
// 统一工具视图
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 统一工具接口 — 将 Telegram action 和 Mod instruction/query 抹平到同一视图。
 */
export interface UnifiedTool {
  /** 工具名称（= 沙箱函数名）。 */
  name: string;
  /** affordance 声明（必须存在——只有声明了 affordance 的工具才能进入统一视图）。 */
  affordance: AffordanceDeclaration;
}

/**
 * 类型工具函数 — 断言工具具有 affordance 声明。
 * 将可选 affordance 的工具安全窄化到 AffordanceDeclaration。
 */
export function hasAffordance<T extends { affordance?: AffordanceDeclaration }>(
  tool: T,
): tool is T & { affordance: AffordanceDeclaration } {
  return tool.affordance != null;
}
