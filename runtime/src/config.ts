import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { SPEECH_MODELS, type SpeechModelName } from "./llm/speech-model.js";
import {
  ELEVENLABS_MODEL,
  ELEVENLABS_VOICE,
  MINIMAX_BASE_URL,
  MINIMAX_MODEL,
  MINIMAX_VOICE,
  type TtsConfig,
} from "./llm/tts.js";
import type {
  PlatformAttentionMode,
  PlatformAttentionOptions,
} from "./mechanisms/pressure/index.js";
import type { RotationUnit } from "./mind/rotation.js";
import { loadOpsConfig, type OpsConfig } from "./ops/config.js";
import { privateScope as qqPrivateScope } from "./qq/world-adapter.js";
import { ALICE_STATE_DIR } from "./runtime-paths.js";

/** config.toml 只写环境变量的名字；密钥本身从环境读。 */
export interface Config {
  telegramApiId: number;
  telegramApiHash: string;
  telegramPhone: string;
  /** 发言模型网关（src/llm/speech-model.ts）的密钥。 */
  speech: { apiKey: string };
  /** 不进入时间线的发送者 id（环境变量 ALICE_IGNORED_SENDERS，逗号分隔，可不设）。 */
  ignoredSenders: ReadonlySet<string>;
}

/**
 * 她在哪个聊天平台上（ALICE_PLATFORM，默认 telegram）。telegram 的密钥按 config.toml 里写的环境变量名读；
 * qq 是 OneBot v11 的正向 WebSocket：QQ_ONEBOT_WS_URL（必填）、QQ_ONEBOT_TOKEN、QQ_SELF_ID（可不设，连上后用
 * get_login_info 取）。OneBot 连接能替她发任何消息：本机（127.0.0.1、localhost、[::1]）可以用 ws:// 且不设
 * token；不在本机的必须 wss:// 加 token。qq 不读 Telegram 的密钥。
 */
export type PlatformConfig =
  | { name: "telegram"; telegramApiId: number; telegramApiHash: string; telegramPhone: string }
  | { name: "qq"; wsUrl: string; token: string | null; selfId: string | null };

const RuntimeConfigSchema = z.object({
  telegram: z
    .object({
      api_id_env: z.string().min(1).default("TELEGRAM_API_ID"),
      api_hash_env: z.string().min(1).default("TELEGRAM_API_HASH"),
      phone_env: z.string().min(1).default("TELEGRAM_PHONE"),
    })
    .default({}),
  speech: z
    .object({
      api_key_env: z.string().min(1).default("LLM_API_KEY"),
    })
    .default({}),
});

function secret(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

/** 运行时（不只是登录）要的全部配置，启动时一次读完、校验完（`--check` 也走这里）。 */
export interface RuntimeConfig {
  /** 主平台（platforms 的第一个）：操作员通知经它发；也方便只认单平台的调用方。 */
  platform: PlatformConfig;
  /** 本次运行挂载的全部平台（ALICE_PLATFORM 可写单个如 "qq" 或多个如 "telegram,qq"）。 */
  platforms: readonly PlatformConfig[];
  speech: Config["speech"];
  ignoredSenders: Config["ignoredSenders"];
  ops: OpsConfig;
  /**
   * 查一下（执行代理 llm/errand.ts）：模型用发言的密钥，搜索要 EXA_API_KEY。默认开；没有 EXA_API_KEY，
   * 或 ALICE_ERRANDS=off，就是 null：她看不到这个动作（不给一个办不成的选项）。
   * domains 是 ALICE_EXECUTOR_DOMAINS：执行代理在 web 之外还能打开的领域（MCP 服务、白名单命令）的 JSON 配置
   * 路径（llm/domains.ts）；不设就只有 web。
   */
  errands: { exaKey: string; domains: string | null } | null;
  /**
   * 语音合成：有 ELEVENLABS_API_KEY 时默认走 ElevenLabs（eleven_v4_turbo），否则有 TTS_API_KEY /
   * MINIMAX_API_KEY 时走 MiniMax（speech-2.8-hd）；可用 TTS_PROVIDER=elevenlabs|minimax 指定。
   * ALICE_TTS=off 或未配密钥时为 null。
   */
  tts: TtsConfig | null;
  /** ALICE_VOICE_CALLS：是否接入 Telegram 一对一语音通话（on/off，配了 TTS 时默认 on）。 */
  voiceCalls: boolean;
  promptLogDir: string;
  /**
   * ALICE_SPEECH_MODEL：主发言/反思模型（SPEECH_MODELS 的名字，推荐直接写网关全名，如 "google/gemini-4-argon,deepseek/deepseek-v4-pro-0813"），
   * 支持逗号分隔的多模型池启用异构智能轮换；默认 flash-3.8（证据见 llm/speech-model.ts）。
   */
  speechModel: SpeechModelName;
  /** 完整的发言模型池（单项即单模型，多项按 pickSpeechModel 轮换与断口癖）。 */
  speechModels: readonly SpeechModelName[];
  /** ALICE_PONDER_MODEL：后台反思与日常安排模型（不直接对人出口），默认 google/gemini-3.8-flash。 */
  ponderModel: SpeechModelName;
  /**
   * ALICE_TAGGER_URL：本机看图标注服务（services/tagger，pm2 里和她一起起，http://127.0.0.1:39100）。
   * 不设就只用看图模型的描述。
   */
  taggerUrl: string | null;
  /**
   * 平台注意力层级（ADR-300）：
   * - ALICE_PLATFORM_ATTENTION：shared（共用全局节奏与 Top-1）或 per-platform（共享主体核心，各平台独立节奏与 Top-1）；
   *   未设时多平台默认 per-platform，单平台默认 shared。
   * - ALICE_PLATFORM_LAMBDA：可选按平台调节开口门槛 lambda0（如 "qq=0.85" 或 "telegram=1.0,qq=0.85"）。
   */
  platformAttention: PlatformAttentionOptions;
  /**
   * 线上轮换（mind/rotation.ts，PLAN 第 25 件）：ALICE_ROTATE 是和生产轮换的候选（sim/will-arms.ts 的组名），
   * ALICE_ROTATE_SEED 是分组的种子（开了轮换就必须给），ALICE_ROTATE_UNIT 可写 chat 或 self（不写按候选改了什么定）。
   * 不设 ALICE_ROTATE 就是 null：只有生产，和没有轮换时逐字节相同。
   */
  rotation: { candidate: string; seed: string; unit: RotationUnit | null } | null;
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const errandsOn = onOffSwitch(env, "ALICE_ERRANDS", "on");
  const exaKey = env.EXA_API_KEY ?? "";
  const tts = ttsOf(env);
  const voiceCalls = onOffSwitch(env, "ALICE_VOICE_CALLS", tts ? "on" : "off");
  if (voiceCalls && tts === null) {
    throw new Error(
      env.ALICE_TTS?.trim() === "off"
        ? "ALICE_VOICE_CALLS=on needs text-to-speech, but ALICE_TTS=off"
        : "ALICE_VOICE_CALLS=on needs ELEVENLABS_API_KEY, TTS_API_KEY, or MINIMAX_API_KEY",
    );
  }
  const speechModels = speechModelsOf(env.ALICE_SPEECH_MODEL);
  const speechModel = speechModels[0] as SpeechModelName;
  const ponderModel = ponderModelOf(env.ALICE_PONDER_MODEL);
  const parsed = readConfigFile(env);
  const platforms = platformsOf(env, parsed);
  return {
    platform: platforms[0] as PlatformConfig,
    platforms,
    speech: { apiKey: speechKeyOf(env, parsed) },
    ignoredSenders: ignoredSendersOf(env),
    ops: opsOf(env, platforms),
    errands:
      exaKey !== "" && errandsOn
        ? { exaKey, domains: env.ALICE_EXECUTOR_DOMAINS?.trim() || null }
        : null,
    tts,
    voiceCalls,
    promptLogDir: env.ALICE_PROMPT_LOG_DIR ?? join(ALICE_STATE_DIR, "prompt-logs"),
    speechModel,
    speechModels,
    ponderModel,
    platformAttention: platformAttentionOf(env, platforms.length),
    taggerUrl: localUrl(env.ALICE_TAGGER_URL?.trim() || null),
    rotation: rotationOf(env),
  };
}

function platformAttentionOf(
  env: NodeJS.ProcessEnv,
  platformCount: number,
): PlatformAttentionOptions {
  const rawMode = env.ALICE_PLATFORM_ATTENTION?.trim().toLowerCase();
  let mode: PlatformAttentionMode;
  if (!rawMode) mode = platformCount > 1 ? "per-platform" : "shared";
  else if (rawMode === "shared" || rawMode === "per-platform") mode = rawMode;
  else throw new Error("ALICE_PLATFORM_ATTENTION must be shared or per-platform");

  const lambda: Record<string, number> = {};
  const rawLambda = env.ALICE_PLATFORM_LAMBDA?.trim();
  if (rawLambda) {
    for (const part of rawLambda
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      const eq = part.indexOf("=");
      if (eq <= 0) throw new Error(`ALICE_PLATFORM_LAMBDA entry must be platform=number: ${part}`);
      const name = part.slice(0, eq).trim().toLowerCase();
      const value = Number(part.slice(eq + 1).trim());
      if (!name || !Number.isFinite(value) || value <= 0) {
        throw new Error(`ALICE_PLATFORM_LAMBDA must be a positive number: ${part}`);
      }
      lambda[name] = value;
    }
  }
  return Object.keys(lambda).length > 0 ? { mode, lambda } : { mode };
}

/** 解析逗号分隔的模型列表并校验每一项都是已登记的模型名（去重保序）。 */
function speechModelsOf(raw: string | undefined): readonly SpeechModelName[] {
  const parts = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const names = parts.length > 0 ? parts : ["flash-3.8"];
  const out: SpeechModelName[] = [];
  for (const name of names) {
    if (!Object.hasOwn(SPEECH_MODELS, name)) {
      throw new Error(`ALICE_SPEECH_MODEL must be one of: ${Object.keys(SPEECH_MODELS).join(" ")}`);
    }
    const typed = name as SpeechModelName;
    if (!out.includes(typed)) out.push(typed);
  }
  return out;
}

function ponderModelOf(raw: string | undefined): SpeechModelName {
  const name = raw?.trim() || "google/gemini-3.8-flash";
  if (!Object.hasOwn(SPEECH_MODELS, name)) {
    throw new Error(`ALICE_PONDER_MODEL must be one of ${Object.keys(SPEECH_MODELS).join(", ")}`);
  }
  return name as SpeechModelName;
}

/** 只挂 QQ 时，ALICE_OPERATOR_ID 就是操作员的 QQ 号；和 Telegram 一起挂时，QQ 上的操作员只看 QQ_OPERATOR_ID。 */
function opsOf(env: NodeJS.ProcessEnv, platforms: readonly PlatformConfig[]): OpsConfig {
  const ops = loadOpsConfig(env);
  const names = new Set(platforms.map((p) => p.name));
  const qqOnly = names.has("qq") && !names.has("telegram");
  return { ...ops, qqOperatorId: ops.qqOperatorId ?? (qqOnly ? ops.operatorId : null) };
}

/** 接受操作员 /ops 命令的私聊会话：每个已挂载的平台各按自己平台上的账号识别（ops/operator.ts intercept）。 */
export function operatorScopes(config: Pick<RuntimeConfig, "platforms" | "ops">): Set<string> {
  const scopes = new Set<string>();
  for (const p of config.platforms) {
    if (p.name === "telegram") scopes.add(`telegram:${config.ops.operatorId}`);
    else if (config.ops.qqOperatorId !== null) scopes.add(qqPrivateScope(config.ops.qqOperatorId));
  }
  return scopes;
}

/** 读一个只能写 on/off 的开关，不写取 fallback。 */
function onOffSwitch(env: NodeJS.ProcessEnv, name: string, fallback: "on" | "off"): boolean {
  const value = env[name]?.trim() || fallback;
  if (value !== "on" && value !== "off") throw new Error(`${name} must be on or off`);
  return value === "on";
}

function ttsOf(env: NodeJS.ProcessEnv): TtsConfig | null {
  const ttsOn = onOffSwitch(env, "ALICE_TTS", "on");
  const providerRaw = env.TTS_PROVIDER?.trim() || "";
  if (providerRaw !== "" && providerRaw !== "elevenlabs" && providerRaw !== "minimax") {
    throw new Error("TTS_PROVIDER must be elevenlabs or minimax");
  }
  const elevenlabsKey = (env.ELEVENLABS_API_KEY || "").trim();
  const minimaxKey = (env.TTS_API_KEY || env.MINIMAX_API_KEY || "").trim();
  const provider = providerRaw || defaultTtsProvider(elevenlabsKey, minimaxKey);
  if (!ttsOn || provider === null) return null;
  if (provider === "elevenlabs") {
    if (elevenlabsKey === "") throw new Error("TTS_PROVIDER=elevenlabs needs ELEVENLABS_API_KEY");
    return {
      provider: "elevenlabs",
      apiKey: elevenlabsKey,
      model: env.TTS_MODEL?.trim() || ELEVENLABS_MODEL,
      voice: env.ELEVENLABS_VOICE_ID?.trim() || env.TTS_VOICE?.trim() || ELEVENLABS_VOICE,
      stability: 0.4,
      similarityBoost: 0.75,
    };
  }
  if (minimaxKey === "")
    throw new Error("TTS_PROVIDER=minimax needs TTS_API_KEY or MINIMAX_API_KEY");
  return {
    provider: "minimax",
    baseUrl: env.TTS_BASE_URL?.trim() || MINIMAX_BASE_URL,
    apiKey: minimaxKey,
    model: env.TTS_MODEL?.trim() || MINIMAX_MODEL,
    voice: env.TTS_VOICE?.trim() || MINIMAX_VOICE,
    groupId: env.TTS_GROUP_ID?.trim() || null,
  };
}

function defaultTtsProvider(
  elevenlabsKey: string,
  minimaxKey: string,
): "elevenlabs" | "minimax" | null {
  if (elevenlabsKey !== "") return "elevenlabs";
  if (minimaxKey !== "") return "minimax";
  return null;
}

function rotationOf(env: NodeJS.ProcessEnv): RuntimeConfig["rotation"] {
  const candidate = env.ALICE_ROTATE?.trim() || "";
  if (candidate === "") return null;
  const seed = env.ALICE_ROTATE_SEED?.trim() || "";
  if (seed === "") throw new Error("ALICE_ROTATE_SEED must be set when ALICE_ROTATE is");
  const unit = env.ALICE_ROTATE_UNIT?.trim() || null;
  if (unit !== null && unit !== "chat" && unit !== "self") {
    throw new Error("ALICE_ROTATE_UNIT must be chat or self");
  }
  return { candidate, seed, unit };
}

const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

/** 图片发去标注不出本机：ALICE_TAGGER_URL 只收 127.0.0.1、localhost、[::1]。 */
function localUrl(value: string | null): string | null {
  if (value === null) return null;
  const host = URL.canParse(value) ? new URL(value).hostname : "";
  if (!LOOPBACK.includes(host)) {
    throw new Error(
      "ALICE_TAGGER_URL must be a URL on this machine (127.0.0.1, localhost or [::1])",
    );
  }
  return value;
}

type ConfigFile = z.infer<typeof RuntimeConfigSchema>;

function readConfigFile(env: NodeJS.ProcessEnv): ConfigFile {
  const path = resolve(env.ALICE_CONFIG_PATH ?? "config.toml");
  return RuntimeConfigSchema.parse(parseToml(readFileSync(path, "utf8")));
}

function speechKeyOf(env: NodeJS.ProcessEnv, parsed: ConfigFile): string {
  return parsed.speech.api_key_env === "LLM_API_KEY"
    ? env.OHMYGPT_API_KEY?.trim() ||
        env.LLM_API_KEY?.trim() ||
        secret(env, "OHMYGPT_API_KEY (or LLM_API_KEY)")
    : secret(env, parsed.speech.api_key_env);
}

function ignoredSendersOf(env: NodeJS.ProcessEnv): ReadonlySet<string> {
  return new Set(
    (env.ALICE_IGNORED_SENDERS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

function telegramOf(
  env: NodeJS.ProcessEnv,
  parsed: ConfigFile,
): Pick<Config, "telegramApiId" | "telegramApiHash" | "telegramPhone"> {
  const telegramApiId = Number(secret(env, parsed.telegram.api_id_env));
  if (!Number.isInteger(telegramApiId)) throw new TypeError("Telegram API ID must be an integer");
  return {
    telegramApiId,
    telegramApiHash: secret(env, parsed.telegram.api_hash_env),
    telegramPhone: secret(env, parsed.telegram.phone_env),
  };
}

function singlePlatformOf(
  name: string,
  env: NodeJS.ProcessEnv,
  parsed: ConfigFile,
): PlatformConfig {
  if (name === "telegram") return { name, ...telegramOf(env, parsed) };
  if (name !== "qq") throw new Error("ALICE_PLATFORM must be telegram or qq");
  const wsUrl = secret(env, "QQ_ONEBOT_WS_URL").trim();
  if (!URL.canParse(wsUrl) || !["ws:", "wss:"].includes(new URL(wsUrl).protocol)) {
    throw new Error("QQ_ONEBOT_WS_URL must be a ws:// or wss:// URL");
  }
  const token = env.QQ_ONEBOT_TOKEN?.trim() || null;
  const url = new URL(wsUrl);
  if (!LOOPBACK.includes(url.hostname)) {
    if (url.protocol !== "wss:") {
      throw new Error("QQ_ONEBOT_WS_URL must use wss:// unless it is on this machine");
    }
    if (token === null) {
      throw new Error("QQ_ONEBOT_TOKEN must be set when QQ_ONEBOT_WS_URL is not on this machine");
    }
  }
  const selfId = env.QQ_SELF_ID?.trim() || null;
  if (selfId !== null && !/^\d+$/.test(selfId)) throw new Error("QQ_SELF_ID must be a QQ number");
  return { name, wsUrl, token, selfId };
}

function platformsOf(env: NodeJS.ProcessEnv, parsed: ConfigFile): PlatformConfig[] {
  const raw = (env.ALICE_PLATFORM?.trim() || "telegram")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (raw.length === 0) throw new Error("ALICE_PLATFORM must be telegram or qq");
  const seen = new Set<string>();
  const result: PlatformConfig[] = [];
  for (const name of raw) {
    if (seen.has(name)) throw new Error(`Duplicate platform in ALICE_PLATFORM: ${name}`);
    seen.add(name);
    result.push(singlePlatformOf(name, env, parsed));
  }
  return result;
}

/** 登录 Telegram 要的配置（`--login`）。 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = readConfigFile(env);
  return {
    ...telegramOf(env, parsed),
    speech: { apiKey: speechKeyOf(env, parsed) },
    ignoredSenders: ignoredSendersOf(env),
  };
}
