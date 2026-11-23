/**
 * 北极星读数（capabilities X01）：只读 Journal，按天（东八区）输出。
 *
 * 1. 别人主动找她：隔了一段时间（--gap，默认 60 分钟）后别人先开口，不是回她的话。
 *    私聊：这条之前这个私聊安静了至少 gap；如果安静之前最后一句是她说的、而且还在"等回音"的窗口里
 *    （--unanswered，默认 12 小时），这条算晚到的回复，不算主动。群里：点名她（不是回复她的消息），
 *    而且此前 gap 内她没在这个群说话、这个人也没点过她。
 * 2. 回来的人：这天第一次冲着她说话（私聊、回复她、点名她）的人里，之后第 1 到第 7 天又主动找她（第 1 条的口径）
 *    的人数。第 7 天还没过完的那几天记为待定。
 * 3. 温暖反应的广度：给她的消息点正面表情的不同的人、回复她的不同的人（回复她的消息，或私聊里在等回音的
 *    窗口内接她的话）。
 * 4. 被嫌弃的信号：被拉黑（发送失败 refused）、发不出去（没有权限、会话不可达、账号注销）、被踢、点负面表情的人、
 *    私聊里连着不回、活跃过的人不再出现（在至少 2 天里说过话，此后 7 天没再出现；记在满 7 天的那天）。
 *    私聊里连着不回：她带着话头去找，对方在窗口内没说话，连着 ignoredRun 次。带着话头去找 = 安静至少 gap 后
 *    她先开口、不是在晚回对方的话，这一段里不只有贴纸。旧口径（她说完、对方窗口内没回，自然聊完也算）
 *    这一版并列输出，下一版删。
 * 5. 群里接她的话：她在群里说完一轮，uptakeMs 内接着这一轮说的不同的人数和轮数（不用点回复，接法见 Talk）。
 *    对照：同一群当天发言条数前四分之一的真人，每人同样算一遍，给 p25–p75。
 * 6. 她一天的总轮数：所有群和私聊加起来。对照：在她的两个以上会话里说过话的真人，当天在这些会话里的轮数合计，
 *    取最多的那个人；这样的人当天少于 4 个时不给对照。
 *
 * 只用 typed 信号：事件类型、回复指向、点名标记、成员变化、Telegram 错误码、表情（Telegram 给的有限集合）、
 * 时刻、消息种类。不读文字判语义。"被叫停"（对方叫她别说了、走开）要读文字，这里不猜：`--stop-candidates <文件>` 把
 * "紧跟在她的话后面、冲着她来的消息"连同她前面的话导出成 JSONL，每行带着要问判别员的问题，由主会话离线判。
 * 导出的是真实聊天，只写进 gitignore 的目录（runtime/eval-artifacts/ 或 runtime/live/）。
 *
 * 7. 按组分开（--by-arm，线上轮换 mind/rotation.ts）：每一行再按组分（生产、候选、没分组），组按事件发生那一刻
 *    那个会话（或她这个人）的 arm.switched 记录认；一天从东八区 DAY_START_HOUR 点算起，和轮换的时间段对齐。
 *    "回来的人"记在那个人第一次来找时的组；"不再出现"记在他最后出现的会话的组；群里一轮记在那一轮开始时的组。
 *    最后多一张每组的平均。
 *
 * 用法：pnpm northstar <journal.db> [--json] [--by-arm] [--gap 60] [--unanswered 12] [--exclude id,id]
 *                                  [--stop-candidates <out.jsonl>]
 * 暂停期间没做的调用（reason paused）单独计数，读数时把那几天当作不完整。
 */
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { decodeEvent } from "./journal.js";
import { type AliceEvent, type MessageReceived, NEGATIVE_REACTIONS } from "./mind/events.js";
import { FAILURES } from "./mind/failure.js";
import { DAY_START_HOUR } from "./mind/rotation.js";
import { towardHerReader } from "./mind/step.js";
import { dayKey } from "./ops/spend.js";

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
/** 一轮：同一个人连着说、中间没人插话、相邻两条不超过 90 秒（active-profile、sim/responders.ts 的口径）。 */
const TURN_MS = 90_000;
/** 接得上的间隔：Elsner & Charniak 2008 只给相隔 129 秒以内的两条打分。 */
const LINK_MS = 129_000;
/** 往回找接在哪条上，最多走这么多步。 */
const MAX_HOPS = 200;

/** 平行数组按下标互相引用，越界说明计算本身错了，直接报错。 */
function nth<T>(xs: readonly T[], i: number): T {
  const x = xs[i];
  if (x === undefined) throw new RangeError(`index ${i} out of ${xs.length}`);
  return x;
}
/** 精力的对照至少要这么多跨会话的真人，才说得上"最活跃的那个"。 */
const MIN_CROSS_CHAT = 4;

/** 正面的表情回应（Telegram 的回应是有限集合；不在两张表里的算中性）。 */
const POSITIVE = new Set([
  "👍",
  "❤",
  "❤️",
  "🔥",
  "🥰",
  "👏",
  "😁",
  "🤩",
  "🎉",
  "😍",
  "💯",
  "🤣",
  "❤‍🔥",
  "😘",
  "🤗",
  "😇",
  "💘",
  "🏆",
  "🍓",
  "🍾",
  "💋",
  "🙏",
  "👌",
  "🫡",
  "😻",
  "🤝",
  "🆒",
  "🥳",
  "😊",
]);
/** 负面的表情：世界 fold 记成一次轻的拒绝的同一张表（mind/events.ts）。 */
const NEGATIVE = NEGATIVE_REACTIONS;

export interface NorthstarOptions {
  gapMs: number;
  unansweredMs: number;
  /** 不计入的人（例如操作员）。 */
  exclude: ReadonlySet<string>;
  /** 活跃过的人：至少在这么多天里说过话。 */
  activeDays: number;
  /** 不再出现：这么久没出现。 */
  lapseMs: number;
  /** 回来的人：第一次来往之后看几天。 */
  returnDays: number;
  /** 私聊里连着几次带着话头去找、对方都没回，算被嫌弃。 */
  ignoredRun: number;
  /** 群里接她的话：她说完一轮之后多久之内。 */
  uptakeMs: number;
  /** 按轮换的组分开（见文件头第 7 条）。 */
  byArm: boolean;
}

export const DEFAULTS: NorthstarOptions = {
  gapMs: 60 * MIN,
  unansweredMs: 12 * H,
  exclude: new Set(),
  activeDays: 2,
  lapseMs: 7 * D,
  returnDays: 7,
  // 带着话头去找、12 小时内没回：真人之间（两份私聊导出，129 次）约 1/10，2 月别人对她（70 次）约 1/11；
  // 不嫌弃对方的人之间，连着两次没回一次也没有（eval-artifacts/northstar-live/k_calibration.py）。
  ignoredRun: 2,
  // 2 月三个数据集里真人之间的引用回复，88–91% 在那一轮说完 10 分钟内到；再放宽，多收的回复很少，
  // 紧挨着接上的误认却跟着窗口变多（eval-artifacts/northstar-live/n_calibration.py）。
  uptakeMs: 10 * MIN,
  byArm: false,
};

/** 没有分组记录的时候（轮换开之前、关了之后、还没分到组的会话）。 */
export const UNASSIGNED = "none";

/** 一组人的读数的四分位。 */
export interface Spread {
  p25: number;
  p75: number;
}

export interface DayRow {
  day: string;
  /** --by-arm：production、候选的名字，或 none（没分组）。 */
  arm?: string;
  inbound: number;
  herMessages: number;
  /** 别人主动找她：次数与人数。 */
  initiations: number;
  initiators: number;
  /** 回来的人：这天第一次冲着她说话的人数，其中之后 returnDays 天里又主动找她的人数（待定时是到目前的数）。 */
  newPeople: number;
  returned: number;
  returnPending: boolean;
  /** 温暖：点正面表情或回复她的不同的人。 */
  warmPeople: number;
  positiveReactors: number;
  repliers: number;
  /** 被嫌弃的信号。 */
  refusedChats: number;
  unreachableChats: number;
  kickedChats: number;
  negativeReactors: number;
  /** 私聊里她带着话头去找、对方连着 ignoredRun 次没回的人数（记在第 ignoredRun 次那天）。 */
  dmIgnored: number;
  /** 她带着话头去找、窗口还没过完的次数（只出现在最后一两天）。 */
  dmApproachPending: number;
  /** 旧口径，下一版删：私聊里她说完、对方窗口内没回（自然聊完也算）；窗口还没过完的记为待定。 */
  dmUnanswered: number;
  dmUnansweredPeople: number;
  dmPending: number;
  lapsedPeople: number;
  /** 群里接她的话：她这天在群里说完、窗口已过完的轮数；平均每轮接着说的不同的人数、别人的轮数。 */
  groupTurns: number;
  uptakePeople: number | null;
  uptakeTurns: number | null;
  /** 同样的两个数，同一群当天发言条数前四分之一的真人，每人一个平均数。 */
  bandPeople: Spread | null;
  bandTurns: Spread | null;
  /** 她这天在所有会话里的轮数。 */
  herTurns: number;
  /** 在她的两个以上会话里说过话、这天说了话的真人数；其中这天轮数最多的那个人的轮数（人数不够时 null）。 */
  crossChatPeople: number;
  crossChatTop: number | null;
  /** 暂停期间没做的发言调用。 */
  pausedCalls: number;
}

export interface StopCandidate {
  at: number;
  scope: string;
  chatType: string;
  senderId: string;
  her: string[];
  message: string | null;
  question: string;
}

/** 给判别员的问题（"被叫停"）：只答是或否。 */
export const STOP_QUESTION =
  "下面是 Alice 说的话和紧接着冲她来的一条消息。这条消息是不是明确地叫她停下、别说了、走开、别烦人（不耐烦或嫌弃），" +
  "而不是开玩笑、调侃、斗嘴或普通的不同意？只答“是”或“否”。";

/** 一轮被接着说的人数和轮数。 */
interface Uptake {
  people: number;
  turns: number;
}

interface Bucket {
  inbound: number;
  herMessages: number;
  initiations: number;
  initiators: Set<string>;
  newPeople: number;
  returned: number;
  returnPending: boolean;
  reactors: Set<string>;
  repliers: Set<string>;
  refused: Set<string>;
  unreachable: Set<string>;
  kicked: Set<string>;
  negative: Set<string>;
  dmIgnored: Set<string>;
  dmApproachPending: number;
  dmUnanswered: number;
  dmUnansweredPeople: Set<string>;
  lapsed: number;
  dmPending: number;
  uptakeHer: Uptake[];
  uptakeBand: Uptake[];
  herTurns: number;
  crossChat: number[];
  pausedCalls: number;
}

const bucket = (): Bucket => ({
  inbound: 0,
  herMessages: 0,
  initiations: 0,
  initiators: new Set(),
  newPeople: 0,
  returned: 0,
  returnPending: false,
  reactors: new Set(),
  repliers: new Set(),
  refused: new Set(),
  unreachable: new Set(),
  kicked: new Set(),
  negative: new Set(),
  dmIgnored: new Set(),
  dmApproachPending: 0,
  dmUnanswered: 0,
  dmUnansweredPeople: new Set(),
  lapsed: 0,
  dmPending: 0,
  uptakeHer: [],
  uptakeBand: [],
  herTurns: 0,
  crossChat: [],
  pausedCalls: 0,
});

/**
 * 会话里谁接着谁说。每条话接在一条更早的话上，按这个次序找（Elsner & Charniak 2008、Kummerfeld et al. 2019
 * 的基线接法；对话分线 pressure/threads.ts 进 main 后改读它）：
 * - 它引用回复的那条（她的话从 speech.decided 的 replyTo 认出来）；
 * - LINK_MS 之内同一个人的上一条；
 * - LINK_MS 之内紧挨着的上一条。
 * 都没有就是新话头。一轮：同一个人连着说、中间没人插话、相邻两条不超过 TURN_MS。
 */
interface Talk {
  lines: Line[];
  turns: Turn[];
  ids: Map<string, number>;
  /** 每个人（她是 null）最近一句的下标。 */
  last: Map<string | null, number>;
}

interface Line {
  at: number;
  /** 说话的人；她是 null。 */
  by: string | null;
  bot: boolean;
  /** 接在哪一条上（lines 的下标）；新话头是 null。 */
  parent: number | null;
  /** 属于哪一轮（turns 的下标）。 */
  turn: number;
}

interface Turn {
  by: string | null;
  /** 第一句（lines 的下标）。 */
  first: number;
  /** 最后一句的时刻。 */
  end: number;
}

function say(
  t: Talk,
  id: string,
  at: number,
  by: string | null,
  bot: boolean,
  replyTo: string | null,
): void {
  const i = t.lines.length;
  const prev = t.lines[i - 1];
  const own = t.last.get(by);
  let parent = replyTo === null ? null : (t.ids.get(replyTo) ?? null);
  if (parent === null && own !== undefined && at - nth(t.lines, own).at <= LINK_MS) parent = own;
  if (parent === null && prev && at - prev.at <= LINK_MS) parent = i - 1;
  const turn = t.turns.at(-1);
  if (turn && prev && prev.by === by && at - prev.at <= TURN_MS) turn.end = at;
  else t.turns.push({ by, first: i, end: at });
  t.lines.push({ at, by, bot, parent, turn: t.turns.length - 1 });
  t.ids.set(id, i);
  t.last.set(by, i);
}

/**
 * 每一轮被谁接着说了。别人的一条话，顺着"接在哪条上"往回找：
 * - 碰到某人的一轮，算接这个人；
 * - 碰到某人一轮接的那条，而且往回找经过的话都在那一轮开头之后，也算接这个人
 *   （A 说、她回、A 接着说：A 的第二句接在 A 自己的第一句上，也是在接她）。
 * 算给这个人在这条话之前、顺着自己的话说下来的最近一轮（两个人不点回复你一句我一句时，每一轮都被下一句接住）。
 * 那条话要在那一轮说完后 windowMs 之内。她的话、机器人的话不算接。
 */
function uptake(t: Talk, windowMs: number): Uptake[] {
  const people = t.turns.map(() => new Set<string>());
  const turns = t.turns.map(() => new Set<number>());
  // 接在别人话上的轮（那条的下标 → 轮），和同一个人接着自己说的下一轮。
  const hanging = new Map<number, number[]>();
  const next = t.turns.map(() => -1);
  t.turns.forEach((turn, k) => {
    const p = nth(t.lines, turn.first).parent;
    if (p === null) return;
    if (nth(t.lines, p).by === turn.by) next[nth(t.lines, p).turn] = k;
    else hanging.set(p, [...(hanging.get(p) ?? []), k]);
  });
  t.lines.forEach((m, i) => {
    const by = m.by;
    if (by === null || m.bot) return;
    const seen = new Set<string | null>([by]);
    const credit = (found: number) => {
      if (seen.has(nth(t.turns, found).by)) return;
      seen.add(nth(t.turns, found).by);
      let k = found;
      while (nth(next, k) >= 0 && nth(t.turns, nth(next, k)).first < i) k = nth(next, k);
      if (m.at - nth(t.turns, k).end > windowMs) return;
      nth(people, k).add(by);
      nth(turns, k).add(m.turn);
    };
    let child = i;
    for (let x = m.parent, hops = 0; x !== null && hops < MAX_HOPS; hops++) {
      credit(nth(t.lines, x).turn);
      for (const k of [...(hanging.get(x) ?? [])].reverse())
        if (nth(t.turns, k).first < child) credit(k);
      child = x;
      x = nth(t.lines, x).parent;
    }
  });
  return t.turns.map((_, k) => ({ people: nth(people, k).size, turns: nth(turns, k).size }));
}

interface Chat {
  chatType: "private" | "group" | null;
  lastAt: number | null;
  lastWasHers: boolean;
  herIds: Set<string>;
  herLines: string[];
  herLastAt: number | null;
  /** 旧口径：私聊里她这一段话最后一句的时刻；对方回了就关上。 */
  open: number | null;
  /** 私聊里她带着话头去找的这一段：最后一句的时刻、有没有不是贴纸的话；对方说话就关上。 */
  approach: { last: number; topic: boolean } | null;
  /** 对方连着几次没回她带着话头的找。 */
  ignored: number;
  /** 群里每个人上一次点她的时刻。 */
  directedAt: Map<string, number>;
  talk: Talk;
  /** 她决定要说、还没发出的话：发出时认出引用回复了哪条。 */
  deciding: Array<{ text: string; replyTo: string | null }>;
}

export function northstar(
  events: Iterable<AliceEvent>,
  options: Partial<NorthstarOptions> = {},
): { days: DayRow[]; stopCandidates: StopCandidate[] } {
  const reading = new Reading({ ...DEFAULTS, ...options });
  // 冲着她、回复她，和心智同一个判断（mind/step.ts towardHer）：回复她的那条在 Journal 里可能没标 directed。
  const toward = towardHerReader();
  for (const logged of events) {
    const { event, reply } = toward(logged);
    reading.read(event, reply);
  }
  return reading.finish();
}

type EventOf<T extends AliceEvent["type"]> = Extract<AliceEvent, { type: T }>;

/** 按时间顺序读一遍 Journal，边读边把读数记进每天（--by-arm 时每天每组）的桶。 */
class Reading {
  private readonly days = new Map<string, Bucket>();
  /** 每个分组单位（会话，或 "self"）的换组记录，按时间。 */
  private readonly arms = new Map<string, Array<{ at: number; arm: string }>>();
  private readonly chats = new Map<string, Chat>();
  private readonly people = new Map<string, { days: Set<string>; lastAt: number; scope: string }>();
  /** 每个人第一次冲着她说话的时刻（和会话），和每次主动找她的时刻。 */
  private readonly firstContact = new Map<string, { at: number; scope: string }>();
  private readonly initiatedAt = new Map<string, number[]>();
  private readonly stopCandidates: StopCandidate[] = [];
  private end = Number.NEGATIVE_INFINITY;

  constructor(private readonly o: NorthstarOptions) {}

  read(event: AliceEvent, repliesToHer: boolean): void {
    this.end = Math.max(this.end, event.at);
    switch (event.type) {
      case "arm.switched": {
        const arm = event.arm === "candidate" ? event.candidate : (event.arm ?? UNASSIGNED);
        this.arms.set(event.scope, [...(this.arms.get(event.scope) ?? []), { at: event.at, arm }]);
        return;
      }
      case "message.received":
        this.received(event, repliesToHer);
        return;
      case "speech.decided": {
        const c = this.chatOf(event.scope);
        const sends = event.decision.acts.flatMap((a) =>
          a.kind === "send" ? [{ text: a.text, replyTo: a.replyTo ?? null }] : [],
        );
        c.deciding = [...c.deciding, ...sends].slice(-20);
        return;
      }
      case "message.sent":
        this.sent(event);
        return;
      case "reaction.received":
        this.reacted(event);
        return;
      case "act.failed": {
        const delivery = FAILURES[event.reason].delivery;
        if (delivery === "refused") this.at(event.at, event.scope).refused.add(event.scope);
        if (delivery === "unreachable") this.at(event.at, event.scope).unreachable.add(event.scope);
        return;
      }
      case "membership.changed":
        if (event.reason === "kicked") this.at(event.at, event.scope).kicked.add(event.scope);
        return;
      case "speech.failed":
        if (event.reason === "paused") this.at(event.at, event.scope).pausedCalls++;
        return;
      default:
    }
  }

  finish(): { days: DayRow[]; stopCandidates: StopCandidate[] } {
    this.closeOpenChats();
    this.countLapsed();
    this.countReturns();
    const dayOf = (t: number) => this.dayOf(t);
    const keyOf = (t: number, scope: string) => this.keyOf(t, scope);
    const onDay = (key: string) => this.onDay(key);
    readGroups(this.chats, this.o.uptakeMs, this.end, dayOf, keyOf, onDay);
    readAttention(this.chats, keyOf, onDay);
    const rows = [...this.days.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, b]) => dayRow(key, b));
    return { days: rows, stopCandidates: this.stopCandidates };
  }

  private onDay(key: string): Bucket {
    let b = this.days.get(key);
    if (!b) {
      b = bucket();
      this.days.set(key, b);
    }
    return b;
  }

  /** 这一刻这个会话在哪一组：它自己的记录和她这个人（self）的记录里，最近的那一条。 */
  private armAt(scope: string, t: number): string {
    let best: { at: number; arm: string } | null = null;
    for (const key of [scope, "self"]) {
      for (const s of this.arms.get(key) ?? []) {
        if (s.at > t) break;
        if (best === null || s.at >= best.at) best = s;
      }
    }
    return best?.arm ?? UNASSIGNED;
  }

  private dayOf(t: number): string {
    return dayKey(this.o.byArm ? t - DAY_START_HOUR * H : t);
  }

  private keyOf(t: number, scope: string): string {
    return this.o.byArm ? `${this.dayOf(t)}|${this.armAt(scope, t)}` : this.dayOf(t);
  }

  private at(t: number, scope: string): Bucket {
    return this.onDay(this.keyOf(t, scope));
  }

  private chatOf(scope: string): Chat {
    let c = this.chats.get(scope);
    if (!c) {
      c = {
        chatType: null,
        lastAt: null,
        lastWasHers: false,
        herIds: new Set(),
        herLines: [],
        herLastAt: null,
        open: null,
        approach: null,
        ignored: 0,
        directedAt: new Map(),
        talk: { lines: [], turns: [], ids: new Map(), last: new Map() },
        deciding: [],
      };
      this.chats.set(scope, c);
    }
    return c;
  }

  private unanswered(scope: string, c: Chat): void {
    if (c.open === null) return;
    const b = this.at(c.open, scope);
    b.dmUnanswered++;
    b.dmUnansweredPeople.add(scope);
    c.open = null;
  }

  private closeApproach(scope: string, c: Chat, answered: boolean): void {
    if (c.approach === null) return;
    if (c.approach.topic) {
      c.ignored = answered ? 0 : c.ignored + 1;
      if (c.ignored === this.o.ignoredRun) this.at(c.approach.last, scope).dmIgnored.add(scope);
    }
    c.approach = null;
  }

  private received(event: MessageReceived, repliesToHer: boolean): void {
    if (this.o.exclude.has(event.senderId)) return;
    const c = this.chatOf(event.scope);
    c.chatType = event.chatType;
    const bot = event.isBot === true;
    say(c.talk, event.messageId, event.at, event.senderId, bot, event.replyToMessageId);
    const b = this.at(event.at, event.scope);
    b.inbound++;
    this.notePerson(event, bot);
    const answersHer = this.answersInPrivate(event, c);
    const reply = repliesToHer || answersHer;
    if (reply) {
      b.repliers.add(event.senderId);
      this.stopCandidates.push(candidate(event, c));
    }
    if (event.chatType === "private") {
      c.open = null;
      if (c.approach !== null)
        this.closeApproach(event.scope, c, event.at - c.approach.last <= this.o.unansweredMs);
      c.ignored = 0;
    }
    if (!reply && initiates(event, c, this.o)) {
      b.initiations++;
      b.initiators.add(event.senderId);
      this.initiatedAt.set(event.senderId, [
        ...(this.initiatedAt.get(event.senderId) ?? []),
        event.at,
      ]);
    }
    if (event.directed) c.directedAt.set(event.senderId, event.at);
    c.lastAt = event.at;
    c.lastWasHers = false;
  }

  /** 记下这个人哪几天说过话、最后出现在哪，和第一次冲着她说话的时刻。 */
  private notePerson(event: MessageReceived, bot: boolean): void {
    const person = this.people.get(event.senderId) ?? {
      days: new Set(),
      lastAt: event.at,
      scope: event.scope,
    };
    person.days.add(this.dayOf(event.at));
    person.lastAt = event.at;
    person.scope = event.scope;
    this.people.set(event.senderId, person);
    const towardHer = event.chatType === "private" || event.directed;
    if (towardHer && !bot && !this.firstContact.has(event.senderId))
      this.firstContact.set(event.senderId, { at: event.at, scope: event.scope });
  }

  /**
   * 私聊里她说完、窗口还开着：这是在回她。窗口已经过了的那一段先记为没回（旧口径）。
   */
  private answersInPrivate(event: MessageReceived, c: Chat): boolean {
    if (event.chatType !== "private" || c.open === null) return false;
    if (event.at - c.open <= this.o.unansweredMs) return true;
    this.unanswered(event.scope, c);
    return false;
  }

  private sent(event: EventOf<"message.sent">): void {
    const c = this.chatOf(event.scope);
    this.at(event.at, event.scope).herMessages++;
    c.herIds.add(event.messageId);
    if (event.kind === "text") c.herLines = [...c.herLines, event.text].slice(-3);
    say(c.talk, event.messageId, event.at, null, false, takeDecided(c, event));
    // 上一段话过了窗口还没人回：那一段记为没回，从这句起是新的一段。
    if (c.open !== null && event.at - c.open > this.o.unansweredMs) this.unanswered(event.scope, c);
    if (c.chatType !== "group") this.sentInPrivate(event, c);
    c.lastAt = event.at;
    c.lastWasHers = true;
    c.herLastAt = event.at;
  }

  /** 私聊里她说了一句：开一段等回音的窗口，接上或开始一段带着话头去找。 */
  private sentInPrivate(event: EventOf<"message.sent">, c: Chat): void {
    c.open = event.at;
    if (c.approach !== null && event.at - c.approach.last > this.o.unansweredMs)
      this.closeApproach(event.scope, c, false);
    const topic = event.kind !== "sticker";
    if (c.approach !== null) c.approach = { last: event.at, topic: c.approach.topic || topic };
    else if (opens(c, event.at, this.o)) c.approach = { last: event.at, topic };
  }

  private reacted(event: EventOf<"reaction.received">): void {
    if (event.senderId === null || this.o.exclude.has(event.senderId)) return;
    const c = this.chatOf(event.scope);
    if (!c.herIds.has(event.messageId)) return;
    if (POSITIVE.has(event.emoji)) this.at(event.at, event.scope).reactors.add(event.senderId);
    if (NEGATIVE.has(event.emoji)) this.at(event.at, event.scope).negative.add(event.senderId);
  }

  /** 日志结束时还开着的私聊：窗口已过完的算没回，没过完的记为待定。 */
  private closeOpenChats(): void {
    for (const [scope, c] of this.chats) {
      if (c.open !== null) {
        if (this.end - c.open > this.o.unansweredMs) this.unanswered(scope, c);
        else this.at(c.open, scope).dmPending++;
      }
      if (c.approach !== null) {
        if (this.end - c.approach.last > this.o.unansweredMs) this.closeApproach(scope, c, false);
        else if (c.approach.topic) this.at(c.approach.last, scope).dmApproachPending++;
      }
    }
  }

  /** 不再出现的人：记在满 lapse 的那天，那天要在日志范围内。 */
  private countLapsed(): void {
    for (const person of this.people.values()) {
      if (person.days.size < this.o.activeDays) continue;
      const lapsedAt = person.lastAt + this.o.lapseMs;
      if (lapsedAt <= this.end) this.at(lapsedAt, person.scope).lapsed++;
    }
  }

  /** 回来的人：第 returnDays 天还没过完，这一天就是待定。 */
  private countReturns(): void {
    for (const [id, first] of this.firstContact) {
      const day = this.dayOf(first.at);
      const last = addDays(day, this.o.returnDays);
      const b = this.onDay(this.keyOf(first.at, first.scope));
      b.newPeople++;
      if (this.dayOf(this.end) <= last) b.returnPending = true;
      const back = (this.initiatedAt.get(id) ?? []).some(
        (t) => this.dayOf(t) > day && this.dayOf(t) <= last,
      );
      if (back) b.returned++;
    }
  }
}

/** 她发出的这条是哪次决定里的话：认出它引用回复了哪条，并从待发的话里拿掉。 */
function takeDecided(c: Chat, event: EventOf<"message.sent">): string | null {
  const k = event.kind === "text" ? c.deciding.findIndex((d) => d.text === event.text) : -1;
  if (k < 0) return null;
  const replyTo = nth(c.deciding, k).replyTo;
  c.deciding = c.deciding.filter((_, i) => i !== k);
  return replyTo;
}

function dayRow(key: string, b: Bucket): DayRow {
  return {
    ...dayAndArm(key),
    inbound: b.inbound,
    herMessages: b.herMessages,
    initiations: b.initiations,
    initiators: b.initiators.size,
    newPeople: b.newPeople,
    returned: b.returned,
    returnPending: b.returnPending,
    warmPeople: new Set([...b.reactors, ...b.repliers]).size,
    positiveReactors: b.reactors.size,
    repliers: b.repliers.size,
    refusedChats: b.refused.size,
    unreachableChats: b.unreachable.size,
    kickedChats: b.kicked.size,
    negativeReactors: b.negative.size,
    dmIgnored: b.dmIgnored.size,
    dmApproachPending: b.dmApproachPending,
    dmUnanswered: b.dmUnanswered,
    dmUnansweredPeople: b.dmUnansweredPeople.size,
    dmPending: b.dmPending,
    lapsedPeople: b.lapsed,
    groupTurns: b.uptakeHer.length,
    uptakePeople: mean(b.uptakeHer.map((u) => u.people)),
    uptakeTurns: mean(b.uptakeHer.map((u) => u.turns)),
    bandPeople: spread(b.uptakeBand.map((u) => u.people)),
    bandTurns: spread(b.uptakeBand.map((u) => u.turns)),
    herTurns: b.herTurns,
    crossChatPeople: b.crossChat.length,
    crossChatTop: b.crossChat.length >= MIN_CROSS_CHAT ? Math.max(...b.crossChat) : null,
    pausedCalls: b.pausedCalls,
  };
}

/**
 * 群里接她的话：她每一轮（窗口已过完）的人数和轮数；同一群当天发言条数前四分之一（向上取整）的真人，
 * 每人把自己各轮的数取平均。
 */
function readGroups(
  chats: ReadonlyMap<string, Chat>,
  windowMs: number,
  end: number,
  dayOf: (t: number) => string,
  keyOf: (t: number, scope: string) => string,
  onDay: (key: string) => Bucket,
): void {
  for (const [scope, c] of chats) {
    if (c.chatType !== "group") continue;
    const t = c.talk;
    const got = uptake(t, windowMs);
    const said = new Map<string, Map<string, number>>();
    for (const line of t.lines) {
      if (line.by === null || line.bot) continue;
      const day = dayOf(line.at);
      const counts = said.get(day) ?? new Map<string, number>();
      counts.set(line.by, (counts.get(line.by) ?? 0) + 1);
      said.set(day, counts);
    }
    const active = new Map<string, Set<string>>();
    for (const [day, counts] of said) {
      const ranked = [...counts].sort((a, b) => b[1] - a[1]).map(([id]) => id);
      active.set(day, new Set(ranked.slice(0, Math.ceil(ranked.length / 4))));
    }
    const members = new Map<string, { day: string; got: Uptake[] }>();
    t.turns.forEach((turn, k) => {
      if (turn.end + windowMs > end || nth(t.lines, turn.first).bot) return;
      const first = nth(t.lines, turn.first).at;
      const day = keyOf(first, scope);
      if (turn.by === null) {
        onDay(day).uptakeHer.push(nth(got, k));
        return;
      }
      if (!active.get(dayOf(first))?.has(turn.by)) return;
      const key = `${day}|${turn.by}`;
      const m = members.get(key) ?? { day, got: [] };
      m.got.push(nth(got, k));
      members.set(key, m);
    });
    for (const m of members.values()) {
      onDay(m.day).uptakeBand.push({
        people: mean(m.got.map((u) => u.people)) as number,
        turns: mean(m.got.map((u) => u.turns)) as number,
      });
    }
  }
}

/** 她一天的总轮数，和在她的两个以上会话里说过话的真人当天在这些会话里的轮数。 */
function readAttention(
  chats: ReadonlyMap<string, Chat>,
  keyOf: (t: number, scope: string) => string,
  onDay: (key: string) => Bucket,
): void {
  const { where, turnsOn } = countTurns(chats, keyOf);
  for (const [day, counts] of turnsOn) {
    const b = onDay(day);
    b.herTurns = counts.get(null) ?? 0;
    for (const [id, n] of counts)
      if (id !== null && (where.get(id)?.size ?? 0) >= 2) b.crossChat.push(n);
  }
}

/** 每个真人在哪些会话里说过话；每个桶里每个人（她是 null）说了几轮。机器人开头的轮不算。 */
function countTurns(
  chats: ReadonlyMap<string, Chat>,
  keyOf: (t: number, scope: string) => string,
): { where: Map<string, Set<string>>; turnsOn: Map<string, Map<string | null, number>> } {
  const where = new Map<string, Set<string>>();
  const turnsOn = new Map<string, Map<string | null, number>>();
  for (const [scope, c] of chats) {
    for (const turn of c.talk.turns) {
      const first = nth(c.talk.lines, turn.first);
      if (first.bot) continue;
      if (turn.by !== null) where.set(turn.by, (where.get(turn.by) ?? new Set()).add(scope));
      const day = keyOf(first.at, scope);
      const counts = turnsOn.get(day) ?? new Map<string | null, number>();
      counts.set(turn.by, (counts.get(turn.by) ?? 0) + 1);
      turnsOn.set(day, counts);
    }
  }
  return { where, turnsOn };
}

/** 桶的键：日期，--by-arm 时后面跟着组。 */
function dayAndArm(key: string): { day: string; arm?: string } {
  const [day, arm] = key.split("|") as [string, string | undefined];
  return arm === undefined ? { day } : { day, arm };
}

/**
 * 每组的平均（--by-arm 的最后一张表）：按天平均的读数，和按她群里的轮加权的"接她"。天与天之间外面热闹的程度差得很多
 * （2 月收到的条数天与天的变异系数 0.5–1.0），所以另给每百条收到她说了几轮（eval-artifacts/rotation/power.out）。
 */
export interface ArmSummary {
  arm: string;
  days: number;
  inbound: number;
  herTurns: number;
  /** 每收到 100 条，她说了几轮。 */
  herTurnsPerHundred: number | null;
  initiations: number;
  warmPeople: number;
  negativeReactors: number;
  dmIgnored: number;
  groupTurns: number;
  uptakePeople: number | null;
  uptakeTurns: number | null;
}

export function armSummary(rows: readonly DayRow[]): ArmSummary[] {
  const groups = new Map<string, DayRow[]>();
  for (const r of rows) {
    const arm = r.arm ?? UNASSIGNED;
    groups.set(arm, [...(groups.get(arm) ?? []), r]);
  }
  const perDay = (rs: DayRow[], f: (r: DayRow) => number) =>
    round2(rs.reduce((a, r) => a + f(r), 0) / rs.length);
  /** 两个合计之比。 */
  const per = (rs: DayRow[], top: (r: DayRow) => number, bottom: (r: DayRow) => number) => {
    const n = rs.reduce((a, r) => a + bottom(r), 0);
    return n === 0 ? null : round2(rs.reduce((a, r) => a + top(r), 0) / n);
  };
  const weighted = (rs: DayRow[], f: (r: DayRow) => number | null) =>
    per(
      rs,
      (r) => (f(r) ?? 0) * r.groupTurns,
      (r) => r.groupTurns,
    );
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([arm, rs]) => ({
      arm,
      days: rs.length,
      inbound: perDay(rs, (r) => r.inbound),
      herTurns: perDay(rs, (r) => r.herTurns),
      herTurnsPerHundred: per(
        rs,
        (r) => r.herTurns,
        (r) => r.inbound / 100,
      ),
      initiations: perDay(rs, (r) => r.initiations),
      warmPeople: perDay(rs, (r) => r.warmPeople),
      negativeReactors: perDay(rs, (r) => r.negativeReactors),
      dmIgnored: rs.reduce((a, r) => a + r.dmIgnored, 0),
      groupTurns: rs.reduce((a, r) => a + r.groupTurns, 0),
      uptakePeople: weighted(rs, (r) => r.uptakePeople),
      uptakeTurns: weighted(rs, (r) => r.uptakeTurns),
    }));
}

const addDays = (day: string, n: number) =>
  new Date(Date.parse(day) + n * D).toISOString().slice(0, 10);

const round2 = (x: number) => Math.round(x * 100) / 100;

function mean(xs: readonly number[]): number | null {
  return xs.length === 0 ? null : round2(xs.reduce((a, b) => a + b, 0) / xs.length);
}

function spread(xs: readonly number[]): Spread | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => round2(nth(s, Math.min(s.length - 1, Math.floor(p * s.length))));
  return { p25: q(0.25), p75: q(0.75) };
}

/** 别人先开口（调用前已排除"回她的话"）。 */
function initiates(event: MessageReceived, c: Chat, o: NorthstarOptions): boolean {
  if (event.chatType === "private") {
    if (c.lastAt === null) return true;
    const quiet = event.at - c.lastAt;
    if (quiet < o.gapMs) return false;
    // 安静之前最后一句是她的、还在等回音的窗口里：是晚到的回复（已在调用前算进回复）。
    return !c.lastWasHers || quiet > o.unansweredMs;
  }
  if (!event.directed) return false;
  const herQuiet = c.herLastAt === null || event.at - c.herLastAt >= o.gapMs;
  const last = c.directedAt.get(event.senderId);
  const theirQuiet = last === undefined || event.at - last >= o.gapMs;
  return herQuiet && theirQuiet;
}

/** 私聊里她先开口：和 initiates 对称，安静了至少 gap，而且不是在晚回对方窗口内的话。 */
function opens(c: Chat, at: number, o: NorthstarOptions): boolean {
  if (c.lastAt === null) return true;
  const quiet = at - c.lastAt;
  return quiet >= o.gapMs && (c.lastWasHers || quiet > o.unansweredMs);
}

function candidate(event: MessageReceived, c: Chat): StopCandidate {
  return {
    at: event.at,
    scope: event.scope,
    chatType: event.chatType,
    senderId: event.senderId,
    her: c.herLines,
    message: event.text,
    question: STOP_QUESTION,
  };
}

function readJournal(path: string): AliceEvent[] {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare("SELECT type, scope, payload FROM journal_events ORDER BY id")
      .iterate() as Iterable<{ type: string; scope: string; payload: string }>;
    const events: AliceEvent[] = [];
    for (const row of rows) {
      const event = decodeEvent(row.type, row.scope, JSON.parse(row.payload));
      if (event) events.push(event);
    }
    return events;
  } finally {
    db.close();
  }
}

const num = (x: number | null) => (x === null ? "—" : String(x));
const range = (s: Spread | null) => (s === null ? "—" : `${s.p25}–${s.p75}`);

const armName = (arm: string | undefined) =>
  arm === "production" ? "生产" : arm === UNASSIGNED || arm === undefined ? "没分组" : arm;

type Column = [string, (r: DayRow) => string | number];

/** 每组的平均（--by-arm）。 */
const SUMMARY: Array<[string, (a: ArmSummary) => string | number]> = [
  ["组", (a) => armName(a.arm)],
  ["天数", (a) => a.days],
  ["收到/天", (a) => a.inbound],
  ["她的总轮数/天", (a) => a.herTurns],
  ["她的轮/百条收到", (a) => num(a.herTurnsPerHundred)],
  ["主动找她/天", (a) => a.initiations],
  ["温暖人数/天", (a) => a.warmPeople],
  ["负面表情/天", (a) => a.negativeReactors],
  ["私聊连着不回", (a) => a.dmIgnored],
  ["她群里的轮", (a) => a.groupTurns],
  ["接她 人/轮", (a) => num(a.uptakePeople)],
  ["接她 轮/轮", (a) => num(a.uptakeTurns)],
];

/** 两张表：找她与嫌弃；群里与精力。 */
const TABLES: Column[][] = [
  [
    ["日期", (r) => r.day],
    ["收到", (r) => r.inbound],
    ["她发", (r) => r.herMessages],
    ["主动找她", (r) => r.initiations],
    ["人", (r) => r.initiators],
    ["回来/新来往", (r) => `${r.returned}/${r.newPeople}${r.returnPending ? " 待定" : ""}`],
    ["温暖人数", (r) => r.warmPeople],
    ["正面表情", (r) => r.positiveReactors],
    ["回复她", (r) => r.repliers],
    ["拉黑", (r) => r.refusedChats],
    ["发不出", (r) => r.unreachableChats],
    ["被踢", (r) => r.kickedChats],
    ["负面表情", (r) => r.negativeReactors],
    ["私聊连着不回", (r) => r.dmIgnored],
    ["待定", (r) => r.dmApproachPending],
    ["私聊没回(旧)", (r) => r.dmUnanswered],
    ["人", (r) => r.dmUnansweredPeople],
    ["待定(旧)", (r) => r.dmPending],
    ["不再出现", (r) => r.lapsedPeople],
    ["暂停", (r) => r.pausedCalls],
  ],
  [
    ["日期", (r) => r.day],
    ["她群里的轮", (r) => r.groupTurns],
    ["接她 人/轮", (r) => num(r.uptakePeople)],
    ["活跃真人 人/轮", (r) => range(r.bandPeople)],
    ["接她 轮/轮", (r) => num(r.uptakeTurns)],
    ["活跃真人 轮/轮", (r) => range(r.bandTurns)],
    ["她的总轮数", (r) => r.herTurns],
    ["跨会话真人", (r) => r.crossChatPeople],
    ["其中最多的轮数", (r) => num(r.crossChatTop)],
  ],
];

function main(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      "by-arm": { type: "boolean" },
      gap: { type: "string" },
      unanswered: { type: "string" },
      exclude: { type: "string" },
      "stop-candidates": { type: "string" },
    },
  });
  const path = positionals[0];
  if (!path) {
    console.error(
      "usage: pnpm northstar <journal.db> [--json] [--by-arm] [--gap 60] [--unanswered 12] [--exclude id,id] [--stop-candidates out.jsonl]",
    );
    process.exit(2);
  }
  const number = (v: string | undefined, fallback: number) =>
    v === undefined ? fallback : Number(v);
  const byArm = values["by-arm"] === true;
  const report = northstar(readJournal(path), {
    byArm,
    gapMs: number(values.gap, 60) * MIN,
    unansweredMs: number(values.unanswered, 12) * H,
    exclude: new Set((values.exclude ?? "").split(",").filter(Boolean)),
  });
  const out = values["stop-candidates"];
  if (out) {
    writeFileSync(out, `${report.stopCandidates.map((c) => JSON.stringify(c)).join("\n")}\n`);
    console.error(`${report.stopCandidates.length} stop candidates → ${out}`);
  }
  if (values.json === true) {
    const out = byArm ? { days: report.days, arms: armSummary(report.days) } : report.days;
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  for (const [i, table] of TABLES.entries()) {
    if (i > 0) console.log("");
    const [date, ...rest] = table as [Column, ...Column[]];
    const cells: Column[] = byArm ? [date, ["组", (r) => armName(r.arm)], ...rest] : table;
    console.log(cells.map(([label]) => label).join("\t"));
    for (const row of report.days) console.log(cells.map(([, cell]) => cell(row)).join("\t"));
  }
  if (!byArm) return;
  console.log("");
  console.log(SUMMARY.map(([label]) => label).join("\t"));
  for (const a of armSummary(report.days)) {
    console.log(SUMMARY.map(([, cell]) => cell(a)).join("\t"));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
