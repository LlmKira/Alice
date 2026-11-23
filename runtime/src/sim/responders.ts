/**
 * 别人的回应模型：一个人在群里说完一轮之后，有没有人引用回复这一轮、谁回、隔多久。从真人数据（2 月 B 等数据集里
 * 别人和别人之间的来回）数出来，回放时用在她说完的那一轮上，取代固定概率的 --respond p。
 *
 * - 轮：同一人连着发、中间没人插话、相邻两条不超过 90 秒（active-profile/profile.py 的口径）。
 * - 有人回：这一轮说完后 10 分钟内，别人引用回复了这一轮里的某一条。数据集里只有引用，没有人点人的名，
 *   所以只出引用回复。
 * - 条件：群的热闹程度（这一轮开头之前 10 分钟里的条数：≤ 4 安静、5–19 中等、≥ 20 热闹），以及这一轮是不是在接
 *   某个人（真人：第一条引用了别人；她：这一轮不是她自己主动开口的）。
 * - 谁回：她这一轮之前 10 分钟里最后一个说话的别人，或倒数第二个（按数据里两者的比例）。
 * - 多久：同一热闹程度下真人回复延迟的经验分布里抽。
 * - 回复的事件和平台送来的一样：带 replyToMessageId，directed 为 false。认不认得出"在回复她"是心智的事
 *   （外壳与心智那一侧的修复），这里不替它认。
 * 抽样按 (会话, 时刻) 的哈希，确定。
 *
 * - 给了线上 Journal（--live）时，回她的概率用线上别人回她的实数（按热闹程度），不用真人之间的。
 *
 * 用法：tsx src/sim/responders.ts fit <model.json> <dataset.jsonl>... [--live <alice.db>]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { unit } from "../mechanisms/hash.js";
import { TURN_GAP } from "../mechanisms/pressure/params.js";
import type { AliceEvent, MessageReceived, MessageSent } from "../mind/events.js";
import type { AliceState } from "../mind/state.js";
import { readJournal } from "./trace.js";

const MIN = 60_000;
const WINDOW = 10 * MIN;
const KEEP_DELAYS = 400;

export type Heat = "quiet" | "mid" | "hot";
export const heatOf = (before: number): Heat =>
  before <= 4 ? "quiet" : before < 20 ? "mid" : "hot";

export interface ResponderModel {
  version: 1;
  /** `${heat}|${addressed}` → 轮数与被引用回复的轮数。 */
  cells: Record<string, { turns: number; replied: number }>;
  /** 每个热闹程度下回复延迟的样本（毫秒，排好序，最多 KEEP_DELAYS 个）。 */
  delays: Record<Heat, number[]>;
  /** 回复的人是前 10 分钟里最后一个说话的别人的比例（其余算倒数第二个）。 */
  last: { n: number; hits: number };
  /**
   * 别人对她这一轮的回复（线上 Journal 里她的群里一轮，按热闹程度）。有就用它，不用真人之间的：
   * 线上别人回她比回彼此多（2026-11-13：0.39–0.52 对 0.20–0.36）。
   */
  her?: Partial<Record<Heat, { turns: number; replied: number }>>;
}

/** 线上 Journal 里她的群里一轮（同一时刻或 90 秒内连着发、中间没人插话）被别人引用回复的次数，按热闹程度。 */
export function fitHer(events: readonly AliceEvent[]): NonNullable<ResponderModel["her"]> {
  const out: NonNullable<ResponderModel["her"]> = {};
  for (const list of groupStreams(events).values()) {
    list.sort((a, b) => a.at - b.at);
    for (let i = 0; i < list.length; i++) {
      const e = list[i] as AliceEvent;
      const prev = list[i - 1];
      if (e.type !== "message.sent") continue;
      if (prev?.type === "message.sent" && e.at - prev.at <= TURN_GAP) continue;
      const { ids, next } = herTurn(list, i);
      const end = (list[next - 1] as AliceEvent).at;
      const before = list.filter(
        (m) => m.type === "message.received" && m.at < e.at && m.at >= e.at - WINDOW,
      ).length;
      const heat = heatOf(before);
      const c = out[heat] ?? { turns: 0, replied: 0 };
      out[heat] = c;
      c.turns++;
      const replied = list
        .slice(next)
        .some(
          (m) =>
            m.type === "message.received" &&
            m.at <= end + WINDOW &&
            m.replyToMessageId !== null &&
            ids.has(m.replyToMessageId),
        );
      if (replied) c.replied++;
    }
  }
  return out;
}

/** 每个群里别人的消息和她发的消息，按会话分开。 */
function groupStreams(events: readonly AliceEvent[]): Map<string, AliceEvent[]> {
  const groups = new Map<string, AliceEvent[]>();
  for (const e of events) {
    const inGroup =
      (e.type === "message.received" && e.chatType === "group") ||
      (e.type === "message.sent" && e.scope.startsWith("telegram:-"));
    if (!inGroup) continue;
    const list = groups.get(e.scope) ?? [];
    list.push(e);
    groups.set(e.scope, list);
  }
  return groups;
}

/**
 * 从 i 开始她的一轮：到下一次隔了 90 秒以上为止，再往后的那条自己开一轮，不算进这一轮。
 * 返回这一轮的消息编号和这一轮之后第一条的下标。
 */
function herTurn(list: readonly AliceEvent[], i: number): { ids: Set<string>; next: number } {
  const ids = new Set<string>();
  let j = i;
  while (
    list[j]?.type === "message.sent" &&
    (j === i || (list[j] as AliceEvent).at - (list[j - 1] as AliceEvent).at <= TURN_GAP)
  ) {
    ids.add((list[j] as MessageSent).messageId);
    j++;
  }
  return { ids, next: j };
}

interface Msg {
  at: number;
  sender: string;
  id: string;
  re: string | null;
}

/** 从数据集的群消息数出模型（只看真人之间：她当年的话不算）。 */
export function fitResponders(events: readonly AliceEvent[]): ResponderModel {
  const groups = new Map<string, Msg[]>();
  for (const e of events) {
    if (e.type !== "message.received" || e.chatType !== "group" || e.isBot) continue;
    const list = groups.get(e.scope) ?? [];
    list.push({ at: e.at, sender: e.senderId, id: e.messageId, re: e.replyToMessageId });
    groups.set(e.scope, list);
  }
  const model: ResponderModel = {
    version: 1,
    cells: {},
    delays: { quiet: [], mid: [], hot: [] },
    last: { n: 0, hits: 0 },
  };
  for (const msgs of groups.values()) {
    msgs.sort((a, b) => a.at - b.at);
    let i = 0;
    while (i < msgs.length) {
      const j = turnEnd(msgs, i);
      countTurn(model, msgs, i, j);
      i = j + 1;
    }
  }
  for (const h of ["quiet", "mid", "hot"] as const) {
    const d = model.delays[h].sort((a, b) => a - b);
    const step = Math.max(1, Math.ceil(d.length / KEEP_DELAYS));
    model.delays[h] = d.filter((_, k) => k % step === 0);
  }
  return model;
}

/** 从 i 开始的一轮的最后一条的下标。 */
function turnEnd(msgs: readonly Msg[], i: number): number {
  const first = msgs[i] as Msg;
  let j = i;
  while (
    j + 1 < msgs.length &&
    (msgs[j + 1] as Msg).sender === first.sender &&
    (msgs[j + 1] as Msg).at - (msgs[j] as Msg).at <= TURN_GAP
  )
    j++;
  return j;
}

/** 一轮（msgs[i..j]）之前 10 分钟里的条数，和说过话的别人（最近的在前）。 */
function lookBack(msgs: readonly Msg[], i: number): { before: number; speakers: string[] } {
  const first = msgs[i] as Msg;
  let before = 0;
  const speakers: string[] = [];
  for (let k = i - 1; k >= 0 && (msgs[k] as Msg).at >= first.at - WINDOW; k--) {
    before++;
    const s = (msgs[k] as Msg).sender;
    if (s !== first.sender && !speakers.includes(s)) speakers.push(s);
  }
  return { before, speakers };
}

/** 把一轮（msgs[i..j]）记进模型：这一格的轮数、有没有人回、隔多久、回的是不是最后说话的那个人。 */
function countTurn(model: ResponderModel, msgs: readonly Msg[], i: number, j: number): void {
  const first = msgs[i] as Msg;
  const end = (msgs[j] as Msg).at;
  const ids = new Set(msgs.slice(i, j + 1).map((m) => m.id));
  const { before, speakers } = lookBack(msgs, i);
  const heat = heatOf(before);
  const cellKey = `${heat}|${first.re !== null}`;
  const cell = model.cells[cellKey] ?? { turns: 0, replied: 0 };
  model.cells[cellKey] = cell;
  cell.turns++;
  const reply = msgs
    .slice(j + 1)
    .find(
      (m) => m.at <= end + WINDOW && m.sender !== first.sender && m.re !== null && ids.has(m.re),
    );
  if (!reply) return;
  cell.replied++;
  model.delays[heat].push(reply.at - end);
  if (speakers.length > 0) {
    model.last.n++;
    if (reply.sender === speakers[0]) model.last.hits++;
  }
}

/** 她这一轮被引用回复的概率（加一平滑）。 */
export function replyChance(model: ResponderModel, heat: Heat, addressed: boolean): number {
  const c = model.her?.[heat] ?? model.cells[`${heat}|${addressed}`] ?? { turns: 0, replied: 0 };
  return (c.replied + 1) / (c.turns + 2);
}

/**
 * 回放用的回应：她在群里说完一轮（同一时刻的几条只回一次），按模型决定有没有人引用回复她。
 * addressed：这一轮是不是在接某个人（压力场记下的"她主动开口"取反）。
 */
export function responders(
  model: ResponderModel,
  events: readonly AliceEvent[],
  addressed: (sent: MessageSent, state: AliceState) => boolean,
  onReply: (reply: MessageReceived) => void = () => {},
): (sent: MessageSent, state: AliceState) => AliceEvent[] {
  const said = new Map<string, Array<{ at: number; id: string; name: string }>>();
  for (const e of events) {
    if (e.type !== "message.received" || e.chatType !== "group" || e.isBot) continue;
    const list = said.get(e.scope) ?? [];
    list.push({ at: e.at, id: e.senderId, name: e.senderName });
    said.set(e.scope, list);
  }
  const answered = new Set<string>();
  let n = 0;
  return (sent, state) => {
    const key = `${sent.scope}@${sent.at}`;
    const list = said.get(sent.scope);
    if (!list || answered.has(key)) return [];
    answered.add(key);
    const recent = list.filter((m) => m.at <= sent.at && m.at >= sent.at - WINDOW);
    const heat = heatOf(recent.length);
    if (unit(`respond:${key}`) >= replyChance(model, heat, addressed(sent, state))) return [];
    const speakers: typeof recent = [];
    for (const m of [...recent].reverse())
      if (!speakers.some((s) => s.id === m.id)) speakers.push(m);
    const lastShare = (model.last.hits + 1) / (model.last.n + 2);
    const who = unit(`who:${key}`) < lastShare ? speakers[0] : (speakers[1] ?? speakers[0]);
    if (!who) return [];
    const delays = model.delays[heat].length > 0 ? model.delays[heat] : [60_000];
    const delay = delays[Math.floor(unit(`delay:${key}`) * delays.length)] as number;
    n++;
    const reply: MessageReceived = {
      type: "message.received",
      at: sent.at + Math.max(1000, delay),
      scope: sent.scope,
      chatType: "group",
      messageId: `respond:${n}`,
      senderId: who.id,
      senderName: who.name,
      text: "（回你的话）",
      contentType: "text",
      replyToMessageId: sent.messageId,
      directed: false,
    };
    onReply(reply);
    return [reply];
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const at = args.indexOf("--live");
  const live = at >= 0 ? (args.splice(at, 2)[1] ?? null) : null;
  const [cmd, out, ...inputs] = args;
  if (cmd !== "fit" || !out || inputs.length === 0) {
    throw new Error("usage: responders.ts fit <model.json> <dataset.jsonl>... [--live <alice.db>]");
  }
  const events = inputs.flatMap((p) =>
    readFileSync(p, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AliceEvent),
  );
  const model = fitResponders(events);
  if (live) model.her = fitHer(readJournal(live).events);
  writeFileSync(out, `${JSON.stringify(model)}\n`);
  for (const [k, c] of Object.entries(model.cells).sort())
    console.log(`${k}: ${c.replied}/${c.turns} = ${(c.replied / c.turns).toFixed(3)}`);
  for (const [k, c] of Object.entries(model.her ?? {}).sort())
    console.log(`her ${k}: ${c.replied}/${c.turns}`);
  console.log(`last speaker replies: ${model.last.hits}/${model.last.n}`);
}

if (process.argv[1]?.endsWith("responders.ts")) main();
