/**
 * 平台层仿真：一个假的 Telegram 客户端，照 mtcute 0.32 在用户账号上的样子送更新，经真的入站适配（world-adapter）、
 * 去重和对话轮询（catch-up.ts Inbox、catchUp、Groups）变成事件流。
 *
 * 复现的几种怪处（2026-11-12 体检的缺陷都出在这里，eval-artifacts/footprint/）：
 * - 本客户端自己发出的消息不派发（mtcute noDispatch）：她的话只经外壳的 message.sent 进 Journal；
 * - 用户账号收不到成员变化的更新（onChatMemberUpdate 登记了也不会被调用）：进群、被移出只有群里的提示消息；
 *   她自己退群是她自己的动作，提示也不派发；
 * - 同一个群里的回复，replyToMessage.sender 是 null；
 * - 不推送的群只能靠对话轮询补（消息晚到，时刻是补到的时刻）；推送晚到时，轮询和推送送来同一条；
 * - 有的群限定了可用的表情：点别的表情，sendReaction 抛 REACTION_INVALID。
 *
 * 输入是"世界里发生了什么"（will-replay 数据集格式的理想事件流：别人的消息、她发的话、进群、表情、频道帖子），
 * 输出是适配器写出来的事件流，名字（会话、人、消息编号）换回输入里的写法，所以两份可以逐行对照；
 * pnpm census 可以直接读输出。没有 Telegram 对应物的事件（noise.drawn 等）原样留着。图片的描述、语音的逐字稿
 * 取自输入里那条的媒体说明，经适配器自己的 perceive 路径写成 message.perceived（线上也是这样晚一步到）。
 * 消息编号尽量用输入里的：同一个会话里编号重复或不是数字（导入的 log:…）的，接着最后一条编，可能和后面的真编号撞上。
 *
 * 用法：tsx src/sim/platform.ts <ideal.jsonl> <out.jsonl> [--unpushed 会话,…] [--late 会话,…]
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { Dispatcher } from "@mtcute/dispatcher";
import { type Message, type TelegramClient, tl, User } from "@mtcute/node";
import type { AliceEvent } from "../mind/events.js";
import { CATCH_UP_MS, catchUp, dialogScopes, Groups, Inbox } from "../telegram/catch-up.js";
import { Gates, Telegram } from "../telegram/gates.js";
import { bindTelegramWorldAdapter, scopeOf } from "../telegram/world-adapter.js";

/** 假世界里的她。 */
export const SELF = { id: 7_000_000_001, username: "alice_fake", name: "Alice" } as const;
/** 把她拉进群的那个管理员（入群提示要有发送者）。 */
const ADMIN = { id: 7_000_000_002, name: "群管理员" } as const;
/** 推送晚到的会话里，推送比消息晚这么久（比对话轮询的间隔长，所以轮询总是先补到）。 */
export const LATE_PUSH_MS = 4 * 60_000;

type Push = "now" | "late" | "never";

interface FakeChat {
  /** Telegram 的数字 id（群是带 -100 的标记 id）。 */
  id: number;
  kind: "private" | "group" | "channel";
  title: string;
  push: Push;
  /** 允许的表情；null 是不限。 */
  reactions: ReadonlySet<string> | null;
  member: boolean;
  /** 私聊的对方（会话本身就是这个人）。 */
  partner: User | null;
  history: FakeMessage[];
}

/** 适配器、对话轮询读的那几个字段（形状照 mtcute 的 Message）。 */
interface FakeMessage {
  id: number;
  date: Date;
  chat: unknown;
  sender: User;
  text: string;
  entities: Array<{ kind: string; text: string; params: object; is(kind: string): boolean }>;
  media: { type: string; [k: string]: unknown } | null;
  action: { type: string; [k: string]: unknown } | null;
  replyToMessage: { id: number; sender: null } | null;
  client: unknown;
}

/** 别人发的一条：文字、回复哪条、点没点她的名、媒体类型和说明、提示消息的动作。 */
export interface Post {
  text?: string | null;
  replyTo?: number | null;
  mention?: boolean;
  contentType?: string;
  media?: string;
  action?: FakeMessage["action"];
}

/**
 * mtcute 的 MessageMedia 里 world-adapter 读的那几个字段，从输入里那条的媒体说明（适配器当年写的，"贴纸 😴"
 * "语音 5 秒：“……”""图片：……"）反推回去。图片的描述、语音的逐字稿放在 description 里：假客户端"下载"时给出，
 * 适配器照常经 perceive 写成 message.perceived。
 */
function mediaOf(contentType: string | undefined, said?: string): FakeMessage["media"] {
  const seconds = Number(said?.match(/(\d+) 秒/)?.[1] ?? 1);
  switch (contentType) {
    case undefined:
    case "text":
      return null;
    case "sticker":
      return { type: "sticker", emoji: said?.match(/^贴纸 (.+)$/)?.[1] ?? "" };
    case "voice":
      return { type: "voice", duration: seconds, description: said?.match(/：“(.*)”$/)?.[1] };
    case "video":
      return {
        type: "video",
        duration: seconds,
        isRound: said?.startsWith("视频消息") ?? false,
        isAnimation: said === "动图",
        // 输入里没有预览帧的描述：不给缩略图，适配器就只写"动图""视频 5 秒"。
        thumbnails: [],
      };
    case "audio":
      return { type: "audio", duration: seconds, title: null, performer: null };
    case "document":
      return { type: "document", fileName: said?.match(/^文件 (.+)$/)?.[1] ?? null };
    case "photo":
      return { type: "photo", description: said?.match(/^图片：(.+)$/)?.[1] };
    default:
      return { type: contentType };
  }
}

/** 假的看图、听语音：把假客户端"下载"给的说明原样还回来（没有说明就是没看成）。 */
const echoPerceive = async (bytes: Uint8Array): Promise<string> => {
  const text = Buffer.from(bytes).toString("utf8");
  if (!text) throw new Error("no description in the fake media");
  return text;
};

export class FakeTelegram {
  readonly dispatcher: Dispatcher;
  readonly client: TelegramClient;
  private readonly chats = new Map<number, FakeChat>();
  private readonly users = new Map<number, User>();
  private readonly onMessage: Array<(m: Message) => unknown> = [];
  private readonly onRaw: Array<{
    filter: (c: unknown, u: { _: string }) => boolean;
    fn: (c: unknown, u: unknown) => unknown;
  }> = [];
  /** 晚到的推送：到点再派发。 */
  private readonly late: Array<{ at: number; message: FakeMessage }> = [];

  constructor(private readonly now: () => number) {
    this.dispatcher = {
      onNewMessage: (fn: (m: Message) => unknown) => void this.onMessage.push(fn),
      onRawUpdate: (filter: never, fn: never) => void this.onRaw.push({ filter, fn }),
      // 用户账号收不到成员变化的更新：登记了也不会被调用。
      onChatMemberUpdate: () => {},
    } as unknown as Dispatcher;
    this.client = this.clientMethods() as unknown as TelegramClient;
    this.user(SELF.id, SELF.name);
  }

  /** 这个人此刻的样子（改过名字就是新的名字）。 */
  user(id: number, name: string, bot = false): User {
    const known = this.users.get(id);
    if (known && known.displayName === name && known.isBot === bot) return known;
    const u = new User({ _: "user", id, firstName: name, bot } as never);
    this.users.set(id, u);
    return u;
  }

  chat(
    id: number,
    kind: FakeChat["kind"],
    o: {
      title?: string;
      push?: Push;
      reactions?: readonly string[] | null;
      member?: boolean;
      partner?: User;
    } = {},
  ): FakeChat {
    const known = this.chats.get(id);
    if (known) return known;
    const c: FakeChat = {
      id,
      kind,
      title: o.title ?? `chat ${id}`,
      push: o.push ?? "now",
      reactions: o.reactions ? new Set(o.reactions) : null,
      member: o.member ?? true,
      partner: o.partner ?? null,
      history: [],
    };
    this.chats.set(id, c);
    return c;
  }

  /**
   * 别人在 chatId 发了一条（或一条提示消息）：按这个会话的推送方式派发。返回 Telegram 编号：想要的编号比这个会话
   * 已有的都大就用它（输入里的真编号），否则接着最后一条编。
   */
  post(chatId: number, from: User, post: Post, wanted?: number): number {
    const c = this.must(chatId);
    const message = this.message(c, from, post, wanted);
    c.history.push(message);
    // 被拉进群：从这一刻起她在里面（对话列表里有了这个群）。被移出：从这一刻起不在了。
    const users = (post.action?.users as number[] | undefined) ?? [];
    if (post.action?.type === "users_added" && users.includes(SELF.id)) c.member = true;
    if (post.action?.type === "user_removed" && post.action.user === SELF.id) {
      this.deliver(c, message);
      c.member = false;
      return message.id;
    }
    this.deliver(c, message);
    return message.id;
  }

  /** 她发出一条（外壳发送成功）：进历史，不派发（mtcute noDispatch）。返回 Telegram 编号。 */
  sent(chatId: number, text: string, wanted?: number): number {
    const c = this.must(chatId);
    const message = this.message(c, this.user(SELF.id, SELF.name), { text }, wanted);
    c.history.push(message);
    return message.id;
  }

  /** 她自己退群：她自己的动作，提示不派发；之后她不在里面了。 */
  leave(chatId: number): void {
    const c = this.must(chatId);
    c.history.push(
      this.message(c, this.user(SELF.id, SELF.name), { action: { type: "user_left" } }),
    );
    c.member = false;
  }

  /** 有人给一条消息点了表情（原始更新 updateMessageReactions，总会推送）。 */
  async react(chatId: number, messageId: number, from: User, emoji: string): Promise<void> {
    const upd = {
      _: "updateMessageReactions",
      peer: peerOf(chatId),
      msgId: messageId,
      reactions: {
        results: [],
        recentReactions: [
          {
            peerId: { _: "peerUser", userId: from.id },
            reaction: { _: "reactionEmoji", emoticon: emoji },
            unread: true,
          },
        ],
      },
    };
    for (const h of this.onRaw) if (h.filter(null, upd)) await h.fn(this.client, upd);
  }

  /** 到点的晚到推送（at 之前的，按时间顺序）。 */
  flush(at: number): void {
    this.late.sort((a, b) => a.at - b.at);
    while (this.late[0] && this.late[0].at <= at) {
      const { message } = this.late.shift() as { message: FakeMessage };
      this.dispatch(message);
    }
  }

  /** 下一个晚到推送的时刻（没有时为 null）。 */
  nextLate(): number | null {
    return this.late.reduce<number | null>((m, l) => (m === null || l.at < m ? l.at : m), null);
  }

  private must(chatId: number): FakeChat {
    const c = this.chats.get(chatId);
    if (!c) throw new Error(`fake telegram: no chat ${chatId}`);
    return c;
  }

  private message(c: FakeChat, from: User, post: Post, wanted?: number): FakeMessage {
    const last = c.history.at(-1)?.id ?? 0;
    const id =
      wanted !== undefined && Number.isSafeInteger(wanted) && wanted > last ? wanted : last + 1;
    return {
      id,
      date: new Date(this.now()),
      chat:
        c.kind === "private"
          ? c.partner
          : { id: c.id, chatType: c.kind === "channel" ? "channel" : "supergroup", title: c.title },
      sender: from,
      text: post.text ?? "",
      entities: post.mention
        ? [{ kind: "mention", text: `@${SELF.username}`, params: {}, is: (k) => k === "mention" }]
        : [],
      media: mediaOf(post.contentType, post.media),
      action: post.action ?? null,
      // 同一个群里的回复：mtcute 拿不到被回复者。
      replyToMessage: post.replyTo ? { id: post.replyTo, sender: null } : null,
      client: this.client,
    };
  }

  private deliver(c: FakeChat, message: FakeMessage): void {
    if (c.push === "now") this.dispatch(message);
    else if (c.push === "late") this.late.push({ at: this.now() + LATE_PUSH_MS, message });
  }

  private dispatch(message: FakeMessage): void {
    for (const fn of this.onMessage) void fn(message as unknown as Message);
  }

  /** TelegramClient 里 telegram/ 用到的那几个方法。 */
  private clientMethods() {
    const self = this;
    return {
      async *iterDialogs() {
        const mine = [...self.chats.values()].filter((c) => c.member);
        const last = (c: FakeChat) => c.history.at(-1)?.date.getTime() ?? 0;
        for (const c of mine.sort((a, b) => last(b) - last(a))) {
          yield { peer: { id: c.id }, lastMessage: c.history.at(-1) ?? null, isPinned: false };
        }
      },
      /**
       * messages.getHistory 的语义：默认从最新往前，offset 之前的；reverse（mtcute 的 add_offset = −limit）从 offset
       * 往后、按编号从旧到新，offset 是编号（含）或时刻（秒，那一刻及之后）。minId 只留比它新的。
       */
      async getHistory(
        peer: { id: number },
        params: {
          limit: number;
          minId?: number;
          reverse?: boolean;
          offset?: { id: number; date: number };
        },
      ) {
        const c = self.must(peer.id);
        const { id = 0, date = 0 } = params.offset ?? {};
        const newer = c.history.filter((m) => m.id > (params.minId ?? 0));
        if (params.reverse) {
          const from = (m: FakeMessage) =>
            id > 0 ? m.id >= id : date > 0 ? m.date.getTime() >= date * 1000 : true;
          return newer.filter(from).slice(0, params.limit);
        }
        const before = (m: FakeMessage) =>
          id > 0 ? m.id < id : date > 0 ? m.date.getTime() < date * 1000 : true;
        return newer.filter(before).reverse().slice(0, params.limit);
      },
      /** 解析会话（假 Telegram 不查凭证）：人给一个带凭证的写法，群照数字。 */
      async resolvePeer(id: number) {
        return id > 0 ? { _: "inputPeerUser", userId: id, accessHash: 1 } : id;
      },
      /** 第一次私聊前拿对方的完整资料（telegram/first-dm.ts）：认识的人都给。 */
      async call(request: { _: string; id?: Array<{ userId: number }> }) {
        if (request._ !== "users.getUsers") throw new Error(`fake telegram: no ${request._}`);
        return (request.id ?? []).map((u) =>
          self.users.has(u.userId)
            ? { _: "user", id: u.userId, accessHash: 1 }
            : { _: "userEmpty", id: u.userId },
        );
      },
      /** 她发出的消息：进历史，不派发（mtcute noDispatch）。 */
      async sendText(peer: PeerArg, text: string | { text: string }) {
        return { id: self.sent(chatOf(peer), typeof text === "string" ? text : text.text) };
      },
      async sendMedia(peer: PeerArg) {
        const c = self.must(chatOf(peer));
        const message = self.message(c, self.user(SELF.id, SELF.name), { contentType: "sticker" });
        c.history.push(message);
        return message;
      },
      async sendReaction(params: { chatId: number; message: number; emoji: string }) {
        const c = self.must(params.chatId);
        if (c.reactions && !c.reactions.has(params.emoji)) {
          throw new tl.RpcError(400, "REACTION_INVALID");
        }
      },
      async readHistory() {},
      async readReactions() {},
      async setTyping() {},
      /** "下载"图片、语音：给出输入里的描述或逐字稿（echoPerceive 还回来）。 */
      async downloadAsBuffer(file: { description?: string }) {
        return Buffer.from(file.description ?? "", "utf8");
      },
    };
  }
}

/** 外壳发往哪里：会话的数字，或第一次私聊时拿到凭证的那个人。 */
type PeerArg = number | { userId: number };

function chatOf(peer: PeerArg): number {
  return typeof peer === "number" ? peer : peer.userId;
}

/** Telegram 的原始 peer（表情更新里用）：-100 开头是超级群，其他负数是普通群，正数是人。 */
function peerOf(chatId: number): object {
  const s = String(chatId);
  if (s.startsWith("-100")) return { _: "peerChannel", channelId: Number(s.slice(4)) };
  if (chatId < 0) return { _: "peerChat", chatId: -chatId };
  return { _: "peerUser", userId: chatId };
}

/** 输入里的名字（会话、人、消息编号）和假 Telegram 里的数字之间来回换：数字就照用，别的按出现顺序编号。 */
class Names {
  private next = 9_000_000_000;
  private readonly people = new Map<string, number>();
  private readonly peopleBack = new Map<number, string>();
  private readonly scopes = new Map<string, number>();
  private readonly scopesBack = new Map<string, string>();
  private readonly messages = new Map<string, number>();
  private readonly messagesBack = new Map<string, string>();

  person(id: string): number {
    const known = this.people.get(id);
    if (known !== undefined) return known;
    const n = /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) ? Number(id) : this.next++;
    this.people.set(id, n);
    this.peopleBack.set(n, id);
    return n;
  }

  personBack(n: string): string {
    return this.peopleBack.get(Number(n)) ?? n;
  }

  /** 会话的数字 id；私聊就是对方的 id。 */
  scope(scope: string, partner?: string): number {
    const known = this.scopes.get(scope);
    if (known !== undefined) return known;
    const raw = scope.startsWith("telegram:") ? scope.slice("telegram:".length) : scope;
    const n =
      partner !== undefined
        ? this.person(partner)
        : /^-?\d+$/.test(raw) && Number.isSafeInteger(Number(raw))
          ? Number(raw)
          : -(1_000_000_000_000 + this.next++);
    this.scopes.set(scope, n);
    this.scopesBack.set(scopeOf(n), scope);
    return n;
  }

  scopeBack(scope: string): string {
    return this.scopesBack.get(scope) ?? scope;
  }

  message(scope: string, id: string, n: number): void {
    this.messages.set(`${scope}/${id}`, n);
    this.messagesBack.set(`${scopeOf(this.scope(scope))}/${n}`, id);
  }

  /** 一条消息在假 Telegram 里的编号：发生过的照它的编号；没发生过的（回复的是更早的消息）是数字就照用。 */
  messageOf(scope: string, id: string | null): number | null {
    if (id === null) return null;
    const known = this.messages.get(`${scope}/${id}`);
    if (known !== undefined) return known;
    return /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) ? Number(id) : null;
  }

  /** 输入里的编号是数字就想用它（post 的 wanted）。 */
  wanted(id: string): number | undefined {
    return /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) ? Number(id) : undefined;
  }

  messageBack(fakeScope: string, n: string): string {
    return this.messagesBack.get(`${fakeScope}/${n}`) ?? n;
  }
}

export interface PlatformOptions {
  /** 不推送的会话（输入里的写法）：消息只能靠对话轮询补。 */
  unpushed?: ReadonlySet<string>;
  /** 推送晚到的会话：对话轮询先补到，推送再送一遍。 */
  late?: ReadonlySet<string>;
}

/**
 * 把理想的事件流送过平台层：按时间顺序在假客户端里发生，真的适配器写出事件；对话轮询每 CATCH_UP_MS 一轮。
 * 返回适配器写出的事件流（加上外壳会写的 message.sent 和原样留着的事件），名字换回输入里的写法，按时刻排好。
 */
export async function throughPlatform(
  ideal: readonly AliceEvent[],
  o: PlatformOptions = {},
): Promise<AliceEvent[]> {
  const events = [...ideal].sort((a, b) => a.at - b.at);
  const start = events[0]?.at ?? 0;
  let now = start;
  const fake = new FakeTelegram(() => now);
  const names = new Names();
  // 会话：第一个事件是她进群的，开始时她还不在里面（对话列表里没有）。
  const first = new Map<string, AliceEvent>();
  for (const e of events) if ("scope" in e && e.scope && !first.has(e.scope)) first.set(e.scope, e);
  for (const [scope, e] of first) {
    const push: Push = o.unpushed?.has(scope) ? "never" : o.late?.has(scope) ? "late" : "now";
    if (e.type === "post.received") {
      fake.chat(names.scope(scope), "channel", { title: e.title, push });
    } else if (e.type === "message.received" && e.chatType === "private") {
      const partner = fake.user(names.person(e.senderId), e.senderName);
      fake.chat(names.scope(scope, e.senderId), "private", { push, partner });
    } else if (e.type === "message.sent" && !scope.startsWith("telegram:-")) {
      // 她先开口的私聊：会话的 id 就是对方。
      const id = names.scope(scope);
      fake.chat(id, "private", { push, partner: fake.user(id, scope) });
    } else if (
      e.type === "message.received" ||
      e.type === "message.sent" ||
      e.type === "member.joined" ||
      e.type === "membership.changed"
    ) {
      const title = e.type === "message.received" ? e.chatTitle : undefined;
      fake.chat(names.scope(scope), "group", {
        push,
        member: !(e.type === "membership.changed" && e.member),
        ...(title ? { title } : {}),
      });
    }
  }

  // 真的那几样：去重、她在哪些群、入站适配、对话轮询。适配器写出的事件像 Journal 一样再投影给前两样。
  const inbox = new Inbox();
  const groups = new Groups();
  /** 适配器（和外壳）写出的事件，名字是假 Telegram 的；as-is 是原样留着的输入事件，名字已是输入的写法。 */
  const out: Array<{ e: AliceEvent; asIs: boolean }> = [];
  const journal = (e: AliceEvent) => {
    out.push({ e, asIs: false });
    inbox.observe(e);
    groups.observe(e);
  };
  const adapter = bindTelegramWorldAdapter(fake.dispatcher, {
    selfId: String(SELF.id),
    selfUsername: SELF.username,
    now: () => now,
    onEvent: journal,
    admit: (scope, id) => inbox.admit(scope, id),
    newGroup: (scope) => groups.isNew(scope),
    perceive: { image: echoPerceive, gif: echoPerceive, video: echoPerceive, voice: echoPerceive },
  });
  const tg = new Telegram(fake.client, new Gates(() => now));
  /** 看图、听语音是异步的：在时钟往前走之前让它们写完（同一刻）。 */
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  groups.started(await dialogScopes(tg));

  let nextPoll = start + CATCH_UP_MS;
  /** 到 at 为止：晚到的推送和对话轮询按时间顺序发生。 */
  const advance = async (at: number) => {
    for (;;) {
      const late = fake.nextLate();
      if (late !== null && late <= at && late < nextPoll) {
        now = late;
        fake.flush(late);
        await settle();
      } else if (nextPoll <= at) {
        now = nextPoll;
        fake.flush(nextPoll);
        await catchUp(tg, inbox, adapter.receive, start);
        await settle();
        nextPoll += CATCH_UP_MS;
      } else {
        return;
      }
    }
  };

  const hers = new Set<string>();
  for (const e of events) {
    await advance(e.at);
    now = e.at;
    switch (e.type) {
      case "message.received": {
        const chatId = names.scope(e.scope, e.chatType === "private" ? e.senderId : undefined);
        const replyTo = names.messageOf(e.scope, e.replyToMessageId);
        const toHer = e.replyToMessageId !== null && hers.has(`${e.scope}/${e.replyToMessageId}`);
        const from = fake.user(names.person(e.senderId), e.senderName, e.isBot === true);
        const n = fake.post(
          chatId,
          from,
          {
            text: e.text,
            replyTo,
            // 群里冲着她、又不是回复她的：是点了她的名。
            mention: e.directed && e.chatType === "group" && !toHer,
            contentType: e.contentType,
            ...(e.media ? { media: e.media } : {}),
          },
          names.wanted(e.messageId),
        );
        names.message(e.scope, e.messageId, n);
        await settle();
        break;
      }
      case "message.sent": {
        // 她发出的消息：外壳在发送成功后记 message.sent（客户端不派发）。
        const chatId = names.scope(e.scope);
        const id = fake.sent(chatId, e.text, names.wanted(e.messageId));
        names.message(e.scope, e.messageId, id);
        hers.add(`${e.scope}/${e.messageId}`);
        journal({ ...e, scope: scopeOf(chatId), messageId: String(id) });
        break;
      }
      case "member.joined": {
        const user = fake.user(names.person(e.userId), e.userId);
        fake.post(names.scope(e.scope), user, {
          action: { type: "user_joined_link", inviter: ADMIN.id },
        });
        break;
      }
      case "membership.changed": {
        const chatId = names.scope(e.scope);
        const admin = fake.user(ADMIN.id, ADMIN.name);
        if (e.member)
          fake.post(chatId, admin, { action: { type: "users_added", users: [SELF.id] } });
        else if (e.reason === "kicked")
          fake.post(chatId, admin, { action: { type: "user_removed", user: SELF.id } });
        else fake.leave(chatId);
        break;
      }
      case "post.received": {
        const admin = fake.user(ADMIN.id, ADMIN.name);
        const n = fake.post(
          names.scope(e.scope),
          admin,
          { text: e.text },
          names.wanted(e.messageId),
        );
        names.message(e.scope, e.messageId, n);
        break;
      }
      case "reaction.received": {
        const n = names.messageOf(e.scope, e.messageId);
        if (n !== null && e.senderId !== null) {
          await fake.react(
            names.scope(e.scope),
            n,
            fake.user(names.person(e.senderId), e.senderId),
            e.emoji,
          );
        }
        break;
      }
      default:
        // 没有 Telegram 对应物的事件（她的随机数、外壳看懂的图）原样留着。
        out.push({ e, asIs: true });
    }
  }
  // 最后再轮询一轮，补齐不推送的会话里最后那几条。
  await advance((events.at(-1)?.at ?? start) + LATE_PUSH_MS + CATCH_UP_MS);

  return out.map(({ e, asIs }) => (asIs ? e : back(e, names))).sort((a, b) => a.at - b.at);
}

/** 适配器写出的事件 → 输入里的写法。 */
function back(e: AliceEvent, names: Names): AliceEvent {
  if (!("scope" in e) || !e.scope) return e;
  const fakeScope = e.scope;
  const scope = names.scopeBack(fakeScope);
  switch (e.type) {
    case "message.received":
      return {
        ...e,
        scope,
        senderId: names.personBack(e.senderId),
        messageId: names.messageBack(fakeScope, e.messageId),
        replyToMessageId:
          e.replyToMessageId === null ? null : names.messageBack(fakeScope, e.replyToMessageId),
      };
    case "message.sent":
    case "post.received":
    case "message.perceived":
      return { ...e, scope, messageId: names.messageBack(fakeScope, e.messageId) };
    case "reaction.received":
      return {
        ...e,
        scope,
        messageId: names.messageBack(fakeScope, e.messageId),
        senderId: e.senderId === null ? null : names.personBack(e.senderId),
      };
    case "member.joined":
      return { ...e, scope, userId: names.personBack(e.userId) };
    default:
      return { ...e, scope } as AliceEvent;
  }
}

async function main(): Promise<void> {
  const [input, output, ...rest] = process.argv.slice(2);
  if (!input || !output)
    throw new Error("usage: platform.ts <ideal.jsonl> <out.jsonl> [--unpushed a,b] [--late a,b]");
  const list = (flag: string) => {
    const i = rest.indexOf(flag);
    return new Set(i >= 0 ? (rest[i + 1] ?? "").split(",").filter(Boolean) : []);
  };
  const ideal = readFileSync(input, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AliceEvent);
  const out = await throughPlatform(ideal, { unpushed: list("--unpushed"), late: list("--late") });
  writeFileSync(output, `${out.map((e) => JSON.stringify(e)).join("\n")}\n`);
  console.log(`${ideal.length} 个事件进去，${out.length} 个出来`);
}

if (process.argv[1]?.endsWith("platform.ts")) void main();
