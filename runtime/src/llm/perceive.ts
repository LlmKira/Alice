/**
 * 看图、听语音：把别人发来的图片、动图和视频（取 Telegram 给的预览帧）写成一段描述、把语音逐字写下来，
 * 作为 message.perceived 写回那条消息（行动空间调研 2026-11-11：先转成文字再给发言层，能回放、每轮不用重带原件）。
 *
 * 画面两路同时看：看图模型（flash-lite）用 2 月 llm/vision.ts 的英文提示写描述（研究员 2026-11-13：标准做法，
 * 不预设、不过滤内容），本机标注器（services/tagger，WD v3）给认得准的角色名、尺度、是不是照片。
 * 看图模型拒绝或失败时，只给标注器的那部分；两路都失败才算没看到。
 * 网关探针（2026-11-11）：一张图约 1100 个输入 token、3 秒；语音 OGG/Opus 直接收，约 25 token/秒、2 秒。
 * 标注器在本机 CPU 上一张约 0.7 秒（eval-artifacts/perception/）。
 */
import { z } from "zod";
import { type ChatUsage, chatTokens, type Gateway } from "./gateway.js";
import { SPEECH_MODEL } from "./speech-model.js";

/** 2 月的提示原文（archive/feb-2026-02:runtime/src/llm/vision.ts MEDIA_PROMPTS）和各自的输出上限。 */
const FRAME_ASKS = {
  photo: {
    text: "What is in this image? Be specific: mention any visible text, names, numbers, UI elements. If there is text or a screenshot, prioritize summarizing the text content. Be concise but keep important details. DO NOT start with 'This image' or 'The image'.",
    maxTokens: 150,
  },
  gif: {
    text: "What emotion or action does this GIF convey? Be brief but specific.",
    maxTokens: 60,
  },
  video: {
    text: "What is happening in this video? Mention key details (people, scene, action). DO NOT start with 'This' or 'The'.",
    maxTokens: 100,
  },
} as const;
export type FrameKind = keyof typeof FRAME_ASKS;

const VOICE_ASK =
  "按原话的语言逐字记下来，别翻译，只写说了什么，不加说明。听不清的地方写（听不清）。";

/** 只防异常长的输出；正常长度由 max_tokens 管（150 token 的英文约 700 字符）。 */
const SAFETY_CHARS = 1_000;
/** 标注器的等待上限：看图模型约 3 秒，标注器再慢也不让这一行晚到超过它。 */
const TAGGER_TIMEOUT_MS = 5_000;

interface Body extends ChatUsage {
  choices?: Array<{ message?: { content?: string } }>;
}

async function ask(
  gateway: Gateway,
  kind: "image" | "voice",
  part: object,
  question: string,
  maxTokens: number,
  maxChars: number,
): Promise<string> {
  const { body } = await gateway.post<Body>({
    kind,
    model: SPEECH_MODEL,
    path: "/chat/completions",
    timeoutMs: 30_000,
    tokens: chatTokens,
    body: {
      model: SPEECH_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: [{ type: "text", text: question }, part] }],
    },
  });
  // 时间线一条一行：去掉 markdown 的粗体、代码标记和换行（2 月 stripMarkdown 同样做）。
  const text = (body.choices?.[0]?.message?.content ?? "")
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) throw new Error("perceive: empty");
  const chars = [...text];
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join("")}…` : text;
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** 一帧画面的描述：图片本身，或动图、视频的预览帧（JPEG）。 */
export function describeFrame(
  gateway: Gateway,
  jpeg: Uint8Array,
  kind: FrameKind,
): Promise<string> {
  const url = `data:image/jpeg;base64,${base64(jpeg)}`;
  const { text, maxTokens } = FRAME_ASKS[kind];
  const part = { type: "image_url", image_url: { url } };
  return ask(gateway, "image", part, text, maxTokens, SAFETY_CHARS);
}

/** Telegram 语音是 OGG/Opus。 */
export function transcribeVoice(gateway: Gateway, ogg: Uint8Array): Promise<string> {
  return ask(
    gateway,
    "voice",
    { type: "input_audio", input_audio: { data: base64(ogg), format: "ogg" } },
    VOICE_ASK,
    300,
    300,
  );
}

/** Danbooru 的四档尺度（标注器训练用的分级）。 */
export const RATINGS = ["general", "sensitive", "questionable", "explicit"] as const;
export type Rating = (typeof RATINGS)[number];

/**
 * 标注器读出的、要写给她的事实。一般标签不写：描述已经说了画面，标签只添错事实
 * （墨西哥城的路牌标成 "tokyo (city)"、猫标成 "shiba inu"；opus 判别 2026-11-13，eval-artifacts/perception/）。
 */
export interface ImageTags {
  rating: Rating;
  /** 认得准的角色（分数 ≥ 0.85，照标注器的写法，如 "hatsune miku"）。 */
  characters: string[];
  /** 标注器很确定这是照片（它是按动漫图练的；这时角色名指的是 cos）。 */
  photo: boolean;
}

const scored = z.object({ name: z.string().min(1), score: z.number() });
/** services/tagger/server.py 的回复。 */
const TaggerReply = z.object({
  rating: z.object({
    general: z.number(),
    sensitive: z.number(),
    questionable: z.number(),
    explicit: z.number(),
  }),
  characters: z.array(scored),
  tags: z.array(scored),
});

const CHARACTER_SCORE = 0.85;
const CHARACTERS_SHOWN = 3;
const PHOTO_SCORE = 0.5;

/** 标注器的回复 → 给她看的事实：最可能的尺度、认得准的角色、"realistic" 标签够不够确定。 */
export function readTags(reply: unknown): ImageTags {
  const r = TaggerReply.parse(reply);
  const rating = RATINGS.reduce((best, k) => (r.rating[k] > r.rating[best] ? k : best));
  const realistic = r.tags.find((t) => t.name === "realistic")?.score ?? 0;
  return {
    rating,
    characters: r.characters
      .filter((c) => c.score >= CHARACTER_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, CHARACTERS_SHOWN)
      .map((c) => c.name),
    photo: realistic >= PHOTO_SCORE,
  };
}

/**
 * 只写标注器分得准的两档：尺度很大、R18 在图片集上标了 13 次、对 12 次，一张没漏。"sensitive" 不写：
 * 有真值的图里它标的 15 张有 8 张其实是普通图（包括一张聊天截图），3 张真人 cos 照它也标了 2 张
 * （eval-artifacts/perception/）。
 */
const RATING_WORDS: Record<Rating, string | null> = {
  general: null,
  sensitive: null,
  questionable: "尺度很大",
  explicit: "R18",
};

/**
 * 时间线里那张图的一行（"图片：" 之后的部分）：描述在前，标注事实跟在破折号后面，
 * 像链接的"标题——摘要"。没有描述时只有事实。
 */
export function imageLine(description: string | null, tags: ImageTags | null): string {
  const facts = tags
    ? [
        tags.photo ? "照片" : null,
        tags.characters.length ? `角色 ${tags.characters.join("、")}` : null,
        RATING_WORDS[tags.rating],
      ].filter((f): f is string => f !== null)
    : [];
  const said = facts.join("，");
  if (description && said) return `${description.replace(/[。.]$/, "")}——${said}`;
  return description || said;
}

/** 本机标注器：图片原样发过去，回读出的事实。 */
export type Tagger = (image: Uint8Array) => Promise<ImageTags>;

export function localTagger(
  url: string,
  doFetch: typeof fetch = fetch,
  timeoutMs = TAGGER_TIMEOUT_MS,
): Tagger {
  const endpoint = `${url.replace(/\/$/, "")}/tag`;
  return async (image) => {
    const response = await doFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(image),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`tagger ${response.status}`);
    return readTags(await response.json());
  };
}

/**
 * 看一帧画面（图片，或动图、视频的预览帧）：描述和标注同时跑，都等到（标注器最多等 TAGGER_TIMEOUT_MS）
 * 再合成一行。两路都没有结果才失败，抛看图模型的错（外壳照旧记一条 Perception failed）。
 */
export async function seeFrame(
  gateway: Gateway,
  tagger: Tagger | null,
  jpeg: Uint8Array,
  kind: FrameKind,
): Promise<string> {
  const [described, tagged] = await Promise.allSettled([
    describeFrame(gateway, jpeg, kind),
    tagger ? tagger(jpeg) : Promise.resolve(null),
  ]);
  const description = described.status === "fulfilled" ? described.value : null;
  const tags = tagged.status === "fulfilled" ? tagged.value : null;
  const line = imageLine(description, tags);
  if (line) return line;
  throw described.status === "rejected" ? described.reason : new Error("perceive: empty");
}
