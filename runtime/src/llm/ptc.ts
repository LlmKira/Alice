/**
 * Code Mode 的执行面（PTC）：把模型写的一段 async 函数体放进 vm 里真跑。只读的那一份在
 * speech/decision.ts（walkProgram，从不执行）；这里真执行，查询类动作的结果回到程序里，于是她能按结果
 * 决定下一步（翻相册 → 挑编号 → 发图），而不是只发一句直线排好的话。
 *
 * 沙箱里只放 Promise 和几个语言构造器（没有 process、require、fetch、fs、计时器）：查相册、找群、查东西
 * 都走 onQuery 由外壳去做。程序停不下来等外面：直到第一个 await 之前的死循环由 runInContext 的 timeout
 * 打断，之后由 Promise 竞速管。
 */
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import {
  type Act,
  type ActKind,
  type Affordance,
  affordanceOf,
  affordances,
} from "../mind/affordances.js";
import { type ArgContext, buildAct } from "../mind/args.js";
import type { SpeechRequest } from "../mind/effects.js";
import type { Defect, ToolReply } from "../speech/decision.js";
import { readObject } from "../speech/json.js";

/** 看了才知道的三件事：结果要回到程序里（其余动作只是做出来）。 */
export type QueryKind = "album-search" | "chat-search" | "delegate" | "recall" | "dm-check";

/**
 * 查询的执行者（外壳接相册、找群、执行代理）。args 是程序传进来、登记表已经校验过的参数；
 * signal 在这个程序超时或被取消时 abort，执行者据此停掉外面的请求。
 */
export type QueryHandler = (
  kind: QueryKind,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;

/** 一次查询的记录：动作、结果，或失败的原因（程序可能自己 catch 了，也可能没有）。 */
export interface PtcRecord {
  act: Act;
  result?: unknown;
  error?: string;
  /** 查询抛错且没被程序的 try/catch 接住（外层外壳据此决定是否再叫醒她一次）。 */
  uncaught?: true;
  /** 查询成功之后，同一轮程序里是否还做出了对外动作（没有时外壳会补唤醒一次，避免查完就哑火）。 */
  actedAfter?: true;
}

/** 对外的动作：心里的事（只有她看得到的那几样）不算。 */
const isOutward = (act: Act) => affordanceOf(act.kind).via !== "mind";

export interface PtcOptions {
  timeoutMs?: number;
  /** 整个程序最多调用几次 tools（默认 20）。 */
  maxCalls?: number;
  /** 其中查询类最多几次（默认 6）。 */
  maxQueries?: number;
  signal?: AbortSignal;
  onQuery?: QueryHandler;
}

export interface PtcResult {
  /** 做出来的事（查询不算，查询在 queries 里）。 */
  acts: Act[];
  defects: Defect[];
  queries: PtcRecord[];
}

export const QUERY_KINDS = new Set<ActKind>([
  "album-search",
  "chat-search",
  "delegate",
  "recall",
  "dm-check",
]);

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_CALLS = 20;
const DEFAULT_MAX_QUERIES = 6;
const RUN_CODE = "run_code";

const byName: Record<string, Affordance> = Object.fromEntries(
  affordances.map((a) => [a.name, a] as const),
);

function isQueryKind(kind: ActKind): kind is QueryKind {
  return QUERY_KINDS.has(kind);
}

/** 参数必须是对象（没写就是空对象）；别的形状整条动作不成立。 */
function argsOf(name: string, raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`invalid args for ${name}`);
  }
  return raw as Record<string, unknown>;
}

/** 包成 async 函数再擦掉类型；语法错时 null（整段不算，真执行也一件都做不成）。 */
function transpile(code: string): string | null {
  const wrapped = `async function run(tools) {\n${code}\n}`;
  const checked = ts.transpileModule(wrapped, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const broken = (checked.diagnostics ?? []).some(
    (d) => d.category === ts.DiagnosticCategory.Error,
  );
  return broken ? null : checked.outputText;
}

/** 一次程序的停止条件：超时和外面取消谁先到算谁；两者都 abort 查询拿到的 signal。 */
interface Deadline {
  signal: AbortSignal;
  stopped: Promise<never>;
  timeoutMs: number;
  done(): void;
}

function deadline(timeoutMs: number, external?: AbortSignal): Deadline {
  const controller = new AbortController();
  const { promise, reject } = Promise.withResolvers<never>();
  const stop = (reason: "timeout" | "abort") => {
    controller.abort();
    reject(new Error(reason === "timeout" ? `timed out after ${timeoutMs}ms` : "aborted"));
  };
  const timer = setTimeout(() => stop("timeout"), timeoutMs);
  const onAbort = () => stop("abort");
  external?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    stopped: promise,
    timeoutMs,
    done() {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * 程序里的 tools：只认这个会话此刻能做的动作，按登记表校验参数，记下动作和查询，超过条数就抛。
 * 查询结果回给程序，所以脚本能按结果决定下一步；查询失败原样抛回去，脚本可以自己接住。
 */
function bindTools(
  request: SpeechRequest,
  options: PtcOptions,
  signal: AbortSignal,
): {
  tools: Record<string, unknown>;
  acts: Act[];
  queries: PtcRecord[];
  markUncaught: (err: unknown) => void;
  markActed: () => void;
} {
  const maxCalls = Math.max(0, Math.floor(options.maxCalls ?? DEFAULT_MAX_CALLS));
  const maxQueries = Math.max(0, Math.floor(options.maxQueries ?? DEFAULT_MAX_QUERIES));
  const ctx: ArgContext = { timeline: request.timeline, now: request.at };
  const allowed = new Set<ActKind>(request.affordances);
  // 标记已读不在提示词的 SDK 里（decision.ts 的 shown），但解析认得；叫到了就照做。
  allowed.add("mark-read");

  const acts: Act[] = [];
  const queries: PtcRecord[] = [];
  const actsAtQuery = new Map<PtcRecord, number>();
  const thrownToRecord = new Map<unknown, PtcRecord>();
  let calls = 0;
  let queryCalls = 0;

  const runQuery = async (
    kind: QueryKind,
    act: Act,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    const atActs = acts.length;
    try {
      const handler = options.onQuery;
      if (!handler) throw new Error(`no query handler for ${kind}`);
      const result = await handler(kind, args, signal);
      const rec: PtcRecord = { act, result };
      queries.push(rec);
      actsAtQuery.set(rec, atActs);
      return result;
    } catch (err) {
      // 先记下来再往外抛：程序的 try/catch 接得住，接不住就是这一轮的 defect。
      const rec: PtcRecord = { act, error: String(err) };
      queries.push(rec);
      thrownToRecord.set(err, rec);
      throw err;
    }
  };
  const callTool = (row: Affordance, raw: unknown): unknown => {
    calls += 1;
    if (calls > maxCalls) throw new Error(`too many tool calls (max ${maxCalls})`);
    const args = argsOf(row.name, raw);
    const act = buildAct(row.kind, args, ctx);
    if (!act) throw new Error(`invalid args for ${row.name}`);
    const kind = act.kind;
    if (!isQueryKind(kind)) {
      acts.push(act);
      return undefined;
    }
    queryCalls += 1;
    if (queryCalls > maxQueries) throw new Error(`too many queries (max ${maxQueries})`);
    return runQuery(kind, act, args);
  };

  const tools = new Proxy<Record<string, unknown>>(Object.create(null), {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      // 原型上的 toString、constructor 不是工具（表本身是普通对象）。
      const row = Object.hasOwn(byName, prop) ? byName[prop] : undefined;
      // 在本段代码里已经查过相册拿到结果后，允许同一轮接着调用 send_photo。
      const chainedPhoto =
        row?.kind === "album-send" &&
        allowed.has("album-search") &&
        queries.some((q) => q.act.kind === "album-search" && q.error === undefined);
      if (!row || (!allowed.has(row.kind) && !chainedPhoto)) {
        throw new Error(`unknown tool: ${prop}`);
      }
      return (raw?: unknown) => callTool(row, raw);
    },
  });
  const markUncaught = (err: unknown) => {
    const rec = thrownToRecord.get(err);
    if (rec) rec.uncaught = true;
  };
  const markActed = () => {
    for (const q of queries) {
      const at = actsAtQuery.get(q);
      if (at === undefined) continue;
      if (acts.slice(at).some(isOutward)) q.actedAfter = true;
    }
  };
  return { tools, acts, queries, markUncaught, markActed };
}

/** 在 vm 里跑入口脚本：程序异常、超时、取消都收敛成一条 defect；null 表示跑完。 */
async function runInSandbox(
  source: string,
  globals: Record<string, unknown>,
  stop: Deadline,
  onUncaught?: (err: unknown) => void,
): Promise<Defect | null> {
  const context = createContext(globals);
  let pending: unknown;
  try {
    // 调用也在 runInContext 里执行：直到第一个 await 之前的死循环由 vm 的 timeout 打断。
    pending = runInContext(`${source}\nrun(__tools);`, context, {
      timeout: stop.timeoutMs,
      filename: "ptc.js",
    });
    await Promise.race([Promise.resolve(pending), stop.stopped]);
    return null;
  } catch (err) {
    // 已经不等它了：程序后面还可能失败，别变成未处理的 rejection。
    void Promise.resolve(pending).catch(() => undefined);
    onUncaught?.(err);
    return { kind: "code", text: String(err) };
  } finally {
    stop.done();
  }
}

/** 执行一段 run_code 程序。语法错时一件都不做；运行出错时保留出错前做成的事。 */
export async function executeProgram(
  code: string,
  request: SpeechRequest,
  options: PtcOptions = {},
): Promise<PtcResult> {
  const source = transpile(code);
  if (source === null) {
    return { acts: [], defects: [{ kind: "unparseable", text: code }], queries: [] };
  }
  if (options.signal?.aborted) {
    return { acts: [], defects: [{ kind: "code", text: "aborted" }], queries: [] };
  }

  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const stop = deadline(timeoutMs, options.signal);
  const { tools, acts, queries, markUncaught, markActed } = bindTools(
    request,
    options,
    stop.signal,
  );
  // 沙箱里只有语言本身（构造器和 Promise），没有 process、require、网络、计时器；
  // run(tools) 从全局拿 tools，它和提示词里的声明是同一张表。
  const globals: Record<string, unknown> = {
    Promise,
    Math,
    JSON,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Date,
    Map,
    Set,
    Error,
    TypeError,
    RangeError,
    __tools: tools,
  };
  const defect = await runInSandbox(source, globals, stop, markUncaught);
  markActed();
  return { acts: [...acts], defects: defect ? [defect] : [], queries: [...queries] };
}

/** 读模型原文；不是 JSON 时 null（整段不算）。 */
function parseReply(rawJson: string): ToolReply | null {
  try {
    const value = JSON.parse(rawJson) as unknown;
    const reply = (value && typeof value === "object" ? value : {}) as Partial<ToolReply>;
    return {
      content: typeof reply.content === "string" ? reply.content : "",
      calls: Array.isArray(reply.calls) ? reply.calls : [],
    };
  } catch {
    return null;
  }
}

/** ToolReply 里的一次调用：run_code 真执行，其余（或参数不是程序）记一条 defect。 */
async function runReplyCall(
  raw: unknown,
  request: SpeechRequest,
  options: PtcOptions,
): Promise<PtcResult> {
  const call = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const name = typeof call.name === "string" ? call.name : "";
  const argumentsText = typeof call.arguments === "string" ? call.arguments : "";
  if (name !== RUN_CODE) {
    return {
      acts: [],
      defects: [{ kind: "unknown", text: `${name}(${argumentsText})` }],
      queries: [],
    };
  }
  const code = readObject(argumentsText)?.code;
  if (typeof code !== "string") {
    return { acts: [], defects: [{ kind: "unparseable", text: argumentsText }], queries: [] };
  }
  return executeProgram(code, request, options);
}

/**
 * 读一次发言模型的原文（ToolReply 的 JSON），逐个 run_code 真执行。工具之外的文字、不认识的工具、
 * 不是 JSON 的参数只记 defect；query 的记录一并交回，供外壳结算（相册、找群、执行代理）。
 */
export async function executeToolReply(
  rawJson: string,
  request: SpeechRequest,
  options: PtcOptions = {},
): Promise<{ decision: { acts: Act[] }; defects: Defect[]; queries: PtcRecord[] }> {
  const reply = parseReply(rawJson);
  if (!reply) {
    return {
      decision: { acts: [] },
      defects: [{ kind: "unparseable", text: rawJson }],
      queries: [],
    };
  }

  const acts: Act[] = [];
  const defects: Defect[] = [];
  const queries: PtcRecord[] = [];
  const stray = reply.content.trim();
  if (stray) defects.push({ kind: "stray", text: stray });

  for (const call of reply.calls) {
    const run = await runReplyCall(call, request, options);
    if (run.acts.some(isOutward)) {
      for (const q of queries) if (q.error === undefined) q.actedAfter = true;
    }
    acts.push(...run.acts);
    defects.push(...run.defects);
    queries.push(...run.queries);
  }
  return { decision: { acts }, defects, queries };
}
