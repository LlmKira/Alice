/**
 * 她的心情（capabilities.md R01/R02/R12）：DynAffect（Kuppens, Oravecz & Tuerlinckx 2010, JPSP 99(6)）
 * 的核心情感效价——围绕一个常态（home base）波动，被回归力（attractor strength）拉回常态，波动来自她察觉不到
 * 来由的内外因素（OU 过程，随机数由外壳抽、写成 noise.drawn 事件，键 "mood"）；她对经历的评价（反思写下的心情、
 * 她自己写的 [心情]）把效价推到那个词的位置，带着原因。词是她自己写的，效价由外壳问判口气的模型
 * （llm/tone.ts perceiveMood，记在事件上）；判不出效价的心情不 fold 进来。
 *
 * 她只有这一份心情：发言提示词里的那一行、反思时"你此刻的心情"、[心情] 这项能力都读写它（压力场的一样，
 * world.affect）。以前压力场的记忆还另折一份（半衰期 1 小时、按词的效价），发言提示只显示这一份，反思却读那一份，
 * 两处说的心情可能对不上。
 * - 更常在场：评价还在时总写（带着是多久之前的）；没有评价时写此刻效价对应的词（多半是平静，2 月 "Your current mood"
 *   的写法，可见 89–100%），但这个会话里在她上一次评价之后又有人来找过她时不写：那时她还没顾上想刚才的事，
 *   一句不带时间的"平静"就是错的（试跑 v2-02：群里被问有没有感情时提示里写着平静）。
 * - 原因跟着评价走：评价本身按回归力衰减、还看得出来（约 1.5–2 小时），而且此刻的效价还在那一侧，就带着原因，
 *   不论在哪个会话；之后效价再偏到同一侧只是波动，不再归给那件事（开发集里 13/99 条原因是这样被波动续上的，
 *   最久一条是 9 小时前的"4天没理我"）。
 * - 跨会话可用，和日记同一条（diary.ts reaches）：原因带到别的会话时注明在哪（"在「X」群里""和 Y 私聊时"）；
 *   标了私密的原因只在那个会话、和当时在场的人的私聊里说，别处只说"因为别处的一件事"。
 * - 她说了 [算了 编号] 的那个会话里的负面心情，原因后面注明她说过先不追究了（翻篇是她自己的事，系统不替她消气）。
 * - 很久没人找她：醒着的这么久里没有人私聊、点名或回复她，作为此刻的事实写一句（孤单不替她写成心情）。
 *
 * 2 月同一套机制造成过的毛病和当年的修复，这里都带上：
 * - 反复说同一个词让心情永不消退（ADR-89/30）：同方向、差得不多的评价不把效价重新推满（条件重置）。
 * - 衰减的终点是温暖的常态，不是 0（ADR-89 WARM_BASELINE = 0.05）。
 * - 陈旧的原因放大负面叙事（2 月原因只显示 30 分钟）：原因只在评价本身还看得出来时显示，更久的事是日记的职责。
 * - 迁怒（ADR-89：生气后对所有人发火）：别处来的原因不说内容，只说是别处的事。
 * - 反刍循环（ADR-95：系统反复把她推回创伤源）：这里不叫醒她、不改意愿，只放事实。
 *
 * 接口：只读事件（noise.drawn 的 "mood"、act.done 的 feel 与 let-go、ponder.done 的反思心情、message.received），
 * 只写提示词和反思请求里的心情。不影响意愿、唤醒、等待时长；精力与想不想社交是 life 的，这里不碰。
 *
 * 底色（候选 warmth，eval-artifacts/warmth/prereg.md）。上线第一天 80 次发言提示里心情只有平静 51、无聊 22、烦 6：
 * 评价只从她反思时写的心情来，而她多半在机器人刷屏的群里反思；有人来找她、问她近况，心情一点不动。三处改动：
 * - 常态取量出来的人：DynAffect 研究 1 的效价常态 5.95（0.1–9.9 量表，中点 5），换到 [−1, 1] 是 +0.19
 *   （原来的 0.05 是 2 月手设的）。人格里写的暖不另加一个数：它落在下面"被人找"的评价上。
 * - 评价的强度按这件事和她有多大关系（Lazarus 的初级评价：与自己相关才有情绪，相关程度定强度）：反思的那段里
 *   有人找过她、或她说过话，评价推满；她只是在旁边看着，只推 REFLECT.ambient（反思触发里旁观一条消息的分量，
 *   和冲着她的一条比）。所以刷屏的群只让她轻微地闷一下，不会盖过她，也不会带着"别处的一件事"跟到别的会话。
 * - 被人找是一次社会性的评价（sociometer：被接纳抬高正面情感，Leary et al. 1995）：有人私聊、点名、回复她，
 *   推多少按这个人隔了多久才来找她（1 − 2^(−间隔/心情半衰期)：一直在聊的人每条只添一点，隔了一阵来找她的推满，
 *   "Someone reaches out after a while, it means something"）。推到哪里看有没有过来往（他找过她、她也回应过，
 *   互惠）：有过的朝"开心"推；还没有的只把她拉回常态（社会基线理论，Coan & Sbarra 2015：有人在身边是常态，
 *   不是奖赏；"Just met → … not cold, just seeing who you are first"）。所以别处的烦闷不会跟着她去见来找她的人，
 *   一个第一次冒出来点名挑衅的人也不会让她开心。这里有她自己刚有的负面心情时不推：那件事她还在这里，由她自己
 *   再评价。同一段对话里随着对方的口气暖起来，要靠以后感知给出的口气（bid 的 tone）；现在没有。
 */
import type { AliceEvent, ChatType } from "../../mind/events.js";
import type { Contribution } from "../../mind/mechanism.js";
import { ou, ouStep } from "../../mind/noise.js";
import { elapsed } from "../../mind/when.js";
import { feature, type PressureFeature, type View, type WillTerms } from "./feature.js";
import type { LifeBodyState } from "./life-body.js";
import { MOOD_RESET, MOOD_VISIBLE, REFLECT } from "./params.js";
import { placeOf } from "./place.js";
import { rejectionAt } from "./rejection.js";
import type { RelationsState } from "./relation.js";
import { awakeBetween, isAsleep } from "./sleep.js";

const MIN = 60_000;
const H = 60 * MIN;

/**
 * DynAffect 的三个量（效价在 [−1, 1]，时间按小时）。常态取 2 月的温暖基线 0.05；回归力取 2 月的心情半衰期 1 小时
 * （θ = ln2 / 1h，和 ESM 研究里相隔一两个小时的效价自相关 0.3–0.5 同一量级）；波动的平稳标准差 0.15，
 * 只靠波动时约 9% 的时候是"有点闷"、2% 的时候"心情不错"，其余平静。都是手设，没有按数据拟合。
 * 常态是她状态里的一项（AffectState.home）：候选 warmth 换成量出来的常态 HOME_MEASURED。
 * AFFECT_SD：效价偏离常态多少个它，是想不想说话耦合心情时用的标准分（life.ts）。
 */
export const AFFECT_SD = 0.15;
const HALF_LIFE_H = 1;
export const AFFECT = ou({ mu: 0.05, sd: AFFECT_SD, halfLife: HALF_LIFE_H });
/**
 * 量出来的常态：Kuppens, Oravecz & Tuerlinckx 2010 研究 1（N = 79）表 2，效价常态的总体均值 5.95，
 * 量表 0.1–9.9、中点 5；换到 [−1, 1]：(5.95 − 5) / 4.9 ≈ 0.19（研究 2 是 5.82，≈ 0.17）。
 */
const HOME_MEASURED = 0.19;
/**
 * 认识的人来找她时，评价推向的词和效价。0.6 是以前心情词表里"开心"的数（手设）；判口气的模型给"开心"0.70
 * （探针 2026-11-13），沿用旧数，免得被人找这条闭环跟着变。
 */
const BID = { word: "开心", valence: 0.6 } as const;
/** 醒着的这么久里没有人找她，就写一句。手设：醒着的一天约 16 小时，四分之一。 */
const LONELY_AWAKE = 4 * H;
/** 群里"当时在场"的人：最近说过话的这么多条消息的发言人（和日记的受众规则同一口径）。 */
const PRESENT_LINES = 30;
/** tone：每个会话记最近几条找她的消息是谁发的（口气晚到时认人）。口气在一次叫醒里判完，几条足够。手设。 */
const SOUGHT_KEPT = 10;

interface Appraisal {
  word: string;
  /** 这次评价把效价推到了哪里（推满时就是这个词被判出的效价）。 */
  valence: number;
  why: string | null;
  scope: string;
  group: boolean;
  /** 评价时那个会话里在场的人（私聊是对方；群里是最近说话的人）。 */
  present: readonly string[];
  at: number;
  /** 评价本身从这里开始衰减（同方向、差得不多的再评价不重置，2 月条件重置）。 */
  since: number;
  /** 她在那个会话里说过算了、先不追究。 */
  letGo: boolean;
  /** 原因是别人托她保密的、明显私密的（她写下时自己标的）：只有这样的原因守受众规则。 */
  private?: true;
}

interface Place {
  chatType: ChatType;
  partner: string | null;
  senders: readonly string[];
  /** 这里上一次有人找她（私聊、点名、回复她）。 */
  soughtAt: number;
  /** 她这里上一次说话（message.sent）。 */
  spokeAt?: number;
  /** 她这里上一次评价（[心情] 或反思的心情）。 */
  appraisedAt?: number;
  /** 她上次在这里说话之后来找过她的人（她再开口就算回应了他们）。 */
  waiting?: readonly string[];
  /** 最近几条找她的消息是谁发的（tone：口气晚到时认出是谁；只在 warmth.tone 时记）。 */
  sought?: ReadonlyArray<readonly [messageId: string, who: string]>;
}

/** 一次"被人找"把心情推向开心：推之前的心情和推的那条消息（tone：那条后来判成冷淡、敌意时退回）。 */
interface Pushed {
  scope: string;
  messageId: string;
  at: number;
  prior: Pick<AffectState, "valence" | "at" | "appraisal">;
}

export interface AffectState {
  /** 核心情感效价，at 时刻的值；从来没有事件时是常态。 */
  valence: number;
  at: number;
  /** 她的常态（DynAffect 的 home base）。 */
  home: number;
  appraisal: Appraisal | null;
  places: Readonly<Record<string, Place>>;
  /** 上一次有人找她（私聊、点名、回复她）。 */
  soughtAt: number | null;
  /** 最近一次"被人找"推向开心（tone）。 */
  pushed?: Pushed;
  /** 饿/困给心情的即时偏移（[-0.2, 0]），吃饱或睡醒自动消退（ADR-276）。 */
  bodyOffset?: number;
}

export const initialAffect: AffectState = {
  valence: AFFECT.mu,
  at: 0,
  home: AFFECT.mu,
  appraisal: null,
  places: {},
  soughtAt: null,
};

/** 她的心情的动力学：回归力和波动不变，常态是她自己的。 */
const dynamics = (state: AffectState) => ({ ...AFFECT, mu: state.home });

/** 没有新的波动时，效价按回归力回到常态（OU 的期望）。 */
export function valenceAt(state: AffectState, now: number): number {
  const base = ouStep(state.valence, dynamics(state), Math.max(0, now - state.at) / H, 0);
  const offset = state.bodyOffset ?? 0;
  if (!offset) return base;
  return Math.max(-1, Math.min(1, base + offset));
}

/**
 * 候选 warmth 的三处（eval-artifacts/warmth/prereg.md）：home 量出来的常态；relevance 评价按和她的关系定强度；
 * bids 被人找是一次评价。都关着就是生产。
 */
export interface Warmth {
  home: boolean;
  relevance: boolean;
  bids: boolean;
  /**
   * tone（生产，2026-11-13；docs/research/relationship.md 第 2 片）：外壳判出一条找她的话冷淡或敌意时，那一条带来的
   * 推向开心退回去，那个人也不因她回了这一条就算"有过来往"。
   */
  tone?: boolean;
}
const NO_WARMTH: Warmth = { home: false, relevance: false, bids: false };

function presentIn(place: Place | undefined): string[] {
  if (!place) return [];
  return place.partner ? [place.partner] : [...new Set(place.senders)];
}

/**
 * 她的一次评价：推向那个词的效价，weight 是推多少（1 推满，生产里总是 1）；和此刻同方向、差得不多就不重推
 * （2 月条件重置）。没推满、推了之后离常态还不到看得出来的程度（MOOD_VISIBLE）时，只动效价，不记成一次评价：
 * 一件和她关系不大的事只让她轻微地偏一下，说不出是因为它。
 */
function appraise(
  state: AffectState,
  mood: {
    word: string;
    why: string | null;
    valence?: number | undefined;
    private?: true | undefined;
  },
  scope: string,
  at: number,
  weight = 1,
  own = true,
): AffectState {
  const { word, why, valence: target, private: secret } = mood;
  if (target === undefined) return state;
  const current = valenceAt(state, at);
  const valence = current + weight * (target - current);
  const home = state.home;
  const place = state.places[scope];
  // 她自己的评价（[心情]、反思）记下时刻，"这件事和她有多大关系"从这里往后数；被人找不算她自己评价过。
  const places =
    own && place ? { ...state.places, [scope]: { ...place, appraisedAt: at } } : state.places;
  if (weight < 1 && Math.abs(valence - home) < MOOD_VISIBLE) {
    return { ...state, valence, at, places };
  }
  const same =
    Math.sign(current - home) === Math.sign(valence - home) &&
    Math.abs(current - valence) <= MOOD_RESET;
  const reason = why
    ? why
        .trim()
        .replace(/^因为/, "")
        .replace(/[。.！!]+$/u, "")
        .slice(0, 100) || null
    : null;
  return {
    ...state,
    valence: same ? current : valence,
    at,
    places,
    appraisal: {
      word,
      valence,
      why: reason,
      scope,
      group: place?.chatType === "group",
      present: presentIn(place),
      at,
      since: same && state.appraisal ? state.appraisal.since : at,
      letGo: false,
      ...(secret ? { private: true as const } : {}),
    },
  };
}

/** 给别的机制（如正向回流）写一条心情评价：复用 appraise 的条件重置与原因归一。 */
function pushAppraisal(
  state: AffectState,
  mood: {
    word: string;
    why: string | null;
    valence: number;
    scope: string;
    present: readonly string[];
    at: number;
    weight?: number;
  },
): AffectState {
  return appraise(
    state,
    { word: mood.word, why: mood.why, valence: mood.valence },
    mood.scope,
    mood.at,
    mood.weight ?? 1,
    false,
  );
}

/** 评价本身此刻还剩多少（不算波动）：(v − μ)·2^(−Δt/半衰期)。 */
function appraisalLeft(a: Appraisal, home: number, now: number): number {
  return (a.valence - home) * Math.exp(-AFFECT.theta * (Math.max(0, now - a.since) / H));
}

/** 她对一个人来找她的口气的感知（以后由感知给出；现在没有，按 undefined）。 */
type BidTone = "warm" | "cold";

/**
 * 一个人来找她（候选 warmth 的 bids）。推多少按他隔了多久才来：1 − 2^(−间隔/心情半衰期)，记录里第一次来算隔了
 * 很久；一直在聊的人每条只添一点。推到哪里看有没有过来往（他来找过她、她也回应过）：有过的朝"开心"推
 * （"Someone reaches out after a while, it means something"）；还没有的只把她拉回常态（社会基线：有人来是常态，
 * 不是奖赏；"Just met → … not cold"）。所以一个第一次冒出来、点名挑衅她的人不会让她开心。
 * 只往上推，不往下拉；她自己刚有的负面心情还看得出来、而且是在这里有的或这个人当时在场时不推（那件事她还在
 * 心里，由她自己再评价）。
 * 口气冷淡时（tone，以后的感知给出）只记下他来过。
 */
function bid(
  state: AffectState,
  b: { who: string; name: string; scope: string; at: number; tone?: BidTone },
  /** 关于这个人的关系事实（relation.ts）：上一次来找她、有没有过来往。 */
  person: { lastToHerAt: number; met: boolean },
  pushedBy?: string,
): AffectState {
  const last = person.lastToHerAt > 0 ? person.lastToHerAt : undefined;
  const place = state.places[b.scope] as Place;
  const waiting = place.waiting ?? [];
  const marked: AffectState = {
    ...state,
    places: {
      ...state.places,
      [b.scope]: { ...place, waiting: waiting.includes(b.who) ? waiting : [...waiting, b.who] },
    },
  };
  if (b.tone === "cold") return marked;
  const v = valenceAt(state, b.at);
  const a = state.appraisal;
  // 她自己刚有的负面心情：在这里有的，或者这个人当时就在场（群里惹她的人追进私聊）。
  if (
    a &&
    (a.scope === b.scope || a.present.includes(b.who)) &&
    a.valence < state.home &&
    heldAt(a, state.home, v - state.home, b.at)
  ) {
    return marked;
  }
  const weight = last === undefined ? 1 : 1 - 2 ** (-(b.at - last) / (HALF_LIFE_H * H));
  if (!person.met) {
    return v >= state.home
      ? marked
      : { ...marked, valence: v + weight * (state.home - v), at: b.at };
  }
  if (v >= BID.valence) return marked;
  const mood = { word: BID.word, valence: BID.valence, why: `${b.name}来找我` };
  const next = appraise(marked, mood, b.scope, b.at, weight, false);
  // tone：记下这次推向开心之前的心情，那条话后来判成冷淡、敌意时退回到这里。
  if (pushedBy === undefined || next.appraisal === marked.appraisal) return next;
  const prior = { valence: marked.valence, at: marked.at, appraisal: marked.appraisal };
  return { ...next, pushed: { scope: b.scope, messageId: pushedBy, at: b.at, prior } };
}

/**
 * tone：一条找她的话被判成冷淡或敌意（message.perceived 的 tone，比消息晚到）。那个人不因她回了这一条就算
 * "有过来往"（从在等她的人里去掉）；这一条推向开心的那次退回到推之前，只退它自己那一次：之后有了新的评价就不动
 * （和原 closeness 机制的 retract 同一个形状）。
 */
function unfriendly(state: AffectState, scope: string, messageId: string): AffectState {
  const place = state.places[scope];
  const who = place?.sought?.find(([id]) => id === messageId)?.[1];
  const places =
    place && who && place.waiting?.includes(who)
      ? { ...state.places, [scope]: { ...place, waiting: place.waiting.filter((w) => w !== who) } }
      : state.places;
  const p = state.pushed;
  const own = p?.scope === scope && p.messageId === messageId;
  if (!own) return places === state.places ? state : { ...state, places };
  const { pushed: _, ...rest } = state;
  return state.appraisal?.at === p.at ? { ...rest, places, ...p.prior } : { ...rest, places };
}

type EventOf<T extends AliceEvent["type"]> = Extract<AliceEvent, { type: T }>;

/** 背景波动走一格（OU 过程，随机数是外壳抽的 "mood"）。 */
function drift(state: AffectState, event: EventOf<"noise.drawn">): AffectState {
  const z = event.draws.mood;
  if (z === undefined) return state;
  // 第一格只定下起点：之前没有经过的时间。
  if (state.at === 0) return { ...state, at: event.at };
  return {
    ...state,
    valence: ouStep(state.valence, dynamics(state), (event.at - state.at) / H, z),
    at: event.at,
  };
}

/** 有人在这个会话里说话：记下在场的人和有没有人找她；warmth.bids 开着时，被人找是一次评价。 */
function received(
  state: AffectState,
  event: EventOf<"message.received">,
  warmth: Warmth,
  relations: Pick<RelationsState, "people"> | undefined,
): AffectState {
  const prev = state.places[event.scope];
  const sought = event.directed || event.chatType === "private";
  const place: Place = {
    ...prev,
    chatType: event.chatType,
    partner: event.chatType === "private" ? event.senderId : (prev?.partner ?? null),
    senders: [...(prev?.senders ?? []), event.senderId].slice(-PRESENT_LINES),
    soughtAt: sought ? event.at : (prev?.soughtAt ?? 0),
    ...(warmth.tone && sought
      ? {
          sought: [...(prev?.sought ?? []), [event.messageId, event.senderId] as const].slice(
            -SOUGHT_KEPT,
          ),
        }
      : {}),
  };
  const next: AffectState = {
    ...state,
    at: state.at === 0 ? event.at : state.at,
    places: { ...state.places, [event.scope]: place },
    soughtAt: sought ? event.at : state.soughtAt,
  };
  if (!warmth.bids || !sought) return next;
  const who = relations?.people[event.senderId];
  return bid(
    next,
    { who: event.senderId, name: event.senderName, scope: event.scope, at: event.at },
    {
      lastToHerAt: who?.seen.lastToHerAt ?? 0,
      met: (who?.warmth.exchanges ?? 0) > 0,
    },
    warmth.tone ? event.messageId : undefined,
  );
}

/** 她自己写的 [心情] 是一次评价；[算了] 只给这个会话里还在的负面评价记一笔翻篇。 */
function acted(state: AffectState, event: EventOf<"act.done">): AffectState {
  const act = event.act;
  if (act.kind === "feel") {
    const mood = {
      word: act.mood,
      why: act.why,
      valence: event.valence,
      ...(act.secret ? { private: true as const } : {}),
    };
    return appraise(state, mood, event.scope, event.at);
  }
  const a = state.appraisal;
  if (act.kind === "let-go" && a && a.scope === event.scope && a.valence < 0) {
    return { ...state, appraisal: { ...a, letGo: true } };
  }
  return state;
}

function reflected(
  state: AffectState,
  event: EventOf<"ponder.done">,
  warmth: Warmth,
  rejected: number,
): AffectState {
  const p = event.ponder;
  if (p.kind !== "reflect" || !p.mood) return state;
  // 那里的人正嫌她时，反思写下的好心情推得少：推多少乘 1 − tanh(嫌她的程度)，和那里开口的代价同一个量
  // （PLAN 第 3 件：线上 11-13 骂战里 9 次反思有 6 次写开心或兴奋）。不好的心情照常。
  const good = (p.mood.valence ?? state.home) > state.home;
  const damp = good ? 1 - Math.tanh(rejected) : 1;
  return appraise(
    state,
    p.mood,
    p.scope,
    event.at,
    (warmth.relevance ? relevance(state, p.scope) : 1) * damp,
  );
}

/**
 * fold 一个事件。warmth 默认全关（生产）；关着时和以前逐字节相同的状态转移（多出的几个字段不进提示词）。
 */
export function reduceAffect(
  state: AffectState,
  event: AliceEvent,
  warmth: Warmth = NO_WARMTH,
  /** 反思的那个会话里此刻嫌她的程度（turn.ts rejectionAt）；不给是 0。 */
  rejected = 0,
  /** 关于人的关系事实（relation.ts）："被人找"读他上次来找我的时刻、有没有过来往。 */
  relations?: Pick<RelationsState, "people">,
): AffectState {
  switch (event.type) {
    case "noise.drawn":
      return drift(state, event);
    case "message.sent": {
      // 她在这里开口：记下时刻（评价强度）。在这里等她的人算她回应过了（有过来往）那一笔由 relation fold 进
      // relations（warmth.exchanges），这里只清掉自己的等待名单。
      const prev = state.places[event.scope];
      if (!prev || !(warmth.relevance || warmth.bids)) return state;
      return {
        ...state,
        places: { ...state.places, [event.scope]: { ...prev, spokeAt: event.at, waiting: [] } },
      };
    }
    case "message.received":
      return received(state, event, warmth, relations);
    case "message.perceived": {
      if (!warmth.tone || (event.tone !== "cold" && event.tone !== "hostile")) return state;
      return unfriendly(state, event.scope, event.messageId);
    }
    case "act.done":
      return acted(state, event);
    case "ponder.done":
      return reflected(state, event, warmth, rejected);
    default:
      return state;
  }
}

/**
 * 反思的那件事和她有多大关系：自她上次在那里评价起，有人找过她或她说过话，是 1；她只在旁边看着，是
 * REFLECT.ambient（反思触发里旁观的一条消息和冲着她的一条的比）。
 */
function relevance(state: AffectState, scope: string): number {
  const p = state.places[scope];
  if (!p) return REFLECT.ambient;
  const since = p.appraisedAt ?? 0;
  return Math.max(p.soughtAt, p.spokeAt ?? 0) > since ? 1 : REFLECT.ambient;
}

/** 评价本身还看得出来，而且此刻的效价（含波动）还在那一侧：才是那件事带来的心情。 */
function heldAt(a: Appraisal, home: number, shift: number, now: number): boolean {
  return (
    Math.abs(appraisalLeft(a, home, now)) >= MOOD_VISIBLE &&
    Math.sign(shift) === Math.sign(a.valence - home) &&
    Math.abs(shift) >= MOOD_VISIBLE
  );
}

/** 淡了的心情：她自己的词前面加"还有点"（她写的已经是"有点…"时只加"还"）。 */
function fading(word: string): string {
  return word.startsWith("有点") ? `还${word}` : `还有点${word}`;
}

/** 只有波动、没有她的评价时，效价对应的词。 */
function plainWord(v: number): string {
  if (v >= 0.35) return "心情不错";
  if (v <= -0.35) return "有点低落";
  if (v <= -0.15) return "有点闷";
  return "平静";
}

/**
 * 此刻在这个会话（scope）里能说的心情（卡片里"心情"那一行冒号后面的部分）；没有可说的是 null：
 * - 没有还在的评价、只是平静（out.md 诊断 4-3：平静是她的常态，一句"心情：平静"在中文里读成冷淡、没波澜）；
 * - 没有还在的评价，而她上一次评价之后这里又有人找过她（刚才的事她还没想过）。
 */
export function moodOf(
  state: AffectState,
  scope: string,
  chatType: ChatType,
  now: number,
  place: (scope: string) => string = (s) =>
    state.places[s]?.chatType === "group" ? "在一个群里" : "在别的私聊里",
): string | null {
  const v = valenceAt(state, now);
  const a = state.appraisal;
  const shift = v - state.home;
  if (!a || !heldAt(a, state.home, shift, now)) {
    if ((state.places[scope]?.soughtAt ?? 0) > (a?.at ?? 0)) return null;
    const word = plainWord(v);
    if (word === "平静") return null;
    return `${word}（说不上为什么）`;
  }
  const word = Math.abs(shift) >= Math.abs(a.valence - state.home) / 2 ? a.word : fading(a.word);
  const partner = chatType === "private" ? (state.places[scope]?.partner ?? null) : null;
  // diary.ts reaches：标了私密的原因只在那个会话、和当时在场的人的私聊里说；其余的到哪都说，注明在哪。
  const here = a.scope === scope;
  const witnessed = a.group && partner !== null && a.present.includes(partner);
  const when = `${elapsed(now - a.at)}前`;
  const note = a.letGo ? "，我说过这事先不追究了" : "";
  // 标了私密的在受众之外连她自己的词也不写：词也是那件事的一部分（留出集 v2-02 群里卡片上的"激动且护短
  // （因为别处的一件事）"，eval-artifacts/knowledge-travels/results.md），只说好坏。
  if (a.private && !here && !witnessed) {
    return `${a.valence >= state.home ? "心情不错" : "有点低落"}（${when}，因为别处的一件事）`;
  }
  if (!a.why) return `${word}（${when}${note}）`;
  if (here) return `${word}（${when}，因为${a.why}${note}）`;
  return `${word}（${when}${place(a.scope)}，因为${a.why}${note}）`;
}

/** 醒着的 LONELY_AWAKE 里没有人找过她：那时到现在多久了（醒着的时长）；否则 null。 */
function lonelyFor(state: AffectState, now: number): number | null {
  if (state.soughtAt === null || isAsleep(now)) return null;
  const awake = awakeBetween(state.soughtAt, now);
  return awake >= LONELY_AWAKE ? now - state.soughtAt : null;
}

/**
 * 反思这个会话时她此刻的心情（写进反思请求，D1）：只有她在这个会话里做的评价还在时才写，就是那个词
 * （淡了是"还有点…"）和原因；别处来的心情不带进这里的日记。和发言提示里的那一行读同一份状态。
 */
export function moodFor(
  state: AffectState,
  scope: string,
  now: number,
): { word: string; why: string | null } | null {
  const a = state.appraisal;
  const shift = valenceAt(state, now) - state.home;
  if (!a || a.scope !== scope || !heldAt(a, state.home, shift, now)) return null;
  const word = Math.abs(shift) >= Math.abs(a.valence - state.home) / 2 ? a.word : fading(a.word);
  return { word, why: a.why };
}

/**
 * 她的心情是压力场的一样：fold 进 world.affect，给她 [心情] 这项能力，往提示词里写心情那一行和"很久没人找你"。
 * noise：读不读外壳的波动（消融 affect-calm 不读：只剩评价和回归）。
 * lonely：写不写"很久没人找你"（消融 affect-unsought 不写：开发集里 affect 组在两个长空档的私聊里多出一倍
 * "想过、决定不主动"的唤醒，要分清是不是这句引起的）。
 * warmth：候选的三处（文件开头"底色"一段）；不给就是生产。
 */
export function affect(o: {
  noise: boolean;
  lonely: boolean;
  warmth?: Warmth;
  /** rejection（生产）：反思的好心情按那里嫌她的程度推得少（turn.ts rejection 记的那一块）。 */
  rejection?: boolean;
  /** feedback（正反馈回路）：读取 positiveLoop 写的 boost。 */
  feedback?: boolean;
  /** body（lifeBody）：读取身体的饿/困偏移（moodNudge）。 */
  body?: boolean;
  /** willDrive（PLAN 第 46 件）：心情温和调制内在驱动（[0.75, 1.20] 有界，不碰义务和回避）。 */
  willDrive?: boolean;
  /** 实验：把本会话内的心情波动按时间穿插回聊天时间线原位。 */
  inline?: boolean;
}): PressureFeature {
  const warmth = o.warmth ?? NO_WARMTH;
  const warm = warmth.home || warmth.relevance || warmth.bids;
  const base = !o.noise ? "affect-calm" : o.lonely ? "affect" : "affect-unsought";
  // 量出来的常态：从第一个事件起就是她的常态（还没有经过的时间时，效价也从这里起步）。
  const start = (s: AffectState): AffectState =>
    warmth.home && s.home !== HOME_MEASURED
      ? { ...s, home: HOME_MEASURED, valence: s.at === 0 ? HOME_MEASURED : s.valence }
      : s;
  const named = warm
    ? `${base}-warm${warmth.bids ? "" : "-nobids"}${warmth.tone ? "-tone" : ""}`
    : base;
  const uses: Array<"chats.turn.rejection" | "life" | "feedback"> = [
    ...(o.rejection ? (["chats.turn.rejection"] as const) : []),
    ...(o.feedback ? (["feedback"] as const) : []),
    ...(o.body ? (["life"] as const) : []),
  ];
  const will: Pick<WillTerms<View<"affect">>, "intrinsicGain"> | undefined = o.willDrive
    ? {
        intrinsicGain: (world, reading, now) => {
          // 有界调制内在开口/分享劲（PLAN 第 46 件）：开心时轻轻往上推（至多 1.20），
          // 低落时不冷掉正在找她或关系好的朋友，只在没人找的主动冒泡时收一点（最低 0.75）。
          const delta = valenceAt(world.affect, now) - world.affect.home;
          const shape = Math.tanh(delta / 0.35);
          if (delta >= 0) return 1 + 0.2 * shape;
          if (reading.solicited) return Math.max(0.9, 1 + 0.1 * shape);
          return Math.max(0.75, 1 + 0.25 * shape);
        },
      }
    : undefined;
  return feature({
    name: `${o.rejection ? `${named}-rejection` : named}${o.willDrive ? "-will" : ""}`,
    provides: ["affect"],
    // 别处的原因注明在哪（place.ts）：群名、私聊的对方。没有 rejection / life / feedback 的组成里照常工作，
    // 所以它们是 uses。
    requires: ["chats", "relations"],
    uses,
    affordances: ["feel"],
    reduce: (_before, w, event) => {
      if (!o.noise && event.type === "noise.drawn") return w;
      const chat =
        o.rejection && event.type === "ponder.done" && event.ponder.kind === "reflect"
          ? w.chats[event.ponder.scope]
          : undefined;
      const rejected = chat ? rejectionAt(chat, event.at) : 0;
      let next = reduceAffect(start(w.affect), event, warmth, rejected, w.relations);
      const boost = w.feedback?.boost ?? null;
      if (boost) {
        const targetValence = Math.max(-1, Math.min(1, valenceAt(next, event.at) + boost.valence));
        next = pushAppraisal(next, {
          word: boost.word,
          why: boost.why,
          valence: targetValence,
          scope: boost.scope,
          present: boost.present,
          at: boost.at,
        });
      }
      const life = w.life as Partial<LifeBodyState> | undefined;
      if (life && "sleep" in life && "hunger" in life) {
        const bodyOffset = life.moodNudge;
        if (next.bodyOffset !== bodyOffset) {
          const { bodyOffset: _drop, ...rest } = next;
          next = bodyOffset === undefined ? rest : { ...rest, bodyOffset };
        }
      }
      return next === w.affect ? w : { ...w, affect: next };
    },
    contribute: ({ world, chat, now }) =>
      contribute(chat, now, world.affect, o.lonely, (s) => placeOf(world, s), o.inline === true),
    ...(will ? { will } : {}),
  });
}

function contribute(
  chat: { scope: string; chatType: ChatType },
  now: number,
  state: AffectState,
  withLonely: boolean,
  place: (scope: string) => string,
  withInline = false,
): Contribution[] {
  const lonely = withLonely ? lonelyFor(state, now) : null;
  const mood = moodOf(state, chat.scope, chat.chatType, now, place);
  const a = state.appraisal;
  const shift = valenceAt(state, now) - state.home;
  const localInline =
    withInline && a && a.scope === chat.scope && heldAt(a, state.home, shift, now)
      ? [
          {
            at: a.at,
            text: `(心情) ${Math.abs(shift) >= Math.abs(a.valence - state.home) / 2 ? a.word : fading(a.word)}${a.why ? `（${a.why}）` : ""}`,
          },
        ]
      : undefined;
  return [
    ...(mood === null && !localInline
      ? []
      : [
          {
            mechanism: "affect",
            kind: "mood" as const,
            text: mood ?? "",
            ...(localInline ? { inline: localInline } : {}),
          },
        ]),
    ...(lonely === null
      ? []
      : [
          {
            mechanism: "affect",
            kind: "state" as const,
            text: `已经 ${elapsed(lonely)}没有人找过我了。`,
          },
        ]),
  ];
}
