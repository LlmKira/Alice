/**
 * 群里的人嫌她（生产；PLAN 第 7 件）。北极星："有人叫她停、对她冷下来、因为她而不说话了，她要察觉，并按对方
 * 的反馈退开"。这里只记她不受欢迎的信号，都是外壳判口气那一次调用看出来的（llm/tone.ts）或平台给的：叫她别回（stop）、
 * 叫她闭嘴少说（hush）、不想跟她说话或在打发她（aloof）、在她这一轮的话上点负面表情。骂她、挖苦她、试探她而人还在跟她说话，不是不欢迎，不记；她怎么接（留下、顶回去、走开）由她自己定，
 * 这里不替她选边。每一笔按人记，连续地加、连续地淡；没有开关、没有窗。
 * 自适应（docs/spec/control-loop.md 的"开放性引导和自适应设计"）：
 * - 一笔有多重，看这个群平时怎么对她：增量是回避的那一套（AVERSION_GAIN）乘 1 − 这个群里找她的话中不欢迎信号的比例。
 *   常态冷的群里一句冷淡算得轻，平时都友好的群里算得重。比例从先验（REJECTION_PRIOR）起，这个群判过的话越多越按它自己。
 * - 淡得多快，看这个群里嫌她的人平时多久回心转意：时间常数从先验（群的回避时间常数 2 小时，算 3 次）起，
 *   每有一个嫌她的人后来好好找她，就把这段间隔算进去。
 * 那个人之后友好或中性地找她，或在她的话上点了不是负面的表情，他那一份划掉；旁边对她友好的人不划掉别人的
 * （围观的人在笑，不抵消嫌她的人，out-rejection.md 反方 1）。
 * 在意愿里（turn.ts dwell 的 rejection 选项）：她在这个群接近类的动作多付 AVERSION_COST·tanh(各人之和)（和会话回避
 * 一样归一），离开不付。群里嫌她越多，她在这段对话里越难被别人的话叫醒、越难开口；被点名、事情够重要时照样会醒。
 * 心情（affect.ts 的 rejection 选项）：那里的反思写下的好心情按 1 − tanh(同一个量) 推。
 * 只读世界的类型，不引 world.ts 的值（world.ts 引 affect.ts，affect.ts 引这里）。
 */
import { AVERSION_COST, AVERSION_GAIN, AVERSION_TAU } from "./params.js";
import type { ChatNode, Rejection } from "./world.js";

/** heard：判过口气、既不是不欢迎也不是好好说话（敌意）——只算进这个群的常态。 */
export type Signal = "stop" | "cold" | "warm" | "heard";

const GAIN = { stop: AVERSION_GAIN.rejected, cold: AVERSION_GAIN.cold } as const;

/**
 * 先验。rate：找她的话里不欢迎信号的比例，线上 11-12、11-13 群里判过的 127 条里 9 条冷淡、0 次叫停、0 个负面表情，
 * 约 0.07；lines：先验算几条话（手设，10 条以后一半按这个群自己）。recoveries：恢复时间先验算几次（手设）。
 */
export const REJECTION_PRIOR = { rate: 0.07, lines: 10, recoveries: 3 } as const;

/** 这个群平时找她的话里不欢迎信号的比例（先验加这个群自己的）。 */
export function usualCold(r: Rejection): number {
  return (
    (REJECTION_PRIOR.rate * REJECTION_PRIOR.lines + r.cold) / (REJECTION_PRIOR.lines + r.heard)
  );
}

/** 这个群里嫌她的人多久回心转意（时间常数，先验加这个群自己的）。 */
export function recoveryTau(r: Rejection): number {
  const n0 = REJECTION_PRIOR.recoveries;
  return (n0 * AVERSION_TAU.group + r.recovered.ms) / (n0 + r.recovered.n);
}

/** 这一份此刻还剩多少。 */
const left = (x: { level: number; at: number }, now: number, tau: number) =>
  x.level * Math.exp(-Math.max(0, now - x.at) / tau);

/** 淡到这以下的那份不再记（状态有界）。 */
const FADED = 0.01;
/** 嫌弃还"在"：群里各人之和至少这么多时，受欢迎不压低她在这里的代价（will.ts）。和 FADED 同一个界。 */
export const REJECTED_LIVE = FADED;

/**
 * 外壳判出的一条属于哪种反馈；没有判出的是 null。叫她别回、叫她闭嘴少说是明确的"别来"（和被拒绝一样重）；不想跟她
 * 说话是轻的那种。口气里的"冷淡"不读：Jev 把普通的短回答判成冷淡（盲标 60 条里 3 条误报），这三项由更强的模型判
 * （llm/tone.ts）。批评她的做法不算：在那些群里多半是亲近的互损，其实是夸她（研究员 2026-11-13，labels-main.json）。
 */
export function signalOf(p: {
  tone?: string;
  stop?: true;
  hush?: true;
  aloof?: true;
}): Signal | null {
  if (p.stop || p.hush) return "stop";
  if (p.aloof) return "cold";
  if (p.tone === "hostile") return "heard";
  return p.tone === "friendly" || p.tone === "neutral" ? "warm" : null;
}

/** 一个人对她的一次反馈折进记录。增量按这一条之前的常态算，再把这一条算进常态。 */
export function feedback(r: Rejection, who: string, at: number, s: Signal): Rejection {
  const heard = r.heard + 1;
  if (s === "heard") return { ...r, heard };
  if (s === "warm") {
    const was = r.people[who];
    if (!was) return { ...r, heard };
    const people = Object.fromEntries(Object.entries(r.people).filter(([id]) => id !== who));
    const recovered = { n: r.recovered.n + 1, ms: r.recovered.ms + (at - was.since) };
    return { ...r, people, heard, recovered };
  }
  const tau = recoveryTau(r);
  const kept = Object.entries(r.people).filter(
    ([id, x]) => id === who || left(x, at, tau) >= FADED,
  );
  const prior = r.people[who];
  const level = (prior ? left(prior, at, tau) : 0) + GAIN[s] * (1 - usualCold(r));
  const since = prior && left(prior, at, tau) >= FADED ? prior.since : at;
  return {
    ...r,
    people: { ...Object.fromEntries(kept), [who]: { level, at, since } },
    heard,
    cold: r.cold + 1,
  };
}

/** 群里此刻嫌她的程度（各人淡掉后相加）。 */
export function rejectionAt(chat: ChatNode, now: number): number {
  const r = chat.turn.rejection;
  const tau = recoveryTau(r);
  return Object.values(r.people).reduce((sum, x) => sum + left(x, now, tau), 0);
}

/** 她在这个群接近类的动作多付的代价（乘 λ），和会话回避一样按 tanh 归一。 */
export function rejectionCost(chat: ChatNode, now: number): number {
  return AVERSION_COST * Math.tanh(rejectionAt(chat, now));
}
