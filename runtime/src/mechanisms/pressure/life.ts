/**
 * 她自己的生活（候选 life，PLAN"回复的快慢"那条；预注册 eval-artifacts/life/prereg.md）：
 *
 * 1. 连续的底色：精力、想不想说话，各是一个带回归力的随机游走（Ornstein–Uhlenbeck；DynAffect 的常态、波动、
 *    回归力，Kuppens, Oravecz & Tuerlinckx 2010）。精力的常态不另造：就是作息模型里离入睡还有多远（sleep.ts
 *    alertness，双过程模型的警觉度）；随机游走只给它加上一阵一阵的起伏。
 * 2. 离散的生活事件：洗漱、吃饭、吃夜宵、洗澡、打游戏、看剧，都在家里，按时段出现、各有时长（时长与每天的总量取自国家统计局
 *    2018 年全国时间利用调查）。正在做一件事时，什么都要先和这件事比一比：按 Barabási（2005）的优先队列，
 *    每件事有一个均匀分布的优先级 x，此刻任何意愿都要多付 Q(x)，Q 是"被私聊找她时最好的意愿"的分布的分位函数
 *    （按秩把均匀优先级换到意愿的刻度上）。比它重要的事打断它（"吃着饭看了一眼手机"），不如它的就等它做完——
 *    长尾来自做事的时长，不设任何延迟参数。洗澡时手机不在手边，优先级取最高。
 * 3. 这些都写成她此刻的事实（"你在吃饭，手机拿出来看了一眼""你刚洗完澡"），不写机制、不写数。
 *
 * 随机数只从 noise.drawn 来（mind/noise.ts），所以从日志折叠、回放都得到同一天。
 * 她的生活是她自己的：都是一个人能自己做的事，不去谁的身边（和能力事实一致），也不编身份（上课、上班不在里面：
 * 人格里没写她上学或工作）。
 */
import type { AliceEvent } from "../../mind/events.js";
import type { Contribution } from "../../mind/mechanism.js";
import { NOISE_EVERY_MS, normalCdf, ou, ouStep } from "../../mind/noise.js";
import { localDay, localMinute } from "../../mind/when.js";
import { AFFECT_SD, type AffectState, valenceAt } from "./affect.js";
import { feature, type PressureFeature, type View } from "./feature.js";
import { alertness, isAsleep, SLEEP_WINDOW } from "./sleep.js";

const MIN = 60_000;
const H = 60 * MIN;

/**
 * 精力与想不想说话的随机游走（时间单位：小时）。
 * 波动幅度取 DynAffect 的个体内波动：唤醒度的平稳方差 4.28（0.1–9.9 的量表，Kuppens 2010 表 2），
 * 标准差 2.07，约为量表跨度的 0.21；精力用这个幅度。想不想说话没有现成的 OU 估计，按标准分处理（平稳标准差 1）。
 * 回归力：DynAffect 的吸引强度是 0.025（研究 1，按小时尺度的抽样），我们读到的原文没有写明时间单位，
 * 所以这里不照抄数值，取半衰期 1 小时（几小时内回到常态，和研究 1"按小时、天"的尺度一致）；是手设，
 * 留在 prereg 的问题里。想不想说话的回归力同样取 1 小时（O'Connor & Rosenblood 1996：社交意愿按小时的
 * 体验抽样呈现稳态调节）。
 */
export const LIFE_TONE = {
  energy: { sd: 0.21, halfLife: 1 },
  social: { sd: 1, halfLife: 1 },
} as const;

const ENERGY_OU = ou(LIFE_TONE.energy);
const SOCIAL_OU = ou(LIFE_TONE.social);

/** 正在做的事：决定说法，以及手机在不在手边。后四样只在候选 life-l2 里（FILLERS）。 */
export type ActivityKind =
  | "wash"
  | "meal"
  | "snack"
  | "shower"
  | "game"
  | "show"
  | "phone"
  | "read"
  | "tidy"
  | "music";

/**
 * 一天里的事：每个时段（本地钟点，分钟；可以跨过午夜）里以概率 p 开始一次，开始时刻在时段里均匀分布，
 * 时长按对数正态（均值 meanMin、对数标准差 LENGTH_SIGMA）。已经在做别的事时不开始（错过这个时段就算了）。
 * 每天的总量对着 2018 年全国时间利用调查（国家统计局公报）：用餐 1 小时 44 分钟（这里约 92 分钟：她起得晚，
 * 早饭和午饭并成一顿）、个人卫生护理 50 分钟（这里约 37 分钟）、休闲娱乐与看电视合计 2 小时 45 分钟
 * （这里打游戏、看剧合计约 1 小时 10 分钟：她的空闲有一部分本来就在 Telegram 上）。
 * 都在家里：人格写着"Offline stuff isn't your domain"；第一版有"出门""在外面吃饭"，真模型场景里她因此答应了
 * 出来见面（"来呗，正好想喝奶茶"），所以拿掉（eval-artifacts/life/prereg.md 修订 1）。
 * 钟点按她的时型往后挪：她 9:31 醒、约 1:34 睡（sleep.ts），比常人晚两三个小时。
 * 时段与 p 是手设的，每个都写在这里；没有一项是按回复延迟挑的。
 */
interface Slot {
  key: string;
  from: number;
  to: number;
  p: number;
  meanMin: number;
  kind: ActivityKind;
}

const at = (h: number, m = 0) => h * 60 + m;

export const LIFE_SLOTS: readonly Slot[] = [
  {
    key: "wash",
    from: SLEEP_WINDOW.wake,
    to: SLEEP_WINDOW.wake + 30,
    p: 1,
    meanMin: 15,
    kind: "wash",
  },
  { key: "brunch", from: at(10, 30), to: at(12, 30), p: 1, meanMin: 35, kind: "meal" },
  { key: "dinner", from: at(18), to: at(20, 30), p: 1, meanMin: 45, kind: "meal" },
  { key: "snack", from: at(23), to: at(24, 30), p: 0.5, meanMin: 25, kind: "snack" },
  { key: "show-day", from: at(14), to: at(17, 30), p: 0.6, meanMin: 45, kind: "show" },
  { key: "game", from: at(20, 30), to: at(23, 30), p: 0.7, meanMin: 50, kind: "game" },
  { key: "show-night", from: at(22), to: at(25), p: 0.4, meanMin: 40, kind: "show" },
  { key: "shower", from: at(21, 30), to: at(24, 30), p: 0.9, meanMin: 25, kind: "shower" },
];

/** 时长的对数标准差（手设：时间利用调查只给均值；0.4 时约有 10% 的长度超过均值的 1.6 倍）。 */
export const LENGTH_SIGMA = 0.4;

/** 手机在不在手边：洗澡、洗漱时不在，优先级取最高（Barabási 模型里永远排在前面的那件事）。 */
const NO_PHONE: ReadonlySet<ActivityKind> = new Set(["shower", "wash"]);

/**
 * 候选 life-l2（docs/research/her-life.md 第 1 片，eval-artifacts/her-life/prereg-1.md）：时段里的事之外，
 * 她醒着的每一刻手上也有一件自己的事。Barabási 的 L = 2 里，人手上一直有一件别的事和消息竞争；生产只在时段里
 * 有事（醒着时约两成），其余时间她一直拿着手机，被找 15 秒就回。
 * 一件做完、或被时段里的事打断，就按权重开始下一件，各抽自己的优先级（和时段里的事同一个 Q）。都在家里、一个人做。
 * 长度：
 * - 刷手机：Andrews et al. 2015（PLOS ONE 10(10): e0139004，23 人两周的真实记录）每天用 84.68 次、共 5.05 小时，
 *   55% 不到 30 秒。不到 30 秒的按 15 秒算，是瞄一眼，不算一件事；其余的平均
 *   (5.05·60/84.68 − 0.55·0.25)/0.45 ≈ 7.6 分钟。
 * - 看书、收拾屋子、听歌：手设 30 分钟。
 * 权重只为让刷手机一天合计约 5 小时（Andrews 的均值），用 60 天空跑核对（test/life.test.ts）；没有按回复延迟挑。
 * 这一片里每件事都在抽样的格子上结束（向上取整到 NOISE_EVERY_MS），下一件在同一格开始，中间没有空当。
 */
export const FILLERS: ReadonlyArray<{ kind: ActivityKind; weight: number; meanMin: number }> = [
  { kind: "phone", weight: 6, meanMin: 7.6 },
  { kind: "read", weight: 1, meanMin: 30 },
  { kind: "tidy", weight: 1, meanMin: 30 },
  { kind: "music", weight: 1, meanMin: 30 },
];
const FILLER: ReadonlySet<ActivityKind> = new Set(FILLERS.map((f) => f.kind));
const FILLER_WEIGHT = FILLERS.reduce((s, f) => s + f.weight, 0);

/** 对数正态的时长：均值 meanMin 分钟，z 是标准正态。 */
const lengthOf = (meanMin: number, z: number) =>
  meanMin * MIN * Math.exp(LENGTH_SIGMA * z - (LENGTH_SIGMA * LENGTH_SIGMA) / 2);

/**
 * 候选 life-l2-glance（eval-artifacts/her-life/prereg-3.md）：做别的事时，她隔一阵瞄一眼手机。Andrews et al. 2015
 * 的 84.68 次里 55% 不到 30 秒，每天约 46.6 次瞄一眼；每次按 15 秒算，和 FILLERS 刷手机长度的推导同一个假设。
 * 只在看得到手机、又不是正在刷手机的事里瞄（洗澡、洗漱不瞄）。瞄的那 15 秒她手上没事，不付代价：消息在那时
 * 照常排序，攒着的也一样。时刻来自这一格没用上的 life-length（这一格没开始新的事时它没被用）：落在 GLANCE_P
 * 以下就瞄，落点就是在格子里的位置。GLANCE_P 让 60 天空跑里每天约 46.6 次（test/life.test.ts 核对）；
 * 没有别的常数。
 */
export const GLANCE = { perDay: 0.55 * 84.68, ms: 15_000 } as const;
export const GLANCE_P = 0.444;

/**
 * Q：被私聊找她的那一刻，那个会话里最好的意愿（NSV）的分位（生产配置、2 月 B 全量回放、rate 桩，醒着时 n = 965；
 * 脚本 eval-artifacts/life/nsv-probe.mts）。分位点之间线性插值。按秩换算：优先级 x 的事，恰好有 1 − x 的私聊比它重要。
 */
const NSV_QUANTILES: ReadonlyArray<readonly [number, number]> = [
  [0, 0.2],
  [0.05, 0.261],
  [0.1, 0.301],
  [0.25, 0.461],
  [0.5, 0.975],
  [0.75, 1.308],
  [0.9, 1.715],
  [0.95, 1.793],
  [0.99, 1.84],
  [1, 1.9],
];

export function priorityCost(x: number): number {
  const p = Math.min(1, Math.max(0, x));
  for (let i = 1; i < NSV_QUANTILES.length; i++) {
    const [p1, q1] = NSV_QUANTILES[i] as readonly [number, number];
    const [p0, q0] = NSV_QUANTILES[i - 1] as readonly [number, number];
    if (p <= p1) return q0 + ((q1 - q0) * (p - p0)) / (p1 - p0);
  }
  return (NSV_QUANTILES.at(-1) as readonly [number, number])[1];
}

export interface Doing {
  kind: ActivityKind;
  from: number;
  until: number;
  /** Barabási 的优先级，(0,1) 均匀；手机不在手边时为 1。 */
  priority: number;
}

export interface LifeState {
  /** 上一次抽样的时刻（0 = 还没有）。 */
  at: number;
  /** 精力相对作息常态的起伏（OU）。 */
  energy: number;
  /** 想不想说话（OU，标准分）。 */
  social: number;
  doing: Doing | null;
  /** 刚做完的那件事（"你刚洗完澡"）。 */
  done: Doing | null;
  /** 每个时段最近一次轮到的"生活日"（一天从早上 6 点算起，跨午夜的时段算前一天）。 */
  slots: Readonly<Record<string, number>>;
  /** 这一格里她瞄一眼手机的时刻（候选 life-l2-glance；没有就不瞄）。 */
  glanceAt?: number;
}

export const emptyLife: LifeState = {
  at: 0,
  energy: 0,
  social: 0,
  doing: null,
  done: null,
  slots: {},
};

/** 生活日：从早上 6 点（她睡着的时候）换天，所以 0:30 的夜宵还算前一天的。 */
const lifeDay = (t: number) => localDay(t - 6 * H);
/** 生活日里的第几分钟（6 点起算之前的钟点加 24 小时）。 */
const lifeMinute = (t: number) => {
  const m = localMinute(t);
  return m < 6 * 60 ? m + 24 * 60 : m;
};

/**
 * 折叠一次抽样：两条随机游走走一步；手上的事做完了就放下；空着（醒着）时，按此刻各时段的开始概率决定开不开始
 * 一件事、开始哪件。一个均匀数 u 同时决定开不开始和是哪件，落进的那一段里的位置再换成优先级
 * （仍是均匀的），所以每格只用 life 与 life-length 两个数。
 * fill（候选 life-l2）：手上只是随手的事（FILLERS）时，时段里的事照样开始、打断它；什么都没在做时，用剩下的 u
 * 按权重开始一件随手的事。每件事都结束在格子上，醒着的每一格手上都有事。
 * glance（候选 life-l2-glance）：这一格接着做同一件看得到手机的事时，可能在格子里瞄一眼（GLANCE）。
 */
export function reduceLife(
  life: LifeState,
  event: AliceEvent,
  o: { fill?: boolean; glance?: boolean } = {},
): LifeState {
  const fill = o.fill === true;
  if (event.type !== "noise.drawn") return life;
  const now = event.at;
  // 旧日志里没有的键按 0（常态）算。
  const z = { energy: 0, social: 0, life: 0, "life-length": 0, ...event.draws };
  const hours = life.at > 0 ? (now - life.at) / H : Number.POSITIVE_INFINITY;
  // 第一次：从平稳分布起步（等于走了无限长的一步）。
  const energy = Number.isFinite(hours)
    ? ouStep(life.energy, ENERGY_OU, hours, z.energy)
    : LIFE_TONE.energy.sd * z.energy;
  const social = Number.isFinite(hours)
    ? ouStep(life.social, SOCIAL_OU, hours, z.social)
    : LIFE_TONE.social.sd * z.social;
  let doing = life.doing;
  let done = life.done;
  if (doing && now >= doing.until) {
    done = doing;
    doing = null;
  }
  // 睡着了，手上的事也就停了。
  if (doing && isAsleep(now)) {
    done = { ...doing, until: now };
    doing = null;
  }
  let slots = life.slots;
  // fill：结束在下一个整格上，下一件在那一格接上。
  const span = (length: number) =>
    fill ? Math.ceil(length / NOISE_EVERY_MS) * NOISE_EVERY_MS : Math.round(length);
  const idle = !doing || (fill && FILLER.has(doing.kind));
  if (idle && !isAsleep(now)) {
    const day = lifeDay(now);
    const minute = lifeMinute(now);
    // 上一格到这一格多少分钟（第一格按一个抽样间隔算）。
    const step = (now - (life.at || now - NOISE_EVERY_MS)) / MIN;
    let u = normalCdf(z.life);
    for (const slot of LIFE_SLOTS) {
      if (minute < slot.from || minute >= slot.to || slots[slot.key] === day) continue;
      // 时段里均匀开始、总概率 p：剩下的时段里条件化的开始概率（落在这一格里的概率）。
      const left = (slot.to - minute) / (slot.to - slot.from);
      const h = Math.min(
        1,
        (slot.p * Math.min(step, slot.to - minute)) /
          (slot.to - slot.from) /
          Math.max(1e-9, 1 - slot.p * (1 - left)),
      );
      if (u >= h) {
        u = (u - h) / (1 - h);
        continue;
      }
      const kind = slot.kind;
      // 放下手上随手的事（只有 fill 才会有）。
      if (doing) done = { ...doing, until: now };
      doing = {
        kind,
        from: now,
        until: now + span(lengthOf(slot.meanMin, z["life-length"])),
        priority: NO_PHONE.has(kind) ? 1 : Math.min(1, Math.max(0, u / h)),
      };
      slots = { ...slots, [slot.key]: day };
      break;
    }
    // 这一格没开始的、已经过去的时段：今天不再轮到（不必记，minute 超过 to 自然不再进来）。
    if (fill && !doing) {
      // 剩下的 u 仍是均匀的：落进哪一段就做哪件，段里的位置就是优先级。
      let lo = 0;
      for (const [i, f] of FILLERS.entries()) {
        const hi = i === FILLERS.length - 1 ? 1 : lo + f.weight / FILLER_WEIGHT;
        if (u < hi) {
          doing = {
            kind: f.kind,
            from: now,
            until: now + span(lengthOf(f.meanMin, z["life-length"])),
            priority: Math.min(1, Math.max(0, (u - lo) / (hi - lo))),
          };
          break;
        }
        lo = hi;
      }
    }
  }
  // 接着做同一件看得到手机的事（这一格的 life-length 没被用上）：可能瞄一眼。
  const g = normalCdf(z["life-length"]);
  const glances =
    o.glance === true &&
    doing !== null &&
    doing === life.doing &&
    doing.kind !== "phone" &&
    !NO_PHONE.has(doing.kind) &&
    g < GLANCE_P;
  return {
    at: now,
    energy,
    social,
    doing,
    done,
    slots,
    ...(glances ? { glanceAt: now + Math.floor((g / GLANCE_P) * NOISE_EVERY_MS) } : {}),
  };
}

/** 她此刻正在瞄一眼手机（GLANCE 的那 15 秒）。 */
export function glancing(life: LifeState, now: number): boolean {
  return life.glanceAt !== undefined && now >= life.glanceAt && now < life.glanceAt + GLANCE.ms;
}

/** 此刻正在做的事给所有意愿多加的代价（NSV 的刻度）；空着、或正瞄一眼手机时为 0。 */
export function busyCost(life: LifeState, now: number): number {
  if (glancing(life, now)) return 0;
  const d = life.doing;
  if (!d || now < d.from || now >= d.until) return 0;
  return NO_PHONE.has(d.kind) ? NO_PHONE_COST : priorityCost(d.priority);
}

/**
 * 手机不在手边时的代价：不是和消息比优先级，是够不着手机。取分位表顶端的两倍——高于回放里所有"被找"时的意愿
 * （最高约 1.92，一个从没聊过的人的第一条私聊）；仍是有限的代价，不是闸门。
 */
const NO_PHONE_COST = 2 * priorityCost(1);

/** 做完之后这么久之内还是"刚……"。 */
const JUST_DONE = 20 * MIN;

/**
 * 她自己的生活：从 noise.drawn 折进 world.life，写成此刻的事实。occupies：手上正在做的事让此刻的所有意愿都多付
 * 它的优先级（Barabási 的优先队列，在 NSV 的刻度上直接减，不乘 λ：priorityCost 就是按 NSV 的分布换算的）；
 * 消融 life-facts 不占用她（生活照样过、照样写成事实）。
 * warm：warmth 的想不想说话（sociability，见下；生产开着）。
 * fill：候选 life-l2，醒着时手上一直有事（FILLERS）。
 * glance：候选 life-l2-glance，做事时隔一阵瞄一眼手机（GLANCE），瞄的那 15 秒不付代价。
 * scan：候选 life-l2-glance-scan，瞄的那一眼扫过各个会话：有新消息的会话都按最新那条再问一次要不要醒
 * （mind/step.ts onTick），而不是只有节律排第一的那一个——看手机的人会扫一遍通知，可能回好几个。
 * 窗口就是那一眼本身，没有别的常数。
 */
export function life(o: {
  occupies: boolean;
  warm?: boolean;
  fill?: boolean;
  glance?: boolean;
  scan?: boolean;
}): PressureFeature {
  return feature({
    name: `${o.occupies ? "life" : "lifefacts"}${o.fill ? "-l2" : ""}${o.glance ? "-glance" : ""}${o.scan ? "-scan" : ""}${o.warm ? "-warm" : ""}`,
    provides: ["life"],
    // 想不想说话（warm）随她的心情起伏；没有心情那一样时按心情的初始值算（列在组合的 gaps 里）。
    uses: o.warm ? ["affect"] : [],
    reduce: (_before, w, event) =>
      event.type === "noise.drawn"
        ? { ...w, life: reduceLife(w.life, event, { fill: o.fill, glance: o.glance }) }
        : w,
    contribute: ({ world, now }) =>
      lifeFacts(world.life, now, o.warm ? sociability(world.life, world.affect, now) : undefined),
    ...(o.occupies
      ? { will: { busy: (world: View<"life">, now: number) => busyCost(world.life, now) } }
      : {}),
    ...(o.glance && o.scan
      ? { scans: (world: View<"life">, now: number) => glancing(world.life, now) }
      : {}),
  });
}

/** 正在做（她被叫起来看手机）时的说法，和刚做完的说法。 */
const SAYING: Record<ActivityKind, { doing: string; done: string }> = {
  wash: { doing: "我刚起来，在洗漱，顺手看了一眼手机。", done: "我刚洗漱完。" },
  meal: { doing: "我在吃饭，手机拿出来看了一眼。", done: "我刚吃完饭。" },
  snack: { doing: "我在吃夜宵，手机拿出来看了一眼。", done: "我刚吃完夜宵。" },
  shower: { doing: "我在洗澡，听见手机响，擦了擦手看了一眼。", done: "我刚洗完澡。" },
  game: { doing: "我在打游戏，这一局打完看了一眼手机。", done: "我刚打完游戏。" },
  show: { doing: "我在看剧，暂停了一下看手机。", done: "我刚看完一集剧。" },
  phone: { doing: "我在刷手机。", done: "我刚刷了会儿手机。" },
  read: { doing: "我在看书，放下书看了一眼手机。", done: "我刚看了会儿书。" },
  tidy: { doing: "我在收拾屋子，停下来看了一眼手机。", done: "我刚收拾完屋子。" },
  music: { doing: "我在听歌，顺手看了一眼手机。", done: "我刚听了会儿歌。" },
};

/** 精力低于这个就是"有点累"（作息常态加起伏；常态在入睡前两三个小时降到 0.3 以下）。 */
const TIRED = 0.3;

/**
 * 在做什么或刚做完什么。手上只是随手的事、刚做完一件时段里的事时两句都说（"我刚吃完饭。""我在刷手机。"），
 * 否则 life-l2 里"刚做完"永远被下一件随手的事盖住。
 */
function activity(life: LifeState, now: number): string[] {
  const d = life.doing;
  const done =
    life.done && now >= life.done.until && now - life.done.until <= JUST_DONE ? life.done : null;
  if (d && now >= d.from && now < d.until) {
    return FILLER.has(d.kind) && done && !FILLER.has(done.kind)
      ? [SAYING[done.kind].done, SAYING[d.kind].doing]
      : [SAYING[d.kind].doing];
  }
  return done ? [SAYING[done.kind].done] : [];
}

/**
 * 她此刻的生活写成事实（state，context-v2，out.md 改动 4）：在做什么或刚做完什么；精力明显低、或明显比平时好；
 * 想不想说话明显偏离常态。睡着时不写（作息的事实管那段）。写成体感，放在记录上方她自己的卡片里，不贴着"轮到你了"：
 * 以前的"不太想说话"和（不说话）那个选项字面相同，续写的模型把它读成这一轮的指示（上线第一天 80 次发言提示里
 * 18 次，18 次都没开口）；低的那句是"人有点犯懒、比较安静"，累的时候只说累，不再叠一句。
 * 想不想说话不给（消融 warmth-no-life：常态 0 的随机游走）时只在低于常态 1.5 个标准差时写（out.md 设计 2-1）；
 * 给了（warmth 的 sociability）按它的低尾。
 */
export const QUIET_SD = 1.5;

export function lifeFacts(
  life: LifeState,
  now: number,
  social?: { quiet: boolean; chatty: boolean },
): Contribution[] {
  if (life.at === 0 || isAsleep(now)) return [];
  const { quiet, chatty } = social ?? {
    quiet: life.social < -QUIET_SD * LIFE_TONE.social.sd,
    chatty: life.social > LIFE_TONE.social.sd,
  };
  const energy = alertness(now) + life.energy;
  const tired = energy < TIRED;
  const lively = !tired && life.energy > LIFE_TONE.energy.sd;
  const tone = tired
    ? `我这会儿有点累，没什么精神${chatty ? "，但挺想找人聊聊天" : ""}。`
    : lively
      ? `我这会儿精神挺好${chatty ? "，挺想找人聊聊天" : quiet ? "，但人比较安静" : ""}。`
      : chatty
        ? "我这会儿挺想找人聊聊天。"
        : quiet
          ? "我这会儿人有点犯懒、比较安静。"
          : null;
  const lines = [...activity(life, now), ...(tone ? [tone] : [])];
  return lines.length > 0
    ? [{ mechanism: "pressure-life", kind: "state", text: lines.join("\n") }]
    : [];
}

/**
 * 想不想说话（warmth，eval-artifacts/warmth/prereg.md）。原来它是一条常态为 0 的标准分随机游走，超过一个
 * 标准差就写（16% 的时候"不太想说话"，上线第一天 80 次发言提示里 18 次）。三处改动：
 * - 常态反映人格：她为聊天而生，活跃度对标群里较活跃的那四分之一人（研究员 2026-11-12）；所以她的常态取标准正态
 *   最高四分之一的均值 φ(z₀.₇₅)/0.25 ≈ 1.27 个标准差，随机游走只让她在这附近起伏。
 * - 心情带着它走：正面情感和社交性同属趋近系统，组内一起涨落（体验抽样里外向行为对正面情感的组内斜率 0.46，
 *   Sun et al. 2017；0.66，Fleeson et al. 2002；取 ρ = 0.5）。有人找她、她暖起来，她也更想说话；刚被惹烦，
 *   她也更想自己待着。合成 √(1 − ρ²)·游走 + ρ·心情的标准分（效价偏离常态多少个 AFFECT_SD），平稳时仍是单位方差。
 * - 低的那句只在低尾写（说法见 lifeFacts）。低到一般人的"不想说话"（人群标准分 −1 以下）才写，
 *   对她是常态以下 2.27 个标准差，平稳时约 1% 的时候。"挺想找人聊聊天"仍是比她平时高一个标准差。
 */
export const SOCIAL_HOME = topQuarterMean();
/** 心情和想不想说话的组内相关。 */
export const SOCIAL_MOOD_RHO = 0.5;

/** 标准正态最高四分之一的均值：φ(z) / 0.25，z = Φ⁻¹(0.75) ≈ 0.6745。 */
function topQuarterMean(): number {
  const z = 0.6744897501960817;
  return Math.exp(-(z * z) / 2) / Math.sqrt(2 * Math.PI) / 0.25;
}

export function sociability(
  life: LifeState,
  affect: AffectState,
  now: number,
): { quiet: boolean; chatty: boolean } {
  const mood = (valenceAt(affect, now) - affect.home) / AFFECT_SD;
  const rho = SOCIAL_MOOD_RHO;
  const s = SOCIAL_HOME + Math.sqrt(1 - rho * rho) * life.social + rho * mood;
  return { quiet: s < -LIFE_TONE.social.sd, chatty: s - SOCIAL_HOME > LIFE_TONE.social.sd };
}
