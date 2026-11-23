/**
 * 她的相册（ADR-260 的做法，archive/untracked-2026-11-10）：她在群里见过的图片，按描述和配文能找到。
 * 各平台共用这一份做法，每个平台一本：Telegram 发的时候用"不带原作者转发"，QQ 取出原消息里的图再发。
 * 私聊里的图不进相册。
 * 相册是日志的投影：启动时从 Journal fold 出来，之后随新事件更新，删了也能重建。
 * 找图交给多语言重排（llm/rerank.ts），不做字词匹配：想找的话和描述是什么语言都行。
 * 给她看最像的几张，对不对得上由她自己看描述判断。搜索结果由外壳写进 act.done，回放读日志里的结果。
 */
import type { AliceEvent } from "./mind/events.js";

export interface AlbumPhoto {
  id: string;
  scope: string;
  messageId: string;
  at: number;
  sender: string;
  caption: string | null;
  description: string | null;
}

export interface AlbumHit {
  asset: string;
  caption: string | null;
  description: string | null;
  sender: string;
  ago: string;
}

/** 按相关程度排好的下标（llm/rerank.ts）。 */
export type Ranker = (
  query: string,
  documents: readonly string[],
  top: number,
) => Promise<number[]>;

const SHOWN = 3;

/** 稳定的短编号：同一张图（会话 + 消息）在重启前后编号相同。 */
function assetId(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return `p${(h >>> 0).toString(36).padStart(6, "0").slice(-6)}`;
}

function ago(ms: number): string {
  const h = ms / 3_600_000;
  if (h < 1) return "刚才";
  if (h < 24) return `${Math.round(h)} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

export class Album {
  private readonly photos = new Map<string, AlbumPhoto>();
  private readonly byId = new Map<string, AlbumPhoto>();

  constructor(private readonly rank: Ranker) {}

  get size(): number {
    return this.photos.size;
  }

  observe(event: AliceEvent): void {
    if (event.type === "message.received") {
      if (event.chatType !== "group" || event.contentType !== "photo") return;
      const key = `${event.scope}:${event.messageId}`;
      const id = assetId(key);
      if (this.byId.has(id)) return;
      const photo: AlbumPhoto = {
        id,
        scope: event.scope,
        messageId: event.messageId,
        at: event.at,
        sender: event.senderName,
        caption: event.text,
        description: null,
      };
      this.photos.set(key, photo);
      this.byId.set(id, photo);
    } else if (event.type === "message.perceived") {
      // 这条消息是相册里的图，写回来的就是它的描述（llm/perceive.ts）。
      const photo = this.photos.get(`${event.scope}:${event.messageId}`);
      if (photo && event.media !== undefined) photo.description = event.media;
    }
  }

  /**
   * 她翻相册看到的结构化结果：PTC 代码可直接读 asset / description / caption 再发图。
   * scopePrefix 只翻这个平台的图（"telegram:"、"qq:"）：别的平台的图在这里发不出去。
   */
  async searchItems(query: string, now: number, scopePrefix?: string): Promise<AlbumHit[]> {
    const known = [...this.photos.values()]
      .filter((p) => scopePrefix === undefined || p.scope.startsWith(scopePrefix))
      .filter((p) => p.description !== null || (p.caption ?? "") !== "")
      .sort((a, b) => b.at - a.at);
    if (known.length === 0) return [];
    const what = (p: AlbumPhoto) =>
      [p.description, p.caption && `配文“${p.caption}”`].filter(Boolean).join("，");
    const order = await this.rank(query, known.map(what), SHOWN);
    return order
      .map((i) => known[i])
      .filter((p): p is AlbumPhoto => p !== undefined)
      .map((p) => ({
        asset: p.id,
        caption: p.caption,
        description: p.description,
        sender: p.sender,
        ago: ago(now - p.at),
      }));
  }

  /** 她翻相册看到的东西：一段写给她看的文字。 */
  async search(query: string, now: number, scopePrefix?: string): Promise<string> {
    const hits = await this.searchItems(query, now, scopePrefix);
    if (hits.length === 0) return `想找的“${query}”。相册里还没有图。`;
    const lines = hits.map((h) => {
      const desc = [h.description, h.caption && `配文“${h.caption}”`].filter(Boolean).join("，");
      return `[${h.asset}] ${desc}（${h.sender} ${h.ago}在群里发的）`;
    });
    return `想找的“${query}”，相册里 ${this.photos.size} 张，最像的几张：\n${lines.join("\n")}`;
  }

  source(id: string): AlbumPhoto | null {
    return this.byId.get(id) ?? null;
  }

  snapshot(): AlbumPhoto[] {
    return [...this.photos.values()];
  }

  seed(items: readonly AlbumPhoto[]): void {
    for (const p of items) {
      const key = `${p.scope}:${p.messageId}`;
      if (this.photos.has(key)) continue;
      this.photos.set(key, { ...p });
      this.byId.set(p.id, this.photos.get(key) as AlbumPhoto);
    }
  }
}

/** 平台查询（PTC 的 search_album）给她看的文字：每张一行。 */
export function albumSearchText(q: string, hits: readonly AlbumHit[]): string {
  if (hits.length === 0) return `想找的“${q}”，相册里没有匹配的图。`;
  return hits
    .map(
      (h) =>
        `[${h.asset}] ${[h.description, h.caption && `配文“${h.caption}”`].filter(Boolean).join("，")}（${h.sender} ${h.ago}在群里发的）`,
    )
    .join("\n");
}
