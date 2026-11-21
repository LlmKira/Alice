/**
 * 看懂冲着她的话：
 * - 口气：友好、中性、冷淡还是敌意（eval-artifacts/relation-c/prereg-jev.md），问 Jev（typesafe/jev-latest，/systemone）；
 * - 她是不是不受欢迎：这条是不是在叫她别回、走开（stop），叫她闭嘴、少说（hush），不想跟她说话、在打发她（aloof）。
 *   这三项少见、分量重（pressure/rejection.ts 读它们），问更强的模型 REJECTION_MODEL。
 * 两问同时发。外壳在一次叫醒时把还没判过的几条一起问，结果写成 message.perceived；心智只读这条记录，重放不再问。
 * 为什么三项换模型：在研究员盲标的 60 条上（eval-artifacts/rejection/prereg.md），Jev 问一次漏了 1 条闭嘴、把 3 条普通的短回答
 * 判成冷淡；每条问三次取多数也漏那条闭嘴；gemini-3-flash-preview 两条真的都判出来，冷淡 0 误报，互损的 10 条 0 误报，
 * 只多判了 1 条闭嘴。
 */
import type { Tone } from "../mind/events.js";
import { type ChatUsage, chatTokens, type Gateway, type Tokens } from "./gateway.js";

export const TONE_MODEL = "typesafe/jev-latest";
/** 判"不受欢迎"三项的模型（不思考）。 */
export const REJECTION_MODEL = "google/gemini-3-flash-preview";

/**
 * 冷淡：不想跟她说话。按群的文化和这条之后的来回判，不按字面（研究员 2026-11-13，docs/spec/evaluation.md：互相损、
 * 开玩笑在那些群里是亲近，读成冷淡就错）。
 */
export const COLD =
  "冷淡：不想跟她说话、敷衍她、打发她、爱答不理，但没有骂她。按这个群平时怎么说话、这条前后大家怎么接来判，不按字面：" +
  "群里本来就这么短、这么冲的说法，互相损、开玩笑，催她回答、追着问她，都不算冷淡";

/** 只说口气，不说她该怎么回（criteria 必须是字典，列表会 422）。 */
const CRITERIA: Readonly<Record<Tone, string>> = {
  friendly: "友好：亲近、关心、热情，或善意地开玩笑",
  neutral: "中性：普通的问话、就事论事",
  cold: COLD,
  hostile: "敌意：骂她、羞辱她、贬低她、挑衅她",
};

/** 这条在不在叫她别回、别理、走开（只认对她本人说的意思，不认玩笑里的反话）。 */
export const STOP: Readonly<Record<"yes" | "no", string>> = {
  yes: "是：明确叫 Alice 别回他的消息、别理他、别找他、走开或离他远点",
  no: "不是：其他所有情况，包括开玩笑、骂她但没叫她走开、叫别人别说话",
};

/** 这条在不在叫她闭嘴、少说。只认对她本人说的，不认叫别人少说。 */
export const HUSH: Readonly<Record<"yes" | "no", string>> = {
  yes: "是：叫 Alice 闭嘴、少说点、别插话、别刷屏，或嫌她话多",
  no: "不是：其他所有情况，包括开玩笑、骂她但没叫她少说、叫别人闭嘴",
};

/** 一条消息看出来的（答不出、答"不是"的那项没有）。 */
export interface Perceived {
  tone?: Tone;
  stop?: true;
  hush?: true;
  aloof?: true;
}

/** 一行聊天：编号、谁说的（她自己是 Alice）、说了什么。 */
export interface ToneLine {
  id: string;
  who: string;
  text: string;
}

/** 给判别看的状态：最近的聊天，按时间顺序。 */
export function toneState(chatType: "private" | "group", lines: readonly ToneLine[]): string {
  const where = chatType === "group" ? "群聊" : "私聊";
  return `Telegram ${where}里最近的记录（[编号] 名字: 内容）：\n${lines
    .map((l) => `[${l.id}] ${l.who}: ${l.text}`)
    .join("\n")}`;
}

interface Body {
  answers?: Record<string, { choice?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

const tokens = (body: Body): Tokens => ({
  promptTokens: body.usage?.input_tokens ?? 0,
  completionTokens: body.usage?.output_tokens ?? 0,
  reasoningTokens: 0,
});

const isTone = (s: unknown): s is Tone => typeof s === "string" && Object.hasOwn(CRITERIA, s);

/**
 * 她自己写下的心情是好是坏、有多强（PLAN 第 34 件：心情用她自己的词，效价由感知判，不查手设的词表）。
 * 同一个判口气的模型，一问，按顺序的五档；答的是按概率加权的档位（0–4），换到效价 [−1, 1]。
 */
const VALENCE_LEVELS = [
  "很糟：很难过、很生气、很害怕、很受伤",
  "有点糟：有点低落、烦、委屈、失落、累",
  "说不上好坏：平静、一般",
  "有点好：轻松、满足、有点开心、期待",
  "很好：很开心、很兴奋、很幸福、很感动",
] as const;

interface ScoreBody extends Body {
  answers?: Record<string, { choice?: string; score?: number }>;
}

/** 档位（0 到 档数−1）换成效价 [−1, 1]。 */
export function valenceOfScore(score: number): number {
  const top = VALENCE_LEVELS.length - 1;
  return Math.max(-1, Math.min(1, (2 * score) / top - 1));
}

/** 她写下的心情词（和原因）的效价；判不出是 null。 */
export async function perceiveMood(
  gateway: Gateway,
  mood: { word: string; why: string | null },
  signal?: AbortSignal,
): Promise<number | null> {
  const why = mood.why ? `（因为${mood.why}）` : "";
  const { body } = await gateway.post<ScoreBody>({
    kind: "tone",
    model: TONE_MODEL,
    path: "/systemone",
    timeoutMs: 20_000,
    attempts: 2,
    tokens,
    ...(signal ? { signal } : {}),
    body: {
      model: TONE_MODEL,
      state: `Alice 在心里记下她此刻的心情：${mood.word}${why}`,
      questions: {
        v: {
          type: "score",
          instructions: "这份心情对她自己来说是好受还是难受，有多强？",
          criteria: [...VALENCE_LEVELS],
        },
      },
    },
  });
  const score = body.answers?.v?.score;
  return typeof score === "number" && Number.isFinite(score) ? valenceOfScore(score) : null;
}

/** 一次问几条（ids 都在 lines 里）：口气问 Jev，三项问 REJECTION_MODEL，同时发；都答不出的那条不写。 */
export async function perceiveTone(
  gateway: Gateway,
  chatType: "private" | "group",
  lines: readonly ToneLine[],
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<Record<string, Perceived>> {
  if (ids.length === 0) return {};
  const [tones, unwelcome] = await Promise.all([
    askTone(gateway, chatType, lines, ids, signal),
    askUnwelcome(gateway, chatType, lines, ids, signal),
  ]);
  const out: Record<string, Perceived> = {};
  for (const id of ids) {
    const p: Perceived = { ...tones[id], ...unwelcome[id] };
    if (Object.keys(p).length > 0) out[id] = p;
  }
  return out;
}

/** 口气（Jev）。 */
export async function askTone(
  gateway: Gateway,
  chatType: "private" | "group",
  lines: readonly ToneLine[],
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<Record<string, Pick<Perceived, "tone">>> {
  if (ids.length === 0) return {};
  const questions = Object.fromEntries(
    ids.map((id, i) => [
      `q${i}`,
      {
        type: "choice",
        instructions: `[${id}] 这条冲着 Alice 的消息，对她是什么口气？`,
        criteria: CRITERIA,
      },
    ]),
  );
  const { body } = await gateway.post<Body>({
    kind: "tone",
    model: TONE_MODEL,
    path: "/systemone",
    timeoutMs: 20_000,
    attempts: 2,
    tokens,
    ...(signal ? { signal } : {}),
    body: { model: TONE_MODEL, state: toneState(chatType, lines), questions },
  });
  const out: Record<string, Pick<Perceived, "tone">> = {};
  ids.forEach((id, i) => {
    const choice = body.answers?.[`q${i}`]?.choice;
    if (isTone(choice)) out[id] = { tone: choice };
  });
  return out;
}

const ask = (c: Readonly<Record<"yes" | "no", string>>) => `${c.yes}\n  ${c.no}`;

/** 她是不是不受欢迎（REJECTION_MODEL，一次问完这几条）。 */
export async function askUnwelcome(
  gateway: Gateway,
  chatType: "private" | "group",
  lines: readonly ToneLine[],
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<Record<string, Pick<Perceived, "stop" | "hush" | "aloof">>> {
  if (ids.length === 0) return {};
  const user =
    `${toneState(chatType, lines)}\n\n对编号 ${ids.map((id) => `[${id}]`).join(" ")} 的每一条，三问各只答 yes 或 no：\n` +
    `stop：这条是不是在叫 Alice 别回、别理他、走开？\n  ${ask(STOP)}\n` +
    `hush：这条是不是在叫 Alice 闭嘴、少说点？\n  ${ask(HUSH)}\n` +
    `aloof：这条是不是不想跟 Alice 说话、在打发她？\n  是：${COLD}\n  不是：其他情况\n` +
    `只输出 JSON，键是编号：{"<编号>":{"stop":"yes|no","hush":"yes|no","aloof":"yes|no"}}`;
  const { body } = await gateway.post<
    ChatUsage & { choices?: Array<{ message?: { content?: string } }> }
  >({
    kind: "tone",
    model: REJECTION_MODEL,
    path: "/chat/completions",
    timeoutMs: 60_000,
    attempts: 2,
    tokens: chatTokens,
    ...(signal ? { signal } : {}),
    body: {
      model: REJECTION_MODEL,
      reasoning_effort: "none",
      max_tokens: 40 + 40 * ids.length,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: user }],
    },
  });
  const raw = body.choices?.[0]?.message?.content ?? "{}";
  let parsed: Record<string, Record<string, string>> = {};
  try {
    parsed = JSON.parse(raw.replace(/^```json\s*|```\s*$/g, "")) as typeof parsed;
  } catch {
    return {};
  }
  const out: Record<string, Pick<Perceived, "stop" | "hush" | "aloof">> = {};
  for (const id of ids) {
    const a = parsed[id] ?? parsed[`[${id}]`];
    if (!a) continue;
    const p = {
      ...(a.stop === "yes" ? { stop: true as const } : {}),
      ...(a.hush === "yes" ? { hush: true as const } : {}),
      ...(a.aloof === "yes" ? { aloof: true as const } : {}),
    };
    if (Object.keys(p).length > 0) out[id] = p;
  }
  return out;
}
