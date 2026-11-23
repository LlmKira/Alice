/**
 * 一个人的一条记录（docs/research/relationship.md 第 1、3 片）：`relations` 这一块只有一个 writer `relation`。
 *
 * 第 1 片（生产，2026-11-13；eval-artifacts/relationship/prereg-1.md）：会话上的回避（world.ts aversion）混着两件事：
 * 群里她主动说的话被晾着（群对她开口的反应，不是哪个人的），和某个人伤了她（私聊里拉黑她）。线上 12:17 一次：
 * 群里被晾着攒到 0.724，一个 3 分钟前刚回复过她的人点她名，叫醒分数 0.311，没叫醒。这里把"某个人伤了她"按人记下，
 * 每一笔带原因（CK3 的 opinion modifier、《模拟人生 4》的情感：带类型、带数值、按时间淡掉）；意愿层按动作的对象读：
 * - 冲着人的动作：这个会话里有人在等她（她上次开口、做决定以后冲着她说过话），读这些人里回避最小的那个人自己的回避；
 * - 不冲着谁的动作（没人在等她时开口）和进出会话：读会话的那一项（被晾着、群的拒绝），和生产一样。
 * 私聊里会话就是那个人：拉黑记在对方身上，数值和会话上的相同。
 *
 * 叫她别回（2026-11-13，线上复盘 eval-artifacts/live-review/2026-11-13.md：Ani 说"别回我的消息"，42 秒后她照样回，
 * 之后 patience 每 15–90 秒又叫醒她）：外壳判口气的同一次调用看出一条找她的话在叫她别回、别理、走开
 * （message.perceived 的 stop），记成那个人的一笔 stop。它不像别的回避那样被 tanh 压在 1 以内：回那个人的代价
 * 按小时淡掉，头几个小时比任何一次叫醒的缓解都大，所以只有那个人在等她时，他的话不再自己叫醒她；别人找她照常。
 * 她醒着时仍然可以选（软引导，不是闸门）。
 *
 * 第 3 片（逐字节不变）：关于一个人的事实并成一条 `Relation`——world.contacts 的名字/最近说话/最近回应/条数、
 * world.closeness 的亲近分数与互惠、people.seen 的群里的说话日子、familiar 的看见的事实（第一次看见、有往来的日子、
 * 进群提示、机器人标记）、affect 的"上次来找我"与"有过来往"，都在这里 fold。读者拿 `RelationView`
 * （familiarity、lastToHerAt、lastAnswerAt、aversion…），不碰字段。
 * 意愿层自己的结局（"想过、决定先不找他"的 consideredAt、declines）不是关系，留在世界 base 的 `willingness`。
 * 第 4 片（候选）：`tierFromFamiliarity` 让层级从校准过的联系频率来，而不是不稳定的排名；生产保持排名，等量过再换。
 * 只写自己这一块（relations），读会话的对方和类型。纯函数，时间只来自事件。
 */
import { memberAfter } from "../../mind/affordances.js";
import { type AliceEvent, type ChatType, NEGATIVE_REACTIONS } from "../../mind/events.js";
import type { Contribution, PersonNote } from "../../mind/mechanism.js";
import { elapsed, localDay } from "../../mind/when.js";
import type { WillAffordance } from "./affordances.js";
import { type FeatureContext, feature, type PressureFeature, type View } from "./feature.js";
import { AVERSION_GAIN, AVERSION_TAU, CLOSENESS_HALF_LIFE, type Tier } from "./params.js";

const DAY_MS = 24 * 60 * 60_000;

// ── 看见的事实（familiar 的 fold 搬进来）──────────────────────────────

/** 他在这一个群里每天说几条：[东八区日历日, 条数]，从旧到新，只留最近 SEEN_DAYS 天。 */
interface RoomSeen {
  days: ReadonlyArray<readonly [day: number, lines: number]>;
  lastAt: number;
  /** 第一次在这个群里说话时，他的入群提示在不在（早于入群提示说过话的，是老面孔）。 */
  joinedAt: number | null;
}

/** 群里关于成员的两件事：她在记录开始之前就在（先验），看到过谁的入群提示。 */
interface GroupNode {
  prior: boolean;
  joined: Readonly<Record<string, number>>;
}

/** 看到的事实：都从 Journal 数出来，不带判断。 */
export interface Seen {
  /** 第一次看见他（任何会话）。 */
  firstAt: number;
  /** 最近一次在任何会话里说话。 */
  lastAt: number;
  /** 说过几条（好奇心对这个人有多不确定）。 */
  count: number;
  /** 他冲着她说话的日子（东八区日历日，留 DAYS_KEPT 天）。 */
  toHerDays: readonly number[];
  /** 最近一次冲着她说话：私聊、点名、回复她。 */
  lastToHerAt: number;
  /** 最近一次回应她：上面那些，或在她的话上点了表情。 */
  lastAnswerAt: number;
  /** 他开的往来（10 分钟内算一段）。 */
  theirs: number;
  /** 她先开口的次数。 */
  hers: number;
  herAt: number;
  /** 他在每个群里说话的日子（S07、熟悉度）。 */
  rooms: Readonly<Record<string, RoomSeen>>;
}

/** 算进最近这一次往来的那条消息，和它之前的分数（null：之前没有这个人）。外壳判出敌意时按这个退回去。 */
interface Opened {
  scope: string;
  messageId: string;
  prior: { score: number; scoreAt: number; theirs: number } | null;
}

/**
 * 有来有回、口气不坏的往来：他冲着她说话、她回了，算一段。第 3 片照搬 closeness 的分数给层级排名用，第 4 片由
 * 熟悉度取代排名（分数仍留着：`knownFor`/`whoSeeks` 读的是有过来往的事实，不是排名）。
 */
interface Warmth {
  /** 亲近分数（他开的往来，14 天半衰期）和它的时刻。 */
  score: number;
  scoreAt: number;
  /** 最近一次算进往来（或它的一段）的时刻：10 分钟内的连发算同一段。 */
  lastExchangeAt: number;
  /** 第一次有往来（认识多久从这里算）。 */
  firstAt: number;
  opened: Opened | null;
  /** 她回应过段的次数（"有过来往"：被人找时推向开心、候选 bond）。 */
  exchanges: number;
}

/** 回避的一笔：在哪、什么会话、为什么、多少。读的时候按它的时间常数淡掉再相加。 */
interface Hurt {
  at: number;
  scope: string;
  chatType: ChatType;
  /**
   * refused：私聊里被对方拉黑（act.failed 的 refused）；stop：他叫她别回、别理、走开（message.perceived 的 stop）；
   * cold：他在她这一轮的话上点了负面表情（NEGATIVE_REACTIONS），一次轻的拒绝。
   */
  why: "refused" | "stop" | "cold";
  gain: number;
}

/** 一个人。只有 relation 写；读者只拿 RelationView。 */
export interface Relation {
  name: string;
  /** 平台的机器人标记：有一条消息带着就是。 */
  bot: boolean;
  seen: Seen;
  /** 亲近的往来（分数、退回游标、互惠）。 */
  warmth: Warmth;
  hurts: readonly Hurt[];
}

/** 关系这一块的骨架：只有人、群（familiar 也折同一份）。 */
export interface RelationStore {
  people: Readonly<Record<string, Relation>>;
  groups: Readonly<Record<string, GroupNode>>;
}

export interface RelationsState extends RelationStore {
  /** 每个会话里在等她的人：她上次开口或做决定以后，冲着她说过话的人（和会话的 pending 同起同落）。 */
  waiting: Readonly<Record<string, readonly string[]>>;
  /** 每个会话里最近几条找她的消息是谁发的（口气、stop 晚到时认人）。 */
  addressed?: Readonly<Record<string, ReadonlyArray<readonly [messageId: string, who: string]>>>;
  /** 她上次开口以后找过她的人（"有过来往"与 affect 的 waiting 同一份；她开口时算她回应过）。 */
  sought?: Readonly<Record<string, readonly string[]>>;
  /**
   * 候选（第 4 片）：层级从熟悉度分档，而不是排名（relationTier）。生产没有这一项。
   */
  tierFromFamiliarity?: true;
}

export const emptyRelations: RelationsState = { people: {}, groups: {}, waiting: {} };

/** 每人留几笔：最早那笔淡到看不出来之前，多半已被挤掉；手设。 */
const HURTS_KEPT = 10;
/** 每个会话记几条找她的消息（口气在一次叫醒里判完，几十条足够）。手设。 */
const ADDRESSED_KEPT = 20;
/** 10 分钟内的连续往来算一次互动，避免一段连发把分数刷高（closeness）。 */
const EPISODE_GAP_MS = 10 * 60_000;
/** 有往来的日子留多少天：四个半衰期（closeness），再早的权重不到 1/16。 */
const DAYS_KEPT = Math.round((4 * CLOSENESS_HALF_LIFE) / DAY_MS);
/** 在一个群里每天说几条留多少天（people 的 S07）。 */
const SEEN_DAYS = 30;
/**
 * 叫她别回的那一笔：数值和时间常数。回那个人的代价是 λ·这个数（被点名时 λ = 0.45）；一次叫醒的缓解几项加起来
 * 最多两三。8 在 1 小时后约 5.7（代价 2.6）、3 小时后约 2.9（1.3）、6 小时后约 1.1（0.5）、9 小时后约 0.4。手设。
 */
export const STOP = { gain: 8, tau: 3 * 60 * 60_000 } as const;

/** 先验值几天的观察，也是说得出频率之前要看几天：一周（社交节律的周期）。 */
const PRIOR_DAYS = 7;
/** 每过一天的折扣（closeness 的半衰期）。 */
const DAILY = 0.5 ** (DAY_MS / CLOSENESS_HALF_LIFE);
/** 频率词按字面意思定界：一周 5 天以上、一周 2 天以上、一个月两次以上。 */
const RATES: ReadonlyArray<readonly [atLeast: number, word: string]> = [
  [5 / 7, "我们几乎天天聊"],
  [2 / 7, "常聊"],
  [1 / 15, "偶尔聊"],
];
/** 认识满两周才说认识多久；往来满 4 次才说谁在找谁（次数少时比例没意义）。 */
const KNOWN_FOR_MS = 14 * DAY_MS;
const SEEKING_MIN = 4;

const fade = (h: Hurt, now: number, tau: number) =>
  now <= h.at ? h.gain : h.gain * Math.exp(-(now - h.at) / tau);

/** 她此刻对这个人的回避（叫她别回的那几笔不在内）：每一笔按它所在会话类型的时间常数淡掉后相加（ADR-217）。 */
export function aversionToward(
  state: Pick<RelationsState, "people">,
  id: string,
  now: number,
): number {
  return (state.people[id]?.hurts ?? [])
    .filter((h) => h.why !== "stop")
    .reduce((sum, h) => sum + fade(h, now, AVERSION_TAU[h.chatType]), 0);
}

/** 他叫她别回的那几笔此刻还剩多少（不压在 1 以内）。 */
export function stopToward(state: Pick<RelationsState, "people">, id: string, now: number): number {
  return (state.people[id]?.hurts ?? [])
    .filter((h) => h.why === "stop")
    .reduce((sum, h) => sum + fade(h, now, STOP.tau), 0);
}

// ── fold ─────────────────────────────────────────────────────────────

const blankSeen = (at: number): Seen => ({
  firstAt: at,
  lastAt: at,
  count: 0,
  toHerDays: [],
  lastToHerAt: 0,
  lastAnswerAt: 0,
  theirs: 0,
  hers: 0,
  herAt: -Infinity,
  rooms: {},
});

const blankWarmth = (): Warmth => ({
  score: 0,
  scoreAt: 0,
  lastExchangeAt: 0,
  firstAt: 0,
  opened: null,
  exchanges: 0,
});

const decayed = (w: Warmth, now: number): number =>
  w.score * 0.5 ** ((now - w.scoreAt) / CLOSENESS_HALF_LIFE);

/** 一个群里说话的日子：同一天加一条，只留 SEEN_DAYS 天。joinedAt 是第一次在这里说话时的入群提示（没有就是 null）。 */
function noteDay(room: RoomSeen | undefined, at: number, joinedAt: number | undefined): RoomSeen {
  const day = localDay(at);
  const days = (room?.days ?? []).filter(([d]) => day - d < SEEN_DAYS);
  const last = days.at(-1);
  return {
    days:
      last && last[0] === day
        ? [...days.slice(0, -1), [day, last[1] + 1] as const]
        : [...days, [day, 1] as const],
    lastAt: at,
    joinedAt: room ? room.joinedAt : (joinedAt ?? null),
  };
}

function withHurt(state: RelationsState, id: string, hurt: Hurt): RelationsState {
  const prev = state.people[id];
  const hurts = [...(prev?.hurts ?? []), hurt].slice(-HURTS_KEPT);
  const relation: Relation = prev
    ? { ...prev, hurts }
    : {
        name: "有人",
        bot: false,
        seen: blankSeen(hurt.at),
        warmth: blankWarmth(),
        hurts,
      };
  return { ...state, people: { ...state.people, [id]: relation } };
}

function withWaiting(state: RelationsState, scope: string, who: readonly string[]): RelationsState {
  return { ...state, waiting: { ...state.waiting, [scope]: who } };
}

type EventOf<T extends AliceEvent["type"]> = Extract<AliceEvent, { type: T }>;

/**
 * 一个人的事实怎么折（relation 与 familiar 共用这一份）：名字、看见的事实、群里的日子、有往来、亲近分数。
 * partnerOf 是私聊会话的对方（relation 读会话，familiar 读自己记的）。
 */
export function reduceStore(
  store: RelationStore,
  event: AliceEvent,
  partnerOf: (scope: string) => string | null,
): RelationStore {
  switch (event.type) {
    case "membership.changed":
      // 这个群的第一个事件是她进群：她是在记录里才来的，这里的人没有先验。
      return store.groups[event.scope]
        ? store
        : {
            ...store,
            groups: {
              ...store.groups,
              [event.scope]: { prior: !event.member, joined: {} },
            },
          };
    case "member.joined": {
      const g = store.groups[event.scope] ?? { prior: true, joined: {} };
      return {
        ...store,
        groups: {
          ...store.groups,
          [event.scope]: { ...g, joined: { ...g.joined, [event.userId]: event.at } },
        },
      };
    }
    case "message.received":
      return storeReceived(store, event);
    case "message.sent":
      return storeSent(store, event, partnerOf);
    case "message.perceived":
      return event.tone === "hostile" ? withdrawHostile(store, event) : store;
    default:
      return store;
  }
}

/** 他说了一条：名字、机器人标记、看见的事实；冲着她说的还算进亲近的往来。 */
function storeReceived(store: RelationStore, event: EventOf<"message.received">): RelationStore {
  const prev = store.people[event.senderId];
  // 这个群的第一个事件是别人的话：她在记录之前就在，这里的人是朋友（先验）。
  const groups =
    event.chatType === "group" && !store.groups[event.scope]
      ? { ...store.groups, [event.scope]: { prior: true, joined: {} } }
      : store.groups;
  const base = prev?.seen ?? blankSeen(event.at);
  const before = prev?.warmth ?? blankWarmth();
  const { warmth, theirs } = event.directed
    ? exchanged(before, base.theirs, event)
    : { warmth: before, theirs: base.theirs };
  const relation: Relation = {
    name: event.senderName,
    bot: prev?.bot === true || event.isBot === true,
    seen: { ...seenAfter(prev, base, groups[event.scope]?.joined[event.senderId], event), theirs },
    warmth,
    hurts: prev?.hurts ?? [],
  };
  return { ...store, groups, people: { ...store.people, [event.senderId]: relation } };
}

/** 看见他说了一条之后的事实（他开的往来数另算，见 exchanged）。joinedAt 是这个群里他的入群提示。 */
function seenAfter(
  prev: Relation | undefined,
  base: Seen,
  joinedAt: number | undefined,
  event: EventOf<"message.received">,
): Seen {
  const at = event.at;
  const day = localDay(at);
  const prevRooms = prev?.seen.rooms ?? {};
  const rooms =
    event.chatType === "group"
      ? { ...prevRooms, [event.scope]: noteDay(prevRooms[event.scope], at, joinedAt) }
      : prevRooms;
  // 有往来的日子：冲着她说话的那一天（familiar 的频率词按它）。
  const talked = event.directed && prev?.seen.toHerDays.at(-1) !== day;
  const toHer = event.directed || event.chatType === "private";
  return {
    ...base,
    firstAt: base.firstAt,
    lastAt: at,
    count: base.count + 1,
    toHerDays: talked
      ? [...base.toHerDays.filter((d) => day - d < DAYS_KEPT), day]
      : base.toHerDays,
    lastToHerAt: toHer ? at : base.lastToHerAt,
    lastAnswerAt: toHer ? at : base.lastAnswerAt,
    rooms,
  };
}

/** 亲近：他冲着她说话算一段往来；10 分钟内的连发算同一段。theirs 是他之前开过几段。 */
function exchanged(
  warmth: Warmth,
  theirs: number,
  event: EventOf<"message.received">,
): { warmth: Warmth; theirs: number } {
  const at = event.at;
  if (warmth.lastExchangeAt > 0 && at - warmth.lastExchangeAt < EPISODE_GAP_MS) {
    return { warmth: { ...warmth, lastExchangeAt: at }, theirs };
  }
  const had = warmth.lastExchangeAt > 0;
  const opened: Opened = {
    scope: event.scope,
    messageId: event.messageId,
    prior: had ? { score: warmth.score, scoreAt: warmth.scoreAt, theirs } : null,
  };
  return {
    warmth: {
      ...warmth,
      score: (had ? decayed(warmth, at) : 0) + 1,
      scoreAt: at,
      lastExchangeAt: at,
      firstAt: had ? warmth.firstAt : at,
      opened,
    },
    theirs: theirs + 1,
  };
}

/** 关系靠互惠维持：她的话只延续对方开启的这段往来，不单独算一次互动。 */
function storeSent(
  store: RelationStore,
  event: EventOf<"message.sent">,
  partnerOf: (scope: string) => string | null,
): RelationStore {
  const partner = partnerOf(event.scope);
  const prev = partner ? store.people[partner] : undefined;
  if (!partner || !prev) return store;
  const w = prev.warmth;
  const sameEpisode = w.lastExchangeAt > 0 && event.at - w.lastExchangeAt < EPISODE_GAP_MS;
  const warmth = sameEpisode ? { ...w, lastExchangeAt: event.at } : w;
  const seen = sameEpisode
    ? prev.seen
    : {
        ...prev.seen,
        herAt: event.at,
        hers: prev.seen.hers + (event.at - prev.seen.herAt >= EPISODE_GAP_MS ? 1 : 0),
      };
  return {
    ...store,
    people: { ...store.people, [partner]: { ...prev, seen, warmth } },
  };
}

/** 敌意的那条不算一次往来：只退它开启的那一次，之后有了新的往来就不动。 */
function withdrawHostile(store: RelationStore, event: EventOf<"message.perceived">): RelationStore {
  const hit = Object.entries(store.people).find(
    ([, r]) =>
      r.warmth.opened?.scope === event.scope && r.warmth.opened.messageId === event.messageId,
  );
  if (!hit) return store;
  const [id, r] = hit;
  const prior = r.warmth.opened?.prior;
  const warmth: Warmth = prior
    ? { ...r.warmth, ...prior, opened: null }
    : { ...blankWarmth(), exchanges: r.warmth.exchanges };
  return {
    ...store,
    people: {
      ...store.people,
      [id]: {
        ...r,
        seen: { ...r.seen, theirs: prior ? prior.theirs : 0 },
        warmth,
      },
    },
  };
}

function reduceRelations(
  state: RelationsState,
  world: View<"chats">,
  event: AliceEvent,
  before: View<"chats"> = world,
): RelationsState {
  const partnerOf = (scope: string) => world.chats[scope]?.partner ?? null;
  // reduceStore 只换 people/groups，其余字段（waiting、addressed、sought、候选开关）原样带过来。
  const store = reduceStore(state, event, partnerOf) as RelationsState;
  switch (event.type) {
    case "reaction.received":
      return reacted(store, before, event);
    case "message.received":
      return event.directed ? addressed(state, store, world, event) : store;
    case "message.perceived":
      return perceived(state, store, world, event);
    case "message.sent":
      return spoke(state, store, event.scope);
    case "speech.decided":
      return clearWaiting(state, store, event.scope);
    case "act.failed": {
      const chat = world.chats[event.scope];
      if (event.reason !== "refused" || chat?.chatType !== "private" || !chat.partner) return store;
      return withHurt(store, chat.partner, {
        at: event.at,
        scope: event.scope,
        chatType: "private",
        why: "refused",
        gain: AVERSION_GAIN.rejected,
      });
    }
    default:
      return store;
  }
}

/** 和世界 fold 同一个条件：点在她这一轮还在等反应的话上（before 是世界 fold 之前的样子）。 */
function reacted(
  store: RelationsState,
  before: View<"chats">,
  event: EventOf<"reaction.received">,
): RelationsState {
  const chat = before.chats[event.scope];
  if (!event.senderId || !chat?.awaiting?.ids.includes(event.messageId)) return store;
  if (NEGATIVE_REACTIONS.has(event.emoji)) {
    return withHurt(store, event.senderId, {
      at: event.at,
      scope: event.scope,
      chatType: chat.chatType,
      why: "cold",
      gain: AVERSION_GAIN.cold,
    });
  }
  // 正面、中性的表情是一次回应（轻，但有人看见了她、给了反应）。
  return answer(store, event.senderId, event.at);
}

/** 有人冲着她说话：记下是谁发的、他找过她、他在等她；回复了她的话（不只是"冲着她"）也是一次回应。 */
function addressed(
  state: RelationsState,
  store: RelationsState,
  world: View<"chats">,
  event: EventOf<"message.received">,
): RelationsState {
  const here = state.waiting[event.scope] ?? [];
  const sought = state.sought?.[event.scope] ?? [];
  const seen = state.addressed?.[event.scope] ?? [];
  const next: RelationsState = {
    ...store,
    addressed: {
      ...state.addressed,
      [event.scope]: [...seen, [event.messageId, event.senderId] as const].slice(-ADDRESSED_KEPT),
    },
    ...(sought.includes(event.senderId)
      ? {}
      : { sought: { ...state.sought, [event.scope]: [...sought, event.senderId] } }),
  };
  const last = world.chats[event.scope]?.receptions.at(-1);
  const replied = last && last.at === event.at && last.kind === "replied";
  const answered = replied ? answer(next, event.senderId, event.at) : next;
  return here.includes(event.senderId)
    ? answered
    : withWaiting(answered, event.scope, [...here, event.senderId]);
}

function perceived(
  state: RelationsState,
  store: RelationsState,
  world: View<"chats">,
  event: EventOf<"message.perceived">,
): RelationsState {
  const who = state.addressed?.[event.scope]?.find(([id]) => id === event.messageId)?.[1];
  // 口气冷淡、敌意的那条不算"有过来往"：她回了它也不算（从她上次开口以后找过她的人里去掉）。
  const cold = event.tone === "cold" || event.tone === "hostile";
  const next =
    cold && who
      ? {
          ...store,
          sought: {
            ...state.sought,
            [event.scope]: (state.sought?.[event.scope] ?? []).filter((id) => id !== who),
          },
        }
      : store;
  if (!event.stop) return next;
  const chatType = world.chats[event.scope]?.chatType;
  if (!who || !chatType) return next;
  return withHurt(next, who, {
    at: event.at,
    scope: event.scope,
    chatType,
    why: "stop",
    gain: STOP.gain,
  });
}

/** 她开口：在这里等她的人都算她回应过了（有过来往，affect 的 met）。 */
function spoke(state: RelationsState, store: RelationsState, scope: string): RelationsState {
  const sought = state.sought?.[scope] ?? [];
  if (sought.length === 0) return clearWaiting(state, store, scope);
  const after = {
    ...store,
    people: Object.fromEntries(
      Object.entries(store.people).map(([id, r]) => [
        id,
        sought.includes(id)
          ? { ...r, warmth: { ...r.warmth, exchanges: r.warmth.exchanges + 1 } }
          : r,
      ]),
    ),
  };
  return { ...clearWaiting(state, after, scope), sought: { ...state.sought, [scope]: [] } };
}

/** 她开口或做了决定：这个会话里不再有人在等她（state 是这次 fold 之前的）。 */
function clearWaiting(state: RelationsState, next: RelationsState, scope: string): RelationsState {
  return (state.waiting[scope]?.length ?? 0) > 0 ? withWaiting(next, scope, []) : next;
}

/** 记一次回应：他最近一次回应她的时刻。 */
function answer(state: RelationsState, id: string, at: number): RelationsState {
  const prev = state.people[id];
  if (!prev) return state;
  return {
    ...state,
    people: {
      ...state.people,
      [id]: { ...prev, seen: { ...prev.seen, lastAnswerAt: at } },
    },
  };
}

// ── 视图 ─────────────────────────────────────────────────────────────

/** 意愿层自己的结局（想过、决定先不）：不是关系，留在世界 base 的 willingness 上。 */
export interface Willingness {
  consideredAt: number;
  declines: number;
}

/** 读者拿到的人：关系（只读）和意愿层自己的结局。 */
export interface RelationView {
  id: string;
  name: string;
  bot: boolean;
  /** 他上一次在任何地方说话。 */
  lastActiveAt: number;
  /** 上一次和她"有回应的互动"：私聊来找她、点名她、回应了她的话。关系冷却从这里算。 */
  lastBondAt: number;
  /** 他上一次来找她（私聊、点名、回复她）：隔了多久才来找我。 */
  lastToHerAt: number;
  /** 说过几条。 */
  count: number;
  /** 她上一次想过要不要主动找这个人、决定先不。 */
  consideredAt: number;
  /** 连着第几次决定先不找他（只在那之后没有新的互动时作数）。 */
  declines: number;
  /** 他开的往来、她先开口的次数。 */
  theirs: number;
  hers: number;
  herAt: number;
  /** 第一次有往来（认识多久）。 */
  firstAt: number;
  /** 有过来往：他找过她、她也回应过。 */
  exchanges: number;
}

/** 自从上一次有回应的互动以来，她连着几次想过、决定先不找他（drives.ts contactCooling 的退避）。 */
export function declineRun(
  view: Pick<RelationView, "consideredAt" | "lastBondAt" | "declines">,
): number {
  return view.consideredAt > view.lastBondAt ? view.declines : 0;
}

type RelationWorld = View<"relations" | "willingness">;

/** 一个人的只读视图；没有这个人的记录时 undefined。 */
export function relationView(world: RelationWorld, id: string): RelationView | undefined {
  const r = world.relations.people[id];
  if (!r) return undefined;
  const w = world.willingness[id];
  return {
    id,
    name: r.name,
    bot: r.bot,
    lastActiveAt: r.seen.lastAt,
    lastBondAt: r.seen.lastAnswerAt,
    lastToHerAt: r.seen.lastToHerAt,
    count: r.seen.count,
    consideredAt: w?.consideredAt ?? 0,
    declines: w?.declines ?? 0,
    theirs: r.seen.theirs,
    hers: r.seen.hers,
    herAt: r.seen.herAt,
    firstAt: r.warmth.firstAt,
    exchanges: r.warmth.exchanges,
  };
}

/** 读过时的名字（日记、记得的事、出处、卡片）。 */
export const nameOf = (
  world: View<"relations">,
  id: string | null | undefined,
): string | undefined =>
  id === null || id === undefined ? undefined : world.relations.people[id]?.name;

/**
 * 熟悉（familiar 的算法，原样搬到这里，两处共用一份）：他多常冲着她说话、他是老面孔、新来的、还是说不准。
 * 不存结论：每次读时从有往来的日子、第一次看见、群里的入群提示和会话的"记录前就在"算。
 */
export type FamiliarKind = "old" | "new" | "unknown";

/** 坐在一个群里的日子：折扣后的被看见的日数（从第一次看见他到今天）和有往来的日数。 */
function exposure(seen: Seen, today: number): { seen: number; talked: number } {
  const firstDay = localDay(seen.firstAt);
  const span = today - firstDay + 1;
  return {
    seen: (1 - DAILY ** span) / (1 - DAILY),
    talked: seen.toHerDays.reduce((sum, d) => sum + DAILY ** (today - d), 0),
  };
}

/** 老面孔 / 新来 / 说不准：从群里的日子和入群提示算（familiar 的 kindOf）。 */
export function familiarKind(store: RelationStore, id: string): FamiliarKind {
  const r = store.people[id];
  if (!r) return "unknown";
  for (const [scope, room] of Object.entries(r.seen.rooms)) {
    if (store.groups[scope]?.prior === true && room.joinedAt === null) return "old";
  }
  for (const [scope, room] of Object.entries(r.seen.rooms)) {
    if (store.groups[scope]?.prior !== true || room.joinedAt !== null) return "new";
  }
  for (const g of Object.values(store.groups)) if (g.joined[id] !== undefined) return "new";
  return "unknown";
}

/** 最近一次看到他的入群提示（带进群提示的新来的人：卡片写"3 天前进的群"）。 */
export function joinedAt(store: RelationStore, id: string): number | null {
  let last: number | null = null;
  for (const g of Object.values(store.groups)) {
    const at = g.joined[id];
    if (at !== undefined && (last === null || at > last)) last = at;
  }
  return last;
}

/** 每一类人汇总的"有往来的日子占比"（经验贝叶斯的先验均值）。 */
export function pooled(
  people: Readonly<Record<string, Relation>>,
  today: number,
  kind: (id: string) => FamiliarKind,
): Record<FamiliarKind, number> {
  const sums: Record<FamiliarKind, [number, number]> = {
    old: [0, 0],
    new: [0, 0],
    unknown: [0, 0],
  };
  for (const [id, r] of Object.entries(people)) {
    const e = exposure(r.seen, today);
    const s = sums[kind(id)];
    s[0] += e.talked;
    s[1] += e.seen;
  }
  const mean = ([t, n]: [number, number]) => (n > 0 ? t / n : 0);
  return { old: mean(sums.old), new: mean(sums.new), unknown: mean(sums.unknown) };
}

/** 第一次看见他之后已经过了整整一周（按日历日）。 */
export const watchedAWeek = (seen: Seen, today: number): boolean =>
  today - localDay(seen.firstAt) >= PRIOR_DAYS;

/** 收缩后的占比与频率词；看见不满一周、或往来少到说不出频率时为 null。 */
export function frequency(
  seen: Seen,
  mu: number,
  today: number,
): { p: number; word: string } | null {
  if (!watchedAWeek(seen, today)) return null;
  const e = exposure(seen, today);
  const p = (PRIOR_DAYS * mu + e.talked) / (PRIOR_DAYS + e.seen);
  const word =
    RATES.find(([min]) => p >= min)?.[1] ?? (seen.toHerDays.length >= 2 ? "聊过几次" : null);
  return word ? { p, word } : null;
}

type People = Pick<RelationStore, "people">;

/** 认识多久（满两周才说）。 */
export function knownFor(store: People, id: string, now: number): string | null {
  const first = store.people[id]?.warmth.firstAt ?? 0;
  if (first <= 0) return null;
  const days = (now - first) / DAY_MS;
  if (now - first < KNOWN_FOR_MS) return null;
  if (days < 30) return `认识 ${Math.floor(days / 7)} 周了`;
  if (days < 365)
    return `认识${Math.floor(days / 30) === 1 ? "一个多" : ` ${Math.floor(days / 30)} 个`}月了`;
  return "认识一年多了";
}

/** 谁在找谁（往来满 4 次才说；差不多就不说）。 */
export function whoSeeks(store: People, id: string): string | null {
  const r = store.people[id];
  if (!r) return null;
  const total = r.seen.theirs + r.seen.hers;
  if (total < SEEKING_MIN) return null;
  const theirShare = r.seen.theirs / total;
  if (theirShare >= 0.7) return "多是对方先找我";
  if (theirShare <= 0.3) return "多是我先找对方";
  return null;
}

/** 某人此刻在所有人里的亲近排名（1 = 最亲近）；没来往过返回 null。 */
export function rankOf(store: People, id: string, now: number): number | null {
  const me = store.people[id];
  if (!me || me.warmth.lastExchangeAt <= 0) return null;
  const mine = decayed(me.warmth, now);
  let rank = 1;
  for (const [other, r] of Object.entries(store.people)) {
    if (other !== id && r.warmth.lastExchangeAt > 0 && decayed(r.warmth, now) > mine) rank++;
  }
  return rank;
}

/** 第 4 片之前层级用的排名换算；没来往过或 150 名以外是 500（world.ts tierOf 读它）。 */
export function rankedTier(store: People, id: string | null, now: number): Tier {
  if (!id) return 500;
  const rank = rankOf(store, id, now);
  if (rank === null) return 500;
  return rank <= 5 ? 5 : rank <= 15 ? 15 : rank <= 50 ? 50 : rank <= 150 ? 150 : 500;
}

/**
 * 候选（第 4 片）：层级从校准过的联系频率分档（Dunbar 的层按联系频率定义；几天的排名不稳）。
 * 初稿的界按卡片的频率词字面意思：一周 5 天以上 → 5，一周 2 天以上 → 15，一个月两次以上 → 50，聊过几次 → 150，
 * 其余（看见不满一周、只来往过一次、只在私聊见过还说不准）→ 500。界要先在数据上量，这里不照抄任何一边。
 * 在它之下，`tier-unbacked`（层级 ≤ 15 而看见不满一周）按构造是 0。
 */
export function familiarityTier(store: RelationStore, id: string | null, now: number): Tier {
  if (!id) return 500;
  const r = store.people[id];
  // 机器人和以频道身份发言的不是人（familiar 的卡片不写它们，也不进同类的占比）。
  if (!r || r.bot || id.startsWith("-")) return 500;
  const today = localDay(now);
  if (!watchedAWeek(r.seen, today)) {
    if (r.warmth.exchanges >= 2 && r.seen.toHerDays.length >= 2) return 50;
    if (r.warmth.exchanges >= 1) return 150;
    return 500;
  }
  const kind = familiarKind(store, id);
  const people = Object.fromEntries(
    Object.entries(store.people).filter(([other, p]) => !p.bot && !other.startsWith("-")),
  );
  const mu = pooled(people, today, (other) => familiarKind(store, other))[kind];
  const f = frequency(r.seen, mu, today);
  if (!f) return r.seen.toHerDays.length >= 2 ? 150 : 500;
  if (f.p >= 5 / 7) return 5;
  if (f.p >= 2 / 7) return 15;
  if (f.p >= 1 / 15) return 50;
  return 150;
}

/** 她对这个人的回避（已归一）：别的回避按 tanh 压在 1 以内，叫她别回的那几笔另加、不压。 */
function toward(world: View<"relations">, id: string, now: number): number {
  return Math.tanh(aversionToward(world.relations, id, now)) + stopToward(world.relations, id, now);
}

/**
 * 意愿层的回避读哪个数（已归一，直接乘代价权重）。只对冲着人的动作（有人在等她，动作不进出会话）；其余返回 null，
 * 读会话的那一项。
 * - 一条消息叫醒她时（waker 是发这条的人）：读这个人自己的回避。叫她别回的人发来的话，不能借另一个也在等她、
 *   她不躲的人叫醒她（线上 11:24 那次就是这样又被叫醒的）；别人的话叫醒她照常，她回谁由卡片上那一句管。
 * - 节律到点时（没有 waker）：读在等她的人里回避最小的那个——她可以去回她不躲的那个人。
 */
export function personAversion(
  world: View<"relations" | "chats">,
  scope: string,
  affordance: Pick<WillAffordance, "after">,
  now: number,
  waker?: string | null,
): number | null {
  if (memberAfter(affordance) !== undefined) return null;
  const waiting = world.relations.waiting[scope] ?? [];
  if (waiting.length === 0) {
    // 私聊里对方就是唯一的人：就算她刚刚已经回过、waiting 已清空，对方最近的回避（如叫她别回）依然算在头上。
    const partner = world.chats[scope]?.partner;
    return partner ? toward(world, partner, now) : null;
  }
  if (waker) return toward(world, waker, now);
  return Math.min(...waiting.map((id) => toward(world, id, now)));
}

/**
 * 叫她别回的那一笔，她知道：写在卡片上那个人的名下（"Ani：30 分钟前叫我别回 Ta 的消息"）。意愿层只管别被那个人的话
 * 叫醒；她被别人叫醒时靠这一句知道这件事。只在那件事发生的会话里、和那个人的私聊里出现；和那一笔同一个时间常数淡掉，
 * 剩到 STOP_SHOWN 以下（约 4.2 小时后）就不再写。写的是她知道的事，不是禁令。
 */
export function stopNotes(
  world: View<"relations" | "chats">,
  scope: string,
  now: number,
): PersonNote[] {
  const partner = world.chats[scope]?.partner ?? null;
  const notes: PersonNote[] = [];
  for (const [id, { hurts }] of Object.entries(world.relations.people)) {
    const here = hurts.filter((h) => h.why === "stop" && (h.scope === scope || id === partner));
    const last = here.at(-1);
    if (!last || fade(last, now, STOP.tau) < STOP_SHOWN) continue;
    notes.push({
      id,
      name: world.relations.people[id]?.name ?? "有人",
      facts: [`${elapsed(Math.max(0, now - last.at))}前叫我别回 Ta 的消息`],
    });
  }
  return notes;
}

/**
 * 那一笔还"在"的界：剩到 2 以下（8 淡到 2，约 4.2 小时）就不再写上卡片。和意愿层对齐：被点名时 λ = 0.45，剩 2 时
 * 回那个人的代价约 0.9，还压得住他一条话带来的缓解（test/pressure-properties.test.ts A4）；再往后就不一定了，
 * 卡片也就不再说。手设。
 */
export const STOP_SHOWN = 2;

const relationContribute = ({
  world,
  chat,
  now,
}: FeatureContext<View<"relations" | "chats">>): Contribution[] => {
  const people = stopNotes(world, chat.scope, now);
  return people.length === 0
    ? []
    : [
        {
          mechanism: "relation",
          kind: "people",
          text: people.map((p) => `${p.name}：${p.facts?.join("；")}`).join("\n"),
          people,
        },
      ];
};

const relationBase = {
  provides: ["relations"] as const,
  requires: ["chats"] as const,
  will: { aversion: personAversion },
  contribute: relationContribute,
};

/** 候选（第 4 片）：层级从熟悉度分档。只改读法（tierOf 读 relations.tierFromFamiliarity），不改 fold。 */
function relationOf(options: RelationOptions): PressureFeature {
  const open = (world: View<"relations" | "chats">, _event: AliceEvent) =>
    world.relations.tierFromFamiliarity
      ? world
      : { ...world, relations: { ...world.relations, tierFromFamiliarity: true as const } };
  return feature<"relations", "chats">({
    name: options.tierFromFamiliarity ? "relation-tier" : "relation",
    ...relationBase,
    ...(options.tierFromFamiliarity ? { open } : {}),
    reduce: (before, after, event) => {
      const next = reduceRelations(after.relations, after, event, before);
      return next === after.relations ? after : { ...after, relations: next };
    },
  });
}

interface RelationOptions {
  /**
   * 候选（docs/research/relationship.md 第 4 片）：层级从校准过的联系频率分档，而不是排名。
   * 生产是 false（排名），等量过再换。
   */
  tierFromFamiliarity?: boolean;
}

/** 生产：回避按人记（第 1 片），层级仍按亲近分数排名。 */
export const relation: PressureFeature = relationOf({});

/** 候选第 4 片：层级从熟悉度来（world.ts tierOf 读 relations.tierFromFamiliarity）。 */
export const relationTier: PressureFeature = relationOf({ tierFromFamiliarity: true });
