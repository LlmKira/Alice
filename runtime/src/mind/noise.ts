/**
 * 她自己的随机性：外壳每隔 NOISE_EVERY_MS 抽一组独立的标准正态数，作为 noise.drawn 写进 Journal
 * （回放用固定种子生成同样的事件，src/noise-source.ts），机制在 reduce 里只读自己的键。mind/ 与机制保持纯：
 * 随机数只从事件里来。
 *
 * 键由用到它的机制声明在 NOISE_KEYS 里；外壳每次把所有键都抽一遍，机制自己决定读几个。
 */

/** 抽样间隔。离散的生活事件按这个格子开始（5 分钟：洗澡、吃饭这类以十几分钟计的事都落得进来）。 */
export const NOISE_EVERY_MS = 5 * 60_000;

/**
 * 每次抽的键：mood（心情的波动，emotion）、energy 与 social（精力、想不想社交的波动，life.ts）、
 * life（这一格开不开始一件事、开始哪件，life.ts）、life-length（那件事做多久）。没有人读的键不抽。
 */
export const MAIN_NOISE_KEYS = ["mood", "energy", "social", "life", "life-length"] as const;
/**
 * 后来加的键从另一条随机数流抽（src/noise-source.ts），前面那几个键抽到的数不变，已有的回放逐字节相同：
 * pickup（这一格她拿不拿起手机、在格子里哪一刻，phone.ts）。
 */
export const SIDE_NOISE_KEYS = ["pickup"] as const;
export const NOISE_KEYS = [...MAIN_NOISE_KEYS, ...SIDE_NOISE_KEYS] as const;
export type NoiseKey = (typeof NOISE_KEYS)[number];

/**
 * Ornstein–Uhlenbeck 过程的精确离散化（Gillespie 1996）：dx = θ(μ − x)dt + σ dW。
 * 过了 dt 之后 x ~ N(μ + (x − μ)e^{−θdt}, σ²(1 − e^{−2θdt}) / 2θ)，z 是标准正态。
 * 平稳分布 N(μ, σ²/2θ)；θ 是回归力（DynAffect 的 attractor strength），单位与 dt 一致。
 */
export function ouStep(
  x: number,
  p: { mu: number; theta: number; sigma: number },
  dt: number,
  z: number,
): number {
  if (dt <= 0) return x;
  const decay = Math.exp(-p.theta * dt);
  const sd = p.sigma * Math.sqrt((1 - decay * decay) / (2 * p.theta));
  return p.mu + (x - p.mu) * decay + sd * z;
}

/**
 * 按想要的波动幅度给出 OU 的参数：平稳标准差 sd、回归到常态的半衰期 halfLife（与 dt 同一时间单位），
 * θ = ln2 / halfLife，σ = sd·√(2θ)（平稳分布 N(μ, σ²/2θ) 的标准差正好是 sd）。
 */
export function ou(o: { mu?: number; sd: number; halfLife: number }): {
  mu: number;
  theta: number;
  sigma: number;
} {
  const theta = Math.LN2 / o.halfLife;
  return { mu: o.mu ?? 0, theta, sigma: o.sd * Math.sqrt(2 * theta) };
}

/** 标准正态的分布函数 Φ（Abramowitz & Stegun 7.1.26，误差 < 1.5e-7）：把一个正态数换成 (0,1) 的均匀数。 */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2));
  const poly =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}
