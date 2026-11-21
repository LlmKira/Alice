import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { createLogger } from "./utils/logger.js";

const log = createLogger("runtime");

function readStalePid(lockPath: string): number | null {
  try {
    const pid = Number(readFileSync(lockPath, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH = 进程不存在；EPERM = 存在但无权限（也算活着）
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 单实例锁：openSync("wx") 原子创建 lockfile 并写入 pid。
 *
 * 多实例共享同一 Telegram session 会把每条消息双份/三份处理（实测事故：
 * 3 个实例并存 → 同一 wake 完成多次、失败冷却互不共享 → 发言翻倍、
 * 被踢后失败风暴停不下来 → 被群踢出）。pm2 与手动启动都无法再拉起第二个实例。
 *
 * 退出（含 SIGINT/SIGTERM 正常 shutdown）时删除锁；进程崩溃残留的锁由
 * 下一次启动探测 pid 存活性接管。
 */
export class SingleInstanceLockError extends Error {
  constructor(
    readonly heldByPid: number,
    readonly lockPath: string,
  ) {
    super(`Another instance is already running (pid ${heldByPid}) — lock at ${lockPath}`);
    this.name = "SingleInstanceLockError";
  }
}

export function acquireSingleInstanceLock(lockPath: string): void {
  if (existsSync(lockPath)) {
    const stale = readStalePid(lockPath);
    if (stale != null && isAlive(stale)) {
      throw new SingleInstanceLockError(stale, lockPath);
    }
    unlinkSync(lockPath);
    log.warn("Stale lock from dead process removed", { pid: stale });
  }
  const fd = openSync(lockPath, "wx");
  writeSync(fd, String(process.pid));
  closeSync(fd);
  log.info("Single-instance lock acquired", { pid: process.pid, lockPath });
  process.once("exit", () => {
    try {
      if (existsSync(lockPath)) unlinkSync(lockPath);
    } catch {
      // 退出路径上锁清理失败不阻塞退出
    }
  });
}
