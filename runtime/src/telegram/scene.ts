/**
 * 聊天现场的客观事实从 Telegram 进来的那一半（mechanisms/scene-facts.ts 是读它们的那一半）：
 * - 贴纸那套的标题：按套查一次（getStickerSet），记在内存里；
 * - 群的样子：人数、群主和管理员（头衔）、她在这里发不了的消息种类；一个群有消息进来、上次查过超过 ROOM_REFRESH_MS 时查，
 *   和 Journal 里最后一份不同才写 chat.described；
 * - 表情反应的合计：Telegram 只推送她自己那几条上的（线上 24 次里 23 次），别人消息上的要自己拉（messages.getMessagesReactions，
 *   官方客户端对眼前的消息也是这样拉）。每轮对话轮询之后，对最近 ACTIVE_MS 里有人说话的群拉最近 REACTION_IDS 条，
 *   和上次知道的不同才写 message.updated。
 * 只取群里每个人都看得到的东西。都经 Telegram（gates.ts）的全局节流。
 */
import { getMarkedPeerId, type TelegramClient, type tl } from "@mtcute/node";
import type { PostKind } from "../mind/affordances.js";
import type { AliceEvent, ChatDescribed, MessageUpdated, Reacted } from "../mind/events.js";
import { createLogger } from "../utils/logger.js";
import { optionalFact } from "./errors.js";
import type { Telegram } from "./gates.js";
import { chatIdOf, scopeOf } from "./world-adapter.js";

const log = createLogger("scene");

/** 群的样子多久重查一次。手设。 */
export const ROOM_REFRESH_MS = 6 * 3_600_000;
/** 拉表情合计的群：最近这么久里有人说话的。 */
export const ACTIVE_MS = 30 * 60_000;
/** 每个群拉最近几条（她的记录是 30 条）。 */
const REACTION_IDS = 30;
/** 一轮最多拉几个群。 */
const REACTION_CHATS = 8;

/** Telegram 消息上的表情合计：只留普通 emoji（自定义表情、付费的星星不写）。 */
export function reactedOf(results: readonly tl.TypeReactionCount[] | undefined): Reacted[] {
  return (results ?? []).flatMap((r) =>
    r.reaction._ === "reactionEmoji" ? [{ emoji: r.reaction.emoticon, count: r.count }] : [],
  );
}

const signature = (r: readonly Reacted[]) =>
  [...r]
    .sort((a, b) => a.emoji.localeCompare(b.emoji))
    .map((x) => `${x.emoji}${x.count}`)
    .join(",");

/**
 * 外壳对每条消息、每个群知道的最后的样子（从 Journal 恢复，写进去的才算）：用来只写变了的，以及该拉哪些群的哪几条。
 */
export class Scene {
  private readonly reactions = new Map<string, string>();
  private readonly texts = new Map<string, string | null>();
  private readonly rooms = new Map<string, string>();
  private readonly checked = new Map<string, number>();
  /** 每个群最近的消息编号和最后一条的时刻。 */
  private readonly recent = new Map<string, { ids: number[]; at: number }>();
  private readonly titles = new Map<string, string>();
  /** 查标题失败过的套：同一套只报一次（失败不缓存空标题，下一条带这套的消息还会再试）。 */
  private readonly titleFailed = new Set<string>();
  private readonly pending = new Set<string>();

  observe(event: AliceEvent): void {
    const key = "messageId" in event ? `${event.scope}|${event.messageId}` : null;
    switch (event.type) {
      case "message.received": {
        if (!key) return;
        this.texts.set(key, event.text);
        if (event.reactions) this.reactions.set(key, signature(event.reactions));
        if (event.chatType === "group")
          this.noteGroupMessage(event.scope, event.messageId, event.at);
        return;
      }
      case "message.updated":
        if (!key) return;
        if (event.text !== undefined) this.texts.set(key, event.text);
        if (event.reactions) this.reactions.set(key, signature(event.reactions));
        return;
      case "chat.described":
        this.rooms.set(event.scope, roomSignature(event));
        return;
      default:
        return;
    }
  }

  /** 记下群里最近的消息编号（拉表情用）和最后一条的时刻。 */
  private noteGroupMessage(scope: string, messageId: string, at: number): void {
    const r = this.recent.get(scope) ?? { ids: [], at: 0 };
    const n = Number(messageId);
    if (Number.isSafeInteger(n)) r.ids = [...r.ids, n].slice(-REACTION_IDS);
    r.at = at;
    this.recent.set(scope, r);
  }

  /** 一条消息后来的样子里和上次知道的不同的那几样；都没变时为 null。 */
  changes(
    scope: string,
    messageId: string,
    seen: { text?: string | null; edited?: boolean; reactions?: readonly Reacted[] },
    at: number,
  ): MessageUpdated | null {
    const key = `${scope}|${messageId}`;
    const update: MessageUpdated = { type: "message.updated", at, scope, messageId };
    if (seen.text !== undefined && this.texts.has(key) && this.texts.get(key) !== seen.text) {
      update.text = seen.text;
    }
    if (seen.edited && update.text !== undefined) update.edited = true;
    if (seen.reactions && (this.reactions.get(key) ?? "") !== signature(seen.reactions)) {
      update.reactions = seen.reactions;
    }
    return update.text !== undefined || update.reactions ? update : null;
  }

  /** 贴纸那套的标题：查过的直接给；没查过的去查，查到了交给 found（同一套只查一次）。 */
  stickerSet(
    tg: Telegram,
    set: tl.TypeInputStickerSet | null,
    found: (title: string) => void,
  ): string | undefined {
    if (!set || set._ !== "inputStickerSetID") return undefined;
    const id = String(set.id);
    const title = this.titles.get(id);
    if (title !== undefined) return title || undefined;
    if (this.pending.has(id)) return undefined;
    this.pending.add(id);
    void tg
      .request("sticker_set", { id }, (c) => c.getStickerSet(set))
      .then((s) => {
        this.titles.set(id, s.title);
        if (s.title) found(s.title);
      })
      .catch((error: unknown) => {
        // 查不到就先缺着：不缓存空标题（缓存了这套就永远是空的），下一条带这套的消息再试；
        // 同一套只报一次（别让一个查不到的套把错误日志刷满），停机中止不算失败、不记。
        if (tg.signal.aborted || this.titleFailed.has(id)) return;
        this.titleFailed.add(id);
        log.warn("Sticker set title failed", error);
      })
      .finally(() => this.pending.delete(id));
    return undefined;
  }

  /** 这个群该不该重查（并记下这次查了）。 */
  roomDue(scope: string, now: number): boolean {
    const last = this.checked.get(scope);
    if (last !== undefined && now - last < ROOM_REFRESH_MS) return false;
    this.checked.set(scope, now);
    return true;
  }

  /** 查到的群的样子和 Journal 里最后一份不同时才写。 */
  roomChanged(event: ChatDescribed): boolean {
    return this.rooms.get(event.scope) !== roomSignature(event);
  }

  /** 该拉表情合计的群和编号：最近 ACTIVE_MS 里有人说话的，最近的先。 */
  activeRooms(now: number): Array<{ scope: string; ids: number[] }> {
    return [...this.recent.entries()]
      .filter(([, r]) => now - r.at <= ACTIVE_MS && r.ids.length > 0)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, REACTION_CHATS)
      .map(([scope, r]) => ({ scope, ids: r.ids }));
  }
}

function roomSignature(e: Pick<ChatDescribed, "members" | "admins" | "banned">): string {
  return JSON.stringify([e.members, e.admins, [...e.banned].sort()]);
}

/** 她自己的发送权限 → 她在这里发不了的消息种类（群主、管理员不受群的禁发限制）。 */
function bannedOf(chat: Awaited<ReturnType<TelegramClient["getChat"]>>): PostKind[] {
  if (chat.isCreator || chat.isAdmin) return [];
  const p = chat.permissions ?? chat.defaultPermissions;
  if (!p) return [];
  const out: PostKind[] = [];
  if (!p.canSendText || !p.canSendMessages) out.push("text", "forward");
  if (!p.canSendStickers) out.push("sticker");
  if (!p.canSendPhotos) out.push("photo");
  if (!p.canSendVoices) out.push("voice");
  return out;
}

/**
 * 查一个群此刻的样子。人数先看 getChat，没有再看 getFullChat；管理员列表要不到（有的群对普通成员藏着）时只写别的。
 * 机器人管理员不写（群管、签到）。不是群时为 null。中止、限流、被拒照抛（optionalFact）。
 */
export async function describeRoom(
  tg: Telegram,
  scope: string,
  at: () => number,
): Promise<ChatDescribed | null> {
  const id = chatIdOf(scope);
  const chat = await tg.request("get_chat", { scope }, (c) => c.getChat(id));
  if (chat.chatType !== "group" && chat.chatType !== "supergroup") return null;
  const members =
    chat.membersCount ??
    (await optionalFact(
      tg.signal,
      () =>
        tg
          .request("get_full_chat", { scope }, (c) => c.getFullChat(id))
          .then((f) => f.membersCount),
      null,
    ));
  const admins = await optionalFact(
    tg.signal,
    () =>
      tg
        .request("get_admins", { scope }, (c) => c.getChatMembers(id, { type: "admins" }))
        .then((list) =>
          list.flatMap((m) =>
            m.user.isBot || (m.status !== "creator" && m.status !== "admin")
              ? []
              : [
                  {
                    id: String(m.user.id),
                    name: m.user.displayName,
                    role: m.status === "creator" ? ("owner" as const) : ("admin" as const),
                    ...(m.title ? { title: m.title } : {}),
                  },
                ],
          ),
        ),
    [],
  );
  return {
    type: "chat.described",
    at: at(),
    scope,
    members: members ?? null,
    admins,
    banned: bannedOf(chat),
  };
}

/** 拉一个群最近几条的表情合计（getMessagesReactions 的回复里每条消息一项 updateMessageReactions）。 */
export async function pullReactions(
  tg: Telegram,
  scope: string,
  ids: readonly number[],
): Promise<Array<{ messageId: string; reactions: Reacted[] }>> {
  const id = chatIdOf(scope);
  const res = await tg.request("get_reactions", { scope }, async (c) =>
    c.call({ _: "messages.getMessagesReactions", peer: await c.resolvePeer(id), id: [...ids] }),
  );
  const updates = "updates" in res ? res.updates : [];
  return updates.flatMap((u) =>
    u._ === "updateMessageReactions" && scopeOf(getMarkedPeerId(u.peer)) === scope
      ? [{ messageId: String(u.msgId), reactions: reactedOf(u.reactions.results) }]
      : [],
  );
}
