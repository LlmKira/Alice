/**
 * ADR-118 统一时间线 — 4 源归并 + IRC 渲染。
 *
 * 将消息流、action_log 思考、engagement session 动作、ReAct 观察
 * 按时间戳归并排序为单一时间线，供 prompt 组装使用。
 *
 * @see docs/adr/118-unified-timeline.md
 */
import { getPeripheralMessages, getRecentActionsByChat } from "../../db/queries.js";
import type { MessageRecord } from "./messages.js";
import { computeChannelPresence, renderPresenceHint } from "./presence.js";

// ═══════════════════════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════════════════════

/** 时间线条目的标签类型。 */
export type TimelineKind =
  | "message" // Telegram 消息（incoming 或 outgoing）
  | "thought" // 内心活动（reasoning from action_log）
  | "action" // 已执行动作的摘要（当前 engagement session）
  | "gap" // 时间间隔标记
  | "context" // 上下文分隔符（reply chain / mention）
  | "observation"; // ReAct 查询结果

export interface TimelineEntry {
  /** 墙钟时间戳（毫秒）。 */
  readonly ts: number;
  readonly kind: TimelineKind;
  /** 渲染后的 IRC 风格文本行。 */
  readonly rendered: string;
  /** 可选元数据。 */
  readonly meta?: Record<string, unknown>;
}

export interface TimelineSource {
  entries(target: string, sinceMs: number, nowMs: number): TimelineEntry[];
}

// ═══════════════════════════════════════════════════════════════════════════
// 优先级感知的消息内容渲染
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 优先级感知的消息内容渲染。
 *
 * 有 segments 时：media/image 段不截断，link 段优先丢弃，body/meta 截断填充。
 * 无 segments 时：回退到 200 字符硬截断（DB 历史/eval fixture）。
 */
export function renderMessageContent(record: MessageRecord, defaultBudget = 200): string {
  const segments = record.segments;
  if (!segments) {
    return record.text.length > defaultBudget
      ? `${record.text.slice(0, defaultBudget)}...`
      : record.text;
  }

  const hasMedia = segments.some((s) => s.kind === "media" || s.kind === "image");
  const budget = hasMedia ? 500 : defaultBudget;

  const full = segments.map((s) => s.text).join(" ");
  if (full.length <= budget) return full;

  // Phase 1: 丢弃 link segments
  const withoutLinks = segments.filter((s) => s.kind !== "link");
  const reduced = withoutLinks.map((s) => s.text).join(" ");
  if (reduced.length <= budget) return reduced;

  // Phase 2: 保留 essential (media/image)，截断其余
  const essential = withoutLinks.filter((s) => s.kind === "media" || s.kind === "image");
  const others = withoutLinks.filter((s) => s.kind !== "media" && s.kind !== "image");
  const essentialText = essential.map((s) => s.text).join(" ");
  const sep = essential.length > 0 && others.length > 0 ? 1 : 0;
  const otherBudget = Math.max(0, budget - essentialText.length - sep);
  const otherText = others.map((s) => s.text).join(" ");
  const truncatedOther =
    otherText.length > otherBudget ? `${otherText.slice(0, otherBudget)}...` : otherText;

  return [truncatedOther, essentialText].filter(Boolean).join(" ");
}

// ═══════════════════════════════════════════════════════════════════════════
// MessageTimelineSource — 消息流 adapter
// ═══════════════════════════════════════════════════════════════════════════
// 渲染逻辑移植自 prompt.ts L382-448

/**
 * 转发记录注册表：msgId → 已转发到的目标名称列表。
 * 由 forward_message action 写入 graph dynamic property "forwarded_msgs"，
 * 由 buildTimelineSlot 传入。BT 反馈闭环——action 结果回流到观察层。
 */
export type ForwardRegistry = Record<string, string[]>;

export class MessageTimelineSource implements TimelineSource {
  constructor(
    private readonly messages: MessageRecord[],
    private readonly forwardRegistry?: ForwardRegistry,
  ) {}

  entries(_target: string, _sinceMs: number, _nowMs: number): TimelineEntry[] {
    const result: TimelineEntry[] = [];
    const repliesByYou = new Map<number, number[]>();
    for (const msg of this.messages) {
      if (!msg.isOutgoing || !msg.replyToId) continue;
      const replies = repliesByYou.get(msg.replyToId) ?? [];
      replies.push(msg.id);
      repliesByYou.set(msg.replyToId, replies);
    }

    // ADR-97 + ADR-114 D2: 上下文分隔符状态
    let contextType: "none" | "diffused" | "mention" = "none";

    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i];
      const msgTs = msg.date.getTime();

      // 上下文类型切换（reply chain / unanswered mention / 常规消息）
      const newCtx = msg.isMentionContext ? "mention" : msg.isDiffused ? "diffused" : "none";
      if (newCtx !== contextType) {
        if (contextType !== "none") {
          result.push({ ts: msgTs, kind: "context", rendered: "--- end context ---" });
        }
        if (newCtx === "mention") {
          result.push({
            ts: msgTs,
            kind: "context",
            rendered: "--- context: unanswered mention ---",
          });
        } else if (newCtx === "diffused") {
          result.push({ ts: msgTs, kind: "context", rendered: "--- context: reply chain ---" });
        }
        contextType = newCtx;
      }

      // IRC 风格消息行（时间戳由 renderTimeline 统一添加）
      const senderTag = msg.senderId != null ? ` @${msg.senderId}` : "";
      const botTag = msg.isBot ? " [bot]" : "";
      const name = msg.isOutgoing ? "Alice (you)" : `${msg.senderName}${botTag}${senderTag}`;
      const preview = renderMessageContent(msg);
      const replyMark = msg.replyToId ? ` ↩${msg.replyToId}` : "";
      const editMark = msg.isEdited ? " [edited]" : "";
      const fwdMark = msg.forwardFrom ? ` [fwd ${msg.forwardFrom}]` : "";
      const repliesFromYou = !msg.isOutgoing ? repliesByYou.get(msg.id) : undefined;
      const alreadyRepliedMark =
        repliesFromYou && repliesFromYou.length > 0
          ? ` (already replied by you: ${repliesFromYou.map((id) => `#${id}`).join(", ")})`
          : "";
      let reactionStr = "";
      if (msg.reactions) {
        const sorted = Object.entries(msg.reactions)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3);
        if (sorted.length > 0) {
          reactionStr = ` [${sorted.map(([e, c]) => `${e}×${c}`).join(" ")}]`;
        }
      }

      // BT 反馈闭环：已转发的消息标注目标（Alice 知道自己转过什么）
      let sharedMark = "";
      if (this.forwardRegistry && msg.id != null) {
        const targets = this.forwardRegistry[String(msg.id)];
        if (targets && targets.length > 0) {
          sharedMark = ` (already shared with ${targets.join(", ")})`;
        }
      }

      result.push({
        ts: msgTs,
        kind: "message",
        rendered: `${name} (${msg.id})${replyMark}${editMark}${fwdMark}: ${preview}${alreadyRepliedMark}${reactionStr}${sharedMark}`,
      });
    }

    // 尾部关闭
    if (contextType !== "none" && this.messages.length > 0) {
      const lastTs = this.messages[this.messages.length - 1].date.getTime();
      result.push({ ts: lastTs + 1, kind: "context", rendered: "--- end context ---" });
    }

    // ADR-118: 存在感低语（ADR-159: 扩展到私聊——私聊连发是实证重灾区）
    if (this.messages.length > 0) {
      const presence = computeChannelPresence(this.messages);
      const hint = renderPresenceHint(presence);
      if (hint) {
        const lastTs = this.messages[this.messages.length - 1].date.getTime();
        result.push({ ts: lastTs + 1, kind: "context", rendered: hint });
      }
    }

    return result;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ThoughtTimelineSource — action_log 思考 adapter
// ═══════════════════════════════════════════════════════════════════════════
// @see docs/adr/117-*.md — D1: 跨 tick 连续性

export class ThoughtTimelineSource implements TimelineSource {
  entries(target: string, sinceMs: number, _nowMs: number): TimelineEntry[] {
    const TEN_MINUTES_MS = 10 * 60 * 1000;
    const effectiveSince = Math.max(sinceMs, Date.now() - TEN_MINUTES_MS);
    const recentThoughts = getRecentActionsByChat(target, effectiveSince, 3);
    // getRecentActionsByChat 返回 DESC 排序，需要 reverse
    return recentThoughts.reverse().flatMap((thought) => {
      const reasoning = thought.reasoning
        ? [...thought.reasoning].slice(0, 120).join("")
        : thought.actionType.includes("silence") || thought.actionType === "stay_silent"
          ? "[silence] observing"
          : null;
      if (!reasoning) return [];
      return [
        {
          ts: thought.createdAt.getTime(),
          kind: "thought" as const,
          rendered: `* ${reasoning}`,
        },
      ];
    });
  }
}

// ADR-214 Wave A: PendingActionTimelineSource 和 renderPendingMessage 已删除。
// shell-native 架构下 Blackboard.actions（RecordedAction[]）始终为空，
// pending actions 不再通过此管线——Telegram 动作通过容器内 Engine API HTTP 直接执行。

// ═══════════════════════════════════════════════════════════════════════════
// ObservationTimelineSource — ReAct 查询结果 adapter
// ═══════════════════════════════════════════════════════════════════════════
// @see docs/adr/70-react-native-sandbox-architecture.md

/**
 * ADR-160 Fix D: 跨聊天观察隔离。
 *
 * 检测包含跨聊天内容的 observation（通过 `[recent_chat]` 标记
 * 和 `messages from` 模式识别），用 context 类型包裹。
 * context 类型不带 `[HH:MM]` 前缀，视觉上与当前对话明显区分。
 *
 * 对比：PeripheralTimelineSource 已正确使用 `kind: "context"` 包裹，
 * LLM 能正确理解其为外部参考。此处应用相同模式。
 *
 * @see docs/adr/158-outbound-feedback-gap.md §Fix D
 */

/** 检测 observation 文本是否包含跨聊天内容。 */
function isCrossChatObservation(obs: string, target: string): boolean {
  // recent_chat 的典型输出含 "[recent_chat]" 或 "messages from"
  if (!obs.includes("recent_chat") && !obs.includes("recentChat") && !obs.includes("messages from"))
    return false;
  // 如果 observation 明确提到 target channel，不算跨聊天
  if (obs.includes(target)) return false;
  return true;
}

export class ObservationTimelineSource implements TimelineSource {
  constructor(private readonly observations: readonly string[]) {}

  entries(target: string, _sinceMs: number, nowMs: number): TimelineEntry[] {
    const result: TimelineEntry[] = [];
    const normalObs: string[] = [];

    for (const obs of this.observations) {
      if (isCrossChatObservation(obs, target)) {
        // 跨聊天观察：用 context 包裹，明确标记禁止回复
        result.push({
          ts: nowMs - 1,
          kind: "context",
          rendered: "--- cross-chat reference (do NOT reply to these messages) ---",
        });
        result.push({
          ts: nowMs,
          kind: "observation",
          rendered: obs,
        });
        result.push({
          ts: nowMs + 1,
          kind: "context",
          rendered: "--- end cross-chat ---",
        });
      } else {
        normalObs.push(obs);
      }
    }

    // ADR-196 F16: 块级标记替代逐行 [observation] 前缀
    if (normalObs.length > 0) {
      result.push({
        ts: nowMs - 1,
        kind: "context",
        rendered: "--- observations ---",
      });
      for (const obs of normalObs) {
        result.push({
          ts: nowMs,
          kind: "observation" as const,
          rendered: obs,
        });
      }
      result.push({
        ts: nowMs + 1,
        kind: "context",
        rendered: "--- end observations ---",
      });
    }

    return result;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PeripheralTimelineSource — 社交余光 adapter
// ═══════════════════════════════════════════════════════════════════════════
// @see docs/adr/121-social-peripheral-vision/README.md

/** 社交余光配置。 */
export interface PeripheralVisionConfig {
  contactId: string;
  contactName: string;
  currentChat: string;
  /** 共享非私聊频道 Map<channelId, displayName>。 */
  sharedChats: Map<string, string>;
  /** 每频道最大条数。 */
  perChannelCap: number;
  /** 总最大条数。 */
  totalCap: number;
  /** 时间窗口（秒）。 */
  windowS: number;
  /** 最短文本长度。 */
  minTextLength: number;
}

/** DB 返回行 — 类型收窄后的子类型在过滤阶段使用。 */
interface PeripheralRow {
  chatId: string;
  text: string | null;
  msgId: number;
  createdAt: Date;
  senderName: string | null;
}

/** text 已通过类型守卫收窄为非空。 */
type ValidPeripheralRow = PeripheralRow & { text: string };

export class PeripheralTimelineSource implements TimelineSource {
  constructor(private readonly config: PeripheralVisionConfig) {}

  entries(_target: string, _sinceMs: number, nowMs: number): TimelineEntry[] {
    // 隐私屏障：无共享频道 或 窗口为 0 → 不激活
    if (this.config.sharedChats.size === 0 || this.config.windowS <= 0) return [];

    const sinceMs = nowMs - this.config.windowS * 1000;

    let rows: PeripheralRow[];
    try {
      rows = getPeripheralMessages(
        this.config.contactId,
        sinceMs,
        this.config.currentChat,
        this.config.totalCap * 3, // over-fetch 以补偿应用层过滤
      );
    } catch {
      // DB 不可用时静默降级（匹配 Formative Memories 模式）
      return [];
    }

    // 应用层过滤 + 类型收窄 text → string
    const filtered = rows.filter(
      (r): r is ValidPeripheralRow =>
        typeof r.text === "string" &&
        r.text.length >= this.config.minTextLength &&
        this.config.sharedChats.has(r.chatId),
    );
    if (filtered.length === 0) return [];

    // 双层 cap：每频道 K + 全局 M
    const capped = this.applyCaps(filtered);
    if (capped.length === 0) return [];

    // getPeripheralMessages 返回 DESC，反转为 ASC
    capped.reverse();

    return this.renderBlock(capped);
  }

  /** 每频道 perChannelCap + 全局 totalCap 截断。 */
  private applyCaps(rows: ValidPeripheralRow[]): ValidPeripheralRow[] {
    const counts = new Map<string, number>();
    const result: ValidPeripheralRow[] = [];
    for (const row of rows) {
      const n = counts.get(row.chatId) ?? 0;
      if (n >= this.config.perChannelCap) continue;
      counts.set(row.chatId, n + 1);
      result.push(row);
      if (result.length >= this.config.totalCap) break;
    }
    return result;
  }

  /** 渲染为分隔的时间线块：开头标记 → 消息 → 结尾标记。 */
  private renderBlock(rows: ValidPeripheralRow[]): TimelineEntry[] {
    const { contactName, sharedChats } = this.config;
    const firstTs = rows[0].createdAt.getTime();
    const lastTs = rows[rows.length - 1].createdAt.getTime();

    const header: TimelineEntry = {
      ts: firstTs - 1,
      kind: "context",
      rendered: `--- peripheral: what ${contactName} has been up to ---`,
    };
    const footer: TimelineEntry = {
      ts: lastTs + 1,
      kind: "context",
      rendered: "--- end peripheral ---",
    };

    const messages = rows.map((row): TimelineEntry => {
      const label = sharedChats.get(row.chatId) ?? row.chatId;
      const text = row.text.length > 150 ? `${row.text.slice(0, 147)}...` : row.text;
      const name = row.senderName ?? contactName;
      return {
        ts: row.createdAt.getTime(),
        kind: "message",
        rendered: `${name} in ${label}: "${text}"`,
      };
    });

    return [header, ...messages, footer];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 归并 + Gap 注入 + 渲染
// ═══════════════════════════════════════════════════════════════════════════

/** 30 分钟静默 → gap 标记。与 ADR-85 D3 conversation break 阈值一致。 */
const GAP_THRESHOLD_MS = 30 * 60_000;

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** 墙钟时间格式化 — h:MM AM/PM，LLM 直觉友好。 */
function formatTime(ts: number, timezoneOffset?: number): string {
  // ADR-34: 使用配置的时区，而非系统时区
  // 将 UTC 时间戳偏移到用户本地时间，然后用 UTC 时区显示
  const adjustedTs = timezoneOffset != null ? ts + timezoneOffset * 60 * 60 * 1000 : ts;
  return new Date(adjustedTs).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC",
  });
}

/** 人类可读的相对时间标签。 */
function relativeLabel(deltaMs: number): string {
  const min = Math.round(deltaMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `~${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `~${hr}h ago`;
  const days = Math.round(hr / 24);
  return `~${days}d ago`;
}

/** 时长格式化 — gap 标记和 tail gap 共用。 */
function formatDuration(ms: number): string {
  const min = ms / 60_000;
  return min >= 120 ? `${Math.round(min / 60)}h` : `${Math.round(min)}m`;
}

/**
 * IRC 风格 day-change 分隔线 + 尾部 gap 注入。
 *
 * 真实 IRC 客户端在日期切换时插入：
 *   --- Day changed to Wednesday March 12 ---
 *
 * 同时在最后一条条目与 nowMs 之间检测尾部静默，
 * 让 LLM 知道"最后一条消息到当前时间"隔了多久。
 */
function injectDayChangesAndTailGap(entries: TimelineEntry[], nowMs: number): TimelineEntry[] {
  if (entries.length === 0) return entries;

  function dayKey(ts: number): string {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }
  function dayLabel(ts: number): string {
    const d = new Date(ts);
    return `${DAY_NAMES[d.getDay()]} ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
  }

  const result: TimelineEntry[] = [];
  let prevDay = "";

  for (const e of entries) {
    // gap/context 条目不触发 day change（它们是结构标记，不是时间事件）
    if (e.kind !== "gap" && e.kind !== "context") {
      const dk = dayKey(e.ts);
      if (dk !== prevDay) {
        // 首条也插 day marker（让 LLM 知道消息是哪天的）
        result.push({
          ts: e.ts - 1,
          kind: "context",
          rendered: `--- Day changed to ${dayLabel(e.ts)} ---`,
        });
        prevDay = dk;
      }
    }
    result.push(e);
  }

  // 尾部 gap：最后一条内容条目 → nowMs
  const lastContent = result.findLast((e) => e.kind !== "gap" && e.kind !== "context");
  if (lastContent) {
    const tailGapMs = nowMs - lastContent.ts;
    if (tailGapMs >= GAP_THRESHOLD_MS) {
      result.push({
        ts: nowMs - 1,
        kind: "gap",
        rendered: `--- ${formatDuration(tailGapMs)} since last message ---`,
      });
    }
  }

  return result;
}

/**
 * 时间线级 gap 注入 — 在任意相邻条目之间检测 ≥30min 静默。
 *
 * 与旧实现（MessageTimelineSource 内部仅检测消息间 gap）不同，
 * 这里在归并排序后的全局时间线上操作——消息、思考、动作、观察
 * 之间的时间断裂都会被捕获。
 *
 * @see docs/adr/118-unified-timeline.md §2.2
 */
function injectGaps(entries: TimelineEntry[]): TimelineEntry[] {
  if (entries.length < 2) return entries;
  const result: TimelineEntry[] = [entries[0]];
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1];
    const curr = entries[i];
    const gapMs = curr.ts - prev.ts;
    if (gapMs >= GAP_THRESHOLD_MS) {
      result.push({
        ts: curr.ts - 1,
        kind: "gap",
        rendered: `--- ${formatDuration(gapMs)} gap ---`,
      });
    }
    result.push(curr);
  }
  return result;
}

/**
 * 多源归并排序 + gap 注入。
 *
 * 实现论文 T(v, [t₀, t]) = sort_τ(M ∪ R ∪ S ∪ O)：
 * 1. Collect — 从各 source 收集条目
 * 2. Sort — 按 ts 升序归并
 * 3. Enrich — 注入跨源 gap 标记
 *
 * @see docs/adr/118-unified-timeline.md §3.3
 */
export function buildTimeline(
  sources: TimelineSource[],
  target: string,
  sinceMs: number,
  nowMs: number,
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const source of sources) {
    entries.push(...source.entries(target, sinceMs, nowMs));
  }
  entries.sort((a, b) => a.ts - b.ts);
  const withGaps = injectGaps(entries);
  return injectDayChangesAndTailGap(withGaps, nowMs);
}

/**
 * 渲染时间线为零缩进文本行。
 *
 * 统一时间戳脊柱：内容条目（message/thought/action/observation）添加 [HH:MM] 前缀，
 * 结构条目（gap/context）不添加——它们是视觉分隔符，不是体验内容。
 *
 * 当 nowMs 提供且消息距今 ≥30min 时，追加相对时间标签（IRC inspired）：
 *   [11:21, ~8h ago] Bob: hello
 * 让 LLM 在逐条阅读时直接感知时间距离，无需跨段推理。
 *
 * @see docs/adr/141-prompt-style-spec.md — 零缩进规范
 */
export function renderTimeline(
  entries: TimelineEntry[],
  nowMs?: number,
  timezoneOffset?: number,
): string[] {
  return entries.map((e) => {
    if (e.kind === "gap" || e.kind === "context") {
      return e.rendered;
    }
    const time = formatTime(e.ts, timezoneOffset);
    // ≥30min 距今才追加相对标签——近期消息不加噪声
    if (nowMs != null && nowMs - e.ts >= GAP_THRESHOLD_MS) {
      return `[${time}, ${relativeLabel(nowMs - e.ts)}] ${e.rendered}`;
    }
    return `[${time}] ${e.rendered}`;
  });
}
