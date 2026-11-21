import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, loadRuntimeConfig } from "../src/config.js";

const ENV_KEYS = [
  "ALICE_CONFIG_PATH",
  "TEST_TELEGRAM_API_ID",
  "TEST_TELEGRAM_HASH",
  "TEST_TELEGRAM_PHONE",
  "TEST_LLM_API_KEY",
] as const;

const CONFIG = `
[telegram]
api_id_env = "TEST_TELEGRAM_API_ID"
api_hash_env = "TEST_TELEGRAM_HASH"
phone_env = "TEST_TELEGRAM_PHONE"

[speech]
api_key_env = "TEST_LLM_API_KEY"
`;

const previous = new Map<string, string | undefined>();
let tempDir = "";

beforeEach(() => {
  for (const key of ENV_KEYS) previous.set(key, process.env[key]);
  process.env.TEST_TELEGRAM_API_ID = "123";
  process.env.TEST_TELEGRAM_HASH = "hash";
  process.env.TEST_TELEGRAM_PHONE = "+10000000000";
  process.env.TEST_LLM_API_KEY = "secret";
  tempDir = mkdtempSync(join(tmpdir(), "alice-config-"));
  process.env.ALICE_CONFIG_PATH = join(tempDir, "config.toml");
  writeFileSync(process.env.ALICE_CONFIG_PATH, CONFIG);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previous.clear();
});

describe("loadConfig", () => {
  it("loads Telegram and speech settings from the named environment variables", () => {
    expect(loadConfig()).toEqual({
      telegramApiId: 123,
      telegramApiHash: "hash",
      telegramPhone: "+10000000000",
      speech: { apiKey: "secret" },
      ignoredSenders: new Set(),
    });
  });

  it("reads the ignored senders from the environment, not from the repository", () => {
    process.env.ALICE_IGNORED_SENDERS = " 1000000002 ,1000000003,";
    try {
      expect([...loadConfig().ignoredSenders]).toEqual(["1000000002", "1000000003"]);
    } finally {
      delete process.env.ALICE_IGNORED_SENDERS;
    }
  });

  it("rejects a missing secret", () => {
    delete process.env.TEST_LLM_API_KEY;
    expect(() => loadConfig()).toThrow("TEST_LLM_API_KEY");
  });

  it("rejects a non-integer Telegram API id", () => {
    process.env.TEST_TELEGRAM_API_ID = "abc";
    expect(() => loadConfig()).toThrow("Telegram API ID must be an integer");
  });
});

describe("loadRuntimeConfig (what --check validates before she goes live)", () => {
  const env = (extra: Record<string, string>) => ({
    ...process.env,
    ALICE_OPERATOR_ID: "42",
    ...extra,
  });

  it("requires ALICE_TTS to be on or off when specified", () => {
    expect(() => loadRuntimeConfig(env({ ALICE_TTS: "bad" }))).toThrow("ALICE_TTS");
  });

  it("decides the lookup switch once: on with an exa key, off without one or when switched off", () => {
    expect(loadRuntimeConfig(env({ EXA_API_KEY: "k" })).errands).toEqual({ exaKey: "k" });
    expect(loadRuntimeConfig(env({ EXA_API_KEY: "" })).errands).toBeNull();
    expect(loadRuntimeConfig(env({ EXA_API_KEY: "k", ALICE_ERRANDS: "off" })).errands).toBeNull();
    expect(() => loadRuntimeConfig(env({ ALICE_ERRANDS: "no" }))).toThrow("ALICE_ERRANDS");
  });

  it("needs the operator", () => {
    expect(() => loadRuntimeConfig({ ...process.env, ALICE_OPERATOR_ID: "" })).toThrow(
      "ALICE_OPERATOR_ID",
    );
  });

  it("sends pictures for tagging only to this machine; without the URL there is no tagger", () => {
    const url = (u: string) => loadRuntimeConfig(env({ ALICE_TAGGER_URL: u })).taggerUrl;
    expect(url("http://127.0.0.1:39100")).toBe("http://127.0.0.1:39100");
    expect(url("http://localhost:39100")).toBe("http://localhost:39100");
    expect(url("")).toBeNull();
    expect(() => url("https://tagger.example.com")).toThrow("ALICE_TAGGER_URL");
    expect(() => url("127.0.0.1:39100")).toThrow("ALICE_TAGGER_URL");
  });

  it("rotates only when a candidate is named, and then only with a seed", () => {
    expect(loadRuntimeConfig(env({ ALICE_ROTATE: "" })).rotation).toBeNull();
    expect(
      loadRuntimeConfig(env({ ALICE_ROTATE: "phone", ALICE_ROTATE_SEED: "s1" })).rotation,
    ).toEqual({ candidate: "phone", seed: "s1", unit: null });
    expect(() => loadRuntimeConfig(env({ ALICE_ROTATE: "phone" }))).toThrow("ALICE_ROTATE_SEED");
    expect(() =>
      loadRuntimeConfig(
        env({ ALICE_ROTATE: "phone", ALICE_ROTATE_SEED: "s1", ALICE_ROTATE_UNIT: "group" }),
      ),
    ).toThrow("ALICE_ROTATE_UNIT");
  });

  /** 把语音合成的环境变量清空：本机的 .env/.env.local 里有密钥，不清空就测不到"没有密钥"的分支。 */
  const noTts = {
    ELEVENLABS_API_KEY: "",
    ELEVENLABS_VOICE_ID: "",
    TTS_PROVIDER: "",
    TTS_API_KEY: "",
    MINIMAX_API_KEY: "",
    TTS_BASE_URL: "",
    TTS_MODEL: "",
    TTS_VOICE: "",
    TTS_GROUP_ID: "",
    ALICE_TTS: "",
  };

  it("disables TTS when no key is present or ALICE_TTS=off", () => {
    expect(loadRuntimeConfig(env(noTts)).tts).toBeNull();
    expect(
      loadRuntimeConfig(env({ ...noTts, TTS_BASE_URL: "https://api.minimax.io" })).tts,
    ).toBeNull();
    expect(loadRuntimeConfig(env({ ...noTts, TTS_API_KEY: "k", ALICE_TTS: "off" })).tts).toBeNull();
    expect(
      loadRuntimeConfig(env({ ...noTts, ELEVENLABS_API_KEY: "el", ALICE_TTS: "off" })).tts,
    ).toBeNull();
  });

  it("prefers ElevenLabs (eleven_v4_turbo) when ELEVENLABS_API_KEY is present, and allows switching to MiniMax", () => {
    expect(
      loadRuntimeConfig(env({ ...noTts, ELEVENLABS_API_KEY: "el", TTS_API_KEY: "k" })).tts,
    ).toEqual({
      provider: "elevenlabs",
      apiKey: "el",
      model: "eleven_v4_turbo",
      voice: "cgSgspJ2msm6clMCkdW9",
      stability: 0.4,
      similarityBoost: 0.75,
    });
    expect(
      loadRuntimeConfig(
        env({
          ...noTts,
          ELEVENLABS_API_KEY: "el",
          TTS_MODEL: "eleven_v4",
          ELEVENLABS_VOICE_ID: "JBFqnCBsd6RMkjVDRZzb",
        }),
      ).tts,
    ).toMatchObject({
      provider: "elevenlabs",
      model: "eleven_v4",
      voice: "JBFqnCBsd6RMkjVDRZzb",
    });
    expect(
      loadRuntimeConfig(
        env({ ...noTts, ELEVENLABS_API_KEY: "el", TTS_API_KEY: "k", TTS_PROVIDER: "minimax" }),
      ).tts,
    ).toMatchObject({
      provider: "minimax",
      apiKey: "k",
      model: "speech-2.8-hd",
    });
    expect(() => loadRuntimeConfig(env({ ...noTts, TTS_PROVIDER: "elevenlabs" }))).toThrow(
      "ELEVENLABS_API_KEY",
    );
    expect(() => loadRuntimeConfig(env({ ...noTts, TTS_PROVIDER: "other" }))).toThrow(
      "TTS_PROVIDER",
    );
  });

  it("enables MiniMax (speech-2.8-hd) when only a MiniMax key is there", () => {
    expect(loadRuntimeConfig(env({ ...noTts, TTS_API_KEY: "k" })).tts).toEqual({
      provider: "minimax",
      baseUrl: "https://api.minimaxi.com",
      apiKey: "k",
      model: "speech-2.8-hd",
      voice: "qiaopi_mengmei",
      groupId: null,
    });
    expect(loadRuntimeConfig(env({ ...noTts, MINIMAX_API_KEY: "m" })).tts).toMatchObject({
      provider: "minimax",
      apiKey: "m",
      model: "speech-2.8-hd",
      voice: "qiaopi_mengmei",
    });
    expect(
      loadRuntimeConfig(
        env({
          ...noTts,
          TTS_API_KEY: "k",
          TTS_BASE_URL: "https://api.minimax.io",
          TTS_MODEL: "speech-2.8-turbo",
          TTS_VOICE: "Wise_Woman",
          TTS_GROUP_ID: "g1",
        }),
      ).tts,
    ).toEqual({
      provider: "minimax",
      baseUrl: "https://api.minimax.io",
      apiKey: "k",
      model: "speech-2.8-turbo",
      voice: "Wise_Woman",
      groupId: "g1",
    });
  });

  it("enables ALICE_VOICE_CALLS by default when TTS is present, and allows explicit off", () => {
    expect(loadRuntimeConfig(env({ ...noTts, ALICE_VOICE_CALLS: "" })).voiceCalls).toBe(false);
    expect(loadRuntimeConfig(env({ ...noTts, ELEVENLABS_API_KEY: "el" })).voiceCalls).toBe(true);
    expect(loadRuntimeConfig(env({ ...noTts, TTS_API_KEY: "k" })).voiceCalls).toBe(true);
    expect(
      loadRuntimeConfig(env({ ...noTts, TTS_API_KEY: "k", ALICE_VOICE_CALLS: "off" })).voiceCalls,
    ).toBe(false);
    expect(
      loadRuntimeConfig(env({ ...noTts, TTS_API_KEY: "k", ALICE_VOICE_CALLS: "on" })).voiceCalls,
    ).toBe(true);
    expect(() => loadRuntimeConfig(env({ ...noTts, ALICE_VOICE_CALLS: "on" }))).toThrow(
      "ALICE_VOICE_CALLS=on",
    );
    expect(() => loadRuntimeConfig(env({ ...noTts, ALICE_VOICE_CALLS: "maybe" }))).toThrow(
      "ALICE_VOICE_CALLS",
    );
  });
});
