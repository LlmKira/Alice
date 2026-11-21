/**
 * 对话轮询（telegram/catch-up.ts）：Telegram 从不推送的群，轮询之后消息照样进 Journal，按原来的先后，
 * 推送和补拉谁先到都不重复；这次启动之前的旧消息不补。
 */
import type { Dispatcher } from "@mtcute/dispatcher";
import type { Message, TelegramClient } from "@mtcute/node";
import { describe, expect, it } from "vitest";
import type { AliceEvent } from "../src/mind/events.js";
import {
  CATCH_UP_PAGE,
  CATCH_UP_PAGES_PER_CHAT,
  CATCH_UP_PAGES_PER_ROUND,
  catchUp,
  Inbox,
} from "../src/telegram/catch-up.js";
import { Gates, Telegram } from "../src/telegram/gates.js";
import { bindTelegramWorldAdapter } from "../src/telegram/world-adapter.js";

const GROUP = -1001234;
const T0 = 1_771_000_000_000;

/** 群里的一条消息（只有入站适配读的那几个字段）。 */
function groupMessage(id: number, at: number): Message {
  return {
    id,
    date: new Date(at),
    chat: { id: GROUP, chatType: "supergroup", title: "胶片日常" },
    sender: { id: 300 + id, displayName: `群友${id}` },
    text: `第${id}条`,
    entities: [],
    media: null,
    replyToMessage: null,
  } as unknown as Message;
}

interface HistoryParams {
  limit: number;
  minId?: number;
  reverse?: boolean;
  offset?: { id: number; date: number };
}

/**
 * messages.getHistory 的语义：默认从最新往前、offset 之前的；reverse 从 offset 往后、从旧到新，offset 是编号（含）
 * 或时刻（秒）。记下每次问的是"哪一条之后"。
 */
function history(messages: readonly Message[], params: HistoryParams, requests: string[]) {
  const { id = 0, date = 0 } = params.offset ?? {};
  const after = params.reverse ? Math.max(0, id - 1) : (params.minId ?? 0);
  requests.push(`getHistory>${after}`);
  const newer = [...messages].filter((m) => m.id > (params.minId ?? 0)).sort((a, b) => a.id - b.id);
  if (params.reverse) {
    const from = (m: Message) =>
      id > 0 ? m.id >= id : date > 0 ? m.date.getTime() >= date * 1000 : true;
    return newer.filter(from).slice(0, params.limit);
  }
  return newer.reverse().slice(0, params.limit);
}

/** 一个从不推送的群：消息只能从对话列表和历史里看到。 */
function silentGroup(messages: Message[]) {
  const requests: string[] = [];
  const client = {
    async *iterDialogs() {
      requests.push("iterDialogs");
      yield { peer: { id: GROUP }, lastMessage: messages.at(-1) ?? null };
    },
    async getHistory(_peer: unknown, params: HistoryParams) {
      return history(messages, params, requests);
    },
  } as unknown as TelegramClient;
  return { client, requests };
}

function adapterInto(events: AliceEvent[], inbox: Inbox) {
  const dispatcher = {
    onNewMessage: () => {},
    onRawUpdate: () => {},
    onChatMemberUpdate: () => {},
  } as unknown as Dispatcher;
  return bindTelegramWorldAdapter(dispatcher, {
    selfId: "42",
    now: () => T0 + 10 * 60_000,
    onEvent: (e) => void events.push(e),
    admit: (scope, id) => inbox.admit(scope, id),
    newGroup: () => false,
  });
}

describe("catching up on chats Telegram never pushed", () => {
  it("journals the missed messages in their order, once, and nothing from before this start", async () => {
    const startedAt = T0;
    const messages = [
      groupMessage(4, T0 - 60_000), // 这次启动之前的：不补
      groupMessage(5, T0 + 60_000),
      groupMessage(6, T0 + 120_000),
      groupMessage(7, T0 + 180_000),
    ];
    const inbox = new Inbox();
    const journal: AliceEvent[] = [];
    const adapter = adapterInto(journal, inbox);
    const { client, requests } = silentGroup(messages);
    const tg = new Telegram(client, new Gates());

    const round = await catchUp(tg, inbox, adapter.receive, startedAt);
    expect(round).toEqual({ dialogs: 1, gaps: 1, fetched: 3, carried: 0 });
    expect(journal.map((e) => (e.type === "message.received" ? e.messageId : e.type))).toEqual([
      "5",
      "6",
      "7",
    ]);
    expect(journal[0]).toMatchObject({ scope: `telegram:${GROUP}`, chatType: "group" });

    // 推送晚到了一条已经补过的：不重复。
    adapter.receive(groupMessage(6, T0 + 120_000), client);
    // 下一轮：没有新消息，不再拉历史。
    expect(await catchUp(tg, inbox, adapter.receive, startedAt)).toEqual({
      dialogs: 1,
      gaps: 0,
      fetched: 0,
      carried: 0,
    });
    expect(journal).toHaveLength(3);

    // 又来了一条，只补它（从见过的最新一条往后拉）。
    messages.push(groupMessage(8, T0 + 240_000));
    expect(await catchUp(tg, inbox, adapter.receive, startedAt)).toMatchObject({ fetched: 1 });
    expect(journal.at(-1)).toMatchObject({ messageId: "8" });
    expect(requests.filter((r) => r.startsWith("getHistory"))).toEqual([
      "getHistory>0",
      "getHistory>7",
    ]);
  });

  it("a chat the Journal already knows is filled only past what it has seen", async () => {
    const inbox = new Inbox();
    inbox.observe({
      type: "message.received",
      at: T0 + 60_000,
      scope: `telegram:${GROUP}`,
      chatType: "group",
      messageId: "5",
      senderId: "305",
      senderName: "群友5",
      text: "第5条",
      contentType: "text",
      replyToMessageId: null,
      directed: false,
    });
    const journal: AliceEvent[] = [];
    const adapter = adapterInto(journal, inbox);
    const { client } = silentGroup([groupMessage(5, T0 + 60_000), groupMessage(6, T0 + 120_000)]);
    const round = await catchUp(new Telegram(client, new Gates()), inbox, adapter.receive, T0);
    expect(round.fetched).toBe(1);
    expect(journal.map((e) => (e.type === "message.received" ? e.messageId : ""))).toEqual(["6"]);
  });

  it("her own message does not skip what was not fetched before it", async () => {
    // 不推送的群里：她见过 5，6–8 还没补到，她发了 9（被别处叫醒、或者早就打算说的）。
    const scope = `telegram:${GROUP}`;
    const inbox = new Inbox();
    inbox.observe({
      type: "message.received",
      at: T0 + 60_000,
      scope,
      chatType: "group",
      messageId: "5",
      senderId: "305",
      senderName: "群友5",
      text: "第5条",
      contentType: "text",
      replyToMessageId: null,
      directed: false,
    });
    inbox.observe({
      type: "message.sent",
      at: T0 + 200_000,
      scope,
      messageId: "9",
      kind: "text",
      text: "嗯",
    });
    const journal: AliceEvent[] = [];
    const adapter = adapterInto(journal, inbox);
    const mine = { ...groupMessage(9, T0 + 200_000), sender: { id: 42, displayName: "Alice" } };
    const messages = [6, 7, 8].map((k) => groupMessage(k, T0 + k * 20_000));
    const { client } = silentGroup([...messages, mine as Message]);
    const tg = new Telegram(client, new Gates());
    await catchUp(tg, inbox, adapter.receive, T0);
    expect(journal.map((e) => (e.type === "message.received" ? e.messageId : ""))).toEqual([
      "6",
      "7",
      "8",
    ]);
    // 拉过了（连她那条）：下一轮不再拉。
    expect((await catchUp(tg, inbox, adapter.receive, T0)).gaps).toBe(0);
  });

  it("an old pinned chat at the top of the list does not end the round", async () => {
    // 对话列表里置顶的排在最前、不按时间；上线第一轮被一个很久没动的置顶会话挡住，dialogs: 0。
    const PINNED = -100999;
    const fresh = groupMessage(5, T0 + 60_000);
    const client = {
      async *iterDialogs() {
        yield {
          peer: { id: PINNED },
          isPinned: true,
          lastMessage: { ...groupMessage(1, T0 - 86_400_000), chat: { id: PINNED } },
        };
        yield { peer: { id: GROUP }, isPinned: false, lastMessage: fresh };
      },
      async getHistory() {
        return [fresh];
      },
    } as unknown as TelegramClient;
    const inbox = new Inbox();
    const journal: AliceEvent[] = [];
    const adapter = adapterInto(journal, inbox);
    const round = await catchUp(new Telegram(client, new Gates()), inbox, adapter.receive, T0);
    expect(round).toEqual({ dialogs: 1, gaps: 1, fetched: 1, carried: 0 });
  });
});

describe("a backlog longer than one page", () => {
  /** 群 group 里的第 id 条。 */
  const inGroup = (group: number, id: number, at: number) =>
    ({
      ...groupMessage(id, at),
      chat: { id: group, chatType: "supergroup", title: "群" },
    }) as Message;

  /** 几个从不推送的群（id → 消息）。 */
  function silentGroups(chats: ReadonlyMap<number, Message[]>) {
    const requests: string[] = [];
    const client = {
      async *iterDialogs() {
        for (const [id, messages] of chats)
          yield { peer: { id }, lastMessage: messages.at(-1) ?? null };
      },
      async getHistory(peer: { id: number }, params: HistoryParams) {
        return history(chats.get(peer.id) ?? [], params, requests);
      },
    } as unknown as TelegramClient;
    return { client, requests };
  }

  it("arrives whole and in order over rounds; one chat takes at most a bounded share of a round", async () => {
    // 停机或轮询出错之后，一个群攒下 500 条：一轮最多拉这个群 CATCH_UP_PAGES_PER_CHAT 页，剩下的下一轮接着拉。
    const messages = Array.from({ length: 500 }, (_, k) => groupMessage(11 + k, T0 + 1000 + k));
    const inbox = new Inbox();
    const journal: AliceEvent[] = [];
    const adapter = adapterInto(journal, inbox);
    const { client, requests } = silentGroups(new Map([[GROUP, messages]]));
    const tg = new Telegram(client, new Gates());
    const perRound = CATCH_UP_PAGE * CATCH_UP_PAGES_PER_CHAT;

    const first = await catchUp(tg, inbox, adapter.receive, T0);
    expect(first).toEqual({ dialogs: 1, gaps: 1, fetched: perRound, carried: 1 });
    expect(requests).toHaveLength(CATCH_UP_PAGES_PER_CHAT);
    let rounds = 1;
    while ((await catchUp(tg, inbox, adapter.receive, T0)).carried > 0) rounds++;
    expect(rounds + 1).toBe(Math.ceil(500 / perRound));
    const ids = journal.map((e) => (e.type === "message.received" ? Number(e.messageId) : 0));
    expect(ids).toEqual(messages.map((m) => m.id));
  });

  it("one round asks for at most CATCH_UP_PAGES_PER_ROUND pages; the chats it could not reach wait for the next", async () => {
    const chats = new Map(
      Array.from({ length: 10 }, (_, g) => {
        const group = -1001000 - g;
        const list = Array.from({ length: 2 * CATCH_UP_PAGE + 1 }, (_, k) =>
          inGroup(group, 1 + k, T0 + 1000 + k),
        );
        return [group, list] as const;
      }),
    );
    const inbox = new Inbox();
    const journal: AliceEvent[] = [];
    const adapter = adapterInto(journal, inbox);
    const { client, requests } = silentGroups(chats);
    // 轮询每隔几分钟一轮：全局节流按这个时钟算，不按真实时间等。
    let now = T0 + 10 * 60_000;
    const tg = new Telegram(client, new Gates(() => now));
    const round = () => {
      now += 3 * 60_000;
      return catchUp(tg, inbox, adapter.receive, T0);
    };

    const first = await round();
    expect(requests).toHaveLength(CATCH_UP_PAGES_PER_ROUND);
    expect(first.carried).toBeGreaterThan(0);
    while ((await round()).carried > 0);
    const total = [...chats.values()].reduce((s, l) => s + l.length, 0);
    expect(journal).toHaveLength(total);
  });
});
