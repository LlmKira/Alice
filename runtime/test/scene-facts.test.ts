/**
 * 聊天现场的客观事实（2026-11-14 进生产，mechanisms/scene-facts.ts、pressure/context.ts mentions）：每样事实在该出现的
 * 那一刻出现、内容对；消融组 no-scene-facts 在同样的事件上和以前的生产逐字一样（每条"消融组里没有"的断言就是这样事实不再
 * 送达时变红的那一条）。
 */
import { describe, expect, it } from "vitest";
import { decodeEvent } from "../src/journal.js";
import {
  emptyWorld,
  intentionsFor,
  PRODUCTION,
  worldFold,
} from "../src/mechanisms/pressure/index.js";
import { affordances } from "../src/mind/affordances.js";
import type { AliceEvent, ChatDescribed, MessageReceived } from "../src/mind/events.js";
import type { Mechanism } from "../src/mind/mechanism.js";
import { type AliceState, emptyState } from "../src/mind/state.js";
import { speechRequest, step } from "../src/mind/step.js";
import { arms } from "../src/sim/will-arms.js";
import { renderSpeechPrompt } from "../src/speech/prompt.js";
import { ACTIVE_MS, ROOM_REFRESH_MS, Scene } from "../src/telegram/scene.js";

const G = "telegram:-100";
const P = "telegram:7";
const S = 1000;
const T0 = Date.parse("2026-11-08T20:00:00+08:00");
const all = arms({});
const PROD = all["no-scene-facts"] as readonly Mechanism[];
const CAND = all.production as readonly Mechanism[];

const say = (
  id: string,
  at: number,
  name: string,
  text: string | null,
  o: Partial<MessageReceived> = {},
): MessageReceived => ({
  type: "message.received",
  at,
  scope: G,
  chatType: "group",
  messageId: id,
  senderId: `u-${name}`,
  senderName: name,
  text,
  contentType: "text",
  replyToMessageId: null,
  directed: false,
  ...o,
});

function render(events: AliceEvent[], list: readonly Mechanism[], scope = G, trigger?: string) {
  const state: AliceState = events.reduce((s, e) => step(s, e, list).state, emptyState);
  const chat = state.chats[scope];
  if (!chat) throw new Error("no chat");
  const at = (events.at(-1)?.at ?? T0) + S;
  const request = speechRequest(state, chat, at, trigger ?? null, list);
  return { ...renderSpeechPrompt("P", request), request };
}

const room = (o: Partial<ChatDescribed> = {}): ChatDescribed => ({
  type: "chat.described",
  at: T0 - 60 * S,
  scope: G,
  members: 128,
  admins: [
    { id: "u-阿杰", name: "Jie", role: "owner", title: "大魔王" },
    { id: "u-小雨", name: "Rain", role: "admin" },
    { id: "u-不在场", name: "Far", role: "admin" },
  ],
  banned: [],
  ...o,
});

describe("facts on each message", () => {
  const events: AliceEvent[] = [
    say("1", T0, "阿杰", "转一个", { forwardedFrom: "猫猫日报" }),
    say("2", T0 + S, "小雨", null, {
      contentType: "sticker",
      media: "贴纸 😂",
      stickerSet: "柴郡猫日常",
    }),
    say("3", T0 + 2 * S, "阿杰", "今晚打游戏"),
    {
      type: "message.updated",
      at: T0 + 3 * S,
      scope: G,
      messageId: "3",
      reactions: [
        { emoji: "👍", count: 1 },
        { emoji: "😂", count: 3 },
        { emoji: "🤣", count: 2 },
        { emoji: "🔥", count: 1 },
      ],
    },
    say("4", T0 + 4 * S, "小雨", "晚上八点"),
    {
      type: "message.updated",
      at: T0 + 5 * S,
      scope: G,
      messageId: "4",
      text: "晚上九点",
      edited: true,
    },
  ];

  it("writes the forward source, the sticker pack, the top three reactions and an edit in that line", () => {
    const { user } = render(events, CAND);
    expect(user).toContain("[1] <阿杰> （转发自 猫猫日报）转一个");
    expect(user).toContain("[2] <小雨> [贴纸 😂「柴郡猫日常」]");
    expect(user).toMatch(/\[3\] <阿杰> 今晚打游戏 \[😂×3 🤣×2 (👍|🔥)×1\]$/m);
    expect(user).toContain("[4] <小雨> 晚上九点  （改过）");
    expect(user).not.toContain("晚上八点");
  });

  it("without scene facts the same events render as before: none of these facts", () => {
    const { user } = render(events, PROD);
    expect(user).toContain("[1] <阿杰> 转一个\n");
    expect(user).toContain("[2] <小雨> [贴纸 😂]\n");
    expect(user).toMatch(/\[3\] <阿杰> 今晚打游戏$/m);
    expect(user).toMatch(/\[4\] <小雨> 晚上八点$/m);
  });

  it("only the moment after a reaction count arrives shows it, and the latest count wins; all withdrawn clears it", () => {
    expect(render(events.slice(0, 3), CAND).user).toMatch(/\[3\] <阿杰> 今晚打游戏$/m);
    const more: AliceEvent[] = [
      ...events,
      {
        type: "message.updated",
        at: T0 + 6 * S,
        scope: G,
        messageId: "3",
        reactions: [{ emoji: "😂", count: 5 }],
      },
    ];
    expect(render(more, CAND).user).toMatch(/\[3\] <阿杰> 今晚打游戏 \[😂×5\]$/m);
    const gone: AliceEvent[] = [
      ...more,
      { type: "message.updated", at: T0 + 7 * S, scope: G, messageId: "3", reactions: [] },
    ];
    expect(render(gone, CAND).user).toMatch(/\[3\] <阿杰> 今晚打游戏$/m);
  });

  it("works in private chats too", () => {
    const dm = say("9", T0, "阿杰", "你看", {
      scope: P,
      chatType: "private",
      directed: true,
      forwardedFrom: "猫猫日报",
    });
    expect(render([dm], CAND, P).user).toContain("[9] <阿杰> （转发自 猫猫日报）你看");
  });
});

describe("the group header", () => {
  const talk = [say("1", T0, "阿杰", "晚上好"), say("2", T0 + S, "小雨", "好")];

  it("one line with members, the owner and the admins who speak in the record", () => {
    const { user } = render([room(), ...talk], CAND);
    expect(user).toContain("· 这个群：128 人，群主 阿杰「大魔王」，管理员 小雨。");
    expect(user.match(/这个群：/g)).toHaveLength(1);
    expect(user).not.toContain("Far");
    expect(render([room(), ...talk], PROD).user).not.toContain("这个群：");
  });

  it("not in private chats; the latest description wins", () => {
    const later = room({ at: T0 + 2 * S, members: 130, admins: [] });
    expect(render([room(), ...talk, later], CAND).user).toContain("· 这个群：130 人。");
  });
});

describe("what the group forbids her to post", () => {
  const talk = [say("1", T0, "阿杰", "晚上好", { directed: true })];
  const offered = (events: AliceEvent[], list: readonly Mechanism[]) =>
    render(events, list).request.affordances;

  it("a banned kind's actions are not offered in that group, and stay in other groups and without scene facts", () => {
    const banned = [room({ banned: ["sticker", "voice"] }), ...talk];
    const cand = offered(banned, CAND);
    expect(cand).not.toContain("sticker");
    expect(cand).not.toContain("voice");
    expect(cand).toContain("send");
    expect(offered(banned, PROD)).toContain("sticker");
    expect(offered([room(), ...talk], CAND)).toContain("sticker");
  });

  it("the will layer reads the same list: it never ranks a banned action there", () => {
    const fold = worldFold(PRODUCTION);
    const world = [room({ banned: ["text", "sticker"] }), ...talk].reduce(fold, emptyWorld);
    const kinds = intentionsFor(world, affordances, G, T0 + S).map((i) => i.affordance);
    expect(kinds).not.toContain("send");
    expect(kinds).not.toContain("sticker");
    expect(kinds).toContain("react");
    const open = [room(), ...talk].reduce(fold, emptyWorld);
    expect(intentionsFor(open, affordances, G, T0 + S).map((i) => i.affordance)).toContain("send");
  });

  it("when she cannot post text at all she is told so in one line", () => {
    const { user, request } = render([room({ banned: ["text", "forward"] }), ...talk], CAND);
    expect(user).toContain("你现在在这个群里发不了言。");
    expect(request.affordances).not.toContain("send");
    expect(request.affordances).toContain("react");
  });
});

describe("a buried message to her comes back", () => {
  /** 一条点她名的话，之后 40 条闲聊把它挤出记录。 */
  const buried = (seenAt: number | null): AliceEvent[] => {
    const events: AliceEvent[] = [
      say("h", T0 - 30 * S, "阿明", "晚上好"),
      say("m", T0, "阿杰", "Alice 明天来不来", { directed: true }),
    ];
    if (seenAt !== null) {
      events.push({
        type: "speech.decided",
        at: seenAt,
        scope: G,
        callId: "x",
        decision: { acts: [] },
      });
    }
    for (let i = 0; i < 40; i++)
      events.push(say(`f${i}`, T0 + 60 * S + i * 20 * S, i % 2 ? "小林" : "阿明", `闲聊第${i}句`));
    return events;
  };

  it("brings back the @ she never saw, alone, in time order", () => {
    const { user } = render(buried(null), CAND, G, "f39");
    expect(user).toContain("[m] <阿杰> Alice 明天来不来");
    expect(user).not.toContain("[h] <阿明> 晚上好");
    expect(user.indexOf("明天来不来")).toBeLessThan(user.indexOf("闲聊第39句"));
    expect(render(buried(null), PROD, G, "f39").user).not.toContain("[m] <阿杰>");
  });

  it("not when she looked at the record while it was on it", () => {
    expect(render(buried(T0 + 30 * S), CAND, G, "f39").user).not.toContain("[m] <阿杰>");
  });

  it("once she has looked after it came (it was brought back then), it is not brought back again", () => {
    const late = buried(null);
    late.splice(late.length - 2, 0, {
      type: "speech.decided",
      at: T0 + 60 * S + 37 * 20 * S + 1,
      scope: G,
      callId: "y",
      decision: { acts: [] },
    });
    expect(render(late, CAND, G, "f39").user).not.toContain("[m] <阿杰>");
  });

  it("a bot naming her is not someone looking for her", () => {
    const bot = buried(null).map((e) =>
      e.type === "message.received" && e.messageId === "m" ? { ...e, isBot: true as const } : e,
    );
    expect(render(bot, CAND, G, "f39").user).not.toContain("[m] <阿杰>");
  });
});

describe("journal", () => {
  it("the new events and fields read back", () => {
    const rows: AliceEvent[] = [
      say("1", T0, "阿杰", "x", {
        forwardedFrom: "a",
        stickerSet: "b",
        edited: true,
        reactions: [{ emoji: "😂", count: 2 }],
      }),
      { type: "message.updated", at: T0, scope: G, messageId: "1", text: null, edited: true },
      room({ banned: ["voice"] }),
    ];
    for (const e of rows) {
      expect(decodeEvent(e.type, G, JSON.parse(JSON.stringify(e)))).toEqual(e);
    }
  });
});

describe("the shell writes only what changed (telegram/scene.ts)", () => {
  it("a reaction-only edit with the same text is a reaction update; a real edit carries the new text; nothing new is nothing", () => {
    const scene = new Scene();
    scene.observe(say("1", T0, "阿杰", "今晚打游戏", { reactions: [{ emoji: "😂", count: 1 }] }));
    expect(
      scene.changes(G, "1", { text: "今晚打游戏", reactions: [{ emoji: "😂", count: 1 }] }, T0),
    ).toBeNull();
    expect(
      scene.changes(G, "1", { text: "今晚打游戏", reactions: [{ emoji: "😂", count: 2 }] }, T0),
    ).toEqual({
      type: "message.updated",
      at: T0,
      scope: G,
      messageId: "1",
      reactions: [{ emoji: "😂", count: 2 }],
    });
    expect(scene.changes(G, "1", { text: "今晚不打了", edited: true }, T0)).toEqual({
      type: "message.updated",
      at: T0,
      scope: G,
      messageId: "1",
      text: "今晚不打了",
      edited: true,
    });
    // 她没收到过的消息：不知道原话，不写改过。
    expect(scene.changes(G, "404", { text: "x", edited: true }, T0)).toBeNull();
  });

  it("a group is checked again only after the refresh interval; an unchanged description is not written", () => {
    const scene = new Scene();
    expect(scene.roomDue(G, T0)).toBe(true);
    expect(scene.roomDue(G, T0 + 60 * S)).toBe(false);
    expect(scene.roomDue(G, T0 + ROOM_REFRESH_MS)).toBe(true);
    scene.observe(room());
    expect(scene.roomChanged(room({ at: T0 }))).toBe(false);
    expect(scene.roomChanged(room({ members: 129 }))).toBe(true);
  });

  it("pulls reactions only for groups someone spoke in lately, newest first", () => {
    const scene = new Scene();
    scene.observe(say("5", T0, "阿杰", "x"));
    scene.observe(say("9", T0, "阿杰", "y", { scope: "telegram:-200" }));
    scene.observe(say("6", T0 + 60 * S, "阿杰", "z"));
    expect(scene.activeRooms(T0 + 2 * 60 * S)).toEqual([
      { scope: G, ids: [5, 6] },
      { scope: "telegram:-200", ids: [9] },
    ]);
    expect(scene.activeRooms(T0 + 60 * S + ACTIVE_MS + 1)).toEqual([]);
  });
});
