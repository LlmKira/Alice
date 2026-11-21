/**
 * 一个对外动作做成之后写回什么事件（外壳和回放共用，src/interpret.ts）：留下了她的消息的写 message.sent，
 * 看了才知道的写 act.done 带她看到的东西，其余写 act.done。
 */
import { type Act, postedMessage } from "./affordances.js";
import type { ActDone, FoundPlace, MessageSent } from "./events.js";
import type { TimelineEntry } from "./state.js";

/** 执行器的结果：发出的消息的 id、看到的东西（找群还带结构化的结果），或者只是做了。 */
export type ActOutcome =
  | { kind: "posted"; messageId: string }
  | { kind: "looked"; text: string; found: FoundPlace[] }
  | { kind: "done" };

export function outcomeEvent(
  scope: string,
  act: Act,
  outcome: ActOutcome,
  at: number,
  find: (messageId: string) => TimelineEntry | undefined,
): MessageSent | ActDone {
  const posted = postedMessage(act, find);
  if (posted) {
    // 该留下消息的动作没有消息 id：不知道发出去没有（外壳记为结果未知，不重发）。
    if (outcome.kind !== "posted") throw new Error(`${act.kind} returned no message id`);
    return { type: "message.sent", at, scope, messageId: outcome.messageId, ...posted };
  }
  if (outcome.kind === "looked") {
    const found = outcome.found.length > 0 ? { found: outcome.found } : {};
    return { type: "act.done", at, scope, act, result: outcome.text, ...found };
  }
  return { type: "act.done", at, scope, act };
}
