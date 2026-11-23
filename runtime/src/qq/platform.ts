/**
 * QQ 平台（实现 src/platform.ts 的接口），通过 OneBot v11 正向 WebSocket 连接 NapCat、Lagrange 等实现。
 * 入站适配在 world-adapter.ts，动作在 acts.ts，限额在 gates.ts，群资料在 rooms.ts。
 * 贴纸库（sticker-palette.ts）和相册（album.ts）与 Telegram 共用同一套做法，各平台一份。
 * QQ 上没有语音通话、找群、转发：这些动作抛 Failed unavailable。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Album, albumSearchText } from "../album.js";
import type { PlatformConfig } from "../config.js";
import type { Gateway } from "../llm/gateway.js";
import type { QueryKind } from "../llm/ptc.js";
import { rerank } from "../llm/rerank.js";
import { synthesizeSpeech, type TtsConfig } from "../llm/tts.js";
import type { Act, PlatformActKind, PlatformCapabilities } from "../mind/affordances.js";
import type { AliceEvent, ChatDescribed } from "../mind/events.js";
import { Failed } from "../mind/failure.js";
import type { ActOutcome } from "../mind/outcome.js";
import type { AliceState } from "../mind/state.js";
import { whenRunning } from "../ops/gate.js";
import { type Platform, type PlatformHost, type QueryResult, selftestReport } from "../platform.js";
import {
  knownSticker,
  listStickerHints,
  paletteSize,
  resolveStickerFileId,
} from "../sticker-palette.js";
import { executeQQAct } from "./acts.js";
import { type Connect, OneBotClient } from "./client.js";
import { QQ, QQGates } from "./gates.js";
import { Rooms } from "./rooms.js";
import {
  createQQWorldAdapter,
  groupScope,
  privateScope,
  type QQSticker,
  stickerKeyOf,
} from "./world-adapter.js";

type QQConfig = Extract<PlatformConfig, { name: "qq" }>;

export interface QQPlatformDeps {
  gateway: Gateway;
  /** 操作员的 QQ 号（QQ_OPERATOR_ID）；为 null 时不经 QQ 发通知，也不做 QQ 自检。 */
  operatorId: string | null;
  ignoredSenders: ReadonlySet<string>;
  tts: TtsConfig | null;
  /** 打开 WebSocket（默认用 Node 自带的；测试里换成假的）。 */
  connect?: Connect;
  /** 下载图片（默认 fetch）。 */
  download?: (url: string, signal: AbortSignal) => Promise<Uint8Array>;
  /** start 等待连上的最长时间（默认 STARTUP_GRACE_MS；测试里调短）。 */
  startupGraceMs?: number;
  /** 状态目录：配置后把看过的 QQ 表情包字节缓存在 stateDir/qq-stickers/，防止腾讯图片链接过期后发不出去。 */
  stateDir?: string;
}

/** start 最多等这么久来连上 OneBot、拿到她的账号；超时就先返回，连接在后台继续重试，不拖住别的平台。 */
const STARTUP_GRACE_MS = 2_000;
/** 入站适配器就绪之前，最多缓存这么多个事件。 */
const EARLY_KEPT = 1_000;
/** 已连上但取不到登录信息时，隔多久重试。 */
const LOGIN_RETRY_MS = 5_000;
/** 去重时记住的最近消息条数。 */
const SEEN_KEPT = 5_000;
/** 启动时向 OneBot 要多少个收藏表情。 */
const FAVORITES_ASKED = 30;
/** 每次启动最多看这么多个还没看过的收藏表情（每个要调一次看图模型）。 */
const FAVORITES_LOOKED = 10;

/** 收到过的消息（会话 + 编号），先进先出，最多 SEEN_KEPT 条。 */
class SeenMessages {
  private readonly keys = new Set<string>();

  /** 记下一条；之前已经记过就返回 false。 */
  add(scope: string, messageId: string): boolean {
    const key = `${scope}#${messageId}`;
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    if (this.keys.size > SEEN_KEPT) {
      const oldest = this.keys.values().next().value;
      if (oldest !== undefined) this.keys.delete(oldest);
    }
    return true;
  }
}

/** 下载图片/语音的超时和体积上限，避免超大或挂起的远端链接拖住感知。 */
const DOWNLOAD_TIMEOUT_MS = 15_000;
const DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024;
const LOCAL_STICKER_PREFIX = "local:";

function safeStickerFileName(key: string): string {
  return `${key.replace(/[^\w.-]/g, "_").slice(0, 96)}.bin`;
}

async function fetchBytes(url: string, signal: AbortSignal): Promise<Uint8Array> {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]);
  const response = await fetch(url, { signal: combined });
  if (!response.ok) throw new Error(`download failed: ${response.status}`);
  const len = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > DOWNLOAD_MAX_BYTES) {
    throw new Error(`download too large: ${len} bytes`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > DOWNLOAD_MAX_BYTES) {
    throw new Error(`download too large: ${bytes.byteLength} bytes`);
  }
  return bytes;
}

interface MemberInfo {
  user_id?: number;
  nickname?: string;
  card?: string;
  role?: string;
  title?: string;
  shut_up_timestamp?: number;
}

export class QQPlatform implements Platform {
  readonly name = "qq" as const;
  readonly prefix = "qq:";
  /**
   * QQ 目前实现的对外动作：能撤回（unsend），不能改消息（edit）；贴表情（react）只在群聊可用；
   * 语音只在配了 TTS 时开放。贴纸发的是 QQ 贴纸库里看过的表情包，相册是她在 QQ 群里见过的图。
   */
  readonly capabilities: PlatformCapabilities;
  private readonly gates = new QQGates();
  private readonly album: Album;
  /** 收藏表情每次启动只看一轮（重连不再看）。 */
  private favoritesLooked = false;
  private readonly rooms = new Rooms();
  /** 每个 QQ 会话里最近一条消息的编号（标已读时传给 OneBot）。 */
  private readonly lastMessageId = new Map<string, number>();
  /** 已知 QQ 好友集合（首次私聊前经 get_friend_list 拉取；null 表示尚未拉取或平台不支持）。 */
  private friends: Set<string> | null = null;
  private friendsLoaded = false;
  /** 某 QQ 用户最近一次出现的同在 QQ 群号（非好友时优先尝试群临时私聊）。 */
  private readonly sharedGroup = new Map<string, number>();
  /** 已经实测拒绝临时私聊的 QQ 群号，避免同群反复撞风控。 */
  private readonly tempBlockedGroups = new Set<number>();
  /** 收到过的消息：重连后 OneBot 再推一次的同一条消息，不再进时间线。 */
  private readonly seen = new SeenMessages();
  private client: OneBotClient | null = null;
  private qq: QQ | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly config: QQConfig,
    private readonly deps: QQPlatformDeps,
  ) {
    const acts = new Set<PlatformActKind>([
      "send",
      "react",
      "mark-read",
      "leave-chat",
      "repeat",
      "unsend",
      "sticker",
      "album-search",
      "album-send",
    ]);
    if (deps.tts) acts.add("voice");
    this.capabilities = { acts, onlyIn: { react: "group" } };
    this.album = new Album((query, documents, top) => rerank(deps.gateway, query, documents, top));
  }

  observe(event: AliceEvent, _state: AliceState, phase: "fold" | "live"): void {
    this.rooms.observe(event);
    this.album.observe(event);
    if (event.type === "message.received") {
      this.seen.add(event.scope, event.messageId);
      if (event.chatType === "group" && event.scope.startsWith("qq:group:")) {
        const gid = Number(event.scope.slice("qq:group:".length));
        if (Number.isSafeInteger(gid)) this.sharedGroup.set(event.senderId, gid);
      } else if (event.chatType === "private" && event.scope.startsWith("qq:private:")) {
        this.friends?.add(event.senderId);
      }
    }
    if (event.type === "message.received" || event.type === "message.sent") {
      const id = Number(event.messageId);
      if (Number.isSafeInteger(id)) this.lastMessageId.set(event.scope, id);
    }
    // 连发计数只在启动 fold 时从历史恢复；运行中由 QQ.post 自己计数。
    if (phase === "fold") this.gates.observe(event);
  }

  startupInfo(): Record<string, unknown> {
    return {
      onebot: new URL(this.config.wsUrl).host,
      stickers: paletteSize("qq"),
      albumPhotos: this.album.size,
    };
  }

  async start(host: PlatformHost): Promise<{ selfId: string; selfName?: string }> {
    // 入站适配器要先知道她的账号才能就绪；就绪前到的事件先缓存，就绪后按顺序处理；缓存满了丢掉最早的。
    let handle: ((raw: unknown) => void) | null = null;
    const early: unknown[] = [];
    let binding = false;
    let resolveBound: (info: { selfId: string; selfName?: string }) => void = () => {};
    const bound = new Promise<{ selfId: string; selfName?: string }>((resolve) => {
      resolveBound = resolve;
    });
    const client = new OneBotClient({
      url: this.config.wsUrl,
      token: this.config.token,
      connect: this.deps.connect,
      onEvent: (event) => {
        if (handle) {
          handle(event);
          return;
        }
        early.push(event);
        if (early.length > EARLY_KEPT) early.shift();
      },
      onState: (state) => {
        host.connection(state);
        if (state === "connected") void bind();
      },
      warn: host.warn,
    });
    // 每次连上都尝试让适配器就绪，直到成功；取不到登录信息就隔一会儿重试（前提是还连着）。
    const bind = async (): Promise<void> => {
      if (handle || binding || host.signal.aborted) return;
      binding = true;
      try {
        const adapter = await this.attach(client, host);
        handle = adapter.handle;
        for (const event of early.splice(0)) adapter.handle(event);
        resolveBound({
          selfId: adapter.selfId,
          ...(adapter.selfName ? { selfName: adapter.selfName } : {}),
        });
      } catch (error) {
        if (host.signal.aborted) return;
        host.warn("QQ login info unavailable; retrying", error);
        this.retryTimer = setTimeout(() => {
          if (client.connected) void bind();
        }, LOGIN_RETRY_MS);
        this.retryTimer.unref?.();
      } finally {
        binding = false;
      }
    };
    this.client = client;
    host.signal.addEventListener("abort", () => void client.close(), { once: true });
    client.start();
    // 别让连不上的 QQ 拖住别的平台和运行时：只等一小会儿，超时就先返回，连接在后台继续重试。
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<null>((resolve) => {
      timer = setTimeout(resolve, this.deps.startupGraceMs ?? STARTUP_GRACE_MS, null);
    });
    const info = await Promise.race([bound, grace]);
    clearTimeout(timer);
    if (info !== null) return info;
    host.warn("QQ (OneBot) is not connected yet; reconnecting in the background");
    return { selfId: this.config.selfId ?? "pending" };
  }

  /** 连上之后：取得她的账号，创建入站适配器。 */
  private async attach(
    client: OneBotClient,
    host: PlatformHost,
  ): Promise<{ selfId: string; selfName?: string; handle: (raw: unknown) => void }> {
    const download = this.deps.download ?? fetchBytes;
    const login = await client
      .call<{ user_id?: number; nickname?: string }>("get_login_info", {}, host.signal)
      .catch((error: unknown): { user_id?: number; nickname?: string } => {
        // 配了 QQ_SELF_ID 时，取不到登录信息也能继续运行（只是不知道她的昵称）。
        if (this.config.selfId === null) throw error;
        return {};
      });
    const selfId = this.config.selfId ?? String(login.user_id ?? "");
    if (!/^\d+$/.test(selfId)) throw new Error("OneBot get_login_info returned no QQ number");
    const qq = new QQ(client, this.gates);
    this.qq = qq;
    const background = () => qq.with(host.signal);
    const stickerDir = this.deps.stateDir ? join(this.deps.stateDir, "qq-stickers") : null;
    const lookAtSticker = (sticker: QQSticker, url: string) => {
      const localName =
        stickerDir && sticker.fileUniqueId ? safeStickerFileName(sticker.fileUniqueId) : null;
      const storedFileId = localName ? `${LOCAL_STICKER_PREFIX}${localName}` : sticker.fileId;
      return host.perceive.sticker(
        { platform: "qq", ...sticker, ...(storedFileId ? { fileId: storedFileId } : {}) },
        async () => {
          const bytes = await download(url, host.signal);
          if (stickerDir && localName) {
            try {
              mkdirSync(stickerDir, { recursive: true });
              const path = join(stickerDir, localName);
              if (!existsSync(path)) writeFileSync(path, bytes);
            } catch (error) {
              host.warn("QQ sticker cache write failed", error);
            }
          }
          return bytes;
        },
      );
    };
    const handle = createQQWorldAdapter({
      selfId,
      selfName: login.nickname,
      ignoredSenders: this.deps.ignoredSenders,
      now: host.now,
      onEvent: (event) => {
        host.dispatch(event);
        if (
          event.type === "message.received" &&
          event.chatType === "group" &&
          this.rooms.due(event.scope, host.now())
        ) {
          void host.track(this.refreshRoom(background(), event.scope, selfId, host));
        }
      },
      // 暂停时连下载和转码也不做。
      perceive: {
        image: whenRunning(host.pause, async (url: string) =>
          host.perceive.image(await download(url, host.signal)),
        ),
        voice: whenRunning(host.pause, async (file: string) =>
          host.perceive.voice(await recordBytes(background(), file, download, host.signal)),
        ),
        sticker: lookAtSticker,
      },
      banChanged: (scope, until, at) => this.rooms.banChanged(scope, until, at),
      firstSeen: (scope, messageId) => this.seen.add(scope, messageId),
      warn: host.warn,
    });
    if (!this.favoritesLooked) {
      this.favoritesLooked = true;
      void host.track(lookAtFavorites(background(), lookAtSticker, host));
    }
    const selfName = login.nickname?.trim() || undefined;
    return { selfId, ...(selfName ? { selfName } : {}), handle };
  }

  private async ensureFriends(qq: QQ): Promise<void> {
    if (this.friendsLoaded) return;
    this.friendsLoaded = true;
    try {
      const list = await qq.request<Array<{ user_id?: number | string }>>("get_friend_list", {});
      if (!Array.isArray(list)) return;
      const next = new Set<string>();
      for (const item of list) {
        if (item?.user_id !== undefined) next.add(String(item.user_id));
      }
      this.friends = next;
    } catch {
      // OneBot 未实现或暂不可用时保持 null，回退到服务端报错分类。
    }
  }

  private async privateRouteOf(qq: QQ, userId: number) {
    await this.ensureFriends(qq);
    const id = String(userId);
    if (this.friends === null || this.friends.has(id)) return { kind: "direct" as const };
    const groupId = this.sharedGroup.get(id);
    if (groupId !== undefined && !this.tempBlockedGroups.has(groupId)) {
      return { kind: "temp" as const, groupId };
    }
    return { kind: "closed" as const };
  }

  async act(scope: string, act: Act, signal: AbortSignal): Promise<ActOutcome> {
    const { tts, gateway } = this.deps;
    const qq = this.connected().with(signal);
    return executeQQAct(
      {
        qq,
        scope,
        lastMessageId: this.lastMessageId.get(scope),
        privateRoute: (userId) => this.privateRouteOf(qq, userId),
        onTempPrivateRejected: (groupId) => {
          this.tempBlockedGroups.add(groupId);
        },
        speak: async (text) => {
          if (!tts) throw new Failed({ reason: "unavailable" });
          return synthesizeSpeech(tts, text, { signal, charge: gateway.charge });
        },
        // 模拟发文字前"正在输入"的那几秒；停机时立即停止等待。
        pause: async (ms) => sleep(ms, undefined, { signal }),
        stickerFileId: (word) => this.resolveStickerPayload(word),
        album: this.album,
        now: () => Date.now(),
      },
      act,
    );
  }

  async query(
    _scope: string,
    kind: Exclude<QueryKind, "delegate">,
    act: Act,
    _signal: AbortSignal,
  ): Promise<QueryResult> {
    if (kind === "album-search") {
      const q = act.kind === "album-search" ? act.query : "";
      const hits = await this.album.searchItems(q, Date.now(), this.prefix);
      return { value: hits, result: albumSearchText(q, hits) };
    }
    throw new Failed({ reason: "unavailable" }, `${kind} is not available on QQ`);
  }

  stickers(): readonly string[] {
    return listStickerHints(14, "qq");
  }

  /** 把 QQ 贴纸库里的 fileId 变成 OneBot 可直接发的字段：本地缓存的转成 base64://（永不过期），旧行 URL 原样返回。 */
  private resolveStickerPayload(word: string): string | null {
    const raw = resolveStickerFileId(word, "qq");
    if (raw === null) return null;
    if (!raw.startsWith(LOCAL_STICKER_PREFIX)) return raw;
    if (!this.deps.stateDir) return null;
    const path = join(this.deps.stateDir, "qq-stickers", raw.slice(LOCAL_STICKER_PREFIX.length));
    if (!existsSync(path)) return null;
    return `base64://${readFileSync(path).toString("base64")}`;
  }

  async sendToOperator(text: string): Promise<void> {
    const { operatorId } = this.deps;
    if (!this.qq || operatorId === null) return;
    await this.qq.request("send_private_msg", {
      user_id: Number(operatorId),
      message: [{ type: "text", data: { text } }],
    });
  }

  async selftest(): Promise<string> {
    const { operatorId } = this.deps;
    if (operatorId === null) return "未配置 QQ_OPERATOR_ID，跳过 QQ 自检。";
    if (!this.qq) return "还没连上 QQ。";
    const scope = privateScope(operatorId);
    return selftestReport((act) => this.act(scope, act, new AbortController().signal));
  }

  async stop(): Promise<void> {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    await this.client?.close();
  }

  private connected(): QQ {
    if (!this.qq) throw new Failed({ reason: "unavailable" }, "QQ is not connected");
    return this.qq;
  }

  /** 重新查询群资料（人数、管理员、她是否被禁言），有变化才写进 Journal。 */
  private async refreshRoom(
    qq: QQ,
    scope: string,
    selfId: string,
    host: PlatformHost,
  ): Promise<void> {
    const groupId = Number(scope.slice(groupScope("").length));
    try {
      const described = await describeRoom(qq, groupId, selfId, (facts) =>
        this.rooms.described(scope, facts, host.now()),
      );
      if (described) host.dispatch(described);
    } catch (error: unknown) {
      // 因停机而中止不算查询失败。
      if (!qq.signal.aborted) host.warn("Room description failed", error);
    }
  }
}

/** 可选的补充请求：失败时那一项留空、用 fallback；但因停机中止时仍然抛出。 */
async function optional<T>(signal: AbortSignal, request: Promise<T>, fallback: T): Promise<T> {
  try {
    return await request;
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    return fallback;
  }
}

async function describeRoom(
  qq: QQ,
  groupId: number,
  selfId: string,
  describe: (
    facts: Pick<ChatDescribed, "members" | "admins"> & { bannedUntil: number | null },
  ) => ChatDescribed | null,
): Promise<ChatDescribed | null> {
  const info = await qq.request<{ member_count?: number }>("get_group_info", { group_id: groupId });
  const members = await optional<MemberInfo[]>(
    qq.signal,
    qq.request("get_group_member_list", { group_id: groupId }),
    [],
  );
  const me = await optional<MemberInfo | null>(
    qq.signal,
    qq.request("get_group_member_info", {
      group_id: groupId,
      user_id: Number(selfId),
      no_cache: true,
    }),
    null,
  );
  const admins = (Array.isArray(members) ? members : []).flatMap((m) =>
    m.role === "owner" || m.role === "admin"
      ? [
          {
            id: String(m.user_id ?? ""),
            name: m.card || m.nickname || String(m.user_id ?? ""),
            role: m.role === "owner" ? ("owner" as const) : ("admin" as const),
            ...(m.title ? { title: m.title } : {}),
          },
        ]
      : [],
  );
  const shutUp = me?.shut_up_timestamp ?? 0;
  return describe({
    members: typeof info?.member_count === "number" ? info.member_count : null,
    admins,
    bannedUntil: shutUp > 0 ? shutUp * 1000 : null,
  });
}

/**
 * 启动时看一轮她的收藏表情（NapCat 等的 fetch_custom_face 扩展），收进 QQ 的贴纸库，她连上就有表情包可发。
 * 只看库里还没有的，每次启动最多 FAVORITES_LOOKED 个；OneBot 不支持或出错都只记一条，不影响别的。
 */
async function lookAtFavorites(
  qq: QQ,
  look: (sticker: QQSticker, url: string) => Promise<string>,
  host: PlatformHost,
): Promise<void> {
  // 暂停、停机：这一轮就不看了。
  const stopped = (error: unknown) =>
    host.signal.aborted || (error instanceof Failed && error.failure.reason === "paused");
  let listed: unknown;
  try {
    listed = await qq.request<unknown>("fetch_custom_face", {
      count: FAVORITES_ASKED,
      return_type: "url",
    });
  } catch (error) {
    if (!stopped(error)) host.warn("QQ favorite stickers unavailable", error);
    return;
  }
  const urls = (Array.isArray(listed) ? listed : []).flatMap((item: unknown) => {
    const url = typeof item === "string" ? item : (item as { url?: unknown } | null)?.url;
    return typeof url === "string" && /^https?:/.test(url) ? [url] : [];
  });
  const fresh = urls
    .flatMap((url) => {
      const key = stickerKeyOf({ type: "image", data: { url } });
      return key && !knownSticker(key, "qq") ? [{ url, key }] : [];
    })
    .slice(0, FAVORITES_LOOKED);
  for (const { url, key } of fresh) {
    try {
      await look({ fileId: url, fileUniqueId: key }, url);
    } catch (error) {
      if (stopped(error)) return;
      host.warn("QQ favorite sticker perception failed", error);
    }
  }
}

/** 取一条语音的音频：请 OneBot 转成 ogg（get_record），返回 base64 或下载地址。 */
async function recordBytes(
  qq: QQ,
  file: string,
  download: (url: string, signal: AbortSignal) => Promise<Uint8Array>,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const record = await qq.request<{ base64?: string; url?: string }>("get_record", {
    file,
    out_format: "ogg",
  });
  if (record?.base64) return new Uint8Array(Buffer.from(record.base64, "base64"));
  if (record?.url && /^https?:/.test(record.url)) return download(record.url, signal);
  throw new Error("OneBot get_record returned no audio");
}
