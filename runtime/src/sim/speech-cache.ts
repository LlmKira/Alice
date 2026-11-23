import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { executeToolReply, type QueryKind } from "../llm/ptc.js";
import { SPEECH_MODEL } from "../llm/speech-model.js";
import type { SpeechRequest } from "../mind/effects.js";
import type { SpeechFormat } from "../speech/decision.js";
import { parseDecision } from "../speech/decision.js";
import { executeNativeTurn } from "../speech/native.js";
import { renderSpeechPrompt, type SpeechPrompt } from "../speech/prompt.js";
import type { SpeechOracle } from "./replay.js";

/**
 * 回放用的发言 oracle：同一模型、同一提示词只真调用一次，原文缓存到 JSONL，
 * 之后的回放直接读缓存，所以结果可复现。模型原文和解析分开存，换解析规则不必重新调用。
 */
export function cachedSpeechOracle(options: {
  persona: string;
  cacheFile: string;
  call: (prompt: SpeechPrompt) => Promise<string>;
  /** 缓存键里的模型 id（默认生产模型；换模型就是另一份缓存）。 */
  model?: string;
  /** 可选实验提示词选项；不传则与生产逐字节一致。 */
  promptOptions?: {
    format?: SpeechFormat;
  };
  /** 可选轮内查询执行器（提供时执行查询串联并返回结果给模型）。 */
  onQuery?: (
    request: SpeechRequest,
    kind: QueryKind,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<unknown>;
}): SpeechOracle & { misses: () => number; failures: () => number } {
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
  const cachedCall = async (prompt: SpeechPrompt): Promise<string> => {
    const keyPayload =
      options.promptOptions?.format === "native" || prompt.messages
        ? `${options.model ?? SPEECH_MODEL}\n${prompt.system}\n${prompt.user}\n${JSON.stringify(prompt.tools ?? null)}\n${JSON.stringify(prompt.messages ?? null)}`
        : `${options.model ?? SPEECH_MODEL}\n${prompt.system}\n${prompt.user}`;
    const key = createHash("sha256").update(keyPayload).digest("hex");
    let raw = cache.get(key);
    if (raw === undefined) {
      misses++;
      raw = await options.call(prompt);
      cache.set(key, raw);
      appendFileSync(options.cacheFile, `${JSON.stringify({ key, raw })}\n`);
    }
    return raw;
  };

  const oracle = async (request: Parameters<SpeechOracle>[0]) => {
    if (options.promptOptions?.format === "native") {
      try {
        const query = options.onQuery;
        const res = await executeNativeTurn({
          persona: options.persona,
          request,
          callModel: cachedCall,
          ...(query ? { onQuery: (kind, args, signal) => query(request, kind, args, signal) } : {}),
        });
        return res.decision;
      } catch (error) {
        failures++;
        if (failures <= 3) console.error(`speech call failed: ${String(error).slice(0, 300)}`);
        return null;
      }
    }
    const prompt = options.promptOptions
      ? renderSpeechPrompt(options.persona, request, options.promptOptions)
      : renderSpeechPrompt(options.persona, request);
    let raw: string;
    try {
      raw = await cachedCall(prompt);
    } catch (error) {
      // 失败不能悄悄算成沉默：计数，并打印前几条原因。
      failures++;
      if (failures <= 3) console.error(`speech call failed: ${String(error).slice(0, 300)}`);
      return null;
    }
    if (!options.onQuery) return parseDecision(raw, request);
    const query = options.onQuery;
    const ptc = await executeToolReply(raw, request, {
      timeoutMs: 90_000,
      onQuery: (kind, args, signal) => query(request, kind, args, signal),
    });
    return ptc.decision;
  };
  return Object.assign(oracle, { misses: () => misses, failures: () => failures });
}
