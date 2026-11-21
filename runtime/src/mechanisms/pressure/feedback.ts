/**
 * 她开口之后的结果，当下回到心里（ADR-276 环节五）。
 *
 * 三条回流里的两条在这里，都是纯函数、时间只来自事件：
 * - 回到心情：她说的被接住、被点了不是负面的表情，是一次"被接纳"的评价。推多少看意外——按这个群平时别人一轮
 *   被接的比例居中（Rutledge, Skandali, Dayan & Dolan 2014, PNAS：当下的快乐由最近几次"比预期好多少"加权）。
 *   安静、挑剔的群里有人接她，比人人都被接的群里推得暖。
 * - 回到想说的劲：她分享的那类东西在这个会话被接的口味。先验按 Beta（两次被接、两次没接），观测按会话和频道
 *   分开记；`scope:channel` 是键。被接抬一点，没人接轻轻降一点。
 *
 * 守 ADR-267：被接只是结构事实，暖不暖要另判。`message.perceived` 判出冷淡、敌意、`stop`/`hush`/`aloof` 时不推暖；
 * 判不出的只计结构，不推心情。没人接也不往下推心情（防 ADR-95 的反刍；代价那一侧已经由 world.ts 记了），这里
 * 从不产生负向评价。被拒照旧交给 rejection.ts。
 *
 * 心情和想不想说话的倍数在这里算出（PLAN 第 46 件）：只乘内在的劲（cooling、curiosity、information、prospect、
 * topic、bond），`attention`、`obligation`、`thread`、`aversion` 保持 1.0——她低落时照样回找她的人。
 */
import {
  type AliceEvent,
  type ChatType,
  type MessagePerceived,
  type MessageReceived,
  type MessageSent,
  NEGATIVE_REACTIONS,
  type ReactionReceived,
} from "../../mind/events.js";
import { valenceAt } from "./affect.js";
import { topShare } from "./desire.js";
import type { DriveKey } from "./drives.js";
import { feature, type PressureFeature } from "./feature.js";
import { RECEPTION_WINDOW, TURN_GAP, UPTAKE_LINK } from "./params.js";
import { usualUptake } from "./world.js";

/** "在场的人"记最近几个发言人（和 affect.ts 同一口径）。 */
const PRESENT_KEPT = 30;
/** 还在等判口气的接话最多记几条（状态有界；正常情况下窗口一过就会被清掉）。 */
const PENDING_KEPT = 40;

/**
 * 分享口味的 Beta 先验：两次被接、两次没接，均值 1/2。归一化让没有观测时正好是 1.0。
 * 一条被接的分享把倍数抬到 1.2，一条没人接的降到 0.8，观测多了才按这个会话自己的样子走。
 */
const TASTE_PRIOR = { alpha: 2, beta: 2 } as const;
/** 口味倍数的上下界：再好的频道也不让分享欲翻倍以上，再冷也留一点。 */
export const TASTE_MIN = 0.4;
export const TASTE_MAX = 1.6;

/** 一次"被接纳"最多推暖多少；实际推多少再乘意外（1 − usualUptake）。 */
export const MOOD_LIFT_MAX = 0.7;
/** 意外的最低值：一个人人都被接的群里被接仍有一点暖，不是零。 */
const SURPRISE_FLOOR = 0.1;

/**
 * 正面情感和外向行为的组内斜率：Sun et al. 2017 为 0.46，Fleeson et al. 2002 为 0.66，取中点。
 * 倍数从这条斜率推，不手设（ADR-276 环节二）。
 */
const AFFECT_SLOPE = (0.46 + 0.66) / 2;
/** 想不想说话和心情同属趋近系统，life.ts 用同一个相关（SOCIAL_MOOD_RHO）。 */
const SOCIAL_MOOD_RHO = 0.5;
/** 内在的劲的倍数护栏（BIBO 安全：心情再偏，也不让意愿层失去有界性）。 */
export const INTRINSIC_GAIN_MIN = 0.65;
export const INTRINSIC_GAIN_MAX = 1.45;

/** 只乘心情/想不想说话的内在的劲。 */
export const INTRINSIC_DRIVES: readonly DriveKey[] = [
  "cooling",
  "curiosity",
  "information",
  "prospect",
  "topic",
  "bond",
];
/** 来自别人、不能因她低落而变小的几项：有人在等她时她照样回。 */
export const EXTRINSIC_DRIVES: readonly DriveKey[] = [
  "attention",
  "obligation",
  "thread",
  "aversion",
];

/** 一个 `scope:channel` 的观测：被接了几次、总共几次。 */
export interface ChannelTaste {
  pos: number;
  total: number;
}

/** 一次"被接纳"：supervisor 把它交给 affect.ts 的评价入口。 */
export interface FeedbackAppraisal {
  word: "被接纳";
  /**
   * 这次往暖里推的增量，(0, MOOD_LIFT_MAX]。
   * 和 affect.ts 的 appraise 不同，这里给的是增量：那边收到的是"推到的效价"。接线时用
   * `valenceAt(state, at) + appraisal.valence`（或等价的推法），这样高心情时不会被意外小的增量拉低。
   */
  valence: number;
  why: string;
  scope: string;
  /** 那个会话里在场的人（私聊是对方，群里是最近说话的人）。 */
  present: readonly string[];
  /** 接住她的人；表情事件没有给名字时是 null。 */
  by: string | null;
  /** 她说的那一条（她那一轮的最后一条）。 */
  turnId: string;
  /** 接住她的那条；表情时没有。 */
  replyId: string | null;
  at: number;
}

/** 她刚开口、还在等反应的那一轮（每个会话一条；一轮里连着说的几条共用）。 */
export interface FeedbackOpenTurn {
  /** 已知的会话类型；`message.sent` 自己不带，按之前收到的消息记，不知道时按群处理。 */
  chatType: ChatType;
  /** 这一轮最后一条她的话的时刻（等反应的窗口从这里算）。 */
  at: number;
  /** 这一轮她说的消息编号。 */
  ids: readonly string[];
  /** 这一轮分享的是哪个频道的东西（给了才学口味）。 */
  channel?: string;
}

/** 已经有人接、还在等判口气的一条接话。 */
export interface FeedbackPendingTone {
  scope: string;
  chatType: ChatType;
  /** 她那一轮的最后一条消息（收到口气后把它那一轮关掉）。 */
  turnId: string;
  /** 接她的那条消息（`message.perceived` 按这个编号找过来）。 */
  messageId: string;
  by: string | null;
  byName: string | null;
  at: number;
  /** 接话时这个群平时别人一轮被接的比例（world.ts usualUptake），在这里冻住。 */
  usual: number;
  /** 这一轮若分享自某频道：判出接纳时学口味。 */
  channel?: string;
}

/** 会话的样子：只记评价要用的一点点（群名、在场的人）。 */
export interface FeedbackChatMemory {
  chatType: ChatType;
  title: string | null;
  present: readonly string[];
}

/**
 * 回流的状态。`open` 是还在等反应的那一轮，`pending` 是已接上、等口气的接话，`taste` 是分享口味，
 * `boost` 是这次事件刚判出来的一次正向评价（下一次折叠清掉，supervisor 只在事件后读一次）。
 */
export interface ReceptionFeedbackState {
  open: Readonly<Record<string, FeedbackOpenTurn>>;
  pending: Readonly<Record<string, FeedbackPendingTone>>;
  taste: Readonly<Record<string, ChannelTaste>>;
  chats: Readonly<Record<string, FeedbackChatMemory>>;
  boost: FeedbackAppraisal | null;
}

export const initialFeedback: ReceptionFeedbackState = {
  open: {},
  pending: {},
  taste: {},
  chats: {},
  boost: null,
};

/** 接线时这一条事件能提供的东西；不给时按世界层的先验。 */
export interface FeedbackContext {
  /** 她这条 `message.sent` 分享的是哪个频道的东西（desire.ts topShare().item.channel）。 */
  channel?: string;
  /** 这个会话的类型（world.chats[scope].chatType）；`message.sent` 自己不带，不知道时按群处理。 */
  chatType?: ChatType;
  /** 此刻这个会话平时别人一轮被接的比例（world.ts usualUptake(chat, now)）；不给是 0.5。 */
  usualUptake?: number;
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

const numberOr = (x: number | undefined, fallback: number): number =>
  typeof x === "number" && Number.isFinite(x) ? x : fallback;

/** `world.ts` 的 usualUptake 落在 [0, 1]；接线方没给时用先验 1/2。 */
function usualUptakeOf(value: number | undefined): number {
  return clamp(numberOr(value, 0.5), 0, 1);
}

/**
 * 意外：这个群平时别人一轮被接的比例越低，一次被接越意外。下限 0.1，免得人人被接的群里被接变成零。
 * 和 world.ts welcomeGain 的 `−(1 − p)` 是同一个形状（ADR-276 环节五，PLAN 第 43 件）。
 */
function surpriseOf(usual: number): number {
  return Math.max(SURPRISE_FLOOR, 1 - usualUptakeOf(usual));
}

/** 分享口味的键。会话 id 里本来就有冒号，但频道名不会，拼起来仍唯一。 */
const tasteKey = (scope: string, channel: string): string => `${scope}:${channel}`;

/** 待判口气的键：Telegram 的消息编号按会话各自数，不同会话会撞，带上 scope。 */
const pendingKey = (scope: string, messageId: string): string => `${scope}:${messageId}`;

/**
 * 一个频道在这个会话里的口味倍数。没有观测时是 1.0；Beta 后验除以先验均值，夹在 [TASTE_MIN, TASTE_MAX]。
 * 被接抬一点、没人接降一点，观测越多越按这个会话自己的样子（贝叶斯收缩）。
 */
export function shareTaste(
  state: Pick<ReceptionFeedbackState, "taste">,
  scope: string,
  channel: string,
): number {
  const t = state.taste[tasteKey(scope, channel)];
  const { alpha, beta } = TASTE_PRIOR;
  const prior = alpha / (alpha + beta);
  const posterior = (alpha + (t?.pos ?? 0)) / (alpha + beta + (t?.total ?? 0));
  return clamp(posterior / prior, TASTE_MIN, TASTE_MAX);
}

/** 记一次口味观测；不改原状态。 */
function withTaste(
  taste: Readonly<Record<string, ChannelTaste>>,
  scope: string,
  channel: string,
  positive: boolean,
): Readonly<Record<string, ChannelTaste>> {
  const key = tasteKey(scope, channel);
  const prev = taste[key] ?? { pos: 0, total: 0 };
  return {
    ...taste,
    [key]: { pos: prev.pos + (positive ? 1 : 0), total: prev.total + 1 },
  };
}

/** 推暖的理由：带具体的人或群，不说"被接纳了"这种系统词（ADR-210）。 */
function acceptedWhy(o: {
  chatType: ChatType;
  title: string | null;
  byName: string | null;
  emoji?: string;
}): string {
  const tail = o.emoji ? `有人接住了，点了${o.emoji}` : "有人接住了";
  if (o.chatType === "group") {
    return o.title ? `在「${o.title}」群里说的话${tail}` : `在群里说的话${tail}`;
  }
  return o.byName ? `「${o.byName}」接住了我的话` : "有人接住了我的话";
}

/** 一次正向评价；推的增量由意外定。 */
function appraisalOf(o: {
  scope: string;
  chatType: ChatType;
  title: string | null;
  by: string | null;
  byName: string | null;
  emoji?: string;
  usual: number;
  turnId: string;
  replyId: string | null;
  at: number;
  present: readonly string[];
}): FeedbackAppraisal {
  return {
    word: "被接纳",
    valence: MOOD_LIFT_MAX * surpriseOf(o.usual),
    why: acceptedWhy({
      chatType: o.chatType,
      title: o.title,
      byName: o.byName,
      ...(o.emoji ? { emoji: o.emoji } : {}),
    }),
    scope: o.scope,
    present: o.present,
    by: o.by,
    turnId: o.turnId,
    replyId: o.replyId,
    at: o.at,
  };
}

/** 只留最近的 PENDING_KEPT 条，状态有界。 */
function trimPending(
  pending: Record<string, FeedbackPendingTone>,
): Record<string, FeedbackPendingTone> {
  const entries = Object.entries(pending);
  return entries.length <= PENDING_KEPT
    ? pending
    : Object.fromEntries(entries.slice(-PENDING_KEPT));
}

/**
 * 窗口过了：没人接的那一轮不再等，分享口味轻轻降一点（ADR-95 的反刍只防心情，不防这一笔）；
 * 一直没等到口气的接话也丢掉（判不出的只计结构，不推心情）。
 */
function settle(state: ReceptionFeedbackState, at: number): ReceptionFeedbackState {
  let changed = false;
  let taste = state.taste;
  const open: Record<string, FeedbackOpenTurn> = {};
  for (const [scope, turn] of Object.entries(state.open)) {
    if (at - turn.at > RECEPTION_WINDOW[turn.chatType]) {
      changed = true;
      const turnId = turn.ids[turn.ids.length - 1];
      if (turn.channel && !awaitsTone(state, scope, turnId)) {
        taste = withTaste(taste, scope, turn.channel, false);
      }
    } else {
      open[scope] = turn;
    }
  }
  const pending = Object.fromEntries(
    Object.entries(state.pending).filter(([, p]) => {
      const keep = at - p.at <= RECEPTION_WINDOW[p.chatType];
      if (!keep) changed = true;
      return keep;
    }),
  );
  return changed ? { ...state, open, pending, taste } : state;
}

/** 关掉一个会话里等着的那一轮。 */
function closeOpen(state: ReceptionFeedbackState, scope: string): ReceptionFeedbackState {
  if (!(scope in state.open)) return state;
  const { [scope]: _, ...rest } = state.open;
  return { ...state, open: rest };
}

/** 只关掉指的是这一轮的那条；口气晚到时她已经在这里说了新的一句就不动新的一轮。 */
function closeTurn(
  state: ReceptionFeedbackState,
  scope: string,
  turnId: string,
): ReceptionFeedbackState {
  const turn = state.open[scope];
  return turn?.ids.includes(turnId) ? closeOpen(state, scope) : state;
}

/** 同一个会话里同一条她的话（一轮）留下的待判。 */
const sameTurn = (p: FeedbackPendingTone, scope: string, turnId: string): boolean =>
  p.scope === scope && p.turnId === turnId;

/** 这一轮还有口气没判：先不把这一件分享算成没人接。 */
function awaitsTone(state: ReceptionFeedbackState, scope: string, turnId: string): boolean {
  return Object.values(state.pending).some((p) => sameTurn(p, scope, turnId));
}

/** 收掉某一轮的全部待判（一轮只认一次）。 */
function withoutTurn(
  pending: Readonly<Record<string, FeedbackPendingTone>>,
  scope: string,
  turnId: string,
): Record<string, FeedbackPendingTone> {
  return Object.fromEntries(Object.entries(pending).filter(([, p]) => !sameTurn(p, scope, turnId)));
}

/** ADR-267：判出来的友好或中性才算暖；叫停、嫌弃、敌意算冷；判不出是 null（只计结构）。 */
function toneVerdict(event: MessagePerceived): "warm" | "cold" | null {
  if (
    event.stop ||
    event.hush ||
    event.aloof ||
    event.tone === "cold" ||
    event.tone === "hostile"
  ) {
    return "cold";
  }
  return event.tone === "friendly" || event.tone === "neutral" ? "warm" : null;
}

/**
 * 折叠一个事件。它只读事件和接线时给的上下文，时钟只来自 `event.at`；同一个事件日志回放出同样的结果。
 * `context.channel` 只在 `message.sent` 上读，`context.usualUptake` 在接住她的那条事件上读。
 */
export function reduceFeedback(
  state: ReceptionFeedbackState,
  event: AliceEvent,
  context: FeedbackContext = {},
): ReceptionFeedbackState {
  const settled = settle(state, event.at);
  // 上一次事件的正向评价只活到下一次折叠：supervisor 折完一个事件就读一次。
  const base: ReceptionFeedbackState = settled.boost ? { ...settled, boost: null } : settled;

  switch (event.type) {
    case "message.sent":
      return onMessageSent(base, event, context);

    case "message.received":
      return onMessageReceived(base, event, context);

    case "message.perceived":
      return onMessagePerceived(base, event);

    case "reaction.received":
      return onReactionReceived(base, event, context);

    default:
      return base;
  }
}

/** 她开口：记下这一轮（连着说的几条共用），分享时带上频道。 */
function onMessageSent(
  state: ReceptionFeedbackState,
  event: MessageSent,
  context: FeedbackContext,
): ReceptionFeedbackState {
  const prev = state.open[event.scope];
  // 连着说的几条算同一轮；隔开 TURN_GAP 就是新的一轮。
  const same = prev !== undefined && event.at - prev.at <= TURN_GAP ? prev : undefined;
  const ids = same ? [...same.ids, event.messageId] : [event.messageId];
  const channel = context.channel ?? same?.channel;
  const turn: FeedbackOpenTurn = {
    chatType: state.chats[event.scope]?.chatType ?? context.chatType ?? "group",
    at: event.at,
    ids,
    ...(channel ? { channel } : {}),
  };
  return { ...state, open: { ...state.open, [event.scope]: turn } };
}

/** 最近说话的几个人（同一个人只算一次，旧的先掉）。 */
function addPresent(present: readonly string[], senderId: string): readonly string[] {
  return [...present.filter((id) => id !== senderId), senderId].slice(-PRESENT_KEPT);
}

/** 会话的样子跟着进来的消息走；在场的人是最近说话的。 */
function rememberChat(
  prev: FeedbackChatMemory | undefined,
  event: MessageReceived,
): FeedbackChatMemory {
  return {
    chatType: event.chatType,
    title: event.chatTitle ?? prev?.title ?? null,
    present:
      event.chatType === "private"
        ? [event.senderId]
        : addPresent(prev?.present ?? [], event.senderId),
  };
}

/**
 * 有人说话。回复、点名、私聊里的回答接上了她那一轮，等口气；
 * 群里紧挨着她的"接着说"（Elsner & Charniak 的 129 秒）也是结构上的 taken，但判不出口气就不推心情。
 */
function onMessageReceived(
  state: ReceptionFeedbackState,
  event: MessageReceived,
  context: FeedbackContext,
): ReceptionFeedbackState {
  const next: ReceptionFeedbackState = {
    ...state,
    chats: { ...state.chats, [event.scope]: rememberChat(state.chats[event.scope], event) },
  };
  const turn = next.open[event.scope];
  if (!turn) return next;
  const replies = event.replyToMessageId !== null && turn.ids.includes(event.replyToMessageId);
  const directed = event.directed || event.chatType === "private";
  if (!replies && !directed && event.at - turn.at > UPTAKE_LINK) return next;

  const turnId = turn.ids[turn.ids.length - 1] ?? event.messageId;
  const key = pendingKey(event.scope, event.messageId);
  const pending: FeedbackPendingTone = {
    scope: event.scope,
    chatType: event.chatType,
    turnId,
    messageId: event.messageId,
    by: event.senderId,
    byName: event.senderName,
    at: event.at,
    usual: usualUptakeOf(context.usualUptake),
    ...(turn.channel ? { channel: turn.channel } : {}),
  };
  if (!replies && !directed) {
    return { ...next, pending: trimPending({ ...next.pending, [key]: pending }) };
  }
  // 接上了：这一轮只认这一条接话的口气。
  return {
    ...closeOpen(next, event.scope),
    pending: trimPending({ ...withoutTurn(next.pending, event.scope, turnId), [key]: pending }),
  };
}

/** 口气晚到：暖才推心情；冷只收掉待判并让分享口味降一点；判不出什么都不做。 */
function onMessagePerceived(
  state: ReceptionFeedbackState,
  event: MessagePerceived,
): ReceptionFeedbackState {
  const pending = state.pending[pendingKey(event.scope, event.messageId)];
  if (!pending) return state;
  const verdict = toneVerdict(event);
  if (verdict === null) return state;

  let next = closeTurn(
    { ...state, pending: withoutTurn(state.pending, pending.scope, pending.turnId) },
    pending.scope,
    pending.turnId,
  );
  if (pending.channel) {
    next = {
      ...next,
      taste: withTaste(next.taste, pending.scope, pending.channel, verdict === "warm"),
    };
  }
  if (verdict === "cold") return next;

  const memo = next.chats[pending.scope];
  return {
    ...next,
    boost: appraisalOf({
      scope: pending.scope,
      chatType: pending.chatType,
      title: memo?.title ?? null,
      by: pending.by,
      byName: pending.byName,
      usual: pending.usual,
      turnId: pending.turnId,
      replyId: pending.messageId,
      at: event.at,
      present: memo?.present ?? (pending.by ? [pending.by] : []),
    }),
  };
}

/** 表情落在我等反应的那条话上：不是负面的就算被接纳；负面的只收掉那一轮。 */
function onReactionReceived(
  state: ReceptionFeedbackState,
  event: ReactionReceived,
  context: FeedbackContext,
): ReceptionFeedbackState {
  const turn = state.open[event.scope];
  if (!turn || !turn.ids.includes(event.messageId)) return state;
  const negative = NEGATIVE_REACTIONS.has(event.emoji);
  const turnId = turn.ids[turn.ids.length - 1] ?? event.messageId;
  let next = closeOpen(
    { ...state, pending: withoutTurn(state.pending, event.scope, turnId) },
    event.scope,
  );
  if (turn.channel) {
    next = {
      ...next,
      taste: withTaste(next.taste, event.scope, turn.channel, !negative),
    };
  }
  if (negative) return next;

  const memo = next.chats[event.scope];
  const present = event.senderId
    ? addPresent(memo?.present ?? [], event.senderId)
    : (memo?.present ?? []);
  return {
    ...next,
    boost: appraisalOf({
      scope: event.scope,
      chatType: turn.chatType,
      title: memo?.title ?? null,
      by: event.senderId,
      byName: null,
      emoji: event.emoji,
      usual: usualUptakeOf(context.usualUptake),
      turnId,
      replyId: null,
      at: event.at,
      present,
    }),
  };
}

/**
 * 这次事件刚判出来的一次正向评价；没有就是 null。下一次折叠会清掉它，所以每次事件后读一次。
 */
export function pendingMoodBoost(state: ReceptionFeedbackState): FeedbackAppraisal | null {
  return state.boost;
}

/**
 * 心情和想不想说话经内在的劲乘进意愿（PLAN 第 46 件）。从组内斜率推：`1 + 0.56·效价`，再夹到
 * [0.65, 1.45]。高心情让内在的冲动更容易胜过代价，低落时更安静；有界，不会把意愿层推出界（BIBO）。
 *
 * `socialOu` 是想不想说话相对她常态的偏离（life.ts 的 warmth，0 是她平时）；给了时按同一个趋近系统
 * 加上 0.5 倍。默认 0，只看心情。
 */
export function intrinsicGain(affectValence: number, socialOu = 0): number {
  const valence = clamp(numberOr(affectValence, 0), -1, 1);
  const social = clamp(numberOr(socialOu, 0), -3, 3);
  return clamp(
    1 + AFFECT_SLOPE * valence + SOCIAL_MOOD_RHO * social,
    INTRINSIC_GAIN_MIN,
    INTRINSIC_GAIN_MAX,
  );
}

/** 意愿层的缓解项（will.ts reliefTerms 的一项）。 */
export type ReliefTerm = readonly [DriveKey, number];

/** `splitRelief` 的结果：乘过 `gain` 的项、内在与外在各自的和、总数。 */
export interface SplitRelief {
  /** 内在的项已经乘过 gain，外在的保持原值。 */
  terms: readonly ReliefTerm[];
  /** 内在的劲之和（已乘 gain）。 */
  intrinsic: number;
  /** 义务、回避等外来的劲之和（不乘 gain）。 */
  extrinsic: number;
  /** 两者之和，就是意愿里减代价之前的 relief。 */
  total: number;
  /** 实际用上的倍数。 */
  gain: number;
}

/**
 * 把 `gain` 只乘在内在的劲上（ADR-276 环节二）：`cooling`、`curiosity`、`information`、`prospect`、`topic`、
 * `bond` 乘，`attention`、`obligation`、`thread`、`aversion` 保持 1.0。有人在等她时她照样回，低落也不会让她
 * 看不见别人的请求。
 */
export function splitRelief(
  terms: readonly ReliefTerm[],
  intrinsicKeys: readonly DriveKey[] = INTRINSIC_DRIVES,
  gain = 1,
): SplitRelief {
  const factor = numberOr(gain, 1);
  const intrinsicKeysSet = new Set(intrinsicKeys);
  let intrinsic = 0;
  let extrinsic = 0;
  const scaled: ReliefTerm[] = terms.map(([key, value]) => {
    if (!intrinsicKeysSet.has(key)) {
      extrinsic += value;
      return [key, value] as const;
    }
    const lifted = value * factor;
    intrinsic += lifted;
    return [key, lifted] as const;
  });
  return { terms: scaled, intrinsic, extrinsic, total: intrinsic + extrinsic, gain: factor };
}

/**
 * 正向回流（ADR-276 环节二、五）：开口后被暖心地接住，推暖心情、记住频道口味；心情推内在的劲（不影响义务）。
 * 组成里要读 chats、affect（amends affect，在 affect 之后折叠）和可选 posts（分享口味）。
 */
export const positiveLoop: PressureFeature = feature({
  name: "positive-loop",
  provides: ["feedback"],
  requires: ["chats"],
  uses: ["posts", "life", "relations", "affect"],
  reduce: (before, after, event) => {
    const prev = after.feedback ?? initialFeedback;
    let context: FeedbackContext = {};
    if (event.type === "message.sent") {
      const chat = before.chats[event.scope];
      const share = before.posts ? topShare(before, event.scope, event.at) : null;
      context = {
        ...(chat ? { chatType: chat.chatType } : {}),
        ...(share ? { channel: share.item.channel } : {}),
      };
    } else if (event.type === "message.received" || event.type === "reaction.received") {
      const chat = before.chats[event.scope];
      context = chat ? { usualUptake: usualUptake(chat, event.at) } : {};
    }
    const next = reduceFeedback(prev, event, context);
    return next === prev && after.feedback ? after : { ...after, feedback: next };
  },
  will: {
    intrinsicGain: (world, _reading, now) => {
      const valence = valenceAt(world.affect, now);
      const social = world.life?.social ?? 0;
      return intrinsicGain(valence, social);
    },
  },
});
