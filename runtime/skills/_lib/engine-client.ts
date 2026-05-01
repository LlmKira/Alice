/**
 * Skill CLI 共享模块 — Engine API 客户端 + 时间工具。
 *
 * 不 import 引擎代码（遵守 ADR-202 P4），只依赖 node:http。
 * calendar/countdown 等需要 Engine API 的 CLI 脚本共用此模块。
 *
 * 环境变量：
 * - ALICE_ENGINE_URL: Engine API TCP URL（如 http://host.docker.internal:3380）
 * - ALICE_SKILL: Skill 名称（X-Alice-Skill header）
 *
 * @see docs/adr/202-engine-api.md
 */

import { request } from "node:http";

// ── Engine API 客户端 ──

// Engine /telegram/send 会先发送 typing indicator，长文本最多等待 8s 再真正发送。
// 客户端超时必须覆盖这个真实路径，否则会出现“消息已发出但 CLI 记为失败”的幽灵重试。
const TIMEOUT_MS = 20_000;

export class EngineApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly method: string,
    readonly path: string,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "EngineApiError";
  }
}

/**
 * 底层请求函数。URL 缺失时返回 null（graceful degradation）。
 * 非 2xx 响应会 reject（fix F2: 不再静默吞掉 403/500）。
 */
function engineRequest(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown | null> {
  const raw = process.env.ALICE_ENGINE_URL;
  if (!raw) return Promise.resolve(null);

  const url = new URL(raw);

  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    const skillName = process.env.ALICE_SKILL;
    if (skillName) {
      headers["X-Alice-Skill"] = skillName;
    }

    let payload: string | undefined;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }

    const req = request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path,
        method,
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            let parsed: Record<string, unknown> | null = null;
            try {
              parsed = data ? (JSON.parse(data) as Record<string, unknown>) : null;
            } catch {
              parsed = null;
            }
            const code = typeof parsed?.code === "string" ? parsed.code : null;
            const message =
              typeof parsed?.error === "string"
                ? parsed.error
                : `Engine API returned ${res.statusCode} for ${method} ${path}`;
            reject(new EngineApiError(res.statusCode, method, path, code, message));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data || null);
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy(new Error("Engine API timeout"));
    });
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

/**
 * GET 请求。URL 缺失时返回 null，其他错误直接抛出。
 */
export async function engineGet(path: string): Promise<unknown | null> {
  return engineRequest("GET", path);
}

/**
 * POST 请求。URL 缺失时返回 null，其他错误直接抛出。
 */
export async function enginePost(path: string, body: unknown): Promise<unknown | null> {
  return engineRequest("POST", path, body);
}

/**
 * Query 端点专用 POST（/query/*, /cmd/* 等）。
 * Engine API 的 query 路由返回 {ok, result} 信封，
 * 此函数自动解包返回 result 字段。
 * @see docs/adr/236-cli-output-structural-fix.md
 */
export async function engineQuery(path: string, body: unknown): Promise<unknown | null> {
  const raw = await enginePost(path, body);
  if (raw != null && typeof raw === "object" && "ok" in raw && "result" in raw) {
    return (raw as { result: unknown }).result;
  }
  return raw;
}

// ── 配置读取 ──

/**
 * 通过 Engine API 读取 timezoneOffset 配置。
 * 无 ALICE_ENGINE_URL 或请求失败时 fallback 到 0 (UTC)。
 */
export async function fetchTimezoneOffset(): Promise<number> {
  try {
    const json = (await engineGet("/config/timezoneOffset")) as { value: number } | null;
    if (!json) return 0;
    const offset = Number(json.value);
    return Number.isFinite(offset) ? offset : 0;
  } catch {
    return 0;
  }
}

// ── 时间工具 ──

/**
 * 构造指定时区偏移的"伪 UTC" Date 对象。
 *
 * **重要**：返回的 Date 必须通过 `getUTCFullYear()/getUTCMonth()/getUTCDate()/getUTCHours()`
 * 等 UTC 系列方法读取，才能得到正确的本地时间。使用 `getFullYear()` 等本地方法会得到错误结果。
 */
export function localNow(timezoneOffset: number): Date {
  const offsetMs = timezoneOffset * 60 * 60 * 1000;
  return new Date(Date.now() + offsetMs);
}

/** 解析 YYYY-MM-DD 格式日期字符串。 */
export function parseYMD(dateStr: string): { year: number; month: number; day: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const [year, month, day] = dateStr.split("-").map(Number);
  return { year, month, day };
}

/** 格式化为 YYYY-MM-DD。 */
export function formatYMD(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** 根据小时返回中文时段。 */
export function timePeriod(hour: number): string {
  if (hour < 6) return "凌晨";
  if (hour < 12) return "上午";
  if (hour < 18) return "下午";
  return "晚上";
}

/** 格式化时区偏移为 UTC+N / UTC-N。 */
export function formatTimezone(offset: number): string {
  return `UTC${offset >= 0 ? "+" : ""}${offset}`;
}
