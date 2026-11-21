import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireSingleInstanceLock, SingleInstanceLockError } from "../src/single-instance.js";

const lockPath = join(tmpdir(), `alice-lock-${process.pid}.test`);

afterEach(() => {
  if (existsSync(lockPath)) unlinkSync(lockPath);
});

describe("single instance lock", () => {
  it("acquires and writes own pid", () => {
    acquireSingleInstanceLock(lockPath);
    expect(existsSync(lockPath)).toBe(true);
    expect(Number(readFileSync(lockPath, "utf8").trim())).toBe(process.pid);
  });

  it("refuses a second acquisition while the holder is alive", () => {
    acquireSingleInstanceLock(lockPath);
    expect(() => acquireSingleInstanceLock(lockPath)).toThrow(SingleInstanceLockError);
  });

  it("takes over a stale lock from a dead process", () => {
    // 伪造一个"已死进程"的锁：pid 巨大且不存在。
    writeFileSync(lockPath, "999999999");
    expect(() => acquireSingleInstanceLock(lockPath)).not.toThrow();
    expect(Number(readFileSync(lockPath, "utf8").trim())).toBe(process.pid);
  });
});
