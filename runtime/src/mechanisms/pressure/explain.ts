/**
 * 意愿层的读数（事后分析 sim/trace.ts、线上快照 src/trace-log.ts）：此刻在所有（会话 × 动作）上的排序，每个候选
 * 拆成各驱动的原值、归一化值与缓解，社交代价、saturation cost，各样东西加进社交代价的部分（困意）和直接占用（生活），
 * 她在不在这段对话里；以及节律门、心情效价与精力。只读，调的就是意愿层自己的函数（rankIntentions、readChat、
 * reliefTerms、rhythmAt、willOf），所以读数就是那一刻意愿层算出来的数。纯函数：时刻由调用方给。
 */
import { affordances as registry } from "../../mind/affordances.js";
import type { ChatType } from "../../mind/events.js";
import type { AliceState } from "../../mind/state.js";
import { valenceAt } from "./affect.js";
import type { DriveKey } from "./drives.js";
import { INTRINSIC_DRIVES, splitRelief } from "./feedback.js";
import {
  PRODUCTION,
  type PressureFeatures,
  pressureProduction,
  rhythmAt,
  willWake,
} from "./index.js";
import { OBLIGATION_THETA } from "./params.js";
import { alertness, isAsleep } from "./sleep.js";
import {
  type ChatReading,
  type Intention,
  readChat,
  reliefTerms,
  type SaturationCost,
} from "./will.js";
import { type ChatNode, emptyWorld, type World } from "./world.js";

interface DriveReading {
  /** 原值 P_k。 */
  raw: number;
  /** 归一化 τ̂_k（已乘 habituation，义务与回避豁免）。 */
  norm: number;
  /** 这个动作对它的期望缓解（乘折扣之前）。 */
  relief: number;
}

export interface Candidate {
  scope: string;
  chatType: ChatType;
  act: string;
  voice: string;
  nsv: number;
  /** Σ 缓解 × 折扣。 */
  relief: number;
  /** 期望缓解的折扣（此刻找人有多大机会被接住；生产里没有这一项时为 1）。 */
  gain: number;
  lambda: number;
  /** 社交代价（含 costs 里各样东西加的那部分），乘 λ。 */
  social: number;
  /** 社交代价里由压力场的各样东西加的（作息的困意），按格子名；已含在 social 里。 */
  costs: Record<string, number>;
  saturation: SaturationCost;
  /** NSV 上直接减的代价（手上正在做的事），按格子名。 */
  busy: Record<string, number>;
  /** 她还在这段对话里（在场：算轮到她，不收主动开口的冷却）。 */
  present: boolean;
  member: boolean;
  /** 原值或缓解不为 0 的驱动。 */
  drives: Partial<Record<DriveKey, DriveReading>>;
}

export interface WillReadout {
  rhythm: ReturnType<typeof rhythmAt>;
  /** 一共几个候选、其中 NSV > 0 的几个。 */
  count: number;
  positive: number;
  /** 排第一的几个（NSV 从高到低）。 */
  top: Candidate[];
  /** 她的心情效价（DynAffect，[−1, 1]）。 */
  valence: number;
  /** 精力：作息的警觉度加上生活的起伏（life.ts 写"有点累"用的同一个数）。 */
  energy: number;
  /** 想不想说话（标准分）。 */
  social: number;
  /** 手上正在做的事。 */
  doing: string | null;
  asleep: boolean;
}

/**
 * 一种组成的意愿层（和 createPressure 用同一个工厂 willWake 造出来）：读法、排序的 affordance、叫醒她的理由；
 * composition 用来把代价按格子拆开。
 */
export type WillLens = ReturnType<typeof willWake> & { composition: PressureFeatures };

export function lensOf(composition: PressureFeatures = PRODUCTION, lambda0?: number): WillLens {
  return { ...willWake(registry, composition, lambda0), composition };
}

/** 生产压力场在核心状态里的那份世界（按机制名存放；还没有事件时是空世界）。 */
export function productionWorld(state: AliceState): World {
  return (state.mechanisms[pressureProduction.name] as World | undefined) ?? emptyWorld;
}

/** 意愿层此刻的全部排序（和节律到点时 createPressure 排的是同一个）。 */
function ranking(world: World, now: number, lens: WillLens): Intention[] {
  return lens.rank(world, now);
}

/** 把一个意愿拆开：各驱动、各项代价。 */
export function candidateOf(
  world: World,
  intention: Intention,
  now: number,
  lens: WillLens,
  readings: Map<string, ChatReading | null> = new Map(),
): Candidate {
  const { policy, composition } = lens;
  const w = policy.candidates(world);
  const chat = w.chats[intention.scope] as ChatNode;
  if (!readings.has(intention.scope)) {
    readings.set(
      intention.scope,
      readChat(w, intention.scope, now, policy.tiers, policy.age, policy.drives),
    );
  }
  const reading = readings.get(intention.scope) as ChatReading;
  const row = lens.affordances.find((a) => a.kind === intention.affordance);
  if (!row) throw new Error(`not a will affordance: ${intention.affordance}`);
  const intrinsic = policy.intrinsicGain?.(w, reading, now) ?? 1;
  const split = splitRelief(reliefTerms(chat, reading, row, now), INTRINSIC_DRIVES, intrinsic);
  const drives: Candidate["drives"] = {};
  for (const [k, relief] of split.terms) {
    const raw = reading.raw[k];
    if (raw !== 0 || relief !== 0) drives[k] = { raw, norm: reading.normalized[k], relief };
  }
  const obliged = reading.obligation > OBLIGATION_THETA;
  const continuing = policy.continuing(chat, now);
  const costs: Record<string, number> = {};
  const busy: Record<string, number> = {};
  for (const [slot, f] of Object.entries(composition)) {
    if (f?.will?.cost) costs[slot] = f.will.cost(w, chat, row, now);
    if (f?.will?.busy) busy[slot] = f.will.busy(w, now, { obliged, continuing });
  }
  return {
    scope: intention.scope,
    chatType: intention.chatType,
    act: intention.affordance,
    voice: intention.voice,
    nsv: intention.nsv,
    relief: intention.relief,
    gain: policy.gain(w, reading, now),
    lambda: intention.lambda,
    social: intention.socialCost,
    costs,
    saturation: intention.saturation,
    busy,
    present: policy.continuing(chat, now),
    member: chat.member,
    drives,
  };
}

/** 此刻的读数：节律门、前 top 名候选、心情与精力。 */
export function readWill(world: World, now: number, lens: WillLens, top = 3): WillReadout {
  const ranked = ranking(world, now, lens);
  const readings = new Map<string, ChatReading | null>();
  const doing = world.life.doing;
  return {
    rhythm: rhythmAt(world, now, lens.policy),
    count: ranked.length,
    positive: ranked.filter((i) => i.nsv > 0).length,
    top: ranked.slice(0, top).map((i) => candidateOf(world, i, now, lens, readings)),
    valence: valenceAt(world.affect, now),
    energy: alertness(now) + world.life.energy,
    social: world.life.social,
    doing: doing && now >= doing.from && now < doing.until ? doing.kind : null,
    asleep: isAsleep(now),
  };
}
