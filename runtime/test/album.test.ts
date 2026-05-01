import { tl } from "@mtcute/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getAlbumPhoto,
  markAlbumPhotoSourceStatus,
  recordAlbumUsage,
  recordObservedGroupPhoto,
  searchAlbumPhotos,
  updateAlbumPhotoSemantics,
} from "../src/db/album.js";
import { closeDb, getSqlite, initDb } from "../src/db/connection.js";
import { buildAlbumSearchObservation } from "../src/system/album-cli.js";
import { classifyAlbumSourceError, forwardMessage } from "../src/telegram/actions.js";

describe("group photo album", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("indexes observed group photos and searches semantic text", () => {
    const asset = recordObservedGroupPhoto({
      fileUniqueId: "photo-unique-1",
      sourceChatId: -1001,
      sourceMsgId: 42,
      captionText: "field snapshot",
      description: "a daisy flower on a wooden table",
      observedAtMs: 1_000,
    });

    const results = searchAlbumPhotos({ query: "daisy", limit: 3 });

    expect(results).toHaveLength(1);
    expect(results[0].assetId).toBe(asset.assetId);
    expect(results[0].sourceChatId).toBe(-1001);
    expect(results[0].sourceMsgId).toBe(42);
  });

  it("updates searchable semantics after VLM/OCR completes", () => {
    recordObservedGroupPhoto({
      fileUniqueId: "photo-unique-2",
      sourceChatId: -1001,
      sourceMsgId: 43,
      captionText: null,
      observedAtMs: 1_000,
    });

    expect(searchAlbumPhotos({ query: "chamomile" })).toHaveLength(0);

    updateAlbumPhotoSemantics("photo-unique-2", {
      description: "fresh chamomile flowers",
      ocrText: "tea menu",
    });

    const results = searchAlbumPhotos({ query: "chamomile" });
    expect(results).toHaveLength(1);
    expect(results[0].description).toBe("fresh chamomile flowers");
  });

  it("excludes missing source messages by default", () => {
    const asset = recordObservedGroupPhoto({
      fileUniqueId: "photo-unique-3",
      sourceChatId: -1001,
      sourceMsgId: 44,
      description: "deleted daisy photo",
      observedAtMs: 1_000,
    });

    markAlbumPhotoSourceStatus(asset.assetId, "missing", "album_source_missing");

    expect(searchAlbumPhotos({ query: "daisy" })).toHaveLength(0);
    expect(searchAlbumPhotos({ query: "daisy", includeUnavailable: true })).toHaveLength(1);
    expect(getAlbumPhoto(asset.assetId)?.sourceStatus).toBe("missing");
  });

  it("records append-only album usage facts", () => {
    recordAlbumUsage({
      assetId: "photo:usage",
      targetChatId: -1002,
      sentMsgId: 99,
      sendMode: "no_author_forward",
      usedAtMs: 2_000,
    });

    const rows = getSqlite().prepare("SELECT * FROM album_usage").all() as Array<{
      asset_id: string;
      target_chat_id: number;
      sent_msg_id: number;
      send_mode: string;
      used_at_ms: number;
    }>;

    expect(rows).toMatchObject([
      {
        asset_id: "photo:usage",
        target_chat_id: -1002,
        sent_msg_id: 99,
        send_mode: "no_author_forward",
        used_at_ms: 2_000,
      },
    ]);
  });
});

describe("album CLI observation contract", () => {
  it("marks search candidates as actionable send_album_photo observations", () => {
    const observation = buildAlbumSearchObservation(
      [
        {
          assetId: "photo:cat",
          sourceChatId: -1001,
          sourceMsgId: 42,
          captionText: null,
          description: "cat on a laptop",
          wdTagsJson: null,
          ocrText: null,
          sourceStatus: "available",
          score: 0.75,
          snippet: null,
        },
      ],
      -1002,
    );

    expect(observation).toMatchObject({
      kind: "query_result",
      source: "album.search",
      enablesContinuation: true,
      currentChatId: "-1002",
      targetChatId: "-1002",
      payload: {
        intent: "send_album_photo",
        candidates: [
          {
            assetId: "photo:cat",
            sourceChatId: -1001,
            sourceMsgId: 42,
            sourceStatus: "available",
            score: 0.75,
          },
        ],
      },
    });
  });

  it("marks empty search as non-continuing empty observation", () => {
    const observation = buildAlbumSearchObservation([], -1002);

    expect(observation).toMatchObject({
      kind: "empty",
      source: "album.search",
      enablesContinuation: false,
      payload: { intent: "send_album_photo", candidates: [] },
    });
  });
});

describe("album Telegram actions", () => {
  it("passes noAuthor through to mtcute forwardMessagesById", async () => {
    const calls: unknown[] = [];
    const client = {
      forwardMessagesById: async (params: unknown) => {
        calls.push(params);
        return [{ id: 77 }];
      },
    };

    const msgId = await forwardMessage(client as never, -1001, 42, -1002, { noAuthor: true });

    expect(msgId).toBe(77);
    expect(calls).toEqual([
      {
        fromChatId: -1001,
        messages: [42],
        toChatId: -1002,
        noAuthor: true,
        noCaption: undefined,
      },
    ]);
  });

  it("classifies deleted source messages from structured RPC errors", () => {
    expect(classifyAlbumSourceError(new tl.RpcError(400, "MESSAGE_ID_INVALID"))).toBe(
      "album_source_missing",
    );
    expect(classifyAlbumSourceError(new tl.RpcError(400, "CHAT_FORWARDS_RESTRICTED"))).toBe(
      "album_forward_restricted",
    );
  });
});
