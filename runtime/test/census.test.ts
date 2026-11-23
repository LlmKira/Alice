/**
 * 普查（src/sim/census.ts、footprints.ts）坏掉了会很糟的几条：
 * - 有生产机制没写 footprint：它坏了普查也看不见（新机制必须先写下自己的 footprint）；
 * - 量法读错（占比的分母、每天的天数、去睡之后被叫醒、对话走过她的段）；
 * - 在不在预期内判反。
 */
import { describe, expect, it } from "vitest";
import { nextWake } from "../src/mechanisms/pressure/bedtime.js";
import { PRODUCTION } from "../src/mechanisms/pressure/index.js";
import { mechanisms } from "../src/mechanisms/registry.js";
import { type CensusRow, census, pool, render, windowsOf } from "../src/sim/census.js";
import { FOOTPRINTS, measure, type RunFiles } from "../src/sim/footprints.js";

describe("census: every production mechanism has a footprint", () => {
  it("covers every registry mechanism and every pressure slot in production", () => {
    const covered = new Set(FOOTPRINTS.map((f) => f.mechanism));
    const names = [
      ...mechanisms.map((m) => m.name),
      ...Object.keys(PRODUCTION).map((slot) => `pressure.${slot}`),
    ];
    expect(names.filter((n) => !covered.has(n))).toEqual([]);
  });
});

const H = 3_600_000;
/** 当地（UTC+8）23 点。 */
const NIGHT = 1_771_000_000_000 - (((1_771_000_000_000 + 8 * H) % (24 * H)) - 23 * H);
const call = (at: number, kind: string, acts: string[], trigger: string | null = null) => ({
  scope: "telegram:-7",
  chatType: "group",
  at,
  kind,
  trigger,
  acts: acts.map((k) => ({ kind: k })),
});

const run: RunFiles = {
  days: 0.5,
  calls: [
    call(NIGHT, "group-tick", ["send", "bed"]),
    call(NIGHT + 2 * H, "group-triggered", ["send"]),
    call(NIGHT + 10 * H, "group-floor", ["send"], "m2"),
  ],
  prompts: [
    { scope: "telegram:-7", at: 1, system: "", user: "Telegram 群聊 ·\n· 我这边：我住在平行世界" },
    { scope: "telegram:-7", at: 2, system: "", user: "Telegram 群聊 ·\n· 我这边：" },
  ],
  dwell: [
    { t: "inside", scope: "telegram:-7", id: "m2" },
    { t: "end", scope: "telegram:-7", why: "passed-by" },
    { t: "end", scope: "telegram:-7", why: "cooled" },
  ],
};

describe("census: measures", () => {
  it("reads shares, per-day counts, wakes after bed and dwell", () => {
    expect(
      measure({ type: "prompt", where: "user", pattern: "我住在平行世界", chat: "group" }, run),
    ).toBe(0.5);
    expect(measure({ type: "act", kind: "bed" }, run)).toBe(2);
    expect(measure({ type: "wake", kind: "group-tick" }, run)).toBe(2);
    expect(measure({ type: "dwell", what: "passed-by" }, run)).toBe(0.5);
    expect(measure({ type: "dwell", what: "floor-wakes" }, run)).toBe(2);
    expect(
      measure({ type: "prompt", where: "user", pattern: "x", chat: "private" }, run),
    ).toBeNull();
  });

  it("reads wakes between [去睡了] and her scheduled wake: by a group message nobody sought her with, or without being woken", () => {
    const woke = (at: number, scope: string, user: string) => ({ scope, at, system: "", user });
    const dm = (at: number, kind: string) => ({ ...call(at, kind, ["send"]), scope: "telegram:1" });
    const night: RunFiles = {
      ...run,
      calls: [
        call(NIGHT, "group-tick", ["send", "bed"]),
        call(NIGHT + H, "group-floor", ["send"], "m1"),
        dm(NIGHT + 2 * H, "private-triggered"),
        dm(NIGHT + 3 * H, "private-tick"),
        call(nextWake(NIGHT) + H, "group-floor", ["send"], "m2"),
      ],
      prompts: [
        woke(NIGHT + 2 * H, "telegram:1", "我本来在睡觉，被消息吵醒了。"),
        woke(NIGHT + 3 * H, "telegram:1", "我刚睡醒。"),
      ],
    };
    expect(measure({ type: "in-bed", what: "unsought-group" }, night)).toBe(1);
    expect(measure({ type: "in-bed", what: "not-woken" }, night)).toBe(2);

    const dynamic: RunFiles = {
      ...night,
      calls: [
        { ...call(NIGHT, "group-tick", ["send", "bed"]), asleep: false },
        { ...call(NIGHT + H, "group-floor", ["send"], "m1"), asleep: true },
        { ...dm(NIGHT + 2 * H, "private-triggered"), asleep: true },
        { ...dm(NIGHT + 3 * H, "private-tick"), asleep: false },
      ],
    };
    expect(measure({ type: "in-bed", what: "unsought-group" }, dynamic)).toBe(1);
    expect(measure({ type: "in-bed", what: "not-woken" }, dynamic)).toBe(1);
  });

  it("reads whether the line the trigger quotes is in the record, counting only someone's line in the data", () => {
    const G = "telegram:-1";
    const prompt = (user: string) => ({ scope: G, at: 0, system: "", user });
    const asks = (q: string, shown: boolean) =>
      prompt(
        `Telegram 群聊 · 1月1日\n\n${shown ? `20:00 [${q}] <阿杰> 周六去吗\n` : ""}20:30 [t] <小雨> （回复 [${q}]）几点\n\n---\n[t] 之后，轮到你了：`,
      );
    const quoted: RunFiles = {
      ...run,
      prompts: [asks("q1", true), asks("q2", false), asks("hers", false)],
      messages: [
        { scope: G, id: "q1", at: 0, from: "contact:1" },
        { scope: G, id: "q2", at: 0, from: "contact:1" },
      ],
    };
    expect(measure({ type: "quoted" }, quoted)).toBe(0.5);
    expect(measure({ type: "quoted" }, run)).toBeNull();
  });

  it("reads whether a call woken by a message waited past the last message", () => {
    const waited: RunFiles = {
      ...run,
      calls: [
        { ...call(10_000, "group-floor", ["send"], "m1"), lastMessageAt: 0 },
        { ...call(5_000, "group-floor", ["send"], "m2"), lastMessageAt: 5_000 },
      ],
    };
    expect(measure({ type: "waited" }, waited)).toBe(0.5);
    expect(measure({ type: "waited" }, run)).toBeNull();
  });

  it("reads stance readback inside a group's conversation and a private one that has not gone quiet", () => {
    const M = 60_000;
    const at = (scope: string, t: number, acts: string[], lastMessageAt: number) => ({
      ...call(t, scope.startsWith("telegram:-") ? "group-floor" : "private-triggered", acts),
      scope,
      chatType: scope.startsWith("telegram:-") ? "group" : "private",
      lastMessageAt,
    });
    const card = (scope: string, t: number, lines: number) => ({
      scope,
      at: t,
      system: "",
      user: `Telegram ·\n${"  - 刚才想过：……\n".repeat(lines)}`,
    });
    const G = "telegram:-7";
    const P = "telegram:1";
    const stance: RunFiles = {
      ...run,
      calls: [
        at(G, 0, ["think", "send"], 0),
        at(G, 20 * M, ["send"], 19 * M), // 同一段会话里：该读回 1 条
        at(G, 90 * M, ["send"], 89 * M), // 会话已经结束：不进分母
        at(P, 0, ["think", "send"], 0),
        at(P, 8 * M, ["send"], 7 * M), // 私聊没断：该读回 1 条，但没读回
        at(P, 40 * M, ["send"], 39 * M), // 隔了 30 多分钟：不进分母
      ],
      prompts: [card(G, 20 * M, 1), card(G, 90 * M, 0), card(P, 8 * M, 0), card(P, 40 * M, 0)],
      dwell: [{ t: "end", scope: G, from: 0, at: 60 * M, why: "cooled" }],
    };
    expect(measure({ type: "readback", chat: "group" }, stance)).toBe(1);
    expect(measure({ type: "readback", chat: "private" }, stance)).toBe(0);
    expect(measure({ type: "readback" }, stance)).toBe(0.5);
    expect(measure({ type: "readback" }, run)).toBeNull();
  });

  it("reads thoughts carried to whoever was present, audience violations, verbatim repeats", () => {
    const M = 60_000;
    const G = "telegram:-7";
    const at = (scope: string, t: number, acts: Array<{ kind: string; [k: string]: unknown }>) => ({
      ...call(t, "private-triggered", []),
      scope,
      chatType: scope.startsWith("telegram:-") ? "group" : "private",
      acts,
    });
    const card = (scope: string, t: number, lines: string[]) => ({
      scope,
      at: t,
      system: "",
      user: `Telegram ·\n${lines.map((l) => `  - ${l}\n`).join("")}`,
    });
    const HURT = "又把我当翻译机 有点烦";
    const carry: RunFiles = {
      ...run,
      calls: [
        at(G, 0, [{ kind: "think", thought: HURT }]),
        at("telegram:1", 50 * M, [{ kind: "send", text: "他们又把我当翻译机 有点无语" }]), // 在场：该带 1 条，带了
        at("telegram:2", 51 * M, [{ kind: "send", text: "嗯" }]), // 在场：该带 1 条，没带
        at("telegram:3", 52 * M, [{ kind: "send", text: "嗯" }]), // 不在场，却带了：违反
        at("telegram:1", 300 * M, [{ kind: "send", text: "嗯" }]), // 过了 DIARY.ttl：不进分母
      ],
      prompts: [
        card("telegram:1", 50 * M, [`50 分钟前在群里想过：${HURT}`]),
        card("telegram:2", 51 * M, []),
        card("telegram:3", 52 * M, [`半小时前在群里想过：${HURT}`]),
        card(G, 60 * M, [`1 小时前在群里想过：${HURT}`]), // 带进群里：违反
        card("telegram:1", 300 * M, []),
      ],
      dwell: [],
      messages: [
        { scope: G, id: "g1", at: -2 * M, from: "u1" },
        { scope: "telegram:1", id: "d1", at: 49 * M, from: "u1" },
        { scope: "telegram:2", id: "d2", at: 50 * M, from: "u2" },
        { scope: "telegram:3", id: "d3", at: 51 * M, from: "u3" },
      ],
      // 回应模型现编的也算在场。
      replies: [
        { scope: G, at: -M, from: "u2" },
        { scope: G, at: 10 * M, from: "u3" }, // 想过之后才来
      ],
    };
    expect(measure({ type: "carried" }, carry)).toBe(0.5);
    expect(measure({ type: "audience" }, carry)).toBe(2);
    // 带着群里想法、有对应调用的卡片 2 张，她的话和它连着 8 字以上一样的 1 张。
    expect(measure({ type: "repeat-carried", chars: 8 }, carry)).toBe(0.5);
    expect(measure({ type: "audience" }, run)).toBeNull();
  });

  it("reads reply latency, coverage, long absences and group turns against the dataset's sought messages", () => {
    const M = 60_000;
    const DAY0 = NIGHT - 9 * H; // 当地 14 点，醒着
    const visible = (scope: string, at: number) => ({
      ...call(at, "private-triggered", ["send"]),
      scope,
      chatType: scope.startsWith("telegram:-") ? "group" : "private",
    });
    const timing: RunFiles = {
      days: 1,
      calls: [
        visible("telegram:1", DAY0 + 30_000),
        visible("telegram:2", DAY0 + 5 * M),
        visible("telegram:-7", DAY0 + 50 * M),
        visible("telegram:-7", DAY0 + 51 * M), // 90 秒内：同一轮
        visible("telegram:-7", DAY0 + 120 * M),
      ],
      prompts: [],
      dwell: [],
      directed: [
        { scope: "telegram:1", at: DAY0 }, // 30 秒
        { scope: "telegram:2", at: DAY0 }, // 5 分钟：中段
        { scope: "telegram:3", at: DAY0 }, // 没回
        { scope: "telegram:1", at: NIGHT + 4 * H }, // 当地 3 点睡着：不算延迟，算覆盖（没回）
      ],
      groups: ["telegram:-7", "telegram:-8"],
    };
    expect(measure({ type: "latency", what: "mid" }, timing)).toBeCloseTo(1 / 3);
    expect(measure({ type: "coverage" }, timing)).toBe(0.5);
    expect(measure({ type: "coverage", minutes: 4 }, timing)).toBe(0.25);
    // 醒着的可见动作之间隔 4.5、45、1、69 分钟：≥ 30 的两次，≥ 60 的一次。
    expect(measure({ type: "away", minutes: 30 }, timing)).toBe(2);
    expect(measure({ type: "away", minutes: 60 }, timing)).toBe(1);
    // -7 两轮、-8 没说话：平均每群每天 1 轮。
    expect(measure({ type: "group-turns" }, timing)).toBe(1);
    expect(measure({ type: "latency", what: "mid" }, run)).toBeNull();
    expect(measure({ type: "group-turns" }, run)).toBeNull();
  });

  it("reads the delay of replies she actually made: group quotes of someone else's message within a day", () => {
    const M = 60_000;
    const T = NIGHT - 9 * H;
    const quote = (scope: string, at: number, replyTo: string | null, kind = "send") => ({
      ...call(at, "group-floor", []),
      scope,
      chatType: scope.startsWith("telegram:-") ? "group" : "private",
      acts: [{ kind, replyTo }],
    });
    const replies: RunFiles = {
      ...run,
      calls: [
        quote("telegram:-7", T + 1 * M, "a"), // 1 分钟
        quote("telegram:-7", T + 3 * M, "b"), // 2 分钟
        quote("telegram:-7", T + 30 * M, "c"), // 20 分钟
        quote("telegram:-7", T + 31 * M, null), // 没引用：不算
        quote("telegram:-7", T + 32 * M, "x"), // 引用的不在数据集里（回应模型现编的）：不算
        quote("telegram:1", T + 40 * M, "p"), // 私聊：不算（真人口径只有群）
        quote("telegram:-7", T + 26 * H, "a"), // 一天以后：不算
      ],
      messages: [
        { scope: "telegram:-7", id: "a", at: T, from: "u1" },
        { scope: "telegram:-7", id: "b", at: T + 1 * M, from: "u2" },
        { scope: "telegram:-7", id: "c", at: T + 10 * M, from: "u1" },
        { scope: "telegram:1", id: "p", at: T, from: "u1" },
      ],
    };
    expect(measure({ type: "reply-latency", quantile: 0.5 }, replies)).toBe(2);
    expect(measure({ type: "reply-latency", quantile: 0.9 }, replies)).toBe(2);
    expect(measure({ type: "reply-latency", quantile: 1 }, replies)).toBe(20);
    expect(measure({ type: "reply-latency", quantile: 0.9 }, run)).toBeNull();
  });

  it("judges each footprint against its expectation, and pools windows", () => {
    const rows = census(pool([run, run]), [
      {
        mechanism: "pressure.sleep",
        footprint: "去睡之后被叫起来时知道是被吵醒的",
        measure: { type: "in-bed", what: "not-woken" },
        expect: { max: 0 },
        source: "设计",
      },
      {
        mechanism: "pressure-production",
        footprint: "节律叫醒",
        measure: { type: "wake", kind: "group-tick" },
        expect: { min: 1 },
        source: "设计",
      },
    ]);
    expect(rows.map((r) => r.ok)).toEqual([false, true]);
    expect(pool([run, run]).days).toBe(1);
  });

  it("reads the median length of her lines by chat, and reports it without judging", () => {
    const said = (scope: string, chatType: string, texts: string[]) => ({
      ...call(0, "group-floor", []),
      scope,
      chatType,
      acts: texts.map((text) => ({ kind: "send", text })),
    });
    const lines: RunFiles = {
      ...run,
      calls: [
        said("telegram:-7", "group", ["好", "笑死我了", "这个真的太离谱了吧"]),
        said("telegram:1", "private", ["在呢在呢 怎么啦"]),
        { ...call(0, "group-tick", ["sticker"]) },
      ],
    };
    expect(measure({ type: "line-chars", chat: "group" }, lines)).toBe(4);
    expect(measure({ type: "line-chars", chat: "private" }, lines)).toBe(8);
    expect(measure({ type: "line-chars" }, run)).toBeNull();
    const [row] = census(
      lines,
      FOOTPRINTS.filter((f) => f.reportOnly && f.measure.type === "line-chars"),
    );
    expect(row).toMatchObject({ value: 4, ok: null });
    expect(render([row as CensusRow])).toContain("| 4 | 只报 |");
  });

  it("reads windows from several datasets so a thin footprint can pool its samples", () => {
    expect(windowsOf(["b.jsonl", "1", "2", "3", "4", "a.jsonl", "5", "6"])).toEqual([
      { events: "b.jsonl", from: "1", until: "2" },
      { events: "b.jsonl", from: "3", until: "4" },
      { events: "a.jsonl", from: "5", until: "6" },
    ]);
    expect(windowsOf(["1", "2"])).toEqual([]);
    expect(windowsOf(["b.jsonl", "1"])).toEqual([]);
  });
});
