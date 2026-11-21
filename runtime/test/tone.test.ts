/**
 * 判口气（llm/tone.ts）：外壳在叫醒时问 Jev，结果作为 message.perceived 的 tone 写进 Journal；回放读场景里写好的。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeEvent } from "../src/journal.js";
import type { Gateway } from "../src/llm/gateway.js";
import { perceiveTone } from "../src/llm/tone.js";
import { type FamiliarState, familiar } from "../src/mechanisms/familiar.js";
import { pressureProduction } from "../src/mechanisms/pressure/index.js";
import { rankOf } from "../src/mechanisms/pressure/relation.js";
import type { World } from "../src/mechanisms/pressure/world.js";
import { mechanisms } from "../src/mechanisms/registry.js";
import type { AliceEvent, Tone } from "../src/mind/events.js";
import { emptyState } from "../src/mind/state.js";
import { step } from "../src/mind/step.js";
import { gated } from "../src/ops/gate.js";
import { createFold, Shell, type ShellPorts } from "../src/shell.js";
import { parse, replayEvents } from "../src/sim/will-replay.js";
import { modelReply } from "./model-reply.js";

const T0 = Date.parse("2026-11-10T14:00:00+08:00");
const DM = "telegram:1";

let n = 0;
const msg = (
  at: number,
  text: string,
  directed = true,
): Extract<AliceEvent, { type: "message.received" }> => ({
  type: "message.received",
  at,
  scope: DM,
  chatType: "private",
  messageId: `m${++n}`,
  senderId: "contact:1",
  senderName: "阿凯",
  text,
  contentType: "text",
  replyToMessageId: null,
  directed,
});
const perceived = (
  m: { scope: string; messageId: string; at: number },
  tone: Tone,
): AliceEvent => ({
  type: "message.perceived",
  at: m.at + 2000,
  scope: m.scope,
  messageId: m.messageId,
  tone,
});

describe("a message perceived as hostile is not an interaction (closeness)", () => {
  const MIN = 60_000;
  const fold = (events: readonly AliceEvent[]) =>
    events.reduce((s, e) => step(s, e, mechanisms).state, emptyState);
  const scores = (events: readonly AliceEvent[]) => {
    const s = fold(events);
    const world = s.mechanisms[pressureProduction.name] as World;
    const known = s.mechanisms[familiar.name] as FamiliarState;
    return {
      world:
        rankOf(world.relations, "contact:1", T0 + 2 * MIN) === null
          ? null
          : (world.relations.people["contact:1"]?.warmth.score ?? null),
      familiar:
        rankOf(known, "contact:1", T0 + 2 * MIN) === null
          ? null
          : (known.people["contact:1"]?.warmth.score ?? null),
    };
  };

  it("the hostile message's episode is taken back, in the pressure field's closeness and in familiar's", () => {
    const hi = msg(T0, "在干嘛");
    const hurt = msg(T0 + 30 * MIN, "你真烦");
    const before = scores([hi]);
    expect(scores([hi, hurt]).world).toBeGreaterThan(before.world ?? 0);
    expect(scores([hi, hurt, perceived(hurt, "hostile")])).toEqual(before);
    // 别的口气不动。
    expect(scores([hi, hurt, perceived(hurt, "cold")])).toEqual(scores([hi, hurt]));
  });

  it("a stranger whose first words are hostile is not in the ranking at all", () => {
    const poke = msg(T0, "你就是个程序吧");
    expect(scores([poke, perceived(poke, "hostile")])).toEqual({ world: null, familiar: null });
  });

  it("a later interaction is left alone", () => {
    const hurt = msg(T0, "你真烦");
    const later = msg(T0 + 30 * MIN, "刚才开玩笑的");
    const all = [hurt, later, perceived(hurt, "hostile")];
    expect(scores(all)).toEqual(scores([hurt, later]));
  });
});

describe("message.perceived carries a tone", () => {
  it("reads back from the Journal and leaves the timeline alone", () => {
    const e = decodeEvent("message.perceived", DM, {
      type: "message.perceived",
      at: T0,
      scope: DM,
      messageId: "7",
      tone: "hostile",
    });
    expect(e).toMatchObject({ messageId: "7", tone: "hostile" });
    const m = msg(T0, "你好烦");
    const s = step(emptyState, m, mechanisms).state;
    const after = step(s, perceived(m, "hostile"), mechanisms).state;
    expect(after.chats[DM]?.timeline).toEqual(s.chats[DM]?.timeline);
  });

  it("will-replay keeps the scene's perceptions (a fact of the world, not asked again)", () => {
    const dir = mkdtempSync(join(tmpdir(), "alice-tone-"));
    try {
      const dataset = join(dir, "events.jsonl");
      const m = msg(T0, "你好烦");
      const events = [m, perceived(m, "hostile")];
      writeFileSync(dataset, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
      const kept = replayEvents(parse([dataset, dir, "production"])).filter(
        (e) => e.type === "message.perceived",
      );
      expect(kept).toEqual([events[1]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the shell asks for the tone once per wake, only for messages aimed at her", () => {
  const harness = (perceive?: ShellPorts["perceiveTone"]) => {
    let now = T0;
    const journal: AliceEvent[] = [];
    const timers: Array<() => void> = [];
    const asked: string[][] = [];
    const ports: ShellPorts = {
      now: () => now,
      append: (event) => void journal.push(event),
      journaled: () => {},
      callModel: async () => modelReply([]),
      act: async () => ({ kind: "done" }),
      background: async () => {
        throw new Error("none");
      },
      ...(perceive
        ? {
            perceiveTone: (chatType, lines, ids, signal) => {
              asked.push([...ids]);
              return perceive(chatType, lines, ids, signal);
            },
          }
        : {}),
      schedule: (delayMs, fire) => {
        timers.push(() => {
          now += delayMs;
          fire();
        });
        return () => {};
      },
      fatal: (error) => {
        throw error;
      },
      log: () => {},
      paused: () => false,
    };
    const shell = new Shell(ports, mechanisms, "P", createFold(mechanisms).result());
    return { shell, journal, timers, asked };
  };
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };

  it("judges the waiting directed messages when she wakes there and journals the tone", async () => {
    const h = harness(async (_t, _l, ids) =>
      Object.fromEntries(ids.map((id) => [id, { tone: "hostile" as Tone }])),
    );
    h.shell.dispatch(msg(T0, "在吗"));
    h.shell.dispatch(msg(T0 + 1000, "你好烦"));
    h.timers.at(-1)?.();
    await settle();
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]).toHaveLength(2);
    const tones = h.journal.filter((e) => e.type === "message.perceived");
    expect(tones.map((e) => (e as { tone?: Tone }).tone)).toEqual(["hostile", "hostile"]);
  });

  it("the pause gate refuses the tone call (no spending while paused)", async () => {
    let asked = 0;
    const base = {
      perceiveTone: async () => {
        asked++;
        return {};
      },
    } as unknown as ShellPorts;
    const ports = gated(base, { paused: true, onPause: () => {} });
    await expect(
      ports.perceiveTone?.("private", [], ["1"], new AbortController().signal),
    ).rejects.toThrow("paused");
    expect(asked).toBe(0);
  });

  it("without the port nothing is asked", async () => {
    const h = harness();
    h.shell.dispatch(msg(T0, "你好烦"));
    h.timers.at(-1)?.();
    await settle();
    expect(h.journal.some((e) => e.type === "message.perceived")).toBe(false);
  });

  it("the tone goes to Jev, the three unwelcome questions to the stronger model, in parallel, and both are read back", async () => {
    const posted: Array<{ path: string; body: Record<string, unknown> }> = [];
    const gateway = {
      post: async (call: { path: string; body: Record<string, unknown> }) => {
        posted.push(call);
        if (call.path === "/systemone")
          return {
            body: {
              answers: {
                q0: { choice: "hostile" },
                q1: { choice: "maybe" },
                q2: { choice: "cold" },
              },
            },
            spent: {} as never,
          };
        const content = JSON.stringify({
          "1": { stop: "yes", hush: "no", aloof: "no" },
          "2": { stop: "no", hush: "yes", aloof: "no" },
          "3": { stop: "no", hush: "no", aloof: "no" },
        });
        return { body: { choices: [{ message: { content } }] }, spent: {} as never };
      },
      charge: () => {},
    } as unknown as Gateway;
    const lines = [
      { id: "1", who: "阿凯", text: "别回我了" },
      { id: "2", who: "阿凯", text: "闭嘴吧" },
      { id: "3", who: "阿凯", text: "随便" },
    ];
    expect(await perceiveTone(gateway, "group", lines, ["1", "2", "3"])).toEqual({
      "1": { tone: "hostile", stop: true },
      "2": { hush: true },
      "3": { tone: "cold" },
    });
    expect(posted.map((p) => p.path).sort()).toEqual(["/chat/completions", "/systemone"]);
    const jev = posted.find((p) => p.path === "/systemone");
    const qs = jev?.body.questions as Record<string, { type: string; criteria: object }>;
    expect(Object.keys(qs)).toEqual(["q0", "q1", "q2"]);
    expect(Object.keys(qs.q0?.criteria ?? {})).toEqual(["friendly", "neutral", "cold", "hostile"]);
  });

  it("an unreadable answer from the stronger model leaves only the tone", async () => {
    const gateway = {
      post: async (call: { path: string }) =>
        call.path === "/systemone"
          ? { body: { answers: { q0: { choice: "neutral" } } }, spent: {} as never }
          : { body: { choices: [{ message: { content: "不是 JSON" } }] }, spent: {} as never },
      charge: () => {},
    } as unknown as Gateway;
    expect(
      await perceiveTone(gateway, "group", [{ id: "1", who: "阿凯", text: "嗯" }], ["1"]),
    ).toEqual({ "1": { tone: "neutral" } });
  });

  it("the shell journals stop alongside the tone", async () => {
    const h = harness(async (_t, _l, ids) =>
      Object.fromEntries(ids.map((id) => [id, { tone: "hostile" as Tone, stop: true as const }])),
    );
    h.shell.dispatch(msg(T0, "别回我了"));
    h.timers.at(-1)?.();
    await settle();
    const perceived = h.journal.filter((e) => e.type === "message.perceived");
    expect(perceived).toEqual([expect.objectContaining({ tone: "hostile", stop: true })]);
  });
});
