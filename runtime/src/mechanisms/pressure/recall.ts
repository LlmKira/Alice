/**
 * 她开口时想得起来的东西，写成事实放进提示词（软引导：只陈述，不指挥）：
 * 关于在场的人她记得什么、她在这里答应过什么、她最近几次在这里开口的结果（心情那一行在 affect.ts）。
 * 只写在场的人（私聊的对方；群里时间线上最近说话的人）和这个会话里的承诺；别处知道的事注明出处，
 * 让她自己掂量能不能在这里说。
 */
import { type ActKind, isSilent } from "../../mind/affordances.js";
import type { AliceEvent } from "../../mind/events.js";
import type { Contribution, PersonNote } from "../../mind/mechanism.js";
import { type ChatState, onTimeline } from "../../mind/state.js";
import { dayDistance, elapsed, localClock } from "../../mind/when.js";
import { reaches } from "./diary.js";
import { feature, type PressureFeature, type View } from "./feature.js";
import type { LifeBodyState } from "./life-body.js";
import {
  advanceTopic,
  type ClosedCommitment,
  type Commitment,
  chatSubject,
  closeTopic,
  consider,
  expire,
  type Fact,
  fulfil,
  intend,
  makeCommitment,
  openTopic,
  rang,
  ringing,
  salient,
  shownTopics,
} from "./memory.js";
import { type MemoryRecord, projectMemoryStream } from "./memory-stream.js";
import {
  EXPIRED_SHOWN,
  FACTS_SHOWN,
  OUTCOMES_SHOWN,
  PEOPLE_SHOWN,
  PROSPECT_ALARM,
  TOPIC_BEAT_CHARS,
  TOPIC_TITLE_CHARS,
} from "./params.js";
import { placeNamed, placeOf } from "./place.js";
import { nameOf } from "./relation.js";
import { type ChatNode, isSolicited, put, type Reception } from "./world.js";

const D = 24 * 3_600_000;

/** 在场的人：私聊的对方；群里时间线上最近说话的几个人（最近的在前）。 */
function present(
  world: View<"relations">,
  chat: ChatState,
  node: ChatNode | undefined,
): Array<{ id: string; name: string }> {
  const people = new Map<string, string>();
  for (const t of [...chat.timeline].reverse()) {
    if (t.sender && !people.has(t.sender.id)) people.set(t.sender.id, t.sender.name);
  }
  if (chat.chatType === "private" && node?.partner) {
    const name = people.get(node.partner) ?? nameOf(world, node.partner) ?? "对方";
    return [{ id: node.partner, name }];
  }
  return [...people].slice(0, PEOPLE_SHOWN).map(([id, name]) => ({ id, name }));
}

/** 别处知道的事注明出处（"在「X」群里知道的""和 Y 私聊时知道的"）。 */
function source(world: View<"chats" | "relations">, scope: string, here: string): string {
  return scope === here ? "" : `${placeOf(world, scope)}知道的`;
}

/**
 * 关于一个人她记得的事，在这个会话里看得见哪些（diary.ts reaches，北极星不变量 1）：标了私密的只在知道它的会话、
 * 和与当时在场的人的私聊里；其余的哪里都看得见，注明出处。关于谁的事只在那个人在场时放（factsFact）。
 */
export function knownAbout(
  world: View<"facts" | "chats">,
  subject: string,
  chat: Pick<ChatState, "scope" | "chatType">,
): Fact[] {
  const node = world.chats[chat.scope];
  const here = {
    scope: chat.scope,
    group: chat.chatType === "group",
    target: chat.chatType === "group" ? null : (node?.partner ?? subject),
    onTimeline: () => false,
  };
  return (world.facts[subject] ?? []).filter((f) =>
    reaches(
      {
        scope: f.scope,
        group: world.chats[f.scope]?.chatType === "group",
        present: f.origin.present,
        private: f.origin.private === true,
      },
      here,
    ),
  );
}

/** 有时间的事：认得出时间的写离今天几天、过没过；认不出的写他哪天说的原话。 */
function whenNote(when: { said: string; at: number; due: number | null }, now: number): string {
  if (when.due === null) return `${elapsed(now - when.at)}前说的"${when.said}"`;
  const days = dayDistance(when.due, now);
  if (now <= when.due) {
    return days <= 0 ? "就在今天" : days === 1 ? "明天" : days === 2 ? "后天" : `${days} 天后`;
  }
  return days >= 0 ? "今天，已经过了" : days === -1 ? "昨天，已经过了" : `${-days} 天前，已经过了`;
}

function factLine(
  world: View<"chats" | "relations">,
  f: Fact,
  chat: ChatState,
  now: number,
): string {
  const when = f.origin.when;
  const old = now - f.lastAt > 7 * D && !when ? `${elapsed(now - f.lastAt)}前` : "";
  const where = source(world, f.scope, chat.scope);
  const note = [when ? whenNote(when, now) : "", old, where].filter(Boolean);
  return `${f.text}${note.length ? `（${note.join("，")}）` : ""}`;
}

function factLines(
  world: View<"facts" | "chats" | "relations">,
  subject: string,
  chat: ChatState,
  now: number,
  limit: number,
) {
  return salient(knownAbout(world, subject, chat), now)
    .slice(0, limit)
    .map((f) => factLine(world, f, chat, now));
}

/** 她记得的关于在场的人（和这个群）的事：一段文字，同样的事也按人给出（发言层可以并到那个人名下）。 */
function factsFact(
  world: View<"facts" | "chats" | "relations">,
  chat: ChatState,
  node: ChatNode | undefined,
  now: number,
): Contribution | null {
  const people = present(world, chat, node);
  const fact = (text: string, notes: PersonNote[]): Contribution => ({
    mechanism: "pressure-memory",
    kind: "people",
    text,
    people: notes,
  });
  if (chat.chatType === "private") {
    const who = people[0];
    if (!who) return null;
    const lines = factLines(world, who.id, chat, now, FACTS_SHOWN.private);
    return lines.length
      ? fact(`我记得关于${who.name}的事：\n${lines.map((l) => `- ${l}`).join("\n")}`, [
          { ...who, facts: lines },
        ])
      : null;
  }
  const lines: string[] = [];
  const notes: PersonNote[] = [];
  for (const p of people) {
    const facts = factLines(world, p.id, chat, now, FACTS_SHOWN.group);
    for (const l of facts) lines.push(`- ${p.name}：${l}`);
    if (facts.length) notes.push({ ...p, facts });
  }
  const subject = chatSubject(chat.scope);
  const group = factLines(world, subject, chat, now, FACTS_SHOWN.group);
  for (const l of group) lines.push(`- 这个群：${l}`);
  if (group.length) notes.push({ id: subject, name: "这个群", facts: group });
  return lines.length ? fact(`我记得：\n${lines.join("\n")}`, notes) : null;
}

function dueText(c: Commitment, now: number): string {
  // 去别处做、没说时间的事有一个"接下来这一会儿"的窗（memory.ts makeCommitment），但约定里没有时间。
  if (c.due === null || c.when === null) return `没说什么时候，${elapsed(now - c.madeAt)}前记下的`;
  if (now >= c.due) {
    // 说了钟点的事刚到点（闹钟响的那一会儿）：是"到时间了"，不是错过了。
    return c.precise && now - c.due < PROSPECT_ALARM ? "到时间了" : "约好的时间已经过了";
  }
  const days = dayDistance(c.due, now);
  const day = days === 0 ? "今天" : days === 1 ? "明天" : days === 2 ? "后天" : `${days} 天后`;
  return `约在${day}${c.precise ? ` ${localClock(c.due)}` : ""}`;
}

/**
 * 过了宽限还没说做完的：已经结算的，加上已过期但还没被结算的（结算只在这个会话有事件时发生）。
 * 没说时间的打算过了寿命只是淡忘；被更新的挤掉的（closedAt 早于 expireAt）也不算失约。
 */
function lapsedIn(node: ChatNode, now: number): ClosedCommitment[] {
  return [
    ...node.commitments.closed.filter((c) => c.outcome === "expired"),
    ...node.commitments.open
      .filter((c) => c.expireAt <= now)
      .map((c): ClosedCommitment => ({ ...c, outcome: "expired", closedAt: c.expireAt })),
  ].filter((c) => c.due !== null && c.closedAt >= c.expireAt && now - c.closedAt < EXPIRED_SHOWN);
}

/** 措辞只陈述她没记下做完，不断言没做（她可能做了忘了记）；没约时间的不说"约的时间过了"。 */
const lapsedText = (c: Commitment) =>
  c.when === null ? "我没记下做完" : "约的时间过了，我没记下做完";

/**
 * 她要在这里做的事。在别处定下、来这里做的，写明在哪定下的（出处用 placeOf），标题也换成"在这里做"
 * （Gemini 写的原文，out-cross-intent.md 第二段）；全是在这里定下的，照旧。
 */
function commitmentsText(
  world: View<"chats" | "relations">,
  node: ChatNode | undefined,
  now: number,
): string | null {
  if (!node) return null;
  const open = node.commitments.open.filter((c) => c.expireAt > now);
  const lapsed = lapsedIn(node, now);
  const from = (c: Commitment) => (c.origin ? `${placeOf(world, c.origin.scope)}定下的，` : "");
  const lines = [
    ...open.map((c) => `- ${c.text}（${from(c)}${dueText(c, now)}）`),
    ...lapsed.map((c) => `- ${c.text}（${from(c)}${lapsedText(c)}）`),
  ];
  if (lines.length === 0) return null;
  const elsewhere = [...open, ...lapsed].some((c) => c.origin);
  const head = elsewhere ? "我答应过或打算在这里做的事：" : "我在这里答应过或打算做的事：";
  return `${head}\n${lines.join("\n")}`;
}

/** 没说做完之后，结局还这么久写在答应的地方（和失约留在心里一样久）。 */
const SETTLED_SHOWN = EXPIRED_SHOWN;

/**
 * 在这里答应、要去别处做的事（研究员 2026-11-15："私聊求她在群里发语音，但是她没有做"）：答应她的人回到这里时，
 * 她记得答应过、去没去做。写去哪做，和那件事现在怎样：还没做、记下做完了、没记下做完。
 */
function promisedHereText(
  world: View<"chats" | "relations">,
  scope: string,
  now: number,
): string | null {
  const lines: string[] = [];
  for (const [target, node] of Object.entries(world.chats)) {
    if (target === scope) continue;
    const mine = (c: Commitment) => c.origin?.scope === scope;
    const where = `${placeOf(world, target)}做`;
    for (const c of node.commitments.open.filter((x) => mine(x) && x.expireAt > now)) {
      lines.push(`- ${c.text}（${where}，${dueText(c, now)}）`);
    }
    for (const c of node.commitments.closed) {
      if (!mine(c) || c.outcome !== "done" || now - c.closedAt >= SETTLED_SHOWN) continue;
      lines.push(`- ${c.text}（${where}，我记下做完了）`);
    }
    for (const c of lapsedIn(node, now).filter(mine)) {
      lines.push(`- ${c.text}（${where}，${lapsedText(c)}）`);
    }
  }
  return lines.length ? `我在这里答应过、要去别处做的事：\n${lines.join("\n")}` : null;
}

function outcome(world: View<"relations">, r: Reception, chatType: ChatNode["chatType"]): string {
  const name = r.by ? (nameOf(world, r.by) ?? "有人") : "有人";
  const opener = r.proactive ? (chatType === "private" ? "我主动找他，" : "我主动插话，") : "";
  switch (r.kind) {
    case "replied":
      return r.emoji ? `${opener}${name}给我点了个${r.emoji}` : `${opener}${name}回了我`;
    case "taken":
      return `${opener}${name}接着我的话说了`;
    case "ignored":
      return `${opener}没人接我的话（大家在聊别的）`;
    case "unheard":
      return chatType === "private" ? `${opener}他没回` : `${opener}之后群里没人说话`;
    case "rejected":
      return `${opener}被拒绝了（被移出或被拉黑）`;
    case "cold":
      return `${opener}${name}给我点了个${r.emoji ?? "嫌弃的表情"}`;
  }
}

/**
 * 这次开口后来怎样，她在时间线上自己看得见：文字回复还在上面；没人接、没回，是她那句话和之后的对话还在上面。
 * 表情和被拒绝在时间线上看不出来。
 */
function shownByTimeline(chat: ChatState, r: Reception): boolean {
  if (r.emoji !== undefined || r.kind === "rejected") return false;
  return onTimeline(chat, r.kind === "replied" ? r.at : r.turnAt);
}

/** 群里最近 TALLY_KEPT 次开口有几次有人接（PLAN 第 43 件：她受不受欢迎作为事实给她看）；不到 3 次不说。 */
function takenTally(node: ChatNode): { said: number; taken: number } | null {
  if (node.chatType !== "group") return null;
  const heard = node.receptions.filter((r) => r.kind !== "unheard").slice(-TALLY_KEPT);
  if (heard.length < 3) return null;
  const taken = heard.filter((r) => r.kind === "replied" || r.kind === "taken").length;
  return { said: heard.length, taken };
}

/** 数最近几次开口。手设。 */
const TALLY_KEPT = 5;

/**
 * M33：她最近几次在这里开口，后来怎样了（2 月 printPastResults 的外部信号部分，不靠她自评）。
 * 时间线上看得见的不再重复（线上 81 行里有 26 行就在时间线上，eval-artifacts/ablation-live/results.md）。
 */
function outcomesText(
  world: View<"relations">,
  chat: ChatState,
  node: ChatNode | undefined,
  now: number,
): string | null {
  if (!node) return null;
  const lines = node.receptions
    .slice(-OUTCOMES_SHOWN)
    .reverse()
    .filter((r) => !shownByTimeline(chat, r))
    .map((r) => `- ${elapsed(now - r.turnAt)}前，${outcome(world, r, node.chatType)}`);
  const tally = takenTally(node);
  const head = tally ? `最近我在这里说的 ${tally.said} 次里 ${tally.taken} 次有人接。` : null;
  const body = lines.length ? `我最近几次在这里开口：\n${lines.join("\n")}` : null;
  return [head, body].filter((x) => x !== null).join("\n") || null;
}

function short(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * 她在这里跟着的事（候选 topics，2 月 threads.mod contribute 的精简版）：最近动过的几件，每件一行，
 * 写她自己的话和上一次进展、隔了多久。只读这个会话自己的那份，私聊里开的事不会出现在别处。
 */
export function topicsFact(
  world: View<"chats.topics">,
  chat: ChatState,
  now: number,
): Contribution[] {
  const node = world.chats[chat.scope];
  if (!node) return [];
  const lines = shownTopics(node.topics, now).map((t) => {
    const last = t.beat
      ? `上次：${short(t.beat.text, TOPIC_BEAT_CHARS)}，${elapsed(now - t.beat.at)}前`
      : `开了个头，${elapsed(now - t.openedAt)}前`;
    return `- ${short(t.title, TOPIC_TITLE_CHARS)}（${last}）`;
  });
  if (lines.length === 0) return [];
  const text = `我在这里跟着的事：\n${lines.join("\n")}`;
  return [{ mechanism: "pressure-topics", kind: "scene", text }];
}

function recall(
  world: View<"facts" | "chats" | "relations">,
  chat: ChatState,
  now: number,
): Contribution[] {
  const node = world.chats[chat.scope];
  const facts = factsFact(world, chat, node, now);
  const doings = [
    commitmentsText(world, node, now),
    promisedHereText(world, chat.scope, now),
    outcomesText(world, chat, node, now),
  ]
    .filter((t): t is string => t !== null)
    .map((text): Contribution => ({ mechanism: "pressure-memory", kind: "doings", text }));
  return [...(facts ? [facts] : []), ...doings];
}

/**
 * 记忆给她的心里的能力：打算和做完。关于人的事只由反思记（people.ts），不给她"记住"这项能力，13 个场景 ×6 次 opus 成对
 * 197 胜 150 负，关于人的事每次反思持平（eval-artifacts/memory-b/）。
 */
export const MEMORY_AFFORDANCES = [
  "intend",
  "fulfil",
  "let-go",
] as const satisfies readonly ActKind[];

/**
 * 她在心里记下的一笔（memory.ts）：答应或打算做的事、做完了。关于人的事由反思记（people.ts）。
 * 答应的事（chats.commitments）现在只由这里折：到期、到时了、响过了都跟着同一条事件；
 * before 是事件之前的会话，用来判断"有人等她吗"和"这次是不是想过、决定先不"。
 */
function remembered<W extends View<"chats.commitments" | "relations">>(
  before: W,
  w: W,
  event: AliceEvent,
): W {
  switch (event.type) {
    case "act.done": {
      const { act, scope, at } = event;
      const chat = w.chats[scope];
      switch (act.kind) {
        case "intend": {
          if (!chat) return w;
          // 要去别处做的，记在那个会话里（那里的劲、那里的卡片），带上在哪、对谁答应的；认不出地方就记在这里。
          const target = act.where ? placeNamed(w, scope, act.where) : null;
          const node = target ? w.chats[target] : undefined;
          if (target && node) {
            const to =
              chat.chatType === "private" ? chat.partner : (chat.recentFrom.at(-1) ?? null);
            const made = makeCommitment(act, at, { scope, to });
            return put(w, target, {
              ...node,
              commitments: intend(expire(node.commitments, at), made, at),
            });
          }
          const commitments = intend(expire(chat.commitments, at), makeCommitment(act, at), at);
          return put(w, scope, { ...chat, commitments });
        }
        case "fulfil": {
          // 先在这里找；在群里答应、到私聊里做完的，按内容去别的会话找。
          const order = [scope, ...Object.keys(w.chats).filter((s) => s !== scope)];
          for (const s of order) {
            const node = w.chats[s];
            const next = node && fulfil(expire(node.commitments, at), act.what, at, s === scope);
            if (node && next) return put(w, s, { ...node, commitments: next });
          }
          return w;
        }
        default:
          return w;
      }
    }
    case "message.sent": {
      const node = w.chats[event.scope];
      if (!node) return w;
      // 到时候了她在这里开口：答应过的事此刻在她眼前，压力从这里重新长起（做没做由她自己说）。
      const commitments = consider(expire(node.commitments, event.at), event.at);
      return commitments === node.commitments ? w : put(w, event.scope, { ...node, commitments });
    }
    case "speech.decided": {
      const { scope, at } = event;
      const prevBefore = before.chats[scope];
      const node = w.chats[scope];
      if (!prevBefore || !node) return w;
      // 发言调用有了结果：到点的闹钟算响过了（memory.ts rang）。
      let commitments = rang(node.commitments, at);
      // 没人找她时想过要不要说、决定先不：到时候了的承诺也从此刻重新长起。
      if (isSilent(event.decision.acts) && !isSolicited(prevBefore, at)) {
        commitments = consider(expire(commitments, at), at);
      }
      return commitments === node.commitments ? w : put(w, scope, { ...node, commitments });
    }
    case "speech.failed": {
      const { scope, at } = event;
      const prevBefore = before.chats[scope];
      const node = w.chats[scope];
      if (!prevBefore || !node) return w;
      let commitments = rang(node.commitments, at);
      if (!isSolicited(prevBefore, at)) {
        commitments = consider(expire(commitments, at), at);
      }
      return commitments === node.commitments ? w : put(w, scope, { ...node, commitments });
    }
    default:
      return w;
  }
}

/**
 * 记忆：给她打算、做完、算了这几种心里的能力，并把她记得的事、答应过的事、最近几次开口的结果
 * 作为事实放进提示词；说了钟点的事到点时叫醒她。
 */
export const memory: PressureFeature = feature({
  name: "memory",
  provides: ["chats.commitments"],
  requires: ["chats"],
  // "我记得关于……的事"由记忆写，事实却由 people 在反思时记（两处管同一件事，要合并）；没有 people/relation 时照旧工作。
  uses: ["facts", "relations"],
  affordances: MEMORY_AFFORDANCES,
  reduce: (before, after, event) => remembered(before, after, event),
  contribute: ({ world, chat, now }) => recall(world, chat, now),
  alarm: (world, scope, now) =>
    ringing(world.chats[scope]?.commitments.open ?? [], now) !== undefined,
});

/** 她自己开始、推进、了结的事（候选 topics，R04）。 */
export const TOPIC_AFFORDANCES = [
  "topic-open",
  "topic-advance",
  "topic-close",
] as const satisfies readonly ActKind[];

/**
 * 她自己的事（候选，2 月 threads.mod；absorb/omp-report.md §2-1）：开始、推进、了结一件她要跟下去的事，这个会话里
 * 最近动过的 3 件作为事实放进提示词。不进驱动：她自己的事不会把她叫醒，只在她醒着时看得见。
 * 只在开头的那个会话里：在别处推进、了结的不去别的会话找（私聊里的事不跟到群里）。
 */
export const topics: PressureFeature = feature({
  name: "topics",
  provides: ["chats.topics"],
  affordances: TOPIC_AFFORDANCES,
  reduce: (_before, w, event) => {
    if (event.type !== "act.done") return w;
    const { act, scope, at } = event;
    const chat = w.chats[scope];
    if (!chat) return w;
    switch (act.kind) {
      case "topic-open":
        return put(w, scope, { ...chat, topics: openTopic(chat.topics, act.title, at) });
      case "topic-advance":
        return put(w, scope, {
          ...chat,
          topics: advanceTopic(chat.topics, act.topic, act.beat, at),
        });
      case "topic-close":
        return put(w, scope, { ...chat, topics: closeTopic(chat.topics, act.topic) });
      default:
        return w;
    }
  },
  contribute: ({ world, chat, now }) => topicsFact(world, chat, now),
});

const RECALL_LIMIT = 8;

function matchesQuery(text: string, q: string | null): boolean {
  return !q || text.toLowerCase().includes(q.toLowerCase());
}

/**
 * PTC 原生自管记忆与日程工具（`tools.recall` 与 `tools.note_self`）：
 * 按关键词或人名检索更早的日记、关于人与自己的事实（严格守 `reaches` 隐私边界）、话头、承诺和当天日程，
 * 不需要每次把海量记忆塞进提示词。
 */
export const recallTools: PressureFeature = feature({
  name: "recall-tools",
  requires: ["chats", "relations"],
  uses: ["facts", "diary", "life", "thoughts"],
  affordances: ["recall", "note-self"] as const satisfies readonly ActKind[],
  query: (kind, args, chat, now, world) => {
    if (kind !== "recall") return undefined;
    const q = typeof args.query === "string" && args.query.trim() ? args.query.trim() : null;
    const subj =
      typeof args.subject === "string" && args.subject.trim() ? args.subject.trim() : null;
    const personName = (id: string | null) => (id === null ? null : (nameOf(world, id) ?? id));
    // 一条统一的记忆流（memory-stream.ts）：日记、事实、自己的话、想法、话头、承诺，按受众规则筛过、按检索打分排。
    const stream = projectMemoryStream(world, chat, now).filter(
      (r) =>
        matchesQuery(`${r.text} ${r.lastBeat ?? ""}`, q) &&
        (!subj || r.about === subj || (r.about !== null && personName(r.about) === subj)),
    );
    const take = (kind: MemoryRecord["kind"]) =>
      stream.filter((r) => r.kind === kind).slice(0, RECALL_LIMIT);
    const people: Record<string, string[]> = {};
    for (const r of stream) {
      if (r.kind !== "fact") continue;
      const name = personName(r.about);
      if (!name) continue;
      const list = people[name] ?? [];
      people[name] = list;
      if (list.length < RECALL_LIMIT) list.push(r.text);
    }
    const day = (world.life as unknown as LifeBodyState | undefined)?.day;
    const schedule = day
      ? {
          date: day.date,
          activities: day.activities,
          moments: day.moments.filter((m) => m.at <= now).map((m) => m.text),
          ongoing: day.ongoing,
          curiosities: day.curiosities ?? [],
        }
      : null;

    return {
      stream: stream.slice(0, RECALL_LIMIT).map((r) => ({
        kind: r.kind,
        text: r.text,
        about: personName(r.about),
        at: r.at,
      })),
      diary: take("summary").map((r) => ({
        text: r.text,
        about: personName(r.about),
        ago: elapsed(now - r.at),
      })),
      self: take("self").map((r) => r.text),
      people,
      topics: take("topic").map((r) => ({ title: r.text, lastBeat: r.lastBeat ?? null })),
      commitments: take("commitment").map((r) => ({ what: r.text, dueAt: r.due ?? null })),
      schedule,
    };
  },
});
