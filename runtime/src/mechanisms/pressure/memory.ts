/**
 * 她自己记下的东西，作为世界图的一部分（论文 §2 的 fact 节点与 knows 边、§3 带截止时间的线程）：
 * 关于某人的事实、她答应或打算做的事、她自己跟着的事（心情在 affect.ts）。全部只从事件（反思的结果、她写下的
 * 打算）确定性地折叠，时间只来自事件，所以删掉派生状态后能从 Journal 原样重建。
 *
 * 取自 2 月（tag archive/feb-2026-02）的写法与修正：
 * - 事实（relationships remember）：同一件事再记一次是强化（稳定性 ×1.2），每人有上限、淘汰可检索性最低的。
 *   2 月的事实 id 用墙钟和模块计数器生成，不可回放；这里事实由内容归一化后的键识别。
 *   没有 recall_fact / update_fact / delete_fact：2 月要求模型逐字给出旧内容才能匹配；改变了的事再记一条新的，
 *   旧的按可检索性自然排到后面。
 * - 承诺（observer note_promise / intend → begin_topic + horizon，p-prospect.ts）：时间由确定的解析器给出，
 *   认不出就没有截止时间。2 月把 deadline 标签换成 tick（约 1 小时）再当分钟用（"明天" = 48 分钟后），
 *   没给标签时默认一周；两者都是缺陷，不照搬。2 月只有 resolved 一种结局，这里有三种：
 *   做了（她写 tools.fulfil，在哪个会话里写都行）、重新约（同一件事又记了一次）、过期（过了宽限还没说做完，
 *   或被更新的挤掉）。到时候她在那里开了口只让压力重新长起，不算做了（开口不看内容）。
 */
import { parseWhen } from "../../mind/when.js";
import {
  CLOSED_COMMITMENTS,
  FACT_DECAY_D,
  FACT_MAX_CHARS,
  FACT_REINFORCE,
  FACT_STABILITY,
  FACTS_PER_SUBJECT,
  OPEN_COMMITMENTS,
  OPEN_TOPICS,
  PROSPECT_ALARM,
  PROSPECT_GRACE,
  PROSPECT_K,
  PROSPECT_MIN_LEAD,
  PROSPECT_REGROW,
  PROSPECT_WEIGHT,
  TOPIC_QUIET,
  TOPICS_SHOWN,
  TURN_GAP,
  UNDATED_LIFETIME,
} from "./params.js";

const DAY = 86_400_000;

export interface Fact {
  text: string;
  /** 归一化的内容：同一件事再记一次就是强化。 */
  key: string;
  /** 在哪个会话里知道的（提示词里说出处，私聊里知道的事在群里要掂量）。 */
  scope: string;
  firstAt: number;
  /** 上一次记住它的时刻（可检索性从这里算）。 */
  lastAt: number;
  /** 稳定性（天）。 */
  stability: number;
  count: number;
  /** 这件事是怎么知道的；受众规则按它分（recall.ts knownAbout）。 */
  origin: FactOrigin;
}

/**
 * 反思时记下的（people.ts）：知道这件事时那个会话里在场的人（群里知道的只在这个群和与当时在场的人的私聊里），
 * 和有时间的事里他原话的时间、认得出时的那一刻（过了就是"已经过了"）。
 */
export interface FactOrigin {
  kind: "reflected";
  present: readonly string[];
  when: { said: string; at: number; due: number | null } | null;
  /** 别人托她保密的、明显私密的（反思时她自己标的）：只有这样的守受众规则（diary.ts reaches）。 */
  private?: true;
}

export type Outcome = "done" | "renewed" | "expired";

/** 她自己答应或打算做的一件事。 */
export interface Commitment {
  text: string;
  key: string;
  /** 她说的时间原话。 */
  when: string | null;
  madeAt: number;
  /** 到时候了的窗：从 start 起，最晚 due；没有约定时间时都是 null。 */
  start: number | null;
  due: number | null;
  /** 她说了钟点（"下午3点"）：提示词里才写出钟点。 */
  precise: boolean;
  /** 过了这个时刻还没做就过期。 */
  expireAt: number;
  /** 她上一次没人找她时想过要不要做、决定先不（压力从这里重新长起）。 */
  consideredAt: number;
  /** 说了钟点的事到点时响一次（ringing）；响过了。 */
  rung: boolean;
  /**
   * 在别的会话里答应、要来这里做的（intend 的"在哪做"，研究员 2026-11-15"私聊求她在群里发语音，她没有做"）：
   * 在哪个会话定下的、对谁（私聊的对方；群里是她答应之前最后说话的那个人）。就在这里定下的没有这一项。
   */
  origin?: { scope: string; to: string | null };
}

export interface ClosedCommitment extends Commitment {
  outcome: Outcome;
  closedAt: number;
}

const clip = (text: string) => text.trim().slice(0, FACT_MAX_CHARS);

export function keyOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[。.!！?？~～…,，、]+$/u, "");
}

// ── 事实 ─────────────────────────────────────────────────────────

/** 可检索性 R = (1 + 天数/(9S))^d（2 月 retrievability，FSRS 形式）。 */
export function retrievability(fact: Fact, now: number): number {
  const days = Math.max(0, now - fact.lastAt) / DAY;
  return (1 + days / (9 * fact.stability)) ** FACT_DECAY_D;
}

/** 按可检索性从高到低（同分时新的在前）。 */
export function salient(facts: readonly Fact[], now: number): Fact[] {
  return [...facts].sort(
    (a, b) => retrievability(b, now) - retrievability(a, now) || b.lastAt - a.lastAt,
  );
}

export function rememberFact(
  facts: readonly Fact[] | undefined,
  text: string,
  scope: string,
  at: number,
  origin: FactOrigin,
): Fact[] {
  const body = clip(text);
  const key = keyOf(body);
  if (!key) return [...(facts ?? [])];
  const list = facts ?? [];
  const same = list.find((f) => f.key === key);
  if (same) {
    return list.map((f) =>
      f === same
        ? {
            ...f,
            text: body,
            scope,
            lastAt: at,
            stability: f.stability * FACT_REINFORCE,
            count: f.count + 1,
          }
        : f,
    );
  }
  const next: Fact[] = [
    ...list,
    {
      text: body,
      key,
      scope,
      firstAt: at,
      lastAt: at,
      stability: FACT_STABILITY,
      count: 1,
      origin,
    },
  ];
  // 超出上限：淘汰可检索性最低的（刚记下的那条 R = 1，不会被淘汰）。
  // 日志里每一条都还在（只追加），这里只是她此刻还记得的那部分有界。
  return next.length <= FACTS_PER_SUBJECT ? next : salient(next, at).slice(0, FACTS_PER_SUBJECT);
}

/** 群本身作为事实的主体（"这个群在准备考研"）。 */
export const chatSubject = (scope: string) => `chat:${scope}`;

// ── 承诺与打算 ───────────────────────────────────────────────────

export function makeCommitment(
  act: { what: string; when: string | null },
  at: number,
  origin?: Commitment["origin"],
): Commitment {
  const text = clip(act.what);
  // 答应去别处做、没说时间：就是接下来这一会儿（和说的时间已经过了一样，见下）。她不在那里，那件事不会摆在她眼前，
  // 只能靠这股劲把她带过去；就在这里做的没说时间的打算，她每次在这里醒来都看得见，不另加劲。
  const when = act.when ? parseWhen(act.when, at) : origin ? { from: at, due: at } : null;
  if (!when) {
    return {
      text,
      key: keyOf(text),
      when: act.when,
      madeAt: at,
      start: null,
      due: null,
      precise: false,
      expireAt: at + UNDATED_LIFETIME,
      consideredAt: 0,
      rung: false,
      ...(origin ? { origin } : {}),
    };
  }
  // "到时候了"从约定窗口开始；窗口在答应的时刻之前就开始（"今天"在下午说）时，从剩下时间的一半开始，
  // 否则答应那句话本身就算做了。说的时间已经过了（晚上十点说"今天"），就当作接下来这一会儿。
  // 说了钟点或"几分钟后"、而且还没到：就是她说的那个时刻（答应"十分钟后提醒你关火"，晚了就没用了；
  // 以前一律推到至少半小时后，提示词里也就不写钟点）。
  const exact = when.due - when.from <= 60 * 60_000 && when.due > at;
  const due = exact ? when.due : Math.max(when.due, at + 2 * PROSPECT_MIN_LEAD);
  const start = Math.max(when.from, at + (due - at) / 2);
  const lead = Math.max(due - start, PROSPECT_MIN_LEAD);
  const grace = Math.min(PROSPECT_GRACE.max, Math.max(PROSPECT_GRACE.min, lead));
  return {
    text,
    key: keyOf(text),
    when: act.when,
    madeAt: at,
    start: Math.min(start, due),
    due,
    precise: when.due - when.from <= 60 * 60_000 && due === when.due,
    expireAt: due + grace,
    consideredAt: 0,
    rung: false,
    ...(origin ? { origin } : {}),
  };
}

export interface Commitments {
  open: Commitment[];
  closed: ClosedCommitment[];
}

/** 按她写的内容认一件事：键相同，或一方包含另一方；都对不上而只有一件时（lone），就是它。 */
function matchByText<T extends { key: string }>(
  items: readonly T[],
  text: string,
  lone: boolean,
): T | undefined {
  const key = keyOf(text);
  return (
    (key ? items.find((c) => c.key === key) : undefined) ??
    (key ? items.find((c) => c.key.includes(key) || key.includes(c.key)) : undefined) ??
    (lone && items.length === 1 ? items[0] : undefined)
  );
}

function close(
  state: Commitments,
  which: (c: Commitment) => boolean,
  outcome: Outcome,
  at: (c: Commitment) => number,
): Commitments {
  const leaving = state.open.filter(which);
  if (leaving.length === 0) return state;
  return {
    open: state.open.filter((c) => !which(c)),
    closed: [...state.closed, ...leaving.map((c) => ({ ...c, outcome, closedAt: at(c) }))].slice(
      -CLOSED_COMMITMENTS,
    ),
  };
}

/** 过了宽限还没做的，记为过期；了结时刻就是过期时刻，与什么时候被结算无关（回放确定）。 */
export function expire(state: Commitments, now: number): Commitments {
  return close(
    state,
    (c) => c.expireAt <= now,
    "expired",
    (c) => c.expireAt,
  );
}

/** 记下一件事：同一件事还没了结就是重新约（旧的记为 renewed）；超出上限时最早的那件过期。 */
export function intend(state: Commitments, commitment: Commitment, at: number): Commitments {
  if (!commitment.key) return state;
  const renewed = close(
    state,
    (c) => c.key === commitment.key,
    "renewed",
    () => at,
  );
  const open = [...renewed.open, commitment];
  if (open.length <= OPEN_COMMITMENTS) return { ...renewed, open };
  const oldest = open[0] as Commitment;
  return close(
    { ...renewed, open },
    (c) => c === oldest,
    "expired",
    () => at,
  );
}

/**
 * 她说做完了（tools.fulfil，2 月 resolve_thread）：按内容找这件事——键相同，或一方包含另一方；
 * 都对不上而这里只有一件没了结的事，就是它。找不到返回 null（调用方再去别的会话找）。
 */
export function fulfil(
  state: Commitments,
  text: string,
  at: number,
  /** 在说这句话的会话里：只有一件时不看内容也认。别的会话只按内容认。 */
  here: boolean,
): Commitments | null {
  const match = matchByText(state.open, text, here);
  return match
    ? close(
        state,
        (c) => c === match,
        "done",
        () => at,
      )
    : null;
}

/**
 * 到时候了，她在这个会话里开了口，或没人找她时想过、决定先不：到时候了的承诺从此刻重新长起。
 * 开口不等于做了（她可能只回了句"哈哈"），所以不了结它；做没做由她自己说（fulfil），否则过期。
 */
export function consider(state: Commitments, at: number): Commitments {
  // 答应的那一轮里她说的话（"好，十分钟后提醒你"）不算想过：不然刚答应就消耗掉了，到点叫不醒她。
  const due = (c: Commitment) =>
    c.start !== null && at >= c.start - leadOf(c) && at - c.madeAt > TURN_GAP;
  if (!state.open.some(due)) return state;
  return { ...state, open: state.open.map((c) => (due(c) ? { ...c, consideredAt: at } : c)) };
}

/**
 * 说了钟点的事到点了，像她给自己定的闹钟（2 月 schedule_task 的定时；"十分钟后提醒你关火"这种，压力慢慢涨
 * 赶不上：她刚说过话，再开口的饱和代价让意愿层晚了 6–11 分钟才叫醒她，eval-artifacts/expression）。
 * 只响一次：响过之后她在这里想过一次（决定了或调用失败）就算响过；PROSPECT_ALARM 之内没机会响就不再响。
 * 叫醒之后做不做、怎么说由她定。
 */
export function ringing(open: readonly Commitment[], now: number): Commitment | undefined {
  return open.find(
    (c) => c.precise && !c.rung && c.due !== null && now >= c.due && now < c.due + PROSPECT_ALARM,
  );
}

/** 她在这个会话里想过一次（一次发言调用有了结果）：已经到点的闹钟算响过了。 */
export function rang(state: Commitments, at: number): Commitments {
  if (!state.open.some((c) => c.precise && !c.rung && c.due !== null && at >= c.due)) return state;
  return {
    ...state,
    open: state.open.map((c) =>
      c.precise && !c.rung && c.due !== null && at >= c.due ? { ...c, rung: true } : c,
    ),
  };
}

function leadOf(c: Commitment): number {
  return c.start === null || c.due === null ? 0 : Math.max(c.due - c.start, PROSPECT_MIN_LEAD);
}

/**
 * P_prospect（论文 Remark prospect-separation，2 月 p-prospect.ts 修正后）：每件有约定时间、还没了结的事
 * w·σ(k·(x − ½))，x = 1 − (due − now)/L；过了约定时间在宽限期里线性消退，过期为 0。
 * 想过、决定先不之后乘 1 − e^{−Δ/τ}（τ = PROSPECT_REGROW·L），和好奇心消耗同一个形状。
 * 有界：≤ 件数 × w。
 */
export function prospectPressure(open: readonly Commitment[], now: number): number {
  let total = 0;
  for (const c of open) {
    if (c.due === null || now >= c.expireAt || now < c.madeAt) continue;
    const lead = leadOf(c);
    // 过了约定时间：急迫在宽限期里线性消退到 0（错过了就是错过了），而不是一直钉在最高。
    const x = Math.min(1, 1 - (c.due - now) / lead);
    const fade = now <= c.due ? 1 : (c.expireAt - now) / (c.expireAt - c.due);
    const sigma = fade / (1 + Math.exp(-PROSPECT_K * (x - 0.5)));
    const regrow =
      c.consideredAt > 0
        ? 1 - Math.exp(-Math.max(0, now - c.consideredAt) / (lead * PROSPECT_REGROW))
        : 1;
    total += PROSPECT_WEIGHT * sigma * regrow;
  }
  return total;
}

// ── 她自己的事 ───────────────────────────────────────────────────
// 2 月 threads.mod 的 begin_topic / advance / resolve_thread，只留她自己写下的话：没有权重、beat 类型、
// 因果链，也不做 thread_review 的摘要（多一次调用，2 月常空转，还诱发反复总结）。每个会话各自一份，
// 私聊里开的事只在那个私聊里出现。

/** 她在一个会话里跟着的一件事。 */
export interface Topic {
  /** 她自己的话（最近一次开头时的写法）。 */
  title: string;
  key: string;
  openedAt: number;
  /** 上一次开头或推进的时刻：多久没动过从这里算。 */
  touchedAt: number;
  /** 上一次进展：她写下的原话和时刻；只开了个头时是 null。 */
  beat: { text: string; at: number } | null;
}

/** 超出上限时放下最久没动过的那件（刚开头、刚推进的那件不会被放下）。 */
function capTopics(topics: Topic[]): Topic[] {
  if (topics.length <= OPEN_TOPICS) return topics;
  const oldest = topics.reduce((a, b) => (b.touchedAt < a.touchedAt ? b : a));
  return topics.filter((t) => t !== oldest);
}

/** 开始一件事：同一件事（归一化后的标题相同）再开一次只是又提起它，不另记一件。 */
export function openTopic(topics: readonly Topic[], title: string, at: number): Topic[] {
  const text = clip(title);
  const key = keyOf(text);
  if (!key) return [...topics];
  const same = topics.find((t) => t.key === key);
  if (same) return topics.map((t) => (t === same ? { ...t, title: text, touchedAt: at } : t));
  return capTopics([...topics, { title: text, key, openedAt: at, touchedAt: at, beat: null }]);
}

/**
 * 推进一件事：按内容认（键相同或互相包含）。认不出就当作她开始了一件新事、带着这次进展
 * （她常常不先写开始）；不按"只有一件"去认，免得把新的事记到旧的上面。
 */
export function advanceTopic(
  topics: readonly Topic[],
  topic: string,
  beat: string,
  at: number,
): Topic[] {
  const step = { text: clip(beat), at };
  if (!step.text) return [...topics];
  const match = matchByText(topics, topic, false);
  if (match) return topics.map((t) => (t === match ? { ...t, touchedAt: at, beat: step } : t));
  const text = clip(topic);
  const key = keyOf(text);
  if (!key) return [...topics];
  return capTopics([...topics, { title: text, key, openedAt: at, touchedAt: at, beat: step }]);
}

/** 了结一件事：按内容认；都对不上而这里只有一件时就是它。认不出就什么也不变。 */
export function closeTopic(topics: readonly Topic[], topic: string): Topic[] {
  const match = matchByText(topics, topic, true);
  return match ? topics.filter((t) => t !== match) : [...topics];
}

/** 放进提示词的几件：TOPIC_QUIET 之内动过的，最近动过的在前。 */
export function shownTopics(topics: readonly Topic[], now: number): Topic[] {
  return topics
    .filter((t) => now - t.touchedAt < TOPIC_QUIET)
    .sort((a, b) => b.touchedAt - a.touchedAt)
    .slice(0, TOPICS_SHOWN);
}
