/**
 * 发文字之前显示"正在输入"多久（capabilities A17）。按线上 6,932 个真人连发间隔校准（间隔 p25=5.4s、
 * p50=10.6s、p75=18.0s；每字耗时 p25=393ms、p50=739ms、p75=1482ms）。只由外壳执行，不影响她的决定。
 *
 * 打字速度取真人中位数（约 1.35 汉字/秒，即约 740ms/字；非汉字 5 字符/秒），再乘一个 [0.55, 1.55] 的随机系数，
 * 还原真人那样参差的节奏。旧版没有随机系数，7–9 个字的消息总是死板地等 7–9 秒。下限 1s，上限 15s。
 */
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/u;
const CJK_PER_SECOND = 1.35;
const OTHER_PER_SECOND = 5;
const MIN_MS = 1_000;
const MAX_MS = 15_000;

export function typingMs(text: string, jitter: number = 0.55 + Math.random()): number {
  let seconds = 0;
  for (const ch of text.trim()) seconds += 1 / (CJK.test(ch) ? CJK_PER_SECOND : OTHER_PER_SECOND);
  return Math.round(Math.min(MAX_MS, Math.max(MIN_MS, seconds * 1000 * jitter)));
}
