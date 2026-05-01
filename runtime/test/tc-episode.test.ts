/**
 * Structured block episode 测试。
 *
 * 当前语义：
 * - `afterward=watching` + host 观察到新本地 observations → 同一 tick 内续轮
 * - `afterward=watching` 但 host 没有拿到新本地 observations → 返回 inter-episode watching
 * - `done` + 运行/指令错误 + 未完成副作用 → 同一 tick 内自纠续轮
 * - 已完成真实副作用 → 不在同一 tick 自纠，避免重复动作
 * - `waiting_reply` / `resting` / `fed_up` / `cooling_down` 直接终止
 */
import { describe, expect, it, vi } from "vitest";
import { createBlackboard } from "../src/engine/tick/blackboard.js";
import type { TickExecutionResult } from "../src/engine/tick/callLLM.js";
import type { TickDeps } from "../src/engine/tick/tick.js";
import { tick } from "../src/engine/tick/tick.js";

function makeBoard(maxSteps = 3) {
  return createBlackboard({
    pressures: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
    voice: "test",
    target: null,
    features: {
      hasWeather: true,
      hasMusic: false,
      hasBrowser: false,
      hasTTS: false,
      hasStickers: false,
      hasBots: false,
      hasSystemThreads: false,
      hasVideo: false,
    },
    contextVars: {},
    maxSteps,
  });
}

function makeExecResult(overrides: Partial<TickExecutionResult> = {}): TickExecutionResult {
  return {
    afterward: "done",
    toolCallCount: 0,
    assistantTurnCount: 1,
    bashCallCount: 1,
    signalCallCount: 0,
    budgetExhausted: false,
    rawScript: "",
    commandOutput: "",
    logs: [],
    errors: [],
    instructionErrors: [],
    errorCodes: [],
    duration: 0,
    thinks: [],
    queryLogs: [],
    observations: [],
    completedActions: [],
    silenceReason: null,
    ...overrides,
  };
}

function makeDeps(steps: Array<TickExecutionResult | null>, promptRounds: number[] = []): TickDeps {
  let callCount = 0;
  return {
    buildPrompt: vi.fn(async (_board, _tools, ctx) => {
      promptRounds.push(ctx.episodeRound ?? 0);
      return { system: "sys", user: "usr" };
    }),
    callLLM: vi.fn(async () => {
      const step = steps[callCount] ?? null;
      callCount++;
      return step;
    }),
  };
}

const BASE_CTX = {
  G: {
    has: () => false,
    getChannel: () => ({ chat_type: "private" }),
    getEntitiesByType: () => [],
    getContact: () => ({}),
    getDynamic: () => null,
  } as never,
  dispatcher: { mods: [], readModState: () => null } as never,
  mods: [],
  config: { peripheral: { perChannelCap: 3, totalCap: 5, minTextLength: 10 } } as never,
  item: { action: "conversation", target: null, facetId: "core" } as never,
  tick: 1,
  messages: [],
  observations: [],
  round: 0,
  client: null,
  runtimeConfig: {} as never,
};

describe("structured block episode continuation", () => {
  it("单轮（done）：episodeRounds=0，outcome=terminal", async () => {
    const board = makeBoard();
    const promptRounds: number[] = [];
    const deps = makeDeps(
      [
        makeExecResult({
          rawScript: "echo hi",
          commandOutput: "$ echo hi\nhi",
          logs: ["hi"],
        }),
      ],
      promptRounds,
    );

    const result = await tick(board, [], deps, BASE_CTX);

    expect(result.outcome).toBe("terminal");
    expect(result.episodeRounds).toBe(0);
    expect(promptRounds).toEqual([0]);
    expect(deps.callLLM).toHaveBeenCalledTimes(1);
  });

  it("无可执行命令的 typed silence 直接终止，不触发同 tick 续轮", async () => {
    const board = makeBoard(3);
    const promptRounds: number[] = [];
    const deps = makeDeps(
      [
        makeExecResult({
          rawScript: "# 只是想想\n# 先不说话",
          afterward: "done",
          bashCallCount: 0,
          commandOutput: "$ # 只是想想\n# 先不说话\n(no executable command; treated as silence)",
          thinks: ["只是想想", "先不说话"],
          silenceReason: "no_executable_script",
        }),
      ],
      promptRounds,
    );

    const result = await tick(board, [], deps, BASE_CTX);

    expect(result.outcome).toBe("terminal");
    expect(result.episodeRounds).toBe(0);
    expect(result.execution.silenceReason).toBe("no_executable_script");
    expect(result.execution.completedActions).toEqual([]);
    expect(result.execution.errors).toEqual([]);
    expect(result.tcMeta?.hostContinuationTrace).toBeUndefined();
    expect(promptRounds).toEqual([0]);
    expect(deps.callLLM).toHaveBeenCalledTimes(1);
  });

  it("afterward=watching + typed query_result：host 触发同一 tick 续轮", async () => {
    const board = makeBoard(3);
    const promptRounds: number[] = [];
    const deps = makeDeps(
      [
        makeExecResult({
          rawScript: "weather tokyo",
          afterward: "watching",
          commandOutput: "$ weather tokyo\n12C",
          logs: ["12C"],
          observations: [
            {
              kind: "query_result",
              source: "weather",
              text: "12C",
              enablesContinuation: true,
            },
          ],
        }),
        makeExecResult({
          rawScript: 'irc say --text "东京 12 度"',
          afterward: "done",
          commandOutput: '$ irc say --text "东京 12 度"\n(sent)',
          logs: ["(sent)"],
          completedActions: ["sent:chatId=1:msgId=2"],
        }),
      ],
      promptRounds,
    );

    const result = await tick(board, [], deps, BASE_CTX);

    expect(result.outcome).toBe("terminal");
    expect(result.episodeRounds).toBe(1);
    expect(result.tcMeta?.hostContinuationTrace).toEqual(["local_observation_followup"]);
    expect(promptRounds).toEqual([0, 1]);
    expect(deps.callLLM).toHaveBeenCalledTimes(2);
  });

  it("afterward=watching + 已经完成发送：不因输出回声续轮", async () => {
    const board = makeBoard(3);
    const promptRounds: number[] = [];
    const deps = makeDeps(
      [
        makeExecResult({
          rawScript: 'irc say --text "我在"',
          afterward: "watching",
          commandOutput: '$ irc say --text "我在"\n✓ Sent',
          logs: ['✓ Sent: "我在"'],
          completedActions: ["sent:chatId=1:msgId=2"],
        }),
      ],
      promptRounds,
    );

    const result = await tick(board, [], deps, BASE_CTX);

    expect(result.outcome).toBe("watching");
    expect(result.episodeRounds).toBe(0);
    expect(result.tcMeta?.hostContinuationTrace).toBeUndefined();
    expect(promptRounds).toEqual([0]);
    expect(deps.callLLM).toHaveBeenCalledTimes(1);
  });

  it("afterward=watching + read_ack only：不触发同一 tick 续轮", async () => {
    const board = makeBoard(3);
    const promptRounds: number[] = [];
    const deps = makeDeps(
      [
        makeExecResult({
          rawScript: "irc read",
          afterward: "watching",
          commandOutput: "$ irc read\n✓ Marked as read",
          logs: ["✓ Marked as read"],
          observations: [
            {
              kind: "read_ack",
              source: "irc.read",
              text: "marked chat 1 as read",
              enablesContinuation: false,
            },
          ],
        }),
      ],
      promptRounds,
    );

    const result = await tick(board, [], deps, BASE_CTX);

    expect(result.outcome).toBe("watching");
    expect(result.episodeRounds).toBe(0);
    expect(result.tcMeta?.hostContinuationTrace).toBeUndefined();
    expect(promptRounds).toEqual([0]);
    expect(deps.callLLM).toHaveBeenCalledTimes(1);
  });

  it("afterward=watching + typed new_message_context：host 触发同一 tick 续轮", async () => {
    const board = makeBoard(3);
    const promptRounds: number[] = [];
    const deps = makeDeps(
      [
        makeExecResult({
          rawScript: "irc tail --count 2\nirc read",
          afterward: "watching",
          commandOutput:
            '$ irc tail --count 2\nirc read\n1. (msgId 10) 小T: "Alice 你怎么看？"\n2. (msgId 11) Yuki: "我也想知道"\n✓ Marked as read',
          logs: [
            '1. (msgId 10) 小T: "Alice 你怎么看？"',
            '2. (msgId 11) Yuki: "我也想知道"',
            "✓ Marked as read",
          ],
          observations: [
            {
              kind: "new_message_context",
              source: "irc.tail",
              text: '1. (msgId 10) 小T: "Alice 你怎么看？"\n2. (msgId 11) Yuki: "我也想知道"',
              enablesContinuation: true,
            },
            {
              kind: "read_ack",
              source: "irc.read",
              text: "marked chat 1 as read",
              enablesContinuation: false,
            },
          ],
        }),
        makeExecResult({
          rawScript: 'irc say --text "我觉得可以试一下"',
          afterward: "done",
          commandOutput: '$ irc say --text "我觉得可以试一下"\n✓ Sent: "我觉得可以试一下"',
          logs: ['✓ Sent: "我觉得可以试一下"'],
          completedActions: ["sent:chatId=1:msgId=12"],
        }),
      ],
      promptRounds,
    );

    const result = await tick(board, [], deps, BASE_CTX);

    expect(result.outcome).toBe("terminal");
    expect(result.episodeRounds).toBe(1);
    expect(result.tcMeta?.hostContinuationTrace).toEqual(["local_observation_followup"]);
    expect(promptRounds).toEqual([0, 1]);
    expect(deps.callLLM).toHaveBeenCalledTimes(2);
  });

  it("afterward=watching 但没有新本地 observations：返回 inter-episode watching", async () => {
    const board = makeBoard(3);
    const promptRounds: number[] = [];
    const deps = makeDeps(
      [
        makeExecResult({
          rawScript: 'irc say --text "我先想想"',
          afterward: "watching",
          commandOutput: '$ irc say --text "我先想想"\n(no output)',
          completedActions: ["sent:chatId=1:msgId=2"],
        }),
      ],
      promptRounds,
    );

    const result = await tick(board, [], deps, BASE_CTX);

    expect(result.outcome).toBe("watching");
    expect(result.episodeRounds).toBe(0);
    expect(result.tcMeta?.hostContinuationTrace).toBeUndefined();
    expect(promptRounds).toEqual([0]);
    expect(deps.callLLM).toHaveBeenCalledTimes(1);
  });

  it("done + runtime error：同一 tick 内给一次自纠机会", async () => {
    const board = makeBoard(3);
    const promptRounds: number[] = [];
    const deps = makeDeps(
      [
        makeExecResult({
          rawScript: "irc whois --target @ghost",
          afterward: "done",
          commandOutput: "$ irc whois --target @ghost\nerror\ninvalid target",
          errors: ['Error: invalid target: "@ghost"'],
          errorCodes: ["command_invalid_target"],
        }),
        makeExecResult({
          rawScript: 'irc say --text "我没找到这个人"',
          afterward: "done",
          commandOutput: '$ irc say --text "我没找到这个人"\n(sent)',
          logs: ["(sent)"],
          completedActions: ["sent:chatId=1:msgId=2"],
        }),
      ],
      promptRounds,
    );

    const result = await tick(board, [], deps, BASE_CTX);

    expect(result.outcome).toBe("terminal");
    expect(result.episodeRounds).toBe(1);
    expect(result.tcMeta?.hostContinuationTrace).toEqual(["error_recovery"]);
    expect(promptRounds).toEqual([0, 1]);
    expect(result.observations.join("\n")).toContain("不知道那是谁");
    expect(deps.callLLM).toHaveBeenCalledTimes(2);
  });

  it("done + completed side effect + runtime error：不保留兼容自纠续轮", async () => {
    const board = makeBoard(3);
    const promptRounds: number[] = [];
    const deps = makeDeps(
      [
        makeExecResult({
          rawScript: 'irc say --text "我在"\nself feel --valence broken',
          afterward: "done",
          commandOutput: '$ irc say --text "我在"\n✓ Sent\nerror\nbad feel',
          logs: ['✓ Sent: "我在"'],
          errors: ["bad feel"],
          errorCodes: ["command_arg_format"],
          completedActions: ["sent:chatId=1:msgId=2"],
        }),
      ],
      promptRounds,
    );

    const result = await tick(board, [], deps, BASE_CTX);

    expect(result.outcome).toBe("terminal");
    expect(result.episodeRounds).toBe(0);
    expect(result.tcMeta?.hostContinuationTrace).toBeUndefined();
    expect(promptRounds).toEqual([0]);
    expect(result.observations.join("\n")).toContain("这些已经做完了，不要再重复");
    expect(deps.callLLM).toHaveBeenCalledTimes(1);
  });

  it("waiting_reply 直接返回对应 outcome：不触发续轮", async () => {
    const board = makeBoard();
    const deps = makeDeps([
      makeExecResult({
        rawScript: "irc say --text '你今天怎么样？'",
        afterward: "waiting_reply",
        completedActions: ["sent:chatId=1:msgId=2"],
      }),
    ]);

    const result = await tick(board, [], deps, BASE_CTX);

    expect(result.outcome).toBe("waiting_reply");
    expect(deps.callLLM).toHaveBeenCalledTimes(1);
  });

  it("waiting_reply + actionable observation + no completed side effect：继续完成 read-then-act 闭环", async () => {
    const board = makeBoard(3);
    const promptRounds: number[] = [];
    const deps = makeDeps(
      [
        makeExecResult({
          rawScript: 'album search --query "cat" --count 5',
          afterward: "waiting_reply",
          commandOutput: '$ album search --query "cat" --count 5\nphoto:cat',
          logs: ["photo:cat @-1001#42 — cat on laptop"],
          observations: [
            {
              kind: "query_result",
              source: "album.search",
              text: "1 album photo candidate",
              enablesContinuation: true,
              payload: {
                intent: "send_album_photo",
                candidates: [{ assetId: "photo:cat", sourceChatId: -1001, sourceMsgId: 42 }],
              },
            },
          ],
        }),
        makeExecResult({
          rawScript: "album send --asset photo:cat",
          afterward: "waiting_reply",
          commandOutput: "$ album send --asset photo:cat\n✓ Sent album photo",
          logs: ["✓ Sent album photo: photo:cat"],
          completedActions: ["sent:chatId=1:msgId=2"],
        }),
      ],
      promptRounds,
    );

    const result = await tick(board, [], deps, BASE_CTX);

    expect(result.outcome).toBe("waiting_reply");
    expect(result.episodeRounds).toBe(1);
    expect(result.tcMeta?.hostContinuationTrace).toEqual(["local_observation_followup"]);
    expect(promptRounds).toEqual([0, 1]);
    expect(deps.callLLM).toHaveBeenCalledTimes(2);
  });

  it("waiting_reply + ordinary query_result without action intent：不升级为默认续轮", async () => {
    const board = makeBoard(3);
    const deps = makeDeps([
      makeExecResult({
        rawScript: "irc whois",
        afterward: "waiting_reply",
        commandOutput: "$ irc whois\nChannel: test",
        logs: ["Channel: test"],
        observations: [
          {
            kind: "query_result",
            source: "irc.whois",
            text: "Channel: test",
            enablesContinuation: true,
          },
        ],
      }),
    ]);

    const result = await tick(board, [], deps, BASE_CTX);

    expect(result.outcome).toBe("waiting_reply");
    expect(result.episodeRounds).toBe(0);
    expect(result.tcMeta?.hostContinuationTrace).toBeUndefined();
    expect(deps.callLLM).toHaveBeenCalledTimes(1);
  });

  it("waiting_reply + runtime error：优先同一 tick 自纠，不进入 watcher", async () => {
    const board = makeBoard(3);
    const promptRounds: number[] = [];
    const deps = makeDeps(
      [
        makeExecResult({
          rawScript: 'irc say --in @ghost --text "还在吗"',
          afterward: "waiting_reply",
          commandOutput: '$ irc say --in @ghost --text "还在吗"\nerror\ninvalid target',
          errors: ['Error: invalid target: "@ghost"'],
          errorCodes: ["command_invalid_target"],
        }),
        makeExecResult({
          rawScript: "irc read",
          afterward: "done",
          commandOutput: "$ irc read\n✓ Marked as read",
          logs: ["✓ Marked as read"],
        }),
      ],
      promptRounds,
    );

    const result = await tick(board, [], deps, BASE_CTX);

    expect(result.outcome).toBe("terminal");
    expect(result.episodeRounds).toBe(1);
    expect(result.tcMeta?.hostContinuationTrace).toEqual(["error_recovery"]);
    expect(promptRounds).toEqual([0, 1]);
    expect(result.execution.errorCodes).toEqual(["command_invalid_target"]);
    expect(deps.callLLM).toHaveBeenCalledTimes(2);
  });

  it("fed_up 直接返回对应 outcome", async () => {
    const board = makeBoard();
    const deps = makeDeps([
      makeExecResult({
        rawScript: "irc say --text '我先走了'",
        afterward: "fed_up",
      }),
    ]);

    const result = await tick(board, [], deps, BASE_CTX);

    expect(result.outcome).toBe("fed_up");
  });

  it("cooling_down 直接返回对应 outcome", async () => {
    const board = makeBoard();
    const deps = makeDeps([
      makeExecResult({
        rawScript: "irc say --text '休息一下'",
        afterward: "cooling_down",
      }),
    ]);

    const result = await tick(board, [], deps, BASE_CTX);

    expect(result.outcome).toBe("cooling_down");
  });

  it("resting 直接返回对应 outcome", async () => {
    const board = makeBoard();
    const deps = makeDeps([
      makeExecResult({
        rawScript: "irc say --text '真的睡了'",
        afterward: "resting",
      }),
    ]);

    const result = await tick(board, [], deps, BASE_CTX);

    expect(result.outcome).toBe("resting");
  });
});
