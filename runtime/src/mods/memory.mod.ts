/**
 * Memory Mod — 消息记忆 + 对话历史上下文。
 *
 * 职责：
 * - 为 Storyteller 贡献近期对话历史（section 桶）
 * - 提供 recentChat 查询
 * - 监听 SEND_MESSAGE 记录发出消息
 *
 * 未来扩展：
 * - 可检索性 R_N（论文 Eq.12: 遗忘曲线）
 * - 记忆整合（stability update, Eq.13）
 *
 * 参考: narrative-engine/mods/memory/index.ts
 * 参考: narrative-framework-paper §6b (Retrievability)
 */
import { and, desc, eq, gte } from "drizzle-orm";
import { z } from "zod";
import { createMod } from "../core/mod-builder.js";
import { PromptBuilder, type PromptLine } from "../core/prompt-style.js";
import type { ContributionItem } from "../core/types.js";
import { section } from "../core/types.js";
import { getDb } from "../db/connection.js";
import { messageLog } from "../db/schema.js";
import { extractNumericId } from "../graph/constants.js";
import { parseTransportTargetId, stableTransportMessageId } from "../platform/transport.js";
import { estimateAgeS } from "../pressure/clock.js";
import { humanDuration, humanDurationAgo } from "../utils/time-format.js";

// -- Mod 状态 -----------------------------------------------------------------

interface MemoryState {
  /** 当前 briefing 的目标 chatId（由 act.ts 设置）。 */
  targetChatId: string | null;
  /** ADR-83 D3: live window 消息数（由 act.ts 注入）。> 0 时跳过 conversation section 避免重叠。 */
  liveMessageCount: number;
}

// -- Mod 定义 -----------------------------------------------------------------

export const memoryMod = createMod<MemoryState>("memory", {
  category: "core",
  description: "消息记忆 + 对话历史上下文",
  topics: ["memory"],
  initialState: { targetChatId: null, liveMessageCount: 0 },
})
  /** 设置当前目标频道（act 阶段调用）。 */
  .instruction("SET_CHAT_TARGET", {
    params: z.object({
      chatId: z.string().optional().describe("目标频道 ID"),
      liveMessageCount: z.number().default(0).describe("ADR-83 D3: live window 消息数"),
    }),
    description: "设置当前行动目标（频道）",
    impl(ctx, args) {
      ctx.state.targetChatId = args.chatId != null ? String(args.chatId) : null;
      ctx.state.liveMessageCount = Number(args.liveMessageCount ?? 0);
      return ctx.state.targetChatId;
    },
  })
  /** 记录发出的消息。 */
  .instruction("SEND_MESSAGE", {
    params: z.object({
      chatId: z.string().min(1).describe("频道 ID"),
      text: z.string().min(1).describe("消息文本"),
      msgId: z.number().optional().describe("当前聊天可见消息引用号"),
    }),
    description: "记录发出的消息到 message_log",
    impl(ctx, args) {
      const text = String(args.text).slice(0, 4096);
      const chatId = String(args.chatId);
      const target = parseTransportTargetId(chatId);
      const nativeChatId = target?.nativeId;
      const nativeMsgId = args.msgId != null ? String(args.msgId) : undefined;
      // FTS 同步由 SQLite 触发器自动完成。
      // @see runtime/drizzle/0017_fts5_triggers.sql
      getDb()
        .insert(messageLog)
        .values({
          tick: ctx.tick,
          platform: target?.platform ?? "telegram",
          chatId,
          msgId: args.msgId != null ? Number(args.msgId) : undefined,
          nativeChatId,
          nativeMsgId,
          stableMessageId:
            target && nativeMsgId != null
              ? stableTransportMessageId(target.platform, target.nativeId, nativeMsgId)
              : undefined,
          senderId: "self",
          senderName: "Alice",
          text,
          isOutgoing: true,
          isDirected: false,
        })
        .run();
      return true;
    },
  })
  /** 获取某频道的近期消息。 */
  .query("recent_chat", {
    params: z.object({
      chatId: z.string().min(1).optional().describe("频道 ID（省略则为当前聊天）"),
      count: z
        .number()
        .int()
        .positive()
        .max(30)
        .default(20)
        .describe("最大条数（默认 20，上限 30）"),
    }),
    deriveParams: {
      chatId: (cv: Record<string, unknown>) => cv.TARGET_CHAT,
    },
    description: "获取频道近期消息",
    affordance: {
      whenToUse: "Review recent conversation history in a channel",
      whenNotToUse: "When live messages are already visible in context",
      priority: "core",
    },
    returns:
      "Array<{ tick: number; chatId: string; senderName: string; text: string; isOutgoing: boolean; isDirected: boolean }>",
    returnHint: "[{senderName, text, timeAgo, isOutgoing, isDirected}]",
    impl(_ctx, args) {
      const db = getDb();
      const chatId = String(args.chatId);
      const limit = Number(args.count ?? 20);
      return db
        .select()
        .from(messageLog)
        .where(eq(messageLog.chatId, chatId))
        .orderBy(desc(messageLog.id))
        .limit(limit)
        .all()
        .reverse();
    },
    format(result) {
      const rows = result as Array<Record<string, unknown>>;
      if (rows.length === 0) return ["(no messages)"];
      const now = Date.now();
      const chatId = String(rows[0]?.chatId ?? "");
      const lines: string[] = [`--- ${rows.length} messages from ${chatId} ---`];
      for (const r of rows) {
        const tags: string[] = [];
        if (r.isOutgoing) tags.push("outgoing");
        if (r.isDirected) tags.push("directed");
        if (r.mediaType) tags.push(String(r.mediaType));
        const suffix = tags.length > 0 ? ` (${tags.join(", ")})` : "";
        const rawText = String(r.text ?? (r.mediaType ? `(${r.mediaType})` : "(empty)"));
        const text = rawText.length > 200 ? `${rawText.slice(0, 200)}...` : rawText;
        const agoS = estimateAgeS(
          {
            createdAt: r.createdAt instanceof Date ? r.createdAt : null,
            tick: Number(r.tick ?? 0),
          },
          now,
          0,
        );
        const ago = humanDurationAgo(agoS);
        lines.push(`[${ago}] ${r.senderName}: ${text}${suffix}`);
      }
      return lines;
    },
  })
  .contribute((ctx): ContributionItem[] => {
    const items: ContributionItem[] = [];
    const db = getDb();

    // 1. 目标聊天的对话历史
    // ADR-83 D3: live window（Telegram API 实时拉取）为 ground truth。
    // 当 liveMessageCount > 0 时跳过此 section，避免与 act.ts 的 live messages 重叠。
    if (ctx.state.targetChatId && ctx.state.liveMessageCount === 0) {
      const messages = db
        .select()
        .from(messageLog)
        .where(eq(messageLog.chatId, ctx.state.targetChatId))
        .orderBy(desc(messageLog.id))
        .limit(20)
        .all()
        .reverse();

      if (messages.length > 0) {
        const mb = new PromptBuilder();
        for (const m of messages) {
          // IRC 风格：display_name ~senderId（非 Alice 消息附加 sender ID）
          let sender: string;
          if (m.isOutgoing) {
            sender = "Alice (you)";
          } else {
            const numId = m.senderId ? extractNumericId(m.senderId) : null;
            const senderTag = numId != null ? ` @${numId}` : "";
            sender = `${m.senderName ?? "Unknown"}${senderTag}`;
          }
          const preview = m.text
            ? m.text.length > 200
              ? `${m.text.slice(0, 200)}...`
              : m.text
            : "(no text)";
          // ADR-110/166: 统一使用 estimateAgeS
          const agoS = estimateAgeS(m, ctx.nowMs, ctx.tick);
          const ago = humanDurationAgo(agoS);
          // ADR-219: 传入当前聊天可见 msgId，使 LLM 可用 `irc forward --ref msgId` 引用频道消息。
          mb.timeline(ago, sender, preview, m.msgId);
        }
        // 用 display_name 替代 raw chatId（LLM 无障碍）
        let chatLabel = "(unknown chat)";
        if (ctx.state.targetChatId && ctx.graph.has(ctx.state.targetChatId)) {
          chatLabel = ctx.graph.getChannel(ctx.state.targetChatId).display_name ?? chatLabel;
        }
        items.push(
          section("conversation", mb.build(), `Recent conversation in ${chatLabel}:`, 20, 80),
        );
      }
    }

    // 2. 对话回顾 — 结构化时间线快照（PageIndex 哲学：提供结构，让 LLM 推理）
    //    查最近 100 条消息（排除已展示的 20 条），按间隔分段，首尾摘要
    if (ctx.state.targetChatId) {
      const olderMessages = db
        .select()
        .from(messageLog)
        .where(eq(messageLog.chatId, ctx.state.targetChatId))
        .orderBy(desc(messageLog.id))
        .limit(120) // 取 120 条，跳过最新 20 条（已在 conversation section 展示）
        .all()
        .reverse();

      // 跳过最新 20 条（已在 conversation section 展示）
      const older = olderMessages.slice(0, Math.max(0, olderMessages.length - 20));

      if (older.length >= 3) {
        // 按间隔分段（gap > 10 ticks → 新段）
        const segments: (typeof older)[] = [];
        let current: typeof older = [older[0]];
        for (let i = 1; i < older.length; i++) {
          if (older[i].tick - older[i - 1].tick > 10) {
            segments.push(current);
            current = [older[i]];
          } else {
            current.push(older[i]);
          }
        }
        segments.push(current);

        // 渲染：每段只显示首尾消息 + 消息数
        const recapLines: PromptLine[] = [];
        for (const seg of segments.slice(-5)) {
          // 最多展示 5 段
          const first = seg[0];
          const last = seg[seg.length - 1];
          // ADR-210 F: Earlier conversation 是回顾性摘要——sender ID 无功能价值，只保留名字
          const firstSender = first.isOutgoing ? "Alice" : (first.senderName ?? "someone");
          const lastSender = last.isOutgoing ? "Alice" : (last.senderName ?? "someone");
          const rawFirst = (first.text ?? "").replaceAll("\n", " ");
          const firstText = rawFirst
            ? rawFirst.length > 60
              ? `${rawFirst.slice(0, 60)}...`
              : rawFirst
            : "(no text)";
          const rawLast = (last.text ?? "").replaceAll("\n", " ");
          const lastText = rawLast
            ? rawLast.length > 60
              ? `${rawLast.slice(0, 60)}...`
              : rawLast
            : "(no text)";

          // ADR-110/166: 统一使用 estimateAgeS
          const startAgoS = estimateAgeS(first, ctx.nowMs, ctx.tick);
          const endAgoS = estimateAgeS(last, ctx.nowMs, ctx.tick);
          const startAgo = humanDuration(startAgoS);
          const endAgo = humanDuration(endAgoS);
          recapLines.push(
            PromptBuilder.of(`[${startAgo} ago — ${endAgo} ago] ${seg.length} messages`),
          );
          recapLines.push(PromptBuilder.of(`First: ${firstSender}: ${firstText}`));
          if (seg.length > 1) {
            recapLines.push(PromptBuilder.of(`Last: ${lastSender}: ${lastText}`));
          }
        }

        if (recapLines.length > 0) {
          items.push(section("conversation-recap", recapLines, "Earlier conversation", 25, 65));
        }
      }
    }

    // 3. ADR-102: Action Echo — 反射性行动轨迹。
    //    Alice 的自我模型有语义记忆（facts）和情绪记忆（diary），但缺少行动记忆。
    //    当消息滚出 30 条 live window 后，Alice 对自己"做了什么"的感知消失，
    //    而 diary 的未解决情绪持续注入 → 正反馈放大环 → 重复追问同一话题。
    //    此 section 从 messageLog 提取 Alice 近期发出的消息，独立于 live window，
    //    填补自我模型的"行动记忆"空缺。
    //    @see docs/adr/102-reflective-action-trace.md
    if (ctx.state.targetChatId) {
      const ECHO_LOOKBACK_S = 3600; // 1 小时
      const ECHO_MAX_MESSAGES = 5;
      // ADR-110: 使用 createdAt 替代 tick 窗口查询
      const outgoing = db
        .select({
          tick: messageLog.tick,
          text: messageLog.text,
          createdAt: messageLog.createdAt,
        })
        .from(messageLog)
        .where(
          and(
            eq(messageLog.chatId, ctx.state.targetChatId),
            eq(messageLog.isOutgoing, true),
            gte(messageLog.createdAt, new Date(ctx.nowMs - ECHO_LOOKBACK_S * 1000)),
          ),
        )
        .orderBy(desc(messageLog.tick))
        .limit(ECHO_MAX_MESSAGES)
        .all()
        .reverse();

      if (outgoing.length > 0) {
        const echoLines: PromptLine[] = [];
        for (const m of outgoing) {
          // ADR-110/166: 统一使用 estimateAgeS
          const agoS = estimateAgeS(m, ctx.nowMs, ctx.tick);
          const ago = humanDurationAgo(agoS);
          const preview = m.text
            ? m.text.length > 80
              ? `${m.text.slice(0, 80)}...`
              : m.text
            : "(no text)";
          echoLines.push(PromptBuilder.of(`[${ago}] you: "${preview}"`));
        }
        items.push(
          // ADR-102: priority 68 — 低于 threads(70)/self-mood(70)，高于 conversation-recap(65)。
          // 在群聊紧张预算下必须存活：防止重复行为比 contact-mood(55)/group-dynamics(55) 更重要。
          section("action-echo", echoLines, "Said recently (this chat)", 15, 68),
        );
      }
    }

    // ADR-56 S4: cross-chat-activity 已删除。
    // 在当前聊天中暴露其他聊天的活动会导致 LLM 跨聊天泄漏信息。
    // @see docs/adr/56-behavioral-reciprocity-action-loop.md §S4

    return items;
  })
  .build();
