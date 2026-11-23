/**
 * 贴纸词 → 库里的贴纸（sticker-palette.ts）：她能选的每个词都要发得出去。线上第一天她两次选 laugh，
 * 库里的笑脸是 😁 😝，只认 😂 就落空了。
 */
import { afterEach, describe, expect, it } from "vitest";
import { closeDb, getSqlite, initDb } from "../src/db/connection.js";
import { STICKER_WORDS } from "../src/mind/words.js";
import { renderSpeechPrompt } from "../src/speech/prompt.js";
import {
  knownSticker,
  listStickerHints,
  paletteSize,
  resolveStickerFileId,
  syncStickerCache,
  unresolvedStickerWords,
  upsertStickerPerception,
} from "../src/sticker-palette.js";

function palette(rows: Array<{ emoji: string; emotion: string; action?: string; label?: string }>) {
  initDb(":memory:");
  const db = getSqlite();
  db.exec(`CREATE TABLE IF NOT EXISTS sticker_palette (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL, label text NOT NULL, file_id text NOT NULL,
    file_unique_id text NOT NULL, emoji text, set_name text, emotion text, action text, intensity text,
    created_at integer NOT NULL)`);
  const insert = db.prepare(
    "INSERT INTO sticker_palette (label, file_id, file_unique_id, emoji, emotion, action, created_at) VALUES (?, ?, ?, ?, ?, ?, 0)",
  );
  for (const [i, r] of rows.entries()) {
    insert.run(r.label ?? `s${i}`, `f${i}`, `u${i}`, r.emoji, r.emotion, r.action ?? "none");
  }
}

afterEach(() => closeDb());

describe("sticker palette", () => {
  it("finds a laugh among the other laughing faces, and falls back to the nearest emotion", () => {
    palette([
      { emoji: "😝", emotion: "neutral" },
      { emoji: "😄", emotion: "happy" },
      { emoji: "😪", emotion: "tired" },
    ]);
    expect(resolveStickerFileId("laugh")).toBe("f0");
    // 没有捂脸的贴纸：退到"累"。
    expect(resolveStickerFileId("facepalm")).toBe("f2");
  });

  it("reports the words she can pick but that no sticker matches", () => {
    palette([{ emoji: "😄", emotion: "happy" }]);
    const unresolved = unresolvedStickerWords(STICKER_WORDS);
    expect(unresolved).not.toContain("happy");
    expect(unresolved).not.toContain("laugh"); // 退到 happy
    expect(unresolved).toContain("sad");
  });

  it("matches natural-language queries against VLM descriptions and Chinese emotion synonyms", () => {
    palette([
      { emoji: "😳", emotion: "shy" },
      { emoji: "😢", emotion: "sad" },
    ]);
    upsertStickerPerception({
      fileId: "f-cat-bsod",
      fileUniqueId: "u1",
      emoji: "😭",
      setName: "cat_memes",
      summary: "猫猫看着蓝屏电脑崩溃痛哭",
      text: "电脑蓝屏",
      emotion: "崩溃",
      now: 100,
    });
    upsertStickerPerception({
      fileId: "f-fox-nod",
      fileUniqueId: "u-new",
      emoji: "👍",
      setName: "fox_girls",
      summary: "橘发狐娘耳朵竖起开心点头赞同",
      text: null,
      emotion: "赞同",
      now: 100,
    });
    // 精准中文画面描述匹配到对应贴纸，不会乱发别的
    expect(resolveStickerFileId("猫猫蓝屏")).toBe("f-cat-bsod");
    expect(resolveStickerFileId("狐娘点头")).toBe("f-fox-nod");
    // 中文同义词在库里有情绪匹配时能命中，完全无关的词返回 null
    expect(resolveStickerFileId("害羞")).toBe("f0");
    expect(resolveStickerFileId("彻底无关的词xyz")).toBeNull();
  });

  it("syncStickerCache upgrades legacy neutral labels without extra VLM calls", () => {
    palette([{ emoji: "🌟", emotion: "neutral" }]);
    const updated = syncStickerCache([
      {
        fileUniqueId: "u0",
        summary: "白发兽耳少女开心咧嘴大笑",
        text: "笑死",
        emotion: "开心",
      },
    ]);
    expect(updated).toBe(1);
    expect(resolveStickerFileId("happy")).toBe("f0");
    expect(resolveStickerFileId("兽耳大笑")).toBe("f0");
  });

  it("lists concrete diverse sticker labels and surfaces them in speech tool docs", () => {
    palette([
      { emoji: "😂", emotion: "happy", label: "sticker" },
      { emoji: "😢", emotion: "sad", label: "白发猫猫抱着膝盖委屈流泪" },
      { emoji: "😳", emotion: "shy", label: "狐娘耳朵泛红低头扯衣角" },
    ]);
    const hints = listStickerHints(10);
    expect(hints).toContain("白发猫猫抱着膝盖委屈流泪");
    expect(hints).toContain("狐娘耳朵泛红低头扯衣角");
    expect(hints).not.toContain("sticker");
    const prompt = renderSpeechPrompt("persona", {
      scope: "telegram:1",
      chatType: "private",
      timeline: [],
      contributions: [],
      triggerMessageId: null,
      at: 1_771_000_000_000,
      affordances: ["send", "sticker"],
      stickers: hints,
    });
    expect(prompt.system).toContain("手头贴纸有：");
    expect(prompt.system).toContain("白发猫猫抱着膝盖委屈流泪");
  });

  it("keeps each platform's stickers apart, even with the same file_unique_id; old rows stay Telegram's", () => {
    // 旧库的表没有 platform 列：第一次读写时补上，原有的行都算 Telegram 的。
    palette([{ emoji: "😄", emotion: "happy", label: "旧的笑脸" }]);
    const seen = {
      fileUniqueId: "u0",
      summary: "猫猫捂嘴偷笑",
      text: "笑死",
      emotion: "想笑",
      now: 100,
    };
    upsertStickerPerception({ ...seen, fileId: "https://qq.example/u0.jpg", platform: "qq" });
    expect(paletteSize("telegram")).toBe(1);
    expect(paletteSize("qq")).toBe(1);
    expect(knownSticker("u0", "qq")).toBe(true);
    expect(resolveStickerFileId("happy")).toBe("f0");
    expect(resolveStickerFileId("猫猫偷笑", "qq")).toBe("https://qq.example/u0.jpg");
    expect(resolveStickerFileId("猫猫偷笑", "telegram")).not.toBe("https://qq.example/u0.jpg");
    // 同一个 id 在 Telegram 上再看懂一次：改的是 Telegram 那行，QQ 那行不动。
    upsertStickerPerception({ ...seen, fileId: "f0-new", summary: "白猫挥手" });
    expect(resolveStickerFileId("白猫挥手")).toBe("f0-new");
    expect(listStickerHints(10, "qq")).toEqual(["猫猫捂嘴偷笑「笑死」"]);
    // 看图缓存按键里的平台补全：qq: 开头的只改 QQ 那行，没有前缀的旧键算 Telegram 的。
    const cached = { summary: "狐娘点头赞同", text: null, emotion: "赞同" };
    expect(syncStickerCache([{ fileUniqueId: "qq:u0", ...cached }], "telegram")).toBe(0);
    expect(syncStickerCache([{ fileUniqueId: "qq:u0", ...cached }], "qq")).toBe(1);
    expect(listStickerHints(10, "qq")).toEqual(["狐娘点头赞同"]);
    expect(listStickerHints(10, "telegram")).toEqual(["白猫挥手「笑死」"]);
    expect(syncStickerCache([{ fileUniqueId: "u0", ...cached }], "qq")).toBe(0);
    expect(syncStickerCache([{ fileUniqueId: "u0", ...cached }])).toBe(1);
    expect(listStickerHints(10, "telegram")).toEqual(["狐娘点头赞同"]);
  });
});
