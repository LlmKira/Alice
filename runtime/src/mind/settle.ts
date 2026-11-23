import { type Act, affordanceOf, memberAfter } from "./affordances.js";
import { buildAct } from "./args.js";
import { chatView } from "./chat-view.js";
import type { SpeechDecision } from "./events.js";
import { type ChatState, SEND_LIMIT, SEND_WINDOW_MS } from "./state.js";

export interface Settled {
  acts: Act[];
  recentSends: number[];
  /** 因为这一分钟里已经发了 SEND_LIMIT 条而没发出去的消息（说给她听：failures 机制）。 */
  dropped: Act[];
}

/**
 * 把模型的决定落成要做的动作，按登记表通用处理，只守不变量：
 * - 动作必须此刻可用（例如私聊里不能退群，退群之后同一决定里的动作都不再可用），参数必须指向本会话
 *   （改消息只能改她自己在这里刚发的文字消息：参数种类 own）；
 * - 会留下消息的动作（posts）受单位时间发送上限约束（防刷屏）；
 * - 同一个不留消息的动作在一次决定里只做一次（重复点同一个表情没有意义）。
 * 发不发贴纸、点不点表情、引不引用属于表达，由模型决定，靠提示词里的事实和示例软引导，
 * 不在这里过滤：优化之后再加二值闸门，模型看不见它，只会反复想要、反复被拒
 * （论文 §4 的 integrator windup）。
 */
export function settleDecision(chat: ChatState, decision: SpeechDecision, at: number): Settled {
  const recentSends = chat.recentSends.filter((t) => at - t < SEND_WINDOW_MS);
  let budget = SEND_LIMIT - recentSends.length;
  let current: ChatState = chat;
  const ctx = { timeline: chat.timeline, now: at };
  const seen = new Set<string>();
  const acts: Act[] = [];
  const dropped: Act[] = [];
  for (const proposed of decision.acts) {
    const row = affordanceOf(proposed.kind);
    if (!row.available(chatView(current), at)) continue;
    const act = buildAct(proposed.kind, proposed, ctx);
    if (!act) continue;
    if (row.posts) {
      if (budget <= 0) {
        dropped.push(act);
        continue;
      }
      budget--;
      recentSends.push(at);
    } else if (!firstSeen(seen, act)) {
      continue;
    }
    acts.push(act);
    const member = memberAfter(row);
    if (member !== undefined) current = { ...current, member };
  }
  return { acts, recentSends, dropped };
}

/** 不留消息的动作在一次决定里只做一次：第一次见到时记下并返回 true。 */
function firstSeen(seen: Set<string>, act: Act): boolean {
  const key = JSON.stringify(act);
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}
