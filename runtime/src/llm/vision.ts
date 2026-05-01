/**
 * ADR-88: 图片/GIF/贴纸/视频感知模块。
 *
 * 架构：
 *   getVlmModel()      — 按需创建 Vercel AI SDK VLM provider（lazy singleton）
 *   MEDIA_HANDLERS      — 每种媒体类型的 prompt 定义（注册表）
 *   describeMedia()     — 公共 API，按 mediaType 路由；sticker 走 generateObject
 *   getStickerAnalysis() — 贴纸结构化分析（describeMedia("sticker") 的副产物）
 *
 * 设计原则：
 *   - photo/gif/video: generateText() → markdown strip → description
 *   - sticker: generateObject() + Zod schema → description + StickerAnalysis（读同时写）
 *   - 内容安全过滤 → WD Tagger fallback → 占位符
 *   - Zod 校验所有外部数据
 *
 * @see docs/adr/88-multimodal-proactive-behavior.md §2.2
 * @see https://github.com/LlmKira/wd14-tagger-server — WD Tagger 服务
 * @see https://github.com/TelechaBot/anime-identify — 动漫图像分类
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateObject, generateText, type LanguageModel } from "ai";
import { z } from "zod";
import type { Config } from "../config.js";
import { createLogger } from "../utils/logger.js";
import { getCachedDescription, setCachedDescription } from "./media-cache.js";

const log = createLogger("vision");

// ═══════════════════════════════════════════════════════════════════════════
// Zod schemas — 外部数据的单一真相来源
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Phase 2: 贴纸 VLM 结构化响应。
 * 字段名短（d/emo/act/int）以节约 VLM output tokens。
 * .describe() 注入 JSON Schema descriptions → API 强制 structured output。
 * anime/text 判断由专用模型完成（ONNX anime-identify + OCR），VLM 只负责语义维度。
 */
const stickerVlmSchema = z.object({
  d: z.string().min(1).describe("What the sticker conveys, one sentence, plain text"),
  emo: z
    .enum(["happy", "sad", "angry", "surprised", "shy", "tired", "neutral", "love", "scared"])
    .describe("Primary emotion conveyed"),
  act: z
    .enum([
      "wave",
      "hug",
      "cry",
      "laugh",
      "sleep",
      "eat",
      "dance",
      "thumbsup",
      "facepalm",
      "peek",
      "none",
    ])
    .describe("Primary physical action shown"),
  int: z.enum(["gentle", "moderate", "intense"]).describe("Expression intensity"),
});

/** Phase 2: 贴纸语义分析结果（公共类型，从 VLM schema 推导）。 */
export const stickerAnalysisSchema = z.object({
  description: z.string(),
  emotion: stickerVlmSchema.shape.emo,
  action: stickerVlmSchema.shape.act,
  intensity: stickerVlmSchema.shape.int,
});

export type StickerAnalysis = z.infer<typeof stickerAnalysisSchema>;

/** WD Tagger API 响应。 */
const wdTaggerResponseSchema = z.object({
  sorted_general_strings: z.string(),
  rating: z.object({
    general: z.number(),
    sensitive: z.number(),
    questionable: z.number(),
    explicit: z.number(),
  }),
  character_res: z.record(z.number()).optional(),
});

// ═══════════════════════════════════════════════════════════════════════════
// VLM Provider — Vercel AI SDK (lazy singleton)
// ═══════════════════════════════════════════════════════════════════════════

let _vlmModel: LanguageModel | null = null;
let _vlmConfigKey = "";
let _visionAuthDisabledKey = "";

/**
 * 获取 VLM 语言模型实例。
 * 基于 visionBaseUrl + visionApiKey + visionModel 创建，配置不变时复用。
 */
function getVlmModel(config: Config): LanguageModel {
  const key = `${config.visionBaseUrl}|${config.visionApiKey}|${config.visionModel}`;
  if (_vlmModel && _vlmConfigKey === key) return _vlmModel;

  const provider = createOpenAICompatible({
    name: "vision",
    baseURL: config.visionBaseUrl,
    apiKey: config.visionApiKey,
    // 启用 json_schema 模式 → generateObject 发送完整 schema，API 强制 structured output
    // @see https://github.com/vercel/ai/issues/5197
    supportsStructuredOutputs: true,
  });

  _vlmModel = provider(config.visionModel);
  _vlmConfigKey = key;
  return _vlmModel;
}

// ═══════════════════════════════════════════════════════════════════════════
// 输入守卫
// ═══════════════════════════════════════════════════════════════════════════

type GuardResult = { ok: true } | { ok: false; reason: string; placeholder?: string };

/** base64 大小 + SVG/XML 检测。 */
function guardBase64(imageBase64: string): GuardResult {
  if (imageBase64.length < 2000) {
    return { ok: false, reason: "too small", placeholder: "(media too small)" };
  }
  // mtcute photoPathSize (type j) 膨胀为 <?xml><svg> outline
  const head = Buffer.from(imageBase64.slice(0, 8), "base64");
  if (head.length >= 2 && head[0] === 0x3c && (head[1] === 0x3f || head[1] === 0x73)) {
    return { ok: false, reason: "SVG/XML", placeholder: "(non-raster media)" };
  }
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// 媒体类型定义 — prompt 注册表
// ═══════════════════════════════════════════════════════════════════════════

const MEDIA_PROMPTS = {
  photo: {
    text: [
      "What is in this image? Be specific: mention any visible text, names, numbers, UI elements.",
      "If there is text or a screenshot, prioritize summarizing the text content.",
      "Be concise but keep important details. DO NOT start with 'This image' or 'The image'.",
    ].join(" "),
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
  sticker: {
    text: "Analyze this chat sticker: describe the emotion, expression, and action it conveys.",
    maxTokens: 120,
  },
} as const;

export type MediaType = keyof typeof MEDIA_PROMPTS;

// ═══════════════════════════════════════════════════════════════════════════
// WD14 Tagger Fallback
// ═══════════════════════════════════════════════════════════════════════════

/** VLM 被安全过滤时的 fallback — 通过 tag 感知图片内容。 */
async function describeWithTagger(
  imageBase64: string,
  taggerUrl: string,
): Promise<string | undefined> {
  try {
    const imageBuffer = Buffer.from(imageBase64, "base64");
    const boundary = `----WdTagger${Date.now()}`;
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="image.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);

    const url = `${taggerUrl.replace(/\/$/, "")}/upload?general_threshold=0.35&character_threshold=0.85`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: Buffer.concat([header, imageBuffer, footer]),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return undefined;

    const result = wdTaggerResponseSchema.safeParse(await resp.json());
    if (!result.success) return undefined;

    const { sorted_general_strings: tags, rating, character_res } = result.data;
    const topRating = (Object.entries(rating) as [string, number][]).sort(
      (a, b) => b[1] - a[1],
    )[0][0];
    const characters = Object.entries(character_res ?? {})
      .filter(([, score]) => score > 0.5)
      .map(([name]) => name);

    const parts: string[] = [];
    if (characters.length > 0) parts.push(`Characters: ${characters.join(", ")}.`);
    const cappedTags = tags.length > 200 ? `${tags.slice(0, 200)}...` : tags;
    parts.push(`Tags: ${cappedTags}.`);
    parts.push(`Content rating: ${topRating}.`);
    return parts.join(" ");
  } catch (e) {
    log.warn("WD Tagger failed", { error: e instanceof Error ? e.message : String(e) });
    return undefined;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 后处理
// ═══════════════════════════════════════════════════════════════════════════

/** strip markdown + 单行化（VLM 自由文本输出注入 IRC 格式）。 */
function stripMarkdown(raw: string): string {
  return raw
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^[-•]\s*/gm, "")
    .replace(/\n+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** 内容安全过滤检测 — 覆盖 Gemini / OpenAI 等 provider 的各种拒绝形式。 */
function isContentFilterError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /safety|blocked|filter|content_policy|prompt_blocked|RECITATION/i.test(msg);
}

function isAuthFailure(e: unknown): boolean {
  if (e == null || typeof e !== "object") {
    return /unauthorized|forbidden/i.test(String(e));
  }
  const obj = e as Record<string, unknown>;
  const status = obj.statusCode ?? obj.status;
  if (status === 401 || status === 403) return true;
  if (obj.cause && isAuthFailure(obj.cause)) return true;
  return /unauthorized|forbidden/i.test(e instanceof Error ? e.message : String(e));
}

// ═══════════════════════════════════════════════════════════════════════════
// 贴纸结构化分析缓存 — describeMedia("sticker") 的副产物
// ═══════════════════════════════════════════════════════════════════════════

const _stickerAnalysisCache = new Map<string, StickerAnalysis>();

/**
 * 读取贴纸的结构化语义分析。
 *
 * 在 describeMedia(base64, uid, "sticker", config) 调用后可用。
 * 生命周期：进程内存（不持久化，重启后重新分析）。
 */
export function getStickerAnalysis(fileUniqueId: string): StickerAnalysis | undefined {
  const analysis = _stickerAnalysisCache.get(fileUniqueId);
  if (analysis) _stickerAnalysisCache.delete(fileUniqueId);
  return analysis;
}

// ═══════════════════════════════════════════════════════════════════════════
// 公共 API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 统一媒体描述入口 — 按 mediaType 路由。
 *
 * | 类型    | SDK 函数          | 后处理              |
 * |---------|-------------------|---------------------|
 * | photo   | generateText()    | stripMarkdown       |
 * | gif     | generateText()    | stripMarkdown       |
 * | video   | generateText()    | stripMarkdown       |
 * | sticker | generateObject()  | Zod 结构化 + 缓存   |
 *
 * **sticker "读同时写"**：
 * - generateObject() + stickerVlmSchema → API 强制 structured output
 * - description 返回给调用者（感知用）
 * - StickerAnalysis 缓存到内存 → getStickerAnalysis() 读取（调色板入库用）
 *
 * Fallback: 内容安全过滤 → WD Tagger → 占位符。
 *
 * @returns 自然语言描述，或 undefined（禁用/失败）
 */
export async function describeMedia(
  imageBase64: string,
  fileUniqueId: string,
  mediaType: MediaType,
  config: Config,
): Promise<string | undefined> {
  if (!config.visionModel) return undefined;

  const visionConfigKey = `${config.visionBaseUrl}|${config.visionApiKey}|${config.visionModel}`;
  if (_visionAuthDisabledKey === visionConfigKey) {
    log.debug("Vision skipped: provider auth disabled", { mediaType });
    return undefined;
  }

  // 缓存命中
  const cached = getCachedDescription(fileUniqueId);
  if (cached) {
    log.debug("Vision cache hit", { fileUniqueId, mediaType });
    return cached;
  }

  // 输入守卫
  const guard = guardBase64(imageBase64);
  if (!guard.ok) {
    log.warn(`Vision skipped: ${guard.reason}`, { fileUniqueId, mediaType });
    if (guard.placeholder) setCachedDescription(fileUniqueId, mediaType, guard.placeholder);
    return undefined;
  }

  const prompt = MEDIA_PROMPTS[mediaType];
  const model = getVlmModel(config);
  const imageBuffer = Buffer.from(imageBase64, "base64");

  try {
    let description: string;

    if (mediaType === "sticker") {
      // ── Structured path: generateObject → Zod 校验 → description + analysis ──
      const { object } = await generateObject({
        model,
        schema: stickerVlmSchema,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt.text },
              { type: "image", image: imageBuffer },
            ],
          },
        ],
        maxOutputTokens: prompt.maxTokens,
        abortSignal: AbortSignal.timeout(15_000),
      });

      description = stripMarkdown(object.d);
      const analysis: StickerAnalysis = {
        description,
        emotion: object.emo,
        action: object.act,
        intensity: object.int,
      };
      _stickerAnalysisCache.set(fileUniqueId, analysis);
      log.info("Sticker analyzed", {
        fileUniqueId,
        emotion: analysis.emotion,
        action: analysis.action,
        description: description.slice(0, 60),
      });
    } else {
      // ── Free text path: generateText → stripMarkdown ──
      const { text } = await generateText({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt.text },
              { type: "image", image: imageBuffer },
            ],
          },
        ],
        maxOutputTokens: prompt.maxTokens,
        abortSignal: AbortSignal.timeout(10_000),
      });

      description = stripMarkdown(text);
      log.info("Media described", { fileUniqueId, mediaType, caption: description.slice(0, 60) });
    }

    if (!description) return undefined;
    setCachedDescription(fileUniqueId, mediaType, description);
    return description;
  } catch (e) {
    if (isAuthFailure(e)) {
      _visionAuthDisabledKey = visionConfigKey;
      log.warn("Vision disabled after provider auth failure", {
        mediaType,
        error: e instanceof Error ? e.message : String(e),
      });
      return undefined;
    }

    // 内容安全过滤 → WD Tagger fallback
    if (isContentFilterError(e)) {
      log.info("Vision content filtered, trying WD Tagger fallback", { fileUniqueId, mediaType });
      const taggerResult = config.wdTaggerUrl
        ? await describeWithTagger(imageBase64, config.wdTaggerUrl)
        : undefined;
      if (taggerResult) {
        setCachedDescription(fileUniqueId, mediaType, taggerResult);
        return taggerResult;
      }
      const placeholder = "(image present but content not visible)";
      setCachedDescription(fileUniqueId, mediaType, placeholder);
      return placeholder;
    }

    log.warn("Vision API call failed", {
      mediaType,
      error: e instanceof Error ? e.message : String(e),
    });
    return undefined;
  }
}

/** 获取缓存的图片描述（向后兼容导出）。 */
export function getCachedCaption(fileUniqueId: string): string | undefined {
  return getCachedDescription(fileUniqueId);
}

/** 检查 Vision 是否已启用。 */
export function isVisionEnabled(config: Config): boolean {
  return !!config.visionModel;
}

/**
 * 调用 AnimeIDF 微服务判断图片是否为动漫/插画风格。
 * 服务不可用时降级为 true（全部通过，不阻塞入库）。
 * @see docs/adr/153-sticker-palette-phase3-group-learning.md §D2
 */
export async function isAnimeSticker(buffer: Buffer, config: Config): Promise<boolean> {
  if (!config.animeClassifyUrl) return true; // 未配置 → 降级：全部通过
  try {
    const boundary = `----AnimeIDF${Date.now()}`;
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sticker.webp"\r\nContent-Type: image/webp\r\n\r\n`,
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const resp = await fetch(`${config.animeClassifyUrl.replace(/\/$/, "")}/classify`, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: Buffer.concat([header, buffer, footer]),
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return true; // 服务异常 → 降级
    const result = z.object({ anime: z.boolean() }).safeParse(await resp.json());
    return result.success ? result.data.anime : true;
  } catch {
    return true; // 超时/网络错误 → 降级
  }
}
