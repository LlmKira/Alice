/**
 * 按登记表校验动作的参数：模型写出的参数（发言层解析时、settle 落成动作时）和读回 Journal 的动作（isAct）。
 */
import {
  type Act,
  type ActKind,
  type ArgKind,
  affordanceOf,
  EDIT_WINDOW_MS,
  isActKind,
  SECRET,
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

const reactionSet = new Set<string>(REACTIONS);

/** 校验一个参数值；不合法返回 null。 */
export function argValue(kind: ArgKind, raw: unknown, ctx: ArgContext): string | null {
  // 标记：写了 "私密"（或 true）就是标了，别的都当没写。
  if (kind === "secret") return raw === SECRET || raw === true || raw === "true" ? SECRET : null;
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const value = String(raw).trim();
  switch (kind) {
    case "text":
      return value || null;
    case "message":
    case "own": {
      const id = value.replace(/^\[|\]$/g, "");
      const entry = ctx.timeline.find((t) => t.messageId === id);
      if (!entry) return null;
      if (kind === "message") return id;
      const recent = ctx.now - entry.at <= EDIT_WINDOW_MS;
      return entry.sender === null && entry.contentType === "text" && recent ? id : null;
    }
    case "emoji": {
      const emoji = normalizeEmoji(value);
      return reactionSet.has(emoji) ? emoji : null;
    }
    case "sticker":
      return stickerWord(value);
    case "mood":
      return moodWord(value);
    // 时间保留原话：认不认得出由折叠时的 parseWhen 决定，认不出就是没有约定时间。
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
