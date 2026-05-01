/**
 * instructor-js 客户端 — 验证驱动的结构化输出 + retry 闭环。
 *
 * ADR-213: tick callLLM 的主力结构化输出通道。
 * 按 provider 自动选择 instructor mode：
 * - Gemini (generativelanguage.googleapis.com) → MD_JSON（tool schema 格式限制）
 * - 其他（OpenAI / Anthropic / OpenRouter 兼容）→ TOOLS（原生 tool calling）
 *
 * 复用 config.providers endpoint 列表的 baseUrl/apiKey/model，不引入新配置。
 *
 * @see docs/adr/213-tool-calling-act-thread.md
 * @see https://js.useinstructor.com/
 */
import Instructor from "@instructor-ai/instructor";
import OpenAI from "openai";
import type { Config } from "../config.js";
import { createLogger } from "../utils/logger.js";
import { getBreakerState } from "./resilience.js";

const log = createLogger("instructor");

// -- 类型 -------------------------------------------------------------------

interface InstructorEntry {
  name: string;
  model: string;
  client: ReturnType<typeof Instructor>;
}

export interface AvailableInstructor {
  client: ReturnType<typeof Instructor>;
  model: string;
  name: string;
}

// -- 状态 -------------------------------------------------------------------

let _entries: InstructorEntry[] = [];

// -- Mode 自动选择 ----------------------------------------------------------

/** Gemini 模型名特征——baseUrl 可能是代理地址，用 model 名判断更可靠。 */
const MD_JSON_MODEL_PATTERNS = ["gemini", "vertex-gemini", "deepseek", "reasoner"];

/** 根据 model 名称选择 instructor mode。 */
function selectMode(model: string): "TOOLS" | "MD_JSON" {
  const lower = model.toLowerCase();
  if (MD_JSON_MODEL_PATTERNS.some((p) => lower.includes(p))) return "MD_JSON";
  return "TOOLS";
}

// -- 公共 API ---------------------------------------------------------------

/** 从 Config.providers 初始化 instructor 客户端链。与 initProviders() 并行调用。 */
export function initInstructorClients(config: Config): void {
  const route = config.llmRouting.firstPass
    .map((name) => config.providers.find((provider) => provider.name === name))
    .filter((provider): provider is Config["providers"][number] => Boolean(provider));
  const entries = route.length > 0 ? route : config.providers;

  _entries = entries.map((pc) => {
    const oai = new OpenAI({
      baseURL: pc.baseUrl,
      apiKey: pc.apiKey,
    });
    const mode = selectMode(pc.model);
    log.info("Instructor client initialized", { name: pc.name, model: pc.model, mode });
    return {
      name: pc.name,
      model: pc.model,
      client: Instructor({ client: oai, mode }),
    };
  });
}

/** 返回当前可用的 instructor 客户端（复用 resilience.ts 熔断器状态）。 */
export function getAvailableInstructor(): AvailableInstructor {
  if (_entries.length === 0) {
    throw new Error("No instructor clients initialized — call initInstructorClients() first");
  }
  for (const entry of _entries) {
    if (getBreakerState(entry.name) !== "open") {
      return { client: entry.client, model: entry.model, name: entry.name };
    }
  }
  const first = _entries[0];
  return { client: first.client, model: first.model, name: first.name };
}

/** 重置（测试用）。 */
export function resetInstructorClients(): void {
  _entries = [];
}
