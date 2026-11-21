/**
 * 群聊记录（eval-artifacts/context-assembly/）：最后 TIMELINE_LIMIT 条，加上被引用、但已经在更早的
 * 那几句。以记录为种子，沿引用回复往上最多 CHAIN_DEPTH 层、最多 CHAIN_CAP 条，只带被引用的那一条本身（2 月 ADR-97 的
 * 回复链逸散，去掉了前后各一条：带上它们线上的记录长了 27%）。叫醒她的那条和新的话先找。
 * 带回来的每一条先换掉记录里一条别人只发贴纸的行或机器人的话（从最旧的换起；价值标注里它们 93–97%、82% 和眼前的事
 * 无关），换完了才加长。记录照旧按时间排，不相邻的地方写"中间还有 N 条"。私聊不改（对方的每句话都冲着她）。
 * 只从 Journal 折叠：这里记最近一天的原话（World.transcript）。
 *
 * 候选 mentions（PLAN 第 55 件第 4 项，2 月 getUnreadMentionIds）：沉在记录之前、她还没看到的找她的话（回复她、点她名）
 * 也先带回来，最多 BURIED_CAP 条，和被引用的那句一样只带那一条本身。"没看到"：它进来之后她还没看过这里的记录（没有
 * 发言调用的结果、也没发过话；World.seenAt）。
 */
import type { LogItem } from "../../mind/effects.js";
import type { AliceEvent } from "../../mind/events.js";
import type { TimelineEntry } from "../../mind/state.js";
import { sentEntry } from "../../mind/step.js";
import type { FeatureContext, PressureFeature } from "./feature.js";
import type { World } from "./world.js";

export const CHAIN_DEPTH = 3;
export const CHAIN_CAP = 12;
/** 沉底的找她的话最多带回几条（最近的几条）。手设。 */
export const BURIED_CAP = 3;
/** 原话留最近一天、每个会话最多这么多条。 */
const KEPT_MS = 24 * 3_600_000;
const KEPT = 2000;

export function contextWith(options: { mentions?: boolean } = {}): PressureFeature {
  if (!options.mentions) {
    return {
      name: "context",
      provides: ["transcript"],
      reduce: (_before, after, event) => withTranscript(after, event),
      layout: (ctx, trigger) => {
        const o = olderOf(ctx);
        return o ? chain(ctx, o, trigger, []) : null;
      },
    };
  }
  return {
    name: "context-mentions",
    provides: ["transcript", "seenAt"],
    reduce: (_before, after, event) => withSeen(withTranscript(after, event), event),
    layout: (ctx, trigger) => {
      const o = olderOf(ctx);
      return o ? chain(ctx, o, trigger, buried(ctx, o)) : null;
    },
  };
}

export const context: PressureFeature = contextWith();

/** 她看过这个会话的记录：发言调用有了结果，或她在这里发了话。 */
function withSeen(world: World, event: AliceEvent): World {
  if (event.type !== "speech.decided" && event.type !== "message.sent") return world;
  return { ...world, seenAt: { ...(world.seenAt ?? {}), [event.scope]: event.at } };
}

/**
 * 记录之前的、找她的、她还没看到的话（最近的 BURIED_CAP 条，从新到旧）。它进来之后她只要看过一次记录就算看到了：
 * 那时它要么还在记录里，要么正是被这里带回来的（像打开会话时 Telegram 跳到那条 @）。
 */
function buried(ctx: FeatureContext, o: Older): string[] {
  const seen = ctx.world.seenAt?.[ctx.chat.scope] ?? Number.NEGATIVE_INFINITY;
  const out: string[] = [];
  for (let i = o.start - 1; i >= 0 && out.length < BURIED_CAP; i--) {
    const e = o.all[i] as TimelineEntry;
    if (e.at <= seen) break;
    // 机器人点她名（入群验证、签到）不是有人在找她。
    if (!e.directed || e.sender === null || e.sender.isBot) continue;
    out.push(e.messageId);
  }
  return out;
}

/** 最近一天每个会话的原话（和时间线同样的行，所以写出来和时间线里的一样）。 */
function withTranscript(world: World, event: AliceEvent): World {
  const all = world.transcript ?? {};
  const add = (scope: string, entry: TimelineEntry): World => {
    const kept = [...(all[scope] ?? []), entry]
      .filter((e) => entry.at - e.at <= KEPT_MS)
      .slice(-KEPT);
    return { ...world, transcript: { ...all, [scope]: kept } };
  };
  switch (event.type) {
    case "message.received":
      return add(event.scope, {
        at: event.at,
        messageId: event.messageId,
        sender: {
          id: event.senderId,
          name: event.senderName,
          ...(event.isBot ? { isBot: true as const } : {}),
        },
        text: event.text,
        contentType: event.contentType,
        ...(event.media ? { media: event.media } : {}),
        replyToMessageId: event.replyToMessageId,
        ...(event.directed ? { directed: true as const } : {}),
      });
    case "message.sent":
      return add(event.scope, sentEntry(event));
    case "message.perceived": {
      const media = event.media;
      const lines = all[event.scope];
      if (media === undefined || !lines?.some((e) => e.messageId === event.messageId)) return world;
      const next = lines.map((e) =>
        e.messageId === event.messageId && e.sender ? { ...e, media } : e,
      );
      return { ...world, transcript: { ...all, [event.scope]: next } };
    }
    default:
      return world;
  }
}

/** 记录之前还有更早的话时：这个会话最近一天的原话，和记录第一条在其中的位置。 */
interface Older {
  all: readonly TimelineEntry[];
  start: number;
}

function olderOf(ctx: FeatureContext): Older | null {
  if (ctx.chat.chatType !== "group") return null;
  const all = ctx.world.transcript?.[ctx.chat.scope] ?? [];
  const head = ctx.chat.timeline[0];
  if (!head) return null;
  let start = -1;
  for (let i = all.length - ctx.chat.timeline.length; i >= 0; i--) {
    if (all[i]?.messageId === head.messageId) {
      start = i;
      break;
    }
  }
  return start > 0 ? { all, start } : null;
}

/** 位置上的那一行：记录里的用时间线的（带着注、看懂了的图），更早的用原话。 */
const entryAt = (ctx: FeatureContext, o: Older, i: number): TimelineEntry =>
  (i >= o.start ? ctx.chat.timeline[i - o.start] : o.all[i]) as TimelineEntry;

/** 选中的位置按时间排成记录；不相邻的地方写跳过了几条（第一条之前不写）。 */
function arrange(ctx: FeatureContext, o: Older, chosen: Iterable<number>): LogItem[] {
  const at = [...new Set(chosen)].sort((a, b) => a - b);
  const items: LogItem[] = [];
  let prev: number | null = null;
  for (const i of at) {
    if (prev !== null && i - prev > 1) items.push({ kind: "skip", count: i - prev - 1 });
    items.push({ kind: "line", entry: entryAt(ctx, o, i) });
    prev = i;
  }
  return items;
}

/** 叫醒她的那条先，其余从新到旧。 */
function seedOrder(ctx: FeatureContext, trigger: string | null): TimelineEntry[] {
  const newest = [...ctx.chat.timeline].reverse();
  const first = newest.find((e) => e.messageId === trigger);
  return first ? [first, ...newest.filter((e) => e !== first)] : newest;
}

function chain(
  ctx: FeatureContext,
  o: Older,
  trigger: string | null,
  first: readonly string[],
): LogItem[] | null {
  const index = new Map(o.all.map((e, i) => [e.messageId, i]));
  const visited = new Set(ctx.chat.timeline.map((e) => e.messageId));
  const added = new Set<number>();
  let frontier = [
    ...first,
    ...seedOrder(ctx, trigger).flatMap((e) =>
      e.replyToMessageId && !visited.has(e.replyToMessageId) ? [e.replyToMessageId] : [],
    ),
  ];
  for (let d = 0; d < CHAIN_DEPTH && frontier.length > 0 && added.size < CHAIN_CAP; d++) {
    const next: string[] = [];
    for (const target of frontier) {
      if (added.size >= CHAIN_CAP) break;
      const i = index.get(target);
      const e = i === undefined ? undefined : o.all[i];
      if (i === undefined || !e || i >= o.start || visited.has(target)) continue;
      visited.add(target);
      added.add(i);
      if (e.replyToMessageId && !visited.has(e.replyToMessageId)) next.push(e.replyToMessageId);
    }
    frontier = next;
  }
  if (added.size === 0) return null;
  const record = Array.from({ length: ctx.chat.timeline.length }, (_, k) => o.start + k);
  const gone = new Set(spare(ctx, o, record, trigger).slice(0, added.size));
  return arrange(ctx, o, [...added, ...record.filter((i) => !gone.has(i))]);
}

/**
 * 记录里可以让出来的行，从旧到新：别人只发贴纸的行、机器人的话。不让的：她自己的行、叫醒她的那条、最新的一条、
 * 记录里有人引用回复的那条（有人回了一张贴纸、回了机器人的答复时，那一行就是在接的话）、回复她的那条（冲着她的）。
 */
function spare(ctx: FeatureContext, o: Older, record: number[], trigger: string | null): number[] {
  const newest = record.at(-1);
  const quoted = new Set(record.map((i) => entryAt(ctx, o, i).replyToMessageId));
  const hers = new Set(o.all.flatMap((e) => (e.sender === null ? [e.messageId] : [])));
  return record.filter((i) => {
    const e = entryAt(ctx, o, i);
    if (i === newest || e.messageId === trigger || e.sender === null) return false;
    if (quoted.has(e.messageId) || (e.replyToMessageId && hers.has(e.replyToMessageId)))
      return false;
    return e.sender.isBot === true || e.contentType === "sticker";
  });
}
