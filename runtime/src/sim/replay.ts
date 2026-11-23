import { backgroundOutcome, deliver, ponderOutcome, speechOutcome } from "../interpret.js";
import { type Act, affordanceOf, postedMessage } from "../mind/affordances.js";
import type { Effect, PonderRequest, SpeechRequest } from "../mind/effects.js";
import type {
  AliceEvent,
  BackgroundUsage,
  FoundPlace,
  MessageSent,
  Ponder,
  SpeechDecision,
} from "../mind/events.js";
import { Failed, type Failure } from "../mind/failure.js";
import { isRotating, type Mind, switchesDue } from "../mind/rotation.js";
import { type AliceState, emptyState } from "../mind/state.js";
import { step } from "../mind/step.js";

/** 回放里代替真实发言模型：录制的结果、带缓存的真实调用或测试 stub。返回 null 表示调用失败。 */
export type SpeechOracle = (
  request: SpeechRequest,
  callId: string,
  /** 调用发生的时刻（触发它的事件时刻，可能是时钟格）；回放总会给出。 */
  at?: number,
) => SpeechDecision | null | Promise<SpeechDecision | null>;

/** 回放里代替想一想的调用：stub（零成本估算）或带缓存的真实调用。返回 null 表示调用失败。 */
export type PonderOracle = (
  request: PonderRequest,
  callId: string,
) => Ponder | null | Promise<Ponder | null>;

/**
 * 回放里代替后台的事（查一下）：request 是做出这个决定的那次发言调用看到的内容。返回结果或没办成的原因，
 * 以及办了多久（结果在 at + ms 时回到会话）。
 */
export type BackgroundResult = ({ result: string } | { failure: Failure }) & {
  usage?: BackgroundUsage;
  ms: number;
};

export type BackgroundOracle = (
  scope: string,
  act: Act,
  request: SpeechRequest | null,
  at: number,
) => Promise<BackgroundResult>;

const UNAVAILABLE: BackgroundResult = { failure: { reason: "unavailable" }, ms: 0 };

/** stub 返回 null 是这次调用失败。 */
async function oracleResult<T>(value: T | null): Promise<T> {
  if (value === null) throw new Error("oracle returned null");
  return value;
}

interface PendingTimer {
  at: number;
  scope: string;
  timerId: string;
}

/** 到 at 为止下一个该触发的回应、计时器或时钟；都没到是 null。和计时器同一时刻的回应排在计时器后面，时钟排最后。 */
function nextDue(
  arrival: AliceEvent | undefined,
  timer: PendingTimer | undefined,
  tick: number | null,
  at: number,
  tickMs: number,
):
  | { kind: "arrival"; event: AliceEvent }
  | { kind: "timer"; timer: PendingTimer }
  | { kind: "tick"; at: number }
  | null {
  if (
    arrival &&
    arrival.at <= at &&
    (!timer || arrival.at < timer.at) &&
    (tick === null || arrival.at <= tick)
  )
    return { kind: "arrival", event: arrival };
  if (timer && timer.at <= at && (tick === null || timer.at <= tick))
    return { kind: "timer", timer };
  if (tick !== null && tickMs > 0) return { kind: "tick", at: tick };
  return null;
}

export interface ReplayRecord {
  at: number;
  effect: Effect;
}

export interface ReplayResult {
  state: AliceState;
  effects: ReplayRecord[];
}

/**
 * 按顺序把事件送进 step()，并就地兑现副作用：发言调用交给 oracle，发送视为立即送达，
 * 计时器在下一个更晚的世界事件之前按时间顺序触发。
 * 限制：发言和发送都按零延迟处理，所以"她思考期间又来了消息"只在原始日志本身包含时出现。
 */
export async function replay(
  events: readonly AliceEvent[],
  options: {
    /** 一套机制，或两套轮换（mind/rotation.ts）：换组和外壳一样，在每个时钟格之前算、先送进去。 */
    mechanisms: Mind;
    speech: SpeechOracle;
    /** 机制请求想一想（她自己）时用；不设时一律记为失败。 */
    ponder?: PonderOracle;
    /** 后台的事（查一下）；不设时当场记为没办成（unavailable），和外壳没有执行者时一样。 */
    background?: BackgroundOracle;
    /** 每隔这么多毫秒注入一次 clock.tick（对齐到整倍数，只在第一条和最后一条事件之间）。不设则不注入。 */
    tickMs?: number;
    /** 每个事件处理完之后的回调（看状态轨迹用，比如压力场忠实度对照）。 */
    observe?: (event: AliceEvent, state: AliceState) => void;
    /** 看了才知道的动作的 stub（场景里写好的找群结果）；不设时这类动作记为做完、没有结果。 */
    look?: (scope: string, act: Act, at: number) => { result: string; found?: FoundPlace[] } | null;
    /**
     * 回应 stub（只作诊断）：她的一条消息送达后，世界会回她哪些话（比如有人引用回复她）。返回的事件按各自的时刻
     * 插进之后的事件流（和后台的结果同一个队列）；时刻不能早于她那条消息。
     */
    respond?: (sent: MessageSent, state: AliceState) => readonly AliceEvent[];
    /** 她写下的心情的效价（外壳的 perceiveMood）；不设时心情只记下词，不 fold 进她的心情（和外壳没有判别时一样）。 */
    valence?: (mood: { word: string; why: string | null }) => Promise<number | null>;
  },
): Promise<ReplayResult> {
  let state = emptyState;
  const log: ReplayRecord[] = [];
  let sent = 0;
  const timers: PendingTimer[] = [];
  /** 后台的事的结果、回应 stub 的回复：到点时送回（和计时器一起按时间排）。 */
  const arrivals: AliceEvent[] = [];
  /** 每个会话最近一次发言调用看到的内容（后台的事带着它办）。 */
  const lastRequest = new Map<string, SpeechRequest>();
  const tickMs = options.tickMs ?? 0;
  const perceived = async (mood: { word: string; why: string | null }) =>
    options.valence ? options.valence(mood) : null;
  let nextTick =
    tickMs > 0 && events.length > 0
      ? Math.ceil((events[0] as AliceEvent).at / tickMs) * tickMs
      : null;

  /** 按时间顺序触发 at 之前到点的回应、计时器和时钟（同一时刻计时器先于回应，回应先于时钟）。 */
  const advanceTo = async (at: number): Promise<void> => {
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      arrivals.sort((a, b) => a.at - b.at);
      const timer = timers[0];
      const arrival = arrivals[0];
      const tick = nextTick !== null && nextTick <= at ? nextTick : null;
      const due = nextDue(arrival, timer, tick, at, tickMs);
      if (due === null) return;
      if (due.kind === "arrival") {
        arrivals.shift();
        await feed(due.event);
      } else if (due.kind === "timer") {
        timers.shift();
        await feed({
          type: "timer.fired",
          at: due.timer.at,
          scope: due.timer.scope,
          timerId: due.timer.timerId,
        });
      } else {
        nextTick = due.at + tickMs;
        await clockTick(due.at);
      }
    }
  };

  /** 一个时钟格：轮换时先送进到点的换组，再送时钟。 */
  const clockTick = async (at: number): Promise<void> => {
    const mind = options.mechanisms;
    if (isRotating(mind)) for (const s of switchesDue(state, at, mind)) await feed(s);
    await feed({ type: "clock.tick", at });
  };

  const feed = async (event: AliceEvent): Promise<void> => {
    const result = step(state, event, options.mechanisms);
    state = result.state;
    options.observe?.(event, state);
    for (const effect of result.effects) {
      log.push({ at: event.at, effect });
      await perform(effect, event);
    }
  };

  /** 反思写下的心情：有判别时问一下效价，fold 进心情。 */
  const withValence = async (ponder: Ponder | null): Promise<Ponder | null> => {
    if (ponder?.kind !== "reflect" || !ponder.mood) return ponder;
    const valence = await perceived(ponder.mood);
    return valence === null ? ponder : { ...ponder, mood: { ...ponder.mood, valence } };
  };

  /** 兑现一个副作用。零延迟：副作用的结果都在引起它的事件那一刻回来（后台的事除外，见下）。 */
  const perform = async (effect: Effect, event: AliceEvent): Promise<void> => {
    const now = () => event.at;
    if (effect.type === "set-timer") {
      timers.push({ at: effect.at, scope: effect.scope, timerId: effect.timerId });
    } else if (effect.type === "call-speech") {
      lastRequest.set(effect.scope, effect.request);
      // stub 在 speechOutcome 外面调：stub 自己抛的错（熔断）要停下回放，不能记成一次失败的调用。
      const decision = await options.speech(effect.request, effect.callId, event.at);
      await feed(await speechOutcome(effect, () => oracleResult(decision), now));
    } else if (effect.type === "call-ponder") {
      const valued = await withValence(
        (await options.ponder?.(effect.request, effect.callId)) ?? null,
      );
      await feed(await ponderOutcome(effect, () => oracleResult(valued), now));
    } else if (affordanceOf(effect.act.kind).via === "errand") {
      await runErrand(effect.scope, effect.act, event.at);
    } else {
      await deliver([effect], {
        now,
        emit: async (e) => {
          if (e.type === "act.done" && e.act.kind === "feel") {
            const valence = await perceived({ word: e.act.mood, why: e.act.why });
            await feed(valence === null ? e : { ...e, valence });
            return;
          }
          await feed(e);
          if (e.type !== "message.sent") return;
          for (const r of options.respond?.(e, state) ?? []) {
            if (r.at >= e.at) arrivals.push(r);
          }
        },
        act: async (scope, act) => {
          // 发送视为立即送达；看了才知道的动作（找群、翻相册）有 stub 时按 stub 给的结果写回。
          if (postedMessage(act)) return { kind: "posted", messageId: `sim:${++sent}` };
          const seen =
            affordanceOf(act.kind).after?.type === "look"
              ? (options.look?.(scope, act, event.at) ?? null)
              : null;
          return seen
            ? { kind: "looked", text: seen.result, found: seen.found ?? [] }
            : { kind: "done" };
        },
        timeline: (scope) => state.chats[scope]?.timeline ?? [],
      });
    }
  };

  /** 查一下：当场记下开始办，结果在办完的时刻回到会话。 */
  const runErrand = async (scope: string, act: Act, at: number): Promise<void> => {
    await feed({ type: "act.started", at, scope, act });
    // 和外壳一样：没有执行者就是没办成（unavailable），不是悄悄办成了。
    const r = options.background
      ? await options.background(scope, act, lastRequest.get(scope) ?? null, at)
      : UNAVAILABLE;
    const job =
      "result" in r
        ? Promise.resolve(r)
        : Promise.reject(new Failed(r.failure, r.failure.reason, r.usage));
    arrivals.push(await backgroundOutcome(scope, act, job, () => at + r.ms));
  };

  for (const event of events) {
    await advanceTo(event.at);
    await feed(event);
  }
  // 最后一条事件之后不再走时钟，只把剩下的计时器放完。
  nextTick = null;
  await advanceTo(Number.POSITIVE_INFINITY);
  return { state, effects: log };
}
