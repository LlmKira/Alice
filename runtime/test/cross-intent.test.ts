/**
 * 跨会话的嘱托（研究员 2026-11-15："私聊求她在群里发语音，但是她没有做"）：intend 写了"在哪做"，那件事记在要去的
 * 会话里，在那里是一股能叫醒她的劲，卡片上写明在哪定下的，叫醒原因里有它；做完用 fulfil 消掉；没做成的，答应她的人
 * 回到原来的私聊时卡片上有。名字、会话都是虚构的。
 */
import { describe, expect, it } from "vitest";
import {
  createPressure,
  emptyWorld,
  memory,
  relation,
  type World,
} from "../src/mechanisms/pressure/index.js";
import { placeNamed } from "../src/mechanisms/pressure/place.js";
import { mechanisms } from "../src/mechanisms/registry.js";
import { type Act, affordances } from "../src/mind/affordances.js";
import { buildAct, isAct } from "../src/mind/args.js";
import type { AliceEvent, MessageReceived } from "../src/mind/events.js";
import { type ChatState, emptyChat } from "../src/mind/state.js";
import { replay } from "../src/sim/replay.js";
import { renderSpeechPrompt } from "../src/speech/prompt.js";

const MIN = 60_000;
const H = 60 * MIN;
/** 2026-11-10 周二 15:00（东八区）。 */
const T = Date.UTC(2026, 10, 10, 7, 0);

const DM = "telegram:101";
const GROUP = "telegram:-201";
const OTHER = "telegram:-202";
const TITLE = "周末爬山群【先看置顶】";

let n = 0;
function msg(at: number, o: Partial<MessageReceived> = {}): MessageReceived {
  n++;
  const scope = o.scope ?? DM;
  const group = scope.startsWith("telegram:-");
  return {
    type: "message.received",
    at,
    scope,
    chatType: group ? "group" : "private",
    messageId: `m${n}`,
    senderId: "u1",
    senderName: "阿明",
    text: "hi",
    contentType: "text",
    replyToMessageId: null,
    directed: !group,
    ...(group ? { chatTitle: scope === GROUP ? TITLE : "随便聊聊" } : {}),
    ...o,
  };
}
const done = (at: number, act: Act, scope = DM): AliceEvent => ({
  type: "act.done",
  at,
  scope,
  act,
});

const pressureMemory = createPressure(affordances, { memory, relation });
const fold = (events: AliceEvent[], from: World = emptyWorld) =>
  events.reduce((w, e) => pressureMemory.reduce?.(w, e) as World, from);

/** 阿明在两个群里都说过话，最近一次在爬山群；她和阿明有私聊。 */
const known = () =>
  fold([
    msg(T - 3 * H, { scope: OTHER, senderId: "u1" }),
    msg(T - 2 * H, { scope: GROUP, senderId: "u1" }),
    msg(T - 2 * H + MIN, { scope: GROUP, senderId: "u2", senderName: "小青" }),
    msg(T - H, { scope: OTHER, senderId: "u2", senderName: "小青" }),
    msg(T),
  ]);

const chatOf = (scope: string): ChatState =>
  emptyChat(scope, scope.startsWith("telegram:-") ? "group" : "private", true);
const card = (w: World, scope: string, now: number) =>
  (
    memory.contribute?.({
      world: w,
      chat: chatOf(scope),
      now,
      sought: true,
      outside: false,
      offered: [],
    }) ?? []
  )
    .map((c) => c.text)
    .join("\n");

describe("where she says to do it becomes the chat it is kept in", () => {
  it("reads a group name, a person's name, a bare 'the group' from a DM, and falls back to here", () => {
    const w = known();
    expect(placeNamed(w, DM, "周末爬山群")).toBe(GROUP);
    expect(placeNamed(w, DM, "在爬山群里")).toBe(GROUP);
    expect(placeNamed(w, GROUP, "阿明")).toBe(DM);
    expect(placeNamed(w, GROUP, "和阿明的私聊")).toBe(DM);
    // 私聊里只说"群里"：阿明最近说过话、她也在的那个群（不是最近热闹的那个）。
    expect(placeNamed(w, DM, "群里")).toBe(GROUP);
    expect(placeNamed(w, DM, "火星基地")).toBeNull();
    expect(placeNamed(w, GROUP, "爬山群")).toBeNull();
  });

  it("the act keeps where only when she wrote it, and old acts without it still read back", () => {
    const ctx = { timeline: [], now: T };
    expect(buildAct("intend", { what: "发条语音", where: "爬山群" }, ctx)).toEqual({
      kind: "intend",
      when: null,
      what: "发条语音",
      where: "爬山群",
    });
    expect(buildAct("intend", { what: "发条语音" }, ctx)).toEqual({
      kind: "intend",
      when: null,
      what: "发条语音",
    });
    expect(isAct({ kind: "intend", when: null, what: "发条语音" })).toBe(true);
    expect(isAct({ kind: "intend", when: null, what: "发条语音", where: 3 })).toBe(false);
  });
});

describe("a promise for another chat lives there", () => {
  const promise: Act = {
    kind: "intend",
    when: null,
    what: "在群里把那段念成语音发出来",
    where: "爬山群",
  };

  it("is kept in the target with where and for whom it was made, and pulls there soon", () => {
    const w = fold([done(T + MIN, promise)], known());
    expect(w.chats[DM]?.commitments.open).toEqual([]);
    const [c] = w.chats[GROUP]?.commitments.open ?? [];
    expect(c?.origin).toEqual({ scope: DM, to: "u1" });
    expect(c?.when).toBeNull();
    expect(c?.due).toBe(T + MIN + 30 * MIN);
    // 不写地方的照旧记在这里，没说时间就没有劲。
    const local = fold([done(T + MIN, { kind: "intend", when: null, what: "改天聊" })], known());
    expect(local.chats[DM]?.commitments.open[0]?.due).toBeNull();
  });

  it("the target's card says where it was made; the DM's card says where it is to be done", () => {
    const w = fold([done(T + MIN, promise)], known());
    expect(card(w, GROUP, T + 4 * MIN)).toContain(
      "我答应过或打算在这里做的事：\n- 在群里把那段念成语音发出来（和阿明私聊时定下的，没说什么时候，3 分钟前记下的）",
    );
    expect(card(w, DM, T + 4 * MIN)).toContain(
      `我在这里答应过、要去别处做的事：\n- 在群里把那段念成语音发出来（在「${TITLE}」群里做，没说什么时候，3 分钟前记下的）`,
    );
    expect(card(w, OTHER, T + 4 * MIN)).not.toContain("念成语音");
  });

  it("done in the target: gone there, and the DM's card says it was done", () => {
    const w = fold(
      [done(T + MIN, promise), done(T + 20 * MIN, { kind: "fulfil", what: "念成语音" }, GROUP)],
      known(),
    );
    expect(w.chats[GROUP]?.commitments.open).toEqual([]);
    expect(card(w, GROUP, T + H)).not.toContain("念成语音");
    expect(card(w, DM, T + H)).toContain("（在「周末爬山群【先看置顶】」群里做，我记下做完了）");
  });

  it("not done: after the urge fades it stays in mind where it was promised, without claiming a time", () => {
    const w = fold([done(T + MIN, promise)], known());
    const c = w.chats[GROUP]?.commitments.open[0];
    const later = (c?.expireAt ?? 0) + H;
    expect(card(w, DM, later)).toContain("（在「周末爬山群【先看置顶】」群里做，我没记下做完）");
    expect(card(w, GROUP, later)).toContain("（和阿明私聊时定下的，我没记下做完）");
  });
});

describe(
  "in the closed loop with production: the promise wakes her in the group, once done it stops",
  { timeout: 15_000 },
  () => {
    /** 私聊里阿明求她；之后两个群都没人说话，能叫醒她去爬山群的只有这件事。 */
    /** chatty：她之前在群里每次醒来都说了话（她在这里的份额高过这个群的带，线上那次就是这样）。 */
    const run = (variant: "follow" | "decline" | "control", chatty = false) => {
      const groupPrompts: string[] = [];
      // 群里几个人聊过一阵。
      const chatter = Array.from({ length: 24 }, (_, i) =>
        msg(T - 3 * H + i * 5 * MIN, {
          scope: GROUP,
          senderId: `u${1 + (i % 6)}`,
          senderName: i % 6 === 0 ? "阿明" : `群友${i % 6}`,
        }),
      );
      return replay(
        [
          ...chatter,
          msg(T, { text: "求你了去群里念一下嘛" }),
          msg(T + 9 * H, { scope: "telegram:-999", senderId: "u9", senderName: "路人" }),
        ],
        {
          mechanisms,
          tickMs: MIN,
          speech: (request) => {
            if (request.scope === DM) {
              return {
                acts: [
                  { kind: "send", text: "行吧", replyTo: null },
                  // 只在答应的那一轮记下（之后私聊里再醒，她只是聊天）。
                  ...(variant === "control" || request.at > T + 5 * MIN
                    ? []
                    : [
                        {
                          kind: "intend",
                          when: null,
                          what: "去群里念那段",
                          where: "爬山群",
                        } as Act,
                      ]),
                ],
              };
            }
            if (request.scope !== GROUP) return { acts: [] };
            if (request.at < T) {
              return { acts: chatty ? [{ kind: "send", text: "哈哈", replyTo: null }] : [] };
            }
            groupPrompts.push(renderSpeechPrompt("p", request).user);
            return variant === "follow"
              ? {
                  acts: [
                    { kind: "voice", text: "念给你们听" },
                    { kind: "fulfil", what: "念那段" },
                  ],
                }
              : { acts: [{ kind: "send", text: "嗯", replyTo: null }] };
          },
        },
      ).then((r) => ({
        calls: r.effects
          .filter((e) => e.effect.type === "call-speech" && e.effect.scope === GROUP && e.at > T)
          .map((e) => e.at),
        groupPrompts,
        state: r.state,
      }));
    };

    it("control: nobody calls her to the group within the promise window", async () => {
      const calls = (await run("control")).calls.filter((at) => at - T < H);
      expect(calls).toEqual([]);
    });

    it("follow: one wake in the group within the hour, the card and the reason say what and from where", async () => {
      const { calls, groupPrompts } = await run("follow");
      expect(calls).toHaveLength(1);
      expect((calls[0] as number) - T).toBeLessThan(H);
      const prompt = groupPrompts[0] ?? "";
      expect(prompt).toContain("去群里念那段（和阿明私聊时定下的，没说什么时候");
      expect(prompt).toContain("和阿明私聊时答应过要在这里做：去群里念那段。");
    });

    it("she had been talking a lot in the group: the promise still brings her there, the control stays away", async () => {
      expect((await run("control", true)).calls).toEqual([]);
      const { calls } = await run("follow", true);
      expect(calls).toHaveLength(1);
      expect((calls[0] as number) - T).toBeLessThan(H);
    });

    it("decline (speaks there but never does it): it asks again a few times, then lets go", async () => {
      const { calls } = await run("decline");
      expect(calls.length).toBeGreaterThan(1);
      expect(calls.length).toBeLessThanOrEqual(8);
      expect(calls.every((at) => at - T < 7 * H)).toBe(true);
    });
  },
);
