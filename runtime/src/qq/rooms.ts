/**
 * QQ 群的公开资料（人数、群主和管理员、她在这里是否被禁言）：从 Journal 里最近一条 chat.described 算出，
 * 另外记着禁言到什么时候。资料有变化时才写新的一条。
 */
import type { PostKind } from "../mind/affordances.js";
import type { AliceEvent, ChatDescribed } from "../mind/events.js";

/** 群资料多久重查一次（和 Telegram 的 scene.ts 相同）。手设。 */
const ROOM_REFRESH_MS = 6 * 3_600_000;
/** 被禁言时她在这里发不了的消息种类：所有种类。 */
const ALL_KINDS: readonly PostKind[] = ["text", "forward", "sticker", "photo", "voice"];

type Room = Pick<ChatDescribed, "members" | "admins" | "banned">;

const signature = (r: Room) => JSON.stringify([r.members, r.admins, [...r.banned].sort()]);

export class Rooms {
  private readonly last = new Map<string, Room>();
  private readonly checked = new Map<string, number>();
  private readonly bannedUntil = new Map<string, number>();

  observe(event: AliceEvent): void {
    if (event.type !== "chat.described") return;
    this.last.set(event.scope, {
      members: event.members,
      admins: event.admins,
      banned: event.banned,
    });
  }

  /** 这个群是否该重查（从没查过、距上次超过 ROOM_REFRESH_MS，或禁言已到期）；该查时记下这次的时间。 */
  due(scope: string, now: number): boolean {
    const last = this.checked.get(scope);
    const until = this.bannedUntil.get(scope);
    const expired =
      until !== undefined && until <= now && (this.last.get(scope)?.banned.length ?? 0) > 0;
    if (!expired && last !== undefined && now - last < ROOM_REFRESH_MS) return false;
    this.checked.set(scope, now);
    if (expired) this.bannedUntil.delete(scope);
    return true;
  }

  /** 禁言状态变了（until 为 null 表示解除）：返回新的群资料；和上次相同时返回 null。 */
  banChanged(scope: string, until: number | null, at: number): ChatDescribed | null {
    if (until === null) this.bannedUntil.delete(scope);
    else this.bannedUntil.set(scope, until);
    const base = this.last.get(scope) ?? { members: null, admins: [] };
    return this.changed(
      scope,
      { ...base, banned: until !== null && until > at ? ALL_KINDS : [] },
      at,
    );
  }

  /** 刚查到的群资料（bannedUntil 是她被禁言到什么时候，没被禁言为 null）：和上次不同时才返回。 */
  described(
    scope: string,
    facts: Pick<ChatDescribed, "members" | "admins"> & { bannedUntil: number | null },
    at: number,
  ): ChatDescribed | null {
    const kept = this.bannedUntil.get(scope);
    const until = Math.max(facts.bannedUntil ?? 0, kept ?? 0);
    const banned = until > at ? ALL_KINDS : [];
    return this.changed(scope, { members: facts.members, admins: facts.admins, banned }, at);
  }

  private changed(scope: string, room: Room, at: number): ChatDescribed | null {
    const before = this.last.get(scope);
    if (before && signature(before) === signature(room)) return null;
    return { type: "chat.described", at, scope, ...room };
  }
}
