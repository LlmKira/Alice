/**
 * 组合核：每个部分声明它独自写哪几块、读哪几块，组合时解析一次（Cordis 的空间组合，
 * Shi、Zhang、Cui 2026 §3.2；这里是纯函数，在组合时做完，不在运行中通知）。
 * - provides：只有它写的块。一块有两个提供者就在组合时报错（定义 22、23：set 要求 k ∉ dom σ）。
 * - requires：它读、少了就不能工作的块。缺一块就不激活，结果里列出它缺什么；它不会读到空的值
 *   （定义 25、26 的满足条件）。按最小不动点算，所以互相依赖的部分都不激活（§6.5）。
 * - uses：有就读、没有也照常工作的块（Cordis 的 ctx.get）。没有提供者时列进 gaps：
 *   它读到的是那一块的初始值，所以要列出来，不能悄悄发生。
 * - amends：它也写、但归别人提供的块。同一个概念有两个主人，是要合并的地方；列进 shared。
 * 时间上的可组合性（§3.1：拿掉一个部分时撤销它做过的事）不用另做：状态都从 Journal 纯折叠出来，
 * 拿掉一个部分就是不带它重新折叠一遍，没有要撤销的副作用。
 */

export interface Coeffects<K extends string = string> {
  readonly provides?: readonly K[];
  readonly requires?: readonly K[];
  readonly uses?: readonly K[];
  readonly amends?: readonly K[];
}

export interface Part<K extends string = string> extends Coeffects<K> {
  readonly name: string;
}

export interface Composition<P extends Part<K>, K extends string = string> {
  /** 激活的部分，按给的次序。 */
  readonly active: readonly P[];
  /** 不激活的部分和它缺的块。 */
  readonly inactive: ReadonlyArray<{ part: string; missing: readonly K[] }>;
  /** 激活的部分 uses 了、没有提供者的块。 */
  readonly gaps: ReadonlyArray<{ part: string; key: K }>;
  /** 激活的部分写了别人提供的块（owner 为 null：这一块此刻没有提供者）。 */
  readonly shared: ReadonlyArray<{ part: string; key: K; owner: string | null }>;
  /** 每一块此刻的提供者（底座和激活的部分）。 */
  readonly providers: ReadonlyMap<K, string>;
}

export class CompositionError extends Error {}

/**
 * 解析一种组成。base 是总在的底座（例如世界折叠），parts 按给的次序。
 * 两个部分提供同一块时抛 CompositionError；同一个名字出现两次也是（它们的状态按名字存）。
 */
export function compose<K extends string, P extends Part<K>>(
  base: Part<K>,
  parts: readonly P[],
): Composition<P, K> {
  const declared = new Map<K, string>();
  const names = new Set<string>([base.name]);
  for (const p of [base, ...parts]) {
    if (p !== base) {
      if (names.has(p.name)) throw new CompositionError(`两个部分都叫 ${p.name}`);
      names.add(p.name);
    }
    for (const k of p.provides ?? []) {
      const prior = declared.get(k);
      if (prior !== undefined) throw new CompositionError(`${k} 有两个提供者：${prior}、${p.name}`);
      declared.set(k, p.name);
    }
  }

  const providers = new Map<K, string>();
  for (const k of base.provides ?? []) providers.set(k, base.name);
  const on = new Set<P>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of parts) {
      if (on.has(p) || !(p.requires ?? []).every((k) => providers.has(k))) continue;
      on.add(p);
      for (const k of p.provides ?? []) providers.set(k, p.name);
      grew = true;
    }
  }

  const active = parts.filter((p) => on.has(p));
  const live: Part<K>[] = [base, ...active];
  return {
    active,
    inactive: parts
      .filter((p) => !on.has(p))
      .map((p) => ({ part: p.name, missing: (p.requires ?? []).filter((k) => !providers.has(k)) })),
    gaps: live.flatMap((p) =>
      (p.uses ?? []).filter((k) => !providers.has(k)).map((key) => ({ part: p.name, key })),
    ),
    shared: live.flatMap((p) =>
      (p.amends ?? []).map((key) => ({ part: p.name, key, owner: providers.get(key) ?? null })),
    ),
    providers,
  };
}
