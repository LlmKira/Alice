/**
 * 注意力公平（ADR-218 的 U_fairness）和第一次私聊的节奏（PLAN 第 45 件）。两个反馈回路都只从事件折进状态、
 * 从状态和世界读出，纯函数：时间只来自事件和参数，没有时钟、随机数和 I/O。
 *
 * - 注意力公平：安静的私聊（已有的私聊；群里认识、还没私聊过的人不算）在她把轮次花在别处时攒一笔有界的服务债。
 *   starvationBoost 是这笔债（0–0.45），fairnessCostDiscount 是它的用法：安静的私聊在意愿层里少付一部分代价。
 *   她一想（speech.decided）、一说（message.sent），这笔债就清零——"考虑过就消耗"。折扣最多 45%：没人回的私聊
 *   还有沉默、连发、退避那几笔代价，公平不会把它们顶掉（30 天 S2 上界不变）。
 * - 第一次私聊的节奏：不再有"一小时最多 4 人"的硬闸。firstDmCost 按来源群学：从这个群认识的人里，
 *   她第一次私聊回来过几个（Beta 先验 2/4），回得少就慢慢加一笔社交代价，刚在同一个群开过一个陌生私聊、
 *   那个群此刻嫌她时再各加一笔；Telegram 的 PEER_FLOOD 出现一次就停（firstDmBlocked），
 *   冷却过后由 clock.tick 放开。
 */
import type { AliceEvent } from "../../mind/events.js";
import type { Contribution } from "../../mind/mechanism.js";
import { elapsed } from "../../mind/when.js";
import { feature, type PressureFeature, type View } from "./feature.js";
import { TURN_GAP } from "./params.js";
import { unopenedPrivate } from "./reach.js";
import { REJECTED_LIVE, rejectionAt } from "./rejection.js";
import { nameOf, type RelationView, relationView, STOP_SHOWN, stopToward } from "./relation.js";
import { aversionAt, type ChatNode } from "./world.js";

const H = 3_600_000;
const D = 24 * H;

/** 注意力公平的几个尺度。 */
export const FAIRNESS = {
  /** 服务债最多换来这么大的代价折扣（U_fairness 的上界；再大就会压过沉默、连发、退避）。 */
  maxBoost: 0.45,
  /** 冷落多久，服务债接近满：6 小时后约 63%，24 小时约 98%。手设。 */
  quietTau: 6 * H,
  /** 别处多少轮开口时，"别处很热闹"按一半算：分母的平滑尺度（crowd = n / (n + κ)）。手设。 */
  crowdKappa: 12,
  /** 算别处热闹程度的窗口：一天。 */
  window: D,
  /** 服务债的流水最多留几条（24 小时内有界的日志；她一天说不到这么多）。 */
  servedKept: 500,
} as const;

/** 第一次私聊的节奏。 */
export const FIRST_DM = {
  /** Beta 先验里"回来过"的份数：2/4 = 0.5，一开始按正常节奏。 */
  priorReplies: 2,
  priorAttempts: 4,
  /** 回来得少时最多多付这么多社交代价（乘成本敏感度 λ 之前）。手设。 */
  cost: 0.8,
  /** Telegram 的 PEER_FLOOD 之后停多久再试：一天（手设；平台限制通常几小时到几天）。 */
  floodCool: D,
  /** 刚从同一个群开过一次初次私聊后的同群冷却（避免扎堆私聊同一个群的人）；尺度与群回避一致（2 小时）。 */
  groupCoolCost: 0.9,
  groupCoolTau: 2 * H,
  /** 群里正嫌她时往同群初次私聊传递的代价倍数。 */
  groupRejectionScale: 1.0,
  /** 群里同意私聊后的有效时长（一天内免除陌生破冰代价）。 */
  consentTtl: D,
} as const;

/** 她在一个会话里开口的一笔流水（算"别处有多热闹"用）。 */
export interface ServedTurn {
  at: number;
  scope: string;
}

/** 一次第一次私聊：在哪个私聊里、什么时候发出的、对方后来回了没有。 */
export interface FirstDmAttempt {
  scope: string;
  sourceGroup?: string;
  sentAt: number;
  replied: boolean;
  blocked?: boolean;
}

/** 她暂缓直接私聊、打算先回来源群里顺口问一句的记录。 */
export interface PlannedGroupAsk {
  partner: string;
  name: string;
  dmScope: string;
  at: number;
  reason: string;
  /** 记下打算后她是否已经在群里开过口（之后对方回应才算顺着答应）。 */
  spokeInGroup: boolean;
}

/** 群里某人顺着接话表示欢迎/同意继续私聊的记录。 */
export interface DmConsent {
  at: number;
  group: string;
}

/** 注意力公平和第一次私聊的全部状态（世界折叠的一小块）。 */
export interface FairnessState {
  /** 她上一次在这个会话里做了决定、或开口的时刻。 */
  readonly lastServedAt: Readonly<Record<string, number>>;
  /** 按人记的第一次私聊（一个人从群里认识后，她第一次私聊他）。 */
  readonly firstDmAttempts: Readonly<Record<string, readonly FirstDmAttempt[]>>;
  /** Telegram 的 PEER_FLOOD 最近一次出现的时刻；不是 null 时不再开新的第一次私聊，冷却从这一刻算。 */
  readonly peerFloodStoppedAt: number | null;
  /** 最近 24 小时里她开口的流水（别的会话的热闹程度从这里算）。 */
  readonly served: readonly ServedTurn[];
  /** 每个来源群最近一次发起陌生初次私聊（发出或被隐私挡住）的时刻。 */
  readonly lastColdByGroup?: Readonly<Record<string, number>>;
  /** 打算先在来源群里问一句再私聊的计划（按来源群存储）。 */
  readonly plannedGroupAsks?: Readonly<Record<string, readonly PlannedGroupAsk[]>>;
  /** 对方已经在来源群里接住/同意私聊的记录（按联系人 id）。 */
  readonly consented?: Readonly<Record<string, DmConsent>>;
}

export const initialFairness: FairnessState = {
  lastServedAt: {},
  firstDmAttempts: {},
  peerFloodStoppedAt: null,
  served: [],
};

/** 公平与第一次私聊读的世界：会话、联系人、在群里认识的人（她开口的流水在 FairnessState.served）。 */
export type FairnessWorld = View<"chats" | "relations" | "willingness" | "reach">;

/**
 * 她开口的一笔进流水。同一轮（TURN_GAP 内连着说）只算一笔，和 world.ts 的 turns 同一个口径；
 * 世界和会话里的 turns 只留 30 / 50 分钟，公平要看一整天，所以这里自己留一份有界的。
 */
function serve(state: FairnessState, at: number, scope: string): FairnessState {
  const lastServedAt = {
    ...state.lastServedAt,
    [scope]: Math.max(state.lastServedAt[scope] ?? 0, at),
  };
  const previous = state.served.findLast((t) => t.scope === scope);
  if (previous !== undefined && at - previous.at <= TURN_GAP) {
    return { ...state, lastServedAt };
  }
  const served = [...state.served, { at, scope }]
    .filter((t) => at - t.at < FAIRNESS.window)
    .slice(-FAIRNESS.servedKept);
  return { ...state, lastServedAt, served };
}

/**
 * 第一次私聊记一笔：这个私聊里没人先找过她，她也没在这里被记过（她第一次开口）。
 * 回复别人的不算：那是回应，不是在群里认识之后主动去找人。
 */
const BLOCK_REASONS = new Set([
  "refused",
  "private_closed",
  "transport_soft_permanent",
  "peer_flood",
]);

function noteFirstDm(
  state: FairnessState,
  world: FairnessWorld,
  event: Extract<AliceEvent, { type: "message.sent" }>,
): FairnessState {
  const chat = world.chats[event.scope];
  if (chat && chat.chatType !== "private") return state;
  const candidate = unopenedPrivate(world).get(event.scope);
  const partner = chat?.partner ?? candidate;
  if (!partner) return state;
  const cold = candidate !== undefined || chat?.lastIncomingAt === 0;
  if (!cold) return state;
  const attempts = state.firstDmAttempts[partner] ?? [];
  if (attempts.some((a) => a.scope === event.scope)) return state;
  const sourceGroup = world.reach.met[partner]?.scope;
  const entry: FirstDmAttempt = {
    scope: event.scope,
    ...(sourceGroup ? { sourceGroup } : {}),
    sentAt: event.at,
    replied: false,
  };
  return {
    ...state,
    firstDmAttempts: {
      ...state.firstDmAttempts,
      [partner]: [...attempts, entry],
    },
    ...(sourceGroup
      ? { lastColdByGroup: { ...(state.lastColdByGroup ?? {}), [sourceGroup]: event.at } }
      : {}),
  };
}

function noteFirstDmBlocked(
  state: FairnessState,
  world: FairnessWorld,
  event: Extract<AliceEvent, { type: "act.failed" }>,
): FairnessState {
  if (!BLOCK_REASONS.has(event.reason)) return state;
  const chat = world.chats[event.scope];
  if (chat && chat.chatType !== "private") return state;
  const candidate = unopenedPrivate(world).get(event.scope);
  const partner = chat?.partner ?? candidate;
  if (!partner) return state;
  const cold = candidate !== undefined || (chat?.lastIncomingAt === 0 && chat.lastAliceAt === 0);
  if (!cold) return state;
  const sourceGroup = world.reach.met[partner]?.scope;
  const existing = state.firstDmAttempts[partner] ?? [];
  const idx = existing.findIndex((a) => a.scope === event.scope);
  const nextAttempts: readonly FirstDmAttempt[] =
    idx >= 0
      ? existing.map((a, i) => (i === idx ? { ...a, blocked: true } : a))
      : [
          ...existing,
          {
            scope: event.scope,
            ...(sourceGroup ? { sourceGroup } : {}),
            sentAt: event.at,
            replied: false,
            blocked: true,
          },
        ];
  return {
    ...state,
    firstDmAttempts: { ...state.firstDmAttempts, [partner]: nextAttempts },
    ...(sourceGroup
      ? { lastColdByGroup: { ...(state.lastColdByGroup ?? {}), [sourceGroup]: event.at } }
      : {}),
  };
}

/** 那个人回了她：这个私聊里最近一笔还没回来的第一次私聊记成回来过。 */
function markReplied(state: FairnessState, scope: string, at: number): FairnessState {
  for (const [contact, attempts] of Object.entries(state.firstDmAttempts)) {
    const i = attempts.findIndex((a) => a.scope === scope && !a.replied && a.sentAt <= at);
    const hit = i < 0 ? undefined : attempts[i];
    if (!hit) continue;
    const list = [...attempts];
    list[i] = { ...hit, replied: true };
    return { ...state, firstDmAttempts: { ...state.firstDmAttempts, [contact]: list } };
  }
  return state;
}

function notePlannedAsk(
  state: FairnessState,
  world: FairnessWorld,
  event: Extract<AliceEvent, { type: "act.done" }>,
): FairnessState {
  if (event.act.kind !== "dm-defer") return state;
  const partner = world.chats[event.scope]?.partner ?? unopenedPrivate(world).get(event.scope);
  if (!partner) return state;
  const sourceGroup = world.reach.met[partner]?.scope;
  if (!sourceGroup) return state;
  const name = nameOf(world, partner) ?? partner;
  const existing = (state.plannedGroupAsks?.[sourceGroup] ?? []).filter(
    (p) => p.partner !== partner && event.at - p.at < D,
  );
  const entry: PlannedGroupAsk = {
    partner,
    name,
    dmScope: event.scope,
    at: event.at,
    reason: event.act.reason,
    spokeInGroup: false,
  };
  return {
    ...state,
    plannedGroupAsks: {
      ...(state.plannedGroupAsks ?? {}),
      [sourceGroup]: [...existing, entry].slice(-5),
    },
  };
}

function advancePlannedGroup(state: FairnessState, event: AliceEvent): FairnessState {
  const asks = state.plannedGroupAsks;
  if (!asks) return state;
  if (event.type === "message.sent") {
    const list = asks[event.scope];
    if (!list?.length || list.every((p) => p.spokeInGroup)) return state;
    return {
      ...state,
      plannedGroupAsks: {
        ...asks,
        [event.scope]: list.map((p) => ({ ...p, spokeInGroup: true })),
      },
    };
  }
  if (event.type === "message.received" && event.chatType === "group" && event.directed) {
    const list = asks[event.scope];
    if (!list?.length) return state;
    const hit = list.find((p) => p.partner === event.senderId && p.spokeInGroup);
    if (!hit) return state;
    const rest = list.filter((p) => p !== hit);
    const nextAsks = { ...asks };
    if (rest.length > 0) nextAsks[event.scope] = rest;
    else delete nextAsks[event.scope];
    return {
      ...state,
      plannedGroupAsks: nextAsks,
      consented: {
        ...(state.consented ?? {}),
        [hit.partner]: { at: event.at, group: event.scope },
      },
    };
  }
  return state;
}

/**
 * 世界折叠：她做了决定、开了口、有人回了她的第一次私聊、被隐私挡住、Telegram 限流、暂缓留到群里问、时间过去。
 */
export function reduceFairness(
  state: FairnessState,
  world: FairnessWorld,
  event: AliceEvent,
): FairnessState {
  if (event.type === "clock.tick") {
    const stopped = state.peerFloodStoppedAt;
    const cooled = stopped !== null && event.at - stopped >= FIRST_DM.floodCool;
    return cooled ? { ...state, peerFloodStoppedAt: null } : state;
  }
  let next = advancePlannedGroup(state, event);
  // Telegram 第一次说给不熟的人发私聊发得太多（errors.ts 的 peer_flood）：不再开新的第一次私聊。
  if (event.type === "act.failed") {
    if (event.reason === "peer_flood") {
      next = { ...next, peerFloodStoppedAt: event.at };
    }
    return noteFirstDmBlocked(next, world, event);
  }
  if (event.type === "act.done") return notePlannedAsk(next, world, event);
  switch (event.type) {
    case "speech.decided": {
      const at = Math.max(next.lastServedAt[event.scope] ?? 0, event.at);
      if (at === next.lastServedAt[event.scope]) return next;
      return { ...next, lastServedAt: { ...next.lastServedAt, [event.scope]: at } };
    }
    case "message.sent":
      return noteFirstDm(serve(next, event.at, event.scope), world, event);
    case "message.received":
      return event.chatType === "private" ? markReplied(next, event.scope, event.at) : next;
    default:
      return next;
  }
}

/** 在原始世界或 withUnopened 展开后的世界里判断 scope 是否仍属于"未开过的初次私聊"。 */
function isUnopenedPrivate(world: FairnessWorld, scope: string): boolean {
  return unopenedPrivate(world).has(scope) || world.chats[scope]?.unopened === true;
}

function partnerFor(world: FairnessWorld, scope: string): string | null {
  return world.chats[scope]?.partner ?? unopenedPrivate(world).get(scope) ?? null;
}
/** 安静的熟人：已有的私聊（还没开过的不算）；还和她有来往，没有正在生效的嫌弃。 */
function quietContact(world: FairnessWorld, scope: string, now: number): RelationView | null {
  const chat = world.chats[scope];
  if (!chat || chat.unopened || chat.chatType !== "private") return null;
  const partner = chat.partner;
  if (!partner) return null;
  // 私聊里的嫌弃（被晾着、被拉黑、被冷脸）在会话的 aversion 上，叫停记在对方的 hurts 上；群里的 rejection 不记在私聊上。
  if (aversionAt(chat, now) >= REJECTED_LIVE) return null;
  if (stopToward(world.relations, partner, now) >= STOP_SHOWN) return null;
  const contact = relationView(world, partner);
  return contact && contact.lastBondAt > 0 ? contact : null;
}

/**
 * 服务债 U_fairness 的版本：0–0.45。她自己多久没被顾上（相对和这个人的关系起点的 6 小时尺度）
 * 乘别处有多热闹（最近 24 小时她在别的会话里开口了多少轮）。没有别处、没有私聊、有嫌弃时是 0。
 * 她一想、一说，lastServedAt 就变成此刻，这笔债立刻归零（考虑过就消耗）。
 */
export function starvationBoost(
  state: FairnessState,
  world: FairnessWorld,
  scope: string,
  now: number,
): number {
  const contact = quietContact(world, scope, now);
  if (!contact) return 0;
  const since = Math.max(state.lastServedAt[scope] ?? 0, contact.lastBondAt);
  const quiet = 1 - Math.exp(-Math.max(0, now - since) / FAIRNESS.quietTau);
  const elsewhere = state.served.filter(
    (t) => t.scope !== scope && t.at <= now && now - t.at < FAIRNESS.window,
  ).length;
  const crowd = elsewhere / (elsewhere + FAIRNESS.crowdKappa);
  return FAIRNESS.maxBoost * quiet * crowd;
}

export function fairnessCostDiscount(
  state: FairnessState,
  world: FairnessWorld,
  scope: string,
  now: number,
): number {
  return 1 - starvationBoost(state, world, scope, now);
}

/**
 * 开一个新的第一次私聊多加的一笔社交代价：所有第一次私聊里回来过的比例（Beta 先验 2/4）低于常态时，
 * 按差多少平滑地加。2/4 回来是正常节奏（0）；回来得越少越重，最多 FIRST_DM.cost；回得越多越轻（0）。
 * 只对还没开过的私聊收，已经有的会话不受影响（它们有自己的连发、沉默、退避）。
 */
export interface GroupDmStats {
  sourceGroup: string | null;
  groupTitle: string | null;
  attempts: number;
  replied: number;
  blocked: number;
  silent: number;
  recentColdAt: number | null;
  groupRejection: number;
  consented: boolean;
  canDmDirectly: boolean;
}

export function groupDmStatsOf(
  state: FairnessState,
  world: FairnessWorld,
  partner: string | null,
  groupScope: string | null,
  now: number,
): GroupDmStats {
  const sourceGroup = groupScope ?? (partner ? (world.reach.met[partner]?.scope ?? null) : null);
  const groupTitle = sourceGroup ? (world.reach.titles[sourceGroup] ?? null) : null;
  const all = Object.values(state.firstDmAttempts)
    .flat()
    .filter((a) => a.sentAt <= now && (!sourceGroup || a.sourceGroup === sourceGroup));
  const replied = all.filter((a) => a.replied).length;
  const blocked = all.filter((a) => a.blocked).length;
  const silent = all.filter((a) => !a.replied && !a.blocked).length;
  const recentColdAt = sourceGroup ? (state.lastColdByGroup?.[sourceGroup] ?? null) : null;
  const sourceChat = sourceGroup ? world.chats[sourceGroup] : undefined;
  const groupRejection = sourceChat ? rejectionAt(sourceChat, now) : 0;
  const consent = partner ? state.consented?.[partner] : undefined;
  const consented =
    Boolean(consent && now - consent.at <= FIRST_DM.consentTtl) && groupRejection < REJECTED_LIVE;
  const recentCool =
    recentColdAt !== null && now >= recentColdAt && now - recentColdAt < FIRST_DM.groupCoolTau;
  const rate = (replied + FIRST_DM.priorReplies) / (all.length + FIRST_DM.priorAttempts);
  const guardedByHistory = (blocked >= 1 && replied === 0) || (all.length >= 2 && rate < 0.4);
  const canDmDirectly =
    consented || (!guardedByHistory && groupRejection < REJECTED_LIVE && !recentCool);
  return {
    sourceGroup,
    groupTitle,
    attempts: all.length,
    replied,
    blocked,
    silent,
    recentColdAt,
    groupRejection,
    consented,
    canDmDirectly,
  };
}

export function firstDmCost(
  state: FairnessState,
  world: FairnessWorld,
  scope: string,
  now: number,
): number {
  if (!isUnopenedPrivate(world, scope)) return 0;
  const partner = partnerFor(world, scope);
  if (!partner) return 0;
  const stats = groupDmStatsOf(state, world, partner, null, now);
  if (stats.consented) return 0;
  const rate = (stats.replied + FIRST_DM.priorReplies) / (stats.attempts + FIRST_DM.priorAttempts);
  const prior = FIRST_DM.priorReplies / FIRST_DM.priorAttempts;
  const rateCost = stats.attempts === 0 ? 0 : FIRST_DM.cost * Math.max(0, 1 - rate / prior);
  const coolCost =
    stats.recentColdAt !== null && now >= stats.recentColdAt
      ? FIRST_DM.groupCoolCost * Math.exp(-(now - stats.recentColdAt) / FIRST_DM.groupCoolTau)
      : 0;
  const rejectionCost =
    stats.groupRejection >= REJECTED_LIVE ? FIRST_DM.groupRejectionScale * stats.groupRejection : 0;
  return rateCost + coolCost + rejectionCost;
}

/** Telegram 最近一次说过 PEER_FLOOD（还没冷却完）：不再开新的第一次私聊。 */
export function firstDmBlocked(state: FairnessState): boolean {
  return state.peerFloodStoppedAt !== null;
}

function resolveGroupTarget(
  world: FairnessWorld,
  scope: string,
  timeline: ReadonlyArray<{ messageId: string; sender: { id: string; name: string } | null }>,
  whoArg: string | null,
): { partner: string | null; name: string | null } {
  if (!whoArg) return { partner: null, name: null };
  const needle = whoArg.trim().replace(/^\[|\]$/g, "");
  const byMsg = timeline.find((t) => t.messageId === needle && t.sender);
  if (byMsg?.sender) return { partner: byMsg.sender.id, name: byMsg.sender.name };
  const lower = needle.toLowerCase();
  for (let i = timeline.length - 1; i >= 0; i--) {
    const s = timeline[i]?.sender;
    if (s?.name.toLowerCase().includes(lower)) return { partner: s.id, name: s.name };
  }
  for (const [id, met] of Object.entries(world.reach.met)) {
    if (met.scope !== scope) continue;
    const n = nameOf(world, id);
    if (n?.toLowerCase().includes(lower)) return { partner: id, name: n };
  }
  return { partner: null, name: needle };
}

function dmCheckResult(
  state: FairnessState,
  world: FairnessWorld,
  scope: string,
  chatType: "private" | "group",
  timeline: ReadonlyArray<{ messageId: string; sender: { id: string; name: string } | null }>,
  whoArg: string | null,
  now: number,
) {
  if (chatType === "private") {
    const partner = world.chats[scope]?.partner ?? unopenedPrivate(world).get(scope) ?? null;
    const name = partner ? (nameOf(world, partner) ?? partner) : null;
    const stats = groupDmStatsOf(state, world, partner, null, now);
    const hasPrivateChat = Boolean(
      world.chats[scope] &&
        (world.chats[scope].lastIncomingAt > 0 || world.chats[scope].lastAliceAt > 0),
    );
    const protocol = hasPrivateChat
      ? "你们已经有私聊来往了，正常聊天即可。"
      : stats.consented
        ? "对方刚才在群里接住并欢迎私聊，可以直接开口。"
        : stats.canDmDirectly
          ? "这个来源群对私聊接受度正常，可以直接轻声打个招呼。"
          : "这个群对未经招呼的突然私聊较防备（或刚私聊过同群成员）。外部协议建议：先别贸然私敲，调用 tools.plan_group_dm 留到来源群里先顺嘴问一句。";
    return {
      person: name,
      hasPrivateChat,
      sourceGroup: stats.groupTitle ?? stats.sourceGroup,
      agreedInGroup: stats.consented,
      groupDmStats: {
        attempts: stats.attempts,
        replied: stats.replied,
        blocked: stats.blocked,
        silent: stats.silent,
      },
      groupRejectionActive: stats.groupRejection >= REJECTED_LIVE,
      recentGroupColdDmAgo:
        stats.recentColdAt !== null && now >= stats.recentColdAt
          ? elapsed(now - stats.recentColdAt)
          : null,
      canDmDirectly: hasPrivateChat || stats.canDmDirectly,
      protocol,
    };
  }
  const { partner, name } = resolveGroupTarget(world, scope, timeline, whoArg);
  const dmScope = partner
    ? Object.entries(world.chats).find(([, c]) => c.partner === partner)?.[0]
    : undefined;
  const hasPrivateChat = Boolean(
    dmScope &&
      world.chats[dmScope] &&
      (world.chats[dmScope].lastIncomingAt > 0 || world.chats[dmScope].lastAliceAt > 0),
  );
  const stats = groupDmStatsOf(state, world, partner, scope, now);
  const protocol = hasPrivateChat
    ? "你们之前已经有过私聊往来，想单独聊时可以直接去私聊。"
    : stats.consented
      ? "对方刚才在群里顺着答应/欢迎私聊了，可以转到私聊接着说。"
      : stats.canDmDirectly
        ? "这个群对私聊接受度正常，可以直接私聊，也可以顺手在群里提一句。"
        : "这个群对突然私聊偏防备（近期有被隐私挡住/未回或刚私聊过同群成员）。若想单独聊，建议先在当前群聊里顺口问一句对方方不方便私聊。";
  return {
    person: name,
    hasPrivateChat,
    sourceGroup: stats.groupTitle ?? scope,
    agreedInGroup: stats.consented,
    groupDmStats: {
      attempts: stats.attempts,
      replied: stats.replied,
      blocked: stats.blocked,
      silent: stats.silent,
    },
    groupRejectionActive: stats.groupRejection >= REJECTED_LIVE,
    recentGroupColdDmAgo:
      stats.recentColdAt !== null && now >= stats.recentColdAt
        ? elapsed(now - stats.recentColdAt)
        : null,
    canDmDirectly: hasPrivateChat || stats.canDmDirectly,
    protocol,
  };
}

function dmFacts(
  state: FairnessState,
  world: FairnessWorld,
  scope: string,
  chatType: "private" | "group",
  timelineLength: number,
  now: number,
): Contribution[] {
  const out: Contribution[] = [];
  if (chatType === "group") {
    const asks = (state.plannedGroupAsks?.[scope] ?? []).filter((p) => now - p.at < D);
    if (asks.length > 0) {
      out.push({
        mechanism: "fairness",
        kind: "doings",
        text: asks
          .map((a) => `我打算找机会在这里顺口问问 ${a.name} 方不方便私聊（${a.reason}）`)
          .join("\n"),
      });
    }
  }
  if (chatType === "private" && timelineLength === 0) {
    const partner = world.chats[scope]?.partner ?? unopenedPrivate(world).get(scope) ?? null;
    if (partner) {
      const stats = groupDmStatsOf(state, world, partner, null, now);
      const facts: string[] = [];
      if (stats.consented) {
        facts.push("对方刚才在群里接住并欢迎继续聊，这不是突兀的陌生私聊。");
      } else if (
        stats.attempts > 0 ||
        stats.groupRejection >= REJECTED_LIVE ||
        stats.recentColdAt !== null
      ) {
        const groupLabel = stats.groupTitle ? `「${stats.groupTitle}」群` : "这个群";
        const parts: string[] = [];
        if (stats.attempts > 0) {
          parts.push(
            `此前从${groupLabel}直接私聊过 ${stats.attempts} 次（${stats.replied} 次接着聊${stats.blocked > 0 ? `、${stats.blocked} 次被隐私挡住` : ""}${stats.silent > 0 ? `、${stats.silent} 次没回` : ""}）`,
          );
        }
        if (
          stats.recentColdAt !== null &&
          now >= stats.recentColdAt &&
          now - stats.recentColdAt < FIRST_DM.groupCoolTau
        ) {
          parts.push(`${elapsed(now - stats.recentColdAt)}前刚私聊过同群的另一个人`);
        }
        if (stats.groupRejection >= REJECTED_LIVE) {
          parts.push(`${groupLabel}此刻对你的气氛偏防备`);
        }
        if (parts.length > 0) facts.push(`${parts.join("；")}。`);
      }
      if (!stats.consented) {
        facts.push(
          "情境规范（初次私聊）：可先调用 tools.check_dm() 看这个群对突然私聊的接受度；若返回偏防备，别在私聊里硬敲，调用 tools.plan_group_dm({ reason }) 留到来源群里先顺口问一句。",
        );
      }
      if (facts.length > 0) {
        out.push({ mechanism: "fairness", kind: "scene", text: facts.join("\n") });
      }
    }
  }
  return out;
}

/**
 * 注意力公平与第一次私聊节奏（PLAN 第 45 件、ADR-218）：安静的私聊攒服务债、首次私聊按回复率自适应节奏、
 * 遇到 PEER_FLOOD 立即停开新私聊；按来源群自适应，第一次私聊前可以 check_dm / plan_group_dm。
 */
export const delegatedFairness: PressureFeature = {
  ...feature({
    name: "fairness",
    provides: ["fairness"],
    requires: ["chats", "relations", "willingness", "reach"],
    uses: ["chats.turn.rejection"],
    offers: (kind, scope, world) =>
      kind === "dm-defer" ? unopenedPrivate(world).has(scope) : true,
    query: (kind, args, chat, now, world) => {
      if (kind !== "dm-check") return undefined;
      const state = world.fairness ?? initialFairness;
      const who = typeof args.who === "string" && args.who.trim() ? args.who.trim() : null;
      return dmCheckResult(state, world, chat.scope, chat.chatType, chat.timeline, who, now);
    },
    reduce: (before, after, event) => {
      const prev = after.fairness ?? initialFairness;
      const next = reduceFairness(prev, before, event);
      return next === prev && after.fairness ? after : { ...after, fairness: next };
    },
    contribute: ({ world, chat, now }) =>
      dmFacts(
        world.fairness ?? initialFairness,
        world,
        chat.scope,
        chat.chatType,
        chat.timeline.length,
        now,
      ),
    will: {
      visible: (world, scope) => {
        const f = world.fairness;
        if (!f || !firstDmBlocked(f)) return true;
        return !isUnopenedPrivate(world, scope);
      },
      impositionScale: (world, chat, _affordance, now) => {
        const f = world.fairness;
        if (!f || chat.chatType !== "private" || !chat.partner) return 1;
        const scope = chatScope(world.chats, chat);
        return scope ? fairnessCostDiscount(f, world, scope, now) : 1;
      },
      cost: (world, chat, _affordance, now) => {
        const f = world.fairness;
        if (!f || chat.chatType !== "private" || !chat.partner) return 0;
        const scope = chatScope(world.chats, chat);
        return scope ? firstDmCost(f, world, scope, now) : 0;
      },
    },
  }),
  affordances: ["dm-check", "dm-defer"],
};

const scopeCache = new WeakMap<FairnessWorld["chats"], WeakMap<ChatNode, string>>();
function chatScope(chats: FairnessWorld["chats"], chat: ChatNode): string | undefined {
  let map = scopeCache.get(chats);
  if (!map) {
    map = new WeakMap<ChatNode, string>();
    for (const [s, c] of Object.entries(chats)) map.set(c, s);
    scopeCache.set(chats, map);
  }
  return map.get(chat);
}
