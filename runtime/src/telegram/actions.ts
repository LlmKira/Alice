/**
 * Telegram 行动执行层：sendText, readHistory 封装 + 全局限流。
 *
 * mtcute 内置了 FloodWait 自动退避（flood-waiter middleware），
 * 这里的限流器是应用层保护——控制请求速率，避免触发 FloodWait。
 */

import { md } from "@mtcute/markdown-parser";
import type { Chat, ChatPreview, Message, StickerSet, TelegramClient } from "@mtcute/node";
import { InputMedia, Long, tl } from "@mtcute/node";
import { createLogger } from "../utils/logger.js";
import {
  rethrowTelegramActionFailure,
  TelegramActionError,
  type TelegramActionErrorCode,
} from "./errors.js";

const log = createLogger("actions");

/**
 * 滑动窗口限流器。
 * 限制在 windowMs 内最多 maxRequests 次调用。
 */
class SlidingWindowLimiter {
  private timestamps: number[] = [];
  /** Promise 链互斥，防止并发 acquire 竞争。 */
  private _queue: Promise<void> = Promise.resolve();

  constructor(
    private maxRequests: number,
    private windowMs: number,
  ) {}

  async acquire(): Promise<void> {
    // 串行化：所有 acquire 排队执行，消除并发竞争
    this._queue = this._queue.then(() => this._doAcquire());
    return this._queue;
  }

  private async _doAcquire(): Promise<void> {
    const now = Date.now();
    // 清除窗口外的旧时间戳
    this.timestamps = this.timestamps.filter((t) => t > now - this.windowMs);

    if (this.timestamps.length >= this.maxRequests) {
      // 等到最早的时间戳滑出窗口
      const waitMs = this.timestamps[0] + this.windowMs - now;
      log.debug("Rate limit hit, waiting", { waitMs });
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return this._doAcquire();
    }

    this.timestamps.push(now);
  }
}

// 全局限流：30 次/分钟（Telegram userbot 的保守安全线）
const globalLimiter = new SlidingWindowLimiter(30, 60_000);

/**
 * Markdown 预处理：覆盖 mtcute md() 不支持但 LLM 会输出的模式。
 * - # Heading → **Heading**（标题转粗体）
 * - - item / * item → • item（列表转符号）
 * - 1. item → • item（有序列表转符号）
 */
function preprocessMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+(.+)$/gm, "**$1**")
    .replace(/^[-*+]\s+/gm, "• ")
    .replace(/^\d+\.\s+/gm, "• ");
}

/**
 * 尝试将文本作为 markdown 解析为 TextWithEntities。
 * 有 entities 则返回解析结果，否则返回 null（fallback 到纯文本）。
 */
function tryParseMarkdown(text: string): { text: string; entities: tl.TypeMessageEntity[] } | null {
  try {
    const preprocessed = preprocessMarkdown(text);
    const parsed = md(preprocessed);
    if (parsed.entities && parsed.entities.length > 0) {
      return parsed as { text: string; entities: tl.TypeMessageEntity[] };
    }
  } catch {
    // 解析失败 → 纯文本 fallback
  }
  return null;
}

/**
 * 发送文字消息。支持可选的 mention entity（真正的 @ 提及，而非纯文本 @username）。
 * 自动检测 markdown 格式（**bold**、`code`、[link](url) 等），有 entities 则渲染。
 */
export async function sendText(
  client: TelegramClient,
  chatId: string | number,
  text: string,
  options: {
    replyToMsgId?: number;
    mentions?: Array<{ offset: number; length: number; userId: number }>;
  } = {},
): Promise<number | undefined> {
  await globalLimiter.acquire();

  const mdParsed = tryParseMarkdown(text);

  let sent: Message | undefined;
  try {
    if (options.mentions?.length) {
      const entities: tl.TypeMessageEntity[] = mdParsed ? [...mdParsed.entities] : [];
      for (const m of options.mentions) {
        // 使用 messageEntityMentionName（userId: number），mtcute _normalizeInputText
        // 会在 sendText 内部自动转换为 inputMessageEntityMentionName + resolvePeer。
        // @see docs/reference/mtcute/ packages/core/src/highlevel/methods/misc/normalize-text.ts
        entities.push({
          _: "messageEntityMentionName",
          offset: m.offset,
          length: m.length,
          userId: m.userId,
        });
      }
      sent = await client.sendText(
        chatId,
        { text: mdParsed ? mdParsed.text : text, entities },
        { replyTo: options.replyToMsgId },
      );
    } else if (mdParsed) {
      sent = await client.sendText(chatId, mdParsed, { replyTo: options.replyToMsgId });
    } else {
      sent = await client.sendText(chatId, text, { replyTo: options.replyToMsgId });
    }
  } catch (err) {
    rethrowTelegramActionFailure(err, "send_text", { chatId: String(chatId) });
  }
  return sent?.id;
}

/**
 * 标记频道为已读（消息 + mention + reaction）。
 */
export async function markRead(client: TelegramClient, chatId: string | number): Promise<void> {
  await globalLimiter.acquire();
  // ADR-114 D3: 同时清除 mention 未读计数，避免 mention badge 累积
  await client.readHistory(chatId, { clearMentions: true });
  // 清除 reaction 未读角标——与 mention 同理，"看了就已读"
  // 复用同一次 limiter acquire——readHistory 和 readReactions 是同一用户意图（"标记已读"）
  try {
    await client.readReactions(chatId);
  } catch {
    // readReactions 失败不阻断主流程
  }
}

/**
 * 获取频道历史消息。
 */
export async function getHistory(
  client: TelegramClient,
  chatId: string | number,
  limit: number = 20,
): Promise<Message[]> {
  await globalLimiter.acquire();
  return client.getHistory(chatId, { limit });
}

/**
 * 对消息添加 emoji 表情回应。
 */
export async function sendReaction(
  client: TelegramClient,
  chatId: string | number,
  msgId: number,
  emoji: string,
): Promise<void> {
  await globalLimiter.acquire();
  try {
    await client.sendReaction({
      chatId,
      message: msgId,
      emoji,
    });
  } catch (err) {
    rethrowTelegramActionFailure(err, "send_reaction", { chatId: String(chatId), msgId, emoji });
  }
}

// ── M2: 行动空间扩展 ─────────────────────────────────────────────────────

/**
 * 编辑已发送的消息。
 */
export async function editMessage(
  client: TelegramClient,
  chatId: string | number,
  msgId: number,
  text: string,
): Promise<void> {
  await globalLimiter.acquire();
  const mdParsed = tryParseMarkdown(text);
  if (mdParsed) {
    await client.editMessage({
      chatId,
      message: msgId,
      text: { text: mdParsed.text, entities: mdParsed.entities },
    });
  } else {
    await client.editMessage({ chatId, message: msgId, text });
  }
}

/**
 * 转发消息到另一个聊天。
 */
export async function forwardMessage(
  client: TelegramClient,
  fromChatId: string | number,
  msgId: number,
  toChatId: string | number,
  options: { noAuthor?: boolean; noCaption?: boolean } = {},
): Promise<number | undefined> {
  await globalLimiter.acquire();
  let sent: Message[];
  try {
    sent = await client.forwardMessagesById({
      fromChatId,
      messages: [msgId],
      toChatId,
      noAuthor: options.noAuthor,
      noCaption: options.noCaption,
    });
  } catch (err) {
    rethrowTelegramActionFailure(err, "forward_message", {
      fromChatId: String(fromChatId),
      toChatId: String(toChatId),
      msgId,
    });
  }
  return sent[0]?.id;
}

export function classifyAlbumSourceError(error: unknown): TelegramActionErrorCode | null {
  if (tl.RpcError.is(error, "MESSAGE_ID_INVALID") || tl.RpcError.is(error, "MSG_ID_INVALID")) {
    return "album_source_missing";
  }
  if (
    tl.RpcError.is(error, "CHANNEL_PRIVATE") ||
    tl.RpcError.is(error, "CHAT_FORBIDDEN") ||
    tl.RpcError.is(error, "PEER_ID_INVALID") ||
    tl.RpcError.is(error, "CHAT_ID_INVALID") ||
    tl.RpcError.is(error, "USER_NOT_PARTICIPANT")
  ) {
    return "album_source_inaccessible";
  }
  if (tl.RpcError.is(error, "CHAT_FORWARDS_RESTRICTED")) {
    return "album_forward_restricted";
  }
  return null;
}

export async function uploadMessageMediaCopy(
  client: TelegramClient,
  fromChatId: string | number,
  msgId: number,
  toChatId: string | number,
  options: { caption?: string; replyToMsgId?: number } = {},
): Promise<number | undefined> {
  await globalLimiter.acquire();
  const msgs = await client.getMessages(fromChatId, [msgId]);
  const msg = msgs[0];
  if (!msg) {
    throw new TelegramActionError(
      "album_source_missing",
      `album source message ${msgId} not found`,
    );
  }
  const media = msg.media;
  if (!media) {
    throw new TelegramActionError(
      "album_source_missing",
      `album source message ${msgId} has no media`,
    );
  }
  const buffer = Buffer.from(
    await client.downloadAsBuffer(media as Parameters<typeof client.downloadAsBuffer>[0]),
  );
  const inputMedia = InputMedia.auto(buffer, { fileName: `album-${msgId}.jpg` });
  let sent: Message | undefined;
  try {
    sent = await client.sendMedia(toChatId, inputMedia, {
      caption: options.caption,
      replyTo: options.replyToMsgId,
    });
  } catch (err) {
    rethrowTelegramActionFailure(err, "upload_media_copy", {
      fromChatId: String(fromChatId),
      toChatId: String(toChatId),
      msgId,
    });
  }
  return sent?.id;
}

/**
 * 发送贴纸（通过 file ID）。
 */
export async function sendSticker(
  client: TelegramClient,
  chatId: string | number,
  fileId: string,
  options: { replyToMsgId?: number } = {},
): Promise<number | undefined> {
  await globalLimiter.acquire();
  let sent: Message | undefined;
  try {
    sent = await client.sendMedia(chatId, fileId, {
      replyTo: options.replyToMsgId,
    });
  } catch (err) {
    rethrowTelegramActionFailure(err, "send_sticker", { chatId: String(chatId), fileId });
  }
  return sent?.id;
}

/**
 * 固定消息。
 */
export async function pinMessage(
  client: TelegramClient,
  chatId: string | number,
  msgId: number,
): Promise<void> {
  await globalLimiter.acquire();
  await client.pinMessage({ chatId, message: msgId });
}

/**
 * 发送/取消打字指示器。
 * 不经过 globalLimiter（不产生消息，不受速率限制）。
 */
export async function setTyping(
  client: TelegramClient,
  chatId: string | number,
  cancel = false,
): Promise<void> {
  await client.setTyping({
    peerId: chatId,
    status: cancel ? "cancel" : "typing",
  });
}

// ── M5: 行动空间全量扩展 ─────────────────────────────────────────────────

// ── 搜索 ──

/**
 * 聊天内搜索消息。
 */
export async function searchMessages(
  client: TelegramClient,
  chatId: string | number,
  query: string,
  limit = 20,
): Promise<Message[]> {
  await globalLimiter.acquire();
  const result = await client.searchMessages({ chatId, query, limit });
  return [...result];
}

/**
 * 全局搜索消息（跨所有聊天）。
 */
export async function searchGlobal(
  client: TelegramClient,
  query: string,
  limit = 20,
  onlyChannels = false,
): Promise<Message[]> {
  await globalLimiter.acquire();
  const result = await client.searchGlobal({ query, limit, onlyChannels });
  return [...result];
}

// ── Bot / Inline ──

/**
 * 获取已安装的贴纸集列表（仅元信息，不含贴纸本身）。
 */
export async function getInstalledStickers(client: TelegramClient): Promise<StickerSet[]> {
  await globalLimiter.acquire();
  return client.getInstalledStickers();
}

/**
 * 获取贴纸集详情（含贴纸列表）。
 * @param setId 贴纸集短名或 ID
 */
export async function getStickerSet(client: TelegramClient, setId: string): Promise<StickerSet> {
  await globalLimiter.acquire();
  return client.getStickerSet(setId);
}

/**
 * 点击 bot inline keyboard 按钮（获取回调应答）。
 */
export async function getCallbackAnswer(
  client: TelegramClient,
  chatId: string | number,
  msgId: number,
  data: string,
): Promise<{ message?: string; url?: string; alert?: boolean }> {
  await globalLimiter.acquire();
  const res = await client.getCallbackAnswer({ chatId, message: msgId, data });
  return {
    message: res.message,
    url: res.url,
    alert: res.alert,
  };
}

/**
 * 查询 inline bot 结果。
 * 使用 Raw TL 调用 messages.getInlineBotResults。
 */
export async function getInlineBotResults(
  client: TelegramClient,
  botUsername: string,
  chatId: string | number,
  query: string,
): Promise<{
  queryId: Long;
  results: Array<{ id: string; title?: string; description?: string; type: string }>;
}> {
  await globalLimiter.acquire();
  const botPeer = await client.resolvePeer(botUsername);
  if (botPeer._ !== "inputPeerUser") throw new Error(`Bot ${botUsername} is not a user`);
  const bot: tl.TypeInputUser = {
    _: "inputUser",
    userId: botPeer.userId,
    accessHash: botPeer.accessHash,
  };
  const peer = await client.resolvePeer(chatId);
  const result = await client.call({
    _: "messages.getInlineBotResults",
    bot,
    peer,
    query,
    offset: "",
  });
  return {
    queryId: result.queryId,
    results: result.results.map((r: tl.TypeBotInlineResult) => ({
      id: r.id,
      title: "title" in r ? r.title : undefined,
      description: "description" in r ? r.description : undefined,
      type: r.type,
    })),
  };
}

/**
 * 发送 inline bot 查询结果。
 * 使用 Raw TL 调用 messages.sendInlineBotResult。
 */
export async function sendInlineBotResult(
  client: TelegramClient,
  chatId: string | number,
  queryId: Long,
  resultId: string,
): Promise<void> {
  await globalLimiter.acquire();
  const peer = await client.resolvePeer(chatId);
  await client.call({
    _: "messages.sendInlineBotResult",
    peer,
    queryId,
    id: resultId,
    randomId: new Long(
      Math.floor(Math.random() * 0xffffffff),
      Math.floor(Math.random() * 0x7fffffff),
    ),
  });
}

// ── 媒体 / 消息管理 ──

/**
 * 发送媒体文件（通过 file ID，可附带 caption）。
 */
export async function sendMedia(
  client: TelegramClient,
  chatId: string | number,
  fileId: string,
  options: { caption?: string; replyTo?: number } = {},
): Promise<Message> {
  await globalLimiter.acquire();
  return client.sendMedia(chatId, fileId, {
    caption: options.caption,
    replyTo: options.replyTo,
  });
}

/**
 * 发送投票。仅群组/频道可用（userbot 私聊发 poll 会 MEDIA_INVALID）。
 */
export async function sendPoll(
  client: TelegramClient,
  chatId: string | number,
  question: string,
  answers: string[],
): Promise<Message> {
  await globalLimiter.acquire();
  return client.sendMedia(chatId, InputMedia.poll({ question, answers }));
}

/**
 * 删除消息（双向撤回）。
 */
export async function deleteMessages(
  client: TelegramClient,
  chatId: string | number,
  ids: number[],
): Promise<void> {
  await globalLimiter.acquire();
  await client.deleteMessagesById(chatId, ids, { revoke: true });
}

/**
 * 按 ID 获取特定消息。
 */
export async function getMessages(
  client: TelegramClient,
  chatId: string | number,
  ids: number[],
): Promise<(Message | null)[]> {
  await globalLimiter.acquire();
  return client.getMessages(chatId, ids);
}

// ── 群组发现 ──

/**
 * 加入频道/群组。支持 invite link、@username、数字 ID。
 * 若需管理员审批，返回 { pending: true }。
 */
export async function joinChat(
  client: TelegramClient,
  chatIdOrLink: string | number,
): Promise<{ chat?: Chat; pending: boolean }> {
  await globalLimiter.acquire();
  const chat = await client.joinChat(chatIdOrLink);
  return { chat, pending: false };
}

/**
 * 离开频道/群组。
 */
export async function leaveChat(client: TelegramClient, chatId: string | number): Promise<void> {
  await globalLimiter.acquire();
  await client.leaveChat(chatId);
}

/**
 * 搜索公开聊天（群组/频道/用户）。
 * 使用 Raw TL 调用 contacts.search。
 */
export async function searchPublicChats(
  client: TelegramClient,
  query: string,
  limit = 20,
): Promise<{
  users: Array<{ id: number; name: string }>;
  chats: Array<{ id: number; title: string }>;
}> {
  await globalLimiter.acquire();
  const res = await client.call({
    _: "contacts.search",
    q: query,
    limit,
  });
  return {
    users: res.users.map((u: tl.TypeUser) => ({
      id: "id" in u ? u.id : 0,
      name:
        "firstName" in u
          ? `${u.firstName ?? ""}${u.lastName ? ` ${u.lastName}` : ""}`.trim()
          : "Unknown",
    })),
    chats: res.chats.map((c: tl.TypeChat) => ({
      id: "id" in c ? c.id : 0,
      title: "title" in c ? (c.title ?? "") : "",
    })),
  };
}

/**
 * 预览私有群组信息（通过 invite link）。
 */
export async function getChatPreview(
  client: TelegramClient,
  inviteLink: string,
): Promise<ChatPreview> {
  await globalLimiter.acquire();
  return client.getChatPreview(inviteLink);
}

/**
 * 获取相似频道推荐。
 */
export async function getSimilarChannels(
  client: TelegramClient,
  chatId: string | number,
): Promise<Chat[]> {
  await globalLimiter.acquire();
  const result = await client.getSimilarChannels(chatId);
  return [...result];
}

// ── Bot 命令发现 ──

/**
 * 获取指定 bot 的命令列表。
 * 通过 users.getFullUser 取 botInfo.commands（适用于任意 bot，不限于自有 bot）。
 */
export async function getBotCommands(
  client: TelegramClient,
  botId: string | number,
): Promise<Array<{ command: string; description: string }>> {
  await globalLimiter.acquire();
  const peer = await client.resolvePeer(botId);
  if (peer._ !== "inputPeerUser") throw new Error(`${botId} is not a user`);
  const inputUser: tl.TypeInputUser = {
    _: "inputUser",
    userId: peer.userId,
    accessHash: peer.accessHash,
  };
  const res = await client.call({ _: "users.getFullUser", id: inputUser });
  const botInfo = res.fullUser.botInfo;
  if (!botInfo?.commands) return [];
  return botInfo.commands.map((c: tl.RawBotCommand) => ({
    command: c.command,
    description: c.description,
  }));
}

// ── 账户管理 ──

/**
 * 修改 Alice 的个人资料（名字、姓氏、签名/简介）。
 * 传 undefined 的字段不修改，传空字符串则清空。
 */
export async function updateProfile(
  client: TelegramClient,
  opts: { firstName?: string; lastName?: string; about?: string },
): Promise<void> {
  await globalLimiter.acquire();
  await client.call({
    _: "account.updateProfile",
    ...(opts.firstName !== undefined && { firstName: opts.firstName }),
    ...(opts.lastName !== undefined && { lastName: opts.lastName }),
    ...(opts.about !== undefined && { about: opts.about }),
  });
}

/**
 * 读取收藏夹（Saved Messages）的最近消息。
 */
export async function readSavedMessages(client: TelegramClient, limit = 10): Promise<Message[]> {
  await globalLimiter.acquire();
  return client.getHistory("me", { limit });
}

/**
 * 创建群组/频道的邀请链接。
 */
export async function createInviteLink(
  client: TelegramClient,
  chatId: number,
): Promise<{ link: string }> {
  await globalLimiter.acquire();
  const invite = await client.createInviteLink(chatId);
  return { link: invite.link };
}

// ── 语音消息 ──

/**
 * ADR-88: 发送语音消息（OGG/Opus Buffer）。
 * @param audioBuffer OGG/Opus 格式的音频 Buffer
 */
export async function sendVoice(
  client: TelegramClient,
  chatId: string | number,
  audioBuffer: Buffer,
  options: { replyToMsgId?: number; duration?: number } = {},
): Promise<number | undefined> {
  await globalLimiter.acquire();
  let sent: Message | undefined;
  try {
    sent = await client.sendMedia(
      chatId,
      InputMedia.voice(audioBuffer, {
        duration: options.duration,
        // Telegram 要求 OGG/Opus 才显示波形条（voice message 样式）
        fileMime: "audio/ogg",
        fileName: "voice.ogg",
      }),
      { replyTo: options.replyToMsgId },
    );
  } catch (err) {
    rethrowTelegramActionFailure(err, "send_voice", { chatId: String(chatId) });
  }
  return sent?.id;
}

// ── 社交工具 ──

/**
 * 翻译消息文本。
 * @param toLang 目标语言（两位 ISO 639-1 语言代码，如 "en", "zh"）
 */
export async function translateMessage(
  client: TelegramClient,
  chatId: string | number,
  msgId: number,
  toLang: string,
): Promise<{ text: string }> {
  await globalLimiter.acquire();
  const res = await client.translateMessage({ chatId, message: msgId, toLanguage: toLang });
  return { text: res.text };
}

/**
 * 获取与指定用户的共同群组。
 */
export async function getCommonChats(
  client: TelegramClient,
  userId: string | number,
): Promise<Chat[]> {
  await globalLimiter.acquire();
  return client.getCommonChats(userId);
}

/**
 * 取消固定消息。
 */
export async function unpinMessage(
  client: TelegramClient,
  chatId: string | number,
  msgId: number,
): Promise<void> {
  await globalLimiter.acquire();
  await client.unpinMessage({ chatId, message: msgId });
}

// ── ADR-117 D7: Exa Browse ────────────────────────────────────────────────

/**
 * ADR-117 D7: Exa 搜索 API 封装。
 * @see https://docs.exa.ai/reference/search
 */
export async function exaFetch(
  query: string,
  apiKey: string,
): Promise<Array<{ title: string; url: string; text: string }>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        type: "auto",
        numResults: 3,
        contents: { text: { maxCharacters: 3000 } },
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`Exa API error: ${resp.status} ${resp.statusText}`);
    }
    const data = (await resp.json()) as {
      results: Array<{ title: string; url: string; text: string }>;
    };
    return (data.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      text: r.text ?? "",
    }));
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Exa URL 内容提取 API 封装。
 * 给定 URL 列表，返回页面标题 + 正文原文。
 * @see https://docs.exa.ai/reference/contents
 */
export async function exaExtract(
  urls: string[],
  apiKey: string,
): Promise<Array<{ title: string; url: string; text: string }>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const resp = await fetch("https://api.exa.ai/contents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        urls,
        text: { maxCharacters: 6000 },
        livecrawl: "fallback",
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`Exa Contents API error: ${resp.status} ${resp.statusText}`);
    }
    const data = (await resp.json()) as {
      results: Array<{ title: string; url: string; text: string }>;
    };
    return (data.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      text: r.text ?? "",
    }));
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Sub-ReAct：LLM 定向摘要子调用。
 * 将 URL 原文压缩为聚焦摘要，防止上下文爆炸。
 *
 * @param content  Exa 提取的原文
 * @param url      来源 URL
 * @param focus    可选的定向关注点（Alice 为什么要读这个页面）
 * @returns 压缩后的摘要文本（~500 字以内）
 */
export async function summarizeWebContent(
  content: string,
  url: string,
  focus?: string,
): Promise<string> {
  return llmSummarize({
    systemPrompt: [
      "You are a reading assistant. Summarize the web page content concisely.",
      "Rules:",
      "- Write in the SAME language as the page content (if Chinese, reply in Chinese; if English, reply in English).",
      "- Keep your summary under 500 characters.",
      "- Focus on facts, key findings, and concrete details — not meta-commentary.",
      "- If a focus question is provided, prioritize answering that question.",
      "- Do NOT start with 'This article...' or 'This page...' — just state the information.",
    ].join("\n"),
    userPrompt: [
      focus ? `Focus: ${focus}` : "",
      `URL: ${url}`,
      "",
      "--- Page Content ---",
      content.slice(0, 5000),
    ]
      .filter(Boolean)
      .join("\n"),
    fallback: content.slice(0, 800),
    caller: "summarizeWebContent",
  });
}

/**
 * Sub-ReAct：根据搜索结果回答问题。
 * google 动作的合成步——将多条搜索片段压缩为一个直接回答。
 *
 * @param question  用户问题
 * @param sources   搜索结果（title + url + text）
 * @returns 合成答案文本（~500 字以内）
 */
export async function synthesizeAnswer(
  question: string,
  sources: Array<{ title: string; url: string; text: string }>,
): Promise<string> {
  const sourcesText = sources
    .map((s, i) => `[${i + 1}] ${s.title}\n${s.url}\n${s.text}`)
    .join("\n\n");
  return llmSummarize({
    systemPrompt: [
      "You are a research assistant. Answer the question based ONLY on the provided sources.",
      "Rules:",
      "- Write in the SAME language as the question.",
      "- Keep your answer under 500 characters.",
      "- State facts directly — no meta-commentary like 'Based on the sources...'.",
      "- If sources conflict, note the disagreement briefly.",
      "- If sources don't contain the answer, say so honestly.",
    ].join("\n"),
    userPrompt: `Question: ${question}\n\n--- Sources ---\n${sourcesText}`,
    fallback: sources[0]?.text.slice(0, 800) ?? "",
    caller: "synthesizeAnswer",
    maxOutputTokens: 800,
  });
}

/** 内部：通用 LLM 摘要调用。 */
async function llmSummarize(opts: {
  systemPrompt: string;
  userPrompt: string;
  fallback: string;
  caller: string;
  maxOutputTokens?: number;
}): Promise<string> {
  const { generateText } = await import("ai");
  const { selectProviderForFirstPass } = await import("../llm/client.js");

  const { provider, model } = selectProviderForFirstPass();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const { text } = await generateText({
      model: provider(model),
      system: opts.systemPrompt,
      prompt: opts.userPrompt,
      maxOutputTokens: opts.maxOutputTokens ?? 400,
      temperature: 0.3,
      abortSignal: controller.signal,
    });
    return text.trim();
  } catch (e) {
    log.warn(`${opts.caller} failed, returning fallback`, {
      error: e instanceof Error ? e.message : String(e),
    });
    return opts.fallback;
  } finally {
    clearTimeout(timeout);
  }
}

// ── ADR-114 D2: Mention 扩散 ─────────────────────────────────────────────

/**
 * 获取未读 @mention 消息的 ID 列表。
 * 使用 Raw TL messages.getUnreadMentions。必须在 markRead({ clearMentions }) 之前调用。
 *
 * 返回 message ID 数组（调用方用 getMessages 或 getMessageCluster 获取完整消息）。
 * @see docs/adr/114-context-assembly-rehabilitation.md — D2
 */
export async function getUnreadMentionIds(
  client: TelegramClient,
  chatId: string | number,
  limit = 20,
): Promise<number[]> {
  await globalLimiter.acquire();
  try {
    const peer = await client.resolvePeer(chatId);
    const res = await client.call({
      _: "messages.getUnreadMentions",
      peer,
      offsetId: 0,
      addOffset: 0,
      limit,
      maxId: 0,
      minId: 0,
    });
    // tl.messages.TypeMessages 的 messagesNotModified 变体没有 messages 字段
    if (res._ === "messages.messagesNotModified") return [];
    // 所有其他变体（messages/messagesSlice/channelMessages）都有 messages: TypeMessage[]
    // TypeMessage 的所有变体（message/messageEmpty/messageService）都有 id: number
    return res.messages.map((m) => m.id).filter((id) => id > 0);
  } catch (e) {
    log.warn("Failed to get unread mentions", e);
    return [];
  }
}
