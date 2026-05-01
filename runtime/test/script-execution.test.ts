import { describe, expect, it } from "vitest";
import { hasCompletedSend } from "../src/core/script-execution.js";

describe("hasCompletedSend", () => {
  it("counts outbound media actions as sent messages", () => {
    expect(hasCompletedSend({ completedActions: ["voice:chatId=1:msgId=2"] })).toBe(true);
    expect(hasCompletedSend({ completedActions: ["sticker:chatId=1:msgId=3"] })).toBe(true);
    expect(hasCompletedSend({ completedActions: ["react:chatId=1:msgId=3"] })).toBe(true);
    expect(hasCompletedSend({ completedActions: ["sent-file:chatId=1:msgId=4"] })).toBe(true);
  });

  it("does not count read-only actions as sent messages", () => {
    expect(hasCompletedSend({ completedActions: ["read:chatId=1"] })).toBe(false);
  });

  it("does not infer delivery from human-readable CLI confirmations", () => {
    expect(hasCompletedSend({ completedActions: [] })).toBe(false);
  });
});
