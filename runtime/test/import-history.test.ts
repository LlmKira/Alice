import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { closeDb, initDb, isDbInitialized } from "../src/db/connection.js";
import { collectHistory, importHistory } from "../src/import-history.js";
import { forEachEvent } from "../src/journal.js";

const dirs: string[] = [];
afterEach(() => {
  if (isDbInitialized()) closeDb();
  for (const d of dirs.splice(0)) rmSync(d, { force: true, recursive: true });
});

/** 旧库的 message_log：(chat, msg_id, text, outgoing, at 秒)。 */
function oldDb(rows: Array<[string, number, string, number, number]>): string {
  const dir = mkdtempSync(join(tmpdir(), "alice-import-"));
  dirs.push(dir);
  const path = join(dir, "old.db");
  const db = new Database(path);
  db.exec(`create table message_log (id integer primary key, chat_id text, msg_id integer,
    reply_to_msg_id integer, sender_id text, sender_name text, text text, media_type text,
    is_outgoing integer, is_directed integer, created_at integer)`);
  const insert = db.prepare(
    "insert into message_log (chat_id, msg_id, sender_id, sender_name, text, is_outgoing, is_directed, created_at) values (?, ?, 'u1', '池塘', ?, ?, 1, ?)",
  );
  for (const [chat, id, text, out, at] of rows) insert.run(chat, id, text, out, at);
  db.close();
  return path;
}

describe("history import", () => {
  it("merges backups in time order, keeping each message once", () => {
    const a = oldDb([
      ["channel:5", 1, "在吗", 0, 100],
      ["channel:5", 2, "在", 1, 101],
    ]);
    const b = oldDb([
      ["channel:5", 2, "在", 1, 101],
      ["channel:5", 3, "晚安", 0, 50],
    ]);
    const { events } = collectHistory([a, b]);
    expect(events.map((e) => [e.type, e.at])).toEqual([
      ["message.received", 50_000],
      ["message.received", 100_000],
      ["message.sent", 101_000],
    ]);
  });

  it("writes only into an empty journal, never twice", () => {
    const { events } = collectHistory([oldDb([["channel:5", 1, "在吗", 0, 100]])]);
    initDb(":memory:");
    expect(importHistory(events, false)).toBe(0);
    expect(forEachEvent(() => {}).read).toBe(0);
    expect(importHistory(events, true)).toBe(1);
    expect(importHistory(events, true)).toBeNull();
  });
});
