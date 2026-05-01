/**
 * mtcute 事件 → 图状态变更 (perturb)。
 * 对应 Python sim_engine.py _apply_events()。
 *
 * 关键设计：未知节点自动创建。
 * 真实 userbot 会遇到 bootstrap 时不存在的用户/频道，
 * 直接丢弃意味着永远感知不到新联系人。
 */
import {
  createImplicitConversation,
  detectConversationStart,
  updateConversation,
} from "../engine/conversation.js";
import { chatIdToContactId, DUNBAR_TIER_THETA, ensureChannelId } from "../graph/constants.js";
import type { ChatType, DunbarTier } from "../graph/entities.js";
import { findActiveConversation } from "../graph/queries.js";
import type { WorldModel } from "../graph/world-model.js";
import { getDefaultParams, type HawkesState, updateOnEvent } from "../pressure/hawkes.js";
import { UNREAD_FRESHNESS_HALFLIFE_S } from "../pressure/signal-decay.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("mapper");

// -- D7: prompt injection 模式检测（ADR-123）---------------------------------
// 纯结构匹配（符合 ADR-50: 结构归代码）。安全标注是瞬态的——每条新消息重新检测。
// @see docs/adr/123-crystallization-substrate-generalization.md §D7

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /you\s+are\s+now\s+/i,
  /system:\s*\n/i,
  /\[system\]/i,
  /forget\s+(everything|all(\s+your)?|your)\s+(instructions|rules)/i,
  /pretend\s+you\s+are/i,
  /jailbreak/i,
  /DAN\s+mode/i,
];

/**
 * 检测文本中的已知 prompt injection 模式。
 * 返回标签字符串（匹配时）或 null（无匹配）。
 */
export function detectInjectionPatterns(text: string): string | null {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) return "prompt_injection";
  }
  return null;
}

export interface GraphPerturbation {
  type:
    | "new_message"
    | "read_history"
    | "user_status"
    | "contact_active"
    | "reaction"
    | "chat_member_update"
    | "typing";
  channelId?: string;
  contactId?: string;
  isDirected?: boolean;
  tick: number;
  /** ADR-110: 墙钟时间戳（ms），用于替代 tick-based 属性写入。 */
  nowMs?: number;
  /** 消息的新鲜度/新奇度估计 */
  novelty?: number;
  /** 发送者显示名（用于自动建节点） */
  displayName?: string;
  /** ADR-220: 频道/群组显示名（用于 channel 节点的 display_name）。 */
  chatDisplayName?: string;
  /** 频道类型（private/group/supergroup） */
  chatType?: string;
  /** 消息文本（用于 message_log 存储） */
  messageText?: string;
  /** 发送者名称（用于 message_log） */
  senderName?: string;
  /** 消息内容类型（L3: 媒体感知） */
  contentType?: "text" | "sticker" | "photo" | "voice" | "video" | "document";
  /** G3: 发送者是否为 bot（AI 回复循环抑制） */
  senderIsBot?: boolean;
  /** ADR-66 F1: Alice 近期在该频道发过言，非 directed 消息也应唤醒 evolve。 */
  isContinuation?: boolean;
  /** reaction emoji（reaction 事件专用） */
  emoji?: string;
  /** 被回应的消息 ID（reaction 事件专用） */
  messageId?: number;
  // -- ADR-206 W5: 频道线索提取 --
  /** 转发来源频道 ID（forward header）。@see docs/adr/206-channel-information-flow/ §5 */
  forwardFromChannelId?: string;
  /** 转发来源频道名。 */
  forwardFromChannelName?: string;
  /** 消息中发现的 t.me 链接列表。 */
  tmeLinks?: string[];
}

/**
 * 确保 channel 节点存在，不存在则自动创建。
 * ADR-220: 新增 chatDisplayName 参数——写入 channel.display_name。
 * 已存在时也更新 display_name（频道/群组名可能被管理员修改）。
 */
function ensureChannel(
  G: WorldModel,
  channelId: string,
  chatType: string = "private",
  chatDisplayName?: string,
): void {
  if (G.has(channelId)) {
    // 已存在 → 仅补充/更新 display_name（如果有新值）
    if (chatDisplayName) {
      const current = G.getChannel(channelId).display_name;
      if (!current || current !== chatDisplayName) {
        G.updateChannel(channelId, { display_name: chatDisplayName });
      }
    }
    return;
  }
  G.addChannel(channelId, {
    chat_type: chatType as ChatType,
    tier_contact: chatType === "private" ? 50 : 150,
    display_name: chatDisplayName,
  });
  // 自动关联到 agent
  if (G.has("self")) {
    G.addRelation("self", "monitors", channelId);
  }
  log.info("Auto-created channel node", channelId);
}

/**
 * 确保 contact 节点存在，不存在则自动创建。
 */
function ensureContact(
  G: WorldModel,
  contactId: string,
  channelId: string | undefined,
  displayName?: string,
): void {
  if (G.has(contactId)) return;
  G.addContact(contactId, {
    tier: 50,
    display_name: displayName ?? contactId,
  });
  // 关联到 agent
  if (G.has("self")) {
    G.addRelation("self", "acquaintance", contactId);
  }
  // 关联到频道
  if (channelId && G.has(channelId)) {
    G.addRelation(contactId, "joined", channelId);
  }
  log.info("Auto-created contact node", { contactId, displayName });
}

/**
 * ADR-79 M1: 重置节点可达性 — 外部事件到达即活性证明。
 * 只在节点之前有失败记录时才操作（避免无谓写入）。
 *
 * channel 和 contact 共享 reachability 字段但类型声明不同：
 * - ChannelAttrs: consecutive_act_failures 等全部 typed
 * - ContactAttrs: reachability_score/failure_type/gc_candidate_ms typed，
 *   consecutive_act_failures 仅通过 setDynamic 写入
 * 按节点类型分派以最大化类型安全。
 */
function resetReachability(G: WorldModel, nodeId: string): void {
  const nodeType = G.getNodeType(nodeId);
  if (nodeType === "channel") {
    const attrs = G.getChannel(nodeId);
    if ((attrs.consecutive_act_failures ?? 0) > 0) {
      G.updateChannel(nodeId, {
        consecutive_act_failures: 0,
        reachability_score: 1.0,
        failure_type: null,
        gc_candidate_ms: null,
      });
      log.info("Reachability self-healed via event", { nodeId });
    }
  } else if (nodeType === "contact") {
    if (Number(G.getDynamic(nodeId, "consecutive_act_failures") ?? 0) > 0) {
      G.setDynamic(nodeId, "consecutive_act_failures", 0);
      G.updateContact(nodeId, {
        reachability_score: 1.0,
        failure_type: null,
        gc_candidate_ms: null,
      });
      log.info("Reachability self-healed via event", { nodeId });
    }
  }
}

/**
 * 将一个事件映射到图状态变更。
 * 返回事件的 novelty 值。
 */
export function applyPerturbation(G: WorldModel, event: GraphPerturbation): number {
  const { type, channelId, contactId } = event;
  // ADR-147 D5: 时钟偏差守卫 — 非法/过大偏差的 nowMs 回退到 Date.now()。
  // 容忍 60 秒未来偏差（Alice 系统时钟与 Telegram 服务器的微小差异）。
  const rawNowMs = event.nowMs;
  const nowMs =
    rawNowMs != null && rawNowMs > 0 && rawNowMs < Date.now() + 60_000 ? rawNowMs : Date.now();

  switch (type) {
    case "new_message": {
      // 自动建节点
      if (channelId) {
        ensureChannel(G, channelId, event.chatType, event.chatDisplayName);
      }
      // ADR-206: 频道以自身身份发消息（sender_id === chat_id）→ 不创建幽灵联系人。
      // 频道是信息流实体，身份属性存储在 channel 节点上，不需要 contact 镜像。
      // 真人管理员以个人身份发消息（sender_id !== chat_id）仍然创建联系人。
      const isChannelSelfPost =
        event.chatType === "channel" &&
        contactId &&
        channelId &&
        contactId === chatIdToContactId(channelId);
      if (contactId && !isChannelSelfPost) {
        ensureContact(G, contactId, channelId, event.displayName);
      }

      // P1: unread 累加
      if (channelId && G.has(channelId)) {
        const chAttrs = G.getChannel(channelId);
        const oldUnread = chAttrs.unread ?? 0;
        // ADR-150 D1: EWMS (Exponentially Weighted Moving Sum) 精确累加器。
        // S_new = S_old × 2^(-Δt/τ) + 1.0 — 数学上等价于逐消息衰减求和。
        // @see docs/adr/150-ewms-exact-unread-decay.md
        const oldEwms = Number(chAttrs.unread_ewms ?? 0);
        const oldEwmsMs = Number(chAttrs.unread_ewms_ms ?? 0);
        const ewmsDtS = oldEwmsMs > 0 ? Math.max(0, (nowMs - oldEwmsMs) / 1000) : 0;
        const ewmsDecay = ewmsDtS > 0 ? 2 ** (-ewmsDtS / UNREAD_FRESHNESS_HALFLIFE_S) : 1;
        G.updateChannel(channelId, {
          unread: oldUnread + 1,
          last_activity_ms: nowMs, // ADR-110
          last_incoming_ms: nowMs, // ADR-134 D2: P1 未读新鲜度衰减用
          unread_ewms: oldEwms * ewmsDecay + 1.0,
          unread_ewms_ms: nowMs,
        });

        // P5: directed 消息追踪 — bot 不产生社交义务
        // Bot 的 reply/@mention/私聊是工具输出，不是社交请求。
        // 若允许 bot 递增 pending_directed，义务检查会在 System 1 bot-digest
        // 之前触发升级，导致 AI-AI 回复循环（死循环）。
        if (event.isDirected && !event.senderIsBot) {
          const oldDirected = chAttrs.pending_directed ?? 0;
          // ADR-95 W1: 新 directed 消息 → 重置沉默冷却（新消息改变了上下文）
          G.updateChannel(channelId, {
            pending_directed: oldDirected + 1,
            last_directed_ms: nowMs,
            consecutive_act_silences: 0,
          });

          // ADR-153: 群组 Hawkes 自激更新 — 仅 directed 消息计入（过滤 noise）
          const chChatType = chAttrs.chat_type ?? "private";
          if (chChatType === "group" || chChatType === "supergroup") {
            const chHawkesParams = getDefaultParams(chAttrs.tier_contact as DunbarTier, true);
            const oldChHawkes: HawkesState = {
              lambdaCarry: chAttrs.hawkes_carry ?? 0,
              lastEventMs: chAttrs.hawkes_last_event_ms ?? 0,
            };
            const newChHawkes = updateOnEvent(chHawkesParams, oldChHawkes, nowMs);
            G.updateChannel(channelId, {
              hawkes_carry: newChHawkes.lambdaCarry,
              hawkes_last_event_ms: newChHawkes.lastEventMs,
            });
          }
        }
      }

      // #22: mentions_alice 标记 — 消息文本包含 Alice 名字时设置
      // 结构匹配（text.includes），非语义判断，符合 ADR-50
      // ADR-126: 写入 mentions_alice_ms 时间戳供信号衰减层使用
      if (channelId && G.has(channelId) && event.messageText) {
        const mentionsAlice = event.messageText?.toLowerCase().includes("alice");
        if (mentionsAlice) {
          G.updateChannel(channelId, { mentions_alice: true, mentions_alice_ms: nowMs });
        }
      }

      // D7: 安全标注 — prompt injection 模式检测（ADR-123 §D7）
      // safety_flag 是瞬态标记：每条新消息到来时重新检测。
      if (channelId && G.has(channelId)) {
        const safetyFlag = event.messageText
          ? detectInjectionPatterns(event.messageText)
          : undefined;
        G.updateChannel(channelId, {
          safety_flag: safetyFlag ?? undefined,
          ...(safetyFlag && { safety_flag_ms: nowMs }),
        });
      }

      // G3: bot 标记 — 写入 contact 节点 + channel 节点
      if (event.senderIsBot) {
        if (contactId && G.has(contactId)) {
          G.updateContact(contactId, { is_bot: true });
        }
        if (channelId && G.has(channelId)) {
          G.updateChannel(channelId, { last_sender_is_bot: true });
        }
      } else if (channelId && G.has(channelId)) {
        // 非 bot 消息清除 channel 的 bot 标记
        G.updateChannel(channelId, { last_sender_is_bot: false });
      }

      // P3: 更新联系人 last_active
      if (contactId && G.has(contactId)) {
        const contactAttrs = G.getContact(contactId);
        const oldLastActive = contactAttrs.last_active_ms ?? 0;
        // ADR-110: silence 以秒为单位（theta 也是秒），从 ms 时间戳计算
        const silence = (nowMs - oldLastActive) / 1000;

        // M2 修复: Returning contact 检测
        if (oldLastActive > 0) {
          const tier = contactAttrs.tier;
          const theta = DUNBAR_TIER_THETA[tier] ?? 80;
          if (silence > theta * 0.5) {
            // 沉默超过半个 theta → 标记为 returning
            // P1-1: 对方在沉默后主动发起互动 → 递增 contact_initiated_count
            const oldCount = Number(contactAttrs.contact_initiated_count ?? 0);
            G.updateContact(contactId, {
              returning_ms: nowMs,
              contact_initiated_count: oldCount + 1,
            });
          }
        }

        const oldCount = contactAttrs.interaction_count ?? 0;
        // ADR-154: Goldilocks 自适应窗口——更新交互间隔 EMA
        const emaUpdate: { ema_contact_interval_s?: number } = {};
        if (oldLastActive > 0 && silence > 0) {
          const emaAlpha = 0.2;
          const prevEma = contactAttrs.ema_contact_interval_s ?? silence;
          emaUpdate.ema_contact_interval_s = emaAlpha * silence + (1 - emaAlpha) * prevEma;
        }
        G.updateContact(contactId, {
          last_active_ms: nowMs,
          interaction_count: oldCount + 1,
          ...emaUpdate,
        });

        // ADR-153: Per-contact Hawkes 自激更新 — bot 消息不产生自激效应
        if (!event.senderIsBot) {
          const hawkesParams = getDefaultParams(contactAttrs.tier as DunbarTier, false);
          const oldHawkes: HawkesState = {
            lambdaCarry: contactAttrs.hawkes_carry ?? 0,
            lastEventMs: contactAttrs.hawkes_last_event_ms ?? 0,
          };
          const newHawkes = updateOnEvent(hawkesParams, oldHawkes, nowMs);
          G.updateContact(contactId, {
            hawkes_carry: newHawkes.lambdaCarry,
            hawkes_last_event_ms: newHawkes.lastEventMs,
            hawkes_event_count: (contactAttrs.hawkes_event_count ?? 0) + 1,
            hawkes_first_event_ms: contactAttrs.hawkes_first_event_ms ?? nowMs,
          });
        }
      }

      // 支柱④: 收到对方消息 → 重置连发计数（anti-bombing turn-taking）
      // Alice 行动 → +1（observer.mod DECLARE_ACTION）；对方回复 → 归零
      if (channelId && G.has(channelId)) {
        G.updateChannel(channelId, { consecutive_outgoing: 0 });
        // ADR-79 M1: 事件自愈 — 收到消息即活性证明
        resetReachability(G, channelId);
      }

      // ADR-79 M1: 联系人级自愈
      if (contactId && G.has(contactId)) {
        resetReachability(G, contactId);
      }

      // L3: 内容类型标记
      if (channelId && G.has(channelId)) {
        G.updateChannel(channelId, { last_content_type: event.contentType ?? "text" });
      }

      // ADR-26: conversation 生命周期
      if (channelId) {
        const existingConv = findActiveConversation(G, channelId);
        if (existingConv) {
          updateConversation(G, existingConv, event);
        } else if (event.isDirected) {
          detectConversationStart(G, event);
        } else if (event.isContinuation) {
          // 隐式对话：Alice 近期发言 + 对方紧跟回复（不用 reply）→ 创建对话
          createImplicitConversation(G, event);
        }
      }

      // ADR-206 W5: 频道线索提取——转发来源 + t.me 链接
      // 线索存储为 channel 节点的动态属性 channel_leads（JSON 数组）
      if (channelId && G.has(channelId)) {
        const leads: string[] = [];
        if (event.forwardFromChannelId) {
          leads.push(`fwd:${event.forwardFromChannelId}`);
          log.debug("Channel lead: forward source", {
            from: channelId,
            lead: event.forwardFromChannelId,
            name: event.forwardFromChannelName,
          });
        }
        if (event.tmeLinks) {
          for (const link of event.tmeLinks) {
            leads.push(`link:${link}`);
          }
        }
        if (leads.length > 0) {
          // 追加到已有线索（去重，最多保留 50 条）
          let existing: string[] = [];
          try {
            existing = JSON.parse(
              String(G.getDynamic(channelId, "channel_leads") ?? "[]"),
            ) as string[];
          } catch {
            // 容错：非法 JSON 值，重置为空数组
          }
          const merged = [...new Set([...existing, ...leads])].slice(-50);
          G.setDynamic(channelId, "channel_leads", JSON.stringify(merged));
        }
      }

      return event.novelty ?? 0.5;
    }

    case "read_history": {
      // 自己读了消息 → 清空 unread
      if (channelId && G.has(channelId)) {
        // pending_directed 不随 read_history 清零——已读 ≠ 已回复。
        // @see paper-five-dim/ §4.2: directed obligation decrement semantics
        G.updateChannel(channelId, {
          unread: 0,
          unread_ewms: 0, // ADR-150 D3: EWMS 同步清零
          mentions_alice: false, // #22: 清除 mentions_alice 标记（已消费）
        });
      }
      return 0.05;
    }

    case "user_status": {
      // 联系人在线状态变更 → 更新 last_active_ms
      if (contactId && G.has(contactId)) {
        G.updateContact(contactId, { last_active_ms: nowMs });
        // ADR-79 M1: 事件自愈 — 在线状态变更即活性证明
        resetReachability(G, contactId);
      }
      return 0.1;
    }

    case "contact_active": {
      if (contactId && G.has(contactId)) {
        G.updateContact(contactId, { last_active_ms: nowMs });
      }
      return 0.2;
    }

    case "reaction": {
      // Reaction 是零成本的外部行为反馈信号
      if (contactId) {
        ensureContact(G, contactId, channelId);
        if (G.has(contactId)) {
          // H2 修复: reaction 注入社交张力
          G.updateContact(contactId, {
            last_active_ms: nowMs,
            last_reaction_ms: nowMs,
            last_reaction_emoji: event.emoji ?? "",
            reaction_boost_ms: nowMs,
          });
          // ADR-79 M1: 事件自愈 — reaction 即活性证明
          resetReachability(G, contactId);
        }
      }
      if (channelId) {
        ensureChannel(G, channelId);
        if (G.has(channelId)) {
          G.updateChannel(channelId, { last_reaction_ms: nowMs });
          // ADR-79 M1: 频道级自愈
          resetReachability(G, channelId);
        }
      }
      return 0.3;
    }

    case "chat_member_update": {
      // M4: 成员变更 → 更新联系人/频道属性
      if (contactId) {
        ensureContact(G, contactId, channelId);
        if (G.has(contactId)) {
          G.updateContact(contactId, { last_active_ms: nowMs });
        }
      }
      if (channelId) {
        ensureChannel(G, channelId);
      }
      return 0.2;
    }

    case "typing": {
      // Typing 事件不修改图状态——仅作为 engagement watcher 的信号源。
      return event.novelty ?? 0.05;
    }

    default:
      return 0.05;
  }
}

/**
 * 批量应用事件，返回平均 novelty。
 */
export function applyPerturbations(G: WorldModel, events: GraphPerturbation[]): number {
  if (events.length === 0) return 0.05;
  let sum = 0;
  for (const event of events) {
    sum += applyPerturbation(G, event);
  }
  return sum / events.length;
}

/**
 * ADR-206: 清理幽灵联系人 — 频道以自身身份发消息产生的 contact 镜像。
 *
 * 识别条件：contact:XXX 对应的 channel:XXX 的 chat_type === "channel"。
 * 清理策略：删除幽灵联系人节点及其所有关系。display_name 等有价值属性
 * 不需要迁移——频道节点在 bootstrap 时已经独立获取了这些属性。
 *
 * 一次性清理，在图恢复后调用。
 * @returns 清理的幽灵联系人数量
 */
export function cleanupPhantomContacts(G: WorldModel): number {
  let cleaned = 0;
  for (const cid of G.getEntitiesByType("contact")) {
    const chId = ensureChannelId(cid);
    if (!chId) continue;
    if (G.has(chId) && G.getChannel(chId).chat_type === "channel") {
      G.removeEntity(cid);
      cleaned++;
      log.info("Removed phantom contact", { contactId: cid, channelId: chId });
    }
  }
  return cleaned;
}
