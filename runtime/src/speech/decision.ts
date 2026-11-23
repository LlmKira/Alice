/**
 * 动作格式 Code Mode（DeepSeek Harness 的 PTC、Cloudflare Code Mode；eval-artifacts/exec-mode/）：给模型的
 * 输出说明和 SDK（rules）、提示词示例的写法（render）、线上的 run_code（tools）和对模型输出的静态解析（parse），
 * 全部按 affordance 登记表通用处理。
 */
import ts from "typescript";
import {
  type Act,
  type ActKind,
  type Affordance,
  type ArgKind,
  type ArgSpec,
  affordanceOf,
  affordances,
  argValues,
  SECRET,
} from "../mind/affordances.js";
import { type ArgContext, buildAct } from "../mind/args.js";
import type { SpeechRequest } from "../mind/effects.js";
import type { SpeechDecision } from "../mind/events.js";
import {
  COMMON_REACTIONS,
  defaultStickerHints,
  enrichStickerHint,
  REACTIONS,
  STICKER_WORDS,
} from "../mind/words.js";
import { readObject } from "./json.js";

/**
 * 说明文字（怎么写的正文、say 和 sticker 的补充说明、回合最后一行）是 2026-11-13 上线的 Gemini 改稿
 * （/home/alice/.local/share/alice-briefs/prompt-gemini/out.md 改稿 1、2、5；docs/adr/282-speech-style-and-room-voice.md：
 * real-v1 开发集两遍，挑毛病 24 : 8，正面问法 37 : 19，风格五项里四项落进同群活跃真人的 p10–p90）。
 */
const SAY_GUIDE =
  "One message per call; call say multiple times for separate thoughts; omit replyTo when continuing directly";
const CHARM_SAY_GUIDE = SAY_GUIDE;
const CHARM_STICKER_SAY_GUIDE = SAY_GUIDE;
const STICKER_GUIDE = `Send a sticker using a keyword (${STICKER_WORDS.join(", ")}) or a short description of the mood or scene`;
const STICKER_GUIDE_OPEN = STICKER_GUIDE;
const EMOJI_GUIDE = `Common reactions: ${COMMON_REACTIONS.join(" ")}`;
const MOOD_GUIDE = "use your own words for mood";

/** 可选参数在说明里的称呼。 */
function placeholder(kind: ArgKind, slot?: string): string {
  switch (kind) {
    case "text":
      return slot ?? "text";
    case "message":
    case "own":
    case "recent":
      return "id";
    case "emoji":
      return "👍";
    case "sticker":
      return "word";
    case "mood":
      return "mood";
    case "when":
      return "when";
    case "secret":
      return SECRET;
  }
}

const slotOf = (spec: ArgSpec): string => placeholder(spec.kind, spec.slot);

/** 动作格式：code 是 run_code（ADR-280），native 是原生工具（speech/native.ts，ADR-298）。 */
export type SpeechFormat = "code" | "native";

/** 发言说明的口吻；默认就是线上那一份。 */
export type DecisionStyle = "default" | "charm" | "charm-sticker" | "vs" | "composite";

/** 发言说明按口吻换；没列的口吻用线上那一份 SAY_GUIDE。 */
const SAY_GUIDES = new Map<DecisionStyle, string>([
  ["charm", CHARM_SAY_GUIDE],
  ["charm-sticker", CHARM_STICKER_SAY_GUIDE],
]);
const IMPULSE_GUIDE =
  "Catch your honest first impulse (a tease, a personal detail, or just a reaction/sticker) rather than a generic reply";
/** 心里想一想那一行在候选口吻下的补充说明；默认口吻没有。 */
const THINK_GUIDES = new Map<DecisionStyle, string>([
  [
    "vs",
    "Briefly consider 2-3 different first reactions in your head, then pick the most natural one to say",
  ],
  ["composite", IMPULSE_GUIDE],
  ["charm-sticker", IMPULSE_GUIDE],
]);

/** 她心里的事：心情用自己的话说，再列出可选参数各是什么；都没有时不写。 */
function mindGuide(row: Affordance): string | null {
  const optional = row.args
    .filter((a) => a.optional && a.kind !== "secret")
    .map((a) => `${slotOf(a)}: ${a.about}`);
  const mood = row.args.some((a) => a.kind === "mood") ? [MOOD_GUIDE] : [];
  const parts = [...mood, ...optional];
  return parts.length > 0 ? parts.join("; ") : null;
}

/** 一行动作的补充说明：发言、贴纸、表情各有共用说明，她心里的事说明可选参数，其余没有。 */
function guideOf(
  row: Affordance,
  style: DecisionStyle = "default",
  format: SpeechFormat = "code",
): string | null {
  if (row.kind === "send") return SAY_GUIDES.get(style) ?? SAY_GUIDE;
  if (row.args.some((a) => a.kind === "sticker")) {
    return style === "charm-sticker" ? STICKER_GUIDE_OPEN : STICKER_GUIDE;
  }
  if (row.args.some((a) => a.kind === "emoji")) return EMOJI_GUIDE;
  const think = row.kind === "think" ? THINK_GUIDES.get(style) : undefined;
  if (think) return think;
  // 原生工具的参数各有自己的说明（native.ts），不在工具说明里再抄一遍。
  if (row.via === "mind" && format === "native") {
    return row.args.some((a) => a.kind === "mood") ? MOOD_GUIDE : null;
  }
  if (row.via === "mind") return mindGuide(row);
  return null;
}

/** 贴纸那一行列出手头的贴纸；charm-sticker 口吻没给贴纸时用默认的一组，并都补上画面描述。 */
function stickerBagOf(
  row: Affordance,
  style: DecisionStyle,
  stickers: readonly string[] | undefined,
): string | null {
  if (row.kind !== "sticker") return null;
  const resolved =
    style === "charm-sticker"
      ? (stickers && stickers.length > 0 ? stickers : defaultStickerHints(14)).map(
          enrichStickerHint,
        )
      : stickers;
  return resolved && resolved.length > 0 ? `手头贴纸有：${resolved.join("、")}等` : null;
}

/**
 * 查询类动作说明里写明会返回什么、拿到以后怎么接：native 是原生多轮工具，看完结果再接着调；
 * code 是同一段程序里接着用（recall 在 code 里不写）。
 */
const RETURNS_NOTES: Record<SpeechFormat, Partial<Record<ActKind, string>>> = {
  native: {
    "album-search": "Returns matching photos (asset, description, caption); call send_photo next",
    "chat-search": "Returns matching groups/channels (scope, kind, title, about, members, recent)",
    delegate: "Returns lookup text; continue based on the result",
    "dm-check": "Returns source-group DM history and guarded status (canDmDirectly, protocol)",
    recall: "Returns matching memory notes",
  },
  code: {
    "album-search":
      "Returns matching photos (asset, description, caption); pass an asset to tools.send_photo({ asset }) in the same script",
    "chat-search": "Returns matching groups/channels (scope, kind, title, about, members, recent)",
    delegate:
      "Returns lookup text; you can handle it and call tools.say({ text }) in the same script or after seeing the result",
    "dm-check":
      "Returns source-group DM history and guarded status (canDmDirectly, protocol); decide whether to say, stay silent, or defer with plan_group_dm",
  },
};

/** 一行动作给模型看的说明（SDK 里那一行的注释）：登记表的说明，加上补充说明。 */
export function describeAct(
  row: Affordance,
  style: DecisionStyle = "default",
  stickers?: readonly string[],
  format: SpeechFormat = "code",
): string {
  const parts = [
    row.hint,
    guideOf(row, style, format),
    stickerBagOf(row, style, stickers),
    RETURNS_NOTES[format][row.kind],
  ].filter(Boolean);
  return parts.join("; ");
}

/**
 * 格式缺陷：unparseable 读不出（语法错、参数不是 JSON）；stray 工具之外的文字；unknown 不认识或此刻不能做的
 * 动作；args 参数不对；code 程序里直线 `await tools.x({…})` 之外的语句。只作诊断，不执行。
 */
type DefectKind = "unparseable" | "stray" | "unknown" | "args" | "code";
export interface Defect {
  kind: DefectKind;
  text: string;
}

/** OpenAI 兼容接口的函数声明。 */
export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
/** 带工具时模型的原文写成这个 JSON（llm/speech-model.ts）：content 是工具之外的文字。 */
export interface ToolReply {
  content: string;
  calls: Array<{ id?: string; name: string; arguments: string; extra_content?: unknown }>;
  reasoning_content?: string;
}

const RUN_CODE = "run_code";
const INNER = "internal only, never sent to chat";
/** 发言层只保留工具与物理边界事实，不在这里催演俏皮反问、不硬编码单一平台、不微操标点与句式。 */
const STYLE_BODY = [
  "群里多人交叉聊天时，隔着几条接某人的话带上 replyTo；紧挨着接话、别人刚回复你或自己另起话头直接发就行。",
];

/** 发言边界提示；默认 codeMode 与 native 共用同一套极简边界。 */
export function styleProse(
  _style: DecisionStyle = "default",
  format: SpeechFormat = "code",
): string {
  const tail =
    format !== "code"
      ? "话到嘴边再发；插不上嘴、没话接或刚连发了几句时，不调用对外工具一样在场。直接写的纯文本不会发出去，想说话必须调用 say。"
      : "话到嘴边再发；插不上嘴、没话接或刚连发了几句时，不调用 run_code 一样在场。run_code 之外写的字不会发出去。";
  return [...STYLE_BODY, tail].join("\n\n");
}

const STYLE_DEFAULT = styleProse("default", "code");
const STYLE_CHARM = STYLE_DEFAULT;
const STYLE_CHARM_STICKER = STYLE_DEFAULT;

const byName = new Map(affordances.map((a) => [a.name, a]));

/**
 * 列出的动作：先是做出来的事，再是她心里的事。不列已读（不调用 run_code 就是不说话），解析照样认。
 */
const shown = (rows: readonly Affordance[]): Affordance[] => {
  const listed = rows.filter((r) => r.kind !== "mark-read");
  return [...listed.filter((r) => r.via !== "mind"), ...listed.filter((r) => r.via === "mind")];
};
/** 注释里的说明：她心里的事前面注明只有她看得到。 */
const described = (
  row: Affordance,
  style: DecisionStyle = "default",
  stickers?: readonly string[],
  format: SpeechFormat = "code",
) =>
  row.via === "mind"
    ? `[${INNER}] ${describeAct(row, style, stickers, format)}`
    : describeAct(row, style, stickers, format);

export function argEnum(spec: ArgSpec): readonly string[] | null {
  if (spec.kind === "sticker") return STICKER_WORDS;
  if (spec.kind === "emoji") return REACTIONS;
  if (spec.kind === "secret") return [SECRET];
  return null;
}

const doc = (text: string, indent: number) =>
  `${"  ".repeat(indent)}/** ${text.replace(/\s+/g, " ").trim().replaceAll("*/", "*\\/")} */`;

/** 参数对象的 TypeScript 类型，按 DSH jsonSchemaToTs 的写法（属性带注释，枚举写成字面量的联合）。 */
function argsType(row: Affordance, indent: number): string {
  if (row.args.length === 0) return "Record<string, never>";
  const lines = row.args.flatMap((a) => {
    const values = argEnum(a);
    const baseType = values ? values.map((v) => JSON.stringify(v)).join(" | ") : "string";
    const type = values && a.kind === "sticker" ? `${baseType} | string` : baseType;
    return [
      doc(a.about, indent + 1),
      `${"  ".repeat(indent + 1)}${a.field}${a.optional ? "?" : ""}: ${type};`,
    ];
  });
  return ["{", ...lines, `${"  ".repeat(indent)}}`].join("\n");
}

const QUERY_RETURNS: Record<string, string> = {
  search_album:
    "Array<{ asset: string; caption: string | null; description: string | null; sender: string; ago: string }>",
  find_chats:
    'Array<{ scope: string; kind: "group" | "channel"; title: string; about: string | null; members: number | null; recent: string[] }>',
  look_up: "string",
};

/** 系统提示里的 SDK（DSH renderToolsSdk 的形状：ToolArgsMap 加 declare const tools）。 */
function sdk(
  rows: readonly Affordance[],
  style: DecisionStyle = "default",
  stickers?: readonly string[],
): string {
  const visible = shown(rows);
  const members = visible.flatMap((row) => [
    doc(described(row, style, stickers), 1),
    `${"  ".repeat(1)}${row.name}: ${argsType(row, 1)};`,
  ]);
  const branches = visible
    .filter((r) => r.name in QUERY_RETURNS)
    .map((r) => `K extends ${JSON.stringify(r.name)} ? ${QUERY_RETURNS[r.name]}`);
  const ret = branches.length > 0 ? `${branches.join(" : ")} : void` : "void";
  return [
    "```ts",
    `interface ToolArgsMap {\n${members.join("\n")}\n}`,
    "",
    `type ToolReturn<K extends keyof ToolArgsMap> = ${ret};`,
    "",
    "declare const tools: {\n  [K in keyof ToolArgsMap]: (args: ToolArgsMap[K]) => Promise<ToolReturn<K>>;\n};",
    "```",
  ].join("\n");
}

/** tools.x 或 tools["x"] 的名字；别的写法返回 null。 */
function toolName(callee: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    return callee.expression.text === "tools" ? callee.name.text : null;
  }
  if (
    ts.isElementAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "tools" &&
    ts.isStringLiteral(callee.argumentExpression)
  ) {
    return callee.argumentExpression.text;
  }
  return null;
}

/** 一个字面量对象参数（字符串、数字、null）；没有参数是空对象；别的写法返回 null。 */
function literalArgs(args: ts.NodeArray<ts.Expression>): Record<string, string | null> | null {
  if (args.length === 0) return {};
  const [only] = args;
  if (args.length > 1 || !only || !ts.isObjectLiteralExpression(only)) return null;
  const out: Record<string, string | null> = {};
  for (const p of only.properties) {
    if (!ts.isPropertyAssignment(p)) return null;
    const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
    if (key === null) return null;
    const value = literalValue(p.initializer);
    if (value === undefined) return null;
    out[key] = value;
  }
  return out;
}

/** 一个参数值：字符串和数字取原文，null 是 null；别的写法返回 undefined。 */
function literalValue(v: ts.Expression): string | null | undefined {
  if (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v) || ts.isNumericLiteral(v)) {
    return v.text;
  }
  if (v.kind === ts.SyntaxKind.NullKeyword) return null;
  // 标记写成 true / false 也认（args.ts 只把 true 当作标了）。
  if (v.kind === ts.SyntaxKind.TrueKeyword) return "true";
  if (v.kind === ts.SyntaxKind.FalseKeyword) return "false";
  return undefined;
}

/** 包成 async 函数读出语句；有语法错返回 null。 */
function programBody(code: string): { file: ts.SourceFile; body: readonly ts.Statement[] } | null {
  const wrapped = `async function run() {\n${code}\n}`;
  const checked = ts.transpileModule(wrapped, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  });
  if ((checked.diagnostics ?? []).length > 0) return null;
  const file = ts.createSourceFile("run.ts", wrapped, ts.ScriptTarget.ESNext, true);
  const body = (file.statements[0] as ts.FunctionDeclaration).body?.statements ?? [];
  return { file, body };
}

/** 直线的 `await tools.x(…)` 语句里的调用和工具名；别的写法返回 null。 */
function awaitedToolCall(st: ts.Statement): { call: ts.CallExpression; name: string } | null {
  if (
    !ts.isExpressionStatement(st) ||
    !ts.isAwaitExpression(st.expression) ||
    !ts.isCallExpression(st.expression.expression)
  ) {
    return null;
  }
  const call = st.expression.expression;
  const name = toolName(call.expression);
  return name === null ? null : { call, name };
}

/** 一次调用落成的动作；不认识或此刻不能做的记 unknown，参数不对的记 args。 */
function actOfCall(
  found: { call: ts.CallExpression; name: string },
  offered: ReadonlySet<ActKind>,
  ctx: ArgContext,
): Act | "unknown" | "args" {
  const row = byName.get(found.name);
  if (!row || !offered.has(row.kind)) return "unknown";
  const args = literalArgs(found.call.arguments);
  return (args ? buildAct(row.kind, args, ctx) : null) ?? "args";
}

/**
 * 静态读一段 run_code 程序（从不执行）：包成 async 函数，有语法错就整段不算（真执行也一件都做不成）；
 * 否则逐句读，直线的 `await tools.x({字面量})` 记成动作，`return;` 到此为止，其余语句记为缺陷。
 */
export function walkProgram(
  code: string,
  request: SpeechRequest,
): { acts: Act[]; defects: Defect[] } {
  const program = programBody(code);
  if (!program) return { acts: [], defects: [{ kind: "unparseable", text: code }] };
  const ctx: ArgContext = { timeline: request.timeline, now: request.at };
  const offered = new Set(request.affordances);
  const out: { acts: Act[]; defects: Defect[] } = { acts: [], defects: [] };
  for (const st of program.body) {
    if (ts.isEmptyStatement(st)) continue;
    if (ts.isReturnStatement(st) && !st.expression) break;
    const text = st.getText(program.file);
    const found = awaitedToolCall(st);
    if (!found) {
      out.defects.push({ kind: "code", text });
      if (ts.isReturnStatement(st)) break;
      continue;
    }
    const act = actOfCall(found, offered, ctx);
    if (typeof act === "string") out.defects.push({ kind: act, text });
    else out.acts.push(act);
  }
  return out;
}

/**
 * 她的动作是系统提示里一份 TypeScript SDK，她调用一次原生工具 run_code，code 是一个 async 函数的函数体。
 * 程序从不执行，按语法树静态读。和续写式比，该用时用心里的动作多（单轮场景 57% 对 22%），缺陷不升，
 * opus 成对判 P 49、A 25。
 */
export const codeMode = {
  /** 接在人格后面的输出说明和 SDK，只列此刻可用的动作。style 是候选口吻，默认线上那一份。 */
  rules(
    rows: readonly Affordance[],
    style: DecisionStyle = "default",
    stickers?: readonly string[],
  ): string {
    const canSay = rows.some((r) => r.kind === "send");
    const queries = shown(rows)
      .filter((r) => r.name in QUERY_RETURNS)
      .map((r) => r.name);
    const queryNote =
      queries.length > 0
        ? `；查询类动作（${queries.join("、")}）会当场返回结果，你可以用 const、if、for、try/catch 接着串联下一步`
        : "";
    const lead = `接着聊天记录，调用 run_code 做你此刻要做的事。code 是一个 async TypeScript 函数的函数体：一行写一个 await tools.名字({ … })，按顺序执行${queryNote}。`;
    return [
      "## 怎么写",
      ...(canSay
        ? [
            `${lead}说话也用它，每条消息 await tools.say({ text: "…" }) 一次。`,
            style === "charm"
              ? STYLE_CHARM
              : style === "charm-sticker"
                ? STYLE_CHARM_STICKER
                : STYLE_DEFAULT,
          ]
        : [`${lead}什么都不想做，就不调用 run_code。`]),
      "",
      "下面的声明是这段程序里能用的 tools，不是单独的工具；注释里标着“只有你自己看得到”的那几样不会发出去。",
      sdk(rows, style, stickers),
    ].join("\n");
  },
  /** 提示词示例里一个决定的写法（就是她要交回的程序）。 */
  render(acts: readonly Act[]): string {
    if (acts.length === 0) return "（不调用 run_code）";
    return acts
      .map((a) => {
        const fields = argValues(a).flatMap(({ spec, value }) =>
          value === null ? [] : [`${spec.field}: ${JSON.stringify(value)}`],
        );
        const name = affordanceOf(a.kind).name;
        return `await tools.${name}({${fields.length ? ` ${fields.join(", ")} ` : ""}});`;
      })
      .join("\n");
  },
  /** 线上的原生工具：只有 run_code 一个。 */
  tools(): ToolSpec[] {
    return [
      {
        type: "function",
        function: {
          name: RUN_CODE,
          description:
            "执行一段 TypeScript 程序，调用 tools 做事。参数 code：一个 async 函数的函数体（只用可擦除的语法，顶层可以 await），按系统提示里的声明调用 await tools.名字(参数)。",
          parameters: {
            type: "object",
            properties: {
              code: { type: "string", description: "程序：一个 async TypeScript 函数的函数体" },
            },
            required: ["code"],
            additionalProperties: false,
          },
        },
      },
    ];
  },
  /** 回合 anchor 里"默认……不想说就……"那半句（foreign 是她该说的语言，中文时为 null）。 */
  hint(foreign: string | null, chatType: "group" | "private" = "group"): string {
    if (!foreign) return "随手接一两条，也可只点个表情，不想开口就不调用 run_code";
    return chatType === "group"
      ? `如要说话请用${foreign}，顺着这个群的说话习惯随手发一两条，也可只点个表情，不想开口就不调用 run_code`
      : `如要说话请用${foreign}，随手接一两条，也可只点个表情，不想开口就不调用 run_code`;
  },
  /** 读模型原文（ToolReply 的 JSON）：每个 run_code 的程序按顺序读。 */
  parse(raw: string, request: SpeechRequest): { decision: SpeechDecision; defects: Defect[] } {
    let reply: ToolReply;
    try {
      const value = JSON.parse(raw) as Partial<ToolReply>;
      reply = { content: value.content ?? "", calls: value.calls ?? [] };
    } catch {
      return { decision: { acts: [] }, defects: [{ kind: "unparseable", text: raw }] };
    }
    const acts: Act[] = [];
    const defects: Defect[] = reply.content.trim()
      ? [{ kind: "stray", text: reply.content.trim() }]
      : [];
    for (const call of reply.calls) {
      if (call.name !== RUN_CODE) {
        defects.push({ kind: "unknown", text: `${call.name}(${call.arguments})` });
        continue;
      }
      const code = readObject(call.arguments)?.code;
      if (typeof code !== "string") {
        defects.push({ kind: "unparseable", text: call.arguments });
        continue;
      }
      const walked = walkProgram(code, request);
      acts.push(...walked.acts);
      defects.push(...walked.defects);
    }
    return { decision: { acts }, defects };
  },
};

/** 生产路径用的解析：Code Mode。 */
export function parseDecision(raw: string, request: SpeechRequest) {
  return codeMode.parse(raw, request).decision;
}

/** 一次决定里会被说出来的部分（文字与贴纸），给判别员和诊断用。 */
export function spokenOf(acts: readonly Act[]): { lines: string[]; stickers: string[] } {
  const lines: string[] = [];
  const stickers: string[] = [];
  for (const act of acts) {
    if (act.kind === "send") lines.push(act.text);
    else if (act.kind === "sticker") stickers.push(act.word);
  }
  return { lines, stickers };
}
