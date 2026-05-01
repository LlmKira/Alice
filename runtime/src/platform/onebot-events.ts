import { z } from "zod";
import type { CanonicalContentType, CanonicalMessageEvent } from "../telegram/canonical-events.js";
import { perturbationFromCanonical } from "../telegram/canonical-events.js";
import type { GraphPerturbation } from "../telegram/mapper.js";
import { stableTransportMessageId } from "./transport.js";

const ONEBOT_OUTGOING_CACHE_LIMIT = 2000;
const oneBotOutgoingMessageCache = new Map<string, true>();

const oneBotIdSchema = z.union([z.string(), z.number()]).transform((value) => String(value));
const oneBotSenderSchema = z.record(z.unknown()).default({});
const oneBotSegmentSchema = z
  .object({
    type: z.string(),
    data: z.record(z.unknown()).default({}),
  })
  .passthrough();

const oneBotMessagePayloadSchema = z.union([z.array(oneBotSegmentSchema), z.string()]);
const oneBotMessageEventBaseSchema = z
  .object({
    post_type: z.literal("message"),
    message_id: oneBotIdSchema,
    user_id: oneBotIdSchema,
    self_id: oneBotIdSchema.optional(),
    time: z.number().optional(),
    sender: oneBotSenderSchema,
    message: oneBotMessagePayloadSchema,
    raw_message: z.string().optional(),
  })
  .passthrough();

const oneBotGroupMessageEventSchema = oneBotMessageEventBaseSchema.extend({
  message_type: z.literal("group"),
  group_id: oneBotIdSchema,
});

const oneBotPrivateMessageEventSchema = oneBotMessageEventBaseSchema.extend({
  message_type: z.literal("private"),
});

export const OneBotMessageEventSchema = z.discriminatedUnion("message_type", [
  oneBotGroupMessageEventSchema,
  oneBotPrivateMessageEventSchema,
]);

export type OneBotMessageSegment = z.infer<typeof oneBotSegmentSchema>;
export type OneBotMessageEvent = z.infer<typeof OneBotMessageEventSchema>;

export interface OneBotMessageMappingOptions {
  tick: number;
  selfId?: string | number;
  selfDisplayName?: string;
  isOutgoingMessage?: (chatNativeId: string, messageNativeId: string) => boolean;
}

export interface OneBotMappedMessage {
  event: CanonicalMessageEvent;
  sourceId: string;
  stableMessageId: string;
  chatNativeId: string;
  messageNativeId: string;
}

function stableQqChannelId(nativeId: string): string {
  return `channel:qq:${nativeId}`;
}

function stableQqContactId(nativeId: string): string {
  return `contact:qq:${nativeId}`;
}

function oneBotChatNativeId(event: OneBotMessageEvent): string {
  return event.message_type === "group" ? event.group_id : event.user_id;
}

function dataString(data: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
    if (typeof value === "number") return String(value);
  }
  return null;
}

function senderDisplayName(sender: Record<string, unknown>, fallback: string): string {
  return dataString(sender, ["card", "nickname", "nick", "name"]) ?? fallback;
}

function segmentText(
  segment: OneBotMessageSegment,
  options: Pick<OneBotMessageMappingOptions, "selfId" | "selfDisplayName">,
): string {
  const { type, data } = segment;
  if (type === "text") return dataString(data, ["text"]) ?? "";

  if (type === "at") {
    const qq = dataString(data, ["qq"]);
    if (qq === "all") return "@全体成员";
    const name = dataString(data, ["name", "card", "nickname"]);
    if (options.selfId != null && qq === String(options.selfId)) {
      return `@${options.selfDisplayName ?? "Alice"}`;
    }
    return name ? `@${name}` : "@某人";
  }

  if (type === "image") return "[图片]";
  if (type === "record") return "[语音]";
  if (type === "video") return "[视频]";
  if (type === "file") {
    const name = dataString(data, ["name", "file_name"]);
    return name ? `[文件:${name}]` : "[文件]";
  }
  if (type === "face") {
    const summary = dataString(data, ["summary", "text", "name"]);
    return summary ? `[表情:${summary}]` : "[表情]";
  }
  if (type === "markdown") return dataString(data, ["markdown", "content"]) ?? "";

  return "";
}

function messageSegments(event: OneBotMessageEvent): OneBotMessageSegment[] {
  return Array.isArray(event.message)
    ? event.message
    : [{ type: "text", data: { text: event.raw_message ?? event.message } }];
}

function messageText(
  event: OneBotMessageEvent,
  options: Pick<OneBotMessageMappingOptions, "selfId" | "selfDisplayName">,
): string | null {
  const text = messageSegments(event)
    .map((segment) => segmentText(segment, options))
    .join("")
    .trim()
    .slice(0, 4096);
  return text.length > 0 ? text : null;
}

function contentType(event: OneBotMessageEvent): CanonicalContentType {
  for (const segment of messageSegments(event)) {
    if (segment.type === "image") return "photo";
    if (segment.type === "record") return "voice";
    if (segment.type === "video") return "video";
    if (segment.type === "file") return "document";
    if (segment.type === "face") return "sticker";
  }
  return "text";
}

function hasAtSelf(event: OneBotMessageEvent, selfId: string | undefined): boolean {
  if (!selfId || event.message_type !== "group") return false;
  return messageSegments(event).some(
    (segment) => segment.type === "at" && dataString(segment.data, ["qq"]) === selfId,
  );
}

function replyToOutgoing(event: OneBotMessageEvent, options: OneBotMessageMappingOptions): boolean {
  const isOutgoing = options.isOutgoingMessage ?? isOneBotOutgoingMsg;
  const chatNativeId = oneBotChatNativeId(event);
  return messageSegments(event).some((segment) => {
    if (segment.type !== "reply") return false;
    const id = dataString(segment.data, ["id"]);
    return id != null && isOutgoing(chatNativeId, id);
  });
}

function eventTimeMs(event: OneBotMessageEvent): number | null {
  return typeof event.time === "number" && Number.isFinite(event.time) && event.time > 0
    ? Math.trunc(event.time * 1000)
    : null;
}

export function parseOneBotMessageEvent(input: unknown): OneBotMessageEvent {
  return OneBotMessageEventSchema.parse(input);
}

/**
 * OneBot v11 入站消息到 Alice canonical fact 的纯映射边界。
 *
 * QQ 内部稳定身份只使用 platform=qq；OneBot/NapCat 只是接入协议，不进入
 * channel/contact/message 的平台命名空间。
 *
 * @see docs/adr/264-qq-platform-support/README.md
 * @see docs/reference/LangBot/src/langbot/pkg/platform/sources/aiocqhttp.py
 * @see docs/reference/AstrBot/astrbot/core/platform/sources/aiocqhttp/aiocqhttp_platform_adapter.py
 */
export function mapOneBotMessageEventToCanonical(
  input: unknown,
  options: OneBotMessageMappingOptions,
): OneBotMappedMessage {
  const event = parseOneBotMessageEvent(input);
  const chatNativeId = oneBotChatNativeId(event);
  const selfId = options.selfId == null ? event.self_id : String(options.selfId);
  const senderName = senderDisplayName(event.sender, "QQ 用户");
  const directed =
    event.message_type === "private" || hasAtSelf(event, selfId) || replyToOutgoing(event, options);

  return {
    event: {
      kind: "message",
      tick: options.tick,
      occurredAtMs: eventTimeMs(event),
      channelId: stableQqChannelId(chatNativeId),
      contactId: stableQqContactId(event.user_id),
      directed,
      novelty: 0.5,
      continuation: false,
      text: messageText(event, { selfId, selfDisplayName: options.selfDisplayName }),
      senderName,
      displayName: senderName,
      chatDisplayName: event.message_type === "private" ? senderName : null,
      chatType: event.message_type,
      contentType: contentType(event),
      senderIsBot: event.sender.is_bot === true,
      forwardFromChannelId: null,
      forwardFromChannelName: null,
      tmeLinks: [],
    },
    sourceId: `message:${chatNativeId}:${event.message_id}`,
    stableMessageId: stableTransportMessageId("qq", chatNativeId, event.message_id),
    chatNativeId,
    messageNativeId: event.message_id,
  };
}

export function mapOneBotMessageEventToPerturbation(
  input: unknown,
  options: OneBotMessageMappingOptions,
): { event: GraphPerturbation; sourceId: string; stableMessageId: string } {
  const mapped = mapOneBotMessageEventToCanonical(input, options);
  return {
    event: perturbationFromCanonical(mapped.event),
    sourceId: mapped.sourceId,
    stableMessageId: mapped.stableMessageId,
  };
}

export function cacheOneBotOutgoingMsg(
  chatNativeId: string,
  messageNativeId: string | number,
): void {
  const key = `${chatNativeId}:${messageNativeId}`;
  if (oneBotOutgoingMessageCache.has(key)) return;
  oneBotOutgoingMessageCache.set(key, true);
  if (oneBotOutgoingMessageCache.size > ONEBOT_OUTGOING_CACHE_LIMIT) {
    const oldest = oneBotOutgoingMessageCache.keys().next().value;
    if (oldest != null) oneBotOutgoingMessageCache.delete(oldest);
  }
}

export function isOneBotOutgoingMsg(
  chatNativeId: string,
  messageNativeId: string | number,
): boolean {
  return oneBotOutgoingMessageCache.has(`${chatNativeId}:${messageNativeId}`);
}

export function clearOneBotOutgoingMsgCacheForTest(): void {
  oneBotOutgoingMessageCache.clear();
}
