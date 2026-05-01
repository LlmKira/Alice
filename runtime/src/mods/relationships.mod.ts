/**
 * Relationships Mod — 联系人档案 + 结构化画像 + 语言检测。
 *
 * 对应叙事引擎的 relation mod + affect mod：
 * - 为每个联系人维护画像信息（语言偏好、互动次数、关系层级）
 * - M2: 结构化 ContactProfile（沟通风格、活跃时段、情绪基线、兴趣标签）
 * - 向 Storyteller 贡献联系人上下文（section 桶）
 *
 * 指令：set_language, set_relation_type, note_active_hour, tag_interest, self_note, recall_fact, update_fact, delete_fact, synthesize_portrait, update_group_profile
 * 查询：contactProfile, languageOf
 *
 * 参考: narrative-engine/mods/relation/index.ts
 * 参考: narrative-framework-paper §5 (P_ρ relationship priority)
 */
import { and, eq, gt, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { createMod } from "../core/mod-builder.js";
import { PromptBuilder, type PromptLine } from "../core/prompt-style.js";
import type { ContributionItem } from "../core/types.js";
import { readModState, readPressureApi, section } from "../core/types.js";
import { getDb } from "../db/connection.js";
import { getRecentMessagesBySender } from "../db/queries.js";
import { actionLog } from "../db/schema.js";
import {
  emit as emitConsciousness,
  reinforce as reinforceConsciousness,
} from "../engine/consciousness.js";
import { activationRetrieval } from "../graph/activation.js";
import {
  ALICE_SELF,
  EMOTIONAL_HALF_LIFE,
  EMOTIONAL_NOTED_THRESHOLD,
  EMOTIONAL_VIVID_THRESHOLD,
  ensureChannelId,
  ensureContactId,
  FACT_CONSOLIDATION_FACTOR,
  FACT_DECAY_D,
  FACT_FORGET_THRESHOLD,
  FACT_TIME_SCALE,
  factTypeInitialStability,
  resolveContactAndChannel,
  STABILITY_REINFORCE_FACTOR,
  tierLabel,
} from "../graph/constants.js";
import { resolveDisplayName, safeDisplayName } from "../graph/display.js";
import type { DunbarTier, FactAttrs, RelationType } from "../graph/entities.js";
import {
  DIMENSION_DECAY,
  decayDimension,
  deriveRomanticPhase,
  INITIAL_RV,
  RV_DIMENSIONS,
  readRV,
  readVelocity,
} from "../graph/relationship-vector.js";
import type { WorldModel } from "../graph/world-model.js";
import { estimateEventMs } from "../pressure/clock.js";
import { effectiveObligation } from "../pressure/signal-decay.js";
import { ChatTarget } from "../prompt/types.js";
import { retrievability as calcRetrievability } from "../utils/math.js";
import { humanDurationAgo } from "../utils/time-format.js";

/**
 * ADR-151 T3: Tier → 语气指导映射。
 * Zhao 2025 EMNLP: LLM 过度依赖消极礼貌（敬语、间接表达），
 * 显式注入礼貌策略可纠偏，让 intimate 联系人获得积极礼貌（随意、直接）。
 *
 * IM 校准（ADR-151 Wave 1）：tier 50+ 向随意方向偏移一级。
 * 依据：IM 是非正式通信渠道，emoji/sticker 消解正式性，
 * 即使不太熟的人在 IM 中也很少使用极正式措辞。
 * @see docs/adr/151-algorithm-audit/priority-ranking.md
 * @see docs/adr/151-algorithm-audit/research-online-calibration.md §4.1
 */
const TIER_TONE_GUIDANCE: Record<number, string> = {
  5: "跟{name}说话随意亲密，像最亲的人",
  15: "跟{name}说话轻松友好，像老朋友",
  50: "跟{name}说话轻松自然，像日常朋友",
  150: "跟{name}保持温暖友善，适度礼貌",
  500: "跟{name}保持礼貌得体",
};

// -- 图节点事实辅助 -----------------------------------------------------------

/**
 * ADR-47 G6: 归一化事实内容用于去重。
 * lowercase + trim + collapse whitespace → 宽松匹配。
 */
export function normalizeFactContent(content: string): string {
  return content.toLowerCase().trim().replace(/\s+/g, " ");
}

/** Module-level counter for unique fact node IDs. */
let _factIdCounter = 0;

/** 生成唯一的 fact 节点 ID。 */
function nextFactId(): string {
  return `fact_${_factIdCounter++}_${Date.now()}`;
}

/**
 * 从 fact 节点属性计算 retrievability。
 * ADR-110: 接受 nowMs（墙钟毫秒），内部转为秒进行遗忘曲线计算。
 * ADR-46 F1: Δt 除以 FACT_TIME_SCALE 将秒级遗忘转换为天级遗忘。
 * 复用 utils/math.ts 的 retrievability 函数（传入缩放后的 gap）。
 * @see docs/adr/46-real-data-calibration.md §2 Wave 1
 */
export function factRetrievabilityFromNode(attrs: FactAttrs, nowMs: number): number {
  // ADR-154: FactAttrs 已统一为 last_access_ms（墙钟 ms）
  const gapS = Math.max(0, (nowMs - attrs.last_access_ms) / 1000);
  const scaledGap = gapS / FACT_TIME_SCALE; // FACT_TIME_SCALE = 86400（秒/天）
  // retrievability(t, t0, S, d) — 传入 scaledGap 作为 t，0 作为 t0
  return calcRetrievability(scaledGap, 0, attrs.stability, FACT_DECAY_D);
}

/**
 * ADR-156: 计算事实的情感反应度 E(t)。
 *
 * E(t) = E₀ · exp(-ln2 · Δt / τ_half)
 *
 * 半衰期 2h：t=0h→1.0, t=2h→0.5, t=4h→0.25, t=8h→0.06。
 * 无 reactivity 字段的事实返回 0（中性事实，向后兼容）。
 *
 * @see docs/adr/156-emotional-reactivity-damping.md §E(t)
 */
export function factEmotionalReactivity(attrs: FactAttrs, nowMs: number): number {
  if (attrs.reactivity == null || attrs.reactivity <= 0) return 0;
  const baseMs = attrs.reactivity_ms ?? attrs.created_ms;
  const dt = Math.max(0, nowMs - baseMs);
  return attrs.reactivity * Math.exp((-Math.LN2 * dt) / EMOTIONAL_HALF_LIFE);
}

/**
 * 查找联系人/agent 的所有 fact 事实节点。
 * 通过 "knows" 边遍历邻居，过滤 fact 类型。
 */
export function getContactFacts(
  graph: WorldModel,
  contactId: string,
): Array<{ id: string; attrs: FactAttrs }> {
  const neighbors = graph.getNeighbors(contactId, "knows");
  const facts: Array<{ id: string; attrs: FactAttrs }> = [];
  for (const nid of neighbors) {
    if (graph.getNodeType(nid) === "fact") {
      facts.push({ id: nid, attrs: graph.getFact(nid) });
    }
  }
  return facts;
}

/**
 * ADR-117 D2: 防御守卫 — 将传入的 ID 解析为 contact 类型节点。
 * LLM 可能传入 channel/fact 等非 contact ID，通过 `knows` 反向边追溯真实联系人。
 * @returns contact 节点 ID，或 null（无法解析时）。
 */
function resolveContactId(graph: WorldModel, rawId: string): string | null {
  if (!graph.has(rawId)) return null;
  if (graph.getNodeType(rawId) === "contact") return rawId;
  // 非 contact 类型 → 反向追溯 knows 边
  const predecessors = graph.getPredecessors(rawId, "knows");
  return predecessors.find((pid) => graph.has(pid) && graph.getNodeType(pid) === "contact") ?? null;
}

// -- ADR-206 W8: 频道社交全景 -------------------------------------------------

const PANORAMA_MAX_CONTACTS = 8;
const PANORAMA_MAX_CHARS = 400;
// 放宽到 500：频道转发的社交全景需要兴趣匹配，而兴趣标签积累集中在 tier=500 的联系人
//（close contacts 的 tag_interest 尚未充分生效）。PANORAMA_MAX_CONTACTS=8 + 排序逻辑
// 保证只展示最相关的人，不会因为放宽 tier 而灌水。
const PANORAMA_MAX_TIER: DunbarTier = 500;
const PANORAMA_MAX_INTERESTS = 2;

/**
 * ADR-206 W8: 构建精简社交全景——频道 tick 中帮助 Alice 决定转发目标。
 *
 * 提取 close contacts（tier ≤ 50），为每人渲染一行摘要：
 *   display_name (tier_label) — interests | last interaction | share frequency
 *
 * @see docs/adr/206-channel-information-flow/ §12 收归转发职责
 */
export function buildSocialPanorama(
  G: WorldModel,
  contactProfiles: Record<string, ContactProfile>,
  groupProfiles: Record<string, GroupProfile>,
  nowMs: number,
): PromptLine[] {
  if (!G.has(ALICE_SELF)) return [];

  const lines: PromptLine[] = [];
  let totalChars = 0;

  // -- 联系人段 --
  const acquaintances = G.getNeighbors(ALICE_SELF, "acquaintance");
  const contactCandidates: Array<{
    name: string;
    tier: number;
    interests: string[];
    lastActiveMs: number;
    lastSharedToMs: number;
    topTrait: string | null;
  }> = [];

  for (const cid of acquaintances) {
    if (!G.has(cid) || G.getNodeType(cid) !== "contact") continue;
    const attrs = G.getContact(cid);
    if (attrs.is_bot) continue;
    const tier = attrs.tier ?? 150;
    if (tier > PANORAMA_MAX_TIER) continue;

    const name = safeDisplayName(G, cid);
    const profile = contactProfiles[cid];

    // ADR-208: 优先使用结晶兴趣，回退旧 interests[]
    const crystallized = Object.values(profile?.crystallizedInterests ?? {})
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, PANORAMA_MAX_INTERESTS)
      .map((ci) => ci.label);
    const interests =
      crystallized.length > 0
        ? crystallized
        : (profile?.interests ?? []).slice(0, PANORAMA_MAX_INTERESTS);

    const lastActiveMs = attrs.last_active_ms ?? 0;
    const privateCh = ensureChannelId(cid) ?? cid;
    const lastSharedToMs = G.has(privateCh)
      ? Number(G.getDynamic(privateCh, "last_shared_ms") ?? 0)
      : 0;

    // ADR-208 W2: top-1 特质（按 |value| 降序）
    const traitEntries = Object.entries(profile?.traits ?? {});
    const topTrait =
      traitEntries.length > 0
        ? traitEntries.sort((a, b) => Math.abs(b[1].value) - Math.abs(a[1].value))[0][0]
        : null;

    contactCandidates.push({ name, tier, interests, lastActiveMs, lastSharedToMs, topTrait });
  }

  // 有兴趣标签的人优先（频道转发场景的核心信号），然后按 tier 升序、活跃度降序
  contactCandidates.sort((a, b) => {
    const aHas = a.interests.length > 0 ? 0 : 1;
    const bHas = b.interests.length > 0 ? 0 : 1;
    return aHas - bHas || a.tier - b.tier || b.lastActiveMs - a.lastActiveMs;
  });

  for (const c of contactCandidates.slice(0, PANORAMA_MAX_CONTACTS)) {
    const tierInfo = c.topTrait ? `${tierLabel(c.tier)}, ${c.topTrait}` : tierLabel(c.tier);
    const parts: string[] = [`${c.name} (${tierInfo})`];
    if (c.interests.length > 0) parts.push(`— ${c.interests.join(", ")}`);
    if (c.lastActiveMs > 0) {
      parts.push(`| ${formatElapsed(nowMs - c.lastActiveMs)} ago`);
    }
    if (c.lastSharedToMs > 0 && nowMs - c.lastSharedToMs < 3_600_000) {
      parts.push("| shared recently");
    }
    const line = parts.join(" ");
    totalChars += line.length;
    if (totalChars > PANORAMA_MAX_CHARS && lines.length > 0) break;
    lines.push(`- ${line}` as PromptLine);
  }

  // -- ADR-208: 群组段 --
  const PANORAMA_MAX_GROUPS = 4;
  const joinedChannels = G.getNeighbors(ALICE_SELF, "joined");
  const groupCandidates: Array<{ name: string; interests: string[]; topic: string | null }> = [];

  for (const chId of joinedChannels) {
    if (!G.has(chId) || G.getNodeType(chId) !== "channel") continue;
    const chAttrs = G.getChannel(chId);
    const chatType = chAttrs.chat_type ?? "unknown";
    if (chatType !== "group" && chatType !== "supergroup") continue;

    const name = safeDisplayName(G, chId);
    const gp = groupProfiles[chId];
    const crystallized = Object.values(gp?.crystallizedInterests ?? {})
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, PANORAMA_MAX_INTERESTS)
      .map((ci) => ci.label);
    const topic = gp?.topic ?? null;

    groupCandidates.push({ name, interests: crystallized, topic });
  }

  for (const g of groupCandidates.slice(0, PANORAMA_MAX_GROUPS)) {
    const parts: string[] = [`[group] ${g.name}`];
    if (g.interests.length > 0) {
      parts.push(`— ${g.interests.join(", ")}`);
    } else if (g.topic) {
      parts.push(`— ${g.topic.slice(0, 40)}`);
    }
    const line = parts.join(" ");
    totalChars += line.length;
    if (totalChars > PANORAMA_MAX_CHARS && lines.length > 0) break;
    lines.push(`- ${line}` as PromptLine);
  }

  return lines;
}

/** 将毫秒时间差转为自然语言。 */
function formatElapsed(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

// -- Mod 状态 -----------------------------------------------------------------

/**
 * ADR-208: 结晶兴趣 — 单极 [0,1] 置信度，BeliefStore interest: 域沉淀。
 * 与 CrystallizedTrait 的双极 [-1,1] 不同：兴趣只有"有/无"，没有反面。
 * @see docs/adr/208-cognitive-label-interest-domain.md
 */
export interface CrystallizedInterest {
  /** 归一化标签（lowercase, underscore-separated）。 */
  label: string;
  /** 置信度 [0,1]，从 BeliefStore μ 派生。 */
  confidence: number;
  /** 结晶发生的 tick。 */
  crystallizedAt: number;
  /** 结晶发生的墙钟时间（ms）。 */
  crystallizedAtMs: number;
  /** 上次被 tag_interest 强化的 tick。 */
  lastReinforced: number;
  /** 上次被 tag_interest 强化的墙钟时间（ms）。 */
  lastReinforcedMs: number;
}

/**
 * ADR-89: 结晶特质 — 多次一致观察后从 BeliefStore 沉淀的持久特质。
 * @see docs/adr/89-impression-formation-system.md §Wave 2
 */
export interface CrystallizedTrait {
  /** 特质值 [-1, 1]，正/负对应 bipolar 维度的两极。 */
  value: number;
  /** 结晶发生的 tick。 */
  crystallizedAt: number;
  /** ADR-110: 结晶发生的墙钟时间（ms）。新数据必有，旧数据可能缺失。 */
  crystallizedAtMs?: number;
  /** 上次被 self_sense 强化的 tick。 */
  lastReinforced: number;
  /** ADR-110: 上次被 self_sense 强化的墙钟时间（ms）。新数据必有，旧数据可能缺失。 */
  lastReinforcedMs?: number;
}

/** M2: 联系人结构化画像。 */
export interface ContactProfile {
  // ADR-198 F10: communicationStyle 已移除（与 portrait 重叠）
  // ADR-198 F10: moodBaseline 已移除（传数值违反语义无障碍）
  /** 活跃时段 EMA 直方图（24 小时槽位，归一化后的活跃度）。 */
  activeHours: number[];
  /** 兴趣标签（LLM 通过 tag_interest 提取，最多 10 个）。 */
  interests: string[];
  /** 上次更新 tick。 */
  lastUpdatedTick: number;
  /** ADR-110: 上次更新的墙钟时间（ms）。新数据必有，旧数据可能缺失。 */
  lastUpdatedMs?: number;
  // ADR-198 F9: trust 字段已删除。信任度统一由 rv_trust（图属性）管理。
  // 旧 state 中残留的 trust 值成为死数据，不再被读取。
  /** 上次 tier 评估时的峰值活跃小时（用于检测模式变化）。 */
  previousPeakHour: number | null;
  /** 最近检测到的日程变化描述（如果有）。 */
  scheduleShift: string | null;
  /** ADR-64 VI-3: 综合印象叙事（LLM 通过 synthesize_portrait 生成）。 */
  portrait: string | null;
  /** ADR-64 VI-3: 印象上次更新 tick。 */
  portraitTick: number | null;
  /** ADR-110: 印象上次更新的墙钟时间（ms）。新数据必有，旧数据可能缺失。 */
  portraitMs?: number | null;
  /** ADR-89: 结晶特质 (dimension → CrystallizedTrait)。多次一致观察后从 BeliefStore 沉淀。 */
  traits: Record<string, CrystallizedTrait>;
  /** ADR-208: 结晶兴趣 (label → CrystallizedInterest)。从 BeliefStore interest: 域沉淀。旧数据可能缺失。 */
  crystallizedInterests?: Record<string, CrystallizedInterest>;
}

/**
 * ADR-64 VI-4: 群组画像。
 * 追踪群组的主题定位、社交氛围、Alice 的角色和关键成员。
 */
export interface GroupProfile {
  /** 群组主题/话题方向（LLM 生成）。 */
  topic: string | null;
  /** 群组社交氛围描述。 */
  atmosphere: string | null;
  /** Alice 在群中的角色定位。 */
  aliceRole: string | null;
  /** 关键成员描述。 */
  memberHighlights: string | null;
  /** 上次更新 tick。 */
  portraitTick: number | null;
  /** ADR-110: 上次更新的墙钟时间（ms）。新数据必有，旧数据可能缺失。 */
  portraitMs?: number | null;
  /** ADR-208: 结晶兴趣/话题标签 (label → CrystallizedInterest)。旧数据可能缺失。 */
  crystallizedInterests?: Record<string, CrystallizedInterest>;
}

/** 创建空白画像。 */
function emptyProfile(tick: number, nowMs?: number): ContactProfile {
  return {
    activeHours: new Array(24).fill(0),
    interests: [],
    lastUpdatedTick: tick,
    lastUpdatedMs: nowMs ?? Date.now(),
    previousPeakHour: null,
    scheduleShift: null,
    portrait: null,
    portraitTick: null,
    portraitMs: null,
    traits: {},
    crystallizedInterests: {},
  };
}

function mergeContactProfile(target: ContactProfile, source: ContactProfile): void {
  for (let h = 0; h < 24; h++) {
    target.activeHours[h] = Math.max(target.activeHours[h] ?? 0, source.activeHours[h] ?? 0);
  }
  target.interests = Array.from(new Set([...target.interests, ...source.interests])).slice(0, 10);
  target.lastUpdatedTick = Math.max(target.lastUpdatedTick ?? 0, source.lastUpdatedTick ?? 0);
  target.lastUpdatedMs = Math.max(target.lastUpdatedMs ?? 0, source.lastUpdatedMs ?? 0);
  target.previousPeakHour ??= source.previousPeakHour;
  target.scheduleShift ??= source.scheduleShift;
  target.portrait ??= source.portrait;
  target.portraitTick ??= source.portraitTick;
  target.portraitMs ??= source.portraitMs;
  target.traits = { ...source.traits, ...target.traits };
  target.crystallizedInterests = {
    ...(source.crystallizedInterests ?? {}),
    ...(target.crystallizedInterests ?? {}),
  };
}

function normalizeContactProfileKeys(
  graph: WorldModel,
  state: Pick<RelationshipsState, "contactProfiles">,
): void {
  for (const [rawKey, profile] of Object.entries({ ...state.contactProfiles })) {
    const contactId = resolveDisplayName(graph, rawKey) ?? ensureContactId(rawKey);
    if (!contactId || contactId === rawKey || !graph.has(contactId)) continue;
    if (graph.getNodeType(contactId) !== "contact") continue;

    if (state.contactProfiles[contactId]) {
      mergeContactProfile(state.contactProfiles[contactId], profile);
    } else {
      state.contactProfiles[contactId] = profile;
    }
    delete state.contactProfiles[rawKey];
  }
}

/** ADR-64 VI-4: 创建空白群组画像。 */
function emptyGroupProfile(): GroupProfile {
  return {
    topic: null,
    atmosphere: null,
    aliceRole: null,
    memberHighlights: null,
    portraitTick: null,
    portraitMs: null,
    crystallizedInterests: {},
  };
}

/**
 * 活跃时段 EMA 更新系数。
 * EMA α = 0.1: 10-sample effective window，适合慢变化信号（频率基线、活跃模式）。
 * 通信工程标准做法：α = 2/(N+1)，N=19 → α ≈ 0.1。
 */
const ACTIVE_HOURS_ALPHA = 0.1;
/**
 * 情绪基线 EMA 更新系数。
 * ADR-198: MOOD_BASELINE_ALPHA 已删除（moodBaseline 字段已移除）。
 */

/** self 节点 facts 容量（高于普通联系人的 20 条）。 */
const SELF_FACTS_LIMIT = 50;
/** 普通联系人 facts 容量。 */
const CONTACT_FACTS_LIMIT = 20;

// ADR-41: 选择性上下文——top-N 注入防止写入-读取回声室
/**
 * contribute() 注入目标联系人 memorized facts 的上限。
 * ADR-46 C5 (ADR-41 专家共识 5): 10 → 7。
 * 认知科学依据: Miller's Law 7±2 + LLM lost-in-the-middle 效应。
 * @see docs/adr/41-write-read-loop-self-evolution.md §专家圆桌共识 5
 */
const MAX_INJECTED_FACTS = 7;
/**
 * contribute() 注入 self memorized facts 的上限。
 * ADR-46 C5: 15 → 10（自我知识配额仍高于联系人，但更紧凑）。
 */
const MAX_INJECTED_SELF_FACTS = 10;

// -- M4: Tier 演化引擎 --------------------------------------------------------

/**
 * Dunbar 层级阶梯。Tier 只沿阶梯移动，不跳级。
 * 500(known) → 150(acquaintance) → 50(friend) → 15(close friend) → 5(intimate)
 */
export const DUNBAR_TIERS = [500, 150, 50, 15, 5] as const;

/** Tier 演化评估间隔（ticks）。 */
export const TIER_EVAL_INTERVAL = 100;
/**
 * 升级连续阈值。
 * 阈值标定: 三分位设计 — 0.7 = top 30% 升级, 0.3 = bottom 30% 降级。
 * 基于 Granovetter (1973) 弱关系理论的非对称升降级：
 * 升级需要强信号（top 30%），降级需要持续弱信号（连续 5 次 bottom 30%）。
 * 非对称保护防止睡眠期误降级。
 */
export const TIER_UPGRADE_THRESHOLD = 0.7;
/**
 * 降级连续阈值。
 * @see TIER_UPGRADE_THRESHOLD 阈值标定说明
 */
export const TIER_DOWNGRADE_THRESHOLD = 0.3;
/** 升级连续次数要求。 */
export const TIER_CONSECUTIVE_REQUIRED = 3;
/**
 * 降级连续次数要求（非对称，更保守）。
 * 关系建立比关系流失慢——升级 3 次（5 小时），降级 5 次（~8.3 小时）。
 * 避免 Alice 睡眠/离线期间的 5 小时静默触发 intimate → close_friend 误降级。
 * @see Gilbert & Karahalios (2009) — 关系强度评估的非对称性
 */
export const TIER_DOWNGRADE_CONSECUTIVE = 5;

/**
 * ADR-110: Frequency 评估窗口（秒）。
 * ADR-45 真实数据标定: D1=5.6/天, D2=2.3/天。
 * FREQUENCY_WINDOW_S=86400 (1 天 = 86400 秒)。
 * 与 TIER_EVAL_INTERVAL（评估频率）解耦：每 100 ticks 评估一次，但回看完整 1 天的数据。
 * @see docs/adr/45-real-data-validation.md §5 F5
 * @see docs/adr/46-real-data-calibration.md
 */
const FREQUENCY_WINDOW_S = 86400;

// -- ADR-89: 印象结晶参数 --------------------------------------------------

/** 结晶条件：σ² 低于此值（多次一致观察后方差收敛）。 */
const CRYSTALLIZE_SIGMA2 = 0.05;
/** 结晶条件：至少 N 次 self_sense 观察。 */
const CRYSTALLIZE_MIN_OBS = 3;
/** 结晶条件：|μ| 超过此值（排除中性特质）。 */
const CRYSTALLIZE_MU_THRESHOLD = 0.2;
/** ADR-110: 结晶特质慢衰减半衰期（秒）：604800 秒 = 7 天。 */
const CRYSTALLIZED_TRAIT_HALFLIFE_S = 604800;
/** 结晶特质消亡阈值：|value| 低于此值时删除。 */
const CRYSTALLIZED_TRAIT_EPSILON = 0.05;

// -- ADR-208: 兴趣结晶参数 ---------------------------------------------------
// @see docs/adr/208-cognitive-label-interest-domain.md

/** 兴趣结晶条件：σ² 低于此值（比 trait 的 0.05 略宽松，与 jargon 的 0.08 居中）。 */
const INTEREST_CRYSTALLIZE_SIGMA2 = 0.06;
/** 兴趣结晶条件：至少 N 次 tag_interest 观察（与 jargon 的 2 对齐）。 */
const INTEREST_CRYSTALLIZE_MIN_OBS = 2;
/** 兴趣结晶条件：μ 超过此值（单极，仅正方向有意义）。 */
const INTEREST_CRYSTALLIZE_MU_THRESHOLD = 0.3;
/** 结晶兴趣慢衰减半衰期（秒）：30 天。兴趣比性格更稳定。 */
const CRYSTALLIZED_INTEREST_HALFLIFE_S = 2_592_000;
/** 结晶兴趣消亡阈值：confidence 低于此值时删除。 */
const CRYSTALLIZED_INTEREST_EPSILON = 0.05;
/** ADR-121 Layer 3: Consolidation Hint — facts 数量阈值（≤ 此值时触发提示）。 */
const CONSOLIDATION_MAX_FACTS = 2;
/** ADR-121 Layer 3: Consolidation Hint — 最少交互次数（> 此值时触发提示）。 */
const CONSOLIDATION_MIN_INTERACTIONS = 5;

/**
 * 每个 tier 期望的日交互频率（每 FREQUENCY_WINDOW_S 秒 = 1 天）。
 * ADR-45 真实数据标定: D1 = 5.6 条/天, D2 = 2.3 条/天。
 * @see docs/adr/45-real-data-validation.md §5 F5
 * @see docs/adr/46-real-data-calibration.md
 * @see Gilbert & Karahalios (2009) — 交互频率是关系强度最强预测器
 */
const EXPECTED_FREQUENCY: Record<number, number> = {
  5: 6, // intimate: ~6 interactions/day（典型亲密私聊）
  15: 3, // close friend: ~3/day
  50: 1, // friend: ~1/day
  150: 0.3, // acquaintance: ~every 3 days
  500: 0.1, // known: ~every 10 days
};

/** Tier 演化跟踪器（per-contact）。 */
interface TierTracker {
  /** 连续高分次数。 */
  consecutiveHigh: number;
  /** 连续低分次数。 */
  consecutiveLow: number;
  /** 上次评估 tick。 */
  lastEvalTick: number;
  /** ADR-110: 上次评估的墙钟时间（ms）。 */
  lastEvalMs?: number;
}

/**
 * 计算 Tier 演化分数。
 * ADR-47 G9: TierScore = 0.35 × Frequency + 0.25 × Quality + 0.25 × Depth + 0.15 × Trust
 *
 * 权重标定依据: Gilbert & Karahalios (2009) "Predicting tie strength with social media"
 * — 交互频率是关系强度最强预测器 (β=0.35)，通信深度和质量次之 (各 0.25)，
 *   信任是独立维度但主观性最强 (0.15)。偏差 ≤ 0.039。
 * @see https://doi.org/10.1145/1518701.1518736
 *
 * @param interactionCount - 最近 100 ticks 的交互次数
 * @param tier - 当前 tier
 * @param avgQuality - 最近行动质量均值 [-1, 1]
 * @param factCount - 事实数量
 * @param maxFacts - 事实上限
 * @param threadInvolvement - 参与的活跃 Thread 数
 * @param maxThreads - Thread 上限
 * @param trust - 信任度 [0, 1]，默认 0.5
 * @param aliceInitiated - Alice 主动发起对话次数（累积）
 * @param contactInitiated - 对方主动发起对话次数（累积）
 */
export function tierScore(
  interactionCount: number,
  tier: number,
  avgQuality: number,
  factCount: number,
  maxFacts: number,
  threadInvolvement: number,
  maxThreads: number,
  trust = 0.5,
  aliceInitiated = 0,
  contactInitiated = 0,
): number {
  const expected = EXPECTED_FREQUENCY[tier] ?? 2;
  const frequency = Math.min(1, interactionCount / expected);
  const quality = (avgQuality + 1) / 2; // 归一化到 [0, 1]
  const depth =
    (maxFacts > 0 ? factCount / maxFacts : 0) +
    (maxThreads > 0 ? threadInvolvement / maxThreads : 0);
  const normalizedDepth = Math.min(1, depth / 2); // depth 两项之和归一化

  // 互惠系数：防止 Alice 单方面高频互动抬升 tier。
  // reciprocity = min(1, sqrt(contactInitiated / aliceInitiated))
  // - 双方均衡 → 1.0（无影响）
  // - Alice 发起 4× → sqrt(1/4) = 0.5（频率得分减半）
  // - 对方发起更多 → 1.0（不过度加分）
  // - 总互动 < 5 次 → 不激活（冷启动噪声保护）
  // sqrt 阻尼避免过于苛刻（2:1 比例在健康关系中也常见）。
  // @see docs/adr/151-algorithm-audit/research-online-calibration.md
  const totalInitiated = aliceInitiated + contactInitiated;
  let reciprocity = 1.0;
  if (totalInitiated >= 5 && aliceInitiated > 0) {
    reciprocity = Math.min(1, Math.sqrt(contactInitiated / aliceInitiated));
  }

  const rawScore = 0.35 * frequency + 0.25 * quality + 0.25 * normalizedDepth + 0.15 * trust;
  return rawScore * reciprocity;
}

/**
 * 获取下一个更亲密的 tier（升级方向）。
 * 如果已在最亲密层级 (5) 则返回 null。
 */
export function nextCloserTier(currentTier: number): DunbarTier | null {
  const idx = (DUNBAR_TIERS as readonly number[]).indexOf(currentTier);
  if (idx < 0) {
    // 不在标准阶梯上，找最近的更低 tier（DUNBAR_TIERS 降序，正向遍历第一个 < currentTier 即最近）
    for (const t of DUNBAR_TIERS) {
      if (t < currentTier) return t;
    }
    return null;
  }
  return idx < DUNBAR_TIERS.length - 1 ? DUNBAR_TIERS[idx + 1] : null;
}

/**
 * 获取下一个更疏远的 tier（降级方向）。
 * 如果已在最疏远层级 (500) 则返回 null。
 */
export function nextFartherTier(currentTier: number): DunbarTier | null {
  const idx = (DUNBAR_TIERS as readonly number[]).indexOf(currentTier);
  if (idx < 0) {
    // 不在标准阶梯上，找最近的更高 tier（DUNBAR_TIERS 降序，反向遍历第一个 > currentTier 即最近）
    for (let i = DUNBAR_TIERS.length - 1; i >= 0; i--) {
      if (DUNBAR_TIERS[i] > currentTier) return DUNBAR_TIERS[i];
    }
    return null;
  }
  return idx > 0 ? DUNBAR_TIERS[idx - 1] : null;
}

interface RelationshipsState {
  /** 当前行动目标。 */
  targetNodeId: string | null;
  /** M2: 联系人结构化画像 (contactId → profile)。 */
  contactProfiles: Record<string, ContactProfile>;
  /** M4: Tier 演化跟踪器 (contactId → tracker)。 */
  tierTrackers: Record<string, TierTracker>;
  /** ADR-64 VI-4: 群组画像 (channelId → profile)。 */
  groupProfiles: Record<string, GroupProfile>;
  /** ADR-208: interest 域观察计数 (key = "entityId::interest:label")。 */
  interestObsCounts: Record<string, number>;
}

// -- Mod 定义 -----------------------------------------------------------------

export const relationshipsMod = createMod<RelationshipsState>("relationships", {
  category: "mechanic",
  description: "联系人档案 + 语言偏好检测",
  depends: ["memory"],
  topics: ["social"],
  initialState: {
    targetNodeId: null,
    contactProfiles: {},
    tierTrackers: {},
    groupProfiles: {},
    interestObsCounts: {},
  },
})
  .instruction("set_language", {
    params: z.object({
      contactId: z.string().min(1).describe("联系人 ID"),
      language: z.string().min(2).max(10).describe("语言代码 (zh-CN, en, etc.)"),
    }),
    description: "设置联系人的语言偏好",
    examples: ['set_language({ contactId: "u123", language: "zh-CN" })'],
    affordance: {
      whenToUse: "Set a contact's preferred language after detecting it from their messages",
      whenNotToUse: "When language preference is already correct",
      priority: "sensor",
    },
    impl(ctx, args) {
      const contactId = String(args.contactId);
      const lang = String(args.language);
      if (!ctx.graph.has(contactId)) {
        return { success: false, error: `contact not found: ${contactId}` };
      }
      const previous = ctx.graph.getContact(contactId).language_preference;
      ctx.graph.updateContact(contactId, { language_preference: lang });
      return { success: true, contactId, language: lang, previous: previous ?? null };
    },
  })
  /**
   * ADR-43 P1: 设置联系人的关系类型（与 tier 正交）。
   * 由 LLM 在对话中推断并调用。
   * 安全约束：romantic 只能在 tier ≤ 50 时设置。
   * @see docs/adr/43-m1.5-feedback-loop-relation-type.md §P1
   */
  .instruction("set_relation_type", {
    params: z.object({
      contactId: z.string().min(1).describe("联系人 ID"),
      relationType: z
        .enum([
          "romantic",
          "close_friend",
          "friend",
          "family",
          "colleague",
          "acquaintance",
          "unknown",
        ])
        .describe(
          "关系类型: romantic | close_friend | friend | family | colleague | acquaintance | unknown",
        ),
      reason: z.string().optional().describe("变更理由（审计日志）"),
    }),
    description: "设置联系人的关系类型（与亲密度 tier 正交的维度）",
    examples: [
      'set_relation_type({ contactId: "u123", relationType: "friend", reason: "long conversations" })',
    ],
    affordance: {
      whenToUse: "Classify the relationship type when it becomes clear",
      whenNotToUse: "When relationship type hasn't changed",
      priority: "capability",
      category: "social",
    },
    impl(ctx, args) {
      const contactId = String(args.contactId);
      // Zod z.enum([...]) 已校验合法值
      const relationType = String(args.relationType);

      if (!ctx.graph.has(contactId)) {
        return { success: false, error: `contact not found: ${contactId}` };
      }

      const attrs = ctx.graph.getContact(contactId);
      const currentTier = attrs.tier ?? 150;
      const previous = attrs.relation_type ?? "unknown";

      // 安全约束：romantic 需要至少 friend 级别（tier ≤ 50）
      if (relationType === "romantic" && currentTier > 50) {
        return {
          success: false,
          error: `romantic requires tier ≤ 50 (current: ${currentTier})`,
          suggestion: "Build more familiarity first",
        };
      }

      // Zod z.enum 已校验 relationType 为合法 RelationType 值，安全 cast
      ctx.graph.updateContact(contactId, {
        relation_type: relationType as RelationType,
        relation_type_set_ms: ctx.nowMs,
      });

      // ADR-123: 结构通道更新 tier 信念（自动记录 changelog）
      // SET_RELATION_TYPE 是 LLM 明确判定，用 structural channel（覆写，σ² → ε）
      // @see paper-pomdp/ Def 3.2
      ctx.graph.beliefs.update(contactId, "tier", currentTier, "structural", ctx.nowMs);

      return {
        success: true,
        contactId,
        previous,
        relationType,
        reason: args.reason ? String(args.reason) : null,
      };
    },
  })
  /**
   * ADR-198 F11: 记录联系人活跃时段。
   * 原 update_contact_profile 的 moodBaseline + communicationStyle 字段已移除：
   * - moodBaseline: 传数值违反语义无障碍
   * - communicationStyle: 与 portrait 完全重叠
   */
  .instruction("note_active_hour", {
    params: z.object({
      contactId: z.string().min(1).describe("联系人 ID"),
      hour: z.number().int().min(0).max(23).describe("当前观察到的活跃小时 (0-23)"),
    }),
    description: "记录联系人当前活跃时段（EMA 更新 24 小时活跃度直方图）",
    affordance: {
      whenToUse: "Note when a contact is actively chatting to track their active hours pattern",
      whenNotToUse: "When you've already noted their activity this session",
      priority: "capability",
      category: "social",
    },
    impl(ctx, args) {
      const rawContactId = String(args.contactId);
      const contactId =
        resolveDisplayName(ctx.graph, rawContactId) ?? ensureContactId(rawContactId);
      const hour = Number(args.hour);

      if (
        !contactId ||
        !ctx.graph.has(contactId) ||
        ctx.graph.getNodeType(contactId) !== "contact"
      ) {
        return { success: false, error: `contact not found: ${rawContactId}` };
      }

      if (!ctx.state.contactProfiles[contactId]) {
        ctx.state.contactProfiles[contactId] = emptyProfile(ctx.tick, ctx.nowMs);
      }
      const profile = ctx.state.contactProfiles[contactId];
      profile.lastUpdatedTick = ctx.tick;
      profile.lastUpdatedMs = ctx.nowMs;

      // EMA 更新对应小时槽位
      for (let h = 0; h < 24; h++) {
        profile.activeHours[h] *= 1 - ACTIVE_HOURS_ALPHA;
      }
      profile.activeHours[hour] += ACTIVE_HOURS_ALPHA;

      return { success: true, contactId, hour, profile };
    },
  })
  /**
   * ADR-208: 为联系人或群组标记兴趣/话题标签。
   * 写入 BeliefStore interest: 域 → 多次观察后结晶 → 持久标签 + 30 天慢衰减。
   * @see docs/adr/208-cognitive-label-interest-domain.md
   */
  .instruction("tag_interest", {
    params: z.object({
      who: z.string().min(1).describe("联系人名或群组名"),
      interest: z.string().trim().min(1).max(50).describe("兴趣/话题标签（简洁，如 'AI', '摄影'）"),
    }),
    deriveParams: {
      who: (cv: Record<string, unknown>) => cv.TARGET_CONTACT ?? cv.TARGET_CHAT,
    },
    description: "Tag someone's or a group's interest (reinforced through repeated observation)",
    affordance: {
      whenToUse:
        "Tag a contact's or group's interest when they discuss something they enjoy or focus on",
      whenNotToUse: "When the interest is too vague",
      priority: "capability",
      category: "social",
    },
    impl(ctx, args) {
      const rawWho = String(args.who);
      const entityId = resolveDisplayName(ctx.graph, rawWho) ?? rawWho;

      if (!ctx.graph.has(entityId)) {
        return { success: false, error: `entity not found: ${rawWho}` };
      }
      const nodeType = ctx.graph.getNodeType(entityId);
      if (nodeType !== "contact" && nodeType !== "channel") {
        return { success: false, error: "tag_interest only applies to contacts or channels" };
      }

      // ADR-50: 标签归一化（代码侧完成）
      const label = String(args.interest).toLowerCase().trim().replace(/\s+/g, "_");

      // BeliefStore EMA 融合（semantic 通道，observation=1.0 = 一次正向观察）
      const belief = ctx.graph.beliefs.update(
        entityId,
        `interest:${label}`,
        1.0,
        "semantic",
        ctx.nowMs,
      );

      // 观察计数（用于结晶条件）
      if (!ctx.state.interestObsCounts) ctx.state.interestObsCounts = {};
      const countKey = `${entityId}::interest:${label}`;
      ctx.state.interestObsCounts[countKey] = (ctx.state.interestObsCounts[countKey] ?? 0) + 1;
      const obsCount = ctx.state.interestObsCounts[countKey];

      // 定位结晶兴趣存储
      let crystallized: Record<string, CrystallizedInterest>;
      if (nodeType === "contact") {
        if (!ctx.state.contactProfiles[entityId]) {
          ctx.state.contactProfiles[entityId] = emptyProfile(ctx.tick, ctx.nowMs);
        }
        const profile = ctx.state.contactProfiles[entityId];
        profile.lastUpdatedTick = ctx.tick;
        profile.lastUpdatedMs = ctx.nowMs;
        if (!profile.crystallizedInterests) profile.crystallizedInterests = {};
        crystallized = profile.crystallizedInterests;
      } else {
        if (!ctx.state.groupProfiles) ctx.state.groupProfiles = {};
        if (!ctx.state.groupProfiles[entityId]) {
          ctx.state.groupProfiles[entityId] = emptyGroupProfile();
        }
        if (!ctx.state.groupProfiles[entityId].crystallizedInterests) {
          ctx.state.groupProfiles[entityId].crystallizedInterests = {};
        }
        crystallized = ctx.state.groupProfiles[entityId].crystallizedInterests;
      }

      const existing = crystallized[label];
      if (existing) {
        // 已结晶 → 强化（刷新 lastReinforced + 更新 confidence）
        existing.lastReinforced = ctx.tick;
        existing.lastReinforcedMs = ctx.nowMs;
        existing.confidence = Math.min(1, belief.mu);
        return {
          success: true,
          entityId,
          label,
          crystallized: true,
          reinforced: true,
          observations: obsCount,
        };
      }

      // 结晶检查：σ² < threshold && obs >= N && μ > threshold
      if (
        belief.sigma2 < INTEREST_CRYSTALLIZE_SIGMA2 &&
        obsCount >= INTEREST_CRYSTALLIZE_MIN_OBS &&
        belief.mu > INTEREST_CRYSTALLIZE_MU_THRESHOLD
      ) {
        crystallized[label] = {
          label,
          confidence: Math.min(1, belief.mu),
          crystallizedAt: ctx.tick,
          crystallizedAtMs: ctx.nowMs,
          lastReinforced: ctx.tick,
          lastReinforcedMs: ctx.nowMs,
        };
        return {
          success: true,
          entityId,
          label,
          crystallized: true,
          reinforced: false,
          observations: obsCount,
        };
      }

      return { success: true, entityId, label, crystallized: false, observations: obsCount };
    },
  })
  /**
   * M3: 记录带遗忘曲线的事实 → fact 图节点。
   * 事实存储为 fact 节点，通过 "knows" 边连接到 contact/agent。
   * 支持 P2 遗忘曲线遍历。
   */
  .instruction("note", {
    deriveParams: {
      // TARGET_CONTACT 已是正确的 contact:xxx 格式（由 buildContextVars 解析）。
      // 旧逻辑从 TARGET_CHAT（channel:xxx）转换会产出错误格式。
      // @see docs/adr/115-evolve-observability/alice-injection-audit.md §2.4
      contactId: (cv: Record<string, unknown>) => cv.TARGET_CONTACT,
    },
    perTurnCap: 3,
    params: z.object({
      contactId: z.string().min(1).describe("联系人 ID（'self' = Alice 自身）"),
      fact: z.string().trim().min(1).max(500).describe("事实描述"),
      type: z
        .enum(["interest", "preference", "skill", "growth", "observation", "general"])
        .optional()
        .describe("事实类型（interest/preference/skill/growth/observation/general）"),
    }),
    description: "记录带遗忘曲线的事实（存储为 fact 图节点）",
    examples: ['self_note({ fact: "likes cats", type: "preference" })'],
    affordance: {
      priority: "sensor",
      whenToUse: "Learning new facts about contacts worth remembering",
      whenNotToUse: "No new personal information shared",
    },
    impl(ctx, args) {
      // ADR-204 C10: LLM 可能提供 display_name，代码侧解析为 nodeId
      const rawId = String(args.contactId);
      const contactId = resolveDisplayName(ctx.graph, rawId) ?? rawId;
      // Zod z.string().trim().min(1).max(500) 保证非空已 trim
      const content = String(args.fact);

      const factType = args.type ? String(args.type) : "general";

      // ADR-47 G6: 归一化去重（宽松匹配：大小写 + 空白不敏感）
      const normalized = normalizeFactContent(content);
      const existingFacts = getContactFacts(ctx.graph, contactId);
      const existing = existingFacts.find(
        (f) => normalizeFactContent(f.attrs.content ?? "") === normalized,
      );
      if (existing) {
        // 重复提及 → 被动强化：stability × 1.2，last_access 刷新。
        // 高稳定性 facts（preference S=40）被重复提及后变得更稳定（S→48→57.6…），
        // 低稳定性 facts（observation S=1）也因重复提及而延长半衰期（S→1.2→1.44…）。
        ctx.graph.updateFact(existing.id, {
          last_access_ms: ctx.nowMs,
          stability: existing.attrs.stability * STABILITY_REINFORCE_FACTOR,
          reinforcement_count: (existing.attrs.reinforcement_count ?? 1) + 1,
        });
        return {
          success: true,
          contactId,
          isDuplicate: true,
          reinforced: true,
          factCount: existingFacts.length,
        };
      }

      // 创建 fact 节点 + knows 边
      const iid = nextFactId();
      // ADR-69 T2.4: source 字段区分 LLM 创建 vs perceive 自动创建
      // ADR-104: source_channel 从当前行动目标推断
      const sourceChannel = ctx.state.targetNodeId ?? undefined;
      // ADR-156: observation 类型的事实自带情感反应度（刚发生的观察往往带情绪）。
      // 其他类型（interest/preference/skill/general）视为中性事实，不设 reactivity。
      const isEmotionalFact = factType === "observation";
      // 连续稳定性频谱：初始 stability 由 fact_type 决定。
      // preference/skill (S₀=40) → ~3年半衰期；observation (S₀=1) → ~27天半衰期。
      const initialStability = factTypeInitialStability(factType);
      ctx.graph.addFact(iid, {
        content,
        fact_type: factType,
        importance: 0.5,
        stability: initialStability,
        last_access_ms: ctx.nowMs,
        volatility: 0,
        tracked: false,
        created_ms: ctx.nowMs,
        novelty: 1.0,
        reinforcement_count: 1,
        source_contact: contactId,
        source_channel: sourceChannel,
        source: "llm",
        ...(isEmotionalFact && { reactivity: 1.0, reactivity_ms: ctx.nowMs }),
      });
      ctx.graph.addRelation(contactId, "knows", iid);

      // 容量控制：self 50 条，其他 20 条。超出时淘汰 R 最低的节点。
      // 连续稳定性频谱下 R 对所有 fact_type 都有意义——高稳定性 facts 自然 R 更高，
      // 受到淘汰保护；低稳定性 + 旧 facts 自然 R 更低，优先淘汰。
      const allFacts = getContactFacts(ctx.graph, contactId);
      const limit = contactId === ALICE_SELF ? SELF_FACTS_LIMIT : CONTACT_FACTS_LIMIT;
      while (allFacts.length > limit) {
        let worstIdx = 0;
        let worstR = Number.MAX_VALUE;
        for (let i = 0; i < allFacts.length; i++) {
          const r = factRetrievabilityFromNode(allFacts[i].attrs, ctx.nowMs);
          if (r < worstR) {
            worstR = r;
            worstIdx = i;
          }
        }
        ctx.graph.removeEntity(allFacts[worstIdx].id);
        allFacts.splice(worstIdx, 1);
      }

      // ADR-204: 意识流 reinforce — remember 强化关联事件
      try {
        reinforceConsciousness(getDb(), [contactId], 0.1);
      } catch {
        /* non-critical */
      }

      return { success: true, contactId, isDuplicate: false, factCount: allFacts.length };
    },
  })
  /**
   * M3: 引用事实——更新 last_access 和 stability（巩固机制）。
   * 当 LLM 在回复中引用了某条事实时调用此指令。
   */
  .instruction("recall_fact", {
    params: z.object({
      contactId: z.string().min(1).describe("联系人 ID"),
      fact: z.string().min(1).describe("被引用的事实内容"),
    }),
    description: "标记一条事实被引用——巩固记忆（stability × 1.5）",
    affordance: {
      whenToUse: "Reinforce a memory when you reference it in conversation",
      whenNotToUse: "When the fact wasn't actually used",
      priority: "on-demand",
      category: "memory",
    },
    impl(ctx, args) {
      const contactId = String(args.contactId);
      const content = String(args.fact).trim();
      const facts = getContactFacts(ctx.graph, contactId);
      if (facts.length === 0) return { success: false, error: "no facts for contact" };

      // G6: 归一化匹配
      const normalized = normalizeFactContent(content);
      const fact = facts.find((f) => normalizeFactContent(f.attrs.content ?? "") === normalized);
      if (!fact) return { success: false, error: "fact not found" };

      const oldStability = fact.attrs.stability;
      const newStability = oldStability * FACT_CONSOLIDATION_FACTOR;
      ctx.graph.updateFact(fact.id, {
        last_access_ms: ctx.nowMs,
        stability: newStability,
      });

      return {
        success: true,
        contactId,
        content,
        oldStability,
        newStability,
        retrievability: factRetrievabilityFromNode(
          { ...fact.attrs, last_access_ms: ctx.nowMs, stability: newStability },
          ctx.nowMs,
        ),
      };
    },
  })
  /**
   * ADR-47 G2: 修改已记忆的事实内容。
   * 保留 stability 和 created，更新内容和 last_access。
   * 如果新内容与另一条事实重复，执行合并（取最高 stability，累加 reinforcement_count）。
   */
  .instruction("update_fact", {
    params: z.object({
      contactId: z.string().min(1).describe("联系人 ID（'self' = Alice 自身）"),
      oldContent: z.string().min(1).describe("要修改的事实内容（归一化匹配）"),
      newContent: z.string().trim().min(1).max(500).describe("新的事实内容"),
    }),
    description: "修改已记忆的事实内容。保留 stability，更新内容和 last_access。",
    affordance: {
      whenToUse: "Correct or update a previously remembered fact",
      whenNotToUse: "When the existing fact is still accurate",
      priority: "capability",
      category: "memory",
    },
    impl(ctx, args) {
      const contactId = String(args.contactId);
      const oldNorm = normalizeFactContent(String(args.oldContent));
      // Zod .trim().min(1).max(500) 保证非空已 trim
      const newContent = String(args.newContent);

      const facts = getContactFacts(ctx.graph, contactId);
      if (facts.length === 0) return { success: false, error: "no facts for contact" };

      const target = facts.find((f) => normalizeFactContent(f.attrs.content ?? "") === oldNorm);
      if (!target) return { success: false, error: "fact not found" };

      // 检查新内容是否与其他事实重复
      const newNorm = normalizeFactContent(newContent);
      const dup = facts.find(
        (f) => f.id !== target.id && normalizeFactContent(f.attrs.content ?? "") === newNorm,
      );
      if (dup) {
        // 合并：删除 target，更新 dup
        const mergedStability = Math.max(dup.attrs.stability, target.attrs.stability);
        const mergedRc =
          (dup.attrs.reinforcement_count ?? 1) + (target.attrs.reinforcement_count ?? 1);
        ctx.graph.updateFact(dup.id, {
          stability: mergedStability,
          last_access_ms: ctx.nowMs,
          reinforcement_count: mergedRc,
        });
        ctx.graph.removeEntity(target.id);
        return { success: true, merged: true, factCount: facts.length - 1 };
      }

      ctx.graph.updateFact(target.id, {
        content: newContent,
        last_access_ms: ctx.nowMs,
      });
      return { success: true, contactId, factCount: facts.length };
    },
  })
  /**
   * ADR-47 G2: 删除已记忆的事实。
   * 用于清理过时或错误的信息。归一化匹配。
   */
  .instruction("delete_fact", {
    params: z.object({
      contactId: z.string().min(1).describe("联系人 ID"),
      content: z.string().min(1).describe("要删除的事实内容（归一化匹配）"),
    }),
    description: "删除已记忆的事实。用于清理过时或错误的信息。",
    affordance: {
      whenToUse: "Remove a fact that's no longer true or relevant",
      whenNotToUse: "When the fact is still valid",
      priority: "on-demand",
      category: "memory",
    },
    impl(ctx, args) {
      const contactId = String(args.contactId);
      const norm = normalizeFactContent(String(args.content));

      const facts = getContactFacts(ctx.graph, contactId);
      if (facts.length === 0) return { success: false, error: "no facts for contact" };

      const target = facts.find((f) => normalizeFactContent(f.attrs.content ?? "") === norm);
      if (!target) return { success: false, error: "fact not found" };

      const deleted = target.attrs.content ?? "";
      ctx.graph.removeEntity(target.id);
      return { success: true, deleted, factCount: facts.length - 1 };
    },
  })
  /** 设置当前行动目标（由 act.ts 调用）。 */
  .instruction("SET_CONTACT_TARGET", {
    params: z.object({
      nodeId: z.string().optional().describe("目标节点 ID"),
    }),
    description: "设置当前行动目标（联系人）",
    impl(ctx, args) {
      ctx.state.targetNodeId = args.nodeId ? String(args.nodeId) : null;
      return ctx.state.targetNodeId;
    },
  })
  // ADR-198 F8: update_trust 已删除。trust 统一由 rv_trust（图属性）管理，
  // 通过 rate_outcome / self_sense 隐式积累。
  /**
   * ADR-64 VI-3: 生成联系人综合印象叙事。
   * LLM 在 Reflection 中调用，将离散 facts + profile 综合为 2-3 句话的连续印象。
   */
  .instruction("synthesize_portrait", {
    params: z.object({
      contactId: z.string().min(1).describe("联系人 ID"),
      portrait: z.string().trim().min(1).max(2000).describe("综合印象（2-3 句自然语言）"),
    }),
    description: "生成联系人的综合印象叙事（Living Portrait）",
    affordance: {
      whenToUse: "Write or update a living portrait summarizing your impression of someone",
      whenNotToUse: "When portrait is still fresh and accurate",
      priority: "on-demand",
      category: "social",
    },
    impl(ctx, args) {
      const contactId = String(args.contactId);
      // Zod .trim().min(1).max(2000) 保证非空已 trim
      const portrait = String(args.portrait);

      if (!ctx.state.contactProfiles[contactId]) {
        ctx.state.contactProfiles[contactId] = emptyProfile(ctx.tick, ctx.nowMs);
      }
      const profile = ctx.state.contactProfiles[contactId];
      profile.portrait = portrait;
      profile.portraitTick = ctx.tick;
      profile.portraitMs = ctx.nowMs;
      profile.lastUpdatedTick = ctx.tick;
      profile.lastUpdatedMs = ctx.nowMs;

      return { success: true, contactId, portraitTick: ctx.tick };
    },
  })
  /**
   * ADR-64 VI-4: 更新群组画像。
   * LLM 在 Reflection 中调用，记录群组的主题、氛围、Alice 角色和关键成员。
   */
  .instruction("update_group_profile", {
    params: z.object({
      channelId: z.string().min(1).describe("频道 ID"),
      topic: z.string().trim().optional().describe("群组主题/话题方向"),
      atmosphere: z.string().trim().optional().describe("群组社交氛围"),
      aliceRole: z.string().trim().optional().describe("Alice 在群中的角色定位"),
      memberHighlights: z.string().trim().optional().describe("关键成员描述"),
    }),
    description: "更新群组画像（主题、氛围、角色、成员）",
    affordance: {
      whenToUse: "Describe or update a group's topic, atmosphere, and your role in it",
      whenNotToUse: "When group profile is still fresh",
      priority: "on-demand",
      category: "social",
    },
    impl(ctx, args) {
      const channelId = String(args.channelId);

      if (!ctx.state.groupProfiles) ctx.state.groupProfiles = {};
      if (!ctx.state.groupProfiles[channelId]) {
        ctx.state.groupProfiles[channelId] = emptyGroupProfile();
      }
      const gp = ctx.state.groupProfiles[channelId];

      // Zod .trim().optional() 已处理 trim
      if (args.topic != null) gp.topic = String(args.topic) || null;
      if (args.atmosphere != null) gp.atmosphere = String(args.atmosphere) || null;
      if (args.aliceRole != null) gp.aliceRole = String(args.aliceRole) || null;
      if (args.memberHighlights != null)
        gp.memberHighlights = String(args.memberHighlights) || null;
      gp.portraitTick = ctx.tick;
      gp.portraitMs = ctx.nowMs;

      return { success: true, channelId, profile: gp };
    },
  })
  .query("contact_profile", {
    params: z.object({
      contactId: z.string().min(1).optional().describe("联系人 ID（省略则为当前联系人）"),
    }),
    deriveParams: {
      contactId: (cv: Record<string, unknown>) => cv.TARGET_CONTACT,
    },
    description: "获取联系人画像（含结构化 profile）",
    affordance: {
      priority: "capability",
      category: "social",
      whenToUse: "Need contact profile, facts, or relationship info",
      whenNotToUse: "Already know the person well from context",
    },
    returns:
      "{ contactId: string; displayName: string; tier: number; memorizedFacts: Array<{ content: string; fact_type: string; retrievability: number }> } | null",
    returnHint: "{displayName, tier, lang, facts: [{content, type, clarity}]}",
    impl(ctx, args) {
      normalizeContactProfileKeys(ctx.graph, ctx.state);
      const contactId = resolveContactId(ctx.graph, String(args.contactId));
      if (!contactId) return null;

      const attrs = ctx.graph.getContact(contactId);

      // M3: 从图节点返回 memorized facts + retrievability
      const facts = getContactFacts(ctx.graph, contactId);
      const memorizedWithR = facts.map((f) => ({
        content: f.attrs.content ?? "",
        fact_type: f.attrs.fact_type ?? "general",
        stability: f.attrs.stability,
        last_access_ms: f.attrs.last_access_ms,
        created_ms: f.attrs.created_ms,
        reinforcement_count: f.attrs.reinforcement_count ?? 1,
        retrievability: factRetrievabilityFromNode(f.attrs, ctx.nowMs),
        // ADR-156: 情感反应度 E(t)，用于 prompt 呈现调制
        emotionalReactivity: factEmotionalReactivity(f.attrs, ctx.nowMs),
      }));

      // ADR-198 F7c: 在 impl 中预计算 trust 标签（format 不接收 ctx）
      const rvTrust = readRV(attrs).trust;
      const trustLabel =
        rvTrust >= 0.8
          ? "deeply trusted"
          : rvTrust >= 0.6
            ? "trusted"
            : rvTrust >= 0.4
              ? "somewhat trusted"
              : rvTrust >= 0.25
                ? "cautious"
                : "guarded";

      return {
        contactId,
        displayName: safeDisplayName(ctx.graph, contactId),
        language: attrs.language_preference ?? null,
        interactionCount: attrs.interaction_count ?? 0,
        tier: attrs.tier ?? 50,
        memorizedFacts: memorizedWithR,
        profile: ctx.state.contactProfiles[contactId] ?? null,
        trustLabel,
      };
    },
    format(result) {
      const r = result as Record<string, unknown>;
      const interactions = Number(r.interactionCount ?? 0);
      const interactionDesc =
        interactions >= 100
          ? "many conversations"
          : interactions >= 30
            ? "several conversations"
            : interactions >= 10
              ? "some conversations"
              : "few conversations";
      const meta = [
        tierLabel(Number(r.tier ?? 50)),
        r.language ? `speaks ${r.language}` : null,
        interactionDesc,
      ]
        .filter(Boolean)
        .join(", ");
      const m = new PromptBuilder();
      m.line(`${r.displayName} — ${meta}`);

      const facts = r.memorizedFacts as Array<Record<string, unknown>> | undefined;
      if (facts?.length) {
        m.line("Facts:");
        for (const f of facts) {
          const rv = Number(f.retrievability);
          const ev = Number(f.emotionalReactivity ?? 0);
          // ADR-156: 情感反应度调制 clarity 标签。
          // E > VIVID_THRESHOLD → 用情感驱动标签（vivid/noted）
          // E ≤ NOTED_THRESHOLD → 回退到纯信息 clarity（不带情感标签）
          // 效果：同一条 "管我叫鱼酥"，2h 后从 (vivid) 降为 (noted)，4h 后变为纯信息
          let clarity: string;
          if (ev > EMOTIONAL_VIVID_THRESHOLD) {
            clarity = "vivid";
          } else if (ev > EMOTIONAL_NOTED_THRESHOLD) {
            clarity = "noted";
          } else {
            // 纯信息 clarity，不带情感暗示
            clarity = rv > 0.7 ? "clear" : rv > 0.4 ? "fading" : rv > 0.15 ? "dim" : "distant";
          }
          m.list([`[${f.fact_type}] ${f.content} (${clarity})`]);
        }
      }

      const profile = r.profile as Record<string, unknown> | null;
      if (profile) {
        if (profile.portrait) m.kv("Portrait", String(profile.portrait));
        // ADR-208: 优先结晶兴趣
        const ci208 = Object.values(
          (profile.crystallizedInterests as Record<string, CrystallizedInterest> | undefined) ?? {},
        )
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, 5);
        if (ci208.length > 0) {
          m.kv("Interests", ci208.map((i) => i.label).join(", "));
        } else {
          const interests = profile.interests as string[] | undefined;
          if (interests?.length) m.kv("Interests", interests.join(", "));
        }
      }
      // ADR-198 F7c: trust 标签从 impl 预计算（基于 rv_trust），不再读取 profile.trust
      if (r.trustLabel) m.kv("Trust", String(r.trustLabel));
      return m.build();
    },
  })
  .query("language_of", {
    params: z.object({
      contactId: z.string().min(1).optional().describe("联系人 ID（省略则为当前联系人）"),
    }),
    deriveParams: {
      contactId: (cv: Record<string, unknown>) => cv.TARGET_CONTACT,
    },
    description: "获取联系人语言偏好",
    affordance: {
      whenToUse: "Check what language a contact prefers",
      whenNotToUse: "When you already know their language",
      priority: "core",
    },
    returns: "string | null",
    impl(ctx, args) {
      const contactId = resolveContactId(ctx.graph, String(args.contactId));
      if (!contactId) return null;
      return ctx.graph.getContact(contactId).language_preference ?? null;
    },
  })
  /**
   * ADR-47 G5: 返回最高 tier 联系人的活跃峰值小时。
   * 从 ContactProfile.activeHours（24 槽 EMA 数组）推断 argmax。
   * 供 evolve.ts 学习型节律使用。
   * @see docs/adr/47-gap-closure.md §G5
   */
  .query("best_time", {
    params: z.object({}),
    description: "返回最高 tier 联系人的活跃峰值小时",
    affordance: {
      whenToUse: "Find out when your closest contact is usually active",
      whenNotToUse: "When timing doesn't matter for the current action",
      priority: "capability",
      category: "contact_info",
    },
    returns: "{ peakHour: number | undefined }",
    impl(ctx) {
      normalizeContactProfileKeys(ctx.graph, ctx.state);
      let bestTier = Number.POSITIVE_INFINITY;
      let bestProfile: ContactProfile | undefined;
      for (const [contactId, profile] of Object.entries(ctx.state.contactProfiles)) {
        if (!profile.activeHours || profile.activeHours.length !== 24) continue;
        const tier = ctx.graph.has(contactId) ? (ctx.graph.getContact(contactId).tier ?? 500) : 500;
        if (tier < bestTier) {
          bestTier = tier;
          bestProfile = profile;
        }
      }
      if (!bestProfile?.activeHours) return { peakHour: undefined };
      // 检查是否有任何非零值（全零表示无数据）
      const maxVal = Math.max(...bestProfile.activeHours);
      if (maxVal <= 0) return { peakHour: undefined };
      let peakHour = 14; // 默认
      let peakVal = -1;
      for (let h = 0; h < 24; h++) {
        if (bestProfile.activeHours[h] > peakVal) {
          peakVal = bestProfile.activeHours[h];
          peakHour = h;
        }
      }
      return { peakHour };
    },
  })
  .contribute((ctx): ContributionItem[] => {
    normalizeContactProfileKeys(ctx.graph, ctx.state);
    const target = ctx.state.targetNodeId;
    const items: ContributionItem[] = [];

    // 1. Self-knowledge 注入（无论是否有目标都注入）
    const mSelf = new PromptBuilder();

    // ADR-41: memorized self facts — top-N 注入防止写入-读取回声室
    // 连续稳定性频谱：统一按 R 排序（R 已包含 fact_type 稳定性差异）。
    const selfFacts = getContactFacts(ctx.graph, ALICE_SELF);
    if (selfFacts.length > 0) {
      // 按 R 过滤可检索事实，R 排序选 top-N
      const retrievableSelf = selfFacts
        .filter((f) => factRetrievabilityFromNode(f.attrs, ctx.nowMs) >= FACT_FORGET_THRESHOLD)
        .sort(
          (a, b) =>
            factRetrievabilityFromNode(b.attrs, ctx.nowMs) -
            factRetrievabilityFromNode(a.attrs, ctx.nowMs),
        );
      // ADR-196 F7: 匿名 Activity 行不渲染——"Activity: 3 messages in (a group)" 零决策信息
      const ANON_MARKERS = ["(a group)", "(a private chat)", "(someone)", "(unknown)"];
      const isAnonymousActivity = (content: string) =>
        content.startsWith("Activity:") && ANON_MARKERS.some((m) => content.includes(m));
      const topSelf = retrievableSelf
        .filter((f) => !isAnonymousActivity(f.attrs.content ?? ""))
        .slice(0, MAX_INJECTED_SELF_FACTS);
      // ADR-66 F15: 去标签化——CowAgent 原则"自然使用记忆，就像你本来就知道"。
      // RC2 修复：时间标注让 LLM 知道 self-note 是什么时候记录的
      mSelf.list(
        topSelf.map((f) => {
          const content = f.attrs.content ?? "";
          const createdMs = f.attrs.created_ms ?? 0;
          const agoS = createdMs > 0 ? (ctx.nowMs - createdMs) / 1000 : 0;
          if (agoS > 0) {
            return `${content} — ${humanDurationAgo(agoS)}`;
          }
          return content;
        }),
      );
      const selfRemaining = retrievableSelf.length - topSelf.length;
      if (selfRemaining > 0) {
        mSelf.line(`(${selfRemaining} more self-notes — they'll come to mind when relevant)`);
      }
    }

    const selfLines = mSelf.build();
    if (selfLines.length > 0) {
      items.push(section("self-knowledge", selfLines, "Self-notes", 18, 72));
    }

    if (!target) return items;

    // 2. 目标联系人画像（增强：全量 facts 注入）
    const { contactId, channelId } = resolveContactAndChannel(target, (id) => ctx.graph.has(id));

    // ADR-206: 频道 target 不渲染联系人画像（频道不是社交对等体）
    const targetChatType =
      channelId && ctx.graph.has(channelId) ? ctx.graph.getChannel(channelId).chat_type : undefined;
    if (targetChatType === "channel") {
      // ADR-206 W8: 注入精简社交全景——帮助 Alice 在频道 tick 内决定转发目标
      // @see docs/adr/206-channel-information-flow/ §12 收归转发职责
      const panorama = buildSocialPanorama(
        ctx.graph,
        ctx.state.contactProfiles,
        ctx.state.groupProfiles ?? {},
        ctx.nowMs,
      );
      if (panorama.length > 0) {
        items.push(section("social-panorama", panorama, "People you might share with", 24, 65));
      }
      return items;
    }

    if (contactId && ctx.graph.has(contactId)) {
      const attrs = ctx.graph.getContact(contactId);

      // ADR-91 Layer 3: Bot 联系人功能性渲染（无人格画像、无 formality）
      if (attrs.is_bot === true) {
        const displayName = safeDisplayName(ctx.graph, contactId);
        const botLines = [
          PromptBuilder.of(
            `${displayName} is a bot. Use commands to interact — no social conversation needed.`,
          ),
        ];
        items.push(section("contact-profile", botLines, undefined, 25, 75));
        return items;
      }

      const mContact = new PromptBuilder();

      // --- P1-A: 叙事散文画像 (ADR-55) ---
      // @see docs/adr/55-prompt-style-research — 叙事引擎 95号 + CowAgent 自然记忆
      const displayName = safeDisplayName(ctx.graph, contactId);
      const tier = attrs.tier ?? 50;
      // ADR-43: tier + relationType 组合展示
      const relationType = attrs.relation_type ?? "unknown";
      const tierDesc = tierLabel(tier);
      const relationDesc = relationType !== "unknown" ? `${tierDesc} (${relationType})` : tierDesc;

      const profile = ctx.state.contactProfiles[contactId];
      // ADR-198 F7b: 迁移到 rv_trust（图属性），替代 profile.trust（旧标量）
      const trustVal = readRV(attrs).trust;

      // ADR-66 F14: 核心身份改为自然语言，不暴露 tier 数字和 trust 标签。
      // 天然结构：让 LLM 感受关系亲疏，不需要知道系统内部评分。
      // ADR-198: 下界从 <= 0.3 调为 < 0.25（rv_trust 初始值 = 0.3，避免新联系人都显示 "still getting to know"）
      const trustPhrase =
        trustVal >= 0.7
          ? " you trust deeply"
          : trustVal < 0.25
            ? " you're still getting to know"
            : "";
      const interactionCount = attrs.interaction_count ?? 0;
      const historyPhrase =
        interactionCount > 50
          ? " Long history together."
          : interactionCount > 10
            ? " Plenty of conversation history."
            : "";
      mContact.line(`Talking to ${displayName} — ${relationDesc}${trustPhrase}.${historyPhrase}`);

      // ADR-151 T3: 动态礼貌 — 根据 tier 注入语气指导
      const toneTemplate = TIER_TONE_GUIDANCE[tier];
      if (toneTemplate) {
        mContact.line(`tone: ${toneTemplate.replace("{name}", displayName)}`);
      }

      // 第二行：语言（ADR-198: communicationStyle 已移除，与 portrait 重叠）
      if (attrs.language_preference) {
        mContact.line(`They communicate in ${attrs.language_preference}.`);
      }

      // 第三行：兴趣（ADR-208: 优先结晶兴趣，回退旧 interests[]）
      if (profile) {
        const ci = Object.values(profile.crystallizedInterests ?? {})
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, 5);
        if (ci.length > 0) {
          mContact.line(`Noticed interests: ${ci.map((i) => i.label).join(", ")}.`);
        } else if (profile.interests.length > 0) {
          mContact.line(`Into ${profile.interests.join(", ")}.`);
        }
      }

      // 第四行：活跃时段 + 日程变化（ADR-198: moodBaseline 渲染已移除）
      if (profile) {
        const peakHour = profile.activeHours.indexOf(Math.max(...profile.activeHours));
        const peakVal = profile.activeHours[peakHour];
        if (peakVal > 0) {
          mContact.line(`They are most active around ${peakHour}:00.`);
        }
        if (profile.scheduleShift) {
          mContact.line(`Schedule change detected: ${profile.scheduleShift}.`);
        }
      }

      // --- ADR-89: 结晶特质渲染 ---
      // 在 Portrait 之前展示已结晶的 character traits，最多 5 个，按 |value| 降序。
      // @see docs/adr/89-impression-formation-system.md §Wave 2C
      if (profile && Object.keys(profile.traits).length > 0) {
        const sorted = Object.entries(profile.traits)
          .sort(([, a], [, b]) => Math.abs(b.value) - Math.abs(a.value))
          .slice(0, 5);
        const traitLabels = sorted.map(([dim, t]) => {
          const prefix = Math.abs(t.value) < 0.4 ? "a bit " : "";
          return `${prefix}${t.value > 0 ? dim : `not very ${dim}`}`;
        });
        mContact.line(`Character traits noticed: ${traitLabels.join(", ")}`);
      }

      // --- ADR-64 VI-3: Living Portrait ---
      if (profile?.portrait) {
        mContact.kv("Portrait", profile.portrait);
      }

      // --- P1-B: 记忆引用提示 (ADR-55) ---
      // @see docs/adr/55-prompt-style-research — 126号 "缺陷即暗示"
      // 连续稳定性频谱：统一按 R 排序（R 已包含 fact_type 稳定性差异）。
      const contactFacts = getContactFacts(ctx.graph, contactId);
      if (contactFacts.length > 0) {
        const retrievableFacts = contactFacts
          .filter((f) => factRetrievabilityFromNode(f.attrs, ctx.nowMs) >= FACT_FORGET_THRESHOLD)
          .sort(
            (a, b) =>
              factRetrievabilityFromNode(b.attrs, ctx.nowMs) -
              factRetrievabilityFromNode(a.attrs, ctx.nowMs),
          );
        const fadingFacts = contactFacts.filter(
          (f) => factRetrievabilityFromNode(f.attrs, ctx.nowMs) < FACT_FORGET_THRESHOLD,
        );

        if (retrievableFacts.length > 0) {
          const topFacts = retrievableFacts.slice(0, MAX_INJECTED_FACTS);
          // ADR-66 F4: 分条目展示，避免 lost-in-the-middle。
          // CowAgent 原则："自然使用记忆，就像你本来就知道。"
          // ADR-69: 归因渲染 — "Your notes" + "you noted this" 闭合因果感知环
          mContact.line("notes:");
          for (const f of topFacts) {
            // ADR-121 Layer 1: Source Attribution — 展示事实来源频道
            // RC2 修复：时间标注让 LLM 知道 fact 是什么时候记录的，避免重复 remember()
            const createdMs = f.attrs.created_ms ?? 0;
            const agoS = createdMs > 0 ? (ctx.nowMs - createdMs) / 1000 : 0;
            const agoLabel = agoS > 0 ? humanDurationAgo(agoS) : "";
            let suffix = agoLabel ? `noted ${agoLabel}` : "you noted this";
            if (f.attrs.source_channel && ctx.graph.has(f.attrs.source_channel)) {
              const chName = ctx.graph.getChannel(f.attrs.source_channel).display_name;
              if (chName)
                suffix = agoLabel ? `noticed in ${chName}, ${agoLabel}` : `noticed in ${chName}`;
            }
            mContact.line(`- ${f.attrs.content} — ${suffix}`);
          }
          const remaining = retrievableFacts.length - topFacts.length;
          if (remaining > 0) {
            mContact.line(`(${remaining} more notes — they'll come to mind when relevant)`);
          }
        } else if (fadingFacts.length > 0) {
          mContact.line(
            `${fadingFacts.length} older memories are getting fuzzy — consider recalling important ones.`,
          );
        }
      }

      // ADR-66: 无 facts 时用事实性描述，不用指令。
      if (contactFacts.length === 0) {
        mContact.line("Not much known about them yet.");
      }

      items.push(section("contact-profile", mContact.build(), undefined, 25, 75));

      // ADR-180: consecutive_caution_acts 升级自检已移除——IAUS 折叠 Caution 为
      // U_conflict_avoidance 共享 Consideration，不再产出 "caution" action type。

      // -- Formative Memories: 首次互动上下文注入 --
      // 当 Alice 首次与新联系人真正对话时，从共享群聊的 message_log 中收集
      // 该联系人的历史发言，注入 contribute() 上下文让 LLM 自然形成初始印象。
      // @see docs/adr/86-voyager-concordia-cross-analysis.md §C5 Formative Memories
      if (contactFacts.length === 0 && interactionCount <= 2) {
        try {
          const senderMessages = getRecentMessagesBySender(contactId, 15);
          if (senderMessages.length > 0) {
            const mFirstImpression = new PromptBuilder();
            mFirstImpression.line(
              `You've seen ${displayName} in shared chats. Here's what they said recently:`,
            );
            for (const msg of senderMessages) {
              if (!msg.text) continue;
              // ADR-172: 使用 safeDisplayName — 永不返回 raw graph ID
              const chatLabel = safeDisplayName(ctx.graph, msg.chatId);
              const truncated = msg.text.length > 150 ? `${msg.text.slice(0, 147)}...` : msg.text;
              mFirstImpression.line(`[${chatLabel}] "${truncated}"`);
            }
            mFirstImpression.line(
              "This is your first real conversation with them. Pay attention — use self note for facts and self sense for personality traits you notice.",
            );
            items.push(section("first-impression", mFirstImpression.build(), undefined, 26, 70));
          }
        } catch {
          // DB 不可用时跳过（测试环境等）
        }
      }

      // -- ADR-121 Layer 3: Consolidation Hint — 引导 LLM 固化跨群情节 --
      // 触发条件：少量 facts + 足够多次互动 + 有非私聊共享频道
      // @see docs/adr/121-social-peripheral-vision/README.md §3.4 Layer 3
      if (
        contactFacts.length <= CONSOLIDATION_MAX_FACTS &&
        interactionCount > CONSOLIDATION_MIN_INTERACTIONS
      ) {
        const sharedChannels = ctx.graph.getNeighbors(contactId, "joined").filter((chId) => {
          if (!ctx.graph.has(chId)) return false;
          const chAttrs = ctx.graph.getChannel(chId);
          return chAttrs.chat_type !== "private";
        });
        if (sharedChannels.length > 0) {
          items.push(
            section(
              "consolidation-hint",
              [
                PromptBuilder.of(
                  `You've seen ${displayName} around but have few notes. Use self note to capture what matters.`,
                ),
              ],
              undefined,
              27,
              55,
            ),
          );
        }
      }

      // Spreading Activation 关联记忆——拓扑上与目标相关但非直接连接的事实
      // @see paper/ §3.4 "Pressure Propagation via Weighted Laplacian"
      const seedEntities = [contactId, ...(channelId ? [channelId] : [])].filter((id) =>
        ctx.graph.has(id),
      );
      const activationHits = activationRetrieval(ctx.graph, seedEntities, ctx.nowMs);
      if (activationHits.length > 0) {
        // 排除已在 contactFacts 中展示的
        const directFactIds = new Set(contactFacts.map((f) => f.id));
        const associatedFacts = activationHits
          .filter((h) => !directFactIds.has(h.entityId) && ctx.graph.has(h.entityId))
          .slice(0, 3);
        if (associatedFacts.length > 0) {
          const mAssoc = new PromptBuilder();
          for (const hit of associatedFacts) {
            const content = ctx.graph.getDynamic(hit.entityId, "content");
            if (content) mAssoc.line(`- ${content}`);
          }
          const assocLines = mAssoc.build();
          if (assocLines.length > 0) {
            items.push(
              section(
                "associated-memories",
                assocLines,
                "Related things that come to mind:",
                26,
                40,
              ),
            );
          }
        }
      }

      // ADR-43: relationType 推断提醒
      // ADR-81: 压力门控——低压力时注入关系分类提示
      // @see docs/adr/81-reflection-separation.md §Mod 贡献从声部门控改为压力门控
      const modApi = readPressureApi(ctx);
      if (relationType === "unknown" && tier <= 50 && modApi < 0.6) {
        items.push(
          section(
            "relation-type-hint",
            [
              PromptBuilder.of(
                `You've talked to ${displayName} quite a bit but haven't categorized the relationship yet.`,
              ),
            ],
            undefined,
            27,
            60,
          ),
        );
      }

      // 关系轨迹信号 — 互动频率趋势（warming / stable / cooling）
      try {
        const db = getDb();
        const trajectoryChId = ensureChannelId(contactId) ?? contactId;
        // ADR-110: 最近 50 分钟（3_000_000 ms）的互动次数
        const recentCount = db
          .select({ count: sql<number>`count(*)` })
          .from(actionLog)
          .where(
            and(
              eq(actionLog.chatId, trajectoryChId),
              gt(actionLog.createdAt, new Date(ctx.nowMs - 3_000_000)),
            ),
          )
          .get();
        // ADR-110: 之前 50 分钟的互动次数
        const olderCount = db
          .select({ count: sql<number>`count(*)` })
          .from(actionLog)
          .where(
            and(
              eq(actionLog.chatId, trajectoryChId),
              gt(actionLog.createdAt, new Date(ctx.nowMs - 6_000_000)),
              lte(actionLog.createdAt, new Date(ctx.nowMs - 3_000_000)),
            ),
          )
          .get();
        const recent = recentCount?.count ?? 0;
        const older = olderCount?.count ?? 0;
        if (recent + older > 0) {
          let trajectory: string;
          if (older === 0 && recent > 0) {
            trajectory = "warming (new activity)";
          } else if (older > 0 && recent === 0) {
            trajectory = "cooling (no recent activity)";
          } else if (older > 0) {
            const ratio = recent / older;
            if (ratio > 1.3) {
              trajectory = "warming (more frequent interactions lately)";
            } else if (ratio < 0.7) {
              trajectory = "cooling (less frequent interactions lately)";
            } else {
              trajectory = "stable";
            }
          } else {
            trajectory = "stable";
          }
          items.push(
            section(
              "relationship-trajectory",
              [PromptBuilder.of(`Relationship trajectory: ${trajectory}`)],
              undefined,
              26,
              65,
            ),
          );
        }
      } catch {
        // DB 不可用时跳过
      }

      // ADR-64 VI-3: portrait 综合提示
      // ADR-81: 压力门控——低压力时注入 portrait 更新提示
      if (profile && modApi < 0.6) {
        const memorizedCount = contactFacts.length;
        // ADR-110: 12 小时 = 43200 秒
        const portraitStale =
          profile.portraitMs != null
            ? (ctx.nowMs - profile.portraitMs) / 1000 > 43200
            : memorizedCount >= 3;
        if (portraitStale) {
          items.push(
            section(
              "portrait-hint",
              [PromptBuilder.of(`Impression of ${displayName} hasn't been updated in a while.`)],
              undefined,
              28,
              60,
            ),
          );
        }
      }
    }

    // 3. 目标频道属性
    if (target && ctx.graph.has(target) && ctx.graph.getNodeType(target) === "channel") {
      const attrs = ctx.graph.getChannel(target);
      const mChannel = new PromptBuilder();
      const chatType = attrs.chat_type ?? "unknown";
      const unread = attrs.unread ?? 0;
      // ADR-124: 使用 effectiveObligation 替代 pending_directed
      // @see docs/adr/126-obligation-field-decay.md §D6
      const directed = effectiveObligation(ctx.graph, target, ctx.nowMs);
      const channelName = safeDisplayName(ctx.graph, target);
      mChannel.kv("Channel", `${channelName} (${chatType})`);
      if (unread > 0) mChannel.kv("Unread", String(unread));
      if (directed > 0.1) mChannel.line("Directed here — reply needed");

      // ADR-64 VI-4: 群组画像展示
      const isGroup = ChatTarget.isGroupChat(chatType);
      const gp = ctx.state.groupProfiles?.[target];
      if (isGroup && gp) {
        if (gp.topic) mChannel.kv("Topic", gp.topic);
        if (gp.atmosphere) mChannel.kv("Atmosphere", gp.atmosphere);
        if (gp.aliceRole) mChannel.kv("Role here", gp.aliceRole);
        if (gp.memberHighlights) mChannel.kv("Key members", gp.memberHighlights);
        // ADR-208: 群组结晶兴趣
        const gInterests = Object.values(gp.crystallizedInterests ?? {})
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, 4);
        if (gInterests.length > 0) {
          mChannel.kv("Topics noticed", gInterests.map((ci) => ci.label).join(", "));
        }
        // ADR-66 F6: GroupProfile 过期提醒（对标 ContactProfile 的 12h portrait 过期）
        // ADR-81: 压力门控——低压力时注入群组画像更新提示
        // ADR-110: 12 小时 = 43200 秒
        if (
          gp.portraitMs != null &&
          (ctx.nowMs - gp.portraitMs) / 1000 > 43200 &&
          readPressureApi(ctx) < 0.6
        ) {
          mChannel.line("This group profile hasn't been updated in a while.");
        }
      } else if (isGroup && !gp) {
        // ADR-81: 压力门控——低压力时提示创建群组画像
        if (readPressureApi(ctx) < 0.6) {
          mChannel.line("No group profile yet — a description of this group's vibe would help.");
        }
      }

      // ADR-78 P1: 向 LLM 传达最近消息的内容类型，帮助 reading the room
      // @see .claude/sessions/review-naturalness-h7l9At/prompt-diagnosis.md §D
      const lastContentType = attrs.last_content_type;
      if (lastContentType && lastContentType !== "text") {
        mChannel.kv(
          "Last message type",
          `${lastContentType} — you can only see (${lastContentType}) tag, not the actual content`,
        );
      }

      items.push(section("channel-info", mChannel.build(), undefined, 22, 80));
    }

    return items;
  })
  /**
   * M4: Tier 演化引擎。
   *
   * 理论基础——Dunbar 层级模型 (Dunbar 1992, 2010):
   * 人类社交圈层呈现 ~5/15/50/150/500 的嵌套结构。
   * Alice 的 Tier 系统映射此结构，tier 值通过三维评分自动演化：
   *   TierScore = 0.35 × Frequency + 0.25 × Quality + 0.25 × Depth + 0.15 × Trust
   *
   * 升降规则（防止单次波动触发）：
   * - 连续 N=3 次 score > 0.7 → 升级（更亲密）
   * - 连续 N=3 次 score < 0.3 → 降级（更疏远）
   * - 只沿 Dunbar 阶梯 [500, 150, 50, 15, 5] 移动，不跳级
   */
  .onTickEnd((ctx) => {
    normalizeContactProfileKeys(ctx.graph, ctx.state);

    // 每 TIER_EVAL_INTERVAL ticks 评估一次
    if (ctx.tick % TIER_EVAL_INTERVAL !== 0 || ctx.tick === 0) return;

    // 获取 observer 的 outcomeHistory（用于计算 Quality 维度）
    const obsState = readModState(ctx, "observer");
    const outcomeHistory = obsState?.outcomeHistory ?? [];

    for (const contactId of ctx.graph.getEntitiesByType("contact")) {
      const attrs = ctx.graph.getContact(contactId);

      // ADR-91 Layer 3: Bot 不参与 tier 演化和结晶，锁定 tier=500
      if (attrs.is_bot === true) {
        if ((attrs.tier ?? 150) !== 500) {
          ctx.graph.updateContact(contactId, { tier: 500 });
        }
        continue; // 跳过后续 tier 评估 + 活跃模式检测 + 结晶扫描
      }

      // ADR-178: rv_* 每维度独立衰减
      const rvPatch: Record<string, number | string> = {};
      let rvChanged = false;
      for (const dim of RV_DIMENSIONS) {
        const valueKey = `rv_${dim}` as keyof typeof attrs;
        const msKey = `rv_${dim}_ms` as keyof typeof attrs;
        const value = (attrs[valueKey] as number | undefined) ?? INITIAL_RV[dim];
        const lastMs = (attrs[msKey] as number | undefined) ?? ctx.nowMs;
        const elapsedMs = ctx.nowMs - lastMs;
        if (elapsedMs <= 0) continue;
        const decayed = decayDimension(value, DIMENSION_DECAY[dim], elapsedMs);
        if (Math.abs(decayed - value) > 0.001) {
          rvPatch[`rv_${dim}`] = decayed;
          rvPatch[`rv_${dim}_ms`] = ctx.nowMs;
          rvChanged = true;
        }
      }
      if (rvChanged) {
        // biome-ignore lint/suspicious/noExplicitAny: dynamic rv_${dim} keys cannot be statically typed as ContactAttrs
        ctx.graph.updateContact(contactId, rvPatch as any);
        // 重算导出量
        const updatedAttrs = ctx.graph.getContact(contactId);
        const v = readRV(updatedAttrs);
        const vel = readVelocity(updatedAttrs);
        ctx.graph.updateContact(contactId, {
          romantic_phase: deriveRomanticPhase(v, vel),
        });
      }

      const currentTier = attrs.tier ?? 150;

      // 初始化 tracker
      if (!ctx.state.tierTrackers[contactId]) {
        ctx.state.tierTrackers[contactId] = {
          consecutiveHigh: 0,
          consecutiveLow: 0,
          lastEvalTick: 0,
          lastEvalMs: 0,
        };
      }
      const tracker = ctx.state.tierTrackers[contactId];
      tracker.lastEvalTick = ctx.tick;
      tracker.lastEvalMs = ctx.nowMs;

      // -- 三维评分 --

      // 1. Frequency: 最近 FREQUENCY_WINDOW ticks（1 天）的交互次数
      // 优先用 DB action_log，fallback 到图属性 interaction_count
      // P1-mods-1 修复: 使用窗口计数而非累积计数。
      // P2-1 修复: 窗口从 100 ticks（1.67h）扩大到 1440 ticks（1 天），
      // 配合日级 EXPECTED_FREQUENCY 值，避免 frequency 分数高度随机。
      // @see docs/adr/45-real-data-validation.md §3 Critical-1
      let interactionCount = 0;
      try {
        const db = getDb();
        const chatIdVariant = ensureChannelId(contactId) ?? contactId;
        // ADR-110: 使用 createdAt 替代 tick 窗口查询
        const row = db
          .select({ count: sql<number>`count(*)` })
          .from(actionLog)
          .where(
            and(
              eq(actionLog.chatId, chatIdVariant),
              gt(actionLog.createdAt, new Date(ctx.nowMs - FREQUENCY_WINDOW_S * 1000)),
            ),
          )
          .get();
        interactionCount = row?.count ?? 0;
      } catch {
        // DB 不可用时 frequency 为 0（保守策略，不影响其他维度）
      }

      // 2. Quality: 最近 10 条与该联系人相关的 outcome rating 均值
      const contactChatId = ensureChannelId(contactId) ?? contactId;
      const relevantOutcomes = outcomeHistory.filter(
        (r) => r.target === contactId || r.target === contactChatId,
      );
      const recentOutcomes = relevantOutcomes.slice(-10);
      const avgQuality =
        recentOutcomes.length > 0
          ? recentOutcomes.reduce((s, r) => s + r.quality, 0) / recentOutcomes.length
          : 0;

      // 3. Depth: 事实数量 + Thread 参与度
      const factCount = getContactFacts(ctx.graph, contactId).length;
      const maxFacts = CONTACT_FACTS_LIMIT;

      let threadInvolvement = 0;
      for (const tid of ctx.graph.getEntitiesByType("thread")) {
        const tAttrs = ctx.graph.getThread(tid);
        if (tAttrs.status === "open") {
          const neighbors = ctx.graph.getNeighbors(tid, "involves");
          if (neighbors.includes(contactId)) {
            threadInvolvement++;
          }
        }
      }

      // ADR-198 F7a: 迁移到 rv_trust（图属性），替代 profile.trust（旧标量）
      const contactTrust = readRV(attrs).trust;

      // 互惠系数输入：从 contact 节点读取双方发起对话计数
      const aliceInit = Number(attrs.alice_initiated_count ?? 0);
      const contactInit = Number(attrs.contact_initiated_count ?? 0);

      const score = tierScore(
        interactionCount,
        currentTier,
        avgQuality,
        factCount,
        maxFacts,
        threadInvolvement,
        15, // maxThreads (门控上限)
        contactTrust,
        aliceInit,
        contactInit,
      );

      // -- 连续阈值判定 --
      if (score >= TIER_UPGRADE_THRESHOLD) {
        tracker.consecutiveHigh++;
        tracker.consecutiveLow = 0;
      } else if (score <= TIER_DOWNGRADE_THRESHOLD) {
        tracker.consecutiveLow++;
        tracker.consecutiveHigh = 0;
      } else {
        // 中间区域：重置两个计数器
        tracker.consecutiveHigh = 0;
        tracker.consecutiveLow = 0;
      }

      // -- 升降级 --
      if (tracker.consecutiveHigh >= TIER_CONSECUTIVE_REQUIRED) {
        const nextTier = nextCloserTier(currentTier);
        if (nextTier !== null) {
          ctx.graph.updateContact(contactId, {
            tier: nextTier,
            tier_changed_ms: ctx.nowMs,
            tier_direction: "upgrade",
          });
          // ADR-123: tier 变更是结构性观测（自动记录 changelog）
          ctx.graph.beliefs.update(contactId, "tier", nextTier, "structural", ctx.nowMs);
          // ADR-204: 意识流 — tier 升级事件
          try {
            const name = attrs.display_name ?? contactId;
            emitConsciousness(getDb(), ctx.tick, ctx.nowMs, {
              kind: "evolve:tier",
              entityIds: [contactId],
              summary: `${name} upgraded to tier ${nextTier}`,
            });
          } catch {
            /* non-critical */
          }
        }
        tracker.consecutiveHigh = 0;
        tracker.consecutiveLow = 0;
      } else if (tracker.consecutiveLow >= TIER_DOWNGRADE_CONSECUTIVE) {
        const nextTier = nextFartherTier(currentTier);
        if (nextTier !== null) {
          ctx.graph.updateContact(contactId, {
            tier: nextTier,
            tier_changed_ms: ctx.nowMs,
            tier_direction: "downgrade",
          });
          // ADR-123: tier 变更是结构性观测（自动记录 changelog）
          ctx.graph.beliefs.update(contactId, "tier", nextTier, "structural", ctx.nowMs);
          // ADR-204: 意识流 — tier 降级事件
          try {
            const name = attrs.display_name ?? contactId;
            emitConsciousness(getDb(), ctx.tick, ctx.nowMs, {
              kind: "evolve:tier",
              entityIds: [contactId],
              summary: `${name} downgraded to tier ${nextTier}`,
            });
          } catch {
            /* non-critical */
          }
        }
        tracker.consecutiveLow = 0;
        tracker.consecutiveHigh = 0;
      }

      // -- 活跃模式变化检测（场景 5: 长期陪伴增强） --
      // 在 tier 评估周期中比较当前峰值活跃小时与上次记录的峰值，
      // 检测显著日程变化（>= 3 小时偏移），如 "你最近又开始熬夜了"。
      const traitBeliefs = ctx.graph.beliefs.getByEntityAttrPrefix(contactId, "trait:");
      let profile = ctx.state.contactProfiles[contactId];
      if (!profile && traitBeliefs.length > 0) {
        ctx.state.contactProfiles[contactId] = emptyProfile(ctx.tick, ctx.nowMs);
        profile = ctx.state.contactProfiles[contactId];
      }
      if (profile && profile.activeHours.length === 24) {
        const maxActivity = Math.max(...profile.activeHours);
        if (maxActivity > 0) {
          const currentPeakHour = profile.activeHours.indexOf(maxActivity);
          if (profile.previousPeakHour !== null) {
            const shift = Math.abs(currentPeakHour - profile.previousPeakHour);
            // 考虑跨午夜的环形距离（例如 23→1 = 2h，不是 22h）
            const circularShift = Math.min(shift, 24 - shift);
            if (circularShift >= 3) {
              const hourPeriod = (h: number) =>
                h < 6 ? "late night" : h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
              const direction =
                currentPeakHour > 12 && profile.previousPeakHour <= 12
                  ? "shifted later (possible night owl pattern)"
                  : currentPeakHour <= 12 && profile.previousPeakHour > 12
                    ? "shifted earlier (possible early bird pattern)"
                    : `shifted from ${hourPeriod(profile.previousPeakHour)} to ${hourPeriod(currentPeakHour)}`;
              profile.scheduleShift = direction;
            } else {
              profile.scheduleShift = null; // 变化不显著，清除
            }
          }
          profile.previousPeakHour = currentPeakHour;
        }
      }

      // -- ADR-89 §Wave 2B: 印象结晶 + §Wave 3B: 结晶慢衰减 --
      // 每 TIER_EVAL_INTERVAL 同时扫描该联系人的 trait beliefs。
      // @see docs/adr/89-impression-formation-system.md §Wave 2B/3B
      if (profile) {
        const obsState2 = readModState(ctx, "observer");
        const impressionCounts = obsState2?.impressionCounts ?? {};

        for (const [attr, belief] of traitBeliefs) {
          // attr 形如 "trait:warmth"
          const dimension = attr.slice("trait:".length);
          const countKey = `${contactId}::${attr}`;
          const obsCount = impressionCounts[countKey] ?? 0;
          const existing = profile.traits[dimension];

          if (existing) {
            // ADR-110: 结晶慢衰减：半衰期 604800 秒 = 7 天，向 0（中性）回归
            const lastMs =
              existing.lastReinforcedMs ??
              estimateEventMs({ tick: existing.lastReinforced }, ctx.nowMs, ctx.tick);
            const elapsedS = (ctx.nowMs - lastMs) / 1000;
            if (elapsedS > 0) {
              existing.value *= 2 ** -(elapsedS / CRYSTALLIZED_TRAIT_HALFLIFE_S);
            }
            // |value| 太小 → 删除（特质已自然消退）
            if (Math.abs(existing.value) < CRYSTALLIZED_TRAIT_EPSILON) {
              delete profile.traits[dimension];
              continue;
            }
            // μ 方向反转 → 解晶（认知更新：以前觉得友善，现在发现冷漠）
            if (existing.value > 0 !== belief.mu > 0 && belief.sigma2 < CRYSTALLIZE_SIGMA2) {
              delete profile.traits[dimension];
              continue;
            }
            // self_sense 继续更新 → 刷新 lastReinforced
            const lastReinforcedMs =
              existing.lastReinforcedMs ??
              estimateEventMs({ tick: existing.lastReinforced }, ctx.nowMs, ctx.tick);
            if (belief.tObs > lastReinforcedMs) {
              existing.lastReinforced = ctx.tick;
              existing.lastReinforcedMs = ctx.nowMs;
              existing.value = Math.max(-1, Math.min(1, belief.mu));
            }
          } else {
            // 未结晶 → 检查三条件结晶
            if (
              belief.sigma2 < CRYSTALLIZE_SIGMA2 &&
              obsCount >= CRYSTALLIZE_MIN_OBS &&
              Math.abs(belief.mu) > CRYSTALLIZE_MU_THRESHOLD
            ) {
              profile.traits[dimension] = {
                value: Math.max(-1, Math.min(1, belief.mu)),
                crystallizedAt: ctx.tick,
                crystallizedAtMs: ctx.nowMs,
                lastReinforced: ctx.tick,
                lastReinforcedMs: ctx.nowMs,
              };
            }
          }
        }
      }

      // -- ADR-208: interest 结晶慢衰减（contact）--
      // 与 trait 结晶衰减同频扫描（每 TIER_EVAL_INTERVAL ticks）。
      if (profile?.crystallizedInterests) {
        for (const [label, entry] of Object.entries(profile.crystallizedInterests)) {
          const elapsedS = (ctx.nowMs - entry.lastReinforcedMs) / 1000;
          if (elapsedS > 0) {
            entry.confidence *= 2 ** -(elapsedS / CRYSTALLIZED_INTEREST_HALFLIFE_S);
          }
          if (entry.confidence < CRYSTALLIZED_INTEREST_EPSILON) {
            delete profile.crystallizedInterests[label];
            if (ctx.state.interestObsCounts) {
              delete ctx.state.interestObsCounts[`${contactId}::interest:${label}`];
            }
          }
        }
      }
    }

    // -- ADR-208: interest 结晶慢衰减（group）--
    for (const [channelId, gp] of Object.entries(ctx.state.groupProfiles ?? {})) {
      if (!gp.crystallizedInterests) continue;
      for (const [label, entry] of Object.entries(gp.crystallizedInterests)) {
        const elapsedS = (ctx.nowMs - entry.lastReinforcedMs) / 1000;
        if (elapsedS > 0) {
          entry.confidence *= 2 ** -(elapsedS / CRYSTALLIZED_INTEREST_HALFLIFE_S);
        }
        if (entry.confidence < CRYSTALLIZED_INTEREST_EPSILON) {
          delete gp.crystallizedInterests[label];
          if (ctx.state.interestObsCounts) {
            delete ctx.state.interestObsCounts[`${channelId}::interest:${label}`];
          }
        }
      }
    }
  })
  .build();
