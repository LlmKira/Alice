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
import type { RotationUnit } from "./mind/rotation.js";
import { loadOpsConfig, type OpsConfig } from "./ops/config.js";
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

const RuntimeConfigSchema = z.object({
  telegram: z.object({
    api_id_env: z.string().min(1).default("TELEGRAM_API_ID"),
    api_hash_env: z.string().min(1).default("TELEGRAM_API_HASH"),
    phone_env: z.string().min(1).default("TELEGRAM_PHONE"),
  }),
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
export interface RuntimeConfig extends Config {
  ops: OpsConfig;
  /**
   * 查一下（执行代理 llm/errand.ts）：模型用发言的密钥，搜索要 EXA_API_KEY。默认开；没有 EXA_API_KEY，
   * 或 ALICE_ERRANDS=off，就是 null：她看不到这个动作（不给一个办不成的选项）。
   */
  errands: { exaKey: string } | null;
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
   * ALICE_SPEECH_MODEL：发言和想一想用的模型（SPEECH_MODELS 的名字），默认 flash-3.8
   * （研究员 2026-11-13："换，全部发言都用它"；证据见 llm/speech-model.ts）。
   */
  speechModel: SpeechModelName;
  /**
   * ALICE_TAGGER_URL：本机看图标注服务（services/tagger，pm2 里和她一起起，http://127.0.0.1:39100）。
   * 不设就只用看图模型的描述。
   */
  taggerUrl: string | null;
  /**
   * 线上轮换（mind/rotation.ts，PLAN 第 25 件）：ALICE_ROTATE 是和生产轮换的候选（sim/will-arms.ts 的组名），
   * ALICE_ROTATE_SEED 是分组的种子（开了轮换就必须给），ALICE_ROTATE_UNIT 可写 chat 或 self（不写按候选改了什么定）。
   * 不设 ALICE_ROTATE 就是 null：只有生产，和没有轮换时逐字节相同。
   */
  rotation: { candidate: string; seed: string; unit: RotationUnit | null } | null;
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const errandsSwitch = env.ALICE_ERRANDS?.trim() || "on";
  if (errandsSwitch !== "on" && errandsSwitch !== "off") {
    throw new Error("ALICE_ERRANDS must be on or off");
  }
  const exaKey = env.EXA_API_KEY ?? "";
  const ttsSwitch = env.ALICE_TTS?.trim() || "on";
  if (ttsSwitch !== "on" && ttsSwitch !== "off") {
    throw new Error("ALICE_TTS must be on or off");
  }
  const providerRaw = env.TTS_PROVIDER?.trim() || "";
  if (providerRaw !== "" && providerRaw !== "elevenlabs" && providerRaw !== "minimax") {
    throw new Error("TTS_PROVIDER must be elevenlabs or minimax");
  }
  const elevenlabsKey = (env.ELEVENLABS_API_KEY || "").trim();
  const minimaxKey = (env.TTS_API_KEY || env.MINIMAX_API_KEY || "").trim();
  const minimaxBase = env.TTS_BASE_URL?.trim() || "";
  const provider =
    providerRaw !== ""
      ? providerRaw
      : elevenlabsKey !== ""
        ? "elevenlabs"
        : minimaxKey !== ""
          ? "minimax"
          : null;
  if (ttsSwitch === "on" && provider === "elevenlabs" && elevenlabsKey === "") {
    throw new Error("TTS_PROVIDER=elevenlabs needs ELEVENLABS_API_KEY");
  }
  if (ttsSwitch === "on" && provider === "minimax" && minimaxKey === "") {
    throw new Error("TTS_PROVIDER=minimax needs TTS_API_KEY or MINIMAX_API_KEY");
  }
  const tts: TtsConfig | null =
    ttsSwitch === "on" && provider === "elevenlabs"
      ? {
          provider: "elevenlabs",
          apiKey: elevenlabsKey,
          model: env.TTS_MODEL?.trim() || ELEVENLABS_MODEL,
          voice: env.ELEVENLABS_VOICE_ID?.trim() || env.TTS_VOICE?.trim() || ELEVENLABS_VOICE,
          stability: 0.4,
          similarityBoost: 0.75,
        }
      : ttsSwitch === "on" && provider === "minimax"
        ? {
            provider: "minimax",
            baseUrl: minimaxBase || MINIMAX_BASE_URL,
            apiKey: minimaxKey,
            model: env.TTS_MODEL?.trim() || MINIMAX_MODEL,
            voice: env.TTS_VOICE?.trim() || MINIMAX_VOICE,
            groupId: env.TTS_GROUP_ID?.trim() || null,
          }
        : null;
  const callSwitch = env.ALICE_VOICE_CALLS?.trim() || (tts ? "on" : "off");
  if (callSwitch !== "on" && callSwitch !== "off") {
    throw new Error("ALICE_VOICE_CALLS must be on or off");
  }
  if (callSwitch === "on" && tts === null) {
    throw new Error(
      "ALICE_VOICE_CALLS=on needs ELEVENLABS_API_KEY, TTS_API_KEY, or MINIMAX_API_KEY",
    );
  }
  const speechModel = env.ALICE_SPEECH_MODEL?.trim() || "flash-3.8";
  if (!(speechModel in SPEECH_MODELS)) {
    throw new Error(`ALICE_SPEECH_MODEL must be one of: ${Object.keys(SPEECH_MODELS).join(" ")}`);
  }
  return {
    ...loadConfig(env),
    ops: loadOpsConfig(env),
    errands: exaKey !== "" && errandsSwitch === "on" ? { exaKey } : null,
    tts,
    voiceCalls: callSwitch === "on",
    promptLogDir: env.ALICE_PROMPT_LOG_DIR ?? join(ALICE_STATE_DIR, "prompt-logs"),
    speechModel: speechModel as SpeechModelName,
    taggerUrl: localUrl(env.ALICE_TAGGER_URL?.trim() || null),
    rotation: rotationOf(env),
  };
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

/** 图片发去标注不出本机：ALICE_TAGGER_URL 只收 127.0.0.1、localhost、[::1]。 */
function localUrl(value: string | null): string | null {
  if (value === null) return null;
  const host = URL.canParse(value) ? new URL(value).hostname : "";
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) {
    throw new Error(
      "ALICE_TAGGER_URL must be a URL on this machine (127.0.0.1, localhost or [::1])",
    );
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const path = resolve(env.ALICE_CONFIG_PATH ?? "config.toml");
  const parsed = RuntimeConfigSchema.parse(parseToml(readFileSync(path, "utf8")));
  const telegramApiId = Number(secret(env, parsed.telegram.api_id_env));
  if (!Number.isInteger(telegramApiId)) throw new Error("Telegram API ID must be an integer");
  return {
    telegramApiId,
    telegramApiHash: secret(env, parsed.telegram.api_hash_env),
    telegramPhone: secret(env, parsed.telegram.phone_env),
    speech: { apiKey: secret(env, parsed.speech.api_key_env) },
    ignoredSenders: new Set(
      (env.ALICE_IGNORED_SENDERS ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  };
}
