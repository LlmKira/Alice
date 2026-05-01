/**
 * 图常量——从 Python graph.py 逐字搬运。
 * @see docs/adr/155-branded-graph-id.md — Branded ID + 前缀正式化
 */
import type {
  ChannelNodeId,
  ContactNodeId,
  DunbarTier,
  EdgeCategory,
  TelegramId,
  ThreadWeight,
} from "./entities.js";

// Dunbar 层级权重：圈层越小权重越高
export const DUNBAR_TIER_WEIGHT: Record<DunbarTier, number> = {
  5: 5.0, // 亲密圈
  15: 3.0, // 好友圈
  50: 1.5, // 朋友圈
  150: 0.8, // 熟人圈
  500: 0.3, // 认识圈
};

// ADR-113 §D3: Dunbar 层级的期望互动频率 theta_c（单位: 秒）
// 为**线上即时通讯**场景标定（非面对面社交）。
// 即时回复需求由 P5 覆盖，theta_c 衡量的是"多久没联系开始感到关系冷却"。
// @see docs/adr/113-online-social-recalibration/ §D3
export const DUNBAR_TIER_THETA: Record<DunbarTier, number> = {
  5: 7200, // 亲密圈: 2 小时
  15: 14400, // 好友圈: 4 小时
  50: 43200, // 朋友圈: 12 小时
  150: 172800, // 熟人圈: 2 天
  500: 604800, // 认识圈: 7 天
};

// ADR-121: 社交余光时间窗口（秒）——Dunbar tier 越亲密，余光窗口越长。
// @see docs/adr/121-social-peripheral-vision/README.md §3.2
export const PERIPHERAL_TIER_WINDOW_S: Record<DunbarTier, number> = {
  5: 86400, // 亲密圈: 24h
  15: 43200, // 好友圈: 12h
  50: 21600, // 朋友圈: 6h
  150: 7200, // 熟人圈: 2h
  500: 0, // 认识圈: 禁用
};

// ADR-111: P3 对数时间尺度参数 — Weber-Fechner 定律驱动。
// @see docs/adr/111-log-time-sigmoid/README.md

/**
 * Weber-Fechner 时间感知粒度（秒）。
 * 小于 τ₀ 的沉默被近似线性感知，大于 τ₀ 的沉默被对数压缩。
 * 600s = 10 分钟，对应人类对时间变化的最小可感知差异（JND）。
 */
export const P3_TAU_0 = 600;

/**
 * P3 对数域 sigmoid 陡度参数。
 * 推导：设过渡区覆盖 θ/α 到 α·θ（α=3），
 * β_r = 4.394 / median(W_log across tiers) ≈ 2.5。
 * 各 tier W_log 值域 [1.435, 2.074]，取中值对应 tier-50。
 */
export const P3_BETA_R = 2.5;

// 线程权重映射
export const THREAD_WEIGHTS: Record<ThreadWeight, number> = {
  critical: 4.0,
  major: 2.0,
  minor: 1.0,
  subtle: 0.5,
  trivial: 0.25,
};

// 边标签 → 边类别映射
export const LABEL_CATEGORY: Record<string, EdgeCategory> = {
  monitors: "spatial",
  joined: "spatial",
  owner: "ownership",
  friend: "social",
  acquaintance: "social",
  stranger: "social",
  knows: "cognitive",
  suspects: "cognitive",
  tracks: "cognitive",
  caused: "causal",
  promised: "causal",
  discovered: "causal",
  involves: "ownership",
  from: "ownership",
  in: "ownership",
  happens_in: "spatial", // ADR-26: conversation → channel
  participates: "social", // ADR-26: contact → conversation
};

// Laplacian 传播边类别权重 (v4)
export const PROPAGATION_WEIGHT: Record<EdgeCategory, number> = {
  spatial: 0.5,
  social: 1.0,
  cognitive: 0.3,
  causal: 0.8,
  ownership: 0.6,
};

/** 将边标签映射到类别，未知标签默认 ownership。 */
export function labelToCategory(label: string): EdgeCategory {
  return LABEL_CATEGORY[label] ?? "ownership";
}

/** Dunbar tier 序列（升序）。 */
export const TIER_SEQUENCE: DunbarTier[] = [5, 15, 50, 150, 500];

/** Dunbar tier → 自然语言标签。多处复用（self-observation、strategy hints、relationships contribute）。 */
const TIER_LABELS: Record<number, string> = {
  5: "intimate",
  15: "close friend",
  50: "friend",
  150: "acquaintance",
  500: "known",
};

/** 将 tier 数字转为自然语言标签，未知 tier 回退到 "acquaintance"。 */
export function tierLabel(tier: number): string {
  return TIER_LABELS[tier] ?? "acquaintance";
}

/**
 * 从连续数值找最近的 DunbarTier。
 * 用于 tier bias correction 后将连续值映射回离散层级。
 */
export function nearestTier(value: number): DunbarTier {
  let best: DunbarTier = 150;
  let bestDist = Infinity;
  for (const t of TIER_SEQUENCE) {
    const dist = Math.abs(value - t);
    if (dist < bestDist) {
      bestDist = dist;
      best = t;
    }
  }
  return best;
}

/** Tier bias correction 基线值。 */
const TIER_BASELINE = 150;

/**
 * Tier 高估偏差校正 — Social POMDP。
 *
 * 当 BeliefStore 中 tier 信念的 σ²（方差）较高时，
 * 说明我们对这个联系人的亲密度判断不确定。
 * 校正策略：将 tier 向基线 150（熟人圈）回归。
 *
 * effectiveTier = tier + (150 - tier) × min(σ², 0.8)
 *
 * σ² 低（<0.3）→ 不校正，信任当前 tier
 * σ² 高（>0.3）→ 向 150 回归，越不确定越保守
 *
 * @param tier 原始 DunbarTier（5/15/50/150/500）
 * @param sigma2 信念方差，0-1 之间。undefined 表示无信念数据。
 * @returns 校正后的最近 DunbarTier
 *
 * @see paper/ §Social POMDP "Tier Overestimate Bias Correction"
 */
export function tierBiasCorrection(tier: DunbarTier, sigma2: number | undefined): DunbarTier {
  if (sigma2 === undefined || sigma2 <= 0.3) return tier;
  const regression = Math.min(sigma2, 0.8);
  const effectiveTier = tier + (TIER_BASELINE - tier) * regression;
  return nearestTier(effectiveTier);
}

/** Alice 自身节点 ID 常量。m2: 消除硬编码 "self" 字符串。 */
export const ALICE_SELF = "self";

// -- 压力维度统一规格 ---------------------------------------------------------

/**
 * 压力维度规格——统一双常量体系。
 *
 * - kappa: tanh 归一化曲率（API 聚合用，半饱和点）
 * - typicalScale: 典型量级上界（staleness 等权化用）
 *
 * 消除旧的 aggregate.ts DEFAULT_KAPPA 和 act.ts PRESSURE_SCALES 双源。
 * @see paper/ §3.3 "API Normalization"
 */
export interface PressureDimensionSpec {
  /** ADR-112 D4: 最低 κ（原硬编码 kappa，现为自适应 κ 的下界）。 */
  kappaMin: number;
  typicalScale: number;
}

export const PRESSURE_SPECS: Record<string, PressureDimensionSpec> = {
  // ADR-215: 上调 κ₁ 以匹配实际规模（968 contacts，原标定 ~15）
  // 典型贡献：unread × w ≈ 5 × 20 = 100，κ=15 时 tanh(100/15)≈0.999 仍高
  // 但配合 ln(1+unread) 在 effectiveUnread 中，P1 应保持在合理范围
  P1: { kappaMin: 15.0, typicalScale: 200 },

  // ADR-215: 上调 κ₂ 以匹配实际规模（192 facts）
  // 典型贡献：192 × 0.5 × 0.5 ≈ 48（平均 importance=0.5，半遗忘）
  P2: { kappaMin: 20.0, typicalScale: 50 },

  // P3 有 Top-K 截断，与总规模解耦，κ 保持适中
  P3: { kappaMin: 10.0, typicalScale: 8 },

  // P4 对数增长，与规模次线性，κ 保持保守
  P4: { kappaMin: 5.0, typicalScale: 10 },

  // ADR-215: 大幅上调 κ₅ 以配合 directed 对数缩放
  // effectiveDirected = ln(1+min(raw, 5)) ≈ 1.8
  // 典型贡献：72 channels × 1.8 × avg(w≈50) × chatW(1) ≈ 150
  // κ=50 时 tanh(150/50)=0.76，保留动态范围
  P5: { kappaMin: 50.0, typicalScale: 50 },

  // P6 论文有界 [0, η]，κ 小但 η=0.6 确保有界
  P6: { kappaMin: 0.5, typicalScale: 0.6 },
};

/** 从 PRESSURE_SPECS 派生的 kappaMin 六元组（默认 kappa 下界）。 */
export const DEFAULT_KAPPA: [number, number, number, number, number, number] = [
  PRESSURE_SPECS.P1.kappaMin,
  PRESSURE_SPECS.P2.kappaMin,
  PRESSURE_SPECS.P3.kappaMin,
  PRESSURE_SPECS.P4.kappaMin,
  PRESSURE_SPECS.P5.kappaMin,
  PRESSURE_SPECS.P6.kappaMin,
];

/** 从 PRESSURE_SPECS 派生的 typicalScale 六元组（staleness 等权化用）。 */
export const PRESSURE_TYPICAL_SCALES: [number, number, number, number, number, number] = [
  PRESSURE_SPECS.P1.typicalScale,
  PRESSURE_SPECS.P2.typicalScale,
  PRESSURE_SPECS.P3.typicalScale,
  PRESSURE_SPECS.P4.typicalScale,
  PRESSURE_SPECS.P5.typicalScale,
  PRESSURE_SPECS.P6.typicalScale,
];

// -- chat_type 统一权重 -------------------------------------------------------

/**
 * 统一 chat_type 权重（消除 p1 和 p5 各自维护的常量）。
 * @see paper/ §3.1 "Goffman's Dramaturgical Theory"
 */
export const CHAT_TYPE_WEIGHTS: Record<string, { attention: number; response: number }> = {
  private: { attention: 3.0, response: 2.0 },
  group: { attention: 1.0, response: 1.0 },
  supergroup: { attention: 0.8, response: 0.8 },
  channel: { attention: 0.3, response: 0.3 },
};

// -- 连续稳定性频谱 (Continuous Stability Spectrum) ---------------------------
// 取代二值 semantic/episodic 分类。所有事实统一使用 SM-2 遗忘曲线，
// 区别仅在于初始稳定性 S₀：preference/skill 衰减慢（~1.5年半衰期），
// observation 衰减极快（~27天半衰期），其余居中。
//
// SM-2: R(t) = (1 + t/(9·S))^d, d=-0.5
// 半衰期 t_half = 27·S 天
//
// 在线社交校准：IM 环境信息更新频率远高于线下关系。一年未强化的偏好
// 已经值得重新验证。S₀ 只控制「无强化时的自然衰减」——活跃 fact 通过
// remember() 乘 STABILITY_REINFORCE_FACTOR 累积增长，不受此限。
// 反面证据通过 update_fact/delete_fact 即时纠正，不依赖衰减。
//
// @see docs/adr/151-algorithm-audit/research-online-calibration.md
// 映射由代码从 fact_type 推导——遵循 ADR-50 "语义归 LLM，结构归代码"。

/**
 * fact_type → 初始稳定性 S₀ 映射（在线社交校准）。
 *
 * | fact_type   | S₀ | 半衰期    | 认知理据                                |
 * |-------------|-----|----------|----------------------------------------|
 * | preference  | 20  | ~1.5 年  | IM 中偏好 1.5 年未强化 → 值得重新验证     |
 * | skill       | 20  | ~1.5 年  | 聊天提到的技能，保鲜期合理                |
 * | general     | 14  | ~1 年    | 工作/城市/身份，人会换                    |
 * | interest    | 7   | ~6 月    | 在线兴趣流动性极高                       |
 * | growth      | 3   | ~2.7 月  | 进行中状态，数月可知完成/放弃             |
 * | observation | 1   | ~27 天   | 瞬时观察，衰减最快                       |
 */
export const FACT_TYPE_INITIAL_STABILITY: Record<string, number> = {
  preference: 20,
  skill: 20,
  general: 14,
  interest: 7,
  growth: 3,
  observation: 1,
};

/** 默认稳定性（未知 fact_type 按 observation 处理——安全侧，衰减快）。 */
const DEFAULT_STABILITY = 1;

/** 从 fact_type 推导初始稳定性 S₀。LLM 不需要显式传入。 */
export function factTypeInitialStability(factType: string | undefined): number {
  return FACT_TYPE_INITIAL_STABILITY[factType ?? "general"] ?? DEFAULT_STABILITY;
}

/** remember() 重复提及同一事实时的稳定性强化因子。S_new = S_old × REINFORCE_FACTOR。 */
export const STABILITY_REINFORCE_FACTOR = 1.2;

// -- 遗忘曲线共享常量 --------------------------------------------------------

/**
 * ADR-110: 事实遗忘时间尺度（秒）。
 * 1 天 = 86400 秒。P2 和 factRetrievability 共享此常量。
 * @see paper/ §3.2 "Information Pressure"
 */
export const FACT_TIME_SCALE = 86400;

/** 遗忘曲线参数 d。 */
export const FACT_DECAY_D = -0.5;

/** 遗忘阈值：R < 此值的事实不注入 context。 */
export const FACT_FORGET_THRESHOLD = 0.2;

/** SM-2 巩固系数。 */
export const FACT_CONSOLIDATION_FACTOR = 1.5;

// -- 前缀常量 (ADR-155) ------------------------------------------------------

/** 频道图节点 ID 前缀。 */
export const CHANNEL_PREFIX = "channel:";
/** 联系人图节点 ID 前缀。 */
export const CONTACT_PREFIX = "contact:";
/** 对话会话图节点 ID 前缀。 */
export const CONVERSATION_PREFIX = "conversation:";
export const TELEGRAM_PLATFORM = "telegram";

const PLATFORM_ENTITY_ID_RE = /^(channel|contact):([a-z][a-z0-9_-]*):(.+)$/u;
const TELEGRAM_NUMBER_RE = /^-?\d+$/u;

// -- ID 转换工具 -------------------------------------------------------------

/**
 * 将 chatId (channel:xxx) 推导为 contactId (contact:xxx)。
 * m6: 集中命名约定，替代各处硬编码前缀处理。
 * @see docs/adr/155-branded-graph-id.md
 */
export function chatIdToContactId(chatId: string): ContactNodeId | null {
  const parsed = parsePlatformEntityId(chatId);
  if (!parsed) return null;
  if (parsed.kind === "contact") return chatId as ContactNodeId;
  if (parsed.kind === "channel") return platformContactId(parsed.platform, parsed.nativeId);
  return null;
}

// -- 通用 ID 转换 -----------------------------------------------------------

export function platformChannelId(platform: string, nativeId: string | number): ChannelNodeId {
  return `${CHANNEL_PREFIX}${platform}:${nativeId}` as ChannelNodeId;
}

export function platformContactId(platform: string, nativeId: string | number): ContactNodeId {
  return `${CONTACT_PREFIX}${platform}:${nativeId}` as ContactNodeId;
}

export function telegramChannelId(nativeId: string | number): ChannelNodeId {
  return platformChannelId(TELEGRAM_PLATFORM, nativeId);
}

export function telegramContactId(nativeId: string | number): ContactNodeId {
  return platformContactId(TELEGRAM_PLATFORM, nativeId);
}

function parsePlatformEntityId(
  id: string,
): { kind: "channel" | "contact"; platform: string; nativeId: string } | null {
  const match = PLATFORM_ENTITY_ID_RE.exec(id);
  if (!match) return null;
  return {
    kind: match[1] as "channel" | "contact",
    platform: match[2],
    nativeId: match[3],
  };
}

/**
 * 从任何实体 ID（channel:xxx, contact:xxx, 纯数字字符串）提取 Telegram 数字 ID。
 * 非法格式（如 "channel:abc"）返回 null。
 * @see docs/adr/155-branded-graph-id.md
 */
export function extractNumericId(id: string): TelegramId | null {
  let raw: string;
  const parsed = parsePlatformEntityId(id);
  if (parsed) {
    if (parsed.platform !== TELEGRAM_PLATFORM) return null;
    raw = parsed.nativeId;
  }
  // @senderId 前缀（prompt 标注惯例）+ ~senderId（LLM-facing shorthand）
  else if (id.startsWith("@") || id.startsWith("~")) raw = id.slice(1);
  else raw = id;
  if (!TELEGRAM_NUMBER_RE.test(raw)) return null;
  const n = Number(raw);
  return Number.isNaN(n) || raw === "" ? null : (n as TelegramId);
}

/**
 * 确保 ID 为平台限定 channel 格式（channel:<platform>:<nativeId>）。
 * 纯数字字符串按 Telegram native id 处理；旧 `channel:<id>` / `contact:<id>` 不再接受。
 * @see docs/adr/155-branded-graph-id.md
 */
export function ensureChannelId(id: string): ChannelNodeId | null {
  const parsed = parsePlatformEntityId(id);
  if (parsed?.kind === "channel") return id as ChannelNodeId;
  if (parsed?.kind === "contact") return platformChannelId(parsed.platform, parsed.nativeId);
  const n = extractNumericId(id);
  return n != null ? telegramChannelId(n) : null;
}

// -- Perceive Facts 常量 (ADR-160) ------------------------------------------
// @see docs/adr/158-outbound-feedback-gap.md

/** ADR-160 Fix A: perceive-sourced facts 独立容量池上限。不占 contact 的 20 限额。 */
export const PERCEIVE_FACTS_LIMIT = 30;

/** ADR-160 Fix A: 同一 channel 的 perceive fact 去抖间隔（ms）。30 分钟。 */
export const PERCEIVE_FACT_DEBOUNCE_MS = 30 * 60_000;

/** ADR-160 Fix A: channel 累积消息阈值——自 Alice 上次行动以来 ≥ 此数才创建 perceive fact。 */
export const PERCEIVE_FACT_MSG_THRESHOLD = 3;

// -- 群组存在感独立参数 (ADR-160) -------------------------------------------
// @see docs/adr/158-outbound-feedback-gap.md

/**
 * ADR-160 Fix B: 群组专用 theta 映射（秒）。
 *
 * 群组社交动力学与双边关系不同：群里聊了一下午你一声不吭是不正常的，
 * 但几天没私聊朋友是正常的。群组 theta 比 DUNBAR_TIER_THETA 快 ~12x。
 */
export const GROUP_PRESENCE_THETA: Record<DunbarTier, number> = {
  5: 1800, // intimate group:    30 min
  15: 3600, // close group:       1 hour
  50: 7200, // friend group:      2 hours
  150: 14400, // acquaintance group: 4 hours
  500: 43200, // stranger group:    12 hours
};

/**
 * ADR-161 §3.4: 轨迹驱动 theta — 群组自然消息间隔的倍数 → P3 sigmoid 中点。
 * K=10 含义：群组发了 10 轮消息而 Alice 沉默——此时缺席压力达 50%。
 * @see docs/adr/161-action-space-audit-group-cadence.md §3.4
 */
export const K_ABSENCE_ROUNDS = 10;

/** ADR-161 §3.4: 轨迹驱动 theta 的合理范围夹紧下限（秒）。30 分钟。 */
export const TRAJECTORY_THETA_MIN_S = 1800;

/** ADR-161 §3.4: 轨迹驱动 theta 的合理范围夹紧上限（秒）。7 天。 */
export const TRAJECTORY_THETA_MAX_S = 604800;

// -- 情感反应度常量 (ADR-156) ------------------------------------------------
// @see docs/adr/156-emotional-reactivity-damping.md

/** ADR-156: 情感反应度半衰期（ms）。默认 2 小时。 */
export const EMOTIONAL_HALF_LIFE = 7_200_000;

/** ADR-156: 排放因子。Alice 回应后 E *= 此值（一次回应消解 70% 情感压力）。 */
export const EMOTIONAL_DISCHARGE_FACTOR = 0.3;

/** ADR-156: 情感呈现阈值。E > 此值时使用 (vivid) 标签。 */
export const EMOTIONAL_VIVID_THRESHOLD = 0.5;

/** ADR-156: 情感呈现阈值。E > 此值时使用 (noted) 标签，否则无标签。 */
export const EMOTIONAL_NOTED_THRESHOLD = 0.2;

/**
 * 确保 ID 为 contact 格式（contact:xxx）。
 * 接受 channel:xxx、contact:xxx、纯数字字符串。非法格式返回 null。
 * @see docs/adr/155-branded-graph-id.md
 */
export function ensureContactId(id: string): ContactNodeId | null {
  const parsed = parsePlatformEntityId(id);
  if (parsed?.kind === "contact") return id as ContactNodeId;
  if (parsed?.kind === "channel") return platformContactId(parsed.platform, parsed.nativeId);
  const n = extractNumericId(id);
  return n != null ? telegramContactId(n) : null;
}

/**
 * 从 target 推断图中的 contact + channel 节点。
 * has 回调验证节点存在（避免循环导入 WorldModel）。
 * @see docs/adr/155-branded-graph-id.md
 */
export function resolveContactAndChannel(
  target: string,
  has: (id: string) => boolean,
): { contactId: ContactNodeId | null; channelId: ChannelNodeId | null } {
  const channelId = ensureChannelId(target);
  const contactId = ensureContactId(target);
  const parsed = parsePlatformEntityId(target);
  const mirroredContactId =
    parsed?.kind === "channel" ? platformContactId(parsed.platform, parsed.nativeId) : null;
  const mirroredChannelId =
    parsed?.kind === "contact" ? platformChannelId(parsed.platform, parsed.nativeId) : null;
  return {
    contactId:
      contactId && has(contactId)
        ? contactId
        : mirroredContactId && has(mirroredContactId)
          ? mirroredContactId
          : null,
    channelId:
      channelId && has(channelId)
        ? channelId
        : mirroredChannelId && has(mirroredChannelId)
          ? mirroredChannelId
          : null,
  };
}
