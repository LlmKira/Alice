/**
 * Engine API 服务器 — TCP HTTP 接口。
 *
 * Skill CLI 脚本通过 TCP 与运行中的 Alice 引擎通信，
 * 读写配置和图属性。容器内通过 host.docker.internal 访问。
 *
 * @see docs/adr/202-engine-api.md
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { WorldModel } from "../graph/world-model.js";
import { createTelegramTransportAdapter, type TransportAdapter } from "../platform/transport.js";
import { ALICE_ENGINE_PORT } from "../runtime-paths.js";
import { loadRegistry, mergeRegistryWithBuiltIns, type Registry } from "../skills/registry.js";
import { createLogger } from "../utils/logger.js";
import { checkCapability, withRequestLog } from "./middleware.js";
import { handleAlbum } from "./routes/album.js";
import { handleChatTail } from "./routes/chat.js";
import { handleCmd } from "./routes/cmd.js";
import { handleConfigGet } from "./routes/config.js";
import { handleDispatchInstruction } from "./routes/dispatch.js";
import { handleEngineSelfcheck, handleEngineTick } from "./routes/engine.js";
import { handleGraphGet, handleGraphSet } from "./routes/graph.js";
import { handleLlmSummarize, handleLlmSynthesize } from "./routes/llm.js";
import { handleMetaCommands } from "./routes/meta.js";
import { handleQuery } from "./routes/query.js";
import { handleResolveName, handleResolveTarget } from "./routes/resolve.js";
import {
  handleSkillInfo,
  handleSkillInstall,
  handleSkillList,
  handleSkillPublish,
  handleSkillRemove,
  handleSkillRollback,
  handleSkillSearch,
  handleSkillUpgrade,
  handleSkillUpgrades,
} from "./routes/skills.js";
import { handleTelegramForward } from "./routes/telegram.js";
import { handleTransport } from "./routes/transport.js";

const log = createLogger("engine-api");

export interface EngineApiDeps {
  config: {
    timezoneOffset: number;
    exaApiKey: string;
    musicApiBaseUrl: string;
    youtubeApiKey: string;
  };
  G: WorldModel;
  /** 获取当前 tick 数（引擎查询端点使用）。 */
  getTick?: () => number;
  /** Skill 注册表（capability 验证用）。undefined = Phase 1 宽松模式。 */
  registry?: Registry;
  /** true = strict（无 header / 未知 skill → 403），false/undefined = lenient。 */
  strictCapabilities?: boolean;
  /** Neutral IM transport adapters keyed by platform. */
  transportAdapters?: Record<string, TransportAdapter>;
  /** Telegram 消息转发回调（irc forward: 跨聊天转发 + 可选评论）。 */
  telegramForward?: (params: {
    fromChatId: number;
    msgId: number;
    toChatId: number;
    comment?: string;
  }) => Promise<{ forwardedMsgId: number | null; commentMsgId?: number | null }>;
  /** ADR-260: Telegram group photo album send callback. */
  telegramAlbumSend?: (params: {
    assetId: string;
    targetChatId: number;
    caption?: string;
    replyTo?: number;
  }) => Promise<{ msgId: number | null; sendMode: string; assetId: string }>;
  /** Telegram 文本发送回调（irc say/reply）。 */
  telegramSend?: (params: {
    chatId: number;
    text: string;
    replyTo?: number;
  }) => Promise<{ msgId: number | null }>;
  /** Telegram 已读回调（irc read）。 */
  telegramMarkRead?: (chatId: number) => Promise<{ ok: true }>;
  /** Telegram reaction 回调（irc react）。 */
  telegramReact?: (params: {
    chatId: number;
    msgId: number;
    emoji: string;
  }) => Promise<{ ok: true }>;
  /** Telegram join callback (`irc join`). */
  telegramJoin?: (chatIdOrLink: string) => Promise<{ ok: true }>;
  /** Telegram leave callback (`irc leave`). */
  telegramLeave?: (chatId: number) => Promise<{ ok: true }>;
  /** Telegram sticker callback (`irc sticker`). */
  telegramSticker?: (params: {
    chatId: number;
    sticker: string;
  }) => Promise<{ msgId: number | null }>;
  /** Telegram download callback (`irc download`). */
  telegramDownload?: (params: {
    chatId: number;
    msgId: number;
    output: string;
  }) => Promise<{ path: string; mime: string; size: number }>;
  /** Telegram upload callback (`irc send-file`). */
  telegramUpload?: (params: {
    chatId: number;
    path: string;
    caption?: string;
    replyTo?: number;
  }) => Promise<{ msgId: number | null }>;
  /** Telegram voice callback (`irc voice`). TTS → OGG/Opus → sendVoice. */
  telegramVoice?: (params: {
    chatId: number;
    text: string;
    emotion?: string;
    replyTo?: number;
  }) => Promise<{ msgId: number | null; deliveredAs?: "voice" | "text"; fallbackReason?: string }>;
  /** Dispatcher syscall bridge. */
  dispatchInstruction?: (
    instruction: string,
    args: Record<string, unknown>,
  ) => Promise<unknown> | unknown;
  /** Dispatcher query bridge. */
  query?: (name: string, args: Record<string, unknown>) => Promise<unknown> | unknown;
  /** Dispatcher command kind resolver for /cmd routing. */
  resolveCommandKind?: (name: string) => "query" | "instruction" | undefined;
  /** Mod 定义列表（供 /meta/commands 端点生成命令目录）。 */
  getMods?: () => readonly import("../core/types.js").ModDefinition[];
  /** TCP 端口号。0 = OS 自动分配。 */
  port?: number;
}

/**
 * 简易路由分发。
 *
 * 路径不含版本前缀——进程内 TCP IPC，不是公共 REST API。
 * - GET  /config/:key
 * - GET  /chat/:chatId/tail
 * - GET  /engine/tick
 * - POST /engine/selfcheck
 * - POST /llm/synthesize
 * - POST /llm/summarize
 * - GET  /graph/:entity/:attr
 * - POST /graph/:entity/:attr
 * - POST /telegram/forward
 * - POST /transport/send
 * - POST /transport/read
 * - POST /transport/react
 * - GET  /skills/search?query=...
 * - GET  /skills/list
 * - GET  /skills/info/:name
 * - POST /skills/install
 * - POST /skills/remove
 * - POST /skills/upgrade
 * - POST /skills/rollback
 * - POST /dispatch/:instruction
 * - POST /query/:name
 * - POST /cmd/:name             (ADR-217: unified dispatch/query)
 * - GET  /meta/commands          (ADR-217: command catalog)
 */
export function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: EngineApiDeps,
): void | Promise<void> {
  // Strict mode must observe newly installed/removed skills immediately.
  const registry = deps.strictCapabilities
    ? mergeRegistryWithBuiltIns(loadRegistry())
    : deps.registry
      ? mergeRegistryWithBuiltIns(deps.registry)
      : mergeRegistryWithBuiltIns({});

  // capability 检查
  const capMode = deps.strictCapabilities ? "strict" : "lenient";
  const capCheck = checkCapability(req, registry, capMode);
  if (!capCheck.allowed) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: `skill "${capCheck.skill}" lacks capability "${capCheck.needed}"`,
      }),
    );
    return;
  }

  const method = req.method ?? "GET";
  const url = req.url ?? "/";

  const pathname = url.split("?")[0];
  // /config/timezoneOffset → ["config", "timezoneOffset"]
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length < 2) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  const resource = segments[0];

  // --- config ---
  if (resource === "config" && method === "GET" && segments.length === 2) {
    handleConfigGet(segments[1], req, res, deps);
    return;
  }

  // --- engine ---
  if (resource === "engine") {
    if (method === "GET" && segments[1] === "tick" && segments.length === 2) {
      handleEngineTick(req, res, deps);
      return;
    }
    if (method === "POST" && segments[1] === "selfcheck" && segments.length === 2) {
      return handleEngineSelfcheck(req, res, deps);
    }
  }

  // --- chat ---
  if (resource === "chat" && method === "GET" && segments.length === 3 && segments[2] === "tail") {
    handleChatTail(segments[1], req, res, deps);
    return;
  }

  // --- llm ---
  if (resource === "llm" && method === "POST" && segments.length === 2) {
    if (segments[1] === "synthesize") {
      return handleLlmSynthesize(req, res);
    }
    if (segments[1] === "summarize") {
      return handleLlmSummarize(req, res);
    }
  }

  // --- graph ---
  // /graph/contact:telegram:123/display_name → ["graph", "contact:telegram:123", "display_name"]
  if (resource === "graph" && segments.length === 3) {
    const entity = segments[1];
    const attr = segments[2];
    if (method === "GET") {
      handleGraphGet(entity, attr, req, res, deps);
      return;
    }
    if (method === "POST") {
      return handleGraphSet(entity, attr, req, res, deps);
    }
  }

  // --- telegram ---
  if (resource === "telegram" && method === "POST" && segments.length === 2) {
    return handleTelegramForward(segments[1], req, res, deps);
  }

  // --- transport ---
  if (resource === "transport" && method === "POST" && segments.length === 2) {
    const transportDeps: EngineApiDeps = deps.transportAdapters?.telegram
      ? deps
      : {
          ...deps,
          transportAdapters: {
            ...deps.transportAdapters,
            telegram: createTelegramTransportAdapter({
              send: deps.telegramSend,
              markRead: deps.telegramMarkRead,
              react: deps.telegramReact,
            }),
          },
        };
    return handleTransport(segments[1], req, res, transportDeps);
  }

  // --- album ---
  if (resource === "album" && segments.length === 2) {
    return handleAlbum(segments[1], req, res, deps);
  }

  // --- skills ---
  if (resource === "skills") {
    if (method === "GET" && segments[1] === "search") {
      handleSkillSearch(req, res);
      return;
    }
    if (method === "GET" && segments[1] === "list") {
      handleSkillList(req, res);
      return;
    }
    if (method === "GET" && segments[1] === "info" && segments.length === 3) {
      handleSkillInfo(segments[2], req, res);
      return;
    }
    if (method === "POST" && segments[1] === "install") {
      return handleSkillInstall(req, res);
    }
    if (method === "POST" && segments[1] === "remove") {
      return handleSkillRemove(req, res);
    }
    if (method === "POST" && segments[1] === "upgrade") {
      return handleSkillUpgrade(req, res);
    }
    if (method === "POST" && segments[1] === "rollback") {
      return handleSkillRollback(req, res);
    }
    if (method === "POST" && segments[1] === "publish") {
      return handleSkillPublish(req, res);
    }
    if (method === "GET" && segments[1] === "upgrades") {
      return handleSkillUpgrades(req, res);
    }
  }

  // --- dispatch ---
  if (resource === "dispatch" && method === "POST" && segments.length === 2) {
    return handleDispatchInstruction(segments[1], req, res, deps);
  }

  if (resource === "query" && method === "POST" && segments.length === 2) {
    return handleQuery(segments[1], req, res, deps);
  }

  // --- cmd (ADR-217: unified dispatch/query) ---
  if (resource === "cmd" && method === "POST" && segments.length === 2) {
    return handleCmd(segments[1], req, res, deps);
  }

  // --- meta ---
  if (
    resource === "meta" &&
    method === "GET" &&
    segments.length === 2 &&
    segments[1] === "commands"
  ) {
    return handleMetaCommands(res, deps);
  }

  // --- resolve (ADR-237 name, ADR-265 target refs) ---
  if (
    resource === "resolve" &&
    method === "POST" &&
    segments.length === 2 &&
    segments[1] === "name"
  ) {
    return handleResolveName(req, res, deps);
  }
  if (
    resource === "resolve" &&
    method === "POST" &&
    segments.length === 2 &&
    segments[1] === "target"
  ) {
    return handleResolveTarget(req, res, deps);
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
}

/**
 * 启动 Engine API 服务器（TCP）。
 *
 * @returns { cleanup, port } — cleanup 关闭服务器；port 为实际监听端口
 */
export async function startEngineApi(
  deps: EngineApiDeps,
): Promise<{ cleanup: () => Promise<void>; port: number }> {
  const requestedPort = deps.port ?? ALICE_ENGINE_PORT;
  const server: Server = createServer(withRequestLog((req, res) => routeRequest(req, res, deps)));

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(requestedPort, "0.0.0.0", () => resolve());
  });

  const actualPort = (server.address() as AddressInfo).port;
  log.info(`listening on 0.0.0.0:${actualPort}`);

  return {
    port: actualPort,
    cleanup: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      log.info("server stopped");
    },
  };
}
