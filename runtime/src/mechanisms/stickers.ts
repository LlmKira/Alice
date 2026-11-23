import type { AliceEvent } from "../mind/events.js";
import { type Contribution, defineMechanism } from "../mind/mechanism.js";
import { defaultStickerHints, enrichStickerHint } from "../mind/words.js";

const OBSERVED_KEPT = 8;
const BAG_LIMIT = 14;

/**
 * 候选贴纸视觉清单（PLAN 第 56/65 件）：把聊天下游见过的贴纸画面描述从事件 fold 进状态，
 * 再与内置视觉词表拼进发言提示的 SDK 注释里，让线下回放和线上看到一致的贴纸画面，不靠决策时现读数据库。
 * 纯函数，不写盘，不碰生产。
 */
export const stickerBag = defineMechanism<readonly string[]>({
  name: "sticker-bag",
  initial: [],
  reduce(state, event: AliceEvent) {
    if (event.type !== "message.received" || event.contentType !== "sticker" || !event.media) {
      return state;
    }
    const cleaned = event.media.trim().replace(/^贴纸\s*/u, "");
    if (!cleaned || cleaned.length > 48) return state;
    const formatted =
      cleaned.includes("（") || cleaned.includes("(") ? cleaned : `现场贴纸（${cleaned}）`;
    if (state.includes(formatted)) return state;
    return [...state, formatted].slice(-OBSERVED_KEPT);
  },
  contribute(_chat, _now, state, offered): Contribution[] {
    if (!offered.includes("sticker")) return [];
    const seen = state.map(enrichStickerHint);
    const merged: string[] = [];
    for (const item of [...seen, ...defaultStickerHints(BAG_LIMIT)]) {
      if (!merged.includes(item)) merged.push(item);
      if (merged.length >= BAG_LIMIT) break;
    }
    return [
      {
        mechanism: "sticker-bag",
        kind: "marks",
        text: "",
        stickers: merged,
      },
    ];
  },
});
