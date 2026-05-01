import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET_ENV_KEYS = [
  "ALICE_CONFIG_PATH",
  "TEST_TELEGRAM_API_ID",
  "TEST_LLM_API_KEY",
  "TEST_TELEGRAM_HASH",
  "TEST_TELEGRAM_PHONE",
  "TEST_TELEGRAM_ADMIN",
  "TEST_EXA_KEY",
  "TEST_YOUTUBE_KEY",
  "TEST_ONEBOT_TOKEN",
  "TEST_TTS_GROUP_ID",
] as const;

const previousEnv = new Map<string, string | undefined>();

function writeConfig(path: string, extra = ""): void {
  writeFileSync(
    path,
    `
[telegram]
api_id_env = "TEST_TELEGRAM_API_ID"
api_hash_env = "TEST_TELEGRAM_HASH"
phone_env = "TEST_TELEGRAM_PHONE"
admin_env = "TEST_TELEGRAM_ADMIN"

[[llm.endpoints]]
name = "steady"
base_url = "https://llm.example/v1"
api_key_env = "TEST_LLM_API_KEY"
model = "steady-model"

[[llm.endpoints]]
name = "fresh"
base_url = "https://llm.example/v1"
api_key_env = "TEST_LLM_API_KEY"
model = "fresh-model"

[[llm.endpoints]]
name = "auxiliary"
base_url = "https://auxiliary.example/v1"
api_key_env = "TEST_LLM_API_KEY"
model = "auxiliary-model"

[llm.routing]
first_pass = ["fresh", "steady"]
tool_tick = ["steady"]
eval = ["steady"]
auxiliary = ["auxiliary", "steady"]
reflect = ["steady"]

[services]
exa_api_key_env = "TEST_EXA_KEY"
youtube_api_key_env = "TEST_YOUTUBE_KEY"

${extra}
`.trimStart(),
    "utf-8",
  );
}

beforeEach(() => {
  for (const key of SECRET_ENV_KEYS) previousEnv.set(key, process.env[key]);
  process.env.TEST_TELEGRAM_API_ID = "123";
  process.env.TEST_LLM_API_KEY = "llm-secret";
  process.env.TEST_TELEGRAM_HASH = "tg-hash";
  process.env.TEST_TELEGRAM_PHONE = "+10000000000";
  process.env.TEST_TELEGRAM_ADMIN = "42";
  process.env.TEST_EXA_KEY = "exa-secret";
  process.env.TEST_YOUTUBE_KEY = "youtube-secret";
  process.env.TEST_ONEBOT_TOKEN = "onebot-secret";
  process.env.TEST_TTS_GROUP_ID = "tts-group-secret";
});

afterEach(() => {
  for (const key of SECRET_ENV_KEYS) {
    const previous = previousEnv.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  previousEnv.clear();
  vi.resetModules();
});

describe("loadConfig TOML", () => {
  it("从 TOML 读取非敏感配置，并通过 env 名称注入 secret", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "alice-config-"));
    const configPath = join(tempDir, "config.toml");
    writeConfig(
      configPath,
      `
[time]
timezone_offset = 9

[action_rate]
cap_group = 6
`,
    );
    process.env.ALICE_CONFIG_PATH = configPath;

    try {
      vi.resetModules();
      const { loadConfig } = await import("../src/config.js");
      const config = loadConfig();

      expect(config.telegramApiId).toBe(123);
      expect(config.telegramApiHash).toBe("tg-hash");
      expect(config.telegramPhone).toBe("+10000000000");
      expect(config.telegramAdmin).toBe("42");
      expect(config.operatorChannelId).toBe("channel:telegram:42");
      expect(config.providers).toEqual([
        expect.objectContaining({
          name: "steady",
          baseUrl: "https://llm.example/v1",
          apiKey: "llm-secret",
          model: "steady-model",
        }),
        expect.objectContaining({ name: "fresh", model: "fresh-model" }),
        expect.objectContaining({ name: "auxiliary", model: "auxiliary-model" }),
      ]);
      expect(config.llmRouting).toEqual({
        firstPass: ["fresh", "steady"],
        toolTick: ["steady"],
        eval: ["steady"],
        auxiliary: ["auxiliary", "steady"],
        reflect: ["steady"],
      });
      expect(config.llmBaseUrl).toBe("https://llm.example/v1");
      expect(config.llmApiKey).toBe("llm-secret");
      expect(config.exaApiKey).toBe("exa-secret");
      expect(config.youtubeApiKey).toBe("youtube-secret");
      expect(config.qqOneBotApiBaseUrl).toBe("");
      expect(config.qqOneBotEventWsUrl).toBe("");
      expect(config.qqOneBotAccessToken).toBe("");
      expect(config.qqOneBotTimeoutMs).toBe(10_000);
      expect(config.qqOneBotReconnectMinMs).toBe(1_000);
      expect(config.qqOneBotReconnectMaxMs).toBe(60_000);
      expect(config.timezoneOffset).toBe(9);
      expect(config.rateCap.group).toBe(6);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("缺少 provider secret 时不回退旧 LLM_* env", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "alice-config-missing-secret-"));
    const configPath = join(tempDir, "config.toml");
    writeConfig(configPath);
    process.env.ALICE_CONFIG_PATH = configPath;
    delete process.env.TEST_LLM_API_KEY;
    process.env.LLM_API_KEY = "legacy-secret";

    try {
      vi.resetModules();
      const { loadConfig } = await import("../src/config.js");
      const config = loadConfig();

      expect(config.llmApiKey).toBe("");
      expect(config.providers[0]?.apiKey).toBe("");
    } finally {
      delete process.env.LLM_API_KEY;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("读取 QQ OneBot bridge 配置", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "alice-config-qq-onebot-"));
    const configPath = join(tempDir, "config.toml");
    writeConfig(
      configPath,
      `
[qq]
onebot_api_base_url = "http://127.0.0.1:3000"
onebot_event_ws_url = "ws://127.0.0.1:3001"
onebot_access_token_env = "TEST_ONEBOT_TOKEN"
onebot_timeout_ms = 3000
onebot_reconnect_min_ms = 2000
onebot_reconnect_max_ms = 30000
`,
    );
    process.env.ALICE_CONFIG_PATH = configPath;

    try {
      vi.resetModules();
      const { loadConfig } = await import("../src/config.js");
      const config = loadConfig();

      expect(config.qqOneBotApiBaseUrl).toBe("http://127.0.0.1:3000");
      expect(config.qqOneBotEventWsUrl).toBe("ws://127.0.0.1:3001");
      expect(config.qqOneBotAccessToken).toBe("onebot-secret");
      expect(config.qqOneBotTimeoutMs).toBe(3000);
      expect(config.qqOneBotReconnectMinMs).toBe(2000);
      expect(config.qqOneBotReconnectMaxMs).toBe(30000);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("可选 secret env 名允许用空字符串显式禁用", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "alice-config-empty-optional-env-"));
    const configPath = join(tempDir, "config.toml");
    writeFileSync(
      configPath,
      `
[telegram]
api_id_env = "TEST_TELEGRAM_API_ID"
api_hash_env = "TEST_TELEGRAM_HASH"
phone_env = "TEST_TELEGRAM_PHONE"
admin_env = "TEST_TELEGRAM_ADMIN"

[[llm.endpoints]]
name = "steady"
base_url = "https://llm.example/v1"
api_key_env = "TEST_LLM_API_KEY"
model = "steady-model"

[llm.routing]
first_pass = ["steady"]
tool_tick = ["steady"]
eval = ["steady"]

[vision]
api_key_env = ""

[tts]
api_key_env = ""
group_id_env = ""

[asr]
api_key_env = ""

[services]
exa_api_key_env = ""
youtube_api_key_env = ""
`.trimStart(),
      "utf-8",
    );
    process.env.ALICE_CONFIG_PATH = configPath;

    try {
      vi.resetModules();
      const { loadConfig } = await import("../src/config.js");
      const config = loadConfig();

      expect(config.exaApiKey).toBe("");
      expect(config.youtubeApiKey).toBe("");
      expect(config.ttsApiKey).toBe("");
      expect(config.ttsGroupId).toBe("");
      expect(config.asrApiKey).toBe("");
      expect(config.visionApiKey).toBe("llm-secret");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("MiniMax group_id 通过 env 注入，避免 TOML 暴露实例账号标识", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "alice-config-tts-group-"));
    const configPath = join(tempDir, "config.toml");
    writeConfig(
      configPath,
      `
[tts]
group_id_env = "TEST_TTS_GROUP_ID"
`,
    );
    process.env.ALICE_CONFIG_PATH = configPath;

    try {
      vi.resetModules();
      const { loadConfig } = await import("../src/config.js");
      const config = loadConfig();

      expect(config.ttsGroupId).toBe("tts-group-secret");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("自动发现 ALICE_STATE_DIR 下的焦点白名单文件", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "alice-focus-whitelist-"));
    const whitelistPath = join(tempDir, "focus-whitelist.txt");
    const configPath = join(tempDir, "config.toml");
    writeFileSync(
      whitelistPath,
      ["# 只允许这些目标", "-1001234567890 # 主群", "", "7785440246", "-1001234567890"].join("\n"),
      "utf-8",
    );
    writeConfig(configPath);

    const previousStateDir = process.env.ALICE_STATE_DIR;
    process.env.ALICE_CONFIG_PATH = configPath;
    process.env.ALICE_STATE_DIR = tempDir;

    try {
      vi.resetModules();
      const { loadConfig } = await import("../src/config.js");
      const config = loadConfig();

      expect(config.focusWhitelistPath).toBe(whitelistPath);
      expect(Array.from(config.focusWhitelist ?? [])).toEqual([
        "channel:telegram:-1001234567890",
        "channel:telegram:7785440246",
      ]);
    } finally {
      if (previousStateDir === undefined) delete process.env.ALICE_STATE_DIR;
      else process.env.ALICE_STATE_DIR = previousStateDir;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("优先使用 TOML 内联焦点白名单", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "alice-focus-whitelist-inline-"));
    const configPath = join(tempDir, "config.toml");
    writeConfig(
      configPath,
      `
[focus]
whitelist = ["-1001234567890", "7785440246"]
`,
    );
    process.env.ALICE_CONFIG_PATH = configPath;

    try {
      vi.resetModules();
      const { loadConfig } = await import("../src/config.js");
      const config = loadConfig();

      expect(config.focusWhitelistPath).toBe("config.toml:focus.whitelist");
      expect(Array.from(config.focusWhitelist ?? [])).toEqual([
        "channel:telegram:-1001234567890",
        "channel:telegram:7785440246",
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("支持 TOML 显式覆盖焦点白名单路径", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "alice-focus-whitelist-explicit-"));
    const whitelistPath = join(tempDir, "custom-focus.txt");
    const configPath = join(tempDir, "config.toml");
    writeFileSync(whitelistPath, "123456789\n", "utf-8");
    writeConfig(
      configPath,
      `
[focus]
whitelist_path = "${whitelistPath}"
`,
    );
    process.env.ALICE_CONFIG_PATH = configPath;

    try {
      vi.resetModules();
      const { loadConfig } = await import("../src/config.js");
      const config = loadConfig();

      expect(config.focusWhitelistPath).toBe(whitelistPath);
      expect(Array.from(config.focusWhitelist ?? [])).toEqual(["channel:telegram:123456789"]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
