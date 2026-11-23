/**
 * 群里什么时候该看这一眼（ADR-276 环节四、五）：话题和交情合成一股拉力。
 *
 * 旧候选 groupturn 的话题信号（已删）的 idf 只在这个群最近 30 条话和她心里的东西上数。群的话越日常，
 * "知道""不是""这个"这类填充词在背景里也越常见，可一旦这个群自己不怎么用、她心里又有一句带它的话，
 * 它就被当成话题词拉她。这里换成跨会话的文档频率（desire.ts idfOf 同一个做法）：她所有会话最近在聊的
 * 各自算一份文档，填充词在哪儿都有、权重接近 0；"吉他""芙莉莲""露营"这类只在一两处出现的词才拉得动她。
 *
 * 100% 纯函数：时间只来自 event.at，不读时钟、不取随机数、不碰存储（mind-purity）。
 */
import { feature, type PressureFeature } from "./feature.js";
import { chatSubject } from "./memory.js";
import { type RelationView, relationView } from "./relation.js";
import { BOND_HALF_LIFE, pullAt, SALIENCE_MIN, tokens } from "./turn.js";
import { type ChatNode, halfLife, type TurnSignals, type World } from "./world.js";

/** 词 → 数：一个会话里的词频、文档频率或 idf 权重都写成它。 */
export type TermCounts = Readonly<Record<string, number>>;

/** 一段已经按 tokens 切好的话。 */
export type Words = readonly string[];

/** 每个会话最近说话的词频（scope → 词 → 次数）：跨会话 idf 的每一份文档。 */
export type ChatTermFreqs = Readonly<Record<string, TermCounts>>;

/** 跨会话的文档频率：df 是含这个词的文档数，totalDocs 是有词的文档数（每个会话、她心里每样东西各一份）。 */
export interface DocFreqs {
  readonly df: TermCounts;
  readonly totalDocs: number;
}

/** 每个会话留几条别人的话当跨会话 idf 的语料（和 turn.ts 的 RECENT_KEPT 一致）。 */
const RECENT_KEPT = 30;

/**
 * idf 的平滑写法与 desire.ts 相同：ln(文档数 / 文档频率)。填充词在每份文档里都有，权重正好是 0；
 * 没出现过的词按 df = 1 算，权重最高（还要和她心里有重合才算得上话题）。
 */
function idfAt(term: string, df: TermCounts, totalDocs: number): number {
  if (totalDocs <= 0) return 0;
  return Math.log(totalDocs / Math.max(1, df[term] ?? 0));
}

/** 所有会话最近的词频、她心里的每一样各算一份文档，数出全局 df。 */
export function crossChatDocFreqs(
  allChatTermFreqs: ChatTermFreqs,
  memoryItems: readonly Words[],
): DocFreqs {
  const docs: ReadonlySet<string>[] = [];
  for (const freq of Object.values(allChatTermFreqs)) {
    const terms = Object.keys(freq).filter((t) => (freq[t] ?? 0) > 0);
    if (terms.length > 0) docs.push(new Set(terms));
  }
  for (const item of memoryItems) {
    if (item.length > 0) docs.push(new Set(item));
  }
  const df: Record<string, number> = {};
  for (const doc of docs) for (const term of doc) df[term] = (df[term] ?? 0) + 1;
  return { df, totalDocs: docs.length };
}

/**
 * 一条话里每个词的跨会话 idf 权重。所有会话最近在聊的各自一份文档，她心里的每一样再各一份：
 * 到处都在的"知道""不是"接近 0，"芙莉莲""露营"这类少见的词接近 ln(文档数)。
 */
export function crossChatIdf(
  msgTokens: Words,
  allChatTermFreqs: ChatTermFreqs,
  memoryItems: readonly Words[],
): TermCounts {
  const { df, totalDocs } = crossChatDocFreqs(allChatTermFreqs, memoryItems);
  const out: Record<string, number> = {};
  for (const term of new Set(msgTokens)) out[term] = idfAt(term, df, totalDocs);
  return out;
}

/**
 * 一条话和她心里每样东西的 idf 加权余弦取最大（∈ [0, 1]）。权重来自跨会话的全局 df：
 * 填充词的权重是 0，于是由它们组成的句子没有任何分量；少见的话题词只要和她记得的东西重合，就拉得很高。
 */
export function topicSalience(
  messageText: string,
  memoryItems: readonly Words[],
  globalDocFreqs: TermCounts,
  totalDocs: number,
): number {
  const words = tokens(messageText);
  if (words.length === 0 || memoryItems.length === 0 || totalDocs <= 0) return 0;
  const vector = (xs: Words): Map<string, number> | null => {
    const tf = new Map<string, number>();
    for (const t of xs) tf.set(t, (tf.get(t) ?? 0) + 1);
    const v = new Map<string, number>();
    let norm = 0;
    for (const [t, c] of tf) {
      const w = (1 + Math.log(c)) * idfAt(t, globalDocFreqs, totalDocs);
      if (w <= 0) continue;
      v.set(t, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm);
    if (norm === 0) return null;
    for (const [t, w] of v) v.set(t, w / norm);
    return v;
  };
  const message = vector(words);
  if (!message) return 0;
  let best = 0;
  for (const item of memoryItems) {
    const v = vector(item);
    if (!v) continue;
    let dot = 0;
    for (const [t, w] of message) dot += w * (v.get(t) ?? 0);
    best = Math.max(best, Math.min(1, dot));
  }
  return best;
}

/**
 * 说话的人此刻能拉她多少：这条消息之前和她有过有回应的互动（contact.lastBondAt），随后按 24 小时半衰期淡掉。
 */
export function bondPull(
  person: Pick<RelationView, "lastBondAt"> | undefined,
  prior: number,
  at: number,
): number {
  if (!person || person.lastBondAt <= 0) return prior;
  return prior + halfLife(1, at - person.lastBondAt, BOND_HALF_LIFE);
}

/** 她心里已有的东西：说过的话、日记、记得的这个群和群里人的事、这个群里她的话题线。 */
function memoryOf(
  world: Pick<World, "said" | "diary" | "facts">,
  scope: string,
  chat: ChatNode,
): string[] {
  const people = [...new Set(chat.recentFrom)];
  return [
    ...world.said.map((l) => l.text),
    ...world.diary.map((d) => d.text),
    ...(world.facts[chatSubject(scope)] ?? []).map((f) => f.text),
    ...people.flatMap((p) => (world.facts[p] ?? []).map((f) => f.text)),
    ...chat.topics.map((t) => t.title),
  ];
}

/** 每个会话最近的话记成词频（跨会话 idf 的文档）。 */
function termFreqsOf(world: Pick<World, "chats">): ChatTermFreqs {
  const out: Record<string, TermCounts> = {};
  for (const [scope, chat] of Object.entries(world.chats)) {
    const freq: Record<string, number> = {};
    for (const words of chat.turn.recent) {
      for (const term of words) freq[term] = (freq[term] ?? 0) + 1;
    }
    out[scope] = freq;
  }
  return out;
}

/** 改这个会话的 turn：群里的两条拉力，和所有会话共用的最近的话。 */
function withTurn<W extends Pick<World, "chats">>(
  world: W,
  scope: string,
  change: (s: TurnSignals, chat: ChatNode) => TurnSignals,
): W {
  const chat = world.chats[scope];
  if (!chat) return world;
  const turn = change(chat.turn, chat);
  return { ...world, chats: { ...world.chats, [scope]: { ...chat, turn } } };
}

/**
 * 候选 group-pull：群里别人的一条话同时算话题和交情。话题用跨会话 idf（crossChatIdf / topicSalience），
 * 交情用 bondPull；她在群里看过、说过时两股都清零。它取代了旧候选 groupturn 的话题、交情两样：
 * 所有会话的话都记进 recent 当跨会话语料，拉力只在群里的那条写（chats.turn.topic、chats.turn.bond）。
 */
export const groupPull: PressureFeature = feature({
  name: "group-pull",
  provides: ["chats.turn.topic", "chats.turn.bond"],
  requires: ["said", "relations", "willingness"],
  uses: ["diary", "facts", "chats.topics"],
  reduce: (before, after, event) => {
    if (event.type === "message.received") {
      const words = tokens(event.text);
      // 私聊的话只进跨会话语料，不给她这个群的拉力。
      if (event.chatType !== "group") {
        return words.length === 0
          ? after
          : withTurn(after, event.scope, (s) => ({
              ...s,
              recent: [...s.recent, words].slice(-RECENT_KEPT),
            }));
      }
      const chat = after.chats[event.scope];
      if (!chat) return after;
      const items = memoryOf(after, event.scope, chat).map(tokens);
      const { df, totalDocs } = crossChatDocFreqs(termFreqsOf(after), items);
      const salience = topicSalience(event.text ?? "", items, df, totalDocs);
      const person = relationView(before, event.senderId);
      return withTurn(after, event.scope, (s, c) => {
        const prior = pullAt(c, event.at);
        return {
          ...s,
          topic: salience >= SALIENCE_MIN ? Math.max(prior.topic, salience) : prior.topic,
          topicAt: event.at,
          bond: bondPull(person, prior.bond, event.at),
          bondAt: event.at,
          recent: words.length > 0 ? [...s.recent, words].slice(-RECENT_KEPT) : s.recent,
        };
      });
    }
    // 她看过、说过：这个群里这几条话的拉力消耗掉（考虑过就消耗）。
    const looked =
      event.type === "message.sent" ||
      event.type === "speech.decided" ||
      event.type === "speech.failed";
    return looked && after.chats[event.scope]?.chatType === "group"
      ? withTurn(after, event.scope, (s) => ({
          ...s,
          topic: 0,
          topicAt: event.at,
          bond: 0,
          bondAt: event.at,
        }))
      : after;
  },
});
