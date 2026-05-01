/**
 * mtcute Telegram 客户端初始化。
 */

import { Dispatcher } from "@mtcute/dispatcher";
import { TelegramClient } from "@mtcute/node";
import type { Config } from "../config.js";

let _client: TelegramClient | null = null;
let _dispatcher: Dispatcher | null = null;

/**
 * 创建并返回 TelegramClient 实例。
 * session 文件默认存储为 SQLite (mtcute 内置)。
 */
export function createClient(config: Config): TelegramClient {
  if (_client) return _client;

  _client = new TelegramClient({
    apiId: config.telegramApiId,
    apiHash: config.telegramApiHash,
    storage: "alice.session",
    // mtcute 默认注册 SIGINT/SIGTERM exit hook，会和 Alice 自己的异步 shutdown
    // 竞争关闭 session DB。由 runtime/src/index.ts 统一调用 destroyClient()。
    storageOptions: { cleanup: false },
  });

  return _client;
}

/**
 * 获取当前 client 实例（必须先 createClient）。
 */
export function getClient(): TelegramClient {
  if (!_client) throw new Error("TelegramClient not initialized. Call createClient() first.");
  return _client;
}

/**
 * 创建并绑定 Dispatcher 到 client。
 */
export function createDispatcher(client: TelegramClient): Dispatcher {
  if (_dispatcher) return _dispatcher;
  _dispatcher = Dispatcher.for(client);
  return _dispatcher;
}

/**
 * 获取当前 Dispatcher 实例。
 */
export function getDispatcher(): Dispatcher {
  if (!_dispatcher) throw new Error("Dispatcher not initialized. Call createDispatcher() first.");
  return _dispatcher;
}

/**
 * 启动客户端（登录 / 恢复 session）。
 */
export async function startClient(client: TelegramClient, phone: string): Promise<void> {
  await client.start({
    phone: () => Promise.resolve(phone),
    code: () => client.input("Enter the code: "),
    password: () => client.input("Enter 2FA password: "),
  });
}

/**
 * 优雅关闭。
 * try/catch: shutdown 路径上不值得因为 client 清理失败而阻塞退出。
 */
export async function destroyClient(): Promise<void> {
  try {
    if (_dispatcher) {
      _dispatcher.unbind();
      await _dispatcher.destroy();
      _dispatcher = null;
    }
  } catch {
    /* shutdown — 静默 */
  }
  try {
    if (_client) {
      await _client.destroy();
      _client = null;
    }
  } catch {
    /* shutdown — 静默 */
  }
}
