/**
 * 共享数据库查询函数。
 *
 * 与 Mod 无关的通用查询集中在此，避免分散在各 Mod 中重复实现。
 */
import { and, between, desc, eq, gt } from "drizzle-orm";
import { getDb } from "./connection.js";
import { actionLog, messageLog } from "./schema.js";

export function getRecentMessagesByChat(
  chatId: string,
  limit = 20,
): Array<{
  platform: string;
  msgId: number | null;
  nativeChatId: string | null;
  nativeMsgId: string | null;
  stableMessageId: string | null;
  senderName: string | null;
  senderId: string | null;
  text: string | null;
  isOutgoing: boolean;
  isDirected: boolean;
  mediaType: string | null;
  createdAt: Date;
}> {
  const db = getDb();
  return db
    .select({
      platform: messageLog.platform,
      msgId: messageLog.msgId,
      nativeChatId: messageLog.nativeChatId,
      nativeMsgId: messageLog.nativeMsgId,
      stableMessageId: messageLog.stableMessageId,
      senderName: messageLog.senderName,
      senderId: messageLog.senderId,
      text: messageLog.text,
      isOutgoing: messageLog.isOutgoing,
      isDirected: messageLog.isDirected,
      mediaType: messageLog.mediaType,
      createdAt: messageLog.createdAt,
    })
    .from(messageLog)
    .where(eq(messageLog.chatId, chatId))
    .orderBy(desc(messageLog.id))
    .limit(limit)
    .all()
    .reverse();
}

/**
 * 查询某联系人在所有聊天中的最近消息（用于 Formative Memories）。
 *
 * 从 message_log 按 senderId 查询，按 tick DESC 取最近 N 条。
 * 排除 Alice 自己发出的消息（isOutgoing = true）。
 *
 * @param senderId 联系人 ID（如 "contact:123"）
 * @param limit 最大返回条数，默认 15
 * @returns 按 tick 降序排列的消息列表
 *
 * @see docs/adr/86-voyager-concordia-cross-analysis.md §C5 Formative Memories
 */
export function getRecentMessagesBySender(
  senderId: string,
  limit = 15,
): Array<{ chatId: string; senderName: string | null; text: string | null; tick: number }> {
  const db = getDb();
  return db
    .select({
      chatId: messageLog.chatId,
      senderName: messageLog.senderName,
      text: messageLog.text,
      tick: messageLog.tick,
    })
    .from(messageLog)
    .where(and(eq(messageLog.senderId, senderId), eq(messageLog.isOutgoing, false)))
    .orderBy(desc(messageLog.tick))
    .limit(limit)
    .all();
}

// ── ADR-97: 回复链逸散上下文查询 ──────────────────────────────────────────

/**
 * messageLog 记录的轻量投影，供回复链逸散使用。
 * @see docs/adr/97-reply-chain-diffusion-context.md
 */
export interface DbMessageRecord {
  platform: string;
  /** UI-local visible reference number. Some platforms/rows may not have one. */
  msgId: number | null;
  /** 平台原生聊天 ID。 */
  nativeChatId: string | null;
  /** 平台原生消息 ID。 */
  nativeMsgId: string | null;
  /** 跨平台稳定消息 ID：message:<platform>:<nativeChatId>:<nativeMsgId>。 */
  stableMessageId: string | null;
  tick: number;
  senderId: string | null;
  senderName: string | null;
  text: string | null;
  /** ADR-119: 媒体类型（sticker/photo/voice/video/document）。纯文本消息为 null。 */
  mediaType: string | null;
  isOutgoing: boolean;
  replyToMsgId: number | null;
  createdAt: Date;
}

/** SELECT 投影——与 DbMessageRecord 字段对齐。 */
const MESSAGE_RECORD_COLUMNS = {
  platform: messageLog.platform,
  msgId: messageLog.msgId,
  nativeChatId: messageLog.nativeChatId,
  nativeMsgId: messageLog.nativeMsgId,
  stableMessageId: messageLog.stableMessageId,
  tick: messageLog.tick,
  senderId: messageLog.senderId,
  senderName: messageLog.senderName,
  text: messageLog.text,
  mediaType: messageLog.mediaType,
  isOutgoing: messageLog.isOutgoing,
  replyToMsgId: messageLog.replyToMsgId,
  createdAt: messageLog.createdAt,
} as const;

/**
 * 按当前聊天可见 msgId 获取单条消息。
 * 使用 idx_message_log_chat_msg 复合索引。
 *
 * @see docs/adr/97-reply-chain-diffusion-context.md
 */
export function getMessageByMsgId(chatId: string, msgId: number): DbMessageRecord | null {
  const db = getDb();
  const rows = db
    .select(MESSAGE_RECORD_COLUMNS)
    .from(messageLog)
    .where(and(eq(messageLog.chatId, chatId), eq(messageLog.msgId, msgId)))
    .limit(1)
    .all();
  const r = rows[0];
  if (!r || r.msgId == null) return null;
  return {
    platform: r.platform,
    msgId: r.msgId,
    nativeChatId: r.nativeChatId,
    nativeMsgId: r.nativeMsgId,
    stableMessageId: r.stableMessageId,
    tick: r.tick,
    senderId: r.senderId,
    senderName: r.senderName,
    text: r.text,
    mediaType: r.mediaType,
    isOutgoing: r.isOutgoing,
    replyToMsgId: r.replyToMsgId,
    createdAt: r.createdAt,
  };
}

/**
 * 获取 msgId 周围 ±radius 条消息（同 chatId）。
 * ORDER BY msgId ASC，用 BETWEEN 范围查询。
 *
 * 此函数只服务有数值型当前聊天引用号的平台路径；无 msgId 的平台行不会进入结果。
 *
 * @see docs/adr/97-reply-chain-diffusion-context.md
 */
export function getMessageCluster(
  chatId: string,
  centerMsgId: number,
  radius: number,
): DbMessageRecord[] {
  const db = getDb();
  const rows = db
    .select(MESSAGE_RECORD_COLUMNS)
    .from(messageLog)
    .where(
      and(
        eq(messageLog.chatId, chatId),
        between(messageLog.msgId, centerMsgId - radius, centerMsgId + radius),
      ),
    )
    .all();
  return rows
    .filter((r): r is typeof r & { msgId: number } => r.msgId != null)
    .map((r) => ({
      platform: r.platform,
      msgId: r.msgId,
      nativeChatId: r.nativeChatId,
      nativeMsgId: r.nativeMsgId,
      stableMessageId: r.stableMessageId,
      tick: r.tick,
      senderId: r.senderId,
      senderName: r.senderName,
      text: r.text,
      mediaType: r.mediaType,
      isOutgoing: r.isOutgoing,
      replyToMsgId: r.replyToMsgId,
      createdAt: r.createdAt,
    }))
    .sort((a, b) => a.msgId - b.msgId);
}

// ── ADR-121: 社交余光查询 ────────────────────────────────────────────────────

/**
 * 社交余光查询：某联系人的近期消息（跨频道）。
 *
 * 使用 idx_message_log_sender 索引按 senderId 检索，
 * 应用层过滤 sharedChats + excludeChat（避免 SQL IN 动态构建）。
 * Over-fetch 3x limit 以补偿应用层过滤损耗。
 *
 * @param senderId    联系人 ID（如 "contact:123"）
 * @param sinceMs     时间窗口起点（毫秒时间戳）
 * @param excludeChat 排除的当前频道 ID
 * @param limit       最大返回条数
 *
 * @see docs/adr/121-social-peripheral-vision/README.md §3.6
 */
export function getPeripheralMessages(
  senderId: string,
  sinceMs: number,
  excludeChat: string,
  limit: number,
): Array<{
  chatId: string;
  text: string | null;
  msgId: number;
  createdAt: Date;
  senderName: string | null;
}> {
  const db = getDb();
  const since = new Date(sinceMs);
  const overFetch = limit * 3;
  const rows = db
    .select({
      chatId: messageLog.chatId,
      text: messageLog.text,
      msgId: messageLog.msgId,
      createdAt: messageLog.createdAt,
      senderName: messageLog.senderName,
    })
    .from(messageLog)
    .where(
      and(
        eq(messageLog.senderId, senderId),
        gt(messageLog.createdAt, since),
        eq(messageLog.isOutgoing, false),
      ),
    )
    .orderBy(desc(messageLog.createdAt))
    .limit(overFetch)
    .all();
  // 应用层过滤：排除当前频道，msgId 必须存在
  return rows
    .filter((r): r is typeof r & { msgId: number } => r.msgId != null && r.chatId !== excludeChat)
    .slice(0, limit);
}

// ── ADR-117 D1: IRC-style 思考注入 ─────────────────────────────────────────

/**
 * 查询某 chat 最近的行动记录（用于 IRC-style 思考注入）。
 * 使用已有索引 idx_action_log_chat_tick。
 *
 * @see docs/adr/117-*.md — D1: 跨 tick 连续性
 */
export function getRecentActionsByChat(
  chatId: string,
  sinceMs: number,
  limit = 3,
): Array<{ tick: number; reasoning: string | null; actionType: string; createdAt: Date }> {
  const db = getDb();
  const since = new Date(sinceMs);
  return db
    .select({
      tick: actionLog.tick,
      reasoning: actionLog.reasoning,
      actionType: actionLog.actionType,
      createdAt: actionLog.createdAt,
    })
    .from(actionLog)
    .where(and(eq(actionLog.chatId, chatId), gt(actionLog.createdAt, since)))
    .orderBy(desc(actionLog.createdAt))
    .limit(limit)
    .all();
}
