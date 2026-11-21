/**
 * 驱动层：压力 P_k(G, t) 由世界状态算出（论文 §3），通用，不针对任何具体行为。
 * 每个会话一个驱动向量；联系人的关系冷却路由到和他的私聊（2 月 routeContributions）。
 */

import { sharePressure } from "./desire.js";
import type { Slice } from "./feature.js";
import { prospectPressure } from "./memory.js";
import {
  ATTENTION_CHAT,
  CURIOSITY_ETA,
  EXPECTED_DAILY,
  EXPECTED_SILENCE,
  GROUP_TIER,
  HABITUATION_ALPHA,
  HABITUATION_TAU,
  KAPPA_TONIC,
  NOVELTY_PER,
  NOVELTY_TAU,
  OBLIGATION_HALF_LIFE,
  P3_BETA,
  P3_TAU0,
  PLACE_FRESH,
  PLACE_REGROW,
  RESPONSE_CHAT,
  SIGMA_HALF_COUNT,
  TAU_CURIOSITY,
  THREAD_BETA,
  THREAD_LIFETIME,
  TIER_THETA,
  TIER_WEIGHT,
  type Tier,
  UNREAD_HALF_LIFE,
} from "./params.js";
import { infoPressure } from "./reach.js";
import { declineRun, type RelationView, relationView } from "./relation.js";
import { pullAt } from "./turn.js";
import {
  aversionAt,
  type ChatNode,
  chatTier,
  efold,
  groupTheta,
  halfLife,
  type TierLookup,
  type World,
} from "./world.js";

/**
 * 驱动：attention P1、obligation P5、thread P4（只从环境推出的没接的话）、cooling P3、curiosity P6、
 * aversion（ADR-217，由冷落与拒绝抬高）、prospect（她答应或打算的事快到时候了，memory.ts）。
 * prospect 只来自她自己记下的打算（intend），没有提供这项能力的机制时恒为 0。
 * information（P2，M03）：她最近在频道里看到、还没跟这个人分享过（也没想过要不要分享）的东西，只来自
 * 订阅频道的新帖（reach.ts infoPressure）；没有候选 reach 时恒为 0。候选 desire 再加一份：她手里最想在这个会话里
 * 说的那一件（desire.ts sharePressure，私聊和群里都算）。
 */
export interface DriveSpec {
  /** 单个会话的归一化 τ̂ = tanh(τ/κ)：κ 取单个实体的典型量级，固定不自适应（AdaptiveKappa 被排除）。 */
  kappa: number;
  /** 全局读数 API = Σ tanh(P/κ) 的 κ（论文 §3.5 按约 15 个联系人标定）。 */
  globalKappa: number;
  /** 属于哪个声部（论文 Table voices）；声部相关度按这些权重取加权平均。 */
  voice: Partial<Record<Voice, number>>;
  /** 内在驱动随她的厌倦减弱（乘 ρ_H）；义务与回避是外部信号，不减弱（论文 Eq habituation-application）。 */
  habituates: boolean;
  /**
   * 外部需求：来自别人。节奏随它快慢（外面热闹就勤快，安静就慢下来）；关系冷却、好奇心这类内在冲动只决定那一次
   * 想做什么，不加快节奏——否则联系人一多，总有一个人的冲动在涨，API_peak 被钉住（will 零成本估算：钉在
   * 1.0–1.4，间隔恒约 80 秒）。
   */
  demand: boolean;
}

export const VOICES = ["diligence", "curiosity", "sociability", "caution"] as const;
export type Voice = (typeof VOICES)[number];

/**
 * 驱动表：每个驱动的归一化、全局 κ、声部、习惯化和是不是外部需求只写在这里，其余都从它派生。次序就是驱动的次序。
 * 声部权重：ADR-181（P5 同时算社交，双路由；线程 0.7）；2 月 τ_P 属于勤勉（iaus-scorer 的 U_prospect 由 π_D 调制）；
 * P2 信息压力属于好奇（ADR-181）；Inner Thoughts 的 relevance 是想说的冲动（好奇），想接某个人的话是社交。
 */
const driveTable = <T extends Record<string, DriveSpec>>(t: T): { [K in keyof T]: DriveSpec } => t;

export const DRIVE_SPEC = driveTable({
  attention: {
    kappa: 5,
    globalKappa: 30,
    voice: { diligence: 1 },
    habituates: true,
    demand: true,
  },
  obligation: {
    kappa: 3,
    globalKappa: 10,
    voice: { diligence: 1, sociability: 0.6 },
    habituates: false,
    demand: true,
  },
  thread: {
    kappa: 5,
    globalKappa: 20,
    voice: { diligence: 0.7 },
    habituates: true,
    demand: true,
  },
  cooling: {
    kappa: 3,
    globalKappa: 8,
    voice: { sociability: 1 },
    habituates: true,
    demand: false,
  },
  curiosity: {
    kappa: 1,
    globalKappa: CURIOSITY_ETA,
    voice: { curiosity: 1 },
    habituates: true,
    demand: false,
  },
  aversion: {
    kappa: 1,
    globalKappa: 3,
    voice: { caution: 1 },
    habituates: false,
    demand: false,
  },
  /** 一件到时候的承诺（w = 2，接近约定时间约 1.8）→ τ̂ ≈ 0.95；全局约两件同时到时候。手设。 */
  prospect: {
    kappa: 1,
    globalKappa: 4,
    voice: { diligence: 1 },
    habituates: true,
    demand: false,
  },
  /** 两三条刚看到、还没分享的新鲜帖子（对最亲近的人）→ τ̂ ≈ 0.76–0.96；全局几个人身上都有。手设。 */
  information: {
    kappa: 1.5,
    globalKappa: 4,
    voice: { curiosity: 1 },
    habituates: true,
    demand: false,
  },
  /**
   * 群里别人的话对上她心里的东西（候选 groupturn，turn.ts）：一条显著度 0.3–1 的话 → τ̂ ≈ 0.29–0.76，和群里几条未读的
   * 注意力同量级；全局和单个会话的 κ 相同（拉力只看最强的那个群）。手设。
   */
  topic: {
    kappa: 1,
    globalKappa: 1,
    voice: { curiosity: 1 },
    habituates: true,
    demand: true,
  },
  /** 说话的人最近和她有来往（候选 groupturn）：一条 → τ̂ ≈ 0.32，三条 ≈ 0.76。手设。 */
  bond: {
    kappa: 3,
    globalKappa: 3,
    voice: { sociability: 1 },
    habituates: true,
    demand: true,
  },
});

export type DriveKey = keyof typeof DRIVE_SPEC;
export type Drives = Record<DriveKey, number>;
export const DRIVES = Object.keys(DRIVE_SPEC) as readonly DriveKey[];

/**
 * 意愿层里读压力场某一样的块的几项（mind/compose.ts 的部分）：那一块没有提供者时这一项不算（为 0），
 * 组合结果把它列为不激活。commitments：prospect 和离开时丢掉的承诺（memory）；information：P2（reach）；
 * place：看过预览的群的好奇心（reach）；topic、bond：群里的拉力（候选 groupturn）。
 */
export const DRIVE_TERMS = [
  { name: "drive.commitments", term: "commitments", requires: ["chats.commitments"] },
  { name: "drive.information", term: "information", requires: ["reach"] },
  { name: "drive.place", term: "place", requires: ["chats.place"] },
  { name: "drive.topic", term: "topic", requires: ["chats.turn.topic"] },
  { name: "drive.bond", term: "bond", requires: ["chats.turn.bond"] },
  { name: "drive.share", term: "share", requires: ["posts"] },
] as const satisfies ReadonlyArray<{ name: string; term: string; requires: readonly Slice[] }>;
export type DriveTerms = Readonly<Record<(typeof DRIVE_TERMS)[number]["term"], boolean>>;
/** 不按组成算时（单独调意愿层的测试、工具）：每一项都算，读到的是那一块此刻的值。 */
export const ALL_TERMS: DriveTerms = {
  commitments: true,
  information: true,
  share: true,
  place: true,
  topic: true,
  bond: true,
};
/** 外部需求的驱动：节律由它们的强度量决定。 */
export const DEMAND_DRIVES = DRIVES.filter((k) => DRIVE_SPEC[k].demand);

/** 对数时间域 sigmoid（论文 Eq P3-raw，ADR-111）。 */
export function logSigmoid(silence: number, theta: number): number {
  const x = Math.log(1 + Math.max(0, silence) / P3_TAU0) - Math.log(1 + theta / P3_TAU0);
  return 1 / (1 + Math.exp(-P3_BETA * x));
}

/**
 * 她没看到的事变旧了多久：默认是墙上时间；有作息时只算她醒着的时间（sleep.ts awakeBetween）。
 */
export type Age = (from: number, to: number) => number;
/** 墙上时间：没有作息时的变旧时钟。 */
export const wallClock: Age = (from, to) => to - from;

/** 有效未读 EU = max(phasic, tonic)（论文 Eq P1-phasic/tonic，ADR-150/176）。 */
export function effectiveUnread(chat: ChatNode, now: number, age: Age = wallClock): number {
  if (chat.unread <= 0) return 0;
  const phasic = halfLife(chat.ewms, age(chat.ewmsAt, now), UNREAD_HALF_LIFE);
  return Math.max(phasic, KAPPA_TONIC * Math.log(1 + chat.unread));
}

/** 有效义务 Ω = pending · 2^(−age/τ)（ADR-157）。 */
export function effectiveObligation(chat: ChatNode, now: number, age: Age = wallClock): number {
  return chat.pending > 0
    ? halfLife(chat.pending, age(chat.lastDirectedAt, now), OBLIGATION_HALF_LIFE)
    : 0;
}

/** ρ_H = 1/(1+αH)（论文 Eq habituation-modulation）。 */
export function habituationFactor(chat: ChatNode, now: number): number {
  return 1 / (1 + HABITUATION_ALPHA * efold(chat.habit, now - chat.habitAt, HABITUATION_TAU));
}

export { groupTheta };

/**
 * 关系冷却（论文 Eq P3-raw）：从上一次"有回应的互动"（对方来找她、点名她、回应了她）算起的沉默。
 * 她主动找了对方但对方没理，冷却不缓解（研究员 2026-11-11）；会不会再找一次由 σ_out 与回避决定。
 */
export function contactCooling(person: RelationView, tier: Tier, now: number): number {
  if (person.lastBondAt <= 0) return 0;
  const since = Math.max(person.lastBondAt, person.consideredAt);
  return TIER_WEIGHT[tier] * logSigmoid((now - since) / declineBackoff(person), TIER_THETA[tier]);
}

/** 退避的上限：连着决定先不之后，再想起他最慢是平时的 2^6 = 64 倍（几天一次，而不是几个小时一次）。 */
const BACKOFF_MAX_DOUBLINGS = 6;

/**
 * 连着几次想过、决定先不找他，冷却就长得越慢（指数退避，同 TCP 重传与以太网的二进制指数退避）：第一次照常，
 * 之后每多一次翻一倍，直到上限；有了新的互动从头数。没有它时，一个半年没来往的人会让她每天被叫醒约 7 次、
 * 每次都想一遍"要不要找他"再放下（场景 s13，统一 A/B 2026-11-12：189 天 1,212 次调用）。
 */
function declineBackoff(
  person: Pick<RelationView, "consideredAt" | "lastBondAt" | "declines">,
): number {
  return 2 ** Math.min(Math.max(0, declineRun(person) - 1), BACKOFF_MAX_DOUBLINGS);
}

/**
 * 群聊存在感（ADR-104/161）：群在没人理她的情况下又聊了多久，按群自己的节奏衡量。
 * 从上一次有人回应她（没有就从她上次说话）到别人最近一条：群没人说话时缺席感不增长
 * （替代 2 月 S3 对偶的硬跳过）；她插话被冷落，缺席感不缓解。
 */
export function groupAbsence(chat: ChatNode): number {
  if (chat.chatType !== "group" || chat.lastAliceAt <= 0) return 0;
  const since = Math.max(
    chat.lastBondAt,
    chat.lastBondAt > 0 ? 0 : chat.lastAliceAt,
    chat.consideredAt,
  );
  return TIER_WEIGHT[GROUP_TIER] * logSigmoid(chat.lastIncomingAt - since, groupTheta(chat));
}

/** 没接的话的代价（论文 Def P4 retrospective 项）：w·((1+age/天)^β − 1)，过了寿命不再计。 */
export function threadPressure(chat: ChatNode, now: number): number {
  const t = chat.thread;
  if (!t) return 0;
  const age = now - t.openedAt;
  if (age < 0 || age >= THREAD_LIFETIME) return 0;
  return t.weight * ((1 + age / 86_400_000) ** THREAD_BETA - 1);
}

/** 这个人的行为偏离预期多少（论文 Remark per-contact surprise），∈ [0, 1)。 */
export function contactSurprise(
  person: RelationView,
  tier: Tier,
  graphAgeDays: number,
  now: number,
): number {
  const sigma = 1 / (1 + person.count / SIGMA_HALF_COUNT);
  const expected = EXPECTED_SILENCE[tier];
  const s1 = Math.abs(now - person.lastActiveAt - expected) / expected;
  const s2 =
    person.count >= 2 && graphAgeDays >= 1
      ? Math.abs(Math.log(Math.max(person.count / graphAgeDays / EXPECTED_DAILY[tier], 0.01)))
      : 0;
  const surprise = sigma + (1 - sigma) * Math.tanh((s1 + s2) / 2);
  // 她想过这个人、决定先不找，好奇也一起消耗、一起退避（与冷却同一个结局）。
  const since = Math.max(person.lastActiveAt, person.consideredAt);
  const backoff = person.consideredAt > person.lastActiveAt ? declineBackoff(person) : 1;
  const gamma = 1 - Math.exp(-(now - since) / backoff / TAU_CURIOSITY);
  return (TIER_WEIGHT[tier] / TIER_WEIGHT[5]) * surprise * gamma;
}

/**
 * 全局好奇心 P6 = max(0, η − ν̄)（论文 Def P6），ν̄ 是每分钟的新奇量。有界：P6 ∈ [0, η]。
 * 2 月把每个人的 surprise 加总（365 人，均值 19.9），永远钉在 tanh 上限（ADR-195）。
 */
export function curiosityDeficit(world: World, now: number): number {
  const perMinute =
    efold(world.novelty, now - world.noveltyAt, NOVELTY_TAU) * (NOVELTY_PER / NOVELTY_TAU);
  return Math.max(0, CURIOSITY_ETA - perMinute);
}

/**
 * 一个她看过预览、还没加入的群（A18）：好奇心 = 她此刻有多缺新鲜事（全局 P6 缺口 / η，∈ [0, 1]）
 * × 预览还新不新（PLACE_FRESH 衰减）× 想过、没加之后重新长起（考虑过就消耗；PLACE_REGROW）。
 * 外面热闹时她不缺新鲜事，就不会想去新群。刚看到预览时不打折：看了就是想过一次的开始。
 */
export function placeCuriosity(world: World, chat: ChatNode, seenAt: number, now: number): number {
  const bored = curiosityDeficit(world, now) / CURIOSITY_ETA;
  const fresh = Math.exp(-Math.max(0, now - seenAt) / PLACE_FRESH);
  const regrown =
    chat.consideredAt > seenAt ? 1 - Math.exp(-(now - chat.consideredAt) / PLACE_REGROW) : 1;
  return bored * fresh * regrown;
}

/** 一个会话此刻的原始驱动（未归一化，未习惯化）。 */
export function rawDrives(
  world: World,
  chat: ChatNode,
  now: number,
  tiers?: TierLookup,
  age: Age = wallClock,
  on: DriveTerms = ALL_TERMS,
  /** 这个会话的 id（想分享的劲按会话算，desire.ts）。 */
  scope?: string,
): Drives {
  const tier = chatTier(world, chat, now, tiers);
  const partner = chat.partner ? relationView(world, chat.partner) : undefined;
  const graphAgeDays = world.firstAt > 0 ? (now - world.firstAt) / 86_400_000 : 0;
  const pull = pullAt(chat, now);
  return {
    attention: effectiveUnread(chat, now, age) * TIER_WEIGHT[tier] * ATTENTION_CHAT[chat.chatType],
    obligation:
      effectiveObligation(chat, now, age) * TIER_WEIGHT[tier] * RESPONSE_CHAT[chat.chatType],
    thread: threadPressure(chat, now),
    cooling:
      chat.chatType === "group"
        ? groupAbsence(chat)
        : partner
          ? contactCooling(partner, tier, now)
          : 0,
    curiosity:
      on.place && chat.place && !chat.member
        ? placeCuriosity(world, chat, chat.place.seenAt, now)
        : chat.chatType === "private" && partner
          ? contactSurprise(partner, tier, graphAgeDays, now)
          : 0,
    aversion: aversionAt(chat, now),
    prospect: on.commitments ? prospectPressure(chat.commitments.open, now) : 0,
    information:
      (on.information ? infoPressure(world, chat, TIER_WEIGHT[tier] / TIER_WEIGHT[5], now) : 0) +
      (on.share && scope ? sharePressure(world, scope, now) : 0),
    topic: on.topic ? pull.topic : 0,
    bond: on.bond ? pull.bond : 0,
  };
}

/**
 * τ̂_k = tanh(τ_k/κ_k)，固定 κ（AdaptiveKappa 会把持续压力钉在 tanh(1)，被排除）。
 * 内在驱动乘习惯化 ρ_H；义务与回避是外部信号，不随她的厌倦减弱（论文 Eq habituation-application）。
 */
export function normalizeDrives(raw: Drives, rho: number): Drives {
  return driveRecord((k) => {
    const n = Math.tanh(raw[k] / DRIVE_SPEC[k].kappa);
    return DRIVE_SPEC[k].habituates ? n * rho : n;
  });
}

/** 每个驱动一个值（按驱动表的次序）。 */
export function driveRecord(value: (k: DriveKey) => number): Drives {
  return Object.fromEntries(DRIVES.map((k) => [k, value(k)])) as Drives;
}
