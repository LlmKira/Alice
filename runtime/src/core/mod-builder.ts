/**
 * createMod Builder — 扁平化 Mod 定义 API。
 *
 * 用 `createMod<S>()` scoped builder 替代 `defineMod<S>()` 嵌套对象树，
 * 获得 Zod 类型推断 + 扁平链式声明。
 *
 * 用法:
 * ```typescript
 * export const diaryMod = createMod<DiaryState>("diary", {
 *   category: "mechanic",
 *   description: "...",
 *   topics: ["diary"],
 *   initialState: { turnWriteCount: 0 },
 * })
 *   .instruction("diary", {
 *     params: z.object({
 *       content: z.string().trim().min(1).max(200).describe("日记内容"),
 *     }),
 *     description: "写一条私人日记",
 *     impl(ctx, args) {
 *       // args.content: string ← 自动推断
 *     },
 *   })
 *   .contribute((ctx) => [...])
 *   .build();
 * ```
 *
 * @see docs/adr/ACTIVE.md — createMod Builder ADR
 */
import type { z } from "zod";
import type { AffordanceDeclaration } from "../engine/tick/types.js";
import type {
  ContributionItem,
  InstructionDefinition,
  ListenHandler,
  ModContext,
  ModDefinition,
  ModMeta,
  ParamDefinition,
  QueryDefinition,
} from "./types.js";

// ── Zod → ParamDefinition 转换 ──────────────────────────────────────────────

/**
 * 从 Zod schema 提取 .describe() 描述。
 * 支持 unwrap: z.string().describe("x").optional() 的 describe 在内层。
 */
export function extractDescription(schema: z.ZodTypeAny): string {
  if (schema.description) return schema.description;
  const typeName = (schema._def as { typeName?: string }).typeName;
  if (typeName === "ZodOptional")
    return extractDescription((schema as z.ZodOptional<z.ZodTypeAny>).unwrap());
  if (typeName === "ZodDefault")
    return extractDescription((schema as z.ZodDefault<z.ZodTypeAny>).removeDefault());
  if (typeName === "ZodNullable")
    return extractDescription((schema as z.ZodNullable<z.ZodTypeAny>).unwrap());
  if (typeName === "ZodEffects")
    return extractDescription((schema._def as { schema: z.ZodTypeAny }).schema);
  return "";
}

/** z.object shape → Record<string, ParamDefinition>。 */
export function zodToParamDefs(shape: z.ZodRawShape): Record<string, ParamDefinition> {
  const result: Record<string, ParamDefinition> = {};
  for (const [key, schema] of Object.entries(shape)) {
    result[key] = { description: extractDescription(schema), schema };
  }
  return result;
}

// ── Builder 配置类型 ─────────────────────────────────────────────────────────

interface CreateModConfig<S> {
  category: ModMeta["category"];
  description?: string;
  depends?: string[];
  topics?: string[];
  initialState: S;
}

interface InstructionConfig<S, T extends z.ZodRawShape> {
  params: z.ZodObject<T>;
  description: string;
  examples?: string[];
  deriveParams?: Record<
    string,
    (contextVars: Record<string, unknown>, args?: Record<string, unknown>) => unknown
  >;
  perTurnCap?: number | { limit: number; group: string };
  affordance?: AffordanceDeclaration;
  impl: (ctx: ModContext<S>, args: z.output<z.ZodObject<T>>) => unknown;
}

interface QueryConfig<S, T extends z.ZodRawShape> {
  params: z.ZodObject<T>;
  description: string;
  returns?: string;
  /** LLM 可读的返回值简述。渲染为 JSDoc @returns。 */
  returnHint?: string;
  deriveParams?: Record<
    string,
    (contextVars: Record<string, unknown>, args?: Record<string, unknown>) => unknown
  >;
  affordance?: AffordanceDeclaration;
  format?: (result: unknown) => string[];
  impl: (ctx: ModContext<S>, args: z.output<z.ZodObject<T>>) => unknown;
}

// ── Builder 类 ───────────────────────────────────────────────────────────────

class ModBuilder<S> {
  private readonly _meta: ModMeta;
  private readonly _initialState: S;
  private readonly _instructions: Record<string, InstructionDefinition> = {};
  private readonly _queries: Record<string, QueryDefinition> = {};
  private readonly _listen: Record<string, ListenHandler> = {};
  private _contribute?: (ctx: ModContext<S>) => ContributionItem[];
  private _onTickStart?: (ctx: ModContext<S>) => void;
  private _onTickEnd?: (ctx: ModContext<S>) => void;
  private _onEvent?: (
    ctx: ModContext<S>,
    event: { kind: string; entityIds: string[]; summary: string; salience: number },
  ) => void;

  constructor(name: string, config: CreateModConfig<S>) {
    this._meta = {
      name,
      category: config.category,
      description: config.description,
      depends: config.depends,
      topics: config.topics,
    };
    this._initialState = config.initialState;
  }

  instruction<T extends z.ZodRawShape>(name: string, config: InstructionConfig<S, T>): this {
    this._instructions[name] = {
      params: zodToParamDefs(config.params.shape),
      description: config.description,
      examples: config.examples,
      deriveParams: config.deriveParams,
      perTurnCap: config.perTurnCap,
      affordance: config.affordance,
      impl: config.impl as InstructionDefinition["impl"],
    };
    return this;
  }

  query<T extends z.ZodRawShape>(name: string, config: QueryConfig<S, T>): this {
    this._queries[name] = {
      params: zodToParamDefs(config.params.shape),
      description: config.description,
      returns: config.returns,
      returnHint: config.returnHint,
      deriveParams: config.deriveParams,
      affordance: config.affordance,
      format: config.format,
      impl: config.impl as QueryDefinition["impl"],
    };
    return this;
  }

  listen(
    instruction: string,
    handler: (ctx: ModContext<S>, args: Record<string, unknown>, result: unknown) => void,
  ): this {
    this._listen[instruction] = handler as ListenHandler;
    return this;
  }

  contribute(fn: (ctx: ModContext<S>) => ContributionItem[]): this {
    this._contribute = fn;
    return this;
  }

  onTickStart(fn: (ctx: ModContext<S>) => void): this {
    this._onTickStart = fn;
    return this;
  }

  onTickEnd(fn: (ctx: ModContext<S>) => void): this {
    this._onTickEnd = fn;
    return this;
  }

  /** 意识流事件钩子（C2 元认知入口点）。Wave 4 预留，暂不接线。 */
  onEvent(
    handler: (
      ctx: ModContext<S>,
      event: { kind: string; entityIds: string[]; summary: string; salience: number },
    ) => void,
  ): this {
    this._onEvent = handler;
    return this;
  }

  build(): ModDefinition {
    return {
      meta: this._meta,
      initialState: this._initialState,
      instructions: Object.keys(this._instructions).length > 0 ? this._instructions : undefined,
      queries: Object.keys(this._queries).length > 0 ? this._queries : undefined,
      listen: Object.keys(this._listen).length > 0 ? this._listen : undefined,
      onTickStart: this._onTickStart as ModDefinition["onTickStart"],
      onTickEnd: this._onTickEnd as ModDefinition["onTickEnd"],
      onEvent: this._onEvent as ModDefinition["onEvent"],
      contribute: this._contribute as ModDefinition["contribute"],
    } as ModDefinition;
  }
}

// ── 公开 API ─────────────────────────────────────────────────────────────────

export function createMod<S>(name: string, config: CreateModConfig<S>): ModBuilder<S> {
  return new ModBuilder(name, config);
}
