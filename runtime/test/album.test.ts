import { describe, expect, it } from "vitest";
import type { Effect } from "../src/mind/effects.js";
import type { AliceEvent, MessageReceived } from "../src/mind/events.js";
import { type AliceState, emptyState, LOOK_RUN_LIMIT } from "../src/mind/state.js";
import { step } from "../src/mind/step.js";
import { renderSpeechPrompt } from "../src/speech/prompt.js";
import { Album } from "../src/telegram/album.js";
import { directedWake } from "./directed-wake.js";

const T0 = 1_771_000_000_000;
const DM = "telegram:1";
const GROUP = "telegram:-9";

function message(o: Partial<MessageReceived> = {}): MessageReceived {
  return {
    type: "message.received",
    at: T0,
    scope: DM,
    chatType: "private",
    messageId: "1",
    senderId: "u1",
    senderName: "池塘",
    text: "发张猫图给我看看",
    contentType: "text",
    replyToMessageId: null,
    directed: true,
    ...o,
  };
}

const groupPhoto = (messageId: string, at: number, caption: string | null = null) =>
  message({
    scope: GROUP,
    chatType: "group",
    messageId,
    at,
    text: caption,
    contentType: "photo",
    media: "图片",
    directed: false,
  });
const described = (messageId: string, what: string): AliceEvent => ({
  type: "message.perceived",
  at: T0,
  scope: GROUP,
  messageId,
  media: `图片：${what}`,
});

describe("album: photos she saw in groups", () => {
  // 重排器的替身：记下它看到的描述，把"晚饭"那张排第一。
  const seen: string[][] = [];
  const album = new Album(async (_query, documents) => {
    seen.push([...documents]);
    return documents
      .map((_, i) => i)
      .sort(
        (a, b) => Number(documents[b]?.includes("晚饭")) - Number(documents[a]?.includes("晚饭")),
      );
  });
  for (const e of [
    groupPhoto("10", T0 - 3 * 86_400_000),
    described("10", "一只橘猫趴在键盘上"),
    groupPhoto("11", T0 - 3_600_000 * 5, "今天的晚饭"),
    described("11", "一碗番茄牛腩面"),
    message({ messageId: "12", contentType: "photo", media: "图片", text: null }),
  ])
    album.observe(e);

  it("indexes group photos only, shows them in the ranker's order with who posted them and when, under stable ids", async () => {
    expect(album.size).toBe(2);
    const found = await album.search("ужин", T0);
    expect(seen.at(-1)).toEqual([
      "图片：一碗番茄牛腩面，配文“今天的晚饭”",
      "图片：一只橘猫趴在键盘上",
    ]);
    const lines = found.split("\n");
    expect(lines[0]).toBe("想找的“ужин”，相册里 2 张，最像的几张：");
    expect(lines[1]).toMatch(
      /^\[p[0-9a-z]{6}\] 图片：一碗番茄牛腩面，配文“今天的晚饭”（池塘 5 小时前在群里发的）$/,
    );
    expect(lines[2]).toContain("一只橘猫趴在键盘上（池塘 3 天前在群里发的）");
    const id = lines[2]?.match(/\[(p[0-9a-z]{6})\]/)?.[1] ?? "";
    expect(album.source(id)).toMatchObject({ scope: GROUP, messageId: "10" });
    expect(await new Album(async () => []).search("猫", T0)).toBe("想找的“猫”。相册里还没有图。");
  });
});

describe("looking, then acting: a search result wakes her again in the same chat", () => {
  const mechanisms = [directedWake];
  const search = { kind: "album-search" as const, query: "猫" };
  function feed(events: AliceEvent[], state: AliceState = emptyState) {
    const effects: Effect[] = [];
    for (const e of events) {
      const r = step(state, e, mechanisms);
      state = r.state;
      effects.push(...r.effects);
    }
    return { state, effects };
  }
  const decided = (n: number): AliceEvent => ({
    type: "speech.decided",
    at: T0 + n,
    scope: DM,
    callId: `${DM}#${n}`,
    decision: { acts: [search] },
  });
  const looked = (
    n: number,
    result = "想找的“猫”，找到 1 张：\n[pabc123] 一只橘猫",
  ): AliceEvent => ({
    type: "act.done",
    at: T0 + n,
    scope: DM,
    act: search,
    result,
  });

  it("shows what she saw as her own experience and asks her again", () => {
    const { effects } = feed([message(), decided(1), looked(1)]);
    const again = effects.filter((e) => e.type === "call-speech");
    expect(again).toHaveLength(2);
    const last = again.at(-1);
    const prompt = last?.type === "call-speech" ? renderSpeechPrompt("P", last.request).user : "";
    // 写在记录里、按时间插在她说过的话之间，结果的续行缩进在它下面。
    expect(prompt).toMatch(
      /\d\d:\d\d \* 你翻了翻相册：想找的“猫”，找到 1 张：\n +\[pabc123\] 一只橘猫/,
    );
  });

  it("stops waking after a few looks in a row, and someone speaking starts the count over", () => {
    const events: AliceEvent[] = [message()];
    for (let n = 1; n <= LOOK_RUN_LIMIT + 1; n++) events.push(decided(n), looked(n));
    const { state, effects } = feed(events);
    expect(effects.filter((e) => e.type === "call-speech")).toHaveLength(1 + LOOK_RUN_LIMIT);
    expect(state.chats[DM]?.mind.mode).toBe("idle");
    const fresh = feed([message({ messageId: "2", at: T0 + 100 })], state);
    expect(fresh.state.chats[DM]?.lookRun).toBe(0);
  });

  it("sending a photo is offered only right after she looked through the album in this chat", () => {
    const offered = (events: AliceEvent[]) => {
      const calls = feed(events).effects.filter((e) => e.type === "call-speech");
      const last = calls.at(-1);
      return last?.type === "call-speech" ? last.request.affordances : [];
    };
    expect(offered([message()])).not.toContain("album-send");
    expect(offered([message(), decided(1), looked(1)])).toContain("album-send");
  });

  it("a photo she sent from the album shows in her timeline with its id, so she can tell which one she already sent", () => {
    const { state } = feed([
      message(),
      {
        type: "message.sent",
        at: T0 + 1,
        scope: DM,
        messageId: "9",
        text: "pabc123",
        kind: "photo",
      },
    ]);
    const lines = state.chats[DM]?.timeline ?? [];
    expect(
      renderSpeechPrompt("P", {
        scope: DM,
        chatType: "private",
        timeline: lines,
        contributions: [],
        triggerMessageId: null,
        at: T0 + 2,
        affordances: [],
      }).user,
    ).toContain("[9] <你> [相册里的图 pabc123]");
  });

  it("a result that lands while she is still thinking wakes her right after that decision", () => {
    const thinking = feed([message()]).state;
    const { state, effects } = feed([looked(0), decided(1)], thinking);
    expect(state.chats[DM]?.looked).toHaveLength(1);
    expect(effects.filter((e) => e.type === "call-speech")).toHaveLength(1);
  });
});
