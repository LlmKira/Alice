/**
 * 操作员暂停（capabilities X03）落在端口边界：暂停的意思是"不花钱、不对外做事"，而花钱和对外做事只发生在
 * 外壳的端口（模型调用、对外动作、后台的事、看图听语音）。所以只在这里拦一次：暂停时每个端口当即抛
 * Failed paused，外壳按普通失败写回（不重做，继续之后由她自己决定）；暂停那一刻还在办的后台的事收到
 * 中止信号，不再花钱。外壳自己只留一处判断：暂停时时钟不走（不然时钟格只会叫醒一串注定失败的调用）。
 */
import { Failed } from "../mind/failure.js";
import type { ShellPorts } from "../shell.js";

export interface Pause {
  readonly paused: boolean;
  /** 从运行变成暂停时调用。 */
  onPause: (listener: () => void) => void;
}

const pausedError = () => new Failed({ reason: "paused" }, "paused by the operator");

/** 暂停时不做：抛 Failed paused。 */
export function whenRunning<A extends unknown[], T>(
  pause: Pause,
  fn: (...args: A) => Promise<T>,
): (...args: A) => Promise<T> {
  return async (...args) => {
    if (pause.paused) throw pausedError();
    return fn(...args);
  };
}

export function gated(ports: ShellPorts, pause: Pause): ShellPorts {
  const running = new Set<AbortController>();
  pause.onPause(() => {
    for (const job of running) job.abort(pausedError());
  });
  return {
    ...ports,
    paused: () => pause.paused,
    callModel: whenRunning(pause, async (prompt, call, signal) =>
      ports.callModel(prompt, call, signal),
    ),
    act: whenRunning(pause, async (scope, act, signal) => ports.act(scope, act, signal)),
    ...(ports.perceiveTone
      ? { perceiveTone: whenRunning(pause, ports.perceiveTone.bind(ports)) }
      : {}),
    ...(ports.perceiveMood
      ? { perceiveMood: whenRunning(pause, ports.perceiveMood.bind(ports)) }
      : {}),
    // 后台的事办得久：暂停那一刻还在办的也中止（不再花钱），和外壳停机的中止合在一起。
    background: whenRunning(pause, async (scope, act, context, signal) => {
      const job = new AbortController();
      running.add(job);
      try {
        return await ports.background(scope, act, context, AbortSignal.any([signal, job.signal]));
      } finally {
        running.delete(job);
      }
    }),
    ...(ports.query
      ? {
          query: whenRunning(pause, async (scope, kind, act, prompt, signal) => {
            const queryPort = ports.query?.bind(ports);
            if (!queryPort) throw pausedError();
            const job = new AbortController();
            running.add(job);
            try {
              return await queryPort(
                scope,
                kind,
                act,
                prompt,
                AbortSignal.any([signal, job.signal]),
              );
            } finally {
              running.delete(job);
            }
          }),
        }
      : {}),
  };
}
