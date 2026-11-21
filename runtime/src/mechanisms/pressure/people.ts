/**
 * 她对每个人、每个群知道的具体的事（people；capabilities R05、R08、S07）。
 *
 * PLAN"连续性"：往提示里多放这个人的旧东西（巩固、原文、重逢时放原文）三轮都没带来连续性，画像总结还会加重谄媚
 * （OP-Bench 转述）。所以这里只记具体而稳定的事，不写性格画像、不打信任分，按"送达且无害"判：
 * - R05 印象：他是做什么的、养了什么、上次说要考试。来源是反思时顺手记下的（同一次反思调用，
 *   speech/reflect-people.ts，不加调用次数；2026-11-12 起没有 [记住]，eval-artifacts/memory-b/）。每条带出处（会话、当时在场的人）和时间；
 *   有时间的事过了就写"已经过了"；对不上了的由反思写出旧的原文、换成新的（Mem0 的 UPDATE，2 月 update_fact）。
 *   放进提示词的仍是 recall.ts 的"你记得关于…的事"，受众规则在那里（knownAbout）。
 * - R07 兴趣（谁喜欢、在玩什么）2026-11-12 删了：它不进发言提示词（"他喜欢 X"是讨好的抓手），只给话题打分用，
 *   而话题打分（groupturn 的 topic）判过不上生产（对上的多是虚词），生产里没有读者，反思却每次多花 token 写它。
 * - R08 群画像 2026-11-13 拿掉了：逐个拿掉时效应在噪声里，它的"话题"又带着房间的口气，她跟着骂起来
 *   （eval-artifacts/ablation-live/results.md、live-review/2026-11-13.md）。
 * - S07 社交周边视觉：私聊里，对方在你们都在的群里最近怎么样——只用他本人在那个群里公开说话的次数和日子
 *   （很久没说话了、刚回来），不用任何私聊里的东西。
 * - R06 她自己说过的事：反思时也记她自己说出口的关于她自己的事（存在 SELF_SUBJECT 下），放进卡片；
 *   受众规则和日记同一条（selfKnown）；在它自己的会话里那段对话还在时不放（selfText）。依据 eval-artifacts/memory-b/。
 * 纯函数，时间只来自事件。
 */
import type { PeopleAsk } from "../../mind/effects.js";
import type { AliceEvent } from "../../mind/events.js";
import type { Contribution, PonderAsk } from "../../mind/mechanism.js";
import type { ChatState } from "../../mind/state.js";
import { elapsed, localDay, parseWhen } from "../../mind/when.js";
import { type Audience, audienceOf, reaches } from "./diary.js";
import { feature, type PressureFeature, type View } from "./feature.js";
import { segmentSince } from "./inner.js";
import { type Fact, keyOf, rememberFact, salient } from "./memory.js";
import { FACT_REINFORCE } from "./params.js";
import { placeOf } from "./place.js";
import { knownAbout } from "./recall.js";
import { nameOf } from "./relation.js";
import { presentIn } from "./world.js";

export interface PeopleOptions {
  /** R05：反思时记下关于人的具体的事。 */
  facts?: boolean;
  /** S07：私聊里，对方在你们都在的群里最近怎么样。 */
  peripheral?: boolean;
  /** R06：反思时另记她自己说出口的关于她自己的事（同一次调用），放进卡片。 */
  self?: boolean;
}

/** 她自己说过的关于自己的事，存在 world.facts 的这个主体下（不是联系人 id，也不是群）。 */
export const SELF_SUBJECT = "alice:self";

export const PEOPLE_ALL: PeopleOptions = {
  facts: true,
  peripheral: true,
  self: true,
};

/** 参数（手设，写明理由）。 */
export const PEOPLE = {
  /** 换个说法的同一件事（两字片段 Jaccard）：超过就当作同一件、换成新的写法。与日记去重同一个量（diary.ts）。 */
  duplicate: 0.5,
  /** 反思时给她看每人已经记得的几件。 */
  knownShown: 6,
  /** "之前常说"：一段 regularDays 天里说过至少 regularMin 条、至少两天。 */
  regularDays: 14,
  regularMin: 5,
  /** "很久没说话了"：离他上一条至少 quietDays 天，而那之前 regularDays 天里他说过至少 regularMin 条。 */
  quietDays: 3,
  /** "刚回来"：上一条在 backDays 天之内，而再往前一条隔了至少 awayDays 天。 */
  backDays: 3,
  awayDays: 7,
  /** 卡片里放她自己说过的几件。 */
  selfShown: 4,
} as const;

// ── 字词（换说法的去重）──────────────────────────────────────────────

/** 中文按两字片段（一个字的就是这个字），拉丁字母和数字按词（小写）。 */
export function terms(text: string): Set<string> {
  const out = new Set<string>();
  for (const run of text.toLowerCase().match(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu) ?? []) {
    if (/^\p{Script=Han}/u.test(run)) {
      const chars = [...run];
      if (chars.length === 1) out.add(run);
      for (let i = 0; i + 1 < chars.length; i++) out.add(`${chars[i]}${chars[i + 1]}`);
    } else if (run.length >= 2 || /\p{N}/u.test(run)) {
      out.add(run);
    }
  }
  return out;
}

function jaccard(a: string, b: string): number {
  const x = terms(a);
  const y = terms(b);
  const both = [...x].filter((t) => y.has(t)).length;
  return both / Math.max(1, x.size + y.size - both);
}

// ── 折叠 ─────────────────────────────────────────────────────────────

/** 按内容认一件已经记得的事：键相同、一方包含另一方，或换了个说法（两字片段 Jaccard 超过 duplicate）。 */
function find(facts: readonly Fact[], text: string): Fact | undefined {
  const key = keyOf(text);
  if (!key) return undefined;
  return (
    facts.find((f) => f.key === key) ??
    facts.find((f) => f.key.includes(key) || key.includes(f.key)) ??
    facts.find((f) => jaccard(f.text, text) > PEOPLE.duplicate)
  );
}

interface Learned {
  text: string;
  when: string | null;
  replaces: string | null;
  private?: true | undefined;
}

/**
 * 记下关于一个人的一件事：先去掉它改掉的那件（认得出才去），同一件事（含换了说法的）是强化、换成新的写法，
 * 否则是新的一件（每人有上限，淘汰可检索性最低的，memory.ts rememberFact）。出处、在场的人、时间都换成这一次的；
 * 标过私密的再记一次也还是私密的（她又提了一次，不等于它不再是托付的事）。
 */
export function learnFact(
  facts: readonly Fact[] | undefined,
  learned: Learned,
  scope: string,
  present: readonly string[],
  at: number,
): Fact[] {
  const replaced = learned.replaces ? find(facts ?? [], learned.replaces) : undefined;
  const list = (facts ?? []).filter((f) => f !== replaced);
  const when = learned.when
    ? { said: learned.when, at, due: parseWhen(learned.when, at)?.due ?? null }
    : null;
  const same = find(list, learned.text);
  const secret = learned.private || same?.origin.private || replaced?.origin.private;
  const origin = {
    kind: "reflected" as const,
    present,
    when,
    ...(secret ? { private: true as const } : {}),
  };
  if (same) {
    const text = learned.text.trim().slice(0, 200);
    return list.map((f) =>
      f === same
        ? {
            ...f,
            text,
            key: keyOf(text),
            scope,
            lastAt: at,
            stability: f.stability * FACT_REINFORCE,
            count: f.count + 1,
            origin,
          }
        : f,
    );
  }
  return rememberFact(list, learned.text, scope, at, origin);
}

/** 在压力场的世界折叠之后再折叠：反思顺手记下的事、她自己说过的。群里谁在说话由 relation 折进 relations。 */
export function reducePeople<W extends View<"facts" | "chats">>(
  world: W,
  event: AliceEvent,
  o: PeopleOptions,
): W {
  if (event.type === "act.done" && event.act.kind === "note-self" && o.self) {
    const node = world.chats[event.scope];
    const claim = {
      text: event.act.text,
      when: null,
      replaces: event.act.replaces,
    };
    return {
      ...world,
      facts: {
        ...world.facts,
        [SELF_SUBJECT]: learnFact(
          world.facts[SELF_SUBJECT],
          claim,
          event.scope,
          presentIn(node),
          event.at,
        ),
      },
    };
  }
  if (event.type !== "ponder.done" || event.ponder.kind !== "reflect") return world;
  const p = event.ponder;
  const learned = p.learned ?? {};
  const node = world.chats[p.scope];
  const present = presentIn(node);
  let facts = world.facts;
  // 只记有出处的（reflect-people.ts quoted）：Journal 里 2026-11-13 之前记下的没有出处，里面混着画像和"该怎么对他"，
  // 不再折叠进来，下次反思重新记。
  for (const f of o.facts ? (learned.facts ?? []).filter((x) => x.said) : []) {
    facts = { ...facts, [f.about]: learnFact(facts[f.about], f, p.scope, present, event.at) };
  }
  for (const s of o.self ? (learned.self ?? []).filter((x) => x.said) : []) {
    const claim = {
      text: s.text,
      when: null,
      replaces: s.replaces,
      private: s.private,
    };
    facts = {
      ...facts,
      [SELF_SUBJECT]: learnFact(facts[SELF_SUBJECT], claim, p.scope, present, event.at),
    };
  }
  return { ...world, facts };
}

// ── 反思时多要的 ─────────────────────────────────────────────────────

/** 在反思请求上加上"顺手记下关于人的事"：她已经记得的（只给那个会话里看得见的）。 */
export function withPeople(
  ask: PonderAsk,
  world: View<"facts" | "chats">,
  now: number,
  o: PeopleOptions,
): PonderAsk {
  if (ask.kind !== "reflect" || !o.facts) return ask;
  const here = { scope: ask.scope, chatType: ask.chatType };
  const learn: PeopleAsk = {
    facts: o.facts === true,
    known: o.facts
      ? ask.people.map((p, who) => ({
          who,
          facts: salient(knownAbout(world, p.id, here), now)
            .slice(0, PEOPLE.knownShown)
            .map((f) => f.text),
        }))
      : [],
    ...(o.self
      ? {
          self: {
            known: salient(selfKnown(world, audienceOf(world, ask.scope)), now)
              .slice(0, PEOPLE.knownShown)
              .map((f) => f.text),
          },
        }
      : {}),
  };
  return { ...ask, learn };
}

// ── 她自己说过的关于自己的事 ────────────────────────────────────────

/**
 * 她自己说过的关于自己的事，在这个会话里看得见哪些。和日记是同一条（diary.ts reaches，北极星不变量 1）：
 * 标了私密的只在说的那个会话、和与当时在场的人的私聊里；其余的哪里都看得见，注明在哪说的。
 */
export function selfKnown(world: View<"facts" | "chats">, here: Audience): Fact[] {
  return (world.facts[SELF_SUBJECT] ?? []).filter((f) =>
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

/**
 * 卡片上的"我自己说过的"：只放这里的新信息。在哪个会话里说的，那段对话还在时不放：还在时间线上（和日记在自己
 * 会话里的显示同一条界线），或者这段对话从那时起一直没停（相邻两条隔不到 SEGMENT_GAP_MS，inner.ts segmentSince；
 * 热闹的群里 30 条几分钟就滚过去了，只看时间线挡不住）。那句原话就在这段对话里，卡片再写一遍只会把一时的道具
 * 变成反复出现的母题（线上 261 次群聊发言调用里 60 次带着她 30 分钟内在同一个群里说过的话，茶在 14 分钟里说了
 * 6 次，eval-artifacts/aliveness/）。时刻取记下它的那次反思（原话在那之前）。
 */
type Script = "cjk" | "cyrillic" | "latin";

function scriptOf(text: string): Script | null {
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return "cjk";
  if (/[\p{Script=Cyrillic}]/u.test(text)) return "cyrillic";
  if (/[a-zA-Z]/.test(text)) return "latin";
  return null;
}

function chatScript(chat: ChatState): Script | null {
  for (let i = chat.timeline.length - 1; i >= 0; i--) {
    const s = scriptOf(chat.timeline[i]?.text ?? "");
    if (s) return s;
  }
  return null;
}

function selfText(
  world: View<"facts" | "chats" | "relations">,
  chat: ChatState,
  now: number,
): string | null {
  const here = audienceOf(world, chat.scope, chat);
  const talking = segmentSince(chat, now);
  const saidInThisTalk = (f: Fact) =>
    f.scope === chat.scope &&
    (here.onTimeline(f.lastAt) || (talking !== null && f.lastAt >= talking));
  const ranked = salient(
    selfKnown(world, here).filter((f) => !saidInThisTalk(f)),
    now,
  );
  const script = chatScript(chat);
  const ordered = script
    ? [
        ...ranked.filter((f) => scriptOf(f.text) === script),
        ...ranked.filter((f) => scriptOf(f.text) !== script),
      ]
    : ranked;
  const lines = ordered
    .slice(0, PEOPLE.selfShown)
    .map(
      (f) =>
        `${f.text}（${elapsed(now - f.lastAt)}前${f.scope === chat.scope ? "在这里" : placeOf(world, f.scope)}说的）`,
    );
  return lines.length > 0 ? `我自己说过的：${lines.join("；")}` : null;
}

// ── 放进提示词 ───────────────────────────────────────────────────────

const personName = (world: View<"relations">, id: string) => nameOf(world, id) ?? "某人";

function countSince(
  seen: { days: ReadonlyArray<readonly [number, number]> },
  fromDay: number,
  toDay: number,
) {
  const inRange = seen.days.filter(([d]) => d >= fromDay && d <= toDay);
  return { messages: inRange.reduce((s, [, n]) => s + n, 0), days: inRange.length };
}

/**
 * S07：私聊的对方在你们都在的群里最近怎么样：很久没在那里说话了（之前常说），或刚回来说话（之前很久没出现）。
 * 只用他本人在群里公开说话的日子；她不在那个群里了就不写。
 */
function peripheralText(
  world: View<"chats" | "relations">,
  partner: string,
  now: number,
): string | null {
  const today = localDay(now);
  const lines: string[] = [];
  for (const [scope, seen] of Object.entries(world.relations.people[partner]?.seen.rooms ?? {})) {
    if (!world.chats[scope]?.member || seen.lastAt > now) continue;
    const lastDay = localDay(seen.lastAt);
    const quiet = today - lastDay;
    if (quiet >= PEOPLE.quietDays) {
      const before = countSince(seen, lastDay - PEOPLE.regularDays + 1, lastDay);
      if (before.messages >= PEOPLE.regularMin && before.days >= 2) {
        lines.push(`已经 ${quiet} 天没说话了（之前常说）`);
      }
      continue;
    }
    const previous = seen.days.filter(([d]) => d < lastDay).at(-1);
    if (quiet < PEOPLE.backDays && previous && lastDay - previous[0] >= PEOPLE.awayDays) {
      const when = quiet === 0 ? "今天" : quiet === 1 ? "昨天" : `${quiet} 天前`;
      lines.push(`${when}刚回来说话（之前 ${lastDay - previous[0]} 天没出现）`);
    }
  }
  if (lines.length === 0) return null;
  const name = personName(world, partner);
  return lines.length === 1
    ? `${name}在我们都在的群里${lines[0]}。`
    : `${name}在我们都在的几个群里：\n${lines.map((l) => `- 一个群里${l}`).join("\n")}`;
}

/**
 * 她对每个人、每个群知道的具体的事：在压力场的世界折叠之后再折叠，反思时顺手多问，往提示词里放群画像和
 * 社交周边视觉（关于人的事实由记忆的"你记得关于…的事"放，受众规则在 recall.ts knownAbout）。
 */
export function people(o: PeopleOptions): PressureFeature {
  const off = (Object.keys(PEOPLE_ALL) as Array<keyof PeopleOptions>).filter((k) => !o[k]);
  return feature({
    name: ["people", ...off.map((k) => `no${k}`)].join("-"),
    provides: ["facts"],
    requires: ["chats", "relations"],
    reduce: (_before, after, event) => reducePeople(after, event, o),
    refine: (ask, world, now) => withPeople(ask, world, now, o),
    contribute: ({ world, chat, now }) => peopleFacts(world, chat, now, o),
  });
}

function peopleFacts(
  world: View<"facts" | "chats" | "relations">,
  chat: ChatState,
  now: number,
  o: PeopleOptions,
): Contribution[] {
  const node = world.chats[chat.scope];
  const text =
    chat.chatType === "private" && o.peripheral && node?.partner
      ? peripheralText(world, node.partner, now)
      : null;
  const self = o.self ? selfText(world, chat, now) : null;
  return [text, self].flatMap((t) =>
    t ? [{ mechanism: "pressure-people", kind: "people" as const, text: t }] : [],
  );
}
