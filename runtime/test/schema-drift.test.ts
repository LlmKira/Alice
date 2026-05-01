/**
 * Schema drift detection — 检测 Drizzle schema 定义与实际 DB 表结构的一致性。
 *
 * 防止 schema.ts 修改后忘记更新 initDb() 中的 raw SQL（或反之）。
 */

import { getTableColumns, getTableName } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getSqlite, initDb } from "../src/db/connection.js";
import * as schema from "../src/db/schema.js";

const tables = Object.values(schema);

describe("Schema drift detection", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  for (const table of tables) {
    const tableName = getTableName(table);

    it(`${tableName}: DB 列与 Drizzle schema 一致`, () => {
      const sqlite = getSqlite();
      const dbColumns = sqlite.pragma(`table_info(${tableName})`) as Array<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }>;

      // DB 表存在且有列
      expect(dbColumns.length).toBeGreaterThan(0);

      // 获取 schema 定义的列名（SQL snake_case 名）
      const schemaColumnMap = getTableColumns(table);
      const schemaColumnNames = new Set(Object.values(schemaColumnMap).map((col) => col.name));
      const dbColumnNames = new Set(dbColumns.map((c) => c.name));

      // schema 中定义的每列都应在 DB 中存在
      for (const colName of schemaColumnNames) {
        expect(
          dbColumnNames.has(colName),
          `schema 定义的列 '${colName}' 不存在于 DB 表 '${tableName}'`,
        ).toBe(true);
      }

      // DB 中的每列都应在 schema 中定义（检测遗留列）
      for (const colName of dbColumnNames) {
        expect(
          schemaColumnNames.has(colName),
          `DB 表 '${tableName}' 中的列 '${colName}' 不在 Drizzle schema 中`,
        ).toBe(true);
      }
    });
  }

  it("所有 schema 表都已在 DB 中创建", () => {
    const sqlite = getSqlite();
    const dbTables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    const dbTableNames = new Set(dbTables.map((t) => t.name));

    for (const table of tables) {
      const tableName = getTableName(table);
      expect(dbTableNames.has(tableName), `schema 表 '${tableName}' 未在 DB 中创建`).toBe(true);
    }
  });
});
