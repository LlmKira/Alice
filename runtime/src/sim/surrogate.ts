/**
 * 她的发言替身（不调 LLM）：从提示词日志里她当时的真实输出，按提示词里的结构化事实分组，数出每一类处境下
 * 她这一轮做了什么，回放时按同样的分组抽一个决定。用来在零成本闭环里检查机制（census.ts），不是用来写她说的话。
 *
 * - 条件（features）只从渲染好的提示词里读：群还是私聊、有没有人找她（有没有"这会儿没人点你/找你"）、
 *   是不是被一条消息叫醒（"[编号] 之后"）、最近 15 行里有没有四个以上别人在说、记录最后连着几条是她的、
 *   离最后一条多久、她的状态（刚睡醒、累）、
 *   要不要换语言、是不是夜里、这轮能不能去睡（go_to_bed）。拟合和回放用同一个解析，所以两边的定义一样。
 * - 输出：开不开口；开口时发几条文字、带不带贴纸、第一条引不引用；点不点表情；有没有内心独白、记下心情；
 *   夜里能睡时去不去睡。其余动作（查一下、翻相册、复读……）不到 1%，不出。
 * - 估计：按分组的经验频率，往上一级分组收缩（m 估计，m = SMOOTH）；分组次序就是 FEATURES 的次序，
 *   越往后越细。最上一级是全体（加一平滑）。
 * - 抽样：按 (会话, 时刻, 哪一项) 的哈希确定地抽，同一个输入永远同一个决定。
 *
 * 用法：
 *   tsx src/sim/surrogate.ts fit <model.json> <prompts.jsonl>...    拟合（跳过 stub 的输出、跳过旧 layout）
 *   tsx src/sim/surrogate.ts check <model.json> <prompts.jsonl>...  留出检验：各分组的预测对实测
 */
import { readFileSync, writeFileSync } from "node:fs";
import { unit } from "../mechanisms/hash.js";
import type { Act } from "../mind/affordances.js";
import type { SpeechRequest } from "../mind/effects.js";
import type { SpeechDecision } from "../mind/events.js";
import type { SpeechPrompt } from "../speech/prompt.js";

/** 分组用的事实，次序就是收缩的次序（前面的最重要）。 */
export const FEATURES = [
  "chat",
  "sought",
  "triggered",
  "crowd",
  "own",
  "gap",
  "energy",
  "foreign",
] as const;
type Feature = (typeof FEATURES)[number];
export type Features = Record<Feature, string> & { night: boolean; canBed: boolean };

/** 一次调用的结果（拟合时从她的动作数出来）。 */
export interface Outcome {
  spoke: boolean;
  sends: number;
  sticker: boolean;
  quote: boolean;
  react: boolean;
  think: boolean;
  feel: boolean;
  bed: boolean;
  mood: string | null;
  word: string | null;
}

const SMOOTH = 10;
const BINARY = ["spoke", "react", "think", "feel"] as const;
const GIVEN_SPOKE = ["sticker", "quote"] as const;
const MAX_SENDS = 3;

/** 从渲染好的提示词里读条件（拟合与回放共用）。 */
export function features(prompt: SpeechPrompt): Features {
  const { system, user } = prompt;
  const cut = user.lastIndexOf("\n---\n");
  const log = cut >= 0 ? user.slice(0, cut) : user;
  const anchor = cut >= 0 ? user.slice(cut) : "";
  const lines = log.split("\n").filter((l) => /^\d\d:\d\d \[/.test(l));
  const voices = new Set(
    lines
      .slice(-15)
      .map((l) => /\] <([^>]+)> /.exec(l)?.[1])
      .filter((s) => s !== undefined && s !== "你"),
  );
  const hour = Number(/现在是 (\d\d):/.exec(anchor)?.[1] ?? 12);
  return {
    chat: /^[─ ]*Telegram 群/.test(user) ? "group" : "private",
    sought: /这会儿没人[点找]你/.test(user) ? "unsought" : "sought",
    triggered: /\[[^\]\n]+\] 之后/.test(anchor) ? "message" : "clock",
    crowd: voices.size >= 4 ? "crowd" : "few",
    own: ownRun(lines),
    gap: gapOf(anchor),
    energy: energyOf(user),
    foreign: /如要说话请用/.test(anchor) ? "yes" : "no",
    night: hour >= 23 || hour < 4,
    // 去睡的那一行：Code Mode 的 SDK 里是 go_to_bed，2026-11-13 之前的提示词里是 [去睡了]（拟合用的旧记录）。
    canBed: /go_to_bed: |\[去睡了\]/.test(system),
  };
}

/** 记录最后连着几条是她的：0、1、2+。 */
function ownRun(lines: readonly string[]): string {
  let own = 0;
  for (let i = lines.length - 1; i >= 0 && / <你> /.test(lines[i] as string); i--) own++;
  if (own === 0) return "0";
  return own === 1 ? "1" : "2+";
}

/** 离最后一条多久：几小时、十分钟以上、几分钟、刚刚。 */
function gapOf(anchor: string): string {
  if (/离最后一条已经过了[^）]*小时/.test(anchor)) return "hours";
  const gap = /离最后一条已经过了 (\d+) 分钟/.exec(anchor);
  const minutes = gap ? Number(gap[1]) : 0;
  if (minutes > 10) return "long";
  return minutes > 0 ? "minutes" : "now";
}

function energyOf(user: string): string {
  if (/刚睡醒|被消息吵醒/.test(user)) return "woke";
  return /有点累|犯懒/.test(user) ? "low" : "ok";
}

export function outcomeOf(acts: readonly Act[]): Outcome {
  const sends = acts.filter((a) => a.kind === "send" || a.kind === "voice");
  const sticker = acts.find((a) => a.kind === "sticker");
  const feel = acts.find((a) => a.kind === "feel");
  const first = sends[0];
  return {
    spoke: sends.length > 0 || sticker !== undefined,
    sends: Math.min(MAX_SENDS, sends.length),
    sticker: sticker !== undefined,
    quote: first?.kind === "send" && first.replyTo !== null,
    react: acts.some((a) => a.kind === "react"),
    think: acts.some((a) => a.kind === "think"),
    feel: feel !== undefined,
    bed: acts.some((a) => a.kind === "bed"),
    mood: feel?.kind === "feel" ? feel.mood : null,
    word: sticker?.kind === "sticker" ? sticker.word : null,
  };
}

/** 一个分组里的计数。 */
interface Cell {
  n: number;
  spoke: number;
  react: number;
  think: number;
  feel: number;
  /** 开口的那些里。 */
  sticker: number;
  quote: number;
  /** 开口时发几条文字（0..MAX_SENDS）。 */
  sends: number[];
}

export interface SurrogateModel {
  version: 1;
  rows: number;
  /** 完整分组键（FEATURES 次序，用 | 连）→ 计数。 */
  cells: Record<string, Cell>;
  /** 夜里能睡的调用里去睡了几次（按群/私聊）。 */
  bed: Record<string, { n: number; bed: number }>;
  moods: Record<string, number>;
  words: Record<string, number>;
}

const emptyCell = (): Cell => ({
  n: 0,
  spoke: 0,
  react: 0,
  think: 0,
  feel: 0,
  sticker: 0,
  quote: 0,
  sends: Array.from<number>({ length: MAX_SENDS + 1 }).fill(0),
});

const keyOf = (f: Features, depth: number = FEATURES.length) =>
  FEATURES.slice(0, depth)
    .map((k) => f[k])
    .join("|");

export function fitSurrogate(
  rows: ReadonlyArray<{ prompt: SpeechPrompt; acts: readonly Act[] }>,
): SurrogateModel {
  const model: SurrogateModel = { version: 1, rows: 0, cells: {}, bed: {}, moods: {}, words: {} };
  for (const { prompt, acts } of rows) {
    const f = features(prompt);
    const o = outcomeOf(acts);
    const c = model.cells[keyOf(f)] ?? emptyCell();
    model.cells[keyOf(f)] = c;
    model.rows++;
    countInto(c, o);
    if (f.night && f.canBed) {
      const b = model.bed[f.chat] ?? { n: 0, bed: 0 };
      model.bed[f.chat] = b;
      b.n++;
      b.bed += o.bed ? 1 : 0;
    }
    if (o.mood) model.moods[o.mood] = (model.moods[o.mood] ?? 0) + 1;
    if (o.word) model.words[o.word] = (model.words[o.word] ?? 0) + 1;
  }
  return model;
}

/** 把一次调用的结果记进它的分组。 */
function countInto(c: Cell, o: Outcome): void {
  c.n++;
  for (const k of BINARY) c[k] += o[k] ? 1 : 0;
  if (!o.spoke) return;
  for (const k of GIVEN_SPOKE) c[k] += o[k] ? 1 : 0;
  (c.sends[o.sends] as number)++;
}

/** 某一级分组（前 depth 项相同）的合计。 */
function pooled(model: SurrogateModel, prefix: string, depth: number): Cell {
  const out = emptyCell();
  for (const [key, c] of Object.entries(model.cells)) {
    if (depth > 0 && key.split("|").slice(0, depth).join("|") !== prefix) continue;
    out.n += c.n;
    for (const k of [...BINARY, ...GIVEN_SPOKE]) out[k] += c[k];
    c.sends.forEach((v, i) => {
      out.sends[i] = (out.sends[i] as number) + v;
    });
  }
  return out;
}

/** 收缩后的估计：一个是非项的概率，或开口时文字条数的分布。 */
export interface Estimate {
  spoke: number;
  react: number;
  think: number;
  feel: number;
  sticker: number;
  quote: number;
  sends: number[];
}

export function estimate(model: SurrogateModel, f: Features): Estimate {
  const root = pooled(model, "", 0);
  const spokeN = (c: Cell) => c.sends.reduce((a, b) => a + b, 0);
  let e: Estimate = {
    spoke: (root.spoke + 1) / (root.n + 2),
    react: (root.react + 1) / (root.n + 2),
    think: (root.think + 1) / (root.n + 2),
    feel: (root.feel + 1) / (root.n + 2),
    sticker: (root.sticker + 1) / (spokeN(root) + 2),
    quote: (root.quote + 1) / (spokeN(root) + 2),
    sends: root.sends.map((v) => (v + 1) / (spokeN(root) + root.sends.length)),
  };
  for (let depth = 1; depth <= FEATURES.length; depth++) {
    const c = pooled(model, keyOf(f, depth), depth);
    const s = spokeN(c);
    const shrink = (k: number, n: number, prior: number) => (k + SMOOTH * prior) / (n + SMOOTH);
    e = {
      spoke: shrink(c.spoke, c.n, e.spoke),
      react: shrink(c.react, c.n, e.react),
      think: shrink(c.think, c.n, e.think),
      feel: shrink(c.feel, c.n, e.feel),
      sticker: shrink(c.sticker, s, e.sticker),
      quote: shrink(c.quote, s, e.quote),
      sends: c.sends.map((v, i) => shrink(v, s, e.sends[i] as number)),
    };
  }
  return e;
}

/** 按频率表抽一个（确定地）。 */
function pick(table: Record<string, number>, u: number): string | null {
  const total = Object.values(table).reduce((a, b) => a + b, 0);
  let acc = 0;
  for (const [k, v] of Object.entries(table).sort()) {
    acc += v / total;
    if (u < acc) return k;
  }
  return Object.keys(table).sort().at(-1) ?? null;
}

/** 回放时的一次决定：同样的提示词、同样的 (会话, 时刻)，总是同样的动作。 */
export function decide(
  model: SurrogateModel,
  prompt: SpeechPrompt,
  request: SpeechRequest,
  at: number,
): SpeechDecision {
  const f = features(prompt);
  const e = estimate(model, f);
  const key = `${request.scope}@${at}`;
  const u = (what: string) => unit(`surrogate:${what}:${key}`);
  const others = request.timeline.filter((t) => t.sender !== null);
  const target = request.triggerMessageId ?? others.at(-1)?.messageId ?? null;
  const offered = new Set(request.affordances);
  const acts: Act[] = [];
  if (offered.has("think") && u("think") < e.think) acts.push({ kind: "think", thought: "……" });
  if (offered.has("feel") && u("feel") < e.feel)
    acts.push({ kind: "feel", mood: pick(model.moods, u("mood")) ?? "平静", why: null });
  if (u("spoke") < e.spoke) acts.push(...spoken(model, e, offered, target, u));
  if (offered.has("react") && target && u("react") < e.react)
    acts.push({ kind: "react", messageId: target, emoji: "👍" });
  const bed = model.bed[f.chat];
  if (f.night && offered.has("bed") && bed && u("bed") < (bed.bed + 0.5) / (bed.n + 1))
    acts.push({ kind: "bed" });
  return { acts };
}

/** 开口时说的：按分布抽几条文字（第一条可能引用），带不带贴纸；什么都没抽到时说一条。 */
function spoken(
  model: SurrogateModel,
  e: Estimate,
  offered: ReadonlySet<string>,
  target: string | null,
  u: (what: string) => number,
): Act[] {
  let sends = drawIndex(e.sends, u("sends"));
  const sticker = offered.has("sticker") && u("sticker") < e.sticker;
  if (sends === 0 && !sticker) sends = 1;
  const acts: Act[] = [];
  for (let i = 0; i < sends; i++)
    acts.push({
      kind: "send",
      text: "嗯",
      replyTo: i === 0 && target && u("quote") < e.quote ? target : null,
    });
  if (sticker) acts.push({ kind: "sticker", word: pick(model.words, u("word")) ?? "happy" });
  return acts;
}

/** 按权重抽一个下标（v 在 0..1）；落不进任何一格时是 0。 */
function drawIndex(weights: readonly number[], v: number): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += (weights[i] as number) / total;
    if (v < acc) return i;
  }
  return 0;
}

/**
 * 日志里一行：渲染好的提示词和她的动作。stub 的输出（只有"嗯"）和旧 layout 跳过：只收卡片 layout（context-v2 起，
 * 开头一行是会话、下面有"· 我这边"或"· 你这边"），那以前的运行多是 flash-lite，模型也不一样。
 */
export function readRows(paths: readonly string[]) {
  const rows: Array<{ prompt: SpeechPrompt; acts: Act[] }> = [];
  for (const path of paths) {
    const all = readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { system: string; user: string; acts: Act[] | null });
    const stub = all.every((r) =>
      (r.acts ?? []).every((a) => a.kind === "send" && a.text === "嗯"),
    );
    if (stub) continue;
    for (const r of all) {
      if (r.acts === null || !/^[─ ]*Telegram /.test(r.user)) continue;
      if (!/· [我你]这边/.test(r.user.slice(0, 400))) continue;
      rows.push({ prompt: { system: r.system, user: r.user }, acts: r.acts });
    }
  }
  return rows;
}

/** 留出检验：按 群/私聊 × 有没有人找她 分组，预测的平均对实测。 */
export function check(model: SurrogateModel, rows: ReturnType<typeof readRows>) {
  const groups = new Map<
    string,
    { n: number; pred: Record<string, number>; seen: Record<string, number> }
  >();
  const keys = ["spoke", "react", "think", "feel", "sticker", "quote", "msgs"] as const;
  for (const { prompt, acts } of rows) {
    const f = features(prompt);
    const e = estimate(model, f);
    const o = outcomeOf(acts);
    const g = `${f.chat}|${f.sought}|${f.triggered}`;
    const s = groups.get(g) ?? {
      n: 0,
      pred: Object.fromEntries(keys.map((k) => [k, 0])),
      seen: Object.fromEntries(keys.map((k) => [k, 0])),
    };
    s.n++;
    const total = e.sends.reduce((a, b) => a + b, 0);
    const mean = e.sends.reduce((a, v, i) => a + (v / total) * i, 0);
    const pred = {
      spoke: e.spoke,
      react: e.react,
      think: e.think,
      feel: e.feel,
      sticker: e.spoke * e.sticker,
      quote: e.spoke * e.quote,
      msgs: e.spoke * (mean + e.sticker),
    };
    const seen = {
      spoke: +o.spoke,
      react: +o.react,
      think: +o.think,
      feel: +o.feel,
      sticker: +o.sticker,
      quote: +o.quote,
      msgs: o.sends + +o.sticker,
    };
    for (const k of keys) {
      (s.pred[k] as number) += pred[k];
      (s.seen[k] as number) += seen[k];
    }
    groups.set(g, s);
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .map(([g, s]) => ({
      group: g,
      n: s.n,
      ...Object.fromEntries(
        keys.map((k) => [
          k,
          { pred: (s.pred[k] as number) / s.n, seen: (s.seen[k] as number) / s.n },
        ]),
      ),
    }));
}

function main(): void {
  const [cmd, modelPath, ...inputs] = process.argv.slice(2);
  if (!modelPath || inputs.length === 0) {
    throw new Error("usage: surrogate.ts fit|check <model.json> <prompts.jsonl>...");
  }
  const rows = readRows(inputs);
  if (cmd === "fit") {
    const model = fitSurrogate(rows);
    writeFileSync(modelPath, `${JSON.stringify(model)}\n`);
    console.log(`rows=${model.rows} cells=${Object.keys(model.cells).length}`);
    return;
  }
  const model = JSON.parse(readFileSync(modelPath, "utf8")) as SurrogateModel;
  console.log(JSON.stringify(check(model, rows), null, 1));
}

if (process.argv[1]?.endsWith("surrogate.ts")) main();
