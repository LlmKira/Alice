/**
 * Telegram 平台（实现 src/platform.ts 的接口）：mtcute 用户账号客户端、入站适配、对话轮询补拉、拉取表情反应计数、
 * 查询群资料、贴纸面板、语音通话，以及它们依赖的 Journal 投影（相册、转发书架、认识的人、限额、去重、群、现场事实）。
 */
import { setTimeout as sleep } from "node:timers/promises";
import { Album, albumSearchText } from "../album.js";
import type { PlatformConfig } from "../config.js";
import type { Gateway } from "../llm/gateway.js";
import type { QueryKind } from "../llm/ptc.js";
import { rerank } from "../llm/rerank.js";
import { SPEECH_MODELS, type SpeechModelName } from "../llm/speech-model.js";
import { synthesizeSpeech, type TtsConfig } from "../llm/tts.js";
import {
  type Act,
  PLATFORM_ACT_KINDS,
  type PlatformActKind,
  type PlatformCapabilities,
} from "../mind/affordances.js";
import type { AliceEvent } from "../mind/events.js";
import { Failed } from "../mind/failure.js";
import type { ActOutcome } from "../mind/outcome.js";
import type { AliceState } from "../mind/state.js";
import { STICKER_WORDS } from "../mind/words.js";
import { type Platform, type PlatformHost, type QueryResult, selftestReport } from "../platform.js";
import { applyAccountIdentity } from "../speech/prompt.js";
import {
  listStickerHints,
  paletteSize,
  resolveStickerFileId,
  unresolvedStickerWords,
} from "../sticker-palette.js";
import { createLogger } from "../utils/logger.js";
import { executeAct } from "./acts.js";
import { CATCH_UP_MS, catchUp, dialogScopes, Groups, Inbox } from "./catch-up.js";
import { createClient, createDispatcher, destroyClient, startClient } from "./client.js";
import { discover } from "./discover.js";
import { Acquaintances } from "./first-dm.js";
import { Gates, Telegram } from "./gates.js";
import type { TelegramPhoneCalls } from "./phone-call.js";
import { describeRoom, pullReactions, Scene } from "./scene.js";
import { Shelf } from "./shelf.js";
import { createVoiceCalls } from "./voice-calls.js";
import { bindTelegramWorldAdapter, targetOf } from "./world-adapter.js";

const log = createLogger("runtime");

type TelegramConfig = Extract<PlatformConfig, { name: "telegram" }>;

export interface TelegramPlatformDeps {
  gateway: Gateway;
  persona: string;
  operatorId: string;
  ignoredSenders: ReadonlySet<string>;
  tts: TtsConfig | null;
  /** 是否接一对一语音通话（还需要配了 TTS）。 */
  voiceCalls: boolean;
  speechModel: SpeechModelName;
}

/** Telegram 生产环境开放的对外动作：暂不含 unsend（Telegram 改消息用 edit；这样现有提示词和回放结果逐字节不变）。 */
const TELEGRAM_CAPABILITIES: PlatformCapabilities = {
  acts: new Set<PlatformActKind>(PLATFORM_ACT_KINDS.filter((k) => k !== "unsend")),
};

export class TelegramPlatform implements Platform {
  readonly name = "telegram" as const;
  readonly prefix = "telegram:";
  readonly capabilities = TELEGRAM_CAPABILITIES;
  private readonly album: Album;
  private readonly shelf = new Shelf();
  /** 她在群里见过谁、和谁私聊过：第一次私聊某人之前，要经共同的群拿到对方（first-dm.ts）。 */
  private readonly acquaintances = new Acquaintances();
  /** 执行器的限额（加群、找群、连发）：计数从 Journal 恢复，重启不清零。 */
  private readonly gates = new Gates();
  /** 她收到过的消息：用于推送和对话轮询补拉之间去重、找出漏掉的消息（catch-up.ts）。 */
  private readonly inbox = new Inbox();
  /** 她在哪些群里：启动后才出现的群，按刚被拉进群处理。 */
  private readonly groups = new Groups();
  /** 现场事实（scene.ts）：每条消息、每个群最近写进 Journal 的状态；只在有变化时写新的。 */
  private readonly scene = new Scene();
  private telegram: Telegram | null = null;
  private calls: TelegramPhoneCalls | null = null;
  private catchUpTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: TelegramConfig,
    private readonly deps: TelegramPlatformDeps,
  ) {
    this.album = new Album((query, documents, top) => rerank(deps.gateway, query, documents, top));
  }

  observe(event: AliceEvent, state: AliceState, phase: "fold" | "live"): void {
    this.scene.observe(event);
    this.album.observe(event);
    this.shelf.observe(event, state);
    this.acquaintances.observe(event);
    this.inbox.observe(event);
    this.groups.observe(event);
    // 限额只在启动 fold 时从历史 Journal 恢复；运行中由 Telegram.post / explore 的 tryAcquire 自己计数，不能再 observe 一遍。
    if (phase === "fold") this.gates.observe(event);
  }

  startupInfo(): Record<string, unknown> {
    const stickers = paletteSize("telegram");
    warnStickerGaps(stickers);
    return {
      voiceCalls: this.deps.voiceCalls,
      stickers,
      albumPhotos: this.album.size,
    };
  }

  async start(host: PlatformHost): Promise<{ selfId: string; selfName?: string }> {
    const { deps, scene, inbox, groups } = this;
    const client = createClient(this.config);
    const dispatcher = createDispatcher(client);
    client.onConnectionState.add((state) => host.connection(state));
    await startClient(client, this.config.telegramPhone);
    const self = await client.getMe();
    const selfName = self.displayName?.trim() || undefined;
    const telegram = new Telegram(client, this.gates, undefined, this.acquaintances);
    this.telegram = telegram;
    const background = () => telegram.with(host.signal);

    const adapter = bindTelegramWorldAdapter(dispatcher, {
      selfId: String(self.id),
      selfUsername: self.username ?? undefined,
      ignoredSenders: deps.ignoredSenders,
      now: host.now,
      onEvent: (event) => {
        host.dispatch(event);
        // 群里有人说话，且距上次查询群资料超过 6 小时：重新查一次，有变化才写。
        if (
          event.type === "message.received" &&
          event.chatType === "group" &&
          scene.roomDue(event.scope, host.now())
        ) {
          void host.track(refreshRoom(background(), event.scope, scene, host));
        }
      },
      perceive: {
        ...host.perceive,
        sticker: (meta, load) => host.perceive.sticker({ ...meta, platform: "telegram" }, load),
      },
      warn: (message, error) => host.warn(message, error),
      admit: (scope, messageId) => inbox.admit(scope, messageId),
      newGroup: (scope) => groups.isNew(scope),
      scene: {
        stickerSet: (set, found) => scene.stickerSet(background(), set, found),
        changes: (scope, messageId, seen, at) => scene.changes(scope, messageId, seen, at),
      },
    });
    if (deps.voiceCalls && deps.tts) {
      const voiceCalls = createVoiceCalls({
        client,
        gateway: deps.gateway,
        tts: deps.tts,
        callModel: SPEECH_MODELS[deps.speechModel],
        persona: applyAccountIdentity(deps.persona, { selfName, platforms: ["telegram"] }),
        allowUser: (uid) =>
          !host.pause.paused &&
          !deps.ignoredSenders.has(String(uid)) &&
          (String(uid) === deps.operatorId || Boolean(host.state().chats[`telegram:${uid}`])),
        chat: (uid) => host.state().chats[`telegram:${uid}`],
      });
      this.calls = voiceCalls;
      dispatcher.onRawUpdate(async (_client, update) => {
        if (update._ === "updatePhoneCall") {
          await voiceCalls.handleUpdate(update.phoneCall);
        } else if (update._ === "updatePhoneCallSignalingData") {
          await voiceCalls.handleSignalingData(update);
        }
      });
    }
    void host.track(
      dialogScopes(background())
        .then((scopes) => groups.started(scopes))
        .catch((error: unknown) => {
          if (!host.signal.aborted)
            host.warn("Dialog list failed; new groups are not recognised", error);
        }),
    );
    // 对话轮询：补回 Telegram 没推送的消息（大超级群、频道），只补本次启动之后的。
    const startedAt = Date.now();
    let catchUpRun: Promise<void> | null = null;
    this.catchUpTimer = setInterval(() => {
      if (catchUpRun) return;
      const run = catchUp(background(), inbox, adapter.receive, startedAt)
        .then((round) => log.info("catch-up", { ...round }))
        // Telegram 不推送别人消息上的表情反应计数：对刚有人说话的群主动拉取一次（scene.ts）。
        .then(() => pullActiveReactions(background(), scene, host))
        .catch((error: unknown) => {
          // 因停机而中止不算补拉失败；限流、网络等其他错误照常记录。
          if (!host.signal.aborted) host.warn("Catch-up failed", error);
        })
        .finally(() => {
          if (catchUpRun === run) catchUpRun = null;
        });
      catchUpRun = run;
      void host.track(run);
    }, CATCH_UP_MS);
    this.catchUpTimer.unref();
    return { selfId: String(self.id), ...(selfName ? { selfName } : {}) };
  }

  async act(scope: string, act: Act, signal: AbortSignal): Promise<ActOutcome> {
    return executeAct(this.actContext(scope, signal), act);
  }

  async query(
    _scope: string,
    kind: Exclude<QueryKind, "delegate">,
    act: Act,
    signal: AbortSignal,
  ): Promise<QueryResult> {
    switch (kind) {
      case "album-search": {
        const q = act.kind === "album-search" ? act.query : "";
        const hits = await this.album.searchItems(q, Date.now(), this.prefix);
        return { value: hits, result: albumSearchText(q, hits) };
      }
      case "chat-search": {
        const q = act.kind === "chat-search" ? act.query : "";
        const found = await discover(this.connected().with(signal), q);
        return { value: found.found, result: found.text, found: found.found };
      }
      default:
        throw new Failed({ reason: "unavailable" }, `unsupported query: ${kind}`);
    }
  }

  stickers(): readonly string[] {
    return listStickerHints(14, "telegram");
  }

  async sendToOperator(text: string): Promise<void> {
    if (!this.telegram) return;
    await this.telegram.client.sendText(Number(this.deps.operatorId), text);
  }

  async selftest(): Promise<string> {
    if (!this.telegram) return "还没连上 Telegram。";
    const scope = `telegram:${this.deps.operatorId}`;
    const signal = new AbortController().signal;
    return selftestReport((act) => executeAct(this.actContext(scope, signal), act));
  }

  async stop(): Promise<void> {
    if (this.catchUpTimer) clearInterval(this.catchUpTimer);
    await this.calls?.dispose();
    await destroyClient();
  }

  private connected(): Telegram {
    if (!this.telegram) throw new Failed({ reason: "unavailable" }, "Telegram is not connected");
    return this.telegram;
  }

  /** 执行她的对外动作所需的上下文（外壳的 act 端口和操作员自检走同一条执行路径）。 */
  private actContext(scope: string, signal: AbortSignal) {
    const { tts, gateway } = this.deps;
    return {
      telegram: this.connected().with(signal),
      target: targetOf(scope),
      stickerFileId: (word: string) => resolveStickerFileId(word, "telegram"),
      album: this.album,
      shelf: this.shelf,
      scope,
      now: () => Date.now(),
      speak: async (text: string) => {
        if (!tts) throw new Failed({ reason: "unavailable" });
        return synthesizeSpeech(tts, text, { signal, charge: gateway.charge });
      },
      // 模拟发文字前"正在输入"的那几秒（typing.ts）；停机时立即停止等待。
      pause: async (ms: number) => sleep(ms, undefined, { signal }),
    };
  }
}

function warnStickerGaps(stickers: number): void {
  if (stickers === 0)
    log.warn("Sticker palette is empty: sticker sends will be recorded as failed");
  const unresolved = unresolvedStickerWords(STICKER_WORDS, "telegram");
  if (unresolved.length > 0)
    log.warn("Sticker words with no sticker in the palette", { words: unresolved });
}

/** 重新查询群资料，有变化才写进 Journal。 */
async function refreshRoom(
  telegram: Telegram,
  scope: string,
  scene: Scene,
  host: PlatformHost,
): Promise<void> {
  try {
    const room = await describeRoom(telegram, scope, host.now);
    if (room && scene.roomChanged(room)) host.dispatch(room);
  } catch (error: unknown) {
    // 因停机而中止不算查询失败（限流、没权限等其他错误照常记录）。
    if (!telegram.signal.aborted) host.warn("Room description failed", error);
  }
}

/** Telegram 不推送别人消息上的表情反应计数：对刚有人说话的群主动拉取一次（scene.ts）。 */
async function pullActiveReactions(
  telegram: Telegram,
  scene: Scene,
  host: PlatformHost,
): Promise<void> {
  for (const { scope, ids } of scene.activeRooms(host.now())) {
    const pulled = await pullReactions(telegram, scope, ids).catch((error: unknown) => {
      if (!host.signal.aborted) host.warn("Reaction pull failed", error);
      return [];
    });
    for (const p of pulled) {
      const update = scene.changes(scope, p.messageId, { reactions: p.reactions }, host.now());
      if (update) host.dispatch(update);
    }
  }
}
