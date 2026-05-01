/**
 * Mod 系统核心类型 — 移植自叙事引擎。
 *
 * 叙事引擎使用 ECS + Mod 架构：
 * - 每个关注点是独立 Mod，声明指令（写）、查询（读）、监听（响应广播）
 * - Dispatcher 路由指令 → 执行 → 广播给所有 listener
 * - Storyteller 从所有 Mod 的 contribute() 收集上下文 → 排序 → 渲染
 *
 * Alice 适配：
 * - WorldGraph → WorldModel（伴侣图）
 * - Turn → Tick（60s 周期）
 * - 保留核心接口：ModDefinition, ModContext, ContributionItem
 * - 简化 HUD（无 GUI，不需要）
 *
 * 参考: narrative-engine/mods/types.ts
 */
import type { z } from "zod";
import type { AffordanceDeclaration } from "../engine/tick/types.js";
import type { WorldModel } from "../graph/world-model.js";
import type { PromptLine } from "./prompt-style.js";

// -- Mod 元数据 ---------------------------------------------------------------

export interface ModMeta {
  /** Mod 唯一标识。 */
  name: string;
  /** 分类：core（核心基础设施）| mechanic（可选机制）。 */
  category: "core" | "mechanic";
  /** 人类可读描述。 */
  description?: string;
  /** 依赖的 Mod 列表（名称）。 */
  depends?: string[];
  /**
   * 话题归属（支持多话题）。用于按意图分组渲染查询函数。
   * 省略时 = 分到 "other" 分组（core 基础设施通常省略）。
   */
  topics?: string[];
}

// -- Mod 上下文 ---------------------------------------------------------------

/** 传入每个 Mod 方法的执行上下文。 */
export interface ModContext<TState = unknown> {
  /** 伴侣图（全局共享，可读写）。 */
  graph: WorldModel;
  /** 当前 Mod 的私有状态（可变引用）。 */
  state: TState;
  /** 当前 tick。 */
  tick: number;
  /** ADR-110: 当前墙钟时间（ms），evolveTick 顶部计算一次，线程到所有子函数。 */
  nowMs: number;
  /** 读取其他 Mod 的状态（只读）。 */
  getModState: <T = unknown>(modName: string) => T | undefined;
  /** 调用其他 Mod 的指令（跨 Mod 协作）。由 Dispatcher 注入。 */
  dispatch: (instruction: string, args: Record<string, unknown>) => unknown;
}

// -- 指令系统 -----------------------------------------------------------------

/** 参数定义。schema 是唯一的类型+必选性真相源。 */
export interface ParamDefinition {
  description: string;
  schema: z.ZodTypeAny;
}

/**
 * 指令定义（写操作，有副作用，触发广播）。
 *
 * 设计继承自叙事引擎（指令名=函数名、params key 顺序=位置参数顺序）。
 * @see narrative-engine/mods/types.ts — InstructionDefinition
 * @see narrative-engine/sandbox/inject.ts — 通用注入循环
 */
export interface InstructionDefinition {
  /**
   * 参数签名。Record 的 key 插入顺序 = LLM 调用时的位置参数顺序。
   * 注入层自动将 `feel("positive", "reason")` 映射为 `{valence: "positive", reason: "reason"}`。
   */
  params: Record<string, ParamDefinition>;
  description: string;
  examples?: string[];
  impl: (ctx: ModContext, args: Record<string, unknown>) => unknown;

  /**
   * 上下文注入：当 LLM 未传某 param 时，从 sandbox contextVars 自动填充。
   * key = param 名, value = 从 contextVars 派生默认值的函数。
   */
  deriveParams?: Record<
    string,
    (contextVars: Record<string, unknown>, args?: Record<string, unknown>) => unknown
  >;

  /**
   * 每轮调用上限。数字 = 独立配额，{ limit, group } = 共享配额。
   * 例: intend 使用 { limit: 2, group: "thread_create" }。
   */
  perTurnCap?: number | { limit: number; group: string };

  /**
   * ADR-142: Affordance 声明 — LLM 可见工具的可发现性元数据。
   * @see docs/adr/142-action-space-architecture/README.md
   */
  affordance?: AffordanceDeclaration;
}

/** 查询定义（读操作，无副作用，不广播）。 */
export interface QueryDefinition {
  params: Record<string, ParamDefinition>;
  description: string;
  /** 返回值的 TypeScript 类型字符串（用于生成 .d.ts 声明）。 */
  returns?: string;
  /** LLM 可读的返回值简述。渲染为 JSDoc @returns。 */
  returnHint?: string;
  impl: (ctx: ModContext, args: Record<string, unknown>) => unknown;
  /** 上下文注入：当 LLM 未传某 param 时，从 sandbox contextVars 自动注入。 */
  deriveParams?: Record<
    string,
    (contextVars: Record<string, unknown>, args?: Record<string, unknown>) => unknown
  >;
  /**
   * 将 impl 返回值格式化为 LLM 可读文本。
   * 省略时 fallback 到 JSON.stringify。
   */
  format?: (result: unknown) => string[];

  /**
   * ADR-142: Affordance 声明 — LLM 可见查询的可发现性元数据。
   * @see docs/adr/142-action-space-architecture/README.md
   */
  affordance?: AffordanceDeclaration;
}

/** 监听处理器（响应其他 Mod 的指令广播）。 */
export type ListenHandler = (
  ctx: ModContext,
  args: Record<string, unknown>,
  result: unknown,
) => void;

// -- 贡献系统（Storyteller 上下文组装）----------------------------------------

/** 贡献桶类型（对应 LLM prompt 的区域）。 */
export type BucketType = "header" | "section" | "footer";

/**
 * 单条贡献项。
 * Storyteller 收集所有 Mod 的贡献 → 按 bucket/order/priority 排序 → 渲染成 prompt。
 *
 * ⚠ 诚实性原则：lines 中的文本是 Alice 的内心世界。她不知道引擎的存在。
 * 禁止系统术语（tick/voice/pressure/mod）、原始数值（百分比/计数/ID）、
 * 元指令（"Decide what to do"）。只写观察事实和人类化的语义标签。
 * @see docs/adr/209-tui-native-prompt.md — 诚实性原则
 */
export interface ContributionItem {
  /** 属于哪个大类（header 最先，section 中间，footer 最后）。 */
  bucket: BucketType;
  /** 分组 key（同 bucket 内同 key 的项合并）。 */
  key?: string;
  /** 组标题（同 (bucket, key) 内第一个带 title 的生效）。 */
  title?: string;
  /** 组间排序（数值越小越靠前，默认 50）。 */
  order?: number;
  /** 组内优先级（数值越高越重要，默认 50）。 */
  priority?: number;
  /** 贡献内容行（必须经由 PromptBuilder 产出）。 */
  lines: PromptLine[];
}

// -- Mod 定义 -----------------------------------------------------------------

/**
 * Mod 定义接口 — Alice 版。
 *
 * 每个 Mod 实现此接口，声明：
 * - meta: 元数据（名称、分类、依赖）
 * - initialState: 初始私有状态
 * - instructions: 写操作（指令名 = LLM 函数名，触发广播）
 * - queries: 读操作（不广播）
 * - listen: 监听其他 Mod 的指令
 * - contribute: 为 Storyteller 贡献 LLM 上下文
 * - onTickStart / onTickEnd: 生命周期钩子
 */
export interface ModDefinition<TState = unknown> {
  meta: ModMeta;
  initialState: TState;

  /** 写操作（指令名 = LLM 函数名），有副作用，触发广播。 */
  instructions?: Record<string, InstructionDefinition>;

  /** 读操作，无副作用。 */
  queries?: Record<string, QueryDefinition>;

  /** 监听其他 Mod 的指令广播。key = 指令名。 */
  listen?: Record<string, ListenHandler>;

  /** Tick 开始时调用（清空临时状态等）。 */
  onTickStart?: (ctx: ModContext<TState>) => void;

  /** Tick 结束时调用（计算汇总、被动效果等）。 */
  onTickEnd?: (ctx: ModContext<TState>) => void;

  /** 意识流事件钩子（可选）。未来 C2 元认知的入口点。
   * @see docs/adr/204-consciousness-stream/ */
  onEvent?: (
    ctx: ModContext<TState>,
    event: { kind: string; entityIds: string[]; summary: string; salience: number },
  ) => void;

  /**
   * 为 Storyteller 贡献 LLM 上下文。
   * 返回 ContributionItem[]，由 Storyteller 排序渲染。
   */
  contribute?: (ctx: ModContext<TState>) => ContributionItem[];
}

// -- 跨 Mod 类型安全访问器 ---------------------------------------------------

/**
 * Mod 状态类型注册表 — 每个 Mod 只暴露允许跨 Mod 读取的公共部分。
 * 单一入口的受控 `as` 断言，调用站点零 `as`。
 */
export interface ModStateRegistry {
  relationships: { targetNodeId: string | null };
  observer: {
    outcomeHistory: Array<{ target: string; quality: number; reason: string; tick: number }>;
    impressionCounts?: Record<string, number>;
  };
  pressure: {
    latest: {
      P1: number;
      P2: number;
      P3: number;
      P4: number;
      P5: number;
      P6: number;
      API: number;
    } | null;
  };
  soul: { activeVoice: string | null };
}

/**
 * 类型安全的跨 Mod 状态读取。
 * 内部有一处受控 `as`（泛型参数传递），但所有调用站点零 `as`。
 */
export function readModState<K extends keyof ModStateRegistry>(
  ctx: ModContext,
  modName: K,
): ModStateRegistry[K] | undefined {
  return ctx.getModState<ModStateRegistry[K]>(modName);
}

/**
 * 安全读取 pressure mod 的当前 API 值。
 * 基于 readModState，零手动断言。
 * @see docs/adr/81-reflection-separation.md §Mod 贡献从声部门控改为压力门控
 */
export function readPressureApi(ctx: ModContext): number {
  const state = readModState(ctx, "pressure");
  return state?.latest?.API ?? 0;
}

// -- 贡献工厂函数（便捷 API）--------------------------------------------------

export function header(
  lines: PromptLine | PromptLine[],
  priority = 50,
  key?: string,
): ContributionItem {
  return {
    bucket: "header",
    key,
    priority,
    lines: Array.isArray(lines) ? lines : [lines],
  };
}

export function section(
  key: string,
  lines: PromptLine[],
  title?: string,
  order = 50,
  priority = 50,
): ContributionItem {
  return { bucket: "section", key, title, order, priority, lines };
}

export function footer(lines: PromptLine | PromptLine[], priority = 50): ContributionItem {
  return {
    bucket: "footer",
    priority,
    lines: Array.isArray(lines) ? lines : [lines],
  };
}
