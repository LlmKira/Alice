import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AliceEvent } from "../src/mind/events.js";
import { parse, replayEvents } from "../src/sim/will-replay.js";

const T0 = Date.parse("2026-11-13T00:00:00+08:00");
const msg = (at: number, id: string): AliceEvent => ({
  type: "message.received",
  at,
  scope: "telegram:1",
  chatType: "private",
  messageId: id,
  senderId: "u1",
  senderName: "A",
  text: "hi",
  contentType: "text",
  replyToMessageId: null,
  directed: true,
});
const drawn: AliceEvent = {
  type: "noise.drawn",
  at: T0 + 60_000,
  scope: "self",
  draws: { life: 2 },
};

describe("will-replay --journal-noise", () => {
  it("replays the shell's own noise.drawn from the dataset instead of the seeded noise", () => {
    const dir = mkdtempSync(join(tmpdir(), "alice-will-replay-"));
    try {
      const dataset = join(dir, "events.jsonl");
      const events = [msg(T0, "1"), drawn, msg(T0 + 20 * 60_000, "2")];
      writeFileSync(dataset, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
      const noise = (argv: string[]) =>
        replayEvents(parse([dataset, dir, "production", ...argv])).filter(
          (e) => e.type === "noise.drawn",
        );
      expect(noise(["--journal-noise"])).toEqual([drawn]);
      const seeded = noise([]);
      expect(seeded.length).toBeGreaterThan(1);
      expect(seeded).not.toContainEqual(drawn);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
