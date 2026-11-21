/**
 * 执行代理的工具：搜索、打开网页、天气、算日子。每个工具的说明一两行，像世界里的东西，不提开发工具。
 * 选哪几样：2 月有 11 个小应用（use_*_app），8 月的脚本里真用过的只有搜索（google）、打开链接（visit）
 * 和天气（weather 17 次）；日期与倒计时按研究员的清单留着，本地算、不花钱。音乐、视频、热榜、一言、运势、
 * 发病文、KFC、自检没有使用记录，不做（热榜、新闻用搜索就能查）。
 *
 * - 搜索、打开网页、直接回答走 exa 的 HTTP API（密钥 EXA_API_KEY）：打开网页由 exa 去抓，这台机器不直接
 *   请求别人给的网址，所以聊天里或网页里的链接指不到本机和内网。直接回答（/answer）是 exa 自己先读网页、
 *   再给一句话的答复和出处，比"搜索再加打开几条"省一步，出处照样按工具真的拿到过的网址交回。
 * - 天气走 open-meteo（不要密钥）。
 * - 算日子不联网；"今天"取自外壳给的 now（回放时是事件的时刻），按东八区算（和她提示词里的时间一致）。
 */

export const EXA_BASE_URL = "https://api.exa.ai";
const SEARCH_RESULTS = 5;
const HIGHLIGHT_CHARS = 500;
const PAGE_CHARS = 3000;
const ANSWER_CHARS = 1200;
const ZONE = "Asia/Shanghai";

export interface ToolDeps {
  exaKey: string;
  fetch: typeof fetch;
  /** 现在（毫秒）。 */
  now: number;
  /** 这一次请求最多等多久。 */
  timeoutMs: number;
}

export interface ToolOutput {
  /** 给执行代理看的文字。 */
  text: string;
  /** 这一步真的拿到过内容的网址（交回时只认这些）。 */
  urls: string[];
  /** 这一步花的钱（美元），exa 按它自己报的 costDollars。 */
  usd: number;
}

/** OpenAI 兼容的工具定义（说明一两行）。hand_back 是交回结果，由 errand.ts 处理。 */
export const TOOL_SPECS = [
  {
    type: "function",
    function: {
      name: "search",
      description: "在网上搜，返回几条网页的标题、网址、日期和摘录。",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "搜什么" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_page",
      description: "打开一个网页，读正文的前一部分。",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "网址" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "answer",
      description: "直接提一个问题，根据查到的网页给一句简明答复并附出处。",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "问什么" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "weather",
      description: "某个地方现在的天气和接下来三天的预报。",
      parameters: {
        type: "object",
        properties: { place: { type: "string", description: "城市或地名" } },
        required: ["place"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "days",
      description:
        "算日子：今天几号星期几、离某一天还有几天、某天往后或往前几天是哪天。日期写成 2026-11-12。",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "想知道离它还有几天的那一天" },
          from: { type: "string", description: "从哪天算起，不写就是今天" },
          add_days: { type: "number", description: "往后几天（往前写负数）" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "hand_back",
      description: "把查到的交回给她：一两句事实，加上用到的网址。",
      parameters: {
        type: "object",
        properties: {
          fact: {
            type: "string",
            description: "一两句短的事实，不超过 80 个字；查不到或拿不准就照实说",
          },
          sources: {
            type: "array",
            items: { type: "string" },
            description: "用到的网址（照工具结果里的原样写）",
          },
        },
        required: ["fact"],
      },
    },
  },
] as const;

export type ToolName = Exclude<(typeof TOOL_SPECS)[number]["function"]["name"], "hand_back">;

export const isToolName = (name: string): name is ToolName =>
  name === "search" ||
  name === "open_page" ||
  name === "answer" ||
  name === "weather" ||
  name === "days";

const clip = (s: string, n: number) => {
  const chars = [...s.replace(/\s+/g, " ").trim()];
  return chars.length > n ? `${chars.slice(0, n).join("")}…` : chars.join("");
};

async function exa(path: string, body: object, deps: ToolDeps): Promise<Record<string, unknown>> {
  const response = await deps.fetch(`${EXA_BASE_URL}${path}`, {
    method: "POST",
    headers: { "x-api-key": deps.exaKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(deps.timeoutMs),
  });
  if (!response.ok) throw new Error(`exa ${path}: ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

const costOf = (body: Record<string, unknown>) => {
  const total = (body.costDollars as { total?: unknown } | undefined)?.total;
  return typeof total === "number" && Number.isFinite(total) ? total : 0;
};

interface ExaPage {
  url?: string;
  title?: string;
  publishedDate?: string;
  highlights?: string[];
  text?: string;
}

async function search(query: string, deps: ToolDeps): Promise<ToolOutput> {
  const body = await exa(
    "/search",
    {
      query,
      type: "auto",
      numResults: SEARCH_RESULTS,
      contents: { highlights: { maxCharacters: HIGHLIGHT_CHARS } },
    },
    deps,
  );
  const pages = ((body.results as ExaPage[] | undefined) ?? []).filter((p) => p.url);
  if (pages.length === 0) return { text: "没有搜到。", urls: [], usd: costOf(body) };
  const text = pages
    .map((p) =>
      [
        clip(p.title ?? "", 80),
        p.url,
        p.publishedDate ? `日期 ${p.publishedDate.slice(0, 10)}` : null,
        clip((p.highlights ?? []).join(" "), HIGHLIGHT_CHARS),
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
  return { text, urls: pages.map((p) => p.url as string), usd: costOf(body) };
}

async function openPage(url: string, deps: ToolDeps): Promise<ToolOutput> {
  if (!/^https?:\/\//i.test(url)) return { text: "这不是网址。", urls: [], usd: 0 };
  const body = await exa("/contents", { urls: [url], text: { maxCharacters: PAGE_CHARS } }, deps);
  const page = ((body.results as ExaPage[] | undefined) ?? [])[0];
  if (!page?.text) return { text: "这个网页打不开。", urls: [], usd: costOf(body) };
  const head = [page.title, page.publishedDate ? `日期 ${page.publishedDate.slice(0, 10)}` : null]
    .filter(Boolean)
    .join("\n");
  return {
    text: `${head}\n\n${clip(page.text, PAGE_CHARS)}`,
    urls: [page.url ?? url],
    usd: costOf(body),
  };
}

/** exa /answer 的出处：只要网址，标题和日期有就带上。 */
interface ExaCitation {
  url?: string;
  title?: string;
  publishedDate?: string;
}

async function answer(query: string, deps: ToolDeps): Promise<ToolOutput> {
  const body = await exa("/answer", { query, text: true }, deps);
  const usd = costOf(body);
  const reply = typeof body.answer === "string" ? body.answer.trim() : "";
  const citations = ((body.citations as ExaCitation[] | undefined) ?? []).filter((c) => c.url);
  if (!reply) return { text: "没有查到。", urls: [], usd };
  const sources = citations
    .map((c) =>
      [
        clip(c.title ?? "", 80),
        c.url,
        c.publishedDate ? `日期 ${c.publishedDate.slice(0, 10)}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
  return {
    text: sources
      ? `${clip(reply, ANSWER_CHARS)}\n\n出处：\n${sources}`
      : clip(reply, ANSWER_CHARS),
    urls: citations.map((c) => c.url as string),
    usd,
  };
}

/** WMO 天气代码（open-meteo 文档）。 */
const WEATHER: Record<number, string> = {
  0: "晴",
  1: "大致晴",
  2: "多云",
  3: "阴",
  45: "雾",
  48: "雾凇",
  51: "毛毛雨",
  53: "毛毛雨",
  55: "较密的毛毛雨",
  56: "冻毛毛雨",
  57: "冻毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  66: "冻雨",
  67: "冻雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  77: "雪粒",
  80: "阵雨",
  81: "阵雨",
  82: "强阵雨",
  85: "阵雪",
  86: "强阵雪",
  95: "雷雨",
  96: "雷雨伴冰雹",
  99: "强雷雨伴冰雹",
};
export const WEATHER_SOURCE = "https://open-meteo.com/";

async function getJson(url: string, deps: ToolDeps): Promise<Record<string, unknown>> {
  const response = await deps.fetch(url, { signal: AbortSignal.timeout(deps.timeoutMs) });
  if (!response.ok) throw new Error(`${new URL(url).host}: ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

async function weather(place: string, deps: ToolDeps): Promise<ToolOutput> {
  const geo = await getJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=zh`,
    deps,
  );
  const spot = (geo.results as Array<Record<string, unknown>> | undefined)?.[0];
  if (!spot) return { text: `没找到"${place}"这个地方。`, urls: [], usd: 0 };
  const q = new URLSearchParams({
    latitude: String(spot.latitude),
    longitude: String(spot.longitude),
    current: "temperature_2m,weather_code",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    timezone: "auto",
    forecast_days: "3",
  });
  const f = await getJson(`https://api.open-meteo.com/v1/forecast?${q}`, deps);
  const current = f.current as { temperature_2m?: number; weather_code?: number; time?: string };
  const daily = f.daily as {
    time?: string[];
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: number[];
  };
  const where = [spot.name, spot.admin1, spot.country].filter(Boolean).join("，");
  const lines = [
    `${where}（当地时间 ${current?.time ?? "?"}）：现在 ${WEATHER[current?.weather_code ?? -1] ?? "?"}，${current?.temperature_2m ?? "?"}°C`,
    ...(daily?.time ?? []).map(
      (day, i) =>
        `${day}：${WEATHER[daily.weather_code?.[i] ?? -1] ?? "?"}，${daily.temperature_2m_min?.[i]}–${daily.temperature_2m_max?.[i]}°C，降水概率 ${daily.precipitation_probability_max?.[i] ?? "?"}%`,
    ),
  ];
  lines.push(`来源 ${WEATHER_SOURCE}`);
  return { text: lines.join("\n"), urls: [WEATHER_SOURCE], usd: 0 };
}

const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
const DAY_MS = 86_400_000;

/** now 在东八区是哪一天（UTC 零点表示的日期）。 */
function todayOf(now: number): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day));
}

function parseDay(s: string): number | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s.trim());
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(t) ? null : t;
}

const show = (t: number) =>
  `${new Date(t).toISOString().slice(0, 10)} ${WEEKDAYS[new Date(t).getUTCDay()]}`;

/** 算日子：纯计算，不联网。 */
export function days(
  args: { to?: unknown; from?: unknown; add_days?: unknown },
  now: number,
): ToolOutput {
  const today = todayOf(now);
  const from = typeof args.from === "string" && args.from ? parseDay(args.from) : today;
  if (from === null) return { text: "日期看不懂，写成 2026-11-12 这样。", urls: [], usd: 0 };
  const lines = [`今天是 ${show(today)}。`];
  if (from !== today) lines.push(`从 ${show(from)} 算起。`);
  if (typeof args.add_days === "number" && Number.isFinite(args.add_days)) {
    const n = Math.round(args.add_days);
    lines.push(`${n >= 0 ? "往后" : "往前"} ${Math.abs(n)} 天是 ${show(from + n * DAY_MS)}。`);
  }
  if (typeof args.to === "string" && args.to) {
    const to = parseDay(args.to);
    if (to === null) return { text: "日期看不懂，写成 2026-11-12 这样。", urls: [], usd: 0 };
    const gap = Math.round((to - from) / DAY_MS);
    lines.push(
      gap >= 0 ? `到 ${show(to)} 还有 ${gap} 天。` : `${show(to)} 已经过去 ${-gap} 天了。`,
    );
  }
  return { text: lines.join(""), urls: [], usd: 0 };
}

export async function runTool(
  name: ToolName,
  args: Record<string, unknown>,
  deps: ToolDeps,
): Promise<ToolOutput> {
  const text = (k: string) => (typeof args[k] === "string" ? (args[k] as string).trim() : "");
  switch (name) {
    case "search":
      return text("query") ? search(text("query"), deps) : { text: "要搜什么？", urls: [], usd: 0 };
    case "open_page":
      return openPage(text("url"), deps);
    case "answer":
      return text("query") ? answer(text("query"), deps) : { text: "要问什么？", urls: [], usd: 0 };
    case "weather":
      return text("place")
        ? weather(text("place"), deps)
        : { text: "哪个地方？", urls: [], usd: 0 };
    case "days":
      return days(args, deps.now);
  }
}
