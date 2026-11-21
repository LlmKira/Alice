/**
 * 候选 glance（看一眼，mechanisms/pressure/glance.ts）坏掉了会很糟的几条：
 * - 看一眼不调模型：那一格那个会话没有发言调用；看过之后这个会话的未读拉力为 0（不会每一格都看同一个群）；
 * - 有人在等她（被点名）时照样叫醒她斟酌，不只看一眼；
 * - 看一眼是 Journal 里的一条事实（chat.glanced），读回原样；外壳写的日志折叠出的状态和外壳自己的相同；
 *   只在她是成员的会话里标已读；
 * - 生产里还没有看一眼（没过预注册的判定，eval-artifacts/glance/prereg.md）。
 */
import { describe, expect, it } from "vitest";
import { decodeEvent, type JournaledEvent } from "../src/journal.js";
import { effectiveUnread } from "../src/mechanisms/pressure/drives.js";
import type { World } from "../src/mechanisms/pressure/world.js";
import { mechanisms as production } from "../src/mechanisms/registry.js";
import type { Effect } from "../src/mind/effects.js";
import type { AliceEvent, ChatGlanced, MessageReceived } from "../src/mind/events.js";
import { Failed } from "../src/mind/failure.js";
import { emptyChat, emptyState } from "../src/mind/state.js";
import { step } from "../src/mind/step.js";
import { createFold, Shell, type ShellPorts } from "../src/shell.js";
import { replay } from "../src/sim/replay.js";
import { arms } from "../src/sim/will-arms.js";
import { modelReply } from "./model-reply.js";

/** 当地（UTC+8，mind/when.ts）下午两点多：她醒着。 */
const T0 = 1_771_000_000_000 - 10 * 3_600_000;
const S = 1000;
const M = 60 * S;
const G = "telegram:-7";

let n = 0;
function msg(at: number, o: Partial<MessageReceived> = {}): MessageReceived {
  n++;
  return {
    type: "message.received",
    at,
    scope: G,
    chatType: "group",
    messageId: `g${n}`,
    senderId: `contact:${1 + (n % 3)}`,
    senderName: "群友",
    text: "今天吃什么",
    contentType: "text",
    replyToMessageId: null,
    directed: false,
    ...o,
  };
}

/** 群里别人聊了 40 分钟，每 30 秒一条，没人找她。 */
const chatter = (): MessageReceived[] => Array.from({ length: 80 }, (_, i) => msg(T0 + i * 30 * S));

const glanceArm = arms({}).glance as NonNullable<ReturnType<typeof arms>[string]>;
const pressure = glanceArm[0] as (typeof glanceArm)[number];

async function run(events: readonly AliceEvent[]) {
  const seen: Array<{ event: AliceEvent; world: World }> = [];
  const calls: Array<{ scope: string; at: number; trigger: string | null }> = [];
  const result = await replay(events, {
    mechanisms: glanceArm,
    tickMs: 10_000,
    speech: (request, _id, at) => {
      calls.push({ scope: request.scope, at: at ?? 0, trigger: request.triggerMessageId });
      return { acts: [] };
    },
    observe: (event, state) =>
      seen.push({ event, world: state.mechanisms[pressure.name] as World }),
  });
  return { ...result, seen, calls };
}

describe("glance: a look instead of a model call", () => {
  it("glances at a group with unread nobody aimed at her, without a speech call at that tick", async () => {
    const { effects, seen } = await run(chatter());
    const glances = effects.filter((r) => r.effect.type === "glance");
    expect(glances.length).toBeGreaterThan(0);
    for (const g of glances) {
      const sameTick = effects.filter((r) => r.at === g.at && r.effect.scope === g.effect.scope);
      expect(sameTick.some((r) => r.effect.type === "call-speech")).toBe(false);
    }
    // 每一眼都写成 chat.glanced；看过之后这个会话的未读和未读的拉力都是 0。
    const glanced = seen.filter((s) => s.event.type === "chat.glanced");
    expect(glanced.length).toBe(glances.length);
    for (const s of glanced) {
      const chat = s.world.chats[G];
      expect(chat?.unread).toBe(0);
      expect(chat && effectiveUnread(chat, s.event.at)).toBe(0);
    }
  });

  it("a look marks the chat read on Telegram, in that chat only, and only where she is a member", () => {
    const at = T0;
    const look: ChatGlanced = { type: "chat.glanced", at, scope: G };
    const member = { ...emptyState, chats: { [G]: emptyChat(G, "group", true) } };
    const effects: Effect[] = step(member, look, glanceArm).effects;
    expect(effects).toEqual([{ type: "act", scope: G, act: { kind: "mark-read" } }]);
    const left = { ...emptyState, chats: { [G]: emptyChat(G, "group", false) } };
    expect(step(left, look, glanceArm).effects).toEqual([]);
  });

  it("someone calling her still wakes her to think, not just to look", async () => {
    const events = [...chatter()];
    const called = msg(T0 + 20 * M + 5 * S, { directed: true, text: "Alice 你觉得呢" });
    events.push(called);
    events.sort((a, b) => a.at - b.at);
    const { calls, effects } = await run(events);
    expect(calls.some((c) => c.scope === G && c.trigger === called.messageId)).toBe(true);
    // 被点名到她想完之前，这个群不只看一眼。
    const answered = calls.find((c) => c.trigger === called.messageId)?.at ?? 0;
    const between = effects.filter(
      (r) => r.effect.type === "glance" && r.at >= called.at && r.at < answered,
    );
    expect(between).toEqual([]);
  });

  it("the shell journals the look and the tick that caused it; folding the journal gives the same state", async () => {
    let now = T0;
    const journal: JournaledEvent[] = [];
    const acts: string[] = [];
    const spoken: number[] = [];
    const ports: ShellPorts = {
      now: () => now,
      append: (event) => void journal.push(event),
      journaled: () => {},
      callModel: async (_prompt, call) => {
        if (call.kind === "speech") spoken.push(now);
        return modelReply([]);
      },
      act: async (scope, act) => {
        acts.push(`${scope}:${act.kind}`);
        return { kind: "done" };
      },
      schedule: () => () => {},
      background: async () => {
        throw new Failed({ reason: "unavailable" });
      },
      fatal: (error) => {
        throw error;
      },
      log: () => {},
      paused: () => false,
    };
    const shell = new Shell(ports, glanceArm, "你是 Alice。", createFold(glanceArm).result());
    for (const m of chatter().slice(0, 20)) {
      now = m.at;
      shell.dispatch(m);
    }
    const until = now + 10 * M;
    for (let t = now + 10 * S; t < until; t += 10 * S) {
      now = t;
      shell.dispatch({ type: "clock.tick", at: t });
    }
    await new Promise((r) => setTimeout(r, 0));
    const looks = journal.filter((e) => e.type === "chat.glanced");
    expect(looks.length).toBeGreaterThan(0);
    // 看一眼的那一格没有发言调用。
    for (const look of looks) expect(spoken).not.toContain(look.at);
    expect(acts.filter((a) => a === `${G}:mark-read`).length).toBe(looks.length);
    for (const look of looks) {
      const before = journal[journal.indexOf(look) - 1];
      expect(before).toMatchObject({ type: "clock.tick", scope: G });
    }
    const fold = createFold(glanceArm);
    for (const e of journal) fold.feed(e);
    expect(fold.result().state).toEqual(shell.current);
  });

  it("the look is a Journal fact that reads back as written", () => {
    const look: ChatGlanced = { type: "chat.glanced", at: T0, scope: G };
    expect(decodeEvent("chat.glanced", G, JSON.parse(JSON.stringify(look)))).toEqual(look);
    expect(decodeEvent("chat.glanced", "telegram:-8", look)).toBeNull();
  });

  it("production does not glance yet (the prereg verdict failed)", async () => {
    expect(production.some((m) => m.glance)).toBe(false);
  });
});
