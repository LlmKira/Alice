/**
 * ADR-261: message_log -> rhythm events extraction.
 *
 * 这里是事实源卫生层：chat_id 生成 channel event；sender_id 只有正数用户 ID
 * 才生成 contact event。负数 / -100... 是 Telegram 群组或频道 ID，不能当联系人。
 *
 * @see docs/adr/261-rhythm-profile-projection.md
 */

import { telegramContactId } from "../graph/constants.js";
import type { RhythmEvent } from "./rhythm-spectrum.js";

export interface RhythmMessageRow {
  chat_id: string;
  sender_id: string | null;
  is_outgoing: number;
  created_at: number | string | Date;
}

export interface RhythmSourceStats {
  rowsRead: number;
  rowsSkippedInvalidTime: number;
  channelEvents: number;
  contactEvents: number;
  skippedOutgoingSenders: number;
  skippedInvalidSenders: number;
  skippedChannelLikeSenders: number;
}

export function collectRhythmEventsFromMessages(rows: readonly RhythmMessageRow[]): {
  byEntity: Map<string, RhythmEvent[]>;
  stats: RhythmSourceStats;
} {
  const byEntity = new Map<string, RhythmEvent[]>();
  const stats: RhythmSourceStats = {
    rowsRead: rows.length,
    rowsSkippedInvalidTime: 0,
    channelEvents: 0,
    contactEvents: 0,
    skippedOutgoingSenders: 0,
    skippedInvalidSenders: 0,
    skippedChannelLikeSenders: 0,
  };

  for (const row of rows) {
    const occurredAtMs = toMs(row.created_at);
    if (!Number.isFinite(occurredAtMs)) {
      stats.rowsSkippedInvalidTime++;
      continue;
    }

    addEvent(byEntity, {
      entityId: row.chat_id,
      entityType: "channel",
      occurredAtMs,
    });
    stats.channelEvents++;

    if (row.is_outgoing === 1 || !row.sender_id) {
      if (row.sender_id) stats.skippedOutgoingSenders++;
      continue;
    }

    const contactId = normalizeContactSenderId(row.sender_id);
    if (!contactId) {
      if (isChannelLikeSender(row.sender_id)) stats.skippedChannelLikeSenders++;
      else stats.skippedInvalidSenders++;
      continue;
    }

    addEvent(byEntity, {
      entityId: contactId,
      entityType: "contact",
      occurredAtMs,
    });
    stats.contactEvents++;
  }

  return { byEntity, stats };
}

export function normalizeContactSenderId(senderId: string): string | null {
  const raw = stripEntityPrefix(senderId.trim());
  if (raw.length === 0) return null;
  if (raw.startsWith("-")) return null;
  if (!/^\d+$/.test(raw)) return null;
  return telegramContactId(raw);
}

function isChannelLikeSender(senderId: string): boolean {
  const raw = stripEntityPrefix(senderId.trim());
  return raw.startsWith("-");
}

function stripEntityPrefix(value: string): string {
  if (value.startsWith("contact:telegram:")) return value.slice("contact:telegram:".length);
  if (value.startsWith("channel:telegram:")) return value.slice("channel:telegram:".length);
  if (value.startsWith("contact:")) return value.slice("contact:".length);
  if (value.startsWith("channel:")) return value.slice("channel:".length);
  return value;
}

function addEvent(map: Map<string, RhythmEvent[]>, event: RhythmEvent): void {
  const current = map.get(event.entityId) ?? [];
  current.push(event);
  map.set(event.entityId, current);
}

function toMs(value: number | string | Date): number {
  if (value instanceof Date) return value.getTime();
  const n = Number(value);
  if (!Number.isFinite(n)) return Number.NaN;
  return n < 10_000_000_000 ? n * 1000 : n;
}
