/**
 * 压力场的一样东西（作息、生活、记忆、日记、对人的了解、够得着的地方……）：它在压力场里能做的全部。
 * createPressure 只把几样组合起来（index.ts），不为任何一样写分支；组别就是不同的组合。
 * 每一样只经下面这些接口进来：折叠世界、往提示词里放事实、给她心里的能力、请求想一想，
 * 以及意愿层的那几项（变旧的时钟、代价、期望缓解的折扣、"她还在这段对话里"）。
 * 每一样还声明它独自写世界的哪几块、读哪几块（mind/compose.ts）；用 feature() 定义时，
 * 它的各个接口只看得见声明过的块，读别的块是类型错误。
 */
import type { ActKind } from "../../mind/affordances.js";
import type { Coeffects } from "../../mind/compose.js";
import type { LogItem } from "../../mind/effects.js";
import type { AliceEvent } from "../../mind/events.js";
import type { Contribution, Opening, PonderAsk } from "../../mind/mechanism.js";
import type { AliceState, ChatState } from "../../mind/state.js";
import type { WillAffordance } from "./affordances.js";
import type { Cause } from "./cause-lines.js";
import type { Age } from "./drives.js";
import type { ChatReading } from "./will.js";
import type { ChatNode, World } from "./world.js";

/** 每个会话里只归一样东西管的字段（chats.<字段>）。 */
export type ChatSlice =
  | "chats.commitments"
  | "chats.topics"
  | "chats.place"
  | "chats.turn.topic"
  | "chats.turn.bond"
  | "chats.turn.leftAt"
  | "chats.turn.dwell"
  | "chats.turn.watch"
  | "chats.turn.rejection";

/** 世界里的一块：World 的一个顶层字段，或一个会话字段。 */
export type Slice = keyof World | ChatSlice;

/**
 * 声明了这些块的那一样看得见的世界：只有这些顶层字段。声明了会话字段就看得见 chats；
 * 会话字段本身的读写类型管不到，由 test/slices.test.ts 的写入审计查。
 */
export type View<K extends Slice> = Pick<
  World,
  Extract<K, keyof World> | ([Extract<K, ChatSlice>] extends [never] ? never : "chats")
>;

/** 往提示词里放东西时她此刻的处境（由组合算好，每一样都看同一份）。 */
export interface FeatureContext<W = World> {
  /** 她眼里的世界（够得着的地方按"这个会话已经在了"算）。 */
  world: W;
  chat: ChatState;
  now: number;
  /** 有人在等她，或她还在这段对话里（不是"没人找你"）。 */
  sought: boolean;
  /** 她在一个还没加入的地方（只看过预览）：只有标了 outside 的几样在这里说话。 */
  outside: boolean;
  /** 这一轮提示词里给她的动作（所有机制一起算出来的；能力事实按它写）。 */
  offered: readonly ActKind[];
  /** 这一次是什么叫醒她（why.ts）；只有组成里有一样要它（causes）时才算，否则没有。 */
  causes?: readonly Cause[];
}

/** 意愿层里的一项（都可以没有；组合时时钟取第一个，代价相加，折扣相乘，"还在对话里"取或）。 */
export interface WillTerms<W = World> {
  /** 她没看到的事按哪个时钟变旧。 */
  age: Age;
  /** 排序时的世界（够得着、还不存在的会话也算进来）。 */
  candidates(world: W): W;
  /**
   * 节律到点时这个会话在不在她眼前（候选 phone：手机放着时只看得到有人在等她的会话）。只管节律那条路：
   * 被点名、在对话里被别人的话叫醒不经过它。几样都给时取且。
   */
  visible(world: W, scope: string, now: number): boolean;
  /** 期望缓解的折扣（此刻找人有多大机会被接住）。 */
  gain(world: W, reading: ChatReading, now: number): number;
  /** 只乘内在的劲（想分享、想某人、自己的事、好奇）的倍数，不影响义务与回避（ADR-276 环节二）。 */
  intrinsicGain(world: W, reading: ChatReading, now: number): number;
  /** 她还在这段对话里：和有人接她的话一样算轮到她，不收主动开口的冷却。 */
  continuing(chat: ChatNode, now: number): boolean;
  /** 社交代价里多加的一项（乘 λ）。 */
  cost(world: W, chat: ChatNode, affordance: WillAffordance, now: number): number;
  /** 基础社交代价（imposition）的乘法折扣（如注意力公平照顾安静私聊），组合时相乘，默认 1。 */
  impositionScale(world: W, chat: ChatNode, affordance: WillAffordance, now: number): number;
  /** NSV 上直接减的代价（不乘 λ：手上正在做的事；ctx 提供是否被点名或正在对话里）。 */
  busy(world: W, now: number, ctx?: { obliged: boolean; continuing: boolean }): number;
  /**
   * 接近类动作的回避代价读哪个数（已归一，直接乘代价权重；叫她别回的那几笔可以超过 1）；null 或没有这一项时
   * 读会话的回避。按人记的回避（relation.ts）让冲着人的动作读那个人的。waker：叫醒她的那条消息是谁发的
   * （节律到点时没有）。
   */
  aversion?(
    world: W,
    scope: string,
    affordance: WillAffordance,
    now: number,
    waker?: string | null,
  ): number | null;
}

export interface PressureFeature<W = World> extends Coeffects<Slice> {
  /** 组合的名字由各样的名字拼成。 */
  name: string;
  /** 她心里的（或要有人提供的对外）能力。 */
  affordances?: readonly ActKind[];
  /** 这个会话里给不给这项能力（灰度、要有可转的东西）；不写就是都给。 */
  offers?(kind: ActKind, scope: string, world: W, now: number): boolean;
  /** 世界折叠之前（还不存在的会话在用的时候建出来）。 */
  open?(world: W, event: AliceEvent): W;
  /** 世界折叠之后；before 是这个事件之前的世界。 */
  reduce?(before: W, after: W, event: AliceEvent): W;
  /** 给提示词和可用能力看的世界（还不存在的会话按已经在了算）。 */
  view?(world: W, scope: string): W;
  /** 她不在这个会话里（只看过预览）。 */
  away?(world: W, chat: ChatState, now: number): boolean;
  /** 在她不在里面的地方也说话。 */
  outside?: true;
  /** 要组合算出叫醒她的原因（why.ts）交给提示词：有一样要，就给每一样的 contribute 带上 causes。 */
  causes?: true;
  contribute?(ctx: FeatureContext<W>): Contribution[];
  /** 记录怎么排（Mechanism.layout）：trigger 是叫醒她的那条；组成里只有一样给它。 */
  layout?(ctx: FeatureContext<W>, trigger: string | null): LogItem[] | null;
  /** 时钟格上这个会话有到点的事（她给自己定的闹钟）：直接叫醒。 */
  alarm?(world: W, scope: string, now: number): boolean;
  /** 别人没点她名的话也叫醒她再看一眼（她还在这段对话里），提示词里也不是"没人找你"。 */
  listens?(chat: ChatNode, now: number): boolean;
  /**
   * 别人没点她名的话也叫醒她再看一眼，但她是旁观者（看着这段对话、还没开口）：提示词里照旧是"没人找你"。
   * watchGate：对话在她眼前时（旁观，或在对话里的 listens）别人的话叫不叫醒她按什么算。will 按这个会话最好的
   * 意愿 NSV > 0；look 不收对别人的代价（C_social 属于动作本身，看一眼不打扰谁），只看缓解减去她自己的状态
   * （睡着、手上有事）和饱和代价。look-watch 只对旁观用 look，在对话里照旧按 will；look-dwell 只对在对话里用
   * look（候选 dwell-look）。没有哪一样给它时是 will。
   */
  watches?(chat: ChatNode, now: number): boolean;
  watchGate?: "will" | "look" | "look-watch" | "look-dwell";
  /**
   * 在对话里（listens）时提示词照旧写"没人找你"：她看得到每一条，但那些话不是冲着她说的（被点名、回复她的照旧
   * 是有人找她）。叫醒、λ、冷却不变。
   */
  readerInside?: boolean;
  /** 单独想一想；多样都要时第一个说要的那个。 */
  ponder?(world: W, chats: AliceState["chats"], now: number): PonderAsk | null;
  /** 在要想的那一件上顺手多问点什么。 */
  refine?(ask: PonderAsk, world: W, now: number): PonderAsk;
  /** 她此刻想去、但还没有会话的地方。 */
  opens?(world: W, scope: string): Opening | null;
  /** 她此刻在看手机，一眼扫过各个会话（mind/mechanism.ts scans）；有一样说是就是。 */
  scans?(world: W, now: number): boolean;
  /** 她此刻是不是正在睡觉（sleep、bedtime、lifeBody 各自回答自己的睡眠模型）。 */
  asleep?(world: W, now: number): boolean;
  /** PTC 沙箱按需查询（如 recall）：纯只读返回 JSON 结果，不改状态。 */
  query?(
    kind: string,
    args: Readonly<Record<string, unknown>>,
    chat: ChatState,
    now: number,
    world: W,
  ): unknown;
  will?: Partial<WillTerms<W>>;
  /** 节律到点时看一眼也参加排序（glance.ts）；组成里只有一样给它。 */
  glance?: GlanceTerms;
}

/** 看一眼那一样给意愿层的：节律路径上，哪些要斟酌的动作还能叫醒她。 */
export interface GlanceTerms {
  wakes(row: WillAffordance): boolean;
}

/**
 * 定义压力场的一样东西：provides 是只有它写的块，requires 是它读、少了不能工作的块，uses 是有就读的块，
 * amends 是它也写、但归别人提供的块（要合并的地方）。各个接口只看得见这几块。
 */
export function feature<
  const P extends Slice = never,
  const R extends Slice = never,
  const U extends Slice = never,
  const A extends Slice = never,
>(
  f: PressureFeature<View<P | R | U | A>> & {
    provides?: readonly P[];
    requires?: readonly R[];
    uses?: readonly U[];
    amends?: readonly A[];
  },
): PressureFeature {
  return f as unknown as PressureFeature;
}
