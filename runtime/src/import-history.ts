/**
 * 历史导入（PLAN"历史导入"，上线切换时用）：把旧库 message_log 里的聊天记录按时间顺序写进新 Journal，
 * 让世界图里的关系、线程、亲疏一开始就有历史，而不是从零开始。
 *
 * 用法：tsx src/import-history.ts <目标 alice.db> <来源库> [<来源库> ...] [--apply]
 *   不带 --apply 只演练：报告每个来源的条数、去重后条数和时间范围，不写入。
 *   --apply 只在目标 Journal 里还没有新格式事件时写入（不重复导入）；8 月运行时的旧格式行不动。
 * 对生产库执行属于上线步骤；先在副本上运行并用 start:check 核对 fold 结果。
 */
import Database from "better-sqlite3";
import { initDb } from "./db/connection.js";
import { appendEvent, forEachEvent, type JournaledEvent } from "./journal.js";
import { toEvent } from "./sim/import-message-log.js";

interface Row {
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

function readSource(path: string): JournaledEvent[] {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `select chat_id, msg_id, reply_to_msg_id, sender_id, sender_name, text, media_type,
                is_outgoing, is_directed, created_at
           from message_log order by created_at, id`,
      )
      .all() as Row[];
    return rows.map((row, i) => toEvent(row, i) as JournaledEvent);
  } finally {
    db.close();
  }
}

/** 同一条消息在几份备份里都有：按（会话, 消息 id）去重；没有 id 的按（会话, 时刻, 内容）。 */
function keyOf(e: JournaledEvent): string {
  if (e.type !== "message.received" && e.type !== "message.sent") return "";
  return e.messageId.startsWith("log:")
    ? `${e.scope}|${e.at}|${e.type}|${e.text ?? ""}`
    : `${e.scope}|${e.type}|${e.messageId}`;
}

/** 读出所有来源、去重、按时间排序。 */
export function collectHistory(sources: readonly string[]): {
  events: JournaledEvent[];
  perSource: Array<{ source: string; rows: number; kept: number }>;
} {
  const seen = new Set<string>();
  const events: JournaledEvent[] = [];
  const perSource = sources.map((source) => {
    const read = readSource(source);
    let kept = 0;
    for (const e of read) {
      const key = keyOf(e);
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(e);
      kept++;
    }
    return { source, rows: read.length, kept };
  });
  events.sort((a, b) => a.at - b.at);
  return { events, perSource };
}

/** 目标 Journal 里还没有新格式事件时才写入；返回写了多少条，拒绝时返回 null。 */
export function importHistory(events: readonly JournaledEvent[], apply: boolean): number | null {
  if (forEachEvent(() => {}).read > 0) return null;
  if (!apply) return 0;
  for (const e of events) appendEvent(e);
  return events.length;
}

function main(): void {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const [target, ...sources] = args.filter((a) => a !== "--apply");
  if (!target || sources.length === 0) {
    console.error("usage: import-history.ts <target alice.db> <source.db> [...] [--apply]");
    process.exit(1);
  }
  const { events, perSource } = collectHistory(sources);
  for (const s of perSource) console.log(`${s.source}: ${s.rows} rows, ${s.kept} new after dedupe`);
  const first = events[0]?.at ?? 0;
  const last = events.at(-1)?.at ?? 0;
  console.log(
    `total ${events.length} events, ${first > 0 ? new Date(first).toISOString() : "-"} .. ${last > 0 ? new Date(last).toISOString() : "-"}`,
  );
  initDb(target);
  const written = importHistory(events, apply);
  if (written === null) {
    console.error("target journal already has events; refusing to import twice");
    process.exit(2);
  }
  console.log(
    apply ? `appended ${written} events to ${target}` : "dry run (no --apply): nothing written",
  );
}

if (process.argv[1]?.endsWith("import-history.ts")) main();
