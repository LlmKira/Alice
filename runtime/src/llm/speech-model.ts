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
  "google/gemini-3.8-flash": {
    id: "google/gemini-3.8-flash",
    extra: { reasoning_effort: "none" },
    thinking: 1024,
  },
  "google/gemini-4-hydrogen": {
    id: "google/gemini-4-hydrogen",
    extra: { reasoning_effort: "none" },
    thinking: 1024,
  },
  "google/gemini-4-argon": {
    id: "google/gemini-4-argon",
    extra: { reasoning_effort: "none" },
    thinking: 1024,
  },
  "google/gemini-4-neon": {
    id: "google/gemini-4-neon",
    extra: { reasoning_effort: "none" },
    thinking: 1024,
  },
  "bytedance/doubao-seed-2.1-pro-260915": {
    id: "bytedance/doubao-seed-2.1-pro-260915",
    extra: { reasoning_effort: "none" },
    thinking: 0,
  },
} as const;
export type SpeechModelName = keyof typeof SPEECH_MODELS;

/** 从 callId（如 "telegram:-123#42"）抽出轮次号，保证同一轮多步工具调用始终落到同一个模型。 */
function callTurnIndex(callId: string): number {
  const m = /#(\d+)$/.exec(callId);
  if (m) return Number(m[1]);
  let hash = 0;
  for (const ch of callId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash;
}

const OWN_TIC_RE = /<你>[^\n]*(?:是吧|属于是)/;
const DEEP_GROUP_OWN_TURNS = 2;

/**
 * 分级发言路由（ADR-281）：直接读 renderSpeechPrompt 附带的结构化 routing 事实，不依赖提示词文案格式。
 * - 单模型、后台反思（ponder）或未附带 routing 事实时走主模型；
 * - 外语回合与私聊固定走主模型（保住深度、情绪分寸与真我涌现）；
 * - 群聊按对话分量分级：已有连续多轮互动（ownTurnsInLog >= 2）、带明显心情或人机观察的重回合走主模型，
 *   普通轻群聊走池内次模型（如 google/gemini-4-hydrogen）；
 * - 若池内配了非 Google 异构搭档且记录里她近期出现口癖（是吧/属于是），切到异构搭档打断自回归滚雪球。
 */
export function pickSpeechModel(
  pool: readonly SpeechModelName[],
  call: { kind: "speech" | "ponder"; callId: string },
  prompt: Pick<SpeechPrompt, "user" | "routing">,
): SpeechModelName {
  const primary = pool[0] ?? "flash-3.8";
  if (pool.length <= 1 || call.kind === "ponder") return primary;
  const routing = prompt.routing;
  if (!routing || routing.foreignLanguage) return primary;
  const nonGoogle = pool.find((m) => !SPEECH_MODELS[m].id.startsWith("google/"));
  if (nonGoogle && OWN_TIC_RE.test(prompt.user)) return nonGoogle;
  if (routing.chatType === "private") return primary;
  if (
    routing.hasMood ||
    routing.hasBotObservation ||
    routing.ownTurnsInLog >= DEEP_GROUP_OWN_TURNS
  ) {
    return primary;
  }
  const secondary = pool[1] ?? primary;
  if (pool.length === 2) return secondary;
  const lightPool = pool.slice(1);
  return lightPool[callTurnIndex(call.callId) % lightPool.length] ?? secondary;
}

const ATTEMPTS = 3;
const TIMEOUT_MS = 60_000;

interface ChatToolCall {
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
  extra_content?: unknown;
  [k: string]: unknown;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
  [k: string]: unknown;
}

interface CompletionBody extends ChatUsage {
  choices?: Array<{
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: ChatToolCall[];
    };
  }>;
}

/**
 * 一次非流式调用，返回模型原文（由动作格式解析）。发言带着 tools（tool_choice auto），原文是
 * `{"content", "calls": [{id?, name, arguments, extra_content?}]}` 的 JSON（speech/decision.ts ToolReply）。
 * 用非流式是因为网关上流式请求间歇性 502，非流式实测 24/24 成功（2026-11-10）。5xx、429 和网络错误按退避重试。
 * kind 是记账的分类（发言或想一想）。
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
      messages: prompt.messages ?? [
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
        ...(c.id ? { id: c.id } : {}),
        name: c.function?.name ?? "",
        arguments: c.function?.arguments ?? "",
        ...(c.extra_content !== undefined ? { extra_content: c.extra_content } : {}),
      })),
      ...(typeof message.reasoning_content === "string"
        ? { reasoning_content: message.reasoning_content }
        : {}),
    };
    return JSON.stringify(reply);
  }
  if (typeof message?.content === "string") return message.content;
  throw new GatewayError("response has no message content", 200);
}
