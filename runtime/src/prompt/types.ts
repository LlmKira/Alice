/**
 * ADR-220 + ADR-237: 声明式 User Prompt 数据类型。
 *
 * 核心原则：EntityRef 必须有 id + displayName，编译期保证。
 * 没有 displayName 的实体不进 prompt（根治 "(a group)" 问题）。
 *
 * 每个 Slot 字段都有决策目的注释——LLM 需要这个信息做什么。
 */

// ═══════════════════════════════════════════════════════════════════════════
// 场景类型（ADR-237：封闭状态空间 + Pydantic 风格封装）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ADR-237: 聊天目标类型 — 封闭状态空间，无非法组合。
 *
 * | 类型            | 含义                  | Instincts             |
 * |-----------------|----------------------|-----------------------|
 * | private_person  | 私聊人               | DM_INSTINCTS          |
 * | private_bot     | 私聊 Bot             | BOT_INSTINCTS         |
 * | group           | 群聊                 | GROUP_INSTINCTS       |
 * | channel_other   | 他人频道             | CHANNEL_INSTINCTS     |
 * | channel_owned   | 自己的频道           | OWNED_CHANNEL_INSTINCTS |
 */
export type ChatTargetType =
  | "private_person"
  | "private_bot"
  | "group"
  | "channel_other"
  | "channel_owned";

/**
 * ADR-237: ChannelClass — 四分法分类。
 *
 * 用于 rate cap、社交成本、门控行为等不需要区分 channel_owned/channel_other 的场景。
 */
export type ChannelClass = "private" | "group" | "channel" | "bot";

/**
 * ADR-237: ChatTarget — 场景判定封装类（Pydantic 风格）。
 *
 * 设计理念：
 * - 核心是 ChatTargetType（封闭状态空间）
 * - 派生属性通过 getter 暴露（Haskell-style derived）
 * - 判定逻辑集中在静态工厂方法
 * - 不可变（readonly），所有 getter 是纯函数
 *
 * @example
 * ```ts
 * const target = ChatTarget.from(chatType, isBot, aliceRole);
 * if (target.isPrivate) { ... }
 * const cls = target.channelClass; // 派生属性
 * ```
 */
export class ChatTarget {
  constructor(readonly type: ChatTargetType) {}

  // ── 派生属性（Haskell-style derived functions）──

  /** 四分法分类（rate cap / 社交成本用）。 */
  get channelClass(): ChannelClass {
    switch (this.type) {
      case "private_person":
        return "private";
      case "private_bot":
        return "bot";
      case "group":
        return "group";
      case "channel_other":
      case "channel_owned":
        return "channel";
      default: {
        const unreachable: never = this.type;
        throw new Error(`unknown chat target type: ${unreachable}`);
      }
    }
  }

  /** 是否私聊场景（人或 Bot）。 */
  get isPrivate(): boolean {
    return this.type === "private_person" || this.type === "private_bot";
  }

  /** 是否群聊场景。 */
  get isGroup(): boolean {
    return this.type === "group";
  }

  /** 是否频道场景（他人或自己）。 */
  get isChannel(): boolean {
    return this.type === "channel_other" || this.type === "channel_owned";
  }

  /** 是否自己的频道（策展人转发目标）。 */
  get isOwnedChannel(): boolean {
    return this.type === "channel_owned";
  }

  /** 是否 Bot 场景（私聊 Bot）。 */
  get isBot(): boolean {
    return this.type === "private_bot";
  }

  // ── 静态工厂（判定集中）──

  /**
   * 从 Telegram 信息判定场景类型。
   *
   * @param chatType - Telegram chat_type: "private" | "group" | "supergroup" | "channel"
   * @param isBot - 对方是否 Bot（仅 private 场景有效）
   * @param aliceRole - Alice 在频道中的角色：owner | admin | undefined
   */
  static from(
    chatType: string | undefined,
    isBot: boolean | undefined,
    aliceRole: string | undefined,
  ): ChatTarget {
    // 频道场景
    if (chatType === "channel") {
      const role = aliceRole?.toLowerCase();
      if (role === "owner" || role === "admin") {
        return new ChatTarget("channel_owned");
      }
      return new ChatTarget("channel_other");
    }

    // 群聊场景
    if (ChatTarget.isGroupChat(chatType)) {
      return new ChatTarget("group");
    }

    // 私聊场景：判断是人还是 Bot
    if (isBot === true) {
      return new ChatTarget("private_bot");
    }

    return new ChatTarget("private_person");
  }

  // ── 静态工具方法（替代散落的 chatType 判定）──

  /**
   * 判断 chatType 是否为群聊（group 或 supergroup）。
   *
   * 用于历史行动分类、压力计算等只需要 chatType 的场景。
   * 替代散落的 `chatType === "group" || chatType === "supergroup"`。
   */
  static isGroupChat(chatType: string | undefined): boolean {
    return chatType === "group" || chatType === "supergroup";
  }

  /**
   * 判断 chatType 是否为频道。
   */
  static isChannelChat(chatType: string | undefined): boolean {
    return chatType === "channel";
  }

  /**
   * 判断 chatType 是否为私聊。
   */
  static isPrivateChat(chatType: string | undefined): boolean {
    return chatType === "private";
  }

  // ── 工具方法 ──

  /** 类型相等判断。 */
  equals(other: ChatTargetType | ChatTarget): boolean {
    const otherType = typeof other === "string" ? other : other.type;
    return this.type === otherType;
  }

  /** 用于日志/调试。 */
  toString(): string {
    return `ChatTarget(${this.type})`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 向后兼容（过渡期保留函数形式，内部委托给 ChatTarget）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @deprecated 使用 ChatTarget.channelClass 属性
 */
export function toChannelClass(type: ChatTargetType): ChannelClass {
  return new ChatTarget(type).channelClass;
}

// ═══════════════════════════════════════════════════════════════════════════
// EntityRef — 编译期保证 id + displayName 共存
// ═══════════════════════════════════════════════════════════════════════════

export interface EntityRef {
  /** Telegram numeric ID（用于 irc forward --to @id 等命令）。 */
  id: number;
  /** 人类可读名（LLM 理解"跟谁对话"）。 */
  displayName: string;
  /** 聊天类型（影响行为模式）。 */
  chatType?: "private" | "group" | "supergroup" | "channel";
}

// ═══════════════════════════════════════════════════════════════════════════
// Message Slot — 每条消息
// ═══════════════════════════════════════════════════════════════════════════

/** 时间线条目（已渲染的 IRC 风格文本行）。 */
export interface TimelineSlot {
  /** 渲染后的文本行列表。 */
  lines: readonly string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Contact Slot — 频道社交全景中的联系人
// ═══════════════════════════════════════════════════════════════════════════

export interface ContactSlot {
  /** ref.id 用于 irc forward --to @id。 */
  ref: EntityRef;
  /** tier 语义标签（LLM 判断关系亲密度）。 */
  tierLabel: string;
  /** 显著特质（LLM 判断此人性格）。 */
  topTrait?: string;
  /** 兴趣列表（LLM 判断"谁会喜欢这个内容"）。 */
  interests: readonly string[];
  /** Telegram 用户签名（LLM 理解此人自我描述）。 */
  bio?: string;
  /** 最近一小时是否刚给该联系人分享过内容。 */
  sharedRecently?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Group Slot — 频道社交全景中的群组
// ═══════════════════════════════════════════════════════════════════════════

export interface GroupSlot {
  /** ref.id 用于转发目标。 */
  ref: EntityRef;
  /** 群组话题（LLM 判断内容是否匹配）。 */
  topic?: string;
  /** 群组兴趣列表。 */
  interests: readonly string[];
  /** 群组简介（LLM 理解群组定位）。 */
  bio?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// OwnedChannelSlot — Alice 拥有/管理的频道（转发目标）
// ═══════════════════════════════════════════════════════════════════════════

/** Alice 的频道（ADR-237：策展人转发目标）。 */
export interface OwnedChannelSlot {
  /** ref.id 用于 irc forward --to @id。 */
  ref: EntityRef;
  /** 角色标识。 */
  role: "owner" | "admin";
}

// ═══════════════════════════════════════════════════════════════════════════
// Thread Slot — 活跃线程
// ═══════════════════════════════════════════════════════════════════════════

export interface ThreadSlot {
  /** 线程 ID（LLM 需要它调用 topic_advance #id）。 */
  threadId: string;
  /** 线程标题（LLM 理解"在聊什么"）。 */
  title: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Feedback Slot — 行动反馈
// ═══════════════════════════════════════════════════════════════════════════

export interface FeedbackSlot {
  /** 反馈文本（LLM 理解上一轮行动的结果）。 */
  text: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Presence Slot — 对话状态（防复读）
// ═══════════════════════════════════════════════════════════════════════════

export interface PresenceSlot {
  /** Alice 尾部连发消息数。 */
  trailingYours: number;
  /** 最近一条 outgoing 消息预览。 */
  lastOutgoingPreview?: string;
  /** 距最近一条 outgoing 消息的人类可读时间。 */
  lastOutgoingAgo?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// RecapSegment — 对话回顾分段。层①即时场景。
// ═══════════════════════════════════════════════════════════════════════════

/** 历史对话分段摘要（LLM 理解"之前聊了什么"）。 */
export interface RecapSegment {
  /** 时间范围描述（如 "2h ago — 1h ago"）。 */
  timeRange: string;
  /** 该段消息数。 */
  messageCount: number;
  /** 首条消息预览。 */
  first: string;
  /** 末条消息预览。 */
  last: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// ContactProfileSlot — 联系人详细画像。层②关系上下文。
// ═══════════════════════════════════════════════════════════════════════════

/** 联系人详细画像（仅私聊：portrait + traits + interests）。 */
export interface ContactProfileSlot {
  /** LLM 生成的综合印象。 */
  portrait?: string;
  /** 结晶特质标签。 */
  traits: readonly string[];
  /** 结晶兴趣。 */
  interests: readonly string[];
  /** Telegram 用户签名（来自 bio_cache）。 */
  bio?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// JargonSlot — 群组黑话。层②关系上下文。
// ═══════════════════════════════════════════════════════════════════════════

/** 群组黑话（LLM 适配群聊文化）。 */
export interface JargonSlot {
  /** 术语。 */
  term: string;
  /** 释义。 */
  meaning: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// FeedItemSlot — Feed 条目。层①即时场景（频道）。
// ═══════════════════════════════════════════════════════════════════════════

/** Feed 条目（互联网内容源）。 */
export interface FeedItemSlot {
  /** 标题。 */
  title: string;
  /** 链接。 */
  url: string;
  /** 摘要。 */
  snippet: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// UserPromptSnapshot — 全量快照
// ═══════════════════════════════════════════════════════════════════════════

export interface UserPromptSnapshot {
  // ── 场景（ADR-237：封闭状态空间）──
  /** ADR-237: 聊天目标类型 — 场景判定的唯一真相源。 */
  chatTargetType: ChatTargetType;

  // ── 时间 ──
  /** 墙钟时间（ms）。 */
  nowMs: number;
  /** 用户时区偏移（小时），如 UTC+8 → 8。 */
  timezoneOffset: number;

  /** ADR-268: Alice 自身情绪 episode 的自然语言投影。 */
  emotionProjection?: string;
  /** ADR-268: 当前情绪控制调制转成的自然表达提示。 */
  emotionStyleHint?: string;

  // ── 目标 ──
  /** 当前对话的目标实体（私聊=对方，群聊=群组，频道=频道）。 */
  target?: EntityRef;

  // ── 群组元信息（仅 group 场景）──
  groupMeta?: {
    topic?: string;
    /** Alice 是否被 directed（有人@Alice 或回复 Alice）。 */
    directed: boolean;
    /** 群组参与情况描述（成员数等）。 */
    membersInfo?: string;
    /** 群聊限制（can't send stickers, etc.）。 */
    restrictions?: string;
    /** 群组简介（来自 bio_cache）。 */
    bio?: string;
  };

  // ── 频道社交全景（仅 channel 场景）──
  contacts: readonly ContactSlot[];
  groups: readonly GroupSlot[];
  /** ADR-237: Alice 的频道（策展人转发目标）。 */
  ownedChannels: readonly OwnedChannelSlot[];

  // ── 消息流（统一时间线）──
  timeline: TimelineSlot;

  // ── 对话状态（防复读）──
  presence?: PresenceSlot;

  // ── 线程 ──
  threads: readonly ThreadSlot[];

  // ── 社交 case ──
  /** Alice-centered social case brief lines for the current prompt surface. */
  socialCaseLines: readonly string[];

  // ── 行动反馈 ──
  feedback: readonly FeedbackSlot[];

  // ── 内心低语（从 facet 获取）──
  whisper: string;

  // ── 轮次感知 ──
  roundHint?: string;
  /** ADR-232: TC episode 提示（host 续轮时，告知 LLM 结果已在 observations 中）。 */
  episodeHint?: string;

  // ── 私聊对象关系描述（仅 private 场景）──
  relationshipDesc?: string;

  // ── 层① 即时场景扩展 ──
  /** 历史对话分段摘要（LLM 理解"之前聊了什么"）。层①。 */
  conversationRecap: readonly RecapSegment[];

  // ── 层② 关系上下文扩展 ──
  /** 联系人详细画像（仅私聊：portrait + traits）。层②。 */
  contactProfile?: ContactProfileSlot;
  /** 对方心情（语义标签，影响 Alice 语气选择）。层②。 */
  contactMood?: string;
  /** 群组黑话（LLM 适配群聊文化）。层②。 */
  jargon: readonly JargonSlot[];

  // ── 层③ 战略全景扩展 ──
  /** 全局感知信号（谁在等、谁在漂移、哪个群活跃）。层③。 */
  situationSignals: readonly string[];
  /** 当前对象节律提示（语义投影，不包含 harmonic 参数）。层③。 */
  timingSignals?: readonly string[];
  /** 触发的定时任务。层③。 */
  scheduledEvents: readonly string[];
  /** 风险标记。层③。 */
  riskFlags: readonly string[];

  // ── 层④ 内在世界扩展 ──
  // diary 已移至 diary.mod.ts contribute()（唯一注入路径）。
  // @see ADR-225: 消除双路注入。
  /** Episode 因果残留（跨 engagement 连贯性）。层④。 */
  episodeCarryOver?: string;

  // ── 层④ 社交接收度（ADR-156）──
  /** 群组社交接收度 ∈ [-1, 1]。warm>0, cold<0, hostile<-0.5。仅群组场景。 */
  socialReception?: number;

  // ── 层⑤ 行动约束扩展 ──
  /** 降级行动标志（压力预算不足时限制输出）。层⑤。 */
  isDegraded: boolean;
  /** 当前对话话题（用于 "You were talking about: X"）。层⑤。 */
  openTopic?: string;

  // ── 频道专属 ──
  /** Feed 条目（互联网内容源）。 */
  feedItems: readonly FeedItemSlot[];
}
