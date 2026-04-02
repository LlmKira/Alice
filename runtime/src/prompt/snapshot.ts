/**
 * ADR-220: User Prompt Snapshot 构建器。
 *
 * 从引擎数据源一次性构建类型化快照，供场景渲染器消费。
 * 不直接查 DB——所有数据从传入参数获取。
 *
 * EntityRef 构建原则：id + displayName 缺一则返回 null，不进 prompt。
 * 这是 "(a group)" 问题的根治。
 */

import { and, desc, eq, gt, isNotNull, lte } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { episodes, messageLog, scheduledTasks } from "../db/schema.js";
import type { MessageRecord } from "../engine/act/messages.js";
import { computeChannelPresence } from "../engine/act/presence.js";
import {
  buildTimeline,
  type ForwardRegistry,
  MessageTimelineSource,
  ObservationTimelineSource,
  PeripheralTimelineSource,
  type PeripheralVisionConfig,
  renderTimeline,
  ThoughtTimelineSource,
} from "../engine/act/timeline.js";
import type { ActionQueueItem } from "../engine/action-queue.js";
import {
  ALICE_SELF,
  CONTACT_PREFIX,
  ensureChannelId,
  ensureContactId,
  extractNumericId,
  PERIPHERAL_TIER_WINDOW_S,
  resolveContactAndChannel,
  tierLabel,
} from "../graph/constants.js";
import { safeDisplayName } from "../graph/display.js";
import {
  isBlockedByContact,
  readForwardRegistry,
  readSocialReception,
} from "../graph/dynamic-props.js";
import type { DunbarTier } from "../graph/entities.js";
import { findActiveConversation } from "../graph/queries.js";
import type { WorldModel } from "../graph/world-model.js";
import type { ChatInfo } from "../llm/group-cache.js";
import { getCachedChatInfo } from "../llm/group-cache.js";
import { getCachedBio } from "../telegram/bio-cache.js";
import { createLogger } from "../utils/logger.js";
import { humanDuration } from "../utils/time-format.js";
import { getFacetWhisper } from "../voices/palette.js";
import type {
  ContactProfileSlot,
  ContactSlot,
  EntityRef,
  FeedItemSlot,
  GroupSlot,
  JargonSlot,
  PresenceSlot,
  RecapSegment,
  Scene,
  ThreadSlot,
  UserPromptSnapshot,
} from "./types.js";

const log = createLogger("snapshot");

// ═══════════════════════════════════════════════════════════════════════════
// 快照构建参数
// ═══════════════════════════════════════════════════════════════════════════

export interface SnapshotInput {
  G: WorldModel;
  messages: MessageRecord[];
  observations: string[];
  item: ActionQueueItem;
  round: number;
  /** @deprecated ADR-233: TC 循环已接管续轮，不再使用 */
  episodeRound?: number;
  board: {
    maxSteps: number;
    contextVars: Readonly<Record<string, unknown>>;
  };
  nowMs: number;
  chatType: string;
  isGroup: boolean;
  isChannel: boolean;

  /** 策略 C: 预收集的联系人画像（来自 relationships mod state）。 */
  contactProfiles?: Record<
    string,
    {
      portrait?: string;
      traits?: Record<string, { value: number }>;
      crystallizedInterests?: Record<string, { label: string; confidence: number }>;
      interests?: string[];
    }
  >;

  /** 策略 C: 群组黑话（来自 learning mod state）。 */
  jargonEntries?: Array<{ term: string; meaning: string }>;

  /** 策略 C: Feed 条目（来自 feeds mod cache）。 */
  feedItems?: Array<{ title: string; url: string; snippet: string }>;

  /** 策略 D: Peripheral vision 配置参数。 */
  peripheralConfig?: {
    perChannelCap: number;
    totalCap: number;
    minTextLength: number;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// EntityRef 构建器 — null = 不进 prompt
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 从图节点构建 EntityRef。
 * 返回 null 的情况：节点不存在、无 displayName、无法提取数字 ID。
 */
export function buildEntityRef(G: WorldModel, nodeId: string): EntityRef | null {
  if (!G.has(nodeId)) return null;

  const numericId = extractNumericId(nodeId);
  if (numericId == null) return null;

  // 尝试从 channel 节点获取名称
  let displayName: string | undefined;
  const nodeType = G.getNodeType(nodeId);

  if (nodeType === "channel") {
    const attrs = G.getChannel(nodeId);
    displayName = attrs.display_name;
  } else if (nodeType === "contact") {
    const attrs = G.getContact(nodeId);
    displayName = attrs.display_name;
  } else {
    // 泛型 fallback
    displayName =
      (G.getDynamic(nodeId, "display_name") as string | undefined) ??
      (G.getDynamic(nodeId, "title") as string | undefined);
  }

  if (!displayName || String(displayName).trim() === "") return null;

  // 获取 chatType
  let chatType: EntityRef["chatType"];
  if (nodeType === "channel") {
    const ct = G.getChannel(nodeId).chat_type;
    if (ct === "private" || ct === "group" || ct === "supergroup" || ct === "channel") {
      chatType = ct;
    }
  }

  return { id: numericId, displayName: String(displayName), chatType };
}

/**
 * 为私聊目标构建 EntityRef——如果 channel 节点没有 display_name，
 * 尝试从 contact 节点获取。
 */
function buildTargetRef(G: WorldModel, target: string): EntityRef | null {
  // 先尝试直接从 channel 节点构建
  const ref = buildEntityRef(G, target);
  if (ref) return ref;

  // channel 没有 display_name → 试从 contact 节点获取
  const numericId = extractNumericId(target);
  if (numericId == null) return null;

  const contactId = ensureContactId(String(Math.abs(numericId)));
  if (!contactId || !G.has(contactId)) return null;

  const contactAttrs = G.getContact(contactId);
  const displayName = contactAttrs.display_name;
  if (!displayName || String(displayName).trim() === "") return null;

  // 获取 chatType from channel node if exists
  const channelId = ensureChannelId(target);
  let chatType: EntityRef["chatType"];
  if (channelId && G.has(channelId)) {
    const ct = G.getChannel(channelId).chat_type;
    if (ct === "private" || ct === "group" || ct === "supergroup" || ct === "channel") {
      chatType = ct;
    }
  }

  return { id: numericId, displayName: String(displayName), chatType };
}

// ═══════════════════════════════════════════════════════════════════════════
// 心情标签
// ═══════════════════════════════════════════════════════════════════════════

function deriveMoodLabel(G: WorldModel): string {
  if (!G.has(ALICE_SELF)) return "neutral";
  const selfAttrs = G.getAgent(ALICE_SELF);
  const effective = selfAttrs.mood_effective ?? 0;
  const valence = selfAttrs.mood_valence ?? 0;

  // 优先用 effective（综合了 arousal），但当 effective 接近零而 valence 强烈时
  // 说明情绪被 arousal 掩盖——应该反映真实 valence
  const signal = Math.abs(effective) > 0.2 ? effective : valence;

  if (signal > 0.6) return "quite positive";
  if (signal > 0.3) return "mildly positive";
  if (signal < -0.6) return "quite negative";
  if (signal < -0.3) return "mildly negative";
  return "neutral";
}

// ═══════════════════════════════════════════════════════════════════════════
// 社交全景（频道用）— 从 Graph 构建
// ═══════════════════════════════════════════════════════════════════════════

const PANORAMA_MAX_CONTACTS = 8;
const PANORAMA_MAX_GROUPS = 4;
const PANORAMA_MAX_INTERESTS = 2;

function buildContactPanorama(
  G: WorldModel,
  contactProfiles?: SnapshotInput["contactProfiles"],
): ContactSlot[] {
  const results: Array<
    ContactSlot & { tier: number; lastActiveMs: number; hasInterests: boolean; reception: number }
  > = [];

  // 遍历 Alice 的 "knows" 邻居（联系人）
  for (const cid of G.getEntitiesByType("contact")) {
    if (cid === ALICE_SELF) continue;
    const attrs = G.getContact(cid);
    if (attrs.is_bot) continue;
    const tier = attrs.tier ?? 150;
    // 放宽到 500——兴趣标签积累集中在远圈联系人
    if (tier > 500) continue;

    const numericPart = cid.slice(CONTACT_PREFIX.length);
    const numId = Number(numericPart);
    if (Number.isNaN(numId)) continue;
    const displayName = attrs.display_name;
    if (!displayName || String(displayName).trim() === "") continue;

    // ADR-156 Fix 1: 只展示有对话历史的联系人（不向陌生人转发）
    const channelId = ensureChannelId(cid);
    if (channelId && G.has(channelId)) {
      const ch = G.getChannel(channelId);
      if (!ch.last_activity_ms && !ch.last_alice_action_ms) continue;
    } else {
      continue; // 无对应 channel = 从未有过私聊
    }

    // ADR-156 Fix 3: 被拉黑的联系人不出现在全景中
    if (isBlockedByContact(G, cid)) continue;

    // 收集兴趣：优先从 ContactProfile.crystallizedInterests（Mod State），
    // 回退到 ContactProfile.interests，最后从 fact 节点获取。
    const profile = contactProfiles?.[cid];
    let interests: string[] = [];

    // 策略 1: crystallizedInterests（最高质量——经过多次观察结晶）
    const crystallized = Object.values(profile?.crystallizedInterests ?? {})
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, PANORAMA_MAX_INTERESTS)
      .map((ci) => ci.label);
    if (crystallized.length > 0) {
      interests = crystallized;
    }
    // 策略 2: 旧 interests 数组
    else if (profile?.interests && profile.interests.length > 0) {
      interests = profile.interests.slice(0, PANORAMA_MAX_INTERESTS);
    }
    // 策略 3: fact 节点 fallback
    else {
      const factNeighbors = G.getPredecessors(cid, "from");
      for (const factId of factNeighbors) {
        if (!G.has(factId) || G.getNodeType(factId) !== "fact") continue;
        const fact = G.getFact(factId);
        if ((fact.fact_type === "interest" || fact.fact_type === "preference") && fact.content) {
          interests.push(String(fact.content));
          if (interests.length >= PANORAMA_MAX_INTERESTS) break;
        }
      }
    }

    // topTrait: 优先从 profile.traits，回退到 fact 节点
    let topTrait: string | undefined;
    const traitEntries = Object.entries(profile?.traits ?? {});
    if (traitEntries.length > 0) {
      topTrait = traitEntries.sort((a, b) => Math.abs(b[1].value) - Math.abs(a[1].value))[0][0];
    } else {
      const factNeighbors = G.getPredecessors(cid, "from");
      for (const factId of factNeighbors) {
        if (!G.has(factId) || G.getNodeType(factId) !== "fact") continue;
        const fact = G.getFact(factId);
        if (fact.fact_type === "preference" && fact.content) {
          topTrait = String(fact.content);
          break;
        }
      }
    }

    // Bio: 从 cache 同步读取（miss 时不阻塞，下次 tick 生效）
    const bioEntry = getCachedBio(cid);
    const bio = bioEntry?.bio ?? undefined;

    // 读取该联系人私聊 channel 的社交接收度（转发反馈信号）
    const contactReception = channelId ? readSocialReception(G, channelId) : 0;

    const ref: EntityRef = { id: numId, displayName: String(displayName) };
    results.push({
      ref,
      tierLabel: tierLabel(tier),
      topTrait,
      interests,
      bio,
      tier,
      lastActiveMs: attrs.last_active_ms ?? 0,
      hasInterests: interests.length > 0,
      reception: contactReception,
    });
  }

  // 排序：reception warm 优先 → 有兴趣优先 → tier 升序 → 最近活跃优先
  // cold reception 的联系人自然沉底，不需要 [shared recently] 补丁
  results.sort((a, b) => {
    // reception >= 0 的排前面，< 0 的排后面
    const aWarm = a.reception >= 0 ? 0 : 1;
    const bWarm = b.reception >= 0 ? 0 : 1;
    if (aWarm !== bWarm) return aWarm - bWarm;
    const aHas = a.hasInterests ? 0 : 1;
    const bHas = b.hasInterests ? 0 : 1;
    return aHas - bHas || a.tier - b.tier || b.lastActiveMs - a.lastActiveMs;
  });

  return results
    .slice(0, PANORAMA_MAX_CONTACTS)
    .map(({ ref, tierLabel: tl, topTrait: tt, interests, bio: b }) => ({
      ref,
      tierLabel: tl,
      topTrait: tt,
      interests,
      ...(b ? { bio: b } : {}),
    }));
}

function buildGroupPanorama(G: WorldModel): GroupSlot[] {
  const results: GroupSlot[] = [];

  // Alice 通过 "monitors" 边关联群组（不是 "joined"）
  const monitoredChannels = G.getNeighbors(ALICE_SELF, "monitors");
  for (const chId of monitoredChannels) {
    if (!G.has(chId) || G.getNodeType(chId) !== "channel") continue;
    const attrs = G.getChannel(chId);
    // 只要非私聊、非频道的群组
    if (attrs.chat_type === "private" || attrs.chat_type === "channel") continue;
    const displayName = attrs.display_name;
    if (!displayName || String(displayName).trim() === "") continue;

    const numericId = extractNumericId(chId);
    if (numericId == null) continue;

    // 查找 active conversation topic
    const convId = findActiveConversation(G, chId);
    let topic: string | undefined;
    if (convId && G.has(convId)) {
      const convAttrs = G.getConversation(convId);
      if (convAttrs.topic) topic = String(convAttrs.topic);
    }

    // 收集群组兴趣（从关联 fact 节点）
    const interests: string[] = [];
    const factNeighbors = G.getPredecessors(chId, "from");
    for (const factId of factNeighbors) {
      if (!G.has(factId) || G.getNodeType(factId) !== "fact") continue;
      const fact = G.getFact(factId);
      if (fact.fact_type === "interest" && fact.content) {
        interests.push(String(fact.content));
        if (interests.length >= PANORAMA_MAX_INTERESTS) break;
      }
    }

    // Bio: 从 cache 同步读取
    const bioEntry = getCachedBio(chId);
    const bio = bioEntry?.bio ?? undefined;

    results.push({
      ref: { id: numericId, displayName: String(displayName), chatType: attrs.chat_type },
      topic,
      interests,
      ...(bio ? { bio } : {}),
    });

    if (results.length >= PANORAMA_MAX_GROUPS) break;
  }

  return results;
}

// ══════════════════��════════════════════════════════════════════════════════
// 对话状态（防复读）
// ═══════════════════════════════════════════════════════════════════════════

function buildPresence(
  messages: readonly MessageRecord[],
  nowMs: number,
): PresenceSlot | undefined {
  if (messages.length === 0) return undefined;
  const presence = computeChannelPresence(messages);
  if (presence.trailingYours < 1) return undefined;

  let lastOutgoing: MessageRecord | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].isOutgoing) {
      lastOutgoing = messages[i];
      break;
    }
  }

  if (!lastOutgoing) return undefined;

  const agoS = (nowMs - lastOutgoing.date.getTime()) / 1000;
  const preview =
    lastOutgoing.text.length > 50 ? `${lastOutgoing.text.slice(0, 50)}...` : lastOutgoing.text;

  return {
    trailingYours: presence.trailingYours,
    lastOutgoingPreview: preview,
    lastOutgoingAgo: humanDuration(agoS),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 线程
// ═══════════════════════════════════════════════════════════════════════════

function sanitizeThreadTitle(title: string): string {
  return title.replace(/(?:channel|contact):[+-]?\d+/g, "(chat)");
}

function buildThreads(contextVars: Readonly<Record<string, unknown>>): ThreadSlot[] {
  const threads = contextVars.ACTIVE_THREADS;
  if (!Array.isArray(threads) || threads.length === 0) return [];
  return threads
    .filter(
      (t): t is { id: string; title: string } =>
        typeof t === "object" && t !== null && "id" in t && "title" in t,
    )
    .map((t) => ({
      threadId: String(t.id),
      title: sanitizeThreadTitle(String(t.title)),
    }));
}

// ══════════════���════════════════════════════════════════════════════════════
// 时间线构建
// ═══════════════════════════════════════════════════════════════════════════

const MAX_TIMELINE_LINES = 30;
const TEN_MINUTES_MS = 10 * 60 * 1000;

function buildTimelineSlot(
  messages: MessageRecord[],
  observations: string[],
  target: string,
  nowMs: number,
  peripheralConfig?: PeripheralVisionConfig | null,
  forwardRegistry?: ForwardRegistry,
): { lines: string[] } {
  const sinceMs = nowMs - TEN_MINUTES_MS;

  const sources = [
    ...(peripheralConfig ? [new PeripheralTimelineSource(peripheralConfig)] : []),
    new MessageTimelineSource(messages, forwardRegistry),
    ...(target ? [new ThoughtTimelineSource()] : []),
    ...(observations.length > 0 ? [new ObservationTimelineSource(observations)] : []),
  ];

  const timeline = buildTimeline(sources, target, sinceMs, nowMs);
  if (timeline.length === 0) return { lines: [] };

  const rendered = renderTimeline(timeline, nowMs);
  // 固定窗口——超过上限时 clip-top（保留最新）
  if (rendered.length > MAX_TIMELINE_LINES) {
    return { lines: rendered.slice(-MAX_TIMELINE_LINES) };
  }
  return { lines: rendered };
}

// ═══════════════════════════════════════════════════════════════════════════
// 轮次感知
// ═══════════════════════════════════════════════════════════════════════════

function buildRoundHint(round: number, maxSteps: number): string | undefined {
  if (round <= 0) return undefined;
  const remaining = maxSteps - round - 1;
  if (remaining === 0) {
    return "Been going back and forth — time to wrap up.";
  }
  return "The conversation is still going.";
}

/**
 * ADR-232: TC episode 提示 — 当 LLM 使用 watching 续轮时，
 * 告知它命令结果已在 observations 中，可以继续决策。
 */
function buildEpisodeHint(episodeRound: number): string | undefined {
  if (episodeRound <= 0) return undefined;
  return "The command result is in your observations — continue from where you left off.";
}

// ═══════════════════════════════════════════════════════════════════════════
// 策略 A: 纯 Graph 推导
// ═══════════════════════════════════════════════════════════════════════════

const SEVEN_DAYS_MS = 7 * 24 * 3600_000;

/**
 * 层③ 全局感知信号。
 *
 * 从 Graph 遍历推导：漂移联系人、活跃群组、等待回复的频道。
 * LLM 用这些信号决定是否主动联系某人或关注某群。
 */
function buildSituationSignals(
  G: WorldModel,
  target: string | null,
  nowMs: number,
  round: number,
): string[] {
  const signals: string[] = [];

  // 漂移联系人：last_active_ms 距今 > 7 天
  // 只在 round=0（首轮/非 engagement）显示——engagement 中漂移信号是分心噪音
  if (round === 0) {
    for (const cid of G.getEntitiesByType("contact")) {
      if (cid === ALICE_SELF) continue;
      const attrs = G.getContact(cid);
      if (attrs.is_bot) continue;
      const name = safeDisplayName(G, cid);
      if (name.startsWith("(")) continue; // 泛称 = 无有效名字，跳过
      const lastActive = attrs.last_active_ms ?? 0;
      if (lastActive > 0 && nowMs - lastActive > SEVEN_DAYS_MS) {
        const days = Math.round((nowMs - lastActive) / (24 * 3600_000));
        signals.push(`${name} hasn't been around in ${days} days`);
      }
      if (signals.length >= 3) break;
    }
  }

  // 活跃群组：unread > 5 且非 target（排除私聊和频道）
  const joined = G.has(ALICE_SELF) ? G.getNeighbors(ALICE_SELF, "monitors") : [];
  for (const chId of joined) {
    if (!G.has(chId) || G.getNodeType(chId) !== "channel") continue;
    if (chId === target) continue;
    const ch = G.getChannel(chId);
    if (ch.chat_type === "private" || ch.chat_type === "channel") continue;
    if ((ch.unread ?? 0) > 5) {
      signals.push(`${safeDisplayName(G, chId)} is lively`);
    }
    if (signals.length >= 5) break;
  }

  // ADR-221 No-Silent-Drop: pending_directed > 0 的信号必须呈现。
  // 私聊 channel 的 display_name 可能为空 → 从 contact 节点解析。
  for (const chId of joined) {
    if (!G.has(chId) || G.getNodeType(chId) !== "channel") continue;
    if (chId === target) continue;
    const ch = G.getChannel(chId);
    if ((ch.pending_directed ?? 0) <= 0) continue;

    // Fallback 链：channel display_name → contact display_name → safeDisplayName
    let name = ch.display_name;
    if (!name || String(name).trim() === "") {
      if (ch.chat_type === "private") {
        const contactId = ensureContactId(chId);
        if (contactId && G.has(contactId)) {
          name = G.getContact(contactId).display_name;
        }
      }
    }
    if (!name || String(name).trim() === "") {
      name = safeDisplayName(G, chId);
    }

    const label = ch.chat_type === "private" ? "sent you a DM" : "is waiting for your reply";
    signals.push(`${name} ${label}`);
    if (signals.length >= 7) break;
  }

  return signals;
}

/**
 * 层② 联系人心情。
 *
 * 从 target channel 推导 contact → mood_valence。
 * LLM 用心情标签调整语气（对方心情低落时更温柔）。
 */
function buildContactMood(G: WorldModel, target: string): string | undefined {
  const contactId = ensureContactId(target);
  const cid = contactId && G.has(contactId) ? contactId : null;

  // 尝试从 channel ID 反推 contact ID
  const resolvedCid =
    cid ??
    (() => {
      const numId = extractNumericId(target);
      if (numId == null) return null;
      const altId = ensureContactId(String(Math.abs(numId)));
      return altId && G.has(altId) ? altId : null;
    })();

  if (!resolvedCid) return undefined;
  const attrs = G.getContact(resolvedCid);
  const valence = attrs.mood_valence;
  if (valence == null) return undefined;

  let label: string | undefined;
  if (valence > 0.3) label = "positive";
  else if (valence < -0.3) label = "down";
  else return undefined;

  const shift = attrs.mood_shift;
  if (shift) label += ` (${shift})`;
  return label;
}

/**
 * 层③ 风险标记。
 *
 * 从 target channel 的 graph 属性中提取安全/风险标记。
 * LLM 用风险标记调整行为谨慎度。
 */
function buildRiskFlags(G: WorldModel, target: string): string[] {
  const flags: string[] = [];
  const channelId = ensureChannelId(target);
  if (!channelId || !G.has(channelId)) return flags;

  const ch = G.getChannel(channelId);
  if (ch.risk_level && ch.risk_level !== "none") {
    const reason = ch.risk_reason ? `: ${ch.risk_reason}` : "";
    flags.push(`Risk level ${ch.risk_level}${reason}`);
  }
  if (ch.safety_flag) {
    flags.push(`Safety: ${ch.safety_flag}`);
  }
  return flags;
}

/**
 * 层⑤ 当前对话话题（bug fix — 之前依赖 groupMeta.topic，私聊无法获取）。
 *
 * LLM 用 openTopic 维持对话连贯性。
 */
function buildOpenTopic(G: WorldModel, target: string): string | undefined {
  const channelId = ensureChannelId(target) ?? target;
  if (!G.has(channelId)) return undefined;
  const convId = findActiveConversation(G, channelId);
  if (!convId || !G.has(convId)) return undefined;
  const topic = G.getConversation(convId).topic;
  return topic ? String(topic) : undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// 策略 B: DB 查询
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 层① 对话回顾。
 *
 * 从 DB messageLog 查最近 120 条消息，跳过最新 20 条（已在 live timeline），
 * 按时间间隔 > 10 分钟分段，每段取首尾 + 时间范围 + 消息数。
 * LLM 用回顾理解"之前聊了什么"以保持话题连贯。
 */
function buildConversationRecap(target: string | null, nowMs: number): RecapSegment[] {
  if (!target) return [];
  try {
    const db = getDb();
    const rows = db
      .select({
        senderName: messageLog.senderName,
        text: messageLog.text,
        isOutgoing: messageLog.isOutgoing,
        createdAt: messageLog.createdAt,
      })
      .from(messageLog)
      .where(eq(messageLog.chatId, target))
      .orderBy(desc(messageLog.id))
      .limit(120)
      .all()
      .reverse();

    if (rows.length <= 20) return [];

    // 跳过最新 20 条（已在 live timeline 中）
    const older = rows.slice(0, rows.length - 20);
    if (older.length === 0) return [];

    // 按时间间隔 > 10 分钟分段
    const TEN_MIN = 10 * 60_000;
    const segments: Array<typeof older> = [];
    let current: typeof older = [older[0]];
    for (let i = 1; i < older.length; i++) {
      const gap = older[i].createdAt.getTime() - older[i - 1].createdAt.getTime();
      if (gap > TEN_MIN) {
        segments.push(current);
        current = [older[i]];
      } else {
        current.push(older[i]);
      }
    }
    segments.push(current);

    return segments.slice(-4).map((seg) => {
      const first = seg[0];
      const last = seg[seg.length - 1];
      const firstAgo = humanDuration((nowMs - first.createdAt.getTime()) / 1000);
      const lastAgo = humanDuration((nowMs - last.createdAt.getTime()) / 1000);
      const firstName = first.isOutgoing ? "Alice" : (first.senderName ?? "someone");
      const lastName = last.isOutgoing ? "Alice" : (last.senderName ?? "someone");
      const firstPreview = first.text ? first.text.slice(0, 60) : "(media)";
      const lastPreview = last.text ? last.text.slice(0, 60) : "(media)";
      return {
        timeRange: `${firstAgo} — ${lastAgo}`,
        messageCount: seg.length,
        first: `${firstName}: ${firstPreview}`,
        last: `${lastName}: ${lastPreview}`,
      };
    });
  } catch {
    return [];
  }
}

// ADR-225: FIFTY_FOUR_DAYS_MS 已随 buildDiary() 一同删除。

// ADR-225: buildDiary() 已删除。日记注入唯一路径 = diary.mod.ts contribute()。

/**
 * 层③ 定时任务。
 *
 * 从 DB scheduledTasks 查已触发的活跃任务。
 * LLM 用任务信号执行到期行动。
 */
function buildScheduledEvents(nowMs: number): string[] {
  try {
    const db = getDb();
    const rows = db
      .select({
        action: scheduledTasks.action,
        target: scheduledTasks.target,
      })
      .from(scheduledTasks)
      .where(and(eq(scheduledTasks.active, true), lte(scheduledTasks.targetMs, nowMs)))
      .limit(5)
      .all();

    return rows.map((r) => (r.target ? `${r.action} for ${r.target}` : `Task: ${r.action}`));
  } catch {
    return [];
  }
}

/**
 * 层④ Episode 因果残留。
 *
 * 从 DB episodes 查最新 episode 的 residue，
 * 通过 causedBy 链追溯因果上下文。
 * LLM 用残留维持跨 engagement 连贯性。
 */
/**
 * Episode carryover — 联系人路由的跨聊天叙事桥。
 *
 * 核心思想：Episode 跟着人走，不跟着聊天走。
 * 当 Alice 在群组 tick 中，如果群内某人和 Alice 在别处有未消解的 episode，
 * 该 residue 注入当前 prompt → LLM 自然接续上下文。
 *
 * 查询逻辑：
 * 1. 从当前 target 提取相关联系人 ID
 * 2. 查询近期 episode 中 entityIds 包含这些联系人的、来自**其他聊天**的 episode
 * 3. 取最近一条有 residue 的，注入 "Previously (elsewhere): ..."
 * 4. 如果没有跨聊天 match，fallback 取同聊天的最近 episode（向后兼容）
 *
 * 精度控制（ADR-221 修正）：
 * - 私聊 tick → 匹配任何包含该联系人的跨聊天 episode（窄匹配，总是相关）
 * - 群组 tick → 只匹配来自**私聊**的 episode（DM→群桥接）。
 *   群→群桥接因共享成员过多会产生噪声（群 A 讨论 StoreOS，群 B 的无关 episode 通过共享成员泄入）
 */
function buildEpisodeCarryOver(G: WorldModel, target: string | null): string | undefined {
  try {
    const db = getDb();
    const cutoffMs = Date.now() - 4 * 60 * 60 * 1000; // 4h — 与 RESIDUE_MAX_AGE_MS 对齐

    // 收集当前 target 涉及的联系人
    const relevantContacts = new Set<string>();
    if (target) {
      // 私聊：直接提取联系人
      const cid = ensureContactId(target);
      if (cid) relevantContacts.add(cid);
      // 群组：曾在该频道出现的联系人（contact --[joined]--> channel）
      const channelId = ensureChannelId(target);
      if (channelId && G.has(channelId)) {
        for (const neighbor of G.getNeighbors(channelId, "joined")) {
          if (neighbor.startsWith("contact:")) relevantContacts.add(neighbor);
        }
      }
    }

    // 查询近期有 residue 的 episodes
    const candidates = db
      .select({
        target: episodes.target,
        entityIds: episodes.entityIds,
        residue: episodes.residue,
      })
      .from(episodes)
      .where(and(isNotNull(episodes.residue), gt(episodes.createdMs, cutoffMs)))
      .orderBy(desc(episodes.tickStart))
      .limit(20)
      .all();

    // 当前 target 是否是群组（非私聊、非频道）
    const targetChannelId = target ? ensureChannelId(target) : null;
    const isGroupTarget =
      targetChannelId && G.has(targetChannelId)
        ? !["private", "channel"].includes(G.getChannel(targetChannelId).chat_type ?? "")
        : false;

    // 优先匹配：跨聊天 + 联系人重叠
    for (const ep of candidates) {
      if (!ep.residue || !ep.entityIds) continue;
      // 跳过同一聊天的 episode（跨聊天才需要桥接）
      if (ep.target === target) continue;

      // ADR-221 精度控制：群组 tick 只桥接来自私聊的 episode。
      // 群→群桥接因共享成员过多会产生噪声（off-topic bleed）。
      if (isGroupTarget && ep.target) {
        const epChannelId = ensureChannelId(ep.target);
        const epChatType =
          epChannelId && G.has(epChannelId) ? G.getChannel(epChannelId).chat_type : null;
        if (epChatType !== "private") continue;
      }

      try {
        const entities: string[] = JSON.parse(ep.entityIds);
        const overlaps = entities.some((e) => relevantContacts.has(e));
        if (!overlaps) continue;

        const parsed = JSON.parse(ep.residue);
        const summary = typeof parsed === "string" ? parsed : (parsed.summary ?? parsed.text);
        if (typeof summary !== "string" || summary.length === 0) continue;

        // 用来源聊天的 display_name 标注上下文
        const sourceChannelId = ep.target ? ensureChannelId(ep.target) : null;
        const sourceName =
          sourceChannelId && G.has(sourceChannelId)
            ? G.getChannel(sourceChannelId).display_name
            : null;
        const where = sourceName ? ` (in ${sourceName})` : "";
        return `Previously${where}: ${summary.slice(0, 200)}`;
      } catch {}
    }

    // Fallback：同聊天最近 episode（向后兼容）
    for (const ep of candidates) {
      if (!ep.residue) continue;
      if (ep.target !== target) continue;
      try {
        const parsed = JSON.parse(ep.residue);
        const summary = typeof parsed === "string" ? parsed : (parsed.summary ?? parsed.text);
        if (typeof summary === "string" && summary.length > 0) {
          return `Previously: ${summary.slice(0, 200)}`;
        }
      } catch {}
    }

    return undefined;
  } catch {
    return undefined;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 策略 C: Mod State 预收集
// ═══════════════════════════════════════════════════════════════════════════

const MAX_PROFILE_TRAITS = 3;
const MAX_PROFILE_INTERESTS = 3;

/**
 * 层② 联系人详细画像。
 *
 * 从预收集的 relationships mod state 提取 portrait、traits、interests。
 * LLM 用画像个性化对话（了解对方性格和兴趣）。
 */
function buildContactProfile(
  target: string,
  contactProfiles?: SnapshotInput["contactProfiles"],
): ContactProfileSlot | undefined {
  if (!contactProfiles) return undefined;

  const numId = extractNumericId(target);
  const contactId = ensureContactId(target);
  const altContactId = numId != null ? ensureContactId(String(Math.abs(numId))) : null;

  const profile =
    (contactId ? contactProfiles[contactId] : undefined) ??
    (altContactId ? contactProfiles[altContactId] : undefined) ??
    (target ? contactProfiles[target] : undefined);

  if (!profile) return undefined;

  const traits: string[] = [];
  if (profile.traits) {
    const sorted = Object.entries(profile.traits).sort(
      (a, b) => Math.abs(b[1].value) - Math.abs(a[1].value),
    );
    for (const [key] of sorted.slice(0, MAX_PROFILE_TRAITS)) {
      traits.push(key);
    }
  }

  const interests: string[] = [];
  if (profile.crystallizedInterests) {
    const sorted = Object.entries(profile.crystallizedInterests).sort(
      (a, b) => b[1].confidence - a[1].confidence,
    );
    for (const [, val] of sorted.slice(0, MAX_PROFILE_INTERESTS)) {
      interests.push(val.label);
    }
  } else if (profile.interests) {
    interests.push(...profile.interests.slice(0, MAX_PROFILE_INTERESTS));
  }

  // Bio: 从 cache 同步读取（联系人 Telegram 签名）
  const resolvedCid = contactId ?? altContactId;
  const bioEntry = resolvedCid ? getCachedBio(resolvedCid) : null;
  const bio = bioEntry?.bio ?? undefined;

  if (!profile.portrait && traits.length === 0 && interests.length === 0 && !bio) return undefined;

  return {
    portrait: profile.portrait,
    traits,
    interests,
    ...(bio ? { bio } : {}),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 策略 D: Peripheral Vision 配置
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 层③ 社交余光配置。
 *
 * 仅私聊 + 已识别联系人 + tier < 500 时激活。
 * 从 Graph 推导联系人共享频道，构建 PeripheralVisionConfig。
 */
function buildPeripheralConfig(
  G: WorldModel,
  target: string,
  peripheralParams?: SnapshotInput["peripheralConfig"],
): PeripheralVisionConfig | null {
  if (!peripheralParams) return null;

  const { contactId } = resolveContactAndChannel(target, (id) => G.has(id));
  if (!contactId || !G.has(contactId)) return null;

  const tier = (G.getContact(contactId).tier ?? 50) as DunbarTier;
  const windowS = PERIPHERAL_TIER_WINDOW_S[tier] ?? 0;
  if (windowS <= 0) return null;

  const sharedChats = new Map<string, string>();
  for (const chId of G.getNeighbors(contactId, "joined")) {
    if (!G.has(chId)) continue;
    const ch = G.getChannel(chId);
    if (ch.chat_type !== "private") {
      const name = ch.display_name;
      sharedChats.set(chId, name ? String(name) : "(a shared group)");
    }
  }
  if (sharedChats.size === 0) return null;

  return {
    contactId,
    contactName: G.getContact(contactId).display_name
      ? String(G.getContact(contactId).display_name)
      : "(someone)",
    currentChat: target,
    sharedChats,
    windowS,
    ...peripheralParams,
  };
}

// ════���══════════════════════════════════════════════════════════════════════
// 群组元信息
// ═══════════════════════════════════════════════════════════════════════════

function buildGroupMeta(G: WorldModel, target: string): UserPromptSnapshot["groupMeta"] {
  const numId = extractNumericId(target);
  let membersInfo: string | undefined;
  let restrictions: string | undefined;

  if (numId) {
    const ci: ChatInfo | undefined = getCachedChatInfo(numId);
    if (ci?.membersCount) {
      membersInfo = `~${ci.membersCount} members`;
    }
    if (ci?.restrictions.length && !ci.isAliceAdmin) {
      restrictions = `Can't ${ci.restrictions.join(" or ")} here.`;
    }
  }

  // 查找活跃对话的 topic
  const channelId = ensureChannelId(target);
  let topic: string | undefined;
  if (channelId && G.has(channelId)) {
    const convId = findActiveConversation(G, channelId);
    if (convId && G.has(convId)) {
      const convAttrs = G.getConversation(convId);
      if (convAttrs.topic) topic = String(convAttrs.topic);
    }
  }

  // directed: 来自 channel 的 pending_directed
  let directed = false;
  if (channelId && G.has(channelId)) {
    const ch = G.getChannel(channelId);
    directed = (ch.pending_directed ?? 0) > 0;
  }

  // Bio: 群组简介（来自 bio_cache）
  const channelBioEntry = channelId ? getCachedBio(channelId) : null;
  const bio = channelBioEntry?.bio ?? undefined;

  return { topic, directed, membersInfo, restrictions, bio };
}

// ═══════════════════════════════════════════════════════════════════════════
// 关系描述（私聊）
// ═══════════════════════════════════════════════════════════════════════════

function buildRelationshipDesc(G: WorldModel, target: string): string | undefined {
  const contactId = ensureContactId(target);
  if (!contactId || !G.has(contactId)) {
    // 尝试从 channel ID 推导
    const numId = extractNumericId(target);
    if (numId == null) return undefined;
    const altContactId = ensureContactId(String(Math.abs(numId)));
    if (!altContactId || !G.has(altContactId)) return undefined;
    const attrs = G.getContact(altContactId);
    const relType = attrs.relation_type;
    const tier = attrs.tier ?? 150;
    if (relType && relType !== "unknown") {
      return `${tierLabel(tier)}, ${relType}`;
    }
    return tierLabel(tier);
  }

  const attrs = G.getContact(contactId);
  const relType = attrs.relation_type;
  const tier = attrs.tier ?? 150;
  if (relType && relType !== "unknown") {
    return `${tierLabel(tier)}, ${relType}`;
  }
  return tierLabel(tier);
}

// ═══════════════════════════════════════════════════════════════════════════
// buildUserPromptSnapshot — 公共 API
// ═══════════════════════════════════════════════════════════════════════════

export function buildUserPromptSnapshot(input: SnapshotInput): UserPromptSnapshot {
  const {
    G,
    messages,
    observations,
    item,
    round,
    episodeRound = 0,
    board,
    nowMs,
    isGroup,
    isChannel,
  } = input;

  // ── 场景推断 ──
  const scene: Scene = isChannel ? "channel" : isGroup ? "group" : "private";

  // ── 目标 EntityRef ──
  const target = item.target ? (buildTargetRef(G, item.target) ?? undefined) : undefined;

  // ── 心情 ──
  const moodLabel = deriveMoodLabel(G);

  // ── 内心低语 ──
  const whisper = getFacetWhisper(item.facetId, item.action, isGroup);

  // ── 策略 D: Peripheral Vision（仅私聊）──
  const peripheralConfig =
    !isGroup && !isChannel && item.target
      ? buildPeripheralConfig(G, item.target, input.peripheralConfig)
      : null;

  // ── 时间线 ──
  // BT 反馈闭环：频道场景注入 forwardRegistry，让 timeline 标注已转发的消息
  const fwdRegistry: ForwardRegistry | undefined =
    isChannel && item.target ? readForwardRegistry(G, item.target) : undefined;
  const timeline = buildTimelineSlot(
    messages,
    observations,
    item.target ?? "",
    nowMs,
    peripheralConfig,
    fwdRegistry,
  );

  // ─��� 线程 ──
  const threads = isChannel ? [] : buildThreads(board.contextVars);

  // ── 频道社交全景 ──
  const contacts = isChannel ? buildContactPanorama(G, input.contactProfiles) : [];
  const groups = isChannel ? buildGroupPanorama(G) : [];

  // ── 对话状态（非频道）──
  const presence = isChannel ? undefined : buildPresence(messages, nowMs);

  // ── 群组元信息 ──
  const groupMeta = isGroup && item.target ? buildGroupMeta(G, item.target) : undefined;

  // ── 轮次感知 ──
  const roundHint = buildRoundHint(round, board.maxSteps);
  // ADR-232: TC episode 提示（watching 续轮时）
  const episodeHint = buildEpisodeHint(episodeRound);

  // ── 关系描述（私聊）──
  const relationshipDesc =
    scene === "private" && item.target ? buildRelationshipDesc(G, item.target) : undefined;

  // ── 行动反馈（observations 中的跨聊天内容由 timeline source 处理）──
  const feedback: UserPromptSnapshot["feedback"] = [];

  // ── 层① 对话回顾 ──
  const conversationRecap = isChannel ? [] : buildConversationRecap(item.target ?? null, nowMs);

  // ── 层② 联系人画像（仅私聊）──
  const contactProfile =
    scene === "private" && item.target
      ? buildContactProfile(item.target, input.contactProfiles)
      : undefined;

  // ── 层② 联系人心情 ──
  const contactMood = !isChannel && item.target ? buildContactMood(G, item.target) : undefined;

  // ── 层② 群组黑话 ──
  const jargon: JargonSlot[] = input.jargonEntries ?? [];

  // ── 层③ 全局感知信号 ──
  const situationSignals = buildSituationSignals(G, item.target ?? null, nowMs, round);

  // ── 层③ 定时任务 ──
  const scheduledEvents = buildScheduledEvents(nowMs);

  // ── 层③ 风险标记 ──
  const riskFlags = item.target ? buildRiskFlags(G, item.target) : [];

  // ── 层④ 日记 ──
  // ADR-225: diary 已移至 diary.mod.ts contribute()（唯一注入路径）。
  // 此处不再构建 diary snapshot，消除双路注入。

  // ── 层④ 社交接收度（ADR-156）──
  const socialReception =
    scene === "group" && item.target
      ? readSocialReception(G, ensureChannelId(item.target) ?? item.target) || undefined
      : undefined;

  // ── 层④ Episode 残留（联系人路由：跟着人走，不跟着聊天走）──
  const episodeCarryOver = buildEpisodeCarryOver(G, item.target ?? null);

  // ── 层⑤ 降级行动 ──
  const isDegraded = item.reason?.includes("degraded_action") ?? false;

  // ── 层⑤ 当前话题 ──
  const openTopic = item.target ? buildOpenTopic(G, item.target) : undefined;

  // ── 频道 Feed 条目 ──
  const feedItems: FeedItemSlot[] = input.feedItems ?? [];

  return {
    scene,
    nowMs,
    moodLabel,
    target,
    groupMeta,
    contacts,
    groups,
    timeline: { lines: timeline.lines },
    presence,
    threads,
    feedback,
    whisper,
    roundHint,
    episodeHint,
    relationshipDesc,
    conversationRecap,
    contactProfile,
    contactMood,
    jargon,
    situationSignals,
    scheduledEvents,
    riskFlags,
    socialReception,
    episodeCarryOver,
    isDegraded,
    openTopic,
    feedItems,
  };
}
