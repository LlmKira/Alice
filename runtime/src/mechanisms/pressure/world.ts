/**
 * 世界层：从事件 fold 出的实体图（论文 §2 Ontology 的子集），纯函数，时间只来自 event.at。
 * 实体：会话（channel）、线程（thread，只从环境确定性地推出：别人对她说的话停在那里、她没接）、她每次开口得到的
 * 反应（reception），以及她自己记下的事实、承诺、跟着的事（memory.ts）。关于人的事实（名字、看见的、有往来、
 * 亲近、回避）不在这里：只有 relation fold 进 relations（relation.ts）。这里另留意愿层自己的结局（willingness：
 * 想过、决定先不找他）。
 * 压力场的各样东西（feature.ts）各自 fold 自己的那几块：心情（affect）、生活（life）、够得着的地方和频道里看到的
 * 帖子（reach，P2 信息的来源）、关于人和群记得的事（people）。
 * 这里只记"发生了什么"，不算压力。
 */
import {
  affordanceOf,
  isSilent,
  leaves,
  memberAfter,
  type PostKind,
} from "../../mind/affordances.js";
import { type AliceEvent, type ChatType, NEGATIVE_REACTIONS } from "../../mind/events.js";
import type { TimelineEntry } from "../../mind/state.js";
import type { MissedState } from "../missed.js";
import { type AffectState, initialAffect } from "./affect.js";
import type { AttachmentState } from "./attachment.js";
import type { PostsState } from "./desire.js";
import type { DiaryEntry } from "./diary.js";
import type { FairnessState } from "./fairness.js";
import type { ReceptionFeedbackState } from "./feedback.js";
import { isGroupAttentionWorthy } from "./group-filter.js";
import { emptyLife, type LifeState } from "./life.js";
import type { Commitments, Fact, Topic } from "./memory.js";
import {
  AVERSION_GAIN,
  AVERSION_TAU,
  COST_WINDOW,
  GAP_EMA_ALPHA,
  GROUP_ABSENCE_ROUNDS,
  GROUP_THETA_COLD,
  GROUP_THETA_MAX,
  GROUP_THETA_MIN,
  GROUP_TIER,
  HABITUATION_TAU,
  NOVELTY_TAU,
  OBLIGATION_HALF_LIFE,
  RECEPTION_WINDOW,
  SAT,
  SIGMA_HALF_COUNT,
  THREAD_WEIGHT,
  type Tier,
  TURN_GAP,
  TURN_WINDOW,
  UNREAD_HALF_LIFE,
  UPTAKE_LINK,
} from "./params.js";
import type { PhoneState } from "./phone.js";
import type { ReachState } from "./reach.js";
import {
  emptyRelations,
  familiarityTier,
  type RelationsState,
  rankedTier,
  relationView,
  type Willingness,
} from "./relation.js";

/** 会话里还记着的别人的消息（affordance"有没有可回应的消息"用）。 */
const RECENT_IDS = 30;
const RECENT_RECEPTIONS = 20;

/**
 * 她开口之后得到的反应：有人接（回复她、点名她，私聊里对方说话，在她的话上点了正面或中性的表情）、群里有人
 * 接着她的话说（taken：没回复、没点名，按北极星"接她"的口径紧挨着她、或她刚接的那个人接着说；不算有人找她，
 * 不续关系，PLAN 第 43 件）、窗口内别人继续
 * 说话却没人理她、窗口内根本没人说话、被拒绝（踢出、拉黑，或可插拔分类器判定的明确拒绝）、被嫌弃（cold：她的话上
 * 被点了负面表情，NEGATIVE_REACTIONS，一次轻的拒绝）。
 */
type ReceptionKind = "replied" | "taken" | "ignored" | "unheard" | "rejected" | "cold";

export interface Reception {
  at: number;
  /** 她那次开口的时刻。 */
  turnAt: number;
  kind: ReceptionKind;
  /** 回应她的人（replied 时）。 */
  by: string | null;
  /** 那次是她主动开口（没人找她）。 */
  proactive?: boolean;
  /** 回应是一个表情。 */
  emoji?: string;
}

/** 她最近一次开口，还在等反应。 */
interface Awaiting {
  turnAt: number;
  ids: string[];
  /** 之后别人说了几条与她无关的话。 */
  others: number;
  proactive?: boolean;
  /** 她这一轮接的是谁：她开口前 UPTAKE_LINK 内紧挨着的那条是谁说的（那个人接着说，也算接她）。 */
  to?: string;
}

/** 一条没接的话（论文 Def P4 的线程，从环境推出）。 */
interface Thread {
  openedAt: number;
  weight: number;
}

export interface ChatNode {
  chatType: ChatType;
  /** 她是否还在这个会话里（退群、加群由 act.done 改变）。 */
  member: boolean;
  /** 私聊的对方。 */
  partner: string | null;
  /** 见过的别人的消息数（陌生环境的不确定性）。 */
  seen: number;
  recentIds: string[];
  /** recentIds 每条的发言人（她写的编号指向谁；群里最近说话的人）。 */
  recentFrom: string[];
  unread: number;
  /** 未读的指数加权滑动和（ADR-150），ewmsAt 时刻的值。 */
  ewms: number;
  ewmsAt: number;
  lastIncomingAt: number;
  lastAliceAt: number;
  /** 上一次"有回应的互动"：有人回复或点名她（群聊存在感从这里算）。 */
  lastBondAt: number;
  /** 她上一次没人找她时想过要不要说、决定先不（群聊存在感从这里重新长起）。 */
  consideredAt: number;
  /** 上一条消息的时刻和平均间隔（事件时间上的 EMA），即会话自己的节奏。 */
  lastAnyAt: number;
  gapEma: number | null;
  pending: number;
  lastDirectedAt: number;
  thread: Thread | null;
  awaiting: Awaiting | null;
  receptions: Reception[];
  /**
   * 这个群平时别人的一轮有多少被人接（北极星"接她"的同一个口径），淡掉的计数：她在这里受不受欢迎和它比（PLAN 第 43 件）。
   * credited：最近这一轮已经算过被接了。
   */
  usual: { turns: number; taken: number; at: number; credited: boolean };
  /**
   * 群里每个人（和她）最近说了几轮，按 VOICE_HALF_LIFE 淡掉的计数（at 时刻的值）：她的轮次份额和这个群自己说得最多的
   * 那四分之一人比（turn.ts shareBand，PLAN 第 43 件）。
   */
  voices: { by: Readonly<Record<string, number>>; her: number; at: number };
  /** 回避 A（ADR-217），aversionAt 时刻的值；对方来找她不清零，只随时间消退。 */
  aversion: number;
  aversionAt: number;
  /** 她上一次在这里做了决定、没有离开：想离开的冲动从这里重新长起（回避本身不变）。 */
  stayedAt: number;
  /** 对方没回时她连发的条数（σ_out），对方一说话归零。 */
  outgoing: number;
  outgoingAt: number;
  /** 连续选择沉默或失败的次数（σ_fail），她说出话或被点名时归零。 */
  silences: number;
  silencesAt: number;
  /** habituation H(v)（论文 §3 Habituation，ADR-222）。 */
  habit: number;
  habitAt: number;
  /** 她上一次主动开口（不是接话）的时刻（σ_cool）。 */
  lastProactiveAt: number;
  /** 她每一轮开口的时刻（σ_rate、互惠）。 */
  turns: number[];
  /** 别人说话的时刻（互惠）。 */
  incoming: number[];
  /**
   * 双方这阵子各投入了多少（投入度加权的互惠，will.ts socialCost 在 effortReciprocity 打开时读它）：她每一轮记 1，
   * 别人每条值得注意的话按字数记 0.25–1（effortWeight），at 时刻的值，按 COST_WINDOW 半衰期淡掉。旧状态没有。
   */
  effort?: { hers: number; theirs: number; at: number };
  /** 她在这个会话里答应或打算做的事（P_prospect，memory.ts）。 */
  commitments: Commitments;
  /** 她在这个会话里自己跟着的事（memory.ts Topic）；不进驱动，只作为事实放进提示词。 */
  topics: Topic[];
  /** 她找群时看过这个群的预览（reach.ts）：还没加入时，好奇心从这里来；没看过是 null。 */
  place: { seenAt: number } | null;
  /** 群里什么时候轮到她的信号（turn.ts）；没有那几样时一直是 NO_TURN。 */
  turn: TurnSignals;
  /** 群名（入站消息带的；别处知道的事注明出处时用，placeOf）。不知道时没有。 */
  title?: string;
  /** 意愿层临时合成的"还没开过的私聊"标记（reach.ts withUnopened，从不进持久状态）。 */
  unopened?: true;
}

/** 群里每条别人的话留下的拉力（topic、bond，各在自己的时刻的值，turn.ts）；她看过就清零。 */
export interface TurnSignals {
  topic: number;
  topicAt: number;
  bond: number;
  bondAt: number;
  /** 最近几条别人的话的词（算 idf 的背景，有界）。 */
  recent: readonly (readonly string[])[];
  /** 她在这段对话里（turn.ts dwell）：从哪一轮开口起、之后别人说了几条、怎么结束的。 */
  dwell: Dwell;
  /** 群里的人嫌她的程度（turn.ts rejection），按人记。 */
  rejection: Rejection;
}

/**
 * 群里的人嫌她的程度（turn.ts rejection）。people 按人记：level 是 at 时刻的值，之后按这个群自己的恢复时间淡掉；
 * since 是这一回从哪一刻起。那个人之后友好或中性地找她，或在她的话上点了不是负面的表情，就划掉，从 since 到这一刻
 * 记成这个群的一次恢复。heard、cold：这个群判过口气的找她的话有几条、其中几条是她不受欢迎的信号（这个群的常态）。
 */
export interface Rejection {
  people: Readonly<Record<string, { level: number; at: number; since: number }>>;
  heard: number;
  cold: number;
  /** 这个群里嫌她的人后来好好找她的次数、相隔的总时长。 */
  recovered: { n: number; ms: number };
}

export const NO_REJECTION: Rejection = {
  people: {},
  heard: 0,
  cold: 0,
  recovered: { n: 0, ms: 0 },
};

/** 一段她在里面的对话为什么结束：冷下来了、从她身边过去了、她看过决定不说。 */
export type DwellEnd = "cooled" | "passed-by" | "declined";

export interface Dwell {
  /** 这段对话里她第一次开口的时刻（0：还没有过）。 */
  from: number;
  /** 她最近一次开口之后别人说了几条。 */
  after: number;
  /** 结束的时刻和原因；还在里面时是 null。 */
  ended: { at: number; why: DwellEnd } | null;
}

export const NO_DWELL: Dwell = { from: 0, after: 0, ended: null };

export const NO_TURN: TurnSignals = {
  topic: 0,
  topicAt: 0,
  bond: 0,
  bondAt: 0,
  recent: [],
  dwell: NO_DWELL,
  rejection: NO_REJECTION,
};

export interface World {
  chats: Readonly<Record<string, ChatNode>>;
  /**
   * 意愿层自己的结局（"想过、决定先不找他"的 consideredAt 与连着几次）：不是关系，留在世界 base。
   * 关于人的事实（名字、看见的、有往来、亲近、回避）在 relations（relation.ts）。
   */
  willingness: Readonly<Record<string, Willingness>>;
  /** 全局 novelty 的指数滑动和（P6），noveltyAt 时刻的值。 */
  novelty: number;
  noveltyAt: number;
  /** 第一个事件的时刻（"认识多久了"）。 */
  firstAt: number;
  /** 她在所有会话里每一轮开口的时刻（行动密度）。 */
  turns: number[];
  /** 她上一次作出决定（在任何会话里，说或不说，或者只看了一眼）的时刻：节律从这里数（ADR-195）。 */
  lastCallAt: number;
  /** 她记得的事（反思时记下，people.ts），按主体（人的 id，或 chatSubject(群)）存放（memory.ts）。 */
  facts: Readonly<Record<string, Fact[]>>;
  /** 她的心情（affect.ts，DynAffect 式的效价和她的评价；只有这一份）。 */
  affect: AffectState;
  /** 她的日记（diary.ts）：她顺手写的（feb），或反思时写的（reflect）。 */
  diary: readonly DiaryEntry[];
  /** 每个会话里她经历了多少，自上次在那里反思起（只有 reflect 的日记写法 fold 它，diary.ts involve）。 */
  involvement: Readonly<Record<string, number>>;
  /** 她心里想过的（候选 feb-thought）：只有提供"想"能力时才会有。 */
  thoughts: readonly ThoughtLine[];
  /** 她自己最近说过的话（跨会话、只有文字、有界）：行动回声和群里拉力的话题有关（group-pull.ts）读它。 */
  said: readonly SaidLine[];
  /** 发言调用连续失败了几次、最后一次在何时（任何会话；一次成功的决定清零）：节律按它退避。 */
  callFailures: { count: number; at: number };
  // 下面几块各归压力场的一样东西（feature.ts）fold；组成里没有那一样时一直是空的。
  /** 她自己的生活（life.ts），从 noise.drawn fold。 */
  life: LifeState;
  /** 她够得着、但还没有会话的地方（reach.ts：在群里认识的人、看过预览的群、频道里看到的帖子）。 */
  reach: ReachState;
  /** 关于每个人的一条记录（relation.ts）：看见的事实、有往来、亲近、按人记的回避、在等她的人。 */
  relations: RelationsState;
  /** 她选 [去睡了] 的时刻（候选 bedtime.ts）；组成里没有那一样时没有这一项。 */
  bedAt?: number;
  /** 她上次看消息之后别处来了多少（missed.ts withMissed，作息那一格）；组成里没有时没有这一项。 */
  missed?: MissedState;
  /** 最近一天每个会话的原话（群聊记录 context.ts fold）；组成里没有那一样时没有这一项。 */
  transcript?: Readonly<Record<string, readonly TimelineEntry[]>>;
  /** 每个会话里她最后一次看过记录的时刻（context.ts 带回沉底的找她的话时用）；组成里没有时没有这一项。 */
  seenAt?: Readonly<Record<string, number>>;
  /** 她拿没拿着手机、今天花了多少（候选 phone.ts）；组成里没有那一样时没有这一项。 */
  phone?: PhoneState;
  /** 每个群不让她发的消息种类（chat.described，登记表 posts.as 的写法）；意愿层不为这些动作排分（ADR-276）。 */
  bans?: Readonly<Record<string, readonly PostKind[]>>;
  /** 她在频道里看到的东西、各会话最近在聊什么（desire.ts）；组成里没有那一样时没有这一项。 */
  posts?: PostsState;
  /** 开口后得到温暖接纳或冷淡的回流（候选 feedback.ts）；组成里没有时没有这一项。 */
  feedback?: ReceptionFeedbackState;
  /** 注意力公平与第一次私聊节奏（候选 fairness.ts）；组成里没有时没有这一项。 */
  fairness?: FairnessState;
  /** ADR-299 按人的牵挂引力与未消深疤（候选 attachment.ts）；组成里没有时没有这一项。 */
  attachment?: AttachmentState;
}

interface SaidLine {
  at: number;
  scope: string;
  text: string;
}

export interface ThoughtLine extends SaidLine {
  /** 群里写下时在场的人（presentIn）。thought 开着 carry 时记，私聊里写下的没有。 */
  present?: readonly string[];
  /** 她想的是别人托她保密的、明显私密的事（她写下时自己标的）：只守受众规则（diary.ts reaches）。 */
  private?: true;
}

/** 她自己的话留这么多行（约一天的量）。 */
const SAID_KEPT = 40;

export const emptyWorld: World = {
  chats: {},
  willingness: {},
  novelty: 0,
  noveltyAt: 0,
  firstAt: 0,
  turns: [],
  lastCallAt: 0,
  facts: {},
  affect: initialAffect,
  diary: [],
  involvement: {},
  thoughts: [],
  said: [],
  callFailures: { count: 0, at: 0 },
  life: emptyLife,
  reach: { met: {}, titles: {}, places: {}, info: [] },
  relations: emptyRelations,
};

export function freshChat(chatType: ChatType): ChatNode {
  return {
    chatType,
    member: true,
    partner: null,
    seen: 0,
    recentIds: [],
    recentFrom: [],
    unread: 0,
    ewms: 0,
    ewmsAt: 0,
    lastIncomingAt: 0,
    lastAliceAt: 0,
    lastBondAt: 0,
    consideredAt: 0,
    lastAnyAt: 0,
    gapEma: null,
    pending: 0,
    lastDirectedAt: 0,
    thread: null,
    awaiting: null,
    receptions: [],
    usual: { turns: 0, taken: 0, at: 0, credited: false },
    voices: { by: {}, her: 0, at: 0 },
    aversion: 0,
    aversionAt: 0,
    stayedAt: 0,
    outgoing: 0,
    outgoingAt: 0,
    silences: 0,
    silencesAt: 0,
    habit: 0,
    habitAt: 0,
    lastProactiveAt: 0,
    turns: [],
    incoming: [],
    effort: { hers: 0, theirs: 0, at: 0 },
    commitments: { open: [], closed: [] },
    topics: [],
    place: null,
    turn: NO_TURN,
  };
}

export const halfLife = (value: number, age: number, half: number): number =>
  age <= 0 ? value : value * 2 ** (-age / half);
export const efold = (value: number, age: number, tau: number): number =>
  age <= 0 ? value : value * Math.exp(-age / tau);
const within = (times: readonly number[], now: number, window: number): number[] =>
  times.filter((t) => now - t < window);

/** 一条话算足一份投入的实质字数（去掉空白）。手设：一句完整的话。 */
const EFFORT_FULL_CHARS = 12;
/** 一条话最少算的投入：纯贴纸、没字的媒体、"1"。 */
const EFFORT_MIN = 0.25;

/** 别人一条话的投入：够长或在问她就是一整份，短的按字数，没字的算最少的一份。 */
export function effortWeight(text: string | null): number {
  const chars = [...(text ?? "").replace(/\s+/gu, "")].length;
  if (chars === 0) return EFFORT_MIN;
  if (chars >= EFFORT_FULL_CHARS || /[?？]/u.test(text ?? "")) return 1;
  return Math.min(1, Math.max(EFFORT_MIN, chars / EFFORT_FULL_CHARS));
}

/** 淡掉之后此刻双方的投入。 */
export function effortAt(c: ChatNode, at: number): { hers: number; theirs: number } {
  const e = c.effort ?? { hers: 0, theirs: 0, at };
  return {
    hers: halfLife(e.hers, at - e.at, COST_WINDOW),
    theirs: halfLife(e.theirs, at - e.at, COST_WINDOW),
  };
}

function withEffort(c: ChatNode, at: number, hers: number, theirs: number): ChatNode["effort"] {
  const now = effortAt(c, at);
  return { hers: now.hers + hers, theirs: now.theirs + theirs, at };
}

/** 窗口内的次数。 */
export function countIn(times: readonly number[], now: number, window: number): number {
  return times.filter((t) => t <= now && now - t < window).length;
}

export function aversionAt(chat: ChatNode, now: number): number {
  return efold(chat.aversion, now - chat.aversionAt, AVERSION_TAU[chat.chatType]);
}

function withRhythm(c: ChatNode, at: number): ChatNode {
  if (c.lastAnyAt <= 0 || at <= c.lastAnyAt) return { ...c, lastAnyAt: Math.max(c.lastAnyAt, at) };
  const gap = at - c.lastAnyAt;
  const gapEma = c.gapEma === null ? gap : GAP_EMA_ALPHA * gap + (1 - GAP_EMA_ALPHA) * c.gapEma;
  return { ...c, lastAnyAt: at, gapEma };
}

/** 看了一眼：未读清零，habituation +1（论文 Eq habituation-state）。 */
function looked(c: ChatNode, at: number): ChatNode {
  return {
    ...c,
    unread: 0,
    ewms: 0,
    ewmsAt: at,
    habit: efold(c.habit, at - c.habitAt, HABITUATION_TAU) + 1,
    habitAt: at,
  };
}

/**
 * 想过、决定先不（或主动找过了）：冷却与群聊存在感从此刻重新长起——"考虑过就消耗"这条规则只在这里
 * （2026-11-11 理论伙伴写成公理）。答应的事由记忆（recall.ts memory）在同一条事件上折：世界 fold 不再写它。
 */
function considered(c: ChatNode, at: number): ChatNode {
  return { ...c, consideredAt: at };
}

/**
 * 私聊的冷却按人算：这个人也记一笔"想过了"。上一次想过之后有过互动，就从 1 重新数连着的"决定先不"
 * （退避见 drives.ts contactCooling）。
 */
function partnerConsidered(w: World, chat: ChatNode, at: number): World {
  const partner = chat.partner;
  if (!partner || !w.relations.people[partner]) return w;
  const person = w.willingness[partner] ?? { consideredAt: 0, declines: 0 };
  const declines =
    (person.consideredAt > (w.relations.people[partner]?.seen.lastAnswerAt ?? 0)
      ? person.declines
      : 0) + 1;
  return {
    ...w,
    willingness: { ...w.willingness, [partner]: { consideredAt: at, declines } },
  };
}

function withFailure(c: ChatNode, at: number): ChatNode {
  return {
    ...c,
    silences: halfLife(c.silences, at - c.silencesAt, SAT.failHalfLife) + 1,
    silencesAt: at,
  };
}

/** 记一次反应；冷落与拒绝抬高回避。 */
function withReception(
  c: ChatNode,
  at: number,
  kind: ReceptionKind,
  by: string | null,
  emoji?: string,
): ChatNode {
  const turnAt = c.awaiting?.turnAt ?? at;
  const gain = welcomeGain(c, kind, at);
  const reception: Reception = { at, turnAt, kind, by };
  if (c.awaiting?.proactive) reception.proactive = true;
  if (emoji) reception.emoji = emoji;
  return {
    ...c,
    awaiting: null,
    receptions: [...c.receptions, reception].slice(-RECENT_RECEPTIONS),
    lastBondAt: kind === "replied" ? at : c.lastBondAt,
    aversion: gain !== 0 ? Math.max(WELCOME_FLOOR, aversionAt(c, at) + gain) : c.aversion,
    aversionAt: gain !== 0 ? at : c.aversionAt,
  };
}

/** 这个群平时别人的一轮被接的比例（先验 1/2，算两轮）。 */
export function usualUptake(c: ChatNode, at: number): number {
  const u = c.usual;
  const keep = (n: number) => halfLife(n, at - u.at, USUAL_HALF_LIFE);
  return (keep(u.taken) + 1) / (keep(u.turns) + 2);
}

/**
 * 一次反应让回避（她在这里受不受欢迎，ADR-217 的 A）变多少。群里按这个群平时别人被接的比例 p 居中（PLAN 第 43 件）：
 * 有人接 −(1−p)，没人接 +p，平时就是这样时期望不变；一个人人都接的群里没人接算得重，一个本来就少有人接的群里没人接算得轻。
 * 增量的尺度 2·AVERSION_GAIN.ignored：p = 1/2 时没人接 +0.5，和以前一样。负面表情、被拒照旧；私聊照旧。
 */
function welcomeGain(c: ChatNode, kind: ReceptionKind, at: number): number {
  if (kind === "rejected" || kind === "cold") return AVERSION_GAIN[kind];
  if (c.chatType !== "group") return kind === "ignored" ? AVERSION_GAIN.ignored : 0;
  const p = usualUptake(c, at);
  const scale = 2 * AVERSION_GAIN.ignored;
  if (kind === "ignored") return scale * p;
  return kind === "replied" || kind === "taken" ? -scale * (1 - p) : 0;
}

/** 群里每个人最近说了几轮淡掉一半的时长。手设：一个白天里的几段对话都还算数。 */
const VOICE_HALF_LIFE = 6 * 3_600_000;

/** 淡掉之后此刻的计数。 */
export function voicesAt(c: ChatNode, at: number): { by: Record<string, number>; her: number } {
  const v = c.voices;
  const keep = (n: number) => halfLife(n, at - v.at, VOICE_HALF_LIFE);
  return {
    by: Object.fromEntries(Object.entries(v.by).map(([id, n]) => [id, keep(n)])),
    her: keep(v.her),
  };
}

/** 又一条话（who 为 null 是她）：新的一轮就记一轮（换了人、隔了 TURN_GAP、或中间有别人）。淡到很小的人不再记。 */
function withVoice(prev: ChatNode, who: string | null, at: number): ChatNode["voices"] {
  const now = voicesAt(prev, at);
  const lastIsHer = prev.lastAliceAt > prev.lastIncomingAt;
  const lastAt = Math.max(prev.lastAliceAt, prev.lastIncomingAt);
  const same = who === null ? lastIsHer : !lastIsHer && prev.recentFrom.at(-1) === who;
  const fresh = !same || at - lastAt > TURN_GAP;
  const by = Object.fromEntries(Object.entries(now.by).filter(([, n]) => n >= 0.05));
  if (!fresh) return { by, her: now.her, at };
  if (who === null) return { by, her: now.her + 1, at };
  return { by: { ...by, [who]: (by[who] ?? 0) + 1 }, her: now.her, at };
}

/** 被接得多时回避可以低于 0（她在这里更敢开口），最低到这里。手设。 */
const WELCOME_FLOOR = -0.5;
/** 这个群平时被接的比例按这个半衰期淡掉旧的。手设。 */
const USUAL_HALF_LIFE = 24 * 3_600_000;

/** 别人的一条话 fold 进这个群的常态：换了人或隔开了就是新的一轮；紧挨着上一个别人、UPTAKE_LINK 之内，那一轮算被接。 */
function withUsual(prev: ChatNode, sender: string, at: number): ChatNode["usual"] {
  const u = prev.usual;
  const keep = (n: number) => halfLife(n, at - u.at, USUAL_HALF_LIFE);
  const last = prev.recentFrom.at(-1);
  const herLast = prev.lastAliceAt > prev.lastIncomingAt;
  const fresh = herLast || last !== sender || at - prev.lastIncomingAt > TURN_GAP;
  const takes =
    !herLast && last !== undefined && last !== sender && at - prev.lastIncomingAt <= UPTAKE_LINK;
  const credit = takes && !u.credited;
  return {
    turns: keep(u.turns) + (fresh ? 1 : 0),
    taken: keep(u.taken) + (credit ? 1 : 0),
    at,
    credited: fresh ? false : u.credited || credit,
  };
}

/** 群自己的节奏：K 轮消息的时长（ADR-161 §3.4，换成事件时间上的间隔 EMA）。 */
export function groupTheta(chat: ChatNode): number {
  if (chat.gapEma === null) return GROUP_THETA_COLD;
  return Math.min(GROUP_THETA_MAX, Math.max(GROUP_THETA_MIN, GROUP_ABSENCE_ROUNDS * chat.gapEma));
}

/**
 * 没人接的连发（σ_out）多久淡一半：私聊按 SAT.outHalfLife（对方一直不回的证据不会很快变弱）；群里按这个群自己的
 * 节奏（groupTheta），没人接只是这段对话过去了（PLAN 第 43 件：群里用 30 天，一天下来连发计数只涨不落）。
 */
export function outHalfLife(chat: ChatNode): number {
  return chat.chatType === "group" ? groupTheta(chat) : SAT.outHalfLife;
}

/** 等反应的窗口过了：别人说过话却没人理她是冷落，根本没人说话就算没人听见。 */
function settle(c: ChatNode, at: number): ChatNode {
  const a = c.awaiting;
  if (!a || at - a.turnAt <= RECEPTION_WINDOW[c.chatType]) return c;
  return withReception(
    c,
    a.turnAt + RECEPTION_WINDOW[c.chatType],
    a.others > 0 ? "ignored" : "unheard",
    null,
  );
}

/** 这个会话里在场的人：私聊是对方，群里是最近说过话的人（日记、关于人的事的受众规则都用它）。 */
export function presentIn(chat: ChatNode | undefined): string[] {
  if (!chat) return [];
  return chat.partner ? [chat.partner] : [...new Set(chat.recentFrom)];
}

export function put<W extends Pick<World, "chats">>(world: W, scope: string, chat: ChatNode): W {
  return { ...world, chats: { ...world.chats, [scope]: chat } };
}

/** 轮到她：她说完话后不久有人接她的话（论文 Eq phi-obligation 的 alice_turn；ADR-218 TTL 600 秒）。 */
export function isTurn(chat: ChatNode): boolean {
  // 群里别人接着聊自己的不算轮到她，要有人回应她（回复或点名）；私聊里对方说话就是接她的话。
  const answered = chat.chatType === "group" ? chat.lastBondAt : chat.lastIncomingAt;
  return (
    chat.lastAliceAt > 0 &&
    answered > chat.lastAliceAt &&
    answered - chat.lastAliceAt <= TURN_WINDOW
  );
}

/** 对方说了最后一句之后，多久以内她不回仍算"有人等她"：义务半衰期的 6 倍（那时义务已不到 2%）。 */
export const SOLICITED_FOR = 6 * OBLIGATION_HALF_LIFE;

/**
 * 接话还是主动开口（论文 Remark proactive pacing 的 hot-chat 定义），只看此刻：有没看的冲着她的消息；
 * 对方刚接了她的话（isTurn 只看接话离她说话多近，这里再看离现在多近）；私聊里对方说了最后一句、还不久
 * （SOLICITED_FOR）。群里别人自己聊天不算找她。不看时间的旧定义让 s13 那种半年空档里每一次"想过、
 * 决定先不"都算作没回别人，冷却不消耗（统一 A/B 2026-11-12：189 天 1,212 次调用）。
 */
export function isSolicited(chat: ChatNode, at: number): boolean {
  if (chat.pending > 0) return true;
  const answered = chat.chatType === "group" ? chat.lastBondAt : chat.lastIncomingAt;
  if (isTurn(chat) && at - answered <= TURN_WINDOW) return true;
  return (
    chat.chatType === "private" &&
    chat.lastIncomingAt > chat.lastAliceAt &&
    at - chat.lastIncomingAt <= SOLICITED_FOR
  );
}

/**
 * 世界 fold 之前：reach 候选在一个还没有的会话里做了决定（或开了口、动作做完或失败），由世界 base 建出它。
 * 不运行时导入 reach.ts，避免模块循环依赖。
 */
function openReachOnUse(world: World, event: AliceEvent): World {
  switch (event.type) {
    case "speech.decided":
    case "speech.failed":
    case "message.sent":
    case "act.done":
    case "act.failed":
      return openReachChat(world, event.scope);
    default:
      return world;
  }
}

/** 在 reach 里够得着的地方或认识的人那里建出还没有的会话；够不着、没来往过的不建。 */
function openReachChat(world: World, scope: string): World {
  if (world.chats[scope]) return world;
  const place = world.reach.places[scope];
  if (place) {
    return put(world, scope, {
      ...freshChat("group"),
      member: false,
      place: { seenAt: place.seenAt },
    });
  }
  const met = Object.entries(world.reach.met).find(
    ([id, { scope: where }]) => dmScopeOf(where, id) === scope,
  );
  if (!met) return world;
  const [id] = met;
  return (relationView(world, id)?.lastBondAt ?? 0) > 0
    ? put(world, scope, { ...freshChat("private"), partner: id })
    : world;
}

/** 和一个人的私聊 scope：认识他的那个会话的 scope 保留最后一个冒号及之前的部分，后面换成他的 id。 */
function dmScopeOf(metScope: string, id: string): string {
  const i = metScope.lastIndexOf(":");
  return i < 0 ? id : `${metScope.slice(0, i + 1)}${id}`;
}

/**
 * 可插拔的"明确拒绝"分类器：判断一条进来的消息是不是在拒绝她刚才的话。
 * 默认没有（不接 LLM，也不用关键词匹配做语义判断）；以后可以接一个带类型结果的判断。
 */
export type RejectionClassifier = (event: AliceEvent, chat: ChatNode) => boolean;

type EventOf<T extends AliceEvent["type"]> = Extract<AliceEvent, { type: T }>;

/** 一个事件进来，世界怎么变。 */
export function reduceWorld(
  world: World,
  event: AliceEvent,
  rejected: RejectionClassifier = () => false,
): World {
  const w = openReachOnUse(world.firstAt > 0 ? world : { ...world, firstAt: event.at }, event);
  switch (event.type) {
    case "clock.tick":
      return settleAll(w, event.at);
    case "message.received":
      return receiveMessage(w, event, rejected);
    case "message.sent":
      return sendMessage(w, event);
    case "speech.decided":
      return decideSpeech(w, event);
    case "message.perceived":
      // 外壳判出的口气：敌意的那条不算一次往来（relation.ts 退回那一段）。
      return w;
    case "reaction.received":
      return receiveReaction(w, event);
    case "chat.described":
      // 群里禁发的消息种类：发言提示里由 scene-facts 的 withholds 去掉对应的动作，意愿层读同一份（ADR-276）。
      // 群的样子可能比这个群的第一条消息先到，所以不挂在会话上。
      return { ...w, bans: { ...w.bans, [event.scope]: event.banned } };
    case "membership.changed":
      return changeMembership(w, event);
    case "act.done":
      return finishAct(w, event);
    case "act.failed":
      return failAct(w, event);
    case "speech.failed":
      return failSpeech(w, event);
    default:
      return w;
  }
}

/** 时间走了：把等反应窗口已过的会话结算掉（冷落要在没有新消息时也能被觉察）。 */
function settleAll(w: World, at: number): World {
  let chats: Record<string, ChatNode> | null = null;
  for (const [scope, c] of Object.entries(w.chats)) {
    const s = settle(c, at);
    if (s === c) continue;
    chats = chats ?? { ...w.chats };
    chats[scope] = s;
  }
  return chats ? { ...w, chats } : w;
}

/** 进来一条消息后会话的计数和节律；群里别人之间的闲聊（不值得注意的）只记见过，不涨未读、义务和代价。 */
function withIncoming(prev: ChatNode, event: EventOf<"message.received">): ChatNode {
  const worthy = isGroupAttentionWorthy(event);
  return withRhythm(
    {
      ...prev,
      partner: event.chatType === "private" ? event.senderId : prev.partner,
      seen: prev.seen + 1,
      recentIds: [...prev.recentIds, event.messageId].slice(-RECENT_IDS),
      recentFrom: [...prev.recentFrom, event.senderId].slice(-RECENT_IDS),
      ...(worthy
        ? {
            unread: prev.unread + 1,
            ewms: halfLife(prev.ewms, event.at - prev.ewmsAt, UNREAD_HALF_LIFE) + 1,
            ewmsAt: event.at,
            lastIncomingAt: event.at,
            incoming: [...within(prev.incoming, event.at, COST_WINDOW), event.at],
            effort: withEffort(prev, event.at, 0, effortWeight(event.text)),
          }
        : {}),
      ...(event.chatType === "group"
        ? {
            usual: withUsual(prev, event.senderId, event.at),
            voices: withVoice(prev, event.senderId, event.at),
          }
        : {}),
      ...(event.chatTitle ? { title: event.chatTitle } : {}),
    },
    event.at,
  );
}

/**
 * 有人回应了她：对她说、回复她的话；群里还有北极星"接她"的口径（PLAN 第 43 件）——紧挨着她的话、
 * UPTAKE_LINK 之内说的，或者她刚接的那个人 UPTAKE_LINK 之内接着说。她对没回应的连发归零；群里别人自己聊天不算。
 * prev 是这条消息之前的会话，c 是记下这条消息之后的。
 */
function withAnswer(
  prev: ChatNode,
  c: ChatNode,
  event: EventOf<"message.received">,
  toHer: boolean,
  rejected: RejectionClassifier,
): ChatNode {
  const sinceHer = event.at - prev.lastAliceAt;
  const takenUp =
    event.chatType === "group" &&
    prev.awaiting !== null &&
    sinceHer <= UPTAKE_LINK &&
    (prev.lastAliceAt > prev.lastIncomingAt || prev.awaiting.to === event.senderId);
  const replying =
    toHer ||
    (event.replyToMessageId !== null &&
      (c.awaiting?.ids.includes(event.replyToMessageId) ?? false));
  const next = replying || takenUp ? { ...c, outgoing: 0 } : c;
  if (!next.awaiting) return next;
  if (rejected(event, next)) return withReception(next, event.at, "rejected", event.senderId);
  if (replying) return withReception(next, event.at, "replied", event.senderId);
  if (takenUp) return withReception(next, event.at, "taken", event.senderId);
  return { ...next, awaiting: { ...next.awaiting, others: next.awaiting.others + 1 } };
}

function receiveMessage(
  w: World,
  event: EventOf<"message.received">,
  rejected: RejectionClassifier,
): World {
  const prev = settle(w.chats[event.scope] ?? freshChat(event.chatType), event.at);
  let c = withIncoming(prev, event);
  const toHer = event.directed || event.chatType === "private";
  if (event.directed) {
    c = { ...c, pending: c.pending + 1, lastDirectedAt: event.at, silences: 0 };
  }
  // 别人对她说的话停在这里：开一条线程，直到她接（论文 Def P4，权重按会话类型）。
  if (toHer && !c.thread)
    c = { ...c, thread: { openedAt: event.at, weight: THREAD_WEIGHT[event.chatType] } };
  c = withAnswer(prev, c, event, toHer, rejected);
  const count = w.relations.people[event.senderId]?.seen.count ?? 0;
  // novelty：对这个人的预测有多不确定，σ = 1/(1+n/10)（论文 Remark per-contact surprise 的 σ_c）
  return {
    ...put(w, event.scope, c),
    novelty:
      efold(w.novelty, event.at - w.noveltyAt, NOVELTY_TAU) + 1 / (1 + count / SIGMA_HALF_COUNT),
    noveltyAt: event.at,
  };
}

/** 她这一轮开口在等谁的反应：接着上一轮的等，或者从这条开始新等一轮，记下是不是主动开口、接的是谁。 */
function awaitingAfterSent(
  prev: ChatNode,
  event: EventOf<"message.sent">,
  solicited: boolean,
): Awaiting {
  if (prev.awaiting) return { ...prev.awaiting, ids: [...prev.awaiting.ids, event.messageId] };
  // 她这一轮接的是谁：开口前 UPTAKE_LINK 之内紧挨着的那条别人的话。
  const answered =
    prev.lastIncomingAt > prev.lastAliceAt && event.at - prev.lastIncomingAt <= UPTAKE_LINK
      ? prev.recentFrom.at(-1)
      : undefined;
  return {
    turnAt: event.at,
    ids: [event.messageId],
    others: 0,
    ...(solicited ? {} : { proactive: true }),
    ...(answered ? { to: answered } : {}),
  };
}

function sendMessage(w: World, event: EventOf<"message.sent">): World {
  const found = w.chats[event.scope];
  if (!found) return w;
  const prev = settle(found, event.at);
  const newTurn = event.at - prev.lastAliceAt > TURN_GAP;
  const solicited = isSolicited(prev, event.at);
  const c: ChatNode = withRhythm(
    {
      ...prev,
      // 答应过的事（chats.commitments）只由记忆（recall.ts memory）折，世界 fold 不再写它。
      lastAliceAt: event.at,
      // 行动消耗驱动它的信号（ADR-218/270）：读了、回了，未读、义务、线程清零（论文 Def P5）。
      unread: 0,
      ewms: 0,
      ewmsAt: event.at,
      pending: 0,
      thread: null,
      awaiting: awaitingAfterSent(prev, event, solicited),
      outgoing: halfLife(prev.outgoing, event.at - prev.outgoingAt, outHalfLife(prev)) + 1,
      outgoingAt: event.at,
      silences: 0,
      lastProactiveAt: solicited ? prev.lastProactiveAt : event.at,
      turns: newTurn ? [...within(prev.turns, event.at, SAT.rateWindow), event.at] : prev.turns,
      effort: newTurn ? withEffort(prev, event.at, 1, 0) : prev.effort,
      voices: prev.chatType === "group" ? withVoice(prev, null, event.at) : prev.voices,
    },
    event.at,
  );
  const spoken = event.kind === "text" || event.kind === "voice";
  const next: World = {
    ...put(w, event.scope, c),
    turns: newTurn ? [...within(w.turns, event.at, COST_WINDOW), event.at] : w.turns,
    said: spoken
      ? [...w.said, { at: event.at, scope: event.scope, text: event.text }].slice(-SAID_KEPT)
      : w.said,
  };
  // 主动找了对方：想联系的冲动由"找过了"满足，从此刻重新长起；关系本身（lastBondAt）不变，
  // 一直没回照样积累回避。否则冲动不减，对方不在时她会一条接一条地发
  // （memory-eval：对方一直没回时她最多连发 27 轮）。
  if (solicited) return next;
  return partnerConsidered(
    put(next, event.scope, { ...c, consideredAt: event.at }),
    prev,
    event.at,
  );
}

function decideSpeech(world: World, event: EventOf<"speech.decided">): World {
  const w = { ...world, lastCallAt: event.at, callFailures: { count: 0, at: 0 } };
  const prev = w.chats[event.scope];
  if (!prev) return w;
  // 只标已读、只在心里记一笔都不算回应；说话、贴纸、表情、退群都是可见的行动。
  const silent = isSilent(event.decision.acts);
  const left = event.decision.acts.some(leaves);
  // 看过了：未读清零；选择不回也是义务和线程的一个有类型的结局（ADR-270），一并清零。
  // 想过、没走：离开的冲动也是考虑过就消耗，不然被冷落的热闹群里每个节律格都会为"要不要走"
  // 叫醒她一次（eval-artifacts/cliff/notes.md）。
  const c: ChatNode = {
    ...looked(prev, event.at),
    pending: 0,
    thread: silent ? null : prev.thread,
    stayedAt: left ? prev.stayedAt : event.at,
  };
  if (!silent) return put(w, event.scope, c);
  // 没人找她时想过要不要说、决定先不：冷却与群聊存在感从此刻重新长起，而不是一分钟后再问一遍
  // （will/prereg 零成本估算：不消耗时私聊每天被反复斟酌约 16 次）。选择沉默记一笔（σ_fail）。
  // "有人等她、她没回"有时限（isSolicited）：对方道了晚安、半年没再说话，之后每一次想过、决定先不，
  // 都消耗冷却并退避。
  if (isSolicited(prev, event.at)) return put(w, event.scope, withFailure(c, event.at));
  return partnerConsidered(
    put(w, event.scope, withFailure(considered(c, event.at), event.at)),
    prev,
    event.at,
  );
}

/**
 * 有人在她这一轮的话上点了表情。正面、中性的是一次回应（轻，但有人看见了她、给了反应）；负面的（👎、🤡、💩……）
 * 是一次轻的拒绝：不算回应、不续关系、不清连发，回避加一点（北极星读数同样把它算作嫌弃）。
 */
function receiveReaction(w: World, event: EventOf<"reaction.received">): World {
  const prev = w.chats[event.scope];
  if (!prev?.awaiting?.ids.includes(event.messageId)) return w;
  if (NEGATIVE_REACTIONS.has(event.emoji)) {
    return put(w, event.scope, withReception(prev, event.at, "cold", event.senderId, event.emoji));
  }
  const c = withReception(prev, event.at, "replied", event.senderId, event.emoji);
  return put(w, event.scope, { ...c, outgoing: 0 });
}

/** 被踢是最明确的拒绝；自己离开、被拉进来只改成员身份。 */
function changeMembership(w: World, event: EventOf<"membership.changed">): World {
  const prev = w.chats[event.scope];
  if (!prev) return w;
  const c = event.reason === "kicked" ? withReception(prev, event.at, "rejected", null) : prev;
  return put(w, event.scope, { ...c, member: event.member });
}

function finishAct(w: World, event: EventOf<"act.done">): World {
  const row = affordanceOf(event.act.kind);
  // 她心里的事由提供它的那一样 fold 进世界（feature.ts）。
  if (row.via === "mind") return w;
  const prev = w.chats[event.scope];
  const member = memberAfter(row);
  return prev && member !== undefined ? put(w, event.scope, { ...prev, member }) : w;
}

/** 被对方拉黑（telegram/errors 的 refused）是明确的拒绝；其余失败只抬高 σ_fail。 */
function failAct(w: World, event: EventOf<"act.failed">): World {
  const prev = w.chats[event.scope];
  if (!prev) return w;
  const c = event.reason === "refused" ? withReception(prev, event.at, "rejected", null) : prev;
  return put(w, event.scope, withFailure(c, event.at));
}

/**
 * 没看到、没回成：有人在等她时，义务、线程、未读都留着，好再试。没人找她时，这次就当看了一眼、
 * 想过、决定先不（与沉默的决定一样），所以失败不会比沉默更勤（研究伙伴 switching-scan/prereg-backoff：
 * 否则失败率 0.5 时调用多 33%）；节律从这次尝试重新数，并按连续失败次数再退避。
 */
function failSpeech(w: World, event: EventOf<"speech.failed">): World {
  const failed: World = {
    ...w,
    lastCallAt: event.at,
    callFailures: { count: w.callFailures.count + 1, at: event.at },
  };
  const prev = w.chats[event.scope];
  if (!prev) return failed;
  if (isSolicited(prev, event.at)) return put(failed, event.scope, withFailure(prev, event.at));
  const c = withFailure(
    { ...considered(looked(prev, event.at), event.at), stayedAt: event.at },
    event.at,
  );
  return partnerConsidered(put(failed, event.scope, c), prev, event.at);
}

/** 可选的层级来源（忠实度回放用 2 月图里的 tier）；返回 undefined 则按 relations 算。 */
export type TierLookup = (contactId: string | null) => Tier | undefined;

/**
 * Dunbar 层。生产由亲近排名换算（1–5 → 5，…，150 名以外或没来往过 → 500）：亲近是按互动频率、14 天半衰期的
 * 动态分数，所以层级随互动演化（论文 §2 Dynamic Tier Evolution）。候选第 4 片（relationTier）改成按熟悉度分档。
 */
export function tierOf(world: World, contactId: string | null, now: number): Tier {
  return world.relations.tierFromFamiliarity
    ? familiarityTier(world.relations, contactId, now)
    : rankedTier(world.relations, contactId, now);
}

export function chatTier(world: World, chat: ChatNode, now: number, tiers?: TierLookup): Tier {
  if (chat.chatType === "group") return GROUP_TIER;
  return tiers?.(chat.partner) ?? tierOf(world, chat.partner, now);
}
