/**
 * 这次运行的是哪一版代码：启动时取 git 提交和有没有未提交的改动，写进启动日志、状态目录下的 runs.jsonl
 * （每次启动一行）和每条提示日志。以后要用同一版代码重放 Journal、重算意愿层的每一步，就按这里的 sha
 * 取出代码。拿不到（不在 git 仓库里、没有 git）就记 unknown，不让启动失败。
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Rotation } from "./mind/rotation.js";

export interface CodeVersion {
  /** git 提交；拿不到时为 "unknown"。 */
  sha: string;
  /** 已跟踪的文件有没有未提交的改动；拿不到时为 null。 */
  dirty: boolean | null;
}

type Git = (args: string[]) => string;

const git: Git = (args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

export function codeVersion(run: Git = git): CodeVersion {
  try {
    const sha = run(["rev-parse", "HEAD"]).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) return { sha: "unknown", dirty: null };
    let dirty: boolean | null = null;
    try {
      dirty = run(["status", "--porcelain", "--untracked-files=no"]).trim() !== "";
    } catch {
      // 提交拿到了、状态拿不到：照样记提交。
    }
    return { sha, dirty };
  } catch {
    return { sha: "unknown", dirty: null };
  }
}

/** runs.jsonl 的一行：什么时候、哪一版代码、用了哪些机制和哪个发言模型。写不进去只警告，不让启动失败。 */
export function recordRun(
  path: string,
  run: CodeVersion & {
    at: number;
    mechanisms: readonly string[];
    speechModel?: string;
    /** 线上轮换的候选、种子和单位（mind/rotation.ts）；没开轮换就没有。 */
    rotation?: Rotation;
  },
  warn: (error: unknown) => void,
): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(run)}\n`);
  } catch (error) {
    warn(error);
  }
}
