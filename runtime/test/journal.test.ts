import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { closeDb, getSqlite, initDb, isDbInitialized } from "../src/db/connection.js";
import { appendEvent, forEachEvent, type JournaledEvent } from "../src/journal.js";
import type { AliceEvent } from "../src/mind/events.js";

const tempDirs: string[] = [];

afterEach(() => {
  if (isDbInitialized()) closeDb();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

const received: JournaledEvent = {
  type: "message.received",
  at: 1_771_000_000_000,
  scope: "telegram:1",
  chatType: "private",
  messageId: "10",
  senderId: "u1",
  senderName: "池塘",
  text: "在吗",
  contentType: "text",
  replyToMessageId: null,
  directed: true,
};

function readAll(): { events: AliceEvent[]; read: number; skipped: number } {
  const events: AliceEvent[] = [];
  const counts = forEachEvent((e) => events.push(e));
  return { events, ...counts };
}

describe("Journal", () => {
  it("keeps what a group search found, so a fold knows the same groups exist (A18)", () => {
    initDb(":memory:");
    const done: JournaledEvent = {
      type: "act.done",
      at: received.at,
      scope: "telegram:1",
      act: { kind: "chat-search", query: "胶片" },
      result: "想找的“胶片”……",
      found: [
        {
          scope: "telegram:-1001",
          kind: "channel",
          title: "胶片日常",
          about: null,
          members: 1200,
          recent: ["今天的卷"],
        },
      ],
    };
    appendEvent(done);
    expect(readAll().events).toEqual([done]);
  });

  it("reads events back in write order with their own timestamps", () => {
    initDb(":memory:");
    const decided: JournaledEvent = {
      type: "speech.decided",
      at: received.at + 1000,
      scope: "telegram:1",
      callId: "telegram:1#1",
      decision: {
        acts: [
          { kind: "send", text: "在的", replyTo: "10" },
          { kind: "react", messageId: "10", emoji: "👍" },
        ],
      },
    };
    const sent: JournaledEvent = {
      type: "message.sent",
      at: received.at + 2000,
      scope: "telegram:1",
      messageId: "11",
      text: "在的",
      kind: "text",
    };
    expect([appendEvent(received), appendEvent(decided), appendEvent(sent)]).toEqual([1, 2, 3]);
    expect(readAll()).toEqual({ events: [received, decided, sent], read: 3, skipped: 0 });
    expect(getSqlite().prepare("SELECT ts FROM journal_events WHERE id = 1").get()).toEqual({
      ts: received.at,
    });
  });

  it("skips rows the old runtime wrote under the same table", () => {
    initDb(":memory:");
    const insert = getSqlite().prepare(
      "INSERT INTO journal_events (type, scope, payload, ts) VALUES (?, ?, ?, ?)",
    );
    // 8 月的 message.received：同名类型，形状不同（没有 type、at）。
    insert.run("message.received", "telegram:1", JSON.stringify({ text: "旧", directed: true }), 1);
    insert.run("wake.requested", "telegram:1", "{}", 2);
    appendEvent(received);
    expect(readAll()).toEqual({ events: [received], read: 1, skipped: 1 });
  });

  it("reads failures written before they were typed as codes, keeping what she was told", () => {
    initDb(":memory:");
    const insert = getSqlite().prepare(
      "INSERT INTO journal_events (type, scope, payload, ts) VALUES (?, ?, ?, ?)",
    );
    const at = received.at;
    const errand = { kind: "delegate", task: "天气" };
    const send = { kind: "send", text: "嗯", replyTo: null };
    const rows: Array<[string, object]> = [
      ["act.failed", { act: errand, reason: "中途断了" }],
      ["act.failed", { act: errand, reason: "什么也没查到" }],
      ["act.failed", { act: send, reason: "join_requested" }],
      ["speech.failed", { callId: "c", reason: "502 bad gateway" }],
      ["speech.failed", { callId: "c", reason: "interrupted" }],
    ];
    for (const [type, body] of rows) {
      insert.run(
        type,
        "telegram:1",
        JSON.stringify({ type, at, scope: "telegram:1", ...body }),
        at,
      );
    }
    const { events, skipped } = readAll();
    expect(skipped).toBe(0);
    expect(events).toMatchObject([
      { reason: "interrupted" },
      { reason: "errand", said: "什么也没查到" },
      { reason: "join_requested" },
      { reason: "model", error: "502 bad gateway" },
      { reason: "interrupted" },
    ]);
  });

  it("a field added to an event later is kept on read, not a reason to drop the row as legacy", () => {
    initDb(":memory:");
    const newer = {
      ...received,
      messageId: "11",
      quotedText: "（以后加的字段）",
    } as JournaledEvent;
    appendEvent(newer);
    // 形状不对的同名行（类型对不上）仍然跳过。
    const insert = getSqlite().prepare(
      "INSERT INTO journal_events (type, scope, payload, ts) VALUES (?, ?, ?, ?)",
    );
    insert.run(
      "message.received",
      "telegram:1",
      JSON.stringify({ ...received, directed: "yes" }),
      received.at,
    );
    expect(readAll()).toEqual({ events: [newer], read: 1, skipped: 1 });
  });

  it("migrates a legacy table without the ts column and survives a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "alice-journal-"));
    tempDirs.push(dir);
    const path = join(dir, "legacy.db");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE journal_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        type TEXT NOT NULL,
        scope TEXT NOT NULL,
        payload TEXT NOT NULL
      );
    `);
    legacy.close();

    initDb(path);
    appendEvent(received);
    closeDb();
    initDb(path);
    expect(readAll().events).toEqual([received]);
  });

  it("rejects an event without a finite time", () => {
    initDb(":memory:");
    expect(() => appendEvent({ ...received, at: Number.NaN })).toThrow("finite");
  });

  it("keeps reactions and membership changes", () => {
    initDb(":memory:");
    const reaction: JournaledEvent = {
      type: "reaction.received",
      at: received.at + 1000,
      scope: "telegram:1",
      messageId: "11",
      senderId: null,
      emoji: "👍",
    };
    const kicked: JournaledEvent = {
      type: "membership.changed",
      at: received.at + 2000,
      scope: "telegram:-1",
      member: false,
      reason: "kicked",
    };
    appendEvent(reaction);
    appendEvent(kicked);
    expect(readAll().events).toEqual([reaction, kicked]);
  });
});
