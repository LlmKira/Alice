/**
 * 意愿层闭环对照（eval-artifacts/will/prereg.md 起的各轮）：去掉她当年的发言，整份数据集（所有会话一起，
 * 意愿是跨会话的）由系统自己决定做什么；别人的消息保持真实，时钟每 10 秒一格。记录每次发言调用。
 *
 * 用法：tsx --env-file=.env src/sim/will-replay.ts <dataset.jsonl> <输出目录> <组别> [选项]
 *   组别见 will-arms.ts。
 *   --stub speak|silent|rate|fail：不调模型（零成本）。speak 每次都开口（调用与轮数的上界）；silent 从不开口；
 *     rate 按真模型的开口率开口（SPEAK_RATE，--speak-rate group-tick=0.3,... 覆盖）；fail 以 --fail-rate p
 *     （默认 1）的比例让调用失败。都按 (会话, 时刻) 的哈希确定地抽。
 *     rate-sought 同 rate，但时钟格叫醒时若有人在等她（提示词里没有"没人找你"），按被找时的开口率算。
 *   --lines 1=0.55,2=0.44,3=0.02：stub 开口时发几条的分布（真模型实测，eval-artifacts/dwell-look/）；默认一条。
 *   --bed q：rate stub 在当地 23 点到 4 点、这一轮能去睡（go_to_bed）时，每次调用以 q 的概率说完去睡；默认 0。
 *   --stub surrogate --surrogate <model.json>：她的发言替身（surrogate.ts），按提示词里的处境抽她这一轮的动作。
 *   --responders <model.json>：别人的回应模型（responders.ts），从真人数据数出的回复率、谁回、多久，取代 --respond。
 *   --scopes a,b：只回放这些会话。
 *   --window 开始ms 结束ms：只在这段时间里调真模型并记录；之前用沉默 stub 积累状态，之后不回放。
 *   --lambda0 x：所有压力场组用 λ0 = x（敏感度扫描）。
 *   --log-prompts：把每次发言调用送给模型的提示词原文和她的决定写进 prompts.jsonl（读连续几轮上下文，
 *     看机制缺什么、多什么、有没有跟上外面的事）。缓存命中时不调模型，所以跑完后再开它重放一遍是零成本。
 *   --errand-result 文字：她查一下的事不真办，一律在 15 秒后带着这段结果回来（注入场景：网页内容固定）。
 *   --respond p：回应 stub（只和 --stub 一起用，只作诊断）。她在群里说完一轮，按哈希以概率 p 由这个群 10 分钟内
 *     最后一个说话的别人引用回复她一次，延迟 10–140 秒（eval-artifacts/groupturn/prereg.md §4）。
 *     固定的回放里没人接她的新话，这样"有人接了她、她再接"的来回才会出现。
 *   --journal-noise：用数据里外壳当年抽的 noise.drawn（她那一夜的生活、心情起伏），不用回放的种子。
 *   --rotate 组名 --rotate-seed 种子 [--rotate-unit chat|self]：线上轮换（mind/rotation.ts）。组别写 production，
 *     生产和这个候选两套挂着，分组、换组和线上外壳同一个算法（换组写进 arms.jsonl，每次调用带 arm）。
 * 真模型运行里最近 BREAKER_WINDOW 次调用失败过半就中止（写 ABORTED，退出码 2）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Album } from "../album.js";
import { createGateway } from "../llm/gateway.js";
import { rerank } from "../llm/rerank.js";
import { callSpeechModel, SPEECH_MODELS, type SpeechModelName } from "../llm/speech-model.js";
import { perceiveMood } from "../llm/tone.js";
import { unit } from "../mechanisms/hash.js";
import { foundText } from "../mechanisms/pressure/reach.js";
import { inDwell } from "../mechanisms/pressure/turn.js";
import type { World } from "../mechanisms/pressure/world.js";
import type { Act } from "../mind/affordances.js";
import { type PonderRequest, SELF_SCOPE, type SpeechRequest } from "../mind/effects.js";
import type {
  AliceEvent,
  ChatType,
  FoundPlace,
  MessageSent,
  Ponder,
  SpeechDecision,
} from "../mind/events.js";
import { Failed } from "../mind/failure.js";
import type { Mechanism } from "../mind/mechanism.js";
import { NOISE_EVERY_MS } from "../mind/noise.js";
import { armOf, isAsleepIn, isRotating, type Mind, type RotationUnit } from "../mind/rotation.js";
import { type AliceState, emptyState } from "../mind/state.js";
import { towardHer } from "../mind/step.js";
import { localHour } from "../mind/when.js";
import { noiseSource } from "../noise-source.js";
import type { SpeechFormat } from "../speech/decision.js";
import { renderSpeechPrompt, type SpeechPrompt } from "../speech/prompt.js";
import { cachedErrandOracle } from "./errand-cache.js";
import { cachedPonderOracle, cachedValenceOracle } from "./ponder-cache.js";
import { type BackgroundOracle, replay } from "./replay.js";
import { type ResponderModel, responders } from "./responders.js";
import { cachedSpeechOracle } from "./speech-cache.js";
import { decide, type SurrogateModel } from "./surrogate.js";
import { armPromptConfig, arms, rotationOf } from "./will-arms.js";

/**
 * floor：群里她还在对话里时，别人没点她名的话叫醒了她。follow：同样叫醒，但提示词里写着"没人找你"（生产的 dwell
 * 在对话里也这样写，readerInside），按这个和 floor 分开。
 */
type Kind = `${ChatType}-${"tick" | "triggered"}` | "group-floor" | "group-follow";

/**
 * 真模型被叫醒后开口（说话或贴纸）的比例：2 月 B 最热闹的 12 小时、f70f334（加了作息以后重新量，
 * eval-artifacts/speak-rate）。贴纸也算开口，而 stub 一律发文字，所以文本类指标略偏高。开口率是唤醒逻辑与
 * 模型的联合量：改了唤醒或意愿以后用真模型小窗口重新量。
 */
const SPEAK_RATE: Record<Kind, number> = {
  "private-triggered": 0.97,
  "private-tick": 0.77,
  "group-triggered": 0.83,
  "group-tick": 0.34,
  // 暂定与 group-tick 相同，真模型窗口量出来后替换（eval-artifacts/groupturn/prereg.md §4）。
  "group-floor": 0.34,
  // 暂定（glance 量的节律叫醒：看到 3–5 条 0.14、6–10 条 0.36），真模型窗口量出来后替换（participation/prereg.md §3）。
  "group-follow": 0.2,
};

const STUBS = ["speak", "silent", "rate", "rate-sought", "fail", "surrogate"] as const;
type Stub = (typeof STUBS)[number];

/** 选项与各自带几个值；认不出的选项报错，不默默忽略。 */
const FLAGS = {
  "--stub": 1,
  "--scopes": 1,
  "--window": 2,
  "--lambda0": 1,
  "--fail-rate": 1,
  "--speak-rate": 1,
  "--lines": 1,
  "--bed": 1,
  "--surrogate": 1,
  "--responders": 1,
  "--log-prompts": 0,
  "--model": 1,
  "--errand-result": 1,
  "--respond": 1,
  "--persona": 1,
  "--journal-noise": 0,
  "--rotate": 1,
  "--rotate-seed": 1,
  "--rotate-unit": 1,
} as const;
type Flag = keyof typeof FLAGS;

interface RunOptions {
  dataset: string;
  outDir: string;
  arm: string;
  stub: Stub | null;
  scopes: ReadonlySet<string> | null;
  window: { from: number; until: number } | null;
  lambda0: number | undefined;
  failRate: number;
  rates: Record<Kind, number>;
  /** stub 开口时发几条：[条数, 概率]（--lines）；不给就一条。 */
  lines: ReadonlyArray<readonly [number, number]>;
  /** stub 在夜里（当地 23 点到 4 点）每次调用说完去睡（go_to_bed）的概率（--bed）；默认 0。 */
  bed: number;
  /** --stub surrogate 用的替身（surrogate.ts fit 写出的 JSON）。 */
  surrogate: string | null;
  /** 别人的回应模型（responders.ts fit 写出的 JSON），取代 --respond p。 */
  responders: string | null;
  logPrompts: boolean;
  model: SpeechModelName;
  errandResult: string | null;
  /** 回应 stub 的概率；null 是不回应（固定回放）。 */
  respond: number | null;
  /** 人格文件（默认生产的 SOUL.md；候选人格换一个文件比）。 */
  persona: string;
  /** 用数据里外壳当年抽的 noise.drawn，不用回放的种子（--journal-noise）。 */
  journalNoise: boolean;
  /** 线上轮换（--rotate）：和生产轮换的候选、种子、单位。 */
  rotate: { candidate: string; seed: string; unit: RotationUnit | null } | null;
}

/** 把命令行分成位置参数和选项值；认不出的选项、缺值的选项报错。 */
function splitArgs(argv: readonly string[]): { positional: string[]; values: Map<Flag, string[]> } {
  const positional: string[] = [];
  const values = new Map<Flag, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    if (!(a in FLAGS)) throw new Error(`unknown option ${a}`);
    const n = FLAGS[a as Flag];
    const v = argv.slice(i + 1, i + 1 + n);
    if (v.length !== n) throw new Error(`${a} needs ${n} value(s)`);
    values.set(a as Flag, v);
    i += n;
  }
  return { positional, values };
}

/** --speak-rate group-tick=0.3,...：在默认开口率上逐项覆盖。 */
function parseRates(spec: string): Record<Kind, number> {
  const rates = { ...SPEAK_RATE };
  for (const kv of spec.split(",").filter(Boolean)) {
    const [k, v] = kv.split("=");
    if (!k || !(k in rates) || v === undefined) throw new Error(`bad --speak-rate entry ${kv}`);
    rates[k as Kind] = Number(v);
  }
  return rates;
}

/** --lines 1=0.55,2=0.44：stub 开口时发几条的分布。 */
function parseLines(spec: string): RunOptions["lines"] {
  return spec.split(",").map((kv) => {
    const [n, p] = kv.split("=").map(Number);
    if (n === undefined || !n || p === undefined || Number.isNaN(p))
      throw new Error(`bad --lines entry ${kv}`);
    return [n, p] as const;
  });
}

function parseStub(stub: string | null): Stub | null {
  if (stub !== null && !(STUBS as readonly string[]).includes(stub)) {
    throw new Error(`unknown stub ${stub}`);
  }
  return stub as Stub | null;
}

function parseRotate(values: Map<Flag, string[]>, arm: string): RunOptions["rotate"] {
  const rotate = values.get("--rotate")?.[0];
  const seed = values.get("--rotate-seed")?.[0];
  const unit = values.get("--rotate-unit")?.[0] ?? null;
  if (rotate !== undefined && (arm !== "production" || seed === undefined)) {
    throw new Error("--rotate needs the production arm and --rotate-seed");
  }
  if (unit !== null && unit !== "chat" && unit !== "self")
    throw new Error("--rotate-unit chat|self");
  return rotate === undefined ? null : { candidate: rotate, seed: seed as string, unit };
}

export function parse(argv: readonly string[]): RunOptions {
  const { positional, values } = splitArgs(argv);
  const [dataset, outDir, arm] = positional;
  if (!dataset || !outDir || !arm) {
    throw new Error("usage: will-replay.ts <dataset.jsonl> <out-dir> <arm> [options]");
  }
  const one = (flag: Flag) => values.get(flag)?.[0];
  const stub = parseStub(one("--stub") ?? null);
  const rates = parseRates(one("--speak-rate") ?? "");
  const win = values.get("--window");
  const lambda = one("--lambda0");
  const respond = one("--respond");
  // 回应 stub 的话是占位文字，给真模型看会误导：只和 stub 一起用。
  if (respond !== undefined && stub === null) throw new Error("--respond needs --stub");
  const rotate = parseRotate(values, arm);
  return {
    respond: respond === undefined ? null : Number(respond),
    dataset,
    outDir,
    arm,
    stub,
    scopes: values.has("--scopes") ? new Set((one("--scopes") ?? "").split(",")) : null,
    window: win ? { from: Number(win[0]), until: Number(win[1]) } : null,
    lambda0: lambda === undefined ? undefined : Number(lambda),
    failRate: Number(one("--fail-rate") ?? 1),
    rates,
    lines: parseLines(one("--lines") ?? "1=1"),
    bed: Number(one("--bed") ?? 0),
    surrogate: one("--surrogate") ?? null,
    responders: one("--responders") ?? null,
    logPrompts: values.has("--log-prompts"),
    model: speechModel(one("--model") ?? "flash-lite"),
    errandResult: one("--errand-result") ?? null,
    persona: one("--persona") ?? "SOUL.md",
    journalNoise: values.has("--journal-noise"),
    rotate,
  };
}

function speechModel(name: string): SpeechModelName {
  if (!(name in SPEECH_MODELS)) {
    throw new Error(`unknown --model ${name}; models: ${Object.keys(SPEECH_MODELS).join(" ")}`);
  }
  return name as SpeechModelName;
}

/** 输出目录名（与以前的写法一致，好复用已有的缓存；普查按它找回这一次的输出）。 */
export function runName(o: RunOptions): string {
  const stub = o.stub ? `-stub-${o.stub}${o.stub === "fail" ? `-${o.failRate}` : ""}` : "";
  const window = o.window ? `-window-${o.window.from}` : "";
  const scopes = o.scopes ? `-scopes-${o.scopes.size}` : "";
  const lambda = o.lambda0 === undefined ? "" : `-lambda0-${o.lambda0}`;
  const respond = o.responders ? "-responders" : o.respond === null ? "" : `-respond-${o.respond}`;
  const persona =
    o.persona === "SOUL.md" ? "" : `-persona-${basename(o.persona).replace(/\.md$/, "")}`;
  const noise = o.journalNoise ? "-journal-noise" : "";
  const rotate = o.rotate ? `-rotate-${o.rotate.candidate}-${o.rotate.seed}` : "";
  return `${o.arm}${stub}${window}${scopes}${lambda}${respond}${persona}${noise}${rotate}`;
}

const SAY: SpeechDecision = { acts: [{ kind: "send", text: "嗯", replyTo: null }] };

/** stub 开口发几条：按 --lines 的分布、(会话, 时刻) 的哈希抽；只有一条时就是 SAY。 */
function say(lines: RunOptions["lines"], key: string): SpeechDecision {
  let u = unit(`lines:${key}`);
  let n = lines.at(-1)?.[0] ?? 1;
  for (const [count, p] of lines) {
    if (u < p) {
      n = count;
      break;
    }
    u -= p;
  }
  return n === 1 ? SAY : { acts: Array.from({ length: n }, () => SAY.acts[0] as Act) };
}
const QUIET: SpeechDecision = { acts: [] };

/** 叫醒她的是哪一类：时钟、找她的话（私聊、点名、引用她），或在场时群里别人没点她名的话。 */
function kindOf(request: SpeechRequest, directed: ReadonlySet<string>): Kind {
  const trigger = request.triggerMessageId;
  if (trigger === null) return `${request.chatType}-tick`;
  if (request.chatType === "group" && !directed.has(`${request.scope}/${trigger}`)) {
    // 压力场给旁观者写的那句事实（index.ts proactive，名字固定）：看着、还没开口。
    const bystander = request.contributions.some((c) => c.mechanism === "pressure-unsought");
    return bystander ? "group-follow" : "group-floor";
  }
  return `${request.chatType}-triggered`;
}

/** rate / rate-sought stub：按这一类叫醒的开口率、(会话, 时刻) 的哈希抽开不开口。 */
function rateDecision(
  o: RunOptions,
  stub: Stub,
  directed: ReadonlySet<string>,
  request: SpeechRequest,
  key: string,
): SpeechDecision {
  // rate-sought：时钟格叫醒、但有人在等她（夜里、忙完之后才回的那条），按被找时的开口率算——模型看到的是
  // 一条等着她回的消息，不是"没人找你"。只认压力场写给主动开口的那句事实（诊断用，不进运行时）。
  const waiting =
    stub === "rate-sought" &&
    !request.contributions.some((c) => c.mechanism === "pressure-unsought");
  const kind: Kind =
    request.triggerMessageId === null && waiting
      ? `${request.chatType}-triggered`
      : kindOf(request, directed);
  return unit(key) < o.rates[kind] ? say(o.lines, key) : QUIET;
}

function stubOracle(o: RunOptions, stub: Stub, directed: ReadonlySet<string>, persona: string) {
  const model =
    stub === "surrogate"
      ? (JSON.parse(readFileSync(o.surrogate ?? "", "utf8")) as SurrogateModel)
      : null;
  return (request: SpeechRequest, at: number): SpeechDecision | null => {
    const key = `${request.scope}@${at}`;
    if (model) return decide(model, renderSpeechPrompt(persona, request), request, at);
    // 夜里说完去睡：真模型每次去睡都在同一次调用里说了话（eval-artifacts/dwell-look/prereg.md §6）。
    const hour = localHour(at);
    const night = (hour >= 23 || hour < 4) && request.affordances.includes("bed");
    if (stub.startsWith("rate") && night && unit(`bed:${key}`) < o.bed) {
      return { acts: [...say(o.lines, key).acts, { kind: "bed" }] };
    }
    switch (stub) {
      case "speak":
        return SAY;
      case "silent":
      case "surrogate":
        return QUIET;
      case "fail":
        return unit(`fail:${key}`) < o.failRate ? null : QUIET;
      case "rate":
      case "rate-sought":
        return rateDecision(o, stub, directed, request, key);
    }
  };
}

/** 熔断：真模型运行里看最近这么多次调用。 */
const BREAKER_WINDOW = 20;
class BreakerOpen extends Error {}

/** 记一次调用成败；最近 window 次里失败过半就抛出 BreakerOpen。 */
function breaker(window: number): (failed: boolean) => void {
  const recent: boolean[] = [];
  return (failed) => {
    recent.push(failed);
    if (recent.length > window) recent.shift();
    const bad = recent.filter(Boolean).length;
    if (recent.length === window && bad >= window / 2) {
      throw new BreakerOpen(`${bad}/${window} recent calls failed`);
    }
  };
}

/** 等回放跑完；熔断打开时返回原因（结果不完整），其他错误照常抛出。 */
async function untilBreaker(run: Promise<unknown>): Promise<string | null> {
  try {
    await run;
    return null;
  } catch (error) {
    if (!(error instanceof BreakerOpen)) throw error;
    return error.message;
  }
}

/**
 * 她当年的发言去掉：她做什么由系统决定。别人回复她当年那些话的消息，在新时间线里回复的是不存在的话：
 * 群聊里除非点了她的名字，不再算找她，引用也去掉（2 月 B 群聊 384 条"找她"里 331 条是这种，只有 9 条点名）。
 */
export function replayEvents(o: RunOptions): AliceEvent[] {
  const all = readFileSync(o.dataset, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AliceEvent);
  const hers = new Set(all.flatMap((e) => (e.type === "message.sent" ? [e.messageId] : [])));
  const until = o.window?.until ?? Number.POSITIVE_INFINITY;
  const received = all.flatMap((e) => (e.at < until ? replayed(e, o, hers) : []));
  return o.journalNoise ? received : withNoise(received);
}

/** 窗口内的一个事件在回放里还剩什么。 */
function replayed(e: AliceEvent, o: RunOptions, hers: ReadonlySet<string>): AliceEvent[] {
  const inScope = (scope: string) => !o.scopes || o.scopes.has(scope);
  switch (e.type) {
    // 频道新帖是她看到的东西（不是她的发言），原样留着。
    case "post.received":
      return [e];
    case "noise.drawn":
      return o.journalNoise ? [e] : [];
    // 别人进群的提示也是她看到的，原样留着（关系事实靠它分清刚进群的人）。
    // 她自己被拉进群、被移出也原样留着（平台层仿真的事件流里有，sim/platform.ts）。
    // 外壳当时看出的东西（场景里写好的口气、图片描述）是世界的事实，原样留着；不再问一遍。
    case "member.joined":
    case "membership.changed":
    case "message.perceived":
      return inScope(e.scope) ? [e] : [];
    case "message.received": {
      if (!inScope(e.scope)) return [];
      if (!e.replyToMessageId || !hers.has(e.replyToMessageId)) return [e];
      const named = /alice|爱丽丝/i.test(e.text ?? "");
      return [{ ...e, replyToMessageId: null, directed: e.chatType === "private" || named }];
    }
    default:
      return [];
  }
}

/** 回放里外壳的随机数用这个种子（mind/noise.ts）：同一份数据每次回放都抽出同样的事。 */
const NOISE_SEED = 20261111;

/**
 * 按外壳的间隔插进 noise.drawn（从第一条消息之后的整格到最后一条），同一时刻排在消息前面。
 * 不读它的机制（生产里目前没有）不受影响。
 */
function withNoise(events: AliceEvent[]): AliceEvent[] {
  const first = events[0]?.at;
  const last = events.at(-1)?.at;
  if (first === undefined || last === undefined) return events;
  const draw = noiseSource(NOISE_SEED);
  const noise: AliceEvent[] = [];
  for (
    let at = Math.ceil(first / NOISE_EVERY_MS) * NOISE_EVERY_MS;
    at <= last;
    at += NOISE_EVERY_MS
  ) {
    noise.push({ type: "noise.drawn", at, scope: SELF_SCOPE, draws: draw() });
  }
  const merged: AliceEvent[] = [];
  let i = 0;
  for (const e of events) {
    while (i < noise.length && (noise[i] as AliceEvent).at <= e.at)
      merged.push(noise[i++] as AliceEvent);
    merged.push(e);
  }
  return merged;
}

/**
 * 场景里写好的"公开的群和频道"（数据旁边的 places.json）：她找群时，问的是某个链接就给那一个，否则给全部
 * 公开的（stub，不判断关键词）。没有这个文件时找群没有结果。
 */
function placesFixture(dataset: string) {
  const file = join(dirname(dataset), "places.json");
  if (!existsSync(file)) return null;
  const all = JSON.parse(readFileSync(file, "utf8")) as Array<{
    link?: string;
    public?: boolean;
    place: FoundPlace;
  }>;
  return (_scope: string, act: Act) => {
    if (act.kind !== "chat-search") return null;
    const linked = all.filter((p) => (p.link ? act.query.includes(p.link) : false));
    const found = (linked.length > 0 ? linked : all.filter((p) => p.public)).map((p) => p.place);
    return { result: foundText(act.query, found), found };
  };
}

/**
 * dwell 的 footprint（dwell.jsonl，窗口内）：inside 是她在对话里时到的、没点她名的群消息（能叫醒她的那些；
 * calls.jsonl 里 trigger 是它的调用就是在对话里被叫醒），end 是每段对话怎么结束的。
 */
function dwellLog(mechanisms: readonly Mechanism[], from: number) {
  const name = mechanisms.find((m) => m.name.startsWith("pressure"))?.name;
  const lines: string[] = [];
  const logged = new Map<string, number>();
  const ends = (world: World, scope: string) => {
    const d = world.chats[scope]?.turn.dwell;
    if (!d?.ended || d.from < from || logged.get(scope) === d.from) return;
    logged.set(scope, d.from);
    lines.push(JSON.stringify({ t: "end", scope, from: d.from, at: d.ended.at, why: d.ended.why }));
  };
  const observe = (event: AliceEvent, state: AliceState) => {
    const world = name ? (state.mechanisms[name] as World | undefined) : undefined;
    if (!world || event.at < from) return;
    if (event.type === "clock.tick") {
      for (const scope of Object.keys(world.chats)) ends(world, scope);
      return;
    }
    if (!("scope" in event)) return;
    const chat = world.chats[event.scope];
    if (event.type === "message.received" && !event.directed && chat && inDwell(chat, event.at))
      lines.push(
        JSON.stringify({ t: "inside", scope: event.scope, id: event.messageId, at: event.at }),
      );
    ends(world, event.scope);
  };
  return { lines, observe };
}

/** 回应 stub 里回她的人：这个群里她开口前这么久之内最后一个说话的别人。 */
const RESPOND_LOOKBACK = 10 * 60_000;
const RESPOND_DELAY = { min: 10_000, span: 130_000 } as const;

/**
 * 回应 stub（--respond p）：她在群里说完一轮，以概率 p（按 会话@时刻 的哈希）由这个群里刚说过话的别人引用回复
 * 她一次。同一时刻发出的几条算一轮，只回一次。回复是占位文字，所以只和 stub 一起用。
 * 和线上的适配器一样只记事实（引用了她那条，没点名）：算不算找她由心智定。
 */
function responder(events: readonly AliceEvent[], p: number): (sent: MessageSent) => AliceEvent[] {
  const said = new Map<string, Array<{ at: number; id: string; name: string }>>();
  for (const e of events) {
    if (e.type !== "message.received" || e.chatType !== "group") continue;
    const list = said.get(e.scope) ?? [];
    list.push({ at: e.at, id: e.senderId, name: e.senderName });
    said.set(e.scope, list);
  }
  const answered = new Set<string>();
  let n = 0;
  return (sent) => {
    const key = `${sent.scope}@${sent.at}`;
    const list = said.get(sent.scope);
    if (!list || answered.has(key)) return [];
    answered.add(key);
    if (unit(`respond:${key}`) >= p) return [];
    let last: { at: number; id: string; name: string } | undefined;
    for (const m of list) {
      if (m.at > sent.at) break;
      last = m;
    }
    if (!last || sent.at - last.at > RESPOND_LOOKBACK) return [];
    n++;
    const messageId = `respond:${n}`;
    return [
      {
        type: "message.received",
        at: sent.at + RESPOND_DELAY.min + Math.floor(unit(`delay:${key}`) * RESPOND_DELAY.span),
        scope: sent.scope,
        chatType: "group",
        messageId,
        senderId: last.id,
        senderName: last.name,
        text: "（回你的话）",
        contentType: "text",
        replyToMessageId: sent.messageId,
        directed: false,
      },
    ];
  };
}

type Gateway = ReturnType<typeof createGateway>;

/**
 * 查一下的执行者：stub 从不查；--errand-result 一律 15 秒后带着固定结果回来；否则由执行代理真办（带缓存）。
 */
function errandOracleOf(
  o: RunOptions,
  persona: string,
  dir: string,
  gateway: Gateway,
): BackgroundOracle | null {
  if (o.stub) return null;
  const fixed = o.errandResult;
  if (fixed !== null) return async () => ({ result: fixed, ms: 15_000 });
  return cachedErrandOracle({
    persona,
    cacheFile: join(dir, "errand-cache.jsonl"),
    gateway,
    exaKey: process.env.EXA_API_KEY ?? "",
  });
}

/** 真模型一轮之内的查询（翻相册、找群、查一下）：查一下的结果和花费记进 errands。 */
function speechQuery(
  album: Album,
  look: ReturnType<typeof placesFixture>,
  errandOracle: BackgroundOracle | null,
  errands: string[],
) {
  return async (request: SpeechRequest, kind: string, args: Record<string, unknown>) => {
    if (kind === "album-search") {
      return album.searchItems(String(args.query ?? ""), request.at);
    }
    if (kind === "chat-search") {
      return (
        look?.(request.scope, { kind: "chat-search", query: String(args.query ?? "") })?.found ?? []
      );
    }
    if (!errandOracle) throw new Failed({ reason: "unavailable" });
    const r = await errandOracle(
      request.scope,
      { kind: "delegate", task: String(args.task ?? "") },
      request,
      request.at,
    );
    errands.push(JSON.stringify({ scope: request.scope, at: request.at, args, ...r }));
    if ("failure" in r) throw new Failed(r.failure);
    return r.result;
  };
}

/**
 * 别人怎么回她：--responders 的回应模型（造出的回复记进 replies），或 --respond p 的回应 stub，或不回应。
 */
function respondOf(
  o: RunOptions,
  events: readonly AliceEvent[],
  pressureName: string | undefined,
  replies: string[],
) {
  if (o.responders) {
    return responders(
      JSON.parse(readFileSync(o.responders, "utf8")) as ResponderModel,
      events,
      (sent, state) => {
        const world = pressureName ? (state.mechanisms[pressureName] as World) : undefined;
        return !world?.chats[sent.scope]?.awaiting?.proactive;
      },
      (reply) => {
        replies.push(
          JSON.stringify({
            scope: reply.scope,
            at: reply.at,
            id: reply.messageId,
            from: reply.senderId,
            to: reply.replyToMessageId,
          }),
        );
      },
    );
  }
  return o.respond === null ? undefined : responder(events, o.respond);
}

function valenceOf(dir: string, gateway: Gateway) {
  return cachedValenceOracle({
    cacheFile: join(dir, "valence-cache.jsonl"),
    perceive: (mood) => perceiveMood(gateway, mood),
  });
}

/** 回放里的查一下：每次的结果和花费记进 errands。 */
function loggedErrands(errandOracle: BackgroundOracle, errands: string[]): BackgroundOracle {
  return async (scope, act, request, at) => {
    const r = await errandOracle(scope, act, request, at);
    errands.push(JSON.stringify({ scope, at, act, ...r }));
    return r;
  };
}

/** stub 和窗口之前的想一想：没想出东西。 */
function emptyPonder(request: PonderRequest): Ponder {
  return request.kind === "life"
    ? { kind: "life", date: request.date, activities: {}, moments: [], ongoing: [] }
    : { kind: "reflect", scope: request.scope, entries: [] };
}

/** 一次发言调用在 calls.jsonl 里的一行。 */
function callLine(
  request: SpeechRequest,
  at: number | undefined,
  d: SpeechDecision | null,
  directed: ReadonlySet<string>,
  mind: Mind,
  before: AliceState,
): string {
  return JSON.stringify({
    scope: request.scope,
    chatType: request.chatType,
    at,
    lastMessageAt: request.timeline.at(-1)?.at ?? null,
    trigger: request.triggerMessageId,
    kind: kindOf(request, directed),
    contributed: request.contributions.map((c) => c.mechanism),
    failed: d === null,
    acts: d?.acts ?? [],
    ...(isRotating(mind) ? { arm: armOf(mind, before, request.scope) } : {}),
    asleep: isAsleepIn(mind, before, at ?? 0),
  });
}

/** --log-prompts：送给模型的提示词原文和她的决定（prompts.jsonl 的一行）。 */
function promptLine(
  persona: string,
  request: SpeechRequest,
  at: number | undefined,
  d: SpeechDecision | null,
  promptOptions: { format?: SpeechFormat; concisePeople?: boolean } | undefined,
): string {
  const p = promptOptions
    ? renderSpeechPrompt(persona, request, promptOptions)
    : renderSpeechPrompt(persona, request);
  return JSON.stringify({
    scope: request.scope,
    at,
    system: p.system,
    user: p.user,
    acts: d?.acts ?? null,
    ...(p.tools ? { tools: p.tools } : {}),
  });
}

/**
 * 每个事件处理完之后：记下换组、冲着她的消息，喂给相册和 dwell 的 footprint。
 * before() 是上一个事件处理完时的状态（发言调用按它判断轮换的组和睡没睡）。
 */
function observer(r: {
  directed: Set<string>;
  album: Album;
  dwells: ReturnType<typeof dwellLog>;
  switches: string[];
}) {
  let before: AliceState = emptyState;
  const observe = (event: AliceEvent, state: AliceState) => {
    if (event.type === "arm.switched") r.switches.push(JSON.stringify(event));
    const seen = towardHer(before, event);
    before = state;
    if (seen.type === "message.received" && seen.directed) {
      r.directed.add(`${seen.scope}/${seen.messageId}`);
    }
    r.album.observe(event);
    r.dwells.observe(event, state);
  };
  return { observe, before: () => before };
}

/** 写出各份记录：calls.jsonl 总写，其余有内容才写。 */
function writeLogs(dir: string, calls: string[], optional: ReadonlyArray<[string, string[]]>) {
  writeFileSync(join(dir, "calls.jsonl"), `${calls.join("\n")}\n`);
  for (const [file, lines] of optional) {
    if (lines.length > 0) writeFileSync(join(dir, file), `${lines.join("\n")}\n`);
  }
}

async function main(): Promise<void> {
  const o = parse(process.argv.slice(2));
  const listed = arms({ lambda0: o.lambda0 })[o.arm];
  if (!listed) throw new Error(`unknown arm ${o.arm}; arms: ${Object.keys(arms({})).join(" ")}`);
  // 轮换时两套都不按外壳的服务组合（和单组回放一样，查一下总在）。
  const mind: Mind = o.rotate ? rotationOf(o.rotate, null) : listed;
  const active = isRotating(mind) ? mind.folded : listed;
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey && !o.stub) throw new Error("LLM_API_KEY is required without --stub");
  const dir = join(o.outDir, runName(o));
  mkdirSync(dir, { recursive: true });
  const armProfile = armPromptConfig(o.arm);
  const persona = readFileSync(o.persona, "utf8");
  const promptOptions = armProfile.format ? { format: armProfile.format } : undefined;
  // 回放不受日上限约束，不记进花费账；只把网关报的扣费加起来，写在最后一行（usd=）。
  let usd = 0;
  const gateway = createGateway({
    apiKey: apiKey ?? "",
    charge: (spent) => {
      usd += spent.usd;
    },
  });
  const call = (kind: "speech" | "ponder") => (prompt: SpeechPrompt) =>
    callSpeechModel(gateway, prompt, { kind, model: o.model });
  const model = SPEECH_MODELS[o.model].id;
  const album = new Album((q, docs, top) => rerank(gateway, q, docs, top));
  const look = placesFixture(o.dataset);
  const errands: string[] = [];
  const errandOracle = errandOracleOf(o, persona, dir, gateway);
  const speech = cachedSpeechOracle({
    persona,
    cacheFile: join(dir, "speech-cache.jsonl"),
    call: call("speech"),
    model,
    ...(promptOptions ? { promptOptions } : {}),
    ...(!o.stub ? { onQuery: speechQuery(album, look, errandOracle, errands) } : {}),
  });
  const ponder = cachedPonderOracle({
    persona,
    cacheFile: join(dir, "ponder-cache.jsonl"),
    call: call("ponder"),
    model,
  });
  // 心情的效价：真模型运行里和外壳一样问判口气的模型（带缓存）；stub 不问，心情只记下词。
  const valence = o.stub ? null : valenceOf(dir, gateway);
  const events = replayEvents(o);
  // 冲着她的消息（stub 按它分开叫醒的种类）：和心智同一个判断（towardHer），在每个事件送进 step 时记下。
  const directed = new Set<string>();
  const pressureName = active.find((m) => m.name.startsWith("pressure"))?.name;
  /** 回应模型造出的回复（replies.jsonl）：哪一条、回的是她哪一条、什么时候。 */
  const replies: string[] = [];
  const respond = respondOf(o, events, pressureName, replies);
  const record = breaker(BREAKER_WINDOW);
  const from = o.window?.from ?? Number.NEGATIVE_INFINITY;
  const stub = o.stub ? stubOracle(o, o.stub, directed, persona) : null;
  // 查一下：真模型运行里由执行代理真办（带缓存），结果和花费写进 errands.jsonl。stub 从不查。
  const calls: string[] = [];
  const prompts: string[] = [];
  const ponders: string[] = [];
  const dwells = dwellLog(active, from);
  /** 轮换的换组（arms.jsonl）。 */
  const switches: string[] = [];
  const seen = observer({ directed, album, dwells, switches });
  const aborted = await untilBreaker(
    replay(events, {
      mechanisms: mind,
      tickMs: 10_000,
      observe: seen.observe,
      ...(respond ? { respond } : {}),
      ...(look ? { look } : {}),
      ...(valence ? { valence } : {}),
      ...(errandOracle ? { background: loggedErrands(errandOracle, errands) } : {}),
      ponder: async (request) => {
        // 窗口之前和发言一样用 stub：否则 --window 运行会为窗口前的几天反思付费（groupturn：每组 258 次）。
        const r: Ponder | null =
          o.stub || request.at < from ? emptyPonder(request) : await ponder(request);
        ponders.push(
          JSON.stringify({
            at: request.at,
            lines: request.kind === "reflect" ? request.lines.length : 0,
            failed: r === null,
            ...r,
          }),
        );
        return r;
      },
      speech: async (request, callId, at) => {
        if ((at ?? 0) < from) return QUIET;
        const d = stub ? stub(request, at ?? 0) : await speech(request, callId);
        if (!stub) record(d === null);
        if (o.logPrompts) prompts.push(promptLine(persona, request, at, d, promptOptions));
        calls.push(callLine(request, at, d, directed, mind, seen.before()));
        if (calls.length % 200 === 0) console.error(`${o.arm}: ${calls.length} calls`);
        return d;
      },
    }),
  );
  writeLogs(dir, calls, [
    ["ponders.jsonl", ponders],
    ["dwell.jsonl", dwells.lines],
    ["replies.jsonl", replies],
    ["prompts.jsonl", prompts],
    ["errands.jsonl", errands],
    ["arms.jsonl", switches],
  ]);
  if (aborted) {
    console.error(`ABORTED: ${aborted} — results are incomplete, do not read them`);
    writeFileSync(join(dir, "ABORTED"), `${aborted}\n`);
    process.exitCode = 2;
  }
  console.log(
    `arm=${o.arm} calls=${calls.length} model_calls=${speech.misses()} failures=${speech.failures()} ponders=${ponders.length} ponder_model_calls=${ponder.misses()} usd=${usd.toFixed(4)}`,
  );
}

if (process.argv[1]?.endsWith("will-replay.ts")) void main();
