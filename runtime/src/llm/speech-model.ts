import type { ToolReply } from "../speech/decision.js";
import type { SpeechPrompt } from "../speech/prompt.js";
import { type ChatUsage, chatTokens, type Gateway, GatewayError } from "./gateway.js";

/**
 * 发言模型：gemini-3.5-flash-lite（经 OhMyGPT 网关）。选型证据见 bench-l2（2026-11-10）：
 * 配 2 月人格时与 gemini-3.8-flash 一样像真人，且是唯一真正不思考的 Gemini。
 */
export const SPEECH_MODEL = "google/gemini-3.5-flash-lite";

/**
 * 可选的发言模型（线上由 ALICE_SPEECH_MODEL 选，回放用来做模型交叉）。thinking 是给思考留的 token：
 * 网关把思考算进 max_tokens，不留就会把要说的话挤掉。
 * - flash-preview 用 reasoning_effort "none" 时思考 token 为 0（6/6，2026-11-11）。
 * - flash-3.8 的 "none" 关不干净：线上 32 个时刻各两次，64 次里 44 次在思考，最多 572 token。它在同一批时刻上
 *   每项都比 flash-preview 好（值得说 89% 对 52%，品味 20:10，编造 0 对 17），研究员 2026-11-13 定：发言全部换它
 *   （PLAN 第 50 件，eval-artifacts/voice-style/prereg.md）。
 */
export const SPEECH_MODELS = {
  "flash-lite": { id: SPEECH_MODEL, extra: {}, thinking: 0 },
  "flash-preview": {
    id: "google/gemini-3-flash-preview",
    extra: { reasoning_effort: "none" },
    thinking: 0,
  },
  "flash-3.8": {
    id: "google/gemini-3.8-flash",
    extra: { reasoning_effort: "none" },
    thinking: 1024,
  },
} as const;
export type SpeechModelName = keyof typeof SPEECH_MODELS;

const ATTEMPTS = 3;
const TIMEOUT_MS = 60_000;

interface CompletionBody extends ChatUsage {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
    };
  }>;
}

/**
 * 一次非流式调用，返回模型原文（由动作格式解析）。发言带着 run_code（tool_choice auto），原文是
 * `{"content", "calls": [{name, arguments}]}` 的 JSON（speech/decision.ts ToolReply）。用非流式是因为网关上流式请求间歇性 502，
 * 非流式实测 24/24 成功（2026-11-10）。5xx、429 和网络错误按退避重试。kind 是记账的分类（发言或想一想）。
 */
export async function callSpeechModel(
  gateway: Gateway,
  prompt: SpeechPrompt,
  options: {
    kind: "speech" | "ponder";
    model?: SpeechModelName;
    signal?: AbortSignal;
    temperature?: number;
    presencePenalty?: number;
  },
): Promise<string> {
  const model = SPEECH_MODELS[options.model ?? "flash-lite"];
  const { body } = await gateway.post<CompletionBody>({
    kind: options.kind,
    ...(options.signal ? { signal: options.signal } : {}),
    model: model.id,
    path: "/chat/completions",
    timeoutMs: TIMEOUT_MS,
    attempts: ATTEMPTS,
    tokens: chatTokens,
    body: {
      model: model.id,
      ...model.extra,
      max_tokens: (prompt.maxTokens ?? 600) + model.thinking,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      ...(prompt.tools ? { tools: prompt.tools, tool_choice: "auto" } : {}),
      ...(prompt.responseFormat ? { response_format: prompt.responseFormat } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.presencePenalty !== undefined
        ? { presence_penalty: options.presencePenalty }
        : {}),
    },
  });
  const message = body.choices?.[0]?.message;
  if (prompt.tools && message) {
    const reply: ToolReply = {
      content: message.content ?? "",
      calls: (message.tool_calls ?? []).map((c) => ({
        name: c.function?.name ?? "",
        arguments: c.function?.arguments ?? "",
      })),
    };
    return JSON.stringify(reply);
  }
  if (typeof message?.content === "string") return message.content;
  throw new GatewayError("response has no message content", 200);
}
