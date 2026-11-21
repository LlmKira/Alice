/**
 * 看懂贴纸（llm/sticker-perceive.ts）：一次看图调用换一行时间线，按 file_unique_id 缓存。
 * - 模型回 JSON（可能包着围栏）时取三样；回一段话时整段当描述；
 * - 没有表情、没有包名、贴纸上的字已经写在描述里，这一行都还读得通，且不超过 80 字；
 * - 缓存按 file_unique_id 去重，SQLite（:memory:）里再建一份也认得同一张贴纸。
 */
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { Gateway } from "../src/llm/gateway.js";
import { SPEECH_MODEL } from "../src/llm/speech-model.js";
import {
  describeSticker,
  formatStickerMedia,
  StickerCache,
  type StickerPerception,
} from "../src/llm/sticker-perceive.js";

const BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0]); // "RIFF"：WebP 头

interface MessagePart {
  type?: string;
  text?: string;
  image_url?: { url?: string };
}

interface Posted {
  model?: string;
  max_tokens?: number;
  messages?: Array<{ content?: MessagePart[] }>;
}

function mockGateway(content: string) {
  const posted: Posted[] = [];
  const gateway = {
    charge: () => {},
    post: async (call: { body: unknown }) => {
      posted.push(call.body as Posted);
      return { body: { choices: [{ message: { content } }] }, spent: {} };
    },
  } as unknown as Gateway;
  return { gateway, posted };
}

describe("describeSticker: one short multimodal call", () => {
  it("reads the JSON the model returns inside a markdown fence", async () => {
    const { gateway, posted } = mockGateway(
      '```json\n{"summary":"猫猫捂嘴偷笑「笑死」","text":"笑死","emotion":"想笑"}\n```',
    );
    const p = await describeSticker(gateway, BYTES, { emoji: "😂", setTitle: "柴郡猫日常" });
    expect(p).toEqual({ summary: "猫猫捂嘴偷笑「笑死」", text: "笑死", emotion: "想笑" });
    expect(posted).toHaveLength(1);
    expect(posted[0]?.model).toBe(SPEECH_MODEL);
    expect(posted[0]?.max_tokens).toBe(120);
    const message = posted[0]?.messages?.[0];
    expect(message?.content?.[0]?.text).toContain("笑死");
    expect(message?.content?.[1]?.image_url?.url).toMatch(/^data:image\/webp;base64,/);
  });

  it("falls back to the plain sentence when the model does not answer with JSON", async () => {
    const { gateway } = mockGateway("猫猫捂着嘴偷笑，像是看到了什么好笑的事。");
    const p = await describeSticker(gateway, BYTES);
    expect(p).toEqual({
      summary: "猫猫捂着嘴偷笑，像是看到了什么好笑的事。",
      text: null,
      emotion: "",
    });
  });

  it("finds the JSON when the model writes a sentence around it", async () => {
    const { gateway } = mockGateway(
      '好的：{"summary":"柴郡猫比心","text":null,"emotion":"亲近"}，就这样。',
    );
    const p = await describeSticker(gateway, BYTES);
    expect(p).toEqual({ summary: "柴郡猫比心", text: null, emotion: "亲近" });
  });

  it("throws when the model says nothing", async () => {
    const { gateway } = mockGateway("   ```json\n\n``` ");
    await expect(describeSticker(gateway, BYTES)).rejects.toThrow("sticker-perceive: empty");
  });

  it("treats a JSON reply with nothing usable as empty too", async () => {
    const { gateway } = mockGateway('{"summary":"","text":null,"emotion":""}');
    await expect(describeSticker(gateway, BYTES)).rejects.toThrow("sticker-perceive: empty");
  });
});

describe("formatStickerMedia: one readable timeline line", () => {
  const p: StickerPerception = {
    summary: "猫猫捂嘴偷笑「笑死」",
    text: "笑死",
    emotion: "想笑",
  };

  it("writes emoji and set title when both are known", () => {
    expect(formatStickerMedia(p, { emoji: "😂", setTitle: "柴郡猫日常" })).toBe(
      "贴纸 😂（柴郡猫日常）：猫猫捂嘴偷笑「笑死」",
    );
  });

  it("leaves out the parts Telegram did not give", () => {
    expect(formatStickerMedia(p, { emoji: "😂" })).toBe("贴纸 😂：猫猫捂嘴偷笑「笑死」");
    expect(formatStickerMedia(p, { setTitle: "柴郡猫日常" })).toBe(
      "贴纸（柴郡猫日常）：猫猫捂嘴偷笑「笑死」",
    );
    expect(formatStickerMedia(p)).toBe("贴纸：猫猫捂嘴偷笑「笑死」");
  });

  it("appends the caption only when the summary does not already say it", () => {
    expect(formatStickerMedia({ summary: "猫猫偷笑", text: "笑死", emotion: "想笑" })).toBe(
      "贴纸：猫猫偷笑「笑死」",
    );
    expect(formatStickerMedia({ summary: "只有猫猫", text: null, emotion: "" })).toBe(
      "贴纸：只有猫猫",
    );
  });

  it("keeps the line within 80 characters", () => {
    const long = formatStickerMedia(
      { summary: "很长的描述".repeat(40), text: "笑死", emotion: "" },
      { emoji: "😂", setTitle: "一套名字特别特别长的贴纸" },
    );
    expect([...long]).toHaveLength(80);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("StickerCache: the same sticker is looked at once", () => {
  const p: StickerPerception = { summary: "猫猫捂嘴偷笑", text: null, emotion: "想笑" };

  it("misses before the first look and hits by file_unique_id afterwards", () => {
    const cache = new StickerCache();
    expect(cache.get("uniq-1")).toBeNull();
    expect(cache.has("uniq-1")).toBe(false);
    cache.set("uniq-1", p);
    expect(cache.get("uniq-1")).toBe(p);
    expect(cache.has("uniq-1")).toBe(true);
    // 换一张贴纸（另一个 id）不会拿到这一条。
    expect(cache.get("uniq-2")).toBeNull();
  });

  it("persists in an in-memory SQLite table and is readable by another cache over it", () => {
    const db = new Database(":memory:");
    try {
      const first = new StickerCache(db);
      first.set("uniq-9", { ...p, summary: "旧的一次" });
      first.set("uniq-9", p);
      // 第二份缓存的内存是空的，只能从表里读到同一张贴纸；同一个 id 只有一行。
      const second = new StickerCache(db);
      expect(second.get("uniq-9")).toEqual(p);
      expect(second.get("uniq-10")).toBeNull();
      const rows = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM sticker_cache");
      expect(rows.get()?.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it("accepts :memory: as a path", () => {
    const cache = new StickerCache(":memory:");
    try {
      cache.set("uniq-3", p);
      expect(cache.get("uniq-3")).toEqual(p);
    } finally {
      cache.close();
    }
  });
});
