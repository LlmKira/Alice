/**
 * 她不在时别处错过了什么（mechanisms/missed.ts，2 月 overnight briefing）：只算她上次看消息之后的、
 * 不带别处的内容（带谁私聊、哪个群）、没什么可说就不说、睡过一觉或隔了一小时以上才说。
 */
import { describe, expect, it } from "vitest";
import { missed, withMissed } from "../src/mechanisms/missed.js";
import { bedtime } from "../src/mechanisms/pressure/bedtime.js";
import { createPressure, PRODUCTION } from "../src/mechanisms/pressure/index.js";
import { life } from "../src/mechanisms/pressure/life.js";
import { SLEEP_WINDOW } from "../src/mechanisms/pressure/sleep.js";
import { affordances } from "../src/mind/affordances.js";
import type { AliceEvent, MessageReceived } from "../src/mind/events.js";
import type { Mechanism } from "../src/mind/mechanism.js";
import { type AliceState, type ChatState, emptyState } from "../src/mind/state.js";
import { speechRequest, step } from "../src/mind/step.js";
import { arms } from "../src/sim/will-arms.js";
import { renderSpeechPrompt } from "../src/speech/prompt.js";

const MIN = 60_000;
/** 2026-11-10 东八区本地 0 点。 */
const DAY = Date.UTC(2026, 10, 9, 16, 0);
const local = (minute: number) => DAY + minute * MIN;

const HERE = "telegram:1";
const DM = "telegram:2";
const GROUP = "telegram:-5";

let seq = 0;
function msg(scope: string, at: number, o: Partial<MessageReceived> = {}): MessageReceived {
  const group = scope.startsWith("telegram:-");
  return {
    type: "message.received",
    at,
    scope,
    chatType: group ? "group" : "private",
    messageId: `m${++seq}`,
    senderId: group ? "u9" : scope,
    senderName: group ? "阿杰" : "陈蔓",
    text: "在吗",
    contentType: "text",
    replyToMessageId: null,
    directed: !group,
    ...o,
  };
}

const decided = (scope: string, at: number): AliceEvent => ({
  type: "speech.decided",
  at,
  scope,
  callId: `c${++seq}`,
  decision: { acts: [] },
});

function run(events: AliceEvent[], list: readonly Mechanism[] = [missed]): AliceState {
  return events.reduce((s, e) => step(s, e, list).state, emptyState);
}

function fact(
  state: AliceState,
  scope: string,
  now: number,
  list: readonly Mechanism[] = [missed],
) {
  const request = speechRequest(state, state.chats[scope] as ChatState, now, null, list);
  return request.contributions.find((c) => c.mechanism === "missed");
}

const many = (scope: string, from: number, n: number, o: Partial<MessageReceived> = {}) =>
  Array.from({ length: n }, (_, i) => msg(scope, from + i * MIN, o));

describe("what she missed", () => {
  it("after a long gap, counts what came elsewhere and who is waiting, as a moment fact", () => {
    const state = run([
      msg(HERE, local(14 * 60 - 1)),
      decided(HERE, local(14 * 60)),
      ...many(DM, local(15 * 60), 2),
      ...many(GROUP, local(15 * 60), 9, { directed: false }),
      msg(GROUP, local(16 * 60), { directed: true }),
      msg(HERE, local(17 * 60 + 29)),
    ]);
    const c = fact(state, HERE, local(17 * 60 + 30));
    expect(c?.kind).toBe("state");
    expect(c?.text).toBe(
      "我有 4 小时没看消息，别的聊天里来了 12 条：陈蔓私聊我（2 条），一个群里有 1 条点名或回复我（群里一共 10 条）。",
    );
  });

  it("counts only what came after she last looked, anywhere", () => {
    const state = run([
      msg(HERE, local(9 * 60)),
      decided(HERE, local(9 * 60 + 1)),
      ...many(GROUP, local(10 * 60), 30, { directed: false }),
      // 她在私聊里看过、回过：之前群里那 30 条不算没看到的了。
      msg(DM, local(11 * 60)),
      decided(DM, local(11 * 60 + 1)),
      ...many(GROUP, local(12 * 60), 3, { directed: false }),
      ...many(DM, local(12 * 60), 4),
      msg(HERE, local(13 * 60)),
    ]);
    expect(fact(state, HERE, local(13 * 60))?.text).toBe(
      "我有 2 小时没看消息，别的聊天里来了 7 条：陈蔓私聊我（4 条），一个群里聊了 3 条。",
    );
  });

  // PLAN 第 33 件以前名字也不写；谁来找过她不是托付的事，现在写出是谁、哪个群，内容照旧不写。
  it("never carries another chat's words; says who wrote and which group", () => {
    const state = run([
      msg(HERE, local(14 * 60)),
      decided(HERE, local(14 * 60)),
      msg(DM, local(15 * 60), { text: "我怀孕了，先别告诉别人", senderName: "陈蔓" }),
      msg("telegram:3", local(15 * 60), { text: "借我五千", senderName: "老周", senderId: "u3" }),
      ...many(GROUP, local(15 * 60), 6, {
        text: "周五团建",
        senderName: "阿杰",
        directed: true,
        chatTitle: "胶片群",
      }),
      msg(HERE, local(17 * 60)),
    ]);
    const text = fact(state, HERE, local(17 * 60))?.text ?? "";
    expect(text).toContain("2 个人私聊我（陈蔓、老周，一共 2 条）");
    expect(text).toContain("「胶片群」群里有 6 条点名或回复我");
    for (const leak of ["怀孕", "五千", "团建", "阿杰"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("says nothing when nothing was missed", () => {
    const awake = (events: AliceEvent[], now: number) => fact(run(events), HERE, now);
    const start = [msg(HERE, local(14 * 60)), decided(HERE, local(14 * 60))];
    // 隔了很久，但别处只有几条闲聊（2 月门槛：≤ 5 条又没人找她）。
    expect(
      awake([...start, ...many(GROUP, local(15 * 60), 5, { directed: false })], local(17 * 60)),
    ).toBeUndefined();
    // 隔了很久，只有此刻这个会话自己来了消息：就在时间线上，不用再说。
    expect(awake([...start, ...many(HERE, local(15 * 60), 8)], local(17 * 60))).toBeUndefined();
    // 别处很热闹，但她半小时前刚看过，醒着。
    expect(
      awake([...start, ...many(GROUP, local(14 * 60 + 5), 20)], local(14 * 60 + 30)),
    ).toBeUndefined();
    // 她从来没看过消息（2 月：没有行动记录就没有简报）。
    expect(
      awake([msg(HERE, local(14 * 60)), msg(DM, local(15 * 60))], local(17 * 60)),
    ).toBeUndefined();
  });

  it("speaks after sleep, even when the gap is under an hour", () => {
    const { onset } = SLEEP_WINDOW;
    const state = run([
      msg(HERE, local(onset - 15)),
      decided(HERE, local(onset - 10)),
      msg(DM, local(onset + 10)),
      msg(HERE, local(onset + 29)),
    ]);
    expect(fact(state, HERE, local(onset + 30))?.text).toBe(
      "我睡着的时候别的聊天里来了 1 条：陈蔓私聊我（1 条）。",
    );
  });

  it("in production waking and what came while she slept are one sentence; the no-missed arm drops the second half", () => {
    const { wake } = SLEEP_WINDOW;
    const night = local(24 * 60 + wake - 60 * 6);
    const events = [
      msg(HERE, local(22 * 60)),
      decided(HERE, local(22 * 60 + 1)),
      ...many(DM, night, 3),
      ...many(GROUP, night, 20, { directed: false }),
      msg(HERE, local(24 * 60 + wake + 5)),
    ];
    const now = local(24 * 60 + wake + 6);
    const user = (list: readonly Mechanism[]) => {
      const state = run(events, list);
      const request = speechRequest(state, state.chats[HERE] as ChatState, now, null, list);
      return renderSpeechPrompt("", request).user;
    };
    const withBedtime = [
      createPressure(affordances, {
        ...PRODUCTION,
        sleep: withMissed(bedtime),
        life: life({ warm: true }),
      }),
    ];
    const withBed = user(withBedtime);
    expect(withBed).toContain("· 我这边：我刚睡醒，睡着的时候别的聊天里来了 23 条：");
    expect(withBed.match(/睡/g)?.length).toBe(2);
    const without = user(arms({})["no-missed"] as readonly Mechanism[]);
    expect(without).toContain("· 我这边：我刚睡醒。");
    expect(without).not.toContain("别的聊天里来了");
  });
});
