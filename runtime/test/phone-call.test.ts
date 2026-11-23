/**
 * 电话这条路的两层：phone-call.ts 的 MTProto 信令 + ntgcalls 原生桥，voice-call.ts 的断句、转码和对话。
 * 一半用真的：真的 NTgCalls（原生加载、2048 位 DH 交换、PCM 入帧）、真的 ffmpeg 转 OGG；
 * 一半用假的：Telegram RPC 和传输层，好逐条核对发出去的顺序和字段。
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import type { AuthParams, DhConfig, Frame, FrameData, MediaDescription, RTCServer } from "ntgcalls";
import { MediaSource, NTgCalls, StreamDevice, StreamMode, VideoRotation } from "ntgcalls";
import { describe, expect, it, vi } from "vitest";
import {
  CALL_TONE,
  oggToPcm48k,
  PcmUtteranceDetector,
  pcm48kToOgg,
  pcm48kToWav,
  pcmRms,
  readReply,
  VoiceCallSession,
} from "../src/llm/voice-call.js";
import {
  CALL_SAMPLE_RATE,
  type CallTransport,
  customParametersJson,
  type PhoneCallRequestedUpdate,
  type PhoneCallRpc,
  type PhoneCallSignalingClient,
  phoneCallProtocol,
  rtcServers,
  TelegramPhoneCalls,
} from "../src/telegram/phone-call.js";

/** RFC 3526 group 14：真的 2048 位素数，和 Telegram 的 DH 参数同形。 */
const PRIME = Buffer.from(
  "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AACAA68FFFFFFFFFFFFFFFF",
  "hex",
);

/** ntgcalls 原生实例在 Vitest worker_threads 卸载时会触发 WebRTC C++ 全局析构段错误；放到子进程跑照旧实测原生 ABI 与 DH 交换，进程干净退出。 */
function runNativeProbe(body: string): string {
  return execFileSync(process.execPath, ["--input-type=module", "-e", body], {
    encoding: "utf8",
  }).trim();
}

const PRIME_HEX = PRIME.toString("hex");
function tonePcm(ms: number, hz = 440, amplitude = 0.3): Buffer {
  const samples = Math.round((CALL_SAMPLE_RATE * ms) / 1000);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const value = Math.round(
      Math.sin((2 * Math.PI * hz * i) / CALL_SAMPLE_RATE) * amplitude * 32767,
    );
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, value)), i * 2);
  }
  return pcm;
}

function silencePcm(ms: number): Buffer {
  return Buffer.alloc(Math.round((CALL_SAMPLE_RATE * ms) / 1000) * 2);
}

/** 测试里单独跑一次 WAV → OGG，证明 pcm48kToWav 的头 ffmpeg 认。 */
async function wavToOgg(wav: Buffer): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  const ff = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "wav",
      "-i",
      "pipe:0",
      "-c:a",
      "libopus",
      "-b:a",
      "32k",
      "-ar",
      "48000",
      "-ac",
      "1",
      "-f",
      "ogg",
      "pipe:1",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const out: Buffer[] = [];
  ff.stdout.on("data", (chunk: Buffer) => out.push(chunk));
  ff.on("error", reject);
  ff.on("close", (code) => {
    if (code === 0 && out.length > 0) resolve(Buffer.concat(out));
    else reject(new Error(`ffmpeg exited ${code}`));
  });
  ff.stdin.end(wav);
  return promise;
}

function frame(data: Buffer): Frame {
  return {
    ssrc: 1n,
    data,
    frameData: {
      absoluteCaptureTimestampMs: 0n,
      rotation: VideoRotation.VIDEO_ROTATION_0,
      width: 0,
      height: 0,
    },
  };
}

class FakeClient implements PhoneCallSignalingClient {
  readonly calls: PhoneCallRpc[] = [];
  readonly resolved: number[] = [];
  requestCallReply: Record<string, unknown> = {
    _: "phoneCallWaiting",
    id: 31n,
    accessHash: 32n,
  };
  /** 优先消费的 getDhConfig 回复；空时回完整参数。 */
  dhConfigReplies: Record<string, unknown>[] = [];
  private readonly handlers = new Map<string, (request: PhoneCallRpc) => Record<string, unknown>>();

  constructor() {
    this.handlers.set(
      "messages.getDhConfig",
      () =>
        this.dhConfigReplies.shift() ?? {
          _: "messages.dhConfig",
          g: 3,
          p: PRIME,
          random: randomBytes(256),
          version: 7,
        },
    );
    this.handlers.set("phone.requestCall", () => this.requestCallReply);
    this.handlers.set("phone.acceptCall", () => ({ _: "phoneCall", id: 11n }));
  }

  async call(request: PhoneCallRpc): Promise<Record<string, unknown>> {
    this.calls.push(request);
    return this.handlers.get(request._)?.(request) ?? {};
  }

  async resolveUser(userId: number): Promise<{ userId: number; accessHash: bigint }> {
    this.resolved.push(userId);
    return { userId, accessHash: BigInt(userId) * 2n };
  }

  rpc(name: string): PhoneCallRpc {
    const found = this.calls.find((call) => call._ === name);
    if (!found) throw new Error(`no ${name} rpc`);
    return found;
  }
}

class FakeTransport implements CallTransport {
  readonly created: bigint[] = [];
  readonly streams: { userId: bigint; mode: StreamMode; media: MediaDescription }[] = [];
  readonly exchanges: { userId: bigint; dh: DhConfig; gaHash: Buffer | null }[] = [];
  readonly keys: { userId: bigint; gAOrB: Buffer; fingerprint: bigint }[] = [];
  readonly connects: {
    userId: bigint;
    servers: RTCServer[];
    versions: string[];
    p2pAllowed: boolean;
    customParameters: string;
  }[] = [];
  readonly stopped: bigint[] = [];
  readonly signals: { userId: bigint; data: Buffer }[] = [];
  readonly framesSent: {
    userId: bigint;
    device: StreamDevice;
    data: Buffer;
    frameData: FrameData;
  }[] = [];
  initResult: Buffer = Buffer.alloc(256, 7);
  exchangeResult: AuthParams = { keyFingerprint: 987_654_321n, gAOrB: Buffer.alloc(256, 9) };
  onFrameSent: (() => void) | null = null;
  private signalingHandler: ((userId: bigint, data: Buffer) => void) | null = null;
  private framesHandler:
    | ((userId: bigint, mode: StreamMode, device: StreamDevice, frames: Frame[]) => void)
    | null = null;

  async createP2pCall(userId: bigint): Promise<void> {
    this.created.push(userId);
  }

  async setStreamSources(userId: bigint, mode: StreamMode, media: MediaDescription): Promise<void> {
    this.streams.push({ userId, mode, media });
  }

  async initExchange(userId: bigint, dh: DhConfig, gaHash: Buffer | null): Promise<Buffer> {
    this.exchanges.push({ userId, dh, gaHash });
    return this.initResult;
  }

  async exchangeKeys(userId: bigint, gAOrB: Buffer, fingerprint: bigint): Promise<AuthParams> {
    this.keys.push({ userId, gAOrB, fingerprint });
    return this.exchangeResult;
  }

  async connectP2p(
    userId: bigint,
    servers: RTCServer[],
    versions: string[],
    p2pAllowed: boolean,
    customParameters: string,
  ): Promise<void> {
    this.connects.push({ userId, servers, versions, p2pAllowed, customParameters });
  }

  async stop(userId: bigint): Promise<void> {
    this.stopped.push(userId);
  }

  async sendSignalingData(userId: bigint, data: Buffer): Promise<void> {
    this.signals.push({ userId, data });
  }

  async sendExternalFrame(
    userId: bigint,
    device: StreamDevice,
    data: Buffer,
    frameData: FrameData,
  ): Promise<void> {
    this.framesSent.push({ userId, device, data, frameData });
    this.onFrameSent?.();
  }

  onSignalingData(callback: (userId: bigint, data: Buffer) => void): void {
    this.signalingHandler = callback;
  }

  onFrames(
    callback: (userId: bigint, mode: StreamMode, device: StreamDevice, frames: Frame[]) => void,
  ): void {
    this.framesHandler = callback;
  }

  emitSignaling(userId: bigint, data: Buffer): void {
    this.signalingHandler?.(userId, data);
  }

  emitFrames(userId: bigint, mode: StreamMode, frames: Frame[]): void {
    this.framesHandler?.(userId, mode, StreamDevice.SPEAKER, frames);
  }
}

function setup(options: { allowUser?: (userId: number) => boolean } = {}) {
  const client = new FakeClient();
  const transport = new FakeTransport();
  const closed: { userId: number; reason: string }[] = [];
  const audio: { userId: number; pcm: Buffer }[] = [];
  const connected: number[] = [];
  const errors: unknown[] = [];
  const calls = new TelegramPhoneCalls({
    client,
    transport,
    ...options,
    onClosed: (userId, reason) => closed.push({ userId, reason }),
    onAudio: (userId, pcm) => audio.push({ userId, pcm }),
    onConnected: (userId) => connected.push(userId),
    onError: (error) => errors.push(error),
  });
  return { client, transport, calls, closed, audio, connected, errors };
}

describe("real NTgCalls: native loading and the DH handshake", () => {
  it("reports the protocol Telegram needs and keeps its native ABI happy", () => {
    expect(NTgCalls.ping()).toBe("pong");
    const protocol = NTgCalls.getProtocol();
    expect(protocol.udpP2p).toBe(true);
    expect(protocol.udpReflector).toBe(true);
    expect(protocol.minLayer).toBeGreaterThan(0);
    expect(protocol.maxLayer).toBeGreaterThanOrEqual(protocol.minLayer);
    expect(protocol.libraryVersions.length).toBeGreaterThan(0);
    expect(phoneCallProtocol(protocol)).toMatchObject({
      _: "phoneCallProtocol",
      udpP2p: true,
      minLayer: protocol.minLayer,
      maxLayer: protocol.maxLayer,
      libraryVersions: protocol.libraryVersions,
    });

    const out = runNativeProbe(`
      import { randomBytes } from "node:crypto";
      import { CallType, MediaSource, NTgCalls, StreamDevice, StreamMode, VideoRotation } from "ntgcalls";
      const prime = Buffer.from(${JSON.stringify(PRIME_HEX)}, "hex");
      const ntg = new NTgCalls();
      const userId = 9_000_001n;
      const audio = () => ({ mediaSource: MediaSource.EXTERNAL, sampleRate: ${CALL_SAMPLE_RATE}, channelCount: 1, input: "", keepOpen: true });
      try {
        await ntg.createP2pCall(userId);
        await ntg.setStreamSources(userId, StreamMode.CAPTURE, { microphone: audio() });
        await ntg.setStreamSources(userId, StreamMode.PLAYBACK, { speaker: audio() });
        const callType = await ntg.getCallType(userId);
        await ntg.sendExternalFrame(userId, StreamDevice.MICROPHONE, Array.from(Buffer.alloc(1920)), {
          absoluteCaptureTimestampMs: 0n,
          rotation: VideoRotation.VIDEO_ROTATION_0,
          width: 0,
          height: 0,
        });
        const gAHash = await ntg.initExchange(
          userId,
          { g: 2, p: Array.from(prime), random: Array.from(randomBytes(256)) },
          null,
        );
        console.log(JSON.stringify({ callType, expected: CallType.P2P, hashLen: gAHash.length }));
      } finally {
        await ntg.stop(userId);
      }
    `);
    const parsed = JSON.parse(out) as { callType: number; expected: number; hashLen: number };
    expect(parsed.callType).toBe(parsed.expected);
    expect(parsed.hashLen).toBe(32);
  });

  it("finishes a real 2048-bit DH exchange between caller and callee", () => {
    const out = runNativeProbe(`
      import { randomBytes } from "node:crypto";
      import { NTgCalls } from "ntgcalls";
      const prime = Buffer.from(${JSON.stringify(PRIME_HEX)}, "hex");
      const caller = new NTgCalls();
      const callee = new NTgCalls();
      const callerId = 9_000_011n;
      const calleeId = 9_000_012n;
      try {
        await caller.createP2pCall(callerId);
        await callee.createP2pCall(calleeId);
        const gAHash = await caller.initExchange(callerId, { g: 2, p: Array.from(prime), random: Array.from(randomBytes(256)) }, null);
        const gB = await callee.initExchange(calleeId, { g: 2, p: Array.from(prime), random: Array.from(randomBytes(256)) }, Array.from(gAHash));
        const auth = await caller.exchangeKeys(callerId, Array.from(gB), 0n);
        const peerAuth = await callee.exchangeKeys(calleeId, Array.from(auth.gAOrB), auth.keyFingerprint);
        console.log(JSON.stringify({
          hashLen: gAHash.length,
          gBLen: gB.length,
          gALen: auth.gAOrB.length,
          fpMatch: peerAuth.keyFingerprint === auth.keyFingerprint && BigInt(auth.keyFingerprint) !== 0n,
          gBMatch: Buffer.from(peerAuth.gAOrB).equals(Buffer.from(gB)),
        }));
      } finally {
        await caller.stop(callerId);
        await callee.stop(calleeId);
      }
    `);
    expect(JSON.parse(out)).toEqual({
      hashLen: 32,
      gBLen: 256,
      gALen: 256,
      fpMatch: true,
      gBMatch: true,
    });
  });
});

describe("phone call signaling: incoming", () => {
  const requested = (gAHash: Buffer): PhoneCallRequestedUpdate => ({
    _: "phoneCallRequested",
    id: 11n,
    accessHash: 22n,
    adminId: 777,
    participantId: 1,
    gAHash,
  });

  it("gets DH config, prepares the streams, accepts with gB and flushes signaling", async () => {
    const { client, transport, calls, audio, connected, errors } = setup();
    const gAHash = randomBytes(32);

    await calls.handleUpdate(requested(gAHash));

    expect(client.rpc("messages.getDhConfig")).toMatchObject({
      version: 0,
      randomLength: 256,
    });
    expect(transport.created).toEqual([777n]);
    expect(calls.active).toEqual([777]);

    expect(transport.streams).toHaveLength(2);
    const [capture, playback] = transport.streams;
    expect(capture?.mode).toBe(StreamMode.CAPTURE);
    expect(capture?.media.microphone).toMatchObject({
      mediaSource: MediaSource.EXTERNAL,
      sampleRate: CALL_SAMPLE_RATE,
      channelCount: 1,
      keepOpen: true,
    });
    expect(playback?.mode).toBe(StreamMode.PLAYBACK);
    expect(playback?.media.speaker).toMatchObject({
      mediaSource: MediaSource.EXTERNAL,
      sampleRate: CALL_SAMPLE_RATE,
      channelCount: 1,
      keepOpen: true,
    });

    const exchange = transport.exchanges[0];
    expect(exchange?.userId).toBe(777n);
    // 发给原生层的 DH 参数和 gAHash 是数字数组。
    expect(Array.isArray(exchange?.dh.p)).toBe(true);
    expect(Array.isArray(exchange?.dh.random)).toBe(true);
    expect(Array.isArray(exchange?.gaHash)).toBe(true);
    expect(Buffer.from(exchange?.gaHash ?? [])).toEqual(gAHash);

    const accept = client.rpc("phone.acceptCall");
    expect(accept.peer).toEqual({ _: "inputPhoneCall", id: 11n, accessHash: 22n });
    expect(Buffer.from(accept.gB as Uint8Array)).toEqual(transport.initResult);
    expect(accept.protocol).toMatchObject({
      _: "phoneCallProtocol",
      udpP2p: true,
      minLayer: NTgCalls.getProtocol().minLayer,
    });

    // 对方的声音只收 PLAYBACK；我们自己送出去的 CAPTURE 帧不回调上来。
    transport.emitFrames(777n, StreamMode.CAPTURE, [frame(Buffer.from([1, 1]))]);
    expect(audio).toEqual([]);
    transport.emitFrames(777n, StreamMode.PLAYBACK, [frame(Buffer.from([2, 2]))]);
    expect(audio).toEqual([{ userId: 777, pcm: Buffer.from([2, 2]) }]);

    expect(errors).toEqual([]);
    expect(connected).toEqual([]);
    await calls.dispose();
  });

  it("reuses the cached prime when Telegram answers dhConfigNotModified", async () => {
    const { client, transport, calls } = setup();
    await calls.handleUpdate(requested(randomBytes(32)));
    await calls.hangup(777);

    client.dhConfigReplies.push({
      _: "messages.dhConfigNotModified",
      random: randomBytes(256),
    });
    await calls.handleUpdate({
      _: "phoneCallRequested",
      id: 12n,
      accessHash: 23n,
      adminId: 778,
      participantId: 1,
      gAHash: randomBytes(32),
    });

    expect(transport.exchanges).toHaveLength(2);
    expect(transport.exchanges[1]?.dh.p).toEqual(Array.from(PRIME));
    expect(transport.exchanges[1]?.dh.g).toBe(3);
    expect(client.calls.filter((call) => call._ === "phone.acceptCall")).toHaveLength(2);
    await calls.dispose();
  });

  it("rejects a caller the policy does not allow, as busy", async () => {
    const { client, transport, calls } = setup({ allowUser: () => false });
    await calls.handleUpdate(requested(randomBytes(32)));

    expect(client.rpc("phone.discardCall")).toMatchObject({
      peer: { _: "inputPhoneCall", id: 11n, accessHash: 22n },
      duration: 0,
      reason: { _: "phoneCallDiscardReasonBusy" },
      connectionId: 0n,
    });
    expect(client.calls.some((call) => call._ === "phone.acceptCall")).toBe(false);
    expect(transport.created).toEqual([]);
    expect(calls.active).toEqual([]);
  });

  it("connects on phoneCall with mapped RTC servers and bridges signaling both ways", async () => {
    const { client, transport, calls, closed, errors } = setup({ allowUser: () => true });
    await calls.handleUpdate(requested(randomBytes(32)));

    // connect 之前的信令先排队。
    await calls.handleSignalingData({ phoneCallId: 11n, data: Buffer.from([7, 7]) });
    expect(transport.signals).toEqual([]);

    await calls.handleUpdate({
      _: "phoneCall",
      id: 11n,
      accessHash: 22n,
      gAOrB: Buffer.alloc(256, 3),
      keyFingerprint: 42n,
      connections: [
        {
          _: "phoneConnection",
          id: 9_007_199_254_740_993n,
          ip: "149.154.167.50",
          ipv6: "2001:db8::1",
          port: 443,
          peerTag: Buffer.from([1, 2, 3, 4]),
          tcp: true,
        },
        {
          _: "phoneConnectionWebrtc",
          id: 2n,
          ip: "127.0.0.1",
          port: 3478,
          turn: true,
          stun: true,
          username: "user",
          password: "pass",
        },
      ],
      p2pAllowed: true,
      customParameters: { _: "dataJSON", data: '{"debug":true}' },
    });

    expect(transport.keys[0]?.fingerprint).toBe(42n);
    expect(Array.isArray(transport.keys[0]?.gAOrB)).toBe(true);

    const connect = transport.connects[0];
    expect(connect?.userId).toBe(777n);
    expect(connect?.servers[0]).toMatchObject({
      id: 9_007_199_254_740_993n,
      ipv4: "149.154.167.50",
      ipv6: "2001:db8::1",
      port: 443,
      tcp: true,
      turn: false,
      stun: false,
    });
    expect(connect?.servers[0]?.peerTag).toEqual([1, 2, 3, 4]);
    expect(connect?.servers[1]).toMatchObject({
      id: 2n,
      ipv4: "127.0.0.1",
      port: 3478,
      turn: true,
      stun: true,
      username: "user",
      password: "pass",
      tcp: false,
    });
    expect(connect?.versions).toEqual(NTgCalls.getProtocol().libraryVersions);
    expect(connect?.p2pAllowed).toBe(true);
    expect(connect?.customParameters).toBe('{"debug":true}');

    // connect 前的信令补发出去（原生层收数字数组）。
    expect(transport.signals).toHaveLength(1);
    expect(transport.signals[0]?.userId).toBe(777n);
    expect(transport.signals[0]?.data).toEqual([7, 7]);

    // ntgcalls → MTProto。
    transport.emitSignaling(777n, Buffer.from([5, 5]));
    await vi.waitFor(() => {
      expect(client.rpc("phone.sendSignalingData")).toMatchObject({
        peer: { _: "inputPhoneCall", id: 11n, accessHash: 22n },
        data: Buffer.from([5, 5]),
      });
    });

    // MTProto → ntgcalls（已连接）。
    await calls.handleSignalingData({ phoneCallId: 11n, data: Buffer.from([6, 6]) });
    expect(transport.signals.at(-1)?.userId).toBe(777n);
    expect(transport.signals.at(-1)?.data).toEqual([6, 6]);

    expect(errors).toEqual([]);

    await calls.hangup(777);
    expect(client.rpc("phone.discardCall")).toMatchObject({
      duration: expect.any(Number) as number,
      reason: { _: "phoneCallDiscardReasonHangup" },
      connectionId: 0n,
    });
    expect(transport.stopped).toEqual([777n]);
    expect(closed).toEqual([{ userId: 777, reason: "phoneCallDiscardReasonHangup" }]);
    expect(calls.active).toEqual([]);
  });

  it("stops the transport when Telegram discards the call", async () => {
    const { transport, calls, closed } = setup();
    await calls.handleUpdate(requested(randomBytes(32)));
    await calls.handleUpdate({
      _: "phoneCallDiscarded",
      id: 11n,
      reason: { _: "phoneCallDiscardReasonMissed" },
      duration: 0,
    });
    expect(transport.stopped).toEqual([777n]);
    expect(closed).toEqual([{ userId: 777, reason: "phoneCallDiscardReasonMissed" }]);
  });

  it("paces 20 ms PCM frames and stops sending when interrupted", async () => {
    const { transport, calls } = setup();
    await calls.handleUpdate(requested(randomBytes(32)));

    await calls.sendAudioFrames(777, Buffer.alloc(1920 * 2), { paced: false });
    expect(transport.framesSent).toHaveLength(2);
    expect(transport.framesSent[0]?.device).toBe(StreamDevice.MICROPHONE);
    expect(transport.framesSent[0]?.data).toHaveLength(1920);
    expect(Array.isArray(transport.framesSent[0]?.data)).toBe(true);

    const abort = new AbortController();
    transport.onFrameSent = () => abort.abort(new Error("barge-in"));
    await expect(
      calls.sendAudioFrames(777, Buffer.alloc(1920 * 3), {
        signal: abort.signal,
        paced: false,
      }),
    ).rejects.toThrow("barge-in");
    expect(transport.framesSent).toHaveLength(3);
    await calls.dispose();
  });
});

describe("phone call signaling: outgoing", () => {
  it("requests, confirms and derives gAHash from the real initExchange result", async () => {
    const { client, transport, calls } = setup();
    await calls.placeCall(777);

    expect(client.resolved).toEqual([777]);
    expect(client.rpc("messages.getDhConfig")).toMatchObject({ randomLength: 256 });
    expect(transport.created).toEqual([777n]);
    // 出去时 gaHash 必须是 null：原生层据此返回 SHA-256(gA)。
    expect(transport.exchanges[0]?.gaHash).toBeNull();

    const request = client.rpc("phone.requestCall");
    expect(request.userId).toEqual({ _: "inputUser", userId: 777, accessHash: 1554n });
    expect(request.randomId).toEqual(expect.any(Number));
    expect(Buffer.from(request.gAHash as Uint8Array)).toEqual(
      createHash("sha256").update(transport.initResult).digest(),
    );
    expect(calls.active).toEqual([777]);

    await calls.handleUpdate({
      _: "phoneCallAccepted",
      id: 31n,
      accessHash: 32n,
      adminId: 1,
      participantId: 777,
      gB: Buffer.alloc(256, 5),
    });

    expect(transport.keys[0]).toMatchObject({ userId: 777n, fingerprint: 0n });
    const confirm = client.rpc("phone.confirmCall");
    expect(confirm.peer).toEqual({ _: "inputPhoneCall", id: 31n, accessHash: 32n });
    expect(Buffer.from(confirm.gA as Uint8Array)).toEqual(transport.exchangeResult.gAOrB);
    expect(confirm.keyFingerprint).toBe(transport.exchangeResult.keyFingerprint);
    await calls.dispose();
  });
});

describe("RTC server and custom parameter mapping", () => {
  it("maps both connection flavors and drops broken customParameters", () => {
    const servers = rtcServers([
      {
        _: "phoneConnection",
        id: "9007199254740993",
        ip: "10.0.0.1",
        ipv6: "",
        port: 443,
        peerTag: new Uint8Array([9, 8]),
        tcp: true,
      },
      {
        _: "phoneConnectionWebrtc",
        id: 7n,
        ipv4: "10.0.0.2",
        port: 3478,
        username: "u",
        password: "p",
      },
    ]);
    expect(servers[0]).toMatchObject({
      id: 9_007_199_254_740_993n,
      ipv4: "10.0.0.1",
      port: 443,
      tcp: true,
      turn: false,
      stun: false,
    });
    expect(servers[0]?.peerTag).toEqual([9, 8]);
    expect(servers[1]).toMatchObject({ ipv4: "10.0.0.2", username: "u", password: "p" });
    expect(servers[1]?.peerTag).toBeUndefined();

    expect(customParametersJson({ _: "dataJSON", data: '{"a":1}' })).toBe('{"a":1}');
    expect(customParametersJson({ _: "dataJSON", data: "{oops" })).toBe("{}");
    expect(customParametersJson(null)).toBe("{}");
  });
});

describe("PCM utterance detector", () => {
  it("stays idle on silence", () => {
    let starts = 0;
    let utterances = 0;
    const detector = new PcmUtteranceDetector({
      onSpeechStart: () => starts++,
      onUtterance: () => utterances++,
    });
    detector.push(silencePcm(1_000));
    expect(starts).toBe(0);
    expect(utterances).toBe(0);
    expect(detector.isSpeaking).toBe(false);
  });

  it("signals speech start and emits the utterance after the hangup silence", () => {
    let starts = 0;
    const utterances: { durationMs: number; peakRms: number }[] = [];
    const detector = new PcmUtteranceDetector({
      speechFrames: 3,
      silenceMs: 100,
      preRollMs: 40,
      onSpeechStart: () => starts++,
      onUtterance: (_pcm, meta) => utterances.push(meta),
    });
    detector.push(Buffer.concat([tonePcm(120), silencePcm(200)]));
    expect(starts).toBe(1);
    expect(utterances).toHaveLength(1);
    expect(utterances[0]?.durationMs).toBeGreaterThanOrEqual(180);
    expect(utterances[0]?.peakRms).toBeGreaterThan(0.1);
    expect(detector.isSpeaking).toBe(false);
    expect(pcmRms(tonePcm(20))).toBeGreaterThan(0.1);
  });

  it("flushes long speech at the max utterance length", () => {
    const utterances: number[] = [];
    const detector = new PcmUtteranceDetector({
      maxUtteranceMs: 200,
      silenceMs: 1_000,
      preRollMs: 0,
      onUtterance: (_pcm, meta) => utterances.push(meta.durationMs),
    });
    detector.push(tonePcm(1_000));
    expect(utterances.length).toBeGreaterThanOrEqual(4);
    for (const duration of utterances) {
      expect(duration).toBeLessThanOrEqual(400);
    }
  });
});

describe("audio helpers", () => {
  it("wraps 48 kHz PCM in a WAV header and survives OGG roundtrips", async () => {
    const pcm = tonePcm(300);
    const wav = pcm48kToWav(pcm);
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(48_000);
    expect(wav.readUInt32LE(28)).toBe(96_000);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(pcm.length);

    const ogg = await pcm48kToOgg(pcm);
    expect(ogg.subarray(0, 4).toString("ascii")).toBe("OggS");
    const back = await oggToPcm48k(ogg);
    expect(back.length).toBeGreaterThan(pcm.length * 0.8);
    expect(back.length).toBeLessThan(pcm.length * 1.2);
    expect(back.length % 2).toBe(0);

    // WAV 这条路也真的过一遍 ffmpeg。
    const wavOgg = await wavToOgg(wav);
    expect(wavOgg.subarray(0, 4).toString("ascii")).toBe("OggS");
    const viaWav = await oggToPcm48k(wavOgg);
    expect(Math.abs(viaWav.length - pcm.length)).toBeLessThan(pcm.length * 0.2);
  });

  it("reads the hangup marker the call prompt asks for, in both reply shapes", () => {
    expect(CALL_TONE).toContain("[hangup]");
    expect(readReply("好，就这样。[hangup]")).toEqual({ text: "好，就这样。", end: true });
    expect(readReply({ text: "晚安", end: true })).toEqual({ text: "晚安", end: true });
    expect(readReply("嗯")).toEqual({ text: "嗯", end: false });
  });
});

describe("VoiceCallSession", () => {
  function feed(session: VoiceCallSession, speechMs = 120): void {
    session.handleAudio(tonePcm(speechMs));
    session.handleAudio(silencePcm(200));
  }

  it("runs two turns, keeps history and hangs up when the reply says so", async () => {
    const ogg = await pcm48kToOgg(tonePcm(200));
    const heard: string[] = [];
    const spoken: string[] = [];
    const frames: Buffer[] = [];
    const reasons: string[] = [];
    const errors: unknown[] = [];
    const histories: number[] = [];
    const replies = ["我在呢。", "那就这样，回头再聊。[hangup]"];

    const session = new VoiceCallSession({
      asr: async (audio) => {
        expect(Buffer.from(audio).subarray(0, 4).toString("ascii")).toBe("OggS");
        heard.push("你好");
        return "你好";
      },
      reply: async (history, callerText) => {
        histories.push(history.length);
        expect(callerText).toBe("你好");
        return replies.shift() ?? "嗯";
      },
      speak: async (text) => {
        spoken.push(text);
        return { ogg, seconds: 0.2 };
      },
      sendFrame: async (pcm, signal) => {
        expect(signal.aborted).toBe(false);
        frames.push(pcm);
      },
      onEnd: (reason) => reasons.push(reason),
      onError: (error) => errors.push(error),
      detectorOptions: { speechFrames: 2, silenceMs: 100, preRollMs: 40 },
    });

    await session.start();
    feed(session);
    await session.whenIdle();
    feed(session);
    await session.whenIdle();

    expect(heard).toEqual(["你好", "你好"]);
    expect(histories).toEqual([1, 3]);
    expect(spoken).toEqual(["我在呢。", "那就这样，回头再聊。"]);
    expect(frames).toHaveLength(2);
    expect(frames[0]?.length).toBeGreaterThan(0);
    expect(session.turns.map((turn) => turn.role)).toEqual(["caller", "alice", "caller", "alice"]);
    expect(reasons).toEqual(["hangup"]);
    expect(session.ended).toBe(true);
    expect(errors).toEqual([]);
  });

  it("greets once and answers in the caller's language", async () => {
    const ogg = await pcm48kToOgg(tonePcm(200));
    const spoken: string[] = [];
    const seen: string[] = [];
    const session = new VoiceCallSession({
      asr: async () => "Привет, как дела?",
      reply: async (history, callerText) => {
        seen.push(callerText);
        expect(history[0]?.role).toBe("alice");
        return "Привет! У меня всё хорошо.";
      },
      speak: async (text) => {
        spoken.push(text);
        return { ogg, seconds: 0.2 };
      },
      sendFrame: async () => {},
      onConnect: () => "喂，我在。",
      detectorOptions: { speechFrames: 2, silenceMs: 100, preRollMs: 40 },
    });

    await session.start();
    expect(spoken).toEqual(["喂，我在。"]);
    expect(session.turns[0]).toMatchObject({ role: "alice", text: "喂，我在。" });

    feed(session);
    await session.whenIdle();
    expect(seen).toEqual(["Привет, как дела?"]);
    expect(spoken).toEqual(["喂，我在。", "Привет! У меня всё хорошо."]);
  });

  it("drops its own speech the moment the caller speaks again", async () => {
    const ogg = await pcm48kToOgg(tonePcm(500));
    let frameCalls = 0;
    let asrCalls = 0;
    const errors: unknown[] = [];
    const session = new VoiceCallSession({
      asr: async () => {
        asrCalls++;
        return asrCalls === 1 ? "你还在吗" : "";
      },
      reply: async () => "我在，你说。",
      speak: async () => ({ ogg, seconds: 0.5 }),
      sendFrame: async (_pcm, signal) => {
        frameCalls++;
        if (frameCalls > 1) return;
        // 一直挂着，直到对方插话把它掐掉；测试不靠猜时长。
        const { promise, reject } = Promise.withResolvers<void>();
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        return promise;
      },
      onError: (error) => errors.push(error),
      detectorOptions: { speechFrames: 2, silenceMs: 100, preRollMs: 40 },
    });

    feed(session);
    await vi.waitFor(() => expect(frameCalls).toBe(1));

    session.handleAudio(tonePcm(120));
    expect(session.interruptions).toBe(1);
    session.handleAudio(silencePcm(200));
    await session.whenIdle();

    expect(frameCalls).toBe(1);
    expect(asrCalls).toBe(2);
    expect(session.ended).toBe(false);
    expect(errors).toEqual([]);
  });

  it("survives a failed transcription and handles the next turn", async () => {
    const ogg = await pcm48kToOgg(tonePcm(200));
    let asrCalls = 0;
    const errors: unknown[] = [];
    const session = new VoiceCallSession({
      asr: async () => {
        asrCalls++;
        if (asrCalls === 1) throw new Error("asr down");
        return "第二句";
      },
      reply: async () => "在。",
      speak: async () => ({ ogg, seconds: 0.2 }),
      sendFrame: async () => {},
      onError: (error) => errors.push(error),
      detectorOptions: { speechFrames: 2, silenceMs: 100, preRollMs: 40 },
    });

    feed(session);
    await session.whenIdle();
    feed(session);
    await session.whenIdle();

    expect(errors).toHaveLength(1);
    expect(session.turns.map((turn) => turn.text)).toEqual(["第二句", "在。"]);
    expect(session.ended).toBe(false);
  });
});
