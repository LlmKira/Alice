/**
 * 图实体类型定义 — ADR-154 WorldModel clean-room rewrite。
 *
 * 设计原则：
 *   1. ZERO imports from telegram/ — 修复依赖反转
 *   2. 属性分层：Core（无 ?）、Observable（?）、Shadow（? 之前未声明现显式化）
 *   3. 不包含 ephemeral action result 类型 — 它们属于 CQRS 层
 *
 * 属性分层说明：
 *   Core       — addEntity 默认值保证存在（无 `?`）
 *   Observable — Mod/mapper 写入，pressure/engine/voices 读取（带 `?`）
 *   Shadow     — 以前通过 setNodeAttr 隐式写入，现在显式声明（带 `?`）
 *
 * @see paper-five-dim §3.1 Definition 3.1 (World Model)
 * @see docs/adr/154-world-model-rewrite.md
 */
import type { BeliefDict } from "../belief/store.js";

// -- Branded ID types (ADR-155) ----------------------------------------------
// 编译期区分 Telegram 数字 ID 和图节点 ID，消灭隐式 string ↔ nodeId 混用。
// @see docs/adr/155-branded-graph-id.md

declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

/** Telegram 原生数字 ID（用户正数，频道/超群 -100xxxx）。 */
export type TelegramId = Brand<number, "TelegramId">;

/** 频道图节点 ID，格式 `channel:<platform>:<nativeId>`。 */
export type ChannelNodeId = Brand<string, "ChannelNodeId">;

/** 联系人图节点 ID，格式 `contact:<platform>:<nativeId>`。 */
export type ContactNodeId = Brand<string, "ContactNodeId">;

/** 对话会话图节点 ID，格式 `conversation:<channelId>_<tick>`。 */
export type ConversationNodeId = Brand<string, "ConversationNodeId">;

/** 任何图节点 ID 的联合类型。 */
export type GraphNodeId = ChannelNodeId | ContactNodeId | ConversationNodeId | "self";

// -- 枚举 -------------------------------------------------------------------

export const NodeType = {
  AGENT: "agent",
  CONTACT: "contact",
  THREAD: "thread",
  CHANNEL: "channel",
  /** ADR-154: info_item → fact 重命名。 */
  FACT: "fact",
  CONVERSATION: "conversation", // ADR-26 §3
} as const;
export type NodeType = (typeof NodeType)[keyof typeof NodeType];

export const EdgeCategory = {
  SPATIAL: "spatial",
  SOCIAL: "social",
  COGNITIVE: "cognitive",
  CAUSAL: "causal",
  OWNERSHIP: "ownership",
} as const;
export type EdgeCategory = (typeof EdgeCategory)[keyof typeof EdgeCategory];

export type DunbarTier = 5 | 15 | 50 | 150 | 500;

/**
 * ADR-43: 关系类型 — 与 tier（亲密度）正交的维度。
 *
 * tier 表示"有多亲密"，relationType 表示"是什么关系"。
 * 两者组合产生二维关系空间：
 *   tier=5  + romantic     → 热恋期（撒娇、想念、担心）
 *   tier=5  + close_friend → 老铁（毒舌、深聊、直接）
 *   tier=150 + colleague   → 普通同事（礼貌、话题导向）
 *
 * @see docs/adr/43-m1.5-feedback-loop-relation-type.md §P1
 * @see docs/adr/39-north-star-gap-analysis.md §Gap4
 */
export type RelationType =
  | "romantic"
  | "close_friend"
  | "friend"
  | "family"
  | "colleague"
  | "acquaintance"
  | "unknown";

export type ThreadWeight = "trivial" | "minor" | "major" | "critical" | "subtle";

export type ChatType = "private" | "group" | "supergroup" | "channel";

// -- 节点属性接口 -----------------------------------------------------------

/**
 * Agent（自身）节点属性。论文 V_A。
 */
export interface AgentAttrs {
  entity_type: typeof NodeType.AGENT;
  // -- Core --
  mood_valence: number;
  /** mood 设置的墙钟时间（ms）。 */
  mood_set_ms: number;
  /** 节点创建的墙钟时间（ms）。 */
  created_ms?: number;
  // -- Observable (engine/observer 维护) --
  /** 衰减后的有效情绪（selfMoodDecay 每 tick 计算）。 */
  mood_effective?: number;
  mood_arousal?: number;
  /** mood shift 的墙钟时间（ms）。 */
  mood_shift_ms?: number;
  mood_shift?: string;
  // -- Personality state (index.ts / personality-drift 维护) --
  personality_weights?: string;
  pi_home?: string;
  /** @internal 引擎内部数值，不暴露给 LLM。以 _ 前缀写入图。 */
  _personality_drift?: number;
  /** @internal 引擎内部数值，不暴露给 LLM。以 _ 前缀写入图。 */
  _personality_velocity?: number;
  personality_health?: string;
  /** runtime 最近确认仍在运行的墙钟时间（ms）。用于启动时判断真实进程离线时长。 */
  runtime_last_seen_ms?: number;
  /** runtime 优雅退出写入的墙钟时间（ms）。用于启动恢复判定。 */
  runtime_shutdown_ms?: number;
  // -- Profile --
  display_name?: string;
  bio?: string;
  /** 当前思考目标（thinking 行动写入）。 */
  thinking_target?: string | null;
  /** Alice 主动选择休息/睡觉到此墙钟时间（ms）。 */
  resting_until_ms?: number;
  /** 最近进入 resting 的墙钟时间（ms）。 */
  resting_since_ms?: number;
  /** 休息原因，供诊断和 prompt 投影使用。 */
  resting_reason?: string;
  /**
   * ADR-268: append-only self emotion episode ledger, JSON encoded.
   * Internal graph-backed transition storage; normal prompt must read the projection.
   */
  emotion_episodes?: string;
  /** ADR-268: derived current emotion state, JSON encoded. */
  emotion_state?: string;
  /** ADR-268: derived bounded control patch, JSON encoded. */
  emotion_control?: string;
  /**
   * ADR-268: transient repair fact cache for isolated tests/probes without DB.
   * Production authority is the append-only emotion_repairs table.
   */
  emotion_repairs?: string;
}

/**
 * 联系人节点属性。论文 V_C。
 */
export interface ContactAttrs {
  entity_type: typeof NodeType.CONTACT;
  // -- Core --
  tier: DunbarTier;
  /** 联系人最后活跃的墙钟时间（ms）。 */
  last_active_ms: number;
  /** test fixture 使用。 */
  auth_level: number;
  interaction_count: number;
  display_name?: string;
  /** 联系人语言偏好（由 Reflection LANGUAGE 指令更新）。 */
  language_preference?: string;
  /** ADR-43: 关系类型（与 tier 正交）。默认 "unknown"。 */
  relation_type?: RelationType;
  /** ADR-43: 关系类型上次更新的墙钟时间（ms）。 */
  relation_type_set_ms?: number;
  // -- Observable (mapper/observer 维护) --
  is_bot?: boolean;
  /** returning 标记的墙钟时间（ms）。 */
  returning_ms?: number;
  /** 最后 reaction 的墙钟时间（ms）。 */
  last_reaction_ms?: number;
  last_reaction_emoji?: string;
  /** reaction 社交张力注入的墙钟时间（ms）。 */
  reaction_boost_ms?: number;
  /** tier 变更的墙钟时间（ms）。 */
  tier_changed_ms?: number;
  tier_direction?: "upgrade" | "downgrade";
  // -- Observable (feel / flag_risk / observe_activity / DECLARE_ACTION / rate_outcome) --
  mood_valence?: number;
  mood_arousal?: number;
  /** mood 变化的墙钟时间（ms）。 */
  mood_shift_ms?: number;
  mood_shift?: string;
  /** Alice 最后行动的墙钟时间（ms）。 */
  last_alice_action_ms?: number;
  last_outcome_quality?: number;
  /** outcome 评估的墙钟时间（ms）。 */
  last_outcome_ms?: number;
  social_debt_direction?: string;
  risk_level?: "none" | "low" | "medium" | "high";
  /** risk 更新的墙钟时间（ms）。 */
  risk_updated_ms?: number;
  risk_reason?: string;
  activity_type?: string;
  activity_intensity?: number;
  activity_relevance?: number;
  // -- P1-1: 互惠追踪（per-contact 发起方向计数） --
  /** Alice 主动发起互动的次数（不含回复）。perceive+observer 维护。 */
  alice_initiated_count?: number;
  /** 对方主动发起互动的次数（不含回复）。mapper 维护。 */
  contact_initiated_count?: number;
  // -- Goldilocks Window 自适应状态 (ADR-154) --
  /** 交互间隔 EMA（秒）。Goldilocks 自适应窗口用。@see docs/adr/154-goldilocks-window/ */
  ema_contact_interval_s?: number;
  // -- Hawkes 自激过程状态 (ADR-153) --
  /** Hawkes λ_carry 累积激发量。@see docs/adr/153-per-contact-hawkes/ */
  hawkes_carry?: number;
  /** Hawkes 上次事件的墙钟时间 (ms)。 */
  hawkes_last_event_ms?: number;
  /** 用于在线校准权重的事件计数。 */
  hawkes_event_count?: number;
  /** 首次事件的墙钟时间 (ms)。与 event_count 配合计算累积观测 μ_obs。 */
  hawkes_first_event_ms?: number;
  // -- 关系向量 (ADR-178) --
  /** @see docs/adr/178-relationship-vector-field.md */
  rv_familiarity?: number;
  rv_trust?: number;
  rv_affection?: number;
  rv_attraction?: number;
  rv_respect?: number;
  /** 各维度一阶导数（EMA 平滑的 velocity）。 */
  rv_vel_familiarity?: number;
  rv_vel_trust?: number;
  rv_vel_affection?: number;
  rv_vel_attraction?: number;
  rv_vel_respect?: number;
  /** 各维度上次更新的墙钟时间 (ms)。 */
  rv_familiarity_ms?: number;
  rv_trust_ms?: number;
  rv_affection_ms?: number;
  rv_attraction_ms?: number;
  rv_respect_ms?: number;
  /** 导出量：关系阶段（从向量+velocity 每 tick 重算）。 */
  romantic_phase?: string;
  // -- GC (maintenance mark-sweep) --
  reachability_score?: number;
  failure_type?: string | null;
  /** GC 候选标记的墙钟时间（ms）。 */
  gc_candidate_ms?: number | null;
}

/**
 * 线程节点属性。论文 V_T。
 */
export interface ThreadAttrs {
  entity_type: typeof NodeType.THREAD;
  /** @see docs/adr/134-temporal-coherence.md §D3 — "expired" = 7 天未活动自动过期。 */
  status: "open" | "resolved" | "expired";
  weight: ThreadWeight;
  /** THREAD_WEIGHTS[weight] 的数值映射。 */
  w: number;
  /** 创建时间（墙钟 ms）。ADR-154: 从 tick 改为 wall-clock ms。 */
  created_ms: number;
  deadline: number; // Infinity 表示无截止
  title?: string;
  horizon?: number;
  /** ADR-64 VI-2: 线程叙事摘要。 */
  summary?: string;
  /** ADR-104: 线程产生的来源频道（act 阶段从 targetNodeId 推断）。 */
  source_channel?: string;
  /** ADR-115: 线程来源——对话产生 vs 系统内源性生成 vs 自动聚类。 */
  source?: "conversation" | "system" | "auto";
  /** ADR-134 D3: 最后活动的墙钟时间（ms）。advance/thread_review 更新。 */
  last_activity_ms?: number;
  /** 截止日期的墙钟时间（ms）。ADR-154: 从 tick 改为 wall-clock ms。 */
  deadline_ms?: number;
}

/**
 * 频道节点属性。论文 V_H。
 */
export interface ChannelAttrs {
  entity_type: typeof NodeType.CHANNEL;
  // -- Core --
  unread: number;
  tier_contact: DunbarTier;
  chat_type: ChatType;
  pending_directed: number;
  /** 最后 directed 消息的墙钟时间（ms）。 */
  last_directed_ms: number;
  display_name?: string;
  // -- Observable (observer/mapper 维护，pressure/engine 读取) --
  /** Alice 最后行动的墙钟时间（ms）。 */
  last_alice_action_ms?: number;
  last_outgoing_text?: string;
  consecutive_outgoing?: number;
  risk_level?: "none" | "low" | "medium" | "high";
  /** risk 更新的墙钟时间（ms）。 */
  risk_updated_ms?: number;
  risk_reason?: string;
  activity_type?: string;
  activity_intensity?: number;
  activity_relevance?: number;
  /** 最近清理的墙钟时间（ms）。 */
  recently_cleared_ms?: number;
  mentions_alice?: boolean;
  last_sender_is_bot?: boolean;
  last_content_type?: string;
  /** 频道最后 reaction 的墙钟时间（ms）。 */
  last_reaction_ms?: number;
  // -- D5: Social Cost 追踪 --
  /** Alice 在该频道中的角色（owner/admin/member/restricted），perceive 阶段写入。 */
  alice_role?: string;
  /** Alice 在当前窗口内发送的消息数（D4 writeback 更新）。 */
  alice_sent_window?: number;
  /** 对方在当前窗口内发送的消息数（perceive 更新）。 */
  contact_recv_window?: number;
  // -- Observable (act/reachability 维护) --
  reachability_score?: number;
  consecutive_act_failures?: number;
  failure_type?: string | null;
  failure_subtype?: string | null;
  /** GC 候选标记的墙钟时间（ms）。 */
  gc_candidate_ms?: number | null;
  mood_valence?: number;
  /** mood 变化的墙钟时间（ms）。 */
  mood_shift_ms?: number;
  mood_shift?: string;
  consecutive_act_silences?: number;
  /** ACT 沉默最近一次递增的墙钟时间（ms）。σ_fail 时间衰减用。 @see docs/adr/136-constrained-vmax/README.md §2.3 */
  last_act_silence_ms?: number;
  /** 最后主动外联的墙钟时间（ms）。 */
  last_proactive_outreach_ms?: number;
  alice_thinking_since?: number | null;
  /** 频道最后活动的墙钟时间（ms）。用于群组 P3 S3 保护。 */
  last_activity_ms?: number;
  /** 最近收到消息的墙钟时间（ms）。P1 effectiveUnread 新鲜度衰减用。 @see docs/adr/134-temporal-coherence.md §D2 */
  last_incoming_ms?: number;
  /** EWMS 累加器——精确的指数加权未读和。 @see docs/adr/150-ewms-exact-unread-decay.md §D1 */
  unread_ewms?: number;
  /** EWMS 最后更新时间（ms）。 @see docs/adr/150-ewms-exact-unread-decay.md §D1 */
  unread_ewms_ms?: number;
  topic?: string;
  // -- Mapper/action 维护 --
  /** 加入频道的墙钟时间（ms）。 */
  join_ms?: number;
  apprentice_msg_count?: number;
  participation_ratio?: number;
  social_debt_direction?: "alice_owes" | "contact_owes" | null;
  last_outcome_quality?: number;
  /** outcome 评估的墙钟时间（ms）。 */
  last_outcome_ms?: number;
  // -- Shadow attrs（之前通过 setNodeAttr 隐式写入，现显式声明） --
  /** 延迟评估到期时间（ms）。@see runtime/src/engine/generators.ts, runtime/src/telegram/actions/group.ts */
  deferred_eval_ms?: number | null;
  /** 名字提及的墙钟时间（ms）。@see runtime/src/telegram/mapper.ts */
  mentions_alice_ms?: number;
  /** 安全标记（消息安全级别）。@see runtime/src/telegram/mapper.ts */
  safety_flag?: string;
  /** safety_flag 设置时间（ms）。@see runtime/src/mods/observer.mod.ts */
  safety_flag_ms?: number;
  /** 最后发送的消息 ID。@see runtime/src/engine/react/orchestrator.ts */
  last_sent_msg_id?: number;
  /** 最后外发消息的墙钟时间（ms）。@see runtime/src/mods/observer.mod.ts */
  last_outgoing_ms?: number;
  /** 最后 directed 消息文本（CA 邻接对引用）。@see runtime/src/pressure/situation-lines.ts */
  last_directed_text?: string;
  // -- Hawkes 群组热度状态 (ADR-153) --
  /** 群组 directed Hawkes λ_carry（仅计 directed/mentions 事件）。@see docs/adr/153-per-contact-hawkes/ */
  hawkes_carry?: number;
  /** 群组 Hawkes 上次相关事件的墙钟时间 (ms)。 */
  hawkes_last_event_ms?: number;
  // -- ADR-206: 频道信息流属性 --
  /** 频道内容领域标签（从频道描述/历史内容推断）。@see docs/adr/206-channel-information-flow/ §3 */
  content_domain?: string;
  /** Alice 最后阅读频道的墙钟时间（ms）。信息饥渴计算用。@see docs/adr/206-channel-information-flow/ §3 */
  last_read_ms?: number;
  /** 订阅健康度 ∈ [0,1]。长期不读 → 衰减 → 考虑退订。@see docs/adr/206-channel-information-flow/ §5 */
  subscription_health?: number;
  /** 上次从此频道分享内容的时间（ms）。ADR-206 C3 分享频率限制。 */
  last_shared_ms?: number;
  /** 上次发布到此频道的时间（ms）。ADR-206 C4 发布门控。仅 admin/owner。 */
  last_publish_ms?: number;
  /**
   * ADR-217: 社交回避强度 ∈ [0, 1]。0 = 无回避，1 = 完全回避。
   * 压力场原生排斥力——在 IAUS 层乘性调制目标价值：V_eff = V × (1 - aversion)。
   * 不被 directed 消息重置（与 act_silences 分离）。
   * @see docs/adr/217-pressure-field-aversion-gap.md
   */
  aversion?: number;
  /** 回避事件的墙钟时间（ms）。指数衰减用。 */
  aversion_ms?: number;
  /**
   * ADR-222: 适应性衰减累积值 H(v) ≥ 0。
   * 每次 Alice 对此频道行动后 H += 1.0，指数衰减回 0。
   * ρ_H = 1/(1 + α·H_eff) 调制 P5 以外的压力张力。
   * @see docs/adr/222-habituation-truth-model.md
   */
  habituation?: number;
  /** H(v) 上次更新的墙钟时间（ms）。指数衰减基准。 */
  habituation_ms?: number;
}

/**
 * 事实节点属性。论文 V_I。
 *
 * ADR-154: info_item → fact 重命名。
 *
 * 从 MemorizedFact（Mod state 平坦数组）迁移到图节点：
 * 每条事实是一个 fact 节点，通过 "knows" 边连接到 contact/agent。
 * 这使 P2 遗忘曲线能遍历到实际数据。
 *
 * @see paper/ §3.2 "Information Pressure"
 */
export interface FactAttrs {
  entity_type: typeof NodeType.FACT;
  // -- Core (P2 遗忘曲线) --
  importance: number; // [0,1] 事实重要性
  stability: number; // SM-2 稳定性参数
  /** 上次访问的墙钟时间（ms）。ADR-154: 从 tick 改为 wall-clock ms。 */
  last_access_ms: number;
  volatility: number; // 信息时变性
  tracked: boolean; // 是否追踪陈旧度
  /** 创建时间（墙钟 ms）。ADR-154: 从 tick 改为 wall-clock ms。 */
  created_ms: number;
  novelty: number; // 新奇度
  // -- 从 MemorizedFact 迁移 --
  content?: string; // 事实内容
  fact_type?: string; // interest/preference/skill/...
  reinforcement_count?: number; // 去重强化计数
  // -- 来源追踪 --
  source_contact?: string; // 来源联系人 ID
  source_channel?: string; // 来源频道 ID
  /** ADR-69: 区分 LLM 主动记录 vs perceive 自动提取 vs 压缩合并。 */
  source?: "llm" | "perceive" | "consolidation";
  // -- 情感反应度 (ADR-156) --
  /** 情感反应度 [0,1]。1=强烈情绪触发，0=纯信息性。指数衰减。 @see docs/adr/156-emotional-reactivity-damping.md */
  reactivity?: number;
  /** reactivity 设置/更新的墙钟时间 (ms)。 */
  reactivity_ms?: number;
}

// -- ADR-26 §3: 对话会话实体 ------------------------------------------------

export type ConversationState = "pending" | "opening" | "active" | "closing" | "cooldown";
export type TurnState = "alice_turn" | "other_turn" | "open" | "closed";

/**
 * 对话会话节点属性。ADR-26 扩展。
 */
export interface ConversationAttrs {
  entity_type: typeof NodeType.CONVERSATION;
  channel: string;
  participants: string[];
  state: ConversationState;
  /** 对话开始的墙钟时间（ms）。 */
  start_ms: number;
  /** 最后活动的墙钟时间（ms）。 */
  last_activity_ms: number;
  turn_state: TurnState;
  pace: number;
  message_count: number;
  alice_message_count: number;
  topic?: string;
  /** leave / 超时进入 closing 的墙钟时间（ms）。门控时间戳精确比较用。 */
  closing_since_ms?: number;
}

// -- 联合类型 ---------------------------------------------------------------

export type NodeAttrs =
  | AgentAttrs
  | ContactAttrs
  | ThreadAttrs
  | ChannelAttrs
  | FactAttrs
  | ConversationAttrs;

// -- 判别联合 (ADR-154) ----------------------------------------------------

/** 判别联合：通过 type 字段区分节点类型，便于 switch/if narrowing。 */
export type NodeEntry =
  | { type: "agent"; attrs: AgentAttrs }
  | { type: "contact"; attrs: ContactAttrs }
  | { type: "channel"; attrs: ChannelAttrs }
  | { type: "thread"; attrs: ThreadAttrs }
  | { type: "fact"; attrs: FactAttrs }
  | { type: "conversation"; attrs: ConversationAttrs };

// -- 辅助类型 ---------------------------------------------------------------

/** 从实体属性接口中去掉 entity_type 后取 Partial，用于 patch 更新。 */
export type Mutable<T extends { entity_type: string }> = Partial<Omit<T, "entity_type">>;

// -- NodeType → Attrs 映射 ---------------------------------------------------

/** 从 NodeType 字面量映射到对应的属性接口。 */
export interface NodeAttrsMap {
  agent: AgentAttrs;
  contact: ContactAttrs;
  thread: ThreadAttrs;
  channel: ChannelAttrs;
  fact: FactAttrs;
  conversation: ConversationAttrs;
}

// -- 边数据 -----------------------------------------------------------------

export interface EdgeData {
  label: string;
  category: EdgeCategory;
  [key: string]: unknown;
}

// -- 序列化格式 -------------------------------------------------------------

export interface SerializedNode {
  id: string;
  entity_type: string;
  [key: string]: unknown;
}

export interface SerializedEdge {
  src: string;
  dst: string;
  label: string;
  category: string;
  [key: string]: unknown;
}

export interface SerializedGraph {
  tick: number;
  nodes: SerializedNode[];
  edges: SerializedEdge[];
  /** Social POMDP: 信念快照（ADR-123 结构化格式）。 */
  beliefs?: BeliefDict;
}
