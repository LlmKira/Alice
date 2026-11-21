/** 从核心状态适配出登记表要的会话视图（ChatView）。 */
import type { ChatView } from "./affordances.js";
import type { ChatState, TimelineEntry } from "./state.js";

export function chatView(chat: ChatState): ChatView {
  return {
    chatType: chat.chatType,
    member: chat.member,
    fresh: freshCount(chat.timeline),
    looked: chat.looked,
    running: chat.running.length,
    lookRun: chat.lookRun,
    own: chat.timeline
      .filter((t) => t.sender === null && t.contentType === "text")
      .map((t) => ({ id: t.messageId, at: t.at })),
    echo: echoOf(chat.timeline),
  };
}

/**
 * 记录末尾有没有人在复读：从最后一条往前，连着几条别人的文字消息内容相同，而且至少两个不同的人发了，
 * 就是在复读（2 月 repeat_message）。她自己的话会打断它：她已经跟过了就不再出现。
 */
function echoOf(timeline: readonly TimelineEntry[]): string | null {
  const last = timeline.at(-1);
  const said = last?.sender && last.contentType === "text" ? last.text?.trim() : undefined;
  if (!last || !said) return null;
  const senders = new Set<string>();
  for (let i = timeline.length - 1; i >= 0; i--) {
    const t = timeline[i] as TimelineEntry;
    if (!t.sender || t.contentType !== "text" || t.text?.trim() !== said) break;
    senders.add(t.sender.id);
  }
  return senders.size >= 2 ? last.messageId : null;
}

/** 时间线里她最后一次开口之后别人的消息数。 */
function freshCount(timeline: readonly TimelineEntry[]): number {
  let n = 0;
  for (let i = timeline.length - 1; i >= 0; i--) {
    if ((timeline[i] as TimelineEntry).sender === null) break;
    n++;
  }
  return n;
}
