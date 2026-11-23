/**
 * 生产入口，只做组装：平台入站 → Journal → step() → 外壳执行副作用 → 结果写回 Journal。
 * 平台按 ALICE_PLATFORM 选（telegram 默认，或 qq：OneBot v11），见 src/platform.ts。
 * `--check`：校验配置、打开并迁移数据库、fold 日志、组装，然后退出；不连平台，不调模型。
 * `--login`：只登录 Telegram（交互输入验证码、两步验证密码），写好 alice.session 后退出；不碰 Journal。
 */
import { execFile } from "node:child_process";
import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  loadConfig,
  loadRuntimeConfig,
  operatorScopes,
  type PlatformConfig,
  type RuntimeConfig,
} from "./config.js";
import { closeDb, getSqlite, initDb } from "./db/connection.js";
import { appendEvent, forEachEvent } from "./journal.js";
import { loadDomains, summarizeDeskNotes } from "./llm/domains.js";
import { Errands } from "./llm/errand.js";
import { createGateway, type Gateway } from "./llm/gateway.js";
import { fetchHnTop } from "./llm/hn.js";
import { localTagger, seeFrame, transcribeVoice } from "./llm/perceive.js";
import { callSpeechModel, pickSpeechModel, SPEECH_MODELS } from "./llm/speech-model.js";
import { StickerCache } from "./llm/sticker-perceive.js";
import { perceiveMood, perceiveTone } from "./llm/tone.js";
import { productionMechanisms } from "./mechanisms/registry.js";
import { searchChatArchive } from "./memory-fts.js";
import type { AliceEvent } from "./mind/events.js";
import { Failed } from "./mind/failure.js";
import { isAsleepIn, isRotating, type Mind } from "./mind/rotation.js";
import { noiseSource } from "./noise-source.js";
import { gated, whenRunning } from "./ops/gate.js";
import { Operator } from "./ops/operator.js";
import { SpendMeter } from "./ops/spend.js";
import type { Platform } from "./platform.js";
import { PlatformHub } from "./platform-hub.js";
import { withPromptLog } from "./prompt-log.js";
import { QQPlatform } from "./qq/platform.js";
import { codeVersion, recordRun } from "./runs.js";
import { ALICE_DB_PATH, ALICE_STATE_DIR, ensureParentDir } from "./runtime-paths.js";
import { createFold, Shell, type ShellPorts } from "./shell.js";
import { rotationOf } from "./sim/will-arms.js";
import { acquireSingleInstanceLock, SingleInstanceLockError } from "./single-instance.js";
import { applyAccountIdentity } from "./speech/prompt.js";
import { perceiveSticker, syncStickerCache } from "./sticker-palette.js";
import { createClient, destroyClient, startClient } from "./telegram/client.js";
import { TelegramPlatform } from "./telegram/platform.js";
import { TRACE_EVERY_MS, traceWriter } from "./trace-log.js";
import { closeLogger, createLogger, onProblemLogged } from "./utils/logger.js";

const log = createLogger("runtime");

/** 心跳日志的间隔。 */
const HEARTBEAT_MS = 5 * 60_000;
/** 停下之后最多等这么久让连接、计时器自己散掉，再强制退出（pm2 的 kill_timeout 是 30 秒）。 */
const EXIT_GRACE_MS = 5_000;
/** 停机时等后台任务（对话轮询、查询群资料）结束的上限：它们已被中止，不该超过这个时间还拖着不让关库。 */
const BACKGROUND_GRACE_MS = 3_000;
/** 拉 HN 热门的最短间隔。 */
const HN_EVERY_MS = 30 * 60_000;
/** 多久看一次该不该拉 HN 热门（以前跟着 Telegram 的对话轮询走，同一个间隔）。 */
const HN_CHECK_MS = 3 * 60_000;

/** 出错退出时也要关掉的 PlatformHub 和看贴纸缓存。 */
let activeHub: PlatformHub | null = null;
let activeStickerCache: StickerCache | null = null;

async function login(): Promise<void> {
  if ((process.env.ALICE_PLATFORM?.trim() || "telegram") !== "telegram") {
    throw new Error("--login is only for ALICE_PLATFORM=telegram");
  }
  acquireSingleInstanceLock(join(ALICE_STATE_DIR, "alice.lock"));
  const config = loadConfig();
  const client = createClient(config);
  try {
    await startClient(client, config.telegramPhone);
    const self = await client.getMe();
    log.info("Logged in; session saved", { selfId: String(self.id), name: self.displayName });
  } finally {
    await destroyClient();
  }
}

/** 按配置构造一个平台实例；构造不连网络（--check 也构造）。 */
function createPlatform(
  platformConfig: PlatformConfig,
  config: RuntimeConfig,
  gateway: Gateway,
  persona: string,
): Platform {
  const common = { gateway, ignoredSenders: config.ignoredSenders, tts: config.tts };
  // 两个平台的数字 id 是两套号码：QQ 上的操作员只认 QQ 号（ops/config.ts）。
  if (platformConfig.name === "qq") {
    return new QQPlatform(platformConfig, {
      ...common,
      operatorId: config.ops.qqOperatorId,
      stateDir: ALICE_STATE_DIR,
    });
  }
  return new TelegramPlatform(platformConfig, {
    ...common,
    operatorId: config.ops.operatorId,
    persona,
    voiceCalls: config.voiceCalls,
    speechModel: config.speechModel,
  });
}

/** 先用看图缓存补全各平台的贴纸库（零模型调用）。 */
function refineStickerPalettes(cache: StickerCache, platforms: readonly string[]): void {
  const entries = cache.entries();
  for (const platform of platforms) {
    const refinedStickers = syncStickerCache(entries, platform);
    if (refinedStickers > 0) {
      log.info("Refined sticker palette from VLM cache", { platform, refinedStickers });
    }
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--login")) return login();
  const check = process.argv.includes("--check");
  // 单实例锁在任何连接之前获取；检查模式不连平台，不占锁。
  if (!check) acquireSingleInstanceLock(join(ALICE_STATE_DIR, "alice.lock"));

  // 全部配置一次读完、校验完（--check 也在这里拦下写错的声音名、开关）。
  const config = loadRuntimeConfig();
  const opsConfig = config.ops;
  const persona = readFileSync(new URL("../SOUL.md", import.meta.url), "utf8");
  if (!persona.trim()) throw new Error("SOUL.md is empty");

  ensureParentDir(ALICE_DB_PATH);
  initDb(ALICE_DB_PATH);
  const spend = new SpendMeter(join(ALICE_STATE_DIR, "spend"), Date.now, (error) =>
    log.warn("Spend ledger write failed", error),
  );
  // 操作员控制面要在任何模型调用之前就位：花费从第一次调用起记，暂停状态从上次运行接着来。
  let shell: Shell | null = null;
  let shutdown: (exitCode: number) => Promise<void> = async () => {};
  const operator = new Operator(
    {
      now: Date.now,
      // 平台还没构造好或还没连上时，无法通知操作员（平台在连上之前自己也不会发）。
      send: async (text) => activeHub?.sendToOperator(text),
      stop: () => {
        // 在 pm2 下：请 pm2 自己停（列表里显示 stopped，它发 SIGINT 过来走同一条关停路）。
        // 不在 pm2 下或 pm2 叫不动：自己以 0 退出（ecosystem 的 stop_exit_codes 让 pm2 不再拉起）。
        const pmId = process.env.pm_id;
        if (pmId === undefined) void shutdown(0);
        else execFile("pm2", ["stop", pmId], (error) => error && void shutdown(0));
      },
      state: () => shell?.current ?? folded.state,
      log: (message, fields) => log.info(message, fields),
      selftest: async () => activeHub?.selftest() ?? "还没连上平台。",
    },
    {
      operatorId: opsConfig.operatorId,
      operatorScopes: operatorScopes(config),
      controlPath: join(ALICE_STATE_DIR, "ops-control.json"),
      spend,
      capUsd: opsConfig.capUsd,
    },
  );
  // 所有模型调用经这一个网关，每次调用当场记账（到了日上限就暂停）。
  const gateway = createGateway({
    apiKey: config.speech.apiKey,
    charge: (spent) => operator.charge(spent),
  });
  // 看图时和看图模型一起问本机标注器（角色、标签、尺度）；没配就只有描述。
  const tagger = config.taggerUrl ? localTagger(config.taggerUrl) : null;
  // 看贴纸的缓存各平台共用一份（键带平台），在构造平台之前补全各平台的贴纸库，平台读到的张数才是补全后的。
  const stickerCache = new StickerCache(join(ALICE_STATE_DIR, "sticker-cache.db"));
  activeStickerCache = stickerCache;
  refineStickerPalettes(
    stickerCache,
    config.platforms.map((p) => p.name),
  );

  const hub = new PlatformHub(
    config.platforms.map((p) => createPlatform(p, config, gateway, persona)),
  );
  activeHub = hub;
  // "查一下"的开关、按会话查询的平台能力与多平台注意力层级在这里接入：支持单平台共享或按平台独立节奏与竞争。
  const mechanisms = productionMechanisms(
    config.errands !== null,
    (scope) => hub.capabilitiesFor(scope),
    config.platformAttention,
  );
  // 线上轮换（PLAN 第 25 件）：配了候选就挂两套，分组按种子算、换组记进 Journal；没配就只有生产。
  const mind: Mind = config.rotation
    ? rotationOf(
        config.rotation,
        config.errands !== null ? ["errand"] : [],
        (scope) => hub.capabilitiesFor(scope),
        config.platformAttention,
      )
    : mechanisms;
  const rotation = isRotating(mind) ? mind.rotation : null;
  const errands = config.errands
    ? new Errands({
        gateway,
        exaKey: config.errands.exaKey,
        domains: await loadDomains(config.errands.domains),
      })
    : null;
  const background = backgroundPort(errands);
  // Journal 的投影：启动 fold 和运行时都只从写进了日志的事件更新（同一个函数）。
  const seenHn = new Set<string>();
  const project = (event: AliceEvent) => {
    if (event.type === "post.received" && event.scope === "hn:top") seenHn.add(event.messageId);
  };
  const fold = createFold(mind, (event, state) => {
    project(event);
    hub.observe(event, state, "fold");
  });
  const counts = forEachEvent((event) => fold.feed(event));
  const folded = fold.result();
  const promptLogDir = config.promptLogDir;
  const version = codeVersion();
  log.info("Journal folded", {
    ...version,
    db: ALICE_DB_PATH,
    stateDir: ALICE_STATE_DIR,
    promptLogs: promptLogDir,
    events: counts.read,
    skippedLegacyRows: counts.skipped,
    chats: Object.keys(folded.state.chats).length,
    pendingTimers: folded.timers.length,
    interruptedCalls: folded.interrupted.length,
    mechanisms: mechanisms.map((m) => m.name),
    rotation,
    speechModel: config.speechModel,
    speechModels: config.speechModels,
    ponderModel: config.ponderModel,
    platformAttention: config.platformAttention,
    tts: config.tts ? `${config.tts.provider}/${config.tts.model}` : null,
    ...hub.startupInfo(),
    paused: operator.paused,
    spentTodayUsd: Number(spend.today().total.toFixed(4)),
    dailyCapUsd: operator.cap(),
  });

  if (check) {
    log.info("Startup check passed");
    await hub.stop();
    activeHub = null;
    stickerCache.close();
    activeStickerCache = null;
    closeDb();
    return;
  }

  onProblemLogged(() => operator.watch.errorLogged());

  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let hnTimer: ReturnType<typeof setInterval> | null = null;
  let traceTimer: ReturnType<typeof setInterval> | null = null;
  let shuttingDown = false;
  // 后台任务（对话轮询、查询群资料、启动时拉群列表）：停机时先中止，再等它们结束，最后才关连接、关库。
  const bgAbort = new AbortController();
  const bgTasks = new Set<Promise<void>>();
  const track = <T>(task: Promise<T>): Promise<T> => {
    const tracked = task.then(
      () => {},
      () => {},
    );
    bgTasks.add(tracked);
    void tracked.finally(() => bgTasks.delete(tracked));
    return task;
  };
  shutdown = async (exitCode: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("Shutting down", { exitCode });
    if (heartbeat) clearInterval(heartbeat);
    if (hnTimer) clearInterval(hnTimer);
    if (traceTimer) clearInterval(traceTimer);
    // 还没发出去的后台请求不再发（reason 是 Failed interrupted，和外壳停机的说法一致），在途的尽快结束。
    bgAbort.abort(new Failed({ reason: "interrupted" }));
    await shell?.stop();
    // 等它们把正在写的日志、投影写完再关库；超过上限就不等了（请求已经中止，剩下的是收尾）。
    await Promise.race([
      Promise.all([...bgTasks]),
      sleep(BACKGROUND_GRACE_MS, undefined, { ref: false }),
    ]);
    await hub.stop();
    activeHub = null;
    stickerCache.close();
    activeStickerCache = null;
    closeDb();
    await closeLogger();
    process.exitCode = exitCode;
    setTimeout(() => process.exit(exitCode), EXIT_GRACE_MS).unref();
  };

  // 暂停在端口这一层生效（ops/gate.ts）：暂停时每个端口立即拒绝，进行中的后台任务被中止。
  const ports: ShellPorts = gated(
    {
      now: () => Date.now(),
      append: (event) => void appendEvent(event),
      journaled: (event, state) => {
        project(event);
        hub.observe(event, state, "live");
        // 自检只看运行时的事件（不看 fold 的历史）；出错不能冒充 Journal 写入失败（那会让外壳停下）。
        try {
          operator.observe(event);
        } catch (error) {
          log.warn("Ops observe failed", error);
        }
      },
      callModel: withPromptLog(
        (prompt, call, signal) => {
          const chosen =
            call.kind === "ponder"
              ? config.ponderModel
              : pickSpeechModel(config.speechModels, call, prompt);
          return callSpeechModel(gateway, prompt, {
            kind: call.kind,
            model: chosen,
            signal,
          });
        },
        promptLogDir,
        {
          sha: version.sha,
          model: (prompt, call) => {
            const chosen =
              call.kind === "ponder"
                ? config.ponderModel
                : pickSpeechModel(config.speechModels, call, prompt);
            return SPEECH_MODELS[chosen].id;
          },
        },
        (error) => log.warn("Prompt log write failed", error),
      ),
      act: (scope, act, signal) => hub.act(scope, act, signal),
      // 叫醒她时判冲着她的话的口气（Jev），和发言调用并发；结果写进 Journal，敌意的那条不算一次往来。
      perceiveTone: (chatType, lines, ids, signal) =>
        perceiveTone(gateway, chatType, lines, ids, signal),
      // 她写下的心情（她自己的词）是好是坏：同一个判口气的模型，写进那条心情的事件里。
      perceiveMood: (mood, signal) => perceiveMood(gateway, mood, signal),
      background,
      query: queryPort(hub, errands),
      schedule: (delayMs, fire) => {
        const timer = setTimeout(fire, delayMs);
        return () => clearTimeout(timer);
      },
      fatal: (error) => {
        log.fatal("Journal write failed; stopping", error);
        void shutdown(1);
      },
      log: (message, fields) => log.info(message, fields),
      stickers: (scope) => hub.stickers(scope),
      searchArchive: (scope, query, subject) =>
        searchChatArchive(getSqlite(), { scope, query, subject }),
      readDeskSummary: () => summarizeDeskNotes(join(ALICE_STATE_DIR, "desk")),
      paused: () => operator.paused,
    },
    operator,
  );
  // 她自己的随机性（mind/noise.ts）：种子每次启动取一次，抽出的数写进 Journal，fold 与回放只读日志。
  const running = new Shell(
    ports,
    mind,
    persona,
    folded,
    undefined,
    noiseSource(randomInt(2 ** 31)),
  );
  shell = running;

  const { selfIds, selfNames } = await hub.start({
    dispatch: (event) => {
      // 操作员私聊里的 /ops 命令：在这里处理，不进 Journal，不进她的时间线。
      if (operator.intercept(event)) return;
      running.dispatch(event);
    },
    now: () => ports.now(),
    state: () => running.current,
    pause: operator,
    perceive: {
      image: whenRunning(operator, (jpeg) => seeFrame(gateway, tagger, jpeg, "photo")),
      gif: whenRunning(operator, (jpeg) => seeFrame(gateway, tagger, jpeg, "gif")),
      video: whenRunning(operator, (jpeg) => seeFrame(gateway, tagger, jpeg, "video")),
      voice: whenRunning(operator, (ogg) => transcribeVoice(gateway, ogg)),
      sticker: whenRunning(operator, perceiveSticker(gateway, stickerCache)),
    },
    signal: bgAbort.signal,
    track,
    connection: (state) => operator.watch.connection(state),
    warn: (message, error) => log.warn(message, error),
  });
  const accountName = selfNames.telegram ?? Object.values(selfNames)[0];
  running.setPersona(
    applyAccountIdentity(persona, { selfName: accountName, platforms: hub.names }),
  );
  running.start();
  heartbeat = setInterval(() => log.info("heartbeat", operator.heartbeat()), HEARTBEAT_MS);
  heartbeat.unref();
  // 意愿层快照（trace-log.ts）：只读她此刻的状态，写进 live/traces/，不进 Journal、不改她做什么。
  const writeTrace = traceWriter(join(ALICE_STATE_DIR, "traces"), version.sha, (error) =>
    log.warn("Trace snapshot write failed", error),
  );
  traceTimer = setInterval(() => writeTrace(running.current, Date.now()), TRACE_EVERY_MS);
  traceTimer.unref();
  const pullHn = hnFeed(
    seenHn,
    (event) => running.dispatch(event),
    () => ports.now(),
    // ADR-276 环节一：睡着或暂停时不拉 HN 热门。
    (now) => operator.paused || isAsleepIn(mind, running.current, now),
  );
  let hnRun: Promise<void> | null = null;
  hnTimer = setInterval(() => {
    if (hnRun) return;
    const run = pullHn()
      .catch((error: unknown) => {
        if (!bgAbort.signal.aborted) log.warn("HN pull failed", error);
      })
      .finally(() => {
        if (hnRun === run) hnRun = null;
      });
    hnRun = run;
    void track(run);
  }, HN_CHECK_MS);
  hnTimer.unref();
  log.info("Alice runtime started", {
    platforms: hub.names,
    selfIds,
    journal: ALICE_DB_PATH,
    paused: operator.paused,
    ...version,
  });
  // 每次启动一行：哪一版代码、哪些机制（以后用同一版代码重放 Journal）。
  recordRun(
    join(ALICE_STATE_DIR, "runs.jsonl"),
    {
      at: Date.now(),
      ...version,
      mechanisms: mechanisms.map((m) => m.name),
      ...(rotation ? { rotation } : {}),
      speechModel: config.speechModels.join(","),
    },
    (error) => log.warn("Run record write failed", error),
  );
  void hub
    .sendToOperator(
      `上线了${operator.paused ? "（仍在暂停，/ops resume 继续）" : ""}。/ops help 看命令。`,
    )
    .catch((error) => log.warn("Operator message failed", error));

  process.once("SIGINT", () => void shutdown(0));
  process.once("SIGTERM", () => void shutdown(0));
}

/** 后台的事只有"查一下"一种；没开就当即拒绝。 */
function backgroundPort(errands: Errands | null): ShellPorts["background"] {
  if (!errands) {
    return async () => {
      throw new Failed({ reason: "unavailable" });
    };
  }
  return async (_scope, act, context, signal) => {
    if (act.kind !== "delegate") throw new Failed({ reason: "unavailable" });
    // 每次模型调用和搜索由网关当场记账；合计另随结果写进 act.done / act.failed 的 usage（研究用）。
    return errands.run(act.task, context, Date.now(), signal);
  };
}

/** PTC 代码里当场执行的查询：交出去办的事由运行时处理，相册、找群等由 PlatformHub 按会话分给对应平台。 */
function queryPort(hub: PlatformHub, errands: Errands | null): NonNullable<ShellPorts["query"]> {
  return async (scope, kind, act, context, signal) => {
    if (kind !== "delegate") return hub.query(scope, kind, act, signal);
    if (!errands) throw new Failed({ reason: "unavailable" });
    const task = act.kind === "delegate" ? act.task : "";
    const done = await errands.run(task, context, Date.now(), signal);
    return { value: done.result, result: done.result, usage: done.usage };
  };
}

/** 刷手机看公开榜单：resting 为真或离上次不到 HN_EVERY_MS 就不拉，见过的条目不再进时间线。 */
function hnFeed(
  seen: Set<string>,
  dispatch: (event: AliceEvent) => void,
  now: () => number,
  resting: (now: number) => boolean,
): () => Promise<void> {
  let lastAt = 0;
  return async () => {
    const at = now();
    if (resting(at) || at - lastAt < HN_EVERY_MS) return;
    lastAt = at;
    const stories = await fetchHnTop(5);
    for (const s of stories) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      dispatch({
        type: "post.received",
        at: now(),
        scope: "hn:top",
        messageId: s.id,
        title: "Hacker News",
        text: s.url ? `${s.title}\n${s.url}` : s.title,
      });
    }
  };
}

main().catch(async (error) => {
  if (error instanceof SingleInstanceLockError) log.fatal(error.message);
  else log.fatal("Runtime failed", error);
  await activeHub?.stop().catch(() => {});
  activeStickerCache?.close();
  closeDb();
  await closeLogger();
  process.exitCode = 1;
});
