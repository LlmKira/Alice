/**
 * 她自己的作息：Borbély 双过程模型（Borbély 1982；Daan, Beersma & Borbély 1984，参数取原文）。
 * 睡眠压力 S 醒着时向 1 上升（τ_r = 18.2 小时）、睡着时向 0 下降（τ_d = 4.2 小时）；
 * 昼夜节律 C 让上下阈值 H、L 一起起伏（H0 = 0.67、L0 = 0.17、振幅 0.12）。S 碰到 H 入睡、降到 L 醒来。
 * 这个系统被 24 小时的 C 带动后收敛到每天相同的周期，所以作息只是本地钟点的函数：模块加载时
 * 从任意初值迭代几天取最后一天，之后查表。被吵醒不改变 S（真实里会多攒一点压力，这里忽略）。
 *
 * 唯一手设的是时型（C 的相位）：睡眠中点取本地 5:30——2 月 B 群里发言 ≥ 200 条的 25 个真人，
 * 一天里最安静的 6 小时的中点众数是 5 点（eval-artifacts/sleep/prereg.md）。
 */
import type { Contribution } from "../../mind/mechanism.js";
import { localDay, localMinute, msIntoDay } from "../../mind/when.js";
import { feature, type PressureFeature } from "./feature.js";
import { SLEEP_COST } from "./params.js";

const MIN = 60_000;

export const SLEEP_MODEL = {
  riseHours: 18.2,
  fallHours: 4.2,
  upper: 0.67,
  lower: 0.17,
  amplitude: 0.12,
  /** C 的峰值时刻（本地小时）：使睡眠中点落在 5:30 附近（见 test/sleep.test.ts）。 */
  peakHour: 18.1,
} as const;

const c = (minute: number): number =>
  Math.cos((2 * Math.PI * (minute / 60 - SLEEP_MODEL.peakHour)) / 24);

/**
 * 一天里每一分钟：睡着没有、睡得多深（0 = 马上要醒，1 = 刚睡着）；醒着时离入睡还有多远
 * （alert：(H − S)/(H − L)，刚醒为 1、快睡着为 0；双过程模型里警觉度就是 S 与 C 之差，Åkerstedt & Folkard 1997）。
 */
const DAY_TABLE: ReadonlyArray<{ asleep: boolean; depth: number; alert: number }> = (() => {
  let s = 0.5;
  let asleep = false;
  let table: Array<{ asleep: boolean; depth: number; alert: number }> = [];
  for (let day = 0; day < 8; day++) {
    table = [];
    for (let m = 0; m < 24 * 60; m++) {
      const hi = SLEEP_MODEL.upper + SLEEP_MODEL.amplitude * c(m);
      const lo = SLEEP_MODEL.lower + SLEEP_MODEL.amplitude * c(m);
      if (!asleep && s >= hi) asleep = true;
      else if (asleep && s <= lo) asleep = false;
      const toSleep = Math.min(1, Math.max(0, (hi - s) / (hi - lo)));
      table.push({
        asleep,
        depth: asleep ? Math.min(1, Math.max(0, (s - lo) / (hi - lo))) : 0,
        alert: asleep ? 0 : toSleep,
      });
      s = asleep
        ? s * Math.exp(-1 / (60 * SLEEP_MODEL.fallHours))
        : 1 - (1 - s) * Math.exp(-1 / (60 * SLEEP_MODEL.riseHours));
    }
  }
  return table;
})();

/** 此刻睡得多深：醒着为 0。 */
export function sleepDepth(t: number): number {
  return DAY_TABLE[localMinute(t)]?.depth ?? 0;
}

/** 醒着时离入睡还有多远：刚醒为 1，快睡着为 0；睡着为 0（精力的底色，life.ts）。 */
export function alertness(t: number): number {
  return DAY_TABLE[localMinute(t)]?.alert ?? 0;
}

export function isAsleep(t: number): boolean {
  return DAY_TABLE[localMinute(t)]?.asleep ?? false;
}

const AWAKE_PREFIX: readonly number[] = (() => {
  const prefix = [0];
  for (const row of DAY_TABLE) prefix.push((prefix.at(-1) as number) + (row.asleep ? 0 : 1));
  return prefix;
})();
const AWAKE_PER_DAY = (AWAKE_PREFIX.at(-1) as number) * MIN;

/** 从 t 所在那天 0 点到 t，她醒着的毫秒数。 */
function awakeSinceMidnight(t: number): number {
  const local = msIntoDay(t);
  const m = Math.floor(local / MIN);
  const whole = (AWAKE_PREFIX[m] as number) * MIN;
  return whole + (DAY_TABLE[m]?.asleep ? 0 : local - m * MIN);
}

/**
 * from 到 to 之间她醒着的时长：她没看到的事（没读的消息、等她回的话）只在她醒着时变旧——
 * 夜里来的私聊早上醒来照样要回。
 */
export function awakeBetween(from: number, to: number): number {
  if (to <= from) return 0;
  const days = localDay(to) - localDay(from);
  return days * AWAKE_PER_DAY + awakeSinceMidnight(to) - awakeSinceMidnight(from);
}

/** 一天的作息：入睡、醒来的本地钟点（分钟）。 */
function sleepWindow(): { onset: number; wake: number } {
  let onset = -1;
  let wake = -1;
  for (let m = 0; m < DAY_TABLE.length; m++) {
    const prev = DAY_TABLE[(m + DAY_TABLE.length - 1) % DAY_TABLE.length]?.asleep;
    const now = DAY_TABLE[m]?.asleep;
    if (now && !prev) onset = m;
    if (!now && prev) wake = m;
  }
  return { onset, wake };
}

/** 入睡、醒来的本地钟点（分钟），模块加载时算一次。 */
export const SLEEP_WINDOW = sleepWindow();

/** 醒来这么久之内算"刚睡醒"。 */
const JUST_WOKE = 30 * 60_000;

/** 此刻睡着（asleep）时被叫起来的那句；醒着时，醒来不久是"刚睡醒"。候选 bedtime 按她自己去睡了也算睡着。 */
export function sleepFacts(asleep: boolean, now: number, sought: boolean): Contribution[] {
  const fact = (text: string): Contribution[] => [{ mechanism: "pressure", kind: "state", text }];
  if (asleep) return fact(sought ? "我本来在睡觉，被消息吵醒了。" : "我刚睡醒。");
  return isAsleep(now - JUST_WOKE) ? fact("我刚睡醒。") : [];
}

/**
 * 她自己的作息：睡着时行动有代价（SLEEP_COST × 睡眠深度，对所有动作收），没看到的事只在她醒着时变旧；
 * 提示词里写有人找她时被吵醒，快醒时自己醒了、或醒来不久是"刚睡醒"
 * （不会同时出现"被消息吵醒"和"这会儿没人找你"）。
 */
export const sleep: PressureFeature = feature({
  name: "sleep",
  requires: [],
  outside: true,
  asleep: (_world, now) => isAsleep(now),
  contribute: ({ now, sought }) => sleepFacts(isAsleep(now), now, sought),
  will: {
    age: awakeBetween,
    cost: (_world, _chat, _affordance, now) => SLEEP_COST * sleepDepth(now),
  },
});
