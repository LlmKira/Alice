import { readFile } from "node:fs/promises";
import { createLogger } from "./utils/logger.js";

const log = createLogger("soul");

/**
 * Load SOUL.md from the specified directory.
 * If custom.md exists, append it to the base SOUL.
 */
export async function loadSoul(soulDir: string): Promise<string> {
  const base = await readFile(`${soulDir}/SOUL.md`, "utf-8");
  const custom = await readFile(`${soulDir}/custom.md`, "utf-8").catch(() => null);
  if (custom) {
    log.info("Loaded custom SOUL");
    return `${base}\n\n---\n\n${custom}`;
  }
  return base;
}
