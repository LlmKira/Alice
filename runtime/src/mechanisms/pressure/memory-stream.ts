/**
 * 记忆流（docs/research/memory-stream.md 第 4 片）：日记、关于人与自己的事实、内心独白、答应的事、跟着的事和
 * 当天生活，都是同一条流里的记录。受众规则（reaches）、两字片段的重合（similarity）和检索打分（relevance、
 * scoreMemory）只在这里有一份；日记、内心独白、对人的了解都从这里取，不再各自复制。
 *
 * 纯函数：时间只来自事件 fold 出的 at 和传进来的 now。
 */
import type { ChatState } from "../../mind/state.js";
import { onTimeline } from "../../mind/state.js";
import type { View } from "./feature.js";
import type { LifeBodyState } from "./life-body.js";
import type { Fact } from "./memory.js";
import { DIARY_RANK } from "./params.js";
import { SELF_SUBJECT } from "./people.js";
import { presentIn } from "./world.js";

/** 一条记忆是什么（日记的摘要、事实、她自己的事、想过的立场、答应的事、跟着的事、当天生活）。 */
type MemoryKind = "summary" | "fact" | "self" | "stance" | "commitment" | "topic" | "life";

/** 这条记忆是从哪里来的：哪个会话、是不是群、写下时在场的人、她标没标私密。 */
export interface MemorySource {
  scope: string;
  group: boolean;
  present: readonly string[];
  private?: boolean;
}

/** 此刻看记忆的受众：私聊的对方、哪一刻的对话还在眼前、在场的人、眼前这段对话里的字。 */
export interface MemoryAudience {
  scope: string;
  group: boolean;
  target: string | null;
  onTimeline: (at: number) => boolean;
  /** 她上一次在这个会话里开口的时刻。 */
  spokeAt?: number;
  /** 此刻在场的人（私聊是对方；群里是最近说话的人）。 */
  present?: readonly string[];
  /** 眼前这段对话里的字（两字片段）。 */
  cue?: ReadonlySet<string>;
}

/** 记忆流里的一条记录；各字段是各类记录共有的投影。 */
export interface MemoryRecord {
  kind: MemoryKind;
  text: string;
  /** 关于谁（联系人 id）；null 是不针对谁。 */
  about: string | null;
  source: MemorySource;
  /** 写下/记下/进展/到期的时刻（排序用的时间）。 */
  at: number;
  /** 她写这条时自己打的分（1–10）；没有时按 GA 的默认值（DIARY_RANK.importance）。 */
  importance: number | null;
  /** 答应的事的到期时刻。 */
  due?: number | null;
  /** 跟着的事上一次进展的原话。 */
  lastBeat?: string | null;
  /** 这件事被记住过几次（事实的强化次数）。 */
  count?: number;
}

/** 只由字母、数字组成的两字片段（不含空格、标点）。 */
export function memoryPairs(text: string): Set<string> {
  const out = new Set<string>();
  const chars = Array.from(text);
  for (let i = 0; i + 1 < chars.length; i++) {
    const pair = `${chars[i]}${chars[i + 1]}`;
    if (/^[\p{L}\p{N}]{2}$/u.test(pair)) out.add(pair);
  }
  return out;
}

/** 两字片段（不滤标点：similar 的 Jaccard 用这个，和 pairs 的检索用片段不同）。 */
const grams = (t: string) =>
  new Set(Array.from({ length: Math.max(1, t.length - 1) }, (_, i) => t.slice(i, i + 2)));

/** 两字片段的 Jaccard（中文里换个说法的重复两字约 0.5–0.7，不同的事 ≤ 0.15；4 字片段分不开）。 */
export function memorySimilarity(a: string, b: string): number {
  const x = grams(a);
  const y = grams(b);
  const both = [...x].filter((g) => y.has(g)).length;
  return both / Math.max(1, x.size + y.size - both);
}

/**
 * 她知道的事能到哪些聊天（北极星不变量 1，PLAN 第 33 件）。别人托她保密的、明显私密的（写下时她自己标了
 * private）守受众规则，确定性的，不靠模型自己守秘密：私聊里的只在那个私聊里；群里的只在那个群、和与当时在场的人
 * 的私聊里，不进别的群。其余的到哪个聊天都想得起来，出处由显示的地方注明（world.ts placeOf）；提不提由她。
 */
export function memoryReaches(
  source: MemorySource,
  here: Pick<MemoryAudience, "scope" | "group" | "target">,
): boolean {
  if (!source.private) return true;
  if (here.group) return source.scope === here.scope;
  return (
    here.target !== null && (source.scope === here.scope || source.present.includes(here.target))
  );
}

/**
 * 别处写下的东西和此刻这里有多相关（0–1，Generative Agents 检索打分里的相关性一项）：关于在场的某个人，或写下时
 * 在场的人里有此刻在场的，是 1；否则看它和眼前在聊的话重合多少（条目的两字片段有几成出现在这段对话里）。
 */
export function memoryRelevance(
  source: { about?: string | null; present: readonly string[]; text: string },
  here: MemoryAudience,
): number {
  const now = here.present ?? (here.target ? [here.target] : []);
  if (
    (source.about != null && now.includes(source.about)) ||
    source.present.some((p) => now.includes(p))
  ) {
    return 1;
  }
  if (!here.cue || here.cue.size === 0) return 0;
  const own = memoryPairs(source.text);
  const shared = [...own].filter((p) => here.cue?.has(p)).length;
  return shared / Math.max(1, own.size);
}

/** GA 的检索打分：近因（0.995^(小时)）+ 重要性（1–10 归一）+ 相关性。 */
function scoreMemory(record: MemoryRecord, here: MemoryAudience, now: number): number {
  return (
    DIARY_RANK.decayPerHour ** ((now - record.at) / 3_600_000) +
    (record.importance ?? DIARY_RANK.importance) / 10 +
    memoryRelevance(
      { about: record.about, present: record.source.present, text: record.text },
      here,
    )
  );
}

function diaryRecords(world: View<"diary">, here: MemoryAudience, now: number): MemoryRecord[] {
  const out: MemoryRecord[] = [];
  for (const d of world.diary) {
    if (d.at > now) continue;
    const source: MemorySource = {
      scope: d.scope,
      group: d.group,
      present: d.present,
      ...(d.private ? { private: true } : {}),
    };
    if (!memoryReaches(source, here)) continue;
    out.push({
      kind: "summary",
      text: d.text,
      about: d.about,
      source,
      at: d.at,
      importance: d.importance,
    });
  }
  return out;
}

function factRecords(
  world: View<"facts" | "chats" | "relations">,
  here: MemoryAudience,
  now: number,
): MemoryRecord[] {
  return Object.entries(world.facts).flatMap(([subject, facts]) =>
    subject === SELF_SUBJECT || world.relations.people[subject]
      ? subjectRecords(world, subject, facts, here, now)
      : [],
  );
}

/** 关于一个人（或她自己，SELF_SUBJECT）记下的事里，此刻这个会话看得见的那些。 */
function subjectRecords(
  world: View<"chats">,
  subject: string,
  facts: readonly Fact[],
  here: MemoryAudience,
  now: number,
): MemoryRecord[] {
  const self = subject === SELF_SUBJECT;
  const out: MemoryRecord[] = [];
  for (const f of facts) {
    if (f.lastAt > now) continue;
    const source: MemorySource = {
      scope: f.scope,
      group: world.chats[f.scope]?.chatType === "group",
      present: f.origin.present,
      ...(f.origin.private ? { private: true } : {}),
    };
    if (!memoryReaches(source, here)) continue;
    out.push({
      kind: self ? "self" : "fact",
      text: f.text,
      about: self ? null : subject,
      source,
      at: f.lastAt,
      importance: null,
      count: f.count,
    });
  }
  return out;
}

function thoughtRecords(
  world: View<"thoughts" | "chats">,
  here: MemoryAudience,
  now: number,
): MemoryRecord[] {
  const out: MemoryRecord[] = [];
  for (const t of world.thoughts) {
    if (t.at > now) continue;
    const source: MemorySource = {
      scope: t.scope,
      group: world.chats[t.scope]?.chatType === "group",
      present: t.present ?? [],
      ...(t.private ? { private: true } : {}),
    };
    if (!memoryReaches(source, here)) continue;
    out.push({ kind: "stance", text: t.text, about: null, source, at: t.at, importance: null });
  }
  return out;
}

function chatRecords(world: View<"chats">, scope: string, local: MemorySource): MemoryRecord[] {
  const node = world.chats[scope];
  if (!node) return [];
  const topics: MemoryRecord[] = node.topics.map((t) => ({
    kind: "topic",
    text: t.title,
    about: null,
    source: local,
    at: t.beat?.at ?? t.openedAt,
    importance: null,
    lastBeat: t.beat?.text ?? null,
  }));
  const commitments: MemoryRecord[] = node.commitments.open.map((c) => ({
    kind: "commitment",
    text: c.text,
    about: null,
    source: local,
    at: c.madeAt,
    importance: null,
    due: c.due,
  }));
  return [...topics, ...commitments];
}

function lifeRecords(world: View<"life">, local: MemorySource, now: number): MemoryRecord[] {
  const day = (world.life as Partial<LifeBodyState> | undefined)?.day;
  if (!day) return [];
  const lifeAt = world.life.at > 0 ? world.life.at : now;
  const push = (text: string, at = lifeAt): MemoryRecord => ({
    kind: "life",
    text,
    about: null,
    source: local,
    at,
    importance: null,
  });
  return [
    ...Object.values(day.activities).map((t) => push(t)),
    ...day.moments.filter((m) => m.at <= now).map((m) => push(m.text, m.at)),
    ...day.ongoing.map((t) => push(t)),
    ...(day.curiosities ?? []).map((c) => push(`${c.topic}：${c.hook}`)),
  ];
}

/** 她从事件 fold 出的世界投影成一条记忆流（此刻这个会话看得见的那些），按检索打分从高到低。 */
export function projectMemoryStream(
  world: View<"diary" | "facts" | "thoughts" | "chats" | "relations" | "life">,
  chat: ChatState,
  now: number,
): MemoryRecord[] {
  const node = world.chats[chat.scope];
  const group = chat.chatType === "group";
  const here: MemoryAudience = {
    scope: chat.scope,
    group,
    target: group ? null : (node?.partner ?? null),
    onTimeline: (at) => onTimeline(chat, at),
    spokeAt: node?.lastAliceAt ?? 0,
    present: presentIn(node),
    cue: memoryPairs(chat.timeline.map((e) => e.text ?? "").join("\n")),
  };
  const local: MemorySource = { scope: chat.scope, group, present: here.present ?? [] };
  const records = [
    ...diaryRecords(world, here, now),
    ...factRecords(world, here, now),
    ...thoughtRecords(world, here, now),
    ...chatRecords(world, chat.scope, local),
    ...lifeRecords(world, local, now),
  ];
  return records.sort(
    (a, b) => scoreMemory(b, here, now) - scoreMemory(a, here, now) || b.at - a.at,
  );
}
