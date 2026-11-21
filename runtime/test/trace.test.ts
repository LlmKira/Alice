import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, initDb } from "../src/db/connection.js";
import { appendEvent, type JournaledEvent } from "../src/journal.js";
import { patience } from "../src/mechanisms/patience.js";
import { lensOf, productionWorld } from "../src/mechanisms/pressure/explain.js";
import { PRODUCTION, willAffordances, willOf } from "../src/mechanisms/pressure/index.js";
import { intentionsFor, rankIntentions } from "../src/mechanisms/pressure/will.js";
import { productionMechanisms } from "../src/mechanisms/registry.js";
import { affordances } from "../src/mind/affordances.js";
import type { AliceEvent, MessageReceived } from "../src/mind/events.js";
import type { Mechanism } from "../src/mind/mechanism.js";
import { NOISE_EVERY_MS } from "../src/mind/noise.js";
import { type AliceState, emptyState } from "../src/mind/state.js";
import { step } from "../src/mind/step.js";
import { noiseSource } from "../src/noise-source.js";
import { readJournal, summarize, trace, type WakeLine } from "../src/sim/trace.js";
import { traceRow } from "../src/trace-log.js";

const MIN = 60_000;
/** 2026-02-20 本地（东八区）下午两点：醒着。 */
const T0 = Date.UTC(2026, 1, 19, 16) + 14 * 60 * MIN;
const DM = "telegram:1";
const GROUP = "telegram:-5";

function message(at: number, scope: string, directed: boolean, n: number): MessageReceived {
  return {
    type: "message.received",
    at,
    scope,
    chatType: scope === DM ? "private" : "group",
    messageId: `m${n}`,
    senderId: scope === DM ? "u1" : `u${2 + (n % 3)}`,
    senderName: scope === DM ? "池塘" : `群友${n % 3}`,
    text: directed && scope === GROUP ? "@alice 你说呢" : "今天好热",
    contentType: "text",
    replyToMessageId: null,
    directed,
  };
}

/**
 * 一个小外壳：和 Shell.dispatch 同样只把引起了副作用的时钟格写进日志，发言调用 2 秒后按脚本回来
 * （单数轮说一句，双数轮不说），计时器到点触发，随机数每 5 分钟一组。返回写进日志的事件。
 */
function liveJournal(mechanisms: readonly Mechanism[]): JournaledEvent[] {
  const inputs: AliceEvent[] = [];
  let n = 0;
  for (let t = T0; t < T0 + 150 * MIN; t += 7 * MIN) {
    inputs.push(message(t + 13, GROUP, false, n++));
    inputs.push(message(t + 2 * MIN + 17, GROUP, false, n++));
  }
  inputs.push(message(T0 + 5 * MIN + 31, DM, true, n++));
  inputs.push(message(T0 + 40 * MIN + 31, GROUP, true, n++));
  inputs.push(message(T0 + 70 * MIN + 31, DM, true, n++));
  const draw = noiseSource(7);
  for (let t = T0; t < T0 + 3 * 60 * MIN; t += NOISE_EVERY_MS) {
    inputs.push({ type: "noise.drawn", at: t + 3, scope: "self", draws: draw() });
  }
  for (let t = T0; t < T0 + 3 * 60 * MIN; t += 10_000) inputs.push({ type: "clock.tick", at: t });
  const queue = inputs.sort((a, b) => a.at - b.at);
  const push = (e: AliceEvent) => {
    const i = queue.findIndex((q) => q.at > e.at);
    queue.splice(i < 0 ? queue.length : i, 0, e);
  };
  const journal: JournaledEvent[] = [];
  let state: AliceState = emptyState;
  let calls = 0;
  let sent = 0;
  for (let e = queue.shift(); e; e = queue.shift()) {
    const r = step(state, e, mechanisms);
    state = r.state;
    if (e.type !== "clock.tick") journal.push(e);
    else if (r.effects[0]) journal.push({ ...e, scope: r.effects[0].scope });
    for (const effect of r.effects) {
      if (effect.type === "call-speech") {
        const speak = calls++ % 2 === 0;
        push({
          type: "speech.decided",
          at: e.at + 2000,
          scope: effect.scope,
          callId: effect.callId,
          decision: {
            acts: speak ? [{ kind: "send", text: "嗯嗯", replyTo: null }] : [],
          },
        });
      } else if (effect.type === "set-timer") {
        push({ type: "timer.fired", at: effect.at, scope: effect.scope, timerId: effect.timerId });
      } else if (effect.type === "act" && effect.act.kind === "send") {
        push({
          type: "message.sent",
          at: e.at + 500,
          scope: effect.scope,
          messageId: `s${sent++}`,
          text: effect.act.text,
          kind: "text",
        });
      }
    }
  }
  return journal;
}

const dir = mkdtempSync(join(tmpdir(), "alice-trace-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** 生产；去掉等对方说完（被点名时当场叫醒，理由直接是 directed）。 */
const CONFIGS: Array<[string, readonly Mechanism[]]> = [
  ["production", productionMechanisms(true)],
  ["without patience", productionMechanisms(true).filter((m) => m !== patience)],
];

describe.each(CONFIGS)("trace (%s)", (name, mechanisms) => {
  const db = join(dir, `${name}.db`);
  const written = liveJournal(mechanisms);
  initDb(db);
  for (const e of written) appendEvent(e);
  closeDb();
  const before = hash(db);
  chmodSync(db, 0o444);
  const { events } = readJournal(db);
  const { lines, fidelity } = trace(events, { top: 3, runs: [], mechanisms });
  const wakes = lines.filter((l): l is WakeLine => l.kind === "wake");

  it("never writes the Journal: it reads a read-only file and leaves its bytes unchanged", () => {
    expect(events.length).toBe(written.length);
    expect(hash(db)).toBe(before);
  });

  it("replays the same calls the journal recorded outcomes for", () => {
    expect(wakes.length).toBeGreaterThan(5);
    expect(fidelity.unmatched).toBe(0);
    expect(fidelity.unanswered).toBe(0);
    expect(fidelity.replayedCalls).toBe(fidelity.journalOutcomes);
    expect(wakes.every((l) => l.outcome !== null)).toBe(true);
    expect(wakes.some((l) => l.trigger === "will")).toBe(true);
    expect(wakes.some((l) => (l.cause ?? l.trigger) === "directed")).toBe(true);
  });

  it("reads the same ranking and wake reason as calling the will layer directly", () => {
    const policy = willOf(PRODUCTION);
    const deliberate = willAffordances(affordances);
    let state: AliceState = emptyState;
    let checked = 0;
    for (const e of events) {
      state = step(state, e, mechanisms).state;
      const world = productionWorld(state);
      for (const l of wakes.filter((w) => w.at === e.at)) {
        const ranked = rankIntentions(world, deliberate, e.at, policy).slice(0, 3);
        expect(l.will.top.map((c) => [c.scope, c.act, c.nsv])).toEqual(
          ranked.map((i) => [i.scope, i.affordance, i.nsv]),
        );
        if (l.trigger === "will") {
          expect(l.scope).toBe(ranked[0]?.scope);
          expect(l.woke?.nsv).toBe(ranked[0]?.nsv);
        }
        if (l.trigger === "directed" || l.trigger === "floor") {
          const best = Math.max(
            ...intentionsFor(world, deliberate, l.scope, e.at, policy).map((i) => i.nsv),
          );
          expect(l.woke?.nsv).toBe(best);
        }
        for (const c of l.will.top) {
          const busy = Object.values(c.busy).reduce((a, b) => a + b, 0);
          expect(c.nsv).toBeCloseTo(
            c.relief - c.lambda * (c.social + c.saturation.total) - busy,
            9,
          );
          const relieved = Object.values(c.drives).reduce((a, d) => a + (d?.relief ?? 0), 0);
          expect(c.relief).toBeCloseTo(relieved * c.gain, 9);
        }
        checked++;
      }
    }
    expect(checked).toBe(wakes.length);
  });

  it("summarises every wake once, by chat type and by drive", () => {
    const s = summarize(lines);
    expect(s.wakes).toBe(wakes.length);
    const byType = Object.values(s.byChatType).reduce((a, t) => a + t.wakes, 0);
    const byDrive = Object.values(s.byDrive).reduce((a, n) => a + n, 0);
    expect(byType).toBe(wakes.length);
    expect(byDrive).toBe(wakes.length);
  });
});

describe("live trace snapshot", () => {
  const mechanisms = productionMechanisms(true);
  const events = liveJournal(mechanisms);

  it("only reads: the state is unchanged and stepping on gives the same result", () => {
    let plain: AliceState = emptyState;
    let watched: AliceState = emptyState;
    for (const e of events) {
      plain = step(plain, e, mechanisms).state;
      watched = step(watched, e, mechanisms).state;
      const json = JSON.stringify(watched);
      const row = traceRow(deepFreeze(watched), e.at, "test");
      expect(JSON.stringify(watched)).toBe(json);
      expect(row.top).toBeDefined();
    }
    expect(JSON.stringify(watched)).toBe(JSON.stringify(plain));
    expect(lensOf().affordances.length).toBeGreaterThan(0);
  });
});

/** 冻住整份状态：快照里任何一处改写都会在严格模式下抛错。 */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
