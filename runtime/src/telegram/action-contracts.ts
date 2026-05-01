/**
 * Result Contract — CQRS 查询结果的类型安全桥梁。
 *
 * Schema 是 write（impl store）和 read（formatResult safeParse）的单一真相来源。
 * 消除了 impl 与 formatResult 之间的隐式形状同步。
 *
 * 返回值满足 QueryRuntimeFields（运行时 CQRS 子集）——
 * 展开到 TelegramActionDef 时由 action 注册补齐 returnDoc，编译期强制完整性。
 *
 * @see docs/adr/105-react-cqrs-read-during-next.md
 * @see src/telegram/action-types.ts — QueryRuntimeFields / QueryActionFields 类型
 */

import { z } from "zod";
import { PromptBuilder } from "../core/prompt-style.js";
import type { WorldModel } from "../graph/world-model.js";
import {
  BotCommandsResult,
  CallbackAnswerResult,
  ChatPreviewResult,
  CommandOutputResult,
  InlineQueryResult,
  NoteItem,
  SearchPublicResult,
  SimilarChannelItem,
  StickerSetDetail,
  StickerSetSummary,
  UnifiedSearchResult,
} from "./action-schemas.js";
import type { QueryRuntimeFields } from "./action-types.js";

// ═══════════════════════════════════════════════════════════════════════════
// Contract 工厂
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 创建类型安全的 CQRS result contract。
 *
 * 返回对象同时满足：
 * - `QueryActionFields`（展开到 TelegramActionDef）
 * - `store()` 方法（impl 调用，编译期类型检查）
 *
 * @param schema Zod schema — write/read 的单一真相来源
 * @param source 结果存储节点语义——"self" 或 "target"
 * @param attrKey 图属性名——结果存储在此属性中
 * @param format 格式化函数——将结果转为 observation 文本行
 */
export function resultContract<T extends z.ZodTypeAny>(
  schema: T,
  source: "self" | "target",
  attrKey: string,
  format: (data: z.infer<T>) => string[] | null,
) {
  return {
    returnsResult: true as const,
    resultSource: source,
    resultAttrKey: attrKey,
    /** impl 调用——编译期类型检查，确保存入数据匹配 schema。 */
    store(G: WorldModel, nodeId: string, data: z.infer<T>): void {
      if (!G.has(nodeId)) return;
      G.setDynamic(nodeId, attrKey, data);
    },
    /** formatQueryObservations 调用——运行时 safeParse + 格式化。 */
    formatResult(raw: unknown): string[] | null {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) return null;
      return format(parsed.data);
    },
  } satisfies QueryRuntimeFields & {
    store: (G: WorldModel, nodeId: string, data: z.infer<T>) => void;
  };
}

/** resultContract 返回类型（含 store 方法）。 */
export type ResultContract<T extends z.ZodTypeAny> = ReturnType<typeof resultContract<T>>;

// ═══════════════════════════════════════════════════════════════════════════
// Contract 实例
// ═══════════════════════════════════════════════════════════════════════════

// ── Bot 交互 ──

export const clickInlineButtonContract = resultContract(
  CallbackAnswerResult,
  "target",
  "last_callback_answer",
  ({ msgId, message, url }) => {
    if (!message && !url) return null;
    const m = new PromptBuilder();
    m.line(`Button callback result (msg #${msgId}):`);
    if (message) m.kv("Message", message);
    if (url) m.kv("URL", url);
    return m.build();
  },
);

export const inlineQueryContract = resultContract(
  InlineQueryResult,
  "target",
  "last_inline_query",
  ({ botUsername, queryId, results }) => {
    if (results.length === 0) return null;
    const m = new PromptBuilder();
    m.line(`Inline results from @${botUsername} (queryId: ${queryId}):`);
    for (const r of results.slice(0, 10)) {
      m.line(
        `• ${r.title ?? "(no title)"}${r.description ? ` — ${r.description}` : ""} [resultId: ${r.id}]`,
      );
    }
    m.line("→ send_inline_result(queryId, resultId) — copy the queryId and resultId above.");
    return m.build();
  },
);

// ── 贴纸 ──

export const listStickersContract = resultContract(
  z.array(StickerSetSummary),
  "self",
  "installed_stickers",
  (data) => {
    if (data.length === 0) return null;
    const m = new PromptBuilder();
    m.line("Installed sticker sets:");
    for (const s of data.slice(0, 15)) {
      m.line(`${s.shortName} — "${s.title}" (${s.count} stickers)`);
    }
    m.line(
      "→ Use `irc sticker --keyword <keyword>` with palette dimensions: happy, sad, angry, surprised, shy, tired, love, scared, wave, hug, cry, laugh, sleep, eat, dance, thumbsup, facepalm, peek.",
    );
    return m.build();
  },
);

export const getStickerSetContract = resultContract(
  StickerSetDetail,
  "self",
  "last_sticker_set",
  ({ shortName, title, stickers }) => {
    if (stickers.length === 0) return null;
    const m = new PromptBuilder();
    m.line(`Sticker set "${title}" (${shortName}):`);
    for (const s of stickers.slice(0, 20)) {
      if (!s.emoji) continue;
      m.line(`${s.emoji}`);
    }
    m.line(
      "→ Use `irc sticker --keyword <keyword>` with a palette dimension such as happy, shy, laugh, hug, wave, or peek.",
    );
    return m.build();
  },
);

// ── 搜索 ──

/** ADR-145 W3: 统一搜索 contract（多源联合：messages/diary/threads/all）。 */
export const unifiedSearchContract = resultContract(
  UnifiedSearchResult,
  "self",
  "last_search",
  ({ expression, source, messages, diary, threads, relatedFacts }) => {
    const totalCount = (messages?.length ?? 0) + (diary?.length ?? 0) + (threads?.length ?? 0);
    if (totalCount === 0) return [`No results for "${expression}" in ${source}.`];
    const m = new PromptBuilder();
    m.line(`Search results for "${expression}" (${source}, ${totalCount} found):`);

    if (messages?.length) {
      if (source === "all") m.line("— Messages:");
      for (const r of messages.slice(0, 10)) {
        const time = r.date.slice(11, 16);
        // 优先用 FTS5 snippet（已标记命中关键词），否则截断原文
        const preview = r.snippet || (r.text.length > 120 ? `${r.text.slice(0, 120)}...` : r.text);
        m.line(`[${time}] ${r.sender} (${r.chatId}): ${preview}`);
      }
    }
    if (diary?.length) {
      if (source === "all") m.line("— Diary:");
      for (const d of diary.slice(0, 5)) {
        const time = d.date.slice(0, 10);
        const aboutLabel = d.about ? ` [about ${d.about}]` : "";
        m.line(`[${time}]${aboutLabel} ${d.content}`);
      }
    }
    if (threads?.length) {
      if (source === "all") m.line("— Threads:");
      for (const t of threads.slice(0, 5)) {
        m.line(
          `#${t.id} "${t.title}" (${t.status}/${t.weight})${t.summary ? ` — ${t.summary.slice(0, 80)}` : ""}`,
        );
      }
    }
    if (relatedFacts?.length) {
      m.line("— Related memories:");
      for (const f of relatedFacts) {
        m.line(`· ${f.fact}`);
      }
    }
    return m.build();
  },
);

export const searchPublicContract = resultContract(
  SearchPublicResult,
  "self",
  "last_search_public",
  ({ query, users, chats }) => {
    if (users.length === 0 && chats.length === 0) return null;
    const m = new PromptBuilder();
    m.line(`Public search results for "${query}":`);
    for (const c of chats.slice(0, 10)) {
      m.line(`[chat ${c.id}] ${c.title}`);
    }
    for (const u of users.slice(0, 5)) {
      m.line(`[user ${u.id}] ${u.name}`);
    }
    return m.build();
  },
);

export const previewChatContract = resultContract(
  ChatPreviewResult,
  "self",
  "last_chat_preview",
  ({ title, type, memberCount, withApproval, link }) => {
    return [
      `Chat preview: "${title}" (${type}, ${memberCount} members${withApproval ? ", requires approval" : ""})`,
      `→ Join via \`irc join ${link}\`.`,
    ];
  },
);

export const getSimilarChannelsContract = resultContract(
  z.array(SimilarChannelItem),
  "target",
  "similar_channels",
  (data) => {
    if (data.length === 0) return null;
    const m = new PromptBuilder();
    m.line("Similar channels:");
    for (const c of data.slice(0, 10)) {
      m.line(`[${c.id}] ${c.title}`);
    }
    return m.build();
  },
);

export const getBotCommandsContract = resultContract(
  BotCommandsResult,
  "self",
  "last_bot_commands",
  ({ botId, commands }) => {
    if (commands.length === 0) return null;
    const m = new PromptBuilder();
    m.line(`Bot @${botId} commands:`);
    for (const c of commands.slice(0, 20)) {
      m.line(`/${c.command} — ${c.description}`);
    }
    return m.build();
  },
);

// ── 笔记 ──

export const readNotesContract = resultContract(z.array(NoteItem), "self", "last_notes", (data) => {
  if (data.length === 0) return null;
  const m = new PromptBuilder();
  m.line(`Saved Messages (${data.length} recent notes):`);
  for (const n of data.slice(0, 10)) {
    const preview = n.text.length > 100 ? `${n.text.slice(0, 100)}...` : n.text;
    m.timeline(n.date, "", preview);
  }
  return m.build();
});

// ── 知识 ──

export const createInviteLinkContract = resultContract(
  z.string().min(1),
  "target",
  "last_invite_link",
  (link) => {
    const normalized = link
      .split(/\s+/)
      .map((part) => part.trim())
      .find((part) => part.length > 0);
    if (!normalized) return null;
    const m = new PromptBuilder();
    m.kv("Invite link", normalized);
    return m.build();
  },
);

export const commandOutputContract = resultContract(
  CommandOutputResult,
  "self",
  "last_command_output",
  ({ command, stdout }) => {
    const lines = stdout
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .slice(0, 40);
    if (lines.length === 0) return [`${command}: (no output)`];
    return [`${command}:`, ...lines];
  },
);

// googleContract, visitContract — 已迁移为 Skill CLI 脚本（runtime/skills/google/, runtime/skills/visit/）
// google/visit 结果通过 Exa API + Engine API LLM 管线获取，
// CLI 脚本直接写入 graph 属性 self.last_google_result / self.last_visit_result。

// selfcheckContract — 已迁移为 Skill CLI 脚本（runtime/skills/selfcheck/）
// selfcheck 结果通过 Engine API 端点 POST /engine/selfcheck 获取，
// CLI 脚本直接写入 graph 属性 self.last_selfcheck_result。
