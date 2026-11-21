/**
 * 世界在线份额 A(h)：此刻（钟点 h）她认识的人里有多大份额醒着、在活跃。环境条件，从别人的消息折叠出来，
 * 与她自己的作息无关。只乘到主动开口的期望缓解上（此刻找人有多大机会被接住）。
 * 规格与证据：eval-artifacts/outreach-reception/availability-spec.md（2 月：只看钟点的 g(h) 预测主动开口后
 * 10 分钟内得到回应 AUC 0.647；按人细分没有增量）。这是作为基线看出来的，还没用新数据确认。
 *
 * 口径与参考实现一致：本地时间东八区；单人活跃度 = 在 h−1、h、h+1 里有过发言的日数（一天只计一次）；
 * g(h) = 所有说过话的人的活跃度 / 已观测日数，取平均；向先验曲线收缩（k = 2 天）；A = g / max g。
 */
import { localDay, localHour } from "../../mind/when.js";
import { feature, type PressureFeature } from "./feature.js";

const H = 3_600_000;
const DAY = 24 * H;
/** 保留每个人最近这么多天的小时掩码（状态有界）。 */
export const ACTIVITY_DAYS = 60;
const SHRINK_DAYS = 2;
/** 上线后的日权重半衰期（与 closeness 一致；离线 6 天里与等权等价）。 */
export const AVAILABILITY_HALF_LIFE_DAYS = 14;

/** 2 月 A+B 全量的 g(h)，本地 0–23 点（availability-fixture.json 的 g_full）：冷启动的先验。 */
export const PRIOR_G = [
  0.117889, 0.100822, 0.083123, 0.064791, 0.048989, 0.038559, 0.029393, 0.036662, 0.059102,
  0.081226, 0.091024, 0.097977, 0.104614, 0.108091, 0.109987, 0.107143, 0.120417, 0.128003,
  0.132743, 0.124526, 0.117257, 0.109987, 0.107143, 0.118205,
];

/** 一个人：最近 ACTIVITY_DAYS 天里，每天在哪几个小时说过话（24 位掩码），按日期升序。 */
export interface Activity {
  days: readonly number[];
  masks: readonly number[];
}

export function noteActivity(a: Activity | undefined, at: number): Activity {
  const day = localDay(at);
  const bit = 1 << localHour(at);
  if (!a || a.days.length === 0) return { days: [day], masks: [bit] };
  const last = a.days.length - 1;
  if (a.days[last] === day) {
    if (((a.masks[last] as number) & bit) !== 0) return a;
    const masks = [...a.masks];
    masks[last] = (masks[last] as number) | bit;
    return { days: a.days, masks };
  }
  const days = [...a.days, day];
  const masks = [...a.masks, bit];
  const drop = Math.max(0, days.length - ACTIVITY_DAYS);
  return { days: days.slice(drop), masks: masks.slice(drop) };
}

const nearMask = (h: number): number => (1 << ((h + 23) % 24)) | (1 << h) | (1 << ((h + 1) % 24));

/**
 * g(h)：在时刻 now 查询。halfLife 为 null 时每天等权（离线检验与忠实度核对的口径），否则按日指数衰减。
 * firstAt 是世界开始观测的时刻；不到一天时返回 null（用先验）。
 */
export function worldG(
  activity: Readonly<Record<string, Activity>>,
  firstAt: number,
  now: number,
  h: number,
  halfLife: number | null = AVAILABILITY_HALF_LIFE_DAYS,
): { g: number; observed: number } | null {
  if (firstAt <= 0 || now - firstAt < DAY) return null;
  const today = localDay(now);
  const start = localDay(firstAt);
  const w = (day: number) => (halfLife === null ? 1 : 2 ** (-(today - day) / halfLife));
  let observed = 0;
  for (let d = Math.max(start, today - ACTIVITY_DAYS + 1); d <= today; d++) observed += w(d);
  const mask = nearMask(h);
  let sum = 0;
  let people = 0;
  for (const a of Object.values(activity)) {
    if (a.days.length === 0) continue;
    people++;
    let active = 0;
    for (let i = 0; i < a.days.length; i++) {
      if (((a.masks[i] as number) & mask) !== 0) active += w(a.days[i] as number);
    }
    sum += active / observed;
  }
  return people > 0 ? { g: sum / people, observed } : null;
}

/** A(h) ∈ (0, 1]：g*(h) = (D·g + k·先验)/(D + k)（D = 已观测日数），再按全天最大值归一化。 */
export function availability(
  activity: Readonly<Record<string, Activity>>,
  firstAt: number,
  now: number,
  halfLife: number | null = AVAILABILITY_HALF_LIFE_DAYS,
): number {
  const curve = PRIOR_G.map((prior, h) => {
    const r = worldG(activity, firstAt, now, h, halfLife);
    return r === null
      ? prior
      : (r.observed * r.g + SHRINK_DAYS * prior) / (r.observed + SHRINK_DAYS);
  });
  const max = Math.max(...curve);
  return max > 0 ? (curve[localHour(now)] as number) / max : 1;
}

/**
 * 世界在线份额（候选 awake）：每个说话的人在哪些钟点出现过折进 world.activity；主动开口（没人找她）时，
 * 期望缓解乘上 A(此刻钟点)。被点名、被找时不受影响。
 */
export const awake: PressureFeature = feature({
  name: "awake",
  provides: ["activity"],
  requires: ["firstAt"],
  reduce: (_before, w, event) =>
    event.type === "message.received"
      ? {
          ...w,
          activity: {
            ...w.activity,
            [event.senderId]: noteActivity(w.activity[event.senderId], event.at),
          },
        }
      : w,
  will: {
    gain: (world, reading, now) =>
      reading.solicited ? 1 : availability(world.activity, world.firstAt, now),
  },
});
