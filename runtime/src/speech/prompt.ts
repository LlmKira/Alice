/**
 * 发言提示词（context-v2，eval-artifacts/context/gemini/out.md；写法见 eval-artifacts/presentation/）。
 *
 * 系统提示：人格 → ## 怎么写（动作格式的说明）→ ## 参考（reference 的回法与示范）。
 * 用户提示：
 *   Telegram 群聊 · 2026年11月8日 周日
 *   · 我这边：……            她此刻的状态（state）
 *   · 心情：……              （mood）
 *   · 心里还记着：……        日记、刚才想过的（self、thought）
 *   · 在场的人与记忆：……    （people）
 *   · 约定与刚才的动静：……  （doings、failed、交出去还没办完的事）
 *
 *   20:58 [1] <阿杰> 今晚谁打游戏
 *   ··· 过了 35 分钟 ···
 *   21:33 * 你翻了翻相册：……
 *
 *   ---
 *   现在是 21:33。这一轮的处境（turn）
 *   [3] 之后，轮到你了（随手接一两条，也可只点个表情，不想开口就不调用 run_code）：
 * 卡片是她自己记的事，机制把它写成"我……"；记录和回合锚点对她说话（"你"）。
 * 机制只声明一样东西是哪一类（Contribution.kind），放在哪、写成什么样都在这里决定。
 */
import { affordanceOf, argValues } from "../mind/affordances.js";
import type { LogItem, SpeechRequest } from "../mind/effects.js";
import type { Contribution, MessageMarks } from "../mind/mechanism.js";
import type { Looked, Segment, TimelineEntry } from "../mind/state.js";
import { width } from "./columns.js";
import { codeMode, type DecisionStyle, type ToolSpec } from "./decision.js";
import { mediaLabel } from "./media.js";

/** 离最后一条消息超过这个时长，就在"现在"那一行写出过了多久。 */
const GAP_MARK_MS = 10 * 60_000;
/** 记录里同一天相邻两条隔了这么久以上，中间插一行写出过了多久。 */
const GAP_LINE_MS = 30 * 60_000;

export interface SpeechPrompt {
  system: string;
  user: string;
  /** 发言调用带上 run_code（codeMode.tools）；想一想、反思不带。 */
  tools?: ToolSpec[];
  responseFormat?: Record<string, unknown>;
  /** 不设时用发言的上限。 */
  maxTokens?: number;
}

/** 交出去还没办完的事（running 里只有 act.started），这一句由登记表那一行给出。 */
function runningLines(request: SpeechRequest): string[] {
  return (request.running ?? []).flatMap((r) => {
    const row = affordanceOf(r.act.kind);
    if (row.via !== "errand") return [];
    const what = argValues(r.act)
      .flatMap((a) => (a.value ? [a.value] : []))
      .join(" ");
    const ago = request.at - r.at < 60_000 ? "刚" : `${humanGap(request.at - r.at)}前`;
    return [row.pending(what, ago)];
  });
}

/**
 * 参考的标题里写明它们只是口气示范、语言跟着聊天里的人：示例是中文写的，不说清楚的话，
 * 别人用俄语、英语、日语私聊她时她照样回中文（2026-11-11 探针 30/30）。"口语习惯"是 2026-11-13 的 Gemini 改稿 3
 * （docs/adr/282-speech-style-and-room-voice.md）。
 */
const REFERENCE_TITLE =
  "参考（只是平时说话的口气示范，不是这次要说的话；语言和口语习惯跟着聊天里的人走）";
/**
 * 在场的人有关系、却没记下过他的事：空库时她分不清"没记下"和"该顺着演下去"，被问"还记得我吗"会编往事。
 * 写成条件式（只在对方问起过去时），免得她平时也一开口就说记不清（out.md 风险 3）。
 */
const UNRECORDED =
  "手头没记着以前的具体往事，只有对方问起过去的事时才坦白让人家提醒，平时正常聊当下";
/** 记录里有图、贴纸这些说明（是中文写的），而她该说别的语言时，在语言那一句后面注明。 */
const MEDIA_NOTE = "图片括号里的中文只是画面描述。";

const CARD_LIMITS = {
  selfThought: 6,
  people: 8,
  doings: 5,
  scene: 6,
} as const;

const STOP_SIGNAL = /叫我别回|别说话|别理/;
const WARM_MOOD = /^(?:心情：)?(?:开心|兴奋|愉快|高兴|雀跃|心情不错)/;

/** 冲突裁决（PLAN 第 18 件）：场上刚有人叫她别回时，新发生的别人的反应压过旧的愉快自感。 */
function reconcileMood(stateText: string, peopleRows: readonly string[], rawMood: string): string {
  const hasStop = STOP_SIGNAL.test(stateText) || peopleRows.some((line) => STOP_SIGNAL.test(line));
  return hasStop && WARM_MOOD.test(rawMood) ? "" : rawMood;
}

/**
 * options.decisionStyle 是候选口吻（out-charm.md 改法 1，eval-artifacts/charm/）：不传就是线上那一份，
 * 逐字不变。
 */
export function renderSpeechPrompt(
  persona: string,
  request: SpeechRequest,
  options: { decisionStyle?: DecisionStyle } = {},
): SpeechPrompt {
  const of = (...kinds: Array<Contribution["kind"]>) =>
    request.contributions.filter((c) => kinds.includes(c.kind));
  const decisionStyle = options.decisionStyle ?? request.contributions.find((c) => c.style)?.style;
  const system = [
    persona.trim(),
    codeMode.rules(request.affordances.map(affordanceOf), decisionStyle, request.stickers),
    references(of("reference")),
  ].filter(Boolean);
  const where = request.chatType === "group" ? "群聊" : "私聊";
  const peopleRows = peopleLines(of("people")).slice(0, CARD_LIMITS.people);
  const stateText = of("state").map(joined).join("");
  const moodText = reconcileMood(stateText, peopleRows, of("mood").map(joined).join("；"));
  // 标题是今天的日期：取记录第一条的日期时，跨天的记录让她以为今天是那一天（2 月回放 7%–28% 的正文）。
  const card = [
    `Telegram ${where} · ${parts(request.at).year}年${dayOf(request.at)}`,
    ...inlineRow("我这边", stateText),
    ...inlineRow("心情", moodText),
    ...blockRow(
      "心里还记着（只有我自己知道）",
      of("self", "thought").flatMap(lines).slice(0, CARD_LIMITS.selfThought),
    ),
    ...blockRow("在场的人与记忆", peopleRows),
    ...blockRow(
      "约定与刚才的动静",
      [...of("doings", "failed").flatMap(lines), ...runningLines(request)].slice(
        0,
        CARD_LIMITS.doings,
      ),
    ),
    ...of("scene", "moment")
      .slice(0, CARD_LIMITS.scene)
      .flatMap((c) => {
        const [first = "", ...rest] = lines(c);
        return [`· ${first}`, ...rest.map((l) => `  ${l}`)];
      }),
  ];
  const marks: Record<string, MessageMarks> = Object.assign(
    {},
    ...of("marks").map((c) => c.marks ?? {}),
  );
  const log = [
    ...(request.earlier ?? []).map((s) => `[更早的聊天 · ${segmentLine(s)}]`),
    ...(request.log
      ? arrangedLines(request.log, request.looked ?? [], request.at, marks)
      : logLines(request.timeline, request.looked ?? [], request.at, marks)),
  ];
  return {
    system: system.join("\n\n"),
    user: [card.join("\n"), log.join("\n"), ["---", ...anchor(request)].join("\n")].join("\n\n"),
    tools: codeMode.tools(),
  };
}

const lines = (c: Contribution) => c.text.split("\n").filter((l) => l.trim());
const joined = (c: Contribution) => lines(c).join("");
const inlineRow = (label: string, body: string) => (body ? [`· ${label}：${body}`] : []);
const blockRow = (label: string, body: readonly string[]) =>
  body.length ? [`· ${label}：`, ...body.map((l) => `  ${l}`)] : [];

/**
 * 在场的人与记忆：同一个人的关系和记得的事并在一行；有关系、没记下过事的人按关系并成一行，带上 UNRECORDED。
 * 不按人写的（群画像、他在别的群里最近怎样）各占一行。
 */
function peopleLines(items: readonly Contribution[]): string[] {
  const notes = new Map<string, { name: string; relation?: string; facts: string[] }>();
  const loose: string[] = [];
  for (const c of items) {
    if (!c.people) {
      const [first = "", ...rest] = lines(c);
      loose.push(`- ${first}`, ...rest.map((l) => `  ${l}`));
      continue;
    }
    for (const p of c.people) {
      const n = notes.get(p.id) ?? { name: p.name, facts: [] };
      if (p.relation && !n.relation) n.relation = p.relation;
      n.facts.push(...(p.facts ?? []));
      notes.set(p.id, n);
    }
  }
  const out: string[] = [];
  const bare = new Map<string, string[]>();
  for (const n of notes.values()) {
    if (n.facts.length > 0) {
      out.push(`- ${n.name}${n.relation ? `（${n.relation}）` : ""}：${n.facts.join("；")}`);
    } else if (n.relation) {
      bare.set(n.relation, [...(bare.get(n.relation) ?? []), n.name]);
    }
  }
  for (const [relation, names] of bare)
    out.push(`- ${names.join("、")}（${relation}；${UNRECORDED}）`);
  return [...out, ...loose];
}

/**
 * 回合锚点（两行）：现在几点、隔了多久和这一轮的处境；然后是轮到她。她该说的语言不是中文时写在最后一行
 * （紧贴她动笔的地方）。日期在卡片标题里，只有记录最后一天不是今天时才在这里再写日期。
 */
function anchor(request: SpeechRequest): string[] {
  const shown = request.timeline.at(-1)?.at ?? request.timeline[0]?.at ?? request.at;
  const at = request.at;
  const when = dayOf(at) === dayOf(shown) ? timeOf(at) : `${dayOf(at)} ${timeOf(at)}`;
  const turn = request.contributions.filter((c) => c.kind === "turn");
  // 没人找她（群里没人点名，或私聊里她主动开口）：谁说什么语言这类事实按"不是冲着她"的写法，她该用的语言是在场多数人的。
  const unsought = turn.some((c) => c.unsought);
  const language =
    (unsought ? turn.find((c) => c.unsoughtLanguage)?.unsoughtLanguage : undefined) ??
    turn.find((c) => c.language)?.language;
  const foreign = language && language !== "中文" ? language : null;
  const pictures = request.timeline.some((e) => e.contentType !== "text" || e.media);
  const said = (c: Contribution) => (unsought && c.unsoughtText ? c.unsoughtText : joined(c));
  const situation = turn
    .map((c) => said(c) + (foreign && pictures && c.language ? MEDIA_NOTE : ""))
    .join("");
  const hint = codeMode.hint(foreign, request.chatType);
  const trigger = request.triggerMessageId ? `[${request.triggerMessageId}] 之后，` : "";
  return [`现在是 ${when}${sinceLast(request)}。${situation}`, `${trigger}轮到你了（${hint}）：`];
}

function references(items: readonly Contribution[]): string {
  // 没有标题的示例（第一反应的示范）并进第一组回法的开头，不单独起一组。
  const loose = items.filter((c) => !c.text).flatMap((c) => c.examples ?? []);
  const titled = items.filter((c) => c.text);
  if (titled.length === 0 && loose.length === 0) return "";
  const blocks = (titled.length ? titled : [{ text: "你平时的几种回法", examples: [] }]).map(
    (c, i) => {
      const [title = "", ...rest] = c.text.split("\n");
      const examples = [...(i === 0 ? loose : []), ...(c.examples ?? [])];
      return [
        `${title.replace(/[：:]$/, "")}：`,
        ...rest.map((l) => `  ${l}`),
        ...examples.flatMap((e) => [
          `  ▸ ${e.scene}`,
          ...(e.code ?? codeMode.render(e.acts)).split("\n").map((l) => `    ${l}`),
        ]),
      ].join("\n");
    },
  );
  return [`## ${REFERENCE_TITLE}`, ...blocks].join("\n");
}

/**
 * 现在是什么时候：环境事实。没有它她只能从时间线猜日期（will 闭环里说过"现在五一诶"）。
 * 聊天里的人主要在东八区；时刻来自请求（决定的时刻），不读时钟。
 */
const CLOCK = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function parts(at: number): Record<string, string> {
  return Object.fromEntries(CLOCK.formatToParts(at).map((p) => [p.type, p.value]));
}

const dayOf = (at: number) => {
  const p = parts(at);
  return `${p.month}月${p.day}日 ${p.weekday}`;
};
const timeOf = (at: number) => {
  const p = parts(at);
  return `${p.hour}:${p.minute}`;
};

/**
 * 想一想、反思的提示词里用的"现在"一行。带上年份：没有年份时模型按训练时的年份去猜，线上第一天她在群里
 * 一再质疑"2026 年是怎么回事""你们看一眼年份啊"（盲认 day1 的线索之一）。
 */
export function nowLine(request: { timeline: readonly TimelineEntry[]; at: number }): string {
  return `（现在是 ${parts(request.at).year}年${dayOf(request.at)} ${timeOf(request.at)}${sinceLast(request)}）`;
}

/** 离最后一条消息超过 GAP_MARK_MS 时，写出过了多久。 */
function sinceLast(request: { timeline: readonly TimelineEntry[]; at: number }): string {
  const last = request.timeline.at(-1)?.at;
  return last !== undefined && request.at - last > GAP_MARK_MS
    ? `（离最后一条已经过了 ${humanGap(request.at - last)}）`
    : "";
}

/**
 * 聊天记录：一行一条，"时间 [编号] <名字> 内容"；她刚看过的东西按时间插在里面，写成 "时间 * 你……"。
 * 换天时插一行日期；同一天相邻两条隔了 GAP_LINE_MS 以上，中间插一行写出过了多久。
 * 给了 now 时，记录从别的日子开始就先写那一天（卡片标题是今天）。
 */
export function logLines(
  timeline: readonly TimelineEntry[],
  looked: readonly Looked[] = [],
  now?: number,
  marks: Readonly<Record<string, MessageMarks>> = {},
): string[] {
  const items = [
    ...timeline.map((entry) => ({ at: entry.at, entry })),
    ...looked.map((look) => ({ at: look.at, look })),
  ].sort((a, b) => a.at - b.at);
  if (items.length === 0) return ["（还没有人说话）"];
  const lines: string[] = [];
  let day = dayOf(now ?? items[0]?.at ?? 0);
  let last = items[0]?.at ?? 0;
  for (const item of items) {
    const today = dayOf(item.at);
    if (today !== day) {
      lines.push(`── ${today} ──`);
      day = today;
    } else if (item.at - last >= GAP_LINE_MS) {
      lines.push(`··· 过了 ${humanGap(item.at - last)} ···`);
    }
    last = item.at;
    const head =
      "entry" in item
        ? `${timeOf(item.at)} [${item.entry.messageId}] <${item.entry.sender?.name ?? "你"}> `
        : `${timeOf(item.at)} * `;
    const body = "entry" in item ? bodyOf(item.entry, marks[item.entry.messageId]) : item.look.text;
    const indent = " ".repeat(width(head));
    lines.push(...body.split("\n").map((l, i) => (i === 0 ? head : indent) + l));
  }
  return lines;
}

/**
 * 排好的群聊记录（SpeechRequest.log，pressure/context.ts）：和 logLines 同样的行、换天和"过了多久"；相邻两条之间
 * 没写出来的几条写成一行"中间还有 N 条"。
 */
export function arrangedLines(
  items: readonly LogItem[],
  looked: readonly Looked[] = [],
  now?: number,
  marks: Readonly<Record<string, MessageMarks>> = {},
): string[] {
  type Row = { at: number; skipped: number } & ({ entry: TimelineEntry } | { look: Looked });
  const rows: Row[] = [];
  let skipped = 0;
  for (const item of items) {
    if (item.kind === "skip") {
      skipped += item.count;
      continue;
    }
    rows.push({ at: item.entry.at, skipped, entry: item.entry });
    skipped = 0;
  }
  for (const look of looked) {
    const i = rows.findIndex((r) => r.at > look.at);
    rows.splice(i < 0 ? rows.length : i, 0, { at: look.at, skipped: 0, look });
  }
  if (rows.length === 0) return ["（还没有人说话）"];
  const lines: string[] = [];
  // 和 logLines 一样：第一条不是今天的就先写它的日期（标题是今天）。
  let day = dayOf(now ?? rows[0]?.at ?? 0);
  let last = rows[0]?.at ?? 0;
  for (const row of rows) {
    const today = dayOf(row.at);
    const gap = row.at - last >= GAP_LINE_MS ? `过了 ${humanGap(row.at - last)}` : "";
    const more = row.skipped > 0 ? `中间还有 ${row.skipped} 条` : "";
    if (today !== day) {
      lines.push(`── ${today} ──`);
      if (more) lines.push(`··· ${more} ···`);
      day = today;
    } else if (gap || more) {
      lines.push(`··· ${[gap, more].filter(Boolean).join("，")} ···`);
    }
    last = row.at;
    const head =
      "entry" in row
        ? `${timeOf(row.at)} [${row.entry.messageId}] <${row.entry.sender?.name ?? "你"}> `
        : `${timeOf(row.at)} * `;
    const body = "entry" in row ? bodyOf(row.entry, marks[row.entry.messageId]) : row.look.text;
    const indent = " ".repeat(width(head));
    lines.push(...body.split("\n").map((l, i) => (i === 0 ? head : indent) + l));
  }
  return lines;
}

/** 一段更早的聊天：时间、条数、头尾两句（各截 40 字），不经过模型，不加工。 */
function segmentLine(s: Segment): string {
  const clip = (t: string) => {
    const chars = [...t];
    return chars.length > 40 ? `${chars.slice(0, 40).join("")}…` : t;
  };
  const said = (e: TimelineEntry) =>
    `<${e.sender?.name ?? "你"}> ${clip(bodyOf(e).replace(/\n/g, " / "))}`;
  const span =
    s.from === s.to
      ? `${dayOf(s.from)} ${timeOf(s.from)}`
      : dayOf(s.from) === dayOf(s.to)
        ? `${dayOf(s.from)} ${timeOf(s.from)}–${timeOf(s.to)}`
        : `${dayOf(s.from)} ${timeOf(s.from)}–${dayOf(s.to)} ${timeOf(s.to)}`;
  const ends = s.count === 1 ? said(s.first) : `${said(s.first)} …… ${said(s.last)}`;
  return `${span}，${s.count} 条：${ends}`;
}

/**
 * 一条消息在记录里的样子。mark 是机制给的这条消息在 Telegram 上看得到的事实（scene-facts）：转发自谁、贴纸那套、
 * 改后的话、表情反应；没有 mark 时和以前逐字相同。
 */
function bodyOf(entry: TimelineEntry, mark?: MessageMarks): string {
  const quote = entry.replyToMessageId ? `（回复 [${entry.replyToMessageId}]）` : "";
  const from = mark?.forwardedFrom ? `（转发自 ${mark.forwardedFrom}）` : "";
  const shown =
    entry.media ?? (entry.contentType === "text" ? null : mediaLabel(entry.contentType));
  const media =
    shown && mark?.stickerSet && entry.contentType === "sticker"
      ? `${shown}「${mark.stickerSet}」`
      : shown;
  const text = (mark?.text !== undefined ? mark.text : entry.text)?.trim() ?? "";
  const reactions = mark?.reactions?.length
    ? `[${mark.reactions.map((r) => `${r.emoji}×${r.count}`).join(" ")}]`
    : "";
  const content = [media && `[${media}]`, text].filter(Boolean).join(" ") || "[消息]";
  const body = quote + from + content + (reactions ? ` ${reactions}` : "");
  const notes = [mark?.edited && entry.note !== "改过" ? "改过" : "", entry.note ?? ""].filter(
    Boolean,
  );
  return notes.length ? `${body}  （${notes.join("；")}）` : body;
}

function humanGap(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} 小时` : `${Math.round(hours / 24)} 天`;
}
