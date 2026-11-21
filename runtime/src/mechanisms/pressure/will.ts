/**
 * 意愿层：在所有（目标会话 × 可供性）上按软效用排序（论文 §4 Eq nsv），节律到点时取 NSV 最高的那个。
 * 不做 Boltzmann 抽样：纯函数核心里没有随机数，取最高分让回放确定；多样性来自环境（考虑过就消耗）。
 *   NSV(a, h) = Σ_k relieves_a[k]·τ̂_k(h) − λ(h)·(C_social(a, h) + C_sat(a, h))
 * NSV ≤ 0 的候选不进池，全都 ≤ 0 时什么都不做（论文 Axiom V）；所以没有任何事后闸门，
 * 约束都在目标函数里（ADR-136 anti-windup）。这里只读可供性的声明，不为具体动作写分支。
 * 声部（论文 §4.1–4.4）不决定动作，只说明此刻是哪种需要在驱动：它是人格面向的输入，也是诊断。
 */
import { type ActKind, memberAfter, offers } from "../../mind/affordances.js";
import type { ChatType } from "../../mind/events.js";
import { withheldBy } from "../scene-facts.js";
import type { ChatView, WillAffordance } from "./affordances.js";
import {
  type Age,
  ALL_TERMS,
  curiosityDeficit,
  DEMAND_DRIVES,
  DRIVE_SPEC,
  DRIVES,
  type DriveKey,
  type Drives,
  type DriveTerms,
  driveRecord,
  effectiveObligation,
  habituationFactor,
  normalizeDrives,
  rawDrives,
  VOICES,
  type Voice,
  wallClock,
} from "./drives.js";
import type { WillTerms } from "./feature.js";
import { INTRINSIC_DRIVES, splitRelief } from "./feedback.js";
import {
  AVERSION_COST,
  AVERSION_TAU,
  CAUTION_CONFLICT,
  CAUTION_NORM,
  CAUTION_RISK,
  COST_WINDOW,
  CURIOSITY_ETA,
  DENSITY_SCALE,
  EXIT,
  LAMBDA0,
  OBLIGATION_THETA,
  PERSONALITY,
  PHI_DIRECTED,
  PHI_TURN,
  SAT,
  SOCIAL_WEIGHTS,
  TIER_THETA,
  type Tier,
  TURN_WINDOW,
  UNCERTAINTY_COUNT,
  VOICE_TAU_C,
  VOICE_TAU_MAX,
  VOICE_TAU_MIN,
  WAKE_TEMPERATURE,
} from "./params.js";
import { joinCost } from "./reach.js";
import { REJECTED_LIVE, rejectionAt } from "./rejection.js";
import {
  type ChatNode,
  chatTier,
  countIn,
  effortAt,
  halfLife,
  isSolicited,
  isTurn,
  outHalfLife,
  type TierLookup,
  type World,
} from "./world.js";

export { VOICES, type Voice } from "./drives.js";

/** 驱动主要属于哪个声部：驱动表里权重最大的那个（P5 同时算社交，权重小一些）。 */
function voiceOf(k: DriveKey): Voice {
  const w = DRIVE_SPEC[k].voice;
  return VOICES.reduce((best, v) => ((w[v] ?? 0) > (w[best] ?? 0) ? v : best));
}

/** 一个声部的驱动与权重（驱动表派生）。 */
const drivesOf = (v: Voice) =>
  DRIVES.flatMap((k) => {
    const w = DRIVE_SPEC[k].voice[v];
    return w === undefined ? [] : [[k, w] as const];
  });
const VOICE_DRIVES = {
  diligence: drivesOf("diligence"),
  curiosity: drivesOf("curiosity"),
  sociability: drivesOf("sociability"),
  caution: drivesOf("caution"),
};

export interface SaturationCost {
  rate: number;
  cool: number;
  out: number;
  fail: number;
  total: number;
}

export interface Intention {
  scope: string;
  chatType: ChatType;
  affordance: string;
  /** ΔP 里贡献最大的驱动对应的声部。 */
  voice: Voice;
  relief: number;
  socialCost: number;
  /** socialCost 里对别人的打扰那一部分（C_social：互惠、关系距离、侵入度、她手上多忙），不含睡眠、回避这些她自己的状态。 */
  imposition: number;
  saturation: SaturationCost;
  lambda: number;
  nsv: number;
}

/** 离开的机会成本（params.ts EXIT）：走了会丢掉的回应与承诺，加上证据薄时等待的价值。 */
export function exitCost(chat: ChatNode, now: number, on: DriveTerms = ALL_TERMS): number {
  const answered = chat.receptions
    .filter((r) => r.kind === "replied" || r.kind === "taken")
    .reduce((a, r) => a + 2 ** (-(now - r.at) / EXIT.halfLife), 0);
  const invested = answered + (on.commitments ? chat.commitments.open.length : 0);
  return EXIT.invest * Math.tanh(invested / EXIT.kappa) + EXIT.wait / (1 + chat.receptions.length);
}

/** 一个会话此刻的驱动读数。 */
export interface ChatReading {
  scope: string;
  chatType: ChatType;
  tier: Tier;
  raw: Drives;
  /** τ̂_k，已乘习惯化（义务豁免）。 */
  normalized: Drives;
  /** 1 − ρ_H。 */
  habituation: number;
  obligation: number;
  solicited: boolean;
  /** 本会话的声部分布（论文 Eq softmax，无噪声）。 */
  voices: Record<Voice, number>;
  voice: Voice;
}

/** 归一化 Shannon 熵：几种驱动同时都高 = 目标冲突（ADR-181 BIS）。 */
function entropy(values: readonly number[]): number {
  const sum = values.reduce((a, b) => a + b, 0);
  if (sum <= 0) return 0;
  let h = 0;
  for (const v of values) if (v > 0) h -= (v / sum) * Math.log(v / sum);
  return h / Math.log(values.length);
}

function std(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
}

function softmax(xs: readonly number[], tau: number): number[] {
  const top = Math.max(...xs);
  const exps = xs.map((x) => Math.exp((x - top) / tau));
  const z = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / z);
}

/** 一个声部的驱动按驱动表权重的加权平均（extra 是不在会话里的那一项，全局好奇心，权重 1）。 */
function weighted(v: Voice, n: Drives, extra = 0, extraWeight = 0): number {
  const rows = VOICE_DRIVES[v];
  const sum = rows.reduce((a, [k, w]) => a + w * n[k], extra * extraWeight);
  return sum / rows.reduce((a, [, w]) => a + w, extraWeight);
}

/**
 * 声部相关度 R_v（ADR-181）：勤勉、好奇、社交是驱动表里各自驱动的加权平均（好奇另加全局好奇心），
 * 和 Intention.voice（贡献最大的驱动的声部）用同一张表。
 */
export function voiceRelevance(
  n: Drives,
  raw: Drives,
  curiosity: number,
  uncertainty: number,
): Record<Voice, number> {
  return {
    diligence: weighted("diligence", n),
    curiosity: weighted("curiosity", n, curiosity, 1),
    sociability: weighted("sociability", n),
    // 论文 Remark BIS caution：(冲突 × 量级 + 风险) × (1 + U)；回避充当风险项（ADR-181 α_r = 0.8）。
    // 2 月代码是 "+ U"，安静时 Caution 独大（论文自己指出的冷启动陷阱）。
    caution:
      (CAUTION_CONFLICT *
        entropy(DRIVES.map((k) => n[k])) *
        Math.tanh(Math.hypot(...DRIVES.map((k) => raw[k])) / CAUTION_NORM) +
        CAUTION_RISK * n.aversion) *
      (1 + uncertainty),
  };
}

/** 声部 softmax，自适应温度（论文 Eq softmax、adaptive-tau）。不加噪声：纯函数里没有随机数。 */
export function voiceSoftmax(relevance: Record<Voice, number>): Record<Voice, number> {
  const loud = VOICES.map((v) => PERSONALITY[v] * relevance[v]);
  const tau = VOICE_TAU_MIN + (VOICE_TAU_MAX - VOICE_TAU_MIN) / (1 + VOICE_TAU_C * std(loud));
  const probs = softmax(loud, tau);
  return Object.fromEntries(VOICES.map((v, i) => [v, probs[i] as number])) as Record<Voice, number>;
}

export function argmaxVoice(p: Record<Voice, number>): Voice {
  return VOICES.reduce((best, v) => (p[v] > p[best] ? v : best), VOICES[0] as Voice);
}

/** C_sat（论文 Def saturation-cost，ADR-136 方案 A）：执行约束作为连续代价进入目标函数。 */
export function saturation(
  chat: ChatNode,
  tier: Tier,
  obliged: boolean,
  burst: boolean,
  now: number,
  /** 她还在这段对话里（turn.ts inFloor）：接着说不是新开话头，不收主动开口的冷却。 */
  continuing = false,
): SaturationCost {
  // 四项都只对算作消息的可供性（burst）收：频率、冷却、连发计的是她发消息的节奏；失败（沉默、发不出去、
  // 被拉黑）罚的是再发一条，不罚离开——总被拒正是离开的理由（L2，pressure-properties）。反复为同一件事
  // 醒来由"考虑过就消耗"管（consideredAt、stayedAt）。
  const cap = obliged ? SAT.rateCapObliged : SAT.rateCap;
  const rate = burst
    ? Math.min(1, countIn(chat.turns, now, SAT.rateWindow) / cap) ** SAT.rateExp
    : 0;
  const tauCool =
    SAT.coolAlpha * TIER_THETA[tier] * (chat.chatType === "group" ? SAT.coolGroup : 1);
  const cool =
    burst && chat.lastProactiveAt > 0 && !continuing
      ? Math.exp(-(now - chat.lastProactiveAt) / tauCool)
      : 0;
  const outgoing = burst ? halfLife(chat.outgoing, now - chat.outgoingAt, outHalfLife(chat)) : 0;
  // 不封顶：封顶的代价压不住足够强的冲动——对最亲近的人她会一直发下去（memory-eval 里最多连发 27 轮；
  // 2 月的她私聊里没人回时最多连找 3 次，p90 为 2）。ADR-251 的 U_unilateral 同样随连发数持续加重。
  const out = (outgoing / SAT.outCap[chat.chatType]) ** SAT.outExp;
  const silences = halfLife(chat.silences, now - chat.silencesAt, SAT.failHalfLife);
  const fail = burst ? 1 - Math.exp(-SAT.failGamma * silences) : 0;
  return {
    rate,
    cool,
    out,
    fail,
    total: SAT.wRate * rate + SAT.wCool * cool + SAT.wOut * out + SAT.wFail * fail,
  };
}

/**
 * C_social（论文 Eq NSV；2 月 social-cost.ts 的 dist/imp/temp）。修正两处 2 月缺陷（ADR-60 审计）：
 * 互惠只罚她比对方说得多（2 月取绝对差、窗口以秒为分母，几乎恒为 0）；
 * 关系距离按 tier/500（2 月写成 1 − tier/500，越亲近成本越高）。power 项没有输入，去掉。
 */
export function socialCost(
  world: World,
  chat: ChatNode,
  tier: Tier,
  intrusiveness: number,
  now: number,
  /** 互惠按投入算（world.ts effort）：对方只回"1"、贴纸时，她说得再多也不算两清。 */
  byEffort = false,
): number {
  const group = chat.chatType === "group";
  const effort = byEffort ? effortAt(chat, now) : null;
  const hers = effort ? effort.hers : countIn(chat.turns, now, COST_WINDOW);
  const theirs = effort ? effort.theirs : countIn(chat.incoming, now, COST_WINDOW);
  const reciprocity = Math.min(1, Math.max(0, hers - theirs) / 5) * (group ? 0.3 : 1);
  const distance = (tier / 500) * (group ? 0.4 : 1);
  const tauDist = TIER_THETA[tier] / 2;
  const gap = now - Math.max(chat.lastAliceAt, chat.lastDirectedAt);
  const stale = 1 / (1 + Math.exp(-(gap - 2 * tauDist) / tauDist));
  const dist = 0.5 * reciprocity + 0.3 * distance + 0.2 * stale;

  const outgoing = halfLife(chat.outgoing, now - chat.outgoingAt, outHalfLife(chat));
  const quiet = now - Math.max(chat.lastIncomingAt, chat.lastAliceAt) > TURN_WINDOW;
  const context = [
    0.5,
    ...(quiet ? [group ? 0.2 : 0.6] : []),
    ...(outgoing > 0 ? [Math.min(1, outgoing / 5)] : []),
  ];
  const ctx = context.reduce((a, b) => a + b, 0) / context.length;
  const imp = 0.5 * ctx + 0.5 * intrusiveness;

  const density = countIn(world.turns, now, COST_WINDOW);
  const temp = 0.7 * (1 - Math.exp(-density / DENSITY_SCALE)) + 0.3 * (density > 0 ? 1 : 0);
  return SOCIAL_WEIGHTS.dist * dist + SOCIAL_WEIGHTS.imp * imp + SOCIAL_WEIGHTS.temp * temp;
}

/** 一个会话此刻的驱动读数。 */
export function readChat(
  world: World,
  scope: string,
  now: number,
  tiers?: TierLookup,
  age?: Age,
  on?: DriveTerms,
): ChatReading | null {
  const chat = world.chats[scope];
  if (!chat) return null;
  const raw = rawDrives(world, chat, now, tiers, age, on, scope);
  const rho = habituationFactor(chat, now);
  const normalized = normalizeDrives(raw, rho);
  const curiosity = Math.tanh(curiosityDeficit(world, now) / CURIOSITY_ETA);
  const voices = voiceSoftmax(
    voiceRelevance(normalized, raw, curiosity, Math.exp(-chat.seen / UNCERTAINTY_COUNT)),
  );
  return {
    scope,
    chatType: chat.chatType,
    tier: chatTier(world, chat, now, tiers),
    raw,
    normalized,
    habituation: 1 - rho,
    obligation: effectiveObligation(chat, now, age),
    solicited: isSolicited(chat, now),
    voices,
    voice: argmaxVoice(voices),
  };
}

/** 这个动作对每个驱动的期望缓解（乘折扣之前）：relieves_a[k]·τ̂_k，回避按离开的冲动重新长起的程度打折。 */
export function reliefTerms(
  chat: ChatNode,
  reading: ChatReading,
  affordance: Pick<WillAffordance, "relieves">,
  now: number,
): Array<readonly [DriveKey, number]> {
  // 离开的冲动在她上次想过、没走之后按回避自己的时间常数重新长起。
  const stayed = chat.stayedAt > 0 ? now - chat.stayedAt : Number.POSITIVE_INFINITY;
  const urge = 1 - Math.exp(-stayed / AVERSION_TAU[chat.chatType]);
  return DRIVES.map(
    (k) =>
      [
        k,
        (affordance.relieves[k] ?? 0) * reading.normalized[k] * (k === "aversion" ? urge : 1),
      ] as const,
  );
}

/** 一个 (会话, 可供性) 候选的净社交价值。 */
export function intention(
  world: World,
  reading: ChatReading,
  affordance: WillAffordance,
  now: number,
  policy: WillPolicy = BARE_WILL,
  /** 叫醒她的那条消息是谁发的（节律到点时没有）：按人读的回避读这个人（relation.ts）。 */
  waker: string | null = null,
): Intention {
  const chat = world.chats[reading.scope] as ChatNode;
  const rawTerms = reliefTerms(chat, reading, affordance, now);
  const gain = policy.gain(world, reading, now);
  const intrinsic = policy.intrinsicGain?.(world, reading, now) ?? 1;
  const split = splitRelief(rawTerms, INTRINSIC_DRIVES, intrinsic);
  const terms = split.terms.map(([k, v]) => [k, v * gain] as const);
  const relief = split.total * gain;
  const top = terms.reduce((a, b) => (b[1] > a[1] ? b : a));
  // λ = λ0·φ(Ω, ψ)：被点名时对代价不那么敏感，轮到她时次之（论文 Eq lambda-modulation、phi-obligation）。
  const obliged = reading.obligation > OBLIGATION_THETA;
  const continuing = policy.continuing(chat, now);
  const lambda =
    policy.lambda0 * (obliged ? PHI_DIRECTED : isTurn(chat) || continuing ? PHI_TURN : 1);
  const intrusive =
    affordance.intrusiveness[chat.chatType][reading.solicited ? "solicited" : "unsolicited"];
  const sat = saturation(chat, reading.tier, obliged, Boolean(affordance.posts), now, continuing);
  // 对让她回避的目标，接近类动作更贵；能缓解回避的动作（如离开）不付这笔（ADR-217 的乘性折扣改成代价项）。
  // 组成里有按人记的回避时，冲着人的动作读那个人的（relation.ts）；否则读会话的。
  const person = policy.aversion?.(world, reading.scope, affordance, now, waker) ?? null;
  // 先不被嫌弃，再说受欢迎（北极星）：这个群里有人正嫌她时，"被接得多"不把代价压到 0 以下（PLAN 第 43 件）。
  const room =
    reading.normalized.aversion < 0 && rejectionAt(chat, now) >= REJECTED_LIVE
      ? 0
      : reading.normalized.aversion;
  const aversion = person === null ? room : person;
  const avoid = AVERSION_COST * aversion * (1 - (affordance.relieves.aversion ?? 0));
  const imposition =
    socialCost(world, chat, reading.tier, intrusive, now, policy.effortReciprocity === true) *
    (policy.impositionScale?.(world, chat, affordance, now) ?? 1);
  const social =
    imposition +
    avoid +
    (memberAfter(affordance) === false ? exitCost(chat, now, policy.drives) : 0) +
    (memberAfter(affordance) === true ? joinCost(world, now) : 0) +
    policy.cost(world, chat, affordance, now);
  const busy = policy.busy(world, now, { obliged, continuing });
  return {
    scope: reading.scope,
    chatType: chat.chatType,
    affordance: affordance.kind,
    voice: voiceOf(top[0]),
    relief,
    socialCost: social,
    imposition,
    saturation: sat,
    lambda,
    nsv: relief - lambda * (social + sat.total) - busy,
  };
}

/**
 * 世界图里一个会话给可供性的视图（和核心状态的 chatView 同一个契约）。世界图不记她看过什么、交出去的事、
 * 时间线上的消息，这几项给空：靠它们才可用的行（发图、改消息、复读、群里发语音）在意愿层里不可用。
 */
export function chatViewOf(c: ChatNode): ChatView {
  return {
    chatType: c.chatType,
    member: c.member,
    fresh: c.unread,
    looked: [],
    running: 0,
    lookRun: 0,
    own: [],
    echo: null,
  };
}

/**
 * 意愿层的全部可变项：压力场的各样东西（feature.ts WillTerms）组合出来的，加上 λ0 和层级来源。
 * 意愿层只读它，不认识任何一样具体的东西。
 */
export interface WillPolicy extends WillTerms {
  /** 社交代价敏感度 λ0（敏感度扫描时覆盖；生产用 params.ts 的 LAMBDA0）。 */
  lambda0: number;
  tiers?: TierLookup;
  /**
   * 这个会话里有机制提供的能力（登记表 gated 的行只有这时才算她能做）：和发言提示里给她的是同一个判断，
   * 意愿层不为她做不了的事叫醒她。只知道压力场自己提供的那几样：别的机制提供的 gated 行（语音、改消息、
   * 查一下）现在都不缓解任何驱动，不进意愿层。
   */
  provided(scope: string, world: World, now: number): ReadonlySet<ActKind>;
  /** 读压力场某一样的块的驱动项算不算（drives.ts DRIVE_TERMS，由组合解析出来）。 */
  drives: DriveTerms;
  /** 互惠按双方投入算，不按轮数（world.ts effort）；不设时按轮数。 */
  effortReciprocity?: boolean;
}

/** 什么都没加的意愿层：墙上时间，没有额外代价、折扣和对话延续。 */
export const BARE_WILL: WillPolicy = {
  lambda0: LAMBDA0,
  age: wallClock,
  candidates: (world) => world,
  visible: () => true,
  gain: () => 1,
  intrinsicGain: () => 1,
  continuing: () => false,
  cost: () => 0,
  impositionScale: () => 1,
  busy: () => 0,
  provided: () => new Set(),
  drives: ALL_TERMS,
};

/** 一个会话里所有可用的意愿（未排序）。 */
export function intentionsFor(
  world: World,
  affordances: readonly WillAffordance[],
  scope: string,
  now: number,
  policy: WillPolicy = BARE_WILL,
  waker: string | null = null,
): Intention[] {
  const reading = readChat(world, scope, now, policy.tiers, policy.age, policy.drives);
  if (!reading) return [];
  const chat = world.chats[scope] as ChatNode;
  const view = chatViewOf(chat);
  const provided = policy.provided(scope, world, now);
  // 群里禁发的动作，发言提示里不给，意愿层也不为它排分（ADR-276；scene-facts.ts withheldBy 是同一份）。
  const banned = chat.chatType === "group" ? new Set(withheldBy(world.bans?.[scope])) : null;
  return affordances
    .filter(
      (a) =>
        offers(a, view, now, provided) &&
        (a.wakes?.(view) ?? true) &&
        !(banned?.has(a.kind as ActKind) ?? false),
    )
    .map((a) => intention(world, reading, a, now, policy, waker));
}

/** 意愿的强弱换成 (0,1) 的分数：logistic(NSV/τ)，> 0.5 ⇔ NSV > 0（论文 Axiom V）。 */
export function propensity(nsv: number): number {
  return 1 / (1 + Math.exp(-nsv / WAKE_TEMPERATURE));
}

export function rankIntentions(
  world: World,
  affordances: readonly WillAffordance[],
  now: number,
  policy: WillPolicy = BARE_WILL,
): Intention[] {
  const all = Object.keys(world.chats).flatMap((scope) =>
    intentionsFor(world, affordances, scope, now, policy),
  );
  return all.sort((a, b) => b.nsv - a.nsv);
}

/**
 * 全局读数（忠实度对照与监控）：各驱动总量、API = Σ tanh(P_k/κ_k)（论文 Eq api，固定 κ），
 * API_peak = Σ tanh(max_h P_k(h)/κ_k)（ADR-195：节律应由强度量驱动，不由总量驱动），
 * 以及焦点集式的全局声部（2 月 voices/focus.ts：每个声部取相关度最高的 K 个会话求均值）。
 */
export interface GlobalReading {
  totals: Drives;
  api: number;
  apiPeak: number;
  /** 只算外部需求（别人的未读、点名她的义务、没接的话）的 API_peak：节律由它决定。 */
  demandPeak: number;
  voices: Record<Voice, number>;
  voice: Voice;
}

export function globalReading(
  world: World,
  now: number,
  tiers?: TierLookup,
  age?: Age,
  on?: DriveTerms,
): GlobalReading {
  const readings = Object.keys(world.chats)
    .map((s) => readChat(world, s, now, tiers, age, on))
    .filter((r): r is ChatReading => r !== null);
  const totals = driveRecord(() => 0);
  const peak = driveRecord(() => 0);
  for (const r of readings) {
    for (const k of DRIVES) {
      if (k === "curiosity") continue;
      totals[k] += r.raw[k];
      peak[k] = Math.max(peak[k], r.raw[k]);
    }
  }
  totals.curiosity = peak.curiosity = curiosityDeficit(world, now);
  const api = (d: Drives) =>
    DRIVES.reduce((a, k) => a + Math.tanh(d[k] / DRIVE_SPEC[k].globalKappa), 0);
  const curiosity = Math.tanh(totals.curiosity / CURIOSITY_ETA);
  const k = Math.max(2, Math.min(5, Math.ceil(readings.length / 3)));
  const relevance = Object.fromEntries(
    VOICES.map((voice) => {
      const top = readings
        .map((r) => {
          const seen = world.chats[r.scope]?.seen ?? 0;
          return voiceRelevance(
            r.normalized,
            r.raw,
            curiosity,
            Math.exp(-seen / UNCERTAINTY_COUNT),
          )[voice];
        })
        .sort((a, b) => b - a)
        .slice(0, k);
      return [voice, top.length > 0 ? top.reduce((a, b) => a + b, 0) / top.length : 0];
    }),
  ) as Record<Voice, number>;
  const voices = voiceSoftmax(relevance);
  const demandPeak = DEMAND_DRIVES.reduce(
    (a, d) => a + Math.tanh(peak[d] / DRIVE_SPEC[d].globalKappa),
    0,
  );
  return {
    totals,
    api: api(totals),
    apiPeak: api(peak),
    demandPeak,
    voices,
    voice: argmaxVoice(voices),
  };
}
