/**
 * Drizzle ORM schema：graph_nodes, graph_edges, tick_log, action_log, mod_states 等。
 */
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** 图快照：JSON 序列化的 WorldModel。 */
export const graphSnapshots = sqliteTable(
  "graph_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tick: integer("tick").notNull(),
    graphJson: text("graph_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_graph_snapshots_tick").on(t.tick)],
);

/** Tick 日志：每 tick 的压力值和选中行动。 */
export const tickLog = sqliteTable(
  "tick_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tick: integer("tick").notNull(),
    p1: real("p1").notNull(),
    p2: real("p2").notNull(),
    p3: real("p3").notNull(),
    p4: real("p4").notNull(),
    p5: real("p5").notNull(),
    p6: real("p6").notNull(),
    api: real("api").notNull(),
    /** ADR-195: Peak-based API（驱动 tick 间隔）。 */
    apiPeak: real("api_peak"),
    action: text("action"),
    target: text("target"),
    /** ADR-115: V(a,n) 最终净社交价值。 */
    netValue: real("net_value"),
    /** ADR-115: ΔP 预期压力降低量。 */
    deltaP: real("delta_p"),
    /** ADR-115: C_social 社交成本。 */
    socialCost: real("social_cost"),
    /** ADR-115: softmax 选中概率。 */
    selectedProbability: real("selected_probability"),
    /** ADR-115: 统一决策结果标签 (enqueue|system1:ACTION|silent:LEVEL|skip:REASON)。 */
    gateVerdict: text("gate_verdict"),
    /** ADR-115: Agent Mode (patrol|conversation|consolidation)。 */
    mode: text("mode"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_tick_log_tick").on(t.tick)],
);

/** 行动日志：LLM 生成的行动执行记录。 */
export const actionLog = sqliteTable(
  "action_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tick: integer("tick").notNull(),
    voice: text("voice").notNull(),
    target: text("target"),
    actionType: text("action_type").notNull(),
    chatId: text("chat_id"),
    messageText: text("message_text"),
    confidence: real("confidence"),
    reasoning: text("reasoning"),
    success: integer("success", { mode: "boolean" }).notNull().default(false),
    /** ADR-43 P0 第二层: send_message 后是否缺少 feel() (1=缺失, 0=正常, null=非 send_message 行动) */
    observationGap: integer("observation_gap"),
    /** D4 ClosureDepth: 行动到图结构变化的反馈路径深度。 */
    closureDepth: integer("closure_depth"),
    /** ADR-69: 有效推进代理指标。@see docs/adr/69-llm-cognitive-loop-gravity-well.md */
    eaProxy: real("ea_proxy"),
    /** ADR-108: Engagement session 子周期数。1 = 单次执行（无 expect_reply/stay）。 */
    engagementSubcycles: integer("engagement_subcycles"),
    /** ADR-108: Engagement session 挂钟时间 (ms)。 */
    engagementDurationMs: integer("engagement_duration_ms"),
    /** ADR-108: Engagement session 结束原因: complete/timeout/preempted/limit。 */
    engagementOutcome: text("engagement_outcome"),
    /** ADR-199: 自动状态回写记录 JSON: {"feel":"positive","advance_topic":"conv:xxx"}。 */
    autoWriteback: text("auto_writeback"),
    /** ADR-235: TC 循环工具调用次数。 */
    tcToolCallCount: integer("tc_tool_call_count"),
    /** ADR-235: 是否触及 TC_MAX_TOOL_CALLS 预算上限。 */
    tcBudgetExhausted: integer("tc_budget_exhausted", { mode: "boolean" }),
    /** ADR-235: signal 工具的 afterward 值（done/waiting_reply/watching/fed_up/cooling_down）。 */
    tcAfterward: text("tc_afterward"),
    /** ADR-235: 聚合的 $ cmd\noutput 块（截断到 4KB）。 */
    tcCommandLog: text("tc_command_log"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("idx_action_log_tick").on(t.tick),
    index("idx_action_log_chat_tick").on(t.chatId, t.tick),
  ],
);

/**
 * 沉默日志（ADR-64 II-2）：记录被门控跳过的行动决策。
 *
 * 沉默发生在 EVOLVE 线程（声部已选中、目标已确定后的 skip 出口），
 * 与 action_log（ACT 线程执行记录）分表，对应不同的审计维度。
 *
 * @see docs/adr/64 §II-2: Silence as Information Gathering
 */
export const silenceLog = sqliteTable(
  "silence_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tick: integer("tick").notNull(),
    /** 选中的声部 */
    voice: text("voice").notNull(),
    /** 目标实体 */
    target: text("target"),
    /** 沉默原因：rate_cap | active_cooling | svg_negative | api_floor | all_candidates_negative */
    reason: text("reason").notNull(),
    /** V(a, n) 净社交价值 */
    netValue: real("net_value"),
    /** ΔP(a, n) 预期压力降低量 */
    deltaP: real("delta_p"),
    /** C_social(a, n) 社交成本 */
    socialCost: real("social_cost"),
    /** 当前 API 值 */
    apiValue: real("api_value"),
    /** D5 沉默五级谱层级：L1~L5。 */
    silenceLevel: text("silence_level"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_silence_log_tick").on(t.tick)],
);

/** 人格向量快照。 */
export const personalitySnapshots = sqliteTable("personality_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tick: integer("tick").notNull(),
  weights: text("weights").notNull(), // JSON: number[]
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/** 消息日志：收到和发出的消息。 */
export const messageLog = sqliteTable(
  "message_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tick: integer("tick").notNull(),
    chatId: text("chat_id").notNull(),
    /** Telegram 原始消息 ID（用于 reply directed 检测）。 */
    msgId: integer("msg_id"),
    /** 回复目标消息的 Telegram message ID。用于回复链逸散上下文（ADR-97）。 */
    replyToMsgId: integer("reply_to_msg_id"),
    senderId: text("sender_id"),
    senderName: text("sender_name"),
    text: text("text"),
    /** ADR-119: 媒体类型（sticker/photo/voice/video/document）。纯文本消息为 null。 */
    mediaType: text("media_type"),
    isOutgoing: integer("is_outgoing", { mode: "boolean" }).notNull().default(false),
    isDirected: integer("is_directed", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("idx_message_log_tick").on(t.tick),
    index("idx_message_log_chat").on(t.chatId),
    index("idx_message_log_chat_tick").on(t.chatId, t.tick),
    index("idx_message_log_chat_msg").on(t.chatId, t.msgId),
    index("idx_message_log_sender").on(t.senderId),
  ],
);

/**
 * 叙事线程（简化 Arc）。
 * 追踪持续的话题、关系动态和因果链。
 */
export const narrativeThreads = sqliteTable(
  "narrative_threads",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    title: text("title").notNull(),
    tensionFrame: text("tension_frame"), // 叙事张力的框架描述
    tensionStake: text("tension_stake"), // 赌注/重要性描述
    status: text("status").notNull().default("open"), // open|active|resolved|abandoned
    weight: text("weight").notNull().default("minor"), // trivial|minor|major|critical
    /** ADR-190: 线程来源，区分系统线程和对话线程。 */
    source: text("source").default("conversation"), // "conversation" | "system"
    involves: text("involves"), // JSON: Involvement[]
    createdTick: integer("created_tick").notNull(),
    lastBeatTick: integer("last_beat_tick"),
    resolvedTick: integer("resolved_tick"),
    /** 前瞻范围（ticks），用于 P_prospect 计算。 */
    horizon: integer("horizon"),
    /** 绝对截止 tick = createdTick + horizon。 */
    deadlineTick: integer("deadline_tick"),
    /** ADR-64 VI-2: 线程叙事摘要（LLM 通过 THREAD_REVIEW 生成）。 */
    summary: text("summary"),
    /** ADR-64 VI-2: 摘要上次更新的 tick。 */
    summaryTick: integer("summary_tick"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_narrative_threads_status").on(t.status)],
);

/**
 * Mod 状态持久化（ADR-33 Phase 1）。
 * 每个 Mod 的 state 序列化为 JSON，UPSERT by mod_name。
 */
export const modStates = sqliteTable("mod_states", {
  modName: text("mod_name").primaryKey(),
  stateJson: text("state_json").notNull(),
  updatedTick: integer("updated_tick").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * 图节点（ADR-33 Phase 2: Write-Back Cache）。
 * 替代 graph_snapshots 的全量 JSON 序列化。
 */
export const graphNodes = sqliteTable(
  "graph_nodes",
  {
    id: text("id").primaryKey(),
    entityType: text("entity_type").notNull(),
    attrs: text("attrs").notNull(), // JSON: 节点属性
    updatedTick: integer("updated_tick").notNull(),
  },
  (t) => [index("idx_graph_nodes_type").on(t.entityType)],
);

/**
 * 图边（ADR-33 Phase 2: Write-Back Cache）。
 */
export const graphEdges = sqliteTable(
  "graph_edges",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    src: text("src").notNull(),
    dst: text("dst").notNull(),
    label: text("label").notNull(),
    category: text("category").notNull(),
    attrs: text("attrs"), // JSON: 边附加属性（可为空）
  },
  (t) => [
    index("idx_graph_edges_src").on(t.src),
    index("idx_graph_edges_dst").on(t.dst),
    index("idx_graph_edges_src_label").on(t.src, t.label),
  ],
);

/**
 * 定时任务（Scheduler Mod）。
 * 支持 at（一次性定时）和 every（周期性）两种类型。
 */
export const scheduledTasks = sqliteTable(
  "scheduled_tasks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type").notNull(), // "at" | "every"
    targetMs: integer("target_ms"), // 绝对墙钟 ms（何时触发）
    intervalMs: integer("interval_ms"), // 墙钟 ms 间隔（every 类型）
    action: text("action").notNull(), // 触发时的动作描述（LLM 可读）
    target: text("target"), // 目标 chatId（可选）
    payload: text("payload"), // JSON 附加数据
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [index("idx_scheduled_tasks_active").on(t.active, t.targetMs)],
);

/**
 * 叙事节拍（简化 Beat）。
 * 线程中的关键事件，支持因果链。
 */
export const narrativeBeats = sqliteTable(
  "narrative_beats",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    threadId: integer("thread_id").notNull(),
    tick: integer("tick").notNull(),
    content: text("content").notNull(),
    beatType: text("beat_type").notNull().default("ambient"), // kernel|ambient
    causedBy: text("caused_by"), // JSON: string[] (thread/beat ids)
    spawns: text("spawns"), // JSON: string[] (new thread ids)
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_narrative_beats_thread").on(t.threadId)],
);

/**
 * 人格演化归因日志（ADR-53 #2）。
 * 记录每次人格向量变化的来源，支持审计"因为什么漂移"。
 * @see docs/adr/53-audit-gap-closure.md
 */
export const personalityEvolutionLog = sqliteTable(
  "personality_evolution_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tick: integer("tick").notNull(),
    /** 人格维度：diligence|curiosity|sociability|caution */
    dimension: text("dimension").notNull(),
    /** 权重变化量（归一化前） */
    delta: real("delta").notNull(),
    /** 触发来源：beat|outcome|decay */
    source: text("source").notNull(),
    /** Beat 类型（仅 source=beat 时有值） */
    beatType: text("beat_type"),
    /** 关联的实体 ID（联系人/频道） */
    targetEntity: text("target_entity"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_personality_evo_tick").on(t.tick)],
);

/**
 * ADR-82: Alice 的私人日记。
 * 持久化情感记忆、欲望/意图、自我反思。
 * LLM 通过 diary() 语法糖写入，diary Mod 的 contribute() 读取并注入 system prompt。
 * @see docs/adr/82-diary-inner-world.md
 */
export const diaryEntries = sqliteTable(
  "diary_entries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tick: integer("tick").notNull(),
    /** 日记内容（自由文本，最长 200 字符） */
    content: text("content").notNull(),
    /** 关联实体 ID（联系人/频道，可选） */
    about: text("about"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_diary_tick").on(t.tick), index("idx_diary_about").on(t.about)],
);

/**
 * 审计事件表（ADR-54）。
 *
 * 关键运行时异常和系统事件写入此表，支持 SQL 结构化查询。
 * 用途：事后排查（比 grep 日志更精准）、异常趋势分析。
 *
 * 示例查询：
 *   SELECT tick, level, source, message FROM audit_events WHERE level='fatal' ORDER BY tick DESC LIMIT 20;
 *   SELECT source, COUNT(*) FROM audit_events WHERE tick > 1000 GROUP BY source ORDER BY COUNT(*) DESC;
 *
 * @see docs/adr/54-pre-mortem-safety-net.md
 */
export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tick: integer("tick").notNull(),
    /** fatal | error | warn */
    level: text("level").notNull(),
    /** 来源模块（logger tag：act, evolve, events, sandbox 等） */
    source: text("source").notNull(),
    /** 事件描述 */
    message: text("message").notNull(),
    /** 附加细节 JSON（错误堆栈、参数快照等） */
    details: text("details"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("idx_audit_events_tick").on(t.tick),
    index("idx_audit_events_level").on(t.level),
    index("idx_audit_events_source").on(t.source),
  ],
);

/**
 * ADR-199: 延迟评估审计日志。
 * 记录 Alice 发消息后、系统延迟评估外部反馈的结果。
 * @see runtime/src/engine/deferred-outcome.ts
 */
export const deferredOutcomeLog = sqliteTable(
  "deferred_outcome_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tick: integer("tick").notNull(),
    channelId: text("channel_id").notNull(),
    /** Alice 发送消息的墙钟时间（ms）。 */
    actionMs: integer("action_ms").notNull(),
    /** 延迟评估执行的墙钟时间（ms）。 */
    evaluationMs: integer("evaluation_ms").notNull(),
    /** 延迟时长（ms）= evaluationMs - actionMs。 */
    delayMs: integer("delay_ms").notNull(),
    /** 外部反馈分数 [-1, 1]。 */
    score: real("score").notNull(),
    /** 置信度 [0, 1]。 */
    confidence: real("confidence").notNull(),
    /** 信号 JSON: string[]。 */
    signals: text("signals"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("idx_deferred_outcome_tick").on(t.tick),
    index("idx_deferred_outcome_channel").on(t.channelId),
  ],
);

/** 贴纸语义调色板：label → fileId 映射。Phase 1 手动维护，Phase 2 VLM 自动填充。 */
export const stickerPalette = sqliteTable(
  "sticker_palette",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** 中文语义标签 = VLM summary（LLM 可见） */
    label: text("label").notNull(),
    /** Telegram sticker file ID（发送用，可刷新）。 */
    fileId: text("file_id").notNull().unique(),
    /** Telegram file_unique_id — 永久唯一，去重键。 */
    fileUniqueId: text("file_unique_id").notNull().unique(),
    /** 辅助 emoji（可选） */
    emoji: text("emoji"),
    /** 贴纸集短名（来源追踪） */
    setName: text("set_name"),
    /** 情绪维度（Phase 2 VLM 填充） */
    emotion: text("emotion"),
    /** 动作维度（Phase 2 VLM 填充） */
    action: text("action"),
    /** 强度维度（Phase 2 VLM 填充） */
    intensity: text("intensity"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("idx_sticker_palette_label").on(t.label),
    index("idx_sticker_palette_emotion").on(t.emotion),
  ],
);

/** 贴纸使用频率追踪：per sticker × per chat。 */
export const stickerUsage = sqliteTable(
  "sticker_usage",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** sticker_palette.file_unique_id */
    fileUniqueId: text("file_unique_id").notNull(),
    /** 使用该贴纸的聊天 ID */
    chatId: text("chat_id").notNull(),
    /** 聊天类型（由 chatId 符号派生：正=private，负=group） */
    chatType: text("chat_type").notNull(),
    /** 使用次数（累加） */
    count: integer("count").notNull().default(1),
    /** 最后使用时间 */
    lastUsedAt: integer("last_used_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("idx_sticker_usage_unique").on(t.fileUniqueId, t.chatId),
    index("idx_sticker_usage_chat").on(t.chatId),
    index("idx_sticker_usage_count").on(t.count),
  ],
);

/**
 * ADR-204: 意识流事件。
 * 持久化 tick 循环产生的执行痕迹（情绪、指令、观察、Skill 输出），
 * 下一 tick 通过 surface() 浮现到 prompt，reinforce() 闭合反馈环。
 * @see docs/adr/204-consciousness-stream/
 */
export const consciousnessEvents = sqliteTable(
  "consciousness_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tick: integer("tick").notNull(),
    timestampMs: integer("timestamp_ms").notNull(),
    /** 事件类别：act:feel | act:diary | evolve:tier | evolve:enqueue 等。 */
    kind: text("kind").notNull(),
    /** 关联实体 ID JSON 数组（联系人/频道）。 */
    entityIds: text("entity_ids").notNull().default("[]"),
    /** 人类可读的事件摘要。 */
    summary: text("summary").notNull(),
    /** 显著性 [0,1]，驱动 surface() 排序。 */
    salience: real("salience").notNull().default(0.5),
    /** 展开提示（可选，供 contribute 渲染更丰富的上下文）。 */
    expandHint: text("expand_hint"),
  },
  (t) => [index("idx_ce_tick").on(t.tick), index("idx_ce_salience").on(t.salience)],
);

/**
 * Bio 缓存：按需获取的 Telegram 实体 bio/description。
 * 联系人 → users.getFullUser.about，群组/频道 → channels.getFullChannel.about。
 * TTL 3 天，cache miss 时异步获取，下次 tick 生效。
 */
export const bioCache = sqliteTable("bio_cache", {
  /** 实体 ID（contact:123 或 channel:-100xxx）。 */
  entityId: text("entity_id").primaryKey(),
  /** bio/about 文本（Telegram 用户签名或群组简介）。 */
  bio: text("bio"),
  /** 用户个人频道 ID（仅 contact，可用于探索发现）。 */
  personalChannelId: integer("personal_channel_id"),
  /** 获取时间（ms）。 */
  fetchedAt: integer("fetched_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * ADR-215: Cognitive Episode Graph — 认知片段。
 * Episode = 一段连贯认知活动（从 engagement 开始到自然中断）。
 * 自动分割，不需要 LLM 声明。Residue 编码未消解张力，参与压力竞争。
 * @see docs/adr/215-cognitive-episode-graph.md
 */
export const episodes = sqliteTable(
  "episodes",
  {
    id: text("id").primaryKey(), // episode:${tick_start}
    tickStart: integer("tick_start").notNull(),
    tickEnd: integer("tick_end"),
    target: text("target"),
    voice: text("voice"),
    outcome: text("outcome"), // message_sent | silence | error | preempted
    pressureApi: real("pressure_api"),
    pressureDominant: text("pressure_dominant"),
    triggerEvent: text("trigger_event"),
    entityIds: text("entity_ids").notNull().default("[]"), // JSON string[]
    residue: text("residue"), // JSON EpisodeResidue | null
    causedBy: text("caused_by"), // JSON string[] episode IDs
    consults: text("consults"), // JSON string[] episode IDs
    resolves: text("resolves"), // JSON string[] episode IDs
    createdMs: integer("created_ms").notNull(),
  },
  (t) => [index("idx_episodes_tick").on(t.tickStart), index("idx_episodes_target").on(t.target)],
);
