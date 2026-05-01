import { defineCommand } from "citty";
import { engineGet, enginePost } from "../../skills/_lib/engine-client.js";
import type { ExecutionObservation } from "../core/script-execution.js";
import { parseMsgId, resolveTarget } from "./chat-client.js";
import { renderConfirm, truncate } from "./cli-bridge.js";
import { assertCurrentChatForSend, OBSERVATION_PREFIX } from "./cli-commands.js";
import { createRealContext } from "./cli-io.js";
import { filterOutput, parseOutputMode } from "./cli-json.js";
import { makeDie } from "./cli-types.js";

const ACTION_PREFIX = "__ALICE_ACTION__:";

const jsonFlag = {
  json: {
    type: "string" as const,
    description: "Output as JSON with specified fields (comma-separated). Omit for human-readable.",
    valueHint: "fields",
  },
};

const inOption = {
  type: "string" as const,
  description: "Target chat (@ID or numeric). Omit to use current chat context.",
  valueHint: "chatId",
};

interface AlbumSearchResult {
  assetId: string;
  sourceChatId: number;
  sourceMsgId: number;
  captionText: string | null;
  description: string | null;
  wdTagsJson: string | null;
  ocrText: string | null;
  sourceStatus: string;
  score: number;
  snippet: string | null;
}

function renderSearchResults(results: AlbumSearchResult[]): string {
  if (results.length === 0) return "(no album photos)";
  return results
    .map((r) => {
      const label = r.description ?? r.captionText ?? r.ocrText ?? r.snippet ?? "(photo)";
      return `${r.assetId} @${r.sourceChatId}#${r.sourceMsgId} — ${truncate(label, 120)}`;
    })
    .join("\n");
}

export function buildAlbumSearchObservation(
  results: readonly AlbumSearchResult[],
  currentChatId?: number | null,
): ExecutionObservation {
  if (results.length === 0) {
    return {
      kind: "empty",
      source: "album.search",
      text: "no album photo candidates",
      enablesContinuation: false,
      currentChatId: currentChatId == null ? null : String(currentChatId),
      targetChatId: currentChatId == null ? null : String(currentChatId),
      payload: { intent: "send_album_photo", candidates: [] },
    };
  }

  return {
    kind: "query_result",
    source: "album.search",
    text: `${results.length} album photo candidate${results.length === 1 ? "" : "s"}`,
    enablesContinuation: true,
    currentChatId: currentChatId == null ? null : String(currentChatId),
    targetChatId: currentChatId == null ? null : String(currentChatId),
    payload: {
      intent: "send_album_photo",
      candidates: results.map((result) => ({
        assetId: result.assetId,
        sourceChatId: result.sourceChatId,
        sourceMsgId: result.sourceMsgId,
        sourceStatus: result.sourceStatus,
        score: result.score,
      })),
    },
  };
}

const search = defineCommand({
  meta: { name: "search", description: "Search Alice's group photo album" },
  args: {
    ...jsonFlag,
    query: {
      type: "string",
      description: "Semantic image query",
      required: true,
      valueHint: "query",
    },
    count: {
      type: "string",
      description: "Maximum number of results",
      default: "5",
      valueHint: "n",
    },
    "include-unavailable": {
      type: "boolean",
      description: "Include photos whose source message is missing or inaccessible",
      default: false,
    },
  },
  async run({ args }) {
    const ctx = createRealContext();
    const mode = parseOutputMode("album-search", args.json as string | undefined);
    const count = Number(args.count);
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new Error("--count requires a positive integer");
    }
    const params = new URLSearchParams({
      query: String(args.query),
      limit: String(count),
    });
    if (args["include-unavailable"]) params.set("includeUnavailable", "true");
    const response = (await engineGet(`/album/search?${params.toString()}`)) as {
      results?: AlbumSearchResult[];
    } | null;
    const rawResult = response?.results ?? [];
    console.log(
      `${OBSERVATION_PREFIX}${JSON.stringify(buildAlbumSearchObservation(rawResult, ctx.currentChatId))}`,
    );
    if (mode.type === "json") {
      console.log(
        JSON.stringify(
          filterOutput(rawResult as unknown as Record<string, unknown>[], mode.fields),
          null,
          2,
        ),
      );
      return;
    }
    console.log(renderSearchResults(rawResult));
  },
});

const send = defineCommand({
  meta: { name: "send", description: "Send a group photo album asset" },
  args: {
    ...jsonFlag,
    in: inOption,
    asset: {
      type: "string",
      description: "Album asset ID returned by album search",
      required: true,
      valueHint: "assetId",
    },
    caption: {
      type: "string",
      description: "Optional caption for download/upload fallback",
      valueHint: "message",
    },
    ref: {
      type: "string",
      description: "Visible current-chat message ID to reply to",
      valueHint: "msgId",
    },
  },
  async run({ args }) {
    const ctx = createRealContext();
    const die = makeDie(ctx.output, "album");
    const mode = parseOutputMode("album-send", args.json as string | undefined);
    const targetChatId = await resolveTarget(args.in as string | undefined);
    const replyTo = args.ref ? parseMsgId(args.ref as string) : undefined;
    assertCurrentChatForSend(
      ctx,
      targetChatId,
      die,
      "album.send",
      replyTo ? { replyTo } : undefined,
    );

    const assetId = String(args.asset).trim();
    const response = (await enginePost("/album/send", {
      assetId,
      targetChatId,
      caption: typeof args.caption === "string" ? args.caption : undefined,
      replyTo,
    })) as { msgId?: number | null; sendMode?: string; assetId?: string } | null;

    if (response?.msgId != null) {
      console.log(`${ACTION_PREFIX}sent:chatId=${targetChatId}:msgId=${response.msgId}`);
    }
    const rawResult = {
      msgId: response?.msgId ?? null,
      chatId: targetChatId,
      assetId,
      sendMode: response?.sendMode ?? null,
    };
    if (mode.type === "json") {
      console.log(
        JSON.stringify(filterOutput(rawResult as Record<string, unknown>, mode.fields), null, 2),
      );
      return;
    }
    console.log(
      renderConfirm("Sent album photo", `${assetId} (${response?.sendMode ?? "unknown"})`),
    );
  },
});

export const albumSubCommands = {
  search,
  send,
} as const;

export const albumCommand = defineCommand({
  meta: {
    name: "album",
    description: "Search and send Alice's group photo album",
  },
  subCommands: albumSubCommands,
});
