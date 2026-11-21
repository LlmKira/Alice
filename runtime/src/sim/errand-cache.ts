import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { ERRAND_MODEL, EXECUTOR_VERSION, runErrand } from "../llm/errand.js";
import type { Gateway } from "../llm/gateway.js";
import { Failed } from "../mind/failure.js";
import { renderSpeechPrompt } from "../speech/prompt.js";
import type { BackgroundOracle, BackgroundResult } from "./replay.js";

type Row = BackgroundResult;

/** 缓存里的一行。2026-11-12 之前没办成的行只有 reason（她看到的话）。 */
type CachedRow = Row | { reason: string; usage?: Row["usage"]; ms: number };

function fromCache(row: CachedRow): Row {
  if ("reason" in row) {
    const { reason, ...rest } = row;
    return { failure: { reason: "errand", said: reason }, ...rest };
  }
  return row;
}

/**
 * 回放用的查一下：同一件事、同一份上下文只真办一次（执行代理会上网，结果和耗时都缓存到 JSONL），
 * 之后的回放读缓存，所以可复现。"今天"取回放里事件的时刻。
 */
export function cachedErrandOracle(options: {
  persona: string;
  cacheFile: string;
  gateway: Gateway;
  exaKey: string;
}): BackgroundOracle & { misses: () => number } {
  const cache = new Map<string, Row>();
  if (existsSync(options.cacheFile)) {
    for (const line of readFileSync(options.cacheFile, "utf8").split("\n")) {
      if (!line) continue;
      const { key, ...row } = JSON.parse(line) as { key: string } & CachedRow;
      cache.set(key, fromCache(row));
    }
  }
  let misses = 0;
  const oracle: BackgroundOracle = async (_scope, act, request, at) => {
    if (act.kind !== "delegate") return { failure: { reason: "unavailable" }, ms: 0 };
    const context = request ? renderSpeechPrompt(options.persona, request) : null;
    const key = createHash("sha256")
      .update(`${ERRAND_MODEL}\n${EXECUTOR_VERSION}\n${act.task}\n${context?.user ?? ""}\n${at}`)
      .digest("hex");
    let row = cache.get(key);
    if (!row) {
      misses++;
      try {
        const done = await runErrand(act.task, context, {
          gateway: options.gateway,
          exaKey: options.exaKey,
          now: at,
        });
        row = { result: done.result, usage: done.usage, ms: done.usage.ms };
      } catch (error) {
        const failed = error instanceof Failed ? error : null;
        const usage = failed?.usage;
        row = {
          failure: failed?.failure ?? { reason: "outcome_unknown" },
          ...(usage ? { usage } : {}),
          ms: usage?.ms ?? 0,
        };
      }
      cache.set(key, row);
      appendFileSync(options.cacheFile, `${JSON.stringify({ key, ...row })}\n`);
    }
    return row;
  };
  return Object.assign(oracle, { misses: () => misses });
}
