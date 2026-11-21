/**
 * 候选 dwell（她在这段对话里，mechanisms/pressure/turn.ts）坏掉了会很糟的几条：
 * - 会话的终止都在：她看过、决定不说就放下；对话走过她 K 轮就放下；冷下来就放下——热闹的群不会每条都叫醒她；
 * - 参与身份要别人给：她说完还没人说话时不算在对话里（对着空气接着说不按被邀请算）；
 * - 对话还在时，5 分钟之后别人没点她名的话仍让她再看一眼（floor 做不到的那一段）；
 * - 只在群里：私聊的状态不写；起止写在状态里（Journal 折叠出来读得到）。
 */
import { describe, expect, it } from "vitest";
import { createPressure, dwell, floor, PRODUCTION } from "../src/mechanisms/pressure/index.js";
import { GROUP_ABSENCE_ROUNDS } from "../src/mechanisms/pressure/params.js";
import { inDwell } from "../src/mechanisms/pressure/turn.js";
import { NO_DWELL, type World } from "../src/mechanisms/pressure/world.js";
import { affordances } from "../src/mind/affordances.js";
import type { SpeechRequest } from "../src/mind/effects.js";
import type {
  AliceEvent,
  MessageReceived,
  MessageSent,
  SpeechDecision,
} from "../src/mind/events.js";
import { replay } from "../src/sim/replay.js";

/** 当地（UTC+8，mind/when.ts）下午两点多：她醒着。 */
const T0 = 1_771_000_000_000 - 10 * 3_600_000;
const S = 1000;
const M = 60 * S;
const G = "telegram:-7";
const P = "telegram:8";

let n = 0;
function msg(at: number, o: Partial<MessageReceived> = {}): MessageReceived {
  n++;
  const scope = o.scope ?? G;
  return {
    type: "message.received",
    at,
    scope,
    chatType: scope.startsWith("telegram:-") ? "group" : "private",
    messageId: `d${n}`,
    senderId: o.senderId ?? "contact:1",
    senderName: "群友",
    text: "今天吃什么",
    contentType: "text",
    replyToMessageId: null,
    directed: !scope.startsWith("telegram:-"),
    ...o,
  };
}

function sent(at: number, scope = G): MessageSent {
  n++;
  return { type: "message.sent", at, scope, messageId: `s${n}`, text: "我也想知道", kind: "text" };
}

const say = (text: string): SpeechDecision => ({ acts: [{ kind: "send", text, replyTo: null }] });
const quiet: SpeechDecision = { acts: [] };
const withDwell = createPressure(affordances, { ...PRODUCTION, floor: dwell() });

/** 只折叠世界（不叫醒、不调模型）。 */
function fold(events: readonly AliceEvent[]): World {
  const reduce = withDwell.reduce as (w: World, e: AliceEvent) => World;
  return events.reduce(reduce, withDwell.initial as World);
}

/** 群里有人先说了几句，她接了一句（会话起始）。 */
const opened = (): AliceEvent[] => [
  msg(T0),
  msg(T0 + 10 * S, { senderId: "contact:2" }),
  sent(T0 + 30 * S),
];

describe("dwell: who is in the conversation", () => {
  it("she is in it only after someone else has spoken since her turn", () => {
    const alone = fold(opened());
    const chat = alone.chats[G];
    expect(chat?.turn.dwell.from).toBe(T0 + 30 * S);
    expect(chat && inDwell(chat, T0 + 40 * S)).toBe(false);
    const taken = fold([...opened(), msg(T0 + 50 * S, { senderId: "contact:3" })]);
    expect(taken.chats[G] && inDwell(taken.chats[G], T0 + 60 * S)).toBe(true);
  });

  it("the conversation passes her by after K messages without her", () => {
    const events = opened();
    for (let i = 1; i <= GROUP_ABSENCE_ROUNDS + 1; i++)
      events.push(msg(T0 + 30 * S + i * 15 * S, { senderId: `contact:${(i % 3) + 1}` }));
    const world = fold(events);
    expect(world.chats[G]?.turn.dwell.ended?.why).toBe("passed-by");
    expect(world.chats[G] && inDwell(world.chats[G], T0 + 10 * M)).toBe(false);
  });

  it("a silence longer than the group's own K rounds ends it, and the next message does not reopen it", () => {
    const world = fold([...opened(), msg(T0 + 50 * S), msg(T0 + 5 * 3_600_000)]);
    expect(world.chats[G]?.turn.dwell.ended?.why).toBe("cooled");
    expect(world.chats[G] && inDwell(world.chats[G], T0 + 5 * 3_600_000 + S)).toBe(false);
  });

  it("private chats keep no session state (every message there is already for her)", () => {
    const world = fold([
      msg(T0, { scope: P }),
      sent(T0 + 20 * S, P),
      msg(T0 + 40 * S, { scope: P }),
    ]);
    expect(world.chats[P]?.turn.dwell).toBe(NO_DWELL);
  });
});

async function run(events: AliceEvent[], speech: (r: SpeechRequest) => SpeechDecision) {
  let world: World | undefined;
  const result = await replay(events, {
    mechanisms: [withDwell],
    speech,
    tickMs: 10 * S,
    observe: (_, state) => {
      world = state.mechanisms[withDwell.name] as World;
    },
  });
  const calls = result.effects.flatMap((r) =>
    r.effect.type === "call-speech" && r.effect.scope === G ? [r] : [],
  );
  return { world: world as World, calls };
}

describe("dwell: inside the conversation", () => {
  it("after she declines once inside the conversation, a busy group stops waking her", async () => {
    // 她被点名、回了一句；之后群里每 10 秒一条与她无关的话。
    const events: AliceEvent[] = [msg(T0, { directed: true, senderId: "contact:2" })];
    for (let i = 1; i <= 40; i++)
      events.push(msg(T0 + 20 * S + i * 10 * S, { senderId: `contact:${(i % 3) + 1}` }));
    let calls = 0;
    const { world, calls: groupCalls } = await run(events, (r) => {
      if (r.scope !== G) return quiet;
      calls++;
      return calls === 1 ? say("在呢") : quiet;
    });
    expect(world.chats[G]?.turn.dwell.ended?.why).toBe("declined");
    // 被点名的那次、在对话里看了一眼决定不说的那次；之后不再因为这段对话被叫醒（节律仍可能另起几次）。
    expect(groupCalls.length).toBeGreaterThanOrEqual(2);
    expect(groupCalls.length).toBeLessThanOrEqual(5);
  });

  it("a slow conversation keeps her in it beyond five minutes: a plain message then still wakes her", async () => {
    // 被点名、她回了；之后每 3 分钟一条与她无关的话。她每次被叫醒都说一句。
    const events: AliceEvent[] = [msg(T0, { directed: true, senderId: "contact:2" })];
    for (let i = 1; i <= 8; i++)
      events.push(msg(T0 + i * 3 * M, { senderId: `contact:${(i % 3) + 1}` }));
    // 她上一次开口 5 分钟以后，一条没点她名的话叫醒了她：按 5 分钟算的 floor 在这一刻已经放下了。
    const lateWake = async (mechanism: typeof withDwell) => {
      let last = -1;
      let late = false;
      await replay(events, {
        mechanisms: [mechanism],
        speech: (r) => {
          if (r.scope !== G) return quiet;
          if (last >= 0 && r.triggerMessageId !== null && r.at - last > 5 * M) late = true;
          last = r.at;
          return say("嗯嗯");
        },
        tickMs: 10 * S,
      });
      return late;
    };
    expect(await lateWake(withDwell)).toBe(true);
    expect(await lateWake(createPressure(affordances, { ...PRODUCTION, floor }))).toBe(false);
  });
});
