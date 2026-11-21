/**
 * 每轮提示日志：她每次调用模型时看到的提示和写出的原文，按天写成 JSONL（runtime/prompt-logs/，gitignore）。
 * 用途是上线后的足迹分析和回流成新场景（2 月的 prompt-logs 是回看 2 月的唯一一手材料）。写失败只记一次警告，
 * 不影响她说话。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ModelCall } from "./shell.js";
import type { SpeechPrompt } from "./speech/prompt.js";

type Call = (prompt: SpeechPrompt, call: ModelCall, signal: AbortSignal) => Promise<string>;

/**
 * stamp：这次运行的代码版本（runs.ts）和发言模型，每行都带——回放时按 sha 取同一版代码，
 * 换过模型的日子也分得开是哪个模型写的。
 */
export function withPromptLog(
  callModel: Call,
  dir: string,
  stamp: { sha: string; model: string },
  warn: (error: unknown) => void,
): Call {
  let warned = false;
  const write = (row: Record<string, unknown>) => {
    try {
      mkdirSync(dir, { recursive: true });
      const day = new Date(row.at as number).toISOString().slice(0, 10);
      appendFileSync(join(dir, `${day}.jsonl`), `${JSON.stringify(row)}\n`);
    } catch (error) {
      if (!warned) warn(error);
      warned = true;
    }
  };
  return async (prompt, call, signal) => {
    const at = Date.now();
    try {
      const raw = await callModel(prompt, call, signal);
      write({
        at,
        ...stamp,
        ...call,
        ms: Date.now() - at,
        system: prompt.system,
        user: prompt.user,
        raw,
      });
      return raw;
    } catch (error) {
      write({
        at,
        ...stamp,
        ...call,
        ms: Date.now() - at,
        system: prompt.system,
        user: prompt.user,
        error: String(error),
      });
      throw error;
    }
  };
}
