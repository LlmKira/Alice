/**
 * 执行器护的资源不变量（不是社交节奏，节奏由意愿层的代价管）：全局节流、每个会话的第二道连发闸、加群和找群的
 * 次数上限。一份 Gates 由平台（platform.ts）构造，像花费账一样从 Journal 恢复计数（observe），所以重启不会把今天的加群
 * 额度清零。Telegram 把客户端和这份限额绑在一起，telegram/ 里的每个请求都经它的 request / post。
 */
import type { InputPeerLike, TelegramClient } from "@mtcute/node";
import type { AliceEvent } from "../mind/events.js";
import { KeyedBurstLimiter, SlidingWindowLimiter } from "../utils/rate-limit.js";
import { rethrowTelegramActionFailure, TelegramActionError } from "./errors.js";
import { Acquaintances, closesDm, reachUser } from "./first-dm.js";

const MIN = 60_000;
const H = 60 * MIN;

export type Exploration = "join" | "search";

/** 加群、找群在登记表里是哪一行。 */
const EXPLORATION_KIND = { "join-chat": "join", "chat-search": "search" } as const;

export class Gates {
  readonly throttle: SlidingWindowLimiter;
  /** 第二道闸：即使上游的连发上限出错，同一会话 60 秒内也发不出第 7 条。 */
  readonly burst: KeyedBurstLimiter;
  /**
   * 加入和找群的次数上限（2 月 ExplorationGuard：每天加 5 个、每小时找 10 次）：Telegram 对频繁加群、
   * 搜索会限流甚至封号。超出时记为带类型的失败 too_often。
   */
  readonly exploration: Record<Exploration, KeyedBurstLimiter>;

  constructor(now: () => number = Date.now) {
    this.throttle = new SlidingWindowLimiter(30, MIN, now);
    this.burst = new KeyedBurstLimiter(6, MIN, now);
    this.exploration = {
      join: new KeyedBurstLimiter(5, 24 * H, now),
      search: new KeyedBurstLimiter(10, H, now),
    };
  }

  /**
   * 启动时从 Journal 恢复历史计数（只在启动 fold 阶段调用，运行期由 Telegram.post / explore 的 tryAcquire
   * 记账，重复调用会双倍计数）：加群、找群各试过几次（做成了或 Telegram 拒绝了都算；被这里的额度挡下的
   * too_often 没发出请求，不算），以及她在每个会话发出的消息。
   */
  observe(event: AliceEvent): void {
    if (event.type === "message.sent") {
      this.burst.record(event.scope, event.at);
      return;
    }
    if (event.type !== "act.done" && event.type !== "act.failed") return;
    if (event.type === "act.failed" && event.reason === "too_often") return;
    const act = event.act.kind;
    if (act === "join-chat" || act === "chat-search") {
      const kind = EXPLORATION_KIND[act];
      this.exploration[kind].record(kind, event.at);
    }
  }
}

/** 永不中止的信号（测试、一次性的调用）。 */
const NEVER = new AbortController().signal;

/**
 * 一个 Telegram 客户端和它的限额。signal：外壳停机时中止——还没开始的请求不再发（抛 signal.reason，
 * 外壳的 Failed interrupted），在途的发送交给 mtcute 中止（结果未知）。
 */
export class Telegram {
  constructor(
    readonly client: TelegramClient,
    private readonly gates: Gates,
    readonly signal: AbortSignal = NEVER,
    /** 她在群里见过谁、和谁有过私聊来往（Journal 的投影，first-dm.ts）：第一次私聊前要先拿到对方。 */
    private readonly people: Acquaintances = new Acquaintances(),
  ) {}

  /** 同一个客户端和限额，换一个中止信号（每个动作一份）。 */
  with(signal: AbortSignal): Telegram {
    return new Telegram(this.client, this.gates, signal, this.people);
  }

  /**
   * 每个 Telegram 请求都走这里：先过全局节流，Telegram 的明确拒绝改成带类型的失败（其余错误原样抛出，
   * 外壳记为结果未知）。name 和 details 只进错误信息。
   */
  async request<T>(
    name: string,
    details: Record<string, unknown>,
    fn: (client: TelegramClient) => Promise<T>,
  ): Promise<T> {
    this.signal.throwIfAborted();
    await this.gates.throttle.acquire();
    this.signal.throwIfAborted();
    try {
      return await fn(this.client);
    } catch (error) {
      rethrowTelegramActionFailure(error, name, details);
    }
  }

  /**
   * 会在 chatId 留下一条她的消息的请求：先过第二道闸，再走 request。fn 拿到的 peer 是发往哪里：通常就是 chatId；
   * 第一次私聊时是先经共同的群拿到的对方（first-dm.ts reachUser）。发往人的私聊被对方的设置挡住时，
   * 失败带上 dmClosed（这个人不收她的私聊）。
   */
  async post<T>(
    scope: string,
    chatId: number,
    name: string,
    details: Record<string, unknown>,
    fn: (client: TelegramClient, peer: InputPeerLike) => Promise<T>,
  ): Promise<T> {
    this.signal.throwIfAborted();
    if (!this.gates.burst.tryAcquire(scope)) {
      throw new TelegramActionError(
        "outgoing_burst_limited",
        "too many outgoing messages to this chat in the current window",
        { scope },
      );
    }
    const first = this.people.isFirstDm(chatId);
    return this.request(name, { scope, ...details }, async (client) => {
      const peer = first
        ? await reachUser(client, chatId, this.people.routes(chatId), this.signal)
        : chatId;
      try {
        return await fn(client, peer);
      } catch (error) {
        if (chatId > 0 && closesDm(error, first)) {
          rethrowTelegramActionFailure(error, name, { scope, ...details }, { dmClosed: true });
        }
        throw error;
      }
    });
  }

  /** 加群、找群之前：用掉一次额度，没有了就是 too_often。 */
  explore(kind: Exploration): void {
    if (!this.gates.exploration[kind].tryAcquire(kind)) {
      throw new TelegramActionError("too_often", `${kind} budget exhausted`);
    }
  }
}
