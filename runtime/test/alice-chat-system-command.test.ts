/**
 * chat-client 工具函数测试。
 *
 * ADR-238: 移除了 rejectExtraArgs 测试（citty 原生处理多余参数）。
 */

import { describe, expect, it } from "vitest";
import { parseMsgId, resolveTarget } from "../src/system/chat-client.js";

describe("resolveTarget", () => {
  it("resolves @ID prefix", async () => {
    expect(await resolveTarget("@1000000002")).toBe(1000000002);
  });

  it("resolves ~ID prefix (backward compat)", async () => {
    expect(await resolveTarget("~1000000002")).toBe(1000000002);
  });

  it("resolves bare number", async () => {
    expect(await resolveTarget("123")).toBe(123);
  });

  it("resolves current-chat aliases via ALICE_CTX_TARGET_CHAT", async () => {
    const previous = process.env.ALICE_CTX_TARGET_CHAT;
    process.env.ALICE_CTX_TARGET_CHAT = "456";

    try {
      await expect(resolveTarget("0")).resolves.toBe(456);
      await expect(resolveTarget("me")).resolves.toBe(456);
      await expect(resolveTarget("@me")).resolves.toBe(456);
      await expect(resolveTarget("~me")).resolves.toBe(456);
      await expect(resolveTarget("current")).resolves.toBe(456);
      await expect(resolveTarget("here")).resolves.toBe(456);
      await expect(resolveTarget("this")).resolves.toBe(456);
    } finally {
      if (previous == null) {
        delete process.env.ALICE_CTX_TARGET_CHAT;
      } else {
        process.env.ALICE_CTX_TARGET_CHAT = previous;
      }
    }
  });

  it("throws when no target provided", async () => {
    await expect(resolveTarget()).rejects.toThrow("missing target");
  });

  it("throws on invalid target (non-number name not in graph)", async () => {
    await expect(resolveTarget("not-a-number")).rejects.toThrow('invalid target: "not-a-number"');
  });
});

describe("parseMsgId", () => {
  it("parses bare number", () => {
    expect(parseMsgId("5791")).toBe(5791);
  });

  it("tolerates # prefix", () => {
    expect(parseMsgId("#5791")).toBe(5791);
  });

  it("throws on invalid input", () => {
    expect(() => parseMsgId("abc")).toThrow("invalid message ID");
  });

  it("rejects fake latest aliases", () => {
    expect(() => parseMsgId("#latest")).toThrow("never latest");
  });
});
