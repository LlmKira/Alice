import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { SPEECH_MODEL } from "../llm/speech-model.js";
import type { PonderRequest } from "../mind/effects.js";
import type { Ponder } from "../mind/events.js";
import { parseLifeDay, renderLifeDayPrompt } from "../speech/life-day.js";
import type { SpeechPrompt } from "../speech/prompt.js";
import { parseReflect, renderReflectPrompt } from "../speech/reflect.js";

/**
 * 回放用的心情效价（外壳的 perceiveMood）：同一个词和原因只真问一次，缓存到 JSONL。判失败记为判不出（null），
 * 不缓存。
 */
export function cachedValenceOracle(options: {
  cacheFile: string;
  perceive: (mood: { word: string; why: string | null }) => Promise<number | null>;
}): (mood: { word: string; why: string | null }) => Promise<number | null> {
  const cache = new Map<string, number | null>();
  if (existsSync(options.cacheFile)) {
    for (const line of readFileSync(options.cacheFile, "utf8").split("\n")) {
      if (!line) continue;
      const row = JSON.parse(line) as { key: string; valence: number | null };
      cache.set(row.key, row.valence);
    }
  }
  return async (mood) => {
    const key = `${mood.word}\n${mood.why ?? ""}`;
    if (cache.has(key)) return cache.get(key) ?? null;
    let valence: number | null;
    try {
      valence = await options.perceive(mood);
    } catch (error) {
      console.error(`mood valence failed: ${String(error).slice(0, 300)}`);
      return null;
    }
    cache.set(key, valence);
    appendFileSync(options.cacheFile, `${JSON.stringify({ key, valence })}\n`);
    return valence;
  };
}

/**
 * 回放用的想一想 oracle：同一模型、同一提示词只真调用一次，原文缓存到 JSONL（和发言缓存同一做法），
 * 之后的回放直接读缓存。读不出 JSON 记为失败（和外壳一样）。
 */
export function cachedPonderOracle(options: {
  persona: string;
  cacheFile: string;
  call: (prompt: SpeechPrompt) => Promise<string>;
  /** 缓存键里的模型 id（默认生产模型）。 */
  model?: string;
}): ((request: PonderRequest) => Promise<Ponder | null>) & {
  misses: () => number;
  failures: () => number;
} {
  const cache = new Map<string, string>();
  if (existsSync(options.cacheFile)) {
    for (const line of readFileSync(options.cacheFile, "utf8").split("\n")) {
      if (!line) continue;
      const row = JSON.parse(line) as { key: string; raw: string };
      cache.set(row.key, row.raw);
    }
  }
  let misses = 0;
  let failures = 0;
  const oracle = async (request: PonderRequest): Promise<Ponder | null> => {
    const prompt =
      request.kind === "life"
        ? renderLifeDayPrompt(options.persona, request)
        : renderReflectPrompt(options.persona, request);
    const key = createHash("sha256")
      .update(`${options.model ?? SPEECH_MODEL}\n${prompt.system}\n${prompt.user}`)
      .digest("hex");
    let raw = cache.get(key);
    if (raw === undefined) {
      misses++;
      try {
        raw = await options.call(prompt);
      } catch (error) {
        failures++;
        if (failures <= 3) console.error(`ponder call failed: ${String(error).slice(0, 300)}`);
        return null;
      }
      cache.set(key, raw);
      appendFileSync(options.cacheFile, `${JSON.stringify({ key, raw })}\n`);
    }
    try {
      return request.kind === "life" ? parseLifeDay(raw, request) : parseReflect(raw, request);
    } catch (error) {
      failures++;
      if (failures <= 3) console.error(`ponder parse failed: ${String(error).slice(0, 300)}`);
      return null;
    }
  };
  return Object.assign(oracle, { misses: () => misses, failures: () => failures });
}
