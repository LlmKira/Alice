/**
 * 心情用她自己的词（PLAN 第 34 件）：她写什么词就是什么词，不再从 14 个词里选；效价由外壳问判口气的模型
 * （llm/tone.ts perceiveMood），写在那条心情的事件上；判不出效价的心情只记下词，不 fold 进她的心情。
 */
import { describe, expect, it } from "vitest";
import { decodeEvent } from "../src/journal.js";
import { perceiveMood, valenceOfScore } from "../src/llm/tone.js";
import { initialAffect, moodOf, reduceAffect } from "../src/mechanisms/pressure/affect.js";
import { mechanisms } from "../src/mechanisms/registry.js";
import { buildAct } from "../src/mind/args.js";
import type { AliceEvent } from "../src/mind/events.js";
import { createFold, Shell, type ShellPorts } from "../src/shell.js";
import { parseReflect } from "../src/speech/reflect.js";
import { fakeGateway } from "./fake-gateway.js";
import { modelReply } from "./model-reply.js";

const T0 = Date.parse("2026-11-10T14:00:00+08:00");
const DM = "telegram:1";
const MIN = 60_000;

const reflected = (word: string, why: string | null, valence?: number): AliceEvent => ({
  type: "ponder.done",
  at: T0,
  scope: "self",
  callId: "r1",
  ponder: {
    kind: "reflect",
    scope: DM,
    entries: [],
    mood: { word, why, ...(valence === undefined ? {} : { valence }) },
  },
});
const felt = (mood: string, valence?: number): AliceEvent => ({
  type: "act.done",
  at: T0,
  scope: DM,
  act: { kind: "feel", mood, why: "他说想我" },
  ...(valence === undefined ? {} : { valence }),
});
const card = (events: AliceEvent[], at = T0 + MIN) =>
  moodOf(
    events.reduce((s, e) => reduceAffect(s, e), initialAffect),
    DM,
    "private",
    at,
  );

describe("she writes her own mood word", () => {
  const request = { scope: DM, chatType: "private" as const, lines: [], people: [] };

  it("a word outside the old list is kept, with its reason", () => {
    const raw = '{"entries":[],"mood":{"word":"心动","why":"他说想我"}}';
    expect(parseReflect(raw, { ...request } as never).mood).toEqual({
      word: "心动",
      why: "他说想我",
    });
    // 句末的标点去掉；不是一个词或短说法的（太长）不认；null 是没有心情。
    const said = (word: string) =>
      parseReflect(`{"entries":[],"mood":{"word":"${word}","why":null}}`, request as never).mood
        ?.word;
    expect(said("有点心疼。")).toBe("有点心疼");
    expect(
      said(
        "今天发生了好多事情让我心里很乱很乱，而且一时半会儿也理不清楚到底是怎么回事、该从哪说起才好呢，真的好烦躁",
      ),
    ).toBeUndefined();
    expect(parseReflect('{"entries":[],"mood":null}', request as never).mood).toBeUndefined();
  });

  it("[心情] takes her own word too", () => {
    const ctx = { timeline: [], now: T0 };
    expect(buildAct("feel", { mood: "想念", why: null }, ctx)).toEqual({
      kind: "feel",
      mood: "想念",
      why: null,
    });
  });

  it("her own word is on her card once a valence is perceived; without one it is only written down", () => {
    expect(card([reflected("心动", "他说想我", 0.96)])).toContain("心动（1 分钟前，因为他说想我）");
    expect(card([felt("想念", -0.45)])).toContain("想念");
    expect(card([reflected("心动", "他说想我")])).toBeNull();
    expect(card([felt("想念")])).toBeNull();
  });

  it("fading keeps her words readable: 有点心疼 becomes 还有点心疼, not 还有点有点心疼", () => {
    const line = card([reflected("有点心疼", "知微好累", -0.49)], T0 + 70 * MIN);
    expect(line).toContain("还有点心疼");
    expect(line).not.toContain("有点有点");
  });

  it("the valence travels in the Journal with the mood", () => {
    const round = (e: AliceEvent) =>
      decodeEvent(e.type, (e as { scope: string }).scope, JSON.parse(JSON.stringify(e)));
    expect(round(reflected("心动", "x", 0.96))).toMatchObject({
      ponder: { mood: { word: "心动", valence: 0.96 } },
    });
    expect(round(felt("想念", -0.45))).toMatchObject({ valence: -0.45 });
  });
});

describe("the valence comes from the tone judge, not a table", () => {
  it("five ordered levels map onto [−1, 1]", () => {
    expect(valenceOfScore(0)).toBe(-1);
    expect(valenceOfScore(2)).toBe(0);
    expect(valenceOfScore(4)).toBe(1);
    expect(valenceOfScore(3.4)).toBeCloseTo(0.7);
  });

  it("asks one score question about her word and reason", async () => {
    const bodies: unknown[] = [];
    const gateway = fakeGateway((call) => {
      bodies.push(call.body);
      return { answers: { v: { score: 3.92 } } };
    });
    expect(await perceiveMood(gateway, { word: "心动", why: "他说想我" })).toBeCloseTo(0.96);
    expect(JSON.stringify(bodies[0])).toContain("心动（因为他说想我）");
    expect(JSON.stringify(bodies[0])).toContain('"type":"score"');
  });
});

describe("the shell writes the perceived valence onto the mood", () => {
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  const harness = (perceive?: ShellPorts["perceiveMood"]) => {
    let now = T0;
    const journal: AliceEvent[] = [];
    const timers: Array<() => void> = [];
    const ports: ShellPorts = {
      now: () => now,
      append: (event) => void journal.push(event),
      journaled: () => {},
      callModel: async () => modelReply([{ kind: "feel", mood: "心动", why: "他说想我" }]),
      act: async () => ({ kind: "done" }),
      background: async () => {
        throw new Error("none");
      },
      ...(perceive ? { perceiveMood: perceive } : {}),
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
    return { shell, journal, timers };
  };
  const hello: AliceEvent = {
    type: "message.received",
    at: T0,
    scope: DM,
    chatType: "private",
    messageId: "m1",
    senderId: "contact:1",
    senderName: "阿凯",
    text: "想你了",
    contentType: "text",
    replyToMessageId: null,
    directed: true,
  };

  it("her [心情] is journaled with the valence the judge gave", async () => {
    const asked: string[] = [];
    const h = harness(async (mood) => {
      asked.push(mood.word);
      return 0.96;
    });
    h.shell.dispatch(hello);
    h.timers.at(-1)?.();
    await settle();
    expect(asked).toEqual(["心动"]);
    const done = h.journal.find((e) => e.type === "act.done" && e.act.kind === "feel");
    expect(done).toMatchObject({ act: { mood: "心动" }, valence: 0.96 });
  });

  it("when the judge fails, the mood is still written down, without a valence", async () => {
    const h = harness(async () => {
      throw new Error("down");
    });
    h.shell.dispatch(hello);
    h.timers.at(-1)?.();
    await settle();
    const done = h.journal.find((e) => e.type === "act.done" && e.act.kind === "feel");
    expect(done).toBeDefined();
    expect(done).not.toHaveProperty("valence");
  });
});
