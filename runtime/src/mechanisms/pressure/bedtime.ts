/**
 * bedtime（生产）：把"她说了去睡"并进"她在睡觉"（eval-artifacts/bedtime/prereg.md）。
 *
 * 缺陷：作息（sleep.ts）是固定的一天，说"我去睡了"不改变任何状态——下一条消息把她当作什么都没发生过一样叫起来，
 * 她再道一次晚安（live 一夜 30 分钟里对同一个人五次）。
 *
 * go_to_bed（affordances.ts 的 bed）只记下上床的时刻。从那一刻到作息的下一次醒来都算睡着：作息还没开始睡的那一段，
 * 深度按刚睡着（1）算，之后接作息的深度；代价照旧 SLEEP_COST × 深度，被叫起来时的说法照旧是作息那几句。
 * 成熟形态是 IM 的"勿扰到某个时刻"（Slack 的 pause notifications until …、XMPP 的 dnd）：本人设、一设就生效、
 * 到点自己结束；消息照常收得到，私聊的人仍可以叫醒她——这里就是唤醒代价，不是闸门。
 *
 * PLAN #39：夜里的门（NIGHT）是为"一夜的觉"定的。白天说"去歇一会儿"同样是真的（短睡、午睡），
 * createBedtime({ anytime: true }) 是这条候选：任何时候都给 go_to_bed，白天的觉按短睡（NAP）自己结束，
 * 夜里仍睡到作息的醒来。生产的 bedtime 调用它时不传参，行为不变。
 */
import type { ActKind } from "../../mind/affordances.js";
import { msIntoDay } from "../../mind/when.js";
import { feature, type PressureFeature, type View } from "./feature.js";
import { SLEEP_COST } from "./params.js";
import { awakeBetween, isAsleep, SLEEP_WINDOW, sleepDepth, sleepFacts } from "./sleep.js";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** go_to_bed 只在离作息的下一次醒来不到这么久时给：一夜的觉最长按 12 小时算，下午说去睡不会睡到第二天早上。 */
export const NIGHT = 12 * 60 * MIN;
/** anytime：白天那一次躺下最多睡这么久（短睡/歇一会儿）；夜里仍睡到作息的下一次醒来。 */
export const NAP = 90 * MIN;

/** t 之后作息里的下一次醒来。 */
export function nextWake(t: number): number {
  const today = t - msIntoDay(t) + SLEEP_WINDOW.wake * MIN;
  return today > t ? today : today + DAY;
}

/** 她 at 上床，这一觉睡到什么时候：夜里到作息的下一次醒来；anytime 的白天只睡 NAP。 */
export function bedUntil(at: number, anytime = false): number {
  const wake = nextWake(at);
  return anytime && wake - at > NIGHT ? at + NAP : wake;
}

/** 她去睡了、还没到这一觉的结束（生产：到作息的下一次醒来）。 */
export function inBed(world: View<"bedAt">, now: number): boolean {
  const at = world.bedAt;
  return at !== undefined && at <= now && now < nextWake(at);
}

/** 此刻的睡眠深度：在床上、作息还没开始睡时按刚睡着算，其余按作息表。 */
export function depthIn(world: View<"bedAt">, now: number): number {
  return inBed(world, now) && !isAsleep(now) ? 1 : sleepDepth(now);
}

export interface BedtimeOptions {
  /**
   * true：任何时候都给 go_to_bed（白天也能说去歇一会儿），白天的觉睡 NAP 就自己结束。
   * 生产不传：只在离作息醒来不到 NIGHT 时给，睡到作息醒来。
   */
  anytime?: boolean;
}

export function createBedtime(options: BedtimeOptions = {}): PressureFeature {
  const anytime = options.anytime === true;
  /** 这一次决定里给不给 go_to_bed。 */
  const offers = (now: number): boolean => anytime || nextWake(now) - now <= NIGHT;
  /** 她此刻在床上（anytime 时白天那一觉按 bedUntil 结束）。 */
  const inBedHere = (world: View<"bedAt">, now: number): boolean => {
    const at = world.bedAt;
    return at !== undefined && at <= now && now < bedUntil(at, anytime);
  };
  const depthHere = (world: View<"bedAt">, now: number): number =>
    inBedHere(world, now) && !isAsleep(now) ? 1 : sleepDepth(now);
  return feature({
    name: "bedtime",
    provides: ["bedAt"],
    outside: true,
    affordances: ["bed"] as const satisfies readonly ActKind[],
    offers: (kind, _scope, _world, now) => kind !== "bed" || offers(now),
    // 她决定去睡的那一刻就算上床（决定里的 go_to_bed 在这一刻给得出时），不等动作做完的回执：这次决定期间
    // 来的、要她想完再看的那条（step.ts stillWakes）按她已经去睡了来问。
    reduce: (_before, after, event) =>
      (event.type === "act.done" && event.act.kind === "bed") ||
      (event.type === "speech.decided" &&
        event.decision.acts.some((a) => a.kind === "bed") &&
        offers(event.at))
        ? { ...after, bedAt: event.at }
        : after,
    asleep: (world, now) => isAsleep(now) || inBedHere(world, now),
    contribute: ({ world, now, sought }) =>
      sleepFacts(isAsleep(now) || inBedHere(world, now), now, sought),
    will: {
      age: awakeBetween,
      cost: (world, _chat, _affordance, now) => SLEEP_COST * depthHere(world, now),
    },
  });
}

/** 生产：只在夜里给、睡到作息的下一次醒来。 */
export const bedtime: PressureFeature = createBedtime();
