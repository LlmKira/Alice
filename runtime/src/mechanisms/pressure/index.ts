import { type ActKind, affordances } from "../../mind/affordances.js";
import { type Composition, compose, type Part } from "../../mind/compose.js";
import type { AliceEvent } from "../../mind/events.js";
import { type Contribution, defineMechanism, type Mechanism } from "../../mind/mechanism.js";
import type { ChatState } from "../../mind/state.js";
import { elapsed } from "../../mind/when.js";
import { withMissed } from "../missed.js";
import { affect } from "./affect.js";
import type { WillAffordance } from "./affordances.js";
import { awake } from "./availability.js";
import { createBedtime } from "./bedtime.js";
import { contextWith } from "./context.js";
import { createDesire, desire } from "./desire.js";
import { febDiary, reflectDiary } from "./diary.js";
import { DRIVE_TERMS, type DriveTerms, wallClock } from "./drives.js";
import { delegatedFairness } from "./fairness.js";
import { feature, type PressureFeature, type Slice, type WillTerms } from "./feature.js";
import { positiveLoop } from "./feedback.js";
import { glance } from "./glance.js";
import { isGroupAttentionWorthy } from "./group-filter.js";
import { groupPull } from "./group-pull.js";
import { body, echo, echoExpanded, thought } from "./inner.js";
import { life } from "./life.js";
import { createLifeBody, lifeBody } from "./life-body.js";
import { FAILURE_BACKOFF, LAMBDA0, RHYTHM } from "./params.js";
import { PEOPLE_ALL, people } from "./people.js";
import { phone } from "./phone.js";
import { reach } from "./reach.js";
import { memory, recallTools, topics } from "./recall.js";
import {
  createRelation,
  familiarityTier,
  relation,
  relationTier,
  relationView,
} from "./relation.js";
import { sleep } from "./sleep.js";
import { bondTurn, dwell, floor, floorWake, follow, topicTurn } from "./turn.js";
import { causesOf } from "./why.js";
import {
  globalReading,
  type Intention,
  intentionsFor,
  propensity,
  rankIntentions,
  type WillPolicy,
} from "./will.js";
import { emptyWorld, isSolicited, reduceWorld, type World } from "./world.js";

export type { WillAffordance } from "./affordances.js";
export type { PressureFeature } from "./feature.js";
export {
  globalReading,
  type Intention,
  intentionsFor,
  propensity,
  rankIntentions,
  readChat,
} from "./will.js";
export { emptyWorld, reduceWorld, type World } from "./world.js";
export {
  affect,
  awake,
  body,
  createDesire,
  desire,
  createBedtime,
  echo,
  echoExpanded,
  febDiary,
  floor,
  floorWake,
  delegatedFairness,
  groupPull,
  lifeBody,
  createLifeBody,
  positiveLoop,
  life,
  memory,
  people,
  reach,
};
export { reflectDiary };
export { sleep, thought, topics, topicTurn, bondTurn, recallTools };
export {
  createRelation,
  dwell,
  familiarityTier,
  follow,
  glance,
  phone,
  relation,
  relationTier,
  relationView,
};

/**
 * 主动开口（没人找她、她也没在做一件事）时的此刻：让模型知道这次是她自己想来。是压力场自己的那一行，
 * 排在够得着的地方的事实之后、作息之前。不说话（不调用 run_code）由回合锚点的最后一行说，这一句只说处境
 * （context-v2，out.md 风险 1）。
 */
const proactive = feature({
  name: "proactive",
  requires: ["chats"],
  contribute: ({ world, chat, now, sought, causes }): Contribution[] => {
    // 她正在做一件事（刚翻完相册、查完东西，结果比记录里最后一条还新）：不是"没人找你、你自己想来"。
    const midTask = (chat.looked?.at(-1)?.at ?? -1) >= (chat.timeline.at(-1)?.at ?? 0);
    const c = world.chats[chat.scope];
    if (sought || midTask || !c) return [];
    const last = Math.max(c.lastIncomingAt, c.lastAliceAt);
    const before = last > 0 ? `你们上次说话是 ${elapsed(now - last)}前。` : "";
    // 候选 desire（组成里有一样要原因，causes 不为空）：叫醒她的原因写在卡片上，这一句只说没有视角的事实
    // （Gemini 按 ADR-194、210 重写，out-feelings-v2.md）。
    const text =
      chat.chatType === "group"
        ? causes
          ? "没人点名；大家在自己聊。"
          : "这会儿没人点你，大家在自己聊，你在旁边看着；有想插嘴的就说一句。"
        : causes
          ? `${before}这会儿没人找你。`
          : `${before}这会儿没人找你，想找对方聊点什么就说。`;
    // 名字固定：回放的桩按它认"这次没人找她"（sim/will-replay.ts rate-sought），不看文字。
    return [
      {
        mechanism: "pressure-unsought",
        kind: "turn",
        text,
        unsought: true as const,
      },
    ];
  },
});

/**
 * 世界折叠（world.ts reduceWorld）：总在的底座，写会话的核心字段和意愿层自己的结局（willingness：想过、决定先不找他）。
 * 关于人的事实（名字、看见的、有往来、亲近、回避）只由 relation 折进 relations。答应的事（chats.commitments）只由
 * 记忆（recall.ts memory）折：到期、到时了、响过了都跟着同一条事件，世界折叠不再写它。
 */
export const WORLD_FOLD: Part<Slice> = {
  name: "world",
  provides: [
    "chats",
    "willingness",
    "novelty",
    "noveltyAt",
    "firstAt",
    "turns",
    "lastCallAt",
    "said",
    "callFailures",
  ],
};

/**
 * 压力场的组成：每一格放一样东西（feature.ts），空着就是没有。格子的次序就是折叠、提示词、想一想的次序
 * （够得着的地方先建出会话；提示词里够得着的地方的事实在前，主动开口的那一行接着，作息、生活在"轮到你了"
 * 之前；在场这几样要在其余折叠之后读世界）。
 */
const SLOTS = [
  "reach",
  "fairness",
  "proactive",
  "awake",
  "sleep",
  "diary",
  "life",
  "desire",
  "thought",
  "body",
  "echo",
  "memory",
  "topics",
  "recallTools",
  "people",
  "feedback",
  "affect",
  "topic",
  "bond",
  "floor",
  "glance",
  "follow",
  "relation",
  "context",
  "phone",
] as const;
type Slot = Exclude<(typeof SLOTS)[number], "proactive">;
export type PressureFeatures = Partial<Record<Slot, PressureFeature>>;

/**
 * 一种组成解析出来的样子（mind/compose.ts）：底座是世界折叠，部分是格子里的几样，加上意愿层里读某一样的块的
 * 驱动项（drives.ts DRIVE_TERMS）。两样提供同一块时在这里报错；缺块的不激活，列在 inactive 里。
 */
export function partsOf(composition: PressureFeatures): Composition<Part<Slice>, Slice> {
  return compose<Slice, Part<Slice>>(WORLD_FOLD, [...slotted(composition), ...DRIVE_TERMS]);
}

/** 组成里放了的几样，按格子的次序（主动开口那一行在它的位置上）。 */
function slotted(composition: PressureFeatures): PressureFeature[] {
  return SLOTS.flatMap((s) => {
    const f = s === "proactive" ? proactive : composition[s];
    return f ? [f] : [];
  });
}

/** 意愿层里这些驱动项此刻算不算（它读的块有提供者才算）。 */
function drivesOf(composition: PressureFeatures): DriveTerms {
  const on = new Set(partsOf(composition).active.map((p) => p.name));
  return Object.fromEntries(DRIVE_TERMS.map((t) => [t.term, on.has(t.name)])) as DriveTerms;
}

/** 把几样东西的意愿项合成意愿层的读法（时钟取第一个，代价相加，折扣相乘，"还在对话里"取或）。 */
export function willOf(features: PressureFeatures, lambda0 = LAMBDA0): WillPolicy {
  const ordered = featuresOf(features);
  const terms = ordered.flatMap((f) => (f.will ? [f.will] : []));
  const all = <K extends keyof WillTerms>(k: K) =>
    terms.flatMap((t) => (t[k] ? [t[k] as WillTerms[K]] : []));
  const candidates = all("candidates");
  const visible = all("visible");
  const gains = all("gain");
  const intrinsicGains = all("intrinsicGain");
  const continuing = all("continuing");
  const costs = all("cost");
  const impositionScales = all("impositionScale");
  const busy = all("busy");
  const aversion = all("aversion")[0];
  return {
    ...(aversion ? { aversion } : {}),
    lambda0,
    age: all("age")[0] ?? wallClock,
    candidates: (world) => candidates.reduce((w, f) => f(w), world),
    visible: (world, scope, now) => visible.every((f) => f(world, scope, now)),
    gain: (world, reading, now) => gains.reduce((g, f) => g * f(world, reading, now), 1),
    intrinsicGain: (world, reading, now) =>
      intrinsicGains.reduce((g, f) => g * f(world, reading, now), 1),
    continuing: (chat, now) => continuing.some((f) => f(chat, now)),
    cost: (world, chat, a, now) => costs.reduce((s, f) => s + f(world, chat, a, now), 0),
    impositionScale: (world, chat, a, now) =>
      impositionScales.reduce((m, f) => m * f(world, chat, a, now), 1),
    busy: (world, now, ctx) => busy.reduce((s, f) => s + f(world, now, ctx), 0),
    provided: (scope, world, now) => new Set(offeredIn(ordered, scope, world, now)),
    drives: drivesOf(features),
    effortReciprocity: true,
  };
}

/** 组成里激活的几样，按格子的次序（主动开口那一行在它的位置上）。 */
function featuresOf(composition: PressureFeatures): PressureFeature[] {
  const terms = new Set<Part<Slice>>(DRIVE_TERMS);
  return partsOf(composition).active.filter((p) => !terms.has(p)) as PressureFeature[];
}

/**
 * 一个事件进来，这几样和世界折叠依次改世界：先各样的 open（还不存在的会话建出来），再世界折叠，再各样的
 * reduce（before 是这个事件之前的世界）。watch 只给 test/slices.test.ts 的写入审计用。
 */
function foldWith(
  features: readonly PressureFeature[],
  watch?: (part: string, before: World, after: World) => void,
) {
  return (world: World, event: AliceEvent): World => {
    let w = world;
    for (const f of features) {
      if (!f.open) continue;
      const next = f.open(w, event);
      watch?.(f.name, w, next);
      w = next;
    }
    const folded = reduceWorld(w, event);
    watch?.(WORLD_FOLD.name, w, folded);
    w = folded;
    for (const f of features) {
      if (!f.reduce) continue;
      const next = f.reduce(world, w, event);
      watch?.(f.name, w, next);
      w = next;
    }
    return w;
  };
}

/** 一种组成的世界折叠（世界折叠加这几样的 reduce），给只读意愿层的性质测试用。 */
export function worldFold(
  composition: PressureFeatures,
): (world: World, event: AliceEvent) => World {
  return foldWith(featuresOf(composition));
}

/** 一个压力场机制的世界折叠，每一步交给 watch 看（写入审计）。 */
export function auditedFold(
  m: Mechanism,
  watch: (part: string, before: World, after: World) => void,
) {
  const parts = resolved.get(m);
  if (!parts) throw new Error(`${m.name} is not a pressure field`);
  const terms = new Set<Part<Slice>>(DRIVE_TERMS);
  return foldWith(parts.active.filter((p) => !terms.has(p)) as PressureFeature[], watch);
}

/** 她眼里的世界：还不存在的会话按已经在了算。 */
function viewOf(features: readonly PressureFeature[], world: World, scope: string): World {
  return features.reduce((w, f) => (f.view ? f.view(w, scope) : w), world);
}

/** 这个会话里这几样实际给她的能力（灰度、要有可转的东西）：发言提示和意愿层读同一个。 */
function offeredIn(
  features: readonly PressureFeature[],
  scope: string,
  world: World,
  now: number,
): ActKind[] {
  const seen = viewOf(features, world, scope);
  return features
    .flatMap((f) => f.affordances ?? [])
    .filter((k) => features.every((f) => f.offers?.(k, scope, seen, now) ?? true));
}

/**
 * 意愿层排序的可供性：只为需要斟酌、又真能缓解点什么的意愿叫醒模型。只标已读不值得一次调用，什么驱动都不缓解的行
 * （翻相册、查一下、发语音这类在她醒着时自己选的事）不是意愿。
 */
export function willAffordances(all: readonly WillAffordance[]): WillAffordance[] {
  return all.filter((a) => a.deliberate && Object.keys(a.relieves).length > 0);
}

/** 节律门此刻开没开：Δt、离上次调用多久、失败退避（sim/trace.ts 读同一个）。 */
export interface Rhythm {
  dt: number;
  since: number;
  backoff: number;
  open: boolean;
}

/**
 * 节律（ADR-195）：离上一次调用（决定或失败）还不到 Δt 就不行动。Δt 由外部需求的强度量决定：外面越热闹
 * 间隔越短，安静时拉长到 5 分钟——调用频率随外部需求自己调节，不设上限。发言调用连续失败时另按退避等。
 */
export function rhythmAt(world: World, now: number, policy: WillPolicy): Rhythm {
  const dt =
    RHYTHM.min +
    (RHYTHM.max - RHYTHM.min) *
      Math.exp(
        -globalReading(world, now, undefined, policy.age, policy.drives).demandPeak / RHYTHM.kappa,
      );
  const { count, at } = world.callFailures;
  const backoff =
    count > 0 ? Math.min(FAILURE_BACKOFF.max, FAILURE_BACKOFF.first * 2 ** (count - 1)) : 0;
  const since = now - world.lastCallAt;
  return { dt, since, backoff, open: since >= dt && now - at >= backoff };
}

/**
 * 压力场叫醒她的理由（唤醒分数只从它算，sim/trace.ts 读同一个，所以事后读到的理由就是当时的理由）：
 * - alarm：她给自己定的、说了钟点的事到点了（时钟格上，只响一次，做不做由她定）；
 * - will：时钟格上节律到点，跨所有会话排第一的意愿在这里（NSV > 0）；
 * - directed：有人点她的名（外部义务），按这个会话里最好的意愿；
 * - floor：她还在这段对话里，别人接着说的话让她按这个会话最好的意愿再看一眼。
 * - follow（候选 follow，turn.ts）：她看着这段对话、还没开口，别人的话同样让她再看一眼（她是旁观者）。
 * 后三种的 score 是 logistic(NSV/τ)，到 0.5 才醒；没有候选时 intention 为 null、score 为 0。
 * glance（候选 glance.ts）：节律到点，排第一的是看一眼——不叫醒她（score 0），核心直接看一眼。
 */
export type WakeReason =
  | { kind: "alarm" }
  | { kind: "will" | "glance"; intention: Intention }
  | { kind: "directed" | "floor" | "follow"; intention: Intention | null; score: number };

export function wakeScore(reason: WakeReason | null): number {
  if (!reason) return 0;
  switch (reason.kind) {
    case "glance":
      return 0;
    case "alarm":
    case "will":
      return 1;
    default:
      return reason.score;
  }
}

/**
 * 一种组成的意愿层：读法、排序的可供性、节律到点时排第一的意愿，和每个事件上叫醒她的理由。
 * createPressure 用它决定唤醒；事后分析（sim/trace.ts）用同一个工厂重算，不另写一份判断。
 */
export function willWake(
  all: readonly WillAffordance[],
  composition: PressureFeatures = {},
  lambda0?: number,
) {
  const features = featuresOf(composition);
  const policy = willOf(composition, lambda0);
  const affordances = willAffordances(all);
  const listens = (world: World, scope: string, now: number) => {
    const c = world.chats[scope];
    return !!c && features.some((f) => f.listens?.(c, now) ?? false);
  };
  /** 她看着这段对话、还没开口（turn.ts follow）：别人的话也叫醒她，但她是旁观者。 */
  const watches = (world: World, scope: string, now: number) => {
    const c = world.chats[scope];
    return !!c && features.some((f) => f.watches?.(c, now) ?? false);
  };
  /**
   * 看着的时候再看一眼值不值（feature.ts watchGate look）：不收对别人的打扰（看一眼不打扰谁，C_social 属于动作，
   * 醒来后的那次决定里她自己掂量），她自己的状态（睡着、回避、手上有事）和饱和代价照算。
   */
  const gate = features.find((f) => f.watchGate)?.watchGate ?? "will";
  const lookValue = (i: Intention) => i.nsv + i.lambda * i.imposition;
  // 看一眼（glance.ts）：节律到点时不用斟酌、能缓解点什么的行（标已读）也排序，要斟酌的只留还能叫醒她的。
  const look = features.find((f) => f.glance)?.glance;
  const rhythm = look
    ? all.filter((a) => Object.keys(a.relieves).length > 0 && (!a.deliberate || look.wakes(a)))
    : affordances;
  const reflex = new Set(rhythm.filter((a) => !a.deliberate).map((a) => a.kind));
  /** 节律到点时的全部排序（explain.ts 读同一个）。有人在等她、她在这段对话里的会话不看一眼：那要斟酌。 */
  const rank = (world: World, now: number): Intention[] => {
    const w = policy.candidates(world);
    const all = rankIntentions(w, rhythm, now, policy).filter((i) =>
      policy.visible(w, i.scope, now),
    );
    if (reflex.size === 0) return all;
    return all.filter((i) => {
      if (!reflex.has(i.affordance as ActKind)) return true;
      const c = w.chats[i.scope];
      return !!c && !isSolicited(c, now) && !listens(w, i.scope, now);
    });
  };

  /** 一个 tick 会对每个会话问一遍 wake：同一状态、同一时刻只排一次序。只依赖输入，不影响确定性。 */
  const ranked = new WeakMap<World, { now: number; top: Intention | undefined }>();
  const top = (world: World, now: number): Intention | undefined => {
    const hit = ranked.get(world);
    if (hit && hit.now === now) return hit.top;
    const first = rhythmAt(world, now, policy).open ? rank(world, now)[0] : undefined;
    const best = first && first.nsv > 0 ? first : undefined;
    ranked.set(world, { now, top: best });
    return best;
  };

  const why = (scope: string, event: AliceEvent, now: number, world: World): WakeReason | null => {
    if (event.type === "clock.tick") {
      if (features.some((f) => f.alarm?.(world, scope, now))) return { kind: "alarm" };
      const t = top(world, now);
      if (t?.scope !== scope) return null;
      return {
        kind: reflex.has(t.affordance as ActKind) ? "glance" : "will",
        intention: t,
      };
    }
    // 普通消息只更新压力，行动由节律决定；被点名是外部义务，立刻按义务的意愿响应。
    if (event.type !== "message.received" || event.scope !== scope) return null;
    if (!isGroupAttentionWorthy(event)) return null;
    const inside = listens(world, scope, now);
    if (!event.directed && !inside && !watches(world, scope, now)) return null;
    const kind = event.directed ? "directed" : inside ? "floor" : "follow";
    // 对话在她眼前（旁观或在对话里）时同一个门：她看着就看得到每一条。
    const looks =
      gate === "look"
        ? kind !== "directed"
        : kind === (gate === "look-watch" ? "follow" : gate === "look-dwell" ? "floor" : null);
    const value = looks ? lookValue : (i: Intention) => i.nsv;
    // 按人读的回避读发这条的人（relation.ts personAversion 的 waker）。
    const best = intentionsFor(
      world,
      affordances,
      scope,
      now,
      policy,
      event.senderId,
    ).reduce<Intention | null>((b, i) => (b === null || value(i) > value(b) ? i : b), null);
    return { kind, intention: best, score: best ? propensity(value(best)) : 0 };
  };

  return { policy, affordances, rhythm, rank, top, why, listens, glances: look !== undefined };
}

/** 每个压力场机制解析出来的组成（测试和组别检查读它）。 */
const resolved = new WeakMap<Mechanism, Composition<Part<Slice>, Slice>>();

/** 这个机制是压力场时，它的组成怎么解析的；不是就没有。 */
export function compositionOf(m: Mechanism): Composition<Part<Slice>, Slice> | undefined {
  return resolved.get(m);
}

/**
 * 压力场（论文 §3–4，按 eval-artifacts/trigger/pressure-fidelity.md 的取舍重建）：
 * 世界（world.ts）→ 驱动（drives.ts）→ 意愿（will.ts，读可供性声明）。在 FSM 里只做软引导：
 * - 被点名时：这个会话里最好的意愿 NSV > 0 就醒（沉默公理），具体做什么由模型在会话里决定。
 * - 其余时候按节律：离上次决定满 Δt(API_peak) 后，跨所有会话排序，只叫醒排第一的意愿所在的会话。
 * - 主动开口（没人找她）时，往提示词里放一句事实，让模型知道这次是她自己想来。
 * 不过滤、不改写发言模型的输出。其余全由组成里的几样东西给（feature.ts），这里只把它们组合起来。
 * 名字不给就由各样的名字拼出来（回放组用）；注册表里的几个给固定的名字，晋升一样东西不再改掉生产的名字
 * （能力账本、提示日志、Journal 里机制状态的键都按名字认）。
 */
export function createPressure(
  all: readonly WillAffordance[],
  composition: PressureFeatures = {},
  o: {
    name?: string;
    lambda0?: number;
  } = {},
): Mechanism {
  const parts = partsOf(composition);
  const features = featuresOf(composition);
  // 名字按组成里放了的几样拼（不激活的也算），组别的名字不随解析变。
  const named = slotted(composition)
    .filter((f) => f !== proactive)
    .map((f) => f.name);
  const { top, why, listens, glances, policy, affordances } = willWake(all, composition, o.lambda0);
  const reader = features.some((f) => f.readerInside);
  const provided: ActKind[] = features.flatMap((f) => f.affordances ?? []);
  const view = (world: World, scope: string) => viewOf(features, world, scope);

  const reduce = foldWith(features);
  const ponders = features.filter((f) => f.ponder);
  const opens = features.filter((f) => f.opens);
  const scanners = features.filter((f) => f.scans);
  const sleepers = features.filter((f) => f.asleep);
  const queries = features.filter((f) => f.query);
  const layout = features.find((f) => f.layout)?.layout;
  const wantsCauses = features.some((f) => f.causes);
  const contextOf = (chat: ChatState, now: number, here: World, offered: readonly ActKind[]) => {
    const world = view(here, chat.scope);
    const outside = features.some((f) => f.away?.(world, chat, now) ?? false);
    const c = world.chats[chat.scope];
    const inside = !reader && listens(world, chat.scope, now);
    const sought = !outside && (!c || isSolicited(c, now) || inside);
    const causes =
      wantsCauses && !outside
        ? causesOf(world, affordances, chat.scope, now, policy, sought)
        : undefined;
    return { world, chat, now, sought, outside, offered, ...(causes ? { causes } : {}) };
  };

  const m = defineMechanism<World>({
    name: o.name ?? ["pressure", ...named].join("-"),
    initial: emptyWorld,
    reduce,
    ...(provided.length > 0 ? { affordances: provided } : {}),
    affordancesIn: (scope, world, now) => offeredIn(features, scope, world, now),
    ...(ponders.length > 0
      ? {
          ponder(now, world, chats) {
            for (const f of ponders) {
              const ask = f.ponder?.(world, chats, now);
              if (ask)
                return features.reduce((a, g) => (g.refine ? g.refine(a, world, now) : a), ask);
            }
            return null;
          },
        }
      : {}),
    ...(opens.length > 0
      ? {
          opens(now, world) {
            const t = top(world, now);
            if (!t) return null;
            for (const f of opens) {
              const o = f.opens?.(world, t.scope);
              if (o) return o;
            }
            return null;
          },
        }
      : {}),
    ...(scanners.length > 0
      ? { scans: (now, world) => scanners.some((f) => f.scans?.(world, now) ?? false) }
      : {}),
    ...(sleepers.length > 0
      ? { asleep: (now, world) => sleepers.some((f) => f.asleep?.(world, now) ?? false) }
      : {}),
    wake: (chat, event, now, world) => wakeScore(why(chat.scope, event, now, world)),
    ...(glances
      ? {
          glance: (chat, event, now, world) =>
            why(chat.scope, event, now, world)?.kind === "glance",
        }
      : {}),
    contribute(chat, now, here, offered): Contribution[] {
      const ctx = contextOf(chat, now, here, offered);
      return features.flatMap((f) =>
        ctx.outside && !f.outside ? [] : (f.contribute?.(ctx) ?? []),
      );
    },
    ...(queries.length > 0
      ? {
          query(kind, args, chat, now, here) {
            const world = view(here, chat.scope);
            for (const f of queries) {
              const res = f.query?.(kind, args, chat, now, world);
              if (res !== undefined) return res;
            }
            return undefined;
          },
        }
      : {}),
    ...(layout
      ? { layout: (chat, now, here, trigger) => layout(contextOf(chat, now, here, []), trigger) }
      : {}),
  });
  resolved.set(m, parts);
  return m;
}

/** 生产：registry 与实验回放都从这里派生，不各自抄一份。 */
export const PRODUCTION: PressureFeatures = {
  memory,
  reach,
  fairness: delegatedFairness,
  body: body("parallel"),
  life: withMissed(
    createLifeBody({ busyMode: "phi-half", dailyContent: true, dream: true, phoneWeight: 2 }),
  ),
  floor: dwell({ passBy: true, look: true, share: true, rejection: true }),
  diary: reflectDiary,
  thought: thought({ examples: true, carry: true, composite: true }),
  echo: echoExpanded,
  topics,
  recallTools,
  topic: groupPull,
  people: people(PEOPLE_ALL),
  affect: affect({
    noise: true,
    lonely: true,
    warmth: { home: true, relevance: true, bids: true, tone: true },
    rejection: true,
    feedback: true,
    body: true,
  }),
  feedback: positiveLoop,
  relation: relationTier,
  context: contextWith({ mentions: true }),
  desire: createDesire({ dreamFeed: true, personalUrge: true }),
};

/** 候选 groupturn 的三样信号（话题有关、想接某个人的话、在场）。 */
export const GROUP_TURN: PressureFeatures = { topic: topicTurn, bond: bondTurn, floor };

/** 生产（PRODUCTION，loop-v2 基线）。候选和对照是 sim/will-arms.ts 里的组别。 */
export const pressureProduction = createPressure(affordances, PRODUCTION, {
  name: "pressure-production",
});
