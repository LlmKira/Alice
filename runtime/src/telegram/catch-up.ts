/**
 * 对话轮询：补回 Telegram 没推送过来的消息。
 *
 * 为什么会漏：Telegram 不保证给 userbot 推送大超级群和频道的更新（core.telegram.org/api/updates：频道的更新
 * 要客户端自己 getChannelDifference；tdlight-java#242、sorokin-vladimir/tele#119 是同样的现象，打开那个会话才补回来）。
 * mtcute 0.32 只在 openChat 过的会话里定时拉差量（文档写明最多 5–10 个，否则会被限流甚至封号），catchUp
 * 只在启动时补一次，都不能覆盖她在的几十个会话。
 *
 * 做法：每隔 CATCH_UP_MS 拿一次对话列表（每页 100 个会话一次请求），每个会话的最后一条消息 id 和她见过的最新 id
 * 比；有缺口就拉这个会话这段之后的历史，按 id 从旧到新交给同一条入站适配（world-adapter receive），所以补来的
 * 和推送来的是同一种事件，Inbox 只认第一次进来的那条（推送和补拉谁先到都不会重复）。只补这次启动之后的消息：
 * 停机期间的消息不在这里补（那是另一件事，补了会让她一醒来就面对一大批旧消息）。
 * 每轮写一行诊断：几个会话有缺口、补了多少条——也就是推送漏了多少。
 */
import type { Message, TelegramClient } from "@mtcute/node";
import type { AliceEvent } from "../mind/events.js";
import type { Telegram } from "./gates.js";
import { scopeOf } from "./world-adapter.js";

/** 轮询的间隔。 */
export const CATCH_UP_MS = 3 * 60_000;
/** 一页拉多少条。 */
export const CATCH_UP_PAGE = 50;
/** 一个会话一轮最多拉几页：攒得再多，也不让一个会话占满一轮。 */
export const CATCH_UP_PAGES_PER_CHAT = 4;
/** 一轮最多拉几页（全局节流每分钟 30 个请求，一轮在一分钟内做完）。 */
export const CATCH_UP_PAGES_PER_ROUND = 20;
/** 每个会话记住的最近见过的消息 id（去重用；更早的靠"不比见过的最新更新"挡住）。 */
const REMEMBERED = 200;

/** 她见过的消息：Journal 里的（启动折叠、运行时）加上刚进来、还没写日志的。 */
export class Inbox {
  private readonly recent = new Map<string, Set<string>>();
  private readonly newest = new Map<string, number>();

  /**
   * Journal 里的事件：收到的、频道帖子是她见过的。她自己发出的只用来去重：她在一个不推送的群里说话时，
   * 之前没补到的那几条她并没有见过，见过的最新一条不能因此跳过去（2 月 B 不推送时丢的就是这些）。
   */
  observe(event: AliceEvent): void {
    if (event.type === "message.received" || event.type === "post.received") {
      this.note(event.scope, event.messageId);
    } else if (event.type === "message.sent") {
      this.remember(event.scope, event.messageId);
    }
  }

  /** 对话轮询拉到了这一条（一页的最后一条）：见过的最新一条至少到这里。 */
  caughtUp(scope: string, id: number): void {
    if (id > (this.newest.get(scope) ?? 0)) this.newest.set(scope, id);
  }

  /** 推送或补拉来的一条：第一次见返回 true（并记下），见过返回 false。 */
  admit(scope: string, messageId: string): boolean {
    if (this.recent.get(scope)?.has(messageId)) return false;
    this.note(scope, messageId);
    return true;
  }

  /** 这个会话里见过的最新消息 id；从没见过为 null。 */
  newestSeen(scope: string): number | null {
    return this.newest.get(scope) ?? null;
  }

  private note(scope: string, messageId: string): void {
    this.remember(scope, messageId);
    const n = Number(messageId);
    if (Number.isSafeInteger(n)) this.caughtUp(scope, n);
  }

  private remember(scope: string, messageId: string): void {
    const ids = this.recent.get(scope) ?? new Set<string>();
    ids.add(messageId);
    if (ids.size > REMEMBERED) ids.delete(ids.values().next().value as string);
    this.recent.set(scope, ids);
  }
}

/**
 * 她在哪些会话里：这次启动时对话列表里有的，加上 Journal 里出现过的（启动折叠和运行时走同一个投影）。
 * 两边都没有的群，是她启动之后才被拉进来的。对话列表还没拿到时谁都不算新的。
 */
export class Groups {
  private atStart: ReadonlySet<string> | null = null;
  private readonly known = new Set<string>();

  observe(event: AliceEvent): void {
    if ("scope" in event && event.scope) this.known.add(event.scope);
  }

  started(scopes: Iterable<string>): void {
    this.atStart = new Set(scopes);
  }

  isNew(scope: string): boolean {
    return this.atStart !== null && !this.atStart.has(scope) && !this.known.has(scope);
  }
}

/** 这次启动时她的全部会话（对话列表，每页 100 个一次请求）。 */
export async function dialogScopes(tg: Telegram): Promise<string[]> {
  return tg.request("dialogs", {}, async (c) => {
    const scopes: string[] = [];
    for await (const dialog of c.iterDialogs({ pinned: "keep", archived: "keep" })) {
      scopes.push(scopeOf(dialog.peer.id));
    }
    return scopes;
  });
}

export interface CatchUpRound {
  /** 看了几个会话。 */
  dialogs: number;
  /** 其中有缺口的。 */
  gaps: number;
  /** 补回来、交给入站适配的消息条数（去重之前）。 */
  fetched: number;
  /** 这一轮没拉完的会话：下一轮从见过的最新一条往后接着拉。 */
  carried: number;
}

/**
 * 一轮：对话列表里每个会话的最后一条，比她见过的新、而且是 since 之后发的，就补拉这一段。
 * 从见过的最新一条往后、按编号从旧到新一页一页地拉（没见过的会话从 since 那一刻起），拉到最后一条为止。
 * 一个会话最多 CATCH_UP_PAGES_PER_CHAT 页、一轮最多 CATCH_UP_PAGES_PER_ROUND 页；没拉完的记在 carried 里，
 * 见过的最新一条停在已经补到的地方，下一轮从那里接着拉，中间不漏。以前一轮只拿最新的一页，再把最新的记成见过，
 * 一页之外的就再也补不回来了。receive 是入站适配（去重在它那里）。
 */
export async function catchUp(
  tg: Telegram,
  inbox: Inbox,
  receive: (msg: Message, client: TelegramClient) => void,
  since: number,
): Promise<CatchUpRound> {
  const round: CatchUpRound = { dialogs: 0, gaps: 0, fetched: 0, carried: 0 };
  // 按最后一条的时间从新到旧（置顶的也按时间排、归档的也算）：看到 since 之前的就不用再往下翻。
  const dialogs = await tg.request("catch_up", {}, async (c) => {
    const recent = [];
    for await (const dialog of c.iterDialogs({ pinned: "keep", archived: "keep" })) {
      const last = dialog.lastMessage;
      if (!last) continue;
      // 置顶的排在最前、不按时间：一个很久没动的置顶会话不能让这一轮就此停下（上线第一轮 dialogs: 0）。
      if (last.date.getTime() < since) {
        if (dialog.isPinned) continue;
        break;
      }
      recent.push(dialog);
    }
    return recent;
  });
  let pages = 0;
  for (const dialog of dialogs) {
    round.dialogs++;
    const last = dialog.lastMessage;
    if (!last) continue;
    const scope = scopeOf(dialog.peer.id);
    const seen = inbox.newestSeen(scope);
    if (seen !== null && last.id <= seen) continue;
    round.gaps++;
    if (pages >= CATCH_UP_PAGES_PER_ROUND) {
      round.carried++;
      continue;
    }
    // mtcute reverse：从 offset 往后（编号含 offset），从旧到新。没见过的会话从 since 那一刻（秒）起。
    let offset =
      seen === null ? { id: 0, date: Math.floor(since / 1000) } : { id: seen + 1, date: 0 };
    for (let chatPages = 1; ; chatPages++) {
      const page = await tg.request("catch_up", { scope }, (c) =>
        c.getHistory(dialog.peer, { reverse: true, offset, limit: CATCH_UP_PAGE }),
      );
      pages++;
      const sorted = [...page].sort((a, b) => a.id - b.id);
      const missed = sorted.filter(
        (m) => (seen === null || m.id > seen) && m.date.getTime() >= since,
      );
      for (const msg of missed) receive(msg, tg.client);
      round.fetched += missed.length;
      const end = sorted.at(-1)?.id;
      // 这一页拉过了（包括她自己发的那几条）：下一页、下一轮从这里往后。
      if (end !== undefined) inbox.caughtUp(scope, end);
      if (end === undefined || page.length < CATCH_UP_PAGE || end >= last.id) break;
      if (chatPages >= CATCH_UP_PAGES_PER_CHAT || pages >= CATCH_UP_PAGES_PER_ROUND) {
        round.carried++;
        break;
      }
      offset = { id: end + 1, date: 0 };
    }
  }
  return round;
}
