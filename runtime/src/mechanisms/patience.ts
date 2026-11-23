import { defineMechanism, type Mechanism } from "../mind/mechanism.js";

/**
 * 等对方说完再开口：被唤醒后，会话安静这么久才去想要说什么，对方每来一条就重新计时。
 * 时长取自 2026-02 真实数据：同一人连发时相邻两条间隔的 75 分位，私聊约 16 秒、群聊约 12 秒；
 * 她当时回复的中位延迟是 16–27 秒。
 */
const WAIT_MS = { private: 15_000, group: 12_000 } as const;
/** Telegram 正在输入状态的租期是 6 秒（UserTypingUpdate 文档）。 */
const TYPING_LEASE_MS = 6_000;

export const patience: Mechanism = {
  name: "patience",
  patience: (chat, event) => (event.type === "message.received" ? WAIT_MS[chat.chatType] : 0),
};

interface TypingPatienceState {
  /** 每个会话里最后一次看到别人正在输入并有效到什么时候。 */
  typing: Readonly<Record<string, { senderId: string; until: number }>>;
  /** 每个会话对方已读到她消息的水位与时刻（P06）。 */
  readOutbox: Readonly<Record<string, { at: number; maxReadId: string }>>;
}

const EMPTY: TypingPatienceState = { typing: {}, readOutbox: {} };

/**
 * 候选（PLAN 第 40 件 / P06）：结合对方正在输入和已读状态。
 * 对方正在输入时把等待向后推 6 秒（由 step.ts 的 PATIENCE_CAP_MS 60 秒兜底封顶），
 * 对方一旦发完消息或取消输入立刻清掉输入状态。
 */
export const typingPatience: Mechanism = defineMechanism<TypingPatienceState>({
  name: "typing-patience",
  initial: EMPTY,
  reduce: (state, event) => {
    switch (event.type) {
      case "typing.received": {
        if (event.status === "cancel") {
          if (!(event.scope in state.typing)) return state;
          const { [event.scope]: _, ...rest } = state.typing;
          return { ...state, typing: rest };
        }
        return {
          ...state,
          typing: {
            ...state.typing,
            [event.scope]: { senderId: event.senderId, until: event.at + TYPING_LEASE_MS },
          },
        };
      }
      case "message.received": {
        const cur = state.typing[event.scope];
        if (!cur || cur.senderId !== event.senderId) return state;
        const { [event.scope]: _, ...rest } = state.typing;
        return { ...state, typing: rest };
      }
      case "history.read": {
        if (!event.outbox) return state;
        return {
          ...state,
          readOutbox: {
            ...state.readOutbox,
            [event.scope]: { at: event.at, maxReadId: event.maxReadId },
          },
        };
      }
      default:
        return state;
    }
  },
  patience: (chat, event, now, state) => {
    if (event.type === "typing.received") {
      return event.status === "cancel" ? 0 : TYPING_LEASE_MS;
    }
    if (event.type === "message.received") {
      const active = state.typing[chat.scope];
      const typingExtra = active && active.until > now ? active.until - now : 0;
      return Math.max(WAIT_MS[chat.chatType], typingExtra);
    }
    return 0;
  },
});
