import {
  type ActEffect,
  type BackgroundDone,
  backgroundOutcome,
  deliver,
  ponderOutcome,
  speechOutcome,
} from "./interpret.js";
import type { JournaledEvent } from "./journal.js";
import { executeToolReply, type QueryKind } from "./llm/ptc.js";
import type { Perceived, ToneLine } from "./llm/tone.js";
import { type Act, affordanceOf } from "./mind/affordances.js";
import { type Effect, SELF_SCOPE } from "./mind/effects.js";
import type { AliceEvent, BackgroundUsage, FoundPlace } from "./mind/events.js";
import { Failed, type Failure } from "./mind/failure.js";
import { NOISE_EVERY_MS } from "./mind/noise.js";
import type { ActOutcome } from "./mind/outcome.js";
import {
  isRotating,
  type Mind,
  mechanismsIn,
  rotationEnded,
  switchesDue,
} from "./mind/rotation.js";
import { type AliceState, emptyState } from "./mind/state.js";
import { step, towardHer } from "./mind/step.js";
import { parseDecision } from "./speech/decision.js";
import { parseLifeDay, renderLifeDayPrompt } from "./speech/life-day.js";
import { renderSpeechPrompt, type SpeechPrompt } from "./speech/prompt.js";
import { parseReflect, renderReflectPrompt } from "./speech/reflect.js";

/**
 * 外壳：唯一做 I/O、读时钟的地方。事件先写进 Journal，再送进 step()；
 * step() 返回的副作用在这里执行，结果作为新事件送回来。
 */
export interface ShellPorts {
  now(): number;
  /** 写进 Journal。抛错时外壳停下（报给 fatal），因为没写进日志的事件不能送进 step()。 */
  append(event: JournaledEvent): void;
  /**
   * 一个写进了日志的事件 step 完之后（state 是 step 之后的）：日志的投影只从这里更新，启动折叠时
   * createFold 调同一个钩子，所以投影里不会有日志里没有的东西。不能抛错（抛了算 Journal 失败）。
   */
  journaled(event: AliceEvent, state: AliceState): void;
  /**
   * 发言和想一想都走这里（同一网关、同一模型，提示词里带各自的输出上限）；call 说明是哪个会话的哪次调用。
   * 下面三个端口都收外壳的 signal：停机时中止，还没开始的按 signal.reason（Failed interrupted）没做，
   * 在途的尽快结束（结果未知）。
   */
  callModel(prompt: SpeechPrompt, call: ModelCall, signal: AbortSignal): Promise<string>;
  /**
   * 在会话里执行一个对外动作（telegram/acts.ts）：发出的消息的 id、看了才知道的东西，或者只是做了。
   * 抛 Failed 表示确定没做成，其他错误表示结果未知。
   */
  act(scope: string, act: Act, signal: AbortSignal): Promise<ActOutcome>;
  /**
   * 后台办一件交出去的事（登记表 via: "errand"）：context 是她做这个决定时看到的提示词（执行代理在她的上下文上
   * 接着干，前缀相同也能用上提示缓存）。返回写给她看的结果和花费；没办成时抛 Failed（mind/failure.ts，
   * 带原因和已花的 usage），其他错误记为结果未知；没有这类事的执行者时抛 Failed unavailable。
   * signal 中止时（暂停、停机）尽快按 signal.reason 没办成。
   */
  background(
    scope: string,
    act: Act,
    context: SpeechPrompt | null,
    signal: AbortSignal,
  ): Promise<BackgroundDone>;
  /**
   * PTC 轮内查询（search_album / find_chats / look_up）：程序 await tools.x() 时当场跑，
   * 返回值直接回给同一段代码，结果同时记成 act.done（inline: true）进 Journal。
   */
  query?(
    scope: string,
    kind: QueryKind,
    act: Act,
    prompt: SpeechPrompt,
    signal: AbortSignal,
  ): Promise<{ value: unknown; result: string; found?: FoundPlace[]; usage?: BackgroundUsage }>;
  /**
   * 判口气（llm/tone.ts）：ids 这几条冲着她的消息对她的口气，lines 是给判别看的最近记录。
   * 答不出的那条不在结果里。不给就不判。
   */
  perceiveTone?(
    chatType: "private" | "group",
    lines: readonly ToneLine[],
    ids: readonly string[],
    signal: AbortSignal,
  ): Promise<Record<string, Perceived>>;
  /**
   * 她写下的心情（她自己的词）是好是坏、有多强（llm/tone.ts perceiveMood），效价 [−1, 1]；判不出是 null。
   * 不给就不判：心情只记下词，不折进她的心情。
   */
  perceiveMood?(
    mood: { word: string; why: string | null },
    signal: AbortSignal,
  ): Promise<number | null>;
  /** 可选：读取此刻手头可用贴纸的简短描述，让模型知道自己能发哪些贴纸（纯本地读取）。 */
  stickers?(): readonly string[];
  /** delayMs 之后调用 fire；返回取消函数。 */
  schedule(delayMs: number, fire: () => void): () => void;
  fatal(error: unknown): void;
  log(message: string, fields?: Record<string, unknown>): void;
  /**
   * 操作员暂停（src/ops/gate.ts）：为 true 时时钟不走。模型调用和对外动作由端口自己拒绝（Failed paused），
   * 外壳按普通失败写回；入站照常先写日志再 step。
   */
  paused(): boolean;
}

/** 一次模型调用是哪个会话的哪次、是发言还是想一想（花费分类、提示日志用）。 */
export interface ModelCall {
  scope: string;
  callId: string;
  kind: "speech" | "ponder";
}

export interface PendingTimer {
  scope: string;
  timerId: string;
  at: number;
}

/** 从日志折叠出的状态，加上进程停下时还没有结果的计时和发言调用。 */
export interface Folded {
  state: AliceState;
  timers: PendingTimer[];
  interrupted: Array<{ scope: string; callId: string }>;
}

/**
 * 按日志顺序重放 step()，丢弃副作用：发言调用和发送在上一次运行里已经执行过（或结果未知），
 * 永远不在启动时重发。只记下最后仍在等的计时器，交给 Shell.start 重新挂上。
 * journaled：日志的投影（相册、转发书架、限额、自检）在这里跟着折叠，和运行时同一个钩子（ShellPorts.journaled）。
 */
export function createFold(
  mind: Mind,
  journaled: (event: AliceEvent, state: AliceState) => void = () => {},
) {
  let state = emptyState;
  const timers = new Map<string, PendingTimer>();
  return {
    feed(event: AliceEvent): void {
      const result = step(state, event, mind);
      state = result.state;
      journaled(event, state);
      for (const effect of result.effects) {
        if (effect.type === "set-timer") timers.set(effect.scope, effect);
      }
    },
    result(): Folded {
      const pending: PendingTimer[] = [];
      const interrupted: Folded["interrupted"] = [];
      for (const chat of Object.values(state.chats)) {
        const timer = timers.get(chat.scope);
        if (chat.mind.mode === "waiting" && timer?.timerId === chat.mind.timerId) {
          pending.push({ scope: timer.scope, timerId: timer.timerId, at: timer.at });
        }
        if (chat.mind.mode === "deciding") {
          interrupted.push({ scope: chat.scope, callId: chat.mind.callId });
        }
      }
      return { state, timers: pending, interrupted };
    },
  };
}

/** 判口气时给 Jev 看的最近几行。 */
const TONE_LINES = 15;

export class Shell {
  private state: AliceState;
  private readonly queue: AliceEvent[] = [];
  private dispatching = false;
  private stopped = false;
  private readonly timers = new Map<string, () => void>();
  private cancelClock: (() => void) | null = null;
  private cancelNoise: (() => void) | null = null;
  /** 每个会话一条发送链，保证同一次决定里的几条按顺序发。 */
  private readonly outbox = new Map<string, Promise<void>>();
  /** 每个会话最近一次发言调用的提示词：交出去办的事带着它，执行代理在她的上下文上接着干。 */
  private readonly lastPrompt = new Map<string, SpeechPrompt>();
  /** 停机时中止所有在途的端口调用。 */
  private readonly abort = new AbortController();
  /** 外壳开始的每件在途的事（发言、想一想、后台的事、发送链）：停机时等它们都写完结果，才算停下。 */
  private readonly inflight = new Set<Promise<unknown>>();
  /** 每个会话里冲着她、还没判过口气的消息（有 perceiveTone 时）：下一次在那里叫醒她时一起判。 */
  private readonly unjudged = new Map<string, string[]>();

  constructor(
    private readonly ports: ShellPorts,
    /** 一套机制，或生产和候选两套轮换（mind/rotation.ts）：换组在每个时钟格之前算，写进日志再 step。 */
    private readonly mind: Mind,
    private readonly persona: string,
    private readonly folded: Folded,
    /** 时钟间隔：时间本身也是事件（意愿层的节律、冷却随沉默增长都靠它），和回放一样写进日志。 */
    private readonly clockMs = 10_000,
    /**
     * 她自己的随机性（mind/noise.ts）：每 NOISE_EVERY_MS 抽一组，作为 noise.drawn 写进日志。
     * 不给就不抽（测试）；index.ts 用启动时取的种子。
     */
    private readonly noise: (() => Record<string, number>) | null = null,
  ) {
    this.state = folded.state;
  }

  get current(): AliceState {
    return this.state;
  }

  /** 挂回上次没到点的计时器；上次停下时还在等的发言调用记为失败（失败不重试）。 */
  start(): void {
    for (const timer of this.folded.timers) this.arm(timer.scope, timer.timerId, timer.at);
    // 轮换关了而日志里还有分组：收回，北极星从这一刻起不再把这些单位算进哪一组。
    if (!isRotating(this.mind)) {
      for (const event of rotationEnded(this.state, this.ports.now())) this.dispatch(event);
    }
    const tick = () => {
      if (this.stopped) return;
      // 暂停时时钟不走：不然每一格都会叫醒一串注定被端口拒绝的调用。
      if (!this.ports.paused()) {
        const at = this.ports.now();
        // 轮换：该换组的单位先换（记进日志），这一格就按新的组走。
        if (isRotating(this.mind)) {
          for (const event of switchesDue(this.state, at, this.mind)) this.dispatch(event);
        }
        this.dispatch({ type: "clock.tick", at });
      }
      this.cancelClock = this.ports.schedule(this.clockMs, tick);
    };
    this.cancelClock = this.ports.schedule(this.clockMs, tick);
    const noise = this.noise;
    if (noise) {
      const draw = () => {
        if (this.stopped) return;
        this.dispatch({
          type: "noise.drawn",
          at: this.ports.now(),
          scope: SELF_SCOPE,
          draws: noise(),
        });
        this.cancelNoise = this.ports.schedule(NOISE_EVERY_MS, draw);
      };
      this.cancelNoise = this.ports.schedule(NOISE_EVERY_MS, draw);
    }
    // 上次停下时在途的想一想记为失败，否则它占着的位置永远不释放，她以后再也不会想。
    const pondering = this.folded.state.pondering;
    if (pondering !== null) {
      const { callId, ...target } = pondering;
      this.dispatch({
        type: "ponder.failed",
        at: this.ports.now(),
        scope: SELF_SCOPE,
        callId,
        ...target,
        reason: "interrupted",
      });
    }
    // 上次停下时还没办完的后台的事：结果不会回来了，记为失败，她会知道。
    for (const chat of Object.values(this.folded.state.chats)) {
      for (const job of chat.running ?? []) {
        this.dispatch({
          type: "act.failed",
          at: this.ports.now(),
          scope: chat.scope,
          act: job.act,
          reason: "interrupted",
        });
      }
    }
    for (const call of this.folded.interrupted) {
      this.dispatch({
        type: "speech.failed",
        at: this.ports.now(),
        scope: call.scope,
        callId: call.callId,
        reason: "interrupted",
      });
    }
  }

  /** 送进一个事件：先写日志（时钟除外），再 step()，再执行副作用。重入时排队，保证日志顺序就是 step 顺序。 */
  dispatch(event: AliceEvent): void {
    // 停下之后只记录已经在途的发送结果，不再接收新消息、计时或发言结果。
    const outcome =
      event.type === "message.sent" || event.type === "act.done" || event.type === "act.failed";
    if (this.stopped && !outcome) return;
    this.queue.push(event);
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      for (let next = this.queue.shift(); next; next = this.queue.shift()) {
        // 时钟格只在引起了动作时写日志（journal.ts JournaledEvent）；其余的只让时间往前走，
        // 它们结算的东西（反应窗口）按窗口终点计时，折叠时由下一个事件补上，结果相同。
        if (next.type !== "clock.tick") this.ports.append(next);
        // 冲着她的消息（回复她的也算，和心智同一个判断）等叫醒时判口气。
        const seen = towardHer(this.state, next);
        if (seen.type === "message.received" && seen.directed && this.ports.perceiveTone) {
          this.unjudged.set(seen.scope, [...(this.unjudged.get(seen.scope) ?? []), seen.messageId]);
        }
        const result = step(this.state, next, this.mind);
        const woken = next.type === "clock.tick" ? result.effects[0]?.scope : undefined;
        if (next.type === "clock.tick" && woken) this.ports.append({ ...next, scope: woken });
        this.state = result.state;
        if (next.type !== "clock.tick" || woken) this.ports.journaled(next, this.state);
        // 停下之后只记下在途的事的结果，不再开始新的。
        if (!this.stopped) this.perform(result.effects);
      }
    } catch (error) {
      this.queue.length = 0;
      this.ports.fatal(error);
    } finally {
      this.dispatching = false;
    }
  }

  /**
   * 停下：不再接收新事件、取消计时器，中止所有在途的端口调用，等它们的结果都写进 Journal 再返回
   * （之后 index 才关库）。还没开始的动作记为 interrupted，在途被中止的发送记为 outcome_unknown，
   * 后台的事记为 interrupted；在途的发言调用不写（下次启动按 interrupted 补记）。
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelClock?.();
    this.cancelNoise?.();
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
    this.abort.abort(new Failed({ reason: "interrupted" }, "shell stopped"));
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  /** 登记一件在途的事，结束时注销。 */
  private track(job: Promise<unknown>): void {
    this.inflight.add(job);
    void job.finally(() => this.inflight.delete(job));
  }

  private perform(effects: readonly Effect[]): void {
    const deliveries = new Map<string, ActEffect[]>();
    for (const effect of effects) {
      switch (effect.type) {
        case "call-speech":
          this.track(this.speak(effect));
          break;
        case "call-ponder":
          this.track(this.ponder(effect));
          break;
        case "set-timer":
          this.arm(effect.scope, effect.timerId, effect.at);
          break;
        case "glance":
          // 看一眼不调模型，也不会失败：当场记下（排在这一格之后、下一个事件之前）。
          this.dispatch({ type: "chat.glanced", at: this.ports.now(), scope: effect.scope });
          break;
        case "act": {
          // 交出去办的事在后台办，不排进发送队列（办几分钟也不耽误她在这里说话）。
          const { via } = affordanceOf(effect.act.kind);
          if (via === "errand") {
            this.runInBackground(effect);
            break;
          }
          // 她心里的事（打算、心情）不经 Telegram，也不会失败：此刻就记为已做，
          // 不排在发送后面（前面一条发送失败不影响她记得什么）。
          if (via === "mind") {
            if (effect.act.kind === "feel" && this.ports.perceiveMood) {
              this.track(this.feel(effect.scope, effect.act));
              break;
            }
            this.dispatch({
              type: "act.done",
              at: this.ports.now(),
              scope: effect.scope,
              act: effect.act,
            });
            break;
          }
          const batch = deliveries.get(effect.scope) ?? [];
          batch.push(effect);
          deliveries.set(effect.scope, batch);
          break;
        }
      }
    }
    for (const [scope, batch] of deliveries) {
      const previous = this.outbox.get(scope) ?? Promise.resolve();
      const next = previous.then(() => this.deliver(batch));
      this.outbox.set(scope, next);
      this.track(next);
      void next.finally(() => {
        if (this.outbox.get(scope) === next) this.outbox.delete(scope);
      });
    }
  }

  /** 心情的效价：判不出（或判失败）就不带，心情只记下词。 */
  private async valence(mood: { word: string; why: string | null }): Promise<number | null> {
    const perceive = this.ports.perceiveMood;
    if (!perceive) return null;
    try {
      return await perceive(mood, this.abort.signal);
    } catch (error) {
      this.ports.log("mood valence failed", { word: mood.word, error: String(error) });
      return null;
    }
  }

  /** 她记下的心情：先判出效价，再记为已做（判的那一会儿里别的事照常进行）。 */
  private async feel(scope: string, act: Extract<Act, { kind: "feel" }>): Promise<void> {
    const valence = await this.valence({ word: act.mood, why: act.why });
    this.dispatch({
      type: "act.done",
      at: this.ports.now(),
      scope,
      act,
      ...(valence === null ? {} : { valence }),
    });
  }

  private runInBackground({ scope, act }: ActEffect): void {
    this.dispatch({ type: "act.started", at: this.ports.now(), scope, act });
    const context = this.lastPrompt.get(scope) ?? null;
    const job = this.ports.background(scope, act, context, this.abort.signal);
    this.track(
      backgroundOutcome(scope, act, job, () => this.ports.now()).then((event) => {
        if (event.type === "act.failed") {
          this.ports.log("background failed", { scope, act: act.kind, reason: event.reason });
        }
        this.dispatch(event);
      }),
    );
  }

  /**
   * 叫醒她时，把这个会话里冲着她、还没判过的几条一起判口气（不等它：和发言调用并行），结果写成 message.perceived。
   * 判不成就算了（记一行日志），不重试。
   */
  private judgeTone(request: Extract<Effect, { type: "call-speech" }>["request"]): void {
    const perceive = this.ports.perceiveTone;
    const { scope } = request;
    const waiting = this.unjudged.get(scope);
    if (!perceive || !waiting?.length) return;
    this.unjudged.delete(scope);
    const lines: ToneLine[] = request.timeline.slice(-TONE_LINES).map((e) => ({
      id: e.messageId,
      who: e.sender?.name ?? "Alice",
      text: e.text ?? e.media ?? e.contentType,
    }));
    const ids = waiting.filter((id) => lines.some((l) => l.id === id));
    if (ids.length === 0) return;
    this.track(
      perceive(request.chatType, lines, ids, this.abort.signal).then(
        (perceived) => {
          for (const [messageId, p] of Object.entries(perceived)) {
            this.dispatch({
              type: "message.perceived",
              at: this.ports.now(),
              scope,
              messageId,
              ...p,
            });
          }
        },
        (error: unknown) => this.ports.log("tone failed", { scope, error: String(error) }),
      ),
    );
  }

  private async speak(effect: Extract<Effect, { type: "call-speech" }>): Promise<void> {
    const { scope, callId, request } = effect;
    this.judgeTone(request);
    const event = await speechOutcome(
      effect,
      async () => {
        const stickers = this.ports.stickers?.();
        const req = stickers?.length ? { ...request, stickers } : request;
        const prompt = renderSpeechPrompt(this.persona, req);
        this.lastPrompt.set(scope, prompt);
        const call = { scope, callId, kind: "speech" } as const;
        const raw = await this.ports.callModel(prompt, call, this.abort.signal);
        const queryPort = this.ports.query;
        const usesLocalQuery =
          (request.affordances.includes("recall") && raw.includes("recall")) ||
          (request.affordances.includes("dm-check") && raw.includes("check_dm"));
        if (!queryPort && !usesLocalQuery) return parseDecision(raw, request);
        const doneQueries: Array<{
          at: number;
          act: Act;
          result: string;
          found?: FoundPlace[];
          usage?: BackgroundUsage;
        }> = [];
        const failedQueries: Array<{
          act: Act;
          failure: Failure;
          usage?: BackgroundUsage;
          error: unknown;
        }> = [];
        let ptcQueries: ReadonlyArray<{
          act: Act;
          error?: string;
          uncaught?: true;
          actedAfter?: true;
        }> | null = null;
        try {
          const ptc = await executeToolReply(raw, request, {
            signal: this.abort.signal,
            timeoutMs: 90_000,
            onQuery: async (kind, _args, signal) => {
              const act = buildQueryAct(kind, _args);
              try {
                const chat = this.state.chats[scope];
                const now = this.ports.now();
                if (chat) {
                  for (const m of mechanismsIn(this.mind, this.state, scope)) {
                    const local = m.query?.(kind, _args, chat, now, this.state.mechanisms[m.name]);
                    if (local !== undefined) {
                      doneQueries.push({
                        at: now,
                        act,
                        result: JSON.stringify(local).slice(0, 600),
                      });
                      return local;
                    }
                  }
                }
                if (!queryPort)
                  throw new Failed({ reason: "unavailable" }, `no query port for ${kind}`);
                const res = await queryPort(scope, kind, act, prompt, signal);
                doneQueries.push({
                  at: this.ports.now(),
                  act,
                  result: res.result,
                  ...(res.found ? { found: res.found } : {}),
                  ...(res.usage ? { usage: res.usage } : {}),
                });
                return res.value;
              } catch (error) {
                const failure =
                  error instanceof Failed ? error.failure : { reason: "outcome_unknown" as const };
                const usage = error instanceof Failed ? error.usage : undefined;
                failedQueries.push({ act, failure, ...(usage ? { usage } : {}), error });
                throw error;
              }
            },
          });
          ptcQueries = ptc.queries;
          return ptc.decision;
        } finally {
          // 查询成功但之后没接着做出对外动作（比如只写 const res = await tools.look_up(...) 就结束了），
          // 省略 inline 让 step.ts 补唤醒一次，免得查到了东西却哑火。
          const doneRecords = (ptcQueries ?? []).filter((q) => q.error === undefined);
          for (const [i, d] of doneQueries.entries()) {
            const rec = doneRecords[i];
            const needsFollowUp =
              affordanceOf(d.act.kind).via === "errand" &&
              (ptcQueries === null || !rec?.actedAfter);
            this.dispatch({
              type: "act.done",
              at: d.at,
              scope,
              act: d.act,
              result: d.result,
              ...(d.found ? { found: d.found } : {}),
              ...(d.usage ? { usage: d.usage } : {}),
              ...(needsFollowUp ? {} : { inline: true as const }),
            });
          }
          // 只在查询失败没被 run_code 自己的 try/catch 接住时省略 inline，让 step.ts 记 wakeAgain: true，
          // 免得前面已经说出去一句“等我查一下”后对方干等下文；被程序自己接住处理过的照常标 inline: true。
          const records = (ptcQueries ?? []).filter((q) => q.error !== undefined);
          for (const [i, f] of failedQueries.entries()) {
            const uncaught = ptcQueries === null || records[i]?.uncaught === true;
            this.dispatch({
              type: "act.failed",
              at: this.ports.now(),
              scope,
              act: f.act,
              ...f.failure,
              ...(f.usage ? { usage: f.usage } : {}),
              ...(uncaught ? {} : { inline: true as const }),
            });
          }
        }
      },
      () => this.ports.now(),
    );
    this.ports.log(
      event.type === "speech.decided" ? "speech decided" : "speech failed",
      event.type === "speech.decided"
        ? { scope, callId, acts: event.decision.acts.map((a) => a.kind) }
        : { scope, callId, reason: event.reason, error: event.error },
    );
    this.dispatch(event);
  }

  private async ponder(effect: Extract<Effect, { type: "call-ponder" }>): Promise<void> {
    const { callId, request } = effect;
    const event = await ponderOutcome(
      effect,
      async () => {
        const call = {
          scope: request.scope,
          callId,
          kind: "ponder",
        } as const;
        if (request.kind === "life") {
          const prompt = renderLifeDayPrompt(this.persona, request);
          const raw = await this.ports.callModel(prompt, call, this.abort.signal);
          return parseLifeDay(raw, request);
        }
        const prompt = renderReflectPrompt(this.persona, request);
        const raw = await this.ports.callModel(prompt, call, this.abort.signal);
        const ponder = parseReflect(raw, request);
        if (!ponder.mood) return ponder;
        const valence = await this.valence(ponder.mood);
        return valence === null ? ponder : { ...ponder, mood: { ...ponder.mood, valence } };
      },
      () => this.ports.now(),
    );
    if (event.type === "ponder.done") {
      const { ponder } = event;
      this.ports.log(
        "ponder done",
        ponder.kind === "reflect"
          ? { callId, entries: ponder.entries.length }
          : { callId, kind: "life", date: ponder.date, moments: ponder.moments.length },
      );
      this.dispatch(event);
    } else this.ports.log("ponder failed", { callId, reason: event.reason, error: event.error });
  }

  /** 按顺序执行一次决定里的动作（interpret.ts deliver）。 */
  private deliver(batch: readonly ActEffect[]): Promise<void> {
    return deliver(batch, {
      now: () => this.ports.now(),
      emit: (event) => this.dispatch(event),
      act: (scope, act) => this.ports.act(scope, act, this.abort.signal),
      timeline: (scope) => this.state.chats[scope]?.timeline ?? [],
      log: (message, fields) => this.ports.log(message, fields),
    });
  }

  /** 每个会话只留最新的计时器：旧的即使触发，step() 也会因为 id 对不上而忽略。 */
  private arm(scope: string, timerId: string, at: number): void {
    this.timers.get(scope)?.();
    const cancel = this.ports.schedule(Math.max(0, at - this.ports.now()), () => {
      if (this.timers.get(scope) === cancel) this.timers.delete(scope);
      this.dispatch({ type: "timer.fired", at: this.ports.now(), scope, timerId });
    });
    this.timers.set(scope, cancel);
  }
}

function buildQueryAct(kind: QueryKind, args: Record<string, unknown>): Act {
  switch (kind) {
    case "album-search":
      return { kind, query: String(args.query ?? "") };
    case "chat-search":
      return { kind, query: String(args.query ?? "") };
    case "delegate":
      return { kind, task: String(args.task ?? "") };
    case "recall":
      return {
        kind,
        query: typeof args.query === "string" && args.query.trim() ? args.query.trim() : null,
        subject:
          typeof args.subject === "string" && args.subject.trim() ? args.subject.trim() : null,
      };
    case "dm-check":
      return {
        kind,
        who: typeof args.who === "string" && args.who.trim() ? args.who.trim() : null,
      };
  }
}
