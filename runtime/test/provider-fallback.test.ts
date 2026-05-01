/**
 * D5: Provider Fallback 链 — 单元测试。
 *
 * 测试覆盖：
 * 1. 多 provider 初始化 + 默认选择
 * 2. breaker open → fallback 到下一个 provider
 * 3. 全部 breaker open → 退回第一个
 * 4. 单 provider 向后兼容
 *
 * @see docs/adr/123-crystallization-substrate-generalization.md §D5
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";

// mock @ai-sdk/openai-compatible（避免真实 HTTP 连接）
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: vi.fn((opts: { name: string }) => {
    const providerFn = (model: string) => `${opts.name}:${model}`;
    providerFn._name = opts.name;
    return providerFn;
  }),
}));

import {
  getAuxiliaryProvider,
  getEvalProvider,
  initProviders,
  resetProviders,
  selectProviderForFirstPass,
  selectProviderForTick,
} from "../src/llm/client.js";
import {
  type BreakerEventType,
  onBreakerStateChange,
  resetCircuitBreaker,
  withResilience,
} from "../src/llm/resilience.js";

// 制造 breaker open 状态的辅助函数
async function tripBreaker(providerName: string, failures = 5): Promise<void> {
  for (let i = 0; i < failures; i++) {
    try {
      await withResilience(
        () => Promise.reject(Object.assign(new Error("503"), { status: 503 })),
        { maxRetries: 0, circuitThreshold: failures },
        providerName,
      );
    } catch {
      // 预期失败
    }
  }
}

function mockConfig(
  providers: Config["providers"],
  routing?: Partial<Config["llmRouting"]>,
): Pick<Config, "providers" | "llmRouting"> {
  const names = providers.map((provider) => provider.name);
  return {
    providers,
    llmRouting: {
      firstPass: routing?.firstPass ?? names,
      toolTick: routing?.toolTick ?? routing?.firstPass ?? names,
      eval: routing?.eval ?? routing?.firstPass ?? names,
      auxiliary: routing?.auxiliary ?? routing?.firstPass ?? names,
      reflect: routing?.reflect ?? routing?.firstPass ?? names,
    },
  };
}

afterEach(() => {
  resetProviders();
  resetCircuitBreaker();
});

describe("D5: Provider Fallback", () => {
  it("多 provider 初始化 + firstPass 使用显式路由", () => {
    initProviders(
      mockConfig(
        [
          { name: "primary", baseUrl: "https://a.io/v1", apiKey: "k1", model: "m1" },
          { name: "secondary", baseUrl: "https://b.io/v1", apiKey: "k2", model: "m2" },
        ],
        { firstPass: ["primary"], toolTick: ["secondary"] },
      ) as Config,
    );

    const result = selectProviderForFirstPass();
    expect(result.name).toBe("primary");
    expect(result.model).toBe("m1");
  });

  it("firstPass route 使用 shuffle bag 覆盖首轮模型池", () => {
    initProviders(
      mockConfig(
        [
          { name: "p1", baseUrl: "https://a.io/v1", apiKey: "k1", model: "m1" },
          { name: "p2", baseUrl: "https://b.io/v1", apiKey: "k2", model: "m2" },
          { name: "p3", baseUrl: "https://c.io/v1", apiKey: "k3", model: "m3" },
        ],
        { firstPass: ["p1", "p2", "p3"], toolTick: ["p1"] },
      ) as Config,
    );

    const firstBag = new Set(Array.from({ length: 3 }, () => selectProviderForFirstPass().model));
    const secondBag = new Set(Array.from({ length: 3 }, () => selectProviderForFirstPass().model));

    expect(firstBag).toEqual(new Set(["m1", "m2", "m3"]));
    expect(secondBag).toEqual(new Set(["m1", "m2", "m3"]));
  });

  it("primary breaker open → fallback 到 secondary", async () => {
    initProviders(
      mockConfig([
        { name: "primary", baseUrl: "https://a.io/v1", apiKey: "k1", model: "m1" },
        { name: "secondary", baseUrl: "https://b.io/v1", apiKey: "k2", model: "m2" },
      ]) as Config,
    );

    // 让 primary 的 breaker open
    await tripBreaker("primary");

    const result = selectProviderForFirstPass();
    expect(result.name).toBe("secondary");
    expect(result.model).toBe("m2");
  });

  it("全部 breaker open → 退回第一个", async () => {
    initProviders(
      mockConfig([
        { name: "primary", baseUrl: "https://a.io/v1", apiKey: "k1", model: "m1" },
        { name: "secondary", baseUrl: "https://b.io/v1", apiKey: "k2", model: "m2" },
      ]) as Config,
    );

    await tripBreaker("primary");
    await tripBreaker("secondary");

    const result = selectProviderForFirstPass();
    expect(result.name).toBe("primary");
  });

  it("单 endpoint 可用", () => {
    initProviders(
      mockConfig([
        {
          name: "first-pass",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-test",
          model: "gpt-4o",
        },
      ]) as Config,
    );

    const result = selectProviderForFirstPass();
    expect(result.name).toBe("first-pass");
    expect(result.model).toBe("gpt-4o");
  });

  it("未初始化时 selectProviderForFirstPass 抛出", () => {
    expect(() => selectProviderForFirstPass()).toThrow("No providers initialized");
  });

  it("tick 入口按模型 ID 轮换，endpoint name 只作为路由键", () => {
    initProviders(
      mockConfig(
        [
          { name: "p1", baseUrl: "https://a.io/v1", apiKey: "k1", model: "m1" },
          { name: "p2", baseUrl: "https://b.io/v1", apiKey: "k2", model: "m2" },
          { name: "p3", baseUrl: "https://c.io/v1", apiKey: "k3", model: "m3" },
        ],
        { firstPass: ["p1"], toolTick: ["p1", "p2", "p3"] },
      ) as Config,
    );

    const firstBag = new Set(Array.from({ length: 3 }, () => selectProviderForTick().model));
    const secondBag = new Set(Array.from({ length: 3 }, () => selectProviderForTick().model));

    expect(firstBag).toEqual(new Set(["m1", "m2", "m3"]));
    expect(secondBag).toEqual(new Set(["m1", "m2", "m3"]));
  });

  it("auxiliary provider 使用辅助路由，不参与 toolTick 模型池", () => {
    initProviders(
      mockConfig(
        [
          { name: "first-pass", baseUrl: "https://a.io/v1", apiKey: "k1", model: "first-model" },
          { name: "tool-a", baseUrl: "https://b.io/v1", apiKey: "k2", model: "tool-model-a" },
          { name: "tool-b", baseUrl: "https://c.io/v1", apiKey: "k3", model: "tool-model-b" },
          {
            name: "auxiliary",
            baseUrl: "https://d.io/v1",
            apiKey: "k4",
            model: "auxiliary-model",
          },
        ],
        {
          firstPass: ["first-pass"],
          toolTick: ["tool-a", "tool-b"],
          auxiliary: ["auxiliary", "first-pass"],
        },
      ) as Config,
    );

    expect(selectProviderForFirstPass().model).toBe("first-model");
    expect(getAuxiliaryProvider().model).toBe("auxiliary-model");
    expect(new Set([selectProviderForTick().name, selectProviderForTick().name])).toEqual(
      new Set(["tool-a", "tool-b"]),
    );
  });

  it("firstPass 可包含 Gemini，但 toolTick 工具执行池保持独立", () => {
    initProviders(
      mockConfig(
        [
          {
            name: "first-pass-gemini",
            baseUrl: "https://a.io/v1",
            apiKey: "k1",
            model: "vertex-gemini-3-flash-preview",
          },
          {
            name: "tool-v4",
            baseUrl: "https://b.io/v1",
            apiKey: "k2",
            model: "deepseek-v4-flash",
          },
        ],
        { firstPass: ["first-pass-gemini", "tool-v4"], toolTick: ["tool-v4"] },
      ) as Config,
    );

    const firstPassBag = new Set(Array.from({ length: 2 }, () => selectProviderForFirstPass().model));
    expect(firstPassBag).toEqual(
      new Set(["vertex-gemini-3-flash-preview", "deepseek-v4-flash"]),
    );
    expect(selectProviderForTick().model).toBe("deepseek-v4-flash");
  });

  it("eval route 独立于 firstPass 和 toolTick", () => {
    initProviders(
      mockConfig(
        [
          { name: "first-pass", baseUrl: "https://a.io/v1", apiKey: "k1", model: "first-model" },
          { name: "tool", baseUrl: "https://b.io/v1", apiKey: "k2", model: "tool-model" },
          { name: "eval", baseUrl: "https://c.io/v1", apiKey: "k3", model: "eval-model" },
        ],
        { firstPass: ["first-pass"], toolTick: ["tool"], eval: ["eval"] },
      ) as Config,
    );

    expect(selectProviderForFirstPass().model).toBe("first-model");
    expect(selectProviderForTick().model).toBe("tool-model");
    expect(getEvalProvider().model).toBe("eval-model");
  });

  it("auxiliary route 的第一个 endpoint 熔断后 fallback 到下一个", async () => {
    initProviders(
      mockConfig(
        [
          { name: "first-pass", baseUrl: "https://a.io/v1", apiKey: "k1", model: "first-model" },
          {
            name: "auxiliary",
            baseUrl: "https://b.io/v1",
            apiKey: "k2",
            model: "auxiliary-model",
          },
        ],
        { firstPass: ["first-pass"], auxiliary: ["auxiliary", "first-pass"] },
      ) as Config,
    );

    await tripBreaker("auxiliary");

    const result = getAuxiliaryProvider();
    expect(result.name).toBe("first-pass");
    expect(result.model).toBe("first-model");
  });
});

// ADR-129: 熔断器状态变化监听器
describe("ADR-129: breaker state change listener", () => {
  it("breaker open 时触发 listener", async () => {
    const events: Array<{ name: string; event: BreakerEventType }> = [];
    onBreakerStateChange((name, event) => events.push({ name, event }));

    await tripBreaker("test-provider", 5);

    expect(events).toContainEqual({ name: "test-provider", event: "open" });
  });

  it("breaker 恢复（half-open → closed）时触发 listener", async () => {
    const events: Array<{ name: string; event: BreakerEventType }> = [];
    onBreakerStateChange((name, event) => events.push({ name, event }));

    // 先让 breaker open
    await tripBreaker("recover-test", 5);

    // 等待 resetMs 过期（默认 60s，但 tripBreaker 用 circuitThreshold=5）
    // 直接做一次成功调用来触发 half-open → closed
    // 需要先让 breaker 进入 half-open（手动用短 resetMs）
    try {
      await withResilience(
        () => Promise.reject(Object.assign(new Error("503"), { status: 503 })),
        { maxRetries: 0, circuitThreshold: 1, circuitResetMs: 0 },
        "fast-recover",
      );
    } catch {
      // open
    }

    // resetMs=0 → 立即 half-open，下一次请求放行
    const result = await withResilience(
      () => Promise.resolve("ok"),
      { circuitResetMs: 0 },
      "fast-recover",
    );
    expect(result).toBe("ok");
    expect(events).toContainEqual({ name: "fast-recover", event: "closed" });
  });

  it("listener 异常不影响 breaker 工作", async () => {
    onBreakerStateChange(() => {
      throw new Error("listener error");
    });

    // 应该不抛出
    await tripBreaker("error-listener", 5);
    // breaker 仍然正常 open
  });
});
