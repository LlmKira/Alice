/**
 * 异常警报器单元测试。
 *
 * 使用内存 SQLite 构造各种异常场景，验证 runAnomalyCheck 检测正确。
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAnomalyCheck } from "../src/db/anomaly.js";
import * as connection from "../src/db/connection.js";
import * as schema from "../src/db/schema.js";

// 临时内存数据库
let sqlite: InstanceType<typeof Database>;
let db: ReturnType<typeof drizzle>;

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });

  // 建表
  sqlite.exec(`
    CREATE TABLE tick_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tick INTEGER NOT NULL,
      p1 REAL NOT NULL, p2 REAL NOT NULL, p3 REAL NOT NULL,
      p4 REAL NOT NULL, p5 REAL NOT NULL, p6 REAL NOT NULL,
      api REAL NOT NULL,
      action TEXT, target TEXT,
      gate_verdict TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE action_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tick INTEGER NOT NULL,
      voice TEXT NOT NULL, target TEXT,
      action_type TEXT NOT NULL, chat_id TEXT,
      message_text TEXT, confidence REAL, reasoning TEXT,
      success INTEGER NOT NULL DEFAULT 0,
      observation_gap INTEGER,
      closure_depth INTEGER,
      ea_proxy REAL,
      engagement_subcycles INTEGER,
      engagement_duration_ms INTEGER,
      engagement_outcome TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      auto_writeback TEXT,
      tc_tool_call_count INTEGER,
      tc_budget_exhausted INTEGER,
      tc_afterward TEXT,
      tc_command_log TEXT,
      tc_host_continuation_trace TEXT
    );
    CREATE TABLE personality_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tick INTEGER NOT NULL,
      weights TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tick INTEGER NOT NULL,
      level TEXT NOT NULL,
      source TEXT NOT NULL,
      message TEXT NOT NULL,
      details TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  // mock getDb
  vi.spyOn(connection, "getDb").mockReturnValue(db as ReturnType<typeof connection.getDb>);
});

afterEach(() => {
  vi.restoreAllMocks();
  sqlite.close();
});

// -- 辅助函数 -----------------------------------------------------------------

function insertTickLog(
  tick: number,
  p: [number, number, number, number, number, number],
  api: number,
) {
  sqlite.exec(
    `INSERT INTO tick_log (tick, p1, p2, p3, p4, p5, p6, api)
     VALUES (${tick}, ${p[0]}, ${p[1]}, ${p[2]}, ${p[3]}, ${p[4]}, ${p[5]}, ${api})`,
  );
}

function insertActionWithCommandLog(tick: number, success: boolean, commandLog: string) {
  sqlite
    .prepare(
      `INSERT INTO action_log (tick, voice, action_type, success, tc_command_log)
       VALUES (?, 'sociability', 'observe', ?, ?)`,
    )
    .run(tick, success ? 1 : 0, commandLog);
}

/** ADR-124: voice_starvation 现在查询 tick_log.action（loudness winner）。 */
function insertTickLogWithVoice(tick: number, voice: string) {
  sqlite.exec(
    `INSERT INTO tick_log (tick, p1, p2, p3, p4, p5, p6, api, action)
     VALUES (${tick}, 0, 0, 0, 0, 0, 0, 1.0, '${voice}')`,
  );
}

function insertTickLogWithVoiceAndGate(tick: number, voice: string, gateVerdict: string) {
  sqlite
    .prepare(
      `INSERT INTO tick_log (tick, p1, p2, p3, p4, p5, p6, api, action, gate_verdict)
       VALUES (?, 0, 0, 0, 0, 0, 0, 1.0, ?, ?)`,
    )
    .run(tick, voice, gateVerdict);
}

function insertPersonality(tick: number, weights: number[]) {
  sqlite.exec(
    `INSERT INTO personality_snapshots (tick, weights) VALUES (${tick}, '${JSON.stringify(weights)}')`,
  );
}

// -- 测试 ---------------------------------------------------------------------

describe("runAnomalyCheck", () => {
  it("无数据时返回空", () => {
    const alerts = runAnomalyCheck(100);
    expect(alerts).toEqual([]);
  });

  describe("api_stagnant", () => {
    it("API 标准差 < 0.01 时触发", () => {
      // 20 个相同 API 值
      for (let i = 0; i < 20; i++) {
        insertTickLog(80 + i, [1, 1, 1, 1, 1, 1], 3.0);
      }
      const alerts = runAnomalyCheck(100);
      expect(alerts.some((a) => a.type === "api_stagnant")).toBe(true);
    });

    it("API 有正常波动时不触发", () => {
      for (let i = 0; i < 20; i++) {
        insertTickLog(80 + i, [1, 1, 1, 1, 1, 1], 2.0 + i * 0.1);
      }
      const alerts = runAnomalyCheck(100);
      expect(alerts.some((a) => a.type === "api_stagnant")).toBe(false);
    });
  });

  describe("api_overflow", () => {
    it("API > 50 时触发 error", () => {
      insertTickLog(100, [1, 1, 1, 1, 1, 1], 55.0);
      const alerts = runAnomalyCheck(100);
      const overflow = alerts.find((a) => a.type === "api_overflow");
      expect(overflow).toBeDefined();
      expect(overflow?.level).toBe("error");
    });

    it("API 正常时不触发", () => {
      insertTickLog(100, [1, 1, 1, 1, 1, 1], 3.5);
      const alerts = runAnomalyCheck(100);
      expect(alerts.some((a) => a.type === "api_overflow")).toBe(false);
    });
  });

  describe("pressure_dead", () => {
    it("P1 = 0 持续 100 tick 时触发", () => {
      for (let i = 0; i < 100; i++) {
        insertTickLog(i + 1, [0, 1, 1, 1, 1, 1], 2.0);
      }
      const alerts = runAnomalyCheck(100);
      expect(alerts.some((a) => a.type === "pressure_dead" && a.message.includes("P1"))).toBe(true);
    });

    it("不足 100 条时不触发", () => {
      for (let i = 0; i < 50; i++) {
        insertTickLog(i + 1, [0, 1, 1, 1, 1, 1], 2.0);
      }
      const alerts = runAnomalyCheck(50);
      expect(alerts.some((a) => a.type === "pressure_dead")).toBe(false);
    });
  });

  describe("pressure_extreme", () => {
    it("单维度 > 200 时触发", () => {
      insertTickLog(100, [250, 1, 1, 1, 1, 1], 3.0);
      const alerts = runAnomalyCheck(100);
      const extreme = alerts.find((a) => a.type === "pressure_extreme");
      expect(extreme).toBeDefined();
      expect(extreme?.message).toContain("P1");
    });
  });

  describe("action_failure_rate", () => {
    it("真实 Telegram 失败率 > 50% 时触发 error", () => {
      for (let i = 0; i < 20; i++) {
        const failed = i < 12;
        insertActionWithCommandLog(
          80 + i,
          !failed,
          failed
            ? "$ irc read\nerror\nError: Engine API returned 500 for POST /telegram/read"
            : "$ irc read\n✓ Marked as read",
        );
      }
      const alerts = runAnomalyCheck(100);
      const failure = alerts.find((a) => a.type === "action_failure_rate");
      expect(failure).toBeDefined();
      expect(failure?.level).toBe("error");
    });

    it("真实 Telegram 成功率正常时不触发", () => {
      for (let i = 0; i < 20; i++) {
        insertActionWithCommandLog(80 + i, true, "$ irc read\n✓ Marked as read");
      }
      const alerts = runAnomalyCheck(100);
      expect(alerts.some((a) => a.type === "action_failure_rate")).toBe(false);
    });

    it("host success=false 但已有 Telegram 成功标记时不误报", () => {
      for (let i = 0; i < 20; i++) {
        insertActionWithCommandLog(
          80 + i,
          false,
          '$ irc say --text "hi"\nerror\nError: Engine API timeout\n✓ Sent: "hi"',
        );
      }
      const alerts = runAnomalyCheck(100);
      expect(alerts.some((a) => a.type === "action_failure_rate")).toBe(false);
    });
  });

  describe("personality_drift", () => {
    it("欧氏距离 > 0.3 时触发", () => {
      insertPersonality(90, [0.2, 0.2, 0.2, 0.2, 0.2]);
      insertPersonality(100, [0.5, 0.1, 0.1, 0.1, 0.2]); // 大幅漂移
      const alerts = runAnomalyCheck(100);
      expect(alerts.some((a) => a.type === "personality_drift")).toBe(true);
    });

    it("小幅变化时不触发", () => {
      insertPersonality(90, [0.2, 0.2, 0.2, 0.2, 0.2]);
      insertPersonality(100, [0.21, 0.19, 0.2, 0.2, 0.2]); // 微调
      const alerts = runAnomalyCheck(100);
      expect(alerts.some((a) => a.type === "personality_drift")).toBe(false);
    });
  });

  describe("voice_starvation", () => {
    it("某声部 200+ tick 未被选为 loudness winner 时触发", () => {
      // ADR-124: voice_starvation 现在查询 tick_log（声部选择记录），不查 action_log
      // 只有 sociability 被选为 loudness winner
      for (let i = 0; i < 10; i++) {
        insertTickLogWithVoice(290 + i, "sociability");
      }
      const alerts = runAnomalyCheck(300);
      // diligence, curiosity, caution 都应触发（ADR-81: reflection 已移除）
      const starved = alerts.filter((a) => a.type === "voice_starvation");
      expect(starved.length).toBe(3);
    });
  });

  // ADR-129: voice_lost — LLM 失语检测
  describe("voice_lost", () => {
    /** 插入 action_log 并指定 actionType。 */
    function insertActionWithType(tick: number, actionType: string, success: boolean) {
      sqlite.exec(
        `INSERT INTO action_log (tick, voice, action_type, success)
         VALUES (${tick}, 'sociability', '${actionType}', ${success ? 1 : 0})`,
      );
    }

    it("LLM 失败率 > 50% 时触发 error", () => {
      // 10 条中 6 条 llm_failed → 60%
      for (let i = 0; i < 10; i++) {
        insertActionWithType(90 + i, i < 6 ? "llm_failed" : "message", i >= 6);
      }
      const alerts = runAnomalyCheck(100);
      const voiceLost = alerts.find((a) => a.type === "voice_lost");
      expect(voiceLost).toBeDefined();
      expect(voiceLost?.level).toBe("error");
    });

    it("provider_failed 和 validation_failed 计入 LLM 失语，command_misuse 不计入", () => {
      const types = [
        "provider_failed",
        "provider_failed",
        "validation_failed",
        "validation_failed",
        "validation_failed",
        "validation_failed",
        "command_misuse",
        "message",
        "observe",
        "silence",
      ];
      for (let i = 0; i < types.length; i++) {
        insertActionWithType(90 + i, types[i], !types[i].endsWith("_failed"));
      }

      const alerts = runAnomalyCheck(100);
      expect(alerts.some((a) => a.type === "voice_lost")).toBe(true);
    });

    it("LLM 正常时不触发", () => {
      for (let i = 0; i < 10; i++) {
        insertActionWithType(90 + i, "message", true);
      }
      const alerts = runAnomalyCheck(100);
      expect(alerts.some((a) => a.type === "voice_lost")).toBe(false);
    });

    it("不足 3 条时不触发", () => {
      insertActionWithType(99, "llm_failed", false);
      insertActionWithType(100, "llm_failed", false);
      const alerts = runAnomalyCheck(100);
      expect(alerts.some((a) => a.type === "voice_lost")).toBe(false);
    });

    it("恰好 50% 时不触发（需 > 50%）", () => {
      for (let i = 0; i < 10; i++) {
        insertActionWithType(90 + i, i < 5 ? "llm_failed" : "message", i >= 5);
      }
      const alerts = runAnomalyCheck(100);
      expect(alerts.some((a) => a.type === "voice_lost")).toBe(false);
    });
  });

  // ADR-131 D3: voice_action_starvation — 声部行动饥饿检测
  describe("voice_action_starvation", () => {
    /** 插入带声部的 action_log。 */
    function insertActionForVoice(tick: number, voice: string) {
      sqlite.exec(
        `INSERT INTO action_log (tick, voice, action_type, success)
         VALUES (${tick}, '${voice}', 'message', 1)`,
      );
    }

    it("声部赢 loudness 50+ 次但 action < 5% 时触发 warn", () => {
      // curiosity 赢了 60 次 loudness（tick 501-560）
      for (let i = 0; i < 60; i++) {
        insertTickLogWithVoice(501 + i, "curiosity");
      }
      // 但只有 2 次 action（< 5% of 60 = 3）
      insertActionForVoice(510, "curiosity");
      insertActionForVoice(540, "curiosity");

      const alerts = runAnomalyCheck(1000);
      const starvation = alerts.find(
        (a) => a.type === "voice_action_starvation" && a.message.includes("curiosity"),
      );
      expect(starvation).toBeDefined();
      expect(starvation?.level).toBe("warn");
    });

    it("行动比率 >= 5% 时不触发", () => {
      // 60 次 loudness + 4 次 action = 6.7%
      for (let i = 0; i < 60; i++) {
        insertTickLogWithVoice(501 + i, "curiosity");
      }
      for (let i = 0; i < 4; i++) {
        insertActionForVoice(510 + i * 10, "curiosity");
      }

      const alerts = runAnomalyCheck(1000);
      expect(
        alerts.some((a) => a.type === "voice_action_starvation" && a.message.includes("curiosity")),
      ).toBe(false);
    });

    it("loudness 赢面不足 50 次时不触发", () => {
      // 只有 30 次 loudness，即使 0 次 action 也不触发（样本不足）
      for (let i = 0; i < 30; i++) {
        insertTickLogWithVoice(971 + i, "curiosity");
      }

      const alerts = runAnomalyCheck(1000);
      expect(
        alerts.some((a) => a.type === "voice_action_starvation" && a.message.includes("curiosity")),
      ).toBe(false);
    });

    it("caution 的 system1:skip 不按行动饥饿误报", () => {
      for (let i = 0; i < 80; i++) {
        insertTickLogWithVoiceAndGate(501 + i, "caution", "system1:skip");
      }

      const alerts = runAnomalyCheck(1000);
      expect(alerts.some((a) => a.type === "voice_action_starvation")).toBe(false);
    });

    it("System 1 已处理的 tick 不进入行动饥饿分母", () => {
      for (let i = 0; i < 80; i++) {
        insertTickLogWithVoiceAndGate(501 + i, "diligence", "system1:digest");
      }

      const alerts = runAnomalyCheck(1000);
      expect(
        alerts.some((a) => a.type === "voice_action_starvation" && a.message.includes("diligence")),
      ).toBe(false);
    });
  });

  // db_bloat 跳过——依赖文件系统状态，不适合单元测试
});
