/**
 * 这一次是什么叫醒她（候选 desire，PLAN 第 44 件）：意愿层排第一的那个意愿里，哪几股劲让它过了代价，写成一份有类型的
 * 原因，交给提示词写成没有视角的事实（卡片的"我这边"那一行，cause-lines.ts）。
 *
 * 哪几股算"叫醒她的"：这个会话里最好的意愿，把各驱动的缓解从大到小加起来，加到超过代价（λ·(社交代价 + 饱和代价)
 * 加手上的事）为止，前面这几股就是叫醒她的（缺了它们就醒不了）；都加上也不够时（等安静的那会儿劲头变了）只取最大的
 * 一股。没有手设的门槛：哪几股够格只看代价本身。
 * 另两样不是驱动：手里有想分享的东西（desire.ts 摆在她面前的那一件，这里没人在等她时才有）；刚闲下来（她做完一件事以后
 * 还没看过手机，life.ts）。
 * 句子见 cause-lines.ts；没有任何原因时什么都不写。
 */
import type { WillAffordance } from "./affordances.js";
import type { Cause } from "./cause-lines.js";
import { shownShare } from "./desire.js";
import type { DriveKey } from "./drives.js";
import { groupTheta } from "./drives.js";
import { prospectPressure } from "./memory.js";
import { placeOf } from "./place.js";
import { knownAbout } from "./recall.js";
import { nameOf, relationView } from "./relation.js";
import { intentionsFor, readChat, reliefTerms, type WillPolicy } from "./will.js";
import type { World } from "./world.js";

export type { Cause } from "./cause-lines.js";

/** 她做完一件事到现在不到这么久，还算刚闲下来（同 life.ts 写"我刚吃完饭"的窗口）。 */
const JUST_FREE = 20 * 60_000;
/** 一件写进提示词的事实截这么多字。 */
const ABOUT_CHARS = 40;

/** 叫醒她的那几股劲（从大到小）。 */
export function wakingDrives(
  world: World,
  affordances: readonly WillAffordance[],
  scope: string,
  now: number,
  policy: WillPolicy,
): DriveKey[] {
  const best = intentionsFor(world, affordances, scope, now, policy).reduce<
    ReturnType<typeof intentionsFor>[number] | null
  >((b, i) => (b === null || i.nsv > b.nsv ? i : b), null);
  const chat = world.chats[scope];
  const reading = readChat(world, scope, now, policy.tiers, policy.age, policy.drives);
  const row = affordances.find((a) => a.kind === best?.affordance);
  if (!best || !chat || !reading || !row) return [];
  const gain = policy.gain(world, reading, now);
  const terms = reliefTerms(chat, reading, row, now)
    .map(([k, v]) => [k, v * gain] as const)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  const cost = best.relief - best.nsv;
  const out: DriveKey[] = [];
  let sum = 0;
  for (const [k, v] of terms) {
    out.push(k);
    sum += v;
    if (sum > cost) return out;
  }
  return out.slice(0, 1);
}

/** 这一次叫醒她的原因。sought：有人在等她或她还在对话里（只写手里想分享的那一件，有的话）。 */
export function causesOf(
  world: World,
  affordances: readonly WillAffordance[],
  scope: string,
  now: number,
  policy: WillPolicy,
  sought: boolean,
): Cause[] {
  const chat = world.chats[scope];
  if (!chat) return [];
  const group = chat.chatType === "group";
  const item = shownShare(world, scope, now);
  const share: Cause[] = item
    ? [
        {
          kind: "share",
          id: item.id,
          title: item.title,
          body: item.body,
          group,
          ...(item.scope === "self:dream" ? { self: true as const } : {}),
        },
      ]
    : [];
  if (sought) return share;
  const reading = readChat(world, scope, now, policy.tiers, policy.age, policy.drives);
  const out: Cause[] = [];
  for (const k of wakingDrives(world, affordances, scope, now, policy)) {
    if (k === "attention" && group) {
      out.push({ kind: "unread", heavy: (reading?.normalized.attention ?? 0) >= 0.5 });
    } else if (k === "cooling" && group) {
      const since = Math.max(chat.lastBondAt, chat.lastAliceAt, chat.consideredAt);
      out.push({ kind: "absent", long: chat.lastIncomingAt - since > groupTheta(chat) });
    } else if ((k === "cooling" || k === "curiosity") && chat.partner) {
      out.push(person(world, scope, chat.chatType, chat.partner, false));
    } else if (k === "bond" && group) {
      const who = [...chat.recentFrom]
        .reverse()
        .find((id) => (relationView(world, id)?.lastBondAt ?? 0) > 0);
      if (who) out.push(person(world, scope, chat.chatType, who, true));
      out.push({ kind: "topic" });
    } else if (k === "prospect") {
      // 这股劲里最急的那一件（每件各自的 P_prospect）。
      const c = chat.commitments.open
        .map((x) => [x, prospectPressure([x], now)] as const)
        .filter(([, p]) => p > 0)
        .sort((a, b) => b[1] - a[1])[0]?.[0];
      if (c) {
        const origin = c.origin ? placeOf(world, c.origin.scope) : null;
        out.push({ kind: "promise", what: clip(c.text, ABOUT_CHARS), origin });
      }
    }
  }
  const done = world.life.done;
  const free =
    done !== null &&
    done.until <= now &&
    now - done.until <= JUST_FREE &&
    done.until > world.lastCallAt;
  const unique = out.filter((c, i) => out.findIndex((d) => d.kind === c.kind) === i);
  return [...share, ...unique, ...(free ? [{ kind: "free" } as const] : [])];
}

function person(
  world: World,
  scope: string,
  chatType: "private" | "group",
  id: string,
  seen: boolean,
): Cause {
  const name = nameOf(world, id) ?? "他";
  const fact = knownAbout(world, id, { scope, chatType }).at(-1)?.text ?? null;
  const about = fact ? clip(fact, ABOUT_CHARS) : null;
  return { kind: "person", name, about, seen };
}

function clip(text: string, max: number): string {
  const flat = text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[。.!！]+$/, "");
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : flat;
}
