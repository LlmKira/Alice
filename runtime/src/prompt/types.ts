/**
 * ADR-220: 声明式 User Prompt 数据类型。
 *
 * 核心原则：EntityRef 必须有 id + displayName，编译期保证。
 * 没有 displayName 的实体不进 prompt（根治 "(a group)" 问题）。
 *
 * 每个 Slot 字段都有决策目的注释——LLM 需要这个信息做什么。
 */

// ═══════════════════════════════════════════════════════════════════════════
// 场景枚举
// ═══════════════════════════════════════════════════════════════════════════

export type Scene = "channel" | "group" | "private";

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
  // ── 场景 ──
  scene: Scene;

  // ── 时间 ──
  /** 墙钟时间（ms）。 */
  nowMs: number;

  // ── 心情（语义标签，非数值）──
  moodLabel: string;

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

  // ── 消息流（统一时间线）──
  timeline: TimelineSlot;

  // ── 对话状态（防复读）──
  presence?: PresenceSlot;

  // ── 线程 ──
  threads: readonly ThreadSlot[];

  // ── 行动反馈 ──
  feedback: readonly FeedbackSlot[];

  // ── 内心低语（从 facet 获取）──
  whisper: string;

  // ── 轮次感知 ──
  roundHint?: string;
  /** ADR-232: TC episode 提示（watching 续轮时，告知 LLM 结果已在 observations 中）。 */
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
