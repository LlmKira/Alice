/**
 * 她的身体和她那边的世界（ADR-276 环节一"身体的需要"，架构骨架里 sleep + life + bedtime 三样的终态）：
 *
 * 1. 困：睡眠压力 S 不再查一天一张的钟点表，而是跟着她真实的睡着、醒来走（Borbély 1982；Daan, Beersma &
 *    Borbély 1984 的参数就在 sleep.ts 的 SLEEP_MODEL 里：醒着 τ_r = 18.2 小时升向 1，睡着 τ_d = 4.2 小时降向 0）。
 *    上下阈值 H(t)、L(t) 仍由昼夜节律的余弦给出；S 碰到 H 入睡、降到 L 醒来。熬夜（一直在说话、动作不断）
 *    S 攒得更高，第二天睡得更深、醒得更晚。
 * 2. 饿：离上一顿越久越饿，τ = 5 小时升向 1；吃饭、在外面吃饭、夜宵做完就归零（由事件确定，不问模型）。
 *    饿只改"吃饭"这件事的优先级：饿得厉害时，它会打断手上的随手事（Barabási 2005 的优先队列）。
 * 3. 出门：时段里的事不都在家里——散步、在外面吃饭、逛街、咖啡馆也在她那边发生（docs/research/her-life.md
 *    第 5 片，ADR-276 把"都在家里"撤掉：那是为一次笨拙删掉一种生活）。写成事实时是她那边的外面，
 *    从不暗示她要过来见聊天里的人。
 *
 * 纯函数：时间只来自 event.at / now，随机数只来自 noise.drawn（life 与 life-length 两个键），不读时钟、
 * 不取随机数、不做 I/O（test/mind-purity.test.ts）。
 *
 * 这一样独占世界里的 life 块和 bedAt 块（provides 两块），可以在一种组成里替换 sleep + life + bedtime。
 * 世界里的 life 一块多带着身体的状态（LifeBodyState 在 LifeState 之外加了 sleep 和 hunger）；World 的类型
 * 归 world.ts 管，所以进出这一块时按 LifeBodyState 断言一次，其余函数都是类型化的。家里那几类事的时段、
 * 优先级刻度、随手事的长度都从 life.ts 取；只有"按动态睡眠停手"和外面那几类是新写的（life.ts 的
 * reduceLife 按钟点表判断睡着、ActivityKind 是闭合的，换不过去）。
 *
 * 连续底色（精力、想不想说话）照样 fold 进 energy/social 并写成事实；warm（随心情起伏）由组成时接
 * affect 的 sociability，这一样不另开一份心情。
 *
 * will.age 只拿得到两个时刻（WillTerms.age 是 Age），读不到世界里的睡眠状态，所以时钟那一项仍用作息表
 * （sleep.ts 的 awakeBetween）作底；睡眠深度、代价和事实都按 fold 出来的动态睡眠算。
 */
import type { ActKind } from "../../mind/affordances.js";
import type { LifeDayRequest } from "../../mind/effects.js";
import type { AliceEvent, LifeDayPonder } from "../../mind/events.js";
import type { Contribution } from "../../mind/mechanism.js";
import { NOISE_EVERY_MS, normalCdf, ou, ouStep } from "../../mind/noise.js";
import type { AliceState } from "../../mind/state.js";
import { localDay, localMinute } from "../../mind/when.js";
import { feature, type PressureFeature, type View } from "./feature.js";
import {
  type ActivityKind,
  FILLERS,
  GLANCE,
  GLANCE_P,
  LENGTH_SIGMA,
  LIFE_SLOTS,
  LIFE_TONE,
  type LifeState,
  priorityCost,
  sociability,
} from "./life.js";
import { PHI_TURN, SLEEP_COST } from "./params.js";
import { alertness, awakeBetween, isAsleep, SLEEP_MODEL, sleepDepth, sleepFacts } from "./sleep.js";

const MIN = 60_000;
const H = 60 * MIN;

/** 纯整数公历换算（Howard Hinnant civil_from_days），不构造 Date，守 mind-purity。 */
function civilFromDays(z: number): string {
  const n = z + 719_468;
  const era = Math.floor((n >= 0 ? n : n - 146_096) / 146_097);
  const doe = n - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const year = y + (m <= 2 ? 1 : 0);
  return `${String(year).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function dayStartEpoch(dateText: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
  if (!m) return null;
  let y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  y -= mo <= 2 ? 1 : 0;
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  const days = era * 146_097 + doe - 719_468;
  return days * 24 * H - 8 * H;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

// ── 困：动态的 Borbély 双过程模型 ─────────────────────────────────────

/**
 * 被叫醒、自己动起来之后至少清醒这么久，才允许按阈值再睡着：她刚回过一条消息，不会一分钟后又在"睡着"，
 * 熬夜聊天因此攒下更高的 S。手设，和 sleep.ts 的"刚睡醒"（30 分钟）同量级。
 */
const WAKE_HOLD = 30 * MIN;

/** 记着最近这么多个睡过的时段（算"醒着多久"用；一星期足够覆盖她没看到的事）。 */
const RESTS_KEPT = 16;

interface SleepSpan {
  from: number;
  to: number;
}

/**
 * 睡眠压力 S 的 fold 状态。at 是上次 fold 到的时刻；asleepSince 是这一次睡着的时刻（醒着为 null）；
 * rests 只用来回答"醒着多久"——最近睡过的时段（这一次还在睡的那段不算进去）。
 */
export interface DynamicSleepState {
  /** 上一步 fold 到的时刻（0 = 还没开始，第一件事到来时按作息表起步）。 */
  at: number;
  /** at 时刻的睡眠压力 S ∈ [0, 1]。 */
  s: number;
  /** 这一次睡着的时刻；醒着为 null。 */
  asleepSince: number | null;
  /** 最近一次醒来的时刻（0 = 还不知道）。 */
  wokeAt: number;
  /** 醒来后至少在 awakeUntil 之前不再按阈值入睡（她刚动过，是醒着的）。 */
  awakeUntil: number;
  /** 最近睡过的时段，从旧到新。 */
  rests: readonly SleepSpan[];
}

/** 上下阈值 H(t)、L(t)：昼夜节律 C 的余弦（SLEEP_MODEL 的相位，和 sleep.ts 同一个）。 */
function thresholdsAt(minute: number): { hi: number; lo: number } {
  const c = Math.cos((2 * Math.PI * (minute / 60 - SLEEP_MODEL.peakHour)) / 24);
  return {
    hi: SLEEP_MODEL.upper + SLEEP_MODEL.amplitude * c,
    lo: SLEEP_MODEL.lower + SLEEP_MODEL.amplitude * c,
  };
}

/**
 * 一分钟的模型（advanceSleep 和 nextWakeAt 共用这一条规则）：先看阈值——睡着时 S 降到 L 就醒、
 * 醒着时 S 升到 H 就睡（醒来不到 WAKE_HOLD 时不睡）——再按睡着与否积分 dt。
 */
function stepSleep(
  s: number,
  asleep: boolean,
  awakeUntil: number,
  t: number,
  dt: number,
): { s: number; asleep: boolean; woke: boolean } {
  const { hi, lo } = thresholdsAt(localMinute(t));
  const woke = asleep && s <= lo;
  const slept = !asleep && t >= awakeUntil && s >= hi;
  const next = woke ? false : slept ? true : asleep;
  return {
    s: next
      ? s * Math.exp(-dt / (H * SLEEP_MODEL.fallHours))
      : 1 - (1 - s) * Math.exp(-dt / (H * SLEEP_MODEL.riseHours)),
    asleep: next,
    woke,
  };
}

function pushRest(rests: readonly SleepSpan[], span: SleepSpan): readonly SleepSpan[] {
  return [...rests, span].slice(-RESTS_KEPT);
}

/** 第一件事到来时从作息表里取一个 S，和 asleep 一致（不知道她之前的历史，从模型自己的常态起步）。 */
function seedSleep(now: number): DynamicSleepState {
  const minute = localMinute(now);
  const { hi, lo } = thresholdsAt(minute);
  if (isAsleep(now)) {
    const depth = sleepDepth(now);
    return {
      at: now,
      s: clamp01(lo + depth * (hi - lo)),
      asleepSince: now,
      wokeAt: 0,
      awakeUntil: 0,
      rests: [],
    };
  }
  const alert = alertness(now);
  return {
    at: now,
    s: clamp01(hi - alert * (hi - lo)),
    asleepSince: null,
    wokeAt: 0,
    awakeUntil: 0,
    rests: [],
  };
}

interface SleepCheckpoint {
  at: number;
  s: number;
  asleepSince: number | null;
  wokeAt: number;
  awakeUntil: number;
  rests: readonly SleepSpan[];
}

interface SleepMemo {
  /** 最近一次推进到的整分钟边界（未 clamp01，和逐分钟循环走到该边界时的中间变量逐位一致）。 */
  whole: SleepCheckpoint;
  lastNow: number;
  lastResult: DynamicSleepState;
}

const sleepMemo = new WeakMap<DynamicSleepState, SleepMemo>();

/**
 * 把睡眠状态推进到 now：一分钟一分钟地走（和 sleep.ts 的表同一个分辨率），
 * 睡着时 S 降到 L(t) 就自然醒来，醒着时 S 升到 H(t) 就自然入睡（醒来不到 WAKE_HOLD 时不睡）。
 * 最后在 now 上再按 dt = 0 判一次门槛：循环里的检查都发生在每一段的起点，少了这一步，
 * 恰好落在阈值那一分钟的时刻会报"还睡着"，和 nextWakeAt 说的不是同一件事。
 * 同一个不可变 state 上反复按递增的 now 查询时（如每 10 秒一次 clock.tick），从上次整分钟边界续算，
 * 避免长空闲期退化成 O(T^2)。
 */
export function advanceSleep(state: DynamicSleepState, now: number): DynamicSleepState {
  if (state.at === 0) return seedSleep(now);
  if (now <= state.at) return state;
  const memo = sleepMemo.get(state);
  if (memo && memo.lastNow === now) return memo.lastResult;
  const base: SleepCheckpoint = memo && memo.whole.at <= now ? memo.whole : state;
  let s = base.s;
  let asleepSince = base.asleepSince;
  let wokeAt = base.wokeAt;
  let awakeUntil = base.awakeUntil;
  let rests = base.rests;
  let t = base.at;

  const applyStep = (dt: number) => {
    const sleptFrom = asleepSince;
    const step = stepSleep(s, sleptFrom !== null, awakeUntil, t, dt);
    s = step.s;
    if (step.woke && sleptFrom !== null) {
      rests = pushRest(rests, { from: sleptFrom, to: t });
      asleepSince = null;
      wokeAt = t;
      awakeUntil = t;
    } else if (sleptFrom === null && step.asleep) {
      asleepSince = t;
    }
  };

  while (now - t >= MIN) {
    applyStep(MIN);
    t += MIN;
  }
  const whole: SleepCheckpoint = { at: t, s, asleepSince, wokeAt, awakeUntil, rests };
  if (t < now) {
    applyStep(now - t);
    t = now;
  }
  applyStep(0);

  const result: DynamicSleepState = {
    at: now,
    s: clamp01(s),
    asleepSince,
    wokeAt,
    awakeUntil,
    rests,
  };
  sleepMemo.set(state, {
    whole: memo && memo.whole.at > whole.at ? memo.whole : whole,
    lastNow: now,
    lastResult: result,
  });
  return result;
}

/** 此刻的睡眠压力 S。 */
export function sleepPressureAt(state: DynamicSleepState, now: number): number {
  return advanceSleep(state, now).s;
}

/** 此刻睡着没有（按 fold 出来的 S 与阈值，不查钟点表）。 */
export function isAsleepAt(state: DynamicSleepState, now: number): boolean {
  return advanceSleep(state, now).asleepSince !== null;
}

/** 此刻睡得多深：醒着为 0，刚睡着（S 刚到 H）为 1，快醒（S 到 L）为 0。 */
export function sleepDepthAt(state: DynamicSleepState, now: number): number {
  const p = advanceSleep(state, now);
  if (p.asleepSince === null) return 0;
  const { hi, lo } = thresholdsAt(localMinute(now));
  return clamp01((p.s - lo) / (hi - lo));
}

/** 此刻若睡着，按模型什么时候自然醒来；醒着为 null。 */
export function nextWakeAt(state: DynamicSleepState, now: number): number | null {
  const p = advanceSleep(state, now);
  if (p.asleepSince === null) return null;
  let s = p.s;
  let t = now;
  for (let i = 0; i <= 24 * 60; i++) {
    const step = stepSleep(s, true, 0, t, MIN);
    if (step.woke) return t;
    s = step.s;
    t += MIN;
  }
  return t;
}

/** 她去睡：从 at 起算睡着（自己的选择，不管 WAKE_HOLD）。 */
export function fallAsleep(state: DynamicSleepState, at: number): DynamicSleepState {
  const p = advanceSleep(state, at);
  if (p.asleepSince !== null) return p;
  return { ...p, asleepSince: at, awakeUntil: at };
}

/** 她被叫醒（有人找她、她动起来了）：醒来到 at，之后至少 WAKE_HOLD 之内不再按阈值睡着。 */
export function wakeUp(state: DynamicSleepState, at: number): DynamicSleepState {
  const p = advanceSleep(state, at);
  if (p.asleepSince === null) return { ...p, awakeUntil: Math.max(p.awakeUntil, at + WAKE_HOLD) };
  return {
    ...p,
    asleepSince: null,
    wokeAt: at,
    awakeUntil: at + WAKE_HOLD,
    rests: pushRest(p.rests, { from: p.asleepSince, to: at }),
  };
}

/**
 * from 到 to 之间她醒着的时长：她没看到的事（没读的消息、等她回的话）只在她醒着时变旧。
 * 还记得的睡过的时段（rests）和此刻这一次都减掉；比最早的记录还早的那一段按醒着算（作息表之外的旧账）。
 */
export function awakeDurationBetween(state: DynamicSleepState, from: number, to: number): number {
  if (to <= from) return 0;
  const p = advanceSleep(state, Math.max(to, state.at));
  const spans = p.asleepSince === null ? p.rests : [...p.rests, { from: p.asleepSince, to }];
  const asleep = spans.reduce(
    (sum, s) => sum + Math.max(0, Math.min(s.to, to) - Math.max(s.from, from)),
    0,
  );
  return Math.max(0, to - from - asleep);
}

// ── 饿 ───────────────────────────────────────────────────────────────

/**
 * 饿的增长（ADR-276：离上一顿越久越饿、吃饭确定性地缓解它）。τ = 5 小时：醒着约 3.5 小时到 0.5、
 * 4.6 小时到"去吃饭"的 0.6、7 小时到 0.75。手设：时间利用调查只给时段，不给胃排空的曲线。
 */
const HUNGER_MODEL = {
  tauHours: 5,
  /** 饿到这里，她会放下手上的随手事去吃饭（约 4.6 小时没吃）。 */
  interrupt: 0.6,
  /** 进"有点饿"的起点（约 4 小时）。 */
  hungry: 0.55,
  /** 进"饿得不行了"的起点（约 8 小时）。 */
  very: 0.8,
  /** 优先级从这一档饿开始抬；再饿就抬到 1。 */
  boostFrom: 0.4,
} as const;

export interface HungerState {
  /** 上一步 fold 到的时刻。 */
  at: number;
  /** at 时刻的饿，[0, 1]。 */
  hunger: number;
  /** 上一顿吃完的时刻（0 = 还不知道，第一件事到来时按轻饿起步）。 */
  lastMealAt: number;
}

/** 此刻有多饿。 */
export function hungerAt(state: HungerState, now: number): number {
  if (now <= state.at) return state.hunger;
  return clamp01(
    1 - (1 - state.hunger) * Math.exp(-(now - state.at) / (H * HUNGER_MODEL.tauHours)),
  );
}

/**
 * 饿给"吃饭"这件事加多少优先级（0 = 不饿，1 = 饿到最紧）：只把吃饭往前挪，
 * 不凭空造一件比什么都重要的事。0.4 以下不 boost，饿到 1 时优先级可以到 1。
 */
export function mealPriorityBoost(hunger: number): number {
  const low = HUNGER_MODEL.boostFrom;
  return clamp01((clamp01(hunger) - low) / (1 - low));
}

// ── 她那边的事（家里 + 外面） ───────────────────────────────────────

/** 时段里的事，加上她那边门外的几类（散步、在外面吃饭、逛街、咖啡馆）。后四样手机都在身边。 */
type BodyActivityKind = ActivityKind | "walk" | "eat_out" | "shop" | "cafe";

interface BodyActivity {
  kind: BodyActivityKind;
  from: number;
  until: number;
  /** Barabási 的优先级，(0, 1) 均匀；手机不在手边时为 1。饿可以把吃饭的优先级抬起来。 */
  priority: number;
}

/** 身体的 fold 状态：life.ts 的连续底色与手上的事，加上睡眠压力和饿。世界里的 life 块就是它。 */
export interface LifeBodyState {
  /** 上一次抽样的时刻（0 = 还没有）。 */
  at: number;
  /** 精力相对作息常态的起伏（OU，和 life.ts 同一个过程）。 */
  energy: number;
  /** 想不想说话（OU，标准分）。 */
  social: number;
  doing: BodyActivity | null;
  /** 刚做完的那件（"我刚洗完澡"）。 */
  done: BodyActivity | null;
  /** 每个时段最近一次轮到的"生活日"（一天从早上 6 点算起）。 */
  slots: Readonly<Record<string, number>>;
  sleep: DynamicSleepState;
  hunger: HungerState;
  /** 这一格里瞄一眼手机的时刻（life-l2-glance：做别的事时偶尔瞄 15 秒，不收代价）。 */
  glanceAt?: number;
  /** 饿/困给心情的即时偏移（[-0.2, 0]），affect.ts 只读它写进 AffectState.bodyOffset。 */
  moodNudge?: number;
  /** 每天醒来一次或睡着时梦境复盘的生活内容（her-life.md 第 2 片）：只读她的生活，写具体活动、瞬间小事、跨天的事与内生好奇点。 */
  day?: {
    date: string;
    lastRequestedDate?: string;
    activities: Readonly<Record<string, string>>;
    moments: ReadonlyArray<{ at: number; text: string }>;
    ongoing: readonly string[];
    curiosities?: ReadonlyArray<{ topic: string; hook: string }>;
  };
}

export const emptyBody: LifeBodyState = {
  at: 0,
  energy: 0,
  social: 0,
  doing: null,
  done: null,
  slots: {},
  sleep: { at: 0, s: 0, asleepSince: null, wokeAt: 0, awakeUntil: 0, rests: [] },
  hunger: { at: 0, hunger: 0.2, lastMealAt: 0 },
};

const ENERGY_OU = ou(LIFE_TONE.energy);
const SOCIAL_OU = ou(LIFE_TONE.social);

/**
 * 世界里的 life 一块换成身体的状态。组成里没有这一样时它还是世界 fold 的初始值 emptyLife（没有 sleep/hunger），
 * 第一件事到来时再起步；fold 过一次以后原样返回（这一块只归这一样写，compose 保证没有第二个提供者）。
 */
export function bodyOf(life: LifeState): LifeBodyState {
  const maybe = life as Partial<LifeBodyState>;
  return maybe.sleep !== undefined && maybe.hunger !== undefined
    ? (maybe as LifeBodyState)
    : emptyBody;
}

interface BodySlot {
  key: string;
  from: number;
  to: number;
  p: number;
  meanMin: number;
  kind: BodyActivityKind;
}

const at = (h: number, m = 0) => h * 60 + m;

/**
 * 一天里的事：家里那几类直接取 life.ts 的时段与概率（对着 2018 年全国时间利用调查，改一处两边一起变），
 * 外面那几类按 docs/research/her-life.md 第 5 片（散步、买东西；出门吃饭和咖啡馆是同一类的自然延伸）。
 * 每件事开始时刻在时段里均匀分布、时长按对数正态。都是她一个人在她那边做：外面那几类只是换了个地点，
 * 不是去见谁。重叠的时段按开始时刻排，先到的先用同一个随机数。
 */
const OUTDOOR_SLOTS: readonly BodySlot[] = [
  { key: "eat-out-lunch", from: at(12), to: at(13, 30), p: 0.35, meanMin: 50, kind: "eat_out" },
  { key: "cafe", from: at(14, 30), to: at(16, 30), p: 0.3, meanMin: 45, kind: "cafe" },
  { key: "walk", from: at(16, 30), to: at(18), p: 0.5, meanMin: 30, kind: "walk" },
  { key: "shop", from: at(15), to: at(17), p: 0.35, meanMin: 40, kind: "shop" },
  { key: "eat-out-dinner", from: at(18, 30), to: at(20), p: 0.2, meanMin: 70, kind: "eat_out" },
];

export const LIFE_BODY_SLOTS: readonly BodySlot[] = [...LIFE_SLOTS, ...OUTDOOR_SLOTS].sort(
  (a, b) => a.from - b.from || a.to - b.to,
);

/** 手机不在手边：洗澡、洗漱（Barabási 模型里永远排在前面的那件事）。 */
const NO_PHONE: ReadonlySet<BodyActivityKind> = new Set(["shower", "wash"]);

/** 刚吃完这么久之内不再按饭点开一顿：早午饭和出门吃的那两段窗口重叠，不连着吃两顿。 */
const MEAL_GAP = 90 * MIN;

/** 随手的事（her-life 第 1 片）：醒着时手上一直有一件，时段里的事可以打断它。 */
const FILLER_KINDS: ReadonlySet<BodyActivityKind> = new Set<BodyActivityKind>(
  FILLERS.map((f) => f.kind),
);

/** 随手事的抽法：phoneWeight 换掉刷手机的权重（不给时照 FILLERS），其余几件不变。 */
type Filler = (typeof FILLERS)[number];
function fillersWith(phoneWeight: number | undefined): readonly Filler[] {
  if (phoneWeight === undefined) return FILLERS;
  return FILLERS.map((f) => (f.kind === "phone" ? { ...f, weight: phoneWeight } : f));
}

const MEAL_KINDS: ReadonlySet<BodyActivityKind> = new Set(["meal", "eat_out", "snack"]);

/** 对数正态的时长：均值 meanMin 分钟，z 是标准正态（和 life.ts 同一个 LENGTH_SIGMA）。 */
const lengthOf = (meanMin: number, z: number) =>
  meanMin * MIN * Math.exp(LENGTH_SIGMA * z - (LENGTH_SIGMA * LENGTH_SIGMA) / 2);

/** 生活日：从早上 6 点换天（和 life.ts 一致，跨午夜的时段算前一天）。 */
const lifeDay = (t: number) => localDay(t - 6 * H);
const lifeMinute = (t: number): number => {
  const m = localMinute(t);
  return m < 6 * 60 ? m + 24 * 60 : m;
};

/** 外面吃的那两段（中午、傍晚）：饿了又在饭点，就去外面吃。 */
const outdoorsForMeal = (minute: number): boolean =>
  (minute >= at(11) && minute < at(14)) || (minute >= at(17, 30) && minute < at(20, 30));

function finish(body: LifeBodyState, end: number): LifeBodyState {
  const doing = body.doing;
  if (!doing) return body;
  // 做完了才进"刚……"、才缓解饿；被叫去睡打断的那一件不算做完（她刚吃了半顿，不写"刚吃完饭"）。
  const completed = end >= doing.until;
  return {
    ...body,
    doing: null,
    done: completed ? { ...doing, until: doing.until } : body.done,
    hunger:
      completed && MEAL_KINDS.has(doing.kind)
        ? { at: doing.until, hunger: 0, lastMealAt: doing.until }
        : body.hunger,
  };
}

function start(
  body: LifeBodyState,
  kind: BodyActivityKind,
  now: number,
  lengthMs: number,
  priority: number,
): LifeBodyState {
  return {
    ...body,
    doing: {
      kind,
      from: now,
      until: now + lengthMs,
      priority: NO_PHONE.has(kind) ? 1 : clamp01(priority),
    },
    done: body.doing ? { ...body.doing, until: now } : body.done,
  };
}

/** 这一格里开一件随手的事（剩下的 u 仍是均匀的，落进哪一段就做哪件）。 */
function startFiller(
  body: LifeBodyState,
  now: number,
  u: number,
  z: number,
  span: (ms: number) => number,
  fillers: readonly Filler[],
): LifeBodyState {
  const total = fillers.reduce((s, f) => s + f.weight, 0);
  let lo = 0;
  for (const [i, f] of fillers.entries()) {
    const hi = i === fillers.length - 1 ? 1 : lo + f.weight / total;
    if (u < hi) {
      return start(body, f.kind, now, span(lengthOf(f.meanMin, z)), (u - lo) / (hi - lo));
    }
    lo = hi;
  }
  return body;
}

/** 空着时开始一件事要用的这一格的事实。 */
interface Tick {
  now: number;
  /** 生活日（一天从早上 6 点算起）和其中的分钟。 */
  day: number;
  minute: number;
  /** 这一格有多少分钟（时段里的事按它算这一格开始的条件概率）。 */
  stepMinutes: number;
  /** 这件事做多久的那个随机数（"life-length"）。 */
  lengthZ: number;
  span: (ms: number) => number;
  hunger: number;
}

/** 饿到会打断随手的事：先把这一顿吃了（错过的一顿往后挪，不凭空消失）；饭点在外面吃。 */
function startMeal(b: LifeBodyState, t: Tick, u: number): LifeBodyState {
  const out = outdoorsForMeal(t.minute) && u < 0.4;
  const kind: BodyActivityKind = out ? "eat_out" : "meal";
  const meanMin = out ? 60 : 40;
  return start(
    b,
    kind,
    t.now,
    t.span(lengthOf(meanMin, t.lengthZ)),
    Math.max(mealPriorityBoost(t.hunger), u),
  );
}

/**
 * 时段里的事：时段里均匀开始、总概率 p（这一格里的条件概率）。开始了一件时 next 是新的状态；
 * 没开始时 u 是落在没开始那一段里、重新拉成均匀的剩余（随手的事接着用它）。
 */
function startSlot(
  b: LifeBodyState,
  t: Tick,
  u0: number,
): { next: LifeBodyState | null; u: number } {
  let u = u0;
  for (const slot of LIFE_BODY_SLOTS) {
    if (t.minute < slot.from || t.minute >= slot.to || b.slots[slot.key] === t.day) continue;
    if (MEAL_KINDS.has(slot.kind) && t.now - b.hunger.lastMealAt < MEAL_GAP) continue;
    const left = (slot.to - t.minute) / (slot.to - slot.from);
    const h = Math.min(
      1,
      (slot.p * Math.min(t.stepMinutes, slot.to - t.minute)) /
        (slot.to - slot.from) /
        Math.max(1e-9, 1 - slot.p * (1 - left)),
    );
    if (u >= h) {
      u = (u - h) / (1 - h);
      continue;
    }
    const next = start(
      b.doing ? finish(b, t.now) : b,
      slot.kind,
      t.now,
      t.span(lengthOf(slot.meanMin, t.lengthZ)),
      // 饿也把时段里的饭抬紧一点：饿的时候这顿饭更不容易被随手的事比下去。
      Math.max(u / h, MEAL_KINDS.has(slot.kind) ? mealPriorityBoost(t.hunger) : 0),
    );
    return { next: { ...next, slots: { ...next.slots, [slot.key]: t.day } }, u };
  }
  return { next: null, u };
}

/** 空着（或只在做随手的事）时这一格开始的那件事；什么都没开始为 null。 */
function startNext(
  b: LifeBodyState,
  t: Tick,
  u: number,
  o: { fill: boolean; fillers: readonly Filler[] },
): LifeBodyState | null {
  if (t.hunger >= HUNGER_MODEL.interrupt) return startMeal(b, t, u);
  const slot = startSlot(b, t, u);
  if (slot.next) return slot.next;
  // 候选 life-l2：醒着时手上一直有事。
  if (o.fill && b.doing === null) {
    return startFiller(b, t.now, slot.u, t.lengthZ, t.span, o.fillers);
  }
  return null;
}

/** 接着做同一件看得到手机的事（没消耗 life-length）：可能瞄一眼（life-l2-glance）。 */
function maybeGlance(
  b: LifeBodyState,
  before: LifeBodyState,
  now: number,
  on: boolean,
  g: number,
): LifeBodyState {
  const glances =
    on &&
    b.doing !== null &&
    b.doing === before.doing &&
    b.doing.kind !== "phone" &&
    !NO_PHONE.has(b.doing.kind) &&
    g < GLANCE_P;
  return glances ? { ...b, glanceAt: now + Math.floor((g / GLANCE_P) * NOISE_EVERY_MS) } : b;
}

/**
 * 一次抽样：两条随机游走走一步；做完的事放下；空着（或只在做随手的事）时按此刻各时段的概率开始一件。
 * 饿在前：饿到 interrupt 就先吃饭（饭点在外面吃），优先级至少是 mealPriorityBoost；然后是时段里的事；
 * 都没有时，随手事接上。
 */
function schedule(
  body: LifeBodyState,
  event: { at: number; draws: Partial<Record<string, number>> },
  o: { fill: boolean; glance: boolean; fillers: readonly Filler[] },
  hours: number,
): LifeBodyState {
  const now = event.at;
  const z = { energy: 0, social: 0, life: 0, "life-length": 0, ...event.draws };
  const energy = Number.isFinite(hours)
    ? ouStep(body.energy, ENERGY_OU, hours, z.energy)
    : LIFE_TONE.energy.sd * z.energy;
  const social = Number.isFinite(hours)
    ? ouStep(body.social, SOCIAL_OU, hours, z.social)
    : LIFE_TONE.social.sd * z.social;
  const { glanceAt: _expired, ...base } = body;
  const b: LifeBodyState = { ...base, energy, social };
  if (isAsleepAt(b.sleep, now)) return b;

  const idle = b.doing === null || FILLER_KINDS.has(b.doing.kind);
  if (idle) {
    const tick: Tick = {
      now,
      day: lifeDay(now),
      minute: lifeMinute(now),
      stepMinutes: Number.isFinite(hours) ? hours * 60 : NOISE_EVERY_MS / MIN,
      lengthZ: z["life-length"],
      span: (ms) => (o.fill ? Math.ceil(ms / NOISE_EVERY_MS) * NOISE_EVERY_MS : Math.round(ms)),
      hunger: hungerAt(b.hunger, now),
    };
    const started = startNext(b, tick, normalCdf(z.life), o);
    if (started) return started;
  }
  return maybeGlance(b, body, now, o.glance, normalCdf(z["life-length"]));
}

/** 她自己的动作算醒着（回过话、动过手）；上床另算。 */
function wakesHer(event: AliceEvent): boolean {
  switch (event.type) {
    case "message.sent":
    case "act.started":
    case "act.done":
      return true;
    case "speech.decided":
      return event.decision.acts.some((a) => a.kind !== "bed");
    default:
      return false;
  }
}

/** 她上床的时刻（decided 里带着这一项也算，和 bedtime.ts 同一个口径）。 */
function bedAtOf(event: AliceEvent): number | undefined {
  if (event.type === "act.done" && event.act.kind === "bed") return event.at;
  if (event.type === "speech.decided" && event.decision.acts.some((a) => a.kind === "bed")) {
    return event.at;
  }
  return undefined;
}

/** 生活反思写下的这一天：瞬间小事按当天的钟点放到时刻上。 */
function dayOf(p: LifeDayPonder): NonNullable<LifeBodyState["day"]> {
  const dayStartUtc = dayStartEpoch(p.date);
  const activities: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.activities)) {
    if (v) activities[k] = v;
  }
  return {
    date: p.date,
    lastRequestedDate: p.date,
    activities,
    moments:
      dayStartUtc !== null
        ? p.moments.map((m) => ({ at: dayStartUtc + m.hour * H, text: m.text }))
        : [],
    ongoing: p.ongoing,
    ...(p.curiosities !== undefined && p.curiosities.length > 0
      ? { curiosities: p.curiosities }
      : {}),
  };
}

/** 生活反思没成：记下今天问过了，原来那一天的内容留着。 */
function requestedOn(day: LifeBodyState["day"], today: string): NonNullable<LifeBodyState["day"]> {
  return {
    date: day?.date ?? "",
    lastRequestedDate: today,
    activities: day?.activities ?? {},
    moments: day?.moments ?? [],
    ongoing: day?.ongoing ?? [],
  };
}

/**
 * fold 一件事：先把睡眠、手上的事推进到这一刻（睡到 / 做完了），再办这件事本身
 * （上床、她被叫醒、这一格开始一件新的事）。
 */
export function reduceBody(
  body: LifeBodyState,
  event: AliceEvent,
  o: { fill?: boolean; glance?: boolean; phoneWeight?: number } = {},
): LifeBodyState {
  const fill = o.fill ?? true;
  const glance = o.glance ?? true;
  const fillers = fillersWith(o.phoneWeight);
  const now = event.at;
  const hours = body.at > 0 ? (now - body.at) / H : Number.POSITIVE_INFINITY;
  let b: LifeBodyState =
    body.at === 0
      ? { ...emptyBody, at: now, sleep: seedSleep(now), hunger: { ...body.hunger, at: now } }
      : { ...body, at: now, sleep: advanceSleep(body.sleep, now) };

  if (b.doing && now >= b.doing.until) b = finish(b, b.doing.until);

  const bedAt = bedAtOf(event);
  if (bedAt !== undefined) {
    b = { ...b, sleep: fallAsleep(b.sleep, bedAt) };
  } else if (wakesHer(event)) {
    b = { ...b, sleep: wakeUp(b.sleep, now) };
  }

  // 上床、或在她睡着时发生的事：手上的事停下（这一件不算做完）。
  if (b.doing && isAsleepAt(b.sleep, now)) b = finish(b, now);

  if (event.type === "ponder.done" && event.ponder.kind === "life") {
    return { ...b, day: dayOf(event.ponder) };
  }
  if (event.type === "ponder.failed" && event.kind === "life") {
    return { ...b, day: requestedOn(b.day, localDateText(now)) };
  }

  return event.type === "noise.drawn" ? schedule(b, event, { fill, glance, fillers }, hours) : b;
}

function localDateText(at: number): string {
  return civilFromDays(localDay(at));
}

// ── 写成事实、推动心情 ──────────────────────────────────────────────

/** 做完之后这么久之内还是"刚……"。 */
const JUST_DONE = 20 * MIN;
/** 醒来这么久之内是"刚睡醒"。 */
const JUST_WOKE = 30 * MIN;

/** 正在做（她被叫起来看手机）时的说法，和刚做完的说法。外面那几类说清是在她那边外面。 */
const SAYING: Record<BodyActivityKind, { doing: string; done: string }> = {
  wash: { doing: "我刚起来，在洗漱，顺手看了一眼手机。", done: "我刚洗漱完。" },
  meal: { doing: "我在吃饭，手机拿出来看了一眼。", done: "我刚吃完饭。" },
  snack: { doing: "我在吃夜宵，手机拿出来看了一眼。", done: "我刚吃完夜宵。" },
  shower: {
    doing: "我在洗澡，听见手机响，擦了擦手看了一眼。",
    done: "我刚洗完澡。",
  },
  game: { doing: "我在打游戏，这一局打完看了一眼手机。", done: "我刚打完游戏。" },
  show: { doing: "我在看剧，暂停了一下看手机。", done: "我刚看完一集剧。" },
  phone: { doing: "我在刷手机。", done: "我刚刷了会儿手机。" },
  read: { doing: "我在看书，放下书看了一眼手机。", done: "我刚看了会儿书。" },
  tidy: { doing: "我在收拾屋子，停下来看了一眼手机。", done: "我刚收拾完屋子。" },
  music: { doing: "我在听歌，顺手看了一眼手机。", done: "我刚听了会儿歌。" },
  walk: {
    doing: "我在外面散步，顺手看了一眼手机。",
    done: "我刚在外面散完步回来。",
  },
  eat_out: {
    doing: "我在外面吃饭，刚拿起手机看了一眼。",
    done: "我刚在外面吃完饭回来。",
  },
  shop: { doing: "我在逛街，顺手看了眼消息。", done: "我刚逛完街回来。" },
  cafe: { doing: "我在咖啡馆坐着，手机放在桌上。", done: "我刚从咖啡馆回来。" },
};

/** 给活动加上当天具体内容（"番茄炒蛋"）；没有具体内容时原样返回。 */
function withDetail(sentence: string, detail: string | undefined): string {
  if (!detail) return sentence;
  const idx = sentence.search(/[，。]/);
  return idx >= 0
    ? `${sentence.slice(0, idx)}（${detail}）${sentence.slice(idx)}`
    : `${sentence}（${detail}）`;
}

/** 在做什么或刚做完什么（手上只是随手的事、刚做完一件时段里的事时两句都说）。 */
function activityLines(body: LifeBodyState, now: number): string[] {
  const d = body.doing;
  const finishedDoing = d && now >= d.until && !FILLER_KINDS.has(d.kind) ? d : null;
  const doneCandidate = finishedDoing ?? body.done;
  const done =
    doneCandidate && now >= doneCandidate.until && now - doneCandidate.until <= JUST_DONE
      ? doneCandidate
      : null;
  const detail = (kind: BodyActivityKind): string | undefined => {
    if (!body.day || body.day.date !== localDateText(now)) return undefined;
    const key = kind === "eat_out" ? "meal" : kind === "show" ? "watch" : kind;
    return body.day.activities[key];
  };
  if (d && now >= d.from && now < d.until) {
    const doingLine = withDetail(SAYING[d.kind].doing, detail(d.kind));
    if (FILLER_KINDS.has(d.kind) && done && !FILLER_KINDS.has(done.kind)) {
      return [withDetail(SAYING[done.kind].done, detail(done.kind)), doingLine];
    }
    return [doingLine];
  }
  return done ? [withDetail(SAYING[done.kind].done, detail(done.kind))] : [];
}

/** 精力低于这个就是"有点累"（和 life.ts 同一个阈值：作息常态加起伏，入睡前两三个小时降到 0.3 以下）。 */
const TIRED = 0.3;
/** 想不想说话低于常态这么多就是"比较安静"（life.ts 的 QUIET_SD）。 */
const QUIET_SD = 1.5;

/**
 * 饿、困让心情略低（ADR-276：MacCormack & Lindquist 2019 的"饿怒"、Tomaso et al. 2021 的睡眠不足降正面情感）。
 * 有界的轻推：[-0.2, 0]，很饿或困到贴阈值时才到 −0.2，不另开一份心情（由 affect.ts 的评价入口加上去）。
 * sleepy：醒着、S 离 H 不到这么多的那一段，写"困得不行了"也是它。
 */
const BODY_MOOD = { max: 0.2, hunger: 0.7, sleepy: 0.08 } as const;

/** 今天反思写下的、到这一刻已经发生的小事，和这几天在做的事。 */
function todayLines(body: LifeBodyState, now: number): string[] {
  if (!body.day || body.day.date !== localDateText(now)) return [];
  const lines: string[] = [];
  const unlocked = body.day.moments.filter((m) => m.at <= now).map((m) => m.text);
  if (unlocked.length > 0) lines.push(`今天的小事：${unlocked.join("；")}。`);
  if (body.day.ongoing.length > 0) lines.push(`这几天在做的事：${body.day.ongoing.join("；")}。`);
  return lines;
}

/** 这会儿困不困、累不累、精神好不好（困了就不再说累，累了就不再说精神好）。 */
function vigorAt(
  body: LifeBodyState,
  s: number,
  now: number,
): "very-sleepy" | "sleepy" | "tired" | "lively" | null {
  const { hi, lo } = thresholdsAt(localMinute(now));
  if (s >= hi - BODY_MOOD.sleepy / 2) return "very-sleepy";
  if (s >= hi - BODY_MOOD.sleepy) return "sleepy";
  const alert = clamp01((hi - s) / (hi - lo));
  if (alert + body.energy < TIRED) return "tired";
  if (body.energy > LIFE_TONE.energy.sd) return "lively";
  return null;
}

const SLEEPY_FEEL = { "very-sleepy": "困得不行了", sleepy: "我这会儿有点困了" } as const;

/** 连续底色（life.ts 的同一套说法；warm 时随心情起伏）。困了和累合并成一句，不叠两句报状态。 */
function toneLine(
  vigor: ReturnType<typeof vigorAt>,
  quiet: boolean,
  chatty: boolean,
): string | null {
  if (vigor === "very-sleepy" || vigor === "sleepy") {
    return `${SLEEPY_FEEL[vigor]}${chatty ? "，但挺想找人聊聊天" : ""}。`;
  }
  if (vigor === "tired") return `我这会儿有点累，没什么精神${chatty ? "，但挺想找人聊聊天" : ""}。`;
  if (vigor === "lively") {
    return `我这会儿精神挺好${chatty ? "，挺想找人聊聊天" : quiet ? "，但人比较安静" : ""}。`;
  }
  if (chatty) return "我这会儿挺想找人聊聊天。";
  if (quiet) return "我这会儿人有点犯懒、比较安静。";
  return null;
}

/**
 * 她此刻的身体写成事实（state）：在做什么 / 刚做完什么、刚吃完饭、我有点饿了、困得不行了、刚睡醒，
 * 以及 life.ts 里那两样连续底色（累、精神好、想不想说话）。写成体感，不写机制、不写数。
 * 睡着时手上的事不写，那句"被吵醒/刚睡醒"用 sleep.ts 的同一个说法。warm（想不想说话随心情）由组成时接
 * affect 的 sociability，不在这一样里另开一份心情。
 */

export function bodyFacts(
  body: LifeBodyState,
  now: number,
  sought: boolean,
  social?: { quiet: boolean; chatty: boolean },
): Contribution[] {
  if (body.at === 0) return [];
  const projected = advanceSleep(body.sleep, now);
  if (projected.asleepSince !== null) {
    return sleepFacts(true, now, sought).map((c) => ({ ...c, mechanism: "pressure-life-body" }));
  }
  const lines = [...activityLines(body, now), ...todayLines(body, now)];
  const hunger = hungerAt(body.hunger, now);
  if (hunger >= HUNGER_MODEL.very) lines.push("我饿得不行了。");
  else if (hunger >= HUNGER_MODEL.hungry) lines.push("我有点饿了。");
  if (projected.wokeAt > 0 && now - projected.wokeAt <= JUST_WOKE) lines.push("我刚睡醒。");
  const { quiet, chatty } = social ?? {
    quiet: body.social < -QUIET_SD * LIFE_TONE.social.sd,
    chatty: body.social > LIFE_TONE.social.sd,
  };
  const tone = toneLine(vigorAt(body, projected.s, now), quiet, chatty);
  if (tone) lines.push(tone);
  return lines.length > 0
    ? [{ mechanism: "pressure-life-body", kind: "state", text: lines.join("\n") }]
    : [];
}

/** 此刻饿、困给心情的轻推（负数，[−0.2, 0]）；第一件事到来之前没有身体可说，给 0。 */
export function bodyMoodNudge(body: LifeBodyState, now: number): number {
  if (body.at === 0) return 0;
  const hunger = hungerAt(body.hunger, now);
  const projected = advanceSleep(body.sleep, now);
  const { hi } = thresholdsAt(localMinute(now));
  const hungry = clamp01((hunger - BODY_MOOD.hunger) / (1 - BODY_MOOD.hunger));
  const sleepy =
    projected.asleepSince === null
      ? clamp01((projected.s - (hi - BODY_MOOD.sleepy)) / BODY_MOOD.sleepy)
      : 0;
  const worst = Math.max(hungry, sleepy);
  return worst === 0 ? 0 : -BODY_MOOD.max * worst;
}

// ── 压力场里的那一样 ────────────────────────────────────────────────

/** 手机不在手边时的代价：和 life.ts 同一个量级（分位表顶端的两倍，够不着手机）。 */
const NO_PHONE_COST = 2 * priorityCost(1);

/** 她此刻正在瞄一眼手机（15 秒内不付手上的事的代价，并扫过各个会话）。 */
export function bodyGlancing(body: LifeBodyState, now: number): boolean {
  return body.glanceAt !== undefined && now >= body.glanceAt && now < body.glanceAt + GLANCE.ms;
}

/** 手上的事给所有意愿多加的代价(NSV 的刻度)；phone-free 为刷手机 0 代价，phi-half 仅在被点名/在对话里对刷手机免代价、其余按 PHI_TURN(0.5) 调制。 */
export function bodyBusyCost(
  body: LifeBodyState,
  now: number,
  ctx?: { obliged?: boolean; continuing?: boolean },
  busyMode: "phone-free" | "phi-half" = "phone-free",
): number {
  if (bodyGlancing(body, now)) return 0;
  const d = body.doing;
  if (!d || now < d.from || now >= d.until) return 0;
  if (NO_PHONE.has(d.kind)) return NO_PHONE_COST;
  if (busyMode === "phone-free") return d.kind === "phone" ? 0 : priorityCost(d.priority);
  if (d.kind === "phone" && (ctx?.obliged || ctx?.continuing)) return 0;
  const scale = ctx?.obliged || ctx?.continuing ? PHI_TURN : 1;
  return priorityCost(d.priority) * scale;
}

/**
 * 她的身体和她那边的世界：独占 life 和 bedAt 两块，可以在一种组成里替换 sleep + life + bedtime。
 * fill：醒着时手上一直有事（her-life 第 1 片）。
 * go_to_bed（affordance bed）随时给：白天困了也能去睡，睡到睡眠压力降下来的自然醒来，不再有 12 小时的夜间锁。
 */
export function createLifeBody(
  o: {
    fill?: boolean;
    warm?: boolean;
    glance?: boolean;
    scan?: boolean;
    busyMode?: "phone-free" | "phi-half";
    dailyContent?: boolean;
    dream?: boolean;
    /** 随手事里刷手机的权重（FILLERS 里是 6，另外三件各 1）；不给时照 FILLERS。 */
    phoneWeight?: number;
  } = {},
): PressureFeature {
  const phoneWeight = o.phoneWeight;
  const fill = o.fill ?? true;
  const warm = o.warm ?? true;
  const glance = o.glance ?? true;
  const scan = o.scan ?? true;
  const busyMode = o.busyMode ?? "phone-free";
  const dailyContent = o.dailyContent ?? false;
  const dream = o.dream ?? false;
  return feature({
    name: `life-body${fill ? "-l2" : ""}`,
    provides: ["life", "bedAt"] as const,
    requires: [] as const,
    uses: warm || dream ? (["affect"] as const) : ([] as const),
    outside: true,
    affordances: ["bed"] as const satisfies readonly ActKind[],
    offers: () => true,
    asleep: (world, now) => advanceSleep(bodyOf(world.life).sleep, now).asleepSince !== null,
    ...(glance && scan
      ? { scans: (world: View<"life">, now: number) => bodyGlancing(bodyOf(world.life), now) }
      : {}),
    ...(dailyContent || dream
      ? {
          ponder(
            world: View<"life" | "affect">,
            chats: AliceState["chats"],
            now: number,
          ): Omit<LifeDayRequest, "at"> | null {
            if (Object.keys(chats).length === 0) return null;
            const b = bodyOf(world.life);
            if (b.at === 0) return null;
            const sleep = advanceSleep(b.sleep, now);
            const asleep = sleep.asleepSince !== null;
            if (dream && asleep) {
              if (now - (sleep.asleepSince ?? now) < 30 * MIN) return null;
              const targetDate = localDateText(now + 8 * H);
              if (b.day?.date === targetDate || b.day?.lastRequestedDate === targetDate)
                return null;
              const v = world.affect.valence;
              const moodHint = v >= 0.25 ? "挺开心、有劲" : v <= -0.25 ? "有点闷或累" : "平静安稳";
              return {
                kind: "life",
                scope: "self",
                date: targetDate,
                dream: { moodHint },
                yesterday: {
                  activities: b.day?.activities ?? {},
                  moments: (b.day?.moments ?? []).map((m) => m.text),
                  ongoing: [...(b.day?.ongoing ?? [])],
                },
              };
            }
            if (asleep) return null;
            const date = localDateText(now);
            if (b.day?.date === date || b.day?.lastRequestedDate === date) return null;
            return {
              kind: "life",
              scope: "self",
              date,
              yesterday: {
                activities: b.day?.activities ?? {},
                moments: (b.day?.moments ?? []).map((m) => m.text),
                ongoing: [...(b.day?.ongoing ?? [])],
              },
            };
          },
        }
      : {}),
    reduce: (_before, after, event) => {
      // 身体只在真事件上推进，时钟格不推进：做完的事会一直挂在 doing 上，直到下一个真事件
      // （activityLines 的 finishedDoing 把它当成"刚做完"来写）。
      if (event.type === "clock.tick") return after;
      const next = reduceBody(bodyOf(after.life), event, {
        fill,
        glance,
        ...(phoneWeight !== undefined ? { phoneWeight } : {}),
      });
      const nudge = bodyMoodNudge(next, event.at);
      const { moodNudge: _drop, ...bodyRest } = next;
      const body: LifeBodyState = nudge === 0 ? bodyRest : { ...bodyRest, moodNudge: nudge };
      const bedAt = bedAtOf(event);
      return {
        ...after,
        life: body as LifeState,
        ...(bedAt !== undefined ? { bedAt } : {}),
      };
    },
    contribute: ({ world, now, sought }) => {
      const body = bodyOf(world.life);
      const social = warm ? sociability(body, world.affect, now) : undefined;
      return bodyFacts(body, now, sought, social);
    },
    will: {
      // WillTerms.age 只拿得到两个时刻，读不到 fold 出来的睡眠状态；动态的"醒着多久"由
      // awakeDurationBetween 给别的调用方，这里先用作息表作底。
      age: awakeBetween,
      cost: (world, _chat, _affordance, now) =>
        SLEEP_COST * sleepDepthAt(bodyOf(world.life).sleep, now),
      busy: (world, now, ctx) => bodyBusyCost(bodyOf(world.life), now, ctx, busyMode),
    },
  });
}

/** 默认形态：醒着时手上一直有事。 */
export const lifeBody: PressureFeature = createLifeBody();
