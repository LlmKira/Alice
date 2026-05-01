/**
 * 内容寻址存储 — Nix 风格 SHA256 + 目录结构。
 *
 * store/{hash}/ 下存放 manifest.yaml + 源码。
 * 同 manifest + 同版本 = 同 hash → 幂等安装，不重复。
 *
 * 安装时使用 Go 编译为静态二进制可执行文件。
 *
 * @see docs/adr/201-os-for-llm.md
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

/** 存储根目录。 */
const DEFAULT_STORE_ROOT = process.env.ALICE_STORE_ROOT
  ? resolve(process.env.ALICE_STORE_ROOT)
  : resolve(import.meta.dirname ?? ".", "../../skills/store");

/** 获取存储根目录。 */
export function getAliceStoreRoot(): string {
  return DEFAULT_STORE_ROOT;
}

/**
 * 编译 skill 为静态 Go 二进制可执行文件。
 *
 * 优先使用 dist/bin/ 下已编译的二进制（make 产物），
 * 否则使用 `go build` 从 cmd/skills/{name}/ 编译。
 *
 * 与 Makefile 保持一致：CGO_ENABLED=0 go build -ldflags="-s -w"
 */
export function compileSkillExecutable(
  _storePath: string,
  skillName: string,
  binDir: string,
): string {
  const outputFile = join(binDir, skillName);
  const runtimeDir = resolve(import.meta.dirname ?? ".", "../..");

  // 确保目标目录存在
  mkdirSync(binDir, { recursive: true });

  // 1) 优先：dist/bin/ 下已有编译好的二进制（make 产物）
  const prebuilt = join(runtimeDir, "dist", "bin", skillName);
  if (existsSync(prebuilt)) {
    cpSync(prebuilt, outputFile);
    chmodSync(outputFile, 0o755);
    return outputFile;
  }

  // 2) 从 cmd/skills/{name}/ 用 Go 编译
  const goSource = join(runtimeDir, "cmd", "skills", skillName);
  if (!existsSync(goSource)) {
    throw new Error(
      `Skill "${skillName}": no prebuilt binary in dist/bin/ and no Go source in cmd/skills/${skillName}/`,
    );
  }

  // 移除旧文件（如果存在）
  rmSync(outputFile, { force: true });

  const result = spawnSync(
    "go",
    ["build", "-ldflags=-s -w", "-o", outputFile, `./${join("cmd", "skills", skillName)}`],
    {
      encoding: "utf-8",
      cwd: runtimeDir,
      timeout: 120000,
      env: { ...process.env, CGO_ENABLED: "0" },
    },
  );

  if (result.status !== 0 || !existsSync(outputFile)) {
    throw new Error(
      `Failed to compile skill "${skillName}": ${result.stderr || result.error?.message || "unknown error"}`,
    );
  }

  chmodSync(outputFile, 0o755);
  return outputFile;
}

export function wrapSkillExecutable(
  commandPath: string,
  skillName: string,
  options?: { realPath?: string },
): string {
  const realPath = options?.realPath ?? join(resolve(commandPath, ".."), `.${skillName}.real`);
  const realBasename = basename(realPath);
  rmSync(realPath, { force: true });
  renameSync(commandPath, realPath);
  writeFileSync(
    commandPath,
    [
      "#!/usr/bin/env sh",
      `export ALICE_SKILL=${JSON.stringify(skillName)}`,
      'self_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
      `exec "$self_dir/${realBasename}" "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return commandPath;
}

/**
 * 计算 manifest 内容的 SHA256 哈希。
 * 内容寻址 = 同内容同 hash。
 */
export function computeHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * 同步 _lib 目录到 store 根目录。
 *
 * Skills 可能引用 `../../_lib/engine-client.ts`，
 * 需要在 store 层级保持相同的相对路径结构。
 */
export function ensureStoreLib(storeRoot: string = DEFAULT_STORE_ROOT): void {
  // _lib 位于 skills/ 目录下（store 的父目录）
  const libSource = resolve(storeRoot, "../_lib");
  const libTarget = join(storeRoot, "_lib");

  if (existsSync(libSource) && !existsSync(libTarget)) {
    cpSync(libSource, libTarget, { recursive: true });
  }
}

/**
 * 安装 manifest 到内容寻址存储。
 *
 * @param manifestContent manifest.yaml 原始内容
 * @param sourceDir Skill 包源码目录（可选）。提供时会将整个包复制到 store。
 * @param storeRoot 存储根目录
 * @returns { hash, storePath }
 */
export function installToStore(
  manifestContent: string,
  sourceDir?: string,
  _skillName?: string,
  storeRoot: string = DEFAULT_STORE_ROOT,
): { hash: string; storePath: string } {
  const hash = computeHash(manifestContent);
  const storePath = join(storeRoot, hash);

  if (!existsSync(storePath)) {
    if (sourceDir) {
      // Store contains the full package body so installed skills stay runnable
      // even after the source workspace changes.
      cpSync(sourceDir, storePath, { recursive: true });

      // 同步 _lib 目录到 store 根目录（支持 ../../_lib 引用）
      ensureStoreLib(storeRoot);
    } else {
      mkdirSync(storePath, { recursive: true });
    }
    writeFileSync(join(storePath, "manifest.yaml"), manifestContent);
  }

  return { hash, storePath };
}

/**
 * 从存储中读取 manifest 内容。
 */
export function readFromStore(hash: string, storeRoot: string = DEFAULT_STORE_ROOT): string | null {
  const filePath = join(storeRoot, hash, "manifest.yaml");
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, "utf-8");
}

/**
 * 从存储中移除。
 */
export function removeFromStore(hash: string, storeRoot: string = DEFAULT_STORE_ROOT): void {
  const storePath = join(storeRoot, hash);
  if (existsSync(storePath)) {
    rmSync(storePath, { recursive: true });
  }
}

/**
 * 检查 hash 是否已存在于存储中。
 */
export function existsInStore(hash: string, storeRoot: string = DEFAULT_STORE_ROOT): boolean {
  return existsSync(join(storeRoot, hash, "manifest.yaml"));
}
