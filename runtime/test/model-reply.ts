import type { Act } from "../src/mind/affordances.js";
import { codeMode, type ToolReply } from "../src/speech/decision.js";

/** 发言模型对这些动作交回的原文：一次 run_code，程序是 codeMode 的写法；没有动作就是不调用。 */
export function modelReply(acts: readonly Act[], content = ""): string {
  const calls = acts.length
    ? [{ name: "run_code", arguments: JSON.stringify({ code: codeMode.render(acts) }) }]
    : [];
  return JSON.stringify({ content, calls } satisfies ToolReply);
}

/** 她写的一段程序原样交回（一次 run_code）。 */
export const program = (code: string, content = ""): string =>
  JSON.stringify({
    content,
    calls: [{ name: "run_code", arguments: JSON.stringify({ code }) }],
  } satisfies ToolReply);

/** 一句话就是一个 say。 */
export const says = (...texts: string[]): string =>
  modelReply(texts.map((text) => ({ kind: "send", text, replyTo: null })));
