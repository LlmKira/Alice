import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { DEFAULT_DOCKER_IMAGE } from "../skills/backends/docker.js";
import { ALICE_CONTAINER_PATHS, executeAliceSandboxCommand } from "../skills/container-runner.js";
import {
  getAliceSystemBinDir,
  isExecutableFile,
  listAliceSystemCommands,
  loadRegistry,
  mergeRegistryWithBuiltIns,
  type Registry,
  type RegistryEntry,
  resolveInstalledSkillDir,
} from "../skills/registry.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("command-catalog");

export interface CommandCatalogEntry {
  name: string;
  packageName: string;
  kind: "system" | "skill";
  summary: string;
  /** ADR-223: skill 的 whenToUse（从 manifest.yaml 提取）。 */
  whenToUse?: string;
}

export interface CommandCatalog {
  commands: CommandCatalogEntry[];
}

function safeReadText(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/** ADR-216: --help 替代 man。系统命令 summary 硬编码。 */
const SYSTEM_COMMAND_SUMMARIES: Record<string, string> = {
  irc: "Telegram system chat client for Alice",
  album: "Alice group photo album search and send",
  self: "Alice self-management commands",
  "alice-pkg": "Alice OS package manager",
};

interface ManifestMeta {
  summary: string;
  whenToUse?: string;
}

function readManifestMeta(entry: RegistryEntry): ManifestMeta {
  const manifestPath = resolve(resolveInstalledSkillDir(entry), "manifest.yaml");
  const raw = safeReadText(manifestPath);
  if (!raw) return { summary: entry.name };

  const parsed = parseYaml(raw) as {
    description?: unknown;
    actions?: Array<{ whenToUse?: string }>;
    family?: { whenToUse?: string };
  } | null;

  const summary =
    parsed && typeof parsed.description === "string" && parsed.description.trim()
      ? parsed.description.trim()
      : entry.name;

  // ADR-223: 提取 whenToUse（优先 action 级——英文，与 shell manual 一致）。
  // family.whenToUse 可能是中文（legacy category summary 遗留），不用。
  const whenToUse = parsed?.actions?.[0]?.whenToUse as string | undefined;

  return { summary, whenToUse };
}

interface ProbeCandidate {
  name: string;
  packageName: string;
  kind: "system" | "skill";
  summary: string;
}

function buildCandidates(registry: Registry, systemBinDir: string): ProbeCandidate[] {
  const systemEntries = listAliceSystemCommands(systemBinDir).map((name) => ({
    name,
    packageName: "alice-system",
    kind: "system" as const,
    summary: SYSTEM_COMMAND_SUMMARIES[name] ?? `${name} command`,
  }));

  const skillEntries = Object.entries(registry)
    .filter(([packageName]) => packageName !== "alice-system")
    .map(([packageName, entry]) => {
      const meta = readManifestMeta(entry);
      return {
        name: entry.name,
        packageName,
        kind: "skill" as const,
        summary: meta.summary,
        whenToUse: meta.whenToUse,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return [...systemEntries, ...skillEntries];
}

async function probeVisibleNames(
  candidates: readonly ProbeCandidate[],
  env: Record<string, string>,
  options: {
    registry: Registry;
    image: string;
    systemBinDir: string;
  },
): Promise<Set<string>> {
  const uniqueNames = [...new Set(candidates.map((candidate) => candidate.name))];
  if (uniqueNames.length === 0) return new Set<string>();

  // biome-ignore lint/suspicious/noTemplateCurlyInString: sh variable expansion
  const script =
    'set -eu\nfor name in "$@"; do\n  if [ -n "${ALICE_SYSTEM_BIN_DIR:-}" ] && [ -x "${ALICE_SYSTEM_BIN_DIR}/$name" ]; then\n    printf "%s\\n" "$name"\n  fi\ndone';

  const stdout = await executeAliceSandboxCommand({
    command: script,
    args: uniqueNames,
    image: options.image,
    skillName: "alice-system",
    enginePort: undefined,
    network: false,
    memory: "256m",
    timeout: 30,
    env,
    extraMounts: collectProbeMounts(options.registry, options.systemBinDir),
    isolation: "sandboxed",
  });

  const commands = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const name = line.trim();
    if (name) commands.add(name);
  }
  return commands;
}

function fallbackVisibleNames(
  candidates: readonly ProbeCandidate[],
  systemBinDir: string,
): Set<string> {
  const commands = new Set<string>();
  for (const candidate of candidates) {
    if (isExecutableFile(resolve(systemBinDir, candidate.name))) {
      commands.add(candidate.name);
    }
  }
  return commands;
}

function collectProbeMounts(
  registry: Registry,
  systemBinDir: string,
): Array<{ source: string; target?: string; readOnly?: boolean }> {
  const mounts = new Map<string, { source: string; target?: string; readOnly?: boolean }>();
  const remember = (source: string, target?: string) => {
    mounts.set(`${source}->${target ?? source}`, { source, target, readOnly: true });
  };

  remember(systemBinDir, ALICE_CONTAINER_PATHS.bin);
  for (const entry of Object.values(registry)) {
    remember(resolveInstalledSkillDir(entry));
  }

  return [...mounts.values()];
}

export async function probeCommandCatalog(options?: {
  registry?: Registry;
  systemBinDir?: string;
  env?: Record<string, string>;
  image?: string;
}): Promise<CommandCatalog> {
  const registry = options?.registry ?? mergeRegistryWithBuiltIns(loadRegistry());
  const systemBinDir = options?.systemBinDir ?? getAliceSystemBinDir();
  const candidates = buildCandidates(registry, systemBinDir);
  const image = options?.image ?? process.env.ALICE_COMMAND_PROBE_IMAGE ?? DEFAULT_DOCKER_IMAGE;

  const env = options?.env ?? {};

  const visibleCommands = await probeVisibleNames(candidates, env, {
    registry,
    image,
    systemBinDir,
  }).catch((error) => {
    log.warn("Container probe failed, falling back to host catalog", {
      error: error instanceof Error ? error.message : String(error),
    });
    return fallbackVisibleNames(candidates, systemBinDir);
  });
  // ADR-223: skill 命令通过 Engine API 执行，始终可见，不需要 probe。
  // 只有 system 命令需要通过 probe 确认 binary 存在。
  const commands = candidates.filter((c) => c.kind === "skill" || visibleCommands.has(c.name));

  return { commands };
}
