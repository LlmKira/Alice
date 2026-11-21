import type { Act, PostKind } from "./affordances.js";
import type { PeopleLearned, SELF_SCOPE } from "./effects.js";
import type { CallFailure, Failure } from "./failure.js";
import type { NoiseKey } from "./noise.js";
import type { ArmName } from "./rotation.js";

/**
 * 送进 step() 的事件。`at` 是事件发生的时刻（epoch 毫秒），step() 只从这里取时间，
 * 所以同一份事件日志回放出同样的结果。
 */

export type ChatType = "private" | "group";

export interface MessageReceived {
  type: "message.received";
  at: number;
  scope: string;
  chatType: ChatType;
  messageId: string;
  senderId: string;
  senderName: string;
  text: string | null;
  /** "text"、"photo"、"sticker"…… */
  contentType: string;
  /** 非文字部分在她眼里是什么（speech/media.ts describeMedia，例如"贴纸 😂"）。旧数据没有。 */
  media?: string;
  replyToMessageId: string | null;
  /** 私聊、回复了 Alice、或点名了 Alice。 */
  directed: boolean;
  /** 群名（群里的消息才有；旧数据没有）。 */
  chatTitle?: string;
  /** 发消息的是 Telegram 标着的机器人账号（只在是的时候写；旧数据没有）。 */
  isBot?: true;
  /** 转发来的：原来是谁发的（Telegram 在消息上显示的名字）。旧数据没有。 */
  forwardedFrom?: string;
  /** 贴纸所在的那套贴纸的标题（外壳查过、记着的；没查到时晚一点由 message.updated 补）。 */
  stickerSet?: string;
  /** 收到时已经被改过（补拉来的消息；Telegram 标了不显示"已编辑"的不算）。 */
  edited?: true;
  /** 收到时消息上已有的表情反应（补拉来的消息）。 */
  reactions?: readonly Reacted[];
}

/** 一条消息上的一种表情反应和点它的人数（Telegram 给的合计）。 */
export interface Reacted {
  emoji: string;
  count: number;
}

/**
 * 她已经收到的一条消息后来在 Telegram 上的样子变了：被改了（text 是改后的话）、表情反应的合计变了（reactions
 * 是现在的全部，空表示都撤了）、贴纸那套的标题查到了。只写变了的那几样。不叫醒她。
 */
export interface MessageUpdated {
  type: "message.updated";
  at: number;
  scope: string;
  messageId: string;
  text?: string | null;
  edited?: true;
  reactions?: readonly Reacted[];
  stickerSet?: string;
}

/**
 * 她在的一个群在 Telegram 上公开的样子（群里每个人都看得到的）：多少人、谁是群主和管理员（头衔）、
 * 她在这里发不了哪几种消息（群的禁发设置，或单独对她的限制）。外壳查到、和上次不同时写一条。不叫醒她。
 */
export interface ChatDescribed {
  type: "chat.described";
  at: number;
  scope: string;
  members: number | null;
  admins: ReadonlyArray<{ id: string; name: string; role: "owner" | "admin"; title?: string }>;
  /** 她在这里发不了的消息种类（登记表 posts.as 的写法）。 */
  banned: readonly PostKind[];
}

/** Alice 自己的一条消息已经送达。 */
export interface MessageSent {
  type: "message.sent";
  at: number;
  scope: string;
  messageId: string;
  text: string;
  /**
   * 登记表 posts.as。photo：从相册发出的图，text 是图的编号。voice：她说成语音的话，text 是说的内容。
   * forward：转发的，text 是那条东西的编号。
   */
  kind: PostKind;
}

/**
 * 发言模型一次调用的决定：按顺序要做的动作，都作用于这次调用所在的会话。空表示她什么也不做。
 * 没有 think 字段：bench 2026-11-10 中带 think 的输出更长更周到，像真人分数低 0.039。
 */
export interface SpeechDecision {
  acts: Act[];
}

export interface SpeechDecided {
  type: "speech.decided";
  at: number;
  scope: string;
  callId: string;
  decision: SpeechDecision;
}

export interface SpeechFailed {
  type: "speech.failed";
  at: number;
  scope: string;
  callId: string;
  reason: CallFailure;
  /** 模型那边的报错（reason model 时，诊断用）。 */
  error?: string;
}

/** 交出去办的事（登记表 via: "errand"）开始办了；办完是 act.done（带 result）或 act.failed。 */
export interface ActStarted {
  type: "act.started";
  at: number;
  scope: string;
  act: Act;
}

/** 不留下消息的动作（表情、已读、退群、加群、心里的事、看了才知道的事）已经做完。发送成功记为 message.sent。 */
export interface ActDone {
  type: "act.done";
  at: number;
  scope: string;
  act: Act;
  /** 看了才知道的动作（登记表 after.type 为 look）看到的东西，原样写进日志，回放时不再去查。 */
  result?: string;
  /** 后台办的事花了多少（执行代理，llm/errand.ts）；机制不读它，按天花费从这里加总。 */
  usage?: BackgroundUsage;
  /** 找群时看到的群和频道（她还不在里面的；意愿层可以去那里看看、决定加不加）。 */
  found?: FoundPlace[];
  /** 她记下的心情（feel）的效价，外壳问判口气的模型得到（同 Ponder.mood.valence）；判不出时没有。 */
  valence?: number;
  /** 这次查询是在当前发言轮次的代码（PTC）里当场跑完的：结果已回到同一段代码里，不再另起一轮叫醒她。 */
  inline?: true;
}

/** 她找群时看到的一个群或频道：预览里看得到的东西。 */
export interface FoundPlace {
  /** 加入时用的会话 id（只有邀请链接、不知道群的 id 时是邀请的写法，见 telegram/world-adapter）。 */
  scope: string;
  kind: "group" | "channel";
  title: string;
  about: string | null;
  members: number | null;
  /** 预览里最近的几条（公开的）。 */
  recent: string[];
}

/** 动作失败或结果未知（原因见 mind/failure.ts）。永远不以重做作为回应。 */
export type ActFailed = {
  type: "act.failed";
  at: number;
  scope: string;
  act: Act;
  /** 后台办的事没办成也花了钱（同 ActDone.usage）。 */
  usage?: BackgroundUsage;
  /** 同 ActDone.inline：当前轮次的代码里当场查失败，程序已自己接住或继续。 */
  inline?: true;
} & Failure;

/**
 * 一件后台的事的花费（llm/errand.ts）。usd = 模型（网关 x-cost-credits ÷ 250000）加搜索（exa 自报的
 * costDollars）；ms 是从开始办到办完的时长，modelCalls 是执行代理调了几次模型，tools 是各工具用了几次。
 */
export interface BackgroundUsage {
  usd: number;
  modelUsd: number;
  searchUsd: number;
  credits: number;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  tools: Record<string, number>;
  ms: number;
}

/** 有人在某条消息上点了表情（userbot 只知道最近点的人，见 telegram/world-adapter）。 */
export interface ReactionReceived {
  type: "reaction.received";
  at: number;
  scope: string;
  messageId: string;
  /** 点表情的人；Telegram 没给出时为 null。 */
  senderId: string | null;
  emoji: string;
}

/**
 * 负面的表情（Telegram 给的有限集合里看得出是嫌弃、生气、嘲笑的那几个）。世界折叠把它记成一次轻的拒绝，
 * 北极星读数把点它的人记成嫌弃的信号：两处读同一张表。
 */
export const NEGATIVE_REACTIONS: ReadonlySet<string> = new Set([
  "👎",
  "💩",
  "🤮",
  "😡",
  "🤬",
  "🖕",
  "💔",
  "🤡",
  "🥱",
]);

/** 她自己在这个会话里的成员身份变了：被踢、自己离开（也可能在别处退的）、被拉进来。 */
export interface MembershipChanged {
  type: "membership.changed";
  at: number;
  scope: string;
  member: boolean;
  reason: "kicked" | "left" | "added" | "joined";
}

/**
 * 想一想的结果。
 * - reflect：写进日记的 0–2 条，about 是联系人 id（null 是不针对谁），importance 是她自己打的 1–10 分。
 * - life：每天醒来写的今天具体活动、0–2 件小事与跨天在做的事（只读她的生活，读不到任何聊天）。
 */
export interface ReflectPonder {
  kind: "reflect";
  scope: string;
  /**
   * private：别人托她保密的、明显私密的（健康、感情、要给谁的惊喜），她写下时自己标的（PLAN 第 33 件）。
   * 只有标了的守受众规则（diary.ts reaches）；其余的可以带到任何聊天，注明出处。
   */
  entries: Array<{
    about: string | null;
    text: string;
    importance: number | null;
    private?: true;
  }>;
  /**
   * 写完日记时她的心情（她自己的词）和原因；和她自己记下心情（tools.feel）一样折进心情。valence 是外壳问判口气的
   * 模型得到的效价（llm/tone.ts perceiveMood）；判不出时没有，这份心情就不折进去。private 同 entries。
   */
  mood?: { word: string; why: string | null; valence?: number; private?: true };
  /** 请求里问了 learn（people）时，顺手记下的关于人的事。 */
  learned?: PeopleLearned;
}

export interface LifeDayPonder {
  kind: "life";
  date: string;
  activities: Partial<Record<string, string>>;
  moments: Array<{ hour: number; text: string }>;
  ongoing: string[];
  /** 睡梦/日程里长出来的内生好奇点（流进 desire 成为主动分享/搭话的上游）。 */
  curiosities?: Array<{ topic: string; hook: string }>;
}

export type Ponder = ReflectPonder | LifeDayPonder;

export interface PonderDone {
  type: "ponder.done";
  at: number;
  scope: string;
  callId: string;
  ponder: Ponder;
}

/** 在想什么：在某个会话（chat）里经历的事，或每天醒来写的自己的生活。失败时靠它只放下那一件。 */
export type PonderTarget = { kind: "reflect"; chat: string } | { kind: "life" };
/** 想一想失败：不重试（这一次不写）。 */
export type PonderFailed = {
  type: "ponder.failed";
  at: number;
  scope: string;
  callId: string;
  reason: CallFailure;
  error?: string;
} & PonderTarget;

export interface ClockTick {
  type: "clock.tick";
  at: number;
}

/** step() 之前要求的计时到点了。过期的计时（id 对不上）会被忽略。 */
export interface TimerFired {
  type: "timer.fired";
  at: number;
  scope: string;
  timerId: string;
}

/** 冲着她的一条消息对她的口气（外壳问 Jev，llm/tone.ts）。 */
export const TONES = ["friendly", "neutral", "cold", "hostile"] as const;
export type Tone = (typeof TONES)[number];

/**
 * 外壳看懂了一条消息：media 是非文字部分（图片描述），替换那条消息在时间线里的描述；tone 是这条冲着她的消息
 * 对她的口气。两样各自晚一点到，都不叫醒她。
 */
export interface MessagePerceived {
  type: "message.perceived";
  at: number;
  scope: string;
  messageId: string;
  media?: string;
  tone?: Tone;
  /** 同一次判口气里看出来的：这条在叫她别回、别理、走开（relation.ts 记成那个人的一笔）。 */
  stop?: true;
  /** 同一次里看出来的：这条在叫她闭嘴、少说（pressure/rejection.ts）。 */
  hush?: true;
  /** 同一次里看出来的：这条不想跟她说话、在打发她（pressure/rejection.ts）。 */
  aloof?: true;
}

/**
 * 她订阅的频道里来了一条新帖（P02）：只是她看得到的东西，不是对她说话，不叫醒她、不进任何会话的时间线；
 * 压力场把它记成她最近看到的事（information 的来源），转发时用它的编号。
 */
export interface PostReceived {
  type: "post.received";
  at: number;
  /** 频道的会话 id。 */
  scope: string;
  messageId: string;
  /** 频道名。 */
  title: string;
  text: string | null;
  /** 非文字部分在她眼里是什么（speech/media.ts）。 */
  media?: string;
}

/**
 * 外壳抽的一组标准正态数（mind/noise.ts，每 NOISE_EVERY_MS 一次）：她自己的随机性（精力、心情的波动，
 * 生活里的事什么时候开始）。机制在 reduce 里只读自己的键；回放用固定种子生成同样的事件。scope 总是 "self"。
 */
export interface NoiseDrawn {
  type: "noise.drawn";
  at: number;
  scope: typeof SELF_SCOPE;
  /** 旧日志里可能没有后来加的键。 */
  draws: Partial<Record<NoiseKey, number>>;
}

/**
 * 别人进了这个群（Telegram 的入群提示：被拉进来、点邀请链接进来）。不叫醒她、不进时间线；
 * 机制靠它分清"刚进群的人"和"在她的记录之前就在群里的人"（候选 familiar 读它）。
 */
export interface MemberJoined {
  type: "member.joined";
  at: number;
  scope: string;
  userId: string;
}

/**
 * 她看了这个会话一眼（System 1，没有调用模型）：节律到点时，意愿层在这里排第一的只是看一眼就能缓解的拉力
 * （未读，Mechanism.glance）。外壳收到 step() 的 glance 副作用就写这一条；之后的消耗（未读清零、习惯化）
 * 和 Telegram 那边的标已读都从它来，所以回放读得回她看过哪里。
 */
export interface ChatGlanced {
  type: "chat.glanced";
  at: number;
  scope: string;
}

/**
 * 线上轮换（mind/rotation.ts）：这个分组单位（一个会话，或 "self"：她这个人）从此刻起用哪一套。外壳在时钟格之前
 * 算出该换的（她在那里不在对话里、这个时间段排的组和现在的不同），先写这一条再走时钟；step 只照它换，
 * 所以折叠、回放和北极星读的是同一份分组。arm 为 null：轮换关了，这个单位回到只有生产。
 */
export interface ArmSwitched {
  type: "arm.switched";
  at: number;
  scope: string;
  arm: ArmName | null;
  /** 候选的名字（sim/will-arms.ts 的组名）。 */
  candidate: string;
  /** 第几个时间段（rotation.ts blockOf）。 */
  block: number;
}

/** 对方正在输入 / 录语音（Telegram P06，ttl 约 6 秒）；不进时间线、不直接叫醒她。 */
export interface TypingReceived {
  type: "typing.received";
  at: number;
  scope: string;
  chatType: ChatType;
  senderId: string;
  status: "typing" | "voice" | "cancel";
}

/** 会话消息已读回执（Telegram P06）：outbox 为对方已读到她的哪一条。 */
export interface HistoryRead {
  type: "history.read";
  at: number;
  scope: string;
  chatType: ChatType;
  outbox: boolean;
  maxReadId: string;
  unreadCount: number;
}

export type AliceEvent =
  | ArmSwitched
  | PostReceived
  | MessageReceived
  | MessagePerceived
  | MessageUpdated
  | ChatDescribed
  | MessageSent
  | SpeechDecided
  | SpeechFailed
  | PonderDone
  | PonderFailed
  | ActStarted
  | ActDone
  | ActFailed
  | ReactionReceived
  | MembershipChanged
  | ClockTick
  | TimerFired
  | NoiseDrawn
  | MemberJoined
  | ChatGlanced
  | TypingReceived
  | HistoryRead;
