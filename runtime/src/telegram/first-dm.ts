/**
 * 第一次私聊（A10）：她在群里认识、还没私聊过的人。Telegram 在群消息里只给对方的简版资料（mtcute 说的 min 用户），
 * 里面的访问凭证不能拿来发私聊。按 mtcute 的做法，发之前经过她和对方同在的群、指着对方在那里说过的一条消息
 * （inputUserFromMessage）向 Telegram 要完整的资料，拿到凭证再发。
 *
 * Acquaintances 是 Journal 的投影（和 shelf、album 一样）：只从写进了日志的事件更新，折叠和运行时看到的一样。
 */
import { MtPeerNotFoundError, type TelegramClient, tl } from "@mtcute/node";
import type { AliceEvent } from "../mind/events.js";
import { rpcOf, TelegramActionError } from "./errors.js";

const PREFIX = "telegram:";
/** 每个人记几个群（各记他在那里最后说的一条），最近见过的先试。 */
const GROUPS_KEPT = 3;

/** 会话 → Telegram 数字 id；不是 telegram:<整数> 的写法时为 null。 */
function idOf(scope: string): number | null {
  if (!scope.startsWith(PREFIX)) return null;
  const n = Number(scope.slice(PREFIX.length));
  return Number.isSafeInteger(n) && `${PREFIX}${n}` === scope ? n : null;
}

/** 经过一个群找到这个人：群和他在那里说过的一条消息。 */
export interface Route {
  chatId: number;
  messageId: number;
}

/** 她在哪些群里见过谁说话（在哪条消息里），和哪些人已经有过私聊来往（收到过或发出过私聊消息）。 */
export class Acquaintances {
  /** 人 → 群 → 他在那里最后说的一条；Map 的插入顺序就是新旧，最新的在后。 */
  private readonly seen = new Map<number, Map<number, number>>();
  private readonly opened = new Set<number>();

  observe(event: AliceEvent): void {
    if (event.type === "message.received") {
      const chat = idOf(event.scope);
      if (chat === null) return;
      if (event.chatType === "private") {
        this.opened.add(chat);
        return;
      }
      const user = Number(event.senderId);
      const message = Number(event.messageId);
      if (!Number.isSafeInteger(user) || user <= 0 || !Number.isSafeInteger(message)) return;
      const groups = this.seen.get(user) ?? new Map<number, number>();
      groups.delete(chat);
      groups.set(chat, message);
      for (const old of [...groups.keys()].slice(0, Math.max(0, groups.size - GROUPS_KEPT))) {
        groups.delete(old);
      }
      this.seen.set(user, groups);
      return;
    }
    if (event.type === "message.sent") {
      const chat = idOf(event.scope);
      if (chat !== null && chat > 0) this.opened.add(chat);
      return;
    }
    // 她不在那个群里了：经过它找不到人。
    if (event.type === "membership.changed" && !event.member) {
      const chat = idOf(event.scope);
      if (chat !== null) for (const groups of this.seen.values()) groups.delete(chat);
    }
  }

  /** 发往 chatId 是第一次私聊：对方是人（Telegram 的用户 id 是正数），还没有过私聊来往。 */
  isFirstDm(chatId: number): boolean {
    return chatId > 0 && !this.opened.has(chatId);
  }

  /** 能经过哪些群找到这个人，最近见过的在前。 */
  routes(userId: number): Route[] {
    const groups = [...(this.seen.get(userId) ?? new Map<number, number>())];
    return groups.reverse().map(([chatId, messageId]) => ({ chatId, messageId }));
  }
}

/** 这条路走不通（找不到这个群、这条消息、这个人），换下一条；限流、网络这类错误不是，照原样抛。 */
function deadEnd(error: unknown): boolean {
  if (error instanceof MtPeerNotFoundError) return true;
  return tl.RpcError.is(error) && (error.code === 400 || error.code === 403);
}

/** mtcute 解析出来的人 → users.getUsers 要的写法。 */
function inputUserOf(peer: tl.TypeInputPeer): tl.TypeInputUser | null {
  switch (peer._) {
    case "inputPeerUser":
      return { _: "inputUser", userId: peer.userId, accessHash: peer.accessHash };
    case "inputPeerUserFromMessage":
      return {
        _: "inputUserFromMessage",
        peer: peer.peer,
        msgId: peer.msgId,
        userId: peer.userId,
      };
    default:
      return null;
  }
}

/**
 * 拿到对方的访问凭证再发：先经共同的群（最近见过的在前），最后试 mtcute 自己存着的（对方以前在别处出现过、
 * 或者是联系人）。Telegram 回的完整资料由 mtcute 顺手存下。都不行就是带类型的失败 peer_unreachable：
 * 照实，没有路可走，什么也没发出去。
 */
export async function reachUser(
  client: TelegramClient,
  userId: number,
  routes: readonly Route[],
  signal: AbortSignal,
): Promise<tl.RawInputPeerUser> {
  const candidates: Array<() => Promise<tl.TypeInputUser | null>> = [
    ...routes.map((r) => async () => ({
      _: "inputUserFromMessage" as const,
      peer: await client.resolvePeer(r.chatId),
      msgId: r.messageId,
      userId,
    })),
    async () => inputUserOf(await client.resolvePeer(userId)),
  ];
  let rpc: string | undefined;
  for (const candidate of candidates) {
    signal.throwIfAborted();
    try {
      const input = await candidate();
      if (!input) continue;
      const [user] = await client.call(
        { _: "users.getUsers", id: [input] },
        { abortSignal: signal },
      );
      if (user?._ === "user" && !user.min && user.accessHash) {
        return { _: "inputPeerUser", userId, accessHash: user.accessHash };
      }
    } catch (error) {
      if (!deadEnd(error)) throw error;
      rpc = rpcOf(error) ?? rpc;
    }
  }
  throw new TelegramActionError(
    "peer_unreachable",
    `no shared group to reach user ${userId}`,
    { userId: String(userId), routes: routes.length },
    rpc ? { rpc } : {},
  );
}

/** 对方不收她私聊的回答：隐私设置；或者已经拿到了凭证，Telegram 仍说没有这个人。 */
export function closesDm(error: unknown, resolved: boolean): boolean {
  return (
    tl.RpcError.is(error, "USER_PRIVACY_RESTRICTED") ||
    tl.RpcError.is(error, "PRIVACY_PREMIUM_REQUIRED") ||
    (resolved && tl.RpcError.is(error, "PEER_ID_INVALID"))
  );
}
