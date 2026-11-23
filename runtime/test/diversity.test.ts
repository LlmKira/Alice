import { describe, expect, it } from "vitest";
import {
  GROUP_SILENT,
  palette,
  paletteComposite,
  paletteDiverse,
  REGISTERS,
} from "../src/mechanisms/palette.js";
import { POOL_DIVERSE } from "../src/mechanisms/palette-pool.js";
import { echoText } from "../src/mechanisms/pressure/diary.js";
import { echoExpanded, thought } from "../src/mechanisms/pressure/index.js";
import { emptyWorld } from "../src/mechanisms/pressure/world.js";
import {
  type RoomState,
  reduceRoom,
  roomVoice,
  roomVoiceRotated,
} from "../src/mechanisms/room-voice.js";
import type { ActKind } from "../src/mind/affordances.js";
import type { AliceEvent } from "../src/mind/events.js";
import { type ChatState, emptyChat, type TimelineEntry } from "../src/mind/state.js";
import { renderSpeechPrompt } from "../src/speech/prompt.js";

const T0 = 1_771_000_000_000;
const MIN = 60_000;
const OFFERED: ActKind[] = ["send", "sticker", "react", "think"];

const line = (at: number, text: string): TimelineEntry => ({
  at,
  messageId: String(at),
  sender: { id: "u1", name: "A" },
  text,
  contentType: "text",
  replyToMessageId: null,
});

describe("diversity candidates", () => {
  it("POOL_DIVERSE covers every register with >= 4 group examples", () => {
    for (const r of REGISTERS) {
      const grp = POOL_DIVERSE.filter((e) => e.chat === "group" && e.register === r);
      expect(grp.length, r).toBeGreaterThanOrEqual(4);
    }
  });

  it("paletteDiverse rotates across consecutive calls in the same day", () => {
    const scope = "telegram:-1000000000042";
    const c1: ChatState = { ...emptyChat(scope, "group", true), calls: 1 };
    const c2: ChatState = { ...emptyChat(scope, "group", true), calls: 2 };
    const p1 = palette.contribute?.(c1, T0, undefined, OFFERED)[0]?.examples ?? [];
    const p2 = palette.contribute?.(c2, T0 + 5 * MIN, undefined, OFFERED)[0]?.examples ?? [];
    expect(p1.map((e) => e.scene)).toEqual(p2.map((e) => e.scene));

    const d1 = paletteDiverse.contribute?.(c1, T0, undefined, OFFERED)[0]?.examples ?? [];
    const d2 = paletteDiverse.contribute?.(c2, T0 + 5 * MIN, undefined, OFFERED)[0]?.examples ?? [];
    expect(d1.map((e) => e.scene)).not.toEqual(d2.map((e) => e.scene));
  });

  it("paletteComposite drops scripted speaking examples in active groups while keeping GROUP_SILENT", () => {
    const timeline = Array.from({ length: 12 }, (_, i) => line(T0 + i * 1000, `msg ${i}`));
    const activeGroup: ChatState = { ...emptyChat("telegram:-1", "group", true), timeline };
    const ex =
      paletteComposite.contribute?.(activeGroup, T0 + 20_000, undefined, OFFERED)[0]?.examples ??
      [];
    expect(ex).toHaveLength(GROUP_SILENT.length);
    for (const e of ex) {
      expect(GROUP_SILENT.some((s) => s.scene === e.scene)).toBe(true);
    }
    // Cold-start group still keeps speaking examples.
    const coldGroup: ChatState = {
      ...emptyChat("telegram:-1", "group", true),
      timeline: timeline.slice(0, 3),
    };
    const coldEx =
      paletteComposite.contribute?.(coldGroup, T0 + 20_000, undefined, OFFERED)[0]?.examples ?? [];
    expect(coldEx.length).toBeGreaterThan(GROUP_SILENT.length);
  });

  it("roomVoiceRotated rotates peer exchanges across calls on the same day", () => {
    const scope = "telegram:-100";
    const evs: AliceEvent[] = [];
    for (let i = 0; i < 90; i++) {
      const sender = `u${i % 6}`;
      evs.push({
        type: "message.received",
        at: T0 + i * 10_000,
        scope,
        chatType: "group",
        messageId: `m${i}`,
        senderId: sender,
        senderName: `User${i % 6}`,
        text: `сообщение номер ${i} длинное достаточно для фильтра`,
        contentType: "text",
        replyToMessageId: i >= 1 && (i % 6 === 1 || i % 6 === 2) ? `m${i - 1}` : null,
        directed: false,
      });
    }
    const state = evs.reduce<RoomState>(reduceRoom, roomVoice.initial as RoomState);
    const c1: ChatState = { ...emptyChat(scope, "group", true), calls: 1 };
    const c2: ChatState = { ...emptyChat(scope, "group", true), calls: 2 };
    const r1 = roomVoiceRotated.contribute?.(c1, T0 + 1_000_000, state, OFFERED)[0]?.text ?? "";
    const r2 = roomVoiceRotated.contribute?.(c2, T0 + 1_000_000, state, OFFERED)[0]?.text ?? "";
    expect(r1).not.toEqual(r2);
  });

  it("echoExpanded looks back 6 hours and flags repeated opening starters objectively", () => {
    const scope = "telegram:-1";
    const said = [
      { at: T0, scope, text: "谁家半夜还发这个" },
      { at: T0 + 2 * 3_600_000, scope, text: "谁家把咖啡喝成这样" },
      { at: T0 + 2.5 * 3_600_000, scope, text: "今天天气挺凉快" },
    ];
    const now = T0 + 3 * 3_600_000;
    const out = echoText(said, scope, now, {
      lookback: 6 * 3_600_000,
      max: 12,
      detectStarters: true,
    });
    expect(out).toContain("重复起手：「谁家」2 次");
    const w = { ...emptyWorld, said };
    expect(
      echoExpanded.contribute?.({
        world: w,
        chat: emptyChat(scope, "group", true),
        now,
        sought: true,
        outside: false,
        offered: OFFERED,
      })[0]?.text,
    ).toContain("谁家");
  });

  it("Verbalized Sampling decisionStyle 'vs' and divergent thought render cleanly without altering default", () => {
    const plain = thought({ examples: true, carry: true });
    const t = thought({ examples: true, carry: true, divergent: true });
    const ctx = {
      world: emptyWorld,
      chat: emptyChat("telegram:-1", "group", true),
      now: T0,
      sought: true,
      outside: false,
      offered: OFFERED,
    } as never;
    const baseReq = (contributions: ReturnType<NonNullable<typeof t.contribute>>) => ({
      scope: "telegram:-1",
      chatType: "group" as const,
      timeline: [],
      contributions,
      triggerMessageId: null,
      at: T0,
      affordances: OFFERED,
    });
    const def = renderSpeechPrompt("persona", baseReq(plain.contribute?.(ctx) ?? []));
    const autoVs = renderSpeechPrompt("persona", baseReq(t.contribute?.(ctx) ?? []));
    const explicitVs = renderSpeechPrompt("persona", baseReq(plain.contribute?.(ctx) ?? []), {
      decisionStyle: "vs",
    });
    expect(def.system).not.toContain("2-3 different first reactions");
    expect(autoVs.system).toContain("2-3 different first reactions");
    expect(explicitVs.system).toContain("2-3 different first reactions");
  });
});
