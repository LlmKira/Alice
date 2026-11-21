import { describe, expect, it } from "vitest";
import {
  type Example,
  GROUP_SPEAKING,
  palette,
  REGISTERS,
  said,
} from "../src/mechanisms/palette.js";
import { POOL, RARE } from "../src/mechanisms/palette-pool.js";
import type { Act, ActKind } from "../src/mind/affordances.js";
import type { ChatType } from "../src/mind/events.js";
import type { Mechanism } from "../src/mind/mechanism.js";
import { type ChatState, emptyChat, type TimelineEntry } from "../src/mind/state.js";

const T0 = 1_771_000_000_000;
const DAY = 24 * 60 * 60_000;

const line = (at: number, text: string, mine = false): TimelineEntry => ({
  at,
  messageId: String(at),
  sender: mine ? null : { id: "contact:1", name: "A" },
  text,
  contentType: "text",
  replyToMessageId: null,
});

function chat(scope: string, chatType: ChatType, timeline: TimelineEntry[] = []): ChatState {
  return { ...emptyChat(scope, chatType, true), timeline };
}

function shown(m: Mechanism, c: ChatState, now: number) {
  const [out] = m.contribute?.(c, now, m.initial, ["send", "sticker", "react"]) ?? [];
  return out?.examples ?? [];
}

const replies = (acts: Act[]) => acts.flatMap((a) => (a.kind === "send" ? [a.text] : []));
const registerOf = (scene: string) => POOL.find((e) => e.scene === scene)?.register;
/** 一套示例在私聊里有的口气：每一种都要出现一次。 */
const privateRegisters = (pool: readonly Example[]) =>
  REGISTERS.filter((r) => pool.some((e) => e.chat === "private" && e.register === r));

describe("palette", () => {
  it("shows every register of its pool once in private chats, whatever the day or chat", () => {
    for (let d = 0; d < 7; d++) {
      for (const scope of ["telegram:1", "telegram:2"]) {
        const regs = shown(palette, chat(scope, "private"), T0 + d * DAY).map((e) =>
          registerOf(e.scene),
        );
        expect([...regs].sort()).toEqual([...privateRegisters(POOL)].sort());
      }
    }
  });

  it("keeps groups half silent or light and never repeats a register among the spoken ones", () => {
    const ex = shown(palette, chat("telegram:-1", "group"), T0);
    const spoken = ex.filter((e) => replies(e.acts).length > 0);
    expect(ex.length - spoken.length).toBe(GROUP_SPEAKING);
    expect(new Set(spoken.map((e) => registerOf(e.scene))).size).toBe(GROUP_SPEAKING);
  });

  it("never turns her own past lines into examples", () => {
    // 她自己说过的话在记录里，示例只来自 palette-pool.ts 和群里沉默、轻回应的那几条。
    const c = chat("telegram:1", "private", [line(T0, "我才没有委屈呢", true)]);
    const texts = shown(palette, c, T0 + DAY).flatMap((e) => replies(e.acts));
    expect(texts).not.toContain("我才没有委屈呢");
    for (const t of texts) expect(POOL.some((e) => said(e.acts).includes(t))).toBe(true);
  });

  it("shows the examples of a rarely used act only in the turns that offer it, in both chats", () => {
    const rare = (offered: ActKind[], c: ChatState) =>
      (palette.contribute?.(c, T0, palette.initial, offered)[0]?.examples ?? []).filter((e) =>
        RARE.some((r) => r.scene === e.scene),
      );
    const kinds = (offered: ActKind[], c: ChatState) =>
      new Set(rare(offered, c).flatMap((e) => e.acts.map((a) => a.kind)));
    for (const c of [chat("telegram:1", "private"), chat("telegram:-1", "group")]) {
      expect(rare(["send", "sticker", "react"], c)).toEqual([]);
      expect(rare(["send", "voice"], c)).toHaveLength(2);
      expect([...kinds(["send", "repeat"], c)]).toEqual(["repeat"]);
      expect(kinds(["send", "edit"], c).has("edit")).toBe(true);
      expect(kinds(["send", "edit"], c).has("repeat")).toBe(false);
      const all: ActKind[] = [
        "send",
        "voice",
        "edit",
        "repeat",
        "let-go",
        "album-search",
        "chat-search",
        "intend",
      ];
      expect(rare(all, c)).toHaveLength(RARE.length);
      expect(rare(["send", "album-search"], c).every((e) => e.code?.includes("send_photo"))).toBe(
        true,
      );
      expect(rare(["send", "chat-search"], c).some((e) => e.code?.includes("find_chats"))).toBe(
        true,
      );
    }
  });
});
