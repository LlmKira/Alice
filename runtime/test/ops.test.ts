import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JournaledEvent } from "../src/journal.js";
import { ErrandError, runErrand } from "../src/llm/errand.js";
import { createGateway, type Spent } from "../src/llm/gateway.js";
import { MINIMAX_MODEL, synthesizeMinimax } from "../src/llm/tts.js";
import { mechanisms } from "../src/mechanisms/registry.js";
import type { AliceEvent, MessageReceived } from "../src/mind/events.js";
import { type CallFailure, Failed, type FailureCode } from "../src/mind/failure.js";
import { emptyState } from "../src/mind/state.js";
import { parseOperatorCommand } from "../src/ops/control.js";
import { gated } from "../src/ops/gate.js";
import { Operator } from "../src/ops/operator.js";
import { SpendMeter } from "../src/ops/spend.js";
import { WATCH, Watch } from "../src/ops/watch.js";
import { createFold, Shell, type ShellPorts } from "../src/shell.js";
import { modelReply, says } from "./model-reply.js";

const T0 = 1_771_000_000_000;
const OPERATOR = "900";

const spent = (kind: Spent["kind"], usd: number): Spent => ({
  kind,
  usd,
  model: "m",
  credits: null,
  promptTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
});

function message(overrides: Partial<MessageReceived> = {}): MessageReceived {
  return {
    type: "message.received",
    at: T0,
    scope: "telegram:1",
    chatType: "private",
    messageId: "10",
    senderId: "u1",
    senderName: "池塘",
    text: "在吗",
    contentType: "text",
    replyToMessageId: null,
    directed: true,
    ...overrides,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** 可拨的暂停开关（Operator 的那一面）。 */
function pauseSwitch() {
  const listeners: Array<() => void> = [];
  let paused = false;
  return {
    get paused() {
      return paused;
    },
    set paused(value: boolean) {
      const pausing = value && !paused;
      paused = value;
      if (pausing) for (const listener of listeners) listener();
    },
    onPause: (listener: () => void) => void listeners.push(listener),
  };
}

/** 外壳的假端口，经暂停闸门（ops/gate.ts），加一个可拨的暂停开关。 */
function harness(
  model: () => Promise<string> = async () => says("在的"),
  background: ShellPorts["background"] = async () => {
    throw new Failed({ reason: "unavailable" });
  },
) {
  const control = pauseSwitch();
  let now = T0;
  let ids = 100;
  const journal: JournaledEvent[] = [];
  const timers: Array<{ delayMs: number; fire: () => void; cancelled: boolean }> = [];
  const sends: string[] = [];
  let calls = 0;
  const ports: ShellPorts = gated(
    {
      now: () => now,
      append: (event) => void journal.push(event),
      journaled: () => {},
      callModel: async () => {
        calls++;
        return model();
      },
      act: async (_scope, act) => {
        if (act.kind === "send") sends.push(act.text);
        return { kind: "posted", messageId: String(++ids) };
      },
      schedule: (delayMs, fire) => {
        const timer = { delayMs, fire, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      background,
      fatal: (error) => {
        throw error;
      },
      log: () => {},
      paused: () => control.paused,
    },
    control,
  );
  const shell = new Shell(ports, mechanisms, "你是 Alice。", createFold(mechanisms).result());
  return {
    shell,
    control,
    journal,
    sends,
    calls: () => calls,
    fireTimer() {
      const timer = timers.filter((t) => !t.cancelled).at(-1);
      if (!timer) throw new Error("no armed timer");
      timer.cancelled = true;
      now += timer.delayMs;
      timer.fire();
    },
  };
}

describe("clean start", () => {
  it("an empty world starts with only the clock armed and runs a day of ticks without error", async () => {
    let now = T0;
    const armed: Array<{ at: number; fire: () => void; cancelled: boolean }> = [];
    const journal: JournaledEvent[] = [];
    const calls: string[] = [];
    const ports: ShellPorts = {
      now: () => now,
      append: (event) => void journal.push(event),
      journaled: () => {},
      callModel: async (_prompt, call) => {
        calls.push(call.kind);
        return modelReply([]);
      },
      act: async () => ({ kind: "done" }),
      background: async () => {
        throw new Failed({ reason: "unavailable" });
      },
      paused: () => false,
      schedule: (delayMs, fire) => {
        const timer = { at: now + delayMs, fire, cancelled: false };
        armed.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      fatal: (error) => {
        throw error;
      },
      log: () => {},
    };
    const shell = new Shell(ports, mechanisms, "你是 Alice。", createFold(mechanisms).result());
    shell.start();
    expect(armed.filter((t) => !t.cancelled)).toHaveLength(1);
    expect(journal).toEqual([]);
    for (let i = 0; i < 8_640; i++) {
      const next = armed.find((t) => !t.cancelled);
      if (!next) break;
      next.cancelled = true;
      now = next.at;
      next.fire();
      await Promise.resolve();
    }
    await settle();
    // 空世界里没人可找：不调模型，不对外做任何事。
    expect(calls).toEqual([]);
    expect(journal.every((e) => e.type === "clock.tick")).toBe(true);
    await shell.stop();
    expect(armed.filter((t) => !t.cancelled)).toEqual([]);
  });
});

describe("operator pause in the shell", () => {
  it("keeps writing what comes in, calls no model, sends nothing, and redoes nothing on resume", async () => {
    const h = harness();
    h.control.paused = true;
    h.shell.dispatch(message());
    h.fireTimer();
    await settle();

    expect(h.calls()).toBe(0);
    expect(h.sends).toEqual([]);
    expect(h.journal.map((e) => e.type)).toEqual([
      "message.received",
      "timer.fired",
      "speech.failed",
    ]);
    expect(h.journal.at(-1)).toMatchObject({ reason: "paused" });
    // 先写日志再 step：从 Journal 折叠出的状态就是运行中的状态。
    const fold = createFold(mechanisms);
    for (const event of h.journal) fold.feed(event);
    expect(fold.result().state).toEqual(h.shell.current);

    h.control.paused = false;
    await settle();
    expect(h.calls()).toBe(0);
    expect(h.sends).toEqual([]);
  });

  it("a decision that comes back after the pause is recorded as not done, never sent later", async () => {
    let answer: (raw: string) => void = () => {};
    const h = harness(() => new Promise((resolve) => (answer = resolve)));
    h.shell.dispatch(message());
    h.fireTimer();
    await settle();
    expect(h.calls()).toBe(1);

    h.control.paused = true;
    answer(says("在的", "怎么啦"));
    await settle();
    expect(h.sends).toEqual([]);
    // 端口拒绝了第一条；同一回剩下的按普通失败的规则不再做。
    expect(h.journal.filter((e) => e.type === "act.failed")).toMatchObject([
      { reason: "paused", act: { kind: "send", text: "在的" } },
      { reason: "skipped_after_failure", act: { kind: "send", text: "怎么啦" } },
    ]);

    h.control.paused = false;
    await settle();
    expect(h.sends).toEqual([]);
  });

  it("a lookup still running when she is paused stops spending: it is aborted and recorded as paused", async () => {
    let seen: AbortSignal | null = null;
    const h = harness(
      async () =>
        modelReply([
          { kind: "send", text: "等我一下", replyTo: null },
          { kind: "delegate", task: "明天上海的天气" },
        ]),
      (_scope, _act, _context, signal) =>
        new Promise((_done, fail) => {
          seen = signal;
          signal.addEventListener("abort", () => fail(signal.reason));
        }),
    );
    h.shell.dispatch(message({ text: "帮我查下明天上海天气" }));
    h.fireTimer();
    await settle();
    expect(h.journal.map((e) => e.type)).toContain("act.started");
    expect(seen).not.toBeNull();

    h.control.paused = true;
    await settle();
    expect(h.journal.find((e) => e.type === "act.failed")).toMatchObject({
      act: { kind: "delegate" },
      reason: "paused",
    });
  });
});

function operatorHarness(dir = mkdtempSync(join(tmpdir(), "alice-ops-")), start = T0) {
  let now = start;
  const told: string[] = [];
  let stopped = 0;
  const spend = new SpendMeter(join(dir, "spend"), () => now);
  const operator = new Operator(
    {
      now: () => now,
      send: async (text) => void told.push(text),
      stop: () => void stopped++,
      state: () => emptyState,
      log: () => {},
      selftest: async () => "贴纸：发出去了\n语音：发出去了",
    },
    { operatorId: OPERATOR, controlPath: join(dir, "ops-control.json"), spend, capUsd: 3 },
  );
  return {
    dir,
    operator,
    spend,
    told,
    stopped: () => stopped,
    advance(ms: number) {
      now += ms;
    },
  };
}

const command = (text: string, overrides: Partial<MessageReceived> = {}): MessageReceived =>
  message({ senderId: OPERATOR, scope: `telegram:${OPERATOR}`, text, ...overrides });

describe("operator control", () => {
  it("only the operator's private /ops messages are commands; they never reach her timeline", async () => {
    const o = operatorHarness();
    expect(o.operator.intercept(command("/ops pause"))).toBe(true);
    await settle();
    expect(o.operator.paused).toBe(true);
    // 别人发同样的字、操作员在群里发、操作员平常说话：都是普通消息。
    expect(o.operator.intercept(message({ text: "/ops resume" }))).toBe(false);
    expect(o.operator.intercept(command("/ops resume", { chatType: "group" }))).toBe(false);
    expect(o.operator.intercept(command("在吗"))).toBe(false);
    expect(o.operator.paused).toBe(true);
    // 前缀对了、动词认不出：还是命令（回帮助），不漏进时间线。
    expect(o.operator.intercept(command("/ops 嗯？"))).toBe(true);
    expect(parseOperatorCommand("/opsx status")).toBeNull();
  });

  it("/ops selftest tells the operator whether a sticker and a voice note went out", async () => {
    const o = operatorHarness();
    expect(o.operator.intercept(command("/ops selftest"))).toBe(true);
    await settle();
    expect(o.told.at(-1)).toBe("贴纸：发出去了\n语音：发出去了");
    expect(parseOperatorCommand("/ops 自检")).toEqual({ verb: "selftest" });
  });

  it("a pause survives a restart", async () => {
    const o = operatorHarness();
    o.operator.intercept(command("/ops pause"));
    await settle();
    expect(operatorHarness(o.dir).operator.paused).toBe(true);
  });

  it("reaching the daily cap pauses once and tells the operator; resume waits for a higher cap", async () => {
    const o = operatorHarness();
    o.operator.charge(spent("speech", 2.5));
    expect(o.operator.paused).toBe(false);
    o.operator.charge(spent("speech", 0.6));
    o.operator.charge(spent("ponder", 0.1));
    await settle();
    expect(o.operator.paused).toBe(true);
    expect(o.told).toHaveLength(1);

    o.operator.intercept(command("/ops resume"));
    await settle();
    expect(o.operator.paused).toBe(true);

    o.operator.intercept(command("/ops cap 5"));
    o.operator.intercept(command("/ops resume"));
    await settle();
    expect(o.operator.paused).toBe(false);
    expect(o.operator.status()).toContain("$3.20 / 上限 $5.00");
  });

  it("the day's spend survives a restart and starts over the next day", () => {
    const o = operatorHarness();
    o.operator.charge(spent("speech", 1.25));
    o.operator.charge(spent("image", 0.25));
    expect(operatorHarness(o.dir).spend.today().total).toBeCloseTo(1.5);
    expect(operatorHarness(o.dir, T0 + 24 * 3_600_000).spend.today().total).toBe(0);
  });

  it("speech synthesis is charged to the day's spend (it used to go uncounted)", async () => {
    const o = operatorHarness();
    const gateway = createGateway({ apiKey: "k", charge: (s) => o.operator.charge(s) });
    const rate = 24_000;
    const bytes = rate / 5; // 0.1 秒 WAV
    const wav = Buffer.alloc(44 + bytes);
    wav.write("RIFF", 0, "ascii");
    wav.writeUInt32LE(36 + bytes, 4);
    wav.write("WAVEfmt ", 8, "ascii");
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(rate, 24);
    wav.writeUInt32LE(rate * 2, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36, "ascii");
    wav.writeUInt32LE(bytes, 40);
    const voice = await synthesizeMinimax(
      {
        baseUrl: "https://api.minimaxi.com",
        apiKey: "mk",
        model: MINIMAX_MODEL,
        voice: "Calm_Woman",
        groupId: null,
      },
      "嗯",
      {
        charge: gateway.charge,
        fetch: async () =>
          Response.json({
            data: { audio: wav.toString("hex"), status: 2 },
            extra_info: { usage_characters: 10 },
          }),
      },
    );
    expect(voice.seconds).toBeCloseTo(0.1);
    expect(o.spend.today().calls.tts).toBe(1);
    expect(o.spend.today().usd.tts).toBeCloseTo(((10 / 10_000) * 3.5) / 7.2);
  });

  it("an errand is charged call by call, so the cap stops spending while it is still running", async () => {
    const o = operatorHarness();
    let steps = 0;
    const gateway = createGateway({
      apiKey: "k",
      charge: (s) => o.operator.charge(s),
      fetch: async () => {
        steps++;
        // 每步 3.1 美元：第一步之后就到了上限，此时这件事还没办完（最后也没办成）。
        if (steps === 1) expect(o.spend.today().calls.errand).toBe(0);
        return Response.json(
          { choices: [{ message: { role: "assistant", content: "" } }] },
          { headers: { "x-cost-credits": String(3.1 * 250_000) } },
        );
      },
    });
    const failed = await runErrand("查一下", null, { gateway, exaKey: "e", now: T0 }).catch(
      (e: unknown) => e,
    );
    expect(failed).toBeInstanceOf(ErrandError);
    expect(o.spend.today().calls.errand).toBe(steps);
    expect(o.spend.today().usd.errand).toBeCloseTo(3.1 * steps);
    expect(o.operator.paused).toBe(true);
  });

  it("stop answers the operator, then stops", async () => {
    const o = operatorHarness();
    o.operator.intercept(command("/ops stop"));
    await settle();
    expect(o.told).toHaveLength(1);
    expect(o.stopped()).toBe(1);
  });
});

describe("self-check alerts", () => {
  it("are rate limited and carry the count of what was held back", () => {
    let now = T0;
    const sent: string[] = [];
    const watch = new Watch(
      () => now,
      (text) => void sent.push(text),
    );
    const failed = (reason: Exclude<FailureCode, "errand">): AliceEvent => ({
      type: "act.failed",
      at: now,
      scope: "telegram:1",
      act: { kind: "send", text: "x", replyTo: null },
      reason,
    });
    for (let i = 0; i < 10; i++) watch.observe(failed("outcome_unknown"));
    // 她自己选错的贴纸、暂停时没做的、加群等审批、找群额度用完、私聊不收陌生人、受众规则：不是送达问题。
    for (const choice of [
      "invalid_sticker_keyword",
      "paused",
      "join_requested",
      "too_often",
      "private_closed",
      "peer_flood",
      "not_shareable",
    ] as const) {
      watch.observe(failed(choice));
    }
    expect(watch.recent.map((f) => f.reason)).not.toContain("join_requested");
    expect(sent).toHaveLength(1);
    now += WATCH.perKindMs;
    watch.observe(failed("refused"));
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("9 次");
  });

  it("speech failing in a row is reported once; pauses and restarts do not count", () => {
    const sent: string[] = [];
    const watch = new Watch(
      () => T0,
      (text) => void sent.push(text),
    );
    const failed = (reason: CallFailure): AliceEvent => ({
      type: "speech.failed",
      at: T0,
      scope: "telegram:1",
      callId: "c",
      reason,
      ...(reason === "model" ? { error: "502 bad gateway" } : {}),
    });
    watch.observe(failed("paused"));
    watch.observe(failed("interrupted"));
    watch.observe(failed("model"));
    watch.observe(failed("model"));
    expect(sent).toHaveLength(0);
    watch.observe(failed("model"));
    watch.observe(failed("model"));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("502 bad gateway");
  });

  it("a short reconnect is not news; a long one is", () => {
    let now = T0;
    const sent: string[] = [];
    const watch = new Watch(
      () => now,
      (text) => void sent.push(text),
    );
    watch.connection("connecting");
    now += 5_000;
    watch.connection("connected");
    expect(sent).toHaveLength(0);
    watch.connection("offline");
    now += 5 * 60_000;
    expect(watch.connected).toBe(false);
    watch.connection("connected");
    expect(sent).toHaveLength(1);
  });
});
