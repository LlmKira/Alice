import type { AliceEvent } from "../mind/events.js";
import { type Contribution, defineMechanism } from "../mind/mechanism.js";
import type { ChatState } from "../mind/state.js";

/**
 * 关系远近：她和每个人互动得有多频繁，按 Dunbar 分层（5 / 15 / 50 / 150）排名，
 * 只把在场的人的事实放进提示词。陌生人不写，让模型从"没有信息"推断该客气。
 * 来自 2 月 soul.mod 的 closenessGuidance；那时的 tier 存在图里，这里直接从事件折叠。
 * 每人再加一句认识多久、谁在找谁（8 月 intimacy.ts 的持续时长与互惠；只作修饰，不改分层；
 * absorb/omp-report.md §2-8）。
 */

/** 亲疏分数的半衰期（离开的机会成本里，回应的价值也按它消退）。 */
export const CLOSENESS_HALF_LIFE = 14 * 24 * 60 * 60_000;
/** 10 分钟内的连续往来算一次互动，避免一段连发把分数刷高。 */
const EPISODE_GAP_MS = 10 * 60_000;
const LAYERS: Array<[maxRank: number, fact: string]> = [
  [5, "很亲近，我们几乎天天聊"],
  [15, "常聊"],
  [50, "认识，偶尔聊"],
  [150, "聊过几次"],
];

export interface Person {
  name: string;
  score: number;
  scoreAt: number;
  lastAt: number;
  /** 第一次互动的时刻：认识多久（8 月 intimacy.ts 的持续时长）。 */
  firstAt: number;
  /** 对方开启的往来次数、她在私聊里先开口的次数：谁在找谁（8 月 intimacy.ts 的互惠）。 */
  theirs: number;
  hers: number;
  /** 她上一次先开口的时刻（10 分钟内的连发算同一次）。 */
  herAt: number;
  /**
   * 算进最近这一次往来的那条消息，和它之前的分数（null：之前没有这个人）。外壳后来判出它是敌意时按这个退回去。
   */
  opened?: { scope: string; messageId: string; prior: Prior | null };
}

type Prior = Pick<Person, "score" | "scoreAt" | "theirs">;

/** 认识满两周才说认识多久；往来满 4 次才说谁在找谁（次数少时比例没意义）。 */
const KNOWN_FOR_MS = 14 * 24 * 60 * 60_000;
const SEEKING_MIN = 4;

export interface ClosenessState {
  people: Readonly<Record<string, Person>>;
  /** 私聊会话 → 对方 id，用来让她在私聊里的回话延续对方开启的往来。 */
  partners: Readonly<Record<string, string>>;
}

function decayed(p: Person, now: number): number {
  return p.score * 0.5 ** ((now - p.scoreAt) / CLOSENESS_HALF_LIFE);
}

function interact(
  state: ClosenessState,
  id: string,
  name: string,
  at: number,
  from: { scope: string; messageId: string },
): ClosenessState {
  const p = state.people[id];
  if (p && at - p.lastAt < EPISODE_GAP_MS) {
    return { ...state, people: { ...state.people, [id]: { ...p, name, lastAt: at } } };
  }
  const score = (p ? decayed(p, at) : 0) + 1;
  const opened = {
    ...from,
    prior: p ? { score: p.score, scoreAt: p.scoreAt, theirs: p.theirs } : null,
  };
  const next: Person = p
    ? { ...p, name, score, scoreAt: at, lastAt: at, theirs: p.theirs + 1, opened }
    : {
        name,
        score,
        scoreAt: at,
        lastAt: at,
        firstAt: at,
        theirs: 1,
        hers: 0,
        herAt: -Infinity,
        opened,
      };
  return { ...state, people: { ...state.people, [id]: next } };
}

/**
 * 冲着她的一条消息被外壳判为敌意（message.perceived 的 tone，llm/tone.ts）：它不算一次往来。口气比消息晚到
 * （叫醒她时才判，和发言调用并发），所以这次往来先照常算进去，判出来时再退回到那条消息之前；只退它开启的那一次
 * 往来，之后又有了新的往来就不动。挑衅者因此不会越骂越亲近（eval-artifacts/relation-c/readout2.md）。
 */
function retract(state: ClosenessState, scope: string, messageId: string): ClosenessState {
  const hit = Object.entries(state.people).find(
    ([, p]) => p.opened?.scope === scope && p.opened.messageId === messageId,
  );
  if (!hit) return state;
  const [id, p] = hit;
  const people = { ...state.people };
  const prior = p.opened?.prior;
  if (prior) {
    const { opened: _, ...rest } = p;
    people[id] = { ...rest, ...prior };
  } else delete people[id];
  return { ...state, people };
}

export function reduceCloseness(state: ClosenessState, event: AliceEvent): ClosenessState {
  if (event.type === "message.received") {
    const partners =
      event.chatType === "private" && state.partners[event.scope] !== event.senderId
        ? { ...state.partners, [event.scope]: event.senderId }
        : state.partners;
    const next = partners === state.partners ? state : { ...state, partners };
    return event.directed
      ? interact(next, event.senderId, event.senderName, event.at, {
          scope: event.scope,
          messageId: event.messageId,
        })
      : next;
  }
  if (event.type === "message.perceived" && event.tone === "hostile") {
    return retract(state, event.scope, event.messageId);
  }
  if (event.type === "message.sent") {
    // 关系靠互惠维持（论文 Claim 3）：她的话只延续对方开启的这段往来，不单独算一次互动——
    // 否则对方从不回应，她单方面的找也会维持对方的层级（S2 的长时段反复出价，pressure-properties）。
    const partner = state.partners[event.scope];
    const p = partner ? state.people[partner] : undefined;
    if (!partner || !p) return state;
    if (event.at - p.lastAt < EPISODE_GAP_MS) {
      return { ...state, people: { ...state.people, [partner]: { ...p, lastAt: event.at } } };
    }
    // 她先开口：只记一次"她在找他"，不加分、不延长往来（关系靠互惠维持，见上）。
    const sheStarted = event.at - p.herAt >= EPISODE_GAP_MS;
    const next = { ...p, herAt: event.at, hers: p.hers + (sheStarted ? 1 : 0) };
    return { ...state, people: { ...state.people, [partner]: next } };
  }
  return state;
}

/** 某人此刻在所有人里的排名（1 = 最亲近）；没互动过返回 null。 */
export function rankOf(state: ClosenessState, id: string, now: number): number | null {
  const me = state.people[id];
  if (!me) return null;
  const mine = decayed(me, now);
  let rank = 1;
  for (const [other, p] of Object.entries(state.people)) {
    if (other !== id && decayed(p, now) > mine) rank++;
  }
  return rank;
}

/** 认识多久（满两周才说）。 */
export function knownFor(p: Person, now: number): string | null {
  const days = (now - p.firstAt) / (24 * 60 * 60_000);
  if (now - p.firstAt < KNOWN_FOR_MS) return null;
  if (days < 30) return `认识 ${Math.floor(days / 7)} 周了`;
  if (days < 365)
    return `认识${Math.floor(days / 30) === 1 ? "一个多" : ` ${Math.floor(days / 30)} 个`}月了`;
  return "认识一年多了";
}

/** 谁在找谁（往来满 4 次才说；差不多就不说）。 */
export function whoSeeks(p: Person): string | null {
  const total = p.theirs + p.hers;
  if (total < SEEKING_MIN) return null;
  const theirShare = p.theirs / total;
  if (theirShare >= 0.7) return "多是对方先找我";
  if (theirShare <= 0.3) return "多是我先找对方";
  return null;
}

/** 一个人那一行（按排名分层），和排名；没互动过或排在 150 名以外为 null。 */
export function rankedLine(
  state: ClosenessState,
  id: string,
  name: string,
  now: number,
): [number, string] | null {
  const rank = rankOf(state, id, now);
  const layer = rank === null ? undefined : LAYERS.find(([max]) => rank <= max);
  const p = state.people[id];
  if (rank === null || !layer || !p) return null;
  const more = [knownFor(p, now), whoSeeks(p)].filter(Boolean).join("，");
  return [rank, `${name}：${layer[1]}${more ? `；${more}` : ""}`];
}

/** 时间线上说过话的人：id → 名字。 */
export function presentPeople(chat: ChatState): Map<string, string> {
  const present = new Map<string, string>();
  for (const t of chat.timeline) if (t.sender) present.set(t.sender.id, t.sender.name);
  return present;
}

export const closeness = defineMechanism<ClosenessState>({
  name: "closeness",
  initial: { people: {}, partners: {} },
  reduce: reduceCloseness,
  contribute(chat, now, state): Contribution[] {
    const lines: Array<[number, string]> = [];
    for (const [id, name] of presentPeople(chat)) {
      const line = rankedLine(state, id, name, now);
      if (line) lines.push(line);
    }
    if (lines.length === 0) return [];
    lines.sort((a, b) => a[0] - b[0]);
    return [
      {
        mechanism: "closeness",
        kind: "scene",
        text: `我和在场的人：\n${lines.map(([, l]) => l).join("\n")}`,
      },
    ];
  },
});
