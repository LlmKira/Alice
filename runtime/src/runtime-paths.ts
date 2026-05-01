import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

function resolveFromStateDir(envKey: string, fallbackName: string): string {
  const explicit = process.env[envKey];
  if (explicit) return resolve(explicit);
  return resolve(ALICE_STATE_DIR, fallbackName);
}

/**
 * Mutable runtime state root.
 *
 * Defaults to the current working directory so local development keeps the
 * existing behavior, while deployments can relocate state with ALICE_STATE_DIR.
 */
export const ALICE_STATE_DIR = process.env.ALICE_STATE_DIR
  ? resolve(process.env.ALICE_STATE_DIR)
  : process.cwd();

export const ALICE_DB_PATH = resolve(
  process.env.ALICE_DB_PATH ?? process.env.DB_PATH ?? "alice.db",
);
export const ALICE_MEDIA_CACHE_DB_PATH = resolveFromStateDir(
  "ALICE_MEDIA_CACHE_DB_PATH",
  "media-cache.db",
);
export const ALICE_GROUP_CACHE_DB_PATH = resolveFromStateDir(
  "ALICE_GROUP_CACHE_DB_PATH",
  "group-cache.db",
);
export const ALICE_ERROR_LOG_PATH = resolveFromStateDir("ALICE_ERROR_LOG_PATH", "alice-errors.log");
export const ALICE_GROUP_RECEPTION_SHADOW_LOG_PATH = resolveFromStateDir(
  "ALICE_GROUP_RECEPTION_SHADOW_LOG_PATH",
  "eval-artifacts/ax-group-reception-shadow.jsonl",
);
// Engine API TCP 端口。0 = OS 分配随机端口。
export const ALICE_ENGINE_PORT = process.env.ALICE_ENGINE_PORT
  ? Number(process.env.ALICE_ENGINE_PORT)
  : 0;

export function ensureParentDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}
