/**
 * Shared shell-native CLI bridge helpers.
 *
 * @see docs/adr/235-cli-human-readable-output.md
 */

import { request } from "node:http";

function getEngineUrl(): URL {
  const raw = process.env.ALICE_ENGINE_URL;
  if (raw) return new URL(raw);
  const port = process.env.ALICE_ENGINE_PORT;
  if (port) return new URL(`http://127.0.0.1:${port}`);
  throw new Error("ALICE_ENGINE_URL or ALICE_ENGINE_PORT not set");
}

export function parseCliValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;

  const n = Number(raw);
  if (raw.trim() !== "" && Number.isFinite(n) && /^-?\d+(?:\.\d+)?$/.test(raw)) {
    return n;
  }

  if (
    (raw.startsWith("{") && raw.endsWith("}")) ||
    (raw.startsWith("[") && raw.endsWith("]")) ||
    (raw.startsWith('"') && raw.endsWith('"'))
  ) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  return raw;
}

export function parseKeyValueArgs(args: string[]): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 2) {
        const key = arg.slice(2, eq);
        const value = arg.slice(eq + 1);
        body[key] = parseCliValue(value);
        i++;
        continue;
      }

      // 下一个参数是值（除非它以 -- 开头，那是另一个 flag）
      // 单 - 后跟数字（如 -1009900000001）是合法值（负数 Telegram ID）
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        body[arg.slice(2)] = parseCliValue(args[i + 1]);
        i += 2;
        continue;
      }

      // --flag 无值 → true（布尔标志）
      body[arg.slice(2)] = true;
      i++;
      continue;
    }

    throw new Error(`unknown argument "${arg}". Use --key value format.`);
  }

  return body;
}

function collectContextVarsFromEnv(): Record<string, string> {
  const contextVars: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("ALICE_CTX_") || value == null || value === "") continue;
    contextVars[key.slice("ALICE_CTX_".length)] = value;
  }
  return contextVars;
}

function withContextVars(body: Record<string, unknown>): Record<string, unknown> {
  const contextVars = collectContextVarsFromEnv();
  if (Object.keys(contextVars).length === 0) return body;
  return { ...body, __contextVars: contextVars };
}

export async function enginePostJson(
  pathname: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const url = getEngineUrl();

  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Alice-Skill": process.env.ALICE_SKILL ?? "alice-system",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          try {
            const data = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
            if ((res.statusCode ?? 500) >= 400) {
              reject(new Error(String(data.error ?? `request failed: ${res.statusCode}`)));
              return;
            }
            resolve(data);
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("error", reject);
    req.write(JSON.stringify(withContextVars(body)));
    req.end();
  });
}

export function renderBridgeResult(result: unknown): string {
  if (result == null) return "null";
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}

// ── ADR-235: 人类可读渲染工具 ──

/**
 * 从 rawArgs 中提取 --json flag。
 * 返回过滤后的 args（不含 --json）和是否 json 模式。
 */
export function extractJsonFlag(rawArgs: string[]): { json: boolean; args: string[] } {
  const has = rawArgs.includes("--json");
  return {
    json: has,
    args: has ? rawArgs.filter((a) => a !== "--json") : rawArgs,
  };
}

/** 截断长文本，用于确认消息中的预览。 */
export function truncate(text: string, max = 60): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

/** 渲染成功确认行。`✓ Sent: "hello"` */
export function renderConfirm(action: string, detail?: string): string {
  return detail ? `✓ ${action}: ${detail}` : `✓ ${action}`;
}

/** 渲染错误行。`✗ Rate limited` */
export function renderError(msg: string): string {
  return `✗ ${msg}`;
}

/**
 * 渲染 key-value 对为多行文本。跳过 null/undefined 值。
 * ```
 * Channel: tech-discuss
 * Members: 42
 * ```
 */
export function renderKeyValue(pairs: Array<[string, unknown]>): string {
  return pairs
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => {
      const text = typeof v === "object" ? JSON.stringify(v) : String(v);
      return `${k}: ${text}`;
    })
    .join("\n");
}

/**
 * 提取对象的摘要表示——优先用 title/name/id 等标识字段，
 * 其余字段紧凑渲染，避免全量 JSON 占据大量 token。
 */
function summarizeObject(obj: Record<string, unknown>): string {
  // 标识字段优先级
  const label =
    obj.title ?? obj.name ?? obj.display_name ?? obj.displayName ?? obj.description ?? obj.id;
  if (label != null) {
    const id = obj.id != null && label !== obj.id ? `[#${obj.id}] ` : "";
    // 收集非标识、非 null 的标量字段作为补充
    const extras: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (["id", "title", "name", "display_name", "displayName", "description"].includes(k))
        continue;
      if (v == null || v === "") continue;
      if (typeof v === "object") continue; // 跳过嵌套
      extras.push(`${k}: ${String(v)}`);
    }
    const suffix = extras.length > 0 ? ` (${extras.slice(0, 3).join(", ")})` : "";
    return `${id}${String(label)}${suffix}`;
  }
  // 无标识字段——降级为紧凑 JSON
  return JSON.stringify(obj);
}

/**
 * 渲染 unknown 对象为人类可读文本（ADR-235 通用降级）。
 * - null → `✓ Done`
 * - string → 原文
 * - array → 编号列表（每项 toString 或 JSON）
 * - object → key: value 多行
 */
export function renderHuman(result: unknown): string {
  if (result == null) return "✓ Done";
  if (typeof result === "string") return result;
  if (typeof result === "number" || typeof result === "boolean") return String(result);

  if (Array.isArray(result)) {
    if (result.length === 0) return "(empty)";
    return result
      .map((item, i) => {
        const text =
          typeof item === "string"
            ? item
            : typeof item === "object" && item !== null
              ? summarizeObject(item as Record<string, unknown>)
              : String(item);
        return `${i + 1}. ${text}`;
      })
      .join("\n");
  }

  // object → key-value
  const entries = Object.entries(result as Record<string, unknown>);
  if (entries.length === 0) return "✓ Done";
  return renderKeyValue(entries);
}

/** JSON 模式输出（保留调试能力）。 */
export function renderJson(result: unknown): string {
  return JSON.stringify(result, null, 2);
}

/**
 * 格式化输出内容（ADR-239 简化版）。
 * 返回人类可读文本。JSON 模式由 makeRunner 处理。
 */
export function formatOutput(humanText: string): string {
  return humanText;
}

/**
 * 统一错误退出函数（ADR-235）。
 * 输出 `✗ <msg>` 到 stderr，设置 exit code，然后退出。
 * @param cliName CLI 名称（如 "irc"、"alice-pkg"），用于错误前缀
 * @param msg 错误消息
 */
export function die(cliName: string, msg: string): never {
  process.stderr.write(`✗ ${cliName}: ${msg}\n`);
  process.exitCode = 1;
  // eslint-disable-next-line unicorn/no-process-exit
  process.exit(1);
}
