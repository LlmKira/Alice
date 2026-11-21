/**
 * 按天累计的模型花费（capabilities X04）。每次调用一行写进状态目录下的花费账 `spend/<日>.jsonl`，
 * 进程重启后从当天的账读回总数，所以重启不会把当天的上限清零。日子按东八区算（和她的作息、想一想一致）。
 * 花费账不是 Journal：它记的是外壳的开销，不是她经历的事。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 发言、想一想、看图、听语音、翻相册时的重排、语音合成、交出去办的事（执行代理）、判口气（Jev）。 */
export const SPEND_KINDS = [
  "speech",
  "ponder",
  "image",
  "voice",
  "rerank",
  "tts",
  "errand",
  "tone",
] as const;
export type SpendKind = (typeof SPEND_KINDS)[number];

const H = 3_600_000;
/** 东八区的日期，例如 "2026-11-11"。 */
export function dayKey(at: number): string {
  return new Date(at + 8 * H).toISOString().slice(0, 10);
}

export interface SpendDay {
  day: string;
  calls: Record<SpendKind, number>;
  usd: Record<SpendKind, number>;
  total: number;
}

function emptyDay(day: string): SpendDay {
  const zero = () =>
    Object.fromEntries(SPEND_KINDS.map((k) => [k, 0])) as Record<SpendKind, number>;
  return { day, calls: zero(), usd: zero(), total: 0 };
}

function add(day: SpendDay, kind: SpendKind, usd: number): SpendDay {
  return {
    day: day.day,
    calls: { ...day.calls, [kind]: day.calls[kind] + 1 },
    usd: { ...day.usd, [kind]: day.usd[kind] + usd },
    total: day.total + usd,
  };
}

const isKind = (k: unknown): k is SpendKind => SPEND_KINDS.includes(k as SpendKind);

export class SpendMeter {
  private current: SpendDay;
  private warned = false;

  constructor(
    private readonly dir: string,
    private readonly now: () => number,
    private readonly warn: (error: unknown) => void = () => {},
  ) {
    this.current = this.load(dayKey(now()));
  }

  /** 记一次调用的花费（美元），返回记完之后的当天合计。 */
  record(kind: SpendKind, usd: number, detail: Record<string, unknown> = {}): SpendDay {
    const at = this.now();
    const today = this.today();
    const amount = Number.isFinite(usd) && usd > 0 ? usd : 0;
    this.current = add(today, kind, amount);
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(
        join(this.dir, `${today.day}.jsonl`),
        `${JSON.stringify({ at, kind, usd: amount, ...detail })}\n`,
      );
    } catch (error) {
      // 账写不进去时内存里的合计照样算，上限照样生效。
      if (!this.warned) this.warn(error);
      this.warned = true;
    }
    return this.current;
  }

  /** 当天的合计；过了零点就是新的一天。 */
  today(): SpendDay {
    const day = dayKey(this.now());
    if (this.current.day !== day) this.current = this.load(day);
    return this.current;
  }

  private load(day: string): SpendDay {
    const path = join(this.dir, `${day}.jsonl`);
    if (!existsSync(path)) return emptyDay(day);
    let total = emptyDay(day);
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { kind?: unknown; usd?: unknown };
        if (isKind(row.kind) && typeof row.usd === "number") total = add(total, row.kind, row.usd);
      } catch {
        // 半行（写到一半进程被杀）跳过。
      }
    }
    return total;
  }
}
