/**
 * 发语音的合成（capabilities A16）：支持 ElevenLabs（@elevenlabs/elevenlabs-js，默认 eleven_v4_turbo）
 * 和 MiniMax 同步语音合成 /v1/t2a_v2（默认 speech-2.8-hd），再用 ffmpeg 转成 Telegram 语音要的 OGG/Opus。
 */
import { spawn } from "node:child_process";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import type { SpokenVoice } from "../telegram/actions.js";
import type { Charge, Spent } from "./gateway.js";

const TIMEOUT_MS = 60_000;
/** ffmpeg 解码输出为 24 kHz、16 位、单声道 PCM，再加 WAV 头转成 OGG/Opus。 */
const PCM_RATE = 24_000;

/** MiniMax 的 API 根地址：国内 api.minimaxi.com、国际 api.minimax.io（都能用，TTS_BASE_URL 覆盖）。 */
export const MINIMAX_BASE_URL = "https://api.minimaxi.com";
/** 最新的语音模型（2026-11 的价目表和 OpenAPI：2.8 系列支持 quality 归一化与多语种自动增强）。 */
export const MINIMAX_MODEL = "speech-2.8-hd";
export const MINIMAX_VOICE = "qiaopi_mengmei";
export const ELEVENLABS_MODEL = "eleven_v4_turbo";
/** 预置女声 Jessica（Playful, Bright, Warm，young/conversational/cute，全套餐可用；可用 TTS_VOICE / ELEVENLABS_VOICE_ID 覆盖）。 */
export const ELEVENLABS_VOICE = "cgSgspJ2msm6clMCkdW9";

/** MiniMax 同步语音合成的设置（config.ts 从环境读）：/v1/t2a_v2 返回 mp3 的十六进制串。 */
export interface MinimaxTts {
  provider?: "minimax";
  /** API 根地址，如 https://api.minimax.io。 */
  baseUrl: string;
  apiKey: string;
  /** speech-2.8-hd（3.50 元/万字符）或 speech-2.8-turbo（2.00）；认不出的名字按 hd 记价。 */
  model: string;
  /** 音色 id，如 Calm_Woman。 */
  voice: string;
  /** 控制台里的 Group ID：有就放在查询串里（2 月的写法）。 */
  groupId: string | null;
}

/** ElevenLabs 语音合成设置（SDK 默认读 ELEVENLABS_API_KEY）。 */
export interface ElevenlabsTts {
  provider: "elevenlabs";
  apiKey: string;
  model: string;
  voice: string;
  stability: number;
  similarityBoost: number;
}

export type TtsConfig = ElevenlabsTts | (MinimaxTts & { provider: "minimax" });
export interface MinimaxDeps {
  /** 中止（停机、切走）：在途的请求当即停下，按 signal.reason 抛出。 */
  signal?: AbortSignal;
  /** 记进花费账（gateway.charge）：MiniMax 不经网关，按下面公布的价目估一笔。 */
  charge?: Charge;
  /** 测试注入的 fetch。 */
  fetch?: typeof fetch;
}

/** 同步语音合成按字符计费：speech-2.8-hd 3.50、speech-2.8-turbo 2.00 元/万字符（platform.minimaxi.com/docs/pricing）。 */
const MINIMAX_CNY_PER_10K = { hd: 3.5, turbo: 2 };
/** 价目是人民币，花费账记美元：按 7.2 元/美元估（只影响花费上限的松紧，不参与结算）。 */
const CNY_PER_USD = 7.2;

/**
 * MiniMax 按字符计费，花掉的记成网关那本账里的一笔 tts（credits 是网关扣的，这里没有）。
 * chars 是回复里的 usage_characters（含标点和空格，官方说以它为准）；没报时按 text 的字数估。
 */
export function minimaxSpent(model: string, text: string, chars?: number): Spent {
  const cny = model.endsWith("-turbo") ? MINIMAX_CNY_PER_10K.turbo : MINIMAX_CNY_PER_10K.hd;
  return {
    kind: "tts",
    model: `minimax/${model}`,
    usd: (((chars ?? [...text].length) / 10_000) * cny) / CNY_PER_USD,
    credits: null,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
  };
}

interface MinimaxBody {
  /** 合成结果：audio 是 mp3 的十六进制串。 */
  data?: { audio?: string; status?: number };
  /** 业务错误：0 才是成功。 */
  base_resp?: { status_code?: number; status_msg?: string };
  /** 结算信息：usage_characters 才是计费字符数（含标点空格），audio_length 是毫秒。 */
  extra_info?: { usage_characters?: number; audio_length?: number };
}

/**
 * MiniMax 的同步语音合成（/v1/t2a_v2）：一行字进，mp3 的十六进制串出；转成 Telegram 要的 OGG/Opus，带上时长。
 * 2.6/2.8 系列还带 language_boost=auto（多语种自动增强）和 text_normalization_mode=quality（只对非流式生效）；
 * 情感不写死，让模型按文字自己选。没设 API 密钥、HTTP 拒绝、业务状态码不是 0、回复里没有 audio，
 * 都按失败抛出（sendVoice 记成 voice_failed）。
 */
export async function synthesizeMinimax(
  tts: MinimaxTts,
  text: string,
  deps: MinimaxDeps = {},
): Promise<SpokenVoice> {
  const base = tts.baseUrl.replace(/\/+$/, "");
  const url = tts.groupId
    ? `${base}/v1/t2a_v2?GroupId=${encodeURIComponent(tts.groupId)}`
    : `${base}/v1/t2a_v2`;
  const call = deps.fetch ?? fetch;
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  // quality 归一化和 language_boost 只对 2.6/2.8 有意义；别的模型会按 basic / 默认处理。
  const latest = tts.model.startsWith("speech-2.6") || tts.model.startsWith("speech-2.8");
  const response = await call(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tts.apiKey}` },
    body: JSON.stringify({
      model: tts.model,
      text,
      stream: false,
      ...(latest ? { language_boost: "auto", text_normalization_mode: "quality" } : {}),
      voice_setting: { voice_id: tts.voice, speed: 1, vol: 1, pitch: 0 },
      // mp3：它自己压缩好，这边只转容器；采样率、比特率按 2 月的设置。
      audio_setting: { sample_rate: 32_000, bitrate: 128_000, format: "mp3", channel: 1 },
    }),
    signal: deps.signal ? AbortSignal.any([timeout, deps.signal]) : timeout,
  });
  if (!response.ok) throw new Error(`minimax tts: ${response.status}`);
  const body = (await response.json()) as MinimaxBody;
  const status = body.base_resp?.status_code ?? 0;
  if (status !== 0) throw new Error(`minimax tts: ${body.base_resp?.status_msg ?? status}`);
  const hex = body.data?.audio;
  if (!hex) throw new Error("tts: no audio");
  const audio = new Uint8Array(Buffer.from(hex, "hex"));
  // 合成成功就记一笔：MiniMax 按字符计费，转码失败也照记。
  deps.charge?.(minimaxSpent(tts.model, text, body.extra_info?.usage_characters));
  const wav = isWav(audio) ? audio : wavOf(await toPcm(audio, "mp3"), PCM_RATE);
  return { ogg: await toOggOpus(wav), seconds: wavSeconds(wav) };
}

/** ElevenLabs 定价：turbo/flash 约 $40/百万字符，v4/v3/multilingual 约 $80/百万字符。 */
export function elevenlabsSpent(model: string, text: string, chars?: number): Spent {
  const ratePerMillion = model.includes("turbo") || model.includes("flash") ? 40 : 80;
  return {
    kind: "tts",
    model: `elevenlabs/${model}`,
    usd: ((chars ?? [...text].length) / 1_000_000) * ratePerMillion,
    credits: null,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
  };
}

export interface ElevenlabsClientLike {
  textToSpeech: {
    convert: (
      voiceId: string,
      request: {
        text: string;
        modelId?: string;
        outputFormat?: "mp3_44100_128";
        voiceSettings?: { stability?: number; similarityBoost?: number };
      },
      requestOptions?: { abortSignal?: AbortSignal; timeoutInSeconds?: number },
    ) => AsyncIterable<Uint8Array> | Promise<AsyncIterable<Uint8Array>>;
  };
}

export interface ElevenlabsDeps {
  signal?: AbortSignal;
  charge?: Charge;
  client?: ElevenlabsClientLike;
}

/**
 * ElevenLabs 语音合成：调 @elevenlabs/elevenlabs-js 的 textToSpeech.convert 输出 mp3，
 * 再经 ffmpeg 转成 Telegram 所需的 48 kHz OGG/Opus。
 */
export async function synthesizeElevenlabs(
  tts: ElevenlabsTts,
  text: string,
  deps: ElevenlabsDeps = {},
): Promise<SpokenVoice> {
  const client =
    deps.client ??
    (tts.apiKey === process.env.ELEVENLABS_API_KEY
      ? new ElevenLabsClient()
      : new ElevenLabsClient({ apiKey: tts.apiKey }));
  const audioStream = await client.textToSpeech.convert(
    tts.voice,
    {
      text,
      modelId: tts.model,
      outputFormat: "mp3_44100_128",
      voiceSettings: {
        stability: tts.stability,
        similarityBoost: tts.similarityBoost,
      },
    },
    {
      abortSignal: deps.signal,
      timeoutInSeconds: TIMEOUT_MS / 1000,
    },
  );
  const chunks: Uint8Array[] = [];
  for await (const chunk of audioStream) chunks.push(chunk);
  const audio = new Uint8Array(Buffer.concat(chunks));
  if (audio.length === 0) throw new Error("tts: no audio");
  deps.charge?.(elevenlabsSpent(tts.model, text));
  const wav = isWav(audio) ? audio : wavOf(await toPcm(audio, "mp3"), PCM_RATE);
  return { ogg: await toOggOpus(wav), seconds: wavSeconds(wav) };
}

/** 统一语音合成入口：按配置的提供商走 ElevenLabs 或 MiniMax。 */
export async function synthesizeSpeech(
  tts: TtsConfig,
  text: string,
  deps: MinimaxDeps & ElevenlabsDeps = {},
): Promise<SpokenVoice> {
  return tts.provider === "elevenlabs"
    ? synthesizeElevenlabs(tts, text, deps)
    : synthesizeMinimax(tts, text, deps);
}
function isWav(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF";
}

/** 裸 PCM（16 位单声道）加上 WAV 头。 */
function wavOf(pcm: Uint8Array, rate: number): Uint8Array {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return new Uint8Array(Buffer.concat([header, pcm]));
}

/** WAV 的时长：数据字节数 ÷ 每秒字节数（fmt 块里的 byte rate）。 */
function wavSeconds(wav: Uint8Array): number {
  const view = Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength);
  const byteRate = view.readUInt32LE(28);
  let offset = 12;
  while (offset + 8 <= view.length) {
    const id = view.toString("ascii", offset, offset + 4);
    const size = view.readUInt32LE(offset + 4);
    if (id === "data") return Math.min(size, view.length - offset - 8) / byteRate;
    offset += 8 + size;
  }
  return 0;
}

/** 跑一次 ffmpeg：输入从 stdin 读、输出从 stdout 收（参数按 ffmpeg 的顺序拼好）。 */
async function ffmpeg(args: string[], input: Uint8Array): Promise<Uint8Array> {
  const { promise, resolve, reject } = Promise.withResolvers<Uint8Array>();
  const ff = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  ff.stdout.on("data", (chunk: Buffer) => out.push(chunk));
  ff.stderr.on("data", (chunk: Buffer) => err.push(chunk));
  ff.on("error", reject);
  ff.on("close", (code) => {
    if (code === 0 && out.length > 0) resolve(new Uint8Array(Buffer.concat(out)));
    else reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().trim()}`));
  });
  ff.stdin.end(Buffer.from(input));
  return promise;
}

/** 别的容器（MiniMax 的 mp3）→ 裸 PCM（PCM_RATE、16 位单声道）：按字节算时长，再走同一条 OGG 转换。 */
async function toPcm(audio: Uint8Array, format: string): Promise<Uint8Array> {
  return ffmpeg(
    [
      ...["-hide_banner", "-loglevel", "error", "-f", format, "-i", "pipe:0"],
      ...["-ac", "1", "-ar", String(PCM_RATE), "-f", "s16le", "pipe:1"],
    ],
    audio,
  );
}

/** WAV → OGG/Opus（Telegram 语音的格式；48 kHz 单声道，32 kbps，语音模式）。 */
async function toOggOpus(wav: Uint8Array): Promise<Uint8Array> {
  return ffmpeg(
    [
      ...["-hide_banner", "-loglevel", "error", "-f", "wav", "-i", "pipe:0"],
      ...["-c:a", "libopus", "-b:a", "32k", "-ar", "48000", "-ac", "1", "-application", "voip"],
      ...["-f", "ogg", "pipe:1"],
    ],
    wav,
  );
}
