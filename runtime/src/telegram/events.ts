/**
 * mtcute Dispatcher 事件绑定。
 * 将 Telegram 更新转化为 GraphPerturbation 并推入事件缓冲区。
 */

import type { Dispatcher } from "@mtcute/dispatcher";
import type { TelegramClient } from "@mtcute/node";
import { Chat, getMarkedPeerId, type tl, User } from "@mtcute/node";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { recordObservedGroupPhoto } from "../db/album.js";
import { writeCanonicalEvent, writeCanonicalEventOnce } from "../db/canonical-event-store.js";
import { getDb } from "../db/connection.js";
import { messageLog } from "../db/schema.js";
import { terminateConversation } from "../engine/conversation.js";
import { telegramChannelId, telegramContactId } from "../graph/constants.js";
import type { WorldModel } from "../graph/world-model.js";
import { getCachedDescription, getCachedOcrText } from "../llm/media-cache.js";
import { stableTransportMessageId } from "../platform/transport.js";
import { createLogger } from "../utils/logger.js";
import { fetchAndCacheBio, getCachedBio } from "./bio-cache.js";
import { canonicalFromPerturbation } from "./canonical-events.js";
import type { GraphPerturbation } from "./mapper.js";

const log = createLogger("events");

/** ADR-64 I-1: directed 消息到达回调类型。 */
export type DirectedCallback = (event: GraphPerturbation) => void;

/** ADR-248 W3: canonical_events 实时旁路写入。失败只告警，不影响 EventBuffer 主路径。 */
export function pushCanonicalPerturbation(
  buffer: EventBuffer,
  event: GraphPerturbation,
  sourceId?: string,
): void {
  try {
    if (sourceId) {
      writeCanonicalEventOnce(canonicalFromPerturbation(event), { source: "telegram", sourceId });
    } else {
      writeCanonicalEvent(canonicalFromPerturbation(event));
    }
  } catch (e) {
    log.warn("Failed to write canonical event side path", e);
  }
  buffer.push(event);
}

/**
 * 对话延续唤醒窗口（ms）。旧值 2 ticks × 60s = 120s。
 * Alice 在某频道发言后此时间窗内，该频道的新消息也触发 debounce 唤醒。
 * 避免群聊中对方不用 reply 直接跟进时 Alice 等待整个 tick 间隔。
 */
const CONTINUATION_WAKEUP_MS = 120_000;

function extractMediaUniqueFileId(media: unknown): string | null {
  if (!media || typeof media !== "object") return null;
  const record = media as { uniqueFileId?: unknown; fileUniqueId?: unknown };
  if (typeof record.uniqueFileId === "string" && record.uniqueFileId.trim()) {
    return record.uniqueFileId;
  }
  if (typeof record.fileUniqueId === "string" && record.fileUniqueId.trim()) {
    return record.fileUniqueId;
  }
  return null;
}

/** 事件缓冲区：每 tick 收集，evolve 消费。 */
export class EventBuffer {
  static readonly DEFAULT_MAX_SIZE = 1000;
  /** ADR-114 D4: protected 段上限（directed 事件保护区）。 */
  static readonly MAX_PROTECTED = 100;

  private readonly maxRegularSize: number;
  private readonly maxProtectedSize: number;
  /** ADR-114 D4: directed 事件保护区。忙群离线涌入时 @mention/reply 不被淹没。 */
  private protectedBuffer: GraphPerturbation[] = [];
  /** 非 directed 事件的常规缓冲。 */
  private regularBuffer: GraphPerturbation[] = [];
  /** 自上次 drain 以来常规段溢出丢弃的事件数。供 evolve 感知事件丢失。 */
  private _droppedCount = 0;
  /** ADR-114 D4: protected 段溢出丢弃计数。 */
  private _droppedDirectedCount = 0;
  /** ADR-147 D1: 累计溢出计数（不随 drain 清零，审计用）。 */
  totalDroppedSinceBoot = 0;
  totalDroppedDirectedSinceBoot = 0;
  /** ADR-147 D4: mtcute 重连恢复标志位。`updating` 期间为 true。 */
  private _isRecovering = false;
  /** ADR-64 I-1: directed 消息到达时的回调，用于唤醒 evolve 循环。 */
  private _onDirected: DirectedCallback | null = null;
  /** 任意事件到达时的低优先级唤醒回调（conversation mode 快速响应）。 */
  private _onAnyEvent: (() => void) | null = null;

  // ADR-107: 事件监听回调。engagement session 用来监听目标聊天回复和抢占事件。
  // watcher 是一次性的——resolve 后自动移除。
  private _watchers: Array<{
    filter: (event: GraphPerturbation) => boolean;
    resolve: (event: GraphPerturbation) => void;
  }> = [];

  constructor(maxSize?: number) {
    const total = maxSize ?? EventBuffer.DEFAULT_MAX_SIZE;
    // 小 buffer（测试用）：protected 不超过总容量的一半，regular 至少 1
    this.maxProtectedSize = Math.min(EventBuffer.MAX_PROTECTED, Math.floor(total / 2));
    this.maxRegularSize = Math.max(1, total - this.maxProtectedSize);
  }

  /** ADR-147 D4: mtcute 重连恢复标志（`updating` 期间为 true）。 */
  set isRecovering(v: boolean) {
    this._isRecovering = v;
  }
  get isRecovering(): boolean {
    return this._isRecovering;
  }

  /** 注册 directed 消息到达回调（evolve 循环调用）。 */
  set onDirected(cb: DirectedCallback | null) {
    this._onDirected = cb;
  }

  /** 注册任意事件到达回调（低优先级唤醒）。 */
  set onAnyEvent(cb: (() => void) | null) {
    this._onAnyEvent = cb;
  }

  /**
   * ADR-107: 注册事件监听器。返回 promise（首个匹配事件）和 cancel 函数。
   * 事件仍然正常入 buffer（drain 不受影响），只是额外通知 watcher。
   * @see docs/adr/107-engagement-session/README.md
   */
  watch(filter: (event: GraphPerturbation) => boolean): {
    promise: Promise<GraphPerturbation>;
    cancel: () => void;
  } {
    let resolve!: (event: GraphPerturbation) => void;
    const promise = new Promise<GraphPerturbation>((r) => {
      resolve = r;
    });
    const watcher = { filter, resolve };
    this._watchers.push(watcher);
    return {
      promise,
      cancel: () => {
        const idx = this._watchers.indexOf(watcher);
        if (idx >= 0) this._watchers.splice(idx, 1);
      },
    };
  }

  push(event: GraphPerturbation): void {
    // ADR-114 D4: directed 事件进 protected 段，其余进 regular 段
    if (event.isDirected) {
      this.protectedBuffer.push(event);
      if (this.protectedBuffer.length > this.maxProtectedSize) {
        this.protectedBuffer.shift();
        this._droppedDirectedCount++;
        this.totalDroppedDirectedSinceBoot++;
        log.warn("EventBuffer protected overflow, oldest directed event dropped", {
          protectedSize: this.protectedBuffer.length,
          totalDroppedDirected: this._droppedDirectedCount,
        });
      }
    } else {
      if (this.regularBuffer.length >= this.maxRegularSize) {
        this.regularBuffer.shift();
        this._droppedCount++;
        this.totalDroppedSinceBoot++;
        log.warn("EventBuffer overflow, oldest event dropped", {
          regularSize: this.regularBuffer.length,
          totalDropped: this._droppedCount,
        });
      }
      this.regularBuffer.push(event);
    }

    // ADR-107: 通知匹配的 watchers（从后向前遍历，因为 resolve 后 splice 自身）
    for (let i = this._watchers.length - 1; i >= 0; i--) {
      if (this._watchers[i].filter(event)) {
        this._watchers[i].resolve(event);
        this._watchers.splice(i, 1);
      }
    }

    // ADR-64 I-1: directed 消息到达时通知 evolve 循环提前唤醒
    // ADR-66 F1: 对话延续窗口 — Alice 近期发言的频道的非 directed 消息也唤醒
    if ((event.isDirected || event.isContinuation) && this._onDirected) {
      this._onDirected(event);
    }

    // 低优先级唤醒：任意事件通知（conversation mode 下非 directed 事件也需响应）。
    // 注意：即使 onDirected 已触发也会调用——调用方应自行 debounce。
    if (this._onAnyEvent) {
      this._onAnyEvent();
    }
  }

  /** 取出并清空当前缓冲。返回事件列表（按 tick 排序）和丢弃计数。 */
  drain(): { events: GraphPerturbation[]; droppedCount: number; droppedDirectedCount: number } {
    // ADR-114 D4: 合并两段并按 tick 排序，保证时序一致性
    const events = [...this.protectedBuffer, ...this.regularBuffer].sort(
      (a, b) => (a.tick ?? 0) - (b.tick ?? 0),
    );
    const droppedCount = this._droppedCount;
    const droppedDirectedCount = this._droppedDirectedCount;
    this.protectedBuffer = [];
    this.regularBuffer = [];
    this._droppedCount = 0;
    this._droppedDirectedCount = 0;
    return { events, droppedCount, droppedDirectedCount };
  }

  get length(): number {
    return this.protectedBuffer.length + this.regularBuffer.length;
  }
}

/**
 * 将 Dispatcher 事件绑定到 EventBuffer。
 *
 * 绑定事件：
 * - onNewMessage → new_message
 * - onEditMessage → new_message (视为更新)
 * - onHistoryRead → read_history
 * - onUserStatusUpdate → user_status
 */
// ADR-77 B2: Alice 发出消息的内存缓存，用于 same_chat reply directed 检测。
// mtcute RepliedMessageInfo 在 same_chat origin 时 sender=null，无法判断原消息发送者。
// 缓存 Alice 的 outgoing message ID，reply 检测时查缓存。
// key = `${channelId}_${msgId}`，LRU 淘汰保持上限 2000 条。
const OUTGOING_CACHE_LIMIT = 2000;
// Map 的迭代顺序是插入顺序，天然支持 LRU（O(1) 淘汰最旧条目）。
const outgoingMsgCache = new Map<string, true>();

export function cacheOutgoingMsg(channelId: string, msgId: number): void {
  const key = `${channelId}_${msgId}`;
  if (outgoingMsgCache.has(key)) return;
  outgoingMsgCache.set(key, true);
  if (outgoingMsgCache.size > OUTGOING_CACHE_LIMIT) {
    // Map.keys().next() 返回最早插入的 key（LRU 淘汰）
    const oldest = outgoingMsgCache.keys().next().value;
    if (oldest != null) outgoingMsgCache.delete(oldest);
  }
}

function isOutgoingMsg(channelId: string, msgId: number): boolean {
  return outgoingMsgCache.has(`${channelId}_${msgId}`);
}

/**
 * ADR-90 W1: 启动时从 DB 预热 outgoing message cache。
 * 重启后内存 Set 清空 → reply directed 检测失效。
 * 利用 message_log 的 idx_message_log_chat_msg 索引恢复最近 N 条。
 *
 * @returns 预热的记录数
 */
export function warmOutgoingCache(): number {
  try {
    const db = getDb();
    const rows = db
      .select({ chatId: messageLog.chatId, msgId: messageLog.msgId })
      .from(messageLog)
      .where(and(eq(messageLog.isOutgoing, true), isNotNull(messageLog.msgId)))
      .orderBy(desc(messageLog.tick))
      .limit(OUTGOING_CACHE_LIMIT)
      .all();
    for (const row of rows) {
      if (row.msgId != null) {
        cacheOutgoingMsg(row.chatId, row.msgId);
      }
    }
    return rows.length;
  } catch (e) {
    log.warn("Failed to warm outgoing cache from DB", e);
    return 0;
  }
}

export function bindEvents(
  dp: Dispatcher,
  G: WorldModel,
  buffer: EventBuffer,
  getSelfId: () => string,
  getCurrentTick: () => number,
  getSelfUsername?: () => string | undefined,
  client?: TelegramClient,
): void {
  // 新消息
  dp.onNewMessage(async (ctx) => {
    const chatId = String(ctx.chat.id);
    const channelId = telegramChannelId(chatId);
    const senderId = ctx.sender ? String(ctx.sender.id) : null;
    const selfId = getSelfId();
    const tick = getCurrentTick();

    // 跳过自己发的消息——但先缓存 message ID 用于 reply directed 检测
    if (senderId === selfId) {
      cacheOutgoingMsg(channelId, ctx.id);
      return;
    }

    // 跳过 Telegram "Replies" 系统实体（ID 1271266957）。
    // 关联群组/频道之间的跨 chat 回复会以 Replies 身份投递，
    // 产生幽灵频道 + 虚假 P5 义务 + 发送者身份丢失。
    // Alice 已在原始频道看到真实消息，此处的副本应丢弃。
    if (senderId === "1271266957") return;

    const contactId = senderId ? telegramContactId(senderId) : null;

    // 判断是否 directed（reply、私聊、或 @mention）
    const isPrivate = ctx.chat instanceof User;
    // B1 修复 + ADR-77 B2: reply directed 检测
    // RepliedMessageInfo 在 same_chat origin 时 sender=null（mtcute 设计）。
    // B2 补丁：当 sender 不可用但 replyToMessage.id 存在时，查内存缓存判断
    // 被回复的消息是否是 Alice 发出的。
    let isReply = false;
    if (ctx.replyToMessage) {
      if (ctx.replyToMessage.sender) {
        // other_chat / private origin: sender 可用，直接判断
        const replySender = ctx.replyToMessage.sender;
        if ("id" in replySender && String(replySender.id) === selfId) {
          isReply = true;
        }
      } else if (ctx.replyToMessage.id != null) {
        // same_chat origin: sender=null，用内存缓存查 outgoing message ID
        isReply = isOutgoingMsg(channelId, ctx.replyToMessage.id);
      }
    }
    // 检查消息实体中是否有 @mention 指向自己
    let isMentioned = false;
    const selfUsername = getSelfUsername?.();
    if (selfUsername && ctx.entities) {
      for (const entity of ctx.entities) {
        if (entity.kind === "mention") {
          // @username 形式的 mention
          const mentionText = entity.text;
          if (mentionText.toLowerCase() === `@${selfUsername.toLowerCase()}`) {
            isMentioned = true;
            break;
          }
        }
        if (entity.is("text_mention") && String(entity.params.userId) === selfId) {
          // 无 username 用户的内联 mention
          isMentioned = true;
          break;
        }
      }
    }
    const isDirected = isPrivate || isReply || isMentioned;

    // G3: bot 检测 — mtcute User 对象有 isBot 属性
    const senderIsBot = ctx.sender instanceof User && ctx.sender.isBot;

    // 提取 chatType 和 displayName 供 mapper 自动建节点
    let chatType = "private";
    if (ctx.chat instanceof Chat) {
      const ct = ctx.chat.chatType;
      chatType = ct === "channel" ? "channel" : ct === "supergroup" ? "supergroup" : "group";
    }
    const displayName = ctx.sender?.displayName;
    // ADR-220: 频道/群组名（用于 channel.display_name）。
    // ADR-221: 私聊时 ctx.chat 是 User（无 displayName），用 sender 名作为聊天名。
    const chatDisplayName =
      ctx.chat instanceof Chat ? ctx.chat.displayName : ctx.sender?.displayName; // 私聊: chat name = sender name

    // 消息文本（截断至 4096 字符）
    const msgText = ctx.text ? ctx.text.slice(0, 4096) : undefined;
    const sName = displayName ?? (senderId ? `User ${senderId}` : undefined);

    // L3: 推断消息内容类型
    let contentType: "text" | "sticker" | "photo" | "voice" | "video" | "document" = "text";
    let mediaUniqueFileId: string | null = null;
    const media = ctx.media;
    if (media) {
      const mediaType = media.type;
      if (mediaType === "sticker") contentType = "sticker";
      else if (mediaType === "photo") contentType = "photo";
      else if (mediaType === "voice" || mediaType === "audio") contentType = "voice";
      else if (mediaType === "video") contentType = "video";
      else if (mediaType === "document") contentType = "document";
      mediaUniqueFileId = extractMediaUniqueFileId(media);
    }

    // ADR-66 F1: 对话延续窗口 — Alice 近期在该频道发言 → 非 directed 消息也唤醒 evolve
    // Bot 消息不触发延续——bot 回复不是「轮到 Alice」的信号。
    let isContinuation = false;
    if (!isDirected && !senderIsBot && G.has(channelId)) {
      const lastAliceActionMs = Number(G.getChannel(channelId).last_alice_action_ms ?? 0);
      if (lastAliceActionMs > 0 && Date.now() - lastAliceActionMs <= CONTINUATION_WAKEUP_MS) {
        isContinuation = true;
      }
    }

    // ADR-206 W5: 提取转发来源频道
    let forwardFromChannelId: string | undefined;
    let forwardFromChannelName: string | undefined;
    if (ctx.forward) {
      try {
        const fwdSender = ctx.forward.sender;
        if (fwdSender && "id" in fwdSender) {
          forwardFromChannelId = telegramChannelId(fwdSender.id);
          forwardFromChannelName =
            "displayName" in fwdSender ? (fwdSender.displayName as string) : undefined;
        }
      } catch {
        // forward.sender 可能抛异常（fromId 和 fromName 都不存在时）
      }
    }

    // ADR-206 W5: 提取消息中的 t.me 链接（频道发现线索）
    // ADR-206 W5: 从消息文本提取 t.me 链接中的用户名
    // Telegram 用户名规则：5-32 字符，[a-zA-Z_] 开头，[a-zA-Z0-9_] 组成
    let tmeLinks: string[] | undefined;
    if (msgText) {
      const re = /(?:^|[\s(])(?:https?:\/\/)?t\.me\/([a-zA-Z_][\w]{4,31})(?=[\s).,!?]|$)/g;
      const usernames: string[] = [];
      for (let m = re.exec(msgText); m !== null; m = re.exec(msgText)) {
        usernames.push(m[1]); // 捕获组 [1] = 纯用户名
      }
      if (usernames.length > 0) {
        tmeLinks = [...new Set(usernames)].slice(0, 5); // 去重，最多 5 条
      }
    }

    pushCanonicalPerturbation(
      buffer,
      {
        type: "new_message",
        channelId,
        contactId: contactId ?? undefined,
        isDirected,
        isContinuation,
        tick,
        // ADR-147 D5: 消息原始发送时间（Telegram 服务器 Unix 时间戳）。
        // 积压消息的 nowMs 使用原始时间 → effectiveUnread 衰减正确生效。
        nowMs: ctx.date.getTime(),
        novelty: 0.5,
        displayName,
        chatDisplayName,
        chatType,
        messageText: msgText,
        senderName: sName,
        contentType,
        senderIsBot: senderIsBot || undefined,
        forwardFromChannelId,
        forwardFromChannelName,
        tmeLinks,
      },
      `message:${channelId}:${ctx.id}`,
    );

    // 写入 message_log（FTS 同步由 SQLite 触发器自动完成）。
    // ADR-119: 媒体消息也入库（sticker/voice/photo 等），不再仅限有文本的消息。
    // @see runtime/drizzle/0017_fts5_triggers.sql
    if (msgText || contentType !== "text") {
      try {
        getDb()
          .insert(messageLog)
          .values({
            tick,
            platform: "telegram",
            chatId: channelId,
            msgId: ctx.id,
            nativeChatId: chatId,
            nativeMsgId: String(ctx.id),
            stableMessageId: stableTransportMessageId("telegram", chatId, ctx.id),
            replyToMsgId: ctx.replyToMessage?.id ?? undefined,
            senderId: contactId ?? undefined,
            senderName: sName,
            text: msgText ?? null,
            isOutgoing: false,
            isDirected,
            mediaType: contentType === "text" ? undefined : contentType,
          })
          .run();
      } catch (e) {
        log.warn("Failed to write message_log", e);
      }
    }

    // ADR-260: group photo album asset projection.
    // 只收群/超群照片；私聊照片不进入相册。
    if (
      contentType === "photo" &&
      mediaUniqueFileId &&
      (chatType === "group" || chatType === "supergroup")
    ) {
      try {
        recordObservedGroupPhoto({
          fileUniqueId: mediaUniqueFileId,
          sourceChatId: Number(chatId),
          sourceMsgId: ctx.id,
          captionText: msgText ?? null,
          description: getCachedDescription(mediaUniqueFileId) ?? null,
          ocrText: getCachedOcrText(mediaUniqueFileId) ?? null,
          observedAtMs: ctx.date.getTime(),
        });
      } catch (e) {
        log.warn("Failed to index group photo album asset", e);
      }
    }

    // Bio cache: 对 cache miss 的联系人/频道 fire-and-forget 获取 bio
    if (client) {
      if (contactId && !getCachedBio(contactId)) {
        fetchAndCacheBio(client, contactId).catch(() => {});
      }
      if (channelId && chatType !== "private" && !getCachedBio(channelId)) {
        fetchAndCacheBio(client, channelId).catch(() => {});
      }
    }
  });

  // 编辑消息（视为内容更新）
  // 审计修复: 补全 contactId/isDirected/messageText 等字段，
  // 确保 mapper 的 safety_flag 检测和联系人更新正确执行。
  dp.onEditMessage(async (ctx) => {
    // T-6: 过滤自己编辑的消息（与 onNewMessage 一致）
    const senderId = ctx.sender ? String(ctx.sender.id) : null;
    if (senderId === getSelfId()) return;
    // 跳过 Telegram Replies 系统实体（与 onNewMessage 一致）
    if (senderId === "1271266957") return;

    const chatId = String(ctx.chat.id);
    const channelId = telegramChannelId(chatId);
    const contactId = senderId ? telegramContactId(senderId) : null;
    const tick = getCurrentTick();

    // directed 检测（与 onNewMessage 一致）
    const isPrivate = ctx.chat instanceof User;
    let isReply = false;
    if (ctx.replyToMessage) {
      if (ctx.replyToMessage.sender) {
        const replySender = ctx.replyToMessage.sender;
        if ("id" in replySender && String(replySender.id) === getSelfId()) {
          isReply = true;
        }
      } else if (ctx.replyToMessage.id != null) {
        isReply = isOutgoingMsg(channelId, ctx.replyToMessage.id);
      }
    }
    let isMentioned = false;
    const selfUsername = getSelfUsername?.();
    if (selfUsername && ctx.entities) {
      for (const entity of ctx.entities) {
        if (entity.kind === "mention") {
          if (entity.text.toLowerCase() === `@${selfUsername.toLowerCase()}`) {
            isMentioned = true;
            break;
          }
        }
        if (entity.is("text_mention") && String(entity.params.userId) === getSelfId()) {
          isMentioned = true;
          break;
        }
      }
    }
    const isDirected = isPrivate || isReply || isMentioned;

    // chatType 和 displayName
    let chatType = "private";
    if (ctx.chat instanceof Chat) {
      const ct = ctx.chat.chatType;
      chatType = ct === "channel" ? "channel" : ct === "supergroup" ? "supergroup" : "group";
    }
    const displayName = ctx.sender?.displayName;
    const msgText = ctx.text ? ctx.text.slice(0, 4096) : undefined;

    pushCanonicalPerturbation(
      buffer,
      {
        type: "new_message",
        channelId,
        contactId: contactId ?? undefined,
        isDirected,
        tick,
        novelty: 0.3, // 编辑的新奇度较低
        nowMs: ctx.date.getTime(),
        displayName,
        chatType,
        messageText: msgText, // 审计修复: 确保 safety_flag 检测覆盖编辑消息
      },
      `edit:${channelId}:${ctx.id}`,
    );
  });

  // 已读历史
  dp.onHistoryRead(async (ctx) => {
    const chatId = String(ctx.chatId);
    const channelId = telegramChannelId(chatId);
    const tick = getCurrentTick();

    pushCanonicalPerturbation(
      buffer,
      {
        type: "read_history",
        channelId,
        tick,
      },
      `read_history:${channelId}:${tick}`,
    );
  });

  // 用户在线状态
  dp.onUserStatusUpdate(async (ctx) => {
    const userId = String(ctx.userId);
    const contactId = telegramContactId(userId);
    const tick = getCurrentTick();

    pushCanonicalPerturbation(
      buffer,
      {
        type: "user_status",
        contactId,
        tick,
      },
      `user_status:${contactId}:${tick}`,
    );
  });

  // Reaction（别人给消息点赞/回应）
  // Userbot 收到的是 updateMessageReactions（非 Bot 专用的 updateBotMessageReaction）。
  // mtcute 的 parse-update.ts 不解析此事件（default → null），
  // 所以用 onRawUpdate 直接捕获 TL 对象。
  dp.onRawUpdate(
    (_, upd) => upd._ === "updateMessageReactions",
    async (_client, upd, _peers) => {
      const raw = upd as tl.RawUpdateMessageReactions;
      const chatId = String(getMarkedPeerId(raw.peer));
      const channelId = telegramChannelId(chatId);
      const selfId = getSelfId();
      const tick = getCurrentTick();

      // 从 recentReactions 推断 actor（最近操作者）。
      // updateMessageReactions 不像 Bot API 那样直接给出 actor——
      // 它只提供聚合的 reactions + 最近操作者列表。
      const recent = raw.reactions.recentReactions ?? [];
      // 取 unread 的最新一条作为触发者（最接近真实 actor）
      const trigger = recent.find((r) => r.unread) ?? recent[0];
      const actorPeerId = trigger?.peerId;
      const actorId = actorPeerId ? String(getMarkedPeerId(actorPeerId)) : null;

      // 跳过自己的 reaction
      if (actorId === selfId) return;

      const contactId = actorId ? telegramContactId(actorId) : null;

      // 提取 emoji——从聚合结果中取第一个有效 reaction
      const firstResult = raw.reactions.results[0];
      let emoji = "";
      if (trigger) {
        // 优先用触发者的 reaction
        const r = trigger.reaction;
        emoji = r._ === "reactionEmoji" ? r.emoticon : r._ === "reactionPaid" ? "⭐" : "custom";
      } else if (firstResult) {
        const r = firstResult.reaction;
        emoji = r._ === "reactionEmoji" ? r.emoticon : r._ === "reactionPaid" ? "⭐" : "custom";
      }

      if (emoji) {
        // ADR-78 F1: Reaction continuation — Alice 发言后的即时 reaction 也唤醒 evolve
        let isContinuation = false;
        if (channelId && G.has(channelId)) {
          const lastAliceActionMs = Number(G.getChannel(channelId).last_alice_action_ms ?? 0);
          if (lastAliceActionMs > 0 && Date.now() - lastAliceActionMs <= CONTINUATION_WAKEUP_MS) {
            isContinuation = true;
          }
        }

        pushCanonicalPerturbation(
          buffer,
          {
            type: "reaction",
            channelId,
            contactId: contactId ?? undefined,
            tick,
            emoji,
            messageId: raw.msgId,
            isContinuation,
            // ADR-147 D11: updateMessageReactions TL 无 date 字段，
            // 无法获取 reaction 原始时间。积压场景由 D4 isRecovering + D7 P1 cap 兜底。
          },
          `reaction:${channelId}:${raw.msgId}:${contactId ?? "unknown"}:${emoji}`,
        );
        log.debug("Reaction received (userbot raw)", {
          channelId,
          contactId,
          emoji,
          isContinuation,
        });
      }
    },
  );

  // M4: 群成员变更（加入、离开、封禁等）
  dp.onChatMemberUpdate(async (ctx) => {
    const chatId = String(ctx.chat.id);
    const channelId = telegramChannelId(chatId);
    const userId = String(ctx.user.id);
    const contactId = telegramContactId(userId);
    const tick = getCurrentTick();

    const updateType = ctx.type; // joined | left | kicked | added | ...

    // Self-kick/left 检测：Alice 自己被踢或离开 → 主动标记 permanent unreachable
    const selfId = getSelfId();
    if (userId === selfId && (updateType === "kicked" || updateType === "left")) {
      if (G.has(channelId)) {
        G.setDynamic(channelId, "reachability_score", 0);
        G.setDynamic(channelId, "failure_type", "permanent");
        G.setDynamic(channelId, "pending_directed", 0);
        G.setDynamic(channelId, "mentions_alice", false);
        // F5: 被踢/离开时立即终结活跃对话——防止 conversation 实体残留 45 分钟
        terminateConversation(G, channelId);
        log.info("Self-kick/left detected — marked permanent unreachable", {
          channelId,
          updateType,
        });
      }
    }

    pushCanonicalPerturbation(
      buffer,
      {
        type: "chat_member_update",
        channelId,
        contactId,
        tick,
      },
      `chat_member_update:${channelId}:${contactId}:${updateType}:${tick}`,
    );

    log.debug("Chat member update", { channelId, contactId, updateType });
  });

  // Typing indicator — 用户正在输入
  dp.onUserTyping(async (ctx) => {
    const chatId = String(ctx.chatId);
    const channelId = telegramChannelId(chatId);
    const userId = ctx.userId ? String(ctx.userId) : null;
    const contactId = userId ? telegramContactId(userId) : undefined;
    const tick = getCurrentTick();

    // 跳过 Alice 自己的 typing
    if (userId === getSelfId()) return;

    pushCanonicalPerturbation(
      buffer,
      {
        type: "typing",
        channelId,
        contactId,
        tick,
        novelty: 0.05, // 极低 novelty — typing 不触发 perceive
      },
      `typing:${channelId}:${contactId ?? "unknown"}:${tick}`,
    );
  });
}
