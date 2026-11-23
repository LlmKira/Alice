/**
 * 群里什么时候轮到她：她在这段对话里（dwell），和群里拉力（group-pull.ts 写的 topic、bond）共用的读法与分词。
 * 拉力只进驱动和意愿，不写进提示词：salience 可能来自她在私聊里说过的话，只用来打分，不会把那些话带进群。
 */

import { isSilent } from "../../mind/affordances.js";
import { type AliceEvent, NEGATIVE_REACTIONS } from "../../mind/events.js";
import type { WillAffordance } from "./affordances.js";
import { groupTheta } from "./drives.js";
import { feature, type PressureFeature, type View } from "./feature.js";
import { GROUP_ABSENCE_ROUNDS, SAT } from "./params.js";
import { feedback, rejectionCost, type Signal, signalOf } from "./rejection.js";
import {
  type ChatNode,
  type Dwell,
  type DwellEnd,
  halfLife,
  isSolicited,
  type TurnSignals,
  voicesAt,
} from "./world.js";

/** Inner Thoughts §5.2 的检索阈值。 */
export const SALIENCE_MIN = 0.3;
/** 拉力的半衰期：话题和说话的人只在这段对话还新鲜时拉她（与 TURN_WINDOW 同量级）。手设。 */
const PULL_HALF_LIFE = 10 * 60_000;
/** 和她的交情按这个半衰期变淡（2 月数据里 bond 的窗是 24 小时）。 */
export const BOND_HALF_LIFE = 24 * 3_600_000;

// 平假名和片假名、CJK 扩展 A 和基本区、兼容汉字。不开 u 标志时按 UTF-16 码元匹配，所以区间不能碰到代理对（emoji）。
const CJK = /[\u3040-\u30FF\u3400-\u9FFF\uF900-\uFAFF]+/g;
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

/** 此刻的拉力（已消退）。 */
export function pullAt(chat: ChatNode, now: number): { topic: number; bond: number } {
  const s = chat.turn;
  return {
    topic: halfLife(s.topic, now - s.topicAt, PULL_HALF_LIFE),
    bond: halfLife(s.bond, now - s.bondAt, PULL_HALF_LIFE),
  };
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

/**
 * 她在这段对话里（dwell，eval-artifacts/dwell/prereg.md）：2 月 ADR-66 F1 对话延续窗按对话节奏的版本，2 月 ADR-107 浏览会话
 * 那个 option（Sutton、Precup、Singh 1999 的 起始 / 会话内 / 终止）落在群的状态和意愿里。
 * 对话是共同活动（Clark 1996）：进入之后每一轮只是接着说，别人也把她当参与者（Goffman 1981），所以：
 * - 起始：她在群里开口。
 * - 会话内：别人接着说了（参与身份是别人给的：她说完还没人说话时她只是在等），别人的话叫醒她再看一眼，
 *   λ 按轮到她、不收开新话头的冷却；提示词里没有"没人找你"。开口的 intrusiveness 不另降：叫不叫醒按这个会话最好的
 *   意愿算，群里最好的总是 intrusiveness 最低的点表情，把说话那一列改成"被邀请"，零成本三份回放里逐字节不变（prereg 偏离）。
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
   * 在对话里时别人的话按 look 的门叫醒她（不收对别人的代价，feature.ts looksInside），提示词照旧写"没人点你"
   * （readerInside）。按 NSV 的门几乎叫不醒她：线上 14 段里 11 段是走过她 K 轮结束的（eval-artifacts/dwell-look/prereg.md）。
   */
  look?: boolean;
  /**
   * 轮流：她在群里再说一轮之后的轮次份额超过活跃档真人的 p75，就多付一笔 saturation cost，
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
function shareBand(chat: ChatNode, now: number): { p50: number; p75: number; p90: number } {
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
function shareExcess(chat: ChatNode, now: number): number {
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

/** 一段对话的结束写进状态（Journal fold 出来就能读到起止）。 */
const end = (d: Dwell, at: number, why: DwellEnd): Dwell =>
  d.from > 0 && d.ended === null ? { ...d, ended: { at, why } } : d;

type EventOf<T extends AliceEvent["type"]> = Extract<AliceEvent, { type: T }>;

/** dwell 的 fold；was 是这个事件之前的会话。 */
function reduceDwell<W extends View<"chats">>(
  o: DwellOptions,
  before: W,
  after: W,
  event: AliceEvent,
): W {
  const was = "scope" in event ? before.chats[event.scope] : undefined;
  switch (event.type) {
    case "message.sent":
      // 开口：没有在进行的会话就起一段，有就续上；别人说的条数从这里重新数。
      return withSignals(after, event.scope, (s) => {
        const open = s.dwell.from > 0 && s.dwell.ended === null;
        return { ...s, dwell: { from: open ? s.dwell.from : event.at, after: 0, ended: null } };
      });
    case "message.received":
      return dwellHeard(after, was, event, o.passBy);
    case "speech.decided": {
      const declined = was !== undefined && inDwell(was, event.at) && isSilent(event.decision.acts);
      return declined
        ? withSignals(after, event.scope, (s) => ({
            ...s,
            dwell: end(s.dwell, event.at, "declined"),
          }))
        : after;
    }
    case "clock.tick":
      return dwellCooled(after, event.at);
    case "message.perceived":
      return o.rejection ? perceivedFeedback(after, was, event) : after;
    case "reaction.received":
      return o.rejection ? reactionFeedback(after, was, event) : after;
    default:
      return after;
  }
}

/** 别人说了一条：对话冷下来了就结束；没冷下来就数一条，走过她 K 轮（passBy）也结束。 */
function dwellHeard<W extends View<"chats">>(
  after: W,
  was: ChatNode | undefined,
  event: EventOf<"message.received">,
  passBy: boolean,
): W {
  if (!was || was.turn.dwell.from === 0 || was.turn.dwell.ended !== null) return after;
  return withSignals(after, event.scope, (s) => {
    // 冷下来是按这条之前的节奏判断的（这条的间隔还没 fold 进去）。
    if (event.at > coolsAt(was)) {
      return { ...s, dwell: end(s.dwell, coolsAt(was), "cooled") };
    }
    const d = { ...s.dwell, after: s.dwell.after + 1 };
    const passed = passBy && d.after > GROUP_ABSENCE_ROUNDS;
    return { ...s, dwell: passed ? end(d, event.at, "passed-by") : d };
  });
}

/** 时间走了：冷下来的会话记下结束（没有新消息时状态里也读得到）。 */
function dwellCooled<W extends View<"chats">>(after: W, at: number): W {
  let w = after;
  for (const [scope, c] of Object.entries(after.chats)) {
    const d = c.turn.dwell;
    if (c.chatType !== "group" || d.from === 0 || d.ended !== null) continue;
    if (at > coolsAt(c))
      w = withSignals(w, scope, (s) => ({
        ...s,
        dwell: end(s.dwell, coolsAt(c), "cooled"),
      }));
  }
  return w;
}

/** 外壳判出的一条冲着她的话的口气、叫停（晚到）：记成那个人的一次反馈。 */
function perceivedFeedback<W extends View<"chats">>(
  after: W,
  was: ChatNode | undefined,
  event: EventOf<"message.perceived">,
): W {
  if (was?.chatType !== "group") return after;
  const signal = signalOf(event);
  const who = senderOf(was, event.messageId);
  if (!signal || !who) return after;
  return withFeedback(after, event.scope, who, event.at, signal);
}

/** 她这一轮的话上的表情（和世界 fold 同一个条件）：负面的是冷淡，别的是有来有回。 */
function reactionFeedback<W extends View<"chats">>(
  after: W,
  was: ChatNode | undefined,
  event: EventOf<"reaction.received">,
): W {
  if (was?.chatType !== "group" || !event.senderId) return after;
  if (!was.awaiting?.ids.includes(event.messageId)) return after;
  const signal = NEGATIVE_REACTIONS.has(event.emoji) ? "cold" : "warm";
  return withFeedback(after, event.scope, event.senderId, event.at, signal);
}

function withFeedback<W extends View<"chats">>(
  after: W,
  scope: string,
  who: string,
  at: number,
  signal: Signal,
): W {
  return withSignals(after, scope, (s) => ({
    ...s,
    rejection: feedback(s.rejection, who, at, signal),
  }));
}

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
    ...(o.look ? { looksInside: true as const, readerInside: true } : {}),
    reduce: (before, after, event) => reduceDwell(o, before, after, event),
    will: {
      continuing: inDwell,
      ...(costs.length > 0
        ? { cost: (_w, c, a, now) => costs.reduce((sum, f) => sum + f(c, a, now), 0) }
        : {}),
    },
  });
}
