import type { Contribution, Mechanism } from "../mind/mechanism.js";
import type { ChatState } from "../mind/state.js";

/**
 * 她在这段对话里占了多少：聊天记录尾部连着几条是她发的（2 月 engine/act/presence.ts，ADR-118；
 * ADR-159 扩展到私聊）。2 月约 100% 的提示词带这一行，只在连着 2 条以上时出现（1 条是正常的，
 * 低存在感时不写，免得变成配额心态）；不写比例（要算术）。4 条以上 2 月先写"only you talking"，
 * ADR-159 改成 STOP 指令——这里只取纯事实那一版。私聊和群里写法相同。
 */
function trailingYours(chat: ChatState): number {
  let n = 0;
  for (let i = chat.timeline.length - 1; i >= 0 && chat.timeline[i]?.sender === null; i--) n++;
  return n;
}

export const presence: Mechanism = {
  name: "presence",
  contribute(chat: ChatState): Contribution[] {
    const n = trailingYours(chat);
    if (n < 2) return [];
    const text =
      n >= 4
        ? `聊天记录最后连着 ${n} 条都是你发的，这一阵只有你在说。`
        : `聊天记录最后连着 ${n} 条都是你发的。`;
    return [{ mechanism: "presence", kind: "turn", text }];
  },
};
