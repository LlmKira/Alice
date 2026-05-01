/**
 * messaging 类别动作：send_message, mark_read, edit_message, forward_message, publish_channel, send_dm。
 *
 * @see docs/adr/149-define-action-builder.md
 */

import { tl } from "@mtcute/node";
import { z } from "zod";
import { sanitizeOutgoingText } from "../../core/sandbox-schemas.js";
import { ensureChannelId, ensureContactId, extractNumericId } from "../../graph/constants.js";
import { recordForwardShare } from "../../graph/dynamic-props.js";
import { defineAction } from "../action-builder.js";
import type { TelegramActionDef } from "../action-types.js";
import { editMessage, forwardMessage, markRead, sendText, setTyping } from "../actions.js";
import { cacheOutgoingMsg } from "../events.js";
import { getExplorationGuard } from "./shared.js";

export const messagingActions: TelegramActionDef[] = [
  defineAction({
    name: "send_message",
    category: "messaging",
    description: ["Send a text message to a chat."],
    usageHint:
      "For shell-native chat flows prefer `irc say --text ...` in the script path. Supports @mentions via mentions parameter.",
    params: z.object({
      chatId: z.number().describe("Target chat"),
      text: z.string().describe("Message text"),
      replyTo: z.number().optional().describe("Message ID to reply to"),
      mentions: z
        .array(z.object({ offset: z.number(), length: z.number(), userId: z.number() }))
        .optional()
        .describe("Array of {offset, length, userId} for @mention entities"),
    }),
    inject: { chatId: "TARGET_CHAT" },
    affordance: {
      whenToUse: "Send a text message to someone",
      whenNotToUse: "When you want to stay silent or just react",
      priority: "core",
    },
    async impl(ctx, args) {
      // S-1: 清洗注解泄漏 + Telegram 消息上限 4096 字符
      const text = sanitizeOutgoingText(args.text ?? "");
      if (!args.chatId || !text) return false;

      const rawId = ctx.parseChatId(args.chatId);
      const graphId = ctx.ensureGraphId(args.chatId);

      // 观察窗口检查：新加入的频道需要先静默/学徒
      if (ctx.G.has(graphId)) {
        const channelAttrs = ctx.G.getChannel(graphId);
        const joinMs = channelAttrs.join_ms ?? 0;
        if (joinMs > 0) {
          const nowMs = Date.now();
          const guard = getExplorationGuard();
          const phase = guard.getObservationPhase(joinMs, nowMs);
          if (phase === "silent") {
            ctx.log.info("send blocked: observation window silent phase", { chatId: graphId });
            return false;
          }
          if (phase === "apprentice") {
            const msgCount = channelAttrs.apprentice_msg_count ?? 0;
            if (msgCount >= guard.config.apprenticeMaxMessages) {
              ctx.log.info("send throttled: apprentice limit", { chatId: graphId, msgCount });
              return false;
            }
            ctx.G.setDynamic(graphId, "apprentice_msg_count", msgCount + 1);
          }
        }
      }

      const msgId = await sendText(ctx.client, rawId, text, {
        replyToMsgId: args.replyTo,
        mentions: args.mentions,
      });

      // 主动缓存 outgoing msg_id（不依赖 onNewMessage 被动接收）
      if (msgId != null) {
        cacheOutgoingMsg(graphId, msgId);
      }

      if (ctx.G.has(graphId)) {
        // @see paper-five-dim/ Axiom 1: Structure as Feedback
        // m2 修复: 按 code point 截断，避免 emoji surrogate pair 被切断
        ctx.G.setDynamic(graphId, "last_outgoing_text", [...text].slice(0, 150).join(""));
      }

      ctx.dispatcher.dispatch("SEND_MESSAGE", { chatId: graphId, text, msgId });
      ctx.dispatcher.dispatch("DECLARE_ACTION", { target: graphId });

      ctx.log.info("send_message executed", { chatId: args.chatId, textLen: text.length });
      return { success: true, msgId: msgId ?? undefined, obligationsConsumed: 1 };
    },
  }),

  defineAction({
    name: "mark_read",
    category: "messaging",
    description: ["Mark a chat as read without responding."],
    // chatId 有意保留为 LLM 可见（无 inject）——系统线程场景需要跨聊天标记已读。
    params: z.object({
      chatId: z.number().describe("Chat ID"),
    }),
    affordance: {
      whenToUse: "Acknowledge a chat without responding",
      whenNotToUse: "When you intend to reply — sending a message implicitly marks as read",
      priority: "core",
    },
    async impl(ctx, args) {
      if (!args.chatId) return false;

      const rawId = ctx.parseChatId(args.chatId);
      const graphId = ctx.ensureGraphId(args.chatId);
      await markRead(ctx.client, rawId);

      if (ctx.G.has(graphId)) {
        ctx.G.setDynamic(graphId, "unread", 0);
        // @see paper-five-dim/ §4.2: directed obligation decrement semantics
        ctx.G.setDynamic(graphId, "mentions_alice", false);
        // ADR-158 Fix 6: 与 System 1 mark_read（evolve.ts:1069）保持一致——
        // 记录清除时间戳，让 focus.ts diligence 阻尼正确抑制刚清除的实体。
        // @see docs/adr/158-outbound-feedback-gap.md
        ctx.G.setDynamic(graphId, "recently_cleared_ms", Date.now());
      }

      ctx.log.info("mark_read executed", { chatId: args.chatId });
      return true;
    },
  }),

  defineAction({
    name: "edit_message",
    category: "messaging",
    description: ["Edit a previously sent message. Only works on your own messages."],
    params: z.object({
      chatId: z.number().describe("Target chat"),
      msgId: z.number().describe("Message ID to edit"),
      text: z.string().describe("New message text"),
    }),
    inject: { chatId: "TARGET_CHAT" },
    affordance: {
      whenToUse: "Fix a typo or update your own previously sent message",
      whenNotToUse: "When rewriting would confuse the conversation context",
      priority: "core",
    },
    async impl(ctx, args) {
      if (!args.chatId || !args.msgId || !args.text) return false;

      const rawId = ctx.parseChatId(args.chatId);
      await editMessage(ctx.client, rawId, args.msgId, sanitizeOutgoingText(args.text));

      const graphId = ctx.ensureGraphId(args.chatId);
      ctx.dispatcher.dispatch("DECLARE_ACTION", { target: graphId });

      ctx.log.info("edit_message executed", { chatId: args.chatId, msgId: args.msgId });
      return true;
    },
  }),

  defineAction({
    name: "forward_message",
    category: "messaging",
    description: ["Forward a message from another chat into this conversation."],
    params: z.object({
      fromChatId: z.number().describe("Source chat ID"),
      msgId: z.number().describe("Message ID to forward"),
      toChatId: z.number().describe("Destination chat"),
    }),
    inject: { toChatId: "TARGET_CHAT" },
    affordance: {
      whenToUse: "Share a message from one chat into another",
      whenNotToUse: "When quoting or paraphrasing would be more appropriate",
      priority: "core",
    },
    async impl(ctx, args) {
      if (!args.fromChatId || !args.msgId || !args.toChatId) return false;

      const rawFromId = ctx.parseChatId(args.fromChatId);
      const rawToId = ctx.parseChatId(args.toChatId);
      const toGraphId = ctx.ensureGraphId(args.toChatId);

      let fwdMsgId: number | null | undefined;
      try {
        fwdMsgId = await forwardMessage(ctx.client, rawFromId, args.msgId, rawToId);
      } catch (err) {
        // ADR-156: Block 检测 — 被拉黑/隐私限制时标记 graph，后续全景过滤
        if (
          tl.RpcError.is(err, "USER_PRIVACY_RESTRICTED") ||
          tl.RpcError.is(err, "PEER_ID_BLOCKED") ||
          tl.RpcError.is(err, "USER_IS_BLOCKED")
        ) {
          const contactId = ensureContactId(toGraphId);
          if (contactId && ctx.G.has(contactId)) {
            ctx.G.setDynamic(contactId, "blocked_alice", true);
            ctx.log.warn("Contact blocked Alice — marked in graph", { contactId });
          }
        }
        throw err;
      }

      // 主动缓存 outgoing msg_id — reply directed 检测需要
      if (fwdMsgId != null) {
        cacheOutgoingMsg(toGraphId, fwdMsgId);
      }
      ctx.dispatcher.dispatch("DECLARE_ACTION", { target: toGraphId });

      const fromGraphId = ctx.ensureGraphId(args.fromChatId);
      const toName =
        ctx.G.has(toGraphId) && ctx.G.getDynamic(toGraphId, "display_name")
          ? String(ctx.G.getDynamic(toGraphId, "display_name"))
          : String(args.toChatId);
      if (fwdMsgId != null) {
        recordForwardShare(ctx.G, {
          fromGraphId,
          msgId: args.msgId,
          toGraphId,
          targetName: toName,
        });
      }

      ctx.log.info("forward_message executed", {
        fromChatId: args.fromChatId,
        msgId: args.msgId,
        toChatId: args.toChatId,
      });
      return { success: true, obligationsConsumed: 1 };
    },
  }),

  // ── ADR-206 W7: 频道发布行为 ─────────────────────────────────────────────

  defineAction({
    name: "publish_channel",
    category: "messaging",
    description: [
      "Publish a post to a channel where you are admin or owner.",
      "Use this to share your thoughts, curated content, or announcements on your channel.",
    ],
    usageHint:
      "Only works on channels where you have admin/owner role. Has a 2-hour cooldown between posts.",
    params: z.object({
      channelId: z.number().describe("Target channel ID (must be a channel you admin)"),
      text: z.string().describe("Post content"),
    }),
    affordance: {
      whenToUse:
        "Share original content, curated findings, or announcements on a channel you manage",
      whenNotToUse:
        "When you are not admin/owner of the channel, or when you published recently (< 2h)",
      priority: "core",
    },
    async impl(ctx, args) {
      // S-1: 清洗注解泄漏 + Telegram 消息上限 4096 字符
      const text = sanitizeOutgoingText(args.text ?? "");
      if (!args.channelId || !text) return false;

      const graphId = ctx.ensureGraphId(args.channelId);

      // ADR-206 C4 Gate 1: alice_role 硬检查
      // 注意：不需要 observation window（与 send_message 不同）——
      // admin/owner 角色本身已是强信任信号，不存在"新加入静默期"语义。
      if (!ctx.G.has(graphId)) return { success: false, error: "unknown channel" };
      const attrs = ctx.G.getChannel(graphId);
      const role = String(attrs.alice_role ?? "");
      if (role !== "owner" && role !== "admin") {
        ctx.log.warn("publish_channel blocked: not admin/owner", { channelId: graphId, role });
        return { success: false, error: "not admin or owner" };
      }

      // ADR-206 C4 Gate 2: 2 小时发布冷却期
      const PUBLISH_COOLDOWN_MS = 2 * 60 * 60_000; // 2h
      const lastPublishMs = Number(attrs.last_publish_ms ?? 0);
      if (lastPublishMs > 0 && Date.now() - lastPublishMs < PUBLISH_COOLDOWN_MS) {
        ctx.log.info("publish_channel throttled: cooldown", { channelId: graphId });
        return { success: false, error: "publish cooldown (2h)" };
      }

      // ADR-206 C4 Gate 3: chat_type 必须是 channel
      if (attrs.chat_type !== "channel") {
        return { success: false, error: "not a channel" };
      }

      const rawId = ctx.parseChatId(args.channelId);
      const msgId = await sendText(ctx.client, rawId, text);

      // 更新图状态
      if (msgId != null) {
        cacheOutgoingMsg(graphId, msgId);
      }
      ctx.G.setDynamic(graphId, "last_publish_ms", Date.now());
      ctx.G.setDynamic(graphId, "last_outgoing_text", [...text].slice(0, 150).join(""));

      ctx.dispatcher.dispatch("SEND_MESSAGE", { chatId: graphId, text, msgId });
      ctx.dispatcher.dispatch("DECLARE_ACTION", { target: graphId });

      ctx.log.info("publish_channel executed", { channelId: args.channelId, textLen: text.length });
      // 频道发布不消耗 directed 义务
      return { success: true, msgId: msgId ?? undefined, obligationsConsumed: 0 };
    },
  }),

  defineAction({
    name: "send_dm",
    category: "messaging",
    description: [
      "Send a private message to a contact. Use when you want to DM someone you saw in a group.",
    ],
    usageHint: "Only works for contacts you've talked to before. Use ~senderId from chat log.",
    params: z.object({
      who: z.string().describe("Contact to DM (use ~senderId from chat log)"),
      text: z.string().describe("Message text"),
    }),
    // 无 inject — who 由 LLM 显式传入（仿 mark_read 先例）
    affordance: {
      whenToUse:
        "Privately reach out to someone you saw in a group — follow up, check in, or share something personal",
      whenNotToUse:
        "When you should reply publicly in the group, or when you don't know the person",
      priority: "core",
    },
    async impl(ctx, args) {
      // S-1: 清洗注解泄漏 + Telegram 消息上限 4096 字符
      const text = sanitizeOutgoingText(args.text ?? "");
      if (!text) return false;

      // Guard 2: contact 解析
      const contactId = ensureContactId(args.who ?? "");
      if (!contactId) return { success: false, error: "invalid contact" };

      // Guard 3: 图中存在
      if (!ctx.G.has(contactId)) return { success: false, error: "unknown contact" };

      // Guard 4: 有过互动
      const contactAttrs = ctx.G.getContact(contactId);
      if (contactAttrs.interaction_count <= 0) return { success: false, error: "never interacted" };

      // Guard 5: 非陌生人（tier < 500）
      if (contactAttrs.tier >= 500) return { success: false, error: "too distant" };

      // Guard 6: DM channel 解析
      const dmChannelId = ensureChannelId(args.who ?? "");
      if (!dmChannelId) return { success: false, error: "cannot resolve" };

      // Guard 7: 如果图中有该 channel 节点，确认是私聊
      if (ctx.G.has(dmChannelId)) {
        const channelAttrs = ctx.G.getChannel(dmChannelId);
        if (channelAttrs.chat_type && channelAttrs.chat_type !== "private") {
          return { success: false, error: "not private" };
        }
      }

      // Typing 延迟（impl 内自处理，不走 executor 的打字延迟）
      const rawId = extractNumericId(dmChannelId);
      if (rawId == null) return { success: false, error: "cannot resolve" };
      try {
        await setTyping(ctx.client, rawId);
        const delayMs = Math.min(Math.max(text.length * 80, 800), 8000);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      } catch {
        // typing 失败不阻断发送
      }

      const msgId = await sendText(ctx.client, rawId, text);

      // 取消 typing
      try {
        await setTyping(ctx.client, rawId, true);
      } catch {
        // ignore
      }

      // 图更新 + 事件分派（与 send_message 对齐）
      if (msgId != null) {
        cacheOutgoingMsg(dmChannelId, msgId);
      }

      if (ctx.G.has(dmChannelId)) {
        ctx.G.setDynamic(dmChannelId, "last_outgoing_text", [...text].slice(0, 150).join(""));
      }

      ctx.dispatcher.dispatch("SEND_MESSAGE", { chatId: dmChannelId, text, msgId });
      ctx.dispatcher.dispatch("DECLARE_ACTION", { target: dmChannelId });

      ctx.log.info("send_dm executed", { who: args.who, textLen: text.length });
      // DM 不消耗群聊 obligation
      return { success: true, msgId: msgId ?? undefined, obligationsConsumed: 0 };
    },
  }),
];
