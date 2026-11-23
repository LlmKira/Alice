import { describe, expect, it } from "vitest";
import { decodeEvent } from "../src/journal.js";
import { typingPatience } from "../src/mechanisms/patience.js";
import type {
  AliceEvent,
  HistoryRead,
  MessageReceived,
  TypingReceived,
} from "../src/mind/events.js";
import { emptyChat, emptyState, PATIENCE_CAP_MS } from "../src/mind/state.js";
import { step } from "../src/mind/step.js";
import { replay } from "../src/sim/replay.js";
import { bindTelegramWorldAdapter } from "../src/telegram/world-adapter.js";

const T0 = Date.UTC(2026, 10, 14, 6, 0);
const DM = "telegram:42";
const S = 1000;

function msg(at: number, o: Partial<MessageReceived> = {}): MessageReceived {
  return {
    type: "message.received",
    at,
    scope: DM,
    chatType: "private",
    messageId: `m-${at}`,
    senderId: "42",
    senderName: "小林",
    text: "在吗",
    contentType: "text",
    replyToMessageId: null,
    directed: true,
    ...o,
  };
}

function typing(at: number, status: TypingReceived["status"] = "typing"): TypingReceived {
  return {
    type: "typing.received",
    at,
    scope: DM,
    chatType: "private",
    senderId: "42",
    status,
  };
}

const dummyWake = {
  name: "wake-dm",
  wake: (_chat: unknown, event: AliceEvent) => (event.type === "message.received" ? 1 : 0),
};

describe("typing-patience (P06)", () => {
  it("extends wait when typing arrives while waiting, bounded by PATIENCE_CAP_MS", async () => {
    const events: AliceEvent[] = [
      msg(T0),
      // 原来到点是 T0 + 15s；在 T0 + 14s 收到对方正在输入，延到 T0 + 20s
      typing(T0 + 14 * S),
    ];
    const result = await replay(events, {
      mechanisms: [dummyWake, typingPatience],
      tickMs: 1000,
      speech: () => ({ acts: [] }),
    });
    const call = result.effects.find((r) => r.effect.type === "call-speech");
    expect(call?.at).toBe(T0 + 20 * S);

    // 一直连续输入也不能无限推迟，到 PATIENCE_CAP_MS（60s）强制开口
    const flood: AliceEvent[] = [msg(T0)];
    for (let t = 14; t <= 70; t += 4) flood.push(typing(T0 + t * S));
    const capped = await replay(flood, {
      mechanisms: [dummyWake, typingPatience],
      tickMs: 1000,
      speech: () => ({ acts: [] }),
    });
    const cappedCall = capped.effects.find((r) => r.effect.type === "call-speech");
    expect(cappedCall?.at).toBe(T0 + PATIENCE_CAP_MS);
  });

  it("clears typing state on cancel or once the sender finishes their message", () => {
    let state = emptyState;
    state = step(state, typing(T0, "typing"), [typingPatience]).state;
    const chat = emptyChat(DM, "private", true);
    expect(
      typingPatience.patience?.(
        chat,
        msg(T0 + 2 * S),
        T0 + 2 * S,
        state.mechanisms["typing-patience"],
      ),
    ).toBe(15_000);

    state = step(state, typing(T0 + 3 * S, "cancel"), [typingPatience]).state;
    expect(
      (state.mechanisms["typing-patience"] as { typing: Record<string, unknown> }).typing[DM],
    ).toBeUndefined();

    state = step(state, typing(T0 + 5 * S, "voice"), [typingPatience]).state;
    state = step(state, msg(T0 + 6 * S), [typingPatience]).state;
    expect(
      (state.mechanisms["typing-patience"] as { typing: Record<string, unknown> }).typing[DM],
    ).toBeUndefined();
  });

  it("tracks outbox history.read watermarks and round-trips both events through Journal schema", () => {
    const readEv: HistoryRead = {
      type: "history.read",
      at: T0 + 5 * S,
      scope: DM,
      chatType: "private",
      outbox: true,
      maxReadId: "9001",
      unreadCount: 0,
    };
    const typEv = typing(T0 + 2 * S, "typing");
    expect(decodeEvent(readEv.type, readEv.scope, readEv)).toEqual(readEv);
    expect(decodeEvent(typEv.type, typEv.scope, typEv)).toEqual(typEv);

    const next = step(emptyState, readEv, [typingPatience]).state;
    const st = next.mechanisms["typing-patience"] as {
      readOutbox: Record<string, { at: number; maxReadId: string }>;
    };
    expect(st.readOutbox[DM]).toEqual({ at: T0 + 5 * S, maxReadId: "9001" });
  });

  it("world-adapter throttles typing updates and deduplicates non-advancing history.read", async () => {
    const handlers: Record<string, (ctx: unknown) => Promise<void>> = {};
    const fakeDispatcher = {
      onNewMessage: () => {},
      onEditMessage: () => {},
      onRawUpdate: () => {},
      onChatMemberUpdate: () => {},
      onUserTyping: (cb: (ctx: unknown) => Promise<void>) => {
        handlers.typing = cb;
      },
      onHistoryRead: (cb: (ctx: unknown) => Promise<void>) => {
        handlers.read = cb;
      },
    };
    let now = T0;
    const events: AliceEvent[] = [];
    bindTelegramWorldAdapter(fakeDispatcher as never, {
      selfId: "1",
      now: () => now,
      onEvent: (e) => events.push(e),
      admit: () => true,
      newGroup: () => false,
    });

    await handlers.typing?.({ chatType: "user", userId: 42, chatId: 42, status: "typing" });
    now += 1_000; // 4 秒节流窗内不重复发
    await handlers.typing?.({ chatType: "user", userId: 42, chatId: 42, status: "typing" });
    now += 4_500;
    await handlers.typing?.({ chatType: "user", userId: 42, chatId: 42, status: "typing" });
    await handlers.typing?.({ chatType: "user", userId: 42, chatId: 42, status: "cancel" });

    await handlers.read?.({
      isDiscussion: false,
      isMonoForum: false,
      isOutbox: true,
      chatId: 42,
      maxReadId: 10,
      unreadCount: 0,
    });
    await handlers.read?.({
      isDiscussion: false,
      isMonoForum: false,
      isOutbox: true,
      chatId: 42,
      maxReadId: 10,
      unreadCount: 0,
    });
    await handlers.read?.({
      isDiscussion: false,
      isMonoForum: false,
      isOutbox: true,
      chatId: 42,
      maxReadId: 11,
      unreadCount: 0,
    });

    expect(events.filter((e) => e.type === "typing.received").map((e) => e.status)).toEqual([
      "typing",
      "typing",
      "cancel",
    ]);
    expect(events.filter((e) => e.type === "history.read").map((e) => e.maxReadId)).toEqual([
      "10",
      "11",
    ]);
  });
});
