/**
 * 模型网关（OhMyGPT，OpenAI 兼容，LLM_API_KEY）：发言、想一想、看图、听语音、翻相册的重排、语音合成、执行代理，
 * 所有经网关的调用都走 post——鉴权、超时、重试、读扣费、记账只在这一处。调用方只拼请求体、读回复。
 * 记账回调是必填的：每次成功的响应当场记一笔（执行代理办到一半，花费上限也拦得住）。
 *
 * 扣费优先用网关自己报的：每次响应带 `x-cost-credits` 头（探针 2026-11-11：flash-lite 输入 4405 token
 * 扣 299 credits，按下表估 297）。拿不到这个头时才按下表估。250,000 credits = 1 美元。
 */
import type { SpendKind } from "../ops/spend.js";

export const GATEWAY_URL = "https://api.ohmygpt.com/v1";
export const CREDITS_PER_USD = 250_000;

/** 每百万 token 的 credits（网关 /v1/models 的 price_credits）。 */
const PRICE_CREDITS_PER_M: Readonly<Record<string, { input: number; output: number }>> = {
  // 2026-11-11 读
  "google/gemini-3.5-flash-lite": { input: 67_500, output: 562_500 },
  "google/gemini-3-flash-preview": { input: 112_500, output: 675_000 },
  // 2026-11-13 读，2027-01-01 前的价；思考按输出算
  "google/gemini-3.8-flash": { input: 168_750, output: 843_750 },
  "cohere/rerank-v5.0-pro": { input: 13_750, output: 0 },
  "deepseek/deepseek-v4-flash-0731": { input: 27_600, output: 55_000 },
};

/** 表里没有的模型按表里最贵的一档估：宁可多算，花费上限才不会被悄悄绕过。 */
const FALLBACK = {
  input: Math.max(...Object.values(PRICE_CREDITS_PER_M).map((p) => p.input)),
  output: Math.max(...Object.values(PRICE_CREDITS_PER_M).map((p) => p.output)),
};

export interface Tokens {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
}

/** 记一笔账：哪一类、哪个模型、多少美元；credits 是网关报的扣费（没报、按价格表估的为 null）。 */
export interface Spent extends Tokens {
  kind: SpendKind;
  model: string;
  usd: number;
  credits: number | null;
}

export type Charge = (spent: Spent) => void;

export class GatewayError extends Error {
  constructor(
    message: string,
    /** HTTP 状态；网络错误为 null。 */
    readonly status: number | null,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export interface GatewayCall<T> {
  kind: SpendKind;
  model: string;
  /** 网关下的路径，如 "/chat/completions"。 */
  path: string;
  body: object;
  timeoutMs: number;
  /** 5xx、429 和网络错误时最多试几次（退避 1、2、4 秒……）；默认 1。 */
  attempts?: number;
  /** 从回复里读用量（各接口写法不同）。 */
  tokens(body: T): Tokens;
  /** 中止（暂停、停机）：不再重试，抛 signal.reason。 */
  signal?: AbortSignal;
}

export interface Gateway {
  /** 成功时已经记过账；回复体原样返回，和这次记的账一起。 */
  post<T>(call: GatewayCall<T>): Promise<{ body: T; spent: Spent }>;
  /** 不经网关的花费（执行代理的搜索）也记进同一本账。 */
  charge: Charge;
}

/** 响应头里的扣费（credits）；没有或读不懂时为 null。 */
function creditsHeader(response: Response): number | null {
  const raw = response.headers.get("x-cost-credits");
  const credits = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(credits) && credits >= 0 ? credits : null;
}

function usdOf(model: string, credits: number | null, t: Tokens): number {
  if (credits !== null) return credits / CREDITS_PER_USD;
  const price = PRICE_CREDITS_PER_M[model] ?? FALLBACK;
  const estimated = (t.promptTokens * price.input + t.completionTokens * price.output) / 1_000_000;
  return estimated / CREDITS_PER_USD;
}

export function createGateway(options: {
  apiKey: string;
  charge: Charge;
  fetch?: typeof fetch;
}): Gateway {
  const doFetch = options.fetch ?? fetch;
  return {
    charge: options.charge,
    async post<T>(call: GatewayCall<T>) {
      const attempts = call.attempts ?? 1;
      let last: GatewayError | null = null;
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
        call.signal?.throwIfAborted();
        const timeout = AbortSignal.timeout(call.timeoutMs);
        let response: Response;
        try {
          response = await doFetch(`${GATEWAY_URL}${call.path}`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${options.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(call.body),
            signal: call.signal ? AbortSignal.any([timeout, call.signal]) : timeout,
          });
        } catch (error) {
          call.signal?.throwIfAborted();
          last = new GatewayError(`network: ${String(error)}`, null);
          continue;
        }
        if (response.ok) {
          const body = (await response.json()) as T;
          const tokens = call.tokens(body);
          const credits = creditsHeader(response);
          const spent: Spent = {
            kind: call.kind,
            model: call.model,
            usd: usdOf(call.model, credits, tokens),
            credits,
            ...tokens,
          };
          options.charge(spent);
          return { body, spent };
        }
        last = new GatewayError(
          `${call.path} ${response.status} ${(await response.text()).slice(0, 200)}`,
          response.status,
        );
        if (response.status < 500 && response.status !== 429) throw last;
      }
      throw last ?? new GatewayError("no attempt made", null);
    },
  };
}

/** OpenAI 兼容接口的用量写法（chat/completions）。 */
export interface ChatUsage {
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

export function chatTokens(body: ChatUsage): Tokens {
  return {
    promptTokens: body.usage?.prompt_tokens ?? 0,
    completionTokens: body.usage?.completion_tokens ?? 0,
    reasoningTokens: body.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}
