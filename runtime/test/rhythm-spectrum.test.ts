import { describe, expect, it } from "vitest";
import {
  buildRhythmProfile,
  type RhythmEvent,
  renderTimingLine,
} from "../src/diagnostics/rhythm-spectrum.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const START_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

describe("ADR-261 rhythm spectrum", () => {
  it("从合成 24h 信号恢复晚间活跃窗口", () => {
    const events = dailyEvents(45, [21, 22, 23]);
    const nowMs = START_MS + 45 * DAY_MS + 22 * HOUR_MS;

    const profile = buildRhythmProfile(events, {
      entityId: "contact:bob",
      entityType: "contact",
      nowMs,
      windowStartMs: START_MS,
      windowEndMs: START_MS + 45 * DAY_MS,
    });

    expect(profile.confidence).not.toBe("low");
    expect(profile.activeNowScore).toBeGreaterThan(0.7);
    expect(profile.peakWindows.some((w) => includesHour(w, 22))).toBe(true);
  });

  it("识别 12h 双峰，而不是压成单个峰值", () => {
    const events = dailyEvents(45, [9, 10, 21, 22]);
    const nowMs = START_MS + 45 * DAY_MS + 9 * HOUR_MS;

    const profile = buildRhythmProfile(events, {
      entityId: "channel:group",
      entityType: "channel",
      nowMs,
      windowStartMs: START_MS,
      windowEndMs: START_MS + 45 * DAY_MS,
    });

    expect(profile.confidence).not.toBe("low");
    expect(profile.diagnostics.halfDailyStrength).toBeGreaterThan(0.1);
    expect(profile.peakWindows.some((w) => includesHour(w, 9))).toBe(true);
    expect(profile.peakWindows.some((w) => includesHour(w, 21))).toBe(true);
  });

  it("样本不足时返回 low confidence，不制造假节律", () => {
    const events = dailyEvents(3, [22]);
    const profile = buildRhythmProfile(events, {
      entityId: "contact:new",
      entityType: "contact",
      nowMs: START_MS + 3 * DAY_MS,
      windowStartMs: START_MS,
      windowEndMs: START_MS + 3 * DAY_MS,
    });

    expect(profile.confidence).toBe("low");
    expect(renderTimingLine(profile, "New contact")).toBeNull();
  });

  it("真实覆盖不足 21 天时禁用 168h 周期项", () => {
    const events = dailyEvents(4, [21, 22, 23]);
    const profile = buildRhythmProfile(events, {
      entityId: "contact:short",
      entityType: "contact",
      nowMs: START_MS + 4 * DAY_MS + 22 * HOUR_MS,
      windowEndMs: START_MS + 4 * DAY_MS,
    });

    expect(profile.observedDays).toBe(4);
    expect(profile.activeBucketCount).toBe(12);
    expect(profile.enabledPeriodsHours).toEqual([24, 12]);
    expect(profile.diagnostics.weeklyStrength).toBe(0);
  });

  it("本地时区用于窗口投影和人话输出", () => {
    const events = dailyEvents(30, [12, 13]);
    const profile = buildRhythmProfile(events, {
      entityId: "contact:tz",
      entityType: "contact",
      nowMs: START_MS + 30 * DAY_MS + 12 * HOUR_MS,
      windowEndMs: START_MS + 30 * DAY_MS,
      timezoneOffsetHours: 9,
    });

    const line = renderTimingLine(profile, "Mika");

    expect(profile.timezoneOffsetHours).toBe(9);
    expect(profile.peakWindows.some((w) => includesHour(w, 21))).toBe(true);
    expect(line).toContain("本地");
  });

  it("均匀噪声不生成高置信 active/quiet 投影", () => {
    const events = dailyEvents(
      30,
      Array.from({ length: 24 }, (_, h) => h),
    );
    const profile = buildRhythmProfile(events, {
      entityId: "channel:flat",
      entityType: "channel",
      nowMs: START_MS + 30 * DAY_MS + 12 * HOUR_MS,
      windowStartMs: START_MS,
      windowEndMs: START_MS + 30 * DAY_MS,
    });

    expect(profile.confidence).toBe("low");
    expect(renderTimingLine(profile, "Flat group")).toBeNull();
  });

  it("prompt projection 只输出人话，不泄漏 harmonic 参数", () => {
    const events = dailyEvents(45, [21, 22, 23]);
    const profile = buildRhythmProfile(events, {
      entityId: "contact:bob",
      entityType: "contact",
      nowMs: START_MS + 45 * DAY_MS + 22 * HOUR_MS,
      windowStartMs: START_MS,
      windowEndMs: START_MS + 45 * DAY_MS,
    });

    const line = renderTimingLine(profile, "Bob");

    expect(line).toContain("Bob");
    expect(line).not.toMatch(/phase|amplitude|a24|b24|sin|cos/i);
  });
});

function dailyEvents(days: number, activeHours: number[]): RhythmEvent[] {
  const events: RhythmEvent[] = [];
  for (let day = 0; day < days; day++) {
    for (const hour of activeHours) {
      events.push({
        entityId: "entity",
        entityType: "contact",
        occurredAtMs: START_MS + day * DAY_MS + hour * HOUR_MS,
      });
    }
  }
  return events;
}

function includesHour(window: { startHour: number; endHour: number }, hour: number): boolean {
  if (window.startHour <= window.endHour) {
    return hour >= window.startHour && hour < window.endHour;
  }
  return hour >= window.startHour || hour < window.endHour;
}
