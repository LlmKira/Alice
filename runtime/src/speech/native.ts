/**
 * 原生工具格式（ADR-298，docs/spec/greenfield-native-agent.md 第二节）：发言调用直接给模型一组函数，不包 run_code。
 *
 * 同一件事的几种动作并成一个工具（MERGED），参数是登记表里这几行参数的并集，action 选做哪一种（不写就是第一种）。
 * 这样常驻的工具不超过 12 个，她能做的事一样不少；其余动作一项一个工具，只在此刻做得到时出现。
 *
 * 一轮怎么走：没调查询工具就一次调用结束，没有总结轮；调了，结果作为 role:"tool" 交回，她接着决定，
 * 最多 MAX_ROUNDS 次调用。翻过相册才给 send_photo；读过外面的内容之后不再给退群、加群（readOutside 的同一条不变量）。
 * 工具之外写的字不发出去，记成 stray。
 */
import { z } from "zod";
import { isQueryKind, type PtcRecord, type QueryHandler } from "../llm/ptc.js";
import type { ChatMessage } from "../llm/speech-model.js";
import {
  type Act,
  type ActKind,
  type Affordance,
  affordanceOf,
  affordances,
  argValues,
  memberAfter,
} from "../mind/affordances.js";
import { type ArgContext, buildAct } from "../mind/args.js";
import type { SpeechRequest } from "../mind/effects.js";
import type { SpeechDecision } from "../mind/events.js";
import {
  argEnum,
  type DecisionStyle,
  type Defect,
  describeAct,
  styleProse,
  type ToolSpec,
} from "./decision.js";
import { readObject } from "./json.js";
import { renderSpeechPrompt, type SpeechPrompt, speechLook } from "./prompt.js";

const MAX_ROUNDS = 4;
const MAX_RESULT_CHARS = 4000;
const PRIVATE_NOTE = "internal only, never sent to chat";

/** 并成一个工具的动作，第一种是不写 action 时做的那种。没列的动作各是一个工具，名字是登记表的 name。 */
const MERGED: Record<string, readonly ActKind[]> = {
  say: ["send", "voice", "edit"],
  inner: ["think", "let-go"],
  intend: ["intend", "fulfil"],
  topic: ["topic-open", "topic-advance", "topic-close"],
  look_up: ["delegate", "chat-search"],
  recall: ["recall", "note-self"],
};
const mergedInto = new Map(
  Object.entries(MERGED).flatMap(([name, kinds]) => kinds.map((k) => [k, name] as const)),
);
const toolName = (kind: ActKind) => mergedInto.get(kind) ?? affordanceOf(kind).name;
const isPrivate = (rows: readonly Affordance[]) => rows.every((r) => r.via === "mind");

interface Tool {
  name: string;
  rows: Affordance[];
}

/** 此刻的工具：先是做出来的事，再是她心里的事。已读不列：不调工具就是不说话。 */
export function nativeTools(offered: readonly ActKind[]): Tool[] {
  const tools = new Map<string, Tool>();
  for (const row of affordances) {
    if (row.kind === "mark-read" || !offered.includes(row.kind)) continue;
    const name = toolName(row.kind);
    const kinds = MERGED[name] ?? [row.kind];
    if (!tools.has(name))
      tools.set(name, { name, rows: kinds.filter((k) => offered.includes(k)).map(affordanceOf) });
  }
  const list = [...tools.values()];
  return [...list.filter((t) => !isPrivate(t.rows)), ...list.filter((t) => isPrivate(t.rows))];
}

function specOf(
  { name, rows }: Tool,
  style?: DecisionStyle,
  stickers?: readonly string[],
): ToolSpec {
  const about = (r: Affordance) => describeAct(r, style, stickers, "native");
  const many = rows.length > 1;
  const text = many
    ? `action (default: ${rows[0]?.name}): ${rows.map((r) => `${r.name}: ${about(r)}`).join("; ")}`
    : rows.map(about).join("");
  const properties: Record<string, object> = many
    ? { action: { type: "string", enum: rows.map((r) => r.name) } }
    : {};
  for (const spec of rows.flatMap((r) => r.args)) {
    const values = spec.kind === "sticker" ? null : argEnum(spec);
    properties[spec.field] ??= {
      type: "string",
      ...(values ? { enum: [...values] } : {}),
      description: spec.about,
    };
  }
  // 并起来的工具不标必填：哪些参数必填要看选了哪种，由 buildAct 按那一行登记表查。
  const required = many
    ? []
    : rows.flatMap((r) => r.args.filter((a) => !a.optional).map((a) => a.field));
  return {
    type: "function",
    function: {
      name,
      description: isPrivate(rows) ? `[${PRIVATE_NOTE}] ${text}` : text,
      parameters: {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
      },
    },
  };
}

/** 一次调用落成的动作；不认识、此刻做不到、参数不对的是缺陷。 */
function actOf(
  call: { name: string; arguments: string },
  tools: readonly Tool[],
  ctx: ArgContext,
): { act: Act } | { defect: Defect } {
  const tool = tools.find((t) => t.name === call.name);
  if (!tool) return { defect: { kind: "unknown", text: `${call.name}(${call.arguments})` } };
  const args = readObject(call.arguments);
  if (!args) return { defect: { kind: "unparseable", text: call.arguments } };
  const row =
    args.action === undefined ? tool.rows[0] : tool.rows.find((r) => r.name === args.action);
  const act = row ? buildAct(row.kind, args, ctx) : null;
  return act ? { act } : { defect: { kind: "args", text: `${call.name}(${call.arguments})` } };
}

/** 模型的回复（llm/speech-model.ts 写成的 JSON）：content 是工具之外的字。 */
const REPLY = z.object({
  content: z.string().default(""),
  calls: z
    .array(
      z.object({
        id: z.string().optional(),
        name: z.string(),
        arguments: z.string(),
        extra_content: z.unknown(),
      }),
    )
    .default([]),
  reasoning_content: z.string().optional(),
});
type Reply = z.infer<typeof REPLY>;

function parseReply(raw: string): Reply | null {
  try {
    return REPLY.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export const nativeMode = {
  rules(rows: readonly Affordance[], style: DecisionStyle = "default"): string {
    const queries = nativeTools(rows.map((r) => r.kind))
      .filter((t) => t.rows.some((r) => isQueryKind(r.kind)))
      .map((t) => t.name);
    const note =
      queries.length > 0 ? `；${queries.join("、")}会把结果直接交回给你，看完再接着决定` : "";
    const lead = `接着聊天记录，直接调用你要用的工具。想连续发几条短消息就调用几次 say${note}。`;
    const body = rows.some((r) => r.kind === "send")
      ? [
          `${lead}标着“${PRIVATE_NOTE}”的工具不会发出去；直接写的纯文本也不会发出去。`,
          styleProse(style, "native"),
        ]
      : [`${lead}什么都不想做，就不调用任何工具。`];
    return ["## 怎么写", ...body].join("\n\n");
  },

  render(acts: readonly Act[]): string {
    if (acts.length === 0) return "（不调用工具）";
    return acts
      .map((a) => {
        const name = toolName(a.kind);
        const notDefault = MERGED[name] !== undefined && MERGED[name][0] !== a.kind;
        const fields = [
          ...(notDefault ? [`action: ${JSON.stringify(affordanceOf(a.kind).name)}`] : []),
          ...argValues(a).flatMap(({ spec, value }) =>
            value === null ? [] : [`${spec.field}: ${JSON.stringify(value)}`],
          ),
        ];
        return `${name}(${fields.length > 0 ? `{ ${fields.join(", ")} }` : ""})`;
      })
      .join("\n");
  },

  tools(
    offered: readonly ActKind[],
    style?: DecisionStyle,
    stickers?: readonly string[],
  ): ToolSpec[] {
    return nativeTools(offered).map((t) => specOf(t, style, stickers));
  },

  hint(foreign: string | null, chatType: "group" | "private" = "group", platform?: string): string {
    const reactHint = platform === "qq" ? "" : "，也可只点个表情";
    if (foreign === null) return `随手接一两条${reactHint}，不想开口就不调用对外工具`;
    return chatType === "group"
      ? `如要说话请用${foreign}，顺着这个群的说话习惯随手发一两条${reactHint}，不想开口就不调用对外工具`
      : `如要说话请用${foreign}，随手接一两条${reactHint}，不想开口就不调用对外工具`;
  },
};

export interface NativeTurnOptions {
  persona: string;
  request: SpeechRequest;
  /** 已经渲染好的第一轮提示词（离线批量渲染后回放）。 */
  initialPrompt?: SpeechPrompt;
  callModel: (prompt: SpeechPrompt) => Promise<string>;
  onQuery?: QueryHandler;
  signal?: AbortSignal;
}

/** 一轮里累积的东西。offered 随查询结果变：翻过相册多出 send_photo，读过外面的内容少了退群、加群。 */
interface Turn {
  offered: readonly ActKind[];
  acts: Act[];
  defects: Defect[];
  /** 每次查询，和查询时已经做了几件事（看查完之后有没有对外的动作）。 */
  queries: Array<{ record: PtcRecord; before: number }>;
}

function offeredAfter(offered: readonly ActKind[], kind: ActKind): readonly ActKind[] {
  if (kind === "album-search") return [...offered, "album-send"];
  if (affordanceOf(kind).outside === true)
    return offered.filter((k) => memberAfter(affordanceOf(k)) === undefined);
  return offered;
}

async function ask(act: Act, o: NativeTurnOptions): Promise<PtcRecord> {
  try {
    if (!o.onQuery || !isQueryKind(act.kind)) throw new Error(`no query handler for ${act.kind}`);
    const args = Object.fromEntries(argValues(act).map((a) => [a.spec.field, a.value]));
    const signal = o.signal ?? new AbortController().signal;
    return { act, result: await o.onQuery(act.kind, args, signal) };
  } catch (error) {
    return { act, error: String(error) };
  }
}

/** 执行一次调用，返回交回给模型的结果；查询的结果原样交回。 */
async function run(
  call: { name: string; arguments: string },
  tools: readonly Tool[],
  turn: Turn,
  o: NativeTurnOptions,
): Promise<unknown> {
  const got = actOf(call, tools, { timeline: o.request.timeline, now: o.request.at });
  if ("defect" in got) {
    turn.defects.push(got.defect);
    return { error: `${got.defect.kind}: ${call.name}` };
  }
  if (!isQueryKind(got.act.kind)) {
    turn.acts.push(got.act);
    return { ok: true };
  }
  const record = await ask(got.act, o);
  turn.queries.push({ record, before: turn.acts.length });
  if (record.error !== undefined) return { error: record.error };
  turn.offered = offeredAfter(turn.offered, got.act.kind);
  return record.result;
}

function toolMessage(id: string, result: unknown): ChatMessage {
  const text = JSON.stringify(result ?? null);
  const content = text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…` : text;
  return { role: "tool", tool_call_id: id, content };
}

function assistantMessage(
  reply: Reply,
  calls: ReadonlyArray<Reply["calls"][number] & { id: string }>,
): ChatMessage {
  return {
    role: "assistant",
    content: reply.content,
    tool_calls: calls.map((c) => ({
      id: c.id,
      type: "function" as const,
      function: { name: c.name, arguments: c.arguments },
      ...(c.extra_content === undefined ? {} : { extra_content: c.extra_content }),
    })),
    ...(reply.reasoning_content === undefined
      ? {}
      : { reasoning_content: reply.reasoning_content }),
  };
}

/** 查到了、之后有对外的动作：结果用上了（actedAfter）；没查成、之后也没有对外动作：没接住（uncaught）。 */
function markQueries(turn: Turn): void {
  for (const { record, before } of turn.queries) {
    const outwardAfter = turn.acts.slice(before).some((a) => affordanceOf(a.kind).via !== "mind");
    if (record.error === undefined && outwardAfter) record.actedAfter = true;
    if (record.error !== undefined && !outwardAfter) record.uncaught = true;
  }
}

/** 一轮原生工具对话：她做的事、格式缺陷和查询记录（shell.ts 按它们记 act.done / act.failed）。 */
export async function executeNativeTurn(
  o: NativeTurnOptions,
): Promise<{ decision: SpeechDecision; defects: Defect[]; queries: PtcRecord[] }> {
  const first = o.initialPrompt ?? renderSpeechPrompt(o.persona, o.request, { format: "native" });
  const look = speechLook(o.request);
  const messages: ChatMessage[] = [
    { role: "system", content: first.system },
    { role: "user", content: first.user },
  ];
  const turn: Turn = {
    offered: [...o.request.affordances, "mark-read"],
    acts: [],
    defects: [],
    queries: [],
  };

  for (let n = 1; n <= MAX_ROUNDS && o.signal?.aborted !== true; n++) {
    const tools = nativeTools(turn.offered);
    const prompt =
      n === 1
        ? first
        : {
            ...first,
            tools: nativeMode.tools(turn.offered, look.style, look.stickers),
            messages: [...messages],
          };
    const raw = await o.callModel(prompt);
    const reply = parseReply(raw);
    if (!reply) {
      turn.defects.push({ kind: "unparseable", text: raw });
      break;
    }
    if (reply.content.trim()) turn.defects.push({ kind: "stray", text: reply.content.trim() });
    const calls = reply.calls.map((c, i) => ({ ...c, id: c.id ?? `native_${n}_${i}` }));
    const asked = turn.queries.length;
    const answers: ChatMessage[] = [];
    for (const call of calls) answers.push(toolMessage(call.id, await run(call, tools, turn, o)));
    // 这一轮没有要等的结果：当场结束，不让模型再写一轮总结。
    if (turn.queries.length === asked) break;
    messages.push(assistantMessage(reply, calls), ...answers);
  }

  markQueries(turn);
  return {
    decision: { acts: turn.acts },
    defects: turn.defects,
    queries: turn.queries.map((q) => q.record),
  };
}
