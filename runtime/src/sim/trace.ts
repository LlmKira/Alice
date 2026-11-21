/**
 * 事后分析她的微观行为：她那一刻为什么被叫醒、醒了做了什么。
 *
 * 为什么读得出当时的理由：Journal 是唯一事实，step() 是纯函数；时钟格只在叫醒了什么时写进日志，没写的格不改状态
 * （它们结算的东西按窗口终点计时，下一个事件补上），所以按日志顺序重放 step() 得到的就是她每一刻的状态。
 * 唤醒的理由由压力场自己的 willWake 给（mechanisms/pressure/index.ts：唤醒分数只从它算），这里用同一个工厂
 * 在同一份状态上再问一遍，读到的就是当时的理由；读数（各驱动、各项代价）调的是意愿层自己的函数（explain.ts）。
 * 重放出的调用 id 和日志里的结果逐个对上，对不上的数写进输出头：那是代码版本不同、重放走岔了的地方。
 *
 * 用法：pnpm trace <journal.db> [--from <ISO 时刻或毫秒>] [--scope <会话>] [--out <目录>] [--summary] [--glance]
 *                              [--top 3] [--every <分钟>] [--runs <runs.jsonl>]
 *   每次发言调用一行 JSONL：时刻、会话、触发方式（directed 被点名、floor 还在对话里、will 节律到点排第一、
 *   alarm 她定的钟点到了、patience 等对方说完、again 想的时候又被叫、result 看了结果），叫醒她的那个意愿，
 *   此刻排前几名的候选（会话 × 动作、NSV、各驱动的原值与归一化值与缓解、社交代价、饱和代价、困意与生活占用、
 *   在不在场），心情效价与精力，以及这一轮做了什么（只取动作种类，不取文字）。被点名却没醒的消息记 declined；
 *   引起了想一想、没叫醒会话的时钟格记 tick；--every 在事件之间按间隔取样（probe，只读状态，不送进 step）。
 *   看了一眼（不调模型）记 glance：排第一的那个，和日志里那一眼前后这个会话的未读条数与 attention τ̂。
 *   --glance：用候选 glance（生产 + 看一眼）重放，读日志里原来的唤醒有多少变成看一眼。
 *   --summary：按会话、会话类别、触发方式、驱动汇总唤醒原因的分布。
 *   --out：写 trace.jsonl（第一行是输出头）和 summary.json；不给就写到标准输出。
 * 只读打开 Journal（SQLite 只读模式，等同 mode=ro；再加 query_only），绝不写库。代码版本读 Journal 旁边的
 * runs.jsonl：当前代码的 sha 和写日志时的不一致时照样跑，在输出头和标准错误里写明。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { decodeEvent } from "../journal.js";
import type { DriveKey } from "../mechanisms/pressure/drives.js";
import {
  type Candidate,
  candidateOf,
  lensOf,
  productionWorld,
  readWill,
  type WillLens,
  type WillReadout,
} from "../mechanisms/pressure/explain.js";
import { glance, PRODUCTION, type WakeReason, wakeScore } from "../mechanisms/pressure/index.js";
import { readChat } from "../mechanisms/pressure/will.js";
import type { World } from "../mechanisms/pressure/world.js";
import { productionMechanisms } from "../mechanisms/registry.js";
import { affordanceOf, isSilent } from "../mind/affordances.js";
import type { AliceEvent, ChatType } from "../mind/events.js";
import type { Mechanism } from "../mind/mechanism.js";
import { WAKE_THRESHOLD } from "../mind/mechanism.js";
import { type AliceState, emptyState } from "../mind/state.js";
import { step, towardHer } from "../mind/step.js";
import { type CodeVersion, codeVersion } from "../runs.js";

/** 压力场自己的理由，或 step() 的转移（等完了、想完了又被叫、看了结果）。 */
export type Trigger = WakeReason["kind"] | "patience" | "again" | "result" | "other";

export type Outcome =
  | { result: "spoke" | "silent" | "acted"; acts: string[]; afterMs: number }
  | { result: "failed"; reason: string; afterMs: number };

export interface WakeLine {
  kind: "wake";
  at: number;
  time: string;
  scope: string;
  chatType: ChatType;
  trigger: Trigger;
  /** patience、again：开始等（或想的时候被叫）的那一刻是什么叫醒了她。 */
  cause?: Trigger;
  callId: string;
  /** 叫醒她的那个意愿（压力场的理由里带的；看了结果、闹钟没有）。 */
  woke: Candidate | null;
  /** 唤醒分数（被点名、还在对话里时是 logistic(NSV/τ)，到 0.5 才醒）。 */
  score?: number;
  will: WillReadout;
  /** 这一轮做了什么；重放结束时还没有结果的是 null。 */
  outcome: Outcome | null;
  /** TraceOptions.alt 在同一刻给的理由（glance：换成它就只看一眼）；没有 alt 时不写。 */
  alt?: Trigger;
  sha: string | null;
}

/** 被点名了，最好的意愿 NSV ≤ 0：没有醒。 */
export interface DeclinedLine {
  kind: "declined";
  at: number;
  time: string;
  scope: string;
  chatType: ChatType;
  trigger: "directed";
  woke: Candidate | null;
  score: number;
  will: WillReadout;
  sha: string | null;
}

/** 写进日志、却没叫醒任何会话的时钟格（请求了想一想），或 --every 的取样。 */
export interface TickLine {
  kind: "tick" | "probe";
  at: number;
  time: string;
  scope: string | null;
  ponder?: string;
  will: WillReadout;
  sha: string | null;
}

/**
 * 看了一眼（候选 glance）：节律到点、排第一的是看一眼，没有调用模型。relieved 是这个会话未读的条数和 attention 的
 * τ̂ 在看之前、之后，日志里有这一眼（chat.glanced）时才有；当前代码会看、日志里那一刻却是别的（旧代码写的日志）时为 null。
 */
export interface GlanceLine {
  kind: "glance";
  at: number;
  time: string;
  scope: string;
  chatType: ChatType;
  /** 排第一的那个（看一眼）；日志里有、当前代码在那一格不会看时为 null。 */
  woke: Candidate | null;
  relieved: { unread: number; before: number; after: number } | null;
  sha: string | null;
}

export type TraceLine = WakeLine | DeclinedLine | TickLine | GlanceLine;

export interface RunRecord {
  at: number;
  sha: string;
  dirty: boolean | null;
  mechanisms?: string[];
}

export interface TraceOptions {
  from?: number;
  scope?: string;
  top: number;
  everyMs?: number;
  runs: readonly RunRecord[];
  mechanisms?: readonly Mechanism[];
  lens?: WillLens;
  /** 另一种组成：每次叫醒处在同一份状态上再问它一遍（WakeLine.alt），读"换成它这一刻会怎样"。 */
  alt?: WillLens;
}

/** 重放和日志对得上多少：重放出的调用 id 与日志里写了结果的调用 id。 */
export interface Fidelity {
  replayedCalls: number;
  journalOutcomes: number;
  /** 日志里有结果、重放里没有发起的调用（重放走岔了）。 */
  unmatched: number;
  /** 重放里发起、日志里没有结果的调用（还在等，或进程停下时在途）。 */
  unanswered: number;
}

const iso = (at: number) => new Date(at).toISOString();

/** 只读打开 Journal，按写入顺序读回事件；读不懂的行（旧运行时写的）计入 skipped。 */
export function readJournal(path: string): { events: AliceEvent[]; skipped: number } {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    const rows = db
      .prepare("SELECT type, scope, payload FROM journal_events ORDER BY id")
      .iterate() as Iterable<{ type: string; scope: string; payload: string }>;
    const events: AliceEvent[] = [];
    let skipped = 0;
    for (const row of rows) {
      const event = decodeEvent(row.type, row.scope, JSON.parse(row.payload));
      if (event) events.push(event);
      else skipped++;
    }
    return { events, skipped };
  } finally {
    db.close();
  }
}

export function readRuns(path: string): RunRecord[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RunRecord)
    .sort((a, b) => a.at - b.at);
}

/** 事件那一刻在跑的是哪一版代码：此前最后一次启动。 */
function shaAt(runs: readonly RunRecord[], at: number): string | null {
  let sha: string | null = null;
  for (const r of runs) if (r.at <= at) sha = r.sha;
  return sha;
}

function outcomeOf(event: AliceEvent, calledAt: number): Outcome | null {
  if (event.type === "speech.failed") {
    return { result: "failed", reason: event.reason, afterMs: event.at - calledAt };
  }
  if (event.type !== "speech.decided") return null;
  const acts = event.decision.acts;
  const result = isSilent(acts)
    ? "silent"
    : acts.some((a) => affordanceOf(a.kind).posts)
      ? "spoke"
      : "acted";
  return { result, acts: acts.map((a) => a.kind), afterMs: event.at - calledAt };
}

/** 叫醒她的理由，在理由出现的那一刻读出（等完了、想完了才发起的调用归给它）。 */
interface Cause {
  trigger: Trigger;
  woke: Candidate | null;
  score?: number;
  /** TraceOptions.alt 同一刻的理由。 */
  alt?: Trigger;
}

/**
 * 按日志顺序重放 step()（丢弃副作用，和外壳启动时折叠的是同一条路），在每次发言调用处问压力场为什么醒，
 * 并读出那一刻的意愿层。
 */
export function trace(
  events: readonly AliceEvent[],
  o: TraceOptions,
): { lines: TraceLine[]; fidelity: Fidelity } {
  const mechanisms = o.mechanisms ?? productionMechanisms(true);
  const lens = o.lens ?? lensOf();
  const lines: TraceLine[] = [];
  const open = new Map<string, WakeLine>();
  const calls = new Set<string>();
  let outcomes = 0;
  let unmatched = 0;
  /** 开始等对方说完、或想的时候被叫的那一刻的理由（等完了、想完了才发起调用）。 */
  const pending = new Map<string, Cause>();
  /** 时钟格上当前代码要看一眼的会话：日志里紧接着的 chat.glanced 把消耗填进去。 */
  const glancing = new Map<string, GlanceLine>();
  let state: AliceState = emptyState;
  let probe = o.everyMs && events[0] ? Math.ceil(events[0].at / o.everyMs) * o.everyMs : Infinity;

  const read = (s: AliceState, at: number) => readWill(productionWorld(s), at, lens, o.top);
  /** 压力场的理由，拆成候选（唤醒分数不够时 trigger 记 other：那就不是压力场叫醒的）。 */
  const causeOf = (reason: WakeReason | null, world: World, at: number): Cause => {
    if (!reason) return { trigger: "other", woke: null };
    const woke =
      reason.kind !== "alarm" && reason.intention
        ? candidateOf(world, reason.intention, at, lens)
        : null;
    const trigger =
      reason.kind === "glance" || wakeScore(reason) >= WAKE_THRESHOLD ? reason.kind : "other";
    return reason.kind === "directed" || reason.kind === "floor" || reason.kind === "follow"
      ? { trigger, woke, score: reason.score }
      : { trigger, woke };
  };

  for (const logged of events) {
    // 和 step 看到的是同一个事件（回复她的那条算被找）。
    const event = towardHer(state, logged);
    while (o.everyMs && probe < event.at) {
      lines.push({
        kind: "probe",
        at: probe,
        time: iso(probe),
        scope: null,
        will: read(state, probe),
        sha: shaAt(o.runs, probe),
      });
      probe += o.everyMs;
    }
    const before = state;
    const result = step(state, event, mechanisms);
    state = result.state;
    const at = event.at;
    const world = productionWorld(state);
    // 压力场在 step 里用的就是折叠了这个事件之后的世界（foldMechanisms 在 wake 之前）。
    const why = (scope: string): Cause => {
      const cause = causeOf(lens.why(scope, event, at, world), world, at);
      if (!o.alt) return cause;
      const r = o.alt.why(scope, event, at, world);
      const alt: Trigger =
        r && (r.kind === "glance" || wakeScore(r) >= WAKE_THRESHOLD) ? r.kind : "other";
      return { ...cause, alt };
    };

    if (event.type === "speech.decided" || event.type === "speech.failed") {
      outcomes++;
      const line = open.get(event.callId);
      if (!calls.has(event.callId)) unmatched++;
      if (line) {
        line.outcome = outcomeOf(event, line.at);
        open.delete(event.callId);
      }
    }

    // 开始等对方说完（step 挂上计时器），或还在想的时候被叫醒（step 只记一笔 wakeAgain）：记下是什么叫醒的，
    // 等完了、想完了那一轮的调用归给它。
    const was = "scope" in event ? before.chats[event.scope]?.mind : undefined;
    const now = "scope" in event ? state.chats[event.scope]?.mind : undefined;
    const calledAgain =
      was?.mode === "deciding" && now?.mode === "deciding" && now.wakeAgain && !was.wakeAgain;
    if ((event.type === "act.done" || event.type === "act.failed") && calledAgain) {
      pending.set(event.scope, { trigger: "result", woke: null });
    }
    if (event.type === "message.received") {
      const cause = why(event.scope);
      if (calledAgain || (was?.mode !== "waiting" && now?.mode === "waiting")) {
        pending.set(event.scope, cause);
      }
      // 被点名、没有醒（也不是正在等或正在想）：她这时为什么没理。
      if (event.directed && cause.trigger === "other" && now?.mode === "idle") {
        lines.push({
          kind: "declined",
          at,
          time: iso(at),
          scope: event.scope,
          chatType: event.chatType,
          trigger: "directed",
          woke: cause.woke,
          score: cause.score ?? 0,
          will: read(state, at),
          sha: shaAt(o.runs, at),
        });
      }
    }
    for (const effect of result.effects) {
      if (effect.type !== "glance") continue;
      const reason = lens.why(effect.scope, event, at, world);
      const line: GlanceLine = {
        kind: "glance",
        at,
        time: iso(at),
        scope: effect.scope,
        chatType: state.chats[effect.scope]?.chatType ?? "group",
        woke: reason?.kind === "glance" ? candidateOf(world, reason.intention, at, lens) : null,
        relieved: null,
        sha: shaAt(o.runs, at),
      };
      glancing.set(effect.scope, line);
      lines.push(line);
    }
    if (event.type === "chat.glanced") {
      const attention = (w: World) =>
        readChat(w, event.scope, at, lens.policy.tiers, lens.policy.age, lens.policy.drives)
          ?.normalized.attention ?? 0;
      const was = productionWorld(before);
      let line = glancing.get(event.scope);
      glancing.delete(event.scope);
      if (!line) {
        line = {
          kind: "glance",
          at,
          time: iso(at),
          scope: event.scope,
          chatType: state.chats[event.scope]?.chatType ?? "group",
          woke: null,
          relieved: null,
          sha: shaAt(o.runs, at),
        };
        lines.push(line);
      }
      line.relieved = {
        unread: was.chats[event.scope]?.unread ?? 0,
        before: attention(was),
        after: attention(world),
      };
    }
    const speech = result.effects.filter((e) => e.type === "call-speech");
    for (const effect of speech) {
      const scope = effect.scope;
      // 消息和时钟格当场叫醒：压力场此刻的理由。等完了、想完了才发起的：开始等（被叫）那一刻的理由。
      let cause: Cause;
      let trigger: Trigger;
      let after: Cause | undefined;
      switch (event.type) {
        case "message.received":
        case "clock.tick":
          cause = why(scope);
          trigger = cause.trigger;
          break;
        case "timer.fired":
        case "speech.decided":
          after = pending.get(scope);
          pending.delete(scope);
          cause = after ?? { trigger: "other", woke: null };
          trigger = event.type === "timer.fired" ? "patience" : "again";
          break;
        case "act.done":
        case "act.failed":
          cause = { trigger: "result", woke: null };
          trigger = "result";
          break;
        default:
          cause = { trigger: "other", woke: null };
          trigger = "other";
      }
      const chat = state.chats[scope];
      const line: WakeLine = {
        kind: "wake",
        at,
        time: iso(at),
        scope,
        chatType: chat?.chatType ?? effect.request.chatType,
        trigger,
        ...(after ? { cause: after.trigger } : {}),
        callId: effect.callId,
        woke: cause.woke,
        ...(cause.score !== undefined ? { score: cause.score } : {}),
        will: read(state, at),
        outcome: null,
        ...(cause.alt ? { alt: cause.alt } : {}),
        sha: shaAt(o.runs, at),
      };
      calls.add(effect.callId);
      open.set(effect.callId, line);
      lines.push(line);
    }
    // 想完了、没有再起一轮（决定离开时不再起）：想的时候记下的理由作废。
    if (
      (event.type === "speech.decided" || event.type === "speech.failed") &&
      state.chats[event.scope]?.mind.mode === "idle"
    ) {
      pending.delete(event.scope);
    }
    if (event.type === "clock.tick" && speech.length === 0) {
      const ponder = result.effects.find((e) => e.type === "call-ponder");
      lines.push({
        kind: "tick",
        at,
        time: iso(at),
        scope: null,
        ...(ponder?.type === "call-ponder" ? { ponder: ponder.request.kind } : {}),
        will: read(state, at),
        sha: shaAt(o.runs, at),
      });
    }
  }

  const kept = lines.filter(
    (l) =>
      (o.from === undefined || l.at >= o.from) && (o.scope === undefined || l.scope === o.scope),
  );
  return {
    lines: kept,
    fidelity: {
      replayedCalls: calls.size,
      journalOutcomes: outcomes,
      unmatched,
      unanswered: open.size,
    },
  };
}

/** 叫醒她的那个意愿里缓解最大的驱动；没有意愿（看了结果、闹钟）或什么都不缓解时为 none。 */
export function dominantDrive(c: Candidate | null): DriveKey | "none" {
  if (!c) return "none";
  let best: DriveKey | "none" = "none";
  let value = 0;
  for (const [k, d] of Object.entries(c.drives) as Array<[DriveKey, { relief: number }]>) {
    if (d.relief > value) {
      best = k;
      value = d.relief;
    }
  }
  return best;
}

type Counts = Record<string, number>;

export interface Tally {
  wakes: number;
  declined: number;
  /** 看了一眼（不调模型）的次数，和日志里那几眼消耗掉的 attention τ̂ 合计。 */
  glances: number;
  relieved: number;
  byTrigger: Counts;
  byDrive: Counts;
  /** 有 alt 时：触发方式 → alt 同一刻的理由（will→glance：换成它这次只看一眼）。 */
  byAlt: Counts;
  outcomes: Counts;
}

export interface Summary extends Tally {
  byChatType: Record<string, Tally>;
  byScope: Array<Tally & { scope: string; chatType: string }>;
}

const emptyTally = (): Tally => ({
  wakes: 0,
  declined: 0,
  glances: 0,
  relieved: 0,
  byTrigger: {},
  byDrive: {},
  byAlt: {},
  outcomes: {},
});
const bump = (c: Counts, k: string) => {
  c[k] = (c[k] ?? 0) + 1;
};

/** 按会话、会话类别汇总唤醒原因（触发方式、驱动）和这一轮的结果。 */
export function summarize(lines: readonly TraceLine[]): Summary {
  const all = emptyTally();
  const byType: Record<string, Tally> = {};
  const byScope = new Map<string, Tally & { scope: string; chatType: string }>();
  for (const l of lines) {
    if (l.kind !== "wake" && l.kind !== "declined" && l.kind !== "glance") continue;
    const type = byType[l.chatType] ?? emptyTally();
    byType[l.chatType] = type;
    const scope = byScope.get(l.scope) ?? { scope: l.scope, chatType: l.chatType, ...emptyTally() };
    byScope.set(l.scope, scope);
    for (const t of [all, type, scope]) {
      if (l.kind === "declined") {
        t.declined++;
        continue;
      }
      if (l.kind === "glance") {
        t.glances++;
        t.relieved += l.relieved ? l.relieved.before - l.relieved.after : 0;
        continue;
      }
      t.wakes++;
      bump(t.byTrigger, l.cause ? `${l.trigger}<${l.cause}` : l.trigger);
      bump(t.byDrive, dominantDrive(l.woke));
      if (l.alt) bump(t.byAlt, `${l.cause ?? l.trigger}→${l.alt}`);
      bump(t.outcomes, l.outcome?.result ?? "pending");
    }
  }
  return {
    ...all,
    byChatType: byType,
    byScope: [...byScope.values()].sort((a, b) => b.wakes - a.wakes),
  };
}

/** 版本：当前代码与写日志时的代码（日志时间范围里在跑的那几次启动）。 */
export function versionHeader(
  code: CodeVersion,
  runs: readonly RunRecord[],
  events: readonly AliceEvent[],
  mechanisms: readonly string[],
): { code: CodeVersion; journal: RunRecord[]; match: boolean; notes: string[] } {
  const first = events[0]?.at ?? 0;
  const last = events.at(-1)?.at ?? 0;
  const journal = runs.filter((r, i) => {
    const next = runs[i + 1]?.at ?? Infinity;
    return r.at <= last && next > first;
  });
  const notes: string[] = [];
  if (journal.length === 0) notes.push("没有 runs.jsonl 记录：不知道日志是哪一版代码写的");
  const early = events.filter((e) => e.at < (runs[0]?.at ?? Infinity)).length;
  if (journal.length > 0 && early > 0) {
    notes.push(`日志开头 ${early} 个事件早于 runs.jsonl 的第一条记录：那段不知道是哪一版代码`);
  }
  const shas = [...new Set(journal.map((r) => r.sha))];
  if (shas.some((s) => s !== code.sha)) {
    notes.push(
      `日志由 ${shas.map((s) => s.slice(0, 8)).join("、")} 写下，当前代码是 ${code.sha.slice(0, 8)}`,
    );
  }
  if (code.dirty) notes.push("当前代码有未提交的改动");
  if (journal.some((r) => r.dirty)) notes.push("写日志时的代码有未提交的改动");
  const names = mechanisms.join(",");
  if (journal.some((r) => r.mechanisms && r.mechanisms.join(",") !== names)) {
    notes.push("写日志时的机制列表和当前生产列表不同");
  }
  return { code, journal, match: notes.length === 0, notes };
}

/** 输出时的数：非整数留 4 位小数（时刻、计数是整数，原样）。 */
function rounded(_key: string, value: unknown): unknown {
  return typeof value === "number" && !Number.isInteger(value) && Number.isFinite(value)
    ? Math.round(value * 1e4) / 1e4
    : value;
}

export const toJsonl = (rows: readonly unknown[]) =>
  rows.map((r) => JSON.stringify(r, rounded)).join("\n");

const pct = (n: number, d: number) => (d > 0 ? `${((100 * n) / d).toFixed(0)}%` : "-");

function table(title: string, counts: Counts, total: number): string[] {
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return [
    title,
    ...rows.map(([k, n]) => `  ${k.padEnd(22)} ${String(n).padStart(5)}  ${pct(n, total)}`),
  ];
}

export function summaryText(s: Summary): string {
  const out = [`唤醒 ${s.wakes} 次；被点名没醒 ${s.declined} 次`];
  if (s.glances > 0) {
    out.push(`看了一眼（不调模型）${s.glances} 次，消耗的未读拉力 τ̂ 合计 ${s.relieved.toFixed(2)}`);
  }
  out.push(
    ...table("触发方式（patience<directed：等对方说完，开始等时是被点名）", s.byTrigger, s.wakes),
  );
  out.push(...table("驱动（叫醒她的那个意愿里缓解最大的一项）", s.byDrive, s.wakes));
  out.push(...table("这一轮做了什么", s.outcomes, s.wakes));
  if (Object.keys(s.byAlt).length > 0) {
    out.push(...table("换成候选，同一刻（原来的理由→候选的理由）", s.byAlt, s.wakes));
  }
  for (const [type, t] of Object.entries(s.byChatType)) {
    out.push(`[${type}] 唤醒 ${t.wakes}，没醒 ${t.declined}，看一眼 ${t.glances}`);
    out.push(...table("  触发", t.byTrigger, t.wakes));
    out.push(...table("  驱动", t.byDrive, t.wakes));
    out.push(...table("  结果", t.outcomes, t.wakes));
  }
  out.push("按会话：");
  for (const t of s.byScope) {
    const drives = Object.entries(t.byDrive)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ${n}`)
      .join("，");
    out.push(
      `  ${t.scope} (${t.chatType}) 唤醒 ${t.wakes} 没醒 ${t.declined} 看一眼 ${t.glances}：${drives}`,
    );
  }
  return out.join("\n");
}

function parseTime(v: string): number {
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new Error(`bad time: ${v}`);
  return t;
}

const FLAGS = new Set(["--from", "--scope", "--out", "--top", "--every", "--runs"]);

function main(argv: string[]): void {
  const path = argv.find((a, i) => !a.startsWith("--") && !FLAGS.has(argv[i - 1] ?? ""));
  if (!path) {
    console.error(
      "usage: pnpm trace <journal.db> [--from <time>] [--scope <scope>] [--out <dir>] [--summary] [--top 3] [--every <min>] [--runs <runs.jsonl>]",
    );
    process.exit(2);
  }
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  for (const a of argv) {
    if (a.startsWith("--") && !FLAGS.has(a) && a !== "--summary" && a !== "--glance")
      throw new Error(`unknown flag ${a}`);
  }
  const from = flag("--from");
  const every = flag("--every");
  const runs = readRuns(flag("--runs") ?? join(dirname(path), "runs.jsonl"));
  const { events, skipped } = readJournal(path);
  const mechanisms = productionMechanisms(true);
  // --glance：照日志用生产重放，在每次叫醒处另问候选 glance 同一刻会怎样（eval-artifacts/glance/prereg.md）。
  // 不用候选重放：第一次看一眼之后调用编号就和日志对不上，后面的决定全丢，重放读不出东西。
  const alt = argv.includes("--glance") ? lensOf({ ...PRODUCTION, glance: glance() }) : undefined;
  const version = versionHeader(
    codeVersion(),
    runs,
    events,
    mechanisms.map((m) => m.name),
  );
  for (const note of version.notes) console.error(`trace: ${note}`);
  const { lines, fidelity } = trace(events, {
    ...(from ? { from: parseTime(from) } : {}),
    ...(flag("--scope") ? { scope: flag("--scope") as string } : {}),
    ...(every ? { everyMs: Number(every) * 60_000 } : {}),
    top: Number(flag("--top") ?? 3),
    runs,
    mechanisms,
    ...(alt ? { alt } : {}),
  });
  if (fidelity.unmatched > 0) {
    console.error(
      `trace: 日志里 ${fidelity.unmatched} 次调用的结果在重放里没有对应的调用（重放和当时走岔了）`,
    );
  }
  const header = {
    kind: "header",
    db: path,
    events: events.length,
    skipped,
    span: events.length ? [iso(events[0]?.at ?? 0), iso(events.at(-1)?.at ?? 0)] : null,
    version,
    fidelity,
  };
  const summary = summarize(lines);
  const out = flag("--out");
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "trace.jsonl"), `${toJsonl([header, ...lines])}\n`);
    writeFileSync(
      join(out, "summary.json"),
      `${JSON.stringify({ header, summary }, rounded, 2)}\n`,
    );
    console.error(`trace: ${lines.length} 行 → ${join(out, "trace.jsonl")}`);
  }
  if (argv.includes("--summary")) {
    console.log(summaryText(summary));
    console.log(`重放对照：${JSON.stringify(fidelity)}`);
  } else if (!out) console.log(toJsonl([header, ...lines]));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
