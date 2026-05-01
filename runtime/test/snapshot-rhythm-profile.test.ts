import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, initDb } from "../src/db/connection.js";
import { rhythmProfiles } from "../src/db/schema.js";
import { ALICE_SELF } from "../src/graph/constants.js";
import { WorldModel } from "../src/graph/world-model.js";
import { renderChannel } from "../src/prompt/renderers/channel.js";
import { renderPrivate } from "../src/prompt/renderers/private.js";
import { buildUserPromptSnapshot } from "../src/prompt/snapshot.js";

const NOW_MS = Date.UTC(2026, 3, 25, 22, 0, 0);

describe("snapshot rhythm profile projection", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("把高置信当前联系人节律投成 prompt 人话，不泄漏 harmonic 参数", () => {
    insertProfile({
      entityId: "contact:42",
      entityType: "contact",
      activeNowScore: 0.92,
      quietNowScore: 0.08,
      peakWindowsJson: JSON.stringify([{ startHour: 21, endHour: 23 }]),
      confidence: "high",
    });

    const snapshot = buildUserPromptSnapshot(privateInput());
    const rendered = renderPrivate(snapshot);

    expect(snapshot.timingSignals).toHaveLength(1);
    expect(snapshot.timingSignals?.[0]).toContain("Mika");
    expect(rendered).toContain("## Timing");
    expect(rendered).toContain("活跃窗口");
    expect(rendered).not.toMatch(/phase|amplitude|a24|b24|sin|cos/i);
  });

  it("低置信或 stale projection 不进入 prompt", () => {
    insertProfile({
      entityId: "contact:42",
      entityType: "contact",
      activeNowScore: 0.92,
      quietNowScore: 0.08,
      peakWindowsJson: JSON.stringify([{ startHour: 21, endHour: 23 }]),
      confidence: "low",
    });
    insertProfile({
      entityId: "channel:42",
      entityType: "channel",
      activeNowScore: 0.92,
      quietNowScore: 0.08,
      peakWindowsJson: JSON.stringify([{ startHour: 21, endHour: 23 }]),
      confidence: "high",
      stale: true,
    });

    const snapshot = buildUserPromptSnapshot(privateInput());

    expect(snapshot.timingSignals).toEqual([]);
    expect(renderPrivate(snapshot)).not.toContain("## Timing");
  });

  it("当前私聊最多投两条 timing line", () => {
    insertProfile({
      entityId: "contact:42",
      entityType: "contact",
      activeNowScore: 0.92,
      quietNowScore: 0.08,
      peakWindowsJson: JSON.stringify([{ startHour: 21, endHour: 23 }]),
      confidence: "high",
    });
    insertProfile({
      entityId: "channel:42",
      entityType: "channel",
      activeNowScore: 0.05,
      quietNowScore: 0.95,
      quietWindowsJson: JSON.stringify([{ startHour: 0, endHour: 8 }]),
      confidence: "high",
    });

    const snapshot = buildUserPromptSnapshot(privateInput());

    expect(snapshot.timingSignals).toHaveLength(2);
  });

  it("当前私聊不重复投影语义相同的 contact/channel timing line", () => {
    const sharedWindow = JSON.stringify([{ startHour: 21, endHour: 23 }]);
    insertProfile({
      entityId: "contact:42",
      entityType: "contact",
      activeNowScore: 0.92,
      quietNowScore: 0.08,
      peakWindowsJson: sharedWindow,
      confidence: "high",
    });
    insertProfile({
      entityId: "channel:42",
      entityType: "channel",
      activeNowScore: 0.92,
      quietNowScore: 0.08,
      peakWindowsJson: sharedWindow,
      confidence: "high",
    });

    const snapshot = buildUserPromptSnapshot(privateInput());

    expect(snapshot.timingSignals).toHaveLength(1);
  });

  it("频道场景也显示当前频道节律，而不是被 urgent filter 丢掉", () => {
    insertProfile({
      entityId: "channel:99",
      entityType: "channel",
      activeNowScore: 0.92,
      quietNowScore: 0.08,
      peakWindowsJson: JSON.stringify([{ startHour: 21, endHour: 23 }]),
      confidence: "high",
    });

    const snapshot = buildUserPromptSnapshot(channelInput());
    const rendered = renderChannel(snapshot);

    expect(rendered).toContain("## Timing");
    expect(rendered).toContain("Tech Feed");
    expect(rendered).toContain("活跃窗口");
  });
});

function privateInput(): Parameters<typeof buildUserPromptSnapshot>[0] {
  return {
    G: makePrivateGraph(),
    messages: [],
    observations: [],
    item: { action: "conversation", target: "channel:42", facetId: "core" } as never,
    round: 0,
    board: { maxSteps: 3, contextVars: {} },
    nowMs: NOW_MS,
    timezoneOffset: 9,
    chatType: "private",
    isGroup: false,
    isChannel: false,
  };
}

function channelInput(): Parameters<typeof buildUserPromptSnapshot>[0] {
  return {
    G: makeChannelGraph(),
    messages: [],
    observations: [],
    item: { action: "conversation", target: "channel:99", facetId: "core" } as never,
    round: 0,
    board: { maxSteps: 3, contextVars: {} },
    nowMs: NOW_MS,
    timezoneOffset: 9,
    chatType: "channel",
    isGroup: false,
    isChannel: true,
  };
}

function makePrivateGraph(): WorldModel {
  const G = new WorldModel();
  G.addAgent(ALICE_SELF);
  G.addContact("contact:42", { display_name: "Mika" });
  G.addChannel("channel:42", { chat_type: "private", display_name: "Mika" });
  return G;
}

function makeChannelGraph(): WorldModel {
  const G = new WorldModel();
  G.addAgent(ALICE_SELF);
  G.addChannel("channel:99", { chat_type: "channel", display_name: "Tech Feed" });
  return G;
}

function insertProfile(
  overrides: Partial<typeof rhythmProfiles.$inferInsert> & {
    entityId: string;
    entityType: "contact" | "channel" | "self";
  },
): void {
  getDb()
    .insert(rhythmProfiles)
    .values({
      sourceWindowStartMs: NOW_MS - 30 * 24 * 3_600_000,
      sourceWindowEndMs: NOW_MS,
      sampleCount: 120,
      bucketCount: 720,
      activeBucketCount: 90,
      observedSpanHours: 720,
      observedDays: 30,
      timezoneOffsetHours: 9,
      enabledPeriodsJson: JSON.stringify([24, 12, 168]),
      activeNowScore: 0,
      quietNowScore: 0,
      unusualActivityScore: 0,
      peakWindowsJson: "[]",
      quietWindowsJson: "[]",
      confidence: "medium",
      stale: false,
      diagnosticsJson: JSON.stringify({ r2: 0.5 }),
      updatedAtMs: NOW_MS,
      ...overrides,
    })
    .run();
}
