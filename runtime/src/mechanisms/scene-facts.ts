import { type ActKind, affordances, type PostKind } from "../mind/affordances.js";
import type { AliceEvent, ChatDescribed, Reacted } from "../mind/events.js";
import { type Contribution, defineMechanism, type MessageMarks } from "../mind/mechanism.js";
import type { ChatState } from "../mind/state.js";

/**
 * 聊天现场的客观事实（候选，PLAN 第 55 件第 4 项；Gemini 补查报告第 4、5 条）：2 月她看得到、后来看不到的那些
 * 聊天平台上谁都看得见的东西。
 * - 每条消息上的表情反应和人数（前 TOP_REACTIONS 种）、改过、转发自谁、贴纸是哪一套：写在那一行里（kind marks）；
 * - 群有多少人、谁是群主、记录里说话的人谁是管理员（头衔）：群聊卡片里一行；
 * - 这个群不让她发的那几种消息：对应的动作这一轮不给（withholds），她连字都发不了时写一句事实。
 * 只写事实，不写该怎么回应。都从 Journal fold（message.received 的字段、message.updated、chat.described）。
 */

/** 每条消息写几种表情（2 月同样是前 3 种）。 */
const TOP_REACTIONS = 3;
/** 记录里的管理员最多写几个。 */
const ADMINS_SHOWN = 5;
/** 每个会话记住多少条有事实的消息（时间线 30 条，加上带回来的更早的话，够用）。手设。 */
const KEPT = 200;

interface Room {
  members: number | null;
  admins: ChatDescribed["admins"];
  banned: readonly PostKind[];
}

export interface SceneState {
  /** 每个会话里有事实的消息，按先后（最多 KEPT 条）。 */
  marks: Readonly<Record<string, ReadonlyArray<readonly [string, MessageMarks]>>>;
  rooms: Readonly<Record<string, Room>>;
}

const top = (reactions: readonly Reacted[]): MessageMarks["reactions"] =>
  [...reactions]
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_REACTIONS)
    .map((r) => ({ emoji: r.emoji, count: r.count }));

function mark(state: SceneState, scope: string, id: string, f: (m: MessageMarks) => MessageMarks) {
  const list = state.marks[scope] ?? [];
  const old = list.find(([k]) => k === id)?.[1] ?? {};
  const next = f(old);
  const kept = [...list.filter(([k]) => k !== id), [id, next] as const].slice(-KEPT);
  return { ...state, marks: { ...state.marks, [scope]: kept } };
}

function reduce(state: SceneState, event: AliceEvent): SceneState {
  switch (event.type) {
    case "message.received": {
      const reactions = event.reactions ? top(event.reactions) : undefined;
      const facts: MessageMarks = {
        ...(event.forwardedFrom ? { forwardedFrom: event.forwardedFrom } : {}),
        ...(event.stickerSet ? { stickerSet: event.stickerSet } : {}),
        ...(event.edited ? { edited: true as const } : {}),
        ...(reactions !== undefined && reactions.length > 0 ? { reactions } : {}),
      };
      if (Object.keys(facts).length === 0) return state;
      return mark(state, event.scope, event.messageId, () => facts);
    }
    case "message.updated":
      return mark(state, event.scope, event.messageId, (m) => {
        const next: MessageMarks = { ...m };
        if (event.text !== undefined) {
          next.text = event.text;
          next.edited = true;
        }
        if (event.edited) next.edited = true;
        if (event.stickerSet) next.stickerSet = event.stickerSet;
        if (event.reactions) {
          const r = top(event.reactions);
          if (r !== undefined && r.length > 0) next.reactions = r;
          else delete next.reactions;
        }
        return next;
      });
    case "chat.described":
      return {
        ...state,
        rooms: {
          ...state.rooms,
          [event.scope]: { members: event.members, admins: event.admins, banned: event.banned },
        },
      };
    default:
      return state;
  }
}

/** 群卡片里的那一行：人数、群主，记录里说话的人里谁是管理员。名字用记录里的写法。 */
function roomLine(chat: ChatState, room: Room): string | null {
  const shownName = new Map(
    chat.timeline.flatMap((e) => (e.sender ? [[e.sender.id, e.sender.name] as const] : [])),
  );
  const who = (a: Room["admins"][number]) =>
    `${shownName.get(a.id) ?? a.name}${a.title ? `「${a.title}」` : ""}`;
  const owner = room.admins.find((a) => a.role === "owner");
  const admins = room.admins
    .filter((a) => a.role === "admin" && shownName.has(a.id))
    .slice(0, ADMINS_SHOWN);
  const parts = [
    (room.members ?? 0) > 0 ? `${room.members} 人` : "",
    owner ? `群主 ${who(owner)}` : "",
    admins.length ? `管理员 ${admins.map(who).join("、")}` : "",
  ].filter(Boolean);
  const said = parts.length ? `这个群：${parts.join("，")}。` : "";
  const mute = room.banned.includes("text") ? "你现在在这个群里发不了言。" : "";
  return said + mute || null;
}

/** 禁发的消息种类对应的动作（发言提示和意愿层读同一个，ADR-276）。 */
export function withheldBy(banned: readonly PostKind[] | undefined): readonly ActKind[] {
  if (banned === undefined || banned.length === 0) return [];
  return affordances.filter((a) => a.posts && banned.includes(a.posts.as)).map((a) => a.kind);
}

export const sceneFacts = defineMechanism<SceneState>({
  name: "scene-facts",
  initial: { marks: {}, rooms: {} },
  reduce,
  contribute(chat, _now, state): Contribution[] {
    const out: Contribution[] = [];
    const room = chat.chatType === "group" ? state.rooms[chat.scope] : undefined;
    const line = room ? roomLine(chat, room) : null;
    if (line) out.push({ mechanism: "scene-facts", kind: "scene", text: line });
    const marks = state.marks[chat.scope];
    if (marks !== undefined && marks.length > 0) {
      out.push({
        mechanism: "scene-facts",
        kind: "marks",
        text: "",
        marks: Object.fromEntries(marks),
      });
    }
    return out;
  },
  withholds(chat, _now, state): readonly ActKind[] {
    const banned = chat.chatType === "group" ? state.rooms[chat.scope]?.banned : undefined;
    return withheldBy(banned);
  },
});
