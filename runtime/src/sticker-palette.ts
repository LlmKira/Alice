/**
 * 贴纸调色板（迁移自旧 sticker-palette——@see ADR-148/153/168），各平台共用，按 platform 列各管各的。
 *
 * 真实社交用贴纸而非 emoji 堆砌；LLM 只需描述情绪/动作维度
 * （happy/sad/hug/laugh...），本模块从 sticker_palette 表（Telegram 225 条真实贴纸，
 * 旧数据保留；QQ 的表情包看过一次就收进来）匹配最佳贴纸 fileId。
 *
 * 匹配降级链：
 * 1. dimension：emotion/action 列精确匹配（LLM 标准查询词汇）
 * 2. emoji：keyword → emoji → emoji 列匹配
 * 3. label：label 列包含匹配
 * 4. null（发送记为 send.failed）
 *
 * 新库里没有这张表时一律返回 null。
 *
 * 看贴纸（perceiveSticker）也在这里：同一张贴纸只问一次看图模型，看懂的顺带收进这个平台的贴纸库。
 */

import { getSqlite } from "./db/connection.js";
import { hasStickerTable, putSticker, relabelSticker } from "./journal.js";
import type { Gateway } from "./llm/gateway.js";
import {
  describeSticker,
  formatStickerMedia,
  type StickerCache,
  type StickerMeta,
  type StickerPerception,
} from "./llm/sticker-perceive.js";

const EMOTIONS = new Set(["happy", "sad", "angry", "surprised", "shy", "love", "tired", "scared"]);

const ACTIONS = new Set(["hug", "cry", "laugh", "wave", "thumbsup", "facepalm", "peek"]);

/**
 * 语义关键词 → 由近到远的 emoji（调色板 emoji 列匹配用；结构侧，LLM 不可见）。同一个意思的 emoji 有好几个
 * （笑：😂 🤣 😆 😁），只认一个时就会落空：线上第一天她两次选 laugh，库里的笑脸贴纸是 😁 😝，都没发出去。
 */
const KEYWORD_TO_EMOJI: Record<string, readonly string[]> = {
  happy: ["😄", "😁", "😊", "🥰"],
  sad: ["😢", "🥺", "😭"],
  angry: ["😠", "😡"],
  surprised: ["😲", "😮"],
  shy: ["😳", "🥺"],
  love: ["❤️", "🥰", "😘"],
  tired: ["😪", "🫠"],
  scared: ["😨"],
  laugh: ["😂", "🤣", "😆", "😁", "😝"],
  cry: ["😭", "😢"],
  wave: ["👋"],
  thumbsup: ["👍"],
  facepalm: ["🤦", "🫠"],
  peek: ["👀"],
};

/** 都没对上时退到意思最近的情绪（贴纸库按情绪标得最全）。 */
const NEAREST_EMOTION: Record<string, string> = {
  laugh: "happy",
  facepalm: "tired",
  wave: "happy",
  thumbsup: "happy",
  peek: "shy",
  hug: "love",
  cry: "sad",
};
/** 中文情绪/描写关键词到标准维度的映射（用于 VLM 入库归类和中文自然语言查询）。 */
const ZH_EMOTION: ReadonlyArray<readonly [RegExp, string]> = [
  [/开心|高兴|乐|兴奋|大笑|微笑|好耶|赞同|点头/, "happy"],
  [/难过|伤心|委屈|遗憾|失落|感动/, "sad"],
  [/生气|愤怒|恼|炸毛|烦|不满/, "angry"],
  [/惊讶|震惊|吃惊|懵|疑惑|不解/, "surprised"],
  [/害羞|脸红|不好意思|羞/, "shy"],
  [/爱|喜欢|喜爱|比心|贴贴|亲|撒娇|期待/, "love"],
  [/[累困瘫]|疲惫|摸鱼|无语|摆烂/, "tired"],
  [/害怕|吓|慌|紧张|崩溃|痛哭/, "scared"],
];

const ZH_ACTION: ReadonlyArray<readonly [RegExp, string]> = [
  [/抱|拥抱|摸摸头|揉揉|安慰|贴贴/, "hug"],
  [/哭|流泪|呜|崩溃|土下座/, "cry"],
  [/笑|哈哈|咧嘴|偷笑/, "laugh"],
  [/挥手|再见|拜拜|打招呼/, "wave"],
  [/[赞棒牛]|点头|同意|支持/, "thumbsup"],
  [/捂脸|无语|叹气|无奈|扶额/, "facepalm"],
  [/偷看|探头|暗中观察|盯/, "peek"],
];

/** 查询词本身的中文别名 -> 标准词。 */
const ZH_QUERY_MAP: ReadonlyArray<readonly [RegExp, string]> = [...ZH_ACTION, ...ZH_EMOTION];

interface PaletteRow {
  fileId: string;
  fileUniqueId: string;
  label: string;
  emoji: string;
  setName: string;
  emotion: string;
  action: string;
}

function queryPalette(platform: string): PaletteRow[] {
  if (!hasStickerTable()) return [];
  return getSqlite()
    .prepare(
      `SELECT file_id as fileId, file_unique_id as fileUniqueId, label,
              COALESCE(emoji, '') as emoji, COALESCE(set_name, '') as setName,
              COALESCE(emotion, '') as emotion, COALESCE(action, '') as action
         FROM sticker_palette WHERE platform = ? AND file_id IS NOT NULL AND file_id != ''`,
    )
    .all(platform) as PaletteRow[];
}

/** 这个平台的贴纸库里有没有这张（启动时收藏表情只看还没看过的）。 */
export function knownSticker(fileUniqueId: string, platform: string): boolean {
  if (!hasStickerTable()) return false;
  return (
    getSqlite()
      .prepare("SELECT 1 FROM sticker_palette WHERE platform = ? AND file_unique_id = ?")
      .get(platform, fileUniqueId) !== undefined
  );
}

function bigrams(s: string): Set<string> {
  const chars = [...s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "")];
  const out = new Set<string>();
  for (let i = 1; i < chars.length; i++) out.add(`${chars[i - 1]}${chars[i]}`);
  return out;
}

function mapBy(
  rules: ReadonlyArray<readonly [RegExp, string]>,
  text: string,
  fallback: string,
): string {
  for (const [re, value] of rules) if (re.test(text)) return value;
  return fallback;
}

function isRefusalSummary(summary: string): boolean {
  const lower = summary.toLowerCase();
  return !summary.trim() || lower.includes("i cannot") || lower.includes("unable to");
}

/**
 * ADR-168 D2 两阶段精化：把 VLM 看懂的贴纸写进调色板。
 * 已有 file_unique_id 时覆盖更新其描述与情绪/动作维度；新贴纸则安全收进调色板供以后自然语言调用。
 */
export function upsertStickerPerception(input: {
  fileId: string;
  fileUniqueId: string;
  emoji?: string;
  setName?: string;
  summary: string;
  text?: string | null;
  emotion?: string;
  now?: number;
  platform?: string;
}): boolean {
  if (!input.fileId || !input.fileUniqueId || isRefusalSummary(input.summary)) return false;
  const combined = `${input.emotion ?? ""} ${input.summary} ${input.text ?? ""}`;
  putSticker(
    {
      fileId: input.fileId,
      fileUniqueId: input.fileUniqueId,
      label: labelOf(input.summary, input.text),
      emoji: input.emoji ?? null,
      setName: input.setName ?? null,
      emotion: mapBy(ZH_EMOTION, combined, "neutral"),
      action: mapBy(ZH_ACTION, combined, "none"),
    },
    input.now ?? Date.now(),
    input.platform ?? "telegram",
  );
  return true;
}

/** 贴纸库里的说明：看图得到的描述，图上有字时带上那几个字。 */
function labelOf(summary: string, text: string | null | undefined): string {
  const caption = text?.trim() ?? "";
  return [summary.trim(), caption && !summary.includes(caption) ? `「${caption}」` : ""]
    .filter(Boolean)
    .join("");
}

/** 看图缓存的键：平台加上贴纸在那个平台上的 id。 */
function stickerCacheKey(platform: string, fileUniqueId: string): string {
  return `${platform}:${fileUniqueId}`;
}

/** 缓存键属于哪个平台的哪张贴纸；没有平台前缀的是加平台之前 Telegram 写的旧行。 */
function cacheOwner(key: string): { platform: string; fileUniqueId: string } {
  const m = /^(telegram|qq):(.+)$/.exec(key);
  return m
    ? { platform: m[1] as string, fileUniqueId: m[2] as string }
    : { platform: "telegram", fileUniqueId: key };
}

/** 启动时用 sticker-cache.db 已有 VLM 缓存精化这个平台调色板里重合的贴纸，零额外模型调用。 */
export function syncStickerCache(
  entries: ReadonlyArray<{
    fileUniqueId: string;
    summary: string;
    text: string | null;
    emotion: string;
  }>,
  platform = "telegram",
): number {
  if (!hasStickerTable() || entries.length === 0) return 0;
  const select = getSqlite().prepare<[string, string], { label: string; emotion: string }>(
    "SELECT label, emotion FROM sticker_palette WHERE file_unique_id = ? AND platform = ?",
  );
  let updated = 0;
  for (const e of entries) {
    if (isRefusalSummary(e.summary)) continue;
    const owner = cacheOwner(e.fileUniqueId);
    if (owner.platform !== platform) continue;
    const row = select.get(owner.fileUniqueId, platform);
    if (!row) continue;
    const combined = `${e.emotion} ${e.summary} ${e.text ?? ""}`;
    const emotion = mapBy(ZH_EMOTION, combined, row.emotion || "neutral");
    const label = labelOf(e.summary, e.text);
    if (row.label !== label || row.emotion !== emotion) {
      const action = mapBy(ZH_ACTION, combined, "none");
      relabelSticker(owner.fileUniqueId, label, emotion, action, platform);
      updated++;
    }
  }
  return updated;
}

/** 平台交给看图的一张贴纸：哪个平台、能用来再发出去的 fileId、去重用的 fileUniqueId，和随消息来的提示。 */
export interface StickerSeen extends StickerMeta {
  platform: string;
  fileId?: string;
  fileUniqueId?: string;
}

/**
 * 看贴纸：同一张贴纸只问一次看图模型（缓存键带平台；Telegram 的旧缓存行没有前缀，也认），
 * 有 fileId 和 fileUniqueId 时把看到的描述收进这个平台的贴纸库。返回时间线里那一行。
 */
export function perceiveSticker(gateway: Gateway, cache: StickerCache) {
  // 同一张贴纸几乎同时出现在几个群里：正在看的那次结果大家共用，不重复调模型。
  const looking = new Map<string, Promise<StickerPerception>>();
  const look = (key: string | null, meta: StickerMeta, load: () => Promise<Uint8Array>) => {
    const pending = key ? looking.get(key) : undefined;
    if (pending) return pending;
    const task = load().then((bytes) => describeSticker(gateway, bytes, meta));
    if (!key) return task;
    const stored = task
      .then((p) => {
        cache.set(key, p);
        return p;
      })
      .finally(() => looking.delete(key));
    looking.set(key, stored);
    return stored;
  };
  return async (seen: StickerSeen, load: () => Promise<Uint8Array>): Promise<string> => {
    const { platform, fileId, fileUniqueId: id } = seen;
    const meta: StickerMeta = {
      ...(seen.emoji ? { emoji: seen.emoji } : {}),
      ...(seen.setTitle ? { setTitle: seen.setTitle } : {}),
    };
    const key = id ? stickerCacheKey(platform, id) : null;
    const cached =
      key && id ? (cache.get(key) ?? (platform === "telegram" ? cache.get(id) : null)) : null;
    const perceived = cached ?? (await look(key, meta, load));
    if (id && fileId) {
      upsertStickerPerception({
        fileId,
        fileUniqueId: id,
        emoji: seen.emoji,
        setName: seen.setTitle,
        platform,
        ...perceived,
      });
    }
    return formatStickerMedia(perceived, meta);
  };
}

/** 按 emotion/action 维度随机取一条（同维度多贴纸——多样性）。 */
function pickByDimension(
  rows: PaletteRow[],
  column: "emotion" | "action",
  value: string,
): string | null {
  const hits = rows.filter((r) => (r[column] ?? "").toLowerCase() === value);
  return hits[Math.floor(Math.random() * hits.length)]?.fileId ?? null;
}

/** 一张贴纸和查询的贴切分：标签、包名包含查询，标签和查询的字重合，映射到的情绪/动作对得上。 */
function descriptionScore(
  row: PaletteRow,
  q: string,
  qBigrams: ReadonlySet<string>,
  mapped: string,
): number {
  const label = row.label.toLowerCase();
  const setName = row.setName.toLowerCase();
  // 没有任何描述的不参与（得 0 分不会进入候选）。
  if (!label && !setName) return 0;
  let score = 0;
  if (label.includes(q)) score += 10;
  else if (setName.includes(q)) score += 6;
  if (qBigrams.size > 0) score += overlapScore(q, qBigrams, label);
  if (mapped && (row.emotion === mapped || row.action === mapped)) score += 2;
  return score;
}

/** 标签和查询的 bigram 重合，每个 3 分；一个也不重合时退到单字命中。 */
function overlapScore(q: string, qBigrams: ReadonlySet<string>, label: string): number {
  const lBigrams = bigrams(label);
  let overlap = 0;
  for (const b of qBigrams) if (lBigrams.has(b)) overlap++;
  if (overlap > 0) return overlap * 3;
  // 单字直接命中（例如查询"猫猫"但库里是"白猫"）不靠 bigram，保底检查连续单字。
  const qChars = [...q.replace(/[\s\p{P}\p{S}]/gu, "")];
  const charHits = qChars.filter((c) => label.includes(c)).length;
  return qChars.length >= 2 && charHits >= 2 ? charHits : 0;
}

/** 标准情绪词先按情绪挑，挑不到、或是标准动作词再按动作挑。 */
function pickByStandardWord(rows: PaletteRow[], word: string): string | null {
  return (
    (EMOTIONS.has(word) ? pickByDimension(rows, "emotion", word) : null) ||
    (ACTIONS.has(word) ? pickByDimension(rows, "action", word) : null)
  );
}

/** 用自然语言描述（VLM 标签与包名）打分挑出最贴切的一张。 */
function matchByDescription(rows: PaletteRow[], query: string): string | null {
  const q = query.trim().toLowerCase();
  const qBigrams = bigrams(q);
  const mapped = mapBy(ZH_QUERY_MAP, q, "");
  let bestScore = 0;
  let top: PaletteRow[] = [];
  for (const row of rows) {
    const score = descriptionScore(row, q, qBigrams, mapped);
    if (score > bestScore) {
      bestScore = score;
      top = [row];
    } else if (score === bestScore && score > 0) {
      top.push(row);
    }
  }
  if (bestScore < 2 || top.length === 0) return null;
  return top[Math.floor(Math.random() * top.length)]?.fileId ?? null;
}

/**
 * 解析贴纸：keyword → fileId。降级链：
 * 1. 标准维度（emotion/action）；
 * 2. VLM 画面/文字自然语言描述匹配；
 * 3. 中文情绪/动作同义词转标准维度；
 * 4. emoji 匹配；
 * 5. 最近似情绪兜底（仅已知词；绝不乱发无关贴纸）。
 */
export function resolveStickerFileId(keyword: string, platform = "telegram"): string | null {
  const lower = keyword.trim().toLowerCase();
  if (!lower) return null;
  const rows = queryPalette(platform);
  if (rows.length === 0) return null;

  // 1. dimension 匹配
  const hit = pickByStandardWord(rows, lower);
  if (hit) return hit;

  // 2. 自然语言标签/VLM 描述匹配
  const textHit = matchByDescription(rows, lower);
  if (textHit) return textHit;

  // 3. 中文同义词映射回标准维度
  const mapped = mapBy(ZH_QUERY_MAP, lower, "");
  const mappedHit = mapped ? pickByStandardWord(rows, mapped) : null;
  if (mappedHit) return mappedHit;

  // 4. emoji 匹配（直接 emoji，或 keyword / 映射词由近到远的几个 emoji）
  const emojiKeys = KEYWORD_TO_EMOJI[lower] ??
    (mapped ? KEYWORD_TO_EMOJI[mapped] : undefined) ?? [lower];
  for (const emoji of emojiKeys) {
    const emojiHit = rows.find((r) => r.emoji.includes(emoji));
    if (emojiHit) return emojiHit.fileId;
  }

  // 5. 意思最近的情绪
  const nearest = NEAREST_EMOTION[lower] ?? (mapped ? NEAREST_EMOTION[mapped] : undefined);
  return nearest ? pickByDimension(rows, "emotion", nearest) : null;
}

/** 给出的贴纸词里，库里一张也对不上的（启动检查报出来，免得她选了却永远发不出去）。 */
export function unresolvedStickerWords(words: readonly string[], platform = "telegram"): string[] {
  if (queryPalette(platform).length === 0) return [];
  return words.filter((w) => resolveStickerFileId(w, platform) === null);
}

/** 这个平台可发的贴纸张数（启动检查用）。 */
export function paletteSize(platform = "telegram"): number {
  return queryPalette(platform).length;
}

/**
 * 从本地贴纸库挑出一批有具体画面/情绪描述的贴纸给模型参考（先中文/非占位描述，按不同情绪轮流挑，不重复）。
 * 纯读本地库，不调用模型。
 */
export function listStickerHints(limit = 14, platform = "telegram"): string[] {
  const rows = queryPalette(platform).filter((r) => {
    const l = r.label.trim();
    return l.length >= 2 && l !== "sticker" && l !== "贴纸" && l.length <= 36;
  });
  if (rows.length === 0) return [];
  // 中文具体描写排前面，再按情绪/动作分桶轮流拿，保证覆盖多样表情而不是全堆同一类。
  const isZh = (s: string) => /[\u4E00-\u9FFF]/.test(s);
  const buckets = new Map<string, string[]>();
  const ordered = [...rows].sort((a, b) => Number(isZh(b.label)) - Number(isZh(a.label)));
  const seen = new Set<string>();
  for (const r of ordered) {
    const text = r.label.trim();
    if (seen.has(text)) continue;
    seen.add(text);
    const key = r.action !== "none" ? r.action : r.emotion;
    const list = buckets.get(key) ?? [];
    list.push(text);
    buckets.set(key, list);
  }
  return roundRobin([...buckets.values()], limit);
}

/** 各队轮流各取一条，取满 limit 条或都取空为止（会取空传进来的队列）。 */
function roundRobin(queues: string[][], limit: number): string[] {
  const out: string[] = [];
  while (out.length < limit && queues.some((q) => q.length > 0)) {
    for (const q of queues) {
      const next = q.shift();
      if (next) out.push(next);
      if (out.length >= limit) break;
    }
  }
  return out;
}
