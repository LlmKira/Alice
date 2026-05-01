import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listCanonicalEvents } from "../src/db/canonical-event-store.js";
import { closeDb, getDb, initDb } from "../src/db/connection.js";
import { messageLog } from "../src/db/schema.js";
import {
  type OneBotEventWebSocket,
  type OneBotEventWebSocketFactory,
  startOneBotEventReceiver,
} from "../src/platform/onebot-receiver.js";
import { EventBuffer } from "../src/telegram/events.js";

class FakeSocket implements OneBotEventWebSocket {
  readonly url: string;
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  close = vi.fn(() => {
    this.readyState = 3;
    this.onclose?.({});
  });

  constructor(url: string) {
    this.url = url;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: typeof payload === "string" ? payload : JSON.stringify(payload) });
  }

  drop(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
}

function groupTextEvent(messageId = 456) {
  return {
    post_type: "message",
    message_type: "group",
    time: 1_700_000_000,
    self_id: 10000,
    message_id: messageId,
    group_id: 123,
    user_id: 789,
    sender: { user_id: 789, card: "同学甲" },
    message: [{ type: "text", data: { text: "hello" } }],
    raw_message: "hello",
  };
}

describe("startOneBotEventReceiver", () => {
  beforeEach(() => {
    initDb(":memory:");
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    closeDb();
  });

  it("ingests OneBot message posts from WebSocket into EventBuffer and stores", () => {
    const sockets: FakeSocket[] = [];
    const createWebSocket: OneBotEventWebSocketFactory = (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    };
    const buffer = new EventBuffer();

    const controller = startOneBotEventReceiver({
      url: "ws://127.0.0.1:3001",
      accessToken: "secret",
      selfId: 10000,
      getTick: () => 7,
      buffer,
      createWebSocket,
    });

    expect(sockets[0]?.url).toBe("ws://127.0.0.1:3001/?access_token=secret");
    sockets[0]?.open();
    sockets[0]?.receive(groupTextEvent());

    expect(buffer.drain().events).toHaveLength(1);
    expect(listCanonicalEvents()).toHaveLength(1);
    const rows = getDb().select().from(messageLog).all();
    expect(rows[0]).toMatchObject({
      platform: "qq",
      nativeChatId: "123",
      nativeMsgId: "456",
      stableMessageId: "message:qq:123:456",
    });

    controller.close();
  });

  it("ignores malformed JSON and non-message posts", () => {
    const sockets: FakeSocket[] = [];
    const buffer = new EventBuffer();
    startOneBotEventReceiver({
      url: "ws://127.0.0.1:3001",
      getTick: () => 1,
      buffer,
      createWebSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    sockets[0]?.receive("{bad json");
    sockets[0]?.receive({ post_type: "notice", notice_type: "poke" });

    expect(buffer.drain().events).toHaveLength(0);
    expect(listCanonicalEvents()).toHaveLength(0);
  });

  it("reconnects after close and stops reconnecting after controller close", () => {
    const sockets: FakeSocket[] = [];
    const createWebSocket: OneBotEventWebSocketFactory = (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    };
    const controller = startOneBotEventReceiver({
      url: "ws://127.0.0.1:3001",
      getTick: () => 1,
      buffer: new EventBuffer(),
      reconnectMinMs: 1000,
      reconnectMaxMs: 1000,
      random: () => 0.5,
      createWebSocket,
    });

    expect(sockets).toHaveLength(1);
    sockets[0]?.drop();
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    controller.close();
    sockets[1]?.drop();
    vi.advanceTimersByTime(2000);
    expect(sockets).toHaveLength(2);
  });
});
