/**
 * QQ 的发送限额，以及把 OneBot 的明确拒绝翻译成 Failed。
 * 限额和 Telegram 的 gates.ts 是同一组：全局节流，加上每个会话的连发上限（上游之外的第二道防线）。
 * 全局节流比 Telegram 严：QQ 风控对机器人账号的发送频率更敏感。
 * QQGates 由平台构造，启动 fold 时经 observe 从 Journal 恢复连发计数。
 */
import type { AliceEvent } from "../mind/events.js";
import { Failed, type Failure } from "../mind/failure.js";
import { KeyedBurstLimiter, SlidingWindowLimiter } from "../utils/rate-limit.js";
import { type OneBotClient, OneBotError } from "./client.js";

const MIN = 60_000;
/** 所有会话合计每分钟的请求上限（Telegram 是 30）。手设的保守值。 */
const GLOBAL_PER_MIN = 20;
/** 同一会话 60 秒内最多发 6 条（和 Telegram 的安全上限相同）。 */
const BURST_PER_MIN = 6;

export class QQGates {
  readonly throttle: SlidingWindowLimiter;
  readonly burst: KeyedBurstLimiter;

  constructor(now: () => number = Date.now) {
    this.throttle = new SlidingWindowLimiter(GLOBAL_PER_MIN, MIN, now);
    this.burst = new KeyedBurstLimiter(BURST_PER_MIN, MIN, now);
  }

  /** 启动时从 Journal 恢复她在每个会话发过的消息数（运行中由 QQ.post 的 tryAcquire 计数，不能再 observe 一遍）。 */
  observe(event: AliceEvent): void {
    if (event.type === "message.sent") this.burst.record(event.scope, event.at);
  }
}

type Rule = [RegExp, Exclude<Failure["reason"], "errand">];

/**
 * 各家 OneBot 实现（NapCat、Lagrange、go-cqhttp）没有统一的错误码，只能匹配错误说明文字。按顺序匹配；
 * 都匹配不上的算结果未知（附上 retcode 和说明）。
 */
const RULES: readonly Rule[] = [
  [/消息不存在|找不到消息|message.*not.*(?:found|exist)/i, "message_gone"],
  [/频繁|风控|rate.?limit|too.?(?:fast|many|frequent)/i, "outgoing_burst_limited"],
  [/拉黑|黑名单|blocked|blacklist/i, "refused"],
  [/禁言|muted|shut.?up|\bbanned\b/i, "transport_soft_permanent"],
  [
    /不在.*群|不是群成员|群不存在|没有权限|权限不足|not.*(?:member|admin)|permission|group.*not.*found/i,
    "transport_soft_permanent",
  ],
];

/** 私聊发不过去：不是好友，或临时会话不让发。这是关于对方的事实（dmClosed）。 */
const DM_CLOSED =
  /非好友|不是.*好友|添加.*好友|加.*好友|临时会话|陌生人|not.*friend|\btemp(?:orary)?\s+session\b|\bresult=16\b/i;

/** 撤回被拒（超过两分钟或不能撤）：确定没撤回，和 Telegram 改不了消息用同一个码。只用于 delete_msg 的回复。 */
const RECALL_REFUSED = /撤回|超时|超过.*分钟|recall.*expired|cannot.*recall/i;

/** OneBot 的明确拒绝转成对应的 Failed；本来就是 Failed 的原样返回；其他错误表示结果未知，原样抛出。 */
function failureOf(error: unknown, action: string, privateChat: boolean): unknown {
  if (error instanceof Failed || !(error instanceof OneBotError)) return error;
  const rpc = `${error.retcode} ${error.wording}`.trim();
  // 1404：这个 OneBot 实现不支持这个动作。
  if (error.retcode === 1404)
    return new Failed({ reason: "unavailable", rpc }, `${action}: ${rpc}`);
  if (privateChat && DM_CLOSED.test(error.wording)) {
    return new Failed({ reason: "private_closed", rpc, dmClosed: true }, `${action}: ${rpc}`);
  }
  if (action === "delete_msg" && RECALL_REFUSED.test(error.wording)) {
    return new Failed({ reason: "edit_refused", rpc }, `${action}: ${rpc}`);
  }
  const rule = RULES.find(([pattern]) => pattern.test(error.wording));
  if (rule) return new Failed({ reason: rule[1], rpc }, `${action}: ${rpc}`);
  return new Failed({ reason: "outcome_unknown", rpc }, `${action}: ${rpc}`);
}

/** 永不触发的中止信号（用于一次性调用）。 */
const NEVER = new AbortController().signal;

/** 带限额的 OneBot 客户端。signal 在停机时触发，之后还没发出的请求不再发。 */
export class QQ {
  constructor(
    readonly client: Pick<OneBotClient, "call">,
    private readonly gates: QQGates,
    readonly signal: AbortSignal = NEVER,
  ) {}

  with(signal: AbortSignal): QQ {
    return new QQ(this.client, this.gates, signal);
  }

  /** 所有请求的入口：先过全局节流；OneBot 明确拒绝时转成 Failed。 */
  async request<T>(
    action: string,
    params: Record<string, unknown>,
    privateChat = false,
  ): Promise<T> {
    this.signal.throwIfAborted();
    await this.gates.throttle.acquire();
    try {
      return await this.client.call<T>(action, params, this.signal);
    } catch (error) {
      throw failureOf(error, action, privateChat);
    }
  }

  /** 会在 scope 里留下一条她的消息的请求：先过这个会话的连发上限。 */
  async post<T>(
    scope: string,
    action: string,
    params: Record<string, unknown>,
    privateChat: boolean,
  ): Promise<T> {
    this.signal.throwIfAborted();
    if (!this.gates.burst.tryAcquire(scope)) {
      throw new Failed(
        { reason: "outgoing_burst_limited" },
        "too many outgoing messages to this chat in the current window",
      );
    }
    return this.request<T>(action, params, privateChat);
  }
}
