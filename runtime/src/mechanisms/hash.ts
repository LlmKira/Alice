/** 字符串的 FNV-1a（32 位，无符号）：确定的打散，回放可复现。 */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/**
 * 字符串的 32 位哈希：FNV-1a 加 MurmurHash3 的 fmix32 收尾（只用 FNV 时尾数相近的串会挤在一起）。
 * 确定、不透明、分布均匀，用来分组（灰度）和给东西编号；不是加密用的。
 */
export function hash32(text: string): number {
  let h = fnv1a(text);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** 字符串 → [0, 1)（FNV-1a）：回放的 stub、替身和回应模型按 (会话, 时刻, 哪一项) 确定地抽样。 */
export function unit(key: string): number {
  return fnv1a(key) / 2 ** 32;
}
