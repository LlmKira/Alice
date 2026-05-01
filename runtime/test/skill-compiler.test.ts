/**
 * Skill 编译器测试 — 验证 manifest → TelegramActionDef 编译路径。
 *
 * @see src/skills/compiler.ts
 * @see src/skills/manifest.ts
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { CAPABILITY_FAMILIES } from "../src/core/capability-families.js";
import { executeShellCommand } from "../src/skills/backends/shell.js";
import { compileManifest } from "../src/skills/compiler.js";
import { loadSkill, unloadSkill } from "../src/skills/hot-loader.js";
import { ManifestSchema, type SkillManifest } from "../src/skills/manifest.js";
import {
  buildAliceCommandPath,
  buildAliceContainerCommandPath,
  buildInstalledSkillContainerEnv,
  buildInstalledSkillEnv,
  ensureAllArtifacts,
  exportInstalledSkillArtifacts,
  getAliceStoreRoot,
  getAliceSystemBinDir,
  loadRegistry,
  type Registry,
  removeExportedSkillArtifacts,
  saveRegistry,
} from "../src/skills/registry.js";
import {
  computeHash,
  existsInStore,
  installToStore,
  removeFromStore,
} from "../src/skills/store.js";
import { TELEGRAM_ACTION_MAP } from "../src/telegram/actions/index.js";

// ── Test fixtures ──

const WEATHER_MANIFEST_PATH = resolve(import.meta.dirname, "../skills/weather/manifest.yaml");

function loadWeatherManifest(): SkillManifest {
  const raw = readFileSync(WEATHER_MANIFEST_PATH, "utf-8");
  return ManifestSchema.parse(parseYaml(raw));
}

// ═══════════════════════════════════════════════════════════════════════════
// Manifest Schema
// ═══════════════════════════════════════════════════════════════════════════

describe("manifest schema", () => {
  it("parses weather manifest.yaml", () => {
    const manifest = loadWeatherManifest();
    expect(manifest.name).toBe("weather");
    expect(manifest.version).toBe("1.1.0");
    expect(manifest.actions).toHaveLength(1);
    expect(manifest.actions[0].name).toBe("use_weather_app");
    expect(manifest.actions[0].params).toHaveLength(1);
    expect(manifest.actions[0].params[0].name).toBe("city");
  });

  it("rejects invalid name", () => {
    expect(() =>
      ManifestSchema.parse({
        name: "Weather App", // 空格 + 大写
        version: "1.0.0",
        description: "test",
        actions: [{ name: "test", description: ["test"], whenToUse: "test" }],
      }),
    ).toThrow();
  });

  it("requires at least one action", () => {
    expect(() =>
      ManifestSchema.parse({
        name: "empty",
        version: "1.0.0",
        description: "test",
        actions: [],
      }),
    ).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Compiler
// ═══════════════════════════════════════════════════════════════════════════

describe("manifest compiler", () => {
  it("compiles weather manifest to TelegramActionDef", () => {
    const manifest = loadWeatherManifest();
    const defs = compileManifest(manifest);

    expect(defs).toHaveLength(1);
    const def = defs[0];

    // 基本字段
    expect(def.name).toBe("use_weather_app");
    expect(def.category).toBe("weather");
    expect(def.description).toEqual([
      "Check weather for a city — temperature, condition, wind, humidity.",
      "Like opening a weather app on your phone. Pass the city name.",
    ]);

    // params tuple 格式
    expect(def.params).toHaveLength(1);
    const [paramName, paramDef] = def.params[0];
    expect(paramName).toBe("city");
    expect(paramDef.type).toBe("string");
    expect(paramDef.required).toBe(true);
    expect(paramDef.description).toBe('City name (e.g. "Beijing", "东京")');
    // 无 inject — LLM 可见参数
    expect(paramDef.inject).toBeUndefined();
  });

  it("compiled action has CQRS contract fields", () => {
    const manifest = loadWeatherManifest();
    const def = compileManifest(manifest)[0];

    // QueryAction 判别字段
    expect(def.returnsResult).toBe(true);
    expect(def.resultSource).toBe("self");
    expect(def.resultAttrKey).toBe("last_weather_result");
    expect(typeof def.formatResult).toBe("function");
    expect(def.returnDoc).toBe("Results printed to stdout in next round.");
  });

  it("compiled action has affordance", () => {
    const manifest = loadWeatherManifest();
    const def = compileManifest(manifest)[0];

    expect(def.affordance).toBeDefined();
    expect(def.affordance?.priority).toBe("capability");
    expect(def.affordance?.whenToUse).toBe("Check weather for a city");
  });

  it("compiled action has impl function", () => {
    const manifest = loadWeatherManifest();
    const def = compileManifest(manifest)[0];
    expect(typeof def.impl).toBe("function");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Content-addressed Store
// ═══════════════════════════════════════════════════════════════════════════

describe("content-addressed store", () => {
  it("same content produces same hash", () => {
    const content = "name: test\nversion: 1.0.0";
    const hash1 = computeHash(content);
    const hash2 = computeHash(content);
    expect(hash1).toBe(hash2);
  });

  it("different content produces different hash", () => {
    const hash1 = computeHash("name: test\nversion: 1.0.0");
    const hash2 = computeHash("name: test\nversion: 2.0.0");
    expect(hash1).not.toBe(hash2);
  });

  it("install + exists + remove cycle", () => {
    const tmpStore = resolve(import.meta.dirname, ".test-store");
    const content = `name: test-${Date.now()}\nversion: 1.0.0`;

    const { hash } = installToStore(content, undefined, undefined, tmpStore);
    expect(existsInStore(hash, tmpStore)).toBe(true);

    removeFromStore(hash, tmpStore);
    expect(existsInStore(hash, tmpStore)).toBe(false);

    // 清理
    try {
      rmSync(tmpStore, { recursive: true });
    } catch {
      /* ignore */
    }
  });

  it("copies package body into the store when sourceDir is provided", () => {
    const raw = readFileSync(WEATHER_MANIFEST_PATH, "utf-8");
    const tmpStore = resolve(import.meta.dirname, ".test-store-copy");
    const sourceDir = resolve(import.meta.dirname, "../skills/weather");

    const { hash } = installToStore(raw, sourceDir, "weather", tmpStore);

    expect(existsSync(resolve(tmpStore, hash, "bin", "weather.ts"))).toBe(true);
    expect(existsSync(resolve(tmpStore, hash, "manifest.yaml"))).toBe(true);

    try {
      rmSync(tmpStore, { recursive: true });
    } catch {
      /* ignore */
    }
  });

  it("keeps existing store entries stable on repeated install", () => {
    const raw = readFileSync(WEATHER_MANIFEST_PATH, "utf-8");
    const tmpStore = resolve(import.meta.dirname, ".test-store-backfill");
    const sourceDir = resolve(import.meta.dirname, "../skills/weather");

    const { hash } = installToStore(raw, sourceDir, "weather", tmpStore);

    installToStore(raw, sourceDir, "weather", tmpStore);

    expect(existsSync(resolve(tmpStore, hash, "manifest.yaml"))).toBe(true);

    try {
      rmSync(tmpStore, { recursive: true });
    } catch {
      /* ignore */
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Registry
// ═══════════════════════════════════════════════════════════════════════════

describe("registry", () => {
  it("load empty registry returns {}", () => {
    const registry = loadRegistry("/tmp/nonexistent-registry.json");
    expect(registry).toEqual({});
  });

  it("save and load round-trip", () => {
    const tmpPath = `/tmp/test-registry-${Date.now()}.json`;
    const entries: Registry = {
      weather: {
        name: "weather",
        version: "1.0.0",
        hash: "abc123",
        installedAt: "2026-01-01T00:00:00Z",
        actions: ["use_weather_app"],
        categories: ["weather"],
        capabilities: [],
        backend: "shell",
      },
    };

    saveRegistry(entries, tmpPath);
    const loaded = loadRegistry(tmpPath);
    expect(loaded).toEqual(entries);

    // 清理
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
  });

  it("buildInstalledSkillEnv exposes the system bin as the visible command root", () => {
    const env = buildInstalledSkillEnv({
      skillName: "weather",
      extraEnv: { FOO: "bar" },
    });

    expect(env.PATH.startsWith(getAliceSystemBinDir())).toBe(true);
    expect(env.PATH).not.toContain("/tmp/skills/store/abc123");
    expect(env.ALICE_SYSTEM_BIN_DIR).toBe(getAliceSystemBinDir());
    expect(env.ALICE_STORE_ROOT).toBe(getAliceStoreRoot());
    expect(env.ALICE_SKILL).toBe("weather");
    expect(env.FOO).toBe("bar");
  });

  it("buildInstalledSkillContainerEnv uses a fixed in-container PATH contract", () => {
    const env = buildInstalledSkillContainerEnv({
      skillName: "weather",
      extraEnv: { FOO: "bar" },
      binDir: "/opt/alice/bin",
    });

    expect(env.PATH).toBe(buildAliceContainerCommandPath("/opt/alice/bin"));
    expect(env.PATH).not.toContain(getAliceSystemBinDir());
    expect(env.ALICE_SYSTEM_BIN_DIR).toBe("/opt/alice/bin");
    expect(env.ALICE_SKILL).toBe("weather");
    expect(env.FOO).toBe("bar");
  });

  it("buildAliceCommandPath uses the exported system bin as the first command root", () => {
    const path = buildAliceCommandPath();
    expect(path.startsWith(getAliceSystemBinDir())).toBe(true);
    expect(path).not.toContain("/tmp/skills/store/abc123");
  });

  it("exports installed skill command into Alice bin", () => {
    const tmpRoot = resolve(import.meta.dirname, ".test-exported-roots");
    const skillDir = resolve(tmpRoot, "store", "hash-weather");
    const binDir = resolve(tmpRoot, "bin");
    mkdirSync(skillDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(resolve(skillDir, "weather"), "#!/usr/bin/env sh\n");

    try {
      const exported = exportInstalledSkillArtifacts(
        {
          name: "weather",
          hash: "test-hash-123",
          storePath: skillDir,
          commandPath: resolve(skillDir, "weather"),
        },
        { binDir },
      );

      expect(existsSync(exported.commandPath)).toBe(true);
      expect(readFileSync(exported.commandPath, "utf-8")).toContain('export ALICE_SKILL="weather"');
      expect(readFileSync(exported.commandPath, "utf-8")).toContain(
        'exec "$self_dir/.weather.real" "$@"',
      );
      expect(existsSync(resolve(binDir, ".weather.real"))).toBe(true);

      removeExportedSkillArtifacts("weather", { binDir });
      expect(existsSync(exported.commandPath)).toBe(false);
    } finally {
      try {
        rmSync(tmpRoot, { recursive: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("atomically switches exported command wrapper when a skill is re-exported", () => {
    const tmpRoot = resolve(import.meta.dirname, ".test-exported-command-switch");
    const oldSkillDir = resolve(tmpRoot, "store", "hash-old");
    const newSkillDir = resolve(tmpRoot, "store", "hash-new");
    const binDir = resolve(tmpRoot, "bin");

    mkdirSync(oldSkillDir, { recursive: true });
    mkdirSync(newSkillDir, { recursive: true });
    writeFileSync(resolve(oldSkillDir, "weather"), "#!/usr/bin/env sh\necho old\n");
    writeFileSync(resolve(newSkillDir, "weather"), "#!/usr/bin/env sh\necho new\n");

    try {
      exportInstalledSkillArtifacts(
        {
          name: "weather",
          hash: "hash-old",
          storePath: oldSkillDir,
          commandPath: resolve(oldSkillDir, "weather"),
        },
        { binDir, storeRoot: resolve(tmpRoot, "store") },
      );
      expect(lstatSync(resolve(binDir, "weather")).isSymbolicLink()).toBe(false);
      expect(readFileSync(resolve(binDir, "weather"), "utf-8")).toContain(
        'export ALICE_SKILL="weather"',
      );
      expect(existsSync(resolve(binDir, ".weather.real"))).toBe(true);

      exportInstalledSkillArtifacts(
        {
          name: "weather",
          hash: "hash-new",
          storePath: newSkillDir,
          commandPath: resolve(newSkillDir, "weather"),
        },
        { binDir, storeRoot: resolve(tmpRoot, "store") },
      );
      expect(readFileSync(resolve(binDir, "weather"), "utf-8")).toContain(
        'export ALICE_SKILL="weather"',
      );
      expect(existsSync(resolve(binDir, ".weather.real"))).toBe(true);
    } finally {
      try {
        rmSync(tmpRoot, { recursive: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("ensureAllArtifacts detects and fixes broken wrappers", () => {
    const tmpRoot = resolve(import.meta.dirname, ".test-ensure-artifacts");
    const storeRoot = resolve(tmpRoot, "store");
    const binDir = resolve(tmpRoot, "bin");
    const registryPath = resolve(tmpRoot, "registry.json");

    const skillDir = resolve(storeRoot, "hash-valid", "google");
    mkdirSync(skillDir, { recursive: true });

    // 创建 registry
    writeFileSync(
      registryPath,
      JSON.stringify({
        google: {
          name: "google",
          version: "1.0.0",
          hash: "hash-valid",
          storePath: skillDir,
          commandPath: resolve(skillDir, "google"),
        },
      }),
    );

    // 创建 broken symlink（指向不存在的目标）
    mkdirSync(binDir, { recursive: true });
    symlinkSync("../store/hash-wrong/google", resolve(binDir, "google.tmp"));
    renameSync(resolve(binDir, "google.tmp"), resolve(binDir, "google"));

    try {
      // 调用 ensureAllArtifacts（传入测试目录）
      const result = ensureAllArtifacts({ registryPath, binDir, storeRoot });

      // 应该检测到 broken 并修复
      expect(result.fixed).toBe(1);
      expect(existsSync(resolve(binDir, "google"))).toBe(true);

      expect(lstatSync(resolve(binDir, "google")).isSymbolicLink()).toBe(false);
      expect(readFileSync(resolve(binDir, "google"), "utf-8")).toContain(
        'export ALICE_SKILL="google"',
      );
      expect(existsSync(resolve(binDir, ".google.real"))).toBe(true);
    } finally {
      try {
        rmSync(tmpRoot, { recursive: true });
      } catch {
        /* ignore */
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Hot Loader
// ═══════════════════════════════════════════════════════════════════════════

describe("hot loader", () => {
  it("loadSkill registers actions and unloadSkill removes them", () => {
    const manifest = loadWeatherManifest();
    const defs = compileManifest(manifest);

    // 记录初始状态
    const hadWeatherBefore = TELEGRAM_ACTION_MAP.has("use_weather_app");

    // 加载（幂等：如果已存在则先移除再添加）
    loadSkill(defs, manifest);
    expect(TELEGRAM_ACTION_MAP.has("use_weather_app")).toBe(true);

    // 卸载
    unloadSkill(["use_weather_app"], ["weather"]);
    expect(TELEGRAM_ACTION_MAP.has("use_weather_app")).toBe(false);

    // 如果之前有手写版，重新注册回去（保持测试隔离）
    if (hadWeatherBefore) {
      // 恢复手写版——从 appActions 重新导入
      // 这里不恢复也没关系，其他测试不依赖 weather action
    }
  });

  it("loadSkill registers CAPABILITY_FAMILIES entry", () => {
    const manifest = loadWeatherManifest();
    const defs = compileManifest(manifest);

    loadSkill(defs, manifest);

    // manifest 有 family → 应注册到 CAPABILITY_FAMILIES
    const family = (CAPABILITY_FAMILIES as Record<string, unknown>).weather;
    // 注意：手写版可能已经存在 weather family
    // 编译版会覆盖它
    expect(family).toBeDefined();

    // 清理
    unloadSkill(["use_weather_app"], []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Shell Backend — injection prevention
// ═══════════════════════════════════════════════════════════════════════════

describe("shell backend", () => {
  it("wraps params in single quotes for shell safety", async () => {
    // executeShellCommand 用 execFile + /bin/sh -c，
    // 我们验证参数值被安全引用（通过 echo 命令）
    const result = await executeShellCommand({
      command: "echo {{msg}}",
      params: { msg: "hello world" },
      timeout: 5,
    });
    expect(result).toBe("hello world");
  });

  it("prevents shell injection via single-quote escaping", async () => {
    // 注入尝试：参数包含 shell 元字符
    // 如果注入成功：echo safe 输出 "safe"，然后 echo INJECTED 输出 "INJECTED"
    // 如果注入被阻止：echo 输出完整字面量 "safe; echo INJECTED"
    const result = await executeShellCommand({
      command: "echo {{msg}}",
      params: { msg: "safe; echo INJECTED" },
      timeout: 5,
    });
    // 安全：输出应该是一行完整的字面量（包含分号和 echo）
    expect(result).toBe("safe; echo INJECTED");
    // 验证不是两行（如果注入成功，shell 会执行两个命令产生两行输出）
    expect(result.split("\n")).toHaveLength(1);
  });

  it("handles single quotes in param values", async () => {
    const result = await executeShellCommand({
      command: "echo {{msg}}",
      params: { msg: "it's a test" },
      timeout: 5,
    });
    expect(result).toBe("it's a test");
  });

  it("handles null/undefined params as empty quoted string", async () => {
    const result = await executeShellCommand({
      command: "echo {{msg}}",
      params: { msg: null as unknown as string },
      timeout: 5,
    });
    expect(result).toBe("");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Compiler — edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("compiler edge cases", () => {
  it("rejects MCP backend with clear error", () => {
    const manifest: SkillManifest = {
      name: "test-mcp",
      version: "1.0.0",
      description: "test",
      capabilities: [],
      actions: [
        {
          name: "test_action",
          category: "app",
          description: ["test"],
          whenToUse: "test",
          params: [],
        },
      ],
      runtime: {
        backend: "mcp",
        timeout: 30,
        network: true,
        isolation: "container",
        memory: "512m",
      },
    };
    expect(() => compileManifest(manifest)).toThrow("MCP backend is not yet implemented");
  });

  it("detects attrKey collision across actions", () => {
    const manifest: SkillManifest = {
      name: "test-collision",
      version: "1.0.0",
      description: "test",
      capabilities: [],
      actions: [
        {
          name: "use_foo_app",
          category: "app",
          description: ["test"],
          whenToUse: "test",
          params: [],
          runtime: {
            backend: "shell",
            timeout: 10,
            network: true,
            isolation: "container",
            memory: "512m",
            shell: { command: "echo test" },
          },
        },
        {
          // use_foo_app → last_foo_result, foo → last_foo_result — 碰撞
          name: "foo",
          category: "app",
          description: ["test"],
          whenToUse: "test",
          params: [],
          runtime: {
            backend: "shell",
            timeout: 10,
            network: true,
            isolation: "container",
            memory: "512m",
            shell: { command: "echo test" },
          },
        },
      ],
    };
    expect(() => compileManifest(manifest)).toThrow("duplicate resultAttrKey");
  });

  it("formatResult uses JSON fallback", () => {
    const manifest: SkillManifest = {
      name: "test-no-format",
      version: "1.0.0",
      description: "test",
      capabilities: [],
      actions: [
        {
          name: "use_test_app",
          category: "app",
          description: ["test"],
          whenToUse: "test",
          params: [],
          runtime: {
            backend: "shell",
            timeout: 10,
            network: true,
            isolation: "container",
            memory: "512m",
            shell: { command: "echo test" },
          },
        },
      ],
    };
    const def = compileManifest(manifest)[0];
    const result = def.formatResult?.({ temp: 20 });
    expect(result).toBeDefined();
    expect(result?.[0]).toContain('"temp"');
  });

  it("required array param produces non-optional schema", () => {
    const manifest: SkillManifest = {
      name: "test-array",
      version: "1.0.0",
      description: "test",
      capabilities: [],
      actions: [
        {
          name: "use_test_app",
          category: "app",
          description: ["test"],
          whenToUse: "test",
          params: [{ name: "items", type: "array", required: true, description: "items" }],
          runtime: {
            backend: "shell",
            timeout: 10,
            network: true,
            isolation: "container",
            memory: "512m",
            shell: { command: "echo test" },
          },
        },
      ],
    };
    const def = compileManifest(manifest)[0];
    const [, paramDef] = def.params[0];
    expect(paramDef.required).toBe(true);
    // required array: null/undefined → 空数组（不是 undefined）
    expect(paramDef.schema).toBeDefined();
    if (!paramDef.schema) throw new Error("schema missing");
    const parsed = paramDef.schema.safeParse(null);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Array.isArray(parsed.data)).toBe(true);
    }
  });
});
