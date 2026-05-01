/**
 * Engine API 中间件 — 请求日志 + capability 验证。
 *
 * 两种模式：
 * - lenient（默认）：无 X-Alice-Skill header 时允许所有请求。
 * - strict：无 header → 403，未知 skill → 403，无 capability → 403。
 *
 * @see docs/adr/202-engine-api.md
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SkillCapability } from "../skills/manifest.js";
import type { Registry } from "../skills/registry.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("engine-api");

/** 路径 → 所需 capability 的映射。 */
const ROUTE_CAPABILITIES: Array<{
  test: (method: string, path: string) => boolean;
  required: SkillCapability;
}> = [
  // config 敏感 key（API Key 类）
  {
    test: (m, p) => m === "GET" && /^\/config\/(exaApiKey|musicApiBaseUrl|youtubeApiKey)$/.test(p),
    required: "config.secrets",
  },
  // config 非敏感 key
  {
    test: (m, p) => m === "GET" && p.startsWith("/config/"),
    required: "config.read",
  },
  // engine selfcheck
  {
    test: (m, p) => m === "POST" && p === "/engine/selfcheck",
    required: "engine.selfcheck",
  },
  // engine 读（tick 等）
  {
    test: (m, p) => m === "GET" && p.startsWith("/engine/"),
    required: "config.read",
  },
  // LLM synthesize
  {
    test: (m, p) => m === "POST" && p === "/llm/synthesize",
    required: "llm.synthesize",
  },
  // LLM summarize
  {
    test: (m, p) => m === "POST" && p === "/llm/summarize",
    required: "llm.summarize",
  },
  // graph 写
  {
    test: (m, p) => m === "POST" && p.startsWith("/graph/"),
    required: "graph.write",
  },
  // graph 读
  {
    test: (m, p) => m === "GET" && p.startsWith("/graph/"),
    required: "graph.read",
  },
  // chat tail
  {
    test: (m, p) => m === "GET" && p.startsWith("/chat/"),
    required: "chat.read",
  },
  // telegram send
  {
    test: (m, p) => m === "POST" && p.startsWith("/telegram/send"),
    required: "telegram.send",
  },
  // neutral transport send
  {
    test: (m, p) => m === "POST" && p.startsWith("/transport/send"),
    required: "transport.send",
  },
  // telegram mark read
  {
    test: (m, p) => m === "POST" && p.startsWith("/telegram/read"),
    required: "telegram.read",
  },
  // neutral transport read
  {
    test: (m, p) => m === "POST" && p.startsWith("/transport/read"),
    required: "transport.read",
  },
  // telegram react
  {
    test: (m, p) => m === "POST" && p.startsWith("/telegram/react"),
    required: "telegram.react",
  },
  // neutral transport react
  {
    test: (m, p) => m === "POST" && p.startsWith("/transport/react"),
    required: "transport.react",
  },
  // telegram join
  {
    test: (m, p) => m === "POST" && p.startsWith("/telegram/join"),
    required: "telegram.join",
  },
  // telegram leave
  {
    test: (m, p) => m === "POST" && p.startsWith("/telegram/leave"),
    required: "telegram.leave",
  },
  // telegram forward
  {
    test: (m, p) => m === "POST" && p.startsWith("/telegram/forward"),
    required: "telegram.forward",
  },
  // album search/send
  {
    test: (m, p) => m === "GET" && p.startsWith("/album/search"),
    required: "chat.read",
  },
  {
    test: (m, p) => m === "POST" && p.startsWith("/album/send"),
    required: "telegram.forward",
  },
  // dispatch
  {
    test: (m, p) => m === "POST" && p.startsWith("/dispatch"),
    required: "dispatch",
  },
  // query
  {
    test: (m, p) => m === "POST" && p.startsWith("/query"),
    required: "query",
  },
  // ADR-217: unified cmd (dispatch + query)
  {
    test: (m, p) => m === "POST" && p.startsWith("/cmd"),
    required: "dispatch",
  },
  // ADR-217: meta (command catalog)
  {
    test: (m, p) => m === "GET" && p.startsWith("/meta"),
    required: "config.read",
  },
];

/**
 * 根据请求路径确定所需的 capability。
 */
export function requiredCapability(method: string, pathname: string): SkillCapability | null {
  for (const rule of ROUTE_CAPABILITIES) {
    if (rule.test(method, pathname)) return rule.required;
  }
  return null;
}

export type CapabilityMode = "lenient" | "strict";

/**
 * 检查 Skill 是否拥有请求所需的 capability。
 *
 * - lenient：无 header 或 registry 未提供时返回 true。
 * - strict：无 header → 403，未知 skill → 403，无 capability → 403。
 */
export function checkCapability(
  req: IncomingMessage,
  registry: Registry | undefined,
  mode: CapabilityMode = "lenient",
): { allowed: true } | { allowed: false; skill: string; needed: SkillCapability } {
  const method = req.method ?? "GET";
  const pathname = (req.url ?? "/").split("?")[0];
  const needed = requiredCapability(method, pathname);

  // 不需要 capability 的路由（如 404 路径）→ 放行
  if (!needed) return { allowed: true };

  const skillName = req.headers["x-alice-skill"] as string | undefined;

  if (mode === "strict") {
    // strict: 无 header → 403
    if (!skillName) {
      return { allowed: false, skill: "(no header)", needed };
    }
    // strict: registry 未提供视为配置错误，拒绝
    if (!registry) {
      return { allowed: false, skill: skillName, needed };
    }
    const entry = registry[skillName];
    // strict: 未注册的 skill → 403
    if (!entry) {
      log.warn(`unknown skill "${skillName}" accessing ${method} ${pathname} (strict mode)`);
      return { allowed: false, skill: skillName, needed };
    }
    // 检查 capability
    if (entry.capabilities.includes(needed)) {
      return { allowed: true };
    }
    return { allowed: false, skill: skillName, needed };
  }

  // lenient: 无 header 时允许所有
  if (!skillName || !registry) return { allowed: true };

  const entry = registry[skillName];
  if (!entry) {
    // 未注册的 Skill — lenient 仍然放行（log warning）
    log.warn(`unknown skill "${skillName}" accessing ${method} ${pathname}`);
    return { allowed: true };
  }

  // 检查 capability
  if (entry.capabilities.includes(needed)) {
    return { allowed: true };
  }

  return { allowed: false, skill: skillName, needed };
}

/**
 * 包装 handler，在请求前后打印简洁日志。
 * 格式：`METHOD /path → STATUS (duration ms)`
 */
export function withRequestLog(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const start = performance.now();
    const skill = req.headers["x-alice-skill"] as string | undefined;
    res.on("finish", () => {
      const duration = (performance.now() - start).toFixed(1);
      const tag = skill ? ` [${skill}]` : "";
      log.info(`${req.method} ${req.url}${tag} → ${res.statusCode} (${duration}ms)`);
    });
    // handler 可能返回 Promise（async），捕获未处理错误
    const result = handler(req, res);
    if (result instanceof Promise) {
      result.catch((err) => {
        log.error("unhandled error in request handler", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "internal server error" }));
        }
      });
    }
  };
}
