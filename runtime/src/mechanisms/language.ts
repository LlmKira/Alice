/**
 * 谁在用什么语言跟她说话：作为事实放进提示词。提示词的框架和示例是中文，不写这条事实时，
 * 别人用俄语、英语、日语私聊她，她几乎都回中文；写上一句"（Миша 说俄语。）"后 10/10 跟着对方的语言
 * （2026-11-11 探针，五个情境各 10 次）。
 * 语言由统计模型识别（eld，Nito-ELD 的 n-gram 识别器），不用规则：单条短句（"lol""xswl""ну да"）
 * 谁都认不准，所以按人合并他在这个会话里最近几条再认（探针 12/12，含俚语和乌克兰语/俄语之分）。
 */
import { eld } from "eld/large";
import type { Contribution, Mechanism } from "../mind/mechanism.js";
import type { ChatState, TimelineEntry } from "../mind/state.js";

/** 看最近几条消息里出现的人；每人取他最近几条合起来认。 */
const RECENT_ENTRIES = 12;
const PER_PERSON = 5;
const MAX_PEOPLE = 4;

const names = new Intl.DisplayNames(["zh-Hans"], { type: "language" });

/**
 * 识别器有把握（isReliable），或者字够多，才说：统计识别在很短的文字上不可靠——"Alice，早。"（8 个字）
 * 被认成菲律宾语，事实写成"用菲律宾语跟你说话"，她就回了一句菲律宾语（batch-1111 场景集）。说错比不说更糟；
 * 不说时由她自己看记录、按"说这段聊天里大家在用的语言"那句判断。只认有把握的又太严：
 * "привет / я так устал сегодня…"它没把握但认对了，不写这条事实她就回中文。
 */
const ENOUGH_TEXT = 20;

function detect(text: string): string | null {
  const result = eld.detect(text);
  const code = result.language;
  const long = [...text.replace(/\s/g, "")].length >= ENOUGH_TEXT;
  if (!code || (!result.isReliable() && !long)) return null;
  try {
    return names.of(code) ?? null;
  } catch {
    return null;
  }
}

/**
 * 一条话主要用的文字（汉字、假名、西里尔、拉丁……）；日文混着汉字和假名，有假名就算假名。汉字、假名、谚文按字数，
 * 拼音文字按词数（"sumomo是moss我不是"是中文，不是拉丁文）。
 */
const SCRIPTS = [
  "Hiragana",
  "Katakana",
  "Hangul",
  "Han",
  "Thai",
  "Cyrillic",
  "Arabic",
  "Hebrew",
  "Greek",
  "Latin",
] as const;
const BY_CHAR = new Set(["Hiragana", "Katakana", "Hangul", "Han", "Thai"]);
function scriptOf(text: string): string | null {
  const counts = SCRIPTS.map(
    (s) =>
      text.match(new RegExp(`\\p{Script=${s}}${BY_CHAR.has(s) ? "" : "+"}`, "gu"))?.length ?? 0,
  );
  if ((counts[0] ?? 0) + (counts[1] ?? 0) > 0) return "Kana";
  let best = -1;
  counts.forEach((n, i) => {
    if (n > 0 && (best < 0 || n > (counts[best] ?? 0))) best = i;
  });
  return best < 0 ? null : (SCRIPTS[best] ?? null);
}

/**
 * 他说的语言：先按条数看他最近几条话多数用的是哪种文字，再把用这种文字的几条合起来认。按字数合并时，线上一个说中文的人
 * 贴了一段约 1,500 字的英文画图提示词给别人，整个人成了"在说英语"，她就用英语回了中文群（2026-11-13）。
 * 不逐条认语言：单条短句认不准，俄语短句一条条认会成白俄罗斯语、塞尔维亚语；同一种文字里仍旧合起来认。
 * 条数一样时取最近那条的文字（texts 从新到旧）；那几条认不出（"kk"）就看下一种文字。
 */
function languageOf(texts: readonly string[]): string | null {
  const bare = texts.map(withoutLinks);
  const scripts = bare.map(scriptOf);
  for (const script of ranked(scripts)) {
    const found = detect(bare.filter((_, i) => scripts[i] === script).join("\n"));
    if (found) return found;
  }
  return null;
}

/** 按出现次数从多到少（null 不算）；一样多时靠前的在前。 */
function ranked(votes: ReadonlyArray<string | null>): string[] {
  const counts = new Map<string, number>();
  for (const v of votes) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.keys()].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
}

const withoutLinks = (text: string): string => text.replace(/https?:\/\/\S+/g, "");

/**
 * 这一条是不是有人在说话：机器人发的不是；发给机器人的也不是——命令（"!погода"、"/start"）、@某个 bot、回复机器人的消息；
 * 只有话题标签和 @ 的也不是。线上把只发过一条 "!" 开头的机器人命令的人写成"用白俄罗斯语跟你说话"、只发标签的写成保加利亚语
 * （eval-artifacts/ablation-live/results.md）。
 */
function spoken(entry: TimelineEntry, timeline: readonly TimelineEntry[]): boolean {
  const text = entry.text?.trim() ?? "";
  if (!entry.sender || entry.sender.isBot || !text) return false;
  if (/^[/!]\p{L}/u.test(text) || /@\w*bot\b/i.test(text)) return false;
  // 只有链接、标签、@ 的也不是在说话（一条 t.me 链接被认成阿尔巴尼亚语，一串 pixiv 链接被认成英语）。
  if (!/\p{L}/u.test(withoutLinks(text).replace(/[#@]\S+/g, ""))) return false;
  const to = entry.replyToMessageId
    ? timeline.find((e) => e.messageId === entry.replyToMessageId)
    : undefined;
  return !to?.sender?.isBot;
}

/** 最近说话的人（最近的在前）和他们说的语言。 */
function speakersLanguages(chat: ChatState): Array<{ name: string; language: string }> {
  const order: string[] = [];
  const byId = new Map<string, { name: string; texts: string[] }>();
  for (const entry of chat.timeline.slice(-RECENT_ENTRIES).reverse()) {
    // 机器人（群管、签到）不是在跟她说话的人：线上写成过"Rose 用俄语跟你说话"。
    if (!entry.sender || !spoken(entry, chat.timeline)) continue;
    const person = byId.get(entry.sender.id) ?? { name: entry.sender.name, texts: [] };
    if (!byId.has(entry.sender.id)) {
      byId.set(entry.sender.id, person);
      order.push(entry.sender.id);
    }
  }
  // 每人取他在整段时间线里最近的几条（不止最近 12 条里的那一两句）。
  for (const entry of [...chat.timeline].reverse()) {
    const person = entry.sender ? byId.get(entry.sender.id) : undefined;
    if (person && entry.text && spoken(entry, chat.timeline) && person.texts.length < PER_PERSON)
      person.texts.push(entry.text);
  }
  return order.slice(0, MAX_PEOPLE).flatMap((id) => {
    const person = byId.get(id);
    const language = person ? languageOf(person.texts) : null;
    return person && language ? [{ name: person.name, language }] : [];
  });
}

export const language: Mechanism = {
  name: "language",
  contribute(chat: ChatState): Contribution[] {
    const speakers = speakersLanguages(chat);
    if (speakers.length === 0) return [];
    const groups = new Map<string, string[]>();
    for (const s of speakers) groups.set(s.language, [...(groups.get(s.language) ?? []), s.name]);
    // 写法和探针里 10/10 的那句一样："用俄语跟你说话"比"说俄语"更像在说此刻这段对话。
    const parts = Array.from(groups, ([lang, who]) => `${who.join("、")} 用${lang}跟你说话`);
    // 没人找她时（群里别人自己聊，或私聊里久未发言），他们此刻没在跟她说话。
    const aside = Array.from(groups, ([lang, who]) =>
      chat.chatType === "private"
        ? `${who.join("、")} 平时说${lang}`
        : `${who.join("、")} 在说${lang}`,
    );
    // 她该用的语言：有人找她时是最近说话的那个人说的；群里没人找她时是在场多数人说的（一人一票，一样多时取最近的）。
    const language = speakers[0]?.language;
    const room = ranked(speakers.map((s) => s.language))[0];
    return [
      {
        mechanism: "language",
        kind: "turn",
        text: `${parts.join("；")}。`,
        unsoughtText: `${aside.join("；")}。`,
        ...(language ? { language } : {}),
        ...(room ? { unsoughtLanguage: room } : {}),
      },
    ];
  },
};
