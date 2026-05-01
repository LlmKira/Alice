/**
 * 消息拉取 — Telegram API 实时消息获取 + 回复链逸散。
 */
import {
  Audio,
  type Photo,
  Poll,
  Sticker,
  type TelegramClient,
  Contact as TgContact,
  User,
  Venue,
  Video,
  WebPageMedia,
} from "@mtcute/node";

import { eq } from "drizzle-orm";
import type { Config } from "../../config.js";
import { updateAlbumPhotoSemantics } from "../../db/album.js";
import { getDb } from "../../db/connection.js";
import { type DbMessageRecord, getMessageCluster } from "../../db/queries.js";
import { stickerPalette } from "../../db/schema.js";
import { telegramChannelId } from "../../graph/constants.js";
import type { ChatType } from "../../graph/entities.js";
import { isASREnabled, transcribeVoice } from "../../llm/asr.js";
import { setCachedChatInfo } from "../../llm/group-cache.js";
import {
  getCachedDescription,
  getCachedOcrText,
  getCachedStickerSetTitle,
  setCachedDescription,
  setCachedOcrText,
  setCachedStickerSetTitle,
} from "../../llm/media-cache.js";
import { extractText, isOcrEnabled } from "../../llm/ocr.js";
import {
  describeMedia,
  getStickerAnalysis,
  isAnimeSticker,
  isVisionEnabled,
} from "../../llm/vision.js";
import { getHistory, getUnreadMentionIds, markRead } from "../../telegram/actions.js";
import { isInPalette, upsertFromVLM } from "../../telegram/apps/sticker-palette.js";
import { createLogger } from "../../utils/logger.js";
import { annotateSenderRole, fetchChatInfo, getAdminMap } from "./group-meta.js";

const log = createLogger("act");

/**
 * 光栅缩略图类型白名单。
 * Telegram 缩略图类型：s/m/x/y/w/a/b/c/d = 光栅 JPEG
 * j = SVG outline（photoPathSize — mtcute 本地膨胀为 SVG），i = stripped，f/u/v = video
 * @see docs/reference/mtcute/.../types/media/thumbnail.ts
 */
const RASTER_THUMB_TYPES = new Set(["s", "m", "x", "y", "w", "a", "b", "c", "d"]);

/** 消息内容分段——支持优先级感知的智能截断。 */
export interface ContentSegment {
  readonly kind: "body" | "media" | "link" | "image" | "meta";
  readonly text: string;
}

export function formatImageOcrMetaText(ocr: string): string {
  return `(image OCR text, not sender speech: "${ocr}")`;
}

function formatAudioDuration(seconds: number): string | undefined {
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatAudioMediaText(
  audio: Pick<Audio, "title" | "performer" | "duration" | "fileName">,
): string {
  const title = audio.title?.trim();
  const performer = audio.performer?.trim();
  const fileName = audio.fileName?.trim();
  const duration = formatAudioDuration(audio.duration);
  const track = title && performer ? `${title} — ${performer}` : (title ?? performer ?? fileName);
  const detail = [track, duration].filter(Boolean).join(", ");
  return detail ? `(audio 🎵: ${detail})` : "(audio 🎵)";
}

export function formatStickerMediaText(params: {
  emoji?: string;
  title?: string;
  description?: string;
  fileId: string;
}): string {
  const title = params.title?.trim();
  const description = params.description?.trim();
  const emoji = params.emoji?.trim();
  const header = description ? "sticker" : ["sticker", emoji].filter(Boolean).join(" ");
  const titlePart = title ? ` — ${title}` : "";
  const descriptionPart = description ? `: ${description}` : "";
  return `(${header}${titlePart}${descriptionPart} | id:${params.fileId})`;
}

function extractStickerTitle(text: string): string | undefined {
  const match = text.match(/^\(sticker(?:\s+\S+)? — ([^:|]+?)(?:\s*:|\s*\|)/);
  return match?.[1]?.trim() || undefined;
}

/** 简化的消息记录，供 fetchRecentMessages 使用。 */
export interface MessageRecord {
  id: number;
  senderName: string;
  /** Telegram user ID（IRC ~id 标注用）。仅非 outgoing 消息有值。 */
  senderId?: number;
  isOutgoing: boolean;
  text: string;
  date: Date;
  /** ADR-83 D4: 媒体类型标记（photo/sticker/voice 等），无媒体时 undefined。 */
  mediaType?: string;
  // --- ADR-85 ---
  /** 回复目标消息 ID（↩#id 可视化）。 */
  replyToId?: number;
  /** 是否被编辑过。 */
  isEdited?: boolean;
  /** Reaction 聚合：emoji → count（仅 string emoji，跳过 custom）。 */
  reactions?: Record<string, number>;
  /** 转发来源显示名（频道名/用户名/隐藏名）。 */
  forwardFrom?: string;
  /** ADR-97: 此消息通过回复链逸散拉入，非滑动窗口原始成员。 */
  isDiffused?: boolean;
  /** ADR-114 D5: Telegram 原生 mention 标记（消息 mention 了当前用户）。 */
  isMention?: boolean;
  /** ADR-114 D2: 此消息通过未读 mention 扩散拉入（非滑动窗口原始成员）。 */
  isMentionContext?: boolean;
  /** 发送者是否为 Telegram bot。 */
  isBot?: boolean;
  /** 结构化内容分段（仅 fetchRecentMessages 生成的实时消息）。 */
  segments?: ContentSegment[];
}

/** 替换 record 中第一个 media segment 的 text，同步 text 字段。 */
function replaceMediaSegment(record: MessageRecord, newText: string): void {
  if (!record.segments) return;
  const idx = record.segments.findIndex((s) => s.kind === "media");
  if (idx >= 0) {
    (record.segments as ContentSegment[])[idx] = { kind: "media", text: newText };
    record.text = record.segments.map((s) => s.text).join(" ");
  }
}

/** 向 record 追加一个 segment，同步 text 字段。 */
function appendSegment(record: MessageRecord, seg: ContentSegment): void {
  if (!record.segments) return;
  (record.segments as ContentSegment[]).push(seg);
  record.text = record.segments.map((s) => s.text).join(" ");
}

const CONTEXT_HORIZON_MS_PRIVATE = 7 * 24 * 3600_000;
const CONTEXT_HORIZON_MS_GROUP = 48 * 3600_000;

/**
 * ADR-134 D4: 计算实时消息窗口的地平线。
 *
 * 频道是信息流，不是对话。只要还在浏览这个 channel，最新几条帖子即便超过 48h
 * 也仍然有决策价值；否则 prompt 会退化成“可转发对象列表”，丢掉频道正文。
 */
export function resolveContextHorizonMs(chatId: number, chatType?: ChatType): number | null {
  if (chatType === "channel") return null;
  if (chatType === "private") return CONTEXT_HORIZON_MS_PRIVATE;
  if (chatType === "group" || chatType === "supergroup") return CONTEXT_HORIZON_MS_GROUP;
  return chatId > 0 ? CONTEXT_HORIZON_MS_PRIVATE : CONTEXT_HORIZON_MS_GROUP;
}

/**
 * 获取目标频道的近期消息（Telegram API 实时拉取）。
 */
export async function fetchRecentMessages(
  client: TelegramClient,
  chatId: number,
  config: Config,
  opts: {
    limit?: number;
    chatType?: ChatType;
  } = {},
): Promise<MessageRecord[]> {
  try {
    const limit = opts.limit ?? 30;
    const rawMessages = await getHistory(client, chatId, limit);

    // ADR-134 D4: 感知地平线 — 群聊与频道不能共用同一条粗粒度规则。
    // group/supergroup: 保持 48h 对话窗口；private: 7d；channel: 保留最新帖子（不限时）。
    // @see docs/adr/134-temporal-coherence.md §D4
    const horizonMs = resolveContextHorizonMs(chatId, opts.chatType);
    const floorMs = horizonMs == null ? null : Date.now() - horizonMs;
    const messages =
      floorMs == null ? rawMessages : rawMessages.filter((m) => m.date.getTime() >= floorMs);

    let records: MessageRecord[] = [];

    // 群聊元信息 + 管理员角色标注（并行获取，SQLite 持久缓存）
    const [adminMap, chatInfo] = await Promise.all([
      getAdminMap(client, chatId),
      fetchChatInfo(client, chatId),
    ]);
    // 补充 isAliceAdmin：从 outgoing 消息提取 Alice 的 user ID，写入持久缓存
    if (chatId < 0 && chatInfo) {
      const aliceId = messages.find((m) => m.isOutgoing && m.sender && "id" in m.sender)?.sender
        ?.id as number | undefined;
      if (aliceId) {
        const isAdmin = adminMap.has(aliceId);
        if (chatInfo.isAliceAdmin !== isAdmin) {
          chatInfo.isAliceAdmin = isAdmin;
          setCachedChatInfo(chatId, chatInfo);
        }
      }
    }

    // ADR-88: 收集需要异步解析的媒体消息
    const visionEnabled = isVisionEnabled(config);
    const ocrEnabled = isOcrEnabled(config);
    type MediaRef = NonNullable<(typeof messages)[number]["media"]>;
    const photosToDescribe: Array<{ index: number; fileUniqueId: string; media: MediaRef }> = [];
    // OCR 候选：独立于 VLM，即使 VLM 禁用也可工作
    const photosToOcr: Array<{ index: number; fileUniqueId: string; media: MediaRef }> = [];
    // ADR-119: 收集需要 VLM 语义描述的贴纸
    const stickersToDescribe: Array<{
      index: number;
      fileUniqueId: string;
      media: MediaRef;
      /** sourceType: "static" | "animated" | "video" */
      sourceType: string;
      /** Phase 2: 用于调色板索引 */
      emoji?: string;
      fileId: string;
    }> = [];
    // ADR-119: 收集需要 ASR 转写的语音消息
    const asrEnabled = isASREnabled(config);
    const voicesToTranscribe: Array<{ index: number; fileUniqueId: string; media: MediaRef }> = [];
    const stickersToResolve: Array<{
      index: number;
      emoji: string;
      setId: string;
      fileId: string;
      inputStickerSet: NonNullable<Sticker["inputStickerSet"]>;
    }> = [];
    const gifsToDescribe: Array<{ index: number; fileUniqueId: string; video: Video }> = [];
    const videosToDescribe: Array<{ index: number; fileUniqueId: string; video: Video }> = [];
    const linkPhotosToDescribe: Array<{ index: number; fileUniqueId: string; photo: Photo }> = [];

    for (const msg of messages) {
      const segments: ContentSegment[] = [];
      let mediaType: string | undefined;
      // ADR-78 P0 + ADR-83 D4: 非文本消息生成视觉标记，让 LLM 感知 media 存在
      if (msg.media) {
        mediaType = msg.media.type;
        if (!msg.text) {
          if (msg.media instanceof Sticker) {
            const emoji = msg.media.emoji || "";
            const stickerFileId = msg.media.fileId;
            segments.push({
              kind: "media",
              text: formatStickerMediaText({ emoji, fileId: stickerFileId }),
            });
            // ADR-119: 收集 VLM 语义描述 + Phase 2 调色板索引
            if (visionEnabled) {
              const uid = msg.media.uniqueFileId;
              if (uid) {
                stickersToDescribe.push({
                  index: records.length,
                  fileUniqueId: uid,
                  media: msg.media,
                  sourceType: msg.media.sourceType,
                  emoji: emoji || undefined,
                  fileId: stickerFileId,
                });
              }
            }
            // 收集异步解析：贴纸集标题
            const inputSet = msg.media.inputStickerSet;
            if (msg.media.hasStickerSet && inputSet && "id" in inputSet) {
              stickersToResolve.push({
                index: records.length,
                emoji,
                setId: String(inputSet.id),
                fileId: stickerFileId,
                inputStickerSet: inputSet,
              });
            }
          } else if (mediaType === "photo") segments.push({ kind: "media", text: "(photo 📷)" });
          else if (msg.media instanceof Audio) {
            segments.push({ kind: "media", text: formatAudioMediaText(msg.media) });
          } else if (mediaType === "voice") {
            segments.push({ kind: "media", text: "(voice 🎤)" });
            // ADR-119: 收集 ASR 转写
            if (asrEnabled) {
              const uid = "uniqueFileId" in msg.media ? String(msg.media.uniqueFileId) : "";
              if (uid) {
                voicesToTranscribe.push({
                  index: records.length,
                  fileUniqueId: uid,
                  media: msg.media,
                });
              }
            }
          } else if (msg.media instanceof Video) {
            if (msg.media.isAnimation) {
              segments.push({ kind: "media", text: "(gif 🎞)" });
              if (visionEnabled) {
                gifsToDescribe.push({
                  index: records.length,
                  fileUniqueId: msg.media.uniqueFileId,
                  video: msg.media,
                });
              }
            } else {
              segments.push({ kind: "media", text: "(video 🎬)" });
              if (visionEnabled) {
                videosToDescribe.push({
                  index: records.length,
                  fileUniqueId: msg.media.uniqueFileId,
                  video: msg.media,
                });
              }
            }
          } else if (mediaType === "document")
            segments.push({ kind: "media", text: "(document 📎)" });
          else if (msg.media instanceof Poll) {
            const q = msg.media.question;
            const opts = msg.media.answers.map((a) => a.text).join(" / ");
            segments.push({
              kind: "media",
              text: opts ? `(poll: ${q} — ${opts})` : `(poll: ${q})`,
            });
          } else if (msg.media instanceof TgContact) {
            const name = [msg.media.firstName, msg.media.lastName].filter(Boolean).join(" ");
            segments.push({ kind: "media", text: `(contact: ${name || "unknown"})` });
          } else if (msg.media instanceof Venue) {
            segments.push({
              kind: "media",
              text: `(venue: ${msg.media.title}, ${msg.media.address})`,
            });
          } else segments.push({ kind: "media", text: `(${mediaType})` });
        } else {
          // 有 caption 的媒体消息：body 段承载文本
          segments.push({ kind: "body", text: msg.text });
        }
        // ADR-88: 标记需要 vision 描述的 photo（仅无文本的纯图片消息）
        if (
          mediaType === "photo" &&
          segments.some((s) => s.kind === "media" && s.text === "(photo 📷)")
        ) {
          const uid = "uniqueFileId" in msg.media ? String(msg.media.uniqueFileId) : "";
          if (uid) {
            if (visionEnabled) {
              photosToDescribe.push({ index: records.length, fileUniqueId: uid, media: msg.media });
            }
            // OCR 不受 visionEnabled 约束——VLM 禁用时 OCR 仍可独立工作
            if (ocrEnabled) {
              photosToOcr.push({ index: records.length, fileUniqueId: uid, media: msg.media });
            }
          }
        }
        // WebPageMedia: 消息本身有文字（URL），链接预览附加为 link 段
        if (msg.media instanceof WebPageMedia) {
          const wp = msg.media.preview;
          const parts: string[] = [];
          if (wp.title) parts.push(wp.title);
          if (wp.description) parts.push(wp.description);
          if (parts.length > 0) {
            segments.push({ kind: "link", text: `(link: ${parts.join(" — ")})` });
          }
          // 图片链接（previewType="photo"）的预渲染图有信息量 → VLM 描述
          if (visionEnabled && wp.previewType === "photo" && wp.photo) {
            const uid = wp.photo.uniqueFileId;
            if (uid) {
              linkPhotosToDescribe.push({
                index: records.length,
                fileUniqueId: uid,
                photo: wp.photo,
              });
            }
          }
        }
      } else if (msg.text) {
        // 纯文本消息
        segments.push({ kind: "body", text: msg.text });
      }
      const text = segments.map((s) => s.text).join(" ");
      if (!text) continue; // 无文本也无媒体的消息才跳过
      let senderName = "Unknown";
      let senderId: number | undefined;
      if (msg.sender) {
        // B4 修复: 移除不安全类型断言，直接访问 mtcute Peer 接口属性
        senderName = msg.sender.displayName || `User ${msg.sender.id}`;
        if (!msg.isOutgoing) {
          senderId = msg.sender.id;
        }
        // 群聊角色标注：owner/admin + 自定义头衔
        senderName = annotateSenderRole(senderName, senderId, adminMap);
      }

      // ADR-85 D4: reply chain
      const replyToId = msg.replyToMessage?.id ?? undefined;

      // ADR-85 D5: edit awareness
      const isEdited = msg.editDate != null ? true : undefined;

      // ADR-85 D6: reaction aggregation
      let reactions: Record<string, number> | undefined;
      if (msg.reactions) {
        const counts = msg.reactions.reactions;
        if (counts.length > 0) {
          reactions = {};
          for (const r of counts) {
            const emoji = r.emoji;
            // ReactionEmoji = string | tl.Long — 只保留 string emoji
            if (typeof emoji === "string") {
              reactions[emoji] = r.count;
            }
          }
          if (Object.keys(reactions).length === 0) reactions = undefined;
        }
      }

      // 转发来源提取（IRC 风格：name ~senderId）
      let forwardFrom: string | undefined;
      if (msg.forward) {
        const fwdSender = msg.forward.sender;
        if (fwdSender) {
          const fwdName = fwdSender.displayName || "Unknown";
          const fwdId = "id" in fwdSender ? ` @${fwdSender.id}` : "";
          forwardFrom = `${fwdName}${fwdId}`;
        }
      }

      records.push({
        id: msg.id,
        senderName,
        senderId,
        isOutgoing: msg.isOutgoing,
        isBot:
          !msg.isOutgoing && msg.sender instanceof User ? msg.sender.isBot || undefined : undefined,
        text,
        date: msg.date,
        mediaType,
        replyToId,
        isEdited,
        reactions,
        forwardFrom,
        // ADR-114 D5: 传播 Telegram 原生 mention 标记
        isMention: msg.isMention || undefined,
        segments,
      });
    }
    records.reverse();

    // ── 贴纸集标题异步解析 ────────────────────────────────────────────
    if (stickersToResolve.length > 0) {
      // 先收集未缓存的 set IDs，去重（Sticker.inputStickerSet 可直接传给 getStickerSet）
      const uncachedSets = new Map<string, NonNullable<Sticker["inputStickerSet"]>>();
      for (const s of stickersToResolve) {
        if (!getCachedStickerSetTitle(s.setId)) uncachedSets.set(s.setId, s.inputStickerSet);
      }
      // 并行获取（一般 ≤5 个 set）
      if (uncachedSets.size > 0) {
        await Promise.allSettled(
          [...uncachedSets].map(async ([setId, inputStickerSet]) => {
            try {
              const set = await client.getStickerSet(inputStickerSet);
              setCachedStickerSetTitle(setId, set.title, set.shortName);
            } catch {
              /* 静默 — fallback 到纯 emoji */
            }
          }),
        );
      }
      // 回填
      for (const s of stickersToResolve) {
        const cached = getCachedStickerSetTitle(s.setId);
        const title = cached?.title;
        const reversedIdx = records.length - 1 - s.index;
        if (reversedIdx >= 0 && reversedIdx < records.length && title) {
          const newText = formatStickerMediaText({
            emoji: s.emoji,
            title,
            fileId: s.fileId,
          });
          records[reversedIdx].text = newText;
          replaceMediaSegment(records[reversedIdx], newText);
        }
      }
    }

    // ── ADR-119 + Phase 2: Sticker VLM 语义描述（共享 visionMaxPerTick 预算，优先级最高）──
    // describeMedia("sticker") 同时产出 description + StickerAnalysis（读同时写）。
    // 管线：palette check → OCR 前置过滤 → VLM 结构化分析 → 调色板入库。
    const db = getDb();
    let stickerVisionUsed = 0;
    if (stickersToDescribe.length > 0) {
      const stickerCap = Math.min(
        stickersToDescribe.length,
        Math.ceil(config.visionMaxPerTick * 0.4),
      );
      const stickerBatch = stickersToDescribe.slice(-stickerCap);
      const stickerResults = await Promise.allSettled(
        stickerBatch.map(async ({ index, fileUniqueId, media, sourceType, emoji, fileId }) => {
          // 已在调色板中 → 用缓存 description（不重复分析）
          if (isInPalette(db, fileUniqueId)) {
            const cached = getCachedDescription(fileUniqueId);
            // media-cache TTL 过期时从 palette label 取 fallback
            if (cached) return { index, fileId, caption: cached };
            const paletteLabel = db
              .select({ label: stickerPalette.label })
              .from(stickerPalette)
              .where(eq(stickerPalette.fileUniqueId, fileUniqueId))
              .limit(1)
              .get();
            return { index, fileId, caption: paletteLabel?.label };
          }
          // 缓存命中（之前分析过但不符合入库条件）
          const cached = getCachedDescription(fileUniqueId);
          if (cached) return { index, fileId, caption: cached };
          try {
            // 下载 buffer
            let buffer: Buffer;
            if (sourceType !== "static") {
              const sticker = media as Sticker;
              const thumb = sticker.thumbnails?.find(
                (t) => t.width > 0 && !Number.isNaN(t.width) && RASTER_THUMB_TYPES.has(t.type),
              );
              if (!thumb) return { index, fileId, caption: undefined };
              buffer = Buffer.from(await client.downloadAsBuffer(thumb));
            } else {
              buffer = Buffer.from(
                await client.downloadAsBuffer(
                  media as Parameters<typeof client.downloadAsBuffer>[0],
                ),
              );
            }
            if (buffer.byteLength > 512_000 || buffer.byteLength < 1024) {
              return { index, fileId, caption: undefined };
            }
            const head4 = buffer.subarray(0, 4);
            if (head4[0] === 0x3c && (head4[1] === 0x3f || head4[1] === 0x73)) {
              setCachedDescription(fileUniqueId, "sticker", "(animated sticker)");
              return { index, fileId, caption: "(animated sticker)" };
            }

            // ADR-153: AnimeIDF 门控 — 非动漫贴纸不入库
            const isAnime = await isAnimeSticker(buffer, config);
            if (!isAnime) {
              setCachedDescription(fileUniqueId, "sticker", "(non-anime sticker)");
              return { index, fileId, caption: "(non-anime sticker)" };
            }

            // OCR + VLM 并发（两者互相独立）
            const base64 = buffer.toString("base64");
            const [ocrResult, caption] = await Promise.all([
              // OCR（必执行）：提取贴纸上的文字，同时作为入库判断条件
              extractText(buffer, config).catch(() => undefined),
              // VLM 结构化分析（generateObject → description + StickerAnalysis 副产物）
              describeMedia(base64, fileUniqueId, "sticker", config),
            ]);
            const hasText = !!(ocrResult && ocrResult.trim().length > 0);

            // VLM 入库为后备池（setName=NULL）— 自己安装的贴纸优先，找不到时才用
            const analysis = getStickerAnalysis(fileUniqueId);
            if (analysis && caption && !hasText) {
              upsertFromVLM(db, {
                fileUniqueId,
                fileId,
                label: analysis.description,
                emoji,
                emotion: analysis.emotion,
                action: analysis.action,
                intensity: analysis.intensity,
              });
              log.info("Sticker indexed to palette (fallback pool)", {
                fileUniqueId,
                emotion: analysis.emotion,
              });
            }

            return { index, fileId, caption };
          } catch {
            return { index, fileId, caption: undefined };
          }
        }),
      );
      // 回填：追加 VLM 描述到已有的 (sticker ...) 文本
      for (const r of stickerResults) {
        if (r.status !== "fulfilled" || !r.value.caption) continue;
        const ri = records.length - 1 - r.value.index;
        if (ri < 0 || ri >= records.length) continue;
        const newText = formatStickerMediaText({
          title: extractStickerTitle(records[ri].text),
          description: r.value.caption,
          fileId: r.value.fileId,
        });
        records[ri].text = newText;
        replaceMediaSegment(records[ri], newText);
      }
      stickerVisionUsed = Math.min(stickerBatch.length, config.visionMaxPerTick);
    }

    // ── Photo 下载去重：VLM 和 OCR 共享同一张图片的 Buffer ──────────
    // 同一 fileUniqueId 只下载一次，后续调用复用 Promise
    const photoDownloadCache = new Map<string, Promise<Buffer>>();
    function downloadPhotoOnce(uid: string, media: MediaRef): Promise<Buffer> {
      let p = photoDownloadCache.get(uid);
      if (!p) {
        p = client
          .downloadAsBuffer(media as Parameters<typeof client.downloadAsBuffer>[0])
          .then((buf) => Buffer.from(buf));
        photoDownloadCache.set(uid, p);
      }
      return p;
    }

    // ── ADR-88: 并行获取 photo 描述（最多 visionMaxPerTick 张）────────
    // VLM 描述收集到 Map（index → caption），延迟到 OCR 完成后统一回填
    const visionCaptions = new Map<number, string>();
    if (photosToDescribe.length > 0) {
      const photoBudget = Math.max(0, config.visionMaxPerTick - stickerVisionUsed);
      const batch = photosToDescribe.slice(-photoBudget); // 优先最近的
      const results = await Promise.allSettled(
        batch.map(async ({ index, fileUniqueId, media }) => {
          try {
            const buffer = await downloadPhotoOnce(fileUniqueId, media);
            if (buffer.byteLength > 1_048_576) return { index, fileUniqueId, caption: undefined }; // > 1MB 跳过
            const base64 = buffer.toString("base64");
            const caption = await describeMedia(base64, fileUniqueId, "photo", config);
            return { index, fileUniqueId, caption };
          } catch {
            return { index, fileUniqueId, caption: undefined };
          }
        }),
      );

      // 收集 VLM 描述结果到 Map（index → caption）
      for (const r of results) {
        if (r.status === "fulfilled" && r.value.caption) {
          visionCaptions.set(r.value.index, r.value.caption);
          updateAlbumPhotoSemantics(r.value.fileUniqueId, { description: r.value.caption });
        }
      }
    }

    // ── OCR 文字提取（独立预算，不占 visionMaxPerTick）────────────────
    // OCR 结果收集到 Map，与 VLM 结果合并回填
    const ocrTexts = new Map<number, string>();
    if (photosToOcr.length > 0) {
      const ocrBatch = photosToOcr.slice(-config.ocrMaxPerTick); // 优先最近的
      const ocrResults = await Promise.allSettled(
        ocrBatch.map(async ({ index, fileUniqueId, media }) => {
          // 缓存命中
          const cached = getCachedOcrText(fileUniqueId);
          if (cached) return { index, fileUniqueId, ocrText: cached };
          try {
            const buffer = await downloadPhotoOnce(fileUniqueId, media);
            const ocrText = await extractText(buffer, config);
            if (ocrText) setCachedOcrText(fileUniqueId, ocrText);
            return { index, fileUniqueId, ocrText };
          } catch {
            return { index, fileUniqueId, ocrText: undefined };
          }
        }),
      );
      for (const r of ocrResults) {
        if (r.status === "fulfilled" && r.value.ocrText) {
          ocrTexts.set(r.value.index, r.value.ocrText);
          updateAlbumPhotoSemantics(r.value.fileUniqueId, { ocrText: r.value.ocrText });
        }
      }
    }

    // ── Photo 回填：合并 VLM 描述 + OCR 文字 ─────────────────────────
    // | 场景            | 格式                                          |
    // |-----------------|-----------------------------------------------|
    // | VLM + OCR 都有  | (photo: {VLM描述}) + meta: (image OCR text...)|
    // | 仅 VLM          | (photo: {VLM描述})                            |
    // | 仅 OCR          | (photo 📷) + meta: (image OCR text...)        |
    // | 两者都无        | (photo 📷)（不变）                            |
    {
      const allPhotoIndices = new Set([...visionCaptions.keys(), ...ocrTexts.keys()]);
      for (const idx of allPhotoIndices) {
        const reversedIndex = records.length - 1 - idx;
        if (reversedIndex < 0 || reversedIndex >= records.length) continue;

        const record = records[reversedIndex];
        const vlm = visionCaptions.get(idx);
        const ocr = ocrTexts.get(idx);
        if (vlm) {
          replaceMediaSegment(record, `(photo: ${vlm})`);
        }
        if (ocr) {
          appendSegment(record, { kind: "meta", text: formatImageOcrMetaText(ocr) });
        }
        // 两者都无 → 保持 (photo 📷) 不变
      }
    }

    // ── 统一 VLM 池化：gif/video/linkPhoto 按消息时间排序（最近优先）──
    // 替代旧的级联预算分配——video 和 linkPhoto 不再被系统性饿死。
    {
      const photoUsed = Math.min(
        photosToDescribe.length,
        Math.max(0, config.visionMaxPerTick - stickerVisionUsed),
      );
      const pool = [
        ...gifsToDescribe.map((g) => ({ ...g, mediaKind: "gif" as const })),
        ...videosToDescribe.map((v) => ({ ...v, mediaKind: "video" as const })),
        ...linkPhotosToDescribe.map((l) => ({ ...l, mediaKind: "linkPhoto" as const })),
      ];
      // 按消息 index 降序（最近的消息优先获取 VLM 描述）
      pool.sort((a, b) => b.index - a.index);
      const poolBudget = Math.max(0, config.visionMaxPerTick - stickerVisionUsed - photoUsed);
      const poolBatch = pool.slice(0, poolBudget);

      if (poolBatch.length > 0) {
        const poolResults = await Promise.allSettled(
          poolBatch.map(async (item) => {
            const { index, fileUniqueId, mediaKind } = item;
            const cached = getCachedDescription(fileUniqueId);
            if (cached) return { index, caption: cached, mediaKind };

            try {
              let buffer: Buffer;
              if (mediaKind === "linkPhoto") {
                const { photo } = item as (typeof linkPhotosToDescribe)[number] & {
                  mediaKind: "linkPhoto";
                };
                buffer = Buffer.from(await client.downloadAsBuffer(photo));
                if (buffer.byteLength > 1_048_576) return { index, caption: undefined, mediaKind };
              } else {
                const { video } = item as (typeof gifsToDescribe)[number] & {
                  mediaKind: "gif" | "video";
                };
                const thumb = video.thumbnails.find(
                  (t) => t.width > 0 && !Number.isNaN(t.width) && RASTER_THUMB_TYPES.has(t.type),
                );
                if (!thumb) return { index, caption: undefined, mediaKind };
                buffer = Buffer.from(await client.downloadAsBuffer(thumb));
                if (buffer.byteLength > 512_000) return { index, caption: undefined, mediaKind };
              }

              const base64 = buffer.toString("base64");
              const vlmType = mediaKind === "linkPhoto" ? "photo" : mediaKind;
              const caption = await describeMedia(base64, fileUniqueId, vlmType, config);
              return { index, caption, mediaKind };
            } catch {
              return { index, caption: undefined, mediaKind };
            }
          }),
        );

        for (const r of poolResults) {
          if (r.status !== "fulfilled" || !r.value.caption) continue;
          const { index, caption, mediaKind } = r.value;
          const ri = records.length - 1 - index;
          if (ri < 0 || ri >= records.length) continue;

          if (mediaKind === "gif") {
            replaceMediaSegment(records[ri], `(gif: ${caption})`);
          } else if (mediaKind === "video") {
            replaceMediaSegment(records[ri], `(video: ${caption})`);
          } else {
            // linkPhoto → image segment 追加到已有内容后
            appendSegment(records[ri], { kind: "image", text: `(image: ${caption})` });
          }
        }
      }
    }

    // ── ADR-119: Voice ASR 转写（独立预算，不占 visionMaxPerTick）─────
    const ASR_MAX_PER_TICK = 2;
    if (voicesToTranscribe.length > 0) {
      const asrBatch = voicesToTranscribe.slice(-ASR_MAX_PER_TICK);
      const asrResults = await Promise.allSettled(
        asrBatch.map(async ({ index, fileUniqueId, media }) => {
          const cached = getCachedDescription(fileUniqueId);
          if (cached) return { index, transcription: cached };
          try {
            const buffer = Buffer.from(
              await client.downloadAsBuffer(media as Parameters<typeof client.downloadAsBuffer>[0]),
            );
            if (buffer.byteLength > 10_485_760) return { index, transcription: undefined };
            const text = await transcribeVoice(buffer, config);
            if (text) setCachedDescription(fileUniqueId, "voice", text);
            return { index, transcription: text };
          } catch {
            return { index, transcription: undefined };
          }
        }),
      );
      for (const r of asrResults) {
        if (r.status === "fulfilled" && r.value.transcription) {
          const ri = records.length - 1 - r.value.index;
          if (ri >= 0 && ri < records.length) {
            const newText = `(voice 🎤: "${r.value.transcription}")`;
            records[ri].text = newText;
            replaceMediaSegment(records[ri], newText);
          }
        }
      }
    }

    // ADR-97: 回复链逸散 — 沿 replyToId 追溯窗口外的被回复消息
    const channelId = telegramChannelId(chatId);
    const diffused = diffuseReplyChain(records, channelId);
    if (diffused.length > 0) {
      const seedIds = new Set(records.map((r) => r.id));
      const unique = diffused.filter((d) => !seedIds.has(d.id));
      records = [...unique, ...records].sort((a, b) => a.date.getTime() - b.date.getTime());
    }

    // ADR-114 D2: Mention 扩散 — 获取未读 mention 并采样周围上下文
    // 必须在 markRead 之前调用（markRead 会清除未读 mention 状态）
    // @see docs/adr/114-context-assembly-rehabilitation.md — D2
    try {
      const mentionIds = await getUnreadMentionIds(client, chatId, 20);
      if (mentionIds.length > 0) {
        const existingIds = new Set(records.map((r) => r.id));
        const mentionContext: MessageRecord[] = [];

        for (const mentionMsgId of mentionIds) {
          if (mentionContext.length >= MENTION_DIFFUSION_BUDGET) break;
          if (existingIds.has(mentionMsgId)) {
            // Mention 已在窗口内 — D5 的 isMention 标记已覆盖，无需额外扩散
            continue;
          }

          // 从 DB 获取 ±radius 的消息簇
          const cluster = getMessageCluster(channelId, mentionMsgId, MENTION_CONTEXT_RADIUS);
          for (const row of cluster) {
            if (row.msgId != null && existingIds.has(row.msgId)) continue;
            if (row.msgId != null) existingIds.add(row.msgId);
            mentionContext.push({
              ...dbRecordToMessageRecord(row),
              isDiffused: undefined, // 区分于 reply chain diffusion
              isMentionContext: true,
            });
            if (mentionContext.length >= MENTION_DIFFUSION_BUDGET) break;
          }
        }

        if (mentionContext.length > 0) {
          records = [...mentionContext, ...records].sort(
            (a, b) => a.date.getTime() - b.date.getTime(),
          );
          log.debug("Mention diffusion", {
            mentionIds: mentionIds.length,
            diffusedMessages: mentionContext.length,
          });
        }
      }
    } catch (e) {
      // Mention 扩散失败不应阻断消息拉取——降级到 isMention 标记（D5 备用路径）
      log.warn("Mention diffusion failed, falling back to isMention flags", e);
    }

    // 自动已读：fetchRecentMessages 等同于"Alice 打开了聊天"，
    // 真人行为是看了就已读。不标记会导致对方看不到双勾（已读回执）。
    // ADR-114 D3: clearMentions 同时清除 mention 角标
    markRead(client, chatId).catch(() => {});

    return records;
  } catch (e) {
    log.warn("Failed to fetch message history", e);
    return [];
  }
}

// ── ADR-97: 回复链逸散上下文 ────────────────────────────────────────────
// @see docs/adr/97-reply-chain-diffusion-context.md

/** BFS 最大追溯深度。群聊回复链通常 3-5 层，深度 2 覆盖 >90%。 */
const DIFFUSION_MAX_DEPTH = 2;
/** 被回复消息前后各取的邻近消息数。 */
const DIFFUSION_CONTEXT_RADIUS = 1;
/** 追溯消息总量上限，防止 token 膨胀。 */
const DIFFUSION_BUDGET = 15;

// ADR-114 D2: Mention 扩散常量
/** Mention 消息前后各取的邻近消息数。比 reply chain 多一层上下文。 */
const MENTION_CONTEXT_RADIUS = 2;
/** Mention 扩散消息总量上限。 */
const MENTION_DIFFUSION_BUDGET = 20;

/** DB 记录 → MessageRecord 转换。逸散消息缺少 reactions 等实时字段。 */
function dbRecordToMessageRecord(r: DbMessageRecord): MessageRecord {
  // ADR-119: 媒体消息的 text 可能为 null，用占位符标注
  let text = r.text ?? "(no text)";
  if (!r.text && r.mediaType) {
    const labels: Record<string, string> = {
      sticker: "(sticker)",
      photo: "(photo 📷)",
      voice: "(voice 🎤)",
      audio: "(audio 🎵)",
      video: "(video 🎬)",
      document: "(document 📎)",
    };
    text = labels[r.mediaType] ?? `(${r.mediaType})`;
  }
  return {
    id: r.msgId ?? 0, // Telegram msgId 从 1 开始；null → 0 标识无 ID 的记录（Alice 自发消息）
    senderName: r.senderName ?? "Unknown",
    senderId: r.senderId ? Number(r.senderId.replace("contact:", "")) || undefined : undefined,
    isOutgoing: r.isOutgoing,
    text,
    date: r.createdAt,
    mediaType: r.mediaType ?? undefined,
    replyToId: r.replyToMsgId ?? undefined,
    isDiffused: true,
  };
}

/**
 * 回复链逸散：沿 replyToId 边 BFS 扩展滑动窗口。
 *
 * 以 seeds 中超出窗口的 replyToId 为起点，从 messageLog 追溯被回复消息
 * 及其 ±radius 邻近消息，形成"逸散 cluster"。
 *
 * @param seeds 滑动窗口原始消息
 * @param chatId 频道 ID（messageLog 的 chatId 格式，如 "channel:telegram:123"）
 * @returns 需要插入的逸散消息（已按时间排序，带 isDiffused=true）
 */
export function diffuseReplyChain(seeds: MessageRecord[], chatId: string): MessageRecord[] {
  const seedIds = new Set(seeds.map((s) => s.id));
  const visited = new Set(seedIds);
  const diffused: MessageRecord[] = [];

  // 收集 seeds 中 replyToId 不在 seeds 的消息 → 初始 frontier
  let frontier = new Set<number>();
  for (const seed of seeds) {
    if (seed.replyToId && !seedIds.has(seed.replyToId)) {
      frontier.add(seed.replyToId);
    }
  }

  for (let depth = 0; depth < DIFFUSION_MAX_DEPTH && frontier.size > 0; depth++) {
    const nextFrontier = new Set<number>();
    for (const targetMsgId of frontier) {
      if (diffused.length >= DIFFUSION_BUDGET) break;
      if (visited.has(targetMsgId)) continue;

      const cluster = getMessageCluster(chatId, targetMsgId, DIFFUSION_CONTEXT_RADIUS);
      for (const row of cluster) {
        if (row.msgId != null && visited.has(row.msgId)) continue;
        if (row.msgId != null) visited.add(row.msgId);
        diffused.push(dbRecordToMessageRecord(row));
        if (diffused.length >= DIFFUSION_BUDGET) break;

        // 递归：cluster 中的回复关系加入下轮 frontier
        if (row.replyToMsgId && !visited.has(row.replyToMsgId)) {
          nextFrontier.add(row.replyToMsgId);
        }
      }
    }
    frontier = nextFrontier;
  }

  // 按时间排序
  diffused.sort((a, b) => a.date.getTime() - b.date.getTime());
  return diffused;
}
