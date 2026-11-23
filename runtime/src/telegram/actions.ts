import { md } from "@mtcute/markdown-parser";
import { InputMedia, type InputPeerLike, type TelegramClient, tl } from "@mtcute/node";
import { TelegramActionError } from "./errors.js";
import type { Telegram } from "./gates.js";
import { scopeOf } from "./world-adapter.js";

function parseMarkdown(text: string): { text: string; entities: tl.TypeMessageEntity[] } | null {
  try {
    const normalized = text
      .replace(/^#{1,6}\s+(\S.*)$/gm, "**$1**")
      .replace(/^[-*+]\s+/gm, "• ")
      .replace(/^\d+\.\s+/gm, "• ");
    const parsed = md(normalized);
    return (parsed.entities?.length ?? 0) > 0
      ? (parsed as { text: string; entities: tl.TypeMessageEntity[] })
      : null;
  } catch {
    return null;
  }
}

/**
 * 显示"正在输入"或"正在录音"（mtcute 会自动续上，直到发出一条消息或取消）。失败不阻塞：这只是给对方看的样子。
 */
async function showStatus(
  client: TelegramClient,
  peer: InputPeerLike,
  status: "typing" | "record_voice" | "cancel",
): Promise<void> {
  try {
    await client.setTyping({ peerId: peer, status });
  } catch {
    // 状态没显示出来不影响发送
  }
}

/** "看了才回"：发之前标记已读，失败不阻塞发送。 */
async function readFirst(tg: Telegram, chatId: number): Promise<void> {
  try {
    await markRead(tg, chatId);
  } catch {
    // 已读失败不阻塞发送
  }
}

/** 会在 chatId 留下一条她的消息的请求（过第二道连发闸；第一次私聊先拿到对方，gates.ts post）。 */
async function post<T>(
  tg: Telegram,
  chatId: number,
  name: string,
  details: Record<string, unknown>,
  fn: (client: TelegramClient, peer: InputPeerLike) => Promise<T>,
): Promise<T> {
  return tg.post(scopeOf(chatId), chatId, name, details, fn);
}

/** 先标记已读，再发文字。typing：先显示正在输入，等这么久再发（像真人打字）。 */
export async function sendText(
  tg: Telegram,
  chatId: number,
  text: string,
  options: {
    replyToMsgId?: number;
    typing?: { ms: number; pause: (ms: number) => Promise<void> };
  } = {},
): Promise<number | undefined> {
  return post(tg, chatId, "send_text", {}, async (client, peer) => {
    await readFirst(tg, chatId);
    if (options.typing && options.typing.ms > 0) {
      await showStatus(client, peer, "typing");
      await options.typing.pause(options.typing.ms);
    }
    try {
      const sent = await client.sendText(peer, parseMarkdown(text) ?? text, {
        replyTo: options.replyToMsgId,
        abortSignal: tg.signal,
      });
      return sent?.id;
    } catch (error) {
      // 发送失败时"正在输入"不会自己停（mtcute 只在发出消息后停）。
      if (options.typing) await showStatus(client, peer, "cancel");
      throw error;
    }
  });
}

/** 合成好的语音：ogg/opus，和时长（秒）。 */
export interface SpokenVoice {
  ogg: Uint8Array;
  seconds: number;
}

/**
 * 发一条语音（2 月 send_voice）：合成的时候显示"正在录音"。合成失败是确定没发出去（voice_failed）。
 */
export async function sendVoice(
  tg: Telegram,
  chatId: number,
  synthesize: () => Promise<SpokenVoice>,
): Promise<number | undefined> {
  return post(tg, chatId, "send_voice", {}, async (client, peer) => {
    await readFirst(tg, chatId);
    await showStatus(client, peer, "record_voice");
    let voice: SpokenVoice;
    try {
      voice = await synthesize();
    } catch (error) {
      await showStatus(client, peer, "cancel");
      // 停机中止了合成：什么也没发出去，按中止的原因记。
      tg.signal.throwIfAborted();
      throw new TelegramActionError("voice_failed", "speech synthesis failed", {
        chatId: String(chatId),
        originalError: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      const sent = await client.sendMedia(
        peer,
        InputMedia.voice(voice.ogg, { duration: Math.max(1, Math.round(voice.seconds)) }),
        { abortSignal: tg.signal },
      );
      return sent?.id;
    } catch (error) {
      await showStatus(client, peer, "cancel");
      throw error;
    }
  });
}

/**
 * 改她自己的一条文字消息（2 月 edit_message）。内容没变时 Telegram 报 MESSAGE_NOT_MODIFIED：
 * 已经是这句话了，当作改好了。
 */
export async function editText(
  tg: Telegram,
  chatId: number,
  messageId: number,
  text: string,
): Promise<void> {
  return tg.request("edit_message", { chatId: String(chatId), messageId }, async (client) => {
    try {
      await client.editMessage({ chatId, message: messageId, text: parseMarkdown(text) ?? text });
    } catch (error) {
      if (!tl.RpcError.is(error, "MESSAGE_NOT_MODIFIED")) throw error;
    }
  });
}

/**
 * 把一条消息转到 toChatId（她的一条新消息）。noAuthor：不带原作者（复读、从相册发图）。
 * 源群禁止转发时 Telegram 报 CHAT_FORWARDS_RESTRICTED，是带类型的失败。
 */
export async function forwardMessage(
  tg: Telegram,
  from: { chatId: number; messageId: number },
  toChatId: number,
  options: { noAuthor?: boolean } = {},
): Promise<number | undefined> {
  const details = { fromChatId: String(from.chatId), messageId: from.messageId };
  return post(tg, toChatId, "forward_message", details, async (client, peer) => {
    const [sent] = await client.forwardMessagesById({
      fromChatId: from.chatId,
      messages: [from.messageId],
      toChatId: peer,
      ...(options.noAuthor ? { noAuthor: true } : {}),
    });
    return sent?.id;
  });
}

/** 标记已读（消息、提及、表情角标），"看了"。 */
export async function markRead(tg: Telegram, chatId: number): Promise<void> {
  return tg.request("mark_read", { chatId: String(chatId) }, async (client) => {
    await client.readHistory(chatId, { clearMentions: true });
    try {
      await client.readReactions(chatId);
    } catch {
      // A reaction badge is secondary to marking the chat itself as read.
    }
  });
}

/** 给一条消息点表情回应（2 月 sendReaction）。 */
export async function sendReaction(
  tg: Telegram,
  chatId: number,
  messageId: number,
  emoji: string,
): Promise<void> {
  return tg.request("react", { chatId: String(chatId), messageId, emoji }, async (client) => {
    await client.sendReaction({ chatId, message: messageId, emoji });
  });
}

/** 退出群或频道（2 月 leaveChat）。 */
export async function leaveChat(tg: Telegram, chatId: number): Promise<void> {
  return tg.request("leave_chat", { chatId: String(chatId) }, async (client) => {
    await client.leaveChat(chatId);
  });
}

/**
 * 加入群或频道（2 月 joinChat）：按 id，或者按邀请链接（找群时只看到了邀请预览、不知道 id 的群）。
 * 要管理员审批的群，Telegram 回 INVITE_REQUEST_SENT：记为带类型的失败 join_requested（申请已经发出去了）。
 */
export async function joinChat(
  tg: Telegram,
  target: { chatId: number } | { invite: string },
): Promise<void> {
  tg.explore("join");
  return tg.request("join_chat", { target }, async (client) => {
    const joined = await client.joinChat(
      "invite" in target ? `https://t.me/+${target.invite}` : target.chatId,
    );
    // mtcute 0.30 起不再抛 INVITE_REQUEST_SENT，而是返回 request_sent。
    if (joined.status === "request_sent") {
      throw new TelegramActionError("join_requested", "join request sent, awaiting approval", {
        target,
      });
    }
    // 群的守门机器人要她先打开一个网页才能进：她做不到，没进去。
    if (joined.status === "webview") {
      throw new TelegramActionError("transport_soft_permanent", "join needs a guard bot webview", {
        target,
      });
    }
  });
}

/** fileId 来自 sticker_palette（sticker-palette.ts）。 */
export async function sendSticker(
  tg: Telegram,
  chatId: number,
  fileId: string,
): Promise<number | undefined> {
  return post(tg, chatId, "send_sticker", { fileId }, async (client, peer) => {
    const sent = await client.sendMedia(peer, fileId, { abortSignal: tg.signal });
    return sent?.id;
  });
}
