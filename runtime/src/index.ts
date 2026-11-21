/**
 * 生产入口，只做组装：Telegram 入站 → Journal → step() → 外壳执行副作用 → 结果写回 Journal。
 * `--check`：校验配置、打开并迁移数据库、折叠日志、组装，然后退出；不连 Telegram，不调模型。
 * `--login`：只登录 Telegram（交互输入验证码、两步验证密码），写好 alice.session 后退出；不碰 Journal。
 */
import { execFile } from "node:child_process";
import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig, loadRuntimeConfig } from "./config.js";
import { closeDb, initDb } from "./db/connection.js";
import { appendEvent, forEachEvent } from "./journal.js";
import { Errands } from "./llm/errand.js";
import { chatTokens, createGateway } from "./llm/gateway.js";
import { fetchHnTop } from "./llm/hn.js";
import { localTagger, seeFrame, transcribeVoice } from "./llm/perceive.js";
import { rerank } from "./llm/rerank.js";
import { callSpeechModel, SPEECH_MODELS } from "./llm/speech-model.js";
import { describeSticker, formatStickerMedia, StickerCache } from "./llm/sticker-perceive.js";
import { perceiveMood, perceiveTone } from "./llm/tone.js";
import { synthesizeSpeech } from "./llm/tts.js";
import { CALL_TONE, VoiceCallSession } from "./llm/voice-call.js";
import { productionMechanisms } from "./mechanisms/registry.js";
import type { AliceEvent } from "./mind/events.js";
import { Failed } from "./mind/failure.js";
import { isAsleepIn, isRotating, type Mind } from "./mind/rotation.js";
import type { AliceState } from "./mind/state.js";
import { STICKER_WORDS } from "./mind/words.js";
import { noiseSource } from "./noise-source.js";
import { gated, whenRunning } from "./ops/gate.js";
import { Operator } from "./ops/operator.js";
import { SpendMeter } from "./ops/spend.js";
import { withPromptLog } from "./prompt-log.js";
import { codeVersion, recordRun } from "./runs.js";
import { ALICE_DB_PATH, ALICE_STATE_DIR, ensureParentDir } from "./runtime-paths.js";
import { createFold, Shell, type ShellPorts } from "./shell.js";
import { rotationOf } from "./sim/will-arms.js";
import { acquireSingleInstanceLock, SingleInstanceLockError } from "./single-instance.js";
import { executeAct } from "./telegram/acts.js";
import { Album } from "./telegram/album.js";
import { CATCH_UP_MS, catchUp, dialogScopes, Groups, Inbox } from "./telegram/catch-up.js";
import { createClient, createDispatcher, destroyClient, startClient } from "./telegram/client.js";
import { discover } from "./telegram/discover.js";
import { isTelegramActionError } from "./telegram/errors.js";
import { Acquaintances } from "./telegram/first-dm.js";
import { Gates, Telegram } from "./telegram/gates.js";
import {
  listStickerHints,
  paletteSize,
  resolveStickerFileId,
  syncStickerCache,
  unresolvedStickerWords,
  upsertStickerPerception,
} from "./telegram/palette.js";
import {
  createMtcuteCallClient,
  type PhoneCallSignalingUpdate,
  type PhoneCallUpdate,
  TelegramPhoneCalls,
} from "./telegram/phone-call.js";
import { describeRoom, pullReactions, Scene } from "./telegram/scene.js";
import { Shelf } from "./telegram/shelf.js";
import { bindTelegramWorldAdapter, targetOf } from "./telegram/world-adapter.js";
import { TRACE_EVERY_MS, traceWriter } from "./trace-log.js";
import { closeLogger, createLogger, onProblemLogged } from "./utils/logger.js";

const log = createLogger("runtime");

/** 心跳日志的间隔。 */
const HEARTBEAT_MS = 5 * 60_000;
/** 停下之后最多等这么久让连接、计时器自己散掉，再强制退出（pm2 的 kill_timeout 是 30 秒）。 */
const EXIT_GRACE_MS = 5_000;
/** 停机时等后台的事（对话轮询、查群的样子）收尾的上限：它们已经中止，不该在这个上限之外拖住关库。 */
const BACKGROUND_GRACE_MS = 3_000;

async function login(): Promise<void> {
  acquireSingleInstanceLock(join(ALICE_STATE_DIR, "alice.lock"));
  const config = loadConfig();
  const client = createClient(config);
  await startClient(client, config.telegramPhone);
  const self = await client.getMe();
  log.info("Logged in; session saved", { selfId: String(self.id), name: self.displayName });
  await destroyClient();
}

async function main(): Promise<void> {
  if (process.argv.includes("--login")) return login();
  const check = process.argv.includes("--check");
  // 单实例锁在任何连接之前获取；检查模式不连 Telegram，不占锁。
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
  let sendToOperator: (text: string) => Promise<void> = async () => {};
  let selftest: () => Promise<string> = async () => "还没连上 Telegram。";
  let shell: Shell | null = null;
  let shutdown: (exitCode: number) => Promise<void> = async () => {};
  const operator = new Operator(
    {
      now: Date.now,
      send: (text) => sendToOperator(text),
      stop: () => {
        // 在 pm2 下：请 pm2 自己停（列表里显示 stopped，它发 SIGINT 过来走同一条关停路）。
        // 不在 pm2 下或 pm2 叫不动：自己以 0 退出（ecosystem 的 stop_exit_codes 让 pm2 不再拉起）。
        const pmId = process.env.pm_id;
        if (pmId === undefined) void shutdown(0);
        else execFile("pm2", ["stop", pmId], (error) => error && void shutdown(0));
      },
      state: () => shell?.current ?? folded.state,
      log: (message, fields) => log.info(message, fields),
      selftest: () => selftest(),
    },
    {
      operatorId: opsConfig.operatorId,
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

  // 查一下的开关只在这里判一次：关着时她看不到这个动作，后台端口也没有执行者。
  const mechanisms = productionMechanisms(config.errands !== null);
  // 线上轮换（PLAN 第 25 件）：配了候选就挂两套，分组按种子算、换组记进 Journal；没配就只有生产。
  const mind: Mind = config.rotation
    ? rotationOf(config.rotation, config.errands !== null ? ["errand"] : [])
    : mechanisms;
  const rotation = isRotating(mind) ? mind.rotation : null;
  const errands = config.errands ? new Errands({ gateway, exaKey: config.errands.exaKey }) : null;
  const background: ShellPorts["background"] = errands
    ? async (_scope, act, context, signal) => {
        if (act.kind !== "delegate") throw new Failed({ reason: "unavailable" });
        // 每次模型调用和搜索由网关当场记账；合计另随结果写进 act.done / act.failed 的 usage（研究用）。
        return errands.run(act.task, context, Date.now(), signal);
      }
    : async () => {
        throw new Failed({ reason: "unavailable" });
      };
  const album = new Album((query, documents, top) => rerank(gateway, query, documents, top));
  const stickerCache = new StickerCache(join(ALICE_STATE_DIR, "sticker-cache.db"));
  const shelf = new Shelf();
  // 她在群里见过谁、和谁有过私聊来往：第一次私聊前经共同的群拿到对方（telegram/first-dm.ts）。
  const acquaintances = new Acquaintances();
  // 执行器的限额（加群、找群、连发）：从 Journal 恢复计数，重启不清零。
  const gates = new Gates();
  // Journal 的投影：启动折叠和运行时都只从写进了日志的事件更新（同一个函数）。
  // 她见过的消息（推送和对话轮询补拉的去重、找缺口，telegram/catch-up.ts）。
  const inbox = new Inbox();
  // 她在哪些群里：启动后才出现的群按刚被拉进来算。
  const groups = new Groups();
  // 现场事实（telegram/scene.ts）：每条消息、每个群最后写进 Journal 的样子，只写变了的。
  const scene = new Scene();
  const seenHn = new Set<string>();
  const project = (event: AliceEvent, state: AliceState) => {
    scene.observe(event);
    album.observe(event);
    shelf.observe(event, state);
    acquaintances.observe(event);
    gates.observe(event);
    inbox.observe(event);
    groups.observe(event);
    if (event.type === "post.received" && event.scope === "hn:top") seenHn.add(event.messageId);
  };
  const fold = createFold(mind, project);
  const counts = forEachEvent((event) => fold.feed(event));
  const folded = fold.result();
  const refinedStickers = syncStickerCache(stickerCache.entries());
  if (refinedStickers > 0) log.info("Refined sticker palette from VLM cache", { refinedStickers });
  const stickers = paletteSize();
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
    tts: config.tts ? `${config.tts.provider}/${config.tts.model}` : null,
    voiceCalls: config.voiceCalls,
    stickers,
    albumPhotos: album.size,
    paused: operator.paused,
    spentTodayUsd: Number(spend.today().total.toFixed(4)),
    dailyCapUsd: operator.cap(),
  });
  if (stickers === 0)
    log.warn("Sticker palette is empty: sticker sends will be recorded as failed");
  const unresolved = unresolvedStickerWords(STICKER_WORDS);
  if (unresolved.length > 0)
    log.warn("Sticker words with no sticker in the palette", { words: unresolved });

  if (check) {
    log.info("Startup check passed");
    closeDb();
    return;
  }

  const client = createClient(config);
  const dispatcher = createDispatcher(client);
  client.onConnectionState.add((state) => operator.watch.connection(state));
  await startClient(client, config.telegramPhone);
  const self = await client.getMe();
  const telegram = new Telegram(client, gates, undefined, acquaintances);
  sendToOperator = async (text) => {
    await client.sendText(Number(opsConfig.operatorId), text);
  };
  onProblemLogged(() => operator.watch.errorLogged());

  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let catchUpTimer: ReturnType<typeof setInterval> | null = null;
  let traceTimer: ReturnType<typeof setInterval> | null = null;
  let calls: TelegramPhoneCalls | null = null;
  let shuttingDown = false;
  // 后台的事（对话轮询、查群的样子、启动时的群列表）：停机时先中止，再等它们收尾，最后才关连接、关库。
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
    if (catchUpTimer) clearInterval(catchUpTimer);
    if (traceTimer) clearInterval(traceTimer);
    // 还没发出去的后台请求不再发（reason 是 Failed interrupted，和外壳停机的说法一致），在途的尽快结束。
    bgAbort.abort(new Failed({ reason: "interrupted" }));
    await calls?.dispose();
    await shell?.stop();
    // 等它们把正在写的日志、投影写完再关库；超过上限就不等了（请求已经中止，剩下的是收尾）。
    await Promise.race([
      Promise.all([...bgTasks]),
      sleep(BACKGROUND_GRACE_MS, undefined, { ref: false }),
    ]);
    await destroyClient();
    stickerCache.close();
    closeDb();
    await closeLogger();
    process.exitCode = exitCode;
    setTimeout(() => process.exit(exitCode), EXIT_GRACE_MS).unref();
  };

  /** 她做对外动作用的上下文（外壳的 act 端口和操作员自检共用一条执行路径）。 */
  const actContext = (scope: string, signal: AbortSignal) => ({
    telegram: telegram.with(signal),
    target: targetOf(scope),
    stickerFileId: resolveStickerFileId,
    album,
    shelf,
    scope,
    now: () => Date.now(),
    speak: (text: string) => {
      if (!config.tts) throw new Failed({ reason: "unavailable" });
      return synthesizeSpeech(config.tts, text, { signal, charge: gateway.charge });
    },
    // 发文字前"正在输入"的那几秒（telegram/typing.ts）；停机时不再等。
    pause: (ms: number) => sleep(ms, undefined, { signal }),
  });
  // 操作员自检：往操作员私聊发一张贴纸、一条语音，走和她一样的执行路径，不进 Journal。
  selftest = async () => {
    const scope = `telegram:${opsConfig.operatorId}`;
    const tries: Array<[string, Parameters<typeof executeAct>[1]]> = [
      ["贴纸", { kind: "sticker", word: "happy" }],
      ["语音", { kind: "voice", text: "喂，听得到吗？是我呀。" }],
    ];
    const lines: string[] = [];
    for (const [name, act] of tries) {
      try {
        await executeAct(actContext(scope, new AbortController().signal), act);
        lines.push(`${name}：发出去了`);
      } catch (error) {
        const why = isTelegramActionError(error) ? error.code : String(error).slice(0, 120);
        lines.push(`${name}：没发出去（${why}）`);
        log.warn("Selftest failed", { act: act.kind, error });
      }
    }
    return lines.join("\n");
  };

  // 暂停落在端口边界（ops/gate.ts）：暂停时每个端口当即拒绝，在办的后台的事被中止。
  const ports: ShellPorts = gated(
    {
      now: () => Date.now(),
      append: (event) => void appendEvent(event),
      journaled: (event, state) => {
        project(event, state);
        // 自检只看运行时的事件（不看折叠的历史）；出错不能冒充 Journal 写入失败（那会让外壳停下）。
        try {
          operator.observe(event);
        } catch (error) {
          log.warn("Ops observe failed", error);
        }
      },
      callModel: withPromptLog(
        (prompt, call, signal) =>
          callSpeechModel(gateway, prompt, { kind: call.kind, model: config.speechModel, signal }),
        promptLogDir,
        { sha: version.sha, model: SPEECH_MODELS[config.speechModel].id },
        (error) => log.warn("Prompt log write failed", error),
      ),
      act: (scope, act, signal) => executeAct(actContext(scope, signal), act),
      // 叫醒她时判冲着她的话的口气（Jev），和发言调用并发；结果写进 Journal，敌意的那条不算一次往来。
      perceiveTone: (chatType, lines, ids, signal) =>
        perceiveTone(gateway, chatType, lines, ids, signal),
      // 她写下的心情（她自己的词）是好是坏：同一个判口气的模型，写进那条心情的事件里。
      perceiveMood: (mood, signal) => perceiveMood(gateway, mood, signal),
      background,
      query: async (_scope, kind, act, context, signal) => {
        const at = Date.now();
        switch (kind) {
          case "album-search": {
            const q = act.kind === "album-search" ? act.query : "";
            const hits = await album.searchItems(q, at);
            const result =
              hits.length === 0
                ? `想找的“${q}”，相册里没有匹配的图。`
                : hits
                    .map(
                      (h) =>
                        `[${h.asset}] ${[h.description, h.caption && `配文“${h.caption}”`].filter(Boolean).join("，")}（${h.sender} ${h.ago}在群里发的）`,
                    )
                    .join("\n");
            return { value: hits, result };
          }
          case "chat-search": {
            const q = act.kind === "chat-search" ? act.query : "";
            const found = await discover(telegram.with(signal), q);
            return { value: found.found, result: found.text, found: found.found };
          }
          case "delegate": {
            if (!errands) throw new Failed({ reason: "unavailable" });
            const task = act.kind === "delegate" ? act.task : "";
            const done = await errands.run(task, context, at, signal);
            return {
              value: done.result,
              result: done.result,
              ...(done.usage ? { usage: done.usage } : {}),
            };
          }
          default:
            throw new Failed({ reason: "unavailable" }, `unsupported query: ${kind}`);
        }
      },
      schedule: (delayMs, fire) => {
        const timer = setTimeout(fire, delayMs);
        return () => clearTimeout(timer);
      },
      fatal: (error) => {
        log.fatal("Journal write failed; stopping", error);
        void shutdown(1);
      },
      log: (message, fields) => log.info(message, fields),
      stickers: () => listStickerHints(14),
      paused: () => operator.paused,
    },
    operator,
  );
  // 她自己的随机性（mind/noise.ts）：种子每次启动取一次，抽出的数写进 Journal，折叠与回放只读日志。
  const running = new Shell(
    ports,
    mind,
    persona,
    folded,
    undefined,
    noiseSource(randomInt(2 ** 31)),
  );
  shell = running;

  const adapter = bindTelegramWorldAdapter(dispatcher, {
    selfId: String(self.id),
    selfUsername: self.username ?? undefined,
    ignoredSenders: config.ignoredSenders,
    now: ports.now,
    onEvent: (event) => {
      // 操作员私聊里的 /ops 命令：在这里处理，不进 Journal，不进她的时间线。
      if (operator.intercept(event)) return;
      running.dispatch(event);
      // 群里有人说话、上次查群的样子超过 6 小时：再查一次，变了才写。
      if (
        event.type === "message.received" &&
        event.chatType === "group" &&
        scene.roomDue(event.scope, ports.now())
      ) {
        const described = describeRoom(telegram.with(bgAbort.signal), event.scope, ports.now)
          .then((room) => {
            if (room && scene.roomChanged(room)) running.dispatch(room);
          })
          .catch((error: unknown) => {
            // 停机中止不算没查成（限流、没权限这些别的错照记）。
            if (!bgAbort.signal.aborted) log.warn("Room description failed", error);
          });
        track(described);
      }
    },
    perceive: {
      image: whenRunning(operator, (jpeg) => seeFrame(gateway, tagger, jpeg, "photo")),
      gif: whenRunning(operator, (jpeg) => seeFrame(gateway, tagger, jpeg, "gif")),
      video: whenRunning(operator, (jpeg) => seeFrame(gateway, tagger, jpeg, "video")),
      voice: whenRunning(operator, (ogg) => transcribeVoice(gateway, ogg)),
      sticker: whenRunning(
        operator,
        async (
          meta: { fileId?: string; fileUniqueId?: string; emoji?: string; setTitle?: string },
          load: () => Promise<Uint8Array>,
        ) => {
          const id = meta.fileUniqueId;
          const cached = id ? stickerCache.get(id) : null;
          const perceived = cached ?? (await describeSticker(gateway, await load(), meta));
          if (id && !cached) stickerCache.set(id, perceived);
          if (id && meta.fileId) {
            upsertStickerPerception({
              fileId: meta.fileId,
              fileUniqueId: id,
              emoji: meta.emoji,
              setName: meta.setTitle,
              ...perceived,
            });
          }
          return formatStickerMedia(perceived, meta);
        },
      ),
    },
    warn: (message, error) => log.warn(message, error),
    admit: (scope, messageId) => inbox.admit(scope, messageId),
    newGroup: (scope) => groups.isNew(scope),
    scene: {
      stickerSet: (set, found) => scene.stickerSet(telegram.with(bgAbort.signal), set, found),
      changes: (scope, messageId, seen, at) => scene.changes(scope, messageId, seen, at),
    },
  });
  if (config.voiceCalls && config.tts) {
    const tts = config.tts;
    const callModel = SPEECH_MODELS[config.speechModel];
    const sessions = new Map<number, VoiceCallSession>();
    const voiceCalls = new TelegramPhoneCalls({
      client: createMtcuteCallClient(client),
      allowUser: (uid) =>
        !operator.paused &&
        !config.ignoredSenders.has(String(uid)) &&
        (String(uid) === opsConfig.operatorId || Boolean(running.current.chats[`telegram:${uid}`])),
      onConnected: (uid) => {
        const chat = running.current.chats[`telegram:${uid}`];
        const recent = (chat?.timeline ?? [])
          .slice(-8)
          .map((e) => `${e.sender ? e.sender.name : "Alice"}: ${e.text ?? `[${e.contentType}]`}`)
          .join("\n");
        const session = new VoiceCallSession({
          asr: (ogg) => transcribeVoice(gateway, ogg),
          reply: async (history, callerText) => {
            const { body } = await gateway.post<{
              choices?: Array<{ message?: { content?: string | null } }>;
              usage?: {
                prompt_tokens?: number;
                completion_tokens?: number;
                completion_tokens_details?: { reasoning_tokens?: number };
              };
            }>({
              kind: "speech",
              model: callModel.id,
              path: "/chat/completions",
              timeoutMs: 30_000,
              attempts: 2,
              tokens: chatTokens,
              body: {
                model: callModel.id,
                ...callModel.extra,
                max_tokens: 200 + callModel.thinking,
                messages: [
                  {
                    role: "system",
                    content: `${persona.trim()}\n\n${CALL_TONE}${recent ? `\n\n最近聊天：\n${recent}` : ""}`,
                  },
                  ...history.slice(-12).map((t) => ({
                    role: (t.role === "caller" ? "user" : "assistant") as "user" | "assistant",
                    content: t.text,
                  })),
                  ...(history.at(-1)?.role === "caller"
                    ? []
                    : [{ role: "user" as const, content: callerText }]),
                ],
              },
            });
            return body.choices?.[0]?.message?.content?.trim() ?? "";
          },
          speak: (text, signal) => synthesizeSpeech(tts, text, { signal, charge: gateway.charge }),
          sendFrame: (pcm, signal) => voiceCalls.sendAudioFrames(uid, pcm, { signal }),
          onEnd: (reason) => {
            sessions.delete(uid);
            if (reason === "hangup") void voiceCalls.hangup(uid).catch(() => {});
          },
          onError: (error) => log.warn("Voice call turn failed", { userId: uid, error }),
        });
        sessions.set(uid, session);
        void session.start();
      },
      onAudio: (uid, pcm) => sessions.get(uid)?.handleAudio(pcm),
      onClosed: (uid, reason) => {
        const s = sessions.get(uid);
        sessions.delete(uid);
        s?.dispose(reason);
      },
      onError: (error) => log.warn("Phone call transport failed", { error }),
      log: (line) => log.info(line),
    });
    calls = voiceCalls;
    dispatcher.onRawUpdate(async (_client, update) => {
      if (update._ === "updatePhoneCall") {
        await voiceCalls.handleUpdate(update.phoneCall as unknown as PhoneCallUpdate);
      } else if (update._ === "updatePhoneCallSignalingData") {
        await voiceCalls.handleSignalingData(update as unknown as PhoneCallSignalingUpdate);
      }
    });
  }
  running.start();
  track(
    dialogScopes(telegram.with(bgAbort.signal))
      .then((scopes) => groups.started(scopes))
      .catch((error: unknown) => {
        if (!bgAbort.signal.aborted)
          log.warn("Dialog list failed; new groups are not recognised", error);
      }),
  );
  heartbeat = setInterval(() => log.info("heartbeat", operator.heartbeat()), HEARTBEAT_MS);
  heartbeat.unref();
  // 意愿层快照（trace-log.ts）：只读她此刻的状态，写进 live/traces/，不进 Journal、不改她做什么。
  const writeTrace = traceWriter(join(ALICE_STATE_DIR, "traces"), version.sha, (error) =>
    log.warn("Trace snapshot write failed", error),
  );
  traceTimer = setInterval(() => writeTrace(running.current, Date.now()), TRACE_EVERY_MS);
  traceTimer.unref();
  // 对话轮询：补回 Telegram 没推送的消息（大超级群、频道），只补这次启动之后的。
  const startedAt = Date.now();
  let lastHnAt = 0;
  const HN_EVERY_MS = 30 * 60_000;
  let catchUpRun: Promise<void> | null = null;
  catchUpTimer = setInterval(() => {
    if (catchUpRun) return;
    const run = catchUp(telegram.with(bgAbort.signal), inbox, adapter.receive, startedAt)
      .then((round) => log.info("catch-up", { ...round }))
      // 别人消息上的表情合计 Telegram 不推送：对刚有人说话的群拉一次（telegram/scene.ts）。
      .then(async () => {
        for (const { scope, ids } of scene.activeRooms(Date.now())) {
          const pulled = await pullReactions(telegram.with(bgAbort.signal), scope, ids).catch(
            (error: unknown) => {
              if (!bgAbort.signal.aborted) log.warn("Reaction pull failed", error);
              return [];
            },
          );
          for (const p of pulled) {
            const update = scene.changes(
              scope,
              p.messageId,
              { reactions: p.reactions },
              ports.now(),
            );
            if (update) running.dispatch(update);
          }
        }
      })
      .then(async () => {
        // 刷手机看公开榜单（ADR-276 环节一：睡着或暂停时不拉 HN 热门）。
        const now = ports.now();
        if (
          operator.paused ||
          isAsleepIn(mind, running.current, now) ||
          now - lastHnAt < HN_EVERY_MS
        )
          return;
        lastHnAt = now;
        const stories = await fetchHnTop(5);
        for (const s of stories) {
          if (seenHn.has(s.id)) continue;
          seenHn.add(s.id);
          running.dispatch({
            type: "post.received",
            at: ports.now(),
            scope: "hn:top",
            messageId: s.id,
            title: "Hacker News",
            text: s.url ? `${s.title}\n${s.url}` : s.title,
          });
        }
      })
      .catch((error: unknown) => {
        // 停机中止不算没补成；限流、网络这些别的错照记。
        if (!bgAbort.signal.aborted) log.warn("Catch-up failed", error);
      })
      .finally(() => {
        if (catchUpRun === run) catchUpRun = null;
      });
    catchUpRun = run;
    track(run);
  }, CATCH_UP_MS);
  catchUpTimer.unref();
  log.info("Alice runtime started", {
    selfId: String(self.id),
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
      speechModel: config.speechModel,
    },
    (error) => log.warn("Run record write failed", error),
  );
  void sendToOperator(
    `上线了${operator.paused ? "（仍在暂停，/ops resume 继续）" : ""}。/ops help 看命令。`,
  ).catch((error) => log.warn("Operator message failed", error));

  process.once("SIGINT", () => void shutdown(0));
  process.once("SIGTERM", () => void shutdown(0));
}

main().catch(async (error) => {
  if (error instanceof SingleInstanceLockError) log.fatal(error.message);
  else log.fatal("Runtime failed", error);
  await destroyClient();
  closeDb();
  await closeLogger();
  process.exitCode = 1;
});
