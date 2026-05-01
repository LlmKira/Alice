import { describe, expect, it } from "vitest";
import {
  classifyTelegramActionFailure,
  isTelegramActionError,
  rethrowTelegramActionFailure,
  TelegramActionError,
} from "../src/telegram/errors.js";

describe("TelegramActionError", () => {
  it("carries a typed Telegram action error code", () => {
    const error = new TelegramActionError(
      "voice_messages_forbidden",
      "telegram target forbids voice messages",
    );

    expect(isTelegramActionError(error)).toBe(true);
    expect(error.code).toBe("voice_messages_forbidden");
  });

  it("does not classify plain Telegram error text as typed", () => {
    expect(
      isTelegramActionError(
        new Error("RpcError (400 VOICE_MESSAGES_FORBIDDEN): privacy settings forbid voice"),
      ),
    ).toBe(false);
  });

  it("classifies mtcute local peer invalid as soft permanent", () => {
    expect(classifyTelegramActionFailure(new Error("The provided peer id is invalid."))).toBe(
      "telegram_soft_permanent",
    );
  });

  it("rethrows classified Telegram failures as typed action errors", () => {
    expect(() =>
      rethrowTelegramActionFailure(new Error("The provided peer id is invalid."), "send_text", {
        chatId: "5936910995",
      }),
    ).toThrowError(TelegramActionError);

    try {
      rethrowTelegramActionFailure(new Error("The provided peer id is invalid."), "send_text", {
        chatId: "5936910995",
      });
    } catch (error) {
      expect(isTelegramActionError(error)).toBe(true);
      if (isTelegramActionError(error)) {
        expect(error.code).toBe("telegram_soft_permanent");
        expect(error.details?.chatId).toBe("5936910995");
      }
    }
  });

  it("leaves unrelated errors unclassified", () => {
    expect(classifyTelegramActionFailure(new Error("database is locked"))).toBeNull();
  });
});
