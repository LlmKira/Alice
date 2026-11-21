/**
 * 把旧库的 message_log 转成回放用的事件流（JSONL），只用于离线基准，不写线上的库。
 *
 * 用法：tsx src/sim/import-message-log.ts <旧库路径> <输出.jsonl>
 */
import { writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import type { AliceEvent } from "../mind/events.js";

interface MessageLogRow {
  chat_id: string;
  msg_id: number | null;
  reply_to_msg_id: number | null;
  sender_id: string | null;
  sender_name: string | null;
  text: string | null;
  media_type: string | null;
  is_outgoing: number;
  is_directed: number;
  created_at: number;
}

/** 旧库会话 id 有 "channel:telegram:-100…" 和 "channel:-100…" 两种写法，统一成 "telegram:<id>"。 */
export function scopeOf(chatId: string): string {
  return `telegram:${chatId.replace(/^channel:(telegram:)?/, "")}`;
}

export function toEvent(row: MessageLogRow, index: number): AliceEvent {
  const scope = scopeOf(row.chat_id);
  const at = row.created_at * 1000;
  const messageId = row.msg_id == null ? `log:${index}` : String(row.msg_id);
  if (row.is_outgoing) {
    return {
      type: "message.sent",
      at,
      scope,
      messageId,
      text: row.text ?? "",
      kind: row.media_type === "sticker" ? "sticker" : "text",
    };
  }
  return {
    type: "message.received",
    at,
    scope,
    chatType: scope.startsWith("telegram:-") ? "group" : "private",
    messageId,
    senderId: row.sender_id ?? "unknown",
    senderName: row.sender_name ?? "某人",
    text: row.text,
    contentType: row.media_type ?? "text",
    replyToMessageId: row.reply_to_msg_id == null ? null : String(row.reply_to_msg_id),
    directed: row.is_directed === 1,
  };
}

function main(): void {
  const [dbPath, outPath] = process.argv.slice(2);
  if (!dbPath || !outPath) {
    console.error("usage: import-message-log.ts <db> <out.jsonl>");
    process.exit(1);
  }
  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .prepare(
      `select chat_id, msg_id, reply_to_msg_id, sender_id, sender_name, text, media_type,
              is_outgoing, is_directed, created_at
         from message_log order by created_at, id`,
    )
    .all() as MessageLogRow[];
  writeFileSync(outPath, `${rows.map((row, i) => JSON.stringify(toEvent(row, i))).join("\n")}\n`);
  console.log(`${rows.length} events -> ${outPath}`);
}

if (process.argv[1]?.endsWith("import-message-log.ts")) main();
