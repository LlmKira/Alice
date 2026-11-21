import { nameOf } from "./relation.js";
import type { World } from "./world.js";

/**
 * 别处知道的事的出处（PLAN 第 33 件："在 X 群听 Y 说的""Y 私聊里说的"）：群是「群名」群里，不知道群名时
 * "一个群里"；私聊是"和某人私聊时"。日记、她自己说过的事、关于人的事、心情的原因、想法都用它。
 */
export function placeOf(world: Pick<World, "chats" | "relations">, scope: string): string {
  const chat = world.chats[scope];
  if (chat?.chatType === "private") {
    const name = nameOf(world, chat.partner);
    return `和${name ?? "别人"}私聊时`;
  }
  return chat?.title ? `在「${chat.title}」群里` : "在一个群里";
}

/** 名字只比字：小写，去掉空白、标点和符号。 */
const bare = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");

/** 她写的地方去掉"去、在、和……"和"群里、的私聊、那边"这类说法，只留名字。 */
function nameIn(where: string): string {
  return bare(
    where
      .trim()
      .replace(/^(去|到|在|和|跟|给|找)+/u, "")
      .replace(/(的)?(私聊|群聊|群|那边|那里|这边|这里|里)+$/u, ""),
  );
}

/** 一方的名字包含另一方（太短的只认相等，一个字的名字不拿来包含）。 */
const named = (name: string, q: string) =>
  name !== "" &&
  q !== "" &&
  (name === q || (q.length >= 2 && (name.includes(q) || q.includes(name))));

/**
 * 她在 intend 里写的"在哪做"（群名或人名的原话）认成哪个会话：先按她写的去认群名、私聊对方的名字（写了"群"先认群），
 * 几个都对得上时取最近有人说话的那个；在私聊里只说了"群里"、没写哪个群时，是对方最近说过话、她也在的那个群。
 * 认不出、或就是这里时是 null（记在这里）。
 */
export function placeNamed(
  world: Pick<World, "chats" | "relations">,
  here: string,
  where: string,
): string | null {
  const q = nameIn(where);
  const groupFirst = /群/u.test(where);
  const latest = (scopes: string[]) =>
    scopes.sort((a, b) => (world.chats[b]?.lastAnyAt ?? 0) - (world.chats[a]?.lastAnyAt ?? 0))[0];
  const entries = Object.entries(world.chats).filter(([, c]) => c.member);
  const groups = entries
    .filter(([, c]) => c.chatType === "group" && c.title && named(bare(c.title), q))
    .map(([s]) => s);
  const people = entries
    .filter(([, c]) => c.chatType === "private" && named(bare(nameOf(world, c.partner) ?? ""), q))
    .map(([s]) => s);
  const found = groupFirst
    ? (latest(groups) ?? latest(people))
    : (latest(people) ?? latest(groups));
  const partner = world.chats[here]?.chatType === "private" ? world.chats[here]?.partner : null;
  const shared =
    !found && groupFirst && partner
      ? Object.entries(world.relations.people[partner]?.seen.rooms ?? {})
          .filter(([s]) => world.chats[s]?.member)
          .sort(([, a], [, b]) => b.lastAt - a.lastAt)[0]?.[0]
      : undefined;
  const scope = found ?? shared;
  return scope && scope !== here ? scope : null;
}
