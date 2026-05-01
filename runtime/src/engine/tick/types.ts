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
import type { ScriptExecutionResult } from "../../core/script-execution.js";

export type { ScriptExecutionResult } from "../../core/script-execution.js";

// ═══════════════════════════════════════════════════════════════════════════
// Affordance 声明
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 工具可见性优先级（discriminated union 判别字段）。
 *
 * - sensor: 基础感知器——压力场/图的必要输入，签名始终可见
 * - core: 核心交互工具——始终可见（send_message, react, search...）
 * - capability: 能力工具——在 shell manual 中扁平可见，可用 `<command> --help` 查详情
 * - on-demand: 按需工具——默认不进 shell manual，只通过明确场景/特性门控暴露
 */
export type AffordancePriority = "sensor" | "core" | "capability" | "on-demand";

/**
 * 工具族类别 — 用于 shell manual 分组、能力元数据和特性门控。
 *
 * sensor/core 工具无需 category（始终可见）。
 * capability 工具必须指定 category，并在 shell manual 中扁平展示。
 * on-demand 工具仅在明确场景/特性门控允许时展示。
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
  // 高级指令族
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
  /** 何时使用此工具（写入 shell manual / legacy category summary，LLM 可读）。 */
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

/** 能力工具 — shell manual 中扁平可见。category 必填，用于分组和 whenToUse 元数据。 */
export interface CapabilityAffordance extends AffordanceBase {
  priority: "capability";
  category: ToolCategory;
}

/** 按需工具 — 仅在明确场景/特性门控允许时展示（moderation, group_admin...）。 */
export interface OnDemandAffordance extends AffordanceBase {
  priority: "on-demand";
  category?: ToolCategory;
}

/**
 * Affordance 声明 — 每个 LLM 可见工具的可发现性元数据（discriminated union）。
 *
 * SAA（Stigmergic Affordance Architecture）可见性分层：
 * 1. sensor/core 工具始终可见
 * 2. capability 工具进入扁平 shell manual，并通过 category 元数据辅助说明
 * 3. on-demand 工具只在明确场景/特性门控允许时展示
 *
 * @see docs/adr/142-action-space-architecture/README.md §Architecture
 * @see docs/adr/216-cli-help-unification.md
 * @see docs/adr/223-flat-tool-visibility.md
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
 * 可变部分（observations/execution/preparedCategories/...）在 tick 步进中累积。
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
  execution: ScriptExecutionResult;
  /** 历史字段：旧 capability 激活记录。普通 prompt 已改为扁平 shell manual。 */
  preparedCategories: Set<ToolCategory>;

  // ── 预算 ──
  budget: TickBudget;
  /** 最近一次 LLM 调用失败分类。只用于反馈弧区分基础设施故障和模型无效输出。 */
  failureKind?: import("./callLLM.js").TickFailureKind;
}

// ═══════════════════════════════════════════════════════════════════════════
// Tick 结果
// ═══════════════════════════════════════════════════════════════════════════

/** host 在同一 tick 内立即续轮的原因。 */
export type IntraTickContinuationReason = "local_observation_followup" | "error_recovery" | "none";

/** ADR-235 + ADR-247: tick 级可观测性元数据。 */
export interface TickTcMeta {
  toolCallCount: number;
  budgetExhausted: boolean;
  afterward: string;
  /** tick 入口选中的 endpoint/provider 名，只用于传输和熔断诊断。 */
  provider?: string;
  /** tick 入口选中的稳定模型 ID；模型轮换和质量诊断以此字段为准。 */
  model?: string;
  /** 聚合的 $ cmd\noutput 块（截断到 4KB）。 */
  commandLog: string;
  /**
   * host 在同一 tick 内触发的续轮原因序列。
   * 只记录真正发生的续轮，不记录 "none"。
   */
  hostContinuationTrace?: IntraTickContinuationReason[];
}

/** tick 循环退出原因。 */
export type TickOutcome =
  | "terminal"
  | "waiting_reply"
  | "watching"
  | "empty"
  | "resting"
  | "fed_up"
  | "cooling_down"
  /** 预留：episode 内续轮预算耗尽。当前实现仍折叠为 terminal。 */
  | "tc_budget_exhausted";

/**
 * tick() 循环的完整输出 — 从 Blackboard drain 的最终结果。
 * 替代旧 SubcycleResult。
 */
export interface TickResult {
  outcome: TickOutcome;
  observations: string[];
  execution: ScriptExecutionResult;
  stepsUsed: number;
  /** 历史字段：旧 capability 激活记录。普通 prompt 已改为扁平 shell manual。 */
  preparedCategories: ToolCategory[];
  duration: number;
  /** ADR-215: LLM 最后一步输出的认知残留（来自 TickStepSchema.residue）。 */
  llmResidue?: import("../../llm/schemas.js").LLMResidue;
  /** episode 内 block 续轮次数（host 触发的额外轮数，如本地 follow-up / 自纠）。 */
  episodeRounds: number;
  /** ADR-235: TC 循环可观测性元数据。 */
  tcMeta?: TickTcMeta;
  /** LLM 调用失败的基础设施/模型边界分类。 */
  failureKind?: import("./callLLM.js").TickFailureKind;
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
