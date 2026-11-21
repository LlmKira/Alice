/**
 * 她够得着、但还没有会话的地方：在群里认识、还没私聊过的人（A10），和她找群时看过预览、还没加入的群和频道
 * （A18、A08）。
 *
 * 意愿层原来只在已有的会话里选目标：群友没有私聊时，想念这个人的冲动（关系冷却按人算）无处可去；世界里也没有
 * 她不在的群，加群永远选不到（论文 §8 Joining）。这里把"和这个人的私聊""那个群"当作还不存在的会话放进候选：
 * 驱动、社交代价、饱和代价都照已有会话的算法算（主动、对方没请求的私聊侵入度 1.0，取自 2 月 social-cost.ts），
 * 选中时核心建出空会话、在那里叫醒她（Mechanism.opens），她在里面开口、加入或什么都不做——动作仍只作用于做决定的
 * 那个会话。同一脉络是 The Sims 的自主行为：对认识的人、知道的地方才有动作可选，由需要和代价决定去哪，不由脚本。
 *
 * "认识"：这个人在群里跟她有过有回应的来往（对她说过话、回应过她的话；world.ts 的 lastBondAt），不是只在群里见过。
 * 提示词里写你们是在哪个群认识的、他在那里说过的几句：只写那个群里公开说的、他本人说的话（受众规则：群里的事
 * 只在那个群、和与当时在场的人的私聊里）。
 * "知道的群"：她自己找群（chat-search，看了才知道）时看到的预览；预览里有什么就写什么。
 *
 * 纯函数，时间只来自事件。
 */
import type { ActKind } from "../../mind/affordances.js";
import type { AliceEvent, ChatType, FoundPlace } from "../../mind/events.js";
import type { Opening } from "../../mind/mechanism.js";
import { elapsed } from "../../mind/when.js";
import { hash32 } from "../hash.js";
import { feature, type PressureFeature, type View } from "./feature.js";
import { INFO, JOIN } from "./params.js";
import { nameOf, relationView } from "./relation.js";
import { type ChatNode, freshChat } from "./world.js";

/** 够得着的地方要看的几块：她看过的、会话、认识的人。 */
type Reachable = View<"reach" | "chats" | "relations" | "willingness">;

/** 每个人在群里说过的话记几句（写进"你们在哪认识的"）。 */
const MET_LINES = 4;
const LINE_CHARS = 60;
/** 看过的群最多记几个（最新的）。 */
const PLACES_KEPT = 12;

export interface MetLine {
  at: number;
  text: string;
  /** 这句是对她说的（回复她、点名她）。 */
  toHer: boolean;
}

/** 她最近在哪个群里见过这个人，他在那里说过的几句。 */
export interface Met {
  scope: string;
  lines: readonly MetLine[];
}

/** 她看过预览的群或频道。 */
export interface SeenPlace extends FoundPlace {
  seenAt: number;
}

/** 她在订阅的频道里看到的一条帖子（P02）：她可以跟人说起，或者转发（A14）。 */
export interface InfoItem {
  /** 给她看的编号（itemId）。 */
  id: string;
  scope: string;
  messageId: string;
  title: string;
  text: string;
  at: number;
  /** 跟谁想过要不要分享（私聊的对方）：想过就消耗，不管最后说没说。 */
  offered: readonly string[];
}

export interface ReachState {
  met: Readonly<Record<string, Met>>;
  /** 群名（入站事件带来的）。 */
  titles: Readonly<Record<string, string>>;
  places: Readonly<Record<string, SeenPlace>>;
  /** 最近看到的频道帖子（旧的在前）。 */
  info: readonly InfoItem[];
  /**
   * 不收她私聊的人 → Telegram 说的那一刻（act.failed 的 dmClosed：对方的隐私设置，或拿到凭证后仍说没有这个人）。
   * 和他的私聊不再是她够得着的地方；他先来找她就去掉。
   */
  closed?: Readonly<Record<string, number>>;
}

/**
 * 一条消息给她看的编号（频道帖子、群消息都用它；外壳执行转发时按同一个函数认回来，telegram/shelf.ts）：
 * 会话 + 消息的哈希，稳定、不透明、不是递增数字。
 */
export function itemId(scope: string, messageId: string): string {
  return `f${hash32(`${scope}:${messageId}`).toString(36).padStart(6, "0").slice(-6)}`;
}

/** 一条要转的东西从哪来（转发的受众规则用）。 */
export type ItemSource =
  | { kind: "channel" }
  | { kind: "group"; scope: string; present: readonly string[] }
  | { kind: "private"; scope: string };

/**
 * 转发的受众规则（隐私不变量，A14）：频道帖子和群里的消息转到哪都行（北极星不变量 1 收窄后，群里当众说的不算
 * 托付的事，PLAN 第 33 件；以前群里的只转回原群或给当时在场的人）。私聊里的消息永不原样转出：转发是原话带名字，
 * 一条消息又没有人替它标过"托付的、私密的"（日记、关于人的事是反思时她自己标的），无从分辨，所以不转。
 */
export function mayForward(
  source: ItemSource,
  _target: { scope: string; chatType: ChatType; partner: string | null },
): boolean {
  return source.kind !== "private";
}

/**
 * 和一个人的私聊会话：和你们见面的那个群在同一个网络里，会话 id 换成这个人的 id
 * （telegram:<群> → telegram:<人>；Telegram 私聊的会话 id 就是对方的用户 id）。
 */
export function privateScopeOf(groupScope: string, contactId: string): string {
  const i = groupScope.lastIndexOf(":");
  return i < 0 ? contactId : `${groupScope.slice(0, i + 1)}${contactId}`;
}

function clip(text: string, max = LINE_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : flat;
}

/**
 * 谁不收她的私聊：Telegram 这么说了就记下这个人；他先在私聊里找她，就不再算。
 * 私聊的对方取世界里这个会话的 partner（第一次私聊失败时世界底座已经建出了这个会话）。
 */
function noteClosed<W extends View<"reach" | "chats">>(world: W, event: AliceEvent): W {
  const reach = world.reach;
  if (event.type === "act.failed" && event.reason !== "errand" && event.dmClosed) {
    const chat = world.chats[event.scope];
    const partner = chat?.chatType === "private" ? chat.partner : null;
    if (!partner || reach.closed?.[partner] !== undefined) return world;
    return { ...world, reach: { ...reach, closed: { ...reach.closed, [partner]: event.at } } };
  }
  if (event.type === "message.received" && event.chatType === "private") {
    if (reach.closed?.[event.senderId] === undefined) return world;
    const { [event.senderId]: _, ...closed } = reach.closed;
    return { ...world, reach: { ...reach, closed } };
  }
  return world;
}

/** 这个私聊的对方不收她的私聊（noteClosed）。 */
export function closedTo(world: View<"reach" | "chats">, scope: string): boolean {
  const partner = world.chats[scope]?.partner;
  return !!partner && world.reach.closed?.[partner] !== undefined;
}

/** 世界折叠之后：记下谁在哪个群里说过什么、群叫什么、她找群时看到了哪些群、谁不收她的私聊。 */
export function noteReach<W extends View<"reach" | "chats">>(world: W, event: AliceEvent): W {
  const closed = noteClosed(world, event);
  if (closed !== world) return closed;
  const noted = noteInfo(world, event);
  if (noted !== world) return noted;
  if (event.type === "act.done" && event.found?.length) {
    const reach = world.reach;
    const places = { ...reach.places };
    for (const p of event.found) places[p.scope] = { ...p, seenAt: event.at };
    const kept = Object.values(places)
      .sort((a, b) => b.seenAt - a.seenAt)
      .slice(0, PLACES_KEPT);
    return {
      ...world,
      reach: { ...reach, places: Object.fromEntries(kept.map((p) => [p.scope, p])) },
    };
  }
  if (event.type !== "message.received" || event.chatType !== "group") return world;
  const reach = world.reach;
  const said = event.text ?? event.media ?? null;
  const titles =
    event.chatTitle && reach.titles[event.scope] !== event.chatTitle
      ? { ...reach.titles, [event.scope]: event.chatTitle }
      : reach.titles;
  if (!said || event.senderId === "unknown") {
    return titles === reach.titles ? world : { ...world, reach: { ...reach, titles } };
  }
  const prev = reach.met[event.senderId];
  const kept = prev && prev.scope === event.scope ? prev.lines : [];
  const line: MetLine = { at: event.at, text: clip(said), toHer: event.directed };
  const met: Met = { scope: event.scope, lines: [...kept, line].slice(-MET_LINES) };
  return {
    ...world,
    reach: { ...reach, titles, met: { ...reach.met, [event.senderId]: met } },
  };
}

/** 已经有私聊的人。 */
function partners(world: View<"chats">): Set<string> {
  const out = new Set<string>();
  for (const c of Object.values(world.chats)) if (c.partner) out.add(c.partner);
  return out;
}

/** 在群里认识、还没私聊过的人（不收她私聊的除外）：私聊会话 → 对方 id。 */
export function unopenedPrivate(world: Reachable): Map<string, string> {
  const out = new Map<string, string>();
  const has = partners(world);
  for (const [id, met] of Object.entries(world.reach.met)) {
    if (has.has(id) || world.reach.closed?.[id] !== undefined) continue;
    if ((relationView(world, id)?.lastBondAt ?? 0) <= 0) continue;
    const scope = privateScopeOf(met.scope, id);
    if (!world.chats[scope]) out.set(scope, id);
  }
  return out;
}

/** 看过预览、她不在里面的群和频道（包括她以前退出、后来又找到的）。 */
function unjoined(world: View<"reach" | "chats">): SeenPlace[] {
  return Object.values(world.reach.places).filter((p) => world.chats[p.scope]?.member !== true);
}

/** 一个还不存在的会话在意愿层里的样子；已有的会话照原样，只带上看过预览的时刻。 */
function candidateNode(world: Reachable, scope: string): ChatNode | null {
  const place = world.reach.places[scope];
  const node = world.chats[scope];
  if (place && node?.member !== true) {
    return {
      ...(node ?? { ...freshChat("group"), member: false }),
      place: { seenAt: place.seenAt },
    };
  }
  if (node) return null;
  const partner = unopenedPrivate(world).get(scope);
  return partner ? { ...freshChat("private"), partner, unopened: true } : null;
}

/** 意愿层排序用的世界：已有的会话加上还没开过的私聊、看过预览的群（只用来排序，不折进状态）。 */
export function withUnopened<W extends Reachable>(world: W): W {
  const scopes = [...unopenedPrivate(world).keys(), ...unjoined(world).map((p) => p.scope)];
  if (scopes.length === 0) return world;
  const chats: Record<string, ChatNode> = { ...world.chats };
  for (const scope of scopes) {
    const node = candidateNode(world, scope);
    if (node) chats[scope] = node;
  }
  return { ...world, chats };
}

/** 只带上一个候选（她被叫醒在那里时，提示词里的事实按它算）。 */
export function withOne<W extends Reachable>(world: W, scope: string): W {
  const node = candidateNode(world, scope);
  return node ? { ...world, chats: { ...world.chats, [scope]: node } } : world;
}

/** 意愿落在一个还没有的会话上时，核心建出的空会话：私聊她能直接开口，没加入的群只能加入。 */
export function openingOf(world: Reachable, scope: string): Opening | null {
  if (world.chats[scope]) return null;
  const node = candidateNode(world, scope);
  if (!node) return null;
  const chatType: ChatType = node.chatType;
  return { scope, chatType, member: node.member };
}

/**
 * 世界折叠之前：她在一个还没有的会话里做了决定（或开了口、动作做完或失败），这个会话从此存在，
 * 后面的折叠（想过就消耗、对方没回的连发、冷却、加入）都照已有会话算。
 */
export function openOnUse<W extends Reachable>(world: W, event: AliceEvent): W {
  switch (event.type) {
    case "speech.decided":
    case "speech.failed":
    case "message.sent":
    case "act.done":
    case "act.failed": {
      if (world.chats[event.scope]) return world;
      const node = candidateNode(world, event.scope);
      if (!node) return world;
      const { unopened: _, ...opened } = node;
      return { ...world, chats: { ...world.chats, [event.scope]: opened } };
    }
    default:
      return world;
  }
}

/**
 * 加入的机会成本 C_join = load·tanh(G/κ)：G 是她在里面、这一周里有人说话的群（params.ts JOIN）。
 * 和离开的 C_exit（will.ts exitCost）一起只对改变成员身份的动作收。
 */
export function joinCost(world: View<"chats">, now: number): number {
  let groups = 0;
  for (const c of Object.values(world.chats)) {
    if (c.chatType === "group" && c.member && now - c.lastIncomingAt < JOIN.activeWithin) groups++;
  }
  return JOIN.load * Math.tanh(groups / JOIN.kappa);
}

/** 私聊里一共不到这么多条（没有更早的记录）时，还算刚开始私聊，写明你们是在哪认识的。 */
export const YOUNG_PRIVATE_LINES = 10;

/**
 * 刚开始的私聊里，她和对方是在哪认识的：群名和对方在那个群里说过的几句（只有对方本人公开说的话）。
 * lines 是这个私聊至今的条数（有更早的记录时为 null，不再写）。
 */
export function metText(
  world: Reachable,
  scope: string,
  now: number,
  lines: number | null,
): string | null {
  if (lines === null || lines >= YOUNG_PRIVATE_LINES) return null;
  const partner = world.chats[scope]?.partner;
  const met = partner ? world.reach.met[partner] : undefined;
  if (!partner || !met) return null;
  const name = nameOf(world, partner) ?? "对方";
  const title = world.reach.titles[met.scope];
  const where = title ? `群「${title}」` : "一个群";
  const said = met.lines
    .filter((l) => l.at <= now)
    .map((l) => `- ${elapsed(now - l.at)}前：${l.text}${l.toHer ? "（对你说的）" : ""}`);
  const head =
    lines === 0
      ? `你和${name}还没有私聊过，你们是在${where}里认识的。`
      : `你和${name}是在${where}里认识的，私聊刚开始。`;
  return said.length > 0 ? `${head}${name}在那里说过：\n${said.join("\n")}` : head;
}

/** 人数写成"1.2 万人"这样。 */
function people(n: number | null, kind: FoundPlace["kind"]): string {
  if (n === null) return "";
  const count = n >= 10_000 ? `${(n / 10_000).toFixed(1).replace(/\.0$/, "")} 万` : String(n);
  return kind === "channel" ? `，${count} 人订阅` : `，${count} 人`;
}

/** 一个群或频道的预览写成一段（找群的结果、去那个群看看时的事实都用它）。 */
export function placeLines(p: FoundPlace): string[] {
  const head = `${p.kind === "channel" ? "频道" : "群"}「${p.title}」${people(p.members, p.kind)}`;
  return [
    p.about ? `${head}。简介：${clip(p.about, 120)}` : `${head}。`,
    ...p.recent.slice(0, 3).map((r) => `  最近：${clip(r)}`),
  ];
}

/** 找群看到的东西写给她看（外壳和回放的桩都用它）。 */
export function foundText(query: string, found: readonly FoundPlace[]): string {
  if (found.length === 0) return `想找的“${query}”，没找到公开的群和频道。`;
  const lines = found.flatMap((p) => placeLines(p).map((l, i) => (i === 0 ? `- ${l}` : `  ${l}`)));
  // 写明只是预览：真模型探针里她看了预览就说"进去了"（scenes/synthetic-v2/s02，2026-11-11）。
  return `想找的“${query}”，找到这些（只看到预览，你还没加入）：\n${lines.join("\n")}`;
}

/** 她还没加入、只看过预览的群：去那里看看时，提示词里写她看到过的预览。 */
export function placeText(
  world: View<"reach" | "chats">,
  scope: string,
  now: number,
): string | null {
  const place = world.reach.places[scope];
  if (!place || world.chats[scope]?.member === true) return null;
  return [
    `你${elapsed(now - place.seenAt)}前找群时看到过这个${place.kind === "channel" ? "频道" : "群"}，还没加入：`,
    ...placeLines(place),
  ].join("\n");
}

/** 候选 reach 提供的对外能力：找群（看了才知道）、转发看过的公开内容。 */
export const REACH_AFFORDANCES = ["chat-search", "forward"] as const satisfies readonly ActKind[];

/** 去一个只看过预览的群看看时的此刻。 */
const PLACE_MOMENT = "你还不在这里面。想加入就加入，不想就算了。";

/**
 * 她够得着的地方（候选 A10、A18）：还没开过的私聊、看过预览的群作为还不存在的会话进意愿的候选；选中时在那里
 * 叫醒她。提示词里写你们是在哪个群认识的、他在那里说过的几句、她看过的预览和频道里看到的东西；转发只在有可转的
 * 东西时出现（这个私聊里摆着频道里看到的帖子）。
 */
export const reach: PressureFeature = feature({
  name: "reach",
  provides: ["reach", "chats.place"],
  requires: ["relations", "willingness"],
  affordances: REACH_AFFORDANCES,
  offers: (kind, scope, world, now) => {
    if (kind !== "forward") return true;
    const partner = world.chats[scope]?.partner;
    return partner ? infoShown(world, partner, now).length > 0 : false;
  },
  reduce: (_before, after, event) => noteReach(after, event),
  view: withOne,
  away: (world, chat, now) => !chat.member && placeText(world, chat.scope, now) !== null,
  outside: true,
  contribute: ({ world, chat, now, outside }) => {
    if (outside) {
      return [
        {
          mechanism: "pressure-reach",
          kind: "scene",
          text: placeText(world, chat.scope, now) ?? "",
        },
        { mechanism: "pressure-reach", kind: "turn", text: PLACE_MOMENT },
      ];
    }
    const c = world.chats[chat.scope];
    const met = metText(world, chat.scope, now, chat.earlier?.length ? null : chat.timeline.length);
    const seen = c?.partner ? infoText(world, c.partner, now) : null;
    return [met, seen].flatMap((text) =>
      text ? [{ mechanism: "pressure-reach", kind: "scene" as const, text }] : [],
    );
  },
  opens: openingOf,
  // 不收她私聊的人：和他的私聊不在她眼前，直到他先来找她。
  will: { candidates: withUnopened, visible: (world, scope) => !closedTo(world, scope) },
});

// ── 频道里看到的东西（P02、M03、B04）────────────────────────────────

/**
 * 频道新帖记成她看到的东西；她在一个私聊里想过（做了决定或调用失败）之后，当时摆在她面前的那几条
 * 算是跟这个人想过了（考虑过就消耗）；转发出去的也算。
 */
function noteInfo<W extends View<"reach" | "chats">>(world: W, event: AliceEvent): W {
  const reach = world.reach;
  if (event.type === "post.received") {
    const said = event.text ?? event.media ?? null;
    if (!said) return world;
    const item: InfoItem = {
      id: itemId(event.scope, event.messageId),
      scope: event.scope,
      messageId: event.messageId,
      title: event.title,
      text: clip(said, INFO.chars),
      at: event.at,
      offered: [],
    };
    const info = [...reach.info.filter((i) => event.at - i.at < INFO.kept), item].slice(
      -INFO.count,
    );
    return { ...world, reach: { ...reach, info } };
  }
  if (event.type !== "speech.decided" && event.type !== "speech.failed") return world;
  const partner = world.chats[event.scope]?.partner;
  if (!partner || reach.info.length === 0) return world;
  const shown = new Set(infoShown(world, partner, event.at).map((i) => i.id));
  if (shown.size === 0) return world;
  const info = reach.info.map((i) =>
    shown.has(i.id) ? { ...i, offered: [...i.offered, partner] } : i,
  );
  return { ...world, reach: { ...reach, info } };
}

/** 此刻在和这个人的私聊里摆在她面前的：还新鲜、还没跟他想过的几条，新的在前。 */
export function infoShown(world: View<"reach">, partner: string, now: number): InfoItem[] {
  return world.reach.info
    .filter((i) => i.at <= now && now - i.at < INFO.shownWithin && !i.offered.includes(partner))
    .sort((a, b) => b.at - a.at)
    .slice(0, INFO.shown);
}

/**
 * P2 信息压力（M03）：她看到了还没跟这个人分享的新鲜东西，想跟亲近的人说一说（越新鲜越想说，越亲近越想说）。
 * 只对私聊算，按 e^(−age/INFO.fresh) 累加，乘这个人的层级权重；想过就消耗。不判断内容合不合对方口味，
 * 那是她醒来之后自己看着办的事。
 */
export function infoPressure(
  world: View<"reach">,
  chat: ChatNode,
  weight: number,
  now: number,
): number {
  if (chat.chatType !== "private" || !chat.partner || !world.reach.info.length) return 0;
  return (
    weight *
    infoShown(world, chat.partner, now).reduce(
      (a, i) => a + Math.exp(-(now - i.at) / INFO.fresh),
      0,
    )
  );
}

/** 私聊的提示词里：她最近在频道里看到、还没跟对方说过的几条（编号用来转发）。 */
export function infoText(world: View<"reach">, partner: string, now: number): string | null {
  const items = infoShown(world, partner, now);
  if (items.length === 0) return null;
  const lines = items.map(
    (i) => `[${i.id}] 频道「${i.title}」，${elapsed(now - i.at)}前：${i.text}`,
  );
  return `你最近在频道里看到的（还没跟对方说过）：\n${lines.join("\n")}`;
}
