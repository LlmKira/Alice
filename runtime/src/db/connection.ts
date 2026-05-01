/**
 * SQLite + Drizzle 初始化（使用 better-sqlite3）。
 *
 * ADR-53: 统一到 Drizzle migration，删除手写 raw SQL DDL。
 * @see docs/adr/53-audit-gap-closure.md
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { load as loadBetterTrigram } from "sqlite-better-trigram";
import { ftsEnsurePopulated } from "./fts.js";
import * as schema from "./schema.js";

let _db: ReturnType<typeof drizzle> | null = null;
let _sqlite: InstanceType<typeof Database> | null = null;
let _dbPath: string | null = null;

/** drizzle/ 目录的绝对路径（兼容 tsx 和 vitest 两种运行环境）。 */
const MIGRATIONS_FOLDER = resolve(fileURLToPath(import.meta.url), "../../../drizzle");

/**
 * 获取 Drizzle 数据库实例。必须先调用 initDb()。
 *
 * I10: 移除 dbPath 参数，消除隐式懒初始化。
 * 所有初始化统一走 initDb(path)，getDb() 只做纯读取。
 */
export function getDb() {
  if (!_db) {
    throw new Error("Database not initialized. Call initDb(path) first.");
  }
  return _db;
}

/**
 * 获取当前数据库文件路径。
 * M4 修复: 供 anomaly.ts 等模块获取实际 DB 路径，避免硬编码。
 */
export function getDbPath(): string {
  return _dbPath ?? "alice.db";
}

export function isDbInitialized(): boolean {
  return _db != null;
}

/**
 * 初始化数据库：打开连接 + 运行迁移。
 *
 * I10: 只能调用一次。再次初始化需先 closeDb()。
 * 保证整个生命周期 initDb → getDb → closeDb 的严格顺序。
 */
export function initDb(dbPath: string = "alice.db"): void {
  if (_db) {
    throw new Error(
      `Database already initialized (${_dbPath}). Call closeDb() before re-initializing.`,
    );
  }

  _dbPath = dbPath;
  _sqlite = new Database(dbPath);
  _sqlite.exec("PRAGMA journal_mode = WAL");
  // ADR-145: 加载 better_trigram FTS5 tokenizer——必须在 migrate() 之前，
  // 因为 migration SQL 会引用 better_trigram tokenizer。
  try {
    loadBetterTrigram(_sqlite);
  } catch (e) {
    _sqlite.close();
    _sqlite = null;
    _dbPath = null;
    throw new Error(
      `Failed to load FTS5 better_trigram extension: ${e instanceof Error ? e.message : e}`,
    );
  }
  _db = drizzle(_sqlite, { schema });

  migrate(_db, { migrationsFolder: MIGRATIONS_FOLDER });

  // ADR-145: 首次部署后历史数据补全——FTS 索引为空时全量 rebuild
  ftsEnsurePopulated();
}

/**
 * 获取底层 better-sqlite3 实例（用于 transaction）。
 */
export function getSqlite(): InstanceType<typeof Database> {
  if (!_sqlite) throw new Error("Database not initialized");
  return _sqlite;
}

/**
 * 关闭数据库连接。
 */
export function closeDb(): void {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
    _db = null;
    _dbPath = null;
  }
}
