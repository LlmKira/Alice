/**
 * 真的在 Telegram 上打一对一电话：MTProto 只负责信令（谁打给谁、DH 交换、SDP/ICE 数据），
 * 声音由 ntgcalls 的 WebRTC 通道收发。这个文件是外壳层：读更新、发 RPC、把两边接上，不放判断。
 *
 * ntgcalls 3.0.7 的两处坑（都在这里吸收掉，原生调用处不要绕过）：
 * - 它的 .d.ts 写的字节参数是 Buffer，原生绑定实际只收普通数字数组（传 Buffer 会抛 "An array was expected"）。
 * - 主动打出去时 initExchange 的 gaHash 要传 null（不传空 Buffer 或空数组）：传 null 返回 SHA-256(gA)，
 *   正好就是 phone.requestCall 要的 gAHash；传了空值会被当成"已提供 gAHash"，之后 exchangeKeys 要指纹就报错。
 *   这里按返回长度兜底：32 字节当作已经是 gAHash，其余长度（老版本返回 gA）再做一次 SHA-256。
 */
import { createHash, randomInt } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { TelegramClient, tl } from "@mtcute/node";
import type {
  AudioDescription,
  AuthParams,
  DhConfig,
  Frame,
  FrameData,
  MediaDescription,
  Protocol as NtgProtocol,
  RTCServer,
} from "ntgcalls";
import { MediaSource, NTgCalls, StreamDevice, StreamMode, VideoRotation } from "ntgcalls";

/** 通话音频：48 kHz、16 位、单声道，和 Telegram 的 P2P 语音一致。 */
export const CALL_SAMPLE_RATE = 48_000;
const SAMPLE_BYTES = 2;
/** 一帧 20 ms = 960 个采样 = 1920 字节。 */
const DEFAULT_FRAME_MS = 20;

export type LongLike = bigint | number | string | { toString(): string };
export type DiscardReason =
  | "phoneCallDiscardReasonHangup"
  | "phoneCallDiscardReasonBusy"
  | "phoneCallDiscardReasonMissed"
  | "phoneCallDiscardReasonDisconnect"
  | (string & {});

/** 发 RPC 的最小形状：`{ _: "phone.requestCall", ... }`。 */
export interface PhoneCallRpc {
  _: string;
  [key: string]: unknown;
}

export interface InputUserRef {
  userId: number;
  accessHash: LongLike;
}

/** 信令客户端：mtcute 的 TelegramClient 由 createMtcuteCallClient 包一层即可。 */
export interface PhoneCallSignalingClient {
  call(request: PhoneCallRpc): Promise<Record<string, unknown>>;
  /** 用户 id → inputUser（带 accessHash），phone.requestCall 要用。 */
  resolveUser(userId: number): Promise<InputUserRef>;
}

/** 包一层 mtcute 的 TelegramClient：原始 RPC 直接透传，用户引用按 id 解析。 */
export function createMtcuteCallClient(client: TelegramClient): PhoneCallSignalingClient {
  return {
    async call(request) {
      // mtcute 的方法表里还没有 phone.*（写 Schema 时不支持通话），运行时缺构造器会明确抛错；
      // 类型上仍按 RpcMethod 传，等它补上就能直接用。
      return (await client.call(request as unknown as tl.RpcMethod)) as Record<string, unknown>;
    },
    async resolveUser(userId) {
      // inputUser 带 accessHash；inputUserSelf 之类的没有，按 0 占位（正常路径拿不到这种）。
      const input = (await client.resolveUser(userId)) as {
        userId?: number;
        accessHash?: unknown;
      };
      return {
        userId: input.userId ?? userId,
        accessHash: (input.accessHash ?? 0n) as LongLike,
      };
    },
  };
}

export interface PhoneCallProtocolRef {
  _: "phoneCallProtocol";
  udpP2p?: boolean;
  udpReflector?: boolean;
  minLayer: number;
  maxLayer: number;
  libraryVersions: string[];
}

export interface PhoneCallCustomParameters {
  _: string;
  data: string;
}

export interface PhoneConnectionRef {
  _: "phoneConnection" | "phoneConnectionWebrtc";
  id: LongLike;
  ip?: string;
  ipv4?: string;
  ipv6?: string;
  port: number;
  peerTag?: Uint8Array;
  turn?: boolean;
  stun?: boolean;
  tcp?: boolean;
  username?: string;
  password?: string;
}

export interface PhoneCallRequestedUpdate {
  _: "phoneCallRequested";
  id: LongLike;
  accessHash: LongLike;
  /** 发起人（来电时就是对方）。 */
  adminId: number;
  participantId: number;
  gAHash: Uint8Array;
  protocol?: PhoneCallProtocolRef;
  video?: boolean;
}

export interface PhoneCallAcceptedUpdate {
  _: "phoneCallAccepted";
  id: LongLike;
  accessHash: LongLike;
  adminId: number;
  participantId: number;
  gB: Uint8Array;
  protocol?: PhoneCallProtocolRef;
  video?: boolean;
}

export interface PhoneCallConnectedUpdate {
  _: "phoneCall";
  id: LongLike;
  accessHash: LongLike;
  gAOrB: Uint8Array;
  keyFingerprint: LongLike;
  connections: PhoneConnectionRef[];
  p2pAllowed?: boolean;
  customParameters?: PhoneCallCustomParameters | string | null;
  protocol?: PhoneCallProtocolRef;
  video?: boolean;
}

export interface PhoneCallDiscardedUpdate {
  _: "phoneCallDiscarded";
  id: LongLike;
  accessHash?: LongLike;
  reason?: { _: string } | null;
  duration?: number;
  video?: boolean;
}

export interface PhoneCallSignalingUpdate {
  phoneCallId: LongLike;
  data: Uint8Array;
}

export type PhoneCallUpdate =
  | PhoneCallRequestedUpdate
  | PhoneCallAcceptedUpdate
  | PhoneCallConnectedUpdate
  | PhoneCallDiscardedUpdate
  | { _: "phoneCallWaiting" | "phoneCallEmpty"; id?: LongLike; [key: string]: unknown };

/** 只列这个文件真正用到的 ntgcalls 方法：测试可以注入假的传输层。 */
export interface CallTransport {
  createP2pCall(userId: bigint): Promise<void>;
  setStreamSources(userId: bigint, mode: StreamMode, media: MediaDescription): Promise<void>;
  /** 发出去时 gaHash 传 null：返回 SHA-256(gA)；来电时传对方给的 gAHash，返回 gB。 */
  initExchange(userId: bigint, dhConfig: DhConfig, gaHash: Buffer | null): Promise<Buffer>;
  exchangeKeys(userId: bigint, gAOrB: Buffer, fingerprint: bigint): Promise<AuthParams>;
  connectP2p(
    userId: bigint,
    servers: RTCServer[],
    versions: string[],
    p2pAllowed: boolean,
    customParameters: string,
  ): Promise<void>;
  stop(userId: bigint): Promise<void>;
  sendSignalingData(userId: bigint, data: Buffer): Promise<void>;
  sendExternalFrame(
    userId: bigint,
    device: StreamDevice,
    data: Buffer,
    frameData: FrameData,
  ): Promise<void>;
  onSignalingData(callback: (userId: bigint, data: Buffer) => void): void;
  onFrames(
    callback: (userId: bigint, mode: StreamMode, device: StreamDevice, frames: Frame[]) => void,
  ): void;
}

export interface PhoneCallsOptions {
  client: PhoneCallSignalingClient;
  transport?: CallTransport;
  /** 来电放不放行；不给就都接。返回 false 时按忙拒接。 */
  allowUser?: (userId: number) => boolean | Promise<boolean>;
  /** 一帧多少毫秒（默认 20）。 */
  frameMs?: number;
  onIncomingCall?: (call: { userId: number; video: boolean }) => void;
  /** 对方的声音：48 kHz、16 位、单声道 PCM。 */
  onAudio?: (userId: number, pcm48kMono: Buffer) => void;
  onConnected?: (userId: number) => void;
  onClosed?: (userId: number, reason: string) => void;
  onError?: (error: unknown) => void;
  log?: (line: string) => void;
}

export interface SendAudioOptions {
  /** 中途打断（对方开口、挂断）时中止。 */
  signal?: AbortSignal;
  /** false 时一次性发完不按 20 ms 节流（只有测试会用）。 */
  paced?: boolean;
}

interface ActiveCall {
  userId: bigint;
  peer: { id: LongLike; accessHash: LongLike } | null;
  startedAt: number;
  protocol: PhoneCallProtocolRef;
  connected: boolean;
  /** connectP2p 之前的信令先存着，连上后补发。 */
  signaling: Buffer[];
}

const SAMPLE_BYTES_PER_MS = (CALL_SAMPLE_RATE * SAMPLE_BYTES) / 1000;

/** 原生绑定只收普通数组，这里统一转一次。 */
function nativeBytes(bytes: Uint8Array): Buffer {
  return Array.from(bytes) as unknown as Buffer;
}

function bufferOf(bytes: Uint8Array | readonly number[]): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes as Uint8Array);
}

/** Long、bigint、数字、字符串都收。 */
export function bigintOf(value: LongLike): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  return BigInt(String(value));
}

function callKey(id: LongLike): string {
  return String(id);
}

function inputPhoneCall(peer: { id: LongLike; accessHash: LongLike }): PhoneCallRpc {
  return { _: "inputPhoneCall", id: peer.id, accessHash: peer.accessHash };
}

function ntgDhConfig(dh: { g: number; p: Buffer; random: Buffer }): DhConfig {
  return { g: dh.g, p: nativeBytes(dh.p), random: nativeBytes(dh.random) };
}

/** ntgcalls 的协议参数 → Telegram 的 phoneCallProtocol。 */
export function phoneCallProtocol(
  protocol: NtgProtocol = NTgCalls.getProtocol(),
): PhoneCallProtocolRef {
  return {
    _: "phoneCallProtocol",
    udpP2p: protocol.udpP2p,
    udpReflector: protocol.udpReflector,
    minLayer: protocol.minLayer,
    maxLayer: protocol.maxLayer,
    libraryVersions: [...protocol.libraryVersions],
  };
}

/** phoneConnection / phoneConnectionWebrtc → ntgcalls 的 RTCServer。 */
export function rtcServers(connections: readonly PhoneConnectionRef[]): RTCServer[] {
  return connections.map((connection) => {
    const server: RTCServer = {
      id: bigintOf(connection.id),
      ipv4: connection.ipv4 ?? connection.ip ?? "",
      ipv6: connection.ipv6 ?? "",
      port: connection.port,
      turn: connection.turn === true,
      stun: connection.stun === true,
      tcp: connection.tcp === true,
    };
    if (connection.peerTag) server.peerTag = nativeBytes(bufferOf(connection.peerTag));
    if (connection.username !== undefined) server.username = connection.username;
    if (connection.password !== undefined) server.password = connection.password;
    return server;
  });
}

/** PhoneCall.customParameters（dataJSON）→ connectP2p 要的 JSON 字符串；没有或坏了给 {}。 */
export function customParametersJson(
  custom: PhoneCallCustomParameters | string | null | undefined,
): string {
  const raw = typeof custom === "string" ? custom : (custom?.data ?? "");
  if (!raw.trim()) return "{}";
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    return "{}";
  }
}

/**
 * 管所有 P2P 通话：来电/去电的 DH 状态机、信令双向转发、把 PCM 塞进通话、挂断。
 * 上层把 mtcute 的 updatePhoneCall / updatePhoneCallSignalingData 交给 handleUpdate /
 * handleSignalingData，把对方声音接到 onAudio，把自己的 PCM 交给 sendAudioFrames。
 */
export class TelegramPhoneCalls {
  private readonly client: PhoneCallSignalingClient;
  private readonly transport: CallTransport;
  private readonly allowUser?: (userId: number) => boolean | Promise<boolean>;
  private readonly frameMs: number;
  private readonly options: PhoneCallsOptions;
  private readonly byPeer = new Map<string, ActiveCall>();
  private readonly byCallId = new Map<string, ActiveCall>();
  private dhVersion = 0;
  private dhPrime: { g: number; p: Buffer } | null = null;
  private closed = false;

  constructor(options: PhoneCallsOptions) {
    this.options = options;
    this.client = options.client;
    // 原生绑定的字节参数要数字数组、gaHash 要 null，和 .d.ts 不完全一致，所以这里断言一次。
    this.transport = options.transport ?? (new NTgCalls() as unknown as CallTransport);
    this.allowUser = options.allowUser;
    this.frameMs = options.frameMs ?? DEFAULT_FRAME_MS;
    this.transport.onSignalingData((userId, data) => this.relaySignaling(userId, data));
    this.transport.onFrames((userId, mode, _device, frames) =>
      this.receiveFrames(userId, mode, frames),
    );
  }

  /** 正在通话的用户 id。 */
  get active(): number[] {
    return [...this.byPeer.values()].map((call) => Number(call.userId));
  }

  /** 本地主动打给某人。 */
  async placeCall(userId: number): Promise<void> {
    if (this.closed) throw new Error("phone calls disposed");
    if (this.byPeer.has(String(BigInt(userId)))) {
      throw new Error(`phone call already active: ${userId}`);
    }
    const call: ActiveCall = {
      userId: BigInt(userId),
      peer: null,
      startedAt: Date.now(),
      protocol: phoneCallProtocol(),
      connected: false,
      signaling: [],
    };
    this.byPeer.set(String(call.userId), call);
    try {
      const inputUser = await this.client.resolveUser(userId);
      const dh = await this.dhConfig();
      await this.transport.createP2pCall(call.userId);
      await this.configureStreams(call.userId);
      const init = bufferOf(await this.transport.initExchange(call.userId, ntgDhConfig(dh), null));
      const gAHash = init.length === 32 ? init : createHash("sha256").update(init).digest();
      const reply = await this.client.call({
        _: "phone.requestCall",
        userId: {
          _: "inputUser",
          userId: inputUser.userId,
          accessHash: inputUser.accessHash,
        },
        randomId: randomInt(1, 2 ** 31 - 1),
        gAHash,
        protocol: call.protocol,
      });
      this.bind(call, reply);
    } catch (error) {
      const peer = call.peer;
      this.forget(call);
      await this.stopTransport(call.userId, true);
      if (peer) await this.discard(peer.id, peer.accessHash, "phoneCallDiscardReasonHangup");
      throw error;
    }
  }

  /** 处理一条 updatePhoneCall 里的通话对象。 */
  async handleUpdate(update: PhoneCallUpdate): Promise<void> {
    if (this.closed) return;
    try {
      switch (update._) {
        case "phoneCallRequested":
          await this.onRequested(update);
          return;
        case "phoneCallAccepted":
          await this.onAccepted(update);
          return;
        case "phoneCall":
          await this.onConnected(update);
          return;
        case "phoneCallDiscarded":
          await this.onDiscarded(update);
          return;
        default:
          return;
      }
    } catch (error) {
      this.fail(error);
    }
  }

  /** 处理 updatePhoneCallSignalingData：对方（Telegram）发来的 WebRTC 信令。 */
  async handleSignalingData(update: PhoneCallSignalingUpdate): Promise<void> {
    const call = this.byCallId.get(callKey(update.phoneCallId));
    if (!call || this.closed) return;
    const data = bufferOf(update.data);
    if (!call.connected) {
      call.signaling.push(data);
      return;
    }
    try {
      await this.transport.sendSignalingData(call.userId, nativeBytes(data));
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * 把 48 kHz 单声道 PCM 按 20 ms 一帧送进通话，按实时速度节流。
   * 中途 signal 中止（对方插话）就立刻停，不把剩下的放完。
   */
  async sendAudioFrames(
    userId: number,
    pcm48kMono: Buffer,
    options: SendAudioOptions = {},
  ): Promise<void> {
    const call = this.byPeer.get(String(BigInt(userId)));
    if (!call) throw new Error(`no active phone call: ${userId}`);
    const signal = options.signal;
    const frameBytes = Math.max(2, Math.round(SAMPLE_BYTES_PER_MS * this.frameMs));
    const started = Date.now();
    let offset = 0;
    let sent = 0;
    while (offset < pcm48kMono.length) {
      signal?.throwIfAborted();
      const chunk = pcm48kMono.subarray(offset, offset + frameBytes);
      const frame =
        chunk.length === frameBytes
          ? chunk
          : Buffer.concat([chunk, Buffer.alloc(frameBytes - chunk.length)]);
      await this.transport.sendExternalFrame(
        call.userId,
        StreamDevice.MICROPHONE,
        nativeBytes(frame),
        {
          absoluteCaptureTimestampMs: BigInt(Date.now()),
          rotation: VideoRotation.VIDEO_ROTATION_0,
          width: 0,
          height: 0,
        },
      );
      offset += frameBytes;
      sent++;
      if (options.paced === false || this.frameMs <= 0) continue;
      const wait = started + sent * this.frameMs - Date.now();
      if (wait > 0) await sleep(wait, undefined, { signal: signal ?? undefined });
    }
  }

  /** 挂断或拒接。 */
  async hangup(
    userId: number,
    reason: DiscardReason = "phoneCallDiscardReasonHangup",
  ): Promise<void> {
    const call = this.byPeer.get(String(BigInt(userId)));
    if (!call) return;
    this.forget(call);
    if (call.peer) {
      try {
        await this.client.call({
          _: "phone.discardCall",
          peer: inputPhoneCall(call.peer),
          duration: Math.max(0, Math.round((Date.now() - call.startedAt) / 1000)),
          reason: { _: reason },
          connectionId: 0n,
        });
      } catch (error) {
        this.fail(error);
      }
    }
    await this.stopTransport(call.userId, true);
    this.options.onClosed?.(userId, reason);
  }

  /** 停机：挂掉所有通话，释放原生资源。 */
  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const calls = [...this.byPeer.values()];
    this.byPeer.clear();
    this.byCallId.clear();
    await Promise.all(
      calls.map(async (call) => {
        if (call.peer) {
          try {
            await this.client.call({
              _: "phone.discardCall",
              peer: inputPhoneCall(call.peer),
              duration: Math.max(0, Math.round((Date.now() - call.startedAt) / 1000)),
              reason: { _: "phoneCallDiscardReasonHangup" },
              connectionId: 0n,
            });
          } catch {
            // 停机时 Telegram 多半已经在断，忽略。
          }
        }
        await this.stopTransport(call.userId, true);
      }),
    );
  }

  private async onRequested(update: PhoneCallRequestedUpdate): Promise<void> {
    const userId = BigInt(update.adminId);
    const allowed = (await this.allowUser?.(update.adminId)) ?? true;
    if (!allowed) {
      await this.discard(update.id, update.accessHash, "phoneCallDiscardReasonBusy");
      return;
    }
    if (this.byPeer.has(String(userId))) {
      await this.discard(update.id, update.accessHash, "phoneCallDiscardReasonBusy");
      return;
    }
    const call: ActiveCall = {
      userId,
      peer: { id: update.id, accessHash: update.accessHash },
      startedAt: Date.now(),
      protocol: update.protocol ?? phoneCallProtocol(),
      connected: false,
      signaling: [],
    };
    this.register(call);
    try {
      const dh = await this.dhConfig();
      await this.transport.createP2pCall(userId);
      await this.configureStreams(userId);
      const gB = bufferOf(
        await this.transport.initExchange(
          userId,
          ntgDhConfig(dh),
          nativeBytes(bufferOf(update.gAHash)),
        ),
      );
      await this.client.call({
        _: "phone.acceptCall",
        peer: inputPhoneCall(call.peer ?? { id: update.id, accessHash: update.accessHash }),
        gB,
        protocol: call.protocol,
      });
      this.options.onIncomingCall?.({ userId: update.adminId, video: update.video === true });
    } catch (error) {
      this.forget(call);
      await this.stopTransport(userId, true);
      await this.discard(update.id, update.accessHash, "phoneCallDiscardReasonHangup");
      throw error;
    }
  }

  private async onAccepted(update: PhoneCallAcceptedUpdate): Promise<void> {
    const call = this.byCallId.get(callKey(update.id));
    if (!call) return;
    const gB = bufferOf(update.gB);
    const auth = await this.transport.exchangeKeys(call.userId, nativeBytes(gB), 0n);
    call.peer = { id: update.id, accessHash: update.accessHash };
    this.byCallId.set(callKey(update.id), call);
    await this.client.call({
      _: "phone.confirmCall",
      peer: inputPhoneCall(call.peer),
      gA: bufferOf(auth.gAOrB),
      keyFingerprint: auth.keyFingerprint,
      protocol: update.protocol ?? call.protocol,
    });
  }

  private async onConnected(update: PhoneCallConnectedUpdate): Promise<void> {
    const call = this.byCallId.get(callKey(update.id));
    if (!call || call.connected) return;
    call.connected = true;
    try {
      const key = bufferOf(update.gAOrB);
      await this.transport.exchangeKeys(
        call.userId,
        nativeBytes(key),
        bigintOf(update.keyFingerprint),
      );
      const protocol = update.protocol ?? call.protocol;
      const versions = protocol.libraryVersions.length
        ? [...protocol.libraryVersions]
        : [...call.protocol.libraryVersions];
      await this.transport.connectP2p(
        call.userId,
        rtcServers(update.connections ?? []),
        versions,
        update.p2pAllowed !== false,
        customParametersJson(update.customParameters),
      );
      const queued = call.signaling;
      call.signaling = [];
      for (const data of queued) {
        await this.transport.sendSignalingData(call.userId, nativeBytes(data));
      }
      this.options.onConnected?.(Number(call.userId));
    } catch (error) {
      call.connected = false;
      this.forget(call);
      await this.stopTransport(call.userId, true);
      await this.discard(update.id, update.accessHash, "phoneCallDiscardReasonDisconnect");
      this.options.onClosed?.(Number(call.userId), "phoneCallDiscardReasonDisconnect");
      throw error;
    }
  }

  private async onDiscarded(update: PhoneCallDiscardedUpdate): Promise<void> {
    const call = this.byCallId.get(callKey(update.id));
    if (!call) return;
    this.forget(call);
    await this.stopTransport(call.userId, true);
    const reason = update.reason?._ ?? "phoneCallDiscardReasonHangup";
    this.options.onClosed?.(Number(call.userId), reason);
  }

  private async discard(id: LongLike, accessHash: LongLike, reason: DiscardReason): Promise<void> {
    try {
      await this.client.call({
        _: "phone.discardCall",
        peer: inputPhoneCall({ id, accessHash }),
        duration: 0,
        reason: { _: reason },
        connectionId: 0n,
      });
    } catch (error) {
      this.fail(error);
    }
  }

  /** 取一次 DH 参数（每次通话都要新的 random）。 */
  private async dhConfig(): Promise<{ g: number; p: Buffer; random: Buffer; version: number }> {
    const reply = await this.client.call({
      _: "messages.getDhConfig",
      version: this.dhVersion,
      randomLength: 256,
    });
    const version = Number(reply.version ?? this.dhVersion);
    if (Number.isFinite(version)) this.dhVersion = version;
    // 版本没变时 Telegram 只回 random（messages.dhConfigNotModified）：复用上次的素数和 g。
    if (reply.p) {
      this.dhPrime = { g: Number(reply.g ?? 3), p: bufferOf(reply.p as Uint8Array) };
    }
    if (!this.dhPrime) throw new Error("getDhConfig: no prime");
    return {
      g: this.dhPrime.g,
      p: this.dhPrime.p,
      random: bufferOf(reply.random as Uint8Array),
      version: this.dhVersion,
    };
  }

  /** 双向都用 EXTERNAL：声音由上层塞 PCM，不打开麦克风设备。 */
  private async configureStreams(userId: bigint): Promise<void> {
    const audio: AudioDescription = {
      mediaSource: MediaSource.EXTERNAL,
      sampleRate: CALL_SAMPLE_RATE,
      channelCount: 1,
      input: "",
      keepOpen: true,
    };
    await this.transport.setStreamSources(userId, StreamMode.CAPTURE, { microphone: audio });
    await this.transport.setStreamSources(userId, StreamMode.PLAYBACK, { speaker: audio });
  }

  private bind(call: ActiveCall, reply: Record<string, unknown>): void {
    const id = reply.id as LongLike | undefined;
    const accessHash = reply.accessHash as LongLike | undefined;
    if (id === undefined || accessHash === undefined) return;
    call.peer = { id, accessHash };
    this.byCallId.set(callKey(id), call);
  }

  private register(call: ActiveCall): void {
    this.byPeer.set(String(call.userId), call);
    if (call.peer) this.byCallId.set(callKey(call.peer.id), call);
  }

  private forget(call: ActiveCall): void {
    this.byPeer.delete(String(call.userId));
    if (call.peer) this.byCallId.delete(callKey(call.peer.id));
  }

  private async stopTransport(userId: bigint, quiet: boolean): Promise<void> {
    try {
      await this.transport.stop(userId);
    } catch (error) {
      if (!quiet) this.fail(error);
    }
  }

  /** ntgcalls 要发的 WebRTC 信令 → phone.sendSignalingData。 */
  private relaySignaling(userId: bigint, data: Buffer): void {
    const call = this.byPeer.get(String(userId));
    if (!call?.peer || this.closed) return;
    void this.client
      .call({
        _: "phone.sendSignalingData",
        peer: inputPhoneCall(call.peer),
        data: bufferOf(data),
      })
      .catch((error) => {
        // 停机时在途的信令失败没必要再报。
        if (error instanceof Error && error.name === "AbortError") return;
        this.fail(error);
      });
  }

  /** 只收 PLAYBACK（对方的声音）；CAPTURE 是我们自己送出去的。 */
  private receiveFrames(userId: bigint, mode: StreamMode, frames: Frame[]): void {
    if (mode !== StreamMode.PLAYBACK || this.closed) return;
    if (!this.byPeer.has(String(userId))) return;
    for (const frame of frames) {
      // 原生回调里不能把异常抛回去。
      try {
        this.options.onAudio?.(Number(userId), bufferOf(frame.data));
      } catch (error) {
        this.fail(error);
      }
    }
  }

  private fail(error: unknown): void {
    this.options.log?.(`phone call: ${error instanceof Error ? error.message : String(error)}`);
    this.options.onError?.(error);
  }
}
