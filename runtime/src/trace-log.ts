/**
 * 线上的意愿层快照：每 TRACE_EVERY_MS 把排前几名的候选与各驱动读数写一行到状态目录下的 traces/<日期>.jsonl
 * （runtime/live/，gitignore）。事后的 pnpm trace 能从 Journal 重放出每次唤醒；这里补上"没有醒的时候她心里
 * 排第一的是什么"，并且是当时那一版代码算的（每行带 sha），不怕之后代码变了重放走岔。
 * 只读状态（explain.ts 的 readWill 是纯函数，不改它读的东西），不进 Journal，不进 step()，回放里没有它；
 * 写失败只警告一次，不影响她。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { lensOf, productionWorld, readWill } from "./mechanisms/pressure/explain.js";
import type { AliceState } from "./mind/state.js";

export const TRACE_EVERY_MS = 5 * 60_000;
const TOP = 3;
const lens = lensOf();

/** 一行快照：哪一刻、哪一版代码，加上意愿层的读数。 */
export function traceRow(state: AliceState, now: number, sha: string): Record<string, unknown> {
  return { at: now, sha, ...readWill(productionWorld(state), now, lens, TOP) };
}

/** 返回一个写快照的函数：按 UTC 日期分文件（和提示日志一样）。 */
export function traceWriter(
  dir: string,
  sha: string,
  warn: (error: unknown) => void,
): (state: AliceState, now: number) => void {
  let warned = false;
  return (state, now) => {
    try {
      const row = traceRow(state, now, sha);
      mkdirSync(dir, { recursive: true });
      const day = new Date(now).toISOString().slice(0, 10);
      appendFileSync(join(dir, `${day}.jsonl`), `${JSON.stringify(row)}\n`);
    } catch (error) {
      if (!warned) warn(error);
      warned = true;
    }
  };
}
