/**
 * search 类别动作：search, read_notes。
 *
 * @see docs/adr/145-local-fulltext-search.md
 * @see docs/adr/149-define-action-builder.md
 */

import { z } from "zod";
import {
  type FtsMessageResult,
  searchDiaryFts,
  searchMessagesFts,
  searchThreadsFts,
} from "../../db/fts.js";
import { activationRetrieval } from "../../graph/activation.js";
import { telegramChannelId, telegramContactId } from "../../graph/constants.js";
import { defineAction } from "../action-builder.js";
import { readNotesContract, unifiedSearchContract } from "../action-contracts.js";
import type {
  DiarySearchResultItem,
  LocalSearchResultItem,
  RelatedFactItem,
  ThreadSearchResultItem,
} from "../action-schemas.js";
import type { TelegramActionDef } from "../action-types.js";
import { readSavedMessages } from "../actions.js";

export const searchActions: TelegramActionDef[] = [
  // ADR-145 W3: 统一搜索（messages + diary + threads，替代旧 search_fts5）
  defineAction({
    name: "search",
    category: "search",
    description: [
      "Search your local records — messages, diary entries, narrative threads.",
      'FTS5 expression syntax: space = AND, OR / NOT / "phrase" / prefix*.',
      "Results appear in the next round.",
    ],
    usageHint:
      'Local search across all your data. Examples: `search("天气")`, `search("旅行计划", { source: "diary" })`, `search("毕业", { source: "threads" })`.',
    params: z.object({
      expression: z
        .string()
        .describe('FTS5 match expression. Space = AND, supports OR / NOT / "phrase" / prefix*'),
      source: z
        .string()
        .optional()
        .describe('Where to search: "messages" | "diary" | "threads" | "all" (default "all")'),
      chatId: z.number().optional().describe("Limit search to specific chat (Telegram chat ID)"),
      senderId: z.number().optional().describe("Filter by sender (Telegram user ID)"),
      after: z
        .string()
        .optional()
        .describe('Only results after this date (ISO format, e.g. "2024-01-15")'),
      before: z
        .string()
        .optional()
        .describe('Only results before this date (ISO format, e.g. "2024-06-01")'),
      limit: z.number().optional().describe("Max results per source (default 10, max 20)"),
    }),
    contract: unifiedSearchContract,
    returnDoc: "Results available in the next round as observation (`self.last_search`).",
    affordance: {
      whenToUse: "Find past messages, diary entries, or narrative threads by content",
      whenNotToUse: "When recent context is already visible",
      priority: "core",
    },
    async impl(ctx, args) {
      const expression = (args.expression ?? "").trim();
      if (!expression) return false;

      const source = (args.source ?? "all") as "messages" | "diary" | "threads" | "all";
      const chatId = args.chatId != null ? telegramChannelId(args.chatId) : undefined;
      const senderId = args.senderId != null ? telegramContactId(args.senderId) : undefined;
      const limit = args.limit != null ? Math.min(args.limit, 20) : 10;

      let afterTs: number | undefined;
      let beforeTs: number | undefined;
      if (args.after != null) {
        const ms = new Date(args.after).getTime();
        if (!Number.isNaN(ms)) afterTs = Math.floor(ms / 1000);
      }
      if (args.before != null) {
        const ms = new Date(args.before).getTime();
        if (!Number.isNaN(ms)) beforeTs = Math.floor(ms / 1000);
      }

      let messages: LocalSearchResultItem[] | undefined;
      let diary: DiarySearchResultItem[] | undefined;
      let threads: ThreadSearchResultItem[] | undefined;
      let msgRows: FtsMessageResult[] | undefined;

      try {
        if (source === "messages" || source === "all") {
          msgRows = searchMessagesFts(expression, { chatId, senderId, afterTs, beforeTs, limit });
          messages = msgRows.map((r) => ({
            msgId: r.msgId,
            chatId: r.chatId,
            sender: r.senderName ?? (r.isOutgoing ? "Alice" : "Unknown"),
            text: r.text ? (r.text.length > 150 ? `${r.text.slice(0, 150)}...` : r.text) : "",
            snippet: r.snippet ?? undefined,
            date: r.createdAt.toISOString(),
            isOutgoing: r.isOutgoing,
          }));
        }

        if (source === "diary" || source === "all") {
          const rows = searchDiaryFts(expression, { afterTs, beforeTs, limit });
          diary = rows.map((r) => ({
            id: r.id,
            content: r.content,
            about: r.about,
            date: r.createdAt.toISOString(),
          }));
        }

        if (source === "threads" || source === "all") {
          const rows = searchThreadsFts(expression, { limit });
          threads = rows.map((r) => ({
            id: r.id,
            title: r.title,
            status: r.status,
            weight: r.weight,
            summary: r.summary,
          }));
        }
      } catch (e) {
        ctx.log.warn("FTS query failed (invalid expression?)", { expression, source, error: e });
        return false;
      }

      // 图记忆融合：从消息结果中提取 sender → spreading activation → 关联事实
      let relatedFacts: RelatedFactItem[] | undefined;
      if (msgRows?.length) {
        const uniqueSenderIds = [
          ...new Set(
            msgRows
              .filter(
                (r): r is FtsMessageResult & { senderId: string } => !r.isOutgoing && !!r.senderId,
              )
              .map((r) => r.senderId),
          ),
        ];

        if (uniqueSenderIds.length > 0) {
          try {
            const hits = activationRetrieval(ctx.G, uniqueSenderIds, Date.now());
            const topHits = hits.slice(0, 5);
            if (topHits.length > 0) {
              relatedFacts = topHits.flatMap((h) => {
                try {
                  const content = ctx.G.getFact(h.entityId).content;
                  if (!content) return [];
                  return [{ entity: h.entityId, fact: content, activation: h.activation }];
                } catch {
                  // 节点不存在或类型不匹配——跳过该条，不中断其他结果
                  return [];
                }
              });
            }
          } catch (e) {
            ctx.log.warn("activation retrieval skipped", { error: e });
          }
        }
      }

      unifiedSearchContract.store(ctx.G, "self", {
        expression,
        source,
        messages,
        diary,
        threads,
        relatedFacts: relatedFacts?.length ? relatedFacts : undefined,
      });

      const totalCount = (messages?.length ?? 0) + (diary?.length ?? 0) + (threads?.length ?? 0);
      ctx.log.info("search executed", {
        expression,
        source,
        chatId,
        resultCount: totalCount,
        relatedFactCount: relatedFacts?.length ?? 0,
      });
      return true;
    },
  }),

  defineAction({
    name: "read_notes",
    category: "search",
    description: ["Read recent notes from Saved Messages. Results available in the next round."],
    usageHint: "Read back saved notes. Use to recall bookmarks, reminders, or past thoughts.",
    params: z.object({
      limit: z.number().optional().describe("Max notes to read (default 10, max 20)"),
    }),
    contract: readNotesContract,
    returnDoc: "Results available in the next round as observation (`self.last_notes`).",
    affordance: {
      whenToUse: "Read back saved notes and bookmarks",
      whenNotToUse: "When you haven't saved any notes recently",
      priority: "capability",
      category: "chat_history",
    },
    async impl(ctx, args) {
      const limit = args.limit != null ? Math.min(args.limit, 20) : 10;
      const messages = await readSavedMessages(ctx.client, limit);

      const notes = messages.map((m) => ({
        id: m.id,
        text: m.text ? (m.text.length > 200 ? `${m.text.slice(0, 200)}...` : m.text) : "",
        date: m.date.toISOString(),
      }));
      readNotesContract.store(ctx.G, "self", notes);
      ctx.log.info("read_notes executed", { noteCount: notes.length });
      return true;
    },
  }),
];
