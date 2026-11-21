import Database from "better-sqlite3";

let sqlite: InstanceType<typeof Database> | null = null;

export function isDbInitialized(): boolean {
  return sqlite !== null;
}

export function initDb(path = "alice.db"): void {
  if (sqlite) throw new Error("Database already initialized");

  const connection = new Database(path);
  try {
    connection.pragma("journal_mode = WAL");
    connection.exec(`
      CREATE TABLE IF NOT EXISTS journal_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        type TEXT NOT NULL,
        scope TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_journal_events_scope_id
        ON journal_events (scope, id);
      CREATE INDEX IF NOT EXISTS idx_journal_events_type_id
        ON journal_events (type, id);
    `);
    // 幂等迁移：为既有库补墙钟时间列；新库同样经由此路径补齐。
    // 旧行 ts 为 NULL（时间未知），读取侧按"未知"处理，不做臆测回填。
    const columns = connection.pragma("table_info(journal_events)") as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "ts")) {
      connection.exec("ALTER TABLE journal_events ADD COLUMN ts INTEGER");
    }
    sqlite = connection;
  } catch (error) {
    connection.close();
    throw error;
  }
}

export function getSqlite(): InstanceType<typeof Database> {
  if (!sqlite) throw new Error("Database not initialized");
  return sqlite;
}

export function closeDb(): void {
  sqlite?.close();
  sqlite = null;
}
