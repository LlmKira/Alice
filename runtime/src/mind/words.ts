/**
 * 动作参数的词表：表情、心情、贴纸。登记表按它们校验参数（mind/args.ts），发言层按它们写说明。
 */

/** Telegram 标准表情回应（2 月 ALLOWED_REACTIONS）。 */
export const REACTIONS = [
  "👍",
  "👎",
  "❤",
  "🔥",
  "🥰",
  "👏",
  "😁",
  "🤔",
  "🤯",
  "😱",
  "🤬",
  "😢",
  "🎉",
  "🤩",
  "🤮",
  "💩",
  "🙏",
  "👌",
  "🕊",
  "🤡",
  "🥱",
  "🥴",
  "😍",
  "🐳",
  "❤‍🔥",
  "🌚",
  "🌭",
  "💯",
  "🤣",
  "⚡",
  "🍌",
  "🏆",
  "💔",
  "🤨",
  "😐",
  "🍓",
  "🍾",
  "💋",
  "🖕",
  "😈",
  "😴",
  "😭",
  "🤓",
  "👻",
  "👨‍💻",
  "👀",
  "🎃",
  "🙈",
  "😇",
  "😨",
  "🤝",
  "✍",
  "🤗",
  "🫡",
  "🎅",
  "🎄",
  "☃",
  "💅",
  "🤪",
  "🗿",
  "🆒",
  "💘",
  "🙉",
  "🦄",
  "😘",
  "💊",
  "🙊",
  "😎",
  "👾",
  "🤷‍♂",
  "🤷",
  "🤷‍♀",
  "😡",
] as const;

/** 提示词里列出的常用几个；解析时接受整个 REACTIONS。 */
export const COMMON_REACTIONS = [
  "👍",
  "❤",
  "😁",
  "🤣",
  "🤔",
  "😢",
  "🔥",
  "🎉",
  "👌",
  "🙏",
  "😭",
  "👀",
];

/**
 * 心情用她自己的词（PLAN 第 34 件；以前只能从 14 个词里选，词表外的整条作废）。效价不查表，由外壳问判口气的模型
 * （llm/tone.ts perceiveMood）。这里只限长度：超过这么多字就不是一个词或短说法了，不认。手设。
 */
export const MOOD_CHARS = 12;

/** 她写的心情词：去掉首尾空白和句末标点；空的或太长的不认（null）。 */
export function moodWord(raw: string): string | null {
  const word = raw.trim().replace(/[。.！!～~…，,]+$/u, "");
  return word && [...word].length <= MOOD_CHARS ? word : null;
}

/** 她能发的贴纸种类（按情绪/动作分）。发送时由 palette 映射到真实贴纸。 */
export const STICKER_WORDS = [
  "happy",
  "sad",
  "angry",
  "surprised",
  "shy",
  "love",
  "tired",
  "scared",
  "hug",
  "cry",
  "laugh",
  "wave",
  "thumbsup",
  "facepalm",
  "peek",
] as const;

export type StickerWord = (typeof STICKER_WORDS)[number];
export function isStickerWord(word: string): word is StickerWord {
  return (STICKER_WORDS as readonly string[]).includes(word);
}

/** 自然语言贴纸描述的字数上限：放行短语或情绪词，挡掉一整段话。 */
export const STICKER_CHARS = 24;

/** 贴纸参数：英文常用词规范成小写；也接受简短中文/外文自然语言描述。 */
export function stickerWord(raw: string): string | null {
  const cleaned = raw.trim().replace(/[。.！!～~…，,]+$/u, "");
  if (!cleaned || [...cleaned].length > STICKER_CHARS) return null;
  const lower = cleaned.toLowerCase();
  return isStickerWord(lower) ? lower : cleaned;
}
