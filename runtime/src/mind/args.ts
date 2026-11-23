/**
 * 按登记表校验动作参数：包括模型写出的参数（发言层解析时、settle 生成动作时）和从 Journal 读回的动作（isAct）。
 */
import {
  type Act,
  type ActKind,
  type ArgKind,
  affordanceOf,
  EDIT_WINDOW_MS,
  isActKind,
  SECRET,
  UNSEND_WINDOW_MS,
} from "./affordances.js";
import type { TimelineEntry } from "./state.js";
import { moodWord, REACTIONS, stickerWord } from "./words.js";
/** 参数指向的那个会话此刻的样子：消息编号按它的时间线认，"她刚发的"按 now 算。 */
export interface ArgContext {
  timeline: readonly TimelineEntry[];
  now: number;
}

function normalizeEmoji(raw: string): string {
  return raw.trim().replace(/️/g, "");
}

/** 清洗工具调用 JSON 偶发吐出的末尾未配对引号（如 `捣台球好啊"`）；成对引号原样保留。 */
function stripTrailingStrayQuote(text: string): string {
  if (text.endsWith('"') && (text.match(/"/g)?.length ?? 0) % 2 === 1) {
    return text.slice(0, -1).trimEnd();
  }
  if (text.endsWith("“") && !text.includes("”")) {
    return text.slice(0, -1).trimEnd();
  }
  return text;
}

const reactionSet = new Set<string>(REACTIONS);

/**
 * 消息编号：message 是这个会话里的任何一条；own 是她自己 EDIT_WINDOW_MS 之内的文字消息（改消息）；
 * recent 是她自己 UNSEND_WINDOW_MS 之内的任何一条（撤回）。
 */
function messageArg(
  kind: "message" | "own" | "recent",
  value: string,
  ctx: ArgContext,
): string | null {
  const id = value.replace(/^\[|\]$/g, "");
  const entry = ctx.timeline.find((t) => t.messageId === id);
  if (!entry) return null;
  if (kind === "message") return id;
  if (entry.sender !== null) return null;
  const age = ctx.now - entry.at;
  if (kind === "recent") return age <= UNSEND_WINDOW_MS ? id : null;
  return entry.contentType === "text" && entry.text !== null && age <= EDIT_WINDOW_MS ? id : null;
}

/** 校验一个参数值；不合法返回 null。 */
function argValue(kind: ArgKind, raw: unknown, ctx: ArgContext): string | null {
  // 标记：写了 "私密"（或 true）就是标了，别的都当没写。
  if (kind === "secret") return raw === SECRET || raw === true || raw === "true" ? SECRET : null;
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const value = String(raw).trim();
  switch (kind) {
    case "text":
      return stripTrailingStrayQuote(value) || null;
    case "message":
    case "own":
    case "recent":
      return messageArg(kind, value, ctx);
    case "emoji": {
      const emoji = normalizeEmoji(value);
      return reactionSet.has(emoji) ? emoji : null;
    }
    case "sticker":
      return stickerWord(value);
    case "mood":
      return moodWord(value);
    // 时间保留原话：认不认得出由 fold 时的 parseWhen 决定，认不出就是没有约定时间。
    case "when":
      return value || null;
  }
}

/**
 * 按登记表把参数拼成动作。必填参数不合法时整条动作不成立；可选参数不合法时当作没给
 * （例如引用了不存在的消息，就不引用，话照说）。
 */
export function buildAct(
  kind: ActKind,
  args: Readonly<Record<string, unknown>>,
  ctx: ArgContext,
): Act | null {
  const row = affordanceOf(kind);
  const act: Record<string, unknown> = { kind };
  for (const spec of row.args) {
    const value = argValue(spec.kind, args[spec.field], ctx);
    if (value === null && !spec.optional) return null;
    // 后来加的参数没写就不写字段（之前的动作都没有它）。
    if (value === null && spec.sparse) continue;
    act[spec.field] = value;
  }
  return act as Act;
}

/** 说明必填参数为什么不合法（作为工具错误返回给模型，让它看清哪一项没写对）。 */
export function explainInvalidArgs(
  kind: ActKind,
  args: Readonly<Record<string, unknown>>,
  ctx: ArgContext,
): string {
  const row = affordanceOf(kind);
  const reasons: string[] = [];
  for (const spec of row.args) {
    if (spec.optional) continue;
    if (argValue(spec.kind, args[spec.field], ctx) !== null) continue;
    const raw = args[spec.field];
    switch (spec.kind) {
      case "message":
        reasons.push(
          `${spec.field} must be a visible message ID in the current log ("${String(raw ?? "")}" not found)`,
        );
        break;
      case "own":
        reasons.push(`${spec.field} must be one of your own text messages from the last 48h`);
        break;
      case "recent":
        reasons.push(`${spec.field} must be one of your own messages from the last 2 minutes`);
        break;
      case "emoji":
        reasons.push(`${spec.field} is not an allowed reaction emoji`);
        break;
      case "mood":
      case "sticker":
        reasons.push(`${spec.field} must be a non-empty short phrase (<= 48 chars)`);
        break;
      default:
        reasons.push(`${spec.field} cannot be empty`);
        break;
    }
  }
  return reasons.length > 0 ? reasons.join("; ") : "invalid argument format";
}

/** 读回 Journal 时校验动作形状：只有登记过的字段，类型对。 */
export function isAct(value: unknown): value is Act {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!isActKind(v.kind)) return false;
  const row = affordanceOf(v.kind);
  const fields = new Set(["kind", ...row.args.map((a) => a.field)]);
  if (Object.keys(v).some((k) => !fields.has(k))) return false;
  return row.args.every((a) =>
    a.sparse && v[a.field] === undefined
      ? true
      : a.kind === "secret"
        ? v[a.field] === SECRET
        : a.optional
          ? v[a.field] === null || typeof v[a.field] === "string"
          : typeof v[a.field] === "string",
  );
}
