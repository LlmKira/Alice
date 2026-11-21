/**
 * 候选 phone（拿起手机，mechanisms/pressure/phone.ts；PLAN 第 51 件）坏掉了会很糟的几条：
 * - 手机放着时，没人找她的会话不叫醒她（生产里节律每隔 Δt 就跨所有会话叫醒她一次：这条在生产上是红的）；
 * - 拿起手机以后照常看；放下的时刻是最后一件事之后 SESSION_GAP；她聊着的会话里有人接着说，手机就还在手上；
 * - 有人找她（点名、私聊）照旧叫醒她，和生产一样；她看过没回、还在 SOLICITED_FOR 之内，节律也还看得见那里；
 * - 焦点：手上有聊着的会话时，节律看不见别的没人找她的会话；刚拿起、哪里都没在聊时看得见；
 * - 一个月空跑：拿起的次数对得上 PICKUP_MEAN；睡着时不拿起；
 * - 加了 pickup 这个随机数键，原来几个键抽到的数不变（已有的回放逐字节相同）。
 */
import { describe, expect, it } from "vitest";
import { PRODUCTION, willOf, worldFold } from "../src/mechanisms/pressure/index.js";
import {
  drawPickup,
  emptyPhone,
  online,
  type PhoneState,
  PICKUP_MEAN,
  phone,
  SESSION_GAP,
} from "../src/mechanisms/pressure/phone.js";
import { awakeBetween, isAsleep } from "../src/mechanisms/pressure/sleep.js";
import type { World } from "../src/mechanisms/pressure/world.js";
import { emptyWorld } from "../src/mechanisms/pressure/world.js";
import type { AliceEvent, MessageReceived, MessageSent, NoiseDrawn } from "../src/mind/events.js";
import { MAIN_NOISE_KEYS, NOISE_EVERY_MS } from "../src/mind/noise.js";
import { noiseSource } from "../src/noise-source.js";
import { replay } from "../src/sim/replay.js";
import { arms } from "../src/sim/will-arms.js";

/** 当地（UTC+8）下午两点多：她醒着。 */
const T0 = 1_771_000_000_000 - 10 * 3_600_000;
const S = 1000;
const M = 60 * S;
const A = "telegram:-7";
const B = "telegram:-8";

let n = 0;
function msg(at: number, o: Partial<MessageReceived> = {}): MessageReceived {
  n++;
  return {
    type: "message.received",
    at,
    scope: A,
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
const sent = (at: number, scope = A): MessageSent => ({
  type: "message.sent",
  at,
  scope,
  messageId: `s${++n}`,
  text: "嗯",
  kind: "text",
});
/** pickup 的正态数：很小时这一格一定拿起（均匀数落在格子开头）。 */
const draw = (at: number, pickup: number): NoiseDrawn => ({
  type: "noise.drawn",
  at,
  scope: "self",
  draws: { pickup },
});

/** 群里别人聊了 40 分钟，每 30 秒一条，没人找她。 */
const chatter = (from = T0, scope = A): MessageReceived[] =>
  Array.from({ length: 80 }, (_, i) => msg(from + i * 30 * S, { scope }));

const all = arms({});
const list = (arm: string) => all[arm] as NonNullable<(typeof all)[string]>;

async function calls(arm: string, events: readonly AliceEvent[]) {
  const out: Array<{ scope: string; at: number; trigger: string | null }> = [];
  await replay(events, {
    mechanisms: list(arm),
    tickMs: 10_000,
    speech: (request, _id, at) => {
      out.push({ scope: request.scope, at: at ?? 0, trigger: request.triggerMessageId });
      return { acts: [] };
    },
  });
  return out;
}

const sorted = (events: AliceEvent[]) => [...events].sort((a, b) => a.at - b.at);

describe(
  "phone: she sees unsought chats only while she holds her phone",
  { timeout: 15_000 },
  () => {
    it("phone: chatter nobody aimed at her does not call her while the phone is down", async () => {
      expect(await calls("phone", chatter())).toEqual([]);
    });

    // 生产的缺陷（PLAN 第 51 件）：节律每隔 Δt 跨所有会话排一次序，她醒着的整天都在看手机。
    it.fails("production: the same chatter calls her again and again (the defect)", async () => {
      expect(await calls("production", chatter())).toEqual([]);
    });

    it("after a pickup she looks, and puts the phone down SESSION_GAP after the last thing", async () => {
      const got = await calls("phone", sorted([...chatter(), draw(T0 + 10 * M, -5)]));
      expect(got.length).toBeGreaterThan(0);
      expect(got.every((c) => c.at >= T0 + 10 * M && c.at <= T0 + 10 * M + SESSION_GAP)).toBe(true);
    });

    it("someone seeking her reaches her exactly as in production", async () => {
      const mention = msg(T0 + 20 * M + 5 * S, { directed: true, text: "爱丽丝你怎么看" });
      const events = sorted([...chatter(), mention]);
      const triggered = async (arm: string) =>
        (await calls(arm, events)).filter((c) => c.trigger === mention.messageId).map((c) => c.at);
      const prod = await triggered("production");
      expect(prod.length).toBeGreaterThan(0);
      expect(await triggered("phone")).toEqual(prod);
    });
  },
);

describe("phone: the fold", () => {
  const fold = worldFold({ ...PRODUCTION, phone });
  const run = (events: AliceEvent[]): World => events.reduce(fold, emptyWorld);
  const phoneOf = (w: World): PhoneState => w.phone ?? emptyPhone;

  it("a reply in the conversation she is in keeps the phone up; silence puts it down", () => {
    const t = T0 + 30 * M;
    const w1 = run([msg(t - 2 * M), sent(t), msg(t + 30 * S)]);
    expect(online(phoneOf(w1), t + 30 * S + SESSION_GAP - S)).toBe(true);
    expect(online(phoneOf(w1), t + 30 * S + SESSION_GAP + S)).toBe(false);
  });

  it("focus: while she is talking in one group, another group's chatter is out of sight; fresh off a pickup it is in sight", () => {
    const t = T0 + 30 * M;
    const policy = willOf({ ...PRODUCTION, phone });
    const talkingInA = run(sorted([...chatter(T0, B), msg(t - M), sent(t), msg(t + 30 * S)]));
    expect(policy.visible(talkingInA, A, t + M)).toBe(true);
    expect(policy.visible(talkingInA, B, t + M)).toBe(false);
    const picked = run(sorted([...chatter(T0, B), draw(t, -5)]));
    expect(policy.visible(picked, B, t + M)).toBe(true);
  });

  it("a mention she looked at but did not answer stays in sight while the phone is down", () => {
    const t = T0 + 30 * M;
    const w = run([
      msg(t, { directed: true }),
      { type: "speech.decided", at: t + 10 * S, scope: A, callId: "c1", decision: { acts: [] } },
    ]);
    const policy = willOf({ ...PRODUCTION, phone });
    const later = t + 3 * SESSION_GAP;
    expect(online(w.phone, later)).toBe(false);
    expect(policy.visible(w, A, later)).toBe(true);
  });
});

describe("phone: pickups", () => {
  it("no pickup while asleep, none while the phone is already up", () => {
    let night = T0;
    while (!isAsleep(night)) night += 10 * M;
    expect(drawPickup(emptyPhone, night, -5)).toBe(0);
    const up: PhoneState = { ...emptyPhone, activeAt: T0 };
    expect(drawPickup(up, T0 + M, -5)).toBe(0);
    expect(drawPickup(emptyPhone, T0, -5)).toBeGreaterThanOrEqual(T0);
    expect(drawPickup(emptyPhone, T0, 5)).toBe(0);
  });

  it("a month with nobody around: pickups match PICKUP_MEAN over her waking time", () => {
    const fold = worldFold({ phone });
    const source = noiseSource(11);
    let w = emptyWorld;
    const days = 30;
    for (let at = T0; at < T0 + days * 24 * 60 * M; at += NOISE_EVERY_MS) {
      w = fold(w, { type: "noise.drawn", at, scope: "self", draws: source() });
    }
    const awake = awakeBetween(T0, T0 + days * 24 * 60 * M);
    // 一次拿起之后 SESSION_GAP 里手机在手上、不再抽；之后才是下一段等待。
    const expected = awake / (PICKUP_MEAN + SESSION_GAP);
    const got = w.phone?.pickups ?? 0;
    expect(Math.abs(got - expected) / expected).toBeLessThan(0.15);
  });
});

describe("phone: the record", () => {
  it("adding the pickup key leaves the earlier keys' draws unchanged", () => {
    // 加 pickup 之前的 noiseSource（主流按 MAIN_NOISE_KEYS 的次序抽）。
    const old = (seed: number) => {
      let s = seed >>> 0;
      const uniform = () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return (((t ^ (t >>> 14)) >>> 0) + 1) / 4294967297;
      };
      const normal = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
      return () => Object.fromEntries(MAIN_NOISE_KEYS.map((k) => [k, normal()]));
    };
    const a = old(20261111);
    const b = noiseSource(20261111);
    for (let i = 0; i < 50; i++) {
      const x = a();
      const y = b();
      for (const k of MAIN_NOISE_KEYS) expect(y[k]).toBe(x[k]);
      expect(Number.isFinite(y.pickup)).toBe(true);
    }
  });
});
