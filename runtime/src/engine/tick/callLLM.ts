/**
 * ADR-233: TC 循环 LLM 调用 — 原生 tool_use。
 *
 * 纯错误包装层：构建 TCLoopContext → 调用 runTCLoop → 捕获异常写 audit。
 *
 * @see docs/adr/233-native-toolcall-bt-hybrid.md
 * @see docs/adr/234-wave5-session-erratum.md
 */
import OpenAI from "openai";
import { writeAuditEvent } from "../../db/audit.js";
import { getBreakerState } from "../../llm/resilience.js";
import { createLogger } from "../../utils/logger.js";
import { runTCLoop, type TCLoopContext, type TCLoopResult } from "./tc-loop.js";

export type { TCLoopResult } from "./tc-loop.js";

const log = createLogger("tick/callLLM");

// -- 类型 -------------------------------------------------------------------

interface OpenAIClientEntry {
  name: string;
  model: string;
  openai: OpenAI;
}

// -- 状态 -------------------------------------------------------------------

let _clients: OpenAIClientEntry[] = [];

// -- 客户端管理 --------------------------------------------------------------

export function initOpenAIClients(config: {
  providers: Array<{ name: string; baseUrl: string; apiKey: string; model: string }>;
}): void {
  _clients = config.providers.map((pc) => {
    const openai = new OpenAI({
      baseURL: pc.baseUrl,
      apiKey: pc.apiKey,
    });
    log.info("OpenAI client initialized", { name: pc.name, model: pc.model });
    return {
      name: pc.name,
      model: pc.model,
      openai,
    };
  });
}

export function getAvailableOpenAIClient(): { openai: OpenAI; model: string; name: string } {
  if (_clients.length === 0) {
    throw new Error("No OpenAI clients initialized — call initOpenAIClients() first");
  }
  for (const entry of _clients) {
    if (getBreakerState(entry.name) !== "open") {
      return { openai: entry.openai, model: entry.model, name: entry.name };
    }
  }
  const first = _clients[0];
  return { openai: first.openai, model: first.model, name: first.name };
}

export function resetOpenAIClients(): void {
  _clients = [];
}

// -- 主接口 -----------------------------------------------------------------

export async function callTickLLM(
  system: string,
  user: string,
  tick: number,
  target: string | null,
  voice: string,
  contextVars: Record<string, unknown> | undefined,
): Promise<TCLoopResult | null> {
  try {
    const client = getAvailableOpenAIClient();

    const tcCtx: TCLoopContext = {
      openai: client.openai,
      model: client.model,
      providerName: client.name,
      systemPrompt: system,
      userMessage: user,
      contextVars,
    };

    return await runTCLoop(tcCtx);
  } catch (e) {
    log.error("Tick LLM call failed", e);
    // ADR-235: 记录更多诊断上下文
    const client = _clients.length > 0 ? getAvailableOpenAIClient() : null;
    writeAuditEvent(tick, "error", "tick", "LLM call failed", {
      voice,
      target,
      error: e instanceof Error ? e.message : String(e),
      provider: client?.name ?? "none",
      model: client?.model ?? "none",
      breakerState: client ? getBreakerState(client.name) : "unknown",
    });
    return null;
  }
}
