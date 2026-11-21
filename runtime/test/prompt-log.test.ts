import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withPromptLog } from "../src/prompt-log.js";
import { codeVersion, recordRun } from "../src/runs.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const STAMP = { sha: SHA, model: "google/gemini-3-flash-preview" };
const signal = new AbortController().signal;
const prompt = { system: "PERSONA", user: "聊天记录" };
const call = { scope: "telegram:1", callId: "c1", kind: "speech" as const };

describe("prompt log", () => {
  it("records each call's prompt and raw output, and failures, one JSON line each", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alice-plog-"));
    const ok = withPromptLog(
      async () => "好呀",
      dir,
      STAMP,
      () => {},
    );
    expect(await ok(prompt, call, signal)).toBe("好呀");
    const bad = withPromptLog(
      async () => {
        throw new Error("502");
      },
      dir,
      STAMP,
      () => {},
    );
    await expect(bad(prompt, call, signal)).rejects.toThrow("502");
    const [file] = readdirSync(dir);
    const rows = readFileSync(join(dir, file as string), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows.map((r) => [r.scope, r.callId, r.raw ?? null, r.error ?? null])).toEqual([
      ["telegram:1", "c1", "好呀", null],
      ["telegram:1", "c1", null, "Error: 502"],
    ]);
    expect(rows[0].system).toBe("PERSONA");
    // 每行带着代码版本和发言模型：以后按它取同一版代码重放、分得开换模型前后。
    expect(rows.map((r) => [r.sha, r.model])).toEqual([
      [STAMP.sha, STAMP.model],
      [STAMP.sha, STAMP.model],
    ]);
  });

  it("a log that cannot be written does not stop her from speaking", async () => {
    const warnings: unknown[] = [];
    const file = join(mkdtempSync(join(tmpdir(), "alice-plog-")), "not-a-dir");
    writeFileSync(file, "");
    const logged = withPromptLog(
      async () => "嗯",
      join(file, "plog"),
      STAMP,
      (e) => warnings.push(e),
    );
    expect(await logged(prompt, call, signal)).toBe("嗯");
    expect(await logged(prompt, call, signal)).toBe("嗯");
    expect(warnings).toHaveLength(1);
  });
});

describe("code version of a run", () => {
  it("reads the commit and whether tracked files changed; unknown without git, never throws", () => {
    const answers: Record<string, string> = { "rev-parse": `${SHA}\n`, status: " M src/x.ts\n" };
    expect(codeVersion((args) => answers[args[0] as string] ?? "")).toEqual({
      sha: SHA,
      dirty: true,
    });
    expect(codeVersion((args) => (args[0] === "rev-parse" ? SHA : ""))).toEqual({
      sha: SHA,
      dirty: false,
    });
    const noGit = () => {
      throw new Error("spawn git ENOENT");
    };
    expect(codeVersion(noGit)).toEqual({ sha: "unknown", dirty: null });
    // 真的 git（测试就在仓库里跑）：拿到一个 40 位的提交。
    expect(codeVersion().sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("appends one line per start to runs.jsonl; a write that fails only warns", () => {
    const dir = mkdtempSync(join(tmpdir(), "alice-runs-"));
    const path = join(dir, "live", "runs.jsonl");
    const run = { at: 1, sha: SHA, dirty: false, mechanisms: ["pressure-production"] };
    recordRun(path, run, () => {});
    recordRun(path, { ...run, at: 2 }, () => {});
    const rows = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows).toEqual([run, { ...run, at: 2 }]);
    const warnings: unknown[] = [];
    const blocked = join(dir, "file");
    writeFileSync(blocked, "");
    recordRun(join(blocked, "runs.jsonl"), run, (e) => warnings.push(e));
    expect(warnings).toHaveLength(1);
  });
});
