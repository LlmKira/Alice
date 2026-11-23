/**
 * 看懂别人发的贴纸（ADR-276 环节四："看懂贴纸：便宜的看图模型看一次、按贴纸缓存"）。
 *
 * 每张贴纸只花一次看图模型的钱：一条很短的中文 JSON 说清楚画的是什么、图上的字或梗、什么情绪，
 * 之后写进时间线的那一行（"贴纸 😂（柴郡猫日常）：猫猫捂嘴偷笑「笑死」"）。缓存先看这张贴纸的
 * 平台加 file_unique_id 的键（同一平台上同一张贴纸共用它），有 SQLite 时同时落盘，测试里给 :memory: 就走同一个表。
 *
 * 这里在 llm/ 下：可以调网关、可以用 better-sqlite3；时间只为缓存行（created_at）读一次时钟。
 */
import Database from "better-sqlite3";
import { describeMedia } from "../speech/media.js";
import { type ChatUsage, chatTokens, type Gateway } from "./gateway.js";
import { SPEECH_MODEL } from "./speech-model.js";

/** 一张贴纸在她眼里的样子。 */
export interface StickerPerception {
  /** 一句中文：画的是什么，图上的字或梗也带进来（"猫猫捂嘴偷笑「笑死」"）。 */
  summary: string;
  /** 贴纸上认得出的字或梗；没有时是 null。 */
  text: string | null;
  /** 一个词的情绪（"想笑"、"无语"、"抱抱"）；认不出时是空串。 */
  emotion: string;
}

/** 平台随消息给的、能帮着看懂的两样（QQ 表情包的说明文字也放在 emoji 里）。 */
export interface StickerMeta {
  /** 贴纸自带的表情（"😂"）。 */
  emoji?: string;
  /** 贴纸那套的标题（"柴郡猫日常"）。 */
  setTitle?: string;
}

interface Body extends ChatUsage {
  choices?: Array<{ message?: { content?: string } }>;
}

/** 时间线一条一行的上限。 */
const LINE_CHARS = 80;
/** summary 本身也别拖着整段话（提示词只要一句）。 */
const SUMMARY_CHARS = 48;
const SET_CHARS = 16;
const MAX_TOKENS = 120;

/** 时间线一条一行：去掉 markdown 的粗体、代码标记，压掉换行（perceive.ts 的 ask 同样做）。 */
const plain = (s: string): string =>
  s
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

/** 按字符（码点）截断，连省略号一起不超过 n。 */
const clip = (s: string, n: number): string => {
  const chars = [...s.replace(/\s+/g, " ").trim()];
  return chars.length > n ? `${chars.slice(0, Math.max(0, n - 1)).join("")}…` : chars.join("");
};

/** 看图模型收到的提示：只回 JSON，三样都短。 */
function askFor(meta: StickerMeta): string {
  const hints = [
    meta.emoji ? `这张贴纸标的表情是 ${meta.emoji}` : "",
    meta.setTitle ? `它属于《${meta.setTitle}》这套贴纸` : "",
  ].filter(Boolean);
  return [
    "看这张贴纸，用一句中文说清楚：它画的是什么，图上的字或梗是什么，传达什么情绪。",
    ...hints,
    '只回一个 JSON 对象，形如 {"summary":"猫猫捂嘴偷笑「笑死」","text":"笑死","emotion":"想笑"}。',
    "summary 不超过 30 个字；text 是贴纸上的字或梗，没有就写 null；emotion 只用一个词。",
  ].join("\n");
}

/** 图片的 MIME：Telegram 贴纸多半是 WebP，外壳给的预览帧可能是 JPEG/PNG/GIF。 */
function mimeOf(bytes: Uint8Array): string {
  const b = (i: number) => bytes[i] ?? 0;
  if (b(0) === 0xff && b(1) === 0xd8) return "image/jpeg";
  if (b(0) === 0x89 && b(1) === 0x50) return "image/png";
  if (b(0) === 0x47 && b(1) === 0x49) return "image/gif";
  return "image/webp";
}

/** 模型可能包一层 ```json 围栏，或先写半句再给 JSON。 */
function unfence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?([\s\S]*?)```$/i.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}

/**
 * 模型的回复 → StickerPerception。JSON 读得懂就用它（围栏先剥掉，前后多余的话也试着从花括号里捞）；
 * 读不懂就把整段当成一句描述。什么都没有时抛错（外壳记一条 Perception failed）。
 */
function parseSticker(raw: string): StickerPerception {
  const text = plain(unfence(raw));
  if (!text) throw new Error("sticker-perceive: empty");
  const candidates = [text];
  const braced = /\{[\s\S]*\}/.exec(text)?.[0];
  if (braced && braced !== text) candidates.push(braced);
  for (const candidate of candidates) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue; // 不是 JSON：试下一个候选，都不行就用整段话。
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    return perceptionOf(value as Record<string, unknown>);
  }
  return { summary: clip(text, SUMMARY_CHARS), text: null, emotion: "" };
}

/** 读得懂的 JSON 对象：描述缺了就拿贴纸上的字或情绪顶上。 */
function perceptionOf(o: Record<string, unknown>): StickerPerception {
  const summary = typeof o.summary === "string" ? plain(o.summary) : "";
  const caption = typeof o.text === "string" ? plain(o.text) : "";
  const emotion = typeof o.emotion === "string" ? plain(o.emotion) : "";
  const line = summary || caption || emotion;
  // JSON 读得懂但没有一句能用的：和空回复一样算没看到，不把原始 JSON 写进时间线。
  if (!line) throw new Error("sticker-perceive: empty");
  return {
    summary: clip(line, SUMMARY_CHARS),
    text: caption || null,
    emotion,
  };
}

/** 看一张贴纸：一次很短的多模态调用，回复按 parseSticker 解析。 */
export async function describeSticker(
  gateway: Gateway,
  imageBytes: Uint8Array,
  meta: StickerMeta = {},
): Promise<StickerPerception> {
  const url = `data:${mimeOf(imageBytes)};base64,${Buffer.from(imageBytes).toString("base64")}`;
  const { body } = await gateway.post<Body>({
    kind: "image",
    model: SPEECH_MODEL,
    path: "/chat/completions",
    timeoutMs: 20_000,
    tokens: chatTokens,
    body: {
      model: SPEECH_MODEL,
      max_tokens: MAX_TOKENS,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: askFor(meta) },
            { type: "image_url", image_url: { url } },
          ],
        },
      ],
    },
  });
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new TypeError("sticker-perceive: empty");
  return parseSticker(content);
}

/**
 * 时间线里那张贴纸的一行："贴纸 😂（柴郡猫日常）：猫猫捂嘴偷笑「笑死」"。
 * 缺哪样就不写哪样（没有表情、没有包名、没有字都行），整行不超过 80 个字符。
 */
export function formatStickerMedia(p: StickerPerception, meta: StickerMeta = {}): string {
  const setTitle = meta.setTitle ? clip(plain(meta.setTitle), SET_CHARS) : "";
  const head = describeMedia({ type: "sticker", emoji: meta.emoji?.trim() });
  const label = setTitle ? `${head}（${setTitle}）` : head;
  const summary = plain(p.summary);
  const caption = p.text ? plain(p.text) : "";
  const shown = [summary, caption && !summary.includes(caption) ? `「${caption}」` : ""]
    .filter(Boolean)
    .join("");
  return clip(shown ? `${label}：${shown}` : label, LINE_CHARS);
}

interface StickerRow {
  summary: string;
  text: string | null;
  emotion: string;
}

const TABLE = `CREATE TABLE IF NOT EXISTS sticker_cache (
  file_unique_id TEXT PRIMARY KEY,
  summary TEXT,
  text TEXT,
  emotion TEXT,
  created_at INTEGER
)`;
const SELECT = "SELECT summary, text, emotion FROM sticker_cache WHERE file_unique_id = ?";
const UPSERT = `INSERT INTO sticker_cache (file_unique_id, summary, text, emotion, created_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(file_unique_id) DO UPDATE SET
    summary = excluded.summary,
    text = excluded.text,
    emotion = excluded.emotion,
    created_at = excluded.created_at`;

type DatabaseHandle = InstanceType<typeof Database>;

/** 缓存表的两个动作：查询和覆盖写入。没有数据库时整条缓存只走内存里的 Map。 */
interface StickerQueries {
  read: (fileUniqueId: string) => StickerRow | undefined;
  write: (fileUniqueId: string, p: StickerPerception, at: number) => void;
}

/**
 * 贴纸缓存：按 file_unique_id 去重，同一张贴纸在不同群里再出现时不再调模型。
 * 给了 SQLite（实例或路径）就同时落盘；不给（或测试给 ":memory:"）时就是内存里的 Map。
 */
export class StickerCache {
  private readonly mem = new Map<string, StickerPerception>();
  private readonly db: DatabaseHandle | null;
  private readonly owned: boolean;
  private queries: StickerQueries | null = null;

  constructor(db?: DatabaseHandle | string | null) {
    this.owned = typeof db === "string";
    const handle = typeof db === "string" ? new Database(db) : (db ?? null);
    this.db = handle;
    if (!handle) return;
    try {
      handle.exec(TABLE);
      const select = handle.prepare<[string], StickerRow>(SELECT);
      const upsert = handle.prepare(UPSERT);
      this.queries = {
        read: (id) => select.get(id),
        write: (id, p, at) => {
          upsert.run(id, p.summary, p.text, p.emotion, at);
        },
      };
    } catch (error) {
      // 开出来的连接由这里负责关掉（connection.ts 同样在初始化失败时关连接再抛）。
      if (this.owned) handle.close();
      throw error;
    }
  }

  /** 这张贴纸看过没有：内存先找，再读缓存表（读到就放回内存）。 */
  get(fileUniqueId: string): StickerPerception | null {
    const hit = this.mem.get(fileUniqueId);
    if (hit) return hit;
    const row = this.queries?.read(fileUniqueId);
    if (!row) return null;
    const p: StickerPerception = {
      summary: row.summary,
      text: row.text ?? null,
      emotion: row.emotion,
    };
    this.mem.set(fileUniqueId, p);
    return p;
  }

  /** 记下一张看懂的贴纸（同一个 id 覆盖旧的那行）。 */
  set(fileUniqueId: string, p: StickerPerception): void {
    this.mem.set(fileUniqueId, p);
    this.queries?.write(fileUniqueId, p, Date.now());
  }

  /** 这张贴纸看过没有（和 get 走同一条路，命中时也会放回内存）。 */
  has(fileUniqueId: string): boolean {
    return this.get(fileUniqueId) !== null;
  }

  /** 导出缓存里的全部已知贴纸（供启动时补全贴纸调色板）。 */
  entries(): Array<{ fileUniqueId: string } & StickerPerception> {
    if (this.db) {
      const rows = this.db
        .prepare<[], { file_unique_id: string } & StickerRow>(
          "SELECT file_unique_id, summary, text, emotion FROM sticker_cache",
        )
        .all();
      return rows.map((r) => ({
        fileUniqueId: r.file_unique_id,
        summary: r.summary,
        text: r.text ?? null,
        emotion: r.emotion,
      }));
    }
    return Array.from(this.mem.entries(), ([fileUniqueId, p]) => ({ fileUniqueId, ...p }));
  }

  /** 只关掉这里自己打开的数据库（外面传进来的实例由外面关）。 */
  close(): void {
    if (this.owned) this.db?.close();
  }
}
