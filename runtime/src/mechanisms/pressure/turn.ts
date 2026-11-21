/**
 * 群里什么时候轮到她（候选 groupturn，eval-artifacts/groupturn/prereg.md）。三类时刻变成世界里的信号，各是压力场的
 * 一样（feature.ts）：
 * - 话题有关（topicTurn）：别人刚说的话对上她心里已有的东西。Inner Thoughts（Liu et al., CHI 2025 §5.2）检索那一步的
 *   saliency：和每条记忆的相似度取最大，过 0.3 才算；想法和说不说仍由醒来后的那一次发言调用决定。
 * - 想接某个人的话（bondTurn）：说话的人最近和她有过有回应的互动（私聊找她、点名她、回应她）。
 * - 在场（floor，M27 对话弧）：她在群里说完 FLOOR_MS 之内别人又说了话，她还在这段对话里
 *   （Sacks 等 1974 的"当前说话人可以接着说"；2 月 ADR-66 F1 的对话延续窗）。
 * 2 月数据里真人在前两类时刻开口的比例约是平时的两倍（prereg §1）。信号只进驱动和意愿，不写进提示词：
 * 显著度可能来自她在私聊里说过的话，只用来打分，不会把那些话带进群。
 */

import { isSilent } from "../../mind/affordances.js";
import { type AliceEvent, NEGATIVE_REACTIONS } from "../../mind/events.js";
import type { WillAffordance } from "./affordances.js";
import { groupTheta } from "./drives.js";
import { feature, type PressureFeature, type View } from "./feature.js";
import { chatSubject } from "./memory.js";
import { GROUP_ABSENCE_ROUNDS, SAT } from "./params.js";
import { feedback, rejectionCost, signalOf } from "./rejection.js";
import {
  type ChatNode,
  type Dwell,
  type DwellEnd,
  halfLife,
  isSolicited,
  type TurnSignals,
  voicesAt,
  type Watch,
  type WatchEnd,
} from "./world.js";

/** Inner Thoughts §5.2 的检索阈值。 */
export const SALIENCE_MIN = 0.3;
/** 拉力的半衰期：话题和说话的人只在这段对话还新鲜时拉她（与 TURN_WINDOW 同量级）。手设。 */
export const PULL_HALF_LIFE = 10 * 60_000;
/** 和她的交情按这个半衰期变淡（2 月数据里 bond 的窗是 24 小时）。 */
export const BOND_HALF_LIFE = 24 * 3_600_000;
/** 算 idf 的背景里留几条别人的话。 */
const RECENT_KEPT = 30;
/** 2 月 ADR-66 F1 / system1.ts CONTINUATION_WINDOW_S = 300。 */
export const FLOOR_MS = 300_000;

const CJK = /[぀-ヿ㐀-鿿豈-﫿]+/g;
const WORD = /[a-zа-яё0-9]{3,}/giu;
const MIN_TOKENS = 2;

/**
 * 中日文按两字片段，拉丁、西里尔字母按词（与 prereg §1 的 moments.py 相同）。单个字（"嗯""好"）不算，
 * 少于 MIN_TOKENS 个不同片段的话（"嗯嗯""哈哈哈"）没有话题，记为空。
 */
export function tokens(text: string | null | undefined): string[] {
  if (!text) return [];
  const t = text.toLowerCase();
  const out: string[] = [...(t.match(WORD) ?? [])];
  for (const run of t.match(CJK) ?? []) {
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  return new Set(out).size >= MIN_TOKENS ? out : [];
}

/** 她心里已有的东西：说过的话、日记、记得的这个群和群里人的事、这个群里她的话题线。 */
function memoryItems(
  world: View<"said" | "diary" | "facts">,
  scope: string,
  chat: ChatNode,
): string[] {
  const people = [...new Set(chat.recentFrom)];
  return [
    ...world.said.map((l) => l.text),
    ...world.diary.map((d) => d.text),
    ...(world.facts[chatSubject(scope)] ?? []).map((f) => f.text),
    ...people.flatMap((p) => (world.facts[p] ?? []).map((f) => f.text)),
    ...chat.topics.map((t) => t.title),
  ];
}

/**
 * 一条话和她心里每样东西的 tf-idf 余弦取最大。idf 用平滑形式 ln((1+n)/(1+df)) + 1，df 数的是她心里的东西加上
 * 群里最近的话（不含这条本身）：常说的"有没有""今天"权重低，"吉他""和弦"这类少见的词权重高。
 */
export function salience(
  message: readonly string[],
  items: readonly (readonly string[])[],
  background: readonly (readonly string[])[],
): number {
  if (message.length === 0 || items.length === 0) return 0;
  const docs = [...items, ...background];
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docs.length;
  const vec = (d: readonly string[]): Map<string, number> => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    const v = new Map<string, number>();
    let norm = 0;
    for (const [t, c] of tf) {
      const w = (1 + Math.log(c)) * (Math.log((1 + n) / (1 + (df.get(t) ?? 0))) + 1);
      if (w <= 0) continue;
      v.set(t, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm);
    for (const [t, w] of v) v.set(t, w / norm);
    return v;
  };
  const m = vec(message);
  let best = 0;
  for (const item of items) {
    const v = vec(item);
    let dot = 0;
    for (const [t, w] of m) dot += w * (v.get(t) ?? 0);
    best = Math.max(best, dot);
  }
  return best;
}

/** 此刻的拉力（已消退）。 */
export function pullAt(chat: ChatNode, now: number): { topic: number; bond: number } {
  const s = chat.turn;
  return {
    topic: halfLife(s.topic, now - s.topicAt, PULL_HALF_LIFE),
    bond: halfLife(s.bond, now - s.bondAt, PULL_HALF_LIFE),
  };
}

/**
 * 她还在这段对话里：群里她说完 FLOOR_MS 之内别人又说了话，而且这之后她没有看过、决定不说。
 */
export function inFloor(chat: ChatNode, now: number): boolean {
  return (
    chat.chatType === "group" &&
    chat.lastAliceAt > 0 &&
    now - chat.lastAliceAt <= FLOOR_MS &&
    chat.lastIncomingAt > chat.lastAliceAt &&
    chat.turn.leftAt < chat.lastAliceAt
  );
}

/** 改这个群的信号。 */
function withSignals<W extends View<"chats">>(
  world: W,
  scope: string,
  change: (s: TurnSignals, chat: ChatNode) => TurnSignals,
): W {
  const chat = world.chats[scope];
  if (!chat || chat.chatType !== "group") return world;
  const turn = change(chat.turn, chat);
  return { ...world, chats: { ...world.chats, [scope]: { ...chat, turn } } };
}

/** 看过、说过：这几条话的拉力消耗掉（考虑过就消耗）。 */
const looked = (
  event: AliceEvent,
): event is Extract<AliceEvent, { type: "message.sent" | "speech.decided" | "speech.failed" }> =>
  event.type === "message.sent" ||
  event.type === "speech.decided" ||
  event.type === "speech.failed";

/** 话题有关：别人的话和她心里已有的东西的显著度。 */
export const topicTurn: PressureFeature = feature({
  name: "topic",
  provides: ["chats.turn.topic"],
  requires: ["said"],
  // 她心里已有的东西：有哪样就用哪样（日记、关于人的事、她跟着的事）。
  uses: ["diary", "facts", "chats.topics"],
  reduce: (_before, after, event) => {
    if (event.type === "message.received" && event.chatType === "group") {
      const words = tokens(event.text);
      return withSignals(after, event.scope, (s, chat) => {
        const items = memoryItems(after, event.scope, chat).map(tokens);
        const sal = salience(words, items, s.recent);
        const prior = pullAt(chat, event.at).topic;
        const recent = words.length > 0 ? [...s.recent, words].slice(-RECENT_KEPT) : s.recent;
        return {
          ...s,
          topic: sal >= SALIENCE_MIN ? Math.max(prior, sal) : prior,
          topicAt: event.at,
          recent,
        };
      });
    }
    return looked(event)
      ? withSignals(after, event.scope, (s) => ({ ...s, topic: 0, topicAt: event.at }))
      : after;
  },
});

/** 想接某个人的话：说话的人在这条消息之前和她有过有回应的互动。 */
export const bondTurn: PressureFeature = feature({
  name: "bond",
  provides: ["chats.turn.bond"],
  requires: ["relations"],
  reduce: (before, after, event) => {
    if (event.type === "message.received" && event.chatType === "group") {
      const person = before.relations.people[event.senderId];
      return withSignals(after, event.scope, (s, chat) => {
        const prior = pullAt(chat, event.at).bond;
        const bond =
          person && person.seen.lastAnswerAt > 0
            ? prior + halfLife(1, event.at - person.seen.lastAnswerAt, BOND_HALF_LIFE)
            : prior;
        return { ...s, bond, bondAt: event.at };
      });
    }
    return looked(event)
      ? withSignals(after, event.scope, (s) => ({ ...s, bond: 0, bondAt: event.at }))
      : after;
  },
});

/**
 * 在场（M27 对话弧）：她在群里说完 5 分钟内别人又说了话，别人的话也叫醒她再看一眼、算轮到她（φ_turn）、
 * 不收主动开口冷却；她在场时看过、决定不说，这段对话就放下。
 */
export const floor: PressureFeature = feature({
  name: "floor",
  provides: ["chats.turn.leftAt"],
  listens: inFloor,
  reduce: (before, after, event) => {
    if (event.type !== "speech.decided") return after;
    const was = before.chats[event.scope];
    const declined = was !== undefined && inFloor(was, event.at) && isSilent(event.decision.acts);
    return declined ? withSignals(after, event.scope, (s) => ({ ...s, leftAt: event.at })) : after;
  },
  will: { continuing: inFloor },
});

/**
 * 在场的最简单的竞争者：只有"别人的话叫醒她再看一眼"那一半（2 月 ADR-66 F1），代价不变、看过也不放下。
 * 它读"她看过、不说"的时刻，那是 floor 写的：单用它时一直是 0（列在组合的 gaps 里）。
 */
export const floorWake: PressureFeature = feature({
  name: "floorwake",
  uses: ["chats.turn.leftAt"],
  listens: inFloor,
});

/**
 * 她在这段对话里（候选 dwell，eval-artifacts/dwell/prereg.md）：floor 的按对话节奏的版本，2 月 ADR-107 浏览会话
 * 那个 option（Sutton、Precup、Singh 1999 的 起始 / 会话内 / 终止）落在群的状态和意愿里。
 * 对话是共同活动（Clark 1996）：进入之后每一轮只是接着说，别人也把她当参与者（Goffman 1981），所以：
 * - 起始：她在群里开口。
 * - 会话内：别人接着说了（参与身份是别人给的：她说完还没人说话时她只是在等），别人的话叫醒她再看一眼，
 *   λ 按轮到她、不收开新话头的冷却；提示词里没有"没人找你"。开口的侵入度不另降：叫不叫醒按这个会话最好的
 *   意愿算，群里最好的总是侵入度最低的点表情，把说话那一列改成"被邀请"，零成本三份回放里逐字节不变（prereg 偏离）。
 * - 终止：对话相对自己的节奏冷下来（沉默超过 groupTheta，这个群 K 轮消息的时长）；对话从她身边过去了
 *   （她开口之后别人又说了 K 条，与群聊存在感同一个 K：在对话里就不缺席，走过她 K 轮就是缺席）；她看过、
 *   决定不说（考虑过就消耗）。2 月数据里真人"是不是下一个说话人"按别人又说了几条消退、约 10–30 条回到基线，
 *   和墙上时间关系不大（prereg §1）。
 * 只在群里：私聊里对方的每条话本来就冲着她、按被邀请算，她说完对方没回时没有可缓解的，不会另外叫醒她。
 * 只点表情不算一轮：不续这段对话，也不结束它。
 */
export interface DwellOptions {
  /** 对话走过她 K 轮就结束（消融 dwell-no-passby 关掉）。 */
  passBy: boolean;
  /**
   * 候选 dwell-look（eval-artifacts/dwell-look/prereg.md）：在对话里时别人的话按 look 的门叫醒她（不收对别人的
   * 代价，feature.ts watchGate），提示词照旧写"没人点你"（readerInside）。按 NSV 的门几乎叫不醒她：线上 14 段
   * 里 11 段是走过她 K 轮结束的。旁观不变。
   */
  look?: boolean;
  /**
   * 轮流：她在群里再说一轮之后的轮次份额超过活跃档真人的 p75，就多付一笔饱和代价，
   * 到 p90 时等于 C_sat 频率项的满额。轮流说话里人人都有轮次（Sacks、Schegloff、Jefferson 1974）；
   * 已有的 C_sat 频率项只数她自己的轮，不看别人说了多少，小群里管不住份额。
   */
  share?: boolean;
  /** rejection（生产，eval-artifacts/rejection/prereg.md）：群里的人嫌她，她在这个群开口的代价跟着涨，随时间淡掉。 */
  rejection?: boolean;
}

/** 一条话是谁说的（会话最近记着的那几十条里找）。 */
function senderOf(chat: ChatNode, messageId: string): string | null {
  const i = chat.recentIds.lastIndexOf(messageId);
  return i >= 0 ? (chat.recentFrom[i] ?? null) : null;
}

/**
 * 活跃档真人一段对话里的轮次份额（active-profile/table.md：p25–p75 是 0.056–0.24，p90 0.31；p50 取 p25–p75 的中点）：
 * 新群还没有自己的数时的先验。
 */
const SHARE_BAND = { p50: 0.15, p75: 0.24, p90: 0.31 } as const;
/** 先验算多少轮：这个群最近说了这么多轮时，一半按它自己的。手设。 */
const SHARE_PRIOR_TURNS = 5;

const quantile = (xs: readonly number[], f: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(f * (s.length - 1) + 0.5))] ?? 0;
};

/**
 * 这个群自己的份额带（PLAN 第 43 件）：最近说得最多的那四分之一人（至少一人），各自的轮次份额的 p50、p90；
 * 和先验 SHARE_BAND 按这个群最近说的轮数加权。
 */
export function shareBand(chat: ChatNode, now: number): { p50: number; p75: number; p90: number } {
  const v = voicesAt(chat, now);
  const counts = Object.values(v.by).sort((a, b) => b - a);
  const total = counts.reduce((a, b) => a + b, 0) + v.her;
  if (counts.length === 0 || total <= 0) return SHARE_BAND;
  const top = counts.slice(0, Math.max(1, Math.ceil(counts.length / 4))).map((n) => n / total);
  const w = total / (total + SHARE_PRIOR_TURNS);
  const at = (f: number, prior: number) => w * quantile(top, f) + (1 - w) * prior;
  const p50 = at(0.5, SHARE_BAND.p50);
  const p75 = Math.max(at(0.75, SHARE_BAND.p75), p50 + 0.02);
  return { p50, p75, p90: Math.max(at(0.9, SHARE_BAND.p90), p75) };
}

/**
 * 她再说一轮会超出这个群的带多少（0 是没超）：p50 起收，到 p75 收满一份频率代价（目标是落在 p25–p75，p90 是外面的
 * 检查）。按轮数比，不按份额比——最近总共只说了几轮时，她的第一、二轮份额天然很高，但那是对话刚开始，不是她占着场。
 * 带的 p50 至少容她 1 轮、p75 至少 2 轮。
 */
export function shareExcess(chat: ChatNode, now: number): number {
  const v = voicesAt(chat, now);
  const total = Object.values(v.by).reduce((a, b) => a + b, 0) + v.her + 1;
  const band = shareBand(chat, now);
  const at50 = Math.max(1, band.p50 * total);
  const at75 = Math.max(2, band.p75 * total, at50 + 0.5);
  return Math.max(0, (v.her + 1 - at50) / (at75 - at50));
}

/** 意愿层社交代价里多加的一项（乘 λ）。 */
type Cost = (chat: ChatNode, affordance: WillAffordance, now: number) => number;

/**
 * 收在群里每个接近类的动作上，不只说话：叫醒她的总是这个群里最好的那个意愿（多半是点表情），醒了之后开不开口
 * 由模型定，所以份额要在"再看一眼"这一步就起作用。离开（能缓解回避的动作）不收。有人找她（点名、回复她）时
 * 不收：被选中的下一个说话人本来就该说（Sacks 等的规则 1a），只管她自选接话。
 */
const shareCost: Cost = (chat, affordance, now) => {
  if (chat.chatType !== "group" || (affordance.relieves.aversion ?? 0) > 0) return 0;
  if (isSolicited(chat, now)) return 0;
  // 在别处答应了来这里做一件事（memory.ts Commitment.origin）：是被请来的，和被点名一样不算她自选接话。线上那次她在
  // 这个群里刚说了几轮，这一笔把"去群里念一段"压到了 0 以下（2026-11-15 研究员："私聊求她在群里发语音，她没有做"）。
  // 只免能做那件事的动作（缓解 prospect 的），点表情照收。
  const asked = chat.commitments.open.some((c) => c.origin && c.expireAt > now);
  if (asked && (affordance.relieves.prospect ?? 0) > 0) return 0;
  const over = shareExcess(chat, now);
  return over > 0 ? SAT.wRate * over ** 2 : 0;
};

/** 群里嫌她时，这个群里接近类的动作多付 rejectionCost；离开（能缓解回避的动作）不付。 */
const rejectionTerm: Cost = (chat, affordance, now) =>
  chat.chatType === "group" && (affordance.relieves.aversion ?? 0) === 0
    ? rejectionCost(chat, now)
    : 0;

/** 这段对话冷下来的时刻：最后一条消息之后过了这个群自己 K 轮的时长。 */
const coolsAt = (chat: ChatNode): number => chat.lastAnyAt + groupTheta(chat);

/**
 * 她在群里开口后的这段会话还开着（已起始、没有结束、还没冷下来），不管最后一条是谁说的。返回起始时刻，
 * 没有开着的会话时是 null。inDwell 另外要求别人在她之后说过话（那才叫醒她）。
 */
export function dwellSince(chat: ChatNode, now: number): number | null {
  const d = chat.turn.dwell;
  return chat.chatType === "group" && d.from > 0 && d.ended === null && now <= coolsAt(chat)
    ? d.from
    : null;
}

/** 她此刻还在这段对话里（会话已起始、没有结束、别人在她之后说过话、还没冷下来）。 */
export function inDwell(chat: ChatNode, now: number): boolean {
  const d = chat.turn.dwell;
  return (
    chat.chatType === "group" &&
    chat.member &&
    d.from > 0 &&
    d.ended === null &&
    chat.lastIncomingAt > chat.lastAliceAt &&
    now <= coolsAt(chat)
  );
}

/** 一段对话的结束写进状态（Journal 折叠出来就能读到起止）。 */
const end = (d: Dwell, at: number, why: DwellEnd): Dwell =>
  d.from > 0 && d.ended === null ? { ...d, ended: { at, why } } : d;

export function dwell(o: DwellOptions = { passBy: true }): PressureFeature {
  const costs = [...(o.share ? [shareCost] : []), ...(o.rejection ? [rejectionTerm] : [])];
  return feature<"chats.turn.dwell" | "chats.turn.rejection", never, "chats.commitments">({
    provides: o.rejection ? ["chats.turn.dwell", "chats.turn.rejection"] : ["chats.turn.dwell"],
    // 份额那一笔看这里有没有在别处答应、来这里做的事（shareCost）。
    ...(o.share ? { uses: ["chats.commitments" as const] } : {}),
    name: [
      o.passBy ? "dwell" : "dwell-nopassby",
      ...(o.look ? ["look"] : []),
      ...(o.share ? ["share"] : []),
      ...(o.rejection ? ["rejection"] : []),
    ].join("-"),
    listens: inDwell,
    ...(o.look ? { watchGate: "look-dwell" as const, readerInside: true } : {}),
    reduce: (before, after, event) => {
      const was = "scope" in event ? before.chats[event.scope] : undefined;
      switch (event.type) {
        case "message.sent":
          // 开口：没有在进行的会话就起一段，有就续上；别人说的条数从这里重新数。
          return withSignals(after, event.scope, (s) => {
            const open = s.dwell.from > 0 && s.dwell.ended === null;
            return { ...s, dwell: { from: open ? s.dwell.from : event.at, after: 0, ended: null } };
          });
        case "message.received":
          if (!was || was.turn.dwell.from === 0 || was.turn.dwell.ended !== null) return after;
          return withSignals(after, event.scope, (s) => {
            // 冷下来是按这条之前的节奏判断的（这条的间隔还没折进去）。
            if (event.at > coolsAt(was)) {
              return { ...s, dwell: end(s.dwell, coolsAt(was), "cooled") };
            }
            const d = { ...s.dwell, after: s.dwell.after + 1 };
            const passed = o.passBy && d.after > GROUP_ABSENCE_ROUNDS;
            return { ...s, dwell: passed ? end(d, event.at, "passed-by") : d };
          });
        case "speech.decided": {
          const declined =
            was !== undefined && inDwell(was, event.at) && isSilent(event.decision.acts);
          return declined
            ? withSignals(after, event.scope, (s) => ({
                ...s,
                dwell: end(s.dwell, event.at, "declined"),
              }))
            : after;
        }
        case "clock.tick": {
          // 时间走了：冷下来的会话记下结束（没有新消息时状态里也读得到）。
          let w = after;
          for (const [scope, c] of Object.entries(after.chats)) {
            const d = c.turn.dwell;
            if (c.chatType !== "group" || d.from === 0 || d.ended !== null) continue;
            if (event.at > coolsAt(c))
              w = withSignals(w, scope, (s) => ({
                ...s,
                dwell: end(s.dwell, coolsAt(c), "cooled"),
              }));
          }
          return w;
        }
        case "message.perceived": {
          // 外壳判出的一条冲着她的话的口气、叫停（晚到）：记成那个人的一次反馈。
          if (!o.rejection || was?.chatType !== "group") return after;
          const signal = signalOf(event);
          const who = senderOf(was, event.messageId);
          if (!signal || !who) return after;
          return withSignals(after, event.scope, (s) => ({
            ...s,
            rejection: feedback(s.rejection, who, event.at, signal),
          }));
        }
        case "reaction.received": {
          // 她这一轮的话上的表情（和世界折叠同一个条件）：负面的是冷淡，别的是有来有回。
          if (!o.rejection || was?.chatType !== "group" || !event.senderId) return after;
          if (!was.awaiting?.ids.includes(event.messageId)) return after;
          const signal = NEGATIVE_REACTIONS.has(event.emoji) ? "cold" : "warm";
          const who = event.senderId;
          return withSignals(after, event.scope, (s) => ({
            ...s,
            rejection: feedback(s.rejection, who, event.at, signal),
          }));
        }
        default:
          return after;
      }
    },
    will: {
      continuing: inDwell,
      ...(costs.length > 0
        ? { cost: (_w, c, a, now) => costs.reduce((sum, f) => sum + f(c, a, now), 0) }
        : {}),
    },
  });
}

/**
 * 她看着这段对话（候选 follow，eval-artifacts/participation/prereg.md）：dwell 是她开过口、别人接着说时的参与者，
 * 这一样是她看了、还没开口时的旁观者。对话开着时每一条新消息都在眼前，每一条都是一个可转换点（Sacks 等 1974）；
 * Inner Thoughts（Liu 等，CHI 2025 §5.1）的触发就是每来一条消息想一次（on_new_message）。她同时在很多群，
 * 所以只在她正看着的那段对话里这样：
 * - 起始：她在这个群里看过（做了决定，或看一眼）。
 * - 看着的时候：别人的话也叫醒她再看（和 dwell 同一条路，按这个会话最好的意愿 NSV > 0 才醒），但她是旁观者：
 *   提示词照旧是"没人找你"，λ 不按轮到她，开新话头的冷却照收。刚看过时未读的拉力小，几条攒起来才够、
 *   看得越勤习惯化越高，所以多久再看一次由对话自己的速度和她的习惯化定，不另设间隔。
 * - 终止：和 dwell 同一套——对话冷下来（groupTheta）；从她开始看起别人又说了 K 条（同一个 K，真人的参与按
 *   条数消退）；她开口了就是参与者，交给 dwell。看过、不说不结束：旁观者跳过一个可转换点还在读，看过的那几条
 *   由已有的"考虑过就消耗"消耗（未读清零、习惯化）。
 * skip：她在对话里（dwell）看过、决定不说之后还看着——参与者跳过一轮，从这一刻起看一段（消融 follow-no-skip 关掉）。
 * gate（feature.ts watchGate）：look 是对话在眼前时再看一眼不收对别人的代价（看不打扰谁；Inner Thoughts 每条消息
 * 都想一次，动机在想过之后评估——在我们这里就是醒来后的那次决定）；她自己的状态（睡着、手上有事）和饱和代价照算。
 * 旁观和在对话里（dwell 的 listens）用同一个门。will 是原来的按最好的意愿 NSV > 0（消融 follow-will）：旁观者能
 * 缓解的只有未读的拉力，盖不过社交代价，2 月 B 上看着时 10 条以内只有约一成的消息叫得醒她，她开口之后也多半看不到
 * 别人接着说的话（prereg 偏离）。
 * reader（feature.ts readerInside）：在对话里时提示词也照旧写"没人找你"。每条都叫醒她时，"在对话里、没写没人找你"
 * 让 flash-lite 在别人每说一条后开口 77%（2 月 B 12 小时窗 61/79，两轮之间别人说的条数中位 1），真人参与者
 * 在 1–4 条后是下一个说话人的比例只有 0.06–0.07（dwell prereg §1）；那些话本来就不是冲着她说的。
 */
export interface FollowOptions {
  skip: boolean;
  gate: "will" | "look" | "look-watch";
  reader: boolean;
}

const watchOpen = (w: Watch): boolean => w.from > 0 && w.ended === null;

/** 她此刻看着这段对话：开始看了、之后别人说过话、没冷下来、没结束，而且她不在 dwell 里（那时她是参与者）。 */
export function watching(chat: ChatNode, now: number): boolean {
  const w = chat.turn.watch;
  return (
    chat.chatType === "group" &&
    chat.member &&
    watchOpen(w) &&
    chat.lastIncomingAt > w.from &&
    now <= coolsAt(chat) &&
    !inDwell(chat, now)
  );
}

const stop = (w: Watch, at: number, why: WatchEnd): Watch =>
  watchOpen(w) ? { ...w, ended: { at, why } } : w;
const begin = (at: number): Watch => ({ from: at, after: 0, ended: null });

export function follow(
  o: FollowOptions = { skip: true, gate: "look", reader: false },
): PressureFeature {
  /** 看了一眼这个群：没在看就从这一刻起看（在看就接着，K 从开始看时数）。 */
  const look = <W extends View<"chats">>(world: W, scope: string, at: number, fresh: boolean): W =>
    withSignals(world, scope, (s, chat) =>
      chat.member && (fresh || !watchOpen(s.watch)) ? { ...s, watch: begin(at) } : s,
    );
  return feature({
    provides: ["chats.turn.watch"],
    // 她在对话里（dwell）时是参与者，不算看着；没有 dwell 时她总是旁观者。
    uses: ["chats.turn.dwell"],
    name: [
      "follow",
      ...(o.skip ? [] : ["noskip"]),
      ...(o.gate === "look" ? [] : [o.gate === "will" ? "will" : "watchonly"]),
      ...(o.reader ? ["reader"] : []),
    ].join("-"),
    watches: watching,
    watchGate: o.gate,
    ...(o.reader ? { readerInside: true } : {}),
    reduce: (before, after, event) => {
      const was = "scope" in event ? before.chats[event.scope] : undefined;
      switch (event.type) {
        case "chat.glanced":
          return look(after, event.scope, event.at, false);
        case "speech.decided": {
          if (!was || was.chatType !== "group") return after;
          // 在对话里看过、不说：dwell 结束了；跳过一轮的参与者还看着，从这一刻起看一段。
          if (inDwell(was, event.at) && isSilent(event.decision.acts)) {
            return o.skip ? look(after, event.scope, event.at, true) : after;
          }
          return inDwell(was, event.at) ? after : look(after, event.scope, event.at, false);
        }
        case "message.sent":
          return withSignals(after, event.scope, (s) => ({
            ...s,
            watch: stop(s.watch, event.at, "joined"),
          }));
        case "message.received":
          if (!was || !watchOpen(was.turn.watch)) return after;
          return withSignals(after, event.scope, (s) => {
            if (event.at > coolsAt(was))
              return { ...s, watch: stop(s.watch, coolsAt(was), "cooled") };
            const w = { ...s.watch, after: s.watch.after + 1 };
            return {
              ...s,
              watch: w.after > GROUP_ABSENCE_ROUNDS ? stop(w, event.at, "passed-by") : w,
            };
          });
        case "clock.tick": {
          let w = after;
          for (const [scope, c] of Object.entries(after.chats)) {
            if (c.chatType !== "group" || !watchOpen(c.turn.watch) || event.at <= coolsAt(c))
              continue;
            w = withSignals(w, scope, (s) => ({
              ...s,
              watch: stop(s.watch, coolsAt(c), "cooled"),
            }));
          }
          return w;
        }
        default:
          return after;
      }
    },
  });
}
