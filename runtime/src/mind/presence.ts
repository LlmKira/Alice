/**
 * 一个会话里"在场"的人：她时间线上（最近 TIMELINE_LIMIT 条）说过话的别人；私聊里就是对方。
 * 隐私受众规则（转发、日记、心情的原因跨会话时给谁看）判"当时在不在场"都该用这一个定义，
 * 尺度一漂，两边对同一条消息的判决就不一样。
 */
import type { ChatState } from "./state.js";

export function presentIn(chat: ChatState | undefined): string[] {
  if (!chat) return [];
  return [...new Set(chat.timeline.flatMap((t) => (t.sender ? [t.sender.id] : [])))];
}
