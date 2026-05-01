export interface ChatTailSourceMessage {
  platform: string;
  msgId: number | null;
  nativeChatId: string | null;
  nativeMsgId: string | null;
  stableMessageId: string | null;
  senderName: string | null;
  senderId: string | null;
  text: string | null;
  isOutgoing: boolean;
  isDirected: boolean;
  mediaType: string | null;
  createdAt: Date;
}

export interface ChatTailMessageDto {
  /** UI-local visible reference number. Null means this row has no numeric current-chat ref. */
  id: number | null;
  /** Public key fact: message_log.stable_message_id. Null means the platform message id was unavailable. */
  messageId: string | null;
  /** Public key fact: message_log.platform. */
  platform: string;
  /** Audit/detail fact: platform-native chat id. Null means unknown. */
  nativeChatId: string | null;
  /** Audit/detail fact: platform-native message id. Null means unknown. */
  nativeMsgId: string | null;
  /** Public display fact: message_log.sender_name. Null means unknown sender name. */
  sender: string | null;
  /** Audit/detail fact: stable sender id, useful for machine consumers. */
  senderId: string | null;
  text: string | null;
  mediaType: string | null;
  outgoing: boolean;
  directed: boolean;
  /** ISO timestamp from message_log.created_at. */
  timestamp: string;
}

export interface ChatTailResponse {
  messages: ChatTailMessageDto[];
}

export function toChatTailMessageDto(message: ChatTailSourceMessage): ChatTailMessageDto {
  return {
    id: message.msgId,
    messageId: message.stableMessageId,
    platform: message.platform,
    nativeChatId: message.nativeChatId,
    nativeMsgId: message.nativeMsgId,
    sender: message.senderName,
    senderId: message.senderId,
    text: message.text,
    mediaType: message.mediaType,
    outgoing: message.isOutgoing,
    directed: message.isDirected,
    timestamp: message.createdAt.toISOString(),
  };
}
