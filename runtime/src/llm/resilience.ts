/**
 * LLM API 弹性层：重试 + 指数退避 + 熔断器。
 *
 * 三重保护：
 * 1. 指数退避重试（带 jitter）—— 应对瞬时 429/5xx
 * 2. 熔断器（closed → open → half-open）—— 连续失败时快速失败，避免雪崩
 * 3. AbortSignal 超时 —— 由调用方传入（act.ts 的 60s 超时不变）
 *
 * @see docs/adr/02-architecture-overview.md
 */
import { createLogger } from "../utils/logger.js";

const log = createLogger("resilience");

// -- 配置 -------------------------------------------------------------------

export interface ResilienceConfig {
  /** 最大重试次数（不含首次调用）。默认 2。 */
  maxRetries: number;
  /** 退避基础延迟 (ms)。默认 1000。 */
  baseDelay: number;
  /** 退避最大延迟 (ms)。默认 15000。 */
  maxDelay: number;
  /** 连续失败 N 次后熔断。默认 5。 */
  circuitThreshold: number;
  /** 熔断恢复时间 (ms)。默认 60000。 */
  circuitResetMs: number;
}

const DEFAULT_CONFIG: ResilienceConfig = {
  maxRetries: 2,
  baseDelay: 1000,
  maxDelay: 15000,
  circuitThreshold: 5,
  circuitResetMs: 60_000,
};

// -- 熔断器 -----------------------------------------------------------------

export type CircuitState = "closed" | "open" | "half-open";

/** 熔断器状态变化事件类型。 */
export type BreakerEventType = "open" | "half-open" | "closed";

class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private lastFailureTime = 0;

  constructor(
    private readonly threshold: number,
    private readonly resetMs: number,
    private readonly onStateChange?: (event: BreakerEventType) => void,
  ) {}

  /**
   * 评估时间驱动的状态转换。
   * open 且已过 resetMs → 提升为 half-open。
   * 由 getState() 和 allowRequest() 调用，确保状态始终与墙钟同步。
   */
  private tick(): void {
    if (this.state === "open" && Date.now() - this.lastFailureTime >= this.resetMs) {
      this.state = "half-open";
      log.info("Circuit breaker → half-open");
      this.onStateChange?.("half-open");
    }
  }

  /** 检查是否允许请求通过。 */
  allowRequest(): boolean {
    this.tick();
    return this.state === "closed" || this.state === "half-open";
  }

  /** 记录成功。 */
  recordSuccess(): void {
    if (this.state === "half-open") {
      log.info("Circuit breaker → closed (probe succeeded)");
    }
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.onStateChange?.("closed");
  }

  /** 记录失败。 */
  recordFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    if (this.state === "half-open") {
      // 探测失败，重新打开
      this.state = "open";
      log.warn("Circuit breaker → open (probe failed)");
      this.onStateChange?.("open");
      return;
    }

    if (this.consecutiveFailures >= this.threshold) {
      this.state = "open";
      log.warn("Circuit breaker → open", {
        failures: this.consecutiveFailures,
        threshold: this.threshold,
      });
      this.onStateChange?.("open");
    }
  }

  getState(): CircuitState {
    this.tick();
    return this.state;
  }
}

// -- 可重试错误判断 -----------------------------------------------------------

/** 判断错误是否可重试（429, 502, 503, 504, 超时、网络错误）。 */
function isRetryable(error: unknown): boolean {
  if (error instanceof Error) {
    // 超时
    if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  }

  const nodeCode = extractErrorCode(error);
  if (nodeCode === "ETIMEDOUT" || nodeCode === "ECONNRESET" || nodeCode === "ECONNREFUSED") {
    return true;
  }

  // HTTP 状态码（Vercel AI SDK 和 openai SDK 都在 error 上暴露 status）
  const status = extractStatus(error);
  if (status !== null) {
    // 429 Too Many Requests, 502/503/504 服务端错误
    return status === 429 || status === 502 || status === 503 || status === 504;
  }

  return false;
}

function extractErrorCode(error: unknown): string | null {
  if (error == null || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") return code;
  const cause = (error as { cause?: unknown }).cause;
  return cause ? extractErrorCode(cause) : null;
}

/** 从各种错误格式中提取 HTTP status。 */
function extractStatus(error: unknown): number | null {
  if (error == null || typeof error !== "object") return null;
  const obj = error as Record<string, unknown>;
  // Vercel AI SDK: APICallError.statusCode, openai SDK: .status
  for (const key of ["statusCode", "status"]) {
    const val = obj[key];
    if (typeof val === "number" && val >= 100 && val < 600) return val;
  }
  // 嵌套在 cause 中
  if (obj.cause && typeof obj.cause === "object") {
    return extractStatus(obj.cause);
  }
  return null;
}

// -- 退避计算 ---------------------------------------------------------------

/** 带 jitter 的指数退避。 */
function backoffDelay(attempt: number, baseDelay: number, maxDelay: number): number {
  const exponential = baseDelay * 2 ** attempt;
  // full jitter: [0, min(exponential, maxDelay)]
  const capped = Math.min(exponential, maxDelay);
  return Math.random() * capped;
}

// -- per-provider 熔断器实例（ADR-123 §D5）-----------------------------------

const _breakers = new Map<string, CircuitBreaker>();

/** 熔断器状态变化监听器。 */
type BreakerListener = (providerName: string, event: BreakerEventType) => void;
const _breakerListeners: BreakerListener[] = [];

function emitBreakerEvent(name: string, event: BreakerEventType): void {
  for (const listener of _breakerListeners) {
    try {
      listener(name, event);
    } catch (e) {
      log.warn("Breaker listener error", e);
    }
  }
}

/**
 * 注册熔断器状态变化监听器。启动时调用一次。
 * @see docs/adr/129-llm-voice-loss-awareness.md
 */
export function onBreakerStateChange(listener: BreakerListener): void {
  _breakerListeners.push(listener);
}

function getBreaker(name: string, config: ResilienceConfig): CircuitBreaker {
  let breaker = _breakers.get(name);
  if (!breaker) {
    breaker = new CircuitBreaker(config.circuitThreshold, config.circuitResetMs, (event) => {
      emitBreakerEvent(name, event);
    });
    _breakers.set(name, breaker);
  }
  return breaker;
}

/** 查询指定 provider 的熔断器状态（不创建新实例）。 */
export function getBreakerState(name: string): CircuitState {
  return _breakers.get(name)?.getState() ?? "closed";
}

/** 重置所有熔断器和监听器（用于测试）。 */
export function resetCircuitBreaker(): void {
  _breakers.clear();
  _breakerListeners.length = 0;
}

// -- 公共 API ---------------------------------------------------------------

export class CircuitOpenError extends Error {
  constructor() {
    super("Circuit breaker is open — LLM calls temporarily disabled");
    this.name = "CircuitOpenError";
  }
}

export class ProviderUnavailableError extends Error {
  constructor(readonly cause: unknown) {
    super("LLM provider unavailable after resilience retries");
    this.name = "ProviderUnavailableError";
  }
}

/**
 * 用弹性层包装异步 LLM 调用。
 *
 * @example
 * ```ts
 * const { object } = await withResilience(() =>
 *   generateObject({ model, schema, system, prompt, temperature: 0.7 })
 * );
 * ```
 */
export async function withResilience<T>(
  fn: () => Promise<T>,
  config: Partial<ResilienceConfig> = {},
  providerName = "default",
): Promise<T> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const breaker = getBreaker(providerName, cfg);

  // 熔断检查
  if (!breaker.allowRequest()) {
    throw new CircuitOpenError();
  }

  let lastError: unknown;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      const result = await fn();
      breaker.recordSuccess();
      return result;
    } catch (error) {
      lastError = error;

      // 不可重试的错误直接抛出（400, 401, 403 等）
      if (!isRetryable(error)) {
        breaker.recordFailure();
        throw error;
      }

      // 最后一次尝试，不再重试
      if (attempt === cfg.maxRetries) {
        breaker.recordFailure();
        break;
      }

      // 退避等待
      const delay = backoffDelay(attempt, cfg.baseDelay, cfg.maxDelay);
      log.warn("LLM call failed, retrying", {
        attempt: attempt + 1,
        maxRetries: cfg.maxRetries,
        delayMs: Math.round(delay),
        error: error instanceof Error ? error.message : String(error),
      });

      await new Promise((resolve) => setTimeout(resolve, delay));

      // 重试前再次检查熔断器（可能在等待期间被其他调用触发）
      if (!breaker.allowRequest()) {
        throw new CircuitOpenError();
      }
    }
  }

  throw new ProviderUnavailableError(lastError);
}
