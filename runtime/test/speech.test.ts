import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createGateway, GatewayError, type Spent } from "../src/llm/gateway.js";
import { callSpeechModel } from "../src/llm/speech-model.js";
import {
  type ElevenlabsClientLike,
  type ElevenlabsTts,
  elevenlabsSpent,
  type MinimaxTts,
  minimaxSpent,
  synthesizeElevenlabs,
  synthesizeMinimax,
  synthesizeSpeech,
} from "../src/llm/tts.js";
import type { SpeechRequest } from "../src/mind/effects.js";
import { parseDecision } from "../src/speech/decision.js";
import { renderSpeechPrompt } from "../src/speech/prompt.js";

const T0 = 1_771_000_000_000;

const request: SpeechRequest = {
  scope: "telegram:-5",
  chatType: "group",
  triggerMessageId: "4",
  at: T0 + 41 * 60_000,
  affordances: ["send", "sticker", "react", "mark-read", "leave-chat"],
  contributions: [
    { mechanism: "test", kind: "scene", text: "你和 小雨 很熟。" },
    { mechanism: "test", kind: "turn", text: "小雨 用中文跟你说话。", language: "中文" },
  ],
  timeline: [
    {
      at: T0,
      messageId: "2",
      sender: { id: "v", name: "小雨" },
      text: "显卡快 100 度了",
      contentType: "text",
      replyToMessageId: null,
    },
    {
      at: T0 + 1000,
      messageId: "3",
      sender: null,
      text: "快关机吧",
      contentType: "text",
      replyToMessageId: "2",
    },
    {
      at: T0 + 40 * 60_000,
      messageId: "4",
      sender: { id: "v", name: "小雨" },
      text: null,
      contentType: "sticker",
      replyToMessageId: null,
    },
  ],
};

/** 0.5 秒的静音 WAV（24 kHz、16 位单声道）。 */
function halfSecond(): Buffer {
  const rate = 24_000;
  const bytes = rate; // 每秒 rate × 2 字节，半秒就是 rate 字节
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + bytes, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(bytes, 40);
  return Buffer.concat([header, Buffer.alloc(bytes)]);
}
/** 同一段静音编成 mp3：两家服务真正回的格式。 */
const halfSecondMp3 = () =>
  execFileSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-f", "wav", "-i", "pipe:0", "-f", "mp3", "pipe:1"],
    { input: halfSecond(), maxBuffer: 1 << 20 },
  );

describe("renderSpeechPrompt", () => {
  const prompt = renderSpeechPrompt("You are Alice.", request);

  it("puts the persona first and the output rules after it", () => {
    expect(prompt.system.startsWith("You are Alice.")).toBe(true);
    expect(prompt.system).toContain("replyTo?: string;");
    expect(prompt.system).toContain("laugh");
    expect(prompt.tools?.map((t) => t.function.name)).toEqual(["run_code"]);
  });

  it("lays the chat out as a log: time, number, <name>, her own lines as 你, quotes and media", () => {
    const log = prompt.user.split("\n");
    const at = (id: string) => log.find((l) => l.includes(`[${id}] <`)) ?? "";
    expect(at("2")).toMatch(/^\d\d:\d\d \[2\] <小雨> 显卡快 100 度了$/);
    expect(at("3")).toMatch(/^\d\d:\d\d \[3\] <你> （回复 \[2\]）快关机吧$/);
    expect(at("4")).toMatch(/^\d\d:\d\d \[4\] <小雨> \[贴纸\]$/);
    // 40 分钟的间隔从时间上看得出来。
    expect(at("2").slice(0, 5)).not.toBe(at("4").slice(0, 5));
  });

  it("puts background facts in the card above the log, this turn's situation and the trigger below it", () => {
    const user = prompt.user;
    expect(user.indexOf("· 你和 小雨 很熟。")).toBeLessThan(user.indexOf("[2] <小雨>"));
    expect(user.indexOf("小雨 用中文跟你说话。")).toBeGreaterThan(user.indexOf("[4] <小雨>"));
    expect(user.split("\n").at(-1)).toMatch(/^\[4\] 之后/);
  });

  it("says what time it is now, with the year in the card's title, and how long since the last message when that was long ago", () => {
    // 带年份：没有年份时模型按训练时的年份去猜，线上她质疑过"2026 年是怎么回事"。
    expect(prompt.user).toMatch(/^Telegram 群聊 · \d{4}年\d+月\d+日 周.\n/);
    expect(prompt.user).toMatch(/\n现在是 \d\d:\d\d。/);
    expect(prompt.user).not.toContain("离最后一条");
    const later = renderSpeechPrompt("You are Alice.", { ...request, at: T0 + 5 * 3_600_000 });
    expect(later.user).toContain("离最后一条已经过了 4 小时");
  });

  it("lists only the actions available in this chat", () => {
    expect(prompt.system).toContain("  react: {");
    expect(prompt.system).toContain("  leave_chat: ");
    const dm = renderSpeechPrompt("p", { ...request, affordances: ["send", "sticker", "react"] });
    expect(dm.system).not.toContain("leave_chat");
    expect(dm.system).not.toContain("mark_read");
  });

  it("is deterministic", () => {
    expect(renderSpeechPrompt("You are Alice.", request)).toEqual(prompt);
  });
});

describe("MiniMax voice synthesis (the optional backend)", () => {
  const tts: MinimaxTts = {
    baseUrl: "https://api.minimax.io/",
    apiKey: "mk",
    model: "speech-2.8-hd",
    voice: "Calm_Woman",
    groupId: "g1",
  };
  const reply =
    (body: unknown, status = 200) =>
    async () =>
      Response.json(body, { status });

  it("posts the latest protocol and turns the hex audio into Ogg/Opus with a duration", async () => {
    const sent: Array<{ url: string; init?: RequestInit }> = [];
    const audio = halfSecond();
    const voice = await synthesizeMinimax(tts, "喂，听得到吗？", {
      fetch: (async (input: string | URL, init?: RequestInit) => {
        sent.push({ url: String(input), init });
        return Response.json({
          data: { audio: audio.toString("hex"), status: 2 },
          base_resp: { status_code: 0, status_msg: "success" },
        });
      }) as typeof fetch,
    });
    expect(sent[0]?.url).toBe("https://api.minimax.io/v1/t2a_v2?GroupId=g1");
    expect(sent[0]?.init?.headers).toMatchObject({ Authorization: "Bearer mk" });
    expect(JSON.parse(String(sent[0]?.init?.body))).toEqual({
      model: "speech-2.8-hd",
      text: "喂，听得到吗？",
      stream: false,
      // 2.8 的非流式请求：多语种自动增强 + quality 文本归一化，情感交给模型自己选。
      language_boost: "auto",
      text_normalization_mode: "quality",
      voice_setting: { voice_id: "Calm_Woman", speed: 1, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: 32_000, bitrate: 128_000, format: "mp3", channel: 1 },
    });
    expect(Buffer.from(voice.ogg.subarray(0, 4)).toString("ascii")).toBe("OggS");
    expect(voice.seconds).toBeCloseTo(0.5, 3);
  });

  it("leaves the 2.8-only fields out for older models the researcher might name", async () => {
    const sent: string[] = [];
    await synthesizeMinimax({ ...tts, model: "speech-02-hd" }, "喂", {
      fetch: (async (_input: string | URL, init?: RequestInit) => {
        sent.push(String(init?.body));
        return Response.json({
          data: { audio: halfSecond().toString("hex") },
          base_resp: { status_code: 0 },
        });
      }) as typeof fetch,
    });
    const body = JSON.parse(sent[0] ?? "{}") as Record<string, unknown>;
    expect(body).not.toHaveProperty("language_boost");
    expect(body).not.toHaveProperty("text_normalization_mode");
  });

  it("decodes the mp3 it really returns before measuring it", async () => {
    const mp3 = halfSecondMp3();
    const voice = await synthesizeMinimax(tts, "喂", {
      fetch: reply({
        data: { audio: mp3.toString("hex") },
        base_resp: { status_code: 0 },
      }),
    });
    expect(Buffer.from(voice.ogg.subarray(0, 4)).toString("ascii")).toBe("OggS");
    expect(voice.seconds).toBeGreaterThan(0.4);
    expect(voice.seconds).toBeLessThan(0.7);
  });

  it("bills the characters MiniMax reports, falling back to the text's own", async () => {
    const charged: Spent[] = [];
    const audio = halfSecond().toString("hex");
    await synthesizeMinimax(tts, "字".repeat(100), {
      fetch: reply({
        data: { audio },
        base_resp: { status_code: 0 },
        extra_info: { usage_characters: 126, audio_length: 500 },
      }),
      charge: (s) => charged.push(s),
    });
    expect(charged).toEqual([
      expect.objectContaining({ kind: "tts", model: "minimax/speech-2.8-hd", credits: null }),
    ]);
    // 以回复里的 usage_characters 为准：126 字 × 3.50 元/万字符 ÷ 7.2 元/美元
    expect(charged[0]?.usd).toBeCloseTo(((126 / 10_000) * 3.5) / 7.2);
    // 没报 usage_characters 时按 text 的字数；turbo 是 2.00 元/万字符
    expect(minimaxSpent("speech-2.8-hd", "字".repeat(50)).usd).toBeCloseTo(
      ((50 / 10_000) * 3.5) / 7.2,
    );
    expect(minimaxSpent("speech-2.8-turbo", "字".repeat(10_000)).usd).toBeCloseTo(2 / 7.2);
  });

  it("fails the voice on a rejection or a business error, and does not charge for it", async () => {
    const charged: Spent[] = [];
    const charge = (s: Spent) => charged.push(s);
    await expect(
      synthesizeMinimax(tts, "喂", { fetch: reply("down", 401), charge }),
    ).rejects.toThrow("minimax tts: 401");
    await expect(
      synthesizeMinimax(tts, "喂", {
        fetch: reply({
          base_resp: { status_code: 1004, status_msg: "invalid api key" },
        }),
        charge,
      }),
    ).rejects.toThrow("invalid api key");
    await expect(
      synthesizeMinimax(tts, "喂", {
        fetch: reply({ base_resp: { status_code: 0 } }),
        charge,
      }),
    ).rejects.toThrow("tts: no audio");
    expect(charged).toEqual([]);
  });
});

describe("ElevenLabs voice synthesis", () => {
  const elTts: ElevenlabsTts = {
    provider: "elevenlabs",
    apiKey: "el",
    model: "eleven_v4_turbo",
    voice: "cgSgspJ2msm6clMCkdW9",
    stability: 0.4,
    similarityBoost: 0.75,
  };
  it("converts ElevenLabs mp3 chunks into Ogg/Opus and charges by character", async () => {
    const mp3 = halfSecondMp3();
    const calls: unknown[] = [];
    const charged: Spent[] = [];
    const client: ElevenlabsClientLike = {
      textToSpeech: {
        async convert(voiceId, request) {
          calls.push({ voiceId, request });
          return new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(mp3.subarray(0, 500)));
              controller.enqueue(new Uint8Array(mp3.subarray(500)));
              controller.close();
            },
          });
        },
      },
    };
    const voice = await synthesizeSpeech(elTts, "早啊，刚醒", {
      client,
      charge: (s) => charged.push(s),
    });
    expect(calls).toEqual([
      {
        voiceId: "cgSgspJ2msm6clMCkdW9",
        request: {
          text: "早啊，刚醒",
          modelId: "eleven_v4_turbo",
          outputFormat: "mp3_44100_128",
          voiceSettings: { stability: 0.4, similarityBoost: 0.75 },
        },
      },
    ]);
    expect(Buffer.from(voice.ogg.subarray(0, 4)).toString("ascii")).toBe("OggS");
    expect(voice.seconds).toBeGreaterThan(0.4);
    expect(charged).toEqual([
      expect.objectContaining({
        kind: "tts",
        model: "elevenlabs/eleven_v4_turbo",
        usd: (5 / 1_000_000) * 40,
      }),
    ]);
    expect(elevenlabsSpent("eleven_v4", "ab").usd).toBeCloseTo((2 / 1_000_000) * 80);
  });

  it("rejects empty ElevenLabs audio without charging", async () => {
    const charged: Spent[] = [];
    const client: ElevenlabsClientLike = {
      textToSpeech: {
        async convert() {
          return new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          });
        },
      },
    };
    await expect(
      synthesizeElevenlabs(elTts, "喂", { client, charge: (s) => charged.push(s) }),
    ).rejects.toThrow("tts: no audio");
    expect(charged).toEqual([]);
  });
});

describe("callSpeechModel", () => {
  const prompt = { system: "s", user: "u" };
  const reply = (status: number, content = "{}") =>
    new Response(
      status === 200 ? JSON.stringify({ choices: [{ message: { content } }] }) : "upstream",
      { status },
    );

  it("retries a 502 and returns the content", async () => {
    const statuses = [502, 200];
    let calls = 0;
    const gateway = createGateway({
      apiKey: "k",
      charge: () => {},
      fetch: async () => reply(statuses[calls++] ?? 200, '{"ok":1}'),
    });
    const raw = await callSpeechModel(gateway, prompt, { kind: "speech" });
    expect(raw).toBe('{"ok":1}');
    expect(calls).toBe(2);
  });

  it("does not retry a 400", async () => {
    let calls = 0;
    const gateway = createGateway({
      apiKey: "k",
      charge: () => {},
      fetch: async () => {
        calls++;
        return reply(400);
      },
    });
    await expect(callSpeechModel(gateway, prompt, { kind: "speech" })).rejects.toBeInstanceOf(
      GatewayError,
    );
    expect(calls).toBe(1);
  });

  it("sends run_code with tool_choice auto and returns the tool calls as JSON the parser reads", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const gateway = createGateway({
      apiKey: "k",
      charge: () => {},
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const message = {
          content: null,
          tool_calls: [
            {
              function: {
                name: "run_code",
                arguments: JSON.stringify({ code: 'await tools.say({ text: "快关机" });' }),
              },
            },
          ],
        };
        return new Response(JSON.stringify({ choices: [{ message }] }));
      },
    });
    const speech = renderSpeechPrompt("p", request);
    const raw = await callSpeechModel(gateway, speech, { kind: "speech" });
    expect(bodies[0]).toMatchObject({ tool_choice: "auto", tools: speech.tools });
    expect(parseDecision(raw, request).acts).toEqual([
      { kind: "send", text: "快关机", replyTo: null },
    ]);
  });
});
