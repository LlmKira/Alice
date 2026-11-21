/**
 * 可供性登记表：她在世界里能做的每一件事登记一次。发言、贴纸、表情、标记已读、退群、加群都是表里的一行；
 * 私聊别人不单列，是意愿层选中那个私聊会话后在里面 send。记下答应的事、记下心情是她心里的事
 * （via: "mind"）：没有 Telegram 效果，外壳直接记为 act.done，由机制折进世界。
 *
 * 新增一种能力：在 Act 里加一个形状、在 affordances 里加一行；经 Telegram 做的，在 telegram/acts.ts 的执行表里
 * 补一项（类型会强制补上）。一行用类型化的字段说清它的一切：经哪条通道做（via）、要不要机制提供（gated）、
 * 会不会留下她的一条消息（posts）、做完之后会话里有什么变化（after）。settle、step、外壳和输出格式都按这些字段
 * 通用处理，不按种类写分支。
 * 动作只作用于做决定的那个会话（scope 由外壳注入），所以一个决定不可能落到别的会话。
 */
import type { ChatType } from "./events.js";
import { LOOKED_MS, type Looked, type TimelineEntry } from "./state.js";

export type Act =
  | { kind: "send"; text: string; replyTo: string | null }
  | { kind: "sticker"; word: string }
  | { kind: "react"; messageId: string; emoji: string }
  | { kind: "mark-read" }
  | { kind: "leave-chat" }
  | { kind: "join-chat" }
  /** 在她的相册（群里见过的图）里按描述找图；结果回到这个会话，她看了再决定。 */
  | { kind: "album-search"; query: string }
  /** 把相册里的一张图发到这个会话（不带原作者转发）。 */
  | { kind: "album-send"; asset: string }
  /** 把一件要查、要找、要算的事交出去办（后台执行，结果过一会儿回到这个会话）。 */
  | { kind: "delegate"; task: string }
  /**
   * 答应别人或打算做的事；when 是她说的时间原话（认不出来就是没有约定时间）；where 是要去做的那个群的名字或那个人的
   * 名字（她说的原话，记忆按群名、人名认出会话，认不出就记在这里）。
   */
  | { kind: "intend"; when: string | null; what: string; where?: string }
  /** 答应过、打算过的那件事做完了。 */
  | { kind: "fulfil"; what: string }
  /** 对某条让她不舒服的话，她自己说算了、先不追究（记录里那一行带上一个注，不再引一遍原话）。 */
  | { kind: "let-go"; messageId: string }
  /** 她此刻的心情（她自己的词）和原因；secret：原因是别人托她保密的、明显私密的（只守受众规则）。 */
  | { kind: "feel"; mood: string; why: string | null; secret?: typeof SECRET }
  /** 一句只有她自己看得见的心里话（about = 关于谁，就是他说的那条消息；不写就不针对谁）。 */
  | { kind: "diary"; about: string | null; entry: string }
  /** 她此刻心里在想什么（2 月 think()）：不发出去，这个会话里过一会儿还记得；secret 同 feel。 */
  | { kind: "think"; thought: string; secret?: typeof SECRET }
  /** 她在这个会话里开始跟一件还没完的事（2 月 begin_topic），title 是她自己的话。 */
  | { kind: "topic-open"; title: string }
  /** 她跟着的那件事有了进展（2 月 advance）：topic 按内容认，beat 是她自己写的进展。 */
  | { kind: "topic-advance"; topic: string; beat: string }
  /** 她跟着的那件事了结了（2 月 resolve_thread）。 */
  | { kind: "topic-close"; topic: string }
  /** 她放下手机去睡觉（候选 bedtime）：睡到作息里下一次醒来。 */
  | { kind: "bed" }
  /** 把一句话说成语音发出去（外壳合成，2 月 send_voice）。 */
  | { kind: "voice"; text: string }
  /** 改她自己在这个会话里刚发的一条文字消息（改错字、改口；2 月 edit_message）。 */
  | { kind: "edit"; messageId: string; text: string }
  /** 群里大家连着发同一句时，跟着发一遍（2 月 repeat_message）：messageId 是被复读的那条。 */
  | { kind: "repeat"; messageId: string }
  /** 按关键词、@用户名或 t.me 链接找公开的群和频道；看到的预览回到这个会话。 */
  | { kind: "chat-search"; query: string }
  /** 把她在频道里看到的一条帖子原样转到这个会话（编号是提示词里给的）。 */
  | { kind: "forward"; item: string }
  /** 在 run_code 里按需翻查自己的记忆（日记、说过的话、记住的人、开着的话头、承诺与今天日程）。 */
  | { kind: "recall"; query: string | null; subject: string | null }
  /** 在 run_code 里主动记下或更正一条关于自己的话（发现前后矛盾时用 replaces 换掉旧说法）。 */
  | { kind: "note-self"; text: string; replaces: string | null }
  /** 在 run_code 里核对对某人/来源群的私聊接收度与外部社交规范协议（是否需要先在群里打招呼）。 */
  | { kind: "dm-check"; who: string | null }
  /** 在初次私聊里暂缓直接开口，记下一笔打算留到来源群里先自然问一句方不方便私聊。 */
  | { kind: "dm-defer"; reason: string };
export type ActKind = Act["kind"];

/** 驱动键由压力场（mechanisms/pressure）计算；这里只声明可供性能缓解哪些。 */
export type DriveKey =
  | "attention"
  | "obligation"
  | "cooling"
  | "curiosity"
  | "information"
  | "thread"
  | "prospect"
  | "aversion"
  /** 群里别人的话对上她心里的东西、说话的人最近和她有来往（候选 groupturn）。 */
  | "topic"
  | "bond";

export type EntityKind = "chat" | "message" | "contact";

/** 社交侵入度（2 月 social-cost.ts）。solicited 由意愿层按世界状态判断。 */
export interface Intrusiveness {
  private: { solicited: number; unsolicited: number };
  group: { solicited: number; unsolicited: number };
}

/**
 * 动作参数的种类，决定怎么校验（mind/args.ts）：消息编号必须在这个会话里，own 还必须是她自己
 * EDIT_WINDOW_MS 之内发的文字消息（改消息：不改别人的话，不改很久以前的），表情和贴纸必须在词表里。
 */
export type ArgKind =
  | "text"
  | "message"
  | "own"
  | "emoji"
  | "sticker"
  | "mood"
  | "when"
  /** 标记：写了就是 SECRET，没写就没有这个字段（不是 null）。 */
  | "secret";

/**
 * 她心里的事（想法、心情）写下时自己标的"私密"（PLAN 第 33 件，北极星不变量 1）：别人托她保密的、明显私密的
 * （健康、感情、要给谁的惊喜）。标了的守受众规则（mechanisms/pressure/diary.ts reaches），其余的可以带到别的聊天。
 * 和反思调用里的 private 是同一件事，这里在发言调用里标，不另调模型。
 */
export const SECRET = "私密";
const SECRET_ARG: ArgSpec = {
  field: "secret",
  kind: "secret",
  optional: true,
  sparse: true,
  about: "这是别人托你保密的事，或明显私密的事（健康、感情、要给谁的惊喜）时写上；其余不写",
};

export interface ArgSpec {
  /** Act 上的字段名。 */
  field: string;
  kind: ArgKind;
  optional?: boolean;
  /** 给模型看的说明。 */
  about: string;
  /** 可选参数在说明里的称呼（文字参数默认"要说的话"，speech/decision.ts guideOf）。 */
  slot?: string;
  /** 后来加的可选参数：没写就没有这个字段（不是 null），之前写进 Journal 的动作都没有它。 */
  sparse?: true;
}

/** 她在会话里留下的一条消息是什么（message.sent 的 kind）：时间线按它显示（step.ts SENT_AS）。 */
export type PostKind = "text" | "sticker" | "photo" | "voice" | "forward";

/**
 * 会在会话里留下一条她的消息（计入连发上限）：留下的是 as 这一种，内容取自 from 这一类参数；
 * 参数是消息编号时（复读），内容是那条消息的原话。
 */
export interface Posts {
  as: PostKind;
  from: ArgKind;
}

/**
 * 看了才知道的动作（翻相册、查一下、找群）：外壳把结果写进 act.done，回到这个会话，她看了再做下一步。
 * as 是她经历这件事的说法，提示词里写成"你翻了翻相册：……"。
 */
export interface Look {
  type: "look";
  as: string;
}

/** 做完之后这个会话里有什么变化（step 的 act.done 按它处理）。 */
export type After =
  | Look
  /**
   * 给记录里的一条消息加注（参数里要有一条 message）：那一行后面带上这句（"你说过这事先不追究了"）。
   * 原话不改、不再引一遍，只是让它不再像刚发生的事那样摆着（2 月 relationships.mod 的 reactivity 衰减，
   * absorb/omp-report.md §2-7；不用词表判"道歉"，由她自己说）。
   */
  | { type: "annotate"; note: string }
  /** 改她自己的消息：时间线里那一行换成新的话，带上这个注。 */
  | { type: "revise"; note: string }
  /** 她还在不在这个会话里（退群、加群）。 */
  | { type: "member"; member: boolean };

/**
 * 执行通道。telegram：外壳排进这个会话的发送队列。mind：她心里的事，不经 Telegram，外壳直接记为 act.done。
 * errand：交出去在后台办，外壳不排进发送队列，先记 act.started，办完记 act.done（带 result）或 act.failed；
 * 办的时候她照常聊天，提示词里写着 pending 那句。
 *
 * gated：只有某个机制提供它（Mechanism.affordances）时才有。她心里的事没有机制把它折进世界就没有任何后果；
 * 交出去办的事要有能用的执行代理（errands 机制）；发语音、改消息、复读、找群、转发还是候选。消融那个机制，
 * 这一行也一起拿掉。
 */
type Channel =
  | { via: "telegram"; gated: boolean; after?: After }
  | { via: "mind"; gated: true; after?: After }
  | {
      via: "errand";
      gated: true;
      after: Look;
      /** 还没办完时提示词里的那句（what 是参数，ago 是"刚""5 分钟前"）。 */
      pending(what: string, ago: string): string;
    };

/** 判断可供性需要的会话视图：核心状态（chat-view.ts）和意愿层的世界图（chatViewOf）给出同样的字段。 */
export interface ChatView {
  chatType: ChatType;
  member: boolean;
  /** 她上次开口之后别人又发了几条（还没回应过的新消息）。 */
  fresh: number;
  /** 她最近在这里看过的东西（翻相册之后才能发图）。 */
  looked: readonly Looked[];
  /** 这个会话里交出去、还没办完的事有几件。 */
  running: number;
  /** 自从别人上一次说话，她因为看了结果被连着叫醒了几次（ChatState.lookRun）。 */
  lookRun: number;
  /** 她在时间线上自己发的文字消息（编号与时刻，改消息用）。 */
  own: readonly { id: string; at: number }[];
  /** 记录末尾别人正在复读的那条（不同的人连着发同一句）；没有是 null。 */
  echo: string | null;
}

export type Affordance = {
  kind: ActKind;
  /** 发言提示词里的 SDK 名（`await tools.名字({…})`，speech/decision.ts），也是标识符。 */
  name: string;
  /** 给模型看的说明（SDK 里那一行的注释）：做什么，或什么时候做。 */
  hint: string;
  appliesTo: readonly EntityKind[];
  args: readonly ArgSpec[];
  /** 这一行此刻在这个会话里能不能做（不含 gated：机制给不给由 offers 一起判）。只写做不做得到，不写该不该。 */
  available(chat: ChatView, now: number): boolean;
  /**
   * 意愿层能不能为了这件事叫醒她（不写就是能）。醒着时她能做什么由 available 定；为了什么才叫醒她是另一回事：
   * 点表情在哪条消息上都能点，但只有来了新消息才值得为它叫醒——否则意愿层会借"点表情"的缓解每隔几小时叫醒她
   * 一次，醒来却发消息，绕过连发代价（memory-eval）。
   */
  wakes?(chat: ChatView): boolean;
  relieves: Partial<Record<DriveKey, number>>;
  intrusiveness: Intrusiveness;
  /**
   * 要不要由发言模型斟酌（说什么、回哪条、要不要离开）。只标已读不用：看一眼就是看一眼，
   * 意愿层不会为它叫醒模型（否则积压最多的会话永远排第一，见 trigger/pressure-fidelity.md）。
   */
  deliberate: boolean;
  posts?: Posts;
  /**
   * 结果里带着外面的内容（网页、搜索结果）。这样的结果还在她眼前时（LOOKED_MS 之内），
   * 退群、加群这类改变她在哪儿的动作不可用（readOutside）。
   */
  outside?: boolean;
} & Channel;

const member = (chat: ChatView) => chat.member;

/**
 * 不变量（防间接注入）：外面的内容（查一下的结果）还在她眼前时，不提供退群、加群。网页里写着"退出本群"
 * 这类话时，读了它的那一轮做不出不可逆的动作；过了 LOOKED_MS、结果不在提示词里了，照常可用。
 * settle 也按 available 判，所以模型照写了标记也不会执行。
 */
export function readOutside(chat: ChatView, now: number): boolean {
  return chat.looked.some((l) => now - l.at <= LOOKED_MS && affordanceOf(l.kind).outside === true);
}

/**
 * 她能改自己多久之内发的消息：Telegram 自己的上限 48 小时。改不改、隔多久还改是她自己的事
 * （研究员 2026-11-12：只写做不做得到，不替她定习惯；原先的 10 分钟是对习惯的猜测）。
 */
export const EDIT_WINDOW_MS = 48 * 60 * 60_000;

/** 默认（未测、暂定）的侵入度；send、react、mark-read 取自 2 月 social-cost.ts。 */
const flat = (v: number): Intrusiveness => ({
  private: { solicited: v, unsolicited: v },
  group: { solicited: v, unsolicited: v },
});
/** 说一句话（文字或语音）。 */
const SAYING: Intrusiveness = {
  private: { solicited: 0.6, unsolicited: 1.0 },
  group: { solicited: 0.2, unsolicited: 0.4 },
};
/** 发一样东西（贴纸、图、跟着复读、转发）：比说话轻。 */
const SHOWING: Intrusiveness = {
  private: { solicited: 0.4, unsolicited: 0.6 },
  group: { solicited: 0.15, unsolicited: 0.3 },
};

const rows = [
  {
    kind: "send",
    name: "say",
    hint: "发一条消息",
    appliesTo: ["chat"],
    args: [
      { field: "text", kind: "text", about: "要说的话" },
      {
        field: "replyTo",
        kind: "message",
        optional: true,
        // 2026-11-13 Gemini 改稿 2（docs/adr/282-speech-style-and-room-voice.md）：别人刚回复你、你顺着往下接时通常不引用回去。
        about:
          "引用回复哪条（编号）；群里隔条接话时填上；紧挨着上一条、或别人刚回复你而你顺着往下接时通常省略",
      },
    ],
    available: member,
    relieves: {
      attention: 1,
      obligation: 1,
      cooling: 1,
      curiosity: 1,
      information: 1,
      thread: 1,
      prospect: 1,
      topic: 1,
      bond: 1,
    },
    intrusiveness: SAYING,
    deliberate: true,
    via: "telegram",
    gated: false,
    posts: { as: "text", from: "text" },
  },
  {
    kind: "sticker",
    name: "sticker",
    hint: "发一张贴纸",
    appliesTo: ["chat"],
    args: [{ field: "word", kind: "sticker", about: "贴纸的词" }],
    available: member,
    relieves: { attention: 1, obligation: 0.5, cooling: 0.7, bond: 0.7 },
    intrusiveness: SHOWING,
    deliberate: true,
    via: "telegram",
    gated: false,
    posts: { as: "sticker", from: "sticker" },
  },
  {
    kind: "react",
    name: "react",
    hint: "给某条消息点个表情（看过了、顺手笑一下或轻声表态；适合群友发图、玩梗但没必要接话时，点完就够）",
    appliesTo: ["message"],
    args: [
      { field: "messageId", kind: "message", about: "哪条消息（编号）" },
      { field: "emoji", kind: "emoji", about: "表情" },
    ],
    // 醒着时哪条都能点；只有来了还没回应过的新消息，才值得为点表情叫醒她（见 wakes）。
    available: member,
    wakes: (chat) => chat.fresh > 0,
    relieves: { attention: 0.35, cooling: 0.25, obligation: 0.15, bond: 0.3 },
    intrusiveness: {
      private: { solicited: 0.3, unsolicited: 0.3 },
      group: { solicited: 0.1, unsolicited: 0.1 },
    },
    deliberate: true,
    via: "telegram",
    gated: false,
  },
  {
    kind: "mark-read",
    name: "mark_read",
    hint: "只标记已读、不回复",
    appliesTo: ["chat"],
    args: [],
    available: member,
    relieves: { attention: 1 },
    intrusiveness: flat(0.1),
    deliberate: false,
    via: "telegram",
    gated: false,
  },
  {
    kind: "leave-chat",
    name: "leave_chat",
    hint: "退出这个群",
    appliesTo: ["chat"],
    args: [],
    available: (chat, now) => chat.chatType === "group" && chat.member && !readOutside(chat, now),
    relieves: { aversion: 1 },
    intrusiveness: flat(0.5),
    deliberate: true,
    via: "telegram",
    gated: false,
    after: { type: "member", member: false },
  },
  {
    kind: "join-chat",
    name: "join_chat",
    hint: "加入这个群",
    appliesTo: ["chat"],
    args: [],
    // 只对她不在其中的已知群可用；目前只有意愿层跨会话选目标时才会出现这种决定。
    available: (chat, now) => chat.chatType === "group" && !chat.member && !readOutside(chat, now),
    relieves: { curiosity: 1 },
    intrusiveness: flat(0.5),
    deliberate: true,
    via: "telegram",
    gated: false,
    after: { type: "member", member: true },
  },
  {
    kind: "album-search",
    name: "search_album",
    hint: "从相册里找一张图（在群里见过的图）",
    appliesTo: ["chat"],
    args: [{ field: "query", kind: "text", about: "想找什么样的图", slot: "想找的图" }],
    available: member,
    // 不缓解任何驱动：意愿层不会为"翻相册"叫醒她，醒着时想翻才翻。
    relieves: {},
    intrusiveness: flat(0),
    deliberate: true,
    via: "telegram",
    gated: false,
    after: { type: "look", as: "你翻了翻相册" },
  },
  {
    kind: "delegate",
    name: "look_up",
    // PTC 轮内查询：调用 await tools.look_up({ task }) 会当场返回结果文本，直接在同一段代码里接着说。
    hint: "上网查客观事实（天气、新番、新闻、链接内容）或算日子",
    appliesTo: ["chat"],
    args: [{ field: "task", kind: "text", about: "要查的事", slot: "要查的事" }],
    // 同一个会话里一次只查一件，上一件还没查完就不再查；查完回来、别人还没再说话时也不再查
    // （lookRun 在别人说话时归零）。场景探针里结果回来那一轮她又查了一遍同样的事，两次结果各叫醒她一次，
    // 同一句话说了两遍；结果里写着"再查一下"时也停得下来（花费上限）。
    available: (chat) => chat.member && chat.running === 0 && chat.lookRun === 0,
    // 不缓解任何驱动：意愿层不会为了"查一下"叫醒她。
    relieves: {},
    intrusiveness: flat(0),
    deliberate: true,
    via: "errand",
    gated: true,
    after: { type: "look", as: "你查了一下" },
    pending: (what, ago) => `我在查的事还没查完：${what}（${ago}开始查的）。`,
    outside: true,
  },
  {
    kind: "album-send",
    name: "send_photo",
    hint: "把相册里的一张图发出来（编号是翻相册时看到的）",
    appliesTo: ["chat"],
    args: [{ field: "asset", kind: "text", about: "图的编号", slot: "图的编号" }],
    // 只在这个会话里刚翻过相册之后出现：没看过就没有编号可发（探针里没翻就发，3/10 编了不存在的编号）。
    available: (chat, now) =>
      chat.member && chat.looked.some((l) => l.kind === "album-search" && now - l.at <= LOOKED_MS),
    relieves: { attention: 1, obligation: 0.5, cooling: 0.7, information: 0.5 },
    intrusiveness: SHOWING,
    deliberate: true,
    via: "telegram",
    gated: false,
    posts: { as: "photo", from: "text" },
  },
  {
    kind: "intend",
    name: "intend",
    hint: "记下你答应别人的事、或打算做的事",
    appliesTo: ["chat"],
    args: [
      {
        field: "when",
        kind: "when",
        optional: true,
        about: "什么时候，像今天、明天晚上、周五、下周、11月20日、两小时后；没说就不写",
      },
      { field: "what", kind: "text", about: "要做的事", slot: "要做的事" },
      // Gemini 写的原文（/home/alice/.local/share/alice-briefs/prompt-gemini/out-cross-intent.md 第一段）：她看不见会话的
      // 内部编号，只看得见群名和人名，所以写名字，由记忆认出是哪个会话（recall.ts placeNamed）。
      {
        field: "where",
        kind: "text",
        optional: true,
        sparse: true,
        slot: "在哪做",
        about:
          "要去哪个群或哪个人的私聊里做，就写那个群的名字或那个人的名字；就在当前聊天里做就不写",
      },
    ],
    available: () => true,
    relieves: {},
    intrusiveness: flat(0),
    deliberate: false,
    via: "mind",
    gated: true,
  },
  {
    kind: "fulfil",
    name: "fulfil",
    hint: "记下答应过或打算过的一件事已经做完了",
    appliesTo: ["chat"],
    args: [{ field: "what", kind: "text", about: "哪件事", slot: "哪件事" }],
    available: () => true,
    relieves: {},
    intrusiveness: flat(0),
    deliberate: false,
    via: "mind",
    gated: true,
  },
  {
    kind: "let-go",
    name: "let_go",
    hint: "对某条让你不舒服的话说算了、先不追究（之后记录里那一行会带个注）",
    appliesTo: ["message"],
    args: [{ field: "messageId", kind: "message", about: "哪条消息（编号）" }],
    available: () => true,
    relieves: {},
    intrusiveness: flat(0),
    deliberate: false,
    via: "mind",
    gated: true,
    after: { type: "annotate", note: "你说过这事先不追究了" },
  },
  {
    kind: "feel",
    name: "feel",
    hint: "记下你此刻的心情",
    appliesTo: ["chat"],
    args: [
      { field: "mood", kind: "mood", about: "心情" },
      { field: "why", kind: "text", optional: true, about: "原因，可以不写", slot: "为什么" },
      SECRET_ARG,
    ],
    available: () => true,
    relieves: {},
    intrusiveness: flat(0),
    deliberate: false,
    via: "mind",
    gated: true,
  },
  {
    // 2 月 diary()（ADR-82）；说明取自 2 月人格里的一句："Your diary is where you put the things you'd never say out loud."
    kind: "diary",
    name: "diary",
    // 写成什么时候写：逐代 A/B 第四代之前只说了是什么，日记只写了 0–2%（2 月 12–48%）。
    hint: "这一刻有让你在意、过后还会想起的事，想在日记里记一句说不出口的心里话",
    appliesTo: ["contact", "chat"],
    args: [
      {
        field: "about",
        kind: "message",
        optional: true,
        about: "关于谁，就写他说的那条消息的编号；不针对谁就不写",
      },
      { field: "entry", kind: "text", about: "心里话", slot: "心里话" },
    ],
    available: () => true,
    relieves: {},
    intrusiveness: flat(0),
    deliberate: false,
    via: "mind",
    gated: true,
  },
  {
    // 2 月 think()：每一轮先在心里过一下（2/17、2/19 两个峰值时刻每轮都有）。
    kind: "think",
    // 名字不用 think：推理模型在 think 里写分析式推理。
    name: "inner",
    // 写成"第一反应"而不是"先想清楚"：深思式的说法让她更冷静、更不鲜活；2 月的 think 是脱口而出的情绪
    // （scenes/candidates.md G2c）。要短：exec-mode 那一轮的写法。
    hint: "开口前心里闪过的真实念头，像自言自语，不用讲道理",
    appliesTo: ["chat"],
    args: [{ field: "thought", kind: "text", about: "心里想的", slot: "心里想的" }, SECRET_ARG],
    available: () => true,
    relieves: {},
    intrusiveness: flat(0),
    deliberate: false,
    via: "mind",
    gated: true,
  },
  // 她自己的事（2 月 threads.mod：begin_topic、advance、resolve_thread）：不是别人的话没接，是她自己要跟下去的事。
  // 和"打算"的分别：打算是答应过、有时有约定时间的一件事；这里是会有好几步、要跟一阵子的事。
  {
    kind: "topic-open",
    name: "open_topic",
    hint: "记下一件你想在这里跟下去、还没完的事",
    appliesTo: ["chat"],
    args: [{ field: "title", kind: "text", about: "这件事", slot: "这件事" }],
    available: () => true,
    relieves: {},
    intrusiveness: flat(0),
    deliberate: false,
    via: "mind",
    gated: true,
  },
  {
    kind: "topic-advance",
    name: "advance_topic",
    hint: "记下你跟着的那件事有了什么进展",
    appliesTo: ["chat"],
    args: [
      { field: "topic", kind: "text", about: "哪件事", slot: "哪件事" },
      { field: "beat", kind: "text", about: "到哪了", slot: "到哪了" },
    ],
    available: () => true,
    relieves: {},
    intrusiveness: flat(0),
    deliberate: false,
    via: "mind",
    gated: true,
  },
  {
    kind: "topic-close",
    name: "close_topic",
    hint: "记下你跟着的那件事已经了结",
    appliesTo: ["chat"],
    args: [{ field: "topic", kind: "text", about: "哪件事", slot: "哪件事" }],
    available: () => true,
    relieves: {},
    intrusiveness: flat(0),
    deliberate: false,
    via: "mind",
    gated: true,
  },
  {
    // 候选 bedtime（mechanisms/pressure/bedtime.ts）：说"我去睡了"不改变任何状态，下一条消息照样把她叫起来、
    // 她再道一次晚安（live 一夜对同一个人五次）。这一行是她真去睡了；只在夜里给（bedtime 的 offers）。
    kind: "bed",
    name: "go_to_bed",
    // bedtime 第一轮：真实那一夜剩下的宣布都在她选这一行之前（先口头道晚安，过一阵才选）。说晚安和去睡是同一件事。
    hint: "道晚安、要去睡觉的时候：说了晚安，你就是去睡了",
    appliesTo: ["chat"],
    args: [],
    available: () => true,
    relieves: {},
    intrusiveness: flat(0),
    deliberate: false,
    via: "mind",
    gated: true,
  },
  // 表达的方式（capabilities A16、A13、A27）：都不缓解任何驱动，意愿层不会为它们叫醒她；
  // 醒着、用得上时才出现在提示词里，用不用由她定。只由 mechanisms/voice.ts 提供（候选）。
  {
    kind: "voice",
    name: "voice",
    // "偶尔"和贴纸的"偶尔发"一样是软引导：每条都发语音的人不像真人；引导情绪表达与亲近重要时刻用声音，不写死台词。
    hint: "偶尔把一句想说的话用语音发出去，适合撒娇、护短、心情起伏想说得更真切，或者懒得打长字、深夜陪人聊天时",
    appliesTo: ["chat"],
    args: [{ field: "text", kind: "text", about: "要说的话" }],
    // 在哪都能发：群里有没有人发过语音是群里的习惯，跟不跟由她自己定（研究员 2026-11-12：发语音是她的自由；
    // 只软引导、不设门槛）。
    available: (chat) => chat.member,
    relieves: {},
    intrusiveness: SAYING,
    deliberate: true,
    via: "telegram",
    gated: true,
    posts: { as: "voice", from: "text" },
  },
  {
    kind: "edit",
    name: "edit",
    hint: "改你刚发的一条消息（打错字了、想改口）",
    appliesTo: ["message"],
    args: [
      { field: "messageId", kind: "own", about: "你刚发的哪条（编号）" },
      { field: "text", kind: "text", about: "改成的话", slot: "改好的话" },
    ],
    available: (chat, now) => chat.member && chat.own.some((m) => now - m.at <= EDIT_WINDOW_MS),
    relieves: {},
    intrusiveness: flat(0),
    deliberate: true,
    via: "telegram",
    gated: true,
    after: { type: "revise", note: "改过" },
  },
  {
    kind: "repeat",
    name: "repeat",
    hint: "跟着大家复读正在刷的那句话",
    appliesTo: ["message"],
    args: [{ field: "messageId", kind: "message", about: "大家在复读的那条（编号）" }],
    // 只在群里有人正在复读时：不同的人连着发同一句（ChatView.echo）。
    available: (chat) => chat.member && chat.chatType === "group" && chat.echo !== null,
    relieves: {},
    intrusiveness: SHOWING,
    deliberate: true,
    via: "telegram",
    gated: true,
    posts: { as: "text", from: "message" },
  },
  {
    // 2 月 search_public / preview_chat（A18）：看了才知道（像翻相册），结果回到这个会话。加不加由意愿层在那个群的
    // 会话里另做决定（join-chat），这里只是看。只由候选 reach 提供。
    kind: "chat-search",
    name: "find_chats",
    hint: "按关键词、@用户名或别人发来的 t.me 邀请链接查群和频道，看看简介、人数和最近几条",
    appliesTo: ["chat"],
    args: [
      {
        field: "query",
        kind: "text",
        about: "关键词、@用户名或 t.me 链接",
        slot: "想找的群",
      },
    ],
    available: member,
    // 不缓解任何驱动：意愿层不会为了"找群"叫醒她，醒着时想找才找。
    relieves: {},
    intrusiveness: flat(0),
    deliberate: true,
    via: "telegram",
    gated: true,
    after: { type: "look", as: "你找了找公开的群和频道" },
  },
  {
    // 2 月 forward_message、8 月 irc forward（A14）。受众规则（私聊里的永不转出；群里的只回同一个群或给当时在场的人）
    // 是隐私不变量，由 reach.ts mayForward 定义，执行器按它拒绝（telegram/shelf.ts）。只由候选 reach 提供。
    kind: "forward",
    name: "forward",
    hint: "把你在频道里看到的一条帖子原样转到这里",
    appliesTo: ["message"],
    args: [{ field: "item", kind: "text", about: "帖子的编号", slot: "编号" }],
    available: member,
    // 只缓解想分享的劲头：没有可转的东西时意愿层不会借"转发"的理由叫醒她（提示词里那时也没有这一项，
    // 醒来就会去说话，绕过说话的代价；同 react 只给新消息点表情的道理）。
    relieves: { information: 1 },
    intrusiveness: SHOWING,
    deliberate: true,
    via: "telegram",
    gated: true,
    posts: { as: "forward", from: "text" },
  },
  {
    kind: "recall",
    name: "recall",
    hint: "翻一下你自己的记忆：按关键词或人名查更早的日记、你说过的话、记住的事、开着的话头、承诺和今天的日程",
    appliesTo: ["chat"],
    args: [
      { field: "query", kind: "text", optional: true, about: "关键词（可省略）", slot: "关键词" },
      {
        field: "subject",
        kind: "text",
        optional: true,
        about: "谁或哪个会话（可省略）",
        slot: "对象",
      },
    ],
    available: () => true,
    relieves: {},
    intrusiveness: flat(0),
    deliberate: false,
    via: "mind",
    gated: true,
    after: { type: "look", as: "你翻了一下自己的记忆" },
  },
  {
    kind: "note-self",
    name: "note_self",
    hint: "记下或更正一条关于你自己的近况、习惯或说过的话（前后矛盾时用 replaces 换掉旧说法）",
    appliesTo: ["chat"],
    args: [
      { field: "text", kind: "text", about: "记下或改后的内容", slot: "内容" },
      {
        field: "replaces",
        kind: "text",
        optional: true,
        about: "要替换掉的旧说法原文（可省略）",
        slot: "旧说法",
      },
    ],
    available: () => true,
    relieves: {},
    intrusiveness: flat(0),
    deliberate: false,
    via: "mind",
    gated: true,
  },
  {
    kind: "dm-check",
    name: "check_dm",
    hint: "核对这个群对突然私聊群友的接受度、历史回应与是否建议先在群里征询同意",
    appliesTo: ["chat"],
    args: [
      {
        field: "who",
        kind: "text",
        optional: true,
        about: "群友名字或消息编号（在群里写明想私聊谁，在私聊可省略）",
        slot: "对象",
      },
    ],
    available: () => true,
    relieves: {},
    intrusiveness: flat(0),
    deliberate: false,
    via: "mind",
    gated: true,
    after: { type: "look", as: "你确认了一下这个群对私聊的接收度" },
  },
  {
    kind: "dm-defer",
    name: "plan_group_dm",
    hint: "先不在私聊里贸然开口，记下打算回到认识的群里顺口问一句对方方不方便私聊",
    appliesTo: ["chat"],
    args: [{ field: "reason", kind: "text", about: "想在群里先问的事由", slot: "事由" }],
    available: (chat) => chat.chatType === "private",
    relieves: {},
    intrusiveness: flat(0),
    deliberate: false,
    via: "mind",
    gated: true,
  },
] as const satisfies readonly Affordance[];

export const affordances: readonly Affordance[] = rows;

/** 经 Telegram 做的动作（telegram/acts.ts 的执行表每种一项）。 */
export type TelegramAct = Extract<
  Act,
  { kind: Extract<(typeof rows)[number], { via: "telegram" }>["kind"] }
>;

const byKind = new Map(affordances.map((a) => [a.kind, a]));

export function affordanceOf(kind: ActKind): Affordance {
  const row = byKind.get(kind);
  if (!row) throw new Error(`unregistered affordance: ${kind}`);
  return row;
}

export function isActKind(value: unknown): value is ActKind {
  return typeof value === "string" && byKind.has(value as ActKind);
}

/**
 * 此刻能不能做：要机制提供的行（gated）只在 provided 里有它时才算，再看这一行自己的条件。
 * 发言请求按它列出提示词里的动作；意愿层排序时也该用它（同一个判断）。
 */
export function offers(
  row: Pick<Affordance, "kind" | "gated" | "available">,
  chat: ChatView,
  now: number,
  provided: ReadonlySet<ActKind>,
): boolean {
  return (!row.gated || provided.has(row.kind)) && row.available(chat, now);
}

/** 会话里可以做的事，按登记表顺序。 */
export function availableKinds(
  chat: ChatView,
  now: number,
  provided: ReadonlySet<ActKind> = new Set(),
): ActKind[] {
  return affordances.filter((a) => offers(a, chat, now, provided)).map((a) => a.kind);
}

/**
 * 一个决定不算回应：里面全是不需要斟酌的动作（只标已读、心里记一笔）。说话、贴纸、表情、退群、查一下
 * 都是她做出来的事。
 */
export function isSilent(acts: readonly Act[]): boolean {
  return acts.every((a) => !affordanceOf(a.kind).deliberate);
}

/** 做完之后她在不在这个会话里（after.member）；不改变时是 undefined。 */
export function memberAfter(row: Pick<Affordance, "after">): boolean | undefined {
  return row.after?.type === "member" ? row.after.member : undefined;
}

/** 这个动作让她离开这个会话（退群）。 */
export function leaves(act: Act): boolean {
  return memberAfter(affordanceOf(act.kind)) === false;
}

/**
 * 一个动作按登记表参数顺序取出的值（可选参数没给时为 null）。Act 联合没法按 ArgSpec.field 取值，
 * 这是唯一一处按字段名读动作的地方。
 */
export function argValues(act: Act): Array<{ spec: ArgSpec; value: string | null }> {
  const fields = act as unknown as Record<string, string | null | undefined>;
  return affordanceOf(act.kind).args.map((spec) => ({ spec, value: fields[spec.field] ?? null }));
}

/** 动作里第一个这一类参数的值。 */
export function argOf(act: Act, kind: ArgKind): string | null {
  return argValues(act).find((a) => a.spec.kind === kind)?.value ?? null;
}

/**
 * 会在会话里留下一条她的消息的动作（posts）：消息的内容和种类。复读发出去的是那条原话，要从记录里找（find）；
 * 找不到时内容为空（不编）。
 */
export function postedMessage(
  act: Act,
  find: (messageId: string) => TimelineEntry | undefined = () => undefined,
): { text: string; kind: PostKind } | null {
  const posts = affordanceOf(act.kind).posts;
  if (!posts) return null;
  const value = argOf(act, posts.from) ?? "";
  const text = posts.from === "message" ? (find(value)?.text ?? "") : value;
  return { text, kind: posts.as };
}
