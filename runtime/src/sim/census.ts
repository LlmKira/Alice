/**
 * 普查：在一个或几个窗口上零成本回放生产（她的发言用替身 surrogate.ts，别人的回应用 responders.ts），
 * 按 footprints.ts 的表读出每个生产机制的 footprint：应有的 footprint、期望、实测、在不在预期内。不调 LLM。
 *
 * 用法：pnpm census <events.jsonl> <开始ms> <结束ms> [<开始ms> <结束ms>]... [<另一个 events.jsonl> <开始ms> <结束ms>]...
 *        --surrogate <model.json> [--responders <model.json>] [--arm production] [--out <目录>]
 * 输入是一串事件（will-replay 的数据集格式）。以后由假的 Telegram 客户端经 world-adapter 产出的事件也是这个格式，
 * 直接换掉第一个参数即可。每个窗口的回放写在 --out 下（默认 eval-artifacts/census/runs），表打在标准输出。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AliceEvent } from "../mind/events.js";
import { FOOTPRINTS, type Footprint, measure, type RunFiles } from "./footprints.js";
import { parse, replayEvents, runName } from "./will-replay.js";

const DAY = 86_400_000;

const jsonl = <T>(path: string): T[] =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as T)
    : [];

/** 一次 will-replay 输出目录 → 普查要读的几份。 */
export function readRun(dir: string, days: number): RunFiles {
  return {
    days,
    calls: jsonl(join(dir, "calls.jsonl")),
    prompts: jsonl(join(dir, "prompts.jsonl")),
    dwell: jsonl(join(dir, "dwell.jsonl")),
    replies: jsonl<{ scope: string; at: number; from: string }>(join(dir, "replies.jsonl")).map(
      ({ scope, at, from }) => ({ scope, at, from }),
    ),
  };
}

/** 几个窗口合在一起读（天数相加）。 */
export function pool(runs: readonly RunFiles[]): RunFiles {
  return {
    days: runs.reduce((a, r) => a + r.days, 0),
    calls: runs.flatMap((r) => r.calls),
    prompts: runs.flatMap((r) => r.prompts),
    dwell: runs.flatMap((r) => r.dwell),
    directed: runs.flatMap((r) => r.directed ?? []),
    groups: [...new Set(runs.flatMap((r) => r.groups ?? []))],
    messages: runs.flatMap((r) => r.messages ?? []),
    replies: runs.flatMap((r) => r.replies ?? []),
  };
}

/**
 * 窗口里没被截断的"找她的消息"（最后 2 小时的不算）、有人说话的群，和到窗口结束为止别人的消息（她引用回话时
 * 找时刻；谁在场，窗口开头时谁在场看的是更早的消息）；按回放看到的样子（她的旧话删掉）。
 */
const TAIL = 2 * 3_600_000;
export function soughtIn(
  received: readonly AliceEvent[],
  from: number,
  until: number,
): Pick<RunFiles, "directed" | "groups" | "messages"> {
  const before = received.flatMap((e) =>
    e.type === "message.received" && e.at < until ? [e] : [],
  );
  const inside = before.filter((e) => e.at >= from);
  return {
    directed: inside
      .filter((e) => e.directed && e.at <= until - TAIL)
      .map((e) => ({ scope: e.scope, at: e.at })),
    groups: [...new Set(inside.filter((e) => e.chatType === "group").map((e) => e.scope))],
    messages: before.map((e) => ({
      scope: e.scope,
      id: e.messageId,
      at: e.at,
      from: e.senderId,
    })),
  };
}

export interface CensusRow {
  footprint: Footprint;
  value: number | null;
  ok: boolean | null;
}

export function census(run: RunFiles, table: readonly Footprint[] = FOOTPRINTS): CensusRow[] {
  return table.map((footprint) => {
    const value = measure(footprint.measure, run);
    const { min, max } = footprint.expect;
    const ok =
      value === null || footprint.reportOnly
        ? null
        : (min === undefined || value >= min) && (max === undefined || value <= max);
    return { footprint, value, ok };
  });
}

const unitOf = (f: Footprint) =>
  ["act", "wake", "away", "group-turns"].includes(f.measure.type) ||
  (f.measure.type === "dwell" && f.measure.what === "floor-wakes")
    ? "/天"
    : f.measure.type === "in-bed"
      ? "次"
      : f.measure.type === "reply-latency"
        ? " 分钟"
        : "";

const fmt = (v: number | undefined | null) =>
  v === undefined || v === null ? "–" : Number.isInteger(v) ? String(v) : v.toFixed(3);

/** 期望那一栏：≥ 下限，≤ 上限，带单位。 */
function expectation(f: Footprint): string {
  const { min, max } = f.expect;
  const low = min === undefined ? "" : `≥ ${fmt(min)}`;
  const both = min !== undefined && max !== undefined ? "，" : "";
  const high = max === undefined ? "" : `≤ ${fmt(max)}`;
  return `${low}${both}${high}${unitOf(f)}`;
}

function verdict(f: Footprint, ok: boolean | null): string {
  if (f.reportOnly) return "只报";
  if (ok === null) return "无样本";
  return ok ? "是" : "否";
}

export function render(rows: readonly CensusRow[]): string {
  const lines = [
    "| 机制 | footprint | 期望 | 实测 | 在预期内 | 来源 |",
    "|---|---|---|---|---|---|",
  ];
  for (const { footprint: f, value, ok } of rows) {
    lines.push(
      `| ${f.mechanism} | ${f.footprint} | ${expectation(f)} | ${fmt(value)}${unitOf(f)} | ${verdict(f, ok)} | ${f.source} |`,
    );
  }
  return lines.join("\n");
}

/**
 * 位置参数里的窗口：一个数据集后面跟一对或几对 <开始ms> <结束ms>，可以接着写下一个数据集和它的窗口
 * （几个数据集合在一起读，样本少的 footprint 靠它攒够样本）。格式不对就是空的。
 */
export function windowsOf(
  args: readonly string[],
): Array<{ events: string; from: string; until: string }> {
  const out: Array<{ events: string; from: string; until: string }> = [];
  let events: string | null = null;
  for (let i = 0; i < args.length; ) {
    const a = args[i] as string;
    if (!/^\d+$/.test(a)) {
      events = a;
      i++;
      continue;
    }
    const until = args[i + 1];
    if (events === null || until === undefined || !/^\d+$/.test(until)) return [];
    out.push({ events, from: a, until });
    i += 2;
  }
  return out;
}

function main(): void {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0) return null;
    const v = args[i + 1] ?? null;
    args.splice(i, 2);
    return v;
  };
  const surrogate = flag("--surrogate");
  const responders = flag("--responders");
  const arm = flag("--arm") ?? "production";
  const out = flag("--out") ?? "eval-artifacts/census/runs";
  const windows = windowsOf(args);
  if (!surrogate || windows.length === 0) {
    throw new Error(
      "usage: census <events.jsonl> <from> <until> [<from> <until>]... [<events.jsonl> <from> <until>...]... --surrogate <m.json> [--responders <m.json>] [--arm a] [--out dir]",
    );
  }
  const runs: RunFiles[] = [];
  for (const { events, from, until } of windows) {
    const dir = join(out, `${from}`);
    const argv = [
      ...[events, dir, arm, "--stub", "surrogate", "--surrogate", surrogate],
      ...["--window", from, until, "--log-prompts"],
      ...(responders ? ["--responders", responders] : []),
    ];
    execFileSync(process.execPath, ["--import", "tsx", "src/sim/will-replay.ts", ...argv], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    // 同一个 --out 下可能还留着别的组别、别的选项跑出的目录：按这一次的选项找回它自己的输出。
    const o = parse(argv);
    runs.push({
      ...readRun(join(dir, runName(o)), (Number(until) - Number(from)) / DAY),
      ...soughtIn(replayEvents(o), Number(from), Number(until)),
    });
  }
  const pooled = pool(runs);
  console.log(
    `窗口 ${runs.length} 个，共 ${pooled.days.toFixed(2)} 天，发言调用 ${pooled.calls.length}`,
  );
  console.log(render(census(pooled)));
}

if (process.argv[1]?.endsWith("census.ts")) main();
