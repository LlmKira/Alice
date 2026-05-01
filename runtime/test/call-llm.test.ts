import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TickCallResult, TickExecutionResult } from "../src/engine/tick/callLLM.js";

vi.mock("ai", () => ({
  generateText: vi.fn(),
}));

vi.mock("../src/core/shell-executor.js", () => ({
  executeShellScript: vi.fn(),
}));

vi.mock("../src/db/audit.js", () => ({
  writeAuditEvent: vi.fn(),
}));

vi.mock("../src/llm/client.js", () => ({
  selectProviderForFirstPass: vi.fn(),
}));

vi.mock("../src/llm/resilience.js", () => ({
  withResilience: vi.fn(async (fn: () => Promise<unknown>) => await fn()),
  getBreakerState: vi.fn(() => "closed"),
  CircuitOpenError: class CircuitOpenError extends Error {},
  ProviderUnavailableError: class ProviderUnavailableError extends Error {
    constructor(readonly cause: unknown) {
      super("LLM provider unavailable after resilience retries");
    }
  },
}));

const { generateText } = await import("ai");
const { executeShellScript } = await import("../src/core/shell-executor.js");
const { writeAuditEvent } = await import("../src/db/audit.js");
const { selectProviderForFirstPass } = await import("../src/llm/client.js");
const { ProviderUnavailableError } = await import("../src/llm/resilience.js");
const { callTickLLM } = await import("../src/engine/tick/callLLM.js");
const { normalizeScript, parseTickStep } = await import("../src/llm/schemas.js");

function makeProvider() {
  return {
    provider: vi.fn((model: string) => ({ model })),
    model: "test-model",
    name: "test-provider",
  };
}

function makeShellResult() {
  return {
    logs: ["ok"],
    errors: [],
    instructionErrors: [],
    errorCodes: [],
    errorDetails: [],
    duration: 12,
    thinks: ["先看一眼再回"],
    queryLogs: [],
    observations: [],
    completedActions: ["sent:chatId=1:msgId=2"],
    silenceReason: null,
  };
}

function assertTickSuccess(result: TickCallResult): asserts result is TickExecutionResult {
  if (result == null) {
    throw new Error("expected successful tick result, got null");
  }
  if ("ok" in result) {
    throw new Error(`expected successful tick result, got ${result.failureKind}: ${result.error}`);
  }
}

describe("callTickLLM", () => {
  beforeEach(() => {
    vi.mocked(generateText).mockReset();
    vi.mocked(executeShellScript).mockReset();
    vi.mocked(writeAuditEvent).mockReset();
    vi.mocked(selectProviderForFirstPass).mockReset();
    vi.mocked(selectProviderForFirstPass).mockReturnValue(makeProvider() as never);
  });

  it("默认走 generateText JSON block path，并执行返回的脚本", async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: JSON.stringify({
        script: 'irc tail --count 5\nirc reply --ref 1 --text "好，我看到了"',
        afterward: "done",
        residue: { feeling: "curious", toward: "@123", reason: "still thinking" },
      }),
    } as never);
    vi.mocked(executeShellScript).mockResolvedValue(makeShellResult());

    const result = await callTickLLM(
      "system prompt",
      "user prompt",
      1,
      "channel:1",
      "conversation",
      {},
    );

    assertTickSuccess(result);
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(executeShellScript)).toHaveBeenCalledTimes(1);
    expect(result.assistantTurnCount).toBe(1);
    expect(result.llmProvider).toBe("test-provider");
    expect(result.llmModel).toBe("test-model");
    expect(result.toolCallCount).toBe(0);
    expect(result.bashCallCount).toBe(1);
    expect(result.llmResidue).toEqual({
      feeling: "curious",
      toward: "@123",
      reason: "still thinking",
    });
    expect(result.commandOutput).toContain(
      'irc tail --count 5\nirc reply --ref 1 --text "好，我看到了"',
    );

    const firstCall = vi.mocked(generateText).mock.calls[0]?.[0];
    expect(firstCall?.messages?.[0]?.content).toBe("system prompt");
    expect(firstCall).not.toHaveProperty("schema");
  });

  it("使用 tick 入口传入的 provider，保证同一 subcycle 内模型固定", async () => {
    const fallbackProvider = makeProvider();
    const selectedProvider = {
      provider: vi.fn((model: string) => ({ model })),
      model: "selected-model",
      name: "selected-provider",
    };
    vi.mocked(selectProviderForFirstPass).mockReturnValue(fallbackProvider as never);
    vi.mocked(generateText).mockResolvedValue({
      text: JSON.stringify({
        script: "irc tail --count 5",
        afterward: "done",
      }),
    } as never);
    vi.mocked(executeShellScript).mockResolvedValue(makeShellResult());

    const result = await callTickLLM(
      "system prompt",
      "user prompt",
      1,
      "channel:1",
      "conversation",
      {},
      selectedProvider as never,
    );

    assertTickSuccess(result);
    expect(selectedProvider.provider).toHaveBeenCalledWith("selected-model");
    expect(fallbackProvider.provider).not.toHaveBeenCalled();
    expect(result.llmProvider).toBe("selected-provider");
    expect(result.llmModel).toBe("selected-model");
  });

  it("保留 shell 执行返回的结构化错误详情", async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: JSON.stringify({
        script: 'irc reply --in -1002 --ref 9 --text "hi"',
        afterward: "watching",
      }),
    } as never);
    vi.mocked(executeShellScript).mockResolvedValue({
      ...makeShellResult(),
      logs: [],
      errors: ["refusing cross-chat send"],
      errorCodes: ["command_cross_chat_send"],
      errorDetails: [
        {
          code: "command_cross_chat_send",
          source: "irc.reply",
          currentChatId: "-1001",
          requestedChatId: "-1002",
          payload: { replyTo: 9 },
        },
      ],
      completedActions: [],
    });

    const result = await callTickLLM(
      "system prompt",
      "user prompt",
      1,
      "channel:1",
      "conversation",
      {},
    );

    assertTickSuccess(result);
    expect(result.errorCodes).toEqual(["command_cross_chat_send"]);
    expect(result.errorDetails).toEqual([
      expect.objectContaining({
        code: "command_cross_chat_send",
        source: "irc.reply",
        currentChatId: "-1001",
        requestedChatId: "-1002",
      }),
    ]);
  });

  it("脚本预验证失败时会进行一次结构化修正", async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: JSON.stringify({
          script: "not-a-real-command",
          afterward: "done",
        }),
      } as never)
      .mockResolvedValueOnce({
        text: JSON.stringify({
          script: 'irc reply --ref 1 --text "修好了"',
          afterward: "done",
        }),
      } as never);
    vi.mocked(executeShellScript).mockResolvedValue(makeShellResult());

    const result = await callTickLLM(
      "system prompt",
      "user prompt",
      2,
      "channel:1",
      "conversation",
      {},
    );

    assertTickSuccess(result);
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(executeShellScript)).toHaveBeenCalledTimes(1);
    expect(result.assistantTurnCount).toBe(2);

    const repairCall = vi.mocked(generateText).mock.calls[1]?.[0];
    expect(repairCall?.messages).toHaveLength(4);
    expect(repairCall?.messages?.[3]?.content).toContain("failed shell validation");
  });

  it("JSON 解析失败时会要求模型重发纯 JSON", async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "我想先看看消息，然后再决定。",
      } as never)
      .mockResolvedValueOnce({
        text: JSON.stringify({
          script: "irc tail --count 5",
          afterward: "done",
        }),
      } as never);
    vi.mocked(executeShellScript).mockResolvedValue(makeShellResult());

    const result = await callTickLLM(
      "system prompt",
      "user prompt",
      4,
      "channel:1",
      "conversation",
      {},
    );

    assertTickSuccess(result);
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(2);

    const repairCall = vi.mocked(generateText).mock.calls[1]?.[0];
    expect(repairCall?.messages?.[3]?.content).toContain("not a valid JSON object");
  });

  it("会清理 JSON script 中泄漏的 sh 语言标签", async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: JSON.stringify({
        script: "sh\nirc tail --count 5",
        afterward: "done",
      }),
    } as never);
    vi.mocked(executeShellScript).mockResolvedValue(makeShellResult());

    const result = await callTickLLM(
      "system prompt",
      "user prompt",
      12,
      "channel:1",
      "conversation",
      {},
    );

    assertTickSuccess(result);
    expect(result.rawScript).toBe("irc tail --count 5");
    expect(vi.mocked(executeShellScript)).toHaveBeenCalledWith("irc tail --count 5", {
      contextVars: {},
    });
  });

  it("把 residue:null 视为未填写，避免空残留导致行动失败", async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: JSON.stringify({
        script: "irc tail --count 5",
        afterward: "done",
        residue: null,
      }),
    } as never);
    vi.mocked(executeShellScript).mockResolvedValue(makeShellResult());

    const result = await callTickLLM(
      "system prompt",
      "user prompt",
      5,
      "channel:1",
      "conversation",
      {},
    );

    assertTickSuccess(result);
    expect(result.llmResidue).toBeUndefined();
    expect(vi.mocked(executeShellScript)).toHaveBeenCalledTimes(1);
  });

  it("把无信息量的 residue 字符串视为未填写", async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: JSON.stringify({
        script: "irc tail --count 5",
        afterward: "done",
        residue: "settled",
      }),
    } as never);
    vi.mocked(executeShellScript).mockResolvedValue(makeShellResult());

    const result = await callTickLLM(
      "system prompt",
      "user prompt",
      6,
      "channel:1",
      "conversation",
      {},
    );

    assertTickSuccess(result);
    expect(result.llmResidue).toBeUndefined();
    expect(vi.mocked(executeShellScript)).toHaveBeenCalledTimes(1);
  });

  it("把缺少 feeling 的 residue 对象视为未填写", async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: JSON.stringify({
        script: "irc tail --count 5",
        afterward: "done",
        residue: { reason: "just watching" },
      }),
    } as never);
    vi.mocked(executeShellScript).mockResolvedValue(makeShellResult());

    const result = await callTickLLM(
      "system prompt",
      "user prompt",
      7,
      "channel:1",
      "conversation",
      {},
    );

    assertTickSuccess(result);
    expect(result.llmResidue).toBeUndefined();
    expect(vi.mocked(executeShellScript)).toHaveBeenCalledTimes(1);
  });

  it("空 script 直接闭合为 typed silence，不降级为只读观察动作", async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: JSON.stringify({
        script: "",
        afterward: "done",
      }),
    } as never);
    vi.mocked(executeShellScript).mockResolvedValue(makeShellResult());

    const result = await callTickLLM(
      "system prompt",
      "user prompt",
      8,
      "channel:1",
      "conversation",
      {},
    );

    assertTickSuccess(result);
    expect(result.afterward).toBe("done");
    expect(result.rawScript).toBe("# no action");
    expect(result.silenceReason).toBe("no_executable_script");
    expect(vi.mocked(executeShellScript)).not.toHaveBeenCalled();
  });

  it("纯注释脚本直接闭合为 typed silence，不消耗修正轮", async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: JSON.stringify({
        script: "# 有点累\n# 先不说话",
        afterward: "watching",
      }),
    } as never);

    const result = await callTickLLM(
      "system prompt",
      "user prompt",
      9,
      "channel:1",
      "conversation",
      {},
    );

    assertTickSuccess(result);
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(executeShellScript)).not.toHaveBeenCalled();
    expect(result.afterward).toBe("done");
    expect(result.silenceReason).toBe("no_executable_script");
    expect(result.thinks).toEqual(["有点累", "先不说话"]);
    expect(result.completedActions).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.bashCallCount).toBe(0);
    expect(result.commandOutput).toContain("(no executable command; treated as silence)");
  });

  it("未闭合引号修正失败时直接失败，不降级为只读观察动作", async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: JSON.stringify({
          script: "irc say --text '没说完",
          afterward: "done",
        }),
      } as never)
      .mockResolvedValueOnce({
        text: JSON.stringify({
          script: "irc say --text '还是没说完",
          afterward: "done",
        }),
      } as never);
    vi.mocked(executeShellScript).mockResolvedValue(makeShellResult());

    const result = await callTickLLM(
      "system prompt",
      "user prompt",
      9,
      "channel:1",
      "conversation",
      {},
    );

    expect(result).toMatchObject({ ok: false, failureKind: "llm_invalid" });
    expect(vi.mocked(executeShellScript)).not.toHaveBeenCalled();
  });

  it("非法消息引用不会降级为只读观察动作", async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: JSON.stringify({
          script: "irc react --ref #latest --emoji 👀",
          afterward: "done",
        }),
      } as never)
      .mockResolvedValueOnce({
        text: JSON.stringify({
          script: "irc react --ref #latest --emoji 👀",
          afterward: "done",
        }),
      } as never);

    const result = await callTickLLM(
      "system prompt",
      "user prompt",
      10,
      "channel:1",
      "conversation",
      {},
    );

    expect(result).toMatchObject({ ok: false, failureKind: "llm_invalid" });
    expect(vi.mocked(executeShellScript)).not.toHaveBeenCalled();
  });

  it("provider 网络失败会分类为基础设施不可用", async () => {
    vi.mocked(generateText).mockRejectedValue(
      new ProviderUnavailableError(new Error("network unavailable")),
    );

    const result = await callTickLLM(
      "system prompt",
      "user prompt",
      11,
      "channel:1",
      "conversation",
      {},
    );

    expect(result).toMatchObject({ ok: false, failureKind: "provider_unavailable" });
    expect(vi.mocked(executeShellScript)).not.toHaveBeenCalled();
    expect(vi.mocked(writeAuditEvent)).toHaveBeenCalledTimes(1);
  });

  it("普通错误消息不会靠文本内容分类为 provider 授权失败", async () => {
    vi.mocked(generateText).mockRejectedValue(new Error("Unauthorized"));

    const result = await callTickLLM(
      "system prompt",
      "user prompt",
      12,
      "channel:1",
      "conversation",
      {},
    );

    expect(result).toMatchObject({ ok: false, failureKind: "llm_invalid" });
    expect(vi.mocked(executeShellScript)).not.toHaveBeenCalled();
    expect(vi.mocked(writeAuditEvent)).toHaveBeenCalledTimes(1);
  });

  it("provider 401/403 状态会分类为基础设施不可用", async () => {
    const err = Object.assign(new Error("request failed"), { statusCode: 401 });
    vi.mocked(generateText).mockRejectedValue(err);

    const result = await callTickLLM(
      "system prompt",
      "user prompt",
      13,
      "channel:1",
      "conversation",
      {},
    );

    expect(result).toMatchObject({ ok: false, failureKind: "provider_unavailable" });
    expect(vi.mocked(executeShellScript)).not.toHaveBeenCalled();
  });

  it("修正耗尽时直接失败，不再升级到第二套 transport", async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: JSON.stringify({
          script: "not-a-real-command",
          afterward: "done",
        }),
      } as never)
      .mockResolvedValueOnce({
        text: JSON.stringify({
          script: "still-not-a-real-command",
          afterward: "done",
        }),
      } as never);

    const result = await callTickLLM(
      "system prompt",
      "user prompt",
      3,
      "channel:1",
      "conversation",
      {},
    );

    expect(result).toMatchObject({ ok: false, failureKind: "llm_invalid" });
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(executeShellScript)).not.toHaveBeenCalled();
    expect(vi.mocked(generateText).mock.calls[1]?.[0].messages?.at(-1)?.content).toContain(
      "Use namespaced commands exactly as shown",
    );
    expect(vi.mocked(writeAuditEvent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeAuditEvent).mock.calls[0]?.[4]).toMatchObject({
      error: expect.stringContaining("Structured block validation failed"),
      provider: "test-provider",
      model: "test-model",
    });
  });
});

describe("parseTickStep", () => {
  it("normalizes empty script into a comment-only no-op instead of schema failure", () => {
    const step = parseTickStep('{"script":"","afterward":"done"}');

    expect(step.script).toBe("# no action");
  });

  it("normalizeScript preserves executable commands and turns whitespace into no-op", () => {
    expect(normalizeScript("  \n\t")).toBe("# no action");
    expect(normalizeScript(" irc read ")).toBe("irc read");
  });

  it("是生产和 eval 共用的唯一 TickStep 解析边界", () => {
    const step = parseTickStep(
      '```json\n{"script":"irc read","afterward":"watching","residue":"curious"}\n```',
    );

    expect(step).toEqual({
      script: "irc read",
      afterward: "watching",
      residue: { feeling: "curious" },
    });
  });
});
