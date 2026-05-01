/**
 * ADR-260: group photo album send use case.
 *
 * This module owns album-specific send policy and album fact writes. Runtime wiring
 * such as graph feedback stays in index.ts via onSent.
 *
 * @see docs/adr/260-group-photo-album-affordance/README.md
 */
import type { TelegramClient } from "@mtcute/node";
import {
  type AlbumSendMode,
  getAlbumPhoto,
  markAlbumPhotoSourceStatus,
  recordAlbumUsage,
} from "../db/album.js";
import { createLogger } from "../utils/logger.js";
import { classifyAlbumSourceError, forwardMessage, uploadMessageMediaCopy } from "./actions.js";
import { TelegramActionError } from "./errors.js";

const log = createLogger("album-send");

export interface SendAlbumPhotoParams {
  assetId: string;
  targetChatId: number;
  caption?: string;
  replyTo?: number;
  onSent?: (msgId: number) => void;
}

export interface SendAlbumPhotoResult {
  msgId: number | null;
  sendMode: AlbumSendMode;
  assetId: string;
}

function recordFailure(
  assetId: string,
  targetChatId: number,
  code: string,
  sendMode: AlbumSendMode,
) {
  recordAlbumUsage({
    assetId,
    targetChatId,
    sendMode,
    failureCode: code,
  });
}

function markUnavailableSource(
  assetId: string,
  code: "album_source_missing" | "album_source_inaccessible",
) {
  markAlbumPhotoSourceStatus(
    assetId,
    code === "album_source_missing" ? "missing" : "inaccessible",
    code,
  );
}

function emitSent(onSent: SendAlbumPhotoParams["onSent"], msgId: number | undefined): void {
  if (msgId != null) onSent?.(msgId);
}

export async function sendAlbumPhoto(
  client: TelegramClient,
  params: SendAlbumPhotoParams,
): Promise<SendAlbumPhotoResult> {
  const { assetId, targetChatId, caption, replyTo, onSent } = params;
  const asset = getAlbumPhoto(assetId);
  if (!asset) {
    throw new TelegramActionError("album_asset_not_found", `album asset not found: ${assetId}`);
  }
  if (asset.sourceStatus !== "available") {
    throw new TelegramActionError(
      asset.sourceStatus === "missing" ? "album_source_missing" : "album_source_inaccessible",
      `album asset source is ${asset.sourceStatus}: ${assetId}`,
      { assetId, sourceStatus: asset.sourceStatus },
    );
  }

  try {
    const msgId = await forwardMessage(
      client,
      asset.sourceChatId,
      asset.sourceMsgId,
      targetChatId,
      { noAuthor: true },
    );
    recordAlbumUsage({
      assetId,
      targetChatId,
      sentMsgId: msgId ?? null,
      sendMode: "no_author_forward",
    });
    emitSent(onSent, msgId);
    return { msgId: msgId ?? null, sendMode: "no_author_forward", assetId };
  } catch (err) {
    const code = classifyAlbumSourceError(err);
    if (code === "album_source_missing" || code === "album_source_inaccessible") {
      markUnavailableSource(assetId, code);
      recordFailure(assetId, targetChatId, code, "no_author_forward");
      throw new TelegramActionError(code, `album source unavailable: ${assetId}`, {
        assetId,
        sourceChatId: asset.sourceChatId,
        sourceMsgId: asset.sourceMsgId,
      });
    }
    if (code && code !== "album_forward_restricted") {
      recordFailure(assetId, targetChatId, code, "no_author_forward");
      throw new TelegramActionError(code, `album no-author forward failed: ${assetId}`);
    }
    if (!code) {
      recordFailure(assetId, targetChatId, "album_send_failed", "no_author_forward");
      throw new TelegramActionError(
        "album_send_failed",
        `album no-author forward failed: ${assetId}`,
        {
          assetId,
          sourceChatId: asset.sourceChatId,
          sourceMsgId: asset.sourceMsgId,
        },
      );
    }
    log.warn("Album no-author forward failed; trying download/upload fallback", {
      assetId,
      code,
    });
  }

  try {
    const msgId = await uploadMessageMediaCopy(
      client,
      asset.sourceChatId,
      asset.sourceMsgId,
      targetChatId,
      { caption, replyToMsgId: replyTo },
    );
    recordAlbumUsage({
      assetId,
      targetChatId,
      sentMsgId: msgId ?? null,
      sendMode: "download_upload",
    });
    emitSent(onSent, msgId);
    return { msgId: msgId ?? null, sendMode: "download_upload", assetId };
  } catch (err) {
    const code =
      err instanceof TelegramActionError
        ? err.code
        : (classifyAlbumSourceError(err) ?? "album_send_failed");
    if (code === "album_source_missing" || code === "album_source_inaccessible") {
      markUnavailableSource(assetId, code);
    }
    recordFailure(assetId, targetChatId, code, "download_upload");
    throw err instanceof TelegramActionError
      ? err
      : new TelegramActionError("album_send_failed", `album send failed: ${assetId}`, {
          assetId,
          cause: err instanceof Error ? err.message : String(err),
        });
  }
}
