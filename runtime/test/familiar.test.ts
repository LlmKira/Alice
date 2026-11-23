import { describe, expect, it } from "vitest";
import { createFamiliar, type FamiliarState, familiar } from "../src/mechanisms/familiar.js";
import type { AliceEvent } from "../src/mind/events.js";
import { emptyChat } from "../src/mind/state.js";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const T0 = 1_795_174_200_000;
const GROUP = "telegram:-1009";

const said = (
  at: number,
  senderId: string,
  senderName: string,
  directed = false,
  scope = GROUP,
): AliceEvent => ({
  type: "message.received",
  at,
  scope,
  chatType: scope.startsWith("telegram:-") ? "group" : "private",
  messageId: String(at),
  senderId,
  senderName,
  text: "嗯",
  contentType: "text",
  replyToMessageId: null,
  directed,
});

/** fold 事件，读最后那一刻、这个会话里的关系事实（时间线是这个会话里的全部消息）。 */
function factAt(events: AliceEvent[], scope = GROUP, mechanism = familiar): string {
  const state = events.reduce(
    (s, e) => mechanism.reduce?.(s, e) as FamiliarState,
    mechanism.initial as FamiliarState,
  );
  const chat = emptyChat(scope, scope.startsWith("telegram:-") ? "group" : "private", true);
  chat.timeline = events.flatMap((e) =>
    e.type === "message.received" && e.scope === scope
      ? [
          {
            at: e.at,
            messageId: e.messageId,
            sender: { id: e.senderId, name: e.senderName },
            text: e.text,
            contentType: e.contentType,
            replyToMessageId: null,
          },
        ]
      : [],
  );
  const now = events.at(-1)?.at ?? T0;
  return mechanism.contribute?.(chat, now, state, [])[0]?.text ?? "";
}

describe("familiar: no record is not the same as a stranger", () => {
  it("in a group she was in before her records began, the people there are friends", () => {
    const text = factAt([said(T0, "u1", "老K"), said(T0 + MIN, "u2", "豆子", true)]);
    expect(text).toContain("老K、豆子：这个群里的朋友");
  });

  it("someone with a join notice is new, not a friend from before", () => {
    const text = factAt([
      said(T0, "u1", "糖糖"),
      { type: "member.joined", at: T0 + MIN, scope: GROUP, userId: "u9" },
      said(T0 + 2 * MIN, "u9", "小满", true),
    ]);
    expect(text).toContain("小满：今天刚进群");
    expect(text).toContain("糖糖：这个群里的朋友");
    expect(text).not.toMatch(/小满[^\n]*朋友/);
  });

  it("in a group she joined during her records, nobody is a friend from before", () => {
    const text = factAt([
      { type: "membership.changed", at: T0, scope: GROUP, member: true, reason: "added" },
      said(T0 + MIN, "u1", "阿杰", true),
    ]);
    expect(text).not.toContain("朋友");
    expect(text).toContain("阿杰：刚认识");
  });

  it("a channel posting in the group as itself is not a person, so not a friend (live: 5 of 42 calls)", () => {
    // Telegram 的 id：人是正数，群和频道是负数；以频道身份发言的消息，发言人就是那个频道。
    const text = factAt([said(T0, "-1001234567890", "Новости Канал"), said(T0 + MIN, "u1", "老K")]);
    expect(text).toContain("老K：这个群里的朋友");
    expect(text).not.toContain("Новости Канал");
  });

  it("an old group-mate who messages her privately is still a friend from that group", () => {
    const text = factAt(
      [said(T0, "u1", "南风"), said(T0 + 60 * MIN, "u1", "南风", true, "telegram:77")],
      "telegram:77",
    );
    expect(text).toContain("南风：和我在同一个群里的朋友");
  });
});

describe("familiar: she only says how often they talk when she has watched long enough", () => {
  it("half an hour of someone calling her does not make them close", () => {
    const events = [0, 5, 10, 20, 30].map((m) => said(T0 + m * MIN, "u1", "阿树", true));
    const text = factAt(events);
    expect(text).not.toMatch(/很亲近|几乎天天|常聊|偶尔聊/);
    expect(text).toContain("阿树：这个群里的朋友");
  });

  it("the ranked version still says 'very close' after half an hour (the ablation keeps the old wording)", () => {
    const events = [0, 5].map((m) => said(T0 + m * MIN, "u1", "阿树", true));
    const ranked = createFamiliar("x", { prior: true, calibrated: false });
    expect(factAt(events, GROUP, ranked)).toContain("很亲近");
  });

  it("someone seen only in private: nothing until a week, then three weeks every day reads as almost every day", () => {
    const dm = "telegram:55";
    const daily = (n: number) =>
      Array.from({ length: n }, (_, d) => said(T0 + d * DAY, "u5", "池塘", true, dm));
    expect(factAt(daily(3), dm)).toBe("");
    // 认识多久说不准（记录前也许就认识），不写；谁在找谁是记录里看得到的。
    expect(factAt(daily(21), dm)).toBe("我和在场的人：\n池塘：我们几乎天天聊；多是对方先找我");
  });
});
