import type { Act, ActKind } from "./affordances.js";
import type { ChatType, PonderTarget } from "./events.js";
import type { Contribution } from "./mechanism.js";
import type { Looked, Running, Segment, TimelineEntry } from "./state.js";

/** 发言层渲染一次提示词所需的全部内容；是纯数据，回放时可以按它做缓存。 */
export interface SpeechRequest {
  scope: string;
  chatType: ChatType;
  timeline: TimelineEntry[];
  contributions: Contribution[];
  /** 唤醒她的那条消息（如果有）。 */
  triggerMessageId: string | null;
  /** 她此刻在想（决定的时刻）。时钟触发的主动开口离最后一条消息可能已经很久。 */
  at: number;
  /** 此刻在这个会话里能做的事（按 affordance 登记表算出）。 */
  affordances: ActKind[];
  /** 她刚在这个会话里看过的东西（LOOKED_MS 之内），按时间先后。 */
  looked?: readonly Looked[];
  /** 这个会话里交出去、还没办完的事。 */
  running?: readonly Running[];
  /** 从时间线前面挤出去的更早的聊天（分段，只有头尾）。 */
  earlier?: readonly Segment[];
  /**
   * 记录怎么排（上下文组装的候选，Mechanism.layout）：有它时记录照它写，没有时是 timeline。
   * timeline 仍是机制读的最后 TIMELINE_LIMIT 条。
   */
  log?: readonly LogItem[];
  /** 外壳从贴纸库里读出的几个手头贴纸描述（只给模型看见自己有什么贴纸，纯数据）。 */
  stickers?: readonly string[];
}

/** 记录里的一项：一条消息，或相邻两条之间没写出来的几条。 */
export type LogItem = { kind: "line"; entry: TimelineEntry } | { kind: "skip"; count: number };

/** 一个人在这段对话里出现时的样子：回想时用编号指人，结果再换回 id。 */
export interface Person {
  id: string;
  name: string;
}

/**
 * 反思（候选 reflect）：她在某个会话里经历累计到一定分量后，把那段经历写进日记
 * （2 月的日记是她每轮顺手写的；现在的模型顺手写只有 0–2%）。由机制发起（Mechanism.ponder），
 * 外壳做一次小模型调用，结果作为 ponder.done 回来。
 */
export interface ReflectRequest {
  kind: "reflect";
  at: number;
  scope: string;
  chatType: ChatType;
  /** 那段对话，从旧到新；别人用 p 编号（people 里第几个），她自己是 null。 */
  lines: Array<{ at: number; who: number | null; text: string }>;
  people: Person[];
  /** 她此刻在这里的心情；没有就是 null。 */
  mood: { word: string; why: string | null } | null;
  /** 这里看得见的日记（免得重写同一件事）。 */
  diary: string[];
  /** 写法示范（她以前的日记）。 */
  examples: string[];
  /** 候选 people：同一次反思里顺手记下关于人的具体的事（没有这个字段时提示词与以前逐字相同）。 */
  learn?: PeopleAsk;
}

/** 反思时顺手记下关于人的事（mechanisms/pressure/people.ts）。 */
export interface PeopleAsk {
  /** 记关于人的具体的事（R05）。 */
  facts: boolean;
  /** 她已经记得的关于这段对话里的人的事：who 是 people 的下标。 */
  known: Array<{ who: number; facts: string[] }>;
  /**
   * 另记她自己说出口的关于她自己的事；known 是这里看得见的、她说过的关于自己的事。
   * 不问时没有这个字段。
   */
  self?: { known: string[] };
}

/** 反思时顺手记下的关于人的事（PeopleAsk 问了哪样才有哪样）；about 是联系人 id。 */
export interface PeopleLearned {
  /**
   * 关于人的具体的事，replaces 是被它改掉的旧内容原文。said 是出处（他原话里的几个字，已经校验过）；
   * Journal 里旧的没有出处，fold 时不记（reflect-people.ts quoted）。
   */
  facts?: Array<{
    about: string;
    said?: string | null;
    text: string;
    when: string | null;
    replaces: string | null;
    /** 别人托她保密的、明显私密的（反思时她自己标的）：只守受众规则（diary.ts reaches）。 */
    private?: true;
  }>;
  /** 她自己说出口的关于她自己的事（问了 self 才有），said 是出处，replaces 是被它改掉的旧内容原文。 */
  self?: Array<{ said?: string | null; text: string; replaces: string | null; private?: true }>;
}

/**
 * 每天醒来或睡着时写一次她自己那边今天具体要做什么、有什么小事、在追什么跨天的事（docs/research/her-life.md 第 2 片）。
 * 类型上刻意不含任何聊天、时间线或联系人字段，编译期保证别人的事进不了她的生活。
 */
export interface LifeDayRequest {
  kind: "life";
  at: number;
  scope: typeof SELF_SCOPE;
  date: string;
  /** 睡眠期复盘/做梦模式：只带抽象的自身心情底色，绝不带任何聊天人名或原话。 */
  dream?: { moodHint?: string };
  yesterday: {
    activities: Partial<Record<string, string>>;
    moments: string[];
    ongoing: string[];
  };
}

export type PonderRequest = ReflectRequest | LifeDayRequest;

/** 这次想一想在想什么（失败、重启时只放下这一件）。 */
export function ponderTarget(request: Pick<PonderRequest, "kind" | "scope">): PonderTarget {
  return request.kind === "reflect" ? { kind: "reflect", chat: request.scope } : { kind: "life" };
}

/** 想一想不属于哪个会话：结果事件的 scope 固定是这个。 */
export const SELF_SCOPE = "self";

export type Effect =
  | { type: "call-speech"; scope: string; callId: string; request: SpeechRequest }
  | { type: "call-ponder"; scope: typeof SELF_SCOPE; callId: string; request: PonderRequest }
  | { type: "set-timer"; scope: string; timerId: string; at: number }
  /** scope 总是做出这个决定的会话。 */
  | { type: "act"; scope: string; act: Act };
