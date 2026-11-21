import { describe, expect, it } from "vitest";
import { effectiveObligation, wallClock } from "../src/mechanisms/pressure/drives.js";
import { willOf } from "../src/mechanisms/pressure/index.js";
import {
  awakeBetween,
  isAsleep,
  SLEEP_WINDOW,
  sleepDepth,
  sleep as sleepFeature,
} from "../src/mechanisms/pressure/sleep.js";
import { globalReading, intentionsFor } from "../src/mechanisms/pressure/will.js";
import { emptyWorld, reduceWorld, type World } from "../src/mechanisms/pressure/world.js";
import { affordances } from "../src/mind/affordances.js";
import type { AliceEvent, MessageReceived } from "../src/mind/events.js";

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
/** 2026-02-20 本地（东八区）0 点。 */
const MIDNIGHT = Date.UTC(2026, 1, 19, 16);
const local = (h: number, m = 0) => MIDNIGHT + h * H + m * MIN;
const DM = "telegram:1";

function dm(at: number): MessageReceived {
  return {
    type: "message.received",
    at,
    scope: DM,
    chatType: "private",
    messageId: `m${at}`,
    senderId: "contact:1",
    senderName: "A",
    text: "在吗",
    contentType: "text",
    replyToMessageId: null,
    directed: true,
  };
}
const fold = (events: AliceEvent[], from: World = emptyWorld): World =>
  events.reduce((w, e) => reduceWorld(w, e), from);
const deliberate = affordances.filter((a) => a.deliberate);
const best = (w: World, at: number, sleep: boolean) =>
  Math.max(
    ...intentionsFor(w, deliberate, DM, at, {
      ...willOf(sleep ? { sleep: sleepFeature } : {}),
      tiers: () => 5,
    }).map((i) => i.nsv),
  );
/** 她和这个人前一天聊过（关系是热的），之后对方深夜又来一条。 */
const history = fold([
  dm(local(-10)),
  { type: "message.sent", at: local(-10, 1), scope: DM, messageId: "s1", text: "嗯", kind: "text" },
]);

describe("her own sleep (two-process model)", () => {
  it("sleeps about eight hours a night, centred near 5:30 local", () => {
    const { onset, wake } = SLEEP_WINDOW;
    const length = (wake - onset + 1440) % 1440;
    const mid = (onset + length / 2) % 1440;
    expect(length / 60).toBeGreaterThan(7);
    expect(length / 60).toBeLessThan(9);
    expect(Math.abs(mid - 330)).toBeLessThan(30);
    expect(isAsleep(local(4))).toBe(true);
    expect(isAsleep(local(15))).toBe(false);
    expect(sleepDepth(local(2))).toBeGreaterThan(sleepDepth(local(8)));
  });

  it("lets time pass for what she has not seen only while she is awake", () => {
    expect(awakeBetween(local(3), local(4))).toBe(0);
    expect(awakeBetween(local(12), local(13))).toBe(H);
    const day = awakeBetween(local(12), local(12) + DAY);
    expect(day / H).toBeGreaterThan(15);
    expect(day / H).toBeLessThan(17);
  });

  it("is not woken by one message deep in the night, but can be in the last stretch before waking", () => {
    const { wake } = SLEEP_WINDOW;
    const night = fold([dm(local(3))], history);
    expect(best(night, local(3, 1), true)).toBeLessThan(0);
    const late = local(0, wake - 20);
    expect(best(fold([dm(late)], history), late + MIN, true)).toBeGreaterThan(0);
    // without sleep the same message wakes her at 3am
    expect(best(night, local(3, 1), false)).toBeGreaterThan(0);
  });

  it("lets the rhythm see the night's message as fresh when she wakes, not only the will", () => {
    const { wake } = SLEEP_WINDOW;
    const night = fold([dm(local(3))], history);
    const day = fold([dm(local(15))], history);
    const up = local(0, wake);
    const peak = (w: World, at: number, age = awakeBetween) =>
      globalReading(w, at, () => 5, age).demandPeak;
    const fresh = peak(day, local(15));
    expect(Math.abs(peak(night, up) - fresh)).toBeLessThan(0.1 * fresh);
    expect(peak(night, up, wallClock)).toBeLessThan(0.8 * fresh);
  });

  it("still owes the night's message when she wakes up", () => {
    const { wake } = SLEEP_WINDOW;
    const night = fold([dm(local(3))], history);
    const up = local(0, wake + 10);
    const node = night.chats[DM];
    if (!node) throw new Error("no chat");
    expect(effectiveObligation(node, up, awakeBetween)).toBeGreaterThan(0.8);
    expect(effectiveObligation(node, up)).toBeLessThan(0.05);
    expect(best(night, up, true)).toBeGreaterThan(0);
  });
});
