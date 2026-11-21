/**
 * 她自己的随机性的来源（mind/noise.ts 的键）：确定的伪随机数（mulberry32 加 Box–Muller），外壳和回放用它从种子
 * 生成 noise.drawn。外壳用自己的种子（启动时取一次），回放用固定种子。不在 mind/ 里：核心只读事件里的数。
 * 后来加的键（SIDE_NOISE_KEYS）从同一个种子派生的另一条流抽：原来几个键每一格抽到的数不因为多了键而变。
 */
import { MAIN_NOISE_KEYS, type NoiseKey, SIDE_NOISE_KEYS } from "./mind/noise.js";

function normals(seed: number): () => number {
  let s = seed >>> 0;
  const uniform = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) + 1) / 4294967297;
  };
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
}

/** 另一条流的种子：和主流错开（黄金比例常数）。 */
const SIDE = 0x9e3779b9;

export function noiseSource(seed: number): () => Record<NoiseKey, number> {
  const main = normals(seed);
  const side = normals(seed ^ SIDE);
  return () =>
    Object.fromEntries([
      ...MAIN_NOISE_KEYS.map((k) => [k, main()]),
      ...SIDE_NOISE_KEYS.map((k) => [k, side()]),
    ]) as Record<NoiseKey, number>;
}
