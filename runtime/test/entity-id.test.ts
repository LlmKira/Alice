/**
 * Entity ID 转换工具测试 — constants.ts 的 ID 转换函数。
 */
import { describe, expect, it } from "vitest";
import {
  chatIdToContactId,
  ensureChannelId,
  ensureContactId,
  extractNumericId,
  resolveContactAndChannel,
} from "../src/graph/constants.js";

describe("extractNumericId", () => {
  it("channel:telegram: 前缀", () => expect(extractNumericId("channel:telegram:123")).toBe(123));
  it("contact:telegram: 前缀", () => expect(extractNumericId("contact:telegram:456")).toBe(456));
  it("纯数字字符串", () => expect(extractNumericId("789")).toBe(789));
  it("负数 ID", () => expect(extractNumericId("channel:telegram:-1001234")).toBe(-1001234));
  it("非 Telegram 平台 → null", () => expect(extractNumericId("channel:qq:123")).toBeNull());
  it("旧 channel:123 → null", () => expect(extractNumericId("channel:123")).toBeNull());
  it("空字符串 → null", () => expect(extractNumericId("")).toBeNull());
  it("无前缀非数字 → null", () => expect(extractNumericId("abc")).toBeNull());
});

describe("ensureChannelId", () => {
  it("channel:telegram: 透传", () =>
    expect(ensureChannelId("channel:telegram:123")).toBe("channel:telegram:123"));
  it("contact:telegram: → channel:telegram:", () =>
    expect(ensureChannelId("contact:telegram:456")).toBe("channel:telegram:456"));
  it("channel:qq: 透传", () => expect(ensureChannelId("channel:qq:abc")).toBe("channel:qq:abc"));
  it("contact:qq: → channel:qq:", () =>
    expect(ensureChannelId("contact:qq:abc")).toBe("channel:qq:abc"));
  it("纯数字 → channel:telegram:", () =>
    expect(ensureChannelId("789")).toBe("channel:telegram:789"));
  it("旧 channel:123 → null", () => expect(ensureChannelId("channel:123")).toBeNull());
  it("非法 → null", () => expect(ensureChannelId("abc")).toBeNull());
  it("空串 → null", () => expect(ensureChannelId("")).toBeNull());
});

describe("ensureContactId", () => {
  it("contact:telegram: 透传", () =>
    expect(ensureContactId("contact:telegram:123")).toBe("contact:telegram:123"));
  it("channel:telegram: → contact:telegram:", () =>
    expect(ensureContactId("channel:telegram:456")).toBe("contact:telegram:456"));
  it("纯数字 → contact:telegram:", () =>
    expect(ensureContactId("789")).toBe("contact:telegram:789"));
  it("旧 contact:123 → null", () => expect(ensureContactId("contact:123")).toBeNull());
  it("非法 → null", () => expect(ensureContactId("abc")).toBeNull());
});

describe("resolveContactAndChannel", () => {
  const has = (ids: string[]) => (id: string) => ids.includes(id);

  it("两个节点都存在", () => {
    const result = resolveContactAndChannel(
      "channel:telegram:100",
      has(["channel:telegram:100", "contact:telegram:100"]),
    );
    expect(result.channelId).toBe("channel:telegram:100");
    expect(result.contactId).toBe("contact:telegram:100");
  });

  it("只有 channel 存在", () => {
    const result = resolveContactAndChannel("channel:telegram:200", has(["channel:telegram:200"]));
    expect(result.channelId).toBe("channel:telegram:200");
    expect(result.contactId).toBeNull();
  });

  it("只有 contact 存在", () => {
    const result = resolveContactAndChannel("contact:telegram:300", has(["contact:telegram:300"]));
    expect(result.contactId).toBe("contact:telegram:300");
    expect(result.channelId).toBeNull();
  });

  it("都不存在", () => {
    const result = resolveContactAndChannel("channel:telegram:999", has([]));
    expect(result.channelId).toBeNull();
    expect(result.contactId).toBeNull();
  });

  it("从 contact 输入推断 channel", () => {
    const result = resolveContactAndChannel(
      "contact:telegram:400",
      has(["channel:telegram:400", "contact:telegram:400"]),
    );
    expect(result.channelId).toBe("channel:telegram:400");
    expect(result.contactId).toBe("contact:telegram:400");
  });

  it("支持非数字短语 ID 的 channel/contact 镜像解析", () => {
    const result = resolveContactAndChannel(
      "channel:qq:clear-falcon",
      has(["channel:qq:clear-falcon", "contact:qq:clear-falcon"]),
    );
    expect(result.channelId).toBe("channel:qq:clear-falcon");
    expect(result.contactId).toBe("contact:qq:clear-falcon");
  });
});

describe("chatIdToContactId", () => {
  it("channel:telegram: → contact:telegram:", () =>
    expect(chatIdToContactId("channel:telegram:123")).toBe("contact:telegram:123"));
  it("contact:telegram: 透传", () =>
    expect(chatIdToContactId("contact:telegram:456")).toBe("contact:telegram:456"));
  it("旧 channel:123 → null", () => expect(chatIdToContactId("channel:123")).toBeNull());
  it("无前缀 → null", () => expect(chatIdToContactId("789")).toBeNull());
});
