/**
 * 反思式日记（diary: "reflect"，diary.ts）的性质：
 * - 什么时候写：她在一个会话里经历累计到 REFLECT.involved（冲着她的、她自己说的记 1，群里的闲聊记 ambient），
 *   那里安静下来、或累计到 burst 倍时写；写过（成功或失败）只清那个会话。
 * - 写什么：那段对话、她此刻在这里还在的心情、这里看得见的日记、写法示范。
 * - 给谁看：私聊里写下的只在那个私聊；群里写下的只在那个群、和与当时在场的人的私聊；关于第三个人的只给当时
 *   在场的人；在它自己的会话里，那段对话还在时间线上时不放。
 * - 写入前只和同一批受众看得见的条目去重。生产不反思、提示词里没有日记。
 */
import { describe, expect, it } from "vitest";
import { decodeEvent } from "../src/journal.js";
import { moodFor } from "../src/mechanisms/pressure/affect.js";
import {
  createPressure,
  PRODUCTION,
  pressureProduction,
} from "../src/mechanisms/pressure/index.js";
import { REFLECT } from "../src/mechanisms/pressure/params.js";
import { emptyWorld, type World } from "../src/mechanisms/pressure/world.js";
import { affordances } from "../src/mind/affordances.js";
import type { Effect, ReflectRequest } from "../src/mind/effects.js";
import type { AliceEvent, MessageReceived } from "../src/mind/events.js";
import type { Mechanism } from "../src/mind/mechanism.js";
import { type AliceState, type ChatState, emptyState, TIMELINE_LIMIT } from "../src/mind/state.js";
import { speechRequest, step } from "../src/mind/step.js";
import { moodWord } from "../src/mind/words.js";
import { renderSpeechPrompt } from "../src/speech/prompt.js";
import { parseReflect, renderReflectPrompt } from "../src/speech/reflect.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T = Date.UTC(2026, 10, 10, 7, 0);
const GROUP = "telegram:-5";
const GROUP2 = "telegram:-6";
const DM = "telegram:1";
const DM2 = "telegram:2";
const reflecting = createPressure(affordances, PRODUCTION);
const noDiary = createPressure(affordances, { ...PRODUCTION, diary: undefined });

let n = 0;
function msg(
  at: number,
  scope: string,
  senderId: string,
  text: string,
  directed?: boolean,
): MessageReceived {
  n++;
  const group = scope.startsWith("telegram:-");
  return {
    type: "message.received",
    at,
    scope,
    chatType: group ? "group" : "private",
    messageId: `m${n}`,
    senderId,
    senderName: { u1: "莉莉丝", u2: "小鹿", u3: "阿豪" }[senderId] ?? senderId,
    text,
    contentType: "text",
    replyToMessageId: null,
    directed: directed ?? !group,
  };
}
const sent = (at: number, scope: string, text: string): AliceEvent => ({
  type: "message.sent",
  at,
  scope,
  messageId: `s${++n}`,
  text,
  kind: "text",
});
/** 效价由外壳判出、写在事件上（PLAN 第 34 件）；数是判口气的模型 2026-11-13 给这两个词的。 */
const felt = (at: number, scope: string, mood: string, why: string | null): AliceEvent => ({
  type: "act.done",
  at,
  scope,
  act: { kind: "feel", mood, why },
  valence: mood === "生气" ? -0.92 : 0.7,
});
const tick = (at: number): AliceEvent => ({ type: "clock.tick", at });
/** 第四项 true：她写下时标了私密（PLAN 第 33 件：只有这样的守受众规则）。 */
const reflected = (
  at: number,
  scope: string,
  entries: Array<[string | null, string, number, boolean?]>,
): AliceEvent => ({
  type: "ponder.done",
  at,
  scope: "self",
  callId: `self~reflect@${at}`,
  ponder: {
    kind: "reflect",
    scope,
    entries: entries.map(([about, text, importance, secret]) => ({
      about,
      text,
      importance,
      ...(secret ? { private: true as const } : {}),
    })),
  },
});
const failed = (at: number, chat: string): AliceEvent => ({
  type: "ponder.failed",
  at,
  scope: "self",
  callId: `self~reflect@${at}`,
  kind: "reflect",
  chat,
  reason: "model",
});
/** 一整屏的新消息：把更早的对话挤出时间线。 */
const scrolled = (scope: string, at: number, sender: string) =>
  Array.from({ length: TIMELINE_LIMIT }, (_, k) => msg(at + k, scope, sender, `闲聊${k}`));

function run(events: AliceEvent[], mechanism: Mechanism = reflecting) {
  let state: AliceState = emptyState;
  const effects: Effect[] = [];
  for (const e of events) {
    const r = step(state, e, [mechanism]);
    state = r.state;
    effects.push(...r.effects);
  }
  const asks = effects.flatMap((e) =>
    e.type === "call-ponder" && e.request.kind === "reflect" ? [e.request] : [],
  );
  return { state, asks };
}
/** 她此刻的卡片（聊天记录上方那一段）：日记在"心里还记着"那一行。 */
const cardAt = (events: AliceEvent[], scope: string, at: number, mechanism = reflecting) => {
  const { state } = run(events, mechanism);
  const user = renderSpeechPrompt(
    "PERSONA",
    speechRequest(state, state.chats[scope] as ChatState, at, null, [mechanism]),
  ).user;
  return user.split("\n\n")[0] ?? "";
};

/** 群里四件冲着她的事：点名两次、她回了两句。 */
const named = (k: number, scope = GROUP): AliceEvent =>
  msg(T + k * 10_000, scope, "u1", "Alice 你看", true);
const answered = (k: number, scope = GROUP): AliceEvent => sent(T + k * 10_000, scope, "干嘛");
const four = (scope = GROUP) => [
  named(0, scope),
  answered(1, scope),
  named(2, scope),
  answered(3, scope),
];
/** 第 k 件事之后安静够了的时刻。 */
const quietAfter = (k: number) => T + k * 10_000 + REFLECT.quiet;

describe("when she reflects", () => {
  it("after enough has happened to her in a chat, once it is quiet", () => {
    expect(run([...four(), tick(quietAfter(3))]).asks).toHaveLength(1);
    expect(run([...four(), tick(quietAfter(3) - 1)]).asks).toHaveLength(0);
  });

  it("counts the room's chatter lightly: it adds up, but a few lines are not enough", () => {
    const chatter = (k: number) => msg(T + k * 10_000, GROUP, "u2", "哈哈");
    const few = [named(0), chatter(1), chatter(2), chatter(3), answered(4)];
    expect(run([...few, tick(quietAfter(4))]).asks).toHaveLength(0);
    const many = Math.ceil((REFLECT.involved - 2) / REFLECT.ambient);
    const busy = [named(0), answered(1), ...Array.from({ length: many }, (_, k) => chatter(2 + k))];
    expect(run([...busy, tick(quietAfter(1 + many))]).asks).toHaveLength(1);
  });

  it("writes during a long burst too, and starts counting again after writing", () => {
    const burst: AliceEvent[] = [];
    const total = REFLECT.involved * REFLECT.burst;
    for (let k = 0; k < total; k++) burst.push(k % 2 ? answered(k) : named(k));
    const at = T + (total - 1) * 10_000 + 1;
    expect(run([...burst, tick(at)]).asks).toHaveLength(1);
    expect(
      run([...burst, tick(at), reflected(at, GROUP, []), tick(at + REFLECT.quiet)]).asks,
    ).toHaveLength(1);
  });

  it("a failed reflection sets aside only that chat (D3)", () => {
    // 群一攒够了、反思失败；群二已攒到 3，再来一件就该写。
    const g2 = [named(10, GROUP2), answered(11, GROUP2), named(12, GROUP2)];
    const events = [...four(), tick(quietAfter(3)), failed(quietAfter(3), GROUP), ...g2];
    const more = [answered(40, GROUP2), tick(quietAfter(40))];
    const asks = run([...events, ...more]).asks;
    expect(asks.map((a) => a.scope)).toEqual([GROUP, GROUP2]);
  });

  it("production reflects; the no-diary ablation never does", () => {
    expect(run([...four(), tick(quietAfter(3))], pressureProduction).asks).toHaveLength(1);
    expect(run([...four(), tick(quietAfter(3))], noDiary).asks).toHaveLength(0);
  });
});

describe("what she is asked", () => {
  it("the conversation with people by number, her lines as hers, and Feb's two lines as the example", () => {
    const [ask] = run([
      msg(T, GROUP, "u1", "大家看 Alice 的日志", true),
      ...four().slice(1),
      tick(quietAfter(3)),
    ]).asks;
    expect(ask?.people[0]).toEqual({ id: "u1", name: "莉莉丝" });
    expect(ask?.lines[0]?.who).toBe(0);
    expect(ask?.lines.some((l) => l.who === null)).toBe(true);
    const prompt = renderReflectPrompt("PERSONA", ask as ReflectRequest);
    expect(prompt.user).toContain("p1 莉莉丝: 大家看 Alice 的日志");
    expect(prompt.user).toContain("你: 干嘛");
    expect(prompt.system).toContain("被人这样信赖着，心里暖洋洋的");
  });

  it("her mood only while she still feels it, and only if she felt it here (D1)", () => {
    const at = quietAfter(3);
    const fresh = [...four(), felt(at - MIN, GROUP, "生气", "被当众念日志"), tick(at)];
    expect(run(fresh).asks[0]?.mood).toEqual({ word: "生气", why: "被当众念日志" });
    const stale = [felt(T - 2 * DAY, GROUP, "生气", "被当众念日志"), ...four(), tick(at)];
    expect(run(stale).asks[0]?.mood).toBeNull();
    const elsewhere = [...four(), felt(at - MIN, DM, "开心", null), tick(at)];
    expect(run(elsewhere).asks[0]?.mood).toBeNull();
  });
});

describe("what reflection writes", () => {
  const request: ReflectRequest = {
    kind: "reflect",
    at: T,
    scope: GROUP,
    chatType: "group",
    lines: [],
    people: [{ id: "u1", name: "莉莉丝" }],
    mood: null,
    diary: [],
    examples: [],
  };

  it("maps p numbers back to people, keeps a sane importance, drops empty entries", () => {
    const raw =
      '{"entries":[{"about":"p1","text":"莉莉丝把我的日志发出去了 好丢人","importance":8},' +
      '{"about":null,"text":"  "},{"about":"p9","text":"今天好累","importance":"高"}]}';
    expect(parseReflect(raw, request).entries).toEqual([
      { about: "u1", text: "莉莉丝把我的日志发出去了 好丢人", importance: 8 },
      { about: null, text: "今天好累", importance: null },
    ]);
    expect(() => parseReflect("不是 JSON", request)).toThrow();
  });

  // 第 34 件以前词表外的词（"心碎"）整条作废、走样的词对回词表（"气"→生气）；现在她写什么就是什么
  // （test/own-mood.test.ts）。
  it("also reads her mood after writing: her own word with a reason, else none", () => {
    const entries = '"entries":[]';
    expect(
      parseReflect(`{${entries},"mood":{"word":"委屈","why":"被当众揭短"}}`, request).mood,
    ).toEqual({
      word: "委屈",
      why: "被当众揭短",
    });
    expect(parseReflect(`{${entries},"mood":{"word":"心碎","why":"x"}}`, request).mood).toEqual({
      word: "心碎",
      why: "x",
    });
    expect(parseReflect(`{${entries},"mood":null}`, request).mood).toBeUndefined();
    expect(moodWord("不开心")).toBe("不开心");
  });

  it("that mood becomes her mood, with its reason, in the chat she reflected on", () => {
    const world = reflecting.reduce?.(emptyWorld, {
      type: "ponder.done",
      at: T,
      scope: "self",
      callId: "c1",
      ponder: {
        kind: "reflect",
        scope: GROUP,
        entries: [],
        mood: { word: "委屈", why: "被当众揭短", valence: -0.51 },
      },
    }) as World;
    // 她只有一份心情：下一次在这个群里反思时，请求里的心情就是它；别处的反思不带它（D1）。
    expect(moodFor(world.affect, GROUP, T + 60_000)).toEqual({ word: "委屈", why: "被当众揭短" });
    expect(moodFor(world.affect, "telegram:1", T + 60_000)).toBeNull();
  });

  it("at most two from one reflection", () => {
    const three = reflected(T + MIN, GROUP, [
      [null, "今天下雨了", 3],
      [null, "作业写不完", 3],
      [null, "猫咪掉毛", 3],
    ]);
    const system = cardAt(
      [msg(T, GROUP, "u1", "早"), three, ...scrolled(GROUP, T + DAY, "u1")],
      GROUP,
      T + DAY + MIN,
    );
    expect(system).toContain("今天下雨了");
    expect(system).toContain("作业写不完");
    expect(system).not.toContain("猫咪掉毛");
  });

  it("does not write what the same audience already sees, but a different audience is not blocked (D2)", () => {
    const events = [
      msg(T, DM2, "u2", "在吗"),
      reflected(T + MIN, DM2, [[null, "今天被当众开玩笑 好丢人", 6, true]]),
      msg(T + DAY, GROUP, "u1", "Alice 又被念了", true),
      reflected(T + DAY + MIN, GROUP, [[null, "今天又被当众开玩笑 好丢人", 6]]),
      msg(T + 2 * DAY, DM, "u1", "在吗"),
    ];
    expect(cardAt(events, DM, T + 2 * DAY + MIN)).toContain("今天又被当众开玩笑");
    const twice = [
      ...events,
      reflected(T + DAY + 2 * MIN, GROUP, [[null, "今天又被当众开玩笑了 好丢人", 6]]),
    ];
    expect(cardAt(twice, DM, T + 2 * DAY + MIN).match(/当众开玩笑/g)).toHaveLength(1);
    // 私聊里那条没标私密、小鹿也在群里：在群里也看得见，群里再写一遍几乎一样的就不写（PLAN 第 33 件）。
    const open = [
      ...events.map((e, i) =>
        i === 1 ? reflected(T + MIN, DM2, [[null, "今天被当众开玩笑 好丢人", 6]]) : e,
      ),
      msg(T + DAY - MIN, GROUP, "u2", "嗯"),
    ].sort((a, b) => a.at - b.at);
    expect(cardAt(open, DM, T + 2 * DAY + MIN)).not.toContain("今天又被当众开玩笑");
  });
});

describe("who sees what", () => {
  // 一天半以后：不针对谁的日记过了 48 小时就不再显示（DIARY_VIEW），受众规则在那之前读。
  const later = T + 1.5 * DAY;
  // 下面这几条是她标了私密的（PLAN 第 33 件以前所有日记都这样守受众规则）。
  const world = (secret = true) => [
    msg(T, GROUP, "u1", "大家看 Alice 的日志", true),
    reflected(T + 5 * MIN, GROUP, [[null, "被当众曝光 好丢人", 8, secret]]),
    msg(T + 10 * MIN, DM2, "u2", "今天好累"),
    reflected(T + 15 * MIN, DM2, [[null, "小鹿说她工作上的事 别告诉别人", 7, secret]]),
    ...scrolled(DM2, later - DAY, "u2"),
    msg(later, DM, "u1", "在吗"),
    msg(later, DM2, "u2", "在吗"),
    msg(later, GROUP2, "u3", "早"),
  ];

  it("a private group entry reaches, a day and a half later, a private chat with someone who was there", () => {
    expect(cardAt(world(), DM, later + MIN)).toContain("被当众曝光 好丢人");
    expect(cardAt(world(), DM2, later + MIN)).not.toContain("好丢人");
  });

  it("a private entry stays in that private chat; nothing crosses into another group", () => {
    expect(cardAt(world(), DM2, later + MIN)).toContain("别告诉别人");
    expect(cardAt(world(), DM, later + MIN)).not.toContain("别告诉别人");
    expect(cardAt(world(), GROUP, later + MIN)).not.toContain("别告诉别人");
    expect(cardAt(world(), GROUP2, later + MIN)).not.toMatch(/好丢人|别告诉别人/);
  });

  // 没标私密的哪里都能去（2026-11-14 起不再只放进有关系的人在场的聊天），注明出处；条数上限照旧，
  // 和在场的人、在聊的话有关系的在前（diary.ts relevance）。
  it("an ordinary entry reaches any chat, saying where she wrote it", () => {
    for (const scope of [GROUP2, DM]) {
      const card = cardAt(world(false), scope, later + MIN);
      expect(card).toContain("和小鹿私聊时：小鹿说她工作上的事 别告诉别人");
      expect(card).toContain("在一个群里：被当众曝光 好丢人");
    }
  });

  it("from elsewhere, what touches the conversation on screen comes before what does not", () => {
    const four = [
      msg(T, GROUP, "u1", "早"),
      // 和眼前的话无关的三条更新、更重要，也排在它后面；不针对谁的放 DIARY.global（3）条。
      reflected(T + 5 * MIN, GROUP, [[null, "群里又在吵显卡价格", 5]]),
      reflected(T + 6 * MIN, GROUP, [[null, "大家在群里晒猫 好可爱", 6]]),
      reflected(T + 7 * MIN, GROUP, [[null, "今天下雨 没人出门", 6]]),
      reflected(T + 8 * MIN, GROUP, [[null, "有人说要去旅行", 6]]),
      msg(later, "telegram:3", "u3", "我刚买了新显卡"),
    ];
    const card = cardAt(four, "telegram:3", later + MIN);
    expect(card).toContain("群里又在吵显卡价格");
    expect(card).not.toContain("晒猫");
  });

  it("a private entry about a third person reaches those who were there, and only them; an ordinary one reaches anyone", () => {
    const seen = (secret: boolean) => [
      msg(T, GROUP, "u1", "Alice 你看他"),
      msg(T + MIN, GROUP, "u3", "老婆~"),
      reflected(T + 5 * MIN, GROUP, [["u3", "喝成这样还瞎叫 烦", 4, secret]]),
      msg(later, DM, "u1", "在吗"),
      msg(later, DM2, "u2", "在吗"),
    ];
    expect(cardAt(seen(true), DM, later + MIN)).toContain("喝成这样还瞎叫");
    expect(cardAt(seen(true), DM2, later + MIN)).not.toContain("喝成这样还瞎叫");
    const toHim = [...seen(false), msg(later, "telegram:3", "u3", "在吗")];
    expect(cardAt(toHim, "telegram:3", later + MIN)).toContain(
      "在一个群里 关于 阿豪：喝成这样还瞎叫",
    );
    expect(cardAt(seen(false), DM2, later + MIN)).toContain("在一个群里 关于 阿豪：喝成这样还瞎叫");
  });

  it("up to two about the person, so one written in the group is not crowded out by a newer one", () => {
    const two = [
      msg(T, GROUP, "u1", "答辩就在 29 号"),
      reflected(T + 5 * MIN, GROUP, [["u1", "29号就要答辩了 希望他顺利", 6]]),
      msg(T + DAY, DM, "u1", "在吗"),
      reflected(T + DAY + 5 * MIN, DM, [["u1", "又半天不理人 哼", 4]]),
      ...scrolled(DM, later - 60 * MIN, "u1"),
      msg(later, DM, "u1", "过了！"),
    ];
    const system = cardAt(two, DM, later + MIN);
    expect(system).toContain("29号就要答辩了");
    expect(system).toContain("又半天不理人");
  });

  it("not in its own chat while that conversation is still on screen", () => {
    const fresh = [
      msg(T, DM, "u1", "四十根烤肠 我是不是买多了"),
      reflected(T + 5 * MIN, DM, [["u1", "这笨蛋每次一到这种事就抓瞎", 3]]),
      msg(T + 6 * MIN, DM, "u1", "你帮我理一下清单"),
    ];
    expect(cardAt(fresh, DM, T + 7 * MIN)).not.toContain("抓瞎");
    expect(cardAt([...fresh, ...scrolled(DM, T + DAY, "u1")], DM, T + DAY + MIN)).toContain("抓瞎");
  });

  it("keeps at most three about no one, preferring the recent and the important", () => {
    const many = [
      msg(T, GROUP, "u1", "一"),
      // 都在 48 小时之内（更早的、不针对谁的不再显示）。
      reflected(T + MIN, GROUP, [[null, "最早的小事", 2]]),
      reflected(T + 20 * HOUR, GROUP, [[null, "较早的大事", 9]]),
      reflected(T + 30 * HOUR, GROUP, [[null, "较近的小事", 2]]),
      reflected(T + 40 * HOUR, GROUP, [[null, "刚才的事", 5]]),
      ...scrolled(GROUP, T + 40 * HOUR + MIN, "u1"),
    ];
    const card = cardAt(many, GROUP, T + 40 * HOUR + 2 * MIN);
    expect(card).not.toContain("最早的小事");
    for (const t of ["较早的大事", "较近的小事", "刚才的事"]) expect(card).toContain(t);
  });

  it("the no-diary ablation's prompt has no diary block", () => {
    expect(cardAt(world(), DM, later + MIN, noDiary)).not.toContain("心里还记着");
    expect(cardAt(world(), DM, later + MIN, pressureProduction)).toContain("心里还记着");
  });
});

describe("journal", () => {
  it("reads back reflection results and failures, and refuses malformed ones", () => {
    const done = reflected(T, GROUP, [[null, "好丢人", 8]]);
    expect(decodeEvent("ponder.done", "self", done)).toEqual(done);
    const bad = {
      ...done,
      ponder: {
        kind: "reflect",
        scope: GROUP,
        entries: [{ about: null, text: "x", importance: 99 }],
      },
    };
    expect(decodeEvent("ponder.done", "self", bad)).toBeNull();
    expect(decodeEvent("ponder.failed", "self", failed(T, GROUP))).toEqual(failed(T, GROUP));
    const { chat: _, ...noChat } = failed(T, GROUP) as Extract<AliceEvent, { kind: "reflect" }>;
    expect(decodeEvent("ponder.failed", "self", noChat)).toBeNull();
  });
});
