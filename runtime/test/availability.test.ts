import { describe, expect, it } from "vitest";
import {
  availability,
  noteActivity,
  PRIOR_G,
  worldG,
} from "../src/mechanisms/pressure/availability.js";
import { awake, createPressure, PRODUCTION } from "../src/mechanisms/pressure/index.js";
import { emptyWorld, type World } from "../src/mechanisms/pressure/world.js";
import { affordances } from "../src/mind/affordances.js";
import type { AliceEvent, MessageReceived } from "../src/mind/events.js";
import { localHour } from "../src/mind/when.js";

const H = 3_600_000;
/** 按组 awake（生产加上世界在线份额）折叠：说话的钟点由它折进世界。 */
const pressureAwake = createPressure(affordances, { ...PRODUCTION, awake });
const reduceWorld = (w: World, e: AliceEvent): World => pressureAwake.reduce?.(w, e) as World;
const D = 24 * H;
/** 东八区 2026-02-21 00:00。 */
const T0 = Date.UTC(2026, 1, 20, 16);

const msg = (at: number, senderId: string): MessageReceived => ({
  type: "message.received",
  at,
  scope: "telegram:-1",
  chatType: "group",
  messageId: `${senderId}-${at}`,
  senderId,
  senderName: senderId,
  text: "hi",
  contentType: "text",
  replyToMessageId: null,
  directed: false,
});

describe("world availability A(h)", () => {
  it("counts each person's active days near h once per day", () => {
    let a = noteActivity(undefined, T0 + 14 * H);
    a = noteActivity(a, T0 + 14 * H + 60_000);
    a = noteActivity(a, T0 + D + 15 * H);
    expect(a.days).toHaveLength(2);
    expect(localHour(T0 + 14 * H)).toBe(14);
  });

  it("is low at night and high in the day when people are only active by day", () => {
    let w = emptyWorld;
    for (let day = 0; day < 6; day++)
      for (const p of ["a", "b", "c"])
        for (const h of [10, 14, 20]) w = reduceWorld(w, msg(T0 + day * D + h * H, p));
    const now = T0 + 6 * D;
    expect(availability(w.activity, w.firstAt, now + 3 * H)).toBeLessThan(
      availability(w.activity, w.firstAt, now + 14 * H),
    );
    expect(availability(w.activity, w.firstAt, now + 14 * H)).toBeGreaterThan(0.9);
    // 已观测日数包含当天（与参考实现一致）：6 天都在场，D = 7。
    expect(worldG(w.activity, w.firstAt, now + 14 * H, 14, null)?.g).toBeCloseTo(6 / 7, 6);
  });

  it("falls back to the prior curve before a day of observation", () => {
    const w = reduceWorld(emptyWorld, msg(T0 + 14 * H, "a"));
    const max = Math.max(...PRIOR_G);
    expect(availability(w.activity, w.firstAt, T0 + 15 * H)).toBeCloseTo(
      (PRIOR_G[15] as number) / max,
      6,
    );
  });
});
