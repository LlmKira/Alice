import { writeCanonicalEventOnce } from "../db/canonical-event-store.js";
import { getDb } from "../db/connection.js";
import { messageLog } from "../db/schema.js";
import type { CanonicalMessageEvent } from "../telegram/canonical-events.js";
import type { EventBuffer } from "../telegram/events.js";
import type { GraphPerturbation } from "../telegram/mapper.js";
import { createLogger } from "../utils/logger.js";
import {
  mapOneBotMessageEventToCanonical,
  type OneBotMessageMappingOptions,
} from "./onebot-events.js";

const log = createLogger("onebot-ingress");

export interface OneBotIngressResult {
  canonical: CanonicalMessageEvent;
  perturbation: GraphPerturbation;
  sourceId: string;
  stableMessageId: string;
  inserted: boolean;
}

/**
 * OneBot 入站接线层：payload 先变成 canonical fact，再写 canonical_events，
 * 最后投影为当前 EventBuffer 使用的 GraphPerturbation。
 *
 * @see docs/adr/264-qq-platform-support/README.md
 */
export function ingestOneBotMessageEvent(
  input: unknown,
  options: OneBotMessageMappingOptions & { buffer?: EventBuffer },
): OneBotIngressResult {
  const mapped = mapOneBotMessageEventToCanonical(input, options);
  const write = writeCanonicalEventOnce(mapped.event, {
    source: "onebot",
    sourceId: mapped.sourceId,
  });
  const perturbation: GraphPerturbation = {
    type: "new_message",
    tick: mapped.event.tick,
    nowMs: mapped.event.occurredAtMs ?? undefined,
    channelId: mapped.event.channelId ?? undefined,
    contactId: mapped.event.contactId ?? undefined,
    isDirected: mapped.event.directed,
    isContinuation: mapped.event.continuation,
    novelty: mapped.event.novelty ?? undefined,
    displayName: mapped.event.displayName ?? undefined,
    chatDisplayName: mapped.event.chatDisplayName ?? undefined,
    chatType: mapped.event.chatType ?? undefined,
    messageText: mapped.event.text ?? undefined,
    senderName: mapped.event.senderName ?? undefined,
    contentType: mapped.event.contentType,
    senderIsBot: mapped.event.senderIsBot,
    forwardFromChannelId: mapped.event.forwardFromChannelId ?? undefined,
    forwardFromChannelName: mapped.event.forwardFromChannelName ?? undefined,
    tmeLinks: mapped.event.tmeLinks.length > 0 ? mapped.event.tmeLinks : undefined,
  };
  options.buffer?.push(perturbation);

  if (mapped.event.text || mapped.event.contentType !== "text") {
    try {
      getDb()
        .insert(messageLog)
        .values({
          tick: mapped.event.tick,
          platform: "qq",
          chatId: mapped.event.channelId ?? `channel:qq:${mapped.chatNativeId}`,
          msgId: undefined,
          nativeChatId: mapped.chatNativeId,
          nativeMsgId: mapped.messageNativeId,
          stableMessageId: mapped.stableMessageId,
          senderId: mapped.event.contactId ?? undefined,
          senderName: mapped.event.senderName ?? mapped.event.displayName ?? undefined,
          text: mapped.event.text ?? null,
          isOutgoing: false,
          isDirected: mapped.event.directed,
          mediaType: mapped.event.contentType === "text" ? undefined : mapped.event.contentType,
          createdAt: mapped.event.occurredAtMs ? new Date(mapped.event.occurredAtMs) : undefined,
        })
        .run();
    } catch (error) {
      log.warn("Failed to write QQ message_log", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    canonical: mapped.event,
    perturbation,
    sourceId: mapped.sourceId,
    stableMessageId: mapped.stableMessageId,
    inserted: write.inserted,
  };
}
