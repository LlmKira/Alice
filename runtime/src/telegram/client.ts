import { Dispatcher } from "@mtcute/dispatcher";
import { TelegramClient } from "@mtcute/node";
import type { Config } from "../config.js";

let clientInstance: TelegramClient | null = null;
let dispatcherInstance: Dispatcher | null = null;

export function createClient(
  config: Pick<Config, "telegramApiId" | "telegramApiHash">,
): TelegramClient {
  if (clientInstance) return clientInstance;
  clientInstance = new TelegramClient({
    apiId: config.telegramApiId,
    apiHash: config.telegramApiHash,
    storage: "alice.session",
    storageOptions: { cleanup: false },
  });
  return clientInstance;
}

export function createDispatcher(client: TelegramClient): Dispatcher {
  if (dispatcherInstance) return dispatcherInstance;
  dispatcherInstance = Dispatcher.for(client);
  return dispatcherInstance;
}

export async function startClient(client: TelegramClient, phone: string): Promise<void> {
  await client.start({
    phone: () => Promise.resolve(phone),
    code: () => client.input("Enter the code: "),
    password: () => client.input("Enter 2FA password: "),
  });
}

export async function destroyClient(): Promise<void> {
  try {
    dispatcherInstance?.unbind();
    await dispatcherInstance?.destroy();
    dispatcherInstance = null;
  } catch {
    // Shutdown continues so the Telegram session can still close.
  }
  try {
    await clientInstance?.destroy();
    clientInstance = null;
  } catch {
    // The process is already shutting down.
  }
}
