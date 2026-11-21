/**
 * 动作格式 Code Mode（DeepSeek Harness 的 PTC、Cloudflare Code Mode；eval-artifacts/exec-mode/）：给模型的
 * 输出说明和 SDK（rules）、提示词示例的写法（render）、线上的 run_code（tools）和对模型输出的静态解析（parse），
 * 全部按可供性登记表通用处理。
 */
import ts from "typescript";
import {
  type Act,
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
import { COMMON_REACTIONS, REACTIONS, STICKER_WORDS } from "../mind/words.js";
import { readObject } from "./json.js";

/**
 * 说明文字（怎么写的正文、say 和 sticker 的补充说明、回合最后一行）是 2026-11-13 上线的 Gemini 改稿
 * （/home/alice/.local/share/alice-briefs/prompt-gemini/out.md 改稿 1、2、5；docs/adr/282-speech-style-and-room-voice.md：
 * real-v1 开发集两遍，挑毛病 24 : 8，正面问法 37 : 19，风格五项里四项落进同群活跃真人的 p10–p90）。
 */
const SAY_GUIDE =
  "一句一件事，可只发半句或短句，多几层意思就分几条调用 say；紧挨着接话或自己另起话头直接发";
/**
 * 候选（out-charm.md 改法 1，eval-artifacts/charm/report.md）：保留"短、拆条、少感叹号"的骨架，
 * 中文成对 11:8 胜出且单边路人感 −19.5pp（C1/C2/C3 对照均证实只有正面给出这一段才降路人感）。
 * 只是候选：线上的默认说明一字不改（下面 STYLE_DEFAULT / SAY_GUIDE）。
 */
const CHARM_SAY_GUIDE =
  "一句一件事，可只发半句或短句，多几层意思就分几条调用 say；带着自己的角度或小趣味说，紧挨着接话或自己另起话头直接发";
const STICKER_GUIDE = `偶尔发，适合接梗或轻声回应，单独一张就够，发了文字通常不再补贴纸；可用常用词（${STICKER_WORDS.join("、")}），也可以直接写几个字描述想要的感觉或画面（如 害羞偷笑、猫猫崩溃、抱抱）`;
const EMOJI_GUIDE = `常用的有 ${COMMON_REACTIONS.join(" ")}`;
const MOOD_GUIDE = "心情用你自己的词";

/** 可选参数在说明里的称呼（"时间：……"）。文字参数可以有自己的称呼（slot）。 */
function placeholder(kind: ArgKind, slot?: string): string {
  switch (kind) {
    case "text":
      return slot ?? "要说的话";
    case "message":
    case "own":
      return "编号";
    case "emoji":
      return "👍";
    case "sticker":
      return "词";
    case "mood":
      return "开心";
    case "when":
      return "时间";
    case "secret":
      return SECRET;
  }
}

const slotOf = (spec: ArgSpec): string => placeholder(spec.kind, spec.slot);

/** 发言说明的两种口吻；默认就是线上那一份。 */
export type DecisionStyle = "default" | "charm" | "vs" | "composite";

/** 一行动作的补充说明：发言、贴纸、表情各有共用说明，她心里的事说明可选参数，其余没有。 */
function guideOf(row: Affordance, style: DecisionStyle = "default"): string | null {
  if (row.kind === "send") return style === "charm" ? CHARM_SAY_GUIDE : SAY_GUIDE;
  if (row.args.some((a) => a.kind === "sticker")) return STICKER_GUIDE;
  if (row.args.some((a) => a.kind === "emoji")) return EMOJI_GUIDE;
  if (style === "vs" && row.kind === "think") {
    return "开口前先在心里闪过 2–3 个不同路子的第一反应（比如顺嘴接、反着调侃、或带出自己这边的事），挑最不像套话、最像你真会说的那个再开口";
  }
  if (style === "composite" && row.kind === "think") {
    return "开口前先在心里闪过真实的念头（想吐槽、想带出自己的事，或干脆只点个表情、发张贴纸），别挑第一句平庸的套话";
  }
  if (row.via === "mind") {
    // 标记（私密）的说明只写在参数的注释里，这里不再重复。
    const optional = row.args
      .filter((a) => a.optional && a.kind !== "secret")
      .map((a) => `${slotOf(a)}：${a.about}`);
    const mood = row.args.some((a) => a.kind === "mood") ? [MOOD_GUIDE] : [];
    const parts = [...mood, ...optional];
    return parts.length > 0 ? parts.join("；") : null;
  }
  return null;
}

/** 一行动作给模型看的说明（SDK 里那一行的注释）：登记表的说明，加上补充说明。 */
function describeAct(
  row: Affordance,
  style: DecisionStyle = "default",
  stickers?: readonly string[],
): string {
  const guide = guideOf(row, style);
  const stickerBag =
    row.kind === "sticker" && stickers?.length ? `手头贴纸有：${stickers.join("、")}等` : null;
  const ptc =
    row.kind === "album-search"
      ? "直接返回匹配到的图片列表（含 asset、description、caption）；拿到 asset 后可直接在同一段代码里 await tools.send_photo({ asset })"
      : row.kind === "chat-search"
        ? "直接返回搜到的群/频道列表（含 scope、kind、title、about、members、recent）；可在同一段代码里接着判断"
        : row.kind === "delegate"
          ? "直接返回查询结果文本；拿到结果后可在同一段代码里接着处理后再 await tools.say({ text })，也可先查完这一步、看到结果后再接话"
          : row.kind === "dm-check"
            ? "直接返回该人所在来源群的私聊接收度、近期冷却与协议建议（canDmDirectly、protocol）；拿到后按需要决定是直接说、先沉默，或用 plan_group_dm 留到群里先问"
            : null;
  const parts = [row.hint, guide, stickerBag, ptc].filter(Boolean);
  return parts.join("；");
}

/**
 * 格式缺陷：unparseable 读不出（语法错、参数不是 JSON）；stray 工具之外的文字；unknown 不认识或此刻不能做的
 * 动作；args 参数不对；code 程序里直线 `await tools.x({…})` 之外的语句。只作诊断，不执行。
 */
export type DefectKind = "unparseable" | "stray" | "unknown" | "args" | "code";
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
  calls: Array<{ name: string; arguments: string }>;
}

const RUN_CODE = "run_code";
const INNER = "只有你自己看得到，不会发出去";
/** 怎么写的正文（第四段已经并进"语言跟着走"和"run_code 之外的字不会发出去"）。 */
const STYLE_DEFAULT = [
  "在 Telegram 上随手发消息，通常想起一句发一句：话短、口语化，可省主语或用倒装，少用书面连接词和比喻；话说到哪儿就停在哪儿，半句也能发。一个念头有两三层意思，顺手拆成连续两三条短消息发，比塞进同一条更自然。",
  "群里多人交叉聊天时，隔着几条接某人的话就带上 replyTo 挂过去，接上直接说，省掉句首点名或复述前情；紧挨着上一条顺嘴搭腔、别人刚回复你而你顺着往下接、或自己另起话头时，直接发就行。",
  "情绪直接落进用词、语序和停顿里。平时打字大多素净，感叹号和句尾表情只在真激动或故意耍赖时才用；想轻声表态或顺手笑一下，单独点一个表情或发一张贴纸就够了，发了文字通常不再补贴纸。",
  "用词习惯、缩写和节奏跟着当前对话里大家正在用的那种语言走，外语保留它自己的口语习惯。话到嘴边再发；插不上嘴、没话接或刚连发了几句时，不调用 run_code 一样在场。run_code 之外写的字不会发出去。",
].join("\n\n");
/**
 * 候选的正文（out-charm.md 改法 1）：第一段只删"和比喻"，第三段把"素净"收窄成"标点保持简省"，并把
 * "顺手打个比方、带出自己这边的事、俏皮地反问或吐槽，别只干巴巴复述"正面写出来。其余两段与生产逐字相同。
 */
const STYLE_CHARM = [
  "在 Telegram 上随手发消息，通常想起一句发一句：话短、口语化，可省主语或用倒装，少用书面连接词；话说到哪儿就停在哪儿，半句也能发。一个念头有两三层意思，顺手拆成连续两三条短消息发，比塞进同一条更自然。",
  "群里多人交叉聊天时，隔着几条接某人的话就带上 replyTo 挂过去，接上直接说，省掉句首点名或复述前情；紧挨着上一条顺嘴搭腔、别人刚回复你而你顺着往下接、或自己另起话头时，直接发就行。",
  "用词要有自己的趣味和主意——顺手打个比方、带出自己这边的事、俏皮地反问或吐槽都好，别只干巴巴复述别人的话；标点保持简省，感叹号和句尾表情只在真激动或故意耍赖时才用。想轻声表态或顺手笑一下，单独点一个表情或发一张贴纸就够了，发了文字通常不再补贴纸。",
  "用词习惯、缩写和节奏跟着当前对话里大家正在用的那种语言走，外语保留它自己的口语习惯。话到嘴边再发；插不上嘴、没话接或刚连发了几句时，不调用 run_code 一样在场。run_code 之外写的字不会发出去。",
].join("\n\n");

const byName = new Map(affordances.map((a) => [a.name, a]));

/**
 * 列出的动作：先是做出来的事，再是她心里的事。不列已读（不调用 run_code 就是不说话），解析照样认。
 */
const shown = (rows: readonly Affordance[]) => {
  const listed = rows.filter((r) => r.kind !== "mark-read");
  return [...listed.filter((r) => r.via !== "mind"), ...listed.filter((r) => r.via === "mind")];
};
/** 注释里的说明：她心里的事前面注明只有她看得到。 */
const described = (
  row: Affordance,
  style: DecisionStyle = "default",
  stickers?: readonly string[],
) =>
  row.via === "mind"
    ? `（${INNER}）${describeAct(row, style, stickers)}`
    : describeAct(row, style, stickers);

function argEnum(spec: ArgSpec): readonly string[] | null {
  if (spec.kind === "sticker") return STICKER_WORDS;
  if (spec.kind === "emoji") return REACTIONS;
  if (spec.kind === "secret") return [SECRET];
  return null;
}

const pad = (n: number) => "  ".repeat(n);
const doc = (text: string, indent: number) =>
  `${pad(indent)}/** ${text.replace(/\s+/g, " ").trim().replaceAll("*/", "*\\/")} */`;

/** 参数对象的 TypeScript 类型，按 DSH jsonSchemaToTs 的写法（属性带注释，枚举写成字面量的联合）。 */
function argsType(row: Affordance, indent: number): string {
  if (row.args.length === 0) return "Record<string, never>";
  const lines = row.args.flatMap((a) => {
    const values = argEnum(a);
    const baseType = values ? values.map((v) => JSON.stringify(v)).join(" | ") : "string";
    const type = values && a.kind === "sticker" ? `${baseType} | string` : baseType;
    return [
      doc(a.about, indent + 1),
      `${pad(indent + 1)}${a.field}${a.optional ? "?" : ""}: ${type};`,
    ];
  });
  return ["{", ...lines, `${pad(indent)}}`].join("\n");
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
    `${pad(1)}${row.name}: ${argsType(row, 1)};`,
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
    const v = p.initializer;
    if (key === null) return null;
    if (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v) || ts.isNumericLiteral(v)) {
      out[key] = v.text;
    } else if (v.kind === ts.SyntaxKind.NullKeyword) {
      out[key] = null;
    } else if (v.kind === ts.SyntaxKind.TrueKeyword || v.kind === ts.SyntaxKind.FalseKeyword) {
      // 标记写成 true / false 也认（args.ts 只把 true 当作标了）。
      out[key] = v.kind === ts.SyntaxKind.TrueKeyword ? "true" : "false";
    } else return null;
  }
  return out;
}

/**
 * 静态读一段 run_code 程序（从不执行）：包成 async 函数，有语法错就整段不算（真执行也一件都做不成）；
 * 否则逐句读，直线的 `await tools.x({字面量})` 记成动作，`return;` 到此为止，其余语句记为缺陷。
 */
export function walkProgram(
  code: string,
  request: SpeechRequest,
): { acts: Act[]; defects: Defect[] } {
  const wrapped = `async function run() {\n${code}\n}`;
  const checked = ts.transpileModule(wrapped, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  });
  if ((checked.diagnostics ?? []).length > 0) {
    return { acts: [], defects: [{ kind: "unparseable", text: code }] };
  }
  const file = ts.createSourceFile("run.ts", wrapped, ts.ScriptTarget.ESNext, true);
  const body = (file.statements[0] as ts.FunctionDeclaration).body?.statements ?? [];
  const ctx: ArgContext = { timeline: request.timeline, now: request.at };
  const offered = new Set(request.affordances);
  const out: { acts: Act[]; defects: Defect[] } = { acts: [], defects: [] };
  for (const st of body) {
    if (ts.isEmptyStatement(st)) continue;
    if (ts.isReturnStatement(st) && !st.expression) break;
    const text = st.getText(file);
    const call =
      ts.isExpressionStatement(st) &&
      ts.isAwaitExpression(st.expression) &&
      ts.isCallExpression(st.expression.expression)
        ? st.expression.expression
        : null;
    const name = call ? toolName(call.expression) : null;
    if (!call || name === null) {
      out.defects.push({ kind: "code", text });
      if (ts.isReturnStatement(st)) break;
      continue;
    }
    const row = byName.get(name);
    if (!row || !offered.has(row.kind)) {
      out.defects.push({ kind: "unknown", text });
      continue;
    }
    const args = literalArgs(call.arguments);
    const act = args ? buildAct(row.kind, args, ctx) : null;
    if (act) out.acts.push(act);
    else out.defects.push({ kind: "args", text });
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
            style === "charm" ? STYLE_CHARM : STYLE_DEFAULT,
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
  /** 回合锚点里"默认……不想说就……"那半句（foreign 是她该说的语言，中文时为 null）。 */
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
