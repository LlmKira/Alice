import { describe, expect, it } from "vitest";
import type { JournaledEvent } from "../src/journal.js";
import { createPressure, memory } from "../src/mechanisms/pressure/index.js";
import { byName, mechanisms } from "../src/mechanisms/registry.js";
import { type Act, affordanceOf, affordances } from "../src/mind/affordances.js";
import type { MessageReceived } from "../src/mind/events.js";
import { Failed } from "../src/mind/failure.js";
import type { Mechanism } from "../src/mind/mechanism.js";
import { createFold, type Folded, Shell, type ShellPorts } from "../src/shell.js";
import type { SpeechFormat } from "../src/speech/decision.js";
import type { SpeechPrompt } from "../src/speech/prompt.js";
import { TelegramActionError } from "../src/telegram/errors.js";
import { modelReply, says } from "./model-reply.js";

const T0 = 1_771_000_000_000;

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

/** 外壳的假端口：时钟手动拨，计时器手动触发，模型和 Telegram 按脚本应答。 */
function harness(options: {
  model?: (prompt: SpeechPrompt) => Promise<string>;
  sendText?: (scope: string, text: string, signal: AbortSignal) => Promise<string>;
  other?: (act: Act) => Promise<void>;
  folded?: Folded;
  query?: ShellPorts["query"];
  mechanisms?: readonly Mechanism[];
  speechOptions?: { format?: SpeechFormat; concisePeople?: boolean };
}) {
  const active = options.mechanisms ?? mechanisms;
  let now = T0;
  let sentIds = 100;
  const journal: JournaledEvent[] = [];
  const timers: Array<{ delayMs: number; fire: () => void; cancelled: boolean }> = [];
  const sends: Array<{ scope: string; text: string; replyTo: string | null }> = [];
  const stickers: Array<{ scope: string; word: string }> = [];
  const others: Array<{ scope: string; act: Act }> = [];
  const prompts: SpeechPrompt[] = [];
  const ports: ShellPorts = {
    now: () => now,
    append: (event) => void journal.push(event),
    journaled: () => {},
    callModel: async (prompt) => {
      prompts.push(prompt);
      return options.model ? options.model(prompt) : modelReply([]);
    },
    act: async (scope, act, signal) => {
      if (act.kind === "send") {
        sends.push({ scope, text: act.text, replyTo: act.replyTo });
        const messageId = options.sendText
          ? await options.sendText(scope, act.text, signal)
          : String(++sentIds);
        return { kind: "posted", messageId };
      }
      if (act.kind === "sticker") {
        stickers.push({ scope, word: act.word });
        return { kind: "posted", messageId: String(++sentIds) };
      }
      others.push({ scope, act });
      if (options.other) await options.other(act);
      if (affordanceOf(act.kind).posts) return { kind: "posted", messageId: String(++sentIds) };
      return { kind: "done" };
    },
    schedule: (delayMs, fire) => {
      const timer = { delayMs, fire, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    background: async () => {
      throw new Failed({ reason: "unavailable" });
    },
    ...(options.query ? { query: options.query } : {}),
    fatal: (error) => {
      throw error;
    },
    log: () => {},
    paused: () => false,
  };
  const shell = new Shell(
    ports,
    active,
    "你是 Alice。",
    options.folded ?? createFold(active).result(),
    10_000,
    null,
    options.speechOptions,
  );
  return {
    shell,
    journal,
    timers,
    sends,
    stickers,
    others,
    prompts,
    advance(ms: number) {
      now += ms;
    },
    /** 触发最后一个没被取消的计时器。 */
    fireTimer() {
      const timer = timers.filter((t) => !t.cancelled).at(-1);
      if (!timer) throw new Error("no armed timer");
      timer.cancelled = true;
      now += timer.delayMs;
      timer.fire();
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe("shell", () => {
  it("waits for quiet, asks the model once, and sends its decision in order", async () => {
    const h = harness({
      model: async () =>
        modelReply([
          { kind: "send", text: "在的", replyTo: "10" },
          { kind: "send", text: "怎么啦", replyTo: null },
          { kind: "sticker", word: "happy" },
        ]),
    });
    h.shell.dispatch(message());

    // patience：私聊等 15 秒安静。
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]?.delayMs).toBe(15_000);
    expect(h.prompts).toHaveLength(0);

    h.fireTimer();
    await settle();

    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]?.system).toContain("你是 Alice。");
    expect(h.prompts[0]?.user).toContain("[10] <池塘> 在吗");
    expect(h.sends).toEqual([
      { scope: "telegram:1", text: "在的", replyTo: "10" },
      { scope: "telegram:1", text: "怎么啦", replyTo: null },
    ]);
    expect(h.stickers).toEqual([{ scope: "telegram:1", word: "happy" }]);
    expect(h.journal.map((e) => e.type)).toEqual([
      "message.received",
      "timer.fired",
      "speech.decided",
      "message.sent",
      "message.sent",
      "message.sent",
    ]);
    expect(h.shell.current.chats["telegram:1"]?.mind).toEqual({ mode: "idle" });
  });

  it("restarts the wait when the other side keeps typing", () => {
    const h = harness({});
    h.shell.dispatch(message());
    h.advance(5_000);
    h.shell.dispatch(message({ messageId: "11", at: T0 + 5_000, text: "有个事" }));

    expect(h.timers).toHaveLength(2);
    expect(h.timers[0]?.cancelled).toBe(true);
    expect(h.timers[1]?.delayMs).toBe(15_000);
  });

  it("does not retry a send whose outcome is unknown and drops the rest of the batch", async () => {
    const h = harness({
      model: async () => says("第一句", "第二句"),
      sendText: async () => {
        throw new Error("socket hang up");
      },
    });
    h.shell.dispatch(message());
    h.fireTimer();
    await settle();

    expect(h.sends).toHaveLength(1);
    expect(h.journal.filter((e) => e.type === "act.failed")).toMatchObject([
      { reason: "outcome_unknown" },
      { reason: "skipped_after_failure" },
    ]);
    // 之后什么也不会再发：没有计时器、没有调用在等。
    await settle();
    expect(h.sends).toHaveLength(1);
    expect(h.timers.filter((t) => !t.cancelled)).toHaveLength(0);
    expect(h.prompts).toHaveLength(1);
  });

  it("records Telegram's own failure code", async () => {
    const h = harness({
      model: async () => says("在的"),
      sendText: async () => {
        throw new TelegramActionError("transport_soft_permanent", "blocked");
      },
    });
    h.shell.dispatch(message());
    h.fireTimer();
    await settle();
    expect(h.journal.at(-1)).toMatchObject({
      type: "act.failed",
      reason: "transport_soft_permanent",
    });
  });

  it("reacts, marks read and leaves through the same path, recording each outcome", async () => {
    const h = harness({
      model: async () =>
        modelReply([
          { kind: "react", messageId: "7", emoji: "👍" },
          { kind: "mark-read" },
          { kind: "send", text: "烦", replyTo: null },
          { kind: "leave-chat" },
        ]),
    });
    h.shell.dispatch(message({ scope: "telegram:-5", chatType: "group", messageId: "7" }));
    h.fireTimer();
    await settle();
    expect(h.others).toEqual([
      { scope: "telegram:-5", act: { kind: "react", messageId: "7", emoji: "👍" } },
      { scope: "telegram:-5", act: { kind: "mark-read" } },
      { scope: "telegram:-5", act: { kind: "leave-chat" } },
    ]);
    expect(h.sends).toEqual([{ scope: "telegram:-5", text: "烦", replyTo: null }]);
    expect(h.journal.map((e) => e.type).slice(-4)).toEqual([
      "act.done",
      "act.done",
      "message.sent",
      "act.done",
    ]);
    expect(h.shell.current.chats["telegram:-5"]?.member).toBe(false);
  });

  it("does not redo a reaction whose outcome is unknown, and skips the rest", async () => {
    const h = harness({
      model: async () =>
        modelReply([
          { kind: "react", messageId: "10", emoji: "👍" },
          { kind: "send", text: "在的", replyTo: null },
        ]),
      other: async () => {
        throw new Error("timeout");
      },
    });
    h.shell.dispatch(message());
    h.fireTimer();
    await settle();
    expect(h.others).toHaveLength(1);
    expect(h.sends).toEqual([]);
    expect(h.journal.filter((e) => e.type === "act.failed")).toMatchObject([
      { reason: "outcome_unknown", act: { kind: "react" } },
      { reason: "skipped_after_failure", act: { kind: "send" } },
    ]);
    await settle();
    expect(h.prompts).toHaveLength(1);
  });

  it("records a failed model call and returns to idle without retrying", async () => {
    const h = harness({
      model: async () => {
        throw new Error("502 bad gateway");
      },
    });
    h.shell.dispatch(message());
    h.fireTimer();
    await settle();

    expect(h.journal.at(-1)).toMatchObject({
      type: "speech.failed",
      reason: "model",
      error: "502 bad gateway",
    });
    expect(h.prompts).toHaveLength(1);
    expect(h.sends).toHaveLength(0);
    expect(h.shell.current.chats["telegram:1"]?.mind).toEqual({ mode: "idle" });
  });

  it("sends only to the chat that was spoken to", async () => {
    // 认群里的那次调用看群里那条话本身（关系事实里私聊也可能写"群里的朋友"）。
    const h = harness({
      model: async (prompt) => (prompt.user.startsWith("Telegram 群聊") ? says("嗯") : says("在")),
    });
    h.shell.dispatch(message());
    h.shell.dispatch(
      message({ scope: "telegram:-5", chatType: "group", messageId: "7", text: "群里@她" }),
    );
    for (const timer of [...h.timers]) {
      timer.cancelled = true;
      timer.fire();
    }
    await settle();

    expect(h.sends).toEqual(
      expect.arrayContaining([
        { scope: "telegram:1", text: "在", replyTo: null },
        { scope: "telegram:-5", text: "嗯", replyTo: null },
      ]),
    );
    expect(h.sends).toHaveLength(2);
  });

  it("records what she notes to herself without Telegram, and remembers it after a restart", async () => {
    const rest = byName(["patience"]);
    const withMemory = [createPressure(affordances, { memory }), ...rest];
    const h = harness({
      mechanisms: withMemory,
      model: async () =>
        modelReply([
          { kind: "send", text: "好呀", replyTo: null },
          { kind: "intend", when: "明天", what: "给你发歌单" },
        ]),
    });
    // 答应的事只有提供它的机制在列时才出现在说明里。
    h.shell.dispatch(message({ text: "在吗，我最近在学吉他" }));
    h.fireTimer();
    await settle();

    expect(h.prompts[0]?.system).toMatch(/ {2}intend: \{/);
    expect(h.sends).toEqual([{ scope: "telegram:1", text: "好呀", replyTo: null }]);
    expect(h.others).toEqual([]);
    expect(h.journal.map((e) => e.type)).toEqual([
      "message.received",
      "timer.fired",
      "speech.decided",
      "act.done",
      "message.sent",
    ]);

    // 重启：从日志 fold 出同样的世界，下一次开口时她还记得。
    const fold = createFold(withMemory);
    for (const event of h.journal) fold.feed(event);
    expect(fold.result().state).toEqual(h.shell.current);
    const again = harness({ mechanisms: withMemory, folded: fold.result() });
    again.shell.dispatch(message({ messageId: "12", at: T0 + 60_000, text: "我回来啦" }));
    again.fireTimer();
    await settle();
    expect(again.prompts[0]?.user).toContain("- 给你发歌单（约在明天）");

    // 没有提供它的机制在列时：SDK 里没有 intend 这一行。
    const plain = harness({
      mechanisms: [createPressure(affordances), ...rest],
    });
    plain.shell.dispatch(message());
    plain.fireTimer();
    await settle();
    expect(plain.prompts[0]?.system).toMatch(/ {2}say: \{/);
    expect(plain.prompts[0]?.system).not.toMatch(/ {2}intend: \{/);
  });

  it("rebuilds the same state from its own journal", async () => {
    const h = harness({ model: async () => says("在的") });
    h.shell.dispatch(message());
    h.fireTimer();
    await settle();
    h.shell.dispatch(message({ messageId: "12", at: T0 + 60_000, text: "那明天见" }));

    const fold = createFold(mechanisms);
    for (const event of h.journal) fold.feed(event);
    const folded = fold.result();
    expect(folded.state).toEqual(h.shell.current);
    expect(folded.timers).toHaveLength(1);
    expect(folded.interrupted).toEqual([]);
  });

  it("re-arms a pending timer and fails an interrupted call on restart, without resending", async () => {
    const fold = createFold(mechanisms);
    fold.feed(message());
    fold.feed(message({ scope: "telegram:2", messageId: "3", senderId: "u2" }));
    fold.feed({
      type: "timer.fired",
      at: T0 + 15_000,
      scope: "telegram:2",
      timerId: "telegram:2~1771000015000",
    });
    const folded = fold.result();
    expect(folded.timers).toMatchObject([{ scope: "telegram:1" }]);
    expect(folded.interrupted).toEqual([{ scope: "telegram:2", callId: "telegram:2#1" }]);

    const h = harness({ model: async () => says("在的"), folded });
    h.shell.start();
    expect(h.journal).toMatchObject([
      { type: "speech.failed", scope: "telegram:2", reason: "interrupted" },
    ]);
    // 重新挂上的等待计时器先登记，之后才是时钟。
    expect(h.timers).toHaveLength(2);
    const rearmed = h.timers[0] as (typeof h.timers)[number];
    rearmed.cancelled = true;
    h.advance(rearmed.delayMs);
    rearmed.fire();
    await settle();
    expect(h.sends).toEqual([{ scope: "telegram:1", text: "在的", replyTo: null }]);
  });

  it("keeps a clock that moves time without journaling it, and stops with the shell", async () => {
    const h = harness({});
    h.shell.start();
    const clock = () => h.timers.filter((t) => !t.cancelled);
    expect(clock()).toHaveLength(1);
    h.fireTimer();
    expect(clock()).toHaveLength(1); // 走了一格，又挂上下一格
    expect(h.journal).toEqual([]); // 时钟不写日志
    await h.shell.stop();
    expect(clock()).toHaveLength(0);
  });

  it("journals the clock ticks that woke her, so folding the journal reproduces that moment", async () => {
    // A mechanism that only ever acts on its own: wakes the chat on a tick, never on a message.
    const onTick: Mechanism = {
      name: "on-tick",
      wake: (_chat, event) => (event.type === "clock.tick" ? 1 : 0),
    };
    const h = harness({ mechanisms: [onTick] });
    h.shell.start();
    h.fireTimer(); // nothing to wake yet: not journaled
    expect(h.journal).toEqual([]);
    h.shell.dispatch(message({ at: T0 + 10_000, directed: false }));
    h.fireTimer();
    await settle();
    const tick = h.journal.find((e) => e.type === "clock.tick");
    expect(tick).toMatchObject({ type: "clock.tick", scope: "telegram:1" });
    expect(h.prompts).toHaveLength(1);
    // Folding only the journal replays the woken tick: same decision state as the live shell.
    const fold = createFold([onTick]);
    for (const e of h.journal) fold.feed(e);
    expect(fold.result().state.chats["telegram:1"]?.mind).toEqual(
      h.shell.current.chats["telegram:1"]?.mind,
    );
    await h.shell.stop();
  });

  it("records a ponder that was in flight at the last stop as failed, so she can ponder again", async () => {
    const folded = createFold(mechanisms).result();
    const h = harness({
      folded: {
        ...folded,
        state: {
          ...folded.state,
          pondering: { callId: "self~reflect@1", kind: "reflect", chat: "telegram:7" },
        },
      },
    });
    h.shell.start();
    expect(h.journal.map((e) => e.type)).toEqual(["ponder.failed"]);
    expect(h.shell.current.pondering).toBeNull();
    await h.shell.stop();
  });

  it("dispatches ponder.failed when a live ponder call fails, so pondering never deadlocks", async () => {
    const group = "telegram:-7";
    const h = harness({
      model: async (prompt) => {
        if (prompt.responseFormat) throw new Error("network: ECONNRESET");
        return modelReply([]);
      },
    });
    const named = (i: number): MessageReceived => ({
      type: "message.received",
      at: T0 + i * 1_000,
      scope: group,
      chatType: "group",
      messageId: `f${i}`,
      senderId: "7",
      senderName: "莉莉丝",
      text: "Alice 你看你的日志",
      contentType: "text",
      replyToMessageId: null,
      directed: true,
    });
    for (let i = 0; i < 4; i++) h.shell.dispatch(named(i));
    await settle();
    h.advance(10 * 60_000);
    h.shell.dispatch({ type: "clock.tick", at: T0 + 10 * 60_000 });
    await settle();
    expect(h.journal.some((e) => e.type === "ponder.failed")).toBe(true);
    expect(h.shell.current.pondering).toBeNull();
    await h.shell.stop();
  });

  it("production reflects through the shell: the call is made, journaled, and the entry reaches a witness's chat", async () => {
    const group = "telegram:-7";
    const dm = "telegram:7";
    const h = harness({
      model: async (prompt) =>
        prompt.responseFormat
          ? '{"entries":[{"about":null,"text":"被当众念日志 好丢人","importance":7}]}'
          : modelReply([]),
    });
    const named = (i: number, scope = group): MessageReceived => ({
      type: "message.received",
      at: T0 + i * 1_000,
      scope,
      chatType: scope === dm ? "private" : "group",
      messageId: `g${i}`,
      senderId: "7",
      senderName: "莉莉丝",
      text: "Alice 你看你的日志",
      contentType: "text",
      replyToMessageId: null,
      directed: true,
    });
    for (let i = 0; i < 4; i++) h.shell.dispatch(named(i));
    await settle();
    h.advance(10 * 60_000);
    h.shell.dispatch({ type: "clock.tick", at: T0 + 10 * 60_000 });
    await settle();
    const done = h.journal.find((e) => e.type === "ponder.done");
    expect(
      done?.type === "ponder.done" && done.ponder.kind === "reflect" && done.ponder.entries,
    ).toEqual([{ about: null, text: "被当众念日志 好丢人", importance: 7 }]);
    const later = T0 + 2 * 24 * 60 * 60_000;
    h.advance(later - T0 - 10 * 60_000);
    h.shell.dispatch({ ...named(9, dm), at: later });
    h.fireTimer(); // 等对方说完（patience）之后才开口
    await settle();
    expect(h.prompts.some((p) => !p.responseFormat && p.user.includes("被当众念日志 好丢人"))).toBe(
      true,
    );
    await h.shell.stop();
  });

  it("ignores new events after stop", async () => {
    const h = harness({});
    await h.shell.stop();
    h.shell.dispatch(message());
    expect(h.journal).toEqual([]);
  });

  it("stop aborts a send still typing, records it and the rest of its batch, and writes nothing after", async () => {
    const h = harness({
      model: async () => says("在的", "怎么啦"),
      // 还在"正在输入"的那几秒：只有停机能让它结束。
      sendText: (_scope, _text, signal) =>
        new Promise((_sent, fail) =>
          signal.addEventListener("abort", () => fail(new Error("abort"))),
        ),
    });
    h.shell.dispatch(message());
    h.fireTimer();
    await settle();
    expect(h.sends.map((s) => s.text)).toEqual(["在的"]);

    await h.shell.stop();
    // 在途的那条不知道发出去没有；同一回剩下的不再做。两条都在 stop 返回之前写进了日志。
    expect(h.journal.filter((e) => e.type === "act.failed")).toMatchObject([
      { reason: "outcome_unknown", act: { kind: "send", text: "在的" } },
      { reason: "skipped_after_failure", act: { kind: "send", text: "怎么啦" } },
    ]);
    const written = h.journal.length;
    await settle();
    expect(h.journal).toHaveLength(written);
  });

  it("executes inline PTC queries inside run_code, journals inline act.done, and does not double-wake", async () => {
    const h = harness({
      model: async () =>
        JSON.stringify({
          content: "",
          calls: [
            {
              name: "run_code",
              arguments: JSON.stringify({
                code: [
                  'const hits = await tools.search_album({ query: "猫" });',
                  "if (hits.length > 0) {",
                  "  await tools.send_photo({ asset: hits[0].asset });",
                  '  await tools.say({ text: "发给你" });',
                  "}",
                ].join("\n"),
              }),
            },
          ],
        }),
      query: async (_scope, kind) => {
        expect(kind).toBe("album-search");
        return {
          value: [
            {
              asset: "p12345",
              description: "一只橘猫",
              caption: null,
              sender: "阿岚",
              ago: "刚才",
            },
          ],
          result: "[p12345] 一只橘猫",
        };
      },
    });
    h.shell.dispatch(message());
    h.fireTimer();
    await settle();
    expect(h.prompts).toHaveLength(1);
    expect(h.journal.filter((e) => e.type === "act.done")).toMatchObject([
      { act: { kind: "album-search", query: "猫" }, result: "[p12345] 一只橘猫", inline: true },
    ]);
    expect(h.others).toEqual([
      { scope: "telegram:1", act: { kind: "album-send", asset: "p12345" } },
    ]);
    expect(h.sends.map((s) => s.text)).toEqual(["发给你"]);
  });

  it("keeps caught look_up failures inline without double-waking", async () => {
    const h = harness({
      model: async () =>
        JSON.stringify({
          content: "",
          calls: [
            {
              name: "run_code",
              arguments: JSON.stringify({
                code: [
                  "try {",
                  '  await tools.look_up({ task: "天气" });',
                  "} catch {",
                  '  await tools.say({ text: "查不到天气" });',
                  "}",
                ].join("\n"),
              }),
            },
          ],
        }),
      query: async () => {
        throw new Failed({ reason: "unavailable" });
      },
    });
    h.shell.dispatch(message());
    h.fireTimer();
    await settle();
    expect(h.prompts).toHaveLength(1);
    expect(h.journal.filter((e) => e.type === "act.failed")).toMatchObject([
      { act: { kind: "delegate", task: "天气" }, reason: "unavailable", inline: true },
    ]);
    expect(h.sends.map((s) => s.text)).toEqual(["查不到天气"]);
  });

  it("wakes once after an uncaught inline look_up failure so prior say does not leave user hanging", async () => {
    let round = 0;
    const h = harness({
      model: async () => {
        round += 1;
        if (round === 1) {
          return JSON.stringify({
            content: "",
            calls: [
              {
                name: "run_code",
                arguments: JSON.stringify({
                  code: [
                    'await tools.say({ text: "等我查一下" });',
                    'const r = await tools.look_up({ task: "天气" });',
                    "await tools.say({ text: r });",
                  ].join("\n"),
                }),
              },
            ],
          });
        }
        return says("刚刚没查到");
      },
      query: async () => {
        throw new Failed({ reason: "unavailable" });
      },
    });
    h.shell.dispatch(message());
    h.fireTimer();
    await settle();
    expect(h.prompts).toHaveLength(2);
    expect(h.prompts[1]?.user).toContain("没结果");
    expect(h.journal.filter((e) => e.type === "act.failed")).toMatchObject([
      { act: { kind: "delegate", task: "天气" }, reason: "unavailable" },
    ]);
    expect(h.sends.map((s) => s.text)).toEqual(["等我查一下", "刚刚没查到"]);
  });

  it("wakes once after look_up succeeds when no outward act followed it in the same run_code", async () => {
    let round = 0;
    const h = harness({
      model: async () => {
        round += 1;
        if (round === 1) {
          return JSON.stringify({
            content: "",
            calls: [
              {
                name: "run_code",
                arguments: JSON.stringify({
                  code: [
                    'await tools.inner({ thought: "查一下歌词" });',
                    'const res = await tools.look_up({ task: "奢香夫人 歌词" });',
                  ].join("\n"),
                }),
              },
            ],
          });
        }
        return says("下一句是你来过，年华被传说");
      },
      query: async () => ({
        value: "下一句：你来过，年华被传说",
        result: "《奢香夫人》下一句：你来过，年华被传说",
      }),
    });
    h.shell.dispatch(message());
    h.fireTimer();
    await settle();
    expect(h.prompts).toHaveLength(2);
    expect(h.prompts[1]?.user).toContain("你来过，年华被传说");
    expect(
      h.journal.filter((e) => e.type === "act.done" && e.act.kind === "delegate"),
    ).toHaveLength(1);
    expect(h.sends.map((s) => s.text)).toEqual(["下一句是你来过，年华被传说"]);
  });

  it("forwards concisePeople into native mode initial prompts", async () => {
    const h = harness({
      speechOptions: { format: "native", concisePeople: true },
      model: async () =>
        JSON.stringify({
          content: "",
          calls: [{ name: "say", arguments: JSON.stringify({ text: "在呢" }) }],
        }),
    });
    h.shell.dispatch(message());
    h.fireTimer();
    await settle();
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]?.user).not.toContain("手头没记着以前的具体往事");
    expect(h.sends.map((s) => s.text)).toEqual(["在呢"]);
  });
});
