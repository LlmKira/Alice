/**
 * 群聊记录（pressure/context.ts）：被引用的那句已经在 30 条以前时带回记录，先换掉别人的贴纸和机器人的话。
 * 送达的每样东西都有一条测试，只截 30 条（没有 context 那一格）时是红的；私聊和没有更早可找的话时逐字不变。
 */
import { describe, expect, it } from "vitest";
import { context } from "../src/mechanisms/pressure/context.js";
import { createPressure } from "../src/mechanisms/pressure/index.js";
import { affordances } from "../src/mind/affordances.js";
import type { AliceEvent, MessageReceived } from "../src/mind/events.js";
import type { Mechanism } from "../src/mind/mechanism.js";
import { type AliceState, emptyState, TIMELINE_LIMIT } from "../src/mind/state.js";
import { speechRequest, step } from "../src/mind/step.js";
import { renderSpeechPrompt } from "../src/speech/prompt.js";

const G = "telegram:-100";
const S = 1000;
const T0 = Date.parse("2026-11-08T20:00:00+08:00");

const say = (
  id: string,
  at: number,
  name: string,
  text: string,
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

const truncation = createPressure(affordances, {});
const WITH = createPressure(affordances, { context });

function prompt(events: AliceEvent[], m: Mechanism, scope = G, trigger: string | null = null) {
  const state: AliceState = events.reduce((s, e) => step(s, e, [m]).state, emptyState);
  const chat = state.chats[scope];
  if (!chat) throw new Error("no chat");
  const at = (events.at(-1)?.at ?? T0) + S;
  const request = speechRequest(state, chat, at, trigger, [m]);
  return { user: renderSpeechPrompt("P", request).user, request };
}

/**
 * 一句问话，40 条闲聊之后有人引用回复它。问话前面先有一句，免得它正好是"更早的聊天"那一段的开头
 * （分段只写头尾两句的前 40 字，不是那一行本身）。
 */
function farReply(): AliceEvent[] {
  const events: AliceEvent[] = [
    say("h", T0 - 30 * S, "阿明", "晚上好"),
    say("q", T0, "阿杰", "周六去爬山吗"),
  ];
  for (let i = 0; i < 40; i++)
    events.push(say(`f${i}`, T0 + 60 * S + i * 20 * S, i % 2 ? "小林" : "阿明", `闲聊第${i}句`));
  events.push(say("r", T0 + 900 * S, "小雨", "几点出发", { replyToMessageId: "q" }));
  return events;
}

const lines = (r: ReturnType<typeof prompt>) =>
  (r.request.log ?? []).filter((i) => i.kind === "line").length;

describe("the quoted line is brought back", () => {
  it("shows the line a reply 40 messages back quotes, alone, in time order", () => {
    expect(prompt(farReply(), truncation, G, "r").user).not.toContain("[q] <阿杰> 周六去爬山吗");
    const { user } = prompt(farReply(), WITH, G, "r");
    expect(user).toContain("[q] <阿杰> 周六去爬山吗");
    // 只带被引用的那一条，不带它前后的。
    expect(user).not.toContain("[h] <阿明> 晚上好");
    expect(user).not.toContain("[f0] <阿明>");
    // 跳过的几条写成一行，记录照旧按时间排。
    expect(user).toMatch(/··· (过了 \d+ 分钟，)?中间还有 \d+ 条 ···/);
    expect(user.indexOf("周六去爬山吗")).toBeLessThan(user.indexOf("几点出发"));
  });

  it("takes the place of someone's sticker or a bot line, not hers, and not a line someone answered", () => {
    const events = farReply();
    // 记录里一条别人的贴纸、一条机器人的话、一条她自己的贴纸。
    events.splice(
      20,
      0,
      say("s1", T0 + 60 * S + 18 * 20 * S + 5 * S, "小林", "", { contentType: "sticker" }),
      say("b1", T0 + 60 * S + 18 * 20 * S + 6 * S, "签到机器人", "今日签到 12 人", {
        isBot: true,
      }),
      {
        type: "message.sent",
        at: T0 + 60 * S + 18 * 20 * S + 7 * S,
        scope: G,
        messageId: "her",
        text: "s",
        kind: "sticker",
      },
    );
    const room = prompt(events, WITH, G, "r");
    expect(prompt(events, truncation, G, "r").user).toContain("[s1]");
    expect(room.user).toContain("[q] <阿杰> 周六去爬山吗");
    expect(room.user).not.toContain("[s1]");
    expect(room.user).toContain("[her]");
    // 带回一条、让出一条：记录的行数不变。
    expect(lines(room)).toBe(TIMELINE_LIMIT);
    // 有人回了那张贴纸：它就是在接的话，不让；让出来的换成机器人那一行。
    events.splice(
      23,
      0,
      say("re", T0 + 60 * S + 18 * 20 * S + 8 * S, "阿明", "哈哈", { replyToMessageId: "s1" }),
    );
    const kept = prompt(events, WITH, G, "r").user;
    expect(kept).toContain("[s1]");
    expect(kept).not.toContain("[b1]");
  });

  it("follows the chain up to three replies deep and stops at the cap", () => {
    const events: AliceEvent[] = [];
    for (let i = 0; i < 5; i++)
      events.push(
        say(`c${i}`, T0 + i * 600 * S, "阿杰", `链上第${i}句`, {
          replyToMessageId: i > 0 ? `c${i - 1}` : null,
        }),
      );
    for (let i = 0; i < 40; i++)
      events.push(say(`f${i}`, T0 + 3600 * S + i * 20 * S, "阿明", `闲聊第${i}句`));
    events.push(say("r", T0 + 4600 * S, "小雨", "然后呢", { replyToMessageId: "c4" }));
    const r = prompt(events, WITH, G, "r");
    for (const id of ["c4", "c3", "c2"]) expect(r.user).toContain(`[${id}] <`);
    expect(r.user).not.toContain("[c1] <");
    expect(lines(r) - TIMELINE_LIMIT).toBeLessThanOrEqual(12);
  });
});

describe("the rest stays as truncation writes it", () => {
  it("a private chat is unchanged", () => {
    const events: AliceEvent[] = [];
    for (let i = 0; i < 45; i++)
      events.push({
        ...say(`p${i}`, T0 + i * 20 * S, "阿杰", `第${i}句`, { directed: true }),
        scope: "telegram:7",
        chatType: "private",
        replyToMessageId: i === 44 ? "p0" : null,
      });
    expect(prompt(events, WITH, "telegram:7").user).toBe(
      prompt(events, truncation, "telegram:7").user,
    );
  });

  it("a group whose record holds everything is unchanged", () => {
    const events = farReply().slice(0, 20);
    expect(prompt(events, WITH).user).toBe(prompt(events, truncation).user);
  });

  it("nothing is added when no reply points before the record", () => {
    const events = farReply().slice(0, 41);
    expect(prompt(events, WITH).user).toBe(prompt(events, truncation).user);
  });
});
