/**
 * 她看过的、可以转发的东西（A14）：频道帖子和群消息，按 reach.ts itemId 编号；也认这个群里消息本来的编号。
 * 和相册一样是 Journal 的投影：只从写进了日志的事件更新（index.ts onJournaled），所以日志里没有的消息
 * 这里也不会有。转发前按受众规则（reach.ts mayForward）检查，不合规则就拒绝（带类型的失败 not_shareable）：
 * 这是隐私不变量，执行器这一层守住，不靠模型自觉。群消息"当时在场"的人取那一刻她心里的状态
 * （mind/presence.ts，和日记、心情的受众规则同一个定义）。
 */
import { type ItemSource, itemId, mayForward } from "../mechanisms/pressure/reach.js";
import type { AliceEvent, ChatType } from "../mind/events.js";
import { presentIn } from "../mind/presence.js";
import { type AliceState, TIMELINE_LIMIT } from "../mind/state.js";
import { TelegramActionError } from "./errors.js";

interface Entry {
  scope: string;
  messageId: string;
  source: ItemSource;
}

export class Shelf {
  /** itemId → 那条东西。每个会话只留最近 TIMELINE_LIMIT 条（她能在提示词里看到编号的也就这些）。 */
  private readonly byItem = new Map<string, Entry>();
  private readonly byScope = new Map<string, string[]>();

  get size(): number {
    return this.byItem.size;
  }

  /** 写进了日志、并且已经 step 过的事件，和 step 之后她的状态。 */
  observe(event: AliceEvent, state: AliceState): void {
    if (event.type === "post.received") {
      this.put({ scope: event.scope, messageId: event.messageId, source: { kind: "channel" } });
      return;
    }
    if (event.type !== "message.received") return;
    const { scope, messageId } = event;
    this.put({
      scope,
      messageId,
      source:
        event.chatType === "private"
          ? { kind: "private", scope }
          : { kind: "group", scope, present: presentIn(state.chats[scope]) },
    });
  }

  private put(entry: Entry): void {
    const id = itemId(entry.scope, entry.messageId);
    this.byItem.set(id, entry);
    const ids = [...(this.byScope.get(entry.scope) ?? []).filter((i) => i !== id), id];
    for (const old of ids.splice(0, Math.max(0, ids.length - TIMELINE_LIMIT))) {
      this.byItem.delete(old);
    }
    this.byScope.set(entry.scope, ids);
  }

  /**
   * 要转的那条在哪（来源会话、消息编号）。item 是给她看的编号，或者目标会话里一条消息本来的编号。
   * 找不到，或者按受众规则不能转到这里，就抛带类型的失败。
   */
  source(
    item: string,
    target: { scope: string; chatType: ChatType; partner: string | null },
  ): { scope: string; messageId: string } {
    const id = item.trim().replace(/^\[|\]$/g, "");
    const entry = this.byItem.get(id) ?? this.byItem.get(itemId(target.scope, id));
    if (!entry) throw new TelegramActionError("invalid_asset", `nothing seen as ${id}`);
    if (!mayForward(entry.source, target)) {
      throw new TelegramActionError("not_shareable", `${id} may not go to ${target.scope}`);
    }
    return { scope: entry.scope, messageId: entry.messageId };
  }
}
