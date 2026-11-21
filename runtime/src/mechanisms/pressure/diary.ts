/**
 * 她的日记：她的主观世界（她觉得谁在躲她，也许对方只是忙）。两种写法各配一种显示，构造时选定（DiaryStrategy）：
 * - feb：2 月 diary.mod.ts 的忠实复现（ADR-82/102/110，eval-artifacts/emotion/feb-diary.md）：她每轮顺手写
 *   日记（tools.diary），显示最近 3.3 小时的。作对照。
 * - reflect：她在一个会话里经历累计到一定分量时单独想一次、写下来（Generative Agents 的反思），按近因、重要性、
 *   相关性取前几条，并按受众规则筛（docs/research/mature-designs-2026-11-11.md）。
 * 条目只从事件折叠（act.done 的 diary、ponder.done 的反思），时间只来自事件。
 */
import type { Person } from "../../mind/effects.js";
import type { AliceEvent } from "../../mind/events.js";
import type { Contribution, PonderAsk } from "../../mind/mechanism.js";
import { type AliceState, type ChatState, onTimeline } from "../../mind/state.js";
import { moodFor } from "./affect.js";
import { feature, type PressureFeature, type View } from "./feature.js";
import { memoryPairs, memoryReaches, memoryRelevance, memorySimilarity } from "./memory-stream.js";
import { DIARY, DIARY_RANK, ECHO, REFLECT } from "./params.js";
import { placeOf } from "./place.js";
import { nameOf } from "./relation.js";
import { presentIn } from "./world.js";

export interface DiaryEntry {
  text: string;
  /** 关于谁（联系人 id）；null 是不针对谁。 */
  about: string | null;
  /** 在哪个会话里写下的。 */
  scope: string;
  group: boolean;
  at: number;
  /** 反思时她自己打的分（1–10，GA 的 poignancy）；顺手写的没有。 */
  importance: number | null;
  /** 写下时那个会话里在场的人（私聊是对方；群里是最近说过话的人）。 */
  present: readonly string[];
  /** 别人托她保密的、明显私密的（反思时她自己标的）：只有这样的守受众规则（reaches）。 */
  private?: true;
}

/**
 * feb：她每轮顺手写日记（2 月原样）。thinking：示范按 2 月原版写成先想、再说、再记（和内心独白一起用时）。
 */
export function febDiary(o: { thinking: boolean }): PressureFeature {
  return feature({
    name: "diary",
    provides: ["diary"],
    requires: ["chats", "relations", "lastCallAt"],
    affordances: ["diary"],
    reduce: (_before, w, event) => {
      if (event.type !== "act.done" || event.act.kind !== "diary") return w;
      // 关于谁：编号所指那条消息的发言人；没写编号就不针对谁（2 月：写显示名的也进全局）。
      const act = event.act;
      const chat = w.chats[event.scope];
      const index = act.about === null || !chat ? -1 : chat.recentIds.lastIndexOf(act.about);
      const about = index >= 0 ? (chat?.recentFrom[index] ?? null) : null;
      const entry = {
        text: act.entry,
        about,
        scope: event.scope,
        group: chat?.chatType === "group",
        at: event.at,
        importance: null,
        present: presentIn(chat),
      };
      return { ...w, diary: writeDiary(w.diary, entry, w.lastCallAt) };
    },
    contribute: ({ world, chat, now }) => [
      ...diaryLines(
        world,
        febShown(world.diary, audienceOf(world, chat.scope).target, now),
        null,
        now,
      ),
      {
        mechanism: "pressure-diary",
        kind: "reference" as const,
        text: DEMO_INTRO,
        examples: o.thinking ? DEMOS_THINKING : DEMOS,
      },
    ],
  });
}

/**
 * 她此刻看得见哪些日记的另外两条规矩（context-v2，out.md 改动 5-4）：staleAfter 之前写的、又不是关于此刻对象的
 * 不再看得见（样例里 114、75 小时前的两条"去不了露营有点小失落"一起出现，跨天反刍）；同一个会话里写下的几条
 * 几乎一样（两字片段 Jaccard 超过 collapse）只留最新的一条。2 月日记的对照（febDiary）不设。
 */
export interface DiaryView {
  staleAfter: number;
  collapse: number;
  /**
   * 说过就过去了（只用在卡片上）：在写下它的会话里，她在那里又开过口之后，这条不再放（Audience.spokeAt）。
   * 不看她说了什么：不按字面判断"说的是不是这件事"。反思时不设，反思要看见写过的，免得再写一遍。
   */
  spent?: boolean;
}
export const DIARY_VIEW: DiaryView = { staleAfter: 48 * 3_600_000, collapse: 0.35 };
/** 卡片上的显示（eval-artifacts/rehash/prereg-3.md）。 */
const CARD_VIEW: DiaryView = { ...DIARY_VIEW, spent: true };

/**
 * 反思的写法示范（context-v2，out.md 改动 5-3）：一暖一柔。以前的两条（FEB_LINES，2 月日记的对照还用）都是负面的。
 * out.md 原句的"小满"换成"朋友"：场景里有叫小满的人（warm-02、d08、h06），示范里的名字会被读成她真记得的事。
 */
export const REFLECT_LINES = [
  "朋友一遇到急事第一个来找我帮忙，被人这样信赖着，心里暖洋洋的",
  "他说这周连着加班快撑不住了，虽然还在开玩笑，其实挺累的",
] as const;

/**
 * reflect：经历累计到一定分量时单独想一次、写下来，按打分和受众规则显示（context-v2：日记只写条目，标题由版式写；
 * 示范是 REFLECT_LINES；看得见的日记按 DIARY_VIEW 再筛一次，卡片上按 CARD_VIEW）。
 */
export const reflectDiary: PressureFeature = feature({
  name: "reflect",
  provides: ["diary", "involvement"],
  requires: ["chats", "relations"],
  // 请她反思时带上她此刻的心情；没有心情那一样时是"没有心情"（列在组合的 gaps 里）。
  uses: ["affect"],
  reduce: (_before, w, event) => involve(reflected(w, event, DIARY_VIEW), event),
  contribute: ({ world, chat, now }) => {
    const here = audienceOf(world, chat.scope, chat);
    return diaryLines(world, rankedShown(world.diary, here, now, CARD_VIEW), chat.scope, now);
  },
  ponder: (world, chats, now) => reflectAsk(world, chats, now, DIARY_VIEW, REFLECT_LINES),
});

/**
 * 反思写下的日记：同一次最多 DIARY.perDecision 条（从这次算起）；和这里的受众此刻看得见的某条几乎一样就不写
 * （同一次里先写下的也算）。写完日记时的心情由 affect.ts 折进她的心情。
 */
function reflected<W extends View<"chats" | "diary">>(
  w: W,
  event: AliceEvent,
  view?: DiaryView,
): W {
  if (event.type !== "ponder.done" || event.ponder.kind !== "reflect") return w;
  const p = event.ponder;
  const node = w.chats[p.scope];
  const present = presentIn(node);
  const here = audienceOf(w, p.scope);
  const diary = p.entries.reduce((d, e) => {
    const entry: DiaryEntry = {
      text: e.text,
      about: e.about,
      scope: p.scope,
      group: node?.chatType === "group",
      at: event.at,
      importance: e.importance,
      present,
      ...(e.private ? { private: true as const } : {}),
    };
    return writeDiary(d, entry, event.at, rankedShown(d, here, event.at, view));
  }, w.diary);
  return { ...w, diary };
}

// ── 写 ───────────────────────────────────────────────────────────────

/**
 * 记下一条日记。since 是这次决定的时刻：同一个会话里、这之后写下的已经有 DIARY.perDecision 条，就不再记
 * （2 月每轮最多 2 条）。against 是同一批受众此刻看得见的条目，和其中某条几乎一样就不记（只看得见的才算重复：
 * 另一个私聊里、或早已不显示的旧条目不该挡住这一条）。存 DIARY.retention 之内、最多 DIARY.kept 条。
 */
export function writeDiary(
  entries: readonly DiaryEntry[],
  entry: DiaryEntry,
  since: number,
  against: readonly DiaryEntry[] = [],
): DiaryEntry[] {
  const text = entry.text.trim().slice(0, DIARY.maxChars);
  const kept = entries.filter((e) => entry.at - e.at < DIARY.retention);
  if (!text) return kept;
  const thisDecision = kept.filter((e) => e.scope === entry.scope && e.at >= since).length;
  if (thisDecision >= DIARY.perDecision) return kept;
  if (against.some((e) => memorySimilarity(e.text, text) > DIARY.duplicate)) return kept;
  return [...kept, { ...entry, text }].slice(-DIARY.kept);
}

// ── 显示 ─────────────────────────────────────────────────────────────

/** 一个会话的受众：私聊的对方（群里没有单一对象），和哪一刻的对话还在她眼前的时间线上（mind/state.ts onTimeline）。 */
export interface Audience {
  scope: string;
  group: boolean;
  target: string | null;
  onTimeline: (at: number) => boolean;
  /** 她上一次在这个会话里开口的时刻（DiaryView.spent 用）。 */
  spokeAt?: number;
  /** 此刻在场的人（私聊是对方；群里是最近说话的人）：别处来的东西和他们有关系的排在前面（relevance）。 */
  present?: readonly string[];
  /** 眼前这段对话里的字（两字片段）：别处来的东西和在聊的话题有关系的排在前面（relevance）。 */
  cue?: ReadonlySet<string>;
}

export function audienceOf(
  world: View<"chats">,
  scope: string,
  shown?: Pick<ChatState, "timeline">,
): Audience {
  const chat = world.chats[scope];
  const group = chat?.chatType === "group";
  return {
    scope,
    group,
    target: group ? null : (chat?.partner ?? null),
    onTimeline: (at) => (shown ? onTimeline(shown, at) : false),
    spokeAt: chat?.lastAliceAt ?? 0,
    present: presentIn(chat),
    ...(shown ? { cue: memoryPairs(shown.timeline.map((e) => e.text ?? "").join("\n")) } : {}),
  };
}

/**
 * 她知道的事能到哪些聊天（北极星不变量 1，PLAN 第 33 件）。别人托她保密的、明显私密的（写下时她自己标了
 * private）守受众规则，确定性的，不靠模型自己守秘密：私聊里的只在那个私聊里；群里的只在那个群、和与当时在场的人
 * 的私聊里，不进别的群。其余的到哪个聊天都想得起来，出处由显示的地方注明（world.ts placeOf）；提不提由她。
 * 日记、她自己说过的事（people.ts selfKnown）、关于人的事（recall.ts knownAbout）、心情的原因（affect.ts）、
 * 带到别处的想法（inner.ts）共用这一条。私密只看那一条自己标没标：一个会话里托付过一件事，那里写下的别的事
 * 照常能走（2026-11-14 起；之前一并守规则）。
 */
export { memoryReaches as reaches, memoryRelevance as relevance };

/**
 * feb 的显示（2 月原样）：不针对谁的最新 DIARY.global 条，加上关于此刻对象的最新 DIARY.target 条，
 * 只看 3.3 小时之内的，按写下的时间从旧到新排。
 */
export function febShown(
  entries: readonly DiaryEntry[],
  target: string | null,
  now: number,
): DiaryEntry[] {
  const alive = entries.filter((e) => e.at <= now && now - e.at < DIARY.ttl);
  const newest = (list: DiaryEntry[], n: number) => list.slice(-n);
  const targeted = target
    ? newest(
        alive.filter((e) => e.about === target),
        DIARY.target,
      )
    : [];
  const global = newest(
    alive.filter((e) => e.about === null),
    DIARY.global,
  );
  return [...targeted, ...global].slice(0, DIARY.total).sort((a, b) => a.at - b.at);
}

/**
 * reflect 的显示。先按 reaches 筛：标了私密的只在写下它的会话、和与当时在场的人的私聊里；其余的哪里都行。
 * 在它自己的会话里，那段对话还在时间线上时不放：对话就在眼前，日记只多一份可以照抄的文字。再按近因 + 重要性 +
 * 相关性取前几条（DIARY_RANK）：这里写下的，相关性是"关于此刻的对象，或此刻的对象当时在场"；别处写下的是
 * relevance（和在场的人、在聊的话有没有关系）。关于此刻对象的最多 DIARY_RANK.target 条，其余的最多 DIARY.global
 * 条。
 */
export function rankedShown(
  entries: readonly DiaryEntry[],
  here: Audience,
  now: number,
  view?: DiaryView,
): DiaryEntry[] {
  const witness = (e: DiaryEntry) => here.target !== null && e.present.includes(here.target);
  const fresh = (e: DiaryEntry) =>
    !view || now - e.at <= view.staleAfter || (here.target !== null && e.about === here.target);
  // 同一个会话里几乎一样的几条只留最新的（view.collapse）。
  const newest = (e: DiaryEntry) =>
    !view ||
    !entries.some(
      (f) =>
        f !== e &&
        f.scope === e.scope &&
        f.at <= now &&
        f.at > e.at &&
        memorySimilarity(f.text, e.text) > view.collapse,
    );
  const allowed = (e: DiaryEntry) =>
    fresh(e) &&
    newest(e) &&
    (e.scope === here.scope
      ? !here.onTimeline(e.at) && !(view?.spent && (here.spokeAt ?? 0) > e.at)
      : memoryReaches(e, here));
  const mine = (e: DiaryEntry) => here.target !== null && e.about === here.target;
  const score = (e: DiaryEntry) =>
    DIARY_RANK.decayPerHour ** ((now - e.at) / 3_600_000) +
    (e.importance ?? DIARY_RANK.importance) / 10 +
    (e.scope === here.scope ? (mine(e) || witness(e) ? 1 : 0) : memoryRelevance(e, here));
  const pool = entries
    .filter((e) => e.at <= now && allowed(e))
    .map((e) => ({ e, s: score(e) }))
    .sort((a, b) => b.s - a.s || b.e.at - a.e.at)
    .map((x) => x.e);
  const targeted = pool.filter(mine).slice(0, DIARY_RANK.target);
  const others = pool.filter((e) => !mine(e));
  return [...targeted, ...others.slice(0, DIARY.global)]
    .slice(0, DIARY.total)
    .sort((a, b) => a.at - b.at);
}

/** 只写条目（"- 3 小时前 关于 名字：内容"；别处写下的注明出处），标题由版式写。 */
function diaryLines(
  world: View<"relations" | "chats">,
  entries: readonly DiaryEntry[],
  here: string | null,
  now: number,
): Contribution[] {
  const text = entries
    .map((e) => {
      // here 为 null：2 月日记的对照，原样不注出处。
      const where = here === null || e.scope === here ? "" : ` ${placeOf(world, e.scope)}`;
      const about = e.about ? ` 关于 ${nameOf(world, e.about) ?? "某人"}` : "";
      return `- ${diaryAgo(now - e.at)}${where}${about}：${e.text}`;
    })
    .join("\n");
  return text ? [{ mechanism: "pressure-diary", kind: "self", text }] : [];
}

/** 2 月 formatTimeAgo。 */
export function diaryAgo(ms: number): string {
  const s = ms / 1000;
  if (s <= 300) return "刚才";
  if (s <= 1800) return `${Math.round(s / 60)} 分钟前`;
  if (s <= 3600) return "半小时前";
  return `${Math.round(s / 3600)} 小时前`;
}

// ── 反思（reflect）───────────────────────────────────────────────────

/**
 * 她在每个会话里经历了多少（GA 累计重要性的确定性代理）：冲着她来的消息（私聊里的都算）和她自己说的话各算 1，
 * 群里没冲着她的算 REFLECT.ambient；在那里反思过（成功或失败）就清零。
 */
function involve<W extends View<"involvement">>(w: W, event: AliceEvent): W {
  const add = (scope: string, by: number) => ({
    ...w,
    involvement: { ...w.involvement, [scope]: (w.involvement[scope] ?? 0) + by },
  });
  const clear = (scope: string) => {
    const { [scope]: _, ...rest } = w.involvement;
    return { ...w, involvement: rest };
  };
  switch (event.type) {
    case "message.received":
      return add(event.scope, event.directed || event.chatType === "private" ? 1 : REFLECT.ambient);
    case "message.sent":
      return add(event.scope, 1);
    case "ponder.done":
      return event.ponder.kind === "reflect" ? clear(event.ponder.scope) : w;
    case "ponder.failed":
      return event.kind === "reflect" ? clear(event.chat) : w;
    default:
      return w;
  }
}

/** 经历累计到 REFLECT.involved 的会话里最多的那个；安静 REFLECT.quiet 之后，或累计到 burst 倍还没安静。 */
function due(world: View<"involvement">, chats: AliceState["chats"], now: number): string | null {
  const ready = Object.entries(world.involvement)
    .filter(([scope, n]) => {
      const last = chats[scope]?.timeline.at(-1)?.at;
      if (n < REFLECT.involved || last === undefined) return false;
      return now - last >= REFLECT.quiet || n >= REFLECT.involved * REFLECT.burst;
    })
    .sort((a, b) => b[1] - a[1]);
  return ready[0]?.[0] ?? null;
}

/** 请她把那段经历写进日记：那段对话（人用 p 编号）、她此刻在这里的心情、这里看得见的日记、写法示范。 */
function reflectAsk(
  world: View<"involvement" | "affect" | "diary" | "chats">,
  chats: AliceState["chats"],
  now: number,
  view: DiaryView | undefined,
  examples: readonly string[],
): PonderAsk | null {
  const scope = due(world, chats, now);
  const chat = scope ? chats[scope] : undefined;
  if (!scope || !chat) return null;
  const people: Person[] = [];
  const lines = chat.timeline
    .filter((e) => e.at <= now)
    .slice(-REFLECT.lines)
    .map((e) => {
      const text = e.text ?? `[${e.contentType}]`;
      if (!e.sender) return { at: e.at, who: null, text };
      const id = e.sender.id;
      if (!people.some((p) => p.id === id)) people.push({ id, name: e.sender.name });
      return { at: e.at, who: people.findIndex((p) => p.id === id), text };
    });
  return {
    kind: "reflect",
    scope,
    chatType: chat.chatType,
    lines,
    people,
    // 和发言提示里的心情是同一份（affect.ts）。
    mood: moodFor(world.affect, scope, now),
    // 这里刚写过的也给它看（免得再写一遍）。
    diary: rankedShown(world.diary, audienceOf(world, scope), now, view).map((e) => e.text),
    examples: [...examples],
  };
}

// ── 2 月原版的写法示范（f72379d gold-examples L143、L165）──────────────

/** 2/19 那一刻提示词里的两条日记。 */
const FEB_LINES = [
  "被说了不太好听的话 有点难过 但也许他不是故意的",
  "她说算了不说了 有点担心",
] as const;
const DEMO_INTRO = "你写日记的时候";
const DEMOS = [
  {
    scene: "被说了伤人的话",
    acts: [
      { kind: "send" as const, text: "嗯...好吧", replyTo: null },
      { kind: "diary" as const, about: null, entry: FEB_LINES[0] },
    ],
  },
  {
    scene: "她说「算了不说了」",
    acts: [
      { kind: "send" as const, text: "最近是不是特别累啊", replyTo: null },
      { kind: "diary" as const, about: null, entry: FEB_LINES[1] },
    ],
  },
];
/** 2 月原版的顺序：先想，再说，再记。 */
const DEMOS_THINKING = [
  {
    scene: DEMOS[0].scene,
    acts: [
      { kind: "think" as const, thought: "这话说得挺重的...不过算了 他可能只是今天心情不好" },
      ...DEMOS[0].acts,
    ],
  },
  {
    scene: DEMOS[1].scene,
    acts: [
      {
        kind: "think" as const,
        thought: "她突然说算了不说了...最近换了工作 上周说压力大 不要直接戳",
      },
      ...DEMOS[1].acts,
    ],
  },
];

// ── 同属"她自己写下的、下一轮读回"的两样（候选 echo、feb-thought）──────

/**
 * 行动回声（ADR-102 组件 1）：她在这个会话里最近说过的话，独立于时间线窗口，
 * 免得话滚出窗口后日记里的情绪还在、她做过什么却忘了（"已经问了两次"）。
 */
export interface EchoOptions {
  lookback?: number;
  max?: number;
  /** 统计最近发言里出现 >= 2 次的起手方式，作为纯事实写给镜子，不加禁止规定。 */
  detectStarters?: boolean;
}

function starterOf(text: string): string | null {
  const t = text.trim().replace(/^[\p{P}\p{S}\s]+/gu, "");
  if (!t) return null;
  const hasCjk = /[\u4e00-\u9fff]/.test(t);
  if (hasCjk) {
    const cjk = t.match(/^[\u4e00-\u9fff]{2}/);
    return cjk ? cjk[0] : null;
  }
  const w = t.toLowerCase().match(/^[\p{L}\p{N}]{2,}/u);
  return w ? w[0] : null;
}

/**
 * 行动回声（ADR-102 组件 1）：她在这个会话里最近说过的话，独立于时间线窗口，
 * 免得话滚出窗口后日记里的情绪还在、她做过什么却忘了（"已经问了两次"）。
 */
export function echoText(
  said: ReadonlyArray<{ at: number; scope: string; text: string }>,
  scope: string,
  now: number,
  options: EchoOptions = {},
): string | null {
  const lookback = options.lookback ?? ECHO.lookback;
  const max = options.max ?? ECHO.max;
  const recent = said
    .filter((l) => l.scope === scope && l.at <= now && now - l.at <= lookback)
    .slice(-max);
  if (recent.length === 0) return null;
  const lines = recent.map((l) => {
    const preview = l.text.length > ECHO.chars ? `${l.text.slice(0, ECHO.chars)}...` : l.text;
    return `- [${diaryAgo(now - l.at)}] "${preview}"`;
  });
  let header = "我最近在这里说过：";
  if (options.detectStarters) {
    const counts = new Map<string, number>();
    for (const l of recent) {
      const s = starterOf(l.text);
      if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    const repeated = [...counts.entries()]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([s, n]) => `「${s}」${n} 次`);
    if (repeated.length > 0) {
      header = `我最近在这里说过（其中重复起手：${repeated.join("、")}）：`;
    }
  }
  return `${header}\n${lines.join("\n")}`;
}
