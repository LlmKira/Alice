/**
 * 看图（llm/perceive.ts）：看图模型的描述和本机标注器的事实合成时间线里的一行；看图模型拒绝或失败时只给事实。
 * 动图、视频看 Telegram 给的预览帧（telegram/world-adapter.ts）。
 */
import type { Dispatcher } from "@mtcute/dispatcher";
import { describe, expect, it } from "vitest";
import { createGateway } from "../src/llm/gateway.js";
import { type ImageTags, imageLine, localTagger, readTags, seeFrame } from "../src/llm/perceive.js";
import type { AliceEvent } from "../src/mind/events.js";
import { bindTelegramWorldAdapter } from "../src/telegram/world-adapter.js";
import { mtcuteFake } from "./mtcute-fake.js";

/** services/tagger/server.py 的回复形状。 */
const reply = (over: Partial<Record<"rating" | "characters" | "tags", unknown>> = {}) => ({
  rating: { general: 0.9, sensitive: 0.08, questionable: 0.01, explicit: 0.01 },
  characters: [
    { name: "cirno", score: 0.99 },
    { name: "daiyousei", score: 0.6 },
  ],
  tags: [
    { name: "1girl", score: 0.99 },
    { name: "ice wings", score: 0.95 },
  ],
  ...over,
});

const cirno: ImageTags = { rating: "general", characters: ["cirno"], photo: false };

describe("the tagger's reply becomes a few facts", () => {
  it("keeps the characters it is sure of; general tags are not facts for her", () => {
    expect(readTags(reply())).toEqual(cirno);
  });

  it("the rating is the most likely of the four", () => {
    const r18 = { general: 0.01, sensitive: 0.1, questionable: 0.2, explicit: 0.69 };
    expect(readTags(reply({ rating: r18 })).rating).toBe("explicit");
  });

  it("a confident 'realistic' says it is a photo", () => {
    const tags = (score: number) => [
      { name: "realistic", score },
      { name: "cat", score: 0.9 },
    ];
    expect(readTags(reply({ characters: [], tags: tags(0.83) }))).toEqual({
      rating: "general",
      characters: [],
      photo: true,
    });
    expect(readTags(reply({ characters: [], tags: tags(0.4) })).photo).toBe(false);
  });

  it("a reply in another shape is an error, not an empty fact", () => {
    expect(() => readTags({ tags: "1girl, solo" })).toThrow();
  });
});

describe("the line in her timeline", () => {
  it("description first, the tagger's facts after a dash; the rating only when it is questionable or explicit", () => {
    expect(imageLine("Cirno stands in the snow next to a sign reading '⑨'.", cirno)).toBe(
      "Cirno stands in the snow next to a sign reading '⑨'——角色 cirno",
    );
    // "sensitive" 常常标错（自拍、聊天截图），不写。
    expect(imageLine("A cat", { rating: "sensitive", characters: [], photo: true })).toBe(
      "A cat——照片",
    );
    expect(imageLine("A cat", { rating: "general", characters: [], photo: false })).toBe("A cat");
    expect(imageLine("A pool", { rating: "questionable", characters: [], photo: false })).toBe(
      "A pool——尺度很大",
    );
  });

  it("without a description the facts alone are the line; with neither there is no line", () => {
    expect(imageLine(null, { ...cirno, rating: "explicit" })).toBe("角色 cirno，R18");
    expect(imageLine(null, { ...cirno, rating: "questionable" })).toBe("角色 cirno，尺度很大");
    expect(imageLine("A cat", null)).toBe("A cat");
    expect(imageLine(null, null)).toBe("");
  });
});

/** 看图模型：content 为 null 是被内容过滤挡掉（网关回 200、空内容）。asked 记下发过去的请求体。 */
const vision = (content: string | null, status = 200) => {
  const asked: Array<{
    max_tokens: number;
    messages: Array<{ content: Array<{ text?: string }> }>;
  }> = [];
  const gateway = createGateway({
    apiKey: "k",
    charge: () => {},
    fetch: async (_: unknown, init?: RequestInit) => {
      asked.push(JSON.parse(String(init?.body)) as (typeof asked)[number]);
      return new Response(
        JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1100 } }),
        { status },
      );
    },
  });
  return Object.assign(gateway, { asked });
};

const image = new Uint8Array([0xff, 0xd8, 0xff]);

describe("seeing a picture: description and tagger together", () => {
  it("asks each kind with its own prompt and keeps the answer whole", async () => {
    const long = `**A poster** reading \`SALE\`\n${"and more details ".repeat(30)}`;
    const g = vision(long);
    const line = await seeFrame(g, null, image, "photo");
    expect(line.startsWith("A poster reading SALE and more details")).toBe(true);
    expect(line.endsWith("…")).toBe(false);
    await seeFrame(g, null, image, "gif");
    await seeFrame(g, null, image, "video");
    const prompts = g.asked.map((b) => b.messages[0]?.content[0]?.text);
    expect(new Set(prompts).size).toBe(3);
  });

  it("both arrive: one line with both", async () => {
    const line = await seeFrame(vision("Cirno in the snow."), async () => cirno, image, "photo");
    expect(line).toBe("Cirno in the snow——角色 cirno");
  });

  it("the vision model refuses (empty content) or fails: the tagger's facts still reach her", async () => {
    const r18 = { ...cirno, rating: "explicit" as const };
    expect(await seeFrame(vision(null), async () => r18, image, "photo")).toBe("角色 cirno，R18");
    expect(await seeFrame(vision("", 503), async () => r18, image, "gif")).toBe("角色 cirno，R18");
  });

  it("no tagger, or the tagger fails: the description alone, as before", async () => {
    expect(await seeFrame(vision("A cat"), null, image, "photo")).toBe("A cat");
    const down = async () => {
      throw new Error("tagger 500");
    };
    expect(await seeFrame(vision("A cat"), down, image, "photo")).toBe("A cat");
  });

  it("both fail: no line, the vision model's error is what is reported", async () => {
    await expect(seeFrame(vision(null), null, image, "photo")).rejects.toThrow("perceive: empty");
  });

  it("a slow tagger is given up on, so the description is not held back", async () => {
    const hanging = ((_: unknown, init?: RequestInit) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      )) as typeof fetch;
    const started = Date.now();
    const tagger = localTagger("http://127.0.0.1:1", hanging, 50);
    expect(await seeFrame(vision("A cat"), tagger, image, "photo")).toBe("A cat");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("the local tagger client posts the raw image and reads the reply", async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const fake = (async (url: string, init?: RequestInit) => {
      seen.push({ url, body: init?.body });
      return new Response(JSON.stringify(reply()));
    }) as typeof fetch;
    expect(await localTagger("http://127.0.0.1:39100/", fake)(image)).toEqual(cirno);
    expect(seen[0]?.url).toBe("http://127.0.0.1:39100/tag");
    expect([...(seen[0]?.body as Uint8Array)]).toEqual([...image]);
  });
});

describe("a GIF or a video: its preview frame is looked at", () => {
  /** 适配器收一条带视频的消息；下载器记下下载的是哪个文件，看图记下走的是哪一路。 */
  async function receiveVideo(video: object) {
    const events: AliceEvent[] = [];
    const looked: string[] = [];
    const downloaded: unknown[] = [];
    const look = (kind: string) => async () => {
      looked.push(kind);
      return `${kind} description`;
    };
    const { receive } = bindTelegramWorldAdapter(
      mtcuteFake<Dispatcher>({
        onNewMessage: () => {},
        onRawUpdate: () => {},
        onChatMemberUpdate: () => {},
      }),
      {
        selfId: "42",
        now: () => 1,
        onEvent: (e) => events.push(e),
        perceive: {
          image: look("image"),
          gif: look("gif"),
          video: look("video"),
          voice: look("voice"),
        },
        admit: () => true,
        newGroup: () => false,
      },
    );
    receive(
      {
        id: 7,
        chat: { id: -1009, chatType: "supergroup", title: "群" },
        sender: { id: 5, displayName: "阿杰" },
        text: null,
        entities: [],
        media: { type: "video", duration: 4, isRound: false, isAnimation: false, ...video },
        replyToMessage: null,
      } as never,
      {
        downloadAsBuffer: async (file: unknown) => {
          downloaded.push(file);
          return new Uint8Array([1]);
        },
      },
    );
    await new Promise((r) => setTimeout(r, 0));
    const seen = events.find((e) => e.type === "message.perceived");
    return { looked, downloaded, media: seen?.type === "message.perceived" ? seen.media : null };
  }

  const thumbs = [
    { type: "i", width: Number.NaN },
    { type: "s", width: 90 },
    { type: "m", width: 320 },
    { type: "v", width: 640 },
  ];

  it("a GIF: the largest still thumbnail, the GIF prompt, written after 动图", async () => {
    const got = await receiveVideo({ isAnimation: true, thumbnails: thumbs });
    expect(got.downloaded).toEqual([thumbs[2]]);
    expect(got.looked).toEqual(["gif"]);
    expect(got.media).toBe("动图：gif description");
  });

  it("a video: the video prompt, written after its length", async () => {
    const got = await receiveVideo({ thumbnails: thumbs });
    expect(got.looked).toEqual(["video"]);
    expect(got.media).toBe("视频 4 秒：video description");
  });

  it("no still thumbnail: nothing is looked at, the line stays 动图", async () => {
    const got = await receiveVideo({ isAnimation: true, thumbnails: [thumbs[0], thumbs[3]] });
    expect(got.looked).toEqual([]);
    expect(got.media).toBeNull();
  });
});
