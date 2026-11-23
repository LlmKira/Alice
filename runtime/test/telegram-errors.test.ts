import { tl } from "@mtcute/node";
import { describe, expect, it } from "vitest";
import {
  classifyTelegramActionFailure,
  isTelegramActionError,
  rethrowTelegramActionFailure,
  TelegramActionError,
} from "../src/telegram/errors.js";

/** 和网络层收到 rpc_error 时构造的是同一个对象。 */
function peerIdInvalid(): Error {
  return tl.RpcError.fromTl({ _: "rpc_error", errorCode: 400, errorMessage: "PEER_ID_INVALID" });
}

describe("TelegramActionError", () => {
  it("does not classify plain Telegram error text as typed", () => {
    expect(
      isTelegramActionError(new Error("RpcError (403 CHAT_WRITE_FORBIDDEN): cannot write")),
    ).toBe(false);
  });

  it("classifies being blocked as a refusal, not just an unreachable peer", () => {
    expect(classifyTelegramActionFailure(new tl.RpcError(400, "USER_IS_BLOCKED"))).toBe("refused");
    expect(classifyTelegramActionFailure(new tl.RpcError(400, "PEER_ID_BLOCKED"))).toBe("refused");
  });

  it("classifies a first private message the other side does not accept as typed, not as a refusal", () => {
    expect(classifyTelegramActionFailure(new tl.RpcError(403, "PRIVACY_PREMIUM_REQUIRED"))).toBe(
      "private_closed",
    );
    expect(classifyTelegramActionFailure(new tl.RpcError(400, "PEER_FLOOD"))).toBe("peer_flood");
  });

  it("classifies a reaction this chat does not allow as an invalid reaction", () => {
    expect(classifyTelegramActionFailure(new tl.RpcError(400, "REACTION_INVALID"))).toBe(
      "invalid_reaction",
    );
  });

  it("classifies a message that is gone as gone, not as an edit refused (a reaction hit it on day one)", () => {
    expect(classifyTelegramActionFailure(new tl.RpcError(400, "MESSAGE_ID_INVALID"))).toBe(
      "message_gone",
    );
    expect(classifyTelegramActionFailure(new tl.RpcError(400, "MESSAGE_EDIT_TIME_EXPIRED"))).toBe(
      "edit_refused",
    );
  });

  it("classifies admin-required channel sends as soft permanent", () => {
    expect(classifyTelegramActionFailure(new tl.RpcError(400, "CHAT_ADMIN_REQUIRED"))).toBe(
      "transport_soft_permanent",
    );
  });

  it("rethrows classified Telegram failures as typed action errors", () => {
    expect(() =>
      rethrowTelegramActionFailure(peerIdInvalid(), "send_text", {
        chatId: "1000000001",
      }),
    ).toThrowError(TelegramActionError);

    try {
      rethrowTelegramActionFailure(peerIdInvalid(), "send_text", {
        chatId: "1000000001",
      });
    } catch (error) {
      expect(isTelegramActionError(error)).toBe(true);
      if (isTelegramActionError(error)) {
        expect(error.code).toBe("transport_soft_permanent");
        expect(error.details?.chatId).toBe("1000000001");
      }
    }
  });

  it("leaves unrelated errors unclassified", () => {
    expect(classifyTelegramActionFailure(new Error("database is locked"))).toBeNull();
  });
});
