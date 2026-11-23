/**
 * 并行运行全部校验（typecheck、biome、eslint、knip、vitest），任一项失败即返回非零退出码。
 * 默认跑 117 个单元与集成测试（10s 内）；传 --full 时跑含 4 个多日回放套件的全部 121 个测试（~15s）。
 * 直接调 ./node_modules/.bin 避免多层 pnpm 启动开销。
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const full = process.argv.includes("--full");
const bin = (name) => resolve("node_modules/.bin", name);

const SLOW_SUITES = [
  "test/desire.test.ts",
  "test/reach.test.ts",
  "test/pressure-properties.test.ts",
  "test/slices.test.ts",
];

const vitestArgs = full
  ? ["run"]
  : ["run", ...SLOW_SUITES.flatMap((file) => ["--exclude", file])];

const tasks = [
  { name: "typecheck", cmd: bin("tsc"), args: ["--noEmit", "--incremental", "--tsBuildInfoFile", ".tsbuildinfo"] },
  { name: "biome", cmd: bin("biome"), args: ["check", "src/", "test/"] },
  { name: "eslint", cmd: bin("eslint"), args: ["--cache", "--cache-location", ".eslintcache", "."] },
  { name: "knip", cmd: bin("knip"), args: [] },
  { name: full ? "test:full" : "test", cmd: bin("vitest"), args: vitestArgs },
];

const started = performance.now();

function run(task) {
  return new Promise((resolveTask) => {
    const t0 = performance.now();
    const child = spawn(task.cmd, task.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.on("close", (code, signal) => {
      resolveTask({
        name: task.name,
        code: code ?? (signal ? 1 : 0),
        ms: performance.now() - t0,
        out,
      });
    });
  });
}

const results = await Promise.all(tasks.map(run));
let failed = false;

for (const r of results) {
  const sec = (r.ms / 1000).toFixed(2);
  const tag = r.code === 0 ? "PASS" : "FAIL";
  console.log(`[check] ${tag} ${r.name} (${sec}s)`);
  if (r.code !== 0 || r.name.startsWith("test")) {
    const trimmed = r.out.trim();
    if (trimmed) console.log(trimmed);
  }
  if (r.code !== 0) failed = true;
}

console.log(`[check] total ${((performance.now() - started) / 1000).toFixed(2)}s`);
if (failed) process.exit(1);
