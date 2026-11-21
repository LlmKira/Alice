/**
 * 闭环性质：睡觉是每个叫醒都要经过的状态。
 * - 她说了 [去睡了]，到作息的下一次醒来之前，群里一段她在里面的对话里没人找她的话，不叫醒她——
 *   哪怕这条叫醒在她去睡之前就定下了、正在等对方说完（patience），轮到真正开始想时也要再问一次。
 * - 私聊里找她的话照旧能把她从浅睡里叫起来（睡眠代价按深度，bedtime.ts）。
 */
import { describe, expect, it } from "vitest";
import { nextWake } from "../src/mechanisms/pressure/bedtime.js";
import { mechanisms } from "../src/mechanisms/registry.js";
import type { Effect, SpeechRequest } from "../src/mind/effects.js";
import type { AliceEvent, MessageReceived, SpeechDecision } from "../src/mind/events.js";
import { emptyState } from "../src/mind/state.js";
import { step } from "../src/mind/step.js";
import { replay } from "../src/sim/replay.js";

const S = 1000;
const MIN = 60 * S;
/** 本地（东八区）2026-02-20 23:00。 */
const NIGHT = Date.parse("2026-02-20T23:00:00+08:00");
const G = "telegram:-7";
const DM = "telegram:1";

let n = 0;
const msg = (at: number, o: Partial<MessageReceived> = {}): MessageReceived => {
  const scope = o.scope ?? G;
  const group = scope.startsWith("telegram:-");
  return {
    type: "message.received",
    at,
    scope,
    chatType: group ? "group" : "private",
    messageId: `w${++n}`,
    senderId: group ? `contact:${(n % 3) + 2}` : "contact:1",
    senderName: "群友",
    text: "今天吃什么",
    contentType: "text",
    replyToMessageId: null,
    directed: !group,
    ...o,
  };
};

/** 她每次被叫醒都说一句；私聊里第一次说完就去睡。 */
function speaker() {
  let slept = false;
  const calls: Array<{ scope: string; at: number; trigger: string | null }> = [];
  const speech = async (r: SpeechRequest, _id: string, at?: number): Promise<SpeechDecision> => {
    calls.push({ scope: r.scope, at: at ?? r.at, trigger: r.triggerMessageId });
    if (r.scope === DM && !slept) {
      slept = true;
      return {
        acts: [{ kind: "send", text: "晚安", replyTo: null }, { kind: "bed" }],
      };
    }
    return { acts: [{ kind: "send", text: "嗯", replyTo: null }] };
  };
  return { calls, speech };
}

/**
 * 群里有人点她、她接了一句（对话起始），别人接着聊；私聊的人 23:30 来一条，她回完去睡。
 * 去睡的前几秒，群里一条没点她的话已经让她等着要看（patience）。
 */
function night(): { events: AliceEvent[]; bedBy: number } {
  const dm = NIGHT + 30 * MIN;
  // 群里有人点她（dm 前 40 秒），她接了一句；之后每 20 秒一条没点她的话。
  const events: AliceEvent[] = [msg(dm - 40 * S, { directed: true })];
  for (let at = dm - 20 * S; at < dm + 20 * MIN; at += 20 * S)
    events.push(msg(at === dm ? at + 10 * S : at));
  // 私聊 dm 来一条，等 15 秒才想（patience），她回完去睡。群里 dm + 10 秒那一条让她在对话里再看一眼，
  // 也要等对方说完（12 秒），等完时她已经去睡了。
  events.push(msg(dm, { scope: DM }));
  events.sort((a, b) => a.at - b.at);
  return { events, bedBy: dm + 15 * S };
}

describe("sleep: every wake passes through it", { timeout: 15_000 }, () => {
  it("after [去睡了], a group message nobody sought her with does not wake her before her wake", async () => {
    const { events, bedBy } = night();
    const { calls, speech } = speaker();
    await replay(events, { mechanisms, speech, tickMs: 10 * S });
    const bed = calls.find((c) => c.scope === DM);
    expect(bed?.at).toBe(bedBy);
    // 去睡之前她确实在这段对话里（被点名、接了一句）。
    expect(calls.filter((c) => c.scope === G && c.at < bedBy).length).toBeGreaterThan(0);
    const woken = calls.filter((c) => c.scope === G && c.at > bedBy && c.at < nextWake(bedBy));
    expect(woken).toEqual([]);
  });

  it("a message that came while she was deciding to go to bed does not start another call after it", () => {
    const at = NIGHT + 30 * MIN;
    let state = emptyState;
    const effects: Effect[] = [];
    const feed = (e: AliceEvent) => {
      const r = step(state, e, mechanisms);
      state = r.state;
      effects.push(...r.effects);
    };
    feed(msg(at, { directed: true }));
    const timer = effects.find((e) => e.type === "set-timer");
    if (timer?.type !== "set-timer") throw new Error("no patience timer");
    feed({ type: "timer.fired", at: timer.at, scope: G, timerId: timer.timerId });
    const call = effects.find((e) => e.type === "call-speech");
    if (call?.type !== "call-speech") throw new Error("no call");
    // 她还在想的时候，有人又点了她一次（想完再看）；她这次决定的是道晚安、去睡。
    feed(msg(timer.at + 2 * S, { directed: true }));
    const before = effects.filter((e) => e.type === "call-speech").length;
    feed({
      type: "speech.decided",
      at: timer.at + 5 * S,
      scope: G,
      callId: call.callId,
      decision: { acts: [{ kind: "send", text: "晚安", replyTo: null }, { kind: "bed" }] },
    });
    expect(effects.filter((e) => e.type === "call-speech").length).toBe(before);
  });

  it("a private message seeking her still wakes her from light sleep", async () => {
    const { events, bedBy } = night();
    const morning = nextWake(bedBy) - 10 * MIN;
    events.push(msg(morning, { scope: DM, text: "早，醒了吗" }));
    const { calls, speech } = speaker();
    await replay(events, { mechanisms, speech, tickMs: 10 * S });
    const woken = calls.filter((c) => c.scope === DM && c.at >= morning && c.at < nextWake(bedBy));
    expect(woken.length).toBeGreaterThan(0);
  });
});
