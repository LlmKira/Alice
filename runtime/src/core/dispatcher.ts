/**
 * 指令 Dispatcher — 移植自叙事引擎 core/dispatcher.ts。
 *
 * 核心职责：
 * 1. dispatch(instruction, args) — 找到拥有者 Mod → 执行 → 广播给所有 listener
 * 2. query(name, args) — 找到拥有者 Mod → 执行（不广播）
 * 3. tick 生命周期管理（startTick / endTick）
 * 4. collectContributions — 收集所有 Mod 的 contribute 结果
 *
 * 参考: narrative-engine/core/dispatcher.ts
 */
import { getDb, getSqlite } from "../db/connection.js";
import { modStates as modStatesTable } from "../db/schema.js";
import type { WorldModel } from "../graph/world-model.js";
import { createLogger } from "../utils/logger.js";
import { generateShellManual } from "./shell-manual.js";
import type {
  ContributionItem,
  InstructionDefinition,
  ModContext,
  ModDefinition,
  ParamDefinition,
  QueryDefinition,
} from "./types.js";

const log = createLogger("dispatcher");

/**
 * ADR-79 M3: 深度合并 Mod 状态 — initialState 提供新字段默认值，persisted 覆盖已有字段。
 *
 * 规则：
 * - 两边都是 plain object → 递归合并
 * - 数组 → 以 persisted 为准（不合并数组元素）
 * - 其他 → persisted 覆盖 initial
 * - persisted 中不存在的 key → 保留 initial 的默认值
 */
export function deepMergeModState(initial: unknown, persisted: unknown): unknown {
  if (!isPlainObject(initial) || !isPlainObject(persisted)) {
    return persisted;
  }
  const merged: Record<string, unknown> = {};
  // 从 initial 获取所有默认 key
  for (const key of Object.keys(initial)) {
    if (key in persisted) {
      const initVal = initial[key];
      const persVal = persisted[key];
      if (isPlainObject(initVal) && isPlainObject(persVal)) {
        merged[key] = deepMergeModState(initVal, persVal);
      } else {
        merged[key] = persVal;
      }
    } else {
      // persisted 中不存在 → 保留 initial 默认值（新字段迁移）
      merged[key] = structuredClone(initial[key]);
    }
  }
  // persisted 中存在但 initial 中不存在的 key 也保留（向前兼容）
  for (const key of Object.keys(persisted)) {
    if (!(key in initial)) {
      merged[key] = structuredClone(persisted[key]);
    }
  }
  return merged;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// -- Dispatcher 接口 ----------------------------------------------------------

export interface Dispatcher {
  /** 执行写指令 → 广播。 */
  dispatch: (instruction: string, args: Record<string, unknown>) => unknown;
  /** 执行只读查询。 */
  query: (name: string, args: Record<string, unknown>) => unknown;
  /** 所有已注册的指令名。 */
  getInstructionNames: () => string[];
  /** 读取指令定义（sandbox 通用注入循环使用）。 */
  getInstructionDef: (name: string) => InstructionDefinition | undefined;
  /** 所有已注册的查询名。 */
  getQueryNames: () => string[];
  /** 读取查询定义（sandbox 查询注入管线使用）。 */
  getQueryDef: (name: string) => QueryDefinition | undefined;
  /** Tick 开始。ADR-110: nowMs 线程 — 同 tick 内时间一致。未提供时回退 Date.now()。 */
  startTick: (tick: number, nowMs?: number) => void;
  /** Tick 结束。 */
  endTick: (tick: number) => void;
  /** 收集所有 Mod 的 contribute 结果。 */
  collectContributions: () => ContributionItem[];
  /** 生成 LLM 可读的行动声明手册。 */
  generateManual: () => Promise<string>;
  /** 注册的 Mod 列表。 */
  readonly mods: readonly ModDefinition[];
  /** ADR-31: 快照所有 Mod 状态（深拷贝）。 */
  snapshotModStates: () => Map<string, unknown>;
  /** ADR-31: 从快照恢复所有 Mod 状态。 */
  restoreModStates: (snapshot: Map<string, unknown>) => void;
  /** ADR-33: 持久化所有 Mod 状态到 DB。 */
  saveModStatesToDb: (tick: number) => void;
  /** ADR-33: 从 DB 恢复 Mod 状态（启动时调用）。返回是否有数据恢复。 */
  loadModStatesFromDb: () => boolean;
  /** 只读访问 Mod 状态（用于 prompt 管线预收集）。 */
  readModState: <T = unknown>(name: string) => T | undefined;
}

// -- 创建 Dispatcher ----------------------------------------------------------

export interface CreateDispatcherOptions {
  graph: WorldModel;
  mods: ModDefinition[];
}

export function createAliceDispatcher(options: CreateDispatcherOptions): Dispatcher {
  const { graph, mods } = options;

  // per-mod 状态存储
  const modStates = new Map<string, unknown>();
  let currentTick = 0;
  /** ADR-110: 当前 tick 的墙钟时间（ms），startTick 时设置。 */
  let currentNowMs = Date.now();
  let dispatchDepth = 0;
  const MAX_DISPATCH_DEPTH = 10;

  // 初始化状态
  for (const mod of mods) {
    modStates.set(mod.meta.name, structuredClone(mod.initialState));
  }

  // 创建 ModContext（dispatch 引用在后面赋值，闭包安全）
  let dispatchFn: (instruction: string, args: Record<string, unknown>) => unknown;
  function ctx(modName: string): ModContext {
    // 直接引用 state（递归 dispatch 时内层修改对外层可见）。
    // 失败回滚由 dispatch() 的 snapshot-restore 保证（见 C3 修复）。
    return {
      graph,
      state: modStates.get(modName),
      tick: currentTick,
      nowMs: currentNowMs,
      getModState: <T = unknown>(name: string) => modStates.get(name) as T | undefined,
      dispatch: (instruction, args) => dispatchFn(instruction, args),
    };
  }

  // 回写状态
  function commitState(modName: string, c: ModContext) {
    modStates.set(modName, c.state);
  }

  /** C3: 快照 state 用于失败回滚。仅对 object 类型深拷贝。 */
  function snapshotState(modName: string): unknown {
    const s = modStates.get(modName);
    return typeof s === "object" && s !== null ? structuredClone(s) : s;
  }

  // ADR-70 P3: Zod 运行时验证——在指令/查询执行前校验 LLM 参数。
  // 返回 null = 通过，否则返回错误描述字符串。
  // safeParse 成功时用 parsed.data 覆写 args，使 Zod transforms（.trim()/.default()）
  // 对 impl 透明生效。impl 不再需要重复做 .trim() 或 ?? 默认值。
  function validateParams(
    paramDefs: Record<string, ParamDefinition>,
    args: Record<string, unknown>,
  ): string | null {
    const errors: string[] = [];
    for (const [pName, pDef] of Object.entries(paramDefs)) {
      const parsed = pDef.schema.safeParse(args[pName]);
      if (!parsed.success) {
        errors.push(`${pName}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
      } else {
        args[pName] = parsed.data;
      }
    }
    return errors.length > 0 ? `Invalid params: ${errors.join("; ")}` : null;
  }

  function prepareArgs(
    def: InstructionDefinition | QueryDefinition,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const prepared = { ...args };
    const rawContextVars = prepared.__contextVars;
    delete prepared.__contextVars;

    if (!def.deriveParams || !isPlainObject(rawContextVars)) return prepared;

    for (const [paramName, derive] of Object.entries(def.deriveParams)) {
      if (prepared[paramName] != null) continue;
      const derived = derive(rawContextVars, prepared);
      if (derived != null) prepared[paramName] = derived;
    }

    return prepared;
  }

  // 指令 → Mod 索引
  const instructionIndex = new Map<string, { mod: ModDefinition; def: InstructionDefinition }>();
  for (const mod of mods) {
    for (const [name, def] of Object.entries(mod.instructions ?? {})) {
      if (instructionIndex.has(name)) {
        log.warn(`Instruction ${name} duplicated, last-write-wins: ${mod.meta.name}`);
      }
      instructionIndex.set(name, { mod, def });
    }
  }

  // 查询 → Mod 索引
  const queryIndex = new Map<string, { mod: ModDefinition; def: QueryDefinition }>();
  for (const mod of mods) {
    for (const [name, def] of Object.entries(mod.queries ?? {})) {
      queryIndex.set(name, { mod, def });
    }
  }

  const dispatcher: Dispatcher = {
    mods,

    dispatch(instruction: string, args: Record<string, unknown>): unknown {
      const entry = instructionIndex.get(instruction);
      if (!entry) {
        log.warn(`Unknown instruction: ${instruction}`);
        return undefined;
      }

      // 循环保护：防止 listener 中 dispatch 导致递归炸栈
      if (dispatchDepth >= MAX_DISPATCH_DEPTH) {
        log.error(`Dispatch depth exceeded ${MAX_DISPATCH_DEPTH}`, { instruction });
        return undefined;
      }

      dispatchDepth++;
      try {
        // ADR-70 P3: Zod 运行时验证
        const preparedArgs = prepareArgs(entry.def, args);
        const validationError = validateParams(entry.def.params, preparedArgs);
        if (validationError) {
          return { success: false, error: validationError };
        }

        // 1. 执行
        // C3: snapshot before execution — 失败时 restore 到执行前状态，
        // 防止 impl 通过引用修改 state 后抛异常导致中间状态残留。
        const modName = entry.mod.meta.name;
        const stateBackup = snapshotState(modName);
        const c = ctx(modName);
        let result: unknown;
        try {
          result = entry.def.impl(c, preparedArgs);
          commitState(modName, c);
        } catch (e) {
          // 回滚到执行前状态
          modStates.set(modName, stateBackup);
          log.error(`Instruction ${instruction} failed`, e);
          return undefined;
        }

        // 2. 广播给所有 listener
        for (const mod of mods) {
          const handler = mod.listen?.[instruction];
          if (handler) {
            try {
              const lc = ctx(mod.meta.name);
              handler(lc, preparedArgs, result);
              commitState(mod.meta.name, lc);
            } catch (e) {
              log.warn(`Listener ${mod.meta.name}.${instruction} failed`, e);
            }
          }
        }

        return result;
      } finally {
        dispatchDepth--;
      }
    },

    query(name: string, args: Record<string, unknown>): unknown {
      const entry = queryIndex.get(name);
      if (!entry) {
        log.warn(`Unknown query: ${name}`);
        return undefined;
      }
      // ADR-70 P3: Zod 运行时验证
      const preparedArgs = prepareArgs(entry.def, args);
      const validationError = validateParams(entry.def.params, preparedArgs);
      if (validationError) {
        return { success: false, error: validationError };
      }
      const c = ctx(entry.mod.meta.name);
      try {
        return entry.def.impl(c, preparedArgs);
      } catch (e) {
        log.error(`Query ${name} failed`, e);
        return undefined;
      }
    },

    getInstructionNames: () => [...instructionIndex.keys()],
    getInstructionDef: (name: string) => instructionIndex.get(name)?.def,
    getQueryNames: () => [...queryIndex.keys()],
    getQueryDef: (name: string) => queryIndex.get(name)?.def,

    async generateManual(): Promise<string> {
      return generateShellManual(mods);
    },

    startTick(tick: number, nowMs: number = Date.now()) {
      currentTick = tick;
      currentNowMs = nowMs;
      for (const mod of mods) {
        if (mod.onTickStart) {
          const c = ctx(mod.meta.name);
          try {
            mod.onTickStart(c);
            commitState(mod.meta.name, c);
          } catch (e) {
            log.warn(`${mod.meta.name}.onTickStart failed`, e);
          }
        }
      }
    },

    endTick(tick: number) {
      currentTick = tick;
      for (const mod of mods) {
        if (mod.onTickEnd) {
          const c = ctx(mod.meta.name);
          try {
            mod.onTickEnd(c);
            commitState(mod.meta.name, c);
          } catch (e) {
            log.warn(`${mod.meta.name}.onTickEnd failed`, e);
          }
        }
      }
    },

    collectContributions(): ContributionItem[] {
      const items: ContributionItem[] = [];
      for (const mod of mods) {
        if (mod.contribute) {
          const c = ctx(mod.meta.name);
          try {
            items.push(...mod.contribute(c));
          } catch (e) {
            log.warn(`${mod.meta.name}.contribute failed`, e);
          }
        }
      }
      return items;
    },

    // ADR-31: Mod 状态快照/恢复（用于沙箱原子执行）
    // ⚠ 原子回滚假设：所有 listener 的副作用仅限于图属性和 Mod 状态。
    // 图通过 restoreFrom(graphSnapshot) 回滚，Mod 通过 restoreModStates(modSnapshot) 回滚。
    // 如果未来有 listener 产生图/Mod 以外的副作用（如直接写 DB），回滚将不完整。
    snapshotModStates(): Map<string, unknown> {
      const snapshot = new Map<string, unknown>();
      for (const [name, state] of modStates) {
        snapshot.set(name, structuredClone(state));
      }
      return snapshot;
    },

    restoreModStates(snapshot: Map<string, unknown>): void {
      for (const [name, state] of snapshot) {
        // ADR-79 M3: 恢复时也深度合并，防止快照缺少新字段
        const mod = mods.find((m) => m.meta.name === name);
        const merged = mod
          ? deepMergeModState(mod.initialState, structuredClone(state))
          : structuredClone(state);
        modStates.set(name, merged);
      }
    },

    // ADR-33 Phase 1: Mod 状态持久化
    // P1-core-1 修复: 用事务包裹避免部分写入 + 减少 WAL sync 开销。
    saveModStatesToDb(tick: number): void {
      const db = getDb();
      const sqlite = getSqlite();
      const txn = sqlite.transaction(() => {
        for (const [name, state] of modStates) {
          try {
            const json = JSON.stringify(state);
            db.insert(modStatesTable)
              .values({
                modName: name,
                stateJson: json,
                updatedTick: tick,
              })
              .onConflictDoUpdate({
                target: modStatesTable.modName,
                set: {
                  stateJson: json,
                  updatedTick: tick,
                  updatedAt: new Date(),
                },
              })
              .run();
          } catch (e) {
            log.warn(`Failed to save mod state: ${name}`, e);
          }
        }
      });
      try {
        txn();
        log.debug("Mod states saved to DB", { tick, count: modStates.size });
      } catch (e) {
        log.error("Failed to save mod states (transaction rolled back)", e);
      }
    },

    loadModStatesFromDb(): boolean {
      const db = getDb();
      const rows = db.select().from(modStatesTable).all();
      if (rows.length === 0) return false;

      // ADR-79 M3: 构建 modName → initialState 索引（用于深度合并）
      const initialStates = new Map<string, unknown>();
      for (const mod of mods) {
        initialStates.set(mod.meta.name, mod.initialState);
      }

      let restored = 0;
      for (const row of rows) {
        if (modStates.has(row.modName)) {
          try {
            const persisted = JSON.parse(row.stateJson);
            const initial = initialStates.get(row.modName);
            // ADR-79 M3: 深度合并 — initialState 提供新字段默认值
            const merged = deepMergeModState(initial, persisted);
            modStates.set(row.modName, merged);
            restored++;
          } catch (e) {
            log.warn(`Failed to parse mod state: ${row.modName}`, e);
          }
        }
      }
      log.info("Mod states restored from DB", { restored, total: rows.length });
      return restored > 0;
    },

    readModState<T = unknown>(name: string): T | undefined {
      return modStates.get(name) as T | undefined;
    },
  };

  // 赋值 dispatchFn 供 ModContext.dispatch 使用（闭包引用）
  dispatchFn = dispatcher.dispatch;

  return dispatcher;
}
