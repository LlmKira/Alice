/**
 * 第一次私聊的外壳（telegram/first-dm.ts、gates.ts post）和它写进世界的事实（pressure/reach.ts）：
 * Telegram 的原始错误码记下来；第一次私聊前先经共同的群拿到对方的访问凭证再发；不收她私聊的人不再被她第一次私聊，
 * 对方先来找她就照常聊。
 */
import { Long, MtPeerNotFoundError, type TelegramClient, tl } from "@mtcute/node";
import { describe, expect, it } from "vitest";
import { deliver, ponderOutcome } from "../src/interpret.js";
import { decodeEvent } from "../src/journal.js";
import {
  createPressure,
  PRODUCTION,
  pressureProduction,
  reach as reachFeature,
} from "../src/mechanisms/pressure/index.js";
import { privateScopeOf, unopenedPrivate } from "../src/mechanisms/pressure/reach.js";
import type { World } from "../src/mechanisms/pressure/world.js";
import { mechanisms } from "../src/mechanisms/registry.js";
import { type Act, affordances } from "../src/mind/affordances.js";
import type { ActFailed, AliceEvent, MessageReceived } from "../src/mind/events.js";
import { type AliceState, emptyState } from "../src/mind/state.js";
import { step } from "../src/mind/step.js";
import { type ActContext, executeAct } from "../src/telegram/acts.js";
import { Album } from "../src/telegram/album.js";
import { rethrowTelegramActionFailure } from "../src/telegram/errors.js";
import { Acquaintances } from "../src/telegram/first-dm.js";
import { Gates, Telegram } from "../src/telegram/gates.js";
import { Shelf } from "../src/telegram/shelf.js";

const USER = 200;
const GROUP_ID = -100500;
const HASH = Long.fromNumber(777);
const SEND: Act = { kind: "send", text: "嗨", replyTo: null };

/** 她在里面的群：mtcute 有完整的凭证。 */
const groupPeer = (id: number) => ({
  _: "inputPeerChannel",
  channelId: -id,
  accessHash: Long.fromNumber(5),
});

/**
 * 假 Telegram 客户端：记下每次调用；fail 里的方法抛错（给一串时按调用次序，用完就不再抛）。
 * known：mtcute 自己存没存着这个人（没有时解析抛 MtPeerNotFoundError）。
 */
function fakeClient(fail: Record<string, unknown> = {}, known = true) {
  const calls: Array<[string, unknown[]]> = [];
  const counts = new Map<string, number>();
  const failure = (name: string): unknown => {
    const f = fail[name];
    const i = counts.get(name) ?? 0;
    counts.set(name, i + 1);
    return Array.isArray(f) ? f[i] : f;
  };
  const method =
    (name: string, result: (...args: unknown[]) => unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, args]);
      const f = failure(name);
      if (f) throw f;
      return result(...args);
    };
  const client = {
    resolvePeer: method("resolvePeer", (id) => {
      if ((id as number) < 0) return groupPeer(id as number);
      if (!known) throw new MtPeerNotFoundError(`Peer ${id} is not found in local cache`);
      return { _: "inputPeerUser", userId: id, accessHash: Long.fromNumber(1) };
    }),
    call: method("call", (request) => {
      const [input] = (request as { id: Array<{ userId: number }> }).id;
      return [{ _: "user", id: input?.userId, accessHash: HASH }];
    }),
    sendText: method("sendText", () => ({ id: 41 })),
    sendMedia: method("sendMedia", () => ({ id: 42 })),
    readHistory: method("readHistory", () => undefined),
    readReactions: method("readReactions", () => undefined),
    setTyping: method("setTyping", () => undefined),
  } as unknown as TelegramClient;
  return { client, calls, names: () => calls.map(([n]) => n) };
}

function said(o: Partial<MessageReceived>): MessageReceived {
  return {
    type: "message.received",
    at: 0,
    scope: `telegram:${GROUP_ID}`,
    chatType: "group",
    messageId: "42",
    senderId: String(USER),
    senderName: "小林",
    text: "大家好",
    contentType: "text",
    replyToMessageId: null,
    directed: false,
    ...o,
  };
}

/** 她已经在私聊里给 USER 发过一条。 */
const sentTo = (people: Acquaintances) =>
  people.observe({
    type: "message.sent",
    at: 0,
    scope: `telegram:${USER}`,
    messageId: "1",
    text: "在",
    kind: "text",
  });

/** 她在群里见过 USER（他在那里说过第 42 条），还没和他私聊过。 */
function metInGroup(): Acquaintances {
  const people = new Acquaintances();
  people.observe(said({}));
  return people;
}

const ctx = (client: TelegramClient, people: Acquaintances, chatId = USER): ActContext => ({
  telegram: new Telegram(client, new Gates(), undefined, people),
  target: { chatId },
  scope: `telegram:${chatId}`,
  shelf: new Shelf(),
  stickerFileId: () => null,
  album: new Album(async () => []),
  now: () => 0,
  speak: async () => {
    throw new Error("no speech synthesis in this test");
  },
  pause: async () => {},
});

describe("Telegram's own error code is recorded", () => {
  it("keeps the code next to the merged reason, so the ten soft-permanent errors can be told apart", () => {
    const failureOf = (text: string) => {
      try {
        rethrowTelegramActionFailure(new tl.RpcError(400, text), "send_text");
      } catch (error) {
        return (error as { failure: unknown }).failure;
      }
    };
    expect(failureOf("USER_PRIVACY_RESTRICTED")).toEqual({
      reason: "transport_soft_permanent",
      rpc: "USER_PRIVACY_RESTRICTED",
    });
    expect(failureOf("CHAT_WRITE_FORBIDDEN")).toEqual({
      reason: "transport_soft_permanent",
      rpc: "CHAT_WRITE_FORBIDDEN",
    });
    // 没归类的照旧是结果未知，也带上码。
    expect(failureOf("SOMETHING_NEW")).toEqual({ reason: "outcome_unknown", rpc: "SOMETHING_NEW" });
  });

  it("writes the code into act.failed and the log line, and the Journal reads it back", async () => {
    const { client } = fakeClient({ sendText: new tl.RpcError(403, "CHAT_WRITE_FORBIDDEN") });
    const events: AliceEvent[] = [];
    const logs: Array<Record<string, unknown>> = [];
    const people = metInGroup();
    sentTo(people);
    await deliver([{ type: "act", scope: `telegram:${USER}`, act: SEND }], {
      now: () => 1,
      emit: (e) => void events.push(e),
      act: (_scope, act) => executeAct(ctx(client, people), act),
      timeline: () => [],
      log: (_m, fields) => void logs.push(fields),
    });
    const failed = events[0] as ActFailed;
    expect(failed).toMatchObject({
      type: "act.failed",
      reason: "transport_soft_permanent",
      rpc: "CHAT_WRITE_FORBIDDEN",
    });
    expect(logs[0]).toMatchObject({
      reason: "transport_soft_permanent",
      rpc: "CHAT_WRITE_FORBIDDEN",
    });
    const row = { ...failed, dmClosed: true as const };
    expect(decodeEvent(row.type, row.scope, row)).toMatchObject({
      rpc: "CHAT_WRITE_FORBIDDEN",
      dmClosed: true,
    });
  });
});

describe("before a first private message she gets the person through a group they share", () => {
  it("asks Telegram for the person by their message in the shared group, then sends with that access hash", async () => {
    const { client, calls, names } = fakeClient();
    await expect(executeAct(ctx(client, metInGroup()), SEND)).resolves.toEqual({
      kind: "posted",
      messageId: "41",
    });
    expect(calls.find(([n]) => n === "call")?.[1]?.[0]).toEqual({
      _: "users.getUsers",
      id: [{ _: "inputUserFromMessage", peer: groupPeer(GROUP_ID), msgId: 42, userId: USER }],
    });
    expect(calls.find(([n]) => n === "sendText")?.[1]?.[0]).toEqual({
      _: "inputPeerUser",
      userId: USER,
      accessHash: HASH,
    });
    expect(names().indexOf("call")).toBeLessThan(names().indexOf("sendText"));
  });

  it("tries the next way when a group route is gone, and fails honestly when there is none", async () => {
    // 群里那条消息不在了：退到 mtcute 自己存着的那个人。
    const gone = fakeClient({ call: [new tl.RpcError(400, "MSG_ID_INVALID")] });
    await executeAct(ctx(gone.client, metInGroup()), SEND);
    expect(gone.names().filter((n) => n === "call")).toHaveLength(2);
    expect(gone.calls.find(([n]) => n === "sendText")?.[1]?.[0]).toMatchObject({
      accessHash: HASH,
    });

    // 没有共同的群，mtcute 也不认识：照实失败，什么也没发。
    const nowhere = fakeClient({}, false);
    await expect(executeAct(ctx(nowhere.client, new Acquaintances()), SEND)).rejects.toMatchObject({
      code: "peer_unreachable",
    });
    expect(nowhere.names()).not.toContain("sendText");

    // 限流不是"这条路不通"：照 Telegram 说的记。
    const flood = fakeClient({ call: new tl.RpcError(420, "FLOOD_WAIT_%d") });
    await expect(executeAct(ctx(flood.client, metInGroup()), SEND)).rejects.toMatchObject({
      code: "too_often",
      failure: { rpc: "FLOOD_WAIT_%d" },
    });
    expect(flood.names()).not.toContain("sendText");
  });

  it("does not look the person up again once they have talked privately", async () => {
    const { client, calls, names } = fakeClient();
    const people = metInGroup();
    people.observe(
      said({ scope: `telegram:${USER}`, chatType: "private", messageId: "1", directed: true }),
    );
    await executeAct(ctx(client, people), SEND);
    expect(names()).not.toContain("call");
    expect(calls.find(([n]) => n === "sendText")?.[1]?.[0]).toBe(USER);
  });

  it("says the person does not take her messages when Telegram refuses after the access hash", async () => {
    const after = fakeClient({ sendText: new tl.RpcError(400, "PEER_ID_INVALID") });
    await expect(executeAct(ctx(after.client, metInGroup()), SEND)).rejects.toMatchObject({
      failure: { reason: "transport_soft_permanent", rpc: "PEER_ID_INVALID", dmClosed: true },
    });
    const privacy = fakeClient({ sendText: new tl.RpcError(403, "USER_PRIVACY_RESTRICTED") });
    await expect(executeAct(ctx(privacy.client, metInGroup()), SEND)).rejects.toMatchObject({
      failure: { reason: "transport_soft_permanent", dmClosed: true },
    });
    // 没拿过凭证（已有的私聊）时的 PEER_ID_INVALID 不是关于这个人的事实。
    const people = metInGroup();
    sentTo(people);
    const plain = fakeClient({ sendText: new tl.RpcError(400, "PEER_ID_INVALID") });
    const error = await executeAct(ctx(plain.client, people), SEND).catch((e: unknown) => e);
    expect((error as { failure: unknown }).failure).toEqual({
      reason: "transport_soft_permanent",
      rpc: "PEER_ID_INVALID",
    });
  });
});

// ── 从外壳到世界：不收她私聊的人（pressure/reach.ts）────────────────

/** 本地（UTC+8）11 月 12 日 10:00，醒着。 */
const T0 = Date.UTC(2026, 10, 12, 2, 0);
const MIN = 60_000;
const H = 60 * MIN;
const GROUP = "telegram:-100";
const DM = privateScopeOf(GROUP, "100");
const pressure = createPressure(affordances, { ...PRODUCTION, reach: reachFeature });
const withReach = [pressure, ...mechanisms.filter((m) => m !== pressureProduction)];

let n = 0;
function msg(at: number, o: Partial<MessageReceived> = {}): MessageReceived {
  n++;
  const scope = o.scope ?? GROUP;
  const group = scope.startsWith("telegram:-");
  return {
    type: "message.received",
    at,
    scope,
    chatType: group ? "group" : "private",
    messageId: String(n),
    senderId: "100",
    senderName: "小林",
    text: "hi",
    contentType: "text",
    replyToMessageId: null,
    directed: false,
    ...(group ? { chatTitle: "周末爬山群" } : {}),
    ...o,
  };
}

/** 小林在群里几天里和她互动过（relationTier 进 tier 50），还没私聊过。 */
const met = () => [
  msg(T0 - 24 * H, { text: "爱丽丝最近有去爬山吗，风大不大", directed: true }),
  {
    type: "message.sent" as const,
    at: T0 - 24 * H + 20_000,
    scope: GROUP,
    messageId: "ms0",
    text: "还没呢",
    kind: "text" as const,
  },
  msg(T0, { text: "爱丽丝你周末去爬山吗", directed: true }),
  {
    type: "message.sent" as const,
    at: T0 + 20_000,
    scope: GROUP,
    messageId: "ms1",
    text: "好呀",
    kind: "text" as const,
  },
  msg(T0 + MIN, { text: "我带了新的登山杖", directed: true }),
];

/**
 * 外壳那一圈的最小版：事件和计时器按时间送进 step()（每分钟一格时钟），叫醒她在私聊时她说"嗨"，别处不说；
 * 对外动作走真的执行器（acts.ts、gates.ts）和假客户端，结果按 interpret.ts 写回；投影和 index.ts 一样只看写回的事件。
 */
async function live(events: readonly AliceEvent[], client: TelegramClient, end: number) {
  let state: AliceState = emptyState;
  const people = new Acquaintances();
  /** 还没送进去的事件（外面来的消息，和她定的计时器到点），按时间排。 */
  const queue = [...events].sort((a, b) => a.at - b.at);
  const wakes: number[] = [];
  const feed = async (event: AliceEvent): Promise<void> => {
    const result = step(state, event, withReach);
    state = result.state;
    people.observe(event);
    for (const effect of result.effects) {
      const now = () => event.at;
      if (effect.type === "set-timer") {
        const { scope, timerId } = effect;
        queue.push({ type: "timer.fired", at: effect.at, scope, timerId });
        queue.sort((a, b) => a.at - b.at);
      } else if (effect.type === "call-speech") {
        if (effect.scope === DM) wakes.push(event.at);
        const acts = effect.scope === DM ? [SEND] : [];
        const { scope, callId } = effect;
        await feed({ type: "speech.decided", at: event.at, scope, callId, decision: { acts } });
      } else if (effect.type === "call-ponder") {
        await feed(await ponderOutcome(effect, () => Promise.reject(new Error("no ponder")), now));
      } else if (effect.type === "glance") {
        await feed({ type: "chat.glanced", at: event.at, scope: effect.scope });
      } else if (effect.type === "act") {
        await deliver([effect], {
          now,
          emit: feed,
          act: (scope, act) => {
            const chatId = Number(scope.slice("telegram:".length));
            return executeAct({ ...ctx(client, people, chatId), scope }, act);
          },
          timeline: (scope) => state.chats[scope]?.timeline ?? [],
        });
      }
    }
  };
  for (let at = Math.ceil(T0 / MIN) * MIN; at <= end; at += MIN) {
    while (queue[0] && queue[0].at <= at) await feed(queue.shift() as AliceEvent);
    await feed({ type: "clock.tick", at });
  }
  return { wakes, world: state.mechanisms[pressure.name] as World };
}

describe("someone who does not take her private messages", { timeout: 30_000 }, () => {
  it("is not messaged first again; a refusal that says nothing about the person does not stop her", async () => {
    const privacy = fakeClient({ sendText: new tl.RpcError(403, "USER_PRIVACY_RESTRICTED") });
    const closed = await live(met(), privacy.client, T0 + 24 * H);
    expect(closed.wakes).toHaveLength(1);
    expect(privacy.names().filter((n) => n === "sendText")).toHaveLength(1);
    expect(Object.keys(closed.world.reach.closed ?? {})).toEqual(["100"]);
    expect(unopenedPrivate(closed.world).has(DM)).toBe(false);

    // 对照：这个私聊此刻发不出去，但 Telegram 没说是这个人不收（不是 dmClosed）。
    const other = fakeClient({ sendText: new tl.RpcError(400, "CHAT_RESTRICTED") });
    const open = await live(met(), other.client, T0 + 24 * H);
    expect(open.wakes.length).toBeGreaterThan(1);
  });

  it("is talked to as usual once they write to her first", async () => {
    const privacy = fakeClient({ sendText: [new tl.RpcError(403, "USER_PRIVACY_RESTRICTED")] });
    const back = T0 + 24 * H;
    const events = [
      ...met(),
      msg(back, { scope: DM, chatType: "private", text: "刚看到你找我", directed: true }),
    ];
    const { wakes, world } = await live(events, privacy.client, T0 + 36 * H);
    expect(wakes.filter((t) => t < back)).toHaveLength(1);
    expect(wakes.some((t) => t >= back)).toBe(true);
    expect(world.reach.closed).toEqual({});
    // 他先来找她之后的私聊不再当成第一次：直接发往他的 id。
    expect(privacy.calls.filter(([n]) => n === "sendText").at(-1)?.[1]?.[0]).toBe(100);
  });
});
