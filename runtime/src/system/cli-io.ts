/**
 * CLI IO 实现 — 真实环境绑定（ADR-235 FP 改进）。
 *
 * 提供 EngineClient 和 Output 的真实实现，
 * 用于生产环境 CLI 入口。
 *
 * @see docs/adr/235-cli-human-readable-output.md
 */

import { engineGet, enginePost, engineQuery } from "../../skills/_lib/engine-client.js";
import { resolveTarget } from "./chat-client.js";
import type { EngineClient, Output, TargetResolver } from "./cli-types.js";

function currentChatIdFromEnv(): number | undefined {
  const raw = process.env.ALICE_CTX_TARGET_CHAT?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

// ── Engine Client 实现 ──

/** 真实 Engine API 客户端。 */
export const realEngine: EngineClient = {
  post: enginePost,
  get: engineGet,
  query: engineQuery,
};

// ── Output 实现 ──

/** 真实控制台输出。 */
export const realOutput: Output = {
  log: (msg: string) => console.log(msg),
  error: (msg: string) => console.error(msg),
  exit: (code: number) => {
    process.exitCode = code;
    process.exit(code);
  },
};

// ── Target Resolver 实现 ──

/** 真实目标解析器（返回 number ID 供 Engine API 使用）。 */
export const realResolveTarget: TargetResolver = async (target) => {
  return resolveTarget(target);
};

// ── Command Context 工厂 ──

import type { CliContext } from "./cli-types.js";

/** 创建真实命令上下文。 */
export function createRealContext(): CliContext {
  return {
    engine: realEngine,
    output: realOutput,
    resolveTarget: realResolveTarget,
    currentChatId: currentChatIdFromEnv(),
  };
}
