/**
 * Vercel AI SDK — 多 LLM endpoint fallback 链。
 *
 * D5（ADR-123 §D5）：将单一 provider 单例扩展为有序 endpoint 数组。
 * 每个 endpoint 拥有独立的熔断器（via resilience.ts per-endpoint breaker）。
 * `selectProviderForFirstPass()` 按 firstPass 路由返回首轮/通用结构化任务的 endpoint，
 * `selectProviderForTick()` 按 toolTick 路由返回后续 shell/tool 执行模型。
 * 路由内全部 open 时退回第一个（等待半开放试探）。
 *
 * 使用 @ai-sdk/openai-compatible（而非 @ai-sdk/openai），
 * 因为 Alice 连接的是 OpenAI 兼容代理（如 ohmygpt），不是 OpenAI 原生 API。
 *
 * @see docs/adr/123-crystallization-substrate-generalization.md §D5
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Config, ProviderConfig } from "../config.js";
import { getBreakerState } from "./resilience.js";

// -- 类型 -------------------------------------------------------------------

interface ProviderEntry {
  config: ProviderConfig;
  provider: ReturnType<typeof createOpenAICompatible>;
}

export interface AvailableProvider {
  provider: ReturnType<typeof createOpenAICompatible>;
  model: string;
  name: string;
}

// -- 状态 -------------------------------------------------------------------

let _providers: ProviderEntry[] = [];
let _routing: Config["llmRouting"] = {
  firstPass: [],
  toolTick: [],
  eval: [],
  auxiliary: [],
  reflect: [],
};
const _providerByName = new Map<string, ProviderEntry>();
const _routeBags = new Map<string, string[]>();

// -- 公共 API ---------------------------------------------------------------

/** 从 Config.providers 初始化 endpoint 链。启动时调用一次。 */
export function initProviders(config: Config): void {
  _providers = config.providers.map((pc) => ({
    config: pc,
    provider: createOpenAICompatible({
      name: pc.name,
      baseURL: pc.baseUrl,
      apiKey: pc.apiKey,
      // 启用 json_schema 模式，让 generateObject 发送完整 schema 给 API，
      // 服务端强制 structured output。否则只发 { type: "json_object" }，
      // LLM 返回自由格式 JSON → Zod 验证系统性失败。
      // @see https://github.com/vercel/ai/issues/5197
      supportsStructuredOutputs: true,
    }),
  }));
  _providerByName.clear();
  for (const entry of _providers) {
    _providerByName.set(entry.config.name, entry);
  }
  _routing = config.llmRouting ?? {
    firstPass: _providers.map((entry) => entry.config.name),
    toolTick: _providers.map((entry) => entry.config.name),
    eval: _providers.map((entry) => entry.config.name),
    auxiliary: _providers.map((entry) => entry.config.name),
    reflect: _providers.map((entry) => entry.config.name),
  };
  _routeBags.clear();
}

/**
 * 返回当前可用的 firstPass endpoint（跳过熔断器 open 的）。
 * firstPass 用于首轮/通用结构化任务，不代表后续 shell/tool tick 执行模型。
 * 全部 open 时退回第一个，等待半开放试探。
 */
export function selectProviderForFirstPass(): AvailableProvider {
  return selectShuffledAvailableFromRoute("firstPass", _routing.firstPass);
}

function selectAvailableFromRoute(route: readonly string[], routeName: string): AvailableProvider {
  if (_providers.length === 0) {
    throw new Error("No providers initialized — call initProviders() first");
  }
  const entries = route.flatMap((name) => {
    const entry = _providerByName.get(name);
    return entry ? [entry] : [];
  });
  if (entries.length === 0) {
    throw new Error(`No providers configured for LLM route "${routeName}"`);
  }

  for (const entry of entries) {
    if (getBreakerState(entry.config.name) !== "open") {
      return { provider: entry.provider, model: entry.config.model, name: entry.config.name };
    }
  }
  // 全部 open → 强制使用路由第一个（等待半开放试探）
  const first = entries[0];
  return { provider: first.provider, model: first.config.model, name: first.config.name };
}

function nextEndpointFromRoute(routeName: string, route: readonly string[]): string {
  let bag = _routeBags.get(routeName);
  if (!bag || bag.length === 0) {
    bag = shuffle([...route]);
    _routeBags.set(routeName, bag);
  }
  return bag.pop() ?? route[0] ?? "";
}

function selectShuffledAvailableFromRoute(
  routeName: string,
  route: readonly string[],
): AvailableProvider {
  for (let attempt = 0; attempt < route.length; attempt++) {
    const endpointName = nextEndpointFromRoute(routeName, route);
    const entry = _providerByName.get(endpointName);
    if (entry && getBreakerState(entry.config.name) !== "open") {
      return { provider: entry.provider, model: entry.config.model, name: entry.config.name };
    }
  }
  return selectAvailableFromRoute(route, routeName);
}

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/**
 * tick 入口使用的模型选择。
 *
 * 轮换身份是稳定模型 ID（AvailableProvider.model），不是 endpoint name。
 * endpoint name 只用于路由、熔断和传输诊断。
 *
 * 选择边界是 tick subcycle：同一个 subcycle 内的修正/续轮应复用同一个模型，
 * 避免一次行动里人格和推理口径漂移。
 */
export function selectProviderForTick(): AvailableProvider {
  return selectShuffledAvailableFromRoute("toolTick", _routing.toolTick);
}

/**
 * Eval / calibration 使用的 provider。
 *
 * 独立于生产 firstPass/toolTick，避免测试模型选择反向污染线上路由。
 */
export function getEvalProvider(): AvailableProvider {
  return selectAvailableFromRoute(_routing.eval, "eval");
}

/**
 * 应用内部辅助任务使用的 provider。
 *
 * 不参与 toolTick 执行池；按 llm.routing.auxiliary 的 fallback 顺序选择。
 */
export function getAuxiliaryProvider(): AvailableProvider {
  return selectAvailableFromRoute(_routing.auxiliary, "auxiliary");
}

/**
 * 是否有任何 provider 的熔断器不在 open 状态。
 *
 * evolve 层在 directed_override 前调用此函数——
 * 全部 provider 熔断时强制行动只会空转浪费 tick。
 *
 * @see docs/adr/156-emotional-reactivity-damping.md — 级联故障修复
 */
export function isAnyProviderHealthy(): boolean {
  if (_providers.length === 0) return false;
  return _providers.some((entry) => getBreakerState(entry.config.name) !== "open");
}

/** 重置 provider 列表（用于测试）。 */
export function resetProviders(): void {
  _providers = [];
  _providerByName.clear();
  _routing = { firstPass: [], toolTick: [], eval: [], auxiliary: [], reflect: [] };
  _routeBags.clear();
}
