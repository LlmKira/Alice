/**
 * ADR-204: 意识流核心管道。
 *
 * emit() 持久化事件 → surface() 浮现到 prompt → reinforce() 闭合反馈环。
 * 所有函数都是纯 DB 操作，无 Telegram / LLM 副作用。
 *
 * @see docs/adr/204-consciousness-stream/
 */
import { and, desc, gt, like, lt, sql } from "drizzle-orm";
import { consciousnessEvents } from "../db/schema.js";
import { activationRetrieval } from "../graph/activation.js";
import type { WorldModel } from "../graph/world-model.js";

/** getDb() 返回类型的宽松别名（避免 drizzle generic 泛型不兼容）。 */
// biome-ignore lint/suspicious/noExplicitAny: drizzle schema generic variance
type Db = any;

// ── ADR-210: voice → 人类化情绪映射 ──────────────────────────────────────

/** voice 名称 → 人类可理解的情绪/意图描述（用于意识流 summary） */
const VOICE_FEELING: Record<string, string> = {
  diligence: "felt responsible",
  curiosity: "got curious",
  sociability: "felt like chatting",
  caution: "held back a bit",
};

// ── 类型 ────────────────────────────────────────────────────────────────────

/** 写入事件（emit 入参）。 */
export interface CEvent {
  kind: string;
  entityIds: string[];
  summary: string;
  salience?: number;
  expandHint?: string;
}

/** 浮现指针（surface 返回）。 */
export interface CPointer {
  id: number;
  kind: string;
  summary: string;
  entityIds: string[];
  salience: number;
  ageMs: number;
}

// ── Salience 规则表 ─────────────────────────────────────────────────────────

const SALIENCE_RULES: [string, number][] = [
  ["evolve:tier", 0.9],
  ["self:feel", 0.8],
  ["self:diary", 0.7],
  ["self:note", 0.6],
  ["tool:", 0.5],
  ["evolve:pressure", 0.4],
  ["irc:send", 0.3],
  ["evolve:enqueue", 0.3],
  ["evolve:silence", 0.2],
];

/** 根据 kind 前缀返回默认 salience。 */
export function defaultSalience(kind: string): number {
  for (const [prefix, val] of SALIENCE_RULES) {
    if (kind === prefix || kind.startsWith(prefix)) return val;
  }
  return 0.5;
}

// ── emit ────────────────────────────────────────────────────────────────────

/** INSERT 一条意识流事件。 */
export function emit(db: Db, tick: number, timestampMs: number, event: CEvent): void {
  db.insert(consciousnessEvents)
    .values({
      tick,
      timestampMs,
      kind: event.kind,
      entityIds: JSON.stringify(event.entityIds),
      summary: event.summary.slice(0, 500),
      salience: event.salience ?? defaultSalience(event.kind),
      expandHint: event.expandHint ?? null,
    })
    .run();
}

// ── surface ─────────────────────────────────────────────────────────────────

const HALF_LIFE_MS = 30 * 60 * 1000; // 30 分钟半衰期
const LN2 = Math.LN2;

/**
 * 浮现最相关的意识流事件。
 * score = (salience + entityOverlap) × recency（30 分钟半衰期指数衰减）。
 */
export function surface(
  db: Db,
  nowMs: number,
  seedEntityIds: string[],
  limit = 5,
  G?: WorldModel,
): CPointer[] {
  // 拉取最近 2 小时内的高 salience 事件（预过滤，减少 JS 侧计算量）
  const cutoff = nowMs - 2 * 60 * 60 * 1000;
  const rows = db
    .select()
    .from(consciousnessEvents)
    .where(gt(consciousnessEvents.timestampMs, cutoff))
    .orderBy(desc(consciousnessEvents.timestampMs))
    .limit(50)
    .all();

  if (rows.length === 0) return [];

  const seedSet = new Set(seedEntityIds);

  // C13: 扩散激活——将高激活 fact 节点加入扩展种子集
  if (G && seedEntityIds.length > 0) {
    try {
      const hits = activationRetrieval(G, seedEntityIds, nowMs);
      for (const hit of hits.slice(0, 10)) {
        seedSet.add(hit.entityId);
      }
    } catch {
      /* 图操作失败不影响基础 surface 逻辑 */
    }
  }

  interface Row {
    id: number;
    tick: number;
    timestampMs: number;
    kind: string;
    entityIds: string;
    summary: string;
    salience: number;
    expandHint: string | null;
  }
  const scored = (rows as Row[]).map((row) => {
    const ageMs = nowMs - row.timestampMs;
    const recency = Math.exp((-LN2 * ageMs) / HALF_LIFE_MS);

    // entityId overlap bonus: +0.2 per match, max 0.4
    let overlap = 0;
    try {
      const ids: string[] = JSON.parse(row.entityIds);
      for (const id of ids) {
        if (seedSet.has(id)) overlap += 0.2;
      }
    } catch {
      /* malformed JSON → no bonus */
    }
    overlap = Math.min(overlap, 0.4);

    const score = (row.salience + overlap) * recency;
    return { row, score, ageMs };
  });

  scored.sort((a: { score: number }, b: { score: number }) => b.score - a.score);

  // diary.mod 是日记的权威渲染者（完整内容 + about + 时间格式化），
  // consciousness.mod 的 summary 是退化版本——排除避免双重注入。
  const filtered = scored.filter(({ row }) => row.kind !== "self:diary");

  return filtered.slice(0, limit).map(({ row, ageMs }: { row: Row; ageMs: number }) => ({
    id: row.id,
    kind: row.kind,
    summary: row.summary,
    entityIds: JSON.parse(row.entityIds) as string[],
    salience: row.salience,
    ageMs,
  }));
}

// ── reinforce ───────────────────────────────────────────────────────────────

/**
 * 增强/衰减与指定实体关联的最近事件的 salience。
 * 返回受影响的行数。
 */
export function reinforce(db: Db, entityIds: string[], delta: number): number {
  if (entityIds.length === 0 || delta === 0) return 0;

  let affected = 0;
  for (const eid of entityIds) {
    // SQL LIKE 匹配 JSON 数组中的实体 ID
    const result = db
      .update(consciousnessEvents)
      .set({
        salience: sql`min(1.0, max(0.0, ${consciousnessEvents.salience} + ${delta}))`,
      })
      .where(like(consciousnessEvents.entityIds, `%${eid}%`))
      .run();
    affected += result.changes;
  }
  return affected;
}

// ── gc ──────────────────────────────────────────────────────────────────────

/**
 * 清理过期低 salience 事件。高 salience 事件保留（结晶化）。
 * 返回删除行数。
 */
export function gc(
  db: Db,
  nowMs: number,
  retentionDays = 7,
  crystallizationThreshold = 0.7,
): number {
  const cutoffMs = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  const result = db
    .delete(consciousnessEvents)
    .where(
      and(
        lt(consciousnessEvents.timestampMs, cutoffMs),
        lt(consciousnessEvents.salience, crystallizationThreshold),
      ),
    )
    .run();
  return result.changes;
}

// ── commitTickEvents — evolve 决策→事件批量提取 ─────────────────────────────

/**
 * 从 evolve 管线的 TickPlan 提取意识流事件。
 *
 * 接收宽松类型以避免与 evolve.ts 内部类型的循环依赖——
 * 只读取 type、target、voice、reason、pressures.API 等公共字段。
 */
export function commitTickEvents(
  db: Db,
  tick: number,
  nowMs: number,
  plan: {
    type: string;
    target?: string | null;
    voice?: string;
    reason?: string;
    pressures?: { API?: number };
  },
): void {
  if (plan.type === "skip") return;

  const entityIds = plan.target ? [plan.target] : [];

  if (plan.type === "enqueue") {
    emit(db, tick, nowMs, {
      kind: "evolve:enqueue",
      entityIds,
      summary: `${VOICE_FEELING[plan.voice ?? ""] ?? "turned attention"}${plan.target ? ` toward ${plan.target}` : ""}`,
    });
  } else if (plan.type === "silent") {
    emit(db, tick, nowMs, {
      kind: "evolve:silence",
      entityIds,
      summary: plan.reason ?? "chose silence",
    });
  }
  // system1 → treat like enqueue
  else if (plan.type === "system1") {
    emit(db, tick, nowMs, {
      kind: "evolve:enqueue",
      entityIds,
      summary: `something caught attention${plan.target ? ` in ${plan.target}` : ""}`,
    });
  }
}

// ── commitActEvents — act 执行→事件批量提取 ──────────────────────────────────

/**
 * 从 act 线程的 SubcycleResult 提取意识流事件。
 *
 * 宽松类型：只读取 instructions/actions 的 fn/type 字段。
 */
export function commitActEvents(
  db: Db,
  tick: number,
  nowMs: number,
  sub: {
    instructions: Array<{ fn: string; args?: Record<string, unknown> }>;
    actions: Array<{ fn: string; type?: string; args?: Record<string, unknown> }>;
    completedActions?: string[];
  },
  target: string | null,
): void {
  const entityIds = target ? [target] : [];

  for (const inst of sub.instructions) {
    const fn = inst.fn;
    if (fn === "feel") {
      const valence = inst.args?.valence ?? "?";
      const reason = inst.args?.reason ?? "";
      emit(db, tick, nowMs, {
        kind: "self:feel",
        entityIds,
        summary: `felt ${valence}${reason ? `: ${reason}` : ""}`,
      });
    } else if (fn === "diary") {
      const content = String(inst.args?.content ?? "").slice(0, 100);
      emit(db, tick, nowMs, {
        kind: "self:diary",
        entityIds,
        summary: `wrote diary: ${content}`,
      });
    } else if (fn === "note") {
      const fact = String(inst.args?.fact ?? inst.args?.content ?? "").slice(0, 100);
      emit(db, tick, nowMs, {
        kind: "self:note",
        entityIds: inst.args?.contactId ? [String(inst.args.contactId)] : entityIds,
        summary: `remembered: ${fact}`,
      });
    }
  }

  for (const action of sub.actions) {
    if (action.type === "telegram" && action.fn === "send_message") {
      emit(db, tick, nowMs, {
        kind: "irc:send",
        entityIds,
        summary: `replied${target ? ` in ${target}` : ""}`,
      });
    }
  }

  // ADR-204 C11: tool:* kind — Skill/shell 执行事件
  // completedActions 来自 shell-executor 的 __ALICE_ACTION__ 控制行
  if (sub.completedActions && sub.completedActions.length > 0) {
    for (const ca of sub.completedActions) {
      // 格式: "sent:chatId=X:msgId=Y", "downloaded:chatId=X:...", "sent-file:chatId=X:..."
      const kind = ca.startsWith("downloaded:")
        ? "tool:download"
        : ca.startsWith("sent-file:")
          ? "tool:upload"
          : ca.startsWith("sticker:")
            ? "tool:sticker"
            : `tool:${ca.split(":")[0]}`;
      emit(db, tick, nowMs, {
        kind,
        entityIds,
        summary: ca.slice(0, 200),
      });
    }
  }
}
