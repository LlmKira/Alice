import type { Act, ActKind } from "./affordances.js";
import { compose } from "./compose.js";
import type { LogItem, PonderRequest } from "./effects.js";
import type { AliceEvent, ChatType } from "./events.js";
import type { AliceState, ChatState } from "./state.js";

/**
 * 机制往提示词里放的一样东西。机制只说它是哪一类，放在哪、写成什么样由发言层（speech/prompt.ts）决定：
 * - reference：参考的回法和示范（带 examples）；
 * - self：她自己的内心记录（日记）；
 * - thought：她刚才心里想过的；
 * - state：她自己这边此刻怎样（在做什么、精力、刚睡醒、她的处境与能做的事、多久没人找、别处来了多少）；
 * - mood：她此刻的心情；
 * - people：在场的人和她知道的关于他们、关于这个群的事；
 * - doings：她答应过的事、最近几次开口的结果；
 * - failed：她刚才想做、没做成的事；
 * - turn：这一轮的处境（没人找她、谁用什么语言、记录最后连着几条是她发的、她还不在这里面）；
 * - scene、moment：其余的背景事实、此刻的事实；
 * - marks：记录里某几条消息自己的事实（表情反应、改过、转发来的、贴纸那套），写在那一行里（text 不用）。
 */
export interface Contribution {
  mechanism: string;
  kind:
    | "scene"
    | "moment"
    | "reference"
    | "self"
    | "thought"
    | "state"
    | "mood"
    | "people"
    | "doings"
    | "failed"
    | "turn"
    | "marks";
  text: string;
  /** turn：这一轮没人找她（群里没人点名，或私聊里她主动开口）。别的 turn 事实有 unsoughtText 的，这时按它写。 */
  unsought?: true;
  /** turn：没人找她时这一句的写法（"X 在说中文"，不是"X 用中文跟你说话"）。 */
  unsoughtText?: string;
  /** 示例决定：由发言层按所用的动作格式写出来，接在 text 后面。 */
  examples?: Array<{ scene: string; acts: Act[]; code?: string }>;
  /** people：同一些事按人写（id 是联系人，或这个群），发言层可以把同一个人的关系和记得的事并在一起。 */
  people?: readonly PersonNote[];
  /** turn：她这一轮回应时该用的语言（最近跟她说话的人说的）。 */
  language?: string;
  /** turn：群里这一轮没人找她时该用的语言（在场多数人说的）；没有时按 language。 */
  unsoughtLanguage?: string;
  /** marks：按消息编号。 */
  marks?: Readonly<Record<string, MessageMarks>>;
  /** 发言提示的决策口吻（例如 Verbalized Sampling "vs"、"composite"）；不设则由默认口吻决定。 */
  style?: "default" | "charm" | "vs" | "composite";
}

/** 一条消息在 Telegram 上看得到的样子（都可以没有）。 */
export interface MessageMarks {
  /** 表情反应，按人数从多到少，只留前几种。 */
  reactions?: ReadonlyArray<{ emoji: string; count: number }>;
  edited?: true;
  /** 改后的话（收到之后才改的；null 是改成了没有文字）。 */
  text?: string | null;
  forwardedFrom?: string;
  stickerSet?: string;
}

/** 在场的一个人：她和他是什么关系、记得他的哪些事（都可以没有）。 */
export interface PersonNote {
  id: string;
  name: string;
  relation?: string;
  facts?: readonly string[];
}

/**
 * Alice 的一项可拆卸行为。必须是纯函数：同样的状态、事件和时间给出同样的结果。
 * 消融某个机制，就是不把它放进传给 step() 的列表。
 *
 * 机制只能软引导：往提示词里放事实或示例（contribute），或者给出唤醒分数（wake）。
 * 不能过滤或改写发言模型的输出。
 *
 * 需要跨会话记忆的机制带自己的状态 S：从 `initial` 开始，每个事件经 `reduce` 折叠一次，
 * 所以删掉派生状态后能从事件日志原样重建。
 */
export interface Mechanism<S = unknown> {
  name: string;
  initial?: S;
  reduce?(state: S, event: AliceEvent): S;
  /** 0–1。任一机制达到 WAKE_THRESHOLD 即唤醒。 */
  wake?(chat: ChatState, event: AliceEvent, now: number, state: S): number;
  /**
   * 没有机制要叫醒她时（wake 都不到阈值），这个会话此刻是不是只要看一眼（System 1：不调模型，只缓解看了
   * 就缓解的东西）。核心只在时钟格上、空闲的会话里问；任一机制说是就看（step 发 glance 副作用）。
   */
  glance?(chat: ChatState, event: AliceEvent, now: number, state: S): boolean;
  /** 唤醒后先等多少毫秒的安静再开口（取各机制的最大值；0 = 立刻）。 */
  patience?(chat: ChatState, event: AliceEvent, now: number, state: S): number;
  /** 为这个会话往发言提示词里加的内容；offered 是这一轮提示词里给她的动作（能力事实按它写）。 */
  contribute?(chat: ChatState, now: number, state: S, offered: readonly ActKind[]): Contribution[];
  /**
   * 记录怎么排（上下文组装的候选）：trigger 是叫醒她的那条。给出时记录照它写，不给（null）就是时间线的
   * 最后 TIMELINE_LIMIT 条；一组里只该有一个机制给。
   */
  layout?(chat: ChatState, now: number, state: S, trigger: string | null): LogItem[] | null;
  /**
   * 这个机制给她的能力（登记表里 gated 的行，例如记下打算、发语音）：心里的事由机制折进自己的状态，
   * 所以只有机制在列时，提示词里才出现这些动作。
   */
  affordances?: readonly ActKind[];
  /** 这个会话里实际给哪些（affordances 的子集，灰度用）；不写就是全部。 */
  affordancesIn?(scope: string, state: S, now: number): readonly ActKind[];
  /**
   * 此刻在这个会话里做不到的事（群里禁发的那几种消息）：从这一轮给她的动作里拿掉，和登记表 available 一样
   * 只写做不做得到。
   */
  withholds?(chat: ChatState, now: number, state: S): readonly ActKind[];
  /**
   * 要不要单独想一想（每天醒来想想自己；心情变了之后把那段经历写进日记）。核心只在时钟格、没有正在进行的
   * 想一想时问，并给出各会话的只读状态（反思要读那段对话）；结果作为 ponder.done / ponder.failed 回来，
   * 经 reduce 折进机制自己的状态。
   */
  ponder?(now: number, state: S, chats: AliceState["chats"]): PonderAsk | null;
  /**
   * 她此刻想去、但还没有会话的地方（还没开过的私聊、只看过预览的群）。核心只在时钟格问，先把它建成一个
   * 空会话，再照常问各机制要不要在那里醒；动作仍然只作用于那个会话。
   */
  opens?(now: number, state: S): Opening | null;
  /**
   * 她此刻在看手机，一眼扫过各个会话（候选 life-l2-glance-scan：瞄一眼的那 15 秒）。核心只在时钟格问：
   * 是的话，时钟格没叫醒的空闲会话里，有别人新说的话的，拿最新那条按此刻再问一次要不要醒（和 stillWakes
   * 同一条路），醒了就以它开口。所以一眼能回好几个会话。
   */
  scans?(now: number, state: S): boolean;
  /** 她此刻是不是正在睡觉（由睡眠机制回答，供外壳判定是否暂停主动拉取外部榜单等）。 */
  asleep?(now: number, state: S): boolean;
  /** 在 PTC 沙箱里按需只读查询该机制的状态（如 recall 翻记忆）；不产生副作用，纯函数。 */
  query?(
    kind: string,
    args: Readonly<Record<string, unknown>>,
    chat: ChatState,
    now: number,
    state: S,
  ): unknown;
  /** 要外壳提供的服务（errand：执行代理）。外壳没有时这个机制不激活（composeMind）。 */
  requires?: readonly string[];
}

/**
 * 机制的组合（compose.ts）：每个机制独自写自己的状态（按名字存，state.<名字>）和它给的能力
 * （act.<动作>：一项能力只能有一个机制给），requires 里是外壳的服务。shell 是外壳此刻提供的服务。
 * 机制之间不读彼此的状态：每个机制只拿到核心的会话状态和它自己的 S，这已经由类型保证。
 */
export function composeMind(mechanisms: readonly Mechanism[], shell: readonly string[]) {
  const parts = mechanisms.map((mechanism) => ({
    name: mechanism.name,
    mechanism,
    provides: [`state.${mechanism.name}`, ...(mechanism.affordances ?? []).map((k) => `act.${k}`)],
    requires: mechanism.requires ?? [],
  }));
  const c = compose({ name: "shell", provides: shell }, parts);
  return { ...c, mechanisms: c.active.map((p) => p.mechanism) };
}

/** 一个还没有的会话：她在不在里面（私聊能直接开口；没加入的群只能加入）。 */
export interface Opening {
  scope: string;
  chatType: ChatType;
  member: boolean;
}

/** 对联合的每一支分别去掉字段（Omit 直接作用在联合上会丢掉判别字段的区分）。 */
type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** 机制提出的想一想；时刻由核心补上。 */
export type PonderAsk = OmitEach<PonderRequest, "at">;

/** 让带状态的机制以统一的类型进入注册表。 */
export function defineMechanism<S>(mechanism: Mechanism<S>): Mechanism {
  return mechanism as Mechanism;
}

export const WAKE_THRESHOLD = 0.5;
