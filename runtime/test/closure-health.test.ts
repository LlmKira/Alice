import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeClosureHealth } from "../src/diagnostics/closure-health.js";

let sqlite: InstanceType<typeof Database>;
let db: ReturnType<typeof drizzle>;

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite);

  sqlite.exec(`
    CREATE TABLE action_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tick INTEGER NOT NULL,
      action_type TEXT NOT NULL,
      observation_gap INTEGER,
      closure_depth INTEGER,
      auto_writeback TEXT
    );
    CREATE TABLE deferred_outcome_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tick INTEGER NOT NULL
    );
  `);
});

afterEach(() => {
  sqlite.close();
});

function insertMessage(tick: number, observationGap: number, autoWriteback: string | null) {
  sqlite
    .prepare(
      `INSERT INTO action_log (tick, action_type, observation_gap, closure_depth, auto_writeback)
       VALUES (?, 'message', ?, 1, ?)`,
    )
    .run(tick, observationGap, autoWriteback);
}

describe("computeClosureHealth", () => {
  it("把 auto_writeback.feel 计入 feel 覆盖", () => {
    insertMessage(10, 1, `{"feel":"positive"}`);
    insertMessage(11, 1, `{"feel":"neutral"}`);

    const health = computeClosureHealth(db as Parameters<typeof computeClosureHealth>[0], 100);

    expect(health.totalMessages).toBe(2);
    expect(health.feelCoverage).toBe(1);
    expect(health.autoWritebackRatio).toBe(1);
    expect(health.overallHealth).toBe("healthy");
  });

  it("没有显式 feel 或 auto-writeback 时仍报告缺口", () => {
    insertMessage(10, 1, null);

    const health = computeClosureHealth(db as Parameters<typeof computeClosureHealth>[0], 100);

    expect(health.feelCoverage).toBe(0);
    expect(health.overallHealth).toBe("broken");
  });
});
