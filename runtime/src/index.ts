/**
 * Alice Runtime 入口。
 *
 * 启动流程：
 * 1. 加载配置
 * 2. 初始化数据库
 * 3. 连接 Telegram
 * 4. 恢复/构建图 + 人格
 * 5. 恢复 Mod 状态 + lastActionTick（ADR-33）
 * 6. 安全网预检（LLM 连通 + Telegram 自检 + 贴纸同步 + Skill 同步 + 压力管线 dry-run）
 * 7. 绑定事件 → 启动 EVOLVE 循环 + ACT 循环
 * 8. 优雅退出
 */

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { generateText } from "ai";

import { TRAIT_BELIEF_DECAY } from "./belief/types.js";
import { loadConfig } from "./config.js";
import { checkToolSurfaceCompleteness } from "./core/d3-completeness.js";
import { createAliceDispatcher } from "./core/dispatcher.js";
import { loadAllMods } from "./core/mod-loader.js";
import { ALICE_HOME } from "./core/shell-executor.js";
import { writeAuditEvent } from "./db/audit.js";
import { closeDb, getDb, initDb } from "./db/connection.js";
import { recoverLastActionTick, runMaintenance } from "./db/maintenance.js";
import {
  flushGraph,
  loadGraphFromDb,
  loadLatestPersonality,
  migrateFromSnapshots,
  savePersonalitySnapshot,
} from "./db/snapshot.js";
import { type ActContext, startActLoop } from "./engine/act/index.js";
import { ActionQueue } from "./engine/action-queue.js";
import { createDeliberationState } from "./engine/deliberation.js";
import { initEpisodeState } from "./engine/episode.js";
import { type EvolveState, POST_WAKEUP_RECOVERY_MS, startEvolveLoop } from "./engine/evolve.js";
import {
  decideStartupMode,
  latestRuntimeSeenMs,
  POST_RESTART_RECOVERY_MIN_OFFLINE_MS,
} from "./engine/startup-mode.js";
import { startEngineApi } from "./engine-api/server.js";
import { ALICE_SELF, telegramChannelId } from "./graph/constants.js";
import { recordForwardShare } from "./graph/dynamic-props.js";
import { buildTensionMap } from "./graph/tension.js";
import type { WorldModel } from "./graph/world-model.js";
import { initProviders, selectProviderForFirstPass } from "./llm/client.js";
import { closeGroupCache, initGroupCache } from "./llm/group-cache.js";
import { closeMediaCache, initMediaCache } from "./llm/media-cache.js";
import { onBreakerStateChange } from "./llm/resilience.js";
import { createOneBotTransportAdapter } from "./platform/onebot.js";
import {
  type OneBotReceiverController,
  startOneBotEventReceiver,
} from "./platform/onebot-receiver.js";
import { AdaptiveKappa, computeAllPressures, createPressureHistory } from "./pressure/aggregate.js";
import {
  ALICE_DB_PATH,
  ALICE_GROUP_CACHE_DB_PATH,
  ALICE_MEDIA_CACHE_DB_PATH,
  ensureParentDir,
} from "./runtime-paths.js";
import { syncEnv } from "./skills/pkg.js";
import { ensureAllArtifacts, loadRegistry } from "./skills/registry.js";
import {
  forwardMessage,
  getMessages,
  joinChat,
  leaveChat,
  markRead,
  sendReaction,
  sendSticker,
  sendText,
  setTyping,
} from "./telegram/actions.js";
import { bindAdminCommands } from "./telegram/admin.js";
import { sendAlbumPhoto } from "./telegram/album-send.js";
import {
  getAvailableKeywords,
  resolveByEmoji,
  resolveLabel,
  syncInstalledSets,
} from "./telegram/apps/sticker-palette.js";
import { buildInitialGraph } from "./telegram/bootstrap.js";
import { createClient, createDispatcher, destroyClient, startClient } from "./telegram/client.js";
import { isTelegramActionError, TelegramActionError } from "./telegram/errors.js";
import { bindEvents, cacheOutgoingMsg, EventBuffer, warmOutgoingCache } from "./telegram/events.js";
import { cleanupPhantomContacts } from "./telegram/mapper.js";
import { initAdminNotify, notifyAdmin } from "./telegram/notify-admin.js";
import { createLogger } from "./utils/logger.js";
import { TickClock } from "./utils/time.js";
import { computeLoudness } from "./voices/loudness.js";
import { PersonalityVector } from "./voices/personality.js";
import { selectAction } from "./voices/selection.js";

const log = createLogger("alice");
const RUNTIME_HEARTBEAT_INTERVAL_MS = 30 * 1000;

function recordRuntimeHeartbeat(G: WorldModel, nowMs = Date.now()): void {
  if (!G.has(ALICE_SELF)) return;
  G.updateAgent(ALICE_SELF, { runtime_last_seen_ms: nowMs });
  flushGraph(G);
}

async function main() {
  log.info("Alice Runtime starting...");

  // 1. 配置
  const config = loadConfig();

  // 2. 数据库
  ensureParentDir(ALICE_DB_PATH);
  ensureParentDir(ALICE_MEDIA_CACHE_DB_PATH);
  ensureParentDir(ALICE_GROUP_CACHE_DB_PATH);
  initDb(ALICE_DB_PATH);
  initMediaCache(ALICE_MEDIA_CACHE_DB_PATH);
  initGroupCache(ALICE_GROUP_CACHE_DB_PATH);
  log.info("Database initialized");

  // 3. Telegram 连接
  const client = createClient(config);
  const dp = createDispatcher(client);
  await startClient(client, config.telegramPhone);
  const self = await client.getMe();
  const selfId = String(self.id);
  log.info("Logged in", { selfId, username: self.username });

  // ADR-33 Phase 2: 从旧 graph_snapshots 迁移到 graph_nodes/graph_edges（一次性）
  migrateFromSnapshots();

  // 4. 恢复或构建图
  let G = loadGraphFromDb();
  if (G) {
    log.info("Graph restored from DB", { tick: G.tick, nodes: G.size });
    // ADR-206: 清理历史幽灵联系人（频道以自身身份发消息产生的 contact 镜像）
    const phantomCount = cleanupPhantomContacts(G);
    if (phantomCount > 0) {
      log.info("Cleaned up phantom contacts", { count: phantomCount });
    }
  } else {
    log.info("No graph data found, building initial graph...");
    G = await buildInitialGraph(client);
    flushGraph(G);
    log.info("Initial graph saved", { nodes: G.size, edges: G.edgeCount });
  }

  // ADR-123 D2: 注册域衰减参数（在 evolve 前、所有 graph 路径后）
  // @see docs/adr/123-crystallization-substrate-generalization.md §D2
  G.beliefs.registerDomainDecay("trait:", TRAIT_BELIEF_DECAY);
  // ADR-123 §D3/D4: jargon 和 expression 域衰减参数
  G.beliefs.registerDomainDecay("jargon:", {
    halfLife: 720,
    muPrior: 0,
    sigma2Inf: 1.0,
    theta: 0.001,
  });
  G.beliefs.registerDomainDecay("expression:", {
    halfLife: 1440,
    muPrior: 0,
    sigma2Inf: 1.0,
    theta: 0.001,
  });
  // ADR-208: interest 域 — 复用 trait 的未结晶衰减参数（8h 半衰期，等待结晶期间快速衰减）
  // @see docs/adr/208-cognitive-label-interest-domain.md
  G.beliefs.registerDomainDecay("interest:", TRAIT_BELIEF_DECAY);

  // 恢复或创建人格
  // M7: 单一引用对象——所有消费者通过 personalityRef.current 访问，
  // onPersonalityUpdate 只需更新一处，不再需要同步多个字段。
  const personalityRef = {
    current: loadLatestPersonality() ?? new PersonalityVector(config.piHome),
  };
  log.info("Personality loaded", personalityRef.current.toString());

  // 同步人格信息到图节点（供 strategy.mod 漂移审计使用）
  if (G.has(ALICE_SELF)) {
    G.updateAgent(ALICE_SELF, {
      personality_weights: JSON.stringify(personalityRef.current.weights),
      pi_home: JSON.stringify(config.piHome),
    });
  }

  // 5. 初始化运行时组件
  // Mod 系统：加载所有 Mods → 创建 Dispatcher
  const mods = loadAllMods();
  const dispatcher = createAliceDispatcher({ graph: G, mods });
  log.info("Mod system initialized", {
    mods: mods.map((m) => m.meta.name),
    instructions: dispatcher.getInstructionNames(),
    queries: dispatcher.getQueryNames(),
  });

  // D3 Axiom 3: 工具面完整性检查（启动诊断，不阻塞）
  // @see paper/ §Axiom 3 "Tool Surface Completeness"
  checkToolSurfaceCompleteness(dispatcher);

  // ADR-33: 恢复 Mod 状态（重启后不丢失 memorizedFacts/outcomeHistory/strategy 缓存）
  const modStatesRestored = dispatcher.loadModStatesFromDb();
  if (modStatesRestored) {
    log.info("Mod states restored from DB");
  }

  // ADR-33: 恢复 lastActionTick（避免重启后立即触发空闲自启动）
  const lastActionTick = recoverLastActionTick();

  const clock = new TickClock({
    dtMin: config.dtMin,
    dtMax: config.dtMax,
    kappaT: config.kappaT,
    startTick: G.tick,
  });
  const buffer = new EventBuffer();
  const queue = new ActionQueue();
  let oneBotReceiver: OneBotReceiverController | null = null;
  const noveltyHistory: number[] = [];
  const recentEventCounts: number[] = [];
  const recentActions: EvolveState["recentActions"] = [];

  // 绑定管理员命令（group=-1，在 EventBuffer handler 之前执行）
  const adminCtx = {
    config,
    client,
    clock,
    G,
    get personality() {
      return personalityRef.current;
    },
    queue,
    dispatcher,
    mods,
  };
  bindAdminCommands(dp, adminCtx);

  // ADR-90 W1: 启动预热 outgoing message cache — reply directed 检测重启恢复
  const warmedCount = warmOutgoingCache();
  log.info("Outgoing message cache warmed from DB", { count: warmedCount });

  // 绑定 Telegram 事件 → EventBuffer
  const selfUsername = self.username ?? undefined;
  bindEvents(
    dp,
    G,
    buffer,
    () => selfId,
    () => clock.tick,
    () => selfUsername,
    client,
  );
  if (config.qqOneBotEventWsUrl) {
    oneBotReceiver = startOneBotEventReceiver({
      url: config.qqOneBotEventWsUrl,
      accessToken: config.qqOneBotAccessToken,
      selfId,
      selfDisplayName: self.username ?? "Alice",
      getTick: () => clock.tick,
      buffer,
      reconnectMinMs: config.qqOneBotReconnectMinMs,
      reconnectMaxMs: config.qqOneBotReconnectMaxMs,
    });
    log.info("OneBot event receiver started");
  }

  // EVOLVE 状态
  // ADR-33/110: lastActionTick → lastActionMs。
  // 尝试从图中任意节点读取 last_alice_action_ms（墙钟直读）；
  // 不存在时回退到 tick 差值估算；全无则用 Date.now()。
  const startupNowMs = Date.now();
  let estimatedLastActionMs = startupNowMs;
  if (lastActionTick > 0) {
    // 搜索图中最近的 last_alice_action_ms（任一 channel/contact 节点）
    let bestMs = 0;
    for (const nid of [...G.getEntitiesByType("channel"), ...G.getEntitiesByType("contact")]) {
      const ms = Number(G.getDynamic(nid, "last_alice_action_ms") ?? 0);
      if (ms > bestMs) bestMs = ms;
    }
    estimatedLastActionMs =
      bestMs > 0 ? bestMs : startupNowMs - (G.tick - lastActionTick) * config.dtMax;
  }

  const lastRuntimeSeenMs =
    G.has(ALICE_SELF) && G.getAgent(ALICE_SELF).runtime_last_seen_ms != null
      ? G.getAgent(ALICE_SELF).runtime_last_seen_ms
      : 0;
  const lastRuntimeShutdownMs =
    G.has(ALICE_SELF) && G.getAgent(ALICE_SELF).runtime_shutdown_ms != null
      ? G.getAgent(ALICE_SELF).runtime_shutdown_ms
      : 0;
  const runtimeSeenMs = latestRuntimeSeenMs({
    lastSeenMs: lastRuntimeSeenMs,
    shutdownMs: lastRuntimeShutdownMs,
  });
  const startupMode = decideStartupMode({
    runtimeOfflineMs: runtimeSeenMs > 0 ? startupNowMs - runtimeSeenMs : 0,
    actionSilenceMs: startupNowMs - estimatedLastActionMs,
    wakeupOfflineThresholdS: config.wakeupOfflineThresholdS,
    postRestartRecoveryMinOfflineMs: POST_RESTART_RECOVERY_MIN_OFFLINE_MS,
  });
  const { initialMode, shouldUsePostRestartRecovery } = startupMode;
  if (initialMode === "wakeup") {
    log.info("Entering wakeup mode — long runtime offline detected", {
      runtimeOfflineS: Math.round(startupMode.runtimeOfflineS),
      actionSilenceS: Math.round(startupMode.actionSilenceS),
      thresholdS: config.wakeupOfflineThresholdS,
    });
  } else if (shouldUsePostRestartRecovery) {
    log.info("Entering post-restart recovery window", {
      recoveryMs: POST_WAKEUP_RECOVERY_MS,
      runtimeOfflineS: Math.round(startupMode.runtimeOfflineS),
      actionSilenceS: Math.round(startupMode.actionSilenceS),
    });
  } else {
    log.info("Entering patrol mode after short restart", {
      runtimeOfflineS: Math.round(startupMode.runtimeOfflineS),
      actionSilenceS: Math.round(startupMode.actionSilenceS),
      recoveryMinOfflineS: POST_RESTART_RECOVERY_MIN_OFFLINE_MS / 1000,
    });
  }
  recordRuntimeHeartbeat(G, startupNowMs);

  const evolveState: EvolveState = {
    G,
    get personality() {
      return personalityRef.current;
    },
    clock,
    buffer,
    queue,
    config,
    noveltyHistory,
    recentEventCounts,
    recentActions,
    dispatcher,
    lastActionMs: estimatedLastActionMs,
    pressureHistory: createPressureHistory(),
    deliberation: createDeliberationState(),
    attentionDebtMap: new Map(),
    lastSelectedTarget: null,
    lastSelectedCandidate: null,
    // Agent Mode FSM — ADR-190: 根据离线时长决定初始模态
    mode: initialMode,
    focusTarget: undefined,
    modeEnteredMs: startupNowMs,
    adaptiveKappa: new AdaptiveKappa(config.kappa),
    channelRateEma: new Map(),
    // ADR-191: spike 信号数据源（perceiveTick 产物）
    lastChannelCounts: new Map(),
    // ADR-147 D2: 事件计数 EMA 初始值（冷启动）
    eventCountEma: 10,
    // ADR-147 D12: 连续洪水 tick 计数
    floodTickCount: 0,
    // ADR-190: Wakeup 状态
    wakeupTicksElapsed: 0,
    wakeupEngagedTargets: new Set(),
    // Runtime restart also resets queue/engagement context; use the same recovery control loop.
    wakeupRecoveryUntilMs: shouldUsePostRestartRecovery
      ? startupNowMs + POST_WAKEUP_RECOVERY_MS
      : undefined,
    lastAPI: 0,
    lastAPIPeak: 0,
    lastFlushMs: startupNowMs,
    currentDt: 0,
    // ADR-190: LLM 失败指数退避初始状态
    llmBackoff: { consecutiveFailures: 0, lastFailureMs: 0 },
    // ADR-215: Cognitive Episode Graph
    episodeState: initEpisodeState(),
  };

  // ACT 上下文
  const actCtx: ActContext = {
    client,
    G,
    config,
    queue,
    get personality() {
      return personalityRef.current;
    },
    dispatcher,
    buffer, // ADR-107: EventBuffer 引用
    getCurrentTick: () => clock.tick,
    getCurrentPressures: () => {
      const p = computeAllPressures(G, clock.tick, {
        kappa: config.kappa,
        threadAgeScale: config.threadAgeScale,
        mu: config.mu,
        d: config.d,

        deltaDeadline: config.delta,
      });
      return [p.P1, p.P2, p.P3, p.P4, p.P5, p.P6];
    },
    // ADR-173: 延迟记录——act 确认真实 Telegram 行动后写入 recentActions
    recordAction: (action: string, target: string | null) => {
      const nowMs = Date.now();
      recentActions.push({ tick: clock.tick, action, ms: nowMs, target });
      // 窗口清理（与旧 enqueueAndRecord 逻辑一致）
      const windowStartMs = nowMs - config.actionRateWindow * 1000;
      while (recentActions.length > 0 && recentActions[0].ms <= windowStartMs) {
        recentActions.shift();
      }
    },
    // ADR-190: LLM 调用结果通知——驱动 evolve 调度层指数退避
    reportLLMOutcome: (success: boolean) => {
      if (success) {
        evolveState.llmBackoff.consecutiveFailures = 0;
      } else {
        evolveState.llmBackoff.consecutiveFailures++;
        evolveState.llmBackoff.lastFailureMs = Date.now();
      }
    },
    onPersonalityUpdate: (pv) => {
      // M7: 单点更新——所有消费者通过 getter 自动获取最新值
      personalityRef.current = pv;
      // 同步到图节点（供 strategy.mod 人格漂移审计读取）
      if (G.has(ALICE_SELF)) {
        G.updateAgent(ALICE_SELF, { personality_weights: JSON.stringify(pv.weights) });
      }
      // 人格快照由 snapshotAndMaintain 定时器统一保存（墙钟间隔），
      // 此处不再使用 tick % snapshotIntervalS（tick 计数 vs 秒数语义不匹配）。
      // @see F8 fix: ADR-113 遗留项
    },
  };

  // ── ADR-54 安全网：启动预检 ──────────────────────────────────────────────

  // S2: mtcute 连接监控 — 注册 error/connectionState 处理器
  // mtcute 内部自动重连，这里做日志记录以便排查
  // @see docs/adr/54-pre-mortem-safety-net.md §S2
  client.onError.add((err: Error) => {
    log.error("mtcute connection error", { error: err.message });
    writeAuditEvent(clock.tick, "error", "mtcute", "Connection error", {
      error: err.message,
    });
  });
  // ADR-147 D4: mtcute 重连状态感知 — 精确标记积压期
  // `updating` = 正在追赶积压 updates，`connected` = 追赶完成。
  // 首次连接: onUsable → connected（无 updating 阶段，recoveringStartMs=0 不触发）
  // 重连恢复: connected → onCatchingUp(true) → updating → ... → onCatchingUp(false) → connected
  // @see docs/adr/147-flood-backlog-recovery.md §D4
  let recoveringStartMs = 0;
  client.onConnectionState.add((state: string) => {
    log.info("mtcute connection state changed", { state });
    if (state === "updating") {
      recoveringStartMs = Date.now();
      buffer.isRecovering = true;
      log.warn("mtcute entering recovery mode — catching up backlog");
      writeAuditEvent(clock.tick, "warn", "mtcute", "Entering recovery mode (catching up)");
    } else if (state === "connected" && recoveringStartMs > 0) {
      const durationMs = Date.now() - recoveringStartMs;
      buffer.isRecovering = false;
      recoveringStartMs = 0;
      log.info("mtcute recovery complete", { durationMs });
      writeAuditEvent(clock.tick, "warn", "mtcute", `Recovery complete in ${durationMs}ms`);
    }
    if (state === "offline" || state === "closed") {
      writeAuditEvent(clock.tick, "warn", "mtcute", `Connection state: ${state}`);
    }
  });

  // D5: 初始化 provider fallback 链（ADR-123 §D5）
  initProviders(config);

  // ADR-263: group reception Ax shadow judge 只做旁路诊断，不接管 evidence/control。
  const { initGroupReceptionShadowJudge } = await import("./mods/observer/group-reception.js");
  initGroupReceptionShadowJudge(config);

  // S-EA: 启动 Engine API（TCP）
  // Skill CLI 脚本通过 TCP 读取 config / graph 属性。
  // @see docs/adr/202-engine-api.md
  let engineApiCleanup: (() => Promise<void>) | null = null;
  let enginePort = 0;
  // deps 引用保持可变——S8 syncEnv 完成后注入 registry + 收紧 strict 模式
  const engineApiDeps: Parameters<typeof startEngineApi>[0] = {
    config: {
      timezoneOffset: config.timezoneOffset,
      exaApiKey: config.exaApiKey ?? "",
      musicApiBaseUrl: config.musicApiBaseUrl ?? "",
      youtubeApiKey: config.youtubeApiKey ?? "",
    },
    G,
    getTick: () => clock.tick,
    transportAdapters: config.qqOneBotApiBaseUrl
      ? {
          qq: createOneBotTransportAdapter({
            apiBaseUrl: config.qqOneBotApiBaseUrl,
            accessToken: config.qqOneBotAccessToken,
            timeoutMs: config.qqOneBotTimeoutMs,
          }),
        }
      : undefined,
    telegramSend: async ({ chatId, text, replyTo }) => {
      const rawChatId = typeof chatId === "number" ? chatId : Number(chatId);
      // Typing indicator + 自然延迟（对齐 action-executor 行为）。
      // irc say/reply 通过 Engine API 发送，不经过 action-executor 的 typing 管线，
      // 需要在此处补偿，否则对端看不到"正在输入"。
      try {
        await setTyping(client, rawChatId);
        const charCount = [...text].length;
        const delayMs = Math.min(Math.max(charCount * 80, 800), 8000);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      } catch {
        // typing 失败不阻断发送
      }
      const msgId = await sendText(client, rawChatId, text, { replyToMsgId: replyTo });
      // 显式取消 typing 定时器（mtcute 5s 自动续发，不取消会残留）
      setTyping(client, rawChatId, true).catch(() => {});
      const graphId = telegramChannelId(rawChatId);
      if (msgId != null && graphId) {
        cacheOutgoingMsg(graphId, msgId);
      }
      if (graphId && G.has(graphId)) {
        G.setDynamic(graphId, "last_outgoing_text", [...text].slice(0, 150).join(""));
        dispatcher.dispatch("SEND_MESSAGE", { chatId: graphId, text, msgId });
        dispatcher.dispatch("DECLARE_ACTION", { target: graphId });
      }
      return { msgId: msgId ?? null };
    },
    telegramMarkRead: async (chatId) => {
      const rawChatId = typeof chatId === "number" ? chatId : Number(chatId);
      await markRead(client, rawChatId);
      const graphId = telegramChannelId(rawChatId);
      if (graphId && G.has(graphId)) {
        G.setDynamic(graphId, "unread", 0);
        G.setDynamic(graphId, "mentions_alice", false);
        G.setDynamic(graphId, "recently_cleared_ms", Date.now());
      }
      return { ok: true as const };
    },
    telegramReact: async ({ chatId, msgId, emoji }) => {
      const rawChatId = typeof chatId === "number" ? chatId : Number(chatId);
      await sendReaction(client, rawChatId, msgId, emoji);
      const graphId = telegramChannelId(rawChatId);
      if (graphId) {
        dispatcher.dispatch("DECLARE_ACTION", { target: graphId, isMessage: false });
      }
      return { ok: true as const };
    },
    telegramJoin: async (chatIdOrLink) => {
      await joinChat(client, chatIdOrLink);
      return { ok: true as const };
    },
    telegramLeave: async (chatId) => {
      const rawChatId = typeof chatId === "number" ? chatId : Number(chatId);
      await leaveChat(client, rawChatId);
      return { ok: true as const };
    },
    telegramSticker: async ({ chatId, sticker: keyword }) => {
      const rawChatId = typeof chatId === "number" ? chatId : Number(chatId);
      // Typing indicator（sticker 也需要短暂的"正在输入"模拟自然感）
      try {
        await setTyping(client, rawChatId);
        await new Promise((resolve) => setTimeout(resolve, 600));
      } catch {
        // typing 失败不阻断发送
      }
      const graphId = telegramChannelId(rawChatId);
      const db = getDb();
      // 多层解析：维度关键词 → emoji → raw fileId
      let fileId: string | null = resolveLabel(db, keyword, graphId ?? undefined);
      if (!fileId) fileId = resolveByEmoji(db, keyword, graphId ?? undefined);
      if (!fileId && keyword.startsWith("CAACAgI")) fileId = keyword;
      if (!fileId) {
        const available = getAvailableKeywords(db);
        throw new TelegramActionError(
          "invalid_sticker_keyword",
          `No sticker matches "${keyword}". Valid: ${available}`,
        );
      }
      const msgId = await sendSticker(client, rawChatId, fileId);
      setTyping(client, rawChatId, true).catch(() => {});
      if (msgId != null && graphId) {
        cacheOutgoingMsg(graphId, msgId);
        dispatcher.dispatch("DECLARE_ACTION", { target: graphId });
      }
      return { msgId: msgId ?? null };
    },
    // TTS 语音消息：textToSpeech → sendVoice → fallback sendText
    telegramVoice: async ({ chatId, text, emotion, replyTo }) => {
      const rawChatId = typeof chatId === "number" ? chatId : Number(chatId);
      const graphId = telegramChannelId(rawChatId);
      const { isTTSEnabled, textToSpeech } = await import("./llm/tts.js");
      const { sendVoice } = await import("./telegram/actions.js");
      const ttsConfig = {
        ttsBaseUrl: config.ttsBaseUrl,
        ttsApiKey: config.ttsApiKey,
        ttsModel: config.ttsModel,
        ttsVoice: config.ttsVoice,
        ttsGroupId: config.ttsGroupId,
      };
      if (!isTTSEnabled(ttsConfig)) {
        throw new Error("TTS not configured (set TTS_BASE_URL and TTS_API_KEY in .env)");
      }
      // 情感验证
      const VALID_EMOTIONS = new Set([
        "happy",
        "sad",
        "angry",
        "fearful",
        "disgusted",
        "surprised",
        "calm",
        "fluent",
        "whisper",
      ]);
      const validEmotion =
        emotion && VALID_EMOTIONS.has(emotion)
          ? (emotion as import("./llm/tts.js").TTSEmotion)
          : undefined;
      // Typing indicator
      try {
        await setTyping(client, rawChatId);
      } catch {
        /* typing 失败不阻断 */
      }
      const audioBuffer = await textToSpeech(text.slice(0, 1000), ttsConfig, validEmotion);
      let sentMsgId: number | undefined;
      let deliveredAs: "voice" | "text" = "voice";
      let fallbackReason: string | undefined;
      if (audioBuffer) {
        try {
          sentMsgId = await sendVoice(client, rawChatId, audioBuffer, { replyToMsgId: replyTo });
        } catch (error) {
          if (!isTelegramActionError(error) || error.code !== "voice_messages_forbidden") {
            throw error;
          }
          log.warn("Voice messages forbidden, falling back to text", { chatId: rawChatId });
          sentMsgId =
            (await sendText(client, rawChatId, text, { replyToMsgId: replyTo })) ?? undefined;
          deliveredAs = "text";
          fallbackReason = "voice_messages_forbidden";
        }
      } else {
        // TTS 合成失败 → 回退为文本消息
        log.warn("TTS synthesis failed, falling back to text", { chatId: rawChatId });
        sentMsgId =
          (await sendText(client, rawChatId, text, { replyToMsgId: replyTo })) ?? undefined;
        deliveredAs = "text";
        fallbackReason = "tts_synthesis_failed";
      }
      setTyping(client, rawChatId, true).catch(() => {});
      if (sentMsgId != null && graphId) {
        cacheOutgoingMsg(graphId, sentMsgId);
        dispatcher.dispatch("SEND_MESSAGE", {
          chatId: graphId,
          text: deliveredAs === "text" ? text : `(voice: ${text.slice(0, 50)})`,
        });
        dispatcher.dispatch("DECLARE_ACTION", { target: graphId });
      }
      return { msgId: sentMsgId ?? null, deliveredAs, fallbackReason };
    },
    // ADR-206 W8: 跨聊天转发 + 可选附加评论
    telegramForward: async ({ fromChatId, msgId, toChatId, comment }) => {
      const fwdMsgId = await forwardMessage(client, fromChatId, msgId, toChatId);
      const toGraphId = telegramChannelId(toChatId);
      if (fwdMsgId != null && toGraphId) {
        cacheOutgoingMsg(toGraphId, fwdMsgId);
        dispatcher.dispatch("DECLARE_ACTION", { target: toGraphId });
      }
      // 附加评论：转发成功后，以 reply 形式发送评论
      let commentMsgId: number | null = null;
      if (comment?.trim() && fwdMsgId != null) {
        commentMsgId =
          (await sendText(client, toChatId, comment, { replyToMsgId: fwdMsgId })) ?? null;
        if (commentMsgId != null && toGraphId) {
          cacheOutgoingMsg(toGraphId, commentMsgId);
        }
      }
      const fromGraphId = telegramChannelId(fromChatId);
      if (fwdMsgId != null && fromGraphId && toGraphId) {
        const targetName =
          G.has(toGraphId) && G.getDynamic(toGraphId, "display_name")
            ? String(G.getDynamic(toGraphId, "display_name"))
            : String(toChatId);
        recordForwardShare(G, {
          fromGraphId,
          msgId,
          toGraphId,
          targetName,
        });
      }
      return { forwardedMsgId: fwdMsgId ?? null, commentMsgId };
    },
    telegramAlbumSend: async ({ assetId, targetChatId, caption, replyTo }) => {
      return sendAlbumPhoto(client, {
        assetId,
        targetChatId,
        caption,
        replyTo,
        onSent: (msgId) => {
          const graphId = telegramChannelId(targetChatId);
          if (graphId) {
            cacheOutgoingMsg(graphId, msgId);
            dispatcher.dispatch("DECLARE_ACTION", { target: graphId });
          }
        },
      });
    },
    // ADR-204 W2: Telegram 文件下载回调
    telegramDownload: async ({ chatId, msgId, output }) => {
      // 安全约束：output 路径必须在 ALICE_HOME 下
      const resolved = resolve(output);
      if (!resolved.startsWith(ALICE_HOME)) {
        throw new Error(`output path must be under ALICE_HOME (${ALICE_HOME})`);
      }
      const rawChatId = typeof chatId === "number" ? chatId : Number(chatId);
      const msgs = await getMessages(client, rawChatId, [msgId]);
      const msg = msgs[0];
      if (!msg) throw new Error(`message ${msgId} not found in chat ${chatId}`);
      const media = msg.media;
      if (!media) throw new Error(`message ${msgId} has no media`);
      // 排除不可下载的 media 类型（Dice, Contact, Location 等）
      const downloadable =
        "type" in media
          ? [
              "photo",
              "audio",
              "voice",
              "sticker",
              "document",
              "video",
              "videoNote",
              "animation",
            ].includes(media.type)
          : false;
      if (!downloadable) throw new Error(`message ${msgId} media type is not downloadable`);
      const buffer = Buffer.from(
        await client.downloadAsBuffer(media as Parameters<typeof client.downloadAsBuffer>[0]),
      );
      // 确保目标目录存在
      const { mkdirSync } = await import("node:fs");
      mkdirSync(dirname(resolved), { recursive: true });
      writeFileSync(resolved, buffer);
      // 推断 MIME type（从 mtcute media 类型或扩展名）
      const mime =
        "mimeType" in media
          ? String(media.mimeType ?? "application/octet-stream")
          : "application/octet-stream";
      return { path: resolved, mime, size: buffer.length };
    },
    // ADR-204 W2: Telegram 文件上传回调
    telegramUpload: async ({ chatId, path: filePath, caption, replyTo }) => {
      // 安全约束：path 必须在 ALICE_HOME 下
      const resolved = resolve(filePath);
      if (!resolved.startsWith(ALICE_HOME)) {
        throw new Error(`file path must be under ALICE_HOME (${ALICE_HOME})`);
      }
      const { readFileSync, existsSync } = await import("node:fs");
      if (!existsSync(resolved)) throw new Error(`file not found: ${resolved}`);
      const rawChatId = typeof chatId === "number" ? chatId : Number(chatId);
      const fileBuffer = readFileSync(resolved);
      const fileName = resolved.split("/").pop() ?? "file";
      // 使用 InputMedia.auto 构建媒体
      const { InputMedia } = await import("@mtcute/node");
      const inputMedia = InputMedia.auto(fileBuffer, { fileName });
      const sent = await client.sendMedia(rawChatId, inputMedia, {
        caption,
        replyTo,
      });
      const graphId = telegramChannelId(rawChatId);
      if (sent?.id != null && graphId) {
        cacheOutgoingMsg(graphId, sent.id);
        dispatcher.dispatch("DECLARE_ACTION", { target: graphId });
      }
      return { msgId: sent?.id ?? null };
    },
    dispatchInstruction: (instruction, args) => dispatcher.dispatch(instruction, args),
    query: (name, args) => dispatcher.query(name, args),
    resolveCommandKind: (name) => {
      if (dispatcher.getQueryDef(name)) return "query";
      if (dispatcher.getInstructionDef(name)) return "instruction";
      return undefined;
    },
    getMods: () => dispatcher.mods,
    // S8 完成后收紧为 strict（注入 registry + 翻转开关）
    strictCapabilities: false,
  };
  try {
    const engineResult = await startEngineApi(engineApiDeps);
    engineApiCleanup = engineResult.cleanup;
    enginePort = engineResult.port;
    // 注入端口到 shell-executor 模块变量
    const { setEnginePort } = await import("./core/shell-executor.js");
    setEnginePort(enginePort);
    log.info("Engine API started", { port: enginePort });
  } catch (e) {
    log.warn("Engine API failed to start (non-fatal)", {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // ADR-129: 熔断器 → Admin 通知
  initAdminNotify({ client });
  onBreakerStateChange((providerName, event) => {
    if (event === "open") {
      notifyAdmin(
        `breaker:${providerName}`,
        `LLM provider "${providerName}" 熔断器 OPEN — Alice 暂时无法说话`,
      );
    } else if (event === "closed") {
      notifyAdmin(`breaker-recovery:${providerName}`, `LLM provider "${providerName}" 已恢复`);
    }
  });

  // S1: LLM 连通性预检 — 失败重试 3 次再 exit，网络瞬态超时不应杀进程
  // @see docs/adr/54-pre-mortem-safety-net.md §S1
  {
    const S1_MAX_ATTEMPTS = 3;
    const S1_TIMEOUT_MS = 15_000;
    let s1Passed = false;
    for (let attempt = 1; attempt <= S1_MAX_ATTEMPTS; attempt++) {
      try {
        const { provider, model } = selectProviderForFirstPass();
        await generateText({
          model: provider(model),
          prompt: "ping",
          maxOutputTokens: 1,
          abortSignal: AbortSignal.timeout(S1_TIMEOUT_MS),
        });
        log.info("LLM connectivity check passed", { attempt });
        s1Passed = true;
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < S1_MAX_ATTEMPTS) {
          const delayMs = 2_000 * 2 ** (attempt - 1); // 2s, 4s
          log.warn("LLM connectivity check failed, retrying", { attempt, delayMs, error: msg });
          await new Promise((r) => setTimeout(r, delayMs));
        } else {
          log.fatal("LLM connectivity check failed after all attempts", {
            attempts: S1_MAX_ATTEMPTS,
            error: err,
          });
          writeAuditEvent(-1, "fatal", "startup", "LLM connectivity check failed", { error: msg });
        }
      }
    }
    if (!s1Passed) process.exit(1);
  }

  // S5: 启动自检消息 — 向 Telegram 收藏夹发送自检，验证 mtcute + Telegram API 可用
  // @see docs/adr/54-pre-mortem-safety-net.md §S5
  try {
    const startupMsg = `[Alice] Runtime started — ${new Date().toISOString()} — tick #${clock.tick}`;
    await client.sendText("me", startupMsg);
    log.info("Startup self-check message sent to Saved Messages");
  } catch (err) {
    log.error("Failed to send startup self-check message", { error: err });
    // 不 exit — Telegram 连接已通过 getMe() 验证，sendText 失败可能是临时问题
  }

  // S7: 贴纸调色板同步 — 增量同步已安装贴纸集到 palette
  // 幂等：新贴纸入库 + 过期贴纸清理 + fileId 刷新。VLM 贴纸不受影响。
  try {
    const stats = await syncInstalledSets(client, getDb());
    if (stats.added > 0 || stats.removed > 0) {
      log.info("Sticker palette synced", stats);
    }
  } catch (e) {
    log.warn("Sticker palette sync failed (non-fatal)", { error: e });
  }

  // S8: Skill 包同步 — 收敛到 alice-env.yaml 声明的期望状态
  // @see docs/adr/201-os-for-llm.md
  try {
    const envPath = new URL("../skills/alice-env.yaml", import.meta.url).pathname;
    const skillSync = await syncEnv(envPath, { enginePort });
    if (skillSync.installed.length > 0 || skillSync.upgraded.length > 0) {
      log.info("Skills synced", skillSync);
    }
    // Skill 同步完成后注入 registry + 收紧 strict 模式
    // deps 是引用类型——修改后 route() 的每次请求都会读到最新值
    engineApiDeps.registry = loadRegistry();
    const artifactsResult = ensureAllArtifacts();
    if (artifactsResult.synced > 0 || artifactsResult.fixed > 0) {
      log.info("Skill artifacts verified", {
        synced: artifactsResult.synced,
        fixed: artifactsResult.fixed,
        broken: artifactsResult.broken.length > 0 ? artifactsResult.broken : undefined,
      });
    }
    if (artifactsResult.broken.length > 0) {
      log.warn("Some skills have broken artifacts and could not be fixed", {
        broken: artifactsResult.broken,
      });
    }
    engineApiDeps.strictCapabilities = true;
    log.info("Engine API capability check: strict mode enabled");
  } catch (e) {
    log.warn("Skill sync failed (non-fatal, capability check stays lenient)", {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // S6: 压力管线 dry-run — 跑一遍 pressures → tensionMap → loudness → selectAction
  // 不推进 tick、不写 DB、不入队，只验证计算管线无异常 / 无 NaN
  // @see docs/adr/54-pre-mortem-safety-net.md §S6
  try {
    const dryPressures = computeAllPressures(G, clock.tick, {
      kappa: config.kappa,
      threadAgeScale: config.threadAgeScale,
      mu: config.mu,
      d: config.d,
      deltaDeadline: config.delta,
    });
    const dryTensionMap = buildTensionMap(
      dryPressures.contributions,
      dryPressures.prospectContributions,
    );
    const { loudness: dryLoudness } = computeLoudness(
      dryTensionMap,
      personalityRef.current,
      G,
      clock.tick,
      {
        recentEventCounts,
        targetWhitelist: config.focusWhitelist,
      },
    );
    const [, dryAction] = selectAction(dryLoudness);

    // 验证无 NaN
    const pValues = [
      dryPressures.P1,
      dryPressures.P2,
      dryPressures.P3,
      dryPressures.P4,
      dryPressures.P5,
      dryPressures.P6,
      dryPressures.API,
      dryPressures.API_peak,
    ];
    const hasNaN = pValues.some((v) => Number.isNaN(v)) || dryLoudness.some((v) => Number.isNaN(v));
    if (hasNaN) {
      log.fatal("Pressure pipeline dry-run produced NaN", {
        pressures: pValues.map((v) => v.toFixed(4)),
        loudness: dryLoudness.map((v) => v.toFixed(4)),
      });
      writeAuditEvent(-1, "fatal", "startup", "Pressure pipeline NaN", {
        pressures: pValues,
        loudness: Array.from(dryLoudness),
      });
      process.exit(1);
    }

    log.info("Pressure pipeline dry-run passed", {
      API: dryPressures.API.toFixed(3),
      P1: dryPressures.P1.toFixed(3),
      P6: dryPressures.P6.toFixed(3),
      entities: dryTensionMap.size,
      selectedVoice: dryAction,
    });
  } catch (err) {
    log.fatal("Pressure pipeline dry-run failed", { error: err });
    writeAuditEvent(-1, "fatal", "startup", "Pressure pipeline exception", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  // S7: Docker sandbox session 预热 — 在第一个 tick 前创建容器，消除冷启动延迟
  // 致命：sandbox 起不来 = 所有 shell 命令都无法执行，runtime 无意义
  try {
    const { warmupSandboxSession } = await import("./skills/container-runner.js");
    await warmupSandboxSession(enginePort);
    log.info("Docker sandbox session pre-warmed");
  } catch (err) {
    log.fatal("Docker sandbox session warmup failed — cannot execute shell commands", {
      error: err instanceof Error ? err.message : String(err),
    });
    writeAuditEvent(clock.tick, "error", "safety-net", "S7: Docker sandbox warmup failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  // ── 安全网预检完成 ─────────────────────────────────────────────────────────

  // 6. 启动三线程
  const evolveController = startEvolveLoop(evolveState);
  const actPromise = startActLoop(actCtx);
  log.info("EVOLVE + ACT loops started", {
    dtMin: config.dtMin,
    dtMax: config.dtMax,
    kappaT: config.kappaT,
    startTick: clock.tick,
  });

  const runtimeHeartbeat = setInterval(() => {
    try {
      recordRuntimeHeartbeat(G);
    } catch (e) {
      log.warn("Runtime heartbeat failed", { error: e });
    }
  }, RUNTIME_HEARTBEAT_INTERVAL_MS);

  // ADR-33: 定期保存 Mod 状态 + 维护（与图快照对齐）
  // 使用 snapshotIntervalS 的墙钟秒数作为 setInterval 间隔
  let stickerSyncCounter = 0;
  const snapshotAndMaintain = setInterval(() => {
    try {
      const tick = clock.tick;
      dispatcher.saveModStatesToDb(tick);
      // F8 fix: 人格快照随墙钟定时器保存，不依赖 tick 计数
      savePersonalitySnapshot(tick, personalityRef.current);
      // 每次快照间隔执行日志清理
      if (tick > 0) {
        const alerts = runMaintenance(tick, G, {
          rhythmProfileRebuild: {
            intervalMs: config.rhythmProfileRebuildIntervalS * 1000,
            timezoneOffset: config.timezoneOffset,
          },
        });
        if (alerts.length > 0) {
          dispatcher.dispatch("UPDATE_ANOMALIES", { anomalies: alerts });
        }
      }
      // ADR-168 Wave 2: 贴纸同步（每 5 次快照间隔 = snapshotIntervalS × 5 秒）
      stickerSyncCounter++;
      if (stickerSyncCounter >= 5) {
        stickerSyncCounter = 0;
        syncInstalledSets(client, getDb()).catch((e) => {
          log.warn("Periodic sticker sync failed (non-fatal)", { error: e });
        });
      }
    } catch (e) {
      log.error("snapshotAndMaintain failed", e);
    }
  }, config.snapshotIntervalS * 1000);

  // 7. 优雅退出
  let shutdownInProgress = false;
  const shutdown = async () => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    log.info("Shutting down...");

    // 停定期任务
    clearInterval(runtimeHeartbeat);
    clearInterval(snapshotAndMaintain);
    oneBotReceiver?.close();

    // 关闭 Engine API
    if (engineApiCleanup) {
      try {
        await engineApiCleanup();
      } catch (e) {
        log.warn("Engine API cleanup error (ignored)", { error: e });
      }
    }

    // 停 EVOLVE
    evolveController.abort();

    // 停 ACT
    queue.close();
    await actPromise;

    // 保存最终状态
    if (G.has(ALICE_SELF)) {
      const shutdownMs = Date.now();
      G.updateAgent(ALICE_SELF, {
        runtime_last_seen_ms: shutdownMs,
        runtime_shutdown_ms: shutdownMs,
      });
    }
    flushGraph(G);
    savePersonalitySnapshot(clock.tick, personalityRef.current);
    dispatcher.saveModStatesToDb(clock.tick);
    log.info("Final snapshot saved", { tick: clock.tick });

    // 清理
    await destroyClient();
    closeGroupCache();
    closeMediaCache();
    closeDb();
    log.info("Shutdown complete");
    // P1-3: 给予 I/O 回调缓冲时间（TCP FIN、MTProto session 保存等），
    // 避免 process.exit(0) 截断异步清理。
    const SHUTDOWN_IO_BUFFER_MS = 2000;
    setTimeout(() => process.exit(0), SHUTDOWN_IO_BUFFER_MS);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("unhandledRejection", (reason) => {
    log.error("Unhandled rejection", {
      error: reason instanceof Error ? reason.message : String(reason),
    });
  });
}

main().catch((err) => {
  log.fatal("Fatal error", err);
  process.exit(1);
});
