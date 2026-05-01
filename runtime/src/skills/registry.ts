/**
 * Skill 注册表 — 已安装 Skill 的索引（registry.json CRUD）。
 *
 * @see docs/adr/201-os-for-llm.md
 */

import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import { compileSkillExecutable, getAliceStoreRoot, wrapSkillExecutable } from "./store.js";

// 重新导出供其他模块使用
export { getAliceStoreRoot } from "./store.js";

/** 默认注册表路径。 */
const DEFAULT_REGISTRY_PATH = resolve(import.meta.dirname ?? ".", "../../skills/registry.json");
/**
 * Runtime command-space roots.
 *
 * In development they default to workspace paths.
 * In a protected runner/container they can be rebound to system-style directories
 * like /opt/alice/bin and /opt/alice/share/man via environment variables.
 */
const DEFAULT_SYSTEM_BIN = process.env.ALICE_SYSTEM_BIN_DIR
  ? resolve(process.env.ALICE_SYSTEM_BIN_DIR)
  : resolve(import.meta.dirname ?? ".", "../../dist/bin");
const CONTAINER_SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** 注册表条目。 */
export interface RegistryEntry {
  name: string;
  version: string;
  hash: string;
  /** 已安装命令目录。默认 = skills/store/{hash}。 */
  storePath?: string;
  /** 已安装命令入口。默认 = {storePath}/{name}。 */
  commandPath?: string;
  /** 上一个版本的 hash（用于回滚）。 */
  previousHash?: string;
  installedAt: string;
  /** 导出的动作名列表。 */
  actions: string[];
  /** 注册的 ToolCategory 列表。 */
  categories: string[];
  /** 申请的 Engine API 能力列表。 */
  capabilities: string[];
  backend: "http" | "shell" | "mcp";
}

/** 注册表内存结构。 */
export type Registry = Record<string, RegistryEntry>;

const BUILTIN_SYSTEM_REGISTRY: Registry = {
  "alice-system": {
    name: "alice-system",
    version: "1.0.0",
    hash: "builtin-system",
    storePath: DEFAULT_SYSTEM_BIN,
    commandPath: resolve(DEFAULT_SYSTEM_BIN, "irc"),
    installedAt: "2026-03-11T00:00:00.000Z",
    actions: ["irc", "album", "self", "engine", "alice-pkg"],
    categories: ["app"],
    capabilities: [
      "chat.read",
      "graph.read",
      "transport.send",
      "transport.read",
      "transport.react",
      "telegram.send",
      "telegram.read",
      "telegram.react",
      "telegram.join",
      "telegram.leave",
      "telegram.forward",
      "telegram.download",
      "telegram.upload",
      "dispatch",
      "query",
    ],
    backend: "shell",
  },
};

export function getBuiltInRegistry(): Registry {
  return { ...BUILTIN_SYSTEM_REGISTRY };
}

export function mergeRegistryWithBuiltIns(registry: Registry = loadRegistry()): Registry {
  return {
    ...getBuiltInRegistry(),
    ...registry,
  };
}

/**
 * 加载注册表。不存在时返回空对象。
 */
export function loadRegistry(registryPath: string = DEFAULT_REGISTRY_PATH): Registry {
  if (!existsSync(registryPath)) return {};
  try {
    const raw = readFileSync(registryPath, "utf-8");
    return JSON.parse(raw) as Registry;
  } catch (e) {
    // 注册表损坏——返回空但不静默丢失
    console.warn(
      `[skills/registry] Failed to parse ${registryPath}, treating as empty:`,
      e instanceof Error ? e.message : String(e),
    );
    return {};
  }
}

/**
 * 保存注册表。
 */
export function saveRegistry(
  entries: Registry,
  registryPath: string = DEFAULT_REGISTRY_PATH,
): void {
  const dir = dirname(registryPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(registryPath, JSON.stringify(entries, null, 2));
}

/**
 * 获取单个条目。
 */
export function getEntry(name: string, registryPath?: string): RegistryEntry | undefined {
  const registry = mergeRegistryWithBuiltIns(loadRegistry(registryPath));
  return registry[name];
}

/**
 * 设置单个条目（upsert）。
 */
export function setEntry(name: string, entry: RegistryEntry, registryPath?: string): void {
  const registry = loadRegistry(registryPath);
  registry[name] = entry;
  saveRegistry(registry, registryPath);
}

/**
 * 删除单个条目。
 */
export function removeEntry(name: string, registryPath?: string): void {
  const registry = loadRegistry(registryPath);
  delete registry[name];
  saveRegistry(registry, registryPath);
}

/**
 * 解析已安装 Skill 的目录。
 */
export function resolveInstalledSkillDir(entry: RegistryEntry): string {
  return entry.storePath ?? resolve(getAliceStoreRoot(), entry.hash);
}

/**
 * 解析已安装 Skill 的命令入口。
 */
export function resolveInstalledSkillCommand(entry: RegistryEntry): string {
  return entry.commandPath ?? resolve(resolveInstalledSkillDir(entry), entry.name);
}

/**
 * Alice 内置系统程序目录。
 *
 * 语义上相当于 AI OS 的系统命令层，与用户安装的 Skill 并列。
 */
export function getAliceSystemBinDir(): string {
  return DEFAULT_SYSTEM_BIN;
}

/** Public command exposure root for installed commands. */
export function getAliceBinDir(): string {
  return DEFAULT_SYSTEM_BIN;
}

/**
 * 枚举 Alice 内置系统命令。
 *
 * 注意：系统可见 bin 根目录同时也是已安装 skill 的公开导出前缀，
 * 因此这里不能直接扫描目录，否则会把 skill 误判为系统命令。
 * 真正的系统命令集合以 builtin registry 为准，再用文件存在性校验。
 */
export function listAliceSystemCommands(systemBinDir: string = DEFAULT_SYSTEM_BIN): string[] {
  if (!existsSync(systemBinDir)) return [];

  return BUILTIN_SYSTEM_REGISTRY["alice-system"].actions
    .filter((name) => {
      const path = resolve(systemBinDir, name);
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

/** 检查命令名是否为 Alice 内置系统命令。 */
export function isAliceSystemCommand(
  name: string,
  systemBinDir: string = DEFAULT_SYSTEM_BIN,
): boolean {
  return listAliceSystemCommands(systemBinDir).includes(name);
}

/** 解析 Alice 内置系统命令入口。 */
export function resolveAliceSystemCommand(
  name: string,
  systemBinDir: string = DEFAULT_SYSTEM_BIN,
): string {
  return resolve(systemBinDir, name);
}

/**
 * 构建 Alice 命令空间的 PATH 前缀。
 *
 * 顺序：
 * 1. 系统程序目录（alice-* + exported skills）
 * 2. 原宿主 PATH
 */
export function buildAliceCommandPath(): string {
  const pathParts = [getAliceBinDir(), process.env.PATH].filter(Boolean);
  return pathParts.join(delimiter);
}

/** Build a deterministic container PATH instead of inheriting host developer state. */
export function buildAliceContainerCommandPath(binDir: string = getAliceBinDir()): string {
  return [binDir, CONTAINER_SYSTEM_PATH].join(delimiter);
}

/**
 * 为 Skill 进程构建运行时环境。
 *
 * - PATH: prepend Alice command space (system commands + installed skills)
 * - ALICE_SKILL: optional process identity
 */
export function buildInstalledSkillEnv(options?: {
  skillName?: string;
  extraEnv?: Record<string, string>;
}): Record<string, string> {
  return {
    ...(options?.extraEnv ?? {}),
    PATH: buildAliceCommandPath(),
    ALICE_SYSTEM_BIN_DIR: getAliceSystemBinDir(),
    ALICE_STORE_ROOT: getAliceStoreRoot(),
    ...(options?.skillName ? { ALICE_SKILL: options.skillName } : {}),
  };
}

export function buildInstalledSkillContainerEnv(options?: {
  skillName?: string;
  extraEnv?: Record<string, string>;
  binDir?: string;
}): Record<string, string> {
  const binDir = options?.binDir ?? getAliceBinDir();

  return {
    ...(options?.extraEnv ?? {}),
    PATH: buildAliceContainerCommandPath(binDir),
    ALICE_SYSTEM_BIN_DIR: binDir,
    ...(options?.skillName ? { ALICE_SKILL: options.skillName } : {}),
  };
}

export function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function isSkillWrapper(path: string, skillName: string): boolean {
  try {
    const text = readFileSync(path, "utf-8");
    return text.includes(`export ALICE_SKILL=${JSON.stringify(skillName)}`);
  } catch {
    return false;
  }
}

export function exportInstalledSkillArtifacts(
  entry: Pick<RegistryEntry, "name" | "hash" | "storePath" | "commandPath">,
  options?: { binDir?: string; storeRoot?: string },
): { commandPath: string } {
  const storeRoot = options?.storeRoot ?? getAliceStoreRoot();
  const binDir = options?.binDir ?? getAliceBinDir();
  const storePath = entry.storePath ?? resolve(storeRoot, entry.hash ?? entry.name);
  const commandPath = resolve(binDir, entry.name);
  const realPath = resolve(binDir, `.${entry.name}.real`);

  rmSync(commandPath, { force: true });
  const compiledPath = compileSkillExecutable(storePath, entry.name, binDir);
  wrapSkillExecutable(compiledPath, entry.name, { realPath });

  return { commandPath };
}

/**
 * 启动时确保所有已安装 skill 的可执行文件存在于 bin 目录。
 */
export function ensureAllArtifacts(options?: {
  registryPath?: string;
  binDir?: string;
  storeRoot?: string;
}): { synced: number; fixed: number; broken: string[] } {
  const registry = loadRegistry(options?.registryPath);
  const binDir = options?.binDir ?? getAliceBinDir();
  const storeRoot = options?.storeRoot ?? getAliceStoreRoot();
  mkdirSync(binDir, { recursive: true });

  let synced = 0;
  let fixed = 0;
  const broken: string[] = [];

  for (const entry of Object.values(registry)) {
    const target = resolve(binDir, entry.name);

    // 检查可执行包装器是否存在；旧 symlink / 旧 ELF / 不可执行文件都重导出。
    const needsExport =
      !isExecutableFile(target) || isSymbolicLink(target) || !isSkillWrapper(target, entry.name);
    if (needsExport) {
      try {
        exportInstalledSkillArtifacts(entry, { binDir, storeRoot });
        synced++;
        if (!isExecutableFile(target)) {
          broken.push(entry.name);
        } else {
          fixed++;
        }
      } catch {
        broken.push(entry.name);
      }
    }
  }

  if (broken.length > 0) {
    console.warn(
      `[skill-registry] ${broken.length} skills have broken artifacts: ${broken.join(", ")}`,
    );
  }

  return { synced, fixed, broken };
}

export function removeExportedSkillArtifacts(name: string, options?: { binDir?: string }): void {
  const binDir = options?.binDir ?? getAliceBinDir();
  const exportedCommand = resolve(binDir, name);
  if (existsSync(exportedCommand)) {
    rmSync(exportedCommand, { force: true });
  }
}
