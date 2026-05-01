import { describe, expect, it, vi } from "vitest";
import { createOneBotTransportAdapter, type OneBotHttpFetch } from "../src/platform/onebot.js";

function okResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  };
}

describe("createOneBotTransportAdapter", () => {
  it("sends QQ group text through OneBot v11 send_group_msg", async () => {
    const fetch = vi.fn<OneBotHttpFetch>(async () =>
      okResponse({ status: "ok", retcode: 0, data: { message_id: 456 } }),
    );
    const adapter = createOneBotTransportAdapter({
      apiBaseUrl: "http://127.0.0.1:3000/",
      accessToken: "secret",
      fetch,
    });

    const result = await adapter.send?.({
      target: {
        kind: "channel",
        platform: "qq",
        nativeId: "123",
        stableId: "channel:qq:123",
        legacy: false,
      },
      text: "hello",
    });

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3000/send_group_msg",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret",
        },
        body: JSON.stringify({
          group_id: 123,
          message: [{ type: "text", data: { text: "hello" } }],
        }),
      }),
    );
    expect(result).toEqual({
      platform: "qq",
      target: "channel:qq:123",
      messageId: "message:qq:123:456",
      nativeMessageId: 456,
    });
  });

  it("sends QQ private reply through OneBot v11 send_private_msg", async () => {
    const fetch = vi.fn<OneBotHttpFetch>(async () =>
      okResponse({ status: "ok", retcode: 0, data: { message_id: "m-9" } }),
    );
    const adapter = createOneBotTransportAdapter({
      apiBaseUrl: "http://onebot.local",
      fetch,
    });

    const result = await adapter.send?.({
      target: {
        kind: "contact",
        platform: "qq",
        nativeId: "998877",
        stableId: "contact:qq:998877",
        legacy: false,
      },
      text: "收到",
      replyTo: {
        platform: "qq",
        chatNativeId: "998877",
        messageNativeId: "321",
        stableId: "message:qq:998877:321",
      },
    });

    expect(fetch).toHaveBeenCalledWith(
      "http://onebot.local/send_private_msg",
      expect.objectContaining({
        body: JSON.stringify({
          user_id: 998877,
          message: [
            { type: "reply", data: { id: 321 } },
            { type: "text", data: { text: "收到" } },
          ],
        }),
      }),
    );
    expect(result).toEqual({
      platform: "qq",
      target: "contact:qq:998877",
      messageId: "message:qq:998877:m-9",
      nativeMessageId: "m-9",
    });
  });

  it("rejects reply refs from another QQ conversation before calling OneBot", async () => {
    const fetch = vi.fn<OneBotHttpFetch>();
    const adapter = createOneBotTransportAdapter({
      apiBaseUrl: "http://onebot.local",
      fetch,
    });

    await expect(
      adapter.send?.({
        target: {
          kind: "channel",
          platform: "qq",
          nativeId: "1",
          stableId: "channel:qq:1",
          legacy: false,
        },
        text: "no",
        replyTo: {
          platform: "qq",
          chatNativeId: "2",
          messageNativeId: "9",
          stableId: "message:qq:2:9",
        },
      }),
    ).rejects.toThrow("reply message ref does not belong to target");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces OneBot failed responses as typed provider errors", async () => {
    const fetch = vi.fn<OneBotHttpFetch>(async () =>
      okResponse({ status: "failed", retcode: 1404, message: "group not found" }),
    );
    const adapter = createOneBotTransportAdapter({
      apiBaseUrl: "http://onebot.local",
      fetch,
    });

    await expect(
      adapter.send?.({
        target: {
          kind: "channel",
          platform: "qq",
          nativeId: "123",
          stableId: "channel:qq:123",
          legacy: false,
        },
        text: "hello",
      }),
    ).rejects.toThrow("OneBot send_group_msg failed");
  });
});
