import type { Act, ActKind } from "./affordances.js";
import type { ChatType, MessageReceived, PonderTarget } from "./events.js";
import type { ArmName } from "./rotation.js";

export const TIMELINE_LIMIT = 30;
/** 同一会话 SEND_WINDOW_MS 内最多发 SEND_LIMIT 条安全上限（防无限循环刷屏，同时容得下连续两三轮正常拆条接话）。 */
export const SEND_LIMIT = 6;
export const SEND_WINDOW_MS = 60_000;

/** 没发出去的那几条在状态里留多久：和 failures、看过的东西一样，是"刚才"的尺度。 */
export const DROPPED_MS = 10 * 60_000;
/** 同一个会话最多记几条（一分钟里超出上限的不会更多）。 */
export const DROPPED_KEPT = 3;

/**
 * 她刚才想发、因为一分钟连发上限没发出去的一条：failures 机制在提示词里说给她听。
 * 以前它只活在发言结果的丢弃里，她不知道自己想说的话没出去（PLAN #38）。
 */
interface DroppedSend {
  at: number;
  act: Act;
}

export interface TimelineEntry {
  at: number;
  messageId: string;
  /** Alice 自己为 null。 */
  /** isBot：平台标着的机器人账号（群管、签到）；它们不是在跟她说话的人。 */
  sender: { id: string; name: string; isBot?: true } | null;
  text: string | null;
  contentType: string;
  media?: string;
  replyToMessageId: string | null;
  /** 她给这一行加的注（登记表 after 的 annotate、revise，例如"你说过这事先不追究了"）。 */
  note?: string;
  /** 这一条是冲着她的（私聊、点名、回复她）：她一眼扫过各个会话时，按它当时的样子再问一次要不要醒（step.ts onTick）。 */
  directed?: true;
}

/** 等对方说完时，最多等这么久就开口。 */
export const PATIENCE_CAP_MS = 60_000;

/**
 * 空闲；被唤醒后先等对方说完（waiting，对方每来一条就重新计时）；
 * 或正在等一次发言调用（deciding），这期间又被唤醒只记一笔，不叠加调用。
 * waking：叫醒她、还没轮到她想的那条消息。等完（或这次想完）真正开始想时，拿它再问一次各机制，
 * 这中间她的处境可能变了（比如她刚去睡了）。她自己办的事的结果叫醒她时是 null。
 */
type Mind =
  | { mode: "idle" }
  | {
      mode: "waiting";
      since: number;
      wait: number;
      timerId: string;
      triggerMessageId: string | null;
      waking: MessageReceived | null;
    }
  | {
      mode: "deciding";
      callId: string;
      since: number;
      wakeAgain: boolean;
      waking: MessageReceived | null;
    };

export interface ChatState {
  scope: string;
  chatType: ChatType;
  timeline: TimelineEntry[];
  /** 已经决定要发的消息的时刻，用于连发上限。 */
  recentSends: number[];
  /** 想发、因为一分钟连发上限没发出去的消息（message.sent 清掉，DROPPED_MS 之后过期）。 */
  droppedSends?: readonly DroppedSend[];
  /** 她是否还在这个会话里（退群后为 false，收到消息或加群成功后为 true）。 */
  member: boolean;
  mind: Mind;
  /** 本会话已发起的调用数，用来生成确定的调用 id。 */
  calls: number;
  /** 她在这个会话里刚看过的东西（翻相册、查一下的结果），最近 LOOKED_KEPT 条。 */
  looked: readonly Looked[];
  /** 自从别人上一次说话，她因为"看了结果"被连着叫醒了几次（上限 LOOK_RUN_LIMIT）。 */
  lookRun: number;
  /** 这个会话里交出去、还没办完的事（登记表 via: "errand"）。 */
  running: readonly Running[];
  /**
   * 从时间线前面挤出去的更早的聊天，按间隔分段，每段只留时间、条数和头尾两句（2 月 memory.mod 的分段回顾，
   * absorb/omp-report.md §2-4）。时间线本身仍是 TIMELINE_LIMIT 条：机制读的"她看得见的"不变。
   */
  earlier: readonly Segment[];
  /** 她在这个会话里最近发出的消息的编号（最多 SENT_IDS_KEPT 条）：回复其中一条就是在找她（step.ts towardHer）。 */
  sentIds: readonly string[];
}

/** 记住她最近发出的多少条：线上群里回复她的消息，离她那条最长约 35 分钟，她一小时说不到这么多。 */
export const SENT_IDS_KEPT = 50;

/**
 * 那一刻的对话还在时间线上，她眼前就看得见：卡片不再重复它（日记、最近几次开口的结果）。
 * 时间线是空的时什么都不在上面。
 */
export function onTimeline(chat: Pick<ChatState, "timeline">, at: number): boolean {
  const first = chat.timeline[0];
  return first !== undefined && at >= first.at;
}

/** 一个还什么都没有的会话（状态从 Journal fold，不持久化，所以没有"旧数据缺字段"的情况）。 */
export function emptyChat(scope: string, chatType: ChatType, member: boolean): ChatState {
  return {
    scope,
    chatType,
    timeline: [],
    recentSends: [],
    member,
    mind: { mode: "idle" },
    calls: 0,
    looked: [],
    lookRun: 0,
    running: [],
    earlier: [],
    sentIds: [],
  };
}

export interface Segment {
  from: number;
  to: number;
  count: number;
  first: TimelineEntry;
  last: TimelineEntry;
}

/** 更早的聊天最多留几段；相邻两条间隔超过 SEGMENT_GAP_MS 就另起一段。 */
export const SEGMENTS_KEPT = 5;
export const SEGMENT_GAP_MS = 10 * 60_000;

export interface Running {
  at: number;
  act: Act;
}

export interface Looked {
  at: number;
  /** 哪个动作看到的（发图只在翻过相册之后可用）。 */
  kind: ActKind;
  /** "你翻了翻相册（想找的：猫）：……" */
  text: string;
}

export const LOOKED_KEPT = 3;
/** 看过的东西在提示词里留多久。 */
export const LOOKED_MS = 10 * 60_000;
/** 一次连续操作最多因为"看了结果"再醒几次（翻相册 → 再翻一次 → 发图）。 */
export const LOOK_RUN_LIMIT = 3;

export interface AliceState {
  chats: Readonly<Record<string, ChatState>>;
  /** 各机制自己的状态，按机制名存放。 */
  mechanisms: Readonly<Record<string, unknown>>;
  /** 正在进行的想一想：同时只有一次，结果回来之前不再发起。 */
  pondering: ({ callId: string } & PonderTarget) | null;
  /** 线上轮换：每个分组单位眼下在哪一组（只从 arm.switched 来；没有轮换过就没有这一项）。 */
  arms?: Readonly<Record<string, ArmState>>;
}

interface ArmState {
  arm: ArmName;
  candidate: string;
  since: number;
}

export const emptyState: AliceState = { chats: {}, mechanisms: {}, pondering: null };
