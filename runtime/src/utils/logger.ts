/**
 * 统一日志模块。基于 consola，彩色美化输出。
 *
 * ADR-54: error/warn/fatal 同时写入 alice-errors.log 独立文件，
 * 方便 `tail -f alice-errors.log` 或 `grep` 快速定位异常。
 */
import { createWriteStream, type WriteStream } from "node:fs";
import { createConsola } from "consola";
import { ALICE_ERROR_LOG_PATH, ensureParentDir } from "../runtime-paths.js";

const root = createConsola({
  level: process.env.LOG_LEVEL === "debug" ? 4 : 3,
});

// ADR-54: 错误独立文件 — error/warn/fatal → alice-errors.log
// 测试环境不写文件（避免污染 CI 输出目录）
let _errorStream: WriteStream | null = null;
const problemListeners: Array<() => void> = [];

/** 每写一条 warn / error / fatal 就叫一次（自检数错误日志激增，src/ops/watch.ts）。 */
export function onProblemLogged(listener: () => void): void {
  problemListeners.push(listener);
}

if (!process.env.VITEST && process.env.NODE_ENV !== "test") {
  ensureParentDir(ALICE_ERROR_LOG_PATH);
  _errorStream = createWriteStream(ALICE_ERROR_LOG_PATH, { flags: "a" });
  root.addReporter({
    log(logObj) {
      // consola level: 0=fatal/error, 1=warn
      if (logObj.level > 1) return;
      const ts = new Date().toISOString();
      const tag = logObj.tag ? `[${logObj.tag}]` : "";
      const level = (logObj.type ?? "error").toUpperCase();
      const parts: string[] = [];
      for (const arg of logObj.args ?? []) {
        if (typeof arg === "string") parts.push(arg);
        else if (arg instanceof Error) parts.push(`${arg.message}\n${arg.stack ?? ""}`);
        else {
          try {
            parts.push(JSON.stringify(arg));
          } catch {
            parts.push(String(arg));
          }
        }
      }
      _errorStream?.write(`${ts} ${level} ${tag} ${parts.join(" ")}\n`);
      for (const listener of problemListeners) listener();
    },
  });
}

/** 创建带 tag 的子 logger。 */
export function createLogger(tag: string) {
  return root.withTag(tag);
}

/**
 * 停机时关掉错误日志：等缓冲区里最后几条刷进 alice-errors.log，之后的 warn / error 只走终端。
 * （不关的话进程退出时那几条就丢了：tail 日志的人正好看不到停机前后的报错。）
 */
export async function closeLogger(): Promise<void> {
  const stream = _errorStream;
  _errorStream = null;
  if (!stream) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  stream.end(resolve);
  return promise;
}
