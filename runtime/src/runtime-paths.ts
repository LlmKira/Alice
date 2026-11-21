import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * 运行时状态目录：Journal、锁、错误日志、提示日志、花费账、暂停状态（gitignore 的 runtime/live/）。
 * 默认是当前目录下的 live/，这样 pnpm start、start:check 和 pm2（ecosystem.config.cjs）用的是同一个库、同一把锁；
 * 上线用的是干净的新库，旧的 runtime/alice.db 不再是默认。
 */
export const ALICE_STATE_DIR = resolve(process.env.ALICE_STATE_DIR ?? "live");

export const ALICE_DB_PATH = resolve(
  process.env.ALICE_DB_PATH ?? resolve(ALICE_STATE_DIR, "alice.db"),
);

export const ALICE_ERROR_LOG_PATH = resolve(
  process.env.ALICE_ERROR_LOG_PATH ?? resolve(ALICE_STATE_DIR, "alice-errors.log"),
);

export function ensureParentDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}
