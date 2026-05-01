/**
 * Threads Mod — 叙事线程管理。
 *
 * 对应叙事引擎的 narrative-tree mod（Arc-Beat 系统）：
 * - Thread ≈ Arc（话题/关系线，有 tension + status + weight）
 * - Beat ≈ 关键事件节拍（有 causedBy / spawns 因果链）
 *
 * 指令：self_topic_begin, self_topic_advance, self_topic_resolve, affect_thread, thread_review
 * 查询：openTopics, printTopicsAbout, topicUpdates
 * contribute：活跃线程列表 → section 桶
 *
 * 参考: narrative-engine/mods/narrative-tree/index.ts
 * 参考: narrative-framework-paper §5 (P_τ priority)
 */
import { desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { createMod } from "../core/mod-builder.js";
import { PromptBuilder } from "../core/prompt-style.js";
import type { ContributionItem, ModContext } from "../core/types.js";
import { readModState, readPressureApi, section } from "../core/types.js";
import { getDb } from "../db/connection.js";
import { narrativeBeats, narrativeThreads } from "../db/schema.js";
import { snoozeThreadLifecycle } from "../db/thread-lifecycle.js";
import { createThreadInGraph, resolveThreadInGraph, WEIGHT_MAP } from "../engine/generators.js";
import { resolveDisplayName, safeDisplayName } from "../graph/display.js";
import { estimateEventMs } from "../pressure/clock.js";
import { humanDuration, humanDurationAgo } from "../utils/time-format.js";

// -- 类型 --------------------------------------------------------------------

interface Involvement {
  nodeId: string;
  role: string;
  facts?: string[];
}

// WEIGHT_MAP 从 generators.ts 导入（单一真相来源）

/** ADR-23: 扩展 Beat 社交类型（兼容 kernel|ambient）。ADR-181: +prudence/breakthrough。 */
export const BEAT_TYPES = [
  "kernel",
  "ambient",
  "observation",
  "engagement",
  "assistance",
  "misstep",
  "connection",
  "insight",
  "prudence",
  "breakthrough",
] as const;

export type BeatType = (typeof BEAT_TYPES)[number];

// -- ADR-241: 相关性衰减常量 ------------------------------------------------

/** ADR-241: 相关性阈值 — 低于此值的线程不注入 prompt。 */
// 依据：半衰期 7 天时，minor 线程（w=0.5）约 7 天后 relevance ≈ 0.25，14 天 ≈ 0.125。
// major 线程（w=2.0）14 天 ≈ 1.0，28 天 ≈ 0.5。
const RELEVANCE_THRESHOLD = 0.15;

/** ADR-241: Stale 标记阈值 — 接近过滤阈值时显示 [stale] 标记。 */
// 2× RELEVANCE_THRESHOLD，提前约 2-3 天警告。
const STALE_THRESHOLD = RELEVANCE_THRESHOLD * 2;

// -- 辅助函数 -----------------------------------------------------------------

function parseInvolves(raw: string | null): Involvement[] {
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/** 过滤掉 nodeId 为空/undefined 的 involves 条目。 */
function validInvolves(involves: Involvement[]): Involvement[] {
  return involves.filter((i) => i.nodeId != null && i.nodeId !== "" && i.nodeId !== "undefined");
}

/** 将 involves 渲染为 LLM 可读的显示名称列表（无障碍：用 display_name 替代 raw nodeId）。 */
function renderInvolves(involves: Involvement[], ctx: ModContext): string {
  const valid = validInvolves(involves);
  if (valid.length === 0) return "";
  return valid
    .map((i) => {
      // ADR-172: 统一使用 safeDisplayName — 永不返回 raw graph ID
      const name = safeDisplayName(ctx.graph, i.nodeId);
      return `${name}(${i.role})`;
    })
    .join(", ");
}

/**
 * ADR-110: 线程压力（简化 P_τ，论文 Eq. P1）。
 * ADR-64 VI-1: log(1 + ageS/86400) × w + activity_decay。
 * 使用墙钟秒制时间。
 */
function threadPressure(
  createdMs: number,
  lastBeatMs: number | null,
  weight: string,
  nowMs: number,
): number {
  const ageS = Math.max(1, (nowMs - createdMs) / 1000);
  const w = WEIGHT_MAP[weight] ?? 0.5;
  // ADR-64 VI-1: 对数增长替代 age^1.5，防止长线程爆炸
  const agingPressure = Math.log(1 + ageS / 86400) * w;
  const sinceBeatS = Math.max(0, (nowMs - (lastBeatMs ?? createdMs)) / 1000);
  const activityDecay = sinceBeatS > 300 ? Math.log(sinceBeatS / 60) * w * 0.1 : 0;
  return agingPressure + activityDecay;
}

/**
 * ADR-241: 线程相关性（半衰期衰减）— 用于过滤，不用于排序。
 *
 * threadPressure 随时间增长（"处理紧迫度"），用于排序是正确的。
 * threadRelevance 随不活跃时间衰减（"当前相关性"），用于过滤长期无活动线程。
 *
 * 半衰期 7 天：minor 线程 7 天后 ≈ 0.25，14 天 ≈ 0.125（低于 RELEVANCE_THRESHOLD）。
 * @see docs/adr/241-thread-weight-decay.md
 * @see docs/adr/89-impression-formation-system.md（半衰期参考）
 */
export function threadRelevance(
  createdMs: number,
  lastBeatMs: number | null,
  weight: string,
  nowMs: number,
): number {
  const w = WEIGHT_MAP[weight] ?? 0.5;
  const baseMs = lastBeatMs ?? createdMs;
  const inactiveS = Math.max(0, (nowMs - baseMs) / 1000);
  // 半衰期 7 天（604800 秒）
  const DECAY_HALF_LIFE_S = 7 * 86400;
  const decayFactor = 2 ** (-inactiveS / DECAY_HALF_LIFE_S);
  return w * decayFactor;
}

// -- Mod 状态 -----------------------------------------------------------------

interface ThreadsState {
  /** 缓存：活跃线程数（onTickEnd 更新）。 */
  activeCount: number;
  /** 缓存：最高线程压力。 */
  maxPressure: number;
}

// -- Mod 定义 -----------------------------------------------------------------

export const threadsMod = createMod<ThreadsState>("threads", {
  category: "mechanic",
  description: "叙事线程（Arc-Beat）管理",
  topics: ["threads"],
  initialState: { activeCount: 0, maxPressure: 0 },
})
  .instruction("begin_topic", {
    params: z.object({
      title: z.string().min(1).max(200).describe("线程标题"),
      frame: z.string().max(200).optional().describe("张力框架"),
      stake: z.string().max(200).optional().describe("赌注/重要性"),
      weight: z
        .enum(["trivial", "minor", "major", "critical"])
        .optional()
        .describe("权重: trivial|minor|major|critical"),
      involves: z
        .array(z.object({ nodeId: z.string(), role: z.string() }))
        .optional()
        .describe("参与实体 [{nodeId, role}]"),
      horizon: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("前瞻范围（ticks），用于 P_prospect"),
    }),
    description: "创建新叙事线程",
    examples: ['self_topic_begin({ title: "Weekend hiking plan", weight: "major", horizon: 10 })'],
    affordance: {
      priority: "sensor",
      whenToUse: "Starting a new conversation thread worth tracking",
      whenNotToUse: "Casual small talk that doesn't need a thread",
    },
    impl(ctx, args) {
      const db = getDb();
      // ADR-204 C10: involves 的 nodeId 可能是 display_name，代码侧解析
      const rawInvolves = Array.isArray(args.involves)
        ? (args.involves as Involvement[])
        : undefined;
      const involves = rawInvolves?.map((i) => ({
        ...i,
        nodeId: resolveDisplayName(ctx.graph, i.nodeId) ?? i.nodeId,
      }));
      const horizon = args.horizon != null ? Number(args.horizon) : null;
      const weight = (args.weight ? String(args.weight) : "minor") as
        | "trivial"
        | "minor"
        | "major"
        | "critical";

      // ADR-104: 从 relationships mod 读取当前行动目标作为 source_channel
      const relState = readModState(ctx, "relationships");
      const sourceChannel = relState?.targetNodeId ?? undefined;

      // ADR-115: 委托给 createThreadInGraph 共享函数
      const deadlineMs = horizon != null ? ctx.nowMs + horizon * 60 * 1000 : undefined; // horizon 单位是分钟
      const threadId = createThreadInGraph(db, ctx.graph, ctx.tick, ctx.nowMs, {
        title: String(args.title),
        weight,
        deadlineMs,
        involves,
        source: "conversation",
        frame: args.frame ? String(args.frame) : undefined,
        sourceChannel,
      });

      // FTS 索引同步已内聚到 createThreadInGraph
      return threadId;
    },
  })
  // ADR-66 F8: BEAT → advance（"Beat"是叙事框架术语，LLM 不理解）。
  .instruction("advance_topic", {
    params: z.object({
      threadId: z.number().int().positive().describe("话题 ID"),
      content: z.string().min(1).max(1000).describe("新进展——发生了什么、情况如何变化"),
      beatType: z
        .enum([
          "kernel",
          "ambient",
          "observation",
          "engagement",
          "assistance",
          "misstep",
          "connection",
          "insight",
          "prudence",
          "breakthrough",
        ])
        .optional()
        .describe(
          "进展类型: kernel|ambient|observation|engagement|assistance|misstep|connection|insight|prudence|breakthrough. prudence=审慎评估带来了更好的结果; breakthrough=社交冒险收到正面回应",
        ),
      causedBy: z.array(z.number().int()).optional().describe("因果来源 (thread/beat IDs)"),
      spawns: z.array(z.number().int()).optional().describe("衍生的新话题 IDs"),
    }),
    description: "记录话题的新进展（发生了什么、情况如何变化）",
    examples: [
      'self_topic_advance({ threadId: 3, content: "decided on the route", beatType: "engagement" })',
    ],
    affordance: {
      priority: "sensor",
      whenToUse: "Progressing narrative threads with new developments",
      whenNotToUse: "No active threads or nothing new happened",
    },
    impl(ctx, args) {
      const db = getDb();
      const threadId = Number(args.threadId);
      const rawCausedBy = args.causedBy;
      const causedBy = rawCausedBy
        ? JSON.stringify(typeof rawCausedBy === "string" ? [rawCausedBy] : rawCausedBy)
        : null;
      const spawns = args.spawns ? JSON.stringify(args.spawns) : null;
      const [row] = db
        .insert(narrativeBeats)
        .values({
          threadId,
          tick: ctx.tick,
          content: String(args.content),
          beatType: String(args.beatType ?? "ambient"),
          causedBy,
          spawns,
        })
        .returning({ id: narrativeBeats.id })
        .all();
      // 更新 last_beat_tick（不影响 FTS 索引列 title/summary，无需 rebuild）
      db.update(narrativeThreads)
        .set({ lastBeatTick: ctx.tick })
        .where(eq(narrativeThreads.id, threadId))
        .run();
      // ADR-134 D3: 更新图节点活跃时间（线程过期基于最后活动而非创建时间）
      const threadNodeId = `thread_${threadId}`;
      if (ctx.graph.has(threadNodeId)) {
        ctx.graph.updateThread(threadNodeId, { last_activity_ms: ctx.nowMs });
      }
      return row.id;
    },
  })
  .instruction("resolve_topic", {
    params: z.object({
      threadId: z.number().int().positive().describe("线程 ID"),
    }),
    description: "标记线程为已完结",
    affordance: {
      whenToUse: "Close a thread that's been completed or is no longer relevant",
      whenNotToUse: "When the thread still has unfinished business",
      priority: "on-demand",
      category: "threads",
    },
    impl(ctx, args) {
      const db = getDb();
      const threadId = Number(args.threadId);
      // ADR-191: 委托给 resolveThreadInGraph — resolve 路径的单一真相来源
      // （与 self_topic_begin → createThreadInGraph 对称）
      const threadNodeId = `thread_${threadId}`;
      if (ctx.graph.has(threadNodeId)) {
        resolveThreadInGraph(db, ctx.graph, threadNodeId, ctx.tick, ctx.nowMs);
      } else {
        // 图中无节点（可能已 GC）→ 只更新 DB
        db.update(narrativeThreads)
          .set({ status: "resolved", resolvedTick: ctx.tick })
          .where(eq(narrativeThreads.id, threadId))
          .run();
      }
      return true;
    },
  })
  /**
   * ADR-64 VI-2: 更新线程叙事摘要。
   * LLM 在 Reflection 中调用，对已有多条 beat 的线程生成摘要。
   */
  .instruction("thread_review", {
    params: z.object({
      threadId: z.number().int().positive().describe("线程 ID"),
      summary: z.string().trim().min(1).max(500).describe("线程叙事摘要（2-3 句话）"),
    }),
    description: "更新线程的叙事摘要（定期回顾时使用）",
    affordance: {
      whenToUse: "Write a summary for a thread with many updates",
      whenNotToUse: "When the thread is new or already has a fresh summary",
      priority: "on-demand",
      category: "threads",
    },
    impl(ctx, args) {
      const threadId = Number(args.threadId);
      const summary = String(args.summary);

      // 更新 DB
      const db = getDb();
      // FTS 同步由 AFTER UPDATE OF title, summary 触发器自动完成。
      // @see runtime/drizzle/0017_fts5_triggers.sql
      db.update(narrativeThreads)
        .set({ summary, summaryTick: ctx.tick })
        .where(eq(narrativeThreads.id, threadId))
        .run();

      // 同步更新图节点
      const threadNodeId = `thread_${threadId}`;
      if (ctx.graph.has(threadNodeId)) {
        ctx.graph.updateThread(threadNodeId, { summary, last_activity_ms: ctx.nowMs });
      }

      return { success: true, threadId, summaryTick: ctx.tick };
    },
  })
  .instruction("update_topic_lifecycle", {
    params: z.object({
      threadId: z.number().int().positive().describe("线程 ID"),
      outcome: z.enum(["renewed", "snoozed"]).describe("renewed=继续追踪; snoozed=暂缓提醒"),
      minutes: z.number().int().positive().max(10_080).describe("新的提醒/截止分钟数，最多 7 天"),
      reason: z.string().min(1).max(300).describe("为什么延长或暂缓"),
    }),
    description: "延长或暂缓一个尚未完成的话题线程",
    affordance: {
      whenToUse: "The thread is still relevant, but the right next check should happen later",
      whenNotToUse: "When the thread is complete; use resolve_topic instead",
      priority: "on-demand",
      category: "threads",
    },
    impl(ctx, args) {
      return snoozeThreadLifecycle({
        G: ctx.graph,
        threadId: Number(args.threadId),
        tick: ctx.tick,
        nowMs: ctx.nowMs,
        minutes: Number(args.minutes),
        reason: String(args.reason),
        outcome: args.outcome as "renewed" | "snoozed",
      });
    },
  })
  .instruction("affect_thread", {
    params: z.object({
      threadId: z.number().int().positive().describe("线程 ID"),
      entityId: z.string().min(1).describe("实体 ID"),
      role: z.string().min(1).describe("角色"),
      facts: z.array(z.string()).optional().describe("事实列表"),
    }),
    description: "标记实体参与线程 + 记录事实",
    affordance: {
      whenToUse: "Link a person to a thread and record their role or facts",
      whenNotToUse: "When the person is already properly linked",
      priority: "on-demand",
      category: "threads",
    },
    impl(_ctx, args) {
      const db = getDb();
      const threadId = Number(args.threadId);
      const row = db
        .select({ involves: narrativeThreads.involves })
        .from(narrativeThreads)
        .where(eq(narrativeThreads.id, threadId))
        .get();
      if (!row) return false;

      const involves = parseInvolves(row.involves);
      const facts: string[] | undefined = Array.isArray(args.facts) ? args.facts : undefined;
      const existing = involves.find((inv) => inv.nodeId === String(args.entityId));
      if (existing) {
        existing.role = String(args.role);
        if (facts) {
          existing.facts = [...new Set([...(existing.facts ?? []), ...facts])];
        }
      } else {
        involves.push({
          nodeId: String(args.entityId),
          role: String(args.role),
          facts,
        });
      }

      // involves 不在 FTS 索引列（title/summary）中，无需 rebuild
      db.update(narrativeThreads)
        .set({ involves: JSON.stringify(involves) })
        .where(eq(narrativeThreads.id, threadId))
        .run();
      return true;
    },
  })
  .query("open_topics", {
    params: z.object({}),
    description: "获取所有活跃线程（按压力降序）",
    affordance: {
      priority: "capability",
      category: "threads",
      whenToUse: "Check active conversation threads before responding",
      whenNotToUse: "Simple greetings or casual chat",
    },
    returns:
      "Array<{ id: number; title: string; status: string; weight: string; pressure: number }>",
    returnHint: "[{id, title, status, weight, urgency}]",
    impl(ctx) {
      const db = getDb();
      const rows = db
        .select()
        .from(narrativeThreads)
        .where(inArray(narrativeThreads.status, ["open", "active"]))
        .all();
      return rows
        .map((r) => ({
          ...r,
          involves: validInvolves(parseInvolves(r.involves)).map((i) => ({
            ...i,
            // ADR-190: 统一使用 safeDisplayName — 永不返回 raw graph ID
            displayName: safeDisplayName(ctx.graph, i.nodeId),
          })),
          pressure: threadPressure(
            estimateEventMs({ createdAt: r.createdAt, tick: r.createdTick }, ctx.nowMs, ctx.tick),
            r.lastBeatTick != null
              ? estimateEventMs({ tick: r.lastBeatTick }, ctx.nowMs, ctx.tick)
              : null,
            r.weight,
            ctx.nowMs,
          ),
          // ADR-241: relevance 用于 dormant 判定（半衰期衰减）
          relevance: threadRelevance(
            estimateEventMs({ createdAt: r.createdAt, tick: r.createdTick }, ctx.nowMs, ctx.tick),
            r.lastBeatTick != null
              ? estimateEventMs({ tick: r.lastBeatTick }, ctx.nowMs, ctx.tick)
              : null,
            r.weight,
            ctx.nowMs,
          ),
        }))
        .sort((a, b) => b.pressure - a.pressure);
    },
    format(result) {
      const rows = result as Array<Record<string, unknown>>;
      if (rows.length === 0) return ["(no open topics)"];
      return rows.map((r) => {
        const parts = [`#${r.id} "${r.title}" [${r.status}] ${r.weight}`];
        // ADR-241: 用 relevance（衰减型）判定 dormant，用 pressure（增长型）判定 urgency
        const rel = Number(r.relevance ?? r.pressure ?? 0);
        if (rel < RELEVANCE_THRESHOLD) {
          parts.push("dormant");
        } else if (r.pressure != null) {
          const p = Number(r.pressure);
          const urgency = p > 1.0 ? "high urgency" : p > 0.5 ? "moderate" : "low";
          parts.push(urgency);
        }
        const involves = r.involves as
          | Array<{ displayName?: string; nodeId: string; role?: string }>
          | undefined;
        if (involves?.length)
          parts.push(
            `involves: ${involves.map((i) => `${i.displayName ?? i.nodeId} as ${i.role ?? "participant"}`).join(", ")}`,
          );
        if (r.horizon) parts.push(`~${humanDuration(Number(r.horizon) * 60)} ahead`); // horizon 单位是分钟 → 秒
        return parts.join(", ");
      });
    },
  })
  .query("topic_updates", {
    params: z.object({
      threadId: z.number().int().positive().describe("线程 ID"),
      count: z.number().int().positive().default(5).describe("最大条数"),
    }),
    description: "获取线程最近的 beats",
    affordance: {
      whenToUse: "Review recent progress on a specific thread",
      whenNotToUse: "When thread updates are already visible",
      priority: "capability",
      category: "threads",
    },
    returns:
      "Array<{ id: number; threadId: number; tick: number; content: string; beatType: string; causedBy: string[] | null; spawns: string[] | null }>",
    returnHint: "[{beatType, content, timeAgo, causedBy?, spawns?}]",
    impl(ctx, args) {
      const db = getDb();
      return db
        .select()
        .from(narrativeBeats)
        .where(eq(narrativeBeats.threadId, Number(args.threadId)))
        .orderBy(desc(narrativeBeats.id))
        .limit(Number(args.count))
        .all()
        .reverse()
        .map((r) => ({
          ...r,
          agoLabel: humanDurationAgo(Math.max(0, (ctx.nowMs - r.createdAt.getTime()) / 1000)),
        }));
    },
    format(result) {
      const rows = result as Array<Record<string, unknown>>;
      if (rows.length === 0) return ["(no updates)"];
      return rows.map((r) => {
        const timeLabel = r.agoLabel ? String(r.agoLabel) : "earlier";
        const parts = [`[${timeLabel}] [${r.beatType}] ${r.content}`];
        const causedBy = r.causedBy as string[] | null;
        if (causedBy?.length) parts.push(`\u2190 ${causedBy.join(", ")}`);
        const spawns = r.spawns as string[] | null;
        if (spawns?.length) parts.push(`\u2192 ${spawns.join(", ")}`);
        return parts.join(" ");
      });
    },
  })
  .onTickEnd((ctx) => {
    const db = getDb();
    const rows = db
      .select()
      .from(narrativeThreads)
      .where(inArray(narrativeThreads.status, ["open", "active"]))
      .all();
    ctx.state.activeCount = rows.length;
    ctx.state.maxPressure = rows.reduce(
      (max, r) =>
        Math.max(
          max,
          threadPressure(
            estimateEventMs({ createdAt: r.createdAt, tick: r.createdTick }, ctx.nowMs, ctx.tick),
            r.lastBeatTick != null
              ? estimateEventMs({ tick: r.lastBeatTick }, ctx.nowMs, ctx.tick)
              : null,
            r.weight,
            ctx.nowMs,
          ),
        ),
      0,
    );
  })
  .contribute((ctx): ContributionItem[] => {
    const db = getDb();
    const rows = db
      .select()
      .from(narrativeThreads)
      .where(inArray(narrativeThreads.status, ["open", "active"]))
      .all();

    if (rows.length === 0) return [];

    // ADR-66 F10: 按当前对话对象优先排序线程
    const relState = readModState(ctx, "relationships");
    const targetNodeId = relState?.targetNodeId ?? null;

    const allThreads = rows
      .map((r) => {
        const createdMs = estimateEventMs(
          { createdAt: r.createdAt, tick: r.createdTick },
          ctx.nowMs,
          ctx.tick,
        );
        const lastBeatMs =
          r.lastBeatTick != null
            ? estimateEventMs({ tick: r.lastBeatTick }, ctx.nowMs, ctx.tick)
            : null;
        return {
          ...r,
          involves: parseInvolves(r.involves),
          pressure: threadPressure(createdMs, lastBeatMs, r.weight, ctx.nowMs),
          // ADR-241: relevance 用于过滤（半衰期衰减），pressure 用于排序（增长型）
          relevance: threadRelevance(createdMs, lastBeatMs, r.weight, ctx.nowMs),
        };
      })
      // ADR-241: 相关性过滤 — 自动排除长期无活动的线程
      .filter((t) => t.relevance >= RELEVANCE_THRESHOLD)
      .sort((a, b) => b.pressure - a.pressure);

    // 分离：涉及当前对话对象的线程优先展示
    let threads: typeof allThreads;
    if (targetNodeId) {
      const relevant = allThreads.filter((t) =>
        t.involves.some((inv) => inv.nodeId === targetNodeId),
      );
      const background = allThreads.filter(
        (t) => !t.involves.some((inv) => inv.nodeId === targetNodeId),
      );
      threads = [...relevant.slice(0, 5), ...background].slice(0, 8);
    } else {
      threads = allThreads.slice(0, 8);
    }

    const m = new PromptBuilder();
    const needsReview: string[] = [];

    for (const t of threads) {
      // ADR-64 III-1/III-2: tick → 人类时间, pressure → 定性标签
      // @see docs/adr/64-runtime-theory-alignment-audit.md
      const urgencyLabel =
        t.pressure > 1.0 ? "high urgency" : t.pressure > 0.5 ? "moderate" : "low";
      // ADR-115: 内源性线程标注 [system]，ADR-226: 自动聚类标注 [auto]
      const threadNodeId = `thread_${t.id}`;
      const threadSource = ctx.graph.has(threadNodeId)
        ? ctx.graph.getDynamic(threadNodeId, "source")
        : undefined;
      const sourceTag =
        threadSource === "system" ? " [system]" : threadSource === "auto" ? " [auto]" : "";
      // ADR-110 + ADR-69: 归因 — "you last advanced" 闭合因果感知环
      const lastBeatMs =
        t.lastBeatTick != null
          ? estimateEventMs({ tick: t.lastBeatTick }, ctx.nowMs, ctx.tick)
          : null;
      const lastAdvanced =
        lastBeatMs != null
          ? ` — you last advanced ${humanDurationAgo((ctx.nowMs - lastBeatMs) / 1000)}`
          : "";
      // ADR-241: Stale 标记 — relevance 接近过滤阈值时显示 [stale]
      const isStale = t.relevance < STALE_THRESHOLD;
      const staleTag = isStale ? " [stale]" : "";
      // ADR-241: 计算无活动天数
      const baseActivityMs =
        lastBeatMs ?? (typeof t.createdAt === "number" ? t.createdAt : t.createdAt.getTime());
      const inactiveMs = ctx.nowMs - baseActivityMs;
      const inactiveDays = Math.round(inactiveMs / (24 * 3600 * 1000));
      const inactiveTag = inactiveDays > 0 ? ` — inactive ${inactiveDays}d` : "";
      m.line(
        `[#${t.id}] "${t.title}"${sourceTag} (${t.weight}, ${urgencyLabel})${staleTag}${lastAdvanced}${inactiveTag}`,
      );
      if (t.tensionFrame) m.kv("frame", t.tensionFrame);
      if (t.deadlineTick != null) {
        const deadlineMs =
          estimateEventMs({ tick: t.deadlineTick }, ctx.nowMs, ctx.tick) || ctx.nowMs;
        const remainingS = Math.max(0, (deadlineMs - ctx.nowMs) / 1000);
        const remainingHuman = humanDuration(remainingS);
        // 承诺线程（title 以 "Commitment:" 开头）提前 1 小时预警，其他线程 5 分钟
        const isCommitment = typeof t.title === "string" && t.title.startsWith("Commitment:");
        const urgentThresholdS = isCommitment ? 3600 : 300;
        const urgentTag = remainingS <= urgentThresholdS ? " — URGENT" : "";
        m.kv("deadline", `~${remainingHuman} left${urgentTag}`);
      }
      const involvesStr = renderInvolves(t.involves, ctx);
      if (involvesStr) {
        m.kv("involves", involvesStr);
      }

      // ADR-64 VI-2: 优先展示 summary，fallback 到最近 beat
      if (t.summary) {
        m.kv("summary", t.summary);
        // 仅展示 summary 后的最新 beat（如有）
        const latestBeat = db
          .select()
          .from(narrativeBeats)
          .where(eq(narrativeBeats.threadId, t.id))
          .orderBy(desc(narrativeBeats.id))
          .limit(1)
          .all();
        if (latestBeat.length > 0) {
          const b = latestBeat[0];
          const beatMs = estimateEventMs({ tick: b.tick }, ctx.nowMs, ctx.tick) || ctx.nowMs;
          const beatAgoS = (ctx.nowMs - beatMs) / 1000;
          m.kv(`latest[${humanDurationAgo(beatAgoS)}]`, b.content);
        }
      } else {
        // 无 summary — fallback 到最近 2 条 beat
        const beats = db
          .select()
          .from(narrativeBeats)
          .where(eq(narrativeBeats.threadId, t.id))
          .orderBy(desc(narrativeBeats.id))
          .limit(2)
          .all()
          .reverse();
        for (const b of beats) {
          const bMs = estimateEventMs({ tick: b.tick }, ctx.nowMs, ctx.tick) || ctx.nowMs;
          const beatAgoS = (ctx.nowMs - bMs) / 1000;
          // ADR-84 W3: 渲染 beatType + causedBy/spawns 因果链
          const typeTag = b.beatType && b.beatType !== "ambient" ? ` ${b.beatType}:` : ":";
          let causalSuffix = "";
          if (b.causedBy) {
            try {
              const ids = z.array(z.string()).parse(JSON.parse(b.causedBy));
              if (ids.length > 0) causalSuffix += ` (from ${ids.map((id) => `#${id}`).join(", ")})`;
            } catch {
              /* malformed JSON — skip */
            }
          }
          if (b.spawns) {
            try {
              const ids = z.array(z.string()).parse(JSON.parse(b.spawns));
              if (ids.length > 0) causalSuffix += ` (→ ${ids.map((id) => `#${id}`).join(", ")})`;
            } catch {
              /* malformed JSON — skip */
            }
          }
          m.line(`beat[${humanDurationAgo(beatAgoS)}]${typeTag} ${b.content}${causalSuffix}`);
        }
      }

      // ADR-64 VI-2: 检测需要 thread_review 的线程
      const beatCount = db
        .select({ count: sql<number>`count(*)` })
        .from(narrativeBeats)
        .where(eq(narrativeBeats.threadId, t.id))
        .get();
      const totalBeats = beatCount?.count ?? 0;
      // ADR-110: 21600 秒（6 小时）
      const summaryMs =
        t.summaryTick != null
          ? estimateEventMs({ tick: t.summaryTick }, ctx.nowMs, ctx.tick)
          : null;
      const summaryStale =
        summaryMs != null
          ? totalBeats > 0 && (ctx.nowMs - summaryMs) / 1000 > 21600
          : totalBeats >= 5;
      if (summaryStale) {
        needsReview.push(`#${t.id} "${t.title}"`);
      }
    }

    // ADR-210: 纯事实视角——不用 "Your"
    const items = [section("threads", m.build(), "Narrative threads", 30, 70)];

    // ADR-64 VI-2: thread review 提示
    // ADR-81: 压力门控——低压力时注入指令性簿记提示
    // @see docs/adr/81-reflection-separation.md §Mod 贡献从声部门控改为压力门控
    if (needsReview.length > 0 && readPressureApi(ctx) < 0.6) {
      items.push(
        section(
          "thread-review-hint",
          [
            PromptBuilder.of("These threads haven't been summarized in a while:"),
            ...needsReview.map((t) => PromptBuilder.of(`→ ${t}`)),
          ],
          undefined,
          31,
          65,
        ),
      );
    }

    return items;
  })
  .build();
