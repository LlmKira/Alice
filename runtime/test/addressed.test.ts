/**
 * 关系模型的线上 footprint（src/sim/addressed.ts）：
 * - 回避按人记：在复刻 12:17 的一串事件上，点她名的那条叫醒她、是按人读才值得回的，没有哪条冲着她的消息还在读会话的
 *   回避。拿掉 relation 时 rescued 变 0、readRoom 变满（footprint 看得见它不在）。
 * - 口气不好的来找：敌意那条带来的推向开心，判出口气以后不再是她的心情；拿掉 tone 时 unfriendlyGlad 变 1。
 */
import { describe, expect, it } from "vitest";
import {
  affect,
  createPressure,
  PRODUCTION,
  pressureProduction,
} from "../src/mechanisms/pressure/index.js";
import { mechanisms } from "../src/mechanisms/registry.js";
import { affordances } from "../src/mind/affordances.js";
import type { AliceEvent, MessageReceived, MessageSent } from "../src/mind/events.js";
import { addressedFootprint } from "../src/sim/addressed.js";

const T0 = 1_771_000_000_000;
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const GROUP = "telegram:-100";
const localAt = (day: number, hour: number) => T0 - ((T0 + 8 * H) % D) + day * D + hour * H;

let n = 0;
const msg = (at: number, o: Partial<MessageReceived> = {}): MessageReceived => ({
  type: "message.received",
  at,
  scope: GROUP,
  chatType: "group",
  messageId: `m${++n}`,
  senderId: "contact:5",
  senderName: "池塘",
  text: "hi",
  contentType: "text",
  replyToMessageId: null,
  directed: false,
  ...o,
});
const sent = (at: number): MessageSent => ({
  type: "message.sent",
  at,
  scope: GROUP,
  messageId: `s${++n}`,
  text: "嗯",
  kind: "text",
});

/**
 * 早上 contact:2 回过她；下午她每小时主动说一句，都被晾着；最后一句之后一小时她看过一眼、决定不说，三分钟后
 * contact:2 点她名。
 */
function replica(): AliceEvent[] {
  const morning = localAt(1, 10);
  const first = sent(morning);
  const ev: AliceEvent[] = [
    msg(morning - MIN),
    first,
    msg(morning + MIN, { senderId: "contact:2", replyToMessageId: first.messageId }),
    sent(morning + 2 * MIN),
  ];
  for (let k = 0; k < 5; k++) {
    const t = localAt(1, 13) + k * H;
    ev.push(sent(t));
    for (const m of [3, 4, 5])
      ev.push(msg(t + m * MIN, { senderId: `contact:${5 + ((k + m) % 3)}` }));
  }
  const at = localAt(1, 18);
  ev.push({
    type: "speech.decided",
    at: at - 3 * MIN,
    scope: GROUP,
    callId: "c1",
    decision: { acts: [] },
  });
  ev.push(msg(at, { senderId: "contact:2", directed: true }));
  return ev;
}

describe("the per-person aversion footprint", () => {
  it("the mention wakes her only because the will reads the person, and nothing reads the room", () => {
    const f = addressedFootprint(replica());
    expect(f.readRoom).toBe(0);
    expect(f.rescued).toBeGreaterThanOrEqual(1);
    expect(f.woken).toBe(f.addressed);
  });

  it("without relation the footprint shows it: nothing rescued, the mention reads the room", () => {
    const without = createPressure(
      affordances,
      { ...PRODUCTION, relation: undefined },
      {
        name: "pressure-production",
      },
    );
    const list = mechanisms.map((m) => (m === pressureProduction ? without : m));
    const f = addressedFootprint(replica(), list);
    expect(f.rescued).toBe(0);
    expect(f.readRoom).toBe(f.addressed);
  });
});

describe("the unfriendly-approach footprint", () => {
  const DM = "telegram:1";
  /** 前一天 a 来找她、她回了（有过来往）；今天下午 a 又来，外壳判这条是敌意。 */
  function hostile(): AliceEvent[] {
    const day0 = localAt(0, 14);
    const at = localAt(1, 15);
    return [
      msg(day0, { scope: DM, chatType: "private", senderId: "contact:1", directed: true }),
      {
        type: "message.sent",
        at: day0 + MIN,
        scope: DM,
        messageId: "s-a",
        text: "嗯",
        kind: "text",
      },
      msg(at, {
        scope: DM,
        chatType: "private",
        senderId: "contact:1",
        directed: true,
        messageId: "m-hostile",
      }),
      {
        type: "message.perceived",
        at: at + 30_000,
        scope: DM,
        messageId: "m-hostile",
        tone: "hostile",
      },
    ];
  }

  it("the push toward glad from a hostile message does not stand once its tone is in", () => {
    const f = addressedFootprint(hostile());
    expect(f.glad).toBeGreaterThanOrEqual(1);
    expect(f.unfriendlyGlad).toBe(0);
  });

  it("without the tone rule the footprint shows it", () => {
    const without = createPressure(
      affordances,
      {
        ...PRODUCTION,
        affect: affect({
          noise: true,
          lonely: true,
          warmth: { home: true, relevance: true, bids: true },
        }),
      },
      { name: "pressure-production" },
    );
    const list = mechanisms.map((m) => (m === pressureProduction ? without : m));
    expect(addressedFootprint(hostile(), list).unfriendlyGlad).toBe(1);
  });
});
