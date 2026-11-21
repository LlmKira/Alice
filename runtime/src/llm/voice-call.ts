/**
 * 通话里的实时对话：对方说话 → 断句 → 转写 → 回一句 → 合成 → 放回去，能被对方插话打断。
 * 这个文件是外壳层：只做 PCM 处理、ffmpeg 转容器、编排；说什么由注入的 reply 决定。
 *
 * 多语言：来电的人可能说中文、俄语、英语或别的语言。转写保持原语言（逐字听写，不翻译、不按中文硬猜），
 * reply 按对方这一句的语言自然接（见 CALL_TONE），合成只走 MiniMax speech-2.8-hd（language_boost=auto），
 * 不依赖 Gemini TTS。
 */
import { spawn } from "node:child_process";
import type { SpokenVoice } from "../telegram/actions.js";

export const CALL_SAMPLE_RATE = 48_000;
const SAMPLE_BYTES = 2;
/** 20 ms = 960 个采样 = 1920 字节。 */
export const CALL_FRAME_SAMPLES = 960;
export const CALL_FRAME_BYTES = CALL_FRAME_SAMPLES * SAMPLE_BYTES;

/**
 * 通话里怎么说话。外壳把这段放进 reply 的提示词。
 * 语言跟对方走，不写死中文；说不下去可以自然收尾，用 [hangup] 表示这轮说完就挂。
 */
export const CALL_TONE = [
  "这是语音通话，不是打字：说口语，短句，一次说一件事。",
  "对方说什么语言就用什么语言回，中文、俄语、英语都跟着对方来。",
  "不用 Markdown、列表、表情符号、括号里的动作，也不要把链接念出来。",
  "对方说完再接；没听清就简短问一句，不猜着往下答。",
  "聊完了或对方要挂，就在最后写 [hangup]；那句话照常说出口，然后通话结束。",
].join("\n");

export interface VoiceTurn {
  role: "caller" | "alice";
  text: string;
  at: number;
}

export interface VoiceReply {
  text: string;
  /** 说完这句就挂。 */
  end?: boolean;
}

export interface UtteranceMeta {
  durationMs: number;
  peakRms: number;
}

export interface PcmUtteranceDetectorOptions {
  sampleRate?: number;
  /** 一帧多少毫秒，默认 20。 */
  frameMs?: number;
  /** RMS 门限（0–1，按 int16 归一化后算），默认 0.012。 */
  rmsThreshold?: number;
  /** 连续几帧超过门限才算开口，默认 3。 */
  speechFrames?: number;
  /** 静多久算说完，默认 700 ms。 */
  silenceMs?: number;
  /** 一句话最长攒多久，默认 20 s；到点先交出去，后面接着攒。 */
  maxUtteranceMs?: number;
  /** 开口前往回带多少毫秒，避免吃掉第一个字，默认 200 ms。 */
  preRollMs?: number;
  onSpeechStart?: () => void;
  onUtterance?: (pcm: Buffer, meta: UtteranceMeta) => void;
}

/** 一帧 16 位单声道 PCM 的 RMS（归一化到 0–1）。 */
export function pcmRms(frame: Uint8Array): number {
  const view = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  const samples = Math.floor(view.length / 2);
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const value = view.readInt16LE(i * 2) / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / samples);
}

/**
 * 纯 PCM 的断句器：按 20 ms 帧算能量，连续几帧过了门限就算开口（立刻通知，用来打断正在放的语音），
 * 之后攒帧，静够 silenceMs 交出一整句；一句话最长 maxUtteranceMs，超了先交再接着攒。
 */
export class PcmUtteranceDetector {
  readonly frameMs: number;
  private readonly frameBytes: number;
  private readonly threshold: number;
  private readonly speechFrames: number;
  private readonly silenceFrames: number;
  private readonly maxBytes: number;
  private readonly prerollFrames: number;
  private readonly options: PcmUtteranceDetectorOptions;
  private pending: Buffer = Buffer.alloc(0);
  private speaking = false;
  private speechRun = 0;
  private silentRun = 0;
  private parts: Buffer[] = [];
  private bytes = 0;
  private peak = 0;
  private preroll: Buffer[] = [];

  constructor(options: PcmUtteranceDetectorOptions = {}) {
    const sampleRate = options.sampleRate ?? CALL_SAMPLE_RATE;
    this.frameMs = options.frameMs ?? 20;
    this.frameBytes = Math.max(2, Math.round((sampleRate * SAMPLE_BYTES * this.frameMs) / 1000));
    this.threshold = options.rmsThreshold ?? 0.012;
    this.speechFrames = Math.max(1, options.speechFrames ?? 3);
    this.silenceFrames = Math.max(1, Math.round((options.silenceMs ?? 700) / this.frameMs));
    this.maxBytes = Math.max(
      this.frameBytes,
      Math.round(((options.maxUtteranceMs ?? 20_000) / 1000) * sampleRate * SAMPLE_BYTES),
    );
    this.prerollFrames = Math.max(0, Math.round((options.preRollMs ?? 200) / this.frameMs));
    this.options = options;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** 喂一段 48 kHz 单声道 PCM（可以不是整帧，内部会拼）。 */
  push(chunk: Uint8Array): void {
    const data = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.pending = this.pending.length ? Buffer.concat([this.pending, data]) : data;
    while (this.pending.length >= this.frameBytes) {
      const frame = this.pending.subarray(0, this.frameBytes);
      this.pending = this.pending.subarray(this.frameBytes);
      this.consume(frame);
    }
  }

  /** 通话断开或主动收尾：把还没交出去的一句交掉。 */
  flush(): void {
    if (this.speaking) this.emit();
    this.reset();
  }

  reset(): void {
    this.pending = Buffer.alloc(0);
    this.speaking = false;
    this.speechRun = 0;
    this.silentRun = 0;
    this.parts = [];
    this.bytes = 0;
    this.peak = 0;
    this.preroll = [];
  }

  private consume(frame: Buffer): void {
    const rms = pcmRms(frame);
    if (!this.speaking) {
      if (this.prerollFrames > 0) {
        this.preroll.push(Buffer.from(frame));
        if (this.preroll.length > this.prerollFrames) this.preroll.shift();
      }
      if (rms < this.threshold) {
        this.speechRun = 0;
        return;
      }
      this.speechRun++;
      if (this.speechRun < this.speechFrames) return;
      this.speaking = true;
      this.silentRun = 0;
      this.peak = rms;
      this.parts = this.preroll;
      this.bytes = this.parts.reduce((total, part) => total + part.length, 0);
      this.preroll = [];
      this.speechRun = 0;
      this.options.onSpeechStart?.();
      return;
    }

    this.parts.push(Buffer.from(frame));
    this.bytes += frame.length;
    this.peak = Math.max(this.peak, rms);
    if (rms >= this.threshold) this.silentRun = 0;
    else this.silentRun++;

    if (this.silentRun >= this.silenceFrames) {
      this.emit();
      this.reset();
      return;
    }
    if (this.bytes >= this.maxBytes) {
      // 说得很长：先把这段交出去，后面的继续算同一句的延续。
      this.emit();
      this.parts = [];
      this.bytes = 0;
      this.peak = 0;
      this.silentRun = 0;
    }
  }

  private emit(): void {
    if (this.bytes === 0) return;
    // 说满上限后的那截尾巴可能全是静音：不送去转写。
    if (this.peak < this.threshold) {
      this.parts = [];
      this.bytes = 0;
      this.peak = 0;
      return;
    }
    const pcm = Buffer.concat(this.parts);
    const meta: UtteranceMeta = {
      durationMs: Math.round((this.bytes / (CALL_SAMPLE_RATE * SAMPLE_BYTES)) * 1000),
      peakRms: this.peak,
    };
    this.parts = [];
    this.bytes = 0;
    this.peak = 0;
    this.options.onUtterance?.(pcm, meta);
  }
}

/** 裸 48 kHz PCM 加 44 字节 WAV 头（单声道、16 位）。 */
export function pcm48kToWav(pcm: Uint8Array): Buffer {
  const body = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + body.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(CALL_SAMPLE_RATE, 24);
  header.writeUInt32LE(CALL_SAMPLE_RATE * SAMPLE_BYTES, 28);
  header.writeUInt16LE(SAMPLE_BYTES, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(body.length, 40);
  return Buffer.concat([header, body]);
}

function runFfmpeg(args: string[], input: Uint8Array, signal?: AbortSignal): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  const ff = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  const onAbort = () => ff.kill("SIGKILL");
  signal?.addEventListener("abort", onAbort, { once: true });
  const settle = (finish: () => void) => {
    signal?.removeEventListener("abort", onAbort);
    finish();
  };
  ff.stdout.on("data", (chunk: Buffer) => out.push(chunk));
  ff.stderr.on("data", (chunk: Buffer) => err.push(chunk));
  ff.on("error", (error) => settle(() => reject(error)));
  ff.on("close", (code) => {
    settle(() => {
      if (signal?.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error("ffmpeg aborted"));
      } else if (code === 0 && out.length > 0) {
        resolve(Buffer.concat(out));
      } else {
        reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().trim()}`));
      }
    });
  });
  ff.stdin.end(Buffer.from(input));
  return promise;
}

/** 48 kHz PCM → OGG/Opus（transcribeVoice 认的那种容器；32 kbps、语音模式）。 */
export function pcm48kToOgg(pcm: Uint8Array, signal?: AbortSignal): Promise<Buffer> {
  return runFfmpeg(
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "s16le",
      "-ar",
      String(CALL_SAMPLE_RATE),
      "-ac",
      "1",
      "-i",
      "pipe:0",
      "-c:a",
      "libopus",
      "-b:a",
      "32k",
      "-ar",
      String(CALL_SAMPLE_RATE),
      "-ac",
      "1",
      "-application",
      "voip",
      "-f",
      "ogg",
      "pipe:1",
    ],
    pcm,
    signal,
  );
}

/**
 * OGG/Opus → 48 kHz、16 位、单声道 PCM，直接能喂给 ntgcalls 的 sendExternalFrame。
 * 合成那边（MiniMax speech-2.8-hd，多语种自动增强）给的就是 OGG，不用管原采样率和语言。
 */
export function oggToPcm48k(ogg: Uint8Array, signal?: AbortSignal): Promise<Buffer> {
  return runFfmpeg(
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "ogg",
      "-i",
      "pipe:0",
      "-f",
      "s16le",
      "-ac",
      "1",
      "-ar",
      String(CALL_SAMPLE_RATE),
      "pipe:1",
    ],
    ogg,
    signal,
  );
}

const HANGUP = /\[\s*hangup\s*\]/i;

/** 把 reply 的两种写法（纯文本 + [hangup]，或 {text, end}）归一成一句话和一个是否挂断。 */
export function readReply(answer: string | VoiceReply): { text: string; end: boolean } {
  const raw = typeof answer === "string" ? answer : answer.text;
  const end = HANGUP.test(raw) || (typeof answer !== "string" && answer.end === true);
  const text = raw.replace(HANGUP, "").replace(/\s+/g, " ").trim();
  return { text, end };
}

export interface VoiceCallDeps {
  /**
   * 转写：进来的是 OGG/Opus，回来是对方说的原话。
   * 保持原语言逐字听写（transcribeVoice 就是这么问的），不要翻译成中文再往下走。
   */
  asr(audio: Uint8Array): Promise<string>;
  /** 看完整通话记录接一句；多语言由调用方按 CALL_TONE 提示，按对方语言回。 */
  reply(history: readonly VoiceTurn[], callerText: string): Promise<string | VoiceReply>;
  /** 合成一句（MiniMax speech-2.8-hd 的 OGG）；signal 中止时尽快抛。 */
  speak(text: string, signal: AbortSignal): Promise<SpokenVoice>;
  /** 把合成好的 48 kHz PCM 放进通话（通常接 TelegramPhoneCalls.sendAudioFrames）。 */
  sendFrame(pcm48kMono: Buffer, signal: AbortSignal): Promise<void>;
  /** 接通时返回一句招呼就替她说出来；返回空就不说。 */
  onConnect?: () => string | undefined | Promise<string | undefined>;
  onEnd?: (reason: string) => void;
  onError?: (error: unknown) => void;
  detectorOptions?: PcmUtteranceDetectorOptions;
  now?: () => number;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/**
 * 一通电话里的双向对话。上层每收到一块对方的声音就 handleAudio，其余都在这儿串起来：
 * 断句 → 转写 → 接话 → 合成 → 送回去；对方一开口就打断正在放的语音。
 */
export class VoiceCallSession {
  readonly turns: VoiceTurn[] = [];
  /** 被对方插话打断了几次（测试和观察用）。 */
  interruptions = 0;
  private readonly deps: VoiceCallDeps;
  private readonly detector: PcmUtteranceDetector;
  private readonly now: () => number;
  private queue: Promise<void> = Promise.resolve();
  private inflight: AbortController | null = null;
  private pendingTurns = 0;
  private started = false;
  private closed = false;

  constructor(deps: VoiceCallDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    const detectorOptions = deps.detectorOptions ?? {};
    this.detector = new PcmUtteranceDetector({
      ...detectorOptions,
      onSpeechStart: () => {
        detectorOptions.onSpeechStart?.();
        this.bargeIn();
      },
      onUtterance: (pcm, meta) => {
        detectorOptions.onUtterance?.(pcm, meta);
        this.enqueue(pcm);
      },
    });
  }

  get ended(): boolean {
    return this.closed;
  }

  /** 接通后调一次：可选先说一句招呼。 */
  async start(): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;
    try {
      const greeting = await this.deps.onConnect?.();
      if (this.closed || typeof greeting !== "string") return;
      const text = greeting.trim();
      if (!text) return;
      this.turns.push({ role: "alice", text, at: this.now() });
      await this.withPlayback((signal) => this.play(text, signal));
    } catch (error) {
      this.fail(error);
    }
  }

  /** 收到一块对方的声音（48 kHz、16 位、单声道）。坏帧只记一次错，不往上抛。 */
  handleAudio(pcm: Uint8Array): void {
    if (this.closed) return;
    try {
      this.detector.push(pcm);
    } catch (error) {
      this.fail(error);
    }
  }

  /** 等手上这句处理完（测试、挂断前收尾用）。 */
  async whenIdle(): Promise<void> {
    for (;;) {
      const queued = this.queue;
      await queued.catch(() => {});
      if (this.pendingTurns === 0) return;
    }
  }

  /** 收尾：打断正在放的话，不再接新的声音。 */
  dispose(reason = "dispose"): void {
    if (this.closed) return;
    this.closed = true;
    this.inflight?.abort(new Error("call ended"));
    this.inflight = null;
    this.detector.reset();
    this.deps.onEnd?.(reason);
  }

  private enqueue(pcm: Buffer): void {
    if (this.closed) return;
    this.pendingTurns++;
    this.queue = this.queue
      .then(() => this.runTurn(pcm))
      .catch((error) => this.fail(error))
      .finally(() => {
        this.pendingTurns--;
      });
  }

  private async runTurn(pcm: Buffer): Promise<void> {
    if (this.closed) return;
    const controller = new AbortController();
    this.inflight = controller;
    try {
      const ogg = await pcm48kToOgg(pcm, controller.signal);
      if (controller.signal.aborted) return;
      const heard = (await this.deps.asr(ogg)).trim();
      if (!heard || controller.signal.aborted) return;
      this.turns.push({ role: "caller", text: heard, at: this.now() });
      const answer = await this.deps.reply([...this.turns], heard);
      if (this.closed || controller.signal.aborted) return;
      const reply = readReply(answer);
      if (reply.text) {
        this.turns.push({ role: "alice", text: reply.text, at: this.now() });
        await this.play(reply.text, controller.signal);
      }
      if (reply.end) this.dispose("hangup");
    } catch (error) {
      if (!controller.signal.aborted && !isAbortError(error)) this.fail(error);
    } finally {
      if (this.inflight === controller) this.inflight = null;
    }
  }

  private async play(text: string, signal: AbortSignal): Promise<void> {
    const voice = await this.deps.speak(text, signal);
    if (signal.aborted) return;
    const pcm = await oggToPcm48k(voice.ogg, signal);
    if (signal.aborted) return;
    await this.deps.sendFrame(pcm, signal);
  }

  private async withPlayback(run: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const controller = new AbortController();
    this.inflight = controller;
    try {
      await run(controller.signal);
    } catch (error) {
      // 招呼刚出口就被对方打断：正常，不算错。
      if (!controller.signal.aborted && !isAbortError(error)) throw error;
    } finally {
      if (this.inflight === controller) this.inflight = null;
    }
  }

  /** 对方开口：立刻掐掉正在合成/正在放的那句。 */
  private bargeIn(): void {
    if (!this.inflight || this.inflight.signal.aborted) return;
    this.interruptions++;
    this.inflight.abort(new Error("barge-in"));
  }

  private fail(error: unknown): void {
    this.deps.onError?.(error);
  }
}
