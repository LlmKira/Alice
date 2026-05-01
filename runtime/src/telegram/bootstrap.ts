/**
 * 首次启动：iterDialogs + getContacts → 初始图。
 *
 * 从 Telegram 获取对话列表和联系人，构建初始 WorldModel。
 */
import type { TelegramClient } from "@mtcute/node";
import { Chat, User } from "@mtcute/node";
import { telegramChannelId, telegramContactId } from "../graph/constants.js";
import type { ChatType, DunbarTier } from "../graph/entities.js";
import { WorldModel } from "../graph/world-model.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("bootstrap");

/**
 * 从 Telegram 构建初始图。
 *
 * 步骤：
 * 1. 获取自身信息 → AGENT 节点
 * 2. iterDialogs → CHANNEL 节点
 * 3. 对私聊和小群的对方/成员 → CONTACT 节点 + 边
 */
export async function buildInitialGraph(client: TelegramClient): Promise<WorldModel> {
  const G = new WorldModel();
  G.tick = 0;

  // 1. 自身节点
  const self = await client.getMe();
  const selfId = `self`;
  G.addAgent(selfId);
  log.info("Agent node created", { userId: self.id });

  // 2. 遍历对话
  let dialogCount = 0;
  for await (const dialog of client.iterDialogs()) {
    const peer = dialog.peer;

    // 跳过 Saved Messages（self-chat）——Alice 不应向自己发消息
    if (peer instanceof User && peer.id === self.id) continue;

    const chatId = String(peer.id);
    const channelId = telegramChannelId(chatId);

    // 判断 peer 类型：User 是私聊，Chat 是群/频道
    const isUser = peer instanceof User;
    const isChat = peer instanceof Chat;

    let chatType: ChatType;
    if (isUser) {
      chatType = "private";
    } else if (isChat) {
      const ct = peer.chatType;
      if (ct === "channel") chatType = "channel";
      else if (ct === "supergroup") chatType = "supergroup";
      else chatType = "group";
    } else {
      chatType = "group";
    }

    // ADR-206: 频道不再跳过，作为独立实体进入世界模型
    // 推测 tier：私聊 → 50，群聊 → 150，频道 → 500（低优先级信息源）
    const tierContact: DunbarTier =
      chatType === "private" ? 50 : chatType === "channel" ? 500 : 150;

    // ADR-206 W7: 从 Chat 对象探测 alice_role（零 API 成本）
    let aliceRole: string | undefined;
    if (isChat) {
      if (peer.isCreator) aliceRole = "owner";
      else if (peer.isAdmin) aliceRole = "admin";
    }

    // ADR-220: 写入 display_name（群组/频道使用 title，私聊使用 displayName）
    const channelDisplayName = isChat ? peer.title : isUser ? peer.displayName : undefined;

    G.addChannel(channelId, {
      chat_type: chatType,
      tier_contact: tierContact,
      unread: dialog.unreadCount ?? 0,
      display_name: channelDisplayName,
      ...(aliceRole ? { alice_role: aliceRole } : {}),
    });

    // 自己 monitors 频道
    G.addRelation(selfId, "monitors", channelId);

    // 私聊 → 创建 CONTACT 节点
    if (isUser) {
      const contactId = telegramContactId(chatId);
      if (!G.has(contactId)) {
        G.addContact(contactId, {
          tier: tierContact,
          display_name: peer.displayName ?? `user_${chatId}`,
          ...(peer.isBot ? { is_bot: true } : {}),
        });
        G.addRelation(selfId, "acquaintance", contactId);
        G.addRelation(contactId, "joined", channelId);
      }
    }

    dialogCount++;
    if (dialogCount >= 200) break;
  }

  log.info("Initial graph built", { dialogCount, nodes: G.size, edges: G.edgeCount });
  return G;
}
