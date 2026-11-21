/**
 * 她手里有东西、想分享（PLAN 第 44 件；预注册 eval-artifacts/desire/prereg.md）。
 *
 * 1. 频道的新帖作为她看到的东西进世界（posts），带头一行和正文。
 * 2. 想分享的劲 = 新鲜度 × 和这个会话在聊的东西相不相关 × 和这里的人亲近不亲近，取她手里最想在这里说的那一件。
 *    它是驱动 information 的一部分（drives.ts，"drive.share"），能叫醒她；她在这个会话里想过一次（说或不说），
 *    摆在她面前的那一件就在这里用掉（考虑过就消耗）。在别处想过的，在这里也淡一半。
 * 3. 三样都从数据里来，按频道、按会话自适应：
 *    - 新鲜度按这个频道自己的发帖间隔变旧：后面的帖子一条条顶上来，前面的就沉下去。刷屏的频道一条只新鲜几十分钟，
 *      一天一条的频道新鲜一天（间隔先验 6 小时、算 3 条，向这个频道的实测收缩）。
 *    - 相关：帖子里有分量的词（idf 按她所有会话最近在聊的和手里的帖子一起算，人人都说的词分量为 0）有多少这个会话
 *      最近说过；再和这个会话以往对每条帖子的相关比，排进它自己口味的前一截才算。这一截多宽从数据里来：这里的人
 *      每人每天分享几条，除以她每天看到几条帖子（技术群里技术新闻是平常事，只有最对得上的那一两条算）。
 *    - 亲近：私聊是对方的层级；群里是此刻在场的人里和她最亲近的那个。层级本身从互动里学（world.ts tierOf）。
 * 写进提示词的是她手里的那一件（why.ts 的"想分享"那句），不写分数。纯函数，时间只来自事件。
 */
import type { AliceEvent } from "../../mind/events.js";
import { causeLine } from "./cause-lines.js";
import { feature, type PressureFeature, type View } from "./feature.js";
import { type ReceptionFeedbackState, shareTaste } from "./feedback.js";
import { TIER_WEIGHT, type Tier, TURN_WINDOW } from "./params.js";
import { itemId } from "./reach.js";
import { tokens } from "./turn.js";
import { type ChatNode, isSolicited, tierOf, voicesAt, type World } from "./world.js";

const MIN = 60_000;
const H = 60 * MIN;

/** 手里最多留几件、最久留多久（再旧就不新鲜了）。 */
const KEPT = 40;
const KEPT_MS = 48 * H;
/** 一件的正文：头一行当标题，后面截这么多字给她看；取词只看前面这么多字（标题和导语）。 */
const TITLE_CHARS = 60;
const BODY_CHARS = 120;
const TERM_CHARS = 400;
/**
 * 频道的发帖间隔：先验 6 小时、算 3 条（手设：一天三四条的频道），EMA 的步长 0.2。
 * 发帖越勤，一条沉下去越快。
 */
const PACE_PRIOR = 6 * H;
const PACE_PRIOR_N = 3;
const PACE_ALPHA = 0.2;
/** 一个会话最近说的话记成词频，每来一条话旧的淡掉 1/TALK_MEMORY（大约记得最近一百条，手设）；最多留这么多个词。 */
const TALK_MEMORY = 100;
const TALK_TERMS = 400;
/** 每个会话记最近这么多条帖子到来时的相关度（它自己的口味）。 */
const RELS_KEPT = 400;
const DAY = 24 * H;
/**
 * 挑剔到什么程度从数据里来（修订 2）：这里的人每人每天分享几条（带链接的话），她每天看到几条帖子，
 * 她就只把排进前"分享数 / 帖子数"那一截的当成想在这里说的。真人的先验：线上每个群说得最多的四分之一人
 * 每人每天 1.06 条（p75，eval-artifacts/desire/humans.py），算 3 个人，向这个会话的实测收缩。
 */
const SHARE_PRIOR = 1.06;
const SHARE_PRIOR_N = 3;
/** 说出口的动作（发话、贴纸、语音、发图、转发）。 */
const SPOKEN = new Set<string>(["send", "sticker", "voice", "album-send", "forward"]);
const LINK = /https?:\/\/|\bt\.me\//;
/** 一个人在这个会话里最近说话的分量到这个，算这里在说话的人（VOICE_HALF_LIFE 淡掉的轮数）。 */
const ACTIVE_VOICE = 0.5;
/** 一群人里看最近说话的这么多个人，取和她最亲近的那个。 */
const PRESENT = 10;
/**
 * 想分享的劲（未归一）乘的尺度；κ 是 information 的（1.5）。按预注册的规则在 1.5、3、6 里选（满足频率判定的最大那个）：
 * 第六遍普查里三档都满足，取 6（docs/research/desire-2026-11-13.md）。
 */
export const SHARE_SCALE = 6;
/** 劲头到这个（归一后 tanh(raw/κ) ≥ 0.5，劲头的一半）才算摆在她面前：写进提示词，她想过了就用掉。 */
export const SHOWN_AT = 0.5;
const KAPPA = 1.5;

/** 她在频道里看到的一件。 */
export interface PostItem {
  id: string;
  /** 频道。 */
  scope: string;
  channel: string;
  title: string;
  body: string;
  at: number;
  /** 帖子里的词和到来时的 idf。 */
  idf: Readonly<Record<string, number>>;
  /** 和每个会话此刻的相关度（会话说话时重算）。 */
  rel: Readonly<Record<string, number>>;
  /** 在哪些会话里想过了（考虑过就消耗）。 */
  offered: readonly string[];
}

interface Pace {
  lastAt: number;
  gap: number | null;
  n: number;
}

/** 按一天淡掉的计数（at 时刻的值），和开始数的时刻：估每天几次。 */
interface Rate {
  n: number;
  at: number;
  from: number;
}

interface Talk {
  terms: Readonly<Record<string, number>>;
  /** 最近几条帖子到来时和这个会话的相关度（帖子编号和相关度，旧的在前）。 */
  rels: ReadonlyArray<{ id: string; r: number }>;
  /** 这里的人发带链接的话（分享）的次数。 */
  links?: Rate;
  /** 她上一次在这里把摆在面前的那一件说出口（想过并且开了口）的时刻。 */
  sharedAt?: number;
}

export interface PostsState {
  items: readonly PostItem[];
  channels: Readonly<Record<string, Pace>>;
  talk: Readonly<Record<string, Talk>>;
  /** 她看到的帖子（算一件的）的次数。 */
  arrivals?: Rate;
  /** 想分享的劲的尺度（组别给的，desire({ scale })；普查按它扫）。 */
  scale: number;
  /** 个人日常小事/梦境好奇点不走频道新闻分位门，按亲近度与安静度自然释放（候选 personalUrge）。 */
  personalUrge?: boolean;
}
export const emptyPosts: PostsState = { items: [], channels: {}, talk: {}, scale: SHARE_SCALE };

type Seen = View<"posts" | "chats" | "relations">;

const postsOf = (w: View<"posts">): PostsState => w.posts ?? emptyPosts;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : flat;
}
/** YYYY-MM-DD（东八区）当日 00:00 的时间戳；解析失败回 null。 */
function cnyDayStart(dateText: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
  if (!m) return null;
  let y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  y -= mo <= 2 ? 1 : 0;
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  const days = era * 146_097 + doe - 719_468;
  return days * DAY - 8 * H;
}

/** 链接和 @ 账号不是能聊的内容：去掉再取标题、正文和词（普查里只有一条链接的帖子被当成了一件，修订 1）。 */
const NOT_CONTENT = /https?:\/\/\S+|\bt\.me\/\S+|@[\w_]+/g;
const content = (text: string) => text.replace(NOT_CONTENT, " ");
/** 标题去掉链接后少于这么多字的，没有可说的内容，不算一件。 */
const TITLE_MIN = 4;

/** 头一行当标题，其余是正文。 */
function split(text: string): { title: string; body: string } {
  const lines = content(text)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const [first = "", ...rest] = lines;
  return { title: clip(first, TITLE_CHARS), body: clip(rest.join(" "), BODY_CHARS) };
}

/** 这个频道一条帖子沉下去的时间常数：它的发帖间隔（先验向实测收缩）。 */
export function freshFor(pace: Pace | undefined): number {
  const n = pace?.gap === null || !pace ? 0 : pace.n;
  const gap = pace?.gap ?? PACE_PRIOR;
  return (n * gap + PACE_PRIOR_N * PACE_PRIOR) / (n + PACE_PRIOR_N);
}

/** 一件此刻的新鲜度。 */
export function freshness(posts: PostsState, item: PostItem, now: number): number {
  if (now < item.at) return 0;
  return Math.exp(-(now - item.at) / freshFor(posts.channels[item.scope]));
}

/** 帖子里有分量的词有多少这个会话最近说过（按 idf 加权的覆盖度，∈ [0, 1]）。 */
function relevance(idf: Readonly<Record<string, number>>, talk: Talk | undefined): number {
  if (!talk) return 0;
  let all = 0;
  let hit = 0;
  for (const [t, w] of Object.entries(idf)) {
    all += w;
    hit += w * Math.min(1, talk.terms[t] ?? 0);
  }
  return all > 0 ? hit / all : 0;
}

const bump = (r: Rate | undefined, at: number): Rate => ({
  n: (r ? r.n * Math.exp(-(at - r.at) / DAY) : 0) + 1,
  at,
  from: r?.from ?? at,
});

/** 每天几次（指数加权，刚开始数时按已经数了多久折算）。 */
export function perDay(r: Rate | undefined, now: number): number {
  if (!r) return 0;
  const n = r.n * Math.exp(-(now - r.at) / DAY);
  const span = DAY * (1 - Math.exp(-Math.max(0, now - r.from) / DAY));
  return span > 0 ? (n * DAY) / span : 0;
}

/** 这里一个说话的人每天分享几条（先验向实测收缩）。 */
export function sharesHere(talk: Talk | undefined, chat: ChatNode, now: number): number {
  const people = Object.values(voicesAt(chat, now).by).filter((v) => v >= ACTIVE_VOICE).length;
  return (perDay(talk?.links, now) + SHARE_PRIOR * SHARE_PRIOR_N) / (people + SHARE_PRIOR_N);
}

/**
 * 这一件在这个会话里有多算"想说的那一件"（0–1）：它要比它之前到来的 window 件都更对得上这个会话。window 是她在这里
 * 平常分享一次的工夫里会看到几件帖子（她一天看到几件 / 这里一人一天分享几条）。记下的还不到 window 件时，赢了已经
 * 记下的那些只算赢了一部分（记下的件数 / window：修订 3，第三遍普查里刚开始的五个小时她在一个群里分享了六次）。
 * 不设分位门槛：挑剔到什么程度由这两个数定。
 */
export function picked(
  item: PostItem,
  rel: number,
  talk: Talk | undefined,
  window: number,
): number {
  if (!talk || rel <= 0 || window <= 0) return 0;
  const k = talk.rels.findIndex((e) => e.id === item.id);
  const before = (k < 0 ? talk.rels : talk.rels.slice(0, k)).slice(-Math.ceil(window));
  if (!before.every((e) => e.r < rel)) return 0;
  return Math.min(1, before.length / window);
}

/** 和这个会话里的人亲近不亲近（0–1）：私聊是对方，群里是在场的人里最亲近的。 */
export function closenessIn(world: Seen, chat: ChatNode, now: number): number {
  const weight = (id: string | null) =>
    TIER_WEIGHT[tierOf(world as World, id, now) as Tier] / TIER_WEIGHT[5];
  if (chat.chatType === "private") return weight(chat.partner);
  const present = [...new Set(chat.recentFrom.slice(-PRESENT))];
  return present.reduce((best, id) => Math.max(best, weight(id)), weight(null));
}

/** 一件里有分量的词，有多少在另一件里也有（按 idf 加权，∈ [0, 1]）：同一个消息几个频道各发一遍时接近 1。 */
export function overlap(item: PostItem, other: PostItem): number {
  let all = 0;
  let hit = 0;
  for (const [t, w] of Object.entries(item.idf)) {
    all += w;
    if (t in other.idf) hit += w;
  }
  return all > 0 ? hit / all : 0;
}

/**
 * 这一件对这个会话还有多新（∈ [0, 1]）：和她在这里已经想过的那几件重合得越多越不新（修订 1：普查里同一个消息
 * 被几个频道各发一遍，她在一个群里一天分享了好几遍）。考虑过就消耗，用到同一件事上，不另设门槛。
 */
function novelty(posts: PostsState, item: PostItem, scope: string): number {
  let most = 0;
  for (const o of posts.items) {
    if (o !== item && o.offered.includes(scope)) most = Math.max(most, overlap(item, o));
  }
  return 1 - most;
}

/** 这一件在这个会话里有多想说（未乘尺度）：在这里想过了就是 0，在别处想过一次淡一半。 */
export function urge(world: Seen, item: PostItem, scope: string, now: number): number {
  const chat = world.chats[scope];
  if (!chat || item.offered.includes(scope) || item.at > now) return 0;
  const posts = postsOf(world);
  const talk = posts.talk[scope];
  const seen = perDay(posts.arrivals, now);
  const window = seen / Math.max(1e-9, sharesHere(talk, chat, now));
  // 量跟着反响走（修订 4）：她上一件在这里说出口以后，还没有别人在这里说过话，就先不想下一件。
  if ((talk?.sharedAt ?? 0) >= chat.lastIncomingAt && talk?.sharedAt) return 0;
  const isPersonal = posts.personalUrge === true && item.scope === "self:dream";
  // 群里正在热烈聊别的事、和这条个人小事毫不搭边时，先留着它，不在忙乱里白白想过消耗掉；
  // 等群静下来或者有人说到相关话题时再拿出来。
  if (
    isPersonal &&
    chat.chatType === "group" &&
    now - chat.lastIncomingAt < TURN_WINDOW &&
    (item.rel[scope] ?? 0) === 0
  ) {
    return 0;
  }
  const r = isPersonal
    ? 0.7 + 0.3 * Math.min(1, (item.rel[scope] ?? 0) * 3)
    : picked(item, item.rel[scope] ?? 0, talk, window);
  if (r <= 0) return 0;
  const fresh = isPersonal
    ? Math.exp(-Math.max(0, now - item.at) / (24 * H))
    : freshness(posts, item, now);
  const fb =
    "feedback" in world ? (world.feedback as ReceptionFeedbackState | undefined) : undefined;
  const taste = fb ? shareTaste(fb, scope, item.channel) : 1;
  return (
    fresh *
    r *
    novelty(posts, item, scope) *
    closenessIn(world, chat, now) *
    taste *
    2 ** -item.offered.length
  );
}

/** 她手里此刻最想在这个会话里说的那一件和它的劲（未归一）。 */
export function topShare(
  world: Seen,
  scope: string,
  now: number,
): { item: PostItem; raw: number } | null {
  let best: { item: PostItem; raw: number } | null = null;
  for (const item of postsOf(world).items) {
    const raw = postsOf(world).scale * urge(world, item, scope, now);
    if (raw > 0 && (!best || raw > best.raw)) best = { item, raw };
  }
  return best;
}

/** 驱动 information 的这一份（drives.ts）：她手里最想在这里说的那一件。 */
export function sharePressure(world: World, scope: string, now: number): number {
  if (!world.posts?.items.length) return 0;
  // 劲只来自摆在她面前的那一件（修订 5）：没摆出来的劲也在叫醒她，醒来却看不到是为了什么（第五遍普查里，只摆出
  // 3 件的那一档没人找时的叫醒也多了一成）。叫醒她的和她看到的是同一件。
  const shown = shownShare(world, scope, now);
  return shown ? (topShare(world, scope, now)?.raw ?? 0) : 0;
}

/**
 * 摆在她面前的那一件（劲头过半、这里没人在等她）：写进提示词，她在这里想过之后用掉。有人在等她时她顾着对方，
 * 不摆出来、也不用掉（修订 1：普查里一半的分享摆在有人找她的时候）。
 */
export function shownShare(world: Seen, scope: string, now: number): PostItem | null {
  const chat = world.chats[scope];
  if (!chat || isSolicited(chat, now)) return null;
  const top = topShare(world, scope, now);
  return top && Math.tanh(top.raw / KAPPA) >= SHOWN_AT ? top.item : null;
}

/** 文档频率：她所有会话最近在聊的（每个会话一份）加手里的每一件。 */
function idfOf(
  terms: readonly string[],
  posts: PostsState,
  extra: ReadonlySet<string>,
): Record<string, number> {
  const docs: Array<{ has: (t: string) => boolean }> = [
    ...Object.values(posts.talk).map((t) => ({ has: (x: string) => (t.terms[x] ?? 0) > 0 })),
    ...posts.items.map((i) => ({ has: (x: string) => x in i.idf })),
    { has: (x: string) => extra.has(x) },
  ];
  const out: Record<string, number> = {};
  for (const t of terms) {
    const df = docs.filter((d) => d.has(t)).length;
    const w = Math.log(docs.length / Math.max(1, df));
    if (w > 0) out[t] = w;
  }
  return out;
}

/** 一条新帖进来：记下频道的节奏，算它和每个会话的相关度，每个会话记下自己对这一条的口味。 */
function onPost(
  posts: PostsState,
  event: Extract<AliceEvent, { type: "post.received" }>,
  id: string,
): PostsState {
  if (posts.items.some((i) => i.id === id)) return posts;
  const pace = posts.channels[event.scope];
  const gap = pace ? event.at - pace.lastAt : null;
  const channels = {
    ...posts.channels,
    [event.scope]: {
      lastAt: event.at,
      gap:
        gap === null || gap <= 0
          ? (pace?.gap ?? null)
          : pace?.gap == null
            ? gap
            : PACE_ALPHA * gap + (1 - PACE_ALPHA) * pace.gap,
      n: (pace?.n ?? 0) + (gap !== null && gap > 0 ? 1 : 0),
    },
  };
  if (!event.text) return { ...posts, channels };
  const parts = split(event.text);
  if ([...parts.title.replace(/[\s\p{P}\p{S}]/gu, "")].length < TITLE_MIN)
    return { ...posts, channels };
  // 带图、视频的帖子，字只是配文：写明是什么（修订 6：渲染出来只有"这是什么猫"，看不出那是一段视频的配文）。
  const title = event.media ? `${parts.title}（${event.media}）` : parts.title;
  const body = parts.body;
  const terms = [...new Set(tokens(content(event.text).slice(0, TERM_CHARS)))];
  const kept = posts.items.filter((i) => event.at - i.at < KEPT_MS);
  const idf = idfOf(terms, { ...posts, items: kept }, new Set(terms));
  const rel: Record<string, number> = {};
  const talk: Record<string, Talk> = { ...posts.talk };
  for (const [scope, t] of Object.entries(posts.talk)) {
    const r = relevance(idf, t);
    rel[scope] = r;
    talk[scope] = { ...t, rels: [...t.rels, { id, r }].slice(-RELS_KEPT) };
  }
  const item: PostItem = {
    id,
    scope: event.scope,
    channel: event.title,
    title,
    body,
    at: event.at,
    idf,
    rel,
    offered: [],
  };
  return {
    ...posts,
    items: [...kept, item].slice(-KEPT),
    channels,
    talk,
    arrivals: bump(posts.arrivals, event.at),
  };
}

/** 一个会话里别人又说了一句：记进这个会话在聊的东西，重算手里每一件和它的相关度。 */
function onTalk(posts: PostsState, scope: string, text: string): PostsState {
  const words = new Set(tokens(text));
  if (words.size === 0) return posts;
  const prev = posts.talk[scope];
  const keep = 1 - 1 / TALK_MEMORY;
  const terms: Record<string, number> = {};
  for (const [t, w] of Object.entries(prev?.terms ?? {})) terms[t] = w * keep;
  for (const t of words) terms[t] = (terms[t] ?? 0) + 1;
  const pruned =
    Object.keys(terms).length > TALK_TERMS + 50
      ? Object.fromEntries(
          Object.entries(terms)
            .sort((a, b) => b[1] - a[1])
            .slice(0, TALK_TERMS),
        )
      : terms;
  const talk: Talk = { ...prev, terms: pruned, rels: prev?.rels ?? [] };
  const items = posts.items.map((i) => ({
    ...i,
    rel: { ...i.rel, [scope]: relevance(i.idf, talk) },
  }));
  return { ...posts, items, talk: { ...posts.talk, [scope]: talk } };
}

/** 她在这里想过一次（说或不说）：摆在她面前的那一件在这里用掉。 */
function onConsidered<W extends Seen>(world: W, scope: string, at: number, spoke: boolean): W {
  const shown = shownShare(world, scope, at);
  if (!shown) return world;
  const posts = postsOf(world);
  const items = posts.items.map((i) =>
    i.id === shown.id ? { ...i, offered: [...i.offered, scope] } : i,
  );
  const t = posts.talk[scope];
  const talk = spoke && t ? { ...posts.talk, [scope]: { ...t, sharedAt: at } } : posts.talk;
  return { ...world, posts: { ...posts, items, talk } };
}

export function reducePosts<W extends Seen>(
  before: W,
  after: W,
  event: AliceEvent,
  scale = SHARE_SCALE,
  personalUrge = false,
): W {
  const base = after.posts ?? { ...emptyPosts, scale };
  const posts = personalUrge && !base.personalUrge ? { ...base, personalUrge: true } : base;
  switch (event.type) {
    case "post.received":
      return { ...after, posts: onPost(posts, event, itemId(event.scope, event.messageId)) };
    case "ponder.done": {
      if (event.ponder.kind !== "life") return after;
      let next = posts;
      for (const [idx, c] of (event.ponder.curiosities ?? []).entries()) {
        const synth: Extract<AliceEvent, { type: "post.received" }> = {
          type: "post.received",
          at: event.at,
          scope: "self:dream",
          messageId: `${event.ponder.date}:${idx}`,
          title: "自己刚想到的",
          text: `${c.topic}\n${c.hook}`,
        };
        next = onPost(next, synth, itemId(synth.scope, synth.messageId));
      }
      if (personalUrge && event.ponder.moments.length > 0) {
        const day0 = cnyDayStart(event.ponder.date);
        for (const [idx, m] of event.ponder.moments.entries()) {
          const at = day0 !== null ? Math.max(event.at, day0 + m.hour * H) : event.at;
          const synth: Extract<AliceEvent, { type: "post.received" }> = {
            type: "post.received",
            at,
            scope: "self:dream",
            messageId: `${event.ponder.date}:m:${idx}`,
            title: "自己刚经历的",
            text: m.text,
          };
          next = onPost(next, synth, itemId(synth.scope, synth.messageId));
        }
      }
      return next === posts ? after : { ...after, posts: next };
    }
    case "message.received": {
      if (event.isBot || !event.text) return after;
      const talked = onTalk(posts, event.scope, event.text);
      if (!LINK.test(event.text)) return { ...after, posts: talked };
      const t = talked.talk[event.scope] ?? { terms: {}, rels: [] };
      const links = bump(t.links, event.at);
      return {
        ...after,
        posts: { ...talked, talk: { ...talked.talk, [event.scope]: { ...t, links } } },
      };
    }
    case "message.sent":
      // 她自己的话不算这里在聊的东西：算进去，她说一件就让下一件更对得上，自己喂自己（ADR-195 的正反馈，修订 4）。
      return after;
    case "speech.decided":
    case "speech.failed":
      // 摆在她面前的是这次调用之前的世界里的那一件。
      return {
        ...after,
        posts: postsOf(
          onConsidered(
            before,
            event.scope,
            event.at,
            event.type === "speech.decided" && event.decision.acts.some((a) => SPOKEN.has(a.kind)),
          ),
        ),
      } as W;
    default:
      return after;
  }
}

export function createDesire(
  o: { scale?: number; dreamFeed?: boolean; personalUrge?: boolean } = {},
): PressureFeature {
  const scale = o.scale ?? SHARE_SCALE;
  const dreamFeed = o.dreamFeed ?? false;
  const personalUrge = o.personalUrge ?? false;
  return feature({
    name: dreamFeed ? (personalUrge ? "desire-personal" : "desire-dream") : "desire",
    provides: ["posts"],
    requires: ["chats", "relations"],
    reduce: (before, after, event) => {
      if (!dreamFeed && event.type === "ponder.done") return after;
      return reducePosts(before, after, event, scale, personalUrge);
    },
    causes: true,
    contribute: ({ causes }) =>
      (causes ?? []).map((c) => ({
        mechanism: `pressure-desire-${c.kind}`,
        kind: "state" as const,
        text: causeLine(c),
      })),
  });
}

/**
 * 候选 desire 的世界那一半：频道新帖进世界，想分享的劲进意愿层（drives.ts drive.share）。提示词里的那一句由
 * why.ts 写（叫醒她的原因里的"想分享"，附上那一件）。
 */
export const desire: PressureFeature = createDesire();
