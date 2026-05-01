/**
 * ADR-136: Model Eval Suite — 核心类型定义。
 *
 * 两层评估框架：
 * - Layer 1 (Structural): 代码判定分支/函数调用模式 — 确定性、快速
 * - Layer 2 (Quality): LLM-as-Judge 多维度行为质量 — 非确定性、深度
 *
 * 类型设计原则：
 * - 输入类型（EvalScenario 等）全 readonly — 场景定义不可变
 * - 输出类型（Check, GradeResult 等）全 readonly — 结果产出后不可变
 * - 配置类型（EvalRunnerConfig）保持可变 — 运行时需要合并/覆盖
 * - 重复结构提取为命名类型 — 单一真理源
 *
 * @see docs/adr/136-model-eval-suite.md
 */
import type { ToolCategory } from "../engine/tick/types.js";

/**
 * Eval 场景功能开关。
 * Shell prompt feature flags + API availability toggles.
 */
export interface EvalFeatures {
  hasTarget?: boolean;
  isGroup?: boolean;
  hasBots?: boolean;
  targetIsBot?: boolean;
  hasTTS?: boolean;
  hasSystemThreads?: boolean;
  hasPeripheral?: boolean;
  preparedCategories?: ReadonlySet<string>;
  facetTags?: readonly string[];
  /** 启用浏览器/搜索 API (→ exaApiKey) */
  hasBrowse?: boolean;
  /** 启用音乐 API (→ musicApiBaseUrl) */
  hasMusic?: boolean;
  /** 启用视频 API (→ youtubeApiKey) */
  hasVideo?: boolean;
}

// ── ADR-137: 消融实验条件 ──────────────────────────────────────────────
/**
 * 三条件消融：Full / No-Pressure / Baseline。
 *
 * - full: 当前系统（situation lines + voice instinct + gold examples）
 * - no_pressure: 保留 gold examples，移除 situation lines + voice instinct
 * - baseline: 3 条 airi 风格规则，无 gold examples，无 situation lines
 *
 * @see docs/adr/137-pressure-field-ablation.md
 */
export type AblationCondition = "full" | "no_pressure" | "baseline";

// ── 场景标签 ─────────────────────────────────────────────────────────────

export type ScenarioTag =
  | "private"
  | "group"
  | "empathy"
  | "restraint"
  | "memory"
  | "context"
  | "turn_taking"
  | "observation"
  | "sticker"
  | "app"
  | "calendar"
  | "weather"
  | "browser"
  | "trending"
  | "music"
  | "video"
  | "countdown"
  | "p5_high"
  | "patience"
  | "baseline"
  | "ablation"
  | "proactive"
  | "boundary";

// ── 共享原子类型 ──────────────────────────────────────────────────────────

/** 六维压力快照（对象形式，用于场景定义）。 */
export interface PressureValues {
  readonly p1: number;
  readonly p2: number;
  readonly p3: number;
  readonly p4: number;
  readonly p5: number;
  readonly p6: number;
}

/** 聚合统计三元组（pass / total / rate），用于按标签/分支汇总。 */
export interface AggregatedStat {
  pass: number;
  total: number;
  rate: number;
}

// ── 评估消息 ─────────────────────────────────────────────────────────────

/** eval 场景中的一条消息。所有字段定义后不可变。 */
export interface EvalMessage {
  /** 发送者角色："user" = 对话目标，"other" = 群里其他人，"alice" = Alice 自己（历史消息） */
  readonly role: "user" | "other" | "alice";
  /** 发送者显示名（群聊用） */
  readonly name?: string;
  /** 消息文本 */
  readonly text: string;
  /** 消息 ID（用于 replyTo 断言） */
  readonly msgId?: number;
  /** 是否 directed at Alice */
  readonly directed?: boolean;
  /** 媒体标签（如 "(photo)", "(sticker: 😂)"） */
  readonly mediaLabel?: string;
}

// ── 结构性断言 ────────────────────────────────────────────────────────────

/** 期望的 ReAct 分支类型。 */
export type ExpectedBranch =
  | "reply"
  | "silence"
  | "observe_then_reply"
  | "observe_then_silence"
  | "waiting_reply"
  | "watching"
  | "action_only";

/**
 * 社交意图 — 分支分类的第一性原理层。
 *
 * 9 个分支编码了两个独立维度：Intent × Process。
 * Intent 是 outcome（该做什么），Process 是 path（怎么获取信息）。
 * 评分以 Intent 为主轴，Process 为可选约束。
 *
 * - engage: 参与对话（reply / observe_then_reply / action_only）
 * - silence: 主动沉默（silence / observe_then_silence）
 * - defer: 暂缓回应（expect_reply / stay）
 *
 * @see docs/adr/138-social-intent-truth-model.md
 */
export type SocialIntent = "engage" | "silence" | "defer";

/** Layer 1: 结构性断言 — 代码可判定的行为模式。 */
export interface StructuralAssertions {
  /**
   * 期望的社交意图（primary check）。
   *
   * 单值 = 硬约束（必须是这个意图）。
   * 数组 = 可接受集（任一均可，涌现友好）。
   *
   * 设计原则：社交场景往往没有唯一正确反应。
   * 用可接受集而非单值来测试——测关键路径，不锁定涌现。
   *
   * @see docs/adr/138-social-intent-truth-model.md
   */
  readonly expectedIntent: SocialIntent | readonly SocialIntent[];

  /**
   * 期望的精确分支（secondary check，可选）。
   *
   * 仅在需要严格过程匹配时使用（如 App 必须 observe）。
   * 省略时只检查 Intent。
   */
  readonly expectedBranch?: ExpectedBranch;

  /** 期望的 ReAct 轮数（process tier，仅诊断）。number = 精确，[min, max] = 范围。 */
  readonly expectedRounds?: number | readonly [min: number, max: number];

  /** 步数上限（含）。超出判定为 budget 失败。省略时不检查步数。 */
  readonly maxSteps?: number;

  /** 函数调用断言 */
  readonly actions?: {
    /** 必须调用的函数 */
    readonly must?: readonly string[];
    /** 禁止调用的函数 */
    readonly must_not?: readonly string[];
    /** 至少调用其中一个 */
    readonly any_of?: readonly string[];
  };

  /** Mod 指令断言 */
  readonly instructions?: {
    readonly must?: readonly string[];
    readonly must_not?: readonly string[];
  };

  /** observe 轮次应执行的查询 */
  readonly queries?: {
    readonly must?: readonly string[];
  };

  /** reply 方向性（群聊：true = reply(text, msgId)，false = say(text)） */
  readonly replyDirected?: boolean;

  /** 期望 LLM 使用的工具族。历史字段名保留，实际发现机制为 shell manual + `<command> --help`。 */
  readonly expectedNeeds?: readonly ToolCategory[];
}

// ── 质量评估 Rubric ──────────────────────────────────────────────────────

/** Layer 2 评估维度。 */
export type QualityDimension =
  | "companionship"
  | "emotional_fit"
  | "personality"
  | "boundary"
  | "initiative"
  | "naturalness";

/** Layer 2: 质量评估配置。 */
export interface QualityRubric {
  /** 评估维度列表 */
  readonly dimensions: readonly QualityDimension[];
  /** 合格阈值（维度均分），默认 3.0 */
  readonly passThreshold?: number;
}

// ── 完整场景 ─────────────────────────────────────────────────────────────

/** eval 场景完整定义。 */
export interface EvalScenario {
  /** 唯一标识（如 "branch.reply.direct"） */
  readonly id: string;

  /** 人类可读的场景描述 */
  readonly title: string;

  /** 分类标签 */
  readonly tags: readonly ScenarioTag[];

  // ── 输入 ──

  /** 对话消息 timeline */
  readonly messages: readonly EvalMessage[];

  /** 目标信息 */
  readonly target: {
    readonly contactId: string;
    readonly displayName: string;
    readonly tier: number;
    readonly relationType: string;
  };

  /** 聊天类型 */
  readonly chatType: "private" | "group";

  /** 功能开关（shell prompt 场景特征 + API 可用性） */
  readonly features: EvalFeatures;

  /** 压力快照（可选） */
  readonly pressures?: PressureValues;

  /** 额外上下文变量覆盖 */
  readonly contextOverrides?: Readonly<Record<string, string>>;

  // ── Layer 1 ──

  /** 结构性断言 */
  readonly structural: StructuralAssertions;

  // ── Layer 2（可选） ──

  /** 质量评估配置 */
  readonly quality?: QualityRubric;

  /** 论文映射（如 "Table5.B1", "ADR-63.V1"） */
  readonly paperRef?: string;
}

// ── 评分结果 ─────────────────────────────────────────────────────────────

/** 检查层级。goal/budget 影响 pass/fail，process 仅诊断。 */
export type CheckTier = "goal" | "budget" | "process";

/** 单项检查结果。 */
export interface Check {
  readonly name: string;
  readonly pass: boolean;
  readonly expected: string;
  readonly actual: string;
  /** 检查层级。goal/budget 影响 pass/fail，process 仅供调试参考。 */
  readonly tier: CheckTier;
}

/** Layer 1 评分结果。 */
export interface StructuralGradeResult {
  readonly pass: boolean;
  readonly checks: readonly Check[];
  /** 通过比例 0-1 */
  readonly score: number;
}

/** Layer 2 单维度评分。 */
export interface DimensionScore {
  readonly dimension: QualityDimension;
  readonly score: number; // 1-5
  readonly reasoning: string;
}

/** Layer 2 评分结果。 */
export interface QualityGradeResult {
  readonly dimensions: readonly DimensionScore[];
  readonly overall: number;
  readonly pass: boolean;
}

/** 单个场景单次运行的完整结果。 */
export interface EvalRunResult {
  readonly scenarioId: string;
  readonly runIndex: number;
  /** 原始 LLM 输出 script */
  readonly script: string | null;
  /** Tick 步数（原 rounds） */
  readonly steps: number;
  /** Layer 1 评分 */
  readonly structural: StructuralGradeResult;
  /** Layer 2 评分（可选） */
  readonly quality?: QualityGradeResult;
  /** 耗时 (ms) */
  readonly duration: number;
  /** 错误信息 */
  readonly errors: readonly string[];
  /** 历史字段：旧 capability 激活类别（累积 union）。普通 prompt 已改为扁平 shell manual。 */
  readonly needs?: readonly string[];
}

/** 单个场景多次运行的聚合结果。 */
export interface ScenarioAggregateResult {
  readonly scenarioId: string;
  readonly title: string;
  readonly tags: readonly ScenarioTag[];
  readonly expectedIntent: SocialIntent | readonly SocialIntent[];
  readonly expectedBranch?: ExpectedBranch;
  readonly runs: readonly EvalRunResult[];
  /** pass@k: k 次运行中至少 1 次 Layer 1 通过 */
  readonly passAtK: boolean;
  /** pass^k: k 次运行全部 Layer 1 通过 */
  readonly passAllK: boolean;
  /** Layer 1 通过率 */
  readonly passRate: number;
  /** Layer 2 维度均分（如有） */
  readonly qualityMeans?: Readonly<Record<QualityDimension, number>>;
  /** 是否从缓存跳过（未实际运行 LLM）。 */
  readonly cached?: boolean;
}

/** 完整评估报告。 */
export interface EvalReport {
  /** 模型标识 */
  readonly model: string;
  /** 评估时间 */
  readonly timestamp: string;
  /** 场景总数 */
  readonly totalScenarios: number;
  /** 每场景运行次数 */
  readonly runsPerScenario: number;
  /** 各场景聚合结果 */
  readonly scenarios: readonly ScenarioAggregateResult[];
  /** 按标签聚合的通过率 */
  readonly tagStats: Record<string, AggregatedStat>;
  /** 按社交意图聚合的通过率（ADR-138） */
  readonly intentStats: Record<string, AggregatedStat>;
  /** Layer 2 全局维度均分 + CI（如有） */
  readonly qualityStats?: Readonly<
    Record<QualityDimension, { mean: number; ci95: readonly [number, number] }>
  >;
}

// ── Runner 配置 ──────────────────────────────────────────────────────────

/** eval runner 配置。 */
export interface EvalRunnerConfig {
  /** 每场景运行次数（默认 1） */
  runs: number;
  /** LLM temperature 覆盖（默认 0） */
  temperature: number;
  /** 是否运行 Layer 2（默认 false） */
  includeQuality: boolean;
  /** 场景过滤（按 tag） */
  filterTags?: readonly ScenarioTag[];
  /** 场景过滤（按 ID 前缀） */
  filterPrefix?: string;
  /** 单次 LLM 调用超时 (ms) */
  timeout: number;
  /** LLM provider 名称（可选，用于报告） */
  providerName?: string;
}

export const DEFAULT_EVAL_CONFIG = {
  runs: 1,
  temperature: 0,
  includeQuality: false,
  timeout: 180_000,
} as const satisfies EvalRunnerConfig;
