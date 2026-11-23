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
 * （llm/tone.ts perceiveMood）。这里放宽到 48 字，让俄语、英文和稍完整一点的中文短语都能写下，只挡住整段话。
 */
const MOOD_CHARS = 48;

/** 归整短语：合并空白并去掉句末标点，空或超过上限返回 null。 */
function normalizePhrase(raw: string, maxChars: number): string | null {
  const cleaned = raw
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[。.！!～~…，,]+$/u, "");
  return cleaned && [...cleaned].length <= maxChars ? cleaned : null;
}

/** 她写的心情词：去掉多余空白和句末标点；空的或太长的不认（null）。 */
export function moodWord(raw: string): string | null {
  return normalizePhrase(raw, MOOD_CHARS);
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

type StickerWord = (typeof STICKER_WORDS)[number];

/** 每种常用贴纸词对应的具体画面参考（供未连接本地贴纸库或离线回放时给出可读的视觉提示）。 */
const STICKER_VISUAL_BAG: Readonly<Record<StickerWord, string>> = {
  happy: "眼睛弯成月牙高兴摇尾巴",
  sad: "蔫蔫地垂着耳朵抱膝",
  angry: "鼓起腮帮子气呼呼炸毛",
  surprised: "瞳孔地震竖起耳朵",
  shy: "耳朵发红低头搓手指",
  love: "眼冒小心心凑过来蹭蹭",
  tired: "趴在桌上彻底没电瘫平",
  scared: "抱紧被子瑟瑟发抖",
  hug: "张开手扑过来抱抱",
  cry: "委屈巴巴掉眼泪",
  laugh: "笑到拍桌子打滚",
  wave: "晃着爪子打招呼",
  thumbsup: "竖起大拇指比赞",
  facepalm: "单手扶额没眼看",
  peek: "从门缝探出半个脑袋偷看",
};
const STICKER_VISUAL = new Map<string, string>(Object.entries(STICKER_VISUAL_BAG));

/** 生成带画面描述的默认贴纸清单。 */
export function defaultStickerHints(limit: number = STICKER_WORDS.length): string[] {
  return STICKER_WORDS.slice(0, limit).map((w) => `${w}（${STICKER_VISUAL_BAG[w]}）`);
}

/** 补全贴纸提示里的画面括号描述；已有括号描述则保持原样。 */
export function enrichStickerHint(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  if (trimmed.includes("（") || trimmed.includes("(")) return trimmed;
  const lower = trimmed.toLowerCase();
  const visual = STICKER_VISUAL.get(lower);
  return visual !== undefined ? `${lower}（${visual}）` : trimmed;
}

/** 自然语言贴纸描述的字数上限：放行中英俄短语或画面描述，挡掉一整段话。 */
const STICKER_CHARS = 48;

/** 贴纸参数：英文常用词规范成小写；也接受简短中文/外文自然语言描述。 */
export function stickerWord(raw: string): string | null {
  const cleaned = normalizePhrase(raw, STICKER_CHARS);
  if (!cleaned) return null;
  const lower = cleaned.toLowerCase();
  return STICKER_VISUAL.has(lower) ? lower : cleaned;
}
