/**
 * 她不在的时候别处发生了什么（2 月的 overnight briefing，`mods/strategy/hint-generators.ts@feb:463-607`）：
 * 她上一次看消息（做了决定、发了话）之后沉默超过一小时，或者中间睡过一觉，就在她此刻所在的会话里写一句：
 * 别的会话来了多少条、有几条是找她的（私聊、回复她、点名她）、这些还在等她回。
 * 2 月的门槛原样：一共不超过 5 条、又没人找她，就什么也不说；找她的排在前面。
 *
 * 写条数、谁私聊她、哪个群，不写内容。2026-11-13 之前名字也不写（2 月 ADR-56 的事故是在不相干的群里提到别处的人）；
 * 北极星不变量 1 收窄为只护托付的和明显私密的事以后，谁来找过她不算（PLAN 第 33 件）。此刻这个会话自己的消息
 * 就在时间线上，不算。
 */
import type { AliceEvent, ChatType } from "../mind/events.js";
import { defineMechanism } from "../mind/mechanism.js";
import type { PressureFeature } from "./pressure/feature.js";
import { awakeBetween } from "./pressure/sleep.js";

const MIN = 60_000;
const H = 60 * MIN;
/** 2 月：静默超过 3600 秒。 */
export const MISSED_SILENCE_MS = H;
/** 2 月：一共不超过这么多条、又没人找她，就不说。 */
const MISSED_QUIET = 5;

interface Missed {
  chatType: ChatType;
  total: number;
  directed: number;
  /** 私聊的对方、群名（入站消息带的；不知道群名时没有）。 */
  name?: string;
}

export interface MissedState {
  /** 她上一次看消息的时刻；从来没有过就是 null（2 月：没有行动记录就不出简报）。 */
  activeAt: number | null;
  /** 那之后每个会话来的消息。 */
  since: Readonly<Record<string, Missed>>;
}

export const initialMissed: MissedState = { activeAt: null, since: {} };

function hours(ms: number): string {
  const h = Math.round(ms / H);
  return h < 48 ? `${h} 小时` : `${Math.round(h / 24)} 天`;
}

/** 没有可说的就是 null。after：接在作息那句（刚睡醒、被吵醒）后面说，不再从"我"说起。 */
export function missedText(
  state: MissedState,
  here: string,
  now: number,
  after = false,
): string | null {
  if (state.activeAt === null) return null;
  const gap = now - state.activeAt;
  const slept = awakeBetween(state.activeAt, now) < gap;
  if (gap <= MISSED_SILENCE_MS && !slept) return null;
  const others = Object.entries(state.since)
    .filter(([scope]) => scope !== here)
    .map(([, m]) => m);
  const total = others.reduce((s, m) => s + m.total, 0);
  const directed = others.reduce((s, m) => s + m.directed, 0);
  if (total <= MISSED_QUIET && directed === 0) return null;

  const sum = (list: Missed[], key: "total" | "directed") => list.reduce((s, m) => s + m[key], 0);
  const privates = others.filter((m) => m.chatType === "private" && m.total > 0);
  const groups = others.filter((m) => m.chatType === "group");
  const called = groups.filter((m) => m.directed > 0);
  const quiet = groups.filter((m) => m.directed === 0 && m.total > 0);
  // 谁私聊、哪个群（PLAN 第 33 件：名字不再藏；名字都知道时才列）。
  const names = (list: Missed[], wrap: (n: string) => string) =>
    list.every((m) => m.name) ? list.map((m) => wrap(m.name as string)).join("、") : null;
  const groupsWhere = (list: Missed[]) => {
    const titles = names(list, (n) => `「${n}」`);
    if (list.length === 1) return titles ? `${titles}群` : "一个群";
    return `${list.length} 个群${titles ? `（${titles}）` : ""}`;
  };
  const parts: string[] = [];
  if (privates.length === 1) {
    parts.push(`${privates[0]?.name ?? "有人"}私聊我（${sum(privates, "total")} 条）`);
  } else if (privates.length > 1) {
    const who = names(privates, (n) => n);
    parts.push(
      `${privates.length} 个人私聊我（${who ? `${who}，` : ""}一共 ${sum(privates, "total")} 条）`,
    );
  }
  if (called.length > 0) {
    parts.push(
      `${groupsWhere(called)}里有 ${sum(called, "directed")} 条点名或回复我（${called.length === 1 ? "群里" : "这些群"}一共 ${sum(called, "total")} 条）`,
    );
  }
  if (quiet.length > 0) {
    parts.push(
      `${called.length > 0 ? "另外" : ""}${groupsWhere(quiet)}里聊了 ${sum(quiet, "total")} 条`,
    );
  }
  const me = after ? "" : "我";
  const lead = slept ? `${me}睡着的时候` : `${me}有 ${hours(gap)}没看消息，`;
  // 只写中性的事实，不写"你都还没回"：她在这里动不了别处，愧疚帧会让她把群当成待清的收件箱
  // （2 月 ADR-194 生产原话"赶紧处理完去找……"；谁找了她，前半句已经说了）。
  return `${lead}别的聊天里来了 ${total} 条：${parts.join("，")}。`;
}

export function reduceMissed(state: MissedState, event: AliceEvent): MissedState {
  // 看了一眼也是在看消息（候选 glance）：之后再说"你有几小时没看消息"就不对了。
  if (
    event.type === "speech.decided" ||
    event.type === "message.sent" ||
    event.type === "chat.glanced"
  ) {
    return { activeAt: Math.max(state.activeAt ?? event.at, event.at), since: {} };
  }
  if (event.type !== "message.received") return state;
  if (state.activeAt === null || event.at <= state.activeAt) return state;
  const was = state.since[event.scope] ?? { chatType: event.chatType, total: 0, directed: 0 };
  const name = event.chatType === "private" ? event.senderName : event.chatTitle;
  const now: Missed = {
    chatType: event.chatType,
    total: was.total + 1,
    directed: was.directed + (event.directed ? 1 : 0),
    ...(name ? { name } : {}),
  };
  return { ...state, since: { ...state.since, [event.scope]: now } };
}

/** 单独的机制（对照组 no-missed 之前的写法，仍在 allMechanisms）：自己一句，从"我"说起。 */
export const missed = defineMechanism<MissedState>({
  name: "missed",
  initial: initialMissed,
  reduce: reduceMissed,
  contribute(chat, now, state) {
    const text = missedText(state, chat.scope, now);
    return text ? [{ mechanism: "missed", kind: "state", text }] : [];
  },
});

/**
 * 生产：作息那一格带上错过了什么。刚睡醒、被吵醒和睡着时别处来了多少是同一件事，并成一句
 * （"我刚睡醒，睡着的时候别的聊天里来了 23 条：……"）；分开写时线上 10 次里 10 次两句都说一遍"睡着了"
 * （eval-artifacts/ablation-live/results.md）。作息那句没有时（醒了很久），照旧单独一句。状态折进世界（World.missed）。
 */
export function withMissed(sleep: PressureFeature): PressureFeature {
  return {
    ...sleep,
    provides: [...(sleep.provides ?? []), "missed"],
    reduce: (before, after, event) => {
      const w = sleep.reduce ? sleep.reduce(before, after, event) : after;
      const was = w.missed ?? initialMissed;
      const next = reduceMissed(was, event);
      return next === was ? w : { ...w, missed: next };
    },
    contribute: (ctx) => {
      const facts = sleep.contribute?.(ctx) ?? [];
      const [first, ...rest] = facts;
      const said = missedText(ctx.world.missed ?? initialMissed, ctx.chat.scope, ctx.now, !!first);
      if (!said) return facts;
      if (!first) return [{ mechanism: "missed", kind: "state", text: said }];
      return [{ ...first, text: `${first.text.replace(/。$/, "，")}${said}` }, ...rest];
    },
  };
}
