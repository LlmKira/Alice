/**
 * 副作用怎么兑现成事件：外壳（src/shell.ts，真的模型和 Telegram）和回放（src/sim/replay.ts，即时完成的桩）
 * 共用这一份。两边只是端口不同、排期不同（外壳并发、按真实时钟；回放按顺序、按事件时刻），
 * "做成了写什么、没做成写什么、一批里前一个失败后面怎么办、后台的事怎么回来"只在这里。
 */
import type { Act } from "./mind/affordances.js";
import { type Effect, ponderTarget } from "./mind/effects.js";
import type {
  ActDone,
  ActFailed,
  AliceEvent,
  BackgroundUsage,
  Ponder,
  PonderDone,
  PonderFailed,
  SpeechDecided,
  SpeechDecision,
  SpeechFailed,
} from "./mind/events.js";
import { type CallFailure, FAILURES, Failed, type Failure } from "./mind/failure.js";
import { type ActOutcome, outcomeEvent } from "./mind/outcome.js";
import type { TimelineEntry } from "./mind/state.js";

export type ActEffect = Extract<Effect, { type: "act" }>;
type SpeechEffect = Extract<Effect, { type: "call-speech" }>;
type PonderEffect = Extract<Effect, { type: "call-ponder" }>;

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 动作没做成的原因：带类型的失败原样记，其余一律当作结果未知。都不重做。 */
export function failureOf(error: unknown): Failure {
  return error instanceof Failed ? error.failure : { reason: "outcome_unknown" };
}

/** 发言、想一想的调用没成的原因：端口拒绝的（暂停、停机）按它的码，其余是模型那边出了错。 */
function callFailureOf(error: unknown): CallFailure {
  const reason = error instanceof Failed ? error.failure.reason : null;
  return reason === "paused" || reason === "interrupted" ? reason : "model";
}

/** 一次发言调用的结果：decide 给出决定，抛错就是没成（不重试）。 */
export async function speechOutcome(
  { scope, callId }: SpeechEffect,
  decide: () => Promise<SpeechDecision>,
  now: () => number,
): Promise<SpeechDecided | SpeechFailed> {
  try {
    const decision = await decide();
    return { type: "speech.decided", at: now(), scope, callId, decision };
  } catch (error) {
    const failed = { reason: callFailureOf(error), error: describe(error) };
    return { type: "speech.failed", at: now(), scope, callId, ...failed };
  }
}

/** 一次想一想的结果：没成时靠 ponderTarget 只放下那一件。 */
export async function ponderOutcome(
  { scope, callId, request }: PonderEffect,
  think: () => Promise<Ponder>,
  now: () => number,
): Promise<PonderDone | PonderFailed> {
  try {
    const ponder = await think();
    return { type: "ponder.done", at: now(), scope, callId, ponder };
  } catch (error) {
    const failed = { reason: callFailureOf(error), error: describe(error) };
    return { type: "ponder.failed", at: now(), scope, callId, ...ponderTarget(request), ...failed };
  }
}

export interface DeliveryPorts {
  now(): number;
  /** 写回一个事件（外壳：先写日志再 step；回放：直接 step）。 */
  emit(event: AliceEvent): void | Promise<void>;
  /** 执行一个对外动作；抛 Failed 是确定没做成，其他错误是结果未知。 */
  act(scope: string, act: Act): Promise<ActOutcome>;
  /** 这个会话此刻的时间线（复读要找原话）。 */
  timeline(scope: string): readonly TimelineEntry[];
  log?(message: string, fields: Record<string, unknown>): void;
}

const failed = (scope: string, act: Act, failure: Failure, at: number): ActFailed => ({
  type: "act.failed",
  at,
  scope,
  act,
  ...failure,
});

/**
 * 按顺序执行一次决定里的对外动作。一个失败了：这个会话此刻发不出去（FAILURES 的 stops）时，这批剩下的记为
 * skipped_after_failure；只关于那一个动作的失败（表情不能用）不连累后面的。都不重做。
 */
export async function deliver(batch: readonly ActEffect[], ports: DeliveryPorts): Promise<void> {
  for (const [index, { scope, act }] of batch.entries()) {
    let event: AliceEvent;
    try {
      const outcome = await ports.act(scope, act);
      const find = (id: string) => ports.timeline(scope).find((t) => t.messageId === id);
      event = outcomeEvent(scope, act, outcome, ports.now(), find);
    } catch (error) {
      const failure = failureOf(error);
      ports.log?.("act failed", { scope, act: act.kind, ...failure, error: describe(error) });
      await ports.emit(failed(scope, act, failure, ports.now()));
      if (!FAILURES[failure.reason].stops) continue;
      for (const skipped of batch.slice(index + 1)) {
        const reason = { reason: "skipped_after_failure" } as const;
        await ports.emit(failed(skipped.scope, skipped.act, reason, ports.now()));
      }
      return;
    }
    await ports.emit(event);
  }
}

/** 后台办完的事：结果，或者 Failed（带原因和已经花掉的 usage）。 */
export interface BackgroundDone {
  result: string;
  usage?: BackgroundUsage;
}

/** 一件后台的事回来时写什么（act.started 由调用方当场写）；at 是回来的时刻。 */
export async function backgroundOutcome(
  scope: string,
  act: Act,
  job: Promise<BackgroundDone>,
  at: () => number,
): Promise<ActDone | ActFailed> {
  try {
    const { result, usage } = await job;
    return { type: "act.done", at: at(), scope, act, result, ...(usage ? { usage } : {}) };
  } catch (error) {
    const usage = error instanceof Failed ? error.usage : undefined;
    return { ...failed(scope, act, failureOf(error), at()), ...(usage ? { usage } : {}) };
  }
}
