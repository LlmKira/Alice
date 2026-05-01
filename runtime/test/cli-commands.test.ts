/**
 * CLI 命令逻辑测试 — ADR-238 citty 原生版本。
 *
 * 测试策略：
 * - 通过构造 fake IO 实现，直接测试命令逻辑
 * - 覆盖 citty 边界行为（multiple: true 的 string/array 双态）
 * - 不再需要 rawArgs 解析测试（citty 处理）
 */

import { describe, expect, it } from "vitest";
import {
  gval,
  parseMsgId,
  reactCommand,
  readCommand,
  replyCommand,
  sayCommand,
  stickerCommand,
  tailCommand,
  threadsCommand,
  voiceCommand,
  whoisCommand,
} from "../src/system/cli-commands.js";
import type { CliContext, EngineClient, Output } from "../src/system/cli-types.js";

// ── Fake 实现 ──

/** 记录输出内容。 */
class FakeOutput implements Output {
  logs: string[] = [];
  errors: string[] = [];
  exitCode: number | null = null;

  log(msg: string): void {
    this.logs.push(msg);
  }

  error(msg: string): void {
    this.errors.push(msg);
  }

  exit(code: number): never {
    this.exitCode = code;
    throw new Error(`exit(${code})`);
  }

  reset(): void {
    this.logs = [];
    this.errors = [];
    this.exitCode = null;
  }
}

/** 构造 fake engine。 */
function makeFakeEngine(responses: Map<string, unknown>): EngineClient {
  return {
    post: async (path: string, body: unknown) => {
      const key = `POST:${path}:${JSON.stringify(body)}`;
      return responses.get(key) ?? responses.get(`POST:${path}`) ?? null;
    },
    get: async (path: string) => {
      return responses.get(`GET:${path}`) ?? null;
    },
    query: async (path: string, body: unknown) => {
      const key = `QUERY:${path}:${JSON.stringify(body)}`;
      const raw = responses.get(key) ?? responses.get(`QUERY:${path}`) ?? null;
      // 模拟 engineQuery 自动解包
      if (raw && typeof raw === "object" && "result" in raw) {
        return (raw as { result: unknown }).result;
      }
      return raw;
    },
  };
}

/** 构造 fake context。 */
function makeFakeContext(
  responses: Map<string, unknown>,
  output: Output,
  resolveTarget: (t: unknown) => Promise<number> = async () => 123,
  currentChatId?: number,
): CliContext {
  return {
    engine: makeFakeEngine(responses),
    output,
    resolveTarget,
    currentChatId,
  };
}

// ── Tests ──

describe("parseMsgId", () => {
  it("parses plain number", () => {
    expect(parseMsgId("123")).toBe(123);
  });

  it("parses #prefixed number", () => {
    expect(parseMsgId("#456")).toBe(456);
  });

  it("throws on invalid", () => {
    expect(() => parseMsgId("abc")).toThrow("invalid message ID");
  });

  it("rejects non-integer IDs", () => {
    expect(() => parseMsgId("1.5")).toThrow("visible current-chat msgId");
  });

  it("rejects fake latest aliases", () => {
    expect(() => parseMsgId("#latest")).toThrow("never latest");
  });
});

describe("gval", () => {
  it("extracts value from response", () => {
    expect(gval({ value: "test" })).toBe("test");
  });

  it("returns null for null response", () => {
    expect(gval(null)).toBe(null);
  });

  it("returns null for missing value", () => {
    expect(gval({})).toBe(null);
  });
});

describe("sayCommand", () => {
  it("sends message and returns formatted output", async () => {
    const responses = new Map([
      [
        'POST:/transport/send:{"target":"channel:telegram:123","text":"hello"}',
        {
          messageId: "message:telegram:123:789",
          nativeMessageId: 789,
        },
      ],
    ]);
    const output = new FakeOutput();
    const ctx = makeFakeContext(responses, output);

    const result = await sayCommand(ctx, {
      in: undefined,
      text: "hello",
    });

    expect(result.action).toBe(
      "__ALICE_ACTION__:sent:chatId=123:msgId=789:message=message:telegram:123:789",
    );
    expect(result.output).toBe('✓ Sent: "hello"');
    expect(output.logs).toHaveLength(0); // 命令逻辑不直接输出
  });

  it("returns rawResult when json flag is set", async () => {
    const responses = new Map([
      ['POST:/transport/send:{"target":"channel:telegram:123","text":"test"}', { msgId: 1 }],
    ]);
    const ctx = makeFakeContext(responses, new FakeOutput());

    const result = await sayCommand(ctx, {
      in: undefined,
      text: "test",
      json: "", // 空字符串表示 JSON 模式（输出全部字段）
    });

    // rawResult 用于 JSON 输出，output 是人类可读文本
    expect(result.rawResult).toEqual({
      msgId: 1,
      chatId: 123,
      target: "channel:telegram:123",
      messageId: undefined,
    });
    expect(result.output).toBe('✓ Sent: "test"');
  });

  it("accepts stable transport targets without numeric resolver fallback", async () => {
    const responses = new Map([
      [
        'POST:/transport/send:{"target":"channel:telegram:123","text":"stable"}',
        {
          messageId: "message:telegram:123:790",
          nativeMessageId: 790,
        },
      ],
    ]);
    const ctx = makeFakeContext(responses, new FakeOutput(), async () => {
      throw new Error("numeric resolver should not be called");
    });

    const result = await sayCommand(ctx, {
      in: "channel:telegram:123",
      text: "stable",
    });

    expect(result.action).toBe(
      "__ALICE_ACTION__:sent:chatId=123:msgId=790:message=message:telegram:123:790",
    );
    expect(result.rawResult).toMatchObject({
      chatId: 123,
      target: "channel:telegram:123",
      messageId: "message:telegram:123:790",
    });
  });

  it("posts non-Telegram stable targets through transport without Telegram assumptions", async () => {
    const responses = new Map([
      ['POST:/transport/send:{"target":"channel:discord:guild-1/thread-2","text":"hello"}', null],
    ]);
    const ctx = makeFakeContext(responses, new FakeOutput(), async () => {
      throw new Error("numeric resolver should not be called");
    });

    const result = await sayCommand(ctx, {
      in: "channel:discord:guild-1/thread-2",
      text: "hello",
    });

    expect(result.action).toBeUndefined();
    expect(result.rawResult).toMatchObject({
      chatId: undefined,
      target: "channel:discord:guild-1/thread-2",
    });
  });

  it("resolves display names through neutral target resolver", async () => {
    const responses = new Map([
      [
        'POST:/resolve/target:{"target":"游戏群"}',
        { result: { target: "channel:discord:guild-1/thread-2" } },
      ],
      ['POST:/transport/send:{"target":"channel:discord:guild-1/thread-2","text":"hello"}', null],
    ]);
    const ctx = makeFakeContext(responses, new FakeOutput(), async () => {
      throw new Error("numeric resolver should not be called");
    });

    const result = await sayCommand(ctx, {
      in: "游戏群",
      text: "hello",
    });

    expect(result.rawResult).toMatchObject({
      target: "channel:discord:guild-1/thread-2",
    });
  });

  it("normalizes visible CJK quotes before sending", async () => {
    const responses = new Map([
      [
        'POST:/transport/send:{"target":"channel:telegram:123","text":"不行不行，系统说“道德模块异常，请重启”，一刀杀五个直接蓝屏了😵"}',
        { msgId: 789 },
      ],
    ]);
    const ctx = makeFakeContext(responses, new FakeOutput());

    const result = await sayCommand(ctx, {
      in: undefined,
      text: "不行不行，系统说'道德模块异常，请重启'，一刀杀五个直接蓝屏了😵",
    });

    expect(result.action).toBe(
      "__ALICE_ACTION__:sent:chatId=123:msgId=789:message=message:telegram:123:789",
    );
    expect(result.output).toBe(
      '✓ Sent: "不行不行，系统说“道德模块异常，请重启”，一刀杀五个直接蓝屏了😵"',
    );
  });

  it("keeps English apostrophe semantics while normalizing typography", async () => {
    const responses = new Map([
      [
        'POST:/transport/send:{"target":"channel:telegram:123","text":"don’t worry"}',
        { msgId: 789 },
      ],
    ]);
    const ctx = makeFakeContext(responses, new FakeOutput());

    const result = await sayCommand(ctx, {
      in: undefined,
      text: "don't worry",
    });

    expect(result.output).toBe('✓ Sent: "don’t worry"');
  });

  it("throws on empty text", async () => {
    const ctx = makeFakeContext(new Map(), new FakeOutput());

    await expect(
      sayCommand(ctx, {
        in: undefined,
        text: "   ",
      }),
    ).rejects.toThrow("exit(1)");
  });

  it("rejects cross-chat active send when execution context has a current chat", async () => {
    const output = new FakeOutput();
    const ctx = makeFakeContext(new Map(), output, async () => 456, 123);

    await expect(
      sayCommand(ctx, {
        in: "@456",
        text: "wrong room",
      }),
    ).rejects.toThrow("exit(1)");

    expect(output.errors.join("\n")).toContain("refusing cross-chat send");
    expect(output.errors.join("\n")).toContain("self switch-chat --to @456");
    expect(output.errors.join("\n")).toContain("__ALICE_ERROR__:command_cross_chat_send");
    expect(output.errors.join("\n")).toContain("__ALICE_ERROR_DETAIL__:");
    expect(output.errors.join("\n")).toContain('"source":"irc.say"');
    expect(output.errors.join("\n")).toContain('"currentChatId":"123"');
    expect(output.errors.join("\n")).toContain('"requestedChatId":"channel:telegram:456"');
  });

  it("allows active send to the current chat", async () => {
    const responses = new Map([
      ['POST:/transport/send:{"target":"channel:telegram:123","text":"same room"}', { msgId: 789 }],
    ]);
    const output = new FakeOutput();
    const ctx = makeFakeContext(responses, output, async () => 123, 123);

    const result = await sayCommand(ctx, {
      in: "@123",
      text: "same room",
    });

    expect(result.action).toBe(
      "__ALICE_ACTION__:sent:chatId=123:msgId=789:message=message:telegram:123:789",
    );
  });

  describe("--resolve-thread (ADR-240)", () => {
    it("resolves thread after sending message", async () => {
      const responses = new Map([
        ['POST:/transport/send:{"target":"channel:telegram:123","text":"done"}', { msgId: 789 }],
        ['POST:/dispatch/resolve_topic:{"threadId":158}', { ok: true }],
      ]);
      const output = new FakeOutput();
      const ctx = makeFakeContext(responses, output);

      const result = await sayCommand(ctx, {
        in: undefined,
        text: "done",
        "resolve-thread": "158",
      });

      expect(result.action).toBe(
        "__ALICE_ACTION__:sent:chatId=123:msgId=789:message=message:telegram:123:789",
      );
      expect(result.output).toBe('✓ Sent: "done"');
      // 验证发送了 resolve_topic 请求
      expect(Array.from(responses.keys())).toContain(
        'POST:/dispatch/resolve_topic:{"threadId":158}',
      );
    });

    it("throws on invalid thread ID", async () => {
      const responses = new Map([
        ['POST:/transport/send:{"target":"channel:telegram:123","text":"done"}', { msgId: 789 }],
      ]);
      const output = new FakeOutput();
      const ctx = makeFakeContext(responses, output);

      await expect(
        sayCommand(ctx, {
          in: undefined,
          text: "done",
          "resolve-thread": "invalid",
        }),
      ).rejects.toThrow("exit(1)");
    });

    it("throws on negative thread ID", async () => {
      const responses = new Map([
        ['POST:/transport/send:{"target":"channel:telegram:123","text":"done"}', { msgId: 789 }],
      ]);
      const output = new FakeOutput();
      const ctx = makeFakeContext(responses, output);

      await expect(
        sayCommand(ctx, {
          in: undefined,
          text: "done",
          "resolve-thread": "-1",
        }),
      ).rejects.toThrow("exit(1)");
    });

    it("does not fail when resolve throws", async () => {
      const responses = new Map([
        ['POST:/transport/send:{"target":"channel:telegram:123","text":"done"}', { msgId: 789 }],
        // resolve_topic 返回 null（模拟失败）
        ['POST:/dispatch/resolve_topic:{"threadId":158}', null],
      ]);
      const output = new FakeOutput();
      const ctx = makeFakeContext(responses, output);

      const result = await sayCommand(ctx, {
        in: undefined,
        text: "done",
        "resolve-thread": "158",
      });

      // 消息应该成功发送，即使 resolve 失败
      expect(result.output).toBe('✓ Sent: "done"');
      expect(result.action).toBe(
        "__ALICE_ACTION__:sent:chatId=123:msgId=789:message=message:telegram:123:789",
      );
    });

    it("works without resolve-thread flag", async () => {
      const responses = new Map([
        ['POST:/transport/send:{"target":"channel:telegram:123","text":"hello"}', { msgId: 789 }],
      ]);
      const output = new FakeOutput();
      const ctx = makeFakeContext(responses, output);

      const result = await sayCommand(ctx, {
        in: undefined,
        text: "hello",
        // 不带 resolve-thread 参数
      });

      expect(result.action).toBe(
        "__ALICE_ACTION__:sent:chatId=123:msgId=789:message=message:telegram:123:789",
      );
      expect(result.output).toBe('✓ Sent: "hello"');
      // 不应发送 resolve_topic 请求
      expect(Array.from(responses.keys())).not.toContain("resolve_topic");
    });
  });
});

describe("replyCommand", () => {
  it("sends reply with correct params", async () => {
    const responses = new Map([
      [
        'POST:/transport/send:{"target":"channel:telegram:123","text":"reply text","replyTo":"message:telegram:123:456"}',
        { msgId: 789 },
      ],
    ]);
    const ctx = makeFakeContext(responses, new FakeOutput());

    const result = await replyCommand(ctx, {
      in: undefined,
      ref: "456",
      text: "reply text",
    });

    expect(result.output).toContain("Replied to: #456");
  });

  it("normalizes quoted CJK phrases before replying", async () => {
    const responses = new Map([
      [
        'POST:/transport/send:{"target":"channel:telegram:123","text":"而且“二桃杀三士”本来是计谋","replyTo":"message:telegram:123:456"}',
        { msgId: 789 },
      ],
    ]);
    const ctx = makeFakeContext(responses, new FakeOutput());

    const result = await replyCommand(ctx, {
      in: undefined,
      ref: "456",
      text: "而且'二桃杀三士'本来是计谋",
    });

    expect(result.output).toBe('✓ Replied to: #456: "而且“二桃杀三士”本来是计谋"');
  });

  it("uses stable message refs for non-Telegram replies", async () => {
    const responses = new Map([
      [
        'POST:/transport/send:{"target":"channel:discord:guild-1/thread-2","text":"reply text","replyTo":"message:discord:guild-1/thread-2:m-9"}',
        null,
      ],
    ]);
    const ctx = makeFakeContext(responses, new FakeOutput(), async () => {
      throw new Error("numeric resolver should not be called");
    });

    const result = await replyCommand(ctx, {
      in: "channel:discord:guild-1/thread-2",
      ref: "message:discord:guild-1/thread-2:m-9",
      text: "reply text",
    });

    expect(result.action).toBeUndefined();
    expect(result.output).toContain("message:discord:guild-1/thread-2:m-9");
    expect(result.rawResult).toMatchObject({
      target: "channel:discord:guild-1/thread-2",
      replyToMessage: "message:discord:guild-1/thread-2:m-9",
    });
  });

  it("rejects numeric message refs for non-Telegram targets", async () => {
    const output = new FakeOutput();
    const ctx = makeFakeContext(new Map(), output, async () => {
      throw new Error("numeric resolver should not be called");
    });

    await expect(
      replyCommand(ctx, {
        in: "channel:discord:guild-1/thread-2",
        ref: "456",
        text: "reply text",
      }),
    ).rejects.toThrow("exit(1)");

    expect(output.errors.join("\n")).toContain("use a stable message ref for discord");
  });

  it("rejects cross-chat reply", async () => {
    const output = new FakeOutput();
    const ctx = makeFakeContext(new Map(), output, async () => 456, 123);

    await expect(
      replyCommand(ctx, {
        in: "@456",
        ref: "1",
        text: "wrong room",
      }),
    ).rejects.toThrow("exit(1)");
  });

  it("rejects malformed reply refs before calling Telegram", async () => {
    const output = new FakeOutput();
    const ctx = makeFakeContext(new Map(), output);

    await expect(
      replyCommand(ctx, {
        in: undefined,
        ref: "abc",
        text: "wrong ref",
      }),
    ).rejects.toThrow("exit(1)");

    expect(output.errors.join("\n")).toContain("visible current-chat msgId");
  });
});

describe("stickerCommand", () => {
  it("rejects empty sticker keyword", async () => {
    const output = new FakeOutput();
    const ctx = makeFakeContext(new Map(), output);

    await expect(
      stickerCommand(ctx, {
        in: undefined,
        keyword: "  ",
      }),
    ).rejects.toThrow("exit(1)");

    expect(output.errors.join("\n")).toContain("sticker requires non-empty keyword");
  });

  it("rejects cross-chat sticker", async () => {
    const output = new FakeOutput();
    const ctx = makeFakeContext(new Map(), output, async () => 456, 123);

    await expect(
      stickerCommand(ctx, {
        in: "@456",
        keyword: "wave",
      }),
    ).rejects.toThrow("exit(1)");
  });
});

describe("voiceCommand", () => {
  it("normalizes visible text before voice delivery or text fallback", async () => {
    const responses = new Map([
      [
        'POST:/telegram/voice:{"chatId":123,"text":"系统说“道德模块异常，请重启”"}',
        { msgId: 789, deliveredAs: "text" },
      ],
    ]);
    const ctx = makeFakeContext(responses, new FakeOutput());

    const result = await voiceCommand(ctx, {
      in: undefined,
      text: "系统说'道德模块异常，请重启'",
    });

    expect(result.action).toBe("__ALICE_ACTION__:sent:chatId=123:msgId=789");
    expect(result.output).toBe('✓ Sent text fallback: "系统说“道德模块异常，请重启”"');
  });

  it("rejects cross-chat voice", async () => {
    const output = new FakeOutput();
    const ctx = makeFakeContext(new Map(), output, async () => 456, 123);

    await expect(
      voiceCommand(ctx, {
        in: "@456",
        text: "wrong room",
      }),
    ).rejects.toThrow("exit(1)");
  });
});

describe("reactCommand", () => {
  it("sends reaction", async () => {
    const responses = new Map([
      [
        'POST:/transport/react:{"target":"channel:telegram:123","message":"message:telegram:123:123","emoji":"👍"}',
        { ok: true },
      ],
    ]);
    const ctx = makeFakeContext(responses, new FakeOutput());

    const result = await reactCommand(ctx, {
      in: undefined,
      ref: "123",
      emoji: "👍",
    });

    expect(result.action).toBe("__ALICE_ACTION__:react:chatId=123:msgId=123");
    expect(result.output).toContain("Reacted 👍 to: #123");
  });

  it("normalizes heart variation selector before reaction validation", async () => {
    const responses = new Map([
      [
        'POST:/transport/react:{"target":"channel:telegram:123","message":"message:telegram:123:123","emoji":"❤"}',
        { ok: true },
      ],
    ]);
    const ctx = makeFakeContext(responses, new FakeOutput());

    const result = await reactCommand(ctx, {
      in: undefined,
      ref: "123",
      emoji: "❤️",
    });

    expect(result.action).toBe("__ALICE_ACTION__:react:chatId=123:msgId=123");
    expect(result.output).toContain("Reacted ❤ to: #123");
  });

  it("uses stable target and message refs for non-Telegram reactions", async () => {
    const responses = new Map([
      [
        'POST:/transport/react:{"target":"channel:discord:guild-1/thread-2","message":"message:discord:guild-1/thread-2:m-9","emoji":"👍"}',
        { ok: true },
      ],
    ]);
    const ctx = makeFakeContext(responses, new FakeOutput(), async () => {
      throw new Error("numeric resolver should not be called");
    });

    const result = await reactCommand(ctx, {
      in: "channel:discord:guild-1/thread-2",
      ref: "message:discord:guild-1/thread-2:m-9",
      emoji: "👍",
    });

    expect(result.action).toBeUndefined();
    expect(result.output).toContain("message:discord:guild-1/thread-2:m-9");
    expect(result.rawResult).toMatchObject({
      target: "channel:discord:guild-1/thread-2",
      message: "message:discord:guild-1/thread-2:m-9",
    });
  });

  it("rejects unsupported reaction before calling Engine API", async () => {
    const responses = new Map<string, unknown>();
    const output = new FakeOutput();
    const ctx = makeFakeContext(responses, output);

    await expect(
      reactCommand(ctx, {
        in: undefined,
        ref: "123",
        emoji: "💤",
      }),
    ).rejects.toThrow("exit(1)");

    expect(output.errors.join("\n")).toContain("invalid reaction");
    expect(responses.size).toBe(0);
  });
});

describe("voiceCommand", () => {
  it("reports voice text fallback as sent text", async () => {
    const responses = new Map([
      [
        'POST:/telegram/voice:{"chatId":123,"text":"hello"}',
        { msgId: 9, deliveredAs: "text", fallbackReason: "voice_messages_forbidden" },
      ],
    ]);
    const ctx = makeFakeContext(responses, new FakeOutput());

    const result = await voiceCommand(ctx, {
      in: undefined,
      text: "hello",
    });

    expect(result.action).toBe("__ALICE_ACTION__:sent:chatId=123:msgId=9");
    expect(result.output).toContain('✓ Sent text fallback: "hello"');
    expect(result.rawResult).toMatchObject({
      msgId: 9,
      deliveredAs: "text",
      fallbackReason: "voice_messages_forbidden",
    });
  });
});

describe("readCommand", () => {
  it("marks chat as read", async () => {
    const responses = new Map([
      ['POST:/transport/read:{"target":"channel:telegram:123"}', { ok: true }],
    ]);
    const ctx = makeFakeContext(responses, new FakeOutput(), async () => 123, 123);

    const result = await readCommand(ctx, {
      in: undefined,
    });

    expect(result.output).toBe("✓ Marked as read");
    expect(result.observation).toMatchObject({
      source: "irc.read",
      currentChatId: "123",
      targetChatId: "123",
    });
  });

  it("marks stable non-Telegram transport targets as read", async () => {
    const responses = new Map([
      ['POST:/transport/read:{"target":"channel:discord:guild-1/thread-2"}', { ok: true }],
    ]);
    const ctx = makeFakeContext(responses, new FakeOutput(), async () => {
      throw new Error("numeric resolver should not be called");
    });

    const result = await readCommand(ctx, {
      in: "channel:discord:guild-1/thread-2",
    });

    expect(result.output).toBe("✓ Marked as read");
    expect(result.observation).toMatchObject({
      source: "irc.read",
      targetChatId: "channel:discord:guild-1/thread-2",
    });
  });
});

describe("tailCommand", () => {
  it("formats messages as numbered list", async () => {
    const responses = new Map([
      [
        "GET:/chat/456/tail?limit=20",
        {
          messages: [
            {
              id: 1,
              sender: "Alice",
              senderId: "self",
              text: "hello",
              mediaType: null,
              outgoing: true,
              directed: false,
              timestamp: "2026-03-11T00:00:00.000Z",
            },
            {
              id: 2,
              sender: "Bob",
              senderId: "contact:2",
              text: "hi there",
              mediaType: null,
              outgoing: false,
              directed: true,
              timestamp: "2026-03-11T00:01:00.000Z",
            },
          ],
        },
      ],
    ]);
    const ctx = makeFakeContext(responses, new FakeOutput(), async () => 456, 123);

    const result = await tailCommand(ctx, {
      in: "@456",
      count: "20",
    });

    expect(result.output).toContain('1. (msgId 1) Alice: "hello"');
    expect(result.output).toContain('2. (msgId 2) Bob: "hi there"');
    expect(result.observation).toMatchObject({
      source: "irc.tail",
      currentChatId: "123",
      targetChatId: "456",
      payload: { count: 20, messageCount: 2 },
    });
  });

  it("returns rawResult with json flag", async () => {
    const responses = new Map([
      [
        "GET:/chat/123/tail?limit=10",
        {
          messages: [
            {
              id: 1,
              sender: "Mika",
              senderId: "contact:1",
              text: "test",
              mediaType: null,
              outgoing: false,
              directed: false,
              timestamp: "2026-03-11T00:00:00.000Z",
            },
          ],
        },
      ],
    ]);
    const ctx = makeFakeContext(responses, new FakeOutput());

    const result = await tailCommand(ctx, {
      in: undefined,
      count: "10",
      json: "", // 空字符串表示 JSON 模式
    });

    expect(result.rawResult).toEqual([
      {
        id: 1,
        sender: "Mika",
        senderId: "contact:1",
        text: "test",
        mediaType: null,
        outgoing: false,
        directed: false,
        timestamp: "2026-03-11T00:00:00.000Z",
      },
    ]);
  });

  it("shows (no messages) for empty result", async () => {
    const responses = new Map([["GET:/chat/123/tail?limit=20", []]]);
    const ctx = makeFakeContext(responses, new FakeOutput());

    const result = await tailCommand(ctx, {
      in: undefined,
      count: "20",
    });

    expect(result.output).toBe("(no messages)");
  });
});

describe("threadsCommand", () => {
  it("lists open threads", async () => {
    const responses = new Map([
      [
        "QUERY:/query/open_topics:{}",
        {
          ok: true,
          result: [
            { id: "thread:1", title: "Topic A" },
            { id: "thread:2", title: "Topic B" },
          ],
        },
      ],
    ]);
    const ctx = makeFakeContext(responses, new FakeOutput());

    const result = await threadsCommand(ctx, {});

    expect(result.output).toContain("1.");
    expect(result.output).toContain("2.");
  });
});

describe("whoisCommand", () => {
  it("returns chat info when no target provided", async () => {
    const responses = new Map([
      ["GET:/graph/channel:123/display_name", { value: "Test Chat" }],
      ["GET:/graph/channel:123/chat_type", { value: "supergroup" }],
      ["GET:/graph/channel:123/topic", { value: "Testing" }],
      ["GET:/graph/channel:123/unread", { value: 5 }],
      ["GET:/graph/channel:123/pending_directed", { value: 2 }],
      ["GET:/graph/channel:123/alice_role", { value: "member" }],
    ]);
    const ctx = makeFakeContext(responses, new FakeOutput());

    const result = await whoisCommand(ctx, {
      in: undefined,
      target: undefined,
    });

    expect(result.output).toContain("Test Chat");
    expect(result.output).toContain("supergroup");
    expect(result.output).toContain("Unread: 5");
  });

  it("handles string target (citty may return single string)", async () => {
    const responses = new Map([
      ['POST:/resolve/name:{"name":"test_user"}', { result: { telegramId: 999 } }],
      [
        'QUERY:/query/contact_profile:{"contactId":"contact:999"}',
        {
          contactId: "contact:999",
          display_name: "Test User",
        },
      ],
    ]);
    const ctx = makeFakeContext(responses, new FakeOutput());

    // 关键测试：target 是 string，不是 string[]
    const result = await whoisCommand(ctx, {
      in: undefined,
      target: "test_user", // string，不是 string[]
    });

    expect(result.output).toBeDefined();
    // 不应抛出 TypeError: targets.join is not a function
  });

  it("handles string target with spaces", async () => {
    const responses = new Map([
      ['POST:/resolve/name:{"name":"Test User Name"}', { result: { telegramId: 888 } }],
      [
        'QUERY:/query/contact_profile:{"contactId":"contact:888"}',
        {
          contactId: "contact:888",
          display_name: "Test User Name",
        },
      ],
    ]);
    const ctx = makeFakeContext(responses, new FakeOutput());

    const result = await whoisCommand(ctx, {
      in: undefined,
      target: "Test User Name",
    });

    expect(result.output).toBeDefined();
  });

  it("handles numeric target as contact ID", async () => {
    const responses = new Map([
      [
        'QUERY:/query/contact_profile:{"contactId":"contact:12345"}',
        {
          contactId: "contact:12345",
          display_name: "Numeric User",
        },
      ],
    ]);
    const ctx = makeFakeContext(responses, new FakeOutput());

    const result = await whoisCommand(ctx, {
      in: undefined,
      target: "12345", // 数字 ID
    });

    expect(result.output).toBeDefined();
  });

  it("returns rawResult with json flag", async () => {
    const responses = new Map([
      ["GET:/graph/channel:123/display_name", { value: "Test Chat" }],
      ["GET:/graph/channel:123/chat_type", { value: "supergroup" }],
      ["GET:/graph/channel:123/topic", null],
      ["GET:/graph/channel:123/unread", { value: 0 }],
      ["GET:/graph/channel:123/pending_directed", { value: 0 }],
      ["GET:/graph/channel:123/alice_role", null],
    ]);
    const ctx = makeFakeContext(responses, new FakeOutput());

    const result = await whoisCommand(ctx, {
      in: undefined,
      target: undefined,
      json: "", // 空字符串表示 JSON 模式
    });

    expect(result.rawResult).toEqual({
      chatId: 123,
      name: "Test Chat",
      chatType: "supergroup",
      topic: null,
      unread: 0,
      pendingDirected: 0,
      role: null,
    });
  });
});
