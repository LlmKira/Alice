import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { searchChatArchive, syncChatFts } from "../src/memory-fts.js";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE journal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      type TEXT NOT NULL,
      scope TEXT NOT NULL,
      payload TEXT NOT NULL,
      ts INTEGER
    );
  `);
  return db;
}

function addMsg(
  db: Database.Database,
  opts: {
    type?: "message.received" | "message.sent";
    scope: string;
    chatType: "private" | "group";
    at: number;
    senderName?: string;
    text: string;
  },
): void {
  const type = opts.type ?? "message.received";
  const payload =
    type === "message.sent"
      ? { type, at: opts.at, scope: opts.scope, messageId: "m", kind: "text", text: opts.text }
      : {
          type,
          at: opts.at,
          scope: opts.scope,
          chatType: opts.chatType,
          messageId: "m",
          senderId: "u1",
          senderName: opts.senderName ?? "路人",
          text: opts.text,
          contentType: "text",
        };
  db.prepare("INSERT INTO journal_events (type, scope, payload, ts) VALUES (?, ?, ?, ?)").run(
    type,
    opts.scope,
    JSON.stringify(payload),
    opts.at,
  );
}

describe("SQLite FTS5 chat archive recall", () => {
  it("indexes journal messages incrementally and finds Chinese, English, and Russian quotes", () => {
    const db = makeDb();
    addMsg(db, {
      scope: "telegram:-1001",
      chatType: "group",
      at: 1_000,
      senderName: "白茶",
      text: "昨天通宵打戴森球计划把传送带铺成意大利面了",
    });
    addMsg(db, {
      type: "message.sent",
      scope: "telegram:-1001",
      chatType: "group",
      at: 2_000,
      text: "戴森球理传送带真的上头",
    });
    addMsg(db, {
      scope: "telegram:42",
      chatType: "private",
      at: 3_000,
      senderName: "Влад",
      text: "А тема из MGS2 реально легендарная",
    });

    expect(syncChatFts(db)).toBe(3);
    expect(syncChatFts(db)).toBe(0);

    const zhHits = searchChatArchive(db, {
      scope: "telegram:-1001",
      query: "戴森球",
      subject: null,
    });
    expect(zhHits.map((h) => h.who)).toEqual(["Alice", "白茶"]);

    const shortHits = searchChatArchive(db, {
      scope: "telegram:-1001",
      query: "通宵",
      subject: null,
    });
    expect(shortHits).toHaveLength(1);
    expect(shortHits[0]?.who).toBe("白茶");

    const ruHits = searchChatArchive(db, {
      scope: "telegram:42",
      query: "MGS2",
      subject: null,
    });
    expect(ruHits).toHaveLength(1);
    expect(ruHits[0]?.who).toBe("Влад");
  });

  it("enforces audience privacy: never leaks another private chat into a group or different DM", () => {
    const db = makeDb();
    addMsg(db, {
      scope: "telegram:100",
      chatType: "private",
      at: 1_000,
      senderName: "明识",
      text: "偷偷告诉你一个秘密：我下周准备辞职去杭州",
    });
    addMsg(db, {
      scope: "telegram:-200",
      chatType: "group",
      at: 2_000,
      senderName: "木瓜",
      text: "杭州最近降温了记得穿厚点",
    });

    // 在群里搜“辞职”，绝不能搜出明识私聊里的话
    expect(searchChatArchive(db, { scope: "telegram:-200", query: "辞职", subject: null })).toEqual(
      [],
    );
    // 在另一个私聊里搜“杭州”，只能看到公开群里的，绝不能看到明识私聊里的
    const dmHits = searchChatArchive(db, {
      scope: "telegram:999",
      query: "杭州",
      subject: null,
    });
    expect(dmHits).toHaveLength(1);
    expect(dmHits[0]?.scope).toBe("telegram:-200");
    // 在明识自己的私聊里可以搜到
    const ownDmHits = searchChatArchive(db, {
      scope: "telegram:100",
      query: "辞职",
      subject: null,
    });
    expect(ownDmHits).toHaveLength(1);
    expect(ownDmHits[0]?.who).toBe("明识");
  });

  it("isolates public group archive recall by platform prefix (no cross-app log bleed)", () => {
    const db = makeDb();
    addMsg(db, {
      scope: "telegram:-1001",
      chatType: "group",
      at: 1_000,
      senderName: "白茶",
      text: "今晚去听星际穿越音乐会",
    });
    addMsg(db, {
      scope: "qq:group:2001",
      chatType: "group",
      at: 2_000,
      senderName: "青柚",
      text: "星际穿越原声带太神了",
    });

    const tgHits = searchChatArchive(db, {
      scope: "telegram:-9999",
      query: "星际穿越",
      subject: null,
    });
    expect(tgHits.map((h) => h.scope)).toEqual(["telegram:-1001"]);

    const qqHits = searchChatArchive(db, {
      scope: "qq:group:9999",
      query: "星际穿越",
      subject: null,
    });
    expect(qqHits.map((h) => h.scope)).toEqual(["qq:group:2001"]);
  });
});
