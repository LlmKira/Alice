/**
 * 找群（登记表 chat-search，A18；2 月 search_public、preview_chat）：按关键词搜公开的群和频道，或者看一个
 * @用户名、t.me 链接（别人发来的邀请链接也行）指向的群。每个结果看一眼预览：简介、人数、最近几条（公开群和频道
 * 不加入也能看）。返回写给她看的一段话和结构化的结果（act.done 的 found），意愿层据此知道世界上有这些群。
 * 解析链接只是认格式，不判断语义。
 */
import { Chat, type tl } from "@mtcute/node";
import { foundText } from "../mechanisms/pressure/reach.js";
import type { FoundPlace } from "../mind/events.js";
import { optionalFact } from "./errors.js";
import type { Telegram } from "./gates.js";
import { inviteScope, scopeOf } from "./world-adapter.js";

/** 错误信息里的请求名。 */
const NAME = "search_chats";

/** 关键词搜索最多看几个结果的预览（每个预览两次请求）。 */
const SHOWN = 3;
const RECENT = 3;

const INVITE = /(?:t\.me|telegram\.me)\/(?:\+|joinchat\/)([\w-]+)/i;
const PUBLIC = /(?:t\.me|telegram\.me)\/([A-Za-z][\w]{3,31})(?:[/?#]|$)/i;
const HANDLE = /^@([A-Za-z][\w]{3,31})$/;

export interface Found {
  text: string;
  found: FoundPlace[];
}

function kindOf(chat: Chat): FoundPlace["kind"] | null {
  if (chat.chatType === "channel") return "channel";
  if (chat.chatType === "supergroup" || chat.chatType === "gigagroup" || chat.chatType === "group")
    return "group";
  return null;
}

/** 一个公开群或频道的预览：简介、人数、最近几条。简介和最近几条看不到就让它们缺着（中止、限流照抛）。 */
async function preview(tg: Telegram, chat: Chat): Promise<FoundPlace | null> {
  const kind = kindOf(chat);
  if (!kind) return null;
  const ref = chat.username ? `@${chat.username}` : chat.id;
  const full = await optionalFact(
    tg.signal,
    () => tg.request(NAME, { ref }, (c) => c.getFullChat(ref)),
    null,
  );
  const history = await optionalFact(
    tg.signal,
    () => tg.request(NAME, { ref }, (c) => c.getHistory(ref, { limit: RECENT })),
    null,
  );
  return {
    scope: scopeOf(chat.id),
    kind,
    title: chat.title,
    about: full?.bio || null,
    members: full?.membersCount ?? chat.membersCount ?? null,
    recent: history ? history.flatMap((m) => (m.text ? [m.text] : [])) : [],
  };
}

async function byInvite(tg: Telegram, hash: string): Promise<FoundPlace[]> {
  const invite = (await tg.request(NAME, { hash }, (c) =>
    c.call({ _: "messages.checkChatInvite", hash }),
  )) as tl.TypeChatInvite;
  if (invite._ === "chatInvite") {
    return [
      {
        scope: inviteScope(hash),
        kind: invite.broadcast ? "channel" : "group",
        title: invite.title,
        about: invite.about ?? null,
        members: invite.participantsCount,
        recent: [],
      },
    ];
  }
  const place = await preview(tg, new Chat(invite.chat));
  return place ? [place] : [];
}

async function byName(tg: Telegram, name: string): Promise<FoundPlace[]> {
  const chat = await tg.request(NAME, { name }, (c) => c.getChat(`@${name}`));
  const place = await preview(tg, chat);
  return place ? [place] : [];
}

async function byKeyword(tg: Telegram, q: string): Promise<FoundPlace[]> {
  const res = (await tg.request(NAME, { query: q }, (c) =>
    c.call({ _: "contacts.search", q, limit: 10 }),
  )) as tl.contacts.RawFound;
  const chats = res.chats
    .filter((c): c is tl.RawChannel => c._ === "channel" && Boolean(c.username))
    .map((c) => new Chat(c))
    .filter((c) => kindOf(c) !== null)
    .slice(0, SHOWN);
  const out: FoundPlace[] = [];
  for (const chat of chats) {
    const place = await preview(tg, chat);
    if (place) out.push(place);
  }
  return out;
}

/**
 * 她找群看到的东西。先用掉一次找群的额度；每个请求都过节流和错误分类（gates.ts）：确定没找成时抛
 * TelegramActionError（带错误码），其余错误是结果未知。
 */
export async function discover(tg: Telegram, query: string): Promise<Found> {
  tg.explore("search");
  const q = query.trim();
  const invite = q.match(INVITE)?.[1];
  const name = invite ? undefined : (q.match(PUBLIC)?.[1] ?? q.match(HANDLE)?.[1]);
  const found = invite
    ? await byInvite(tg, invite)
    : name
      ? await byName(tg, name)
      : await byKeyword(tg, q);
  return { text: foundText(q, found), found };
}
