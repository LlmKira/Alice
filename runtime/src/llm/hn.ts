/**
 * HackerNews 热门（ADR-276 环节一）：她刷手机时外壳拉一次，结果作为事件写进记录，回放读记录、不联网。
 *
 * 官方 Firebase API（免费、不要密钥）：topstories 给排在前面的 id，再逐个取条目。只看 story，跳过 job、poll、
 * 被删的、没有标题的；Ask HN 这类没有外链的用讨论页作 url。网络或格式出问题时返回空数组——刷手机刷不到东西
 * 是常事，不抛错、不重试。
 */
const BASE = "https://hacker-news.firebaseio.com/v0";

/** 前 5 条里可能夹着 job / poll，多取一些 id 来凑够 limit 条 story。 */
const ATTEMPTS = 3;

/** 一次最多取几条（防手误给一个很大的 limit）。 */
const MOST = 30;

export interface HnStory {
  id: string;
  title: string;
  url: string;
}

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${new URL(url).host}: ${response.status}`);
  return await response.json();
}

function storyOf(id: string, item: unknown): HnStory | null {
  if (typeof item !== "object" || item === null) return null;
  const it = item as Record<string, unknown>;
  const title = typeof it.title === "string" ? it.title.trim() : "";
  if (it.type !== "story" || it.deleted === true || it.dead === true || title === "") return null;
  return {
    id,
    title,
    url:
      typeof it.url === "string" && it.url.startsWith("http")
        ? it.url
        : `https://news.ycombinator.com/item?id=${id}`,
  };
}

/** 热门前几条：每条最多等 timeoutMs，出错返回 []（不抛）。 */
export async function fetchHnTop(limit = 5, timeoutMs = 8000): Promise<HnStory[]> {
  const want = Math.min(Math.max(0, Math.floor(limit)), MOST);
  if (want === 0) return [];
  try {
    const top = await getJson(`${BASE}/topstories.json`, timeoutMs);
    if (!Array.isArray(top)) return [];
    const ids = top.filter((id): id is number => typeof id === "number").slice(0, want * ATTEMPTS);
    const items = await Promise.all(
      ids.map((id) => getJson(`${BASE}/item/${id}.json`, timeoutMs).catch(() => null)),
    );
    const stories: HnStory[] = [];
    for (const [i, item] of items.entries()) {
      const story = storyOf(String(ids[i]), item);
      if (story) stories.push(story);
      if (stories.length >= want) break;
    }
    return stories;
  } catch {
    return [];
  }
}
