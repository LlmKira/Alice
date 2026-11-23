/**
 * 她被拉进一个新群：心智要知道这是她新进的群，familiar 不把那里的人写成"这个群里的朋友"。
 * 用户账号收不到成员变化的更新，线上 22 小时里 membership.changed 一条也没有，她新进的群里人人是老朋友
 * （eval-artifacts/footprint/）。来源改成入群提示里有她自己；提示没送到时，这次启动的对话列表里没有、
 * Journal 里也没有过的群，按刚被拉进来算（catch-up.ts Groups）。
 */
import type { Dispatcher } from "@mtcute/dispatcher";
import { describe, expect, it } from "vitest";
import { type FamiliarState, familiar } from "../src/mechanisms/familiar.js";
import type { AliceEvent } from "../src/mind/events.js";
import { emptyChat } from "../src/mind/state.js";
import { Groups } from "../src/telegram/catch-up.js";
import { bindTelegramWorldAdapter } from "../src/telegram/world-adapter.js";
import { mtcuteFake } from "./mtcute-fake.js";

const SELF = "42";
const GROUP_ID = -1009;
const SCOPE = "telegram:-1009";
const T0 = Date.parse("2026-11-12T08:00:00Z");

/** 适配器写出的事件按顺序进 Journal（和 index.ts 一样，Groups 从 Journal 投影）。 */
function adapter(atStart: string[] | null) {
  const events: AliceEvent[] = [];
  const groups = new Groups();
  if (atStart) groups.started(atStart);
  let now = T0;
  const dispatcher = mtcuteFake<Dispatcher>({
    onNewMessage: () => {},
    onRawUpdate: () => {},
    onChatMemberUpdate: () => {},
  });
  const { receive } = bindTelegramWorldAdapter(dispatcher, {
    selfId: SELF,
    now: () => now,
    onEvent: (e) => {
      events.push(e);
      groups.observe(e);
    },
    admit: () => true,
    newGroup: (scope) => groups.isNew(scope),
  });
  const message = (id: number, sender: number, extra: object = {}) =>
    receive(
      {
        id,
        chat: { id: GROUP_ID, chatType: "supergroup", title: "群" },
        sender: { id: sender, displayName: `u${sender}` },
        text: "你好呀",
        entities: [],
        media: null,
        replyToMessage: null,
        ...extra,
      } as never,
      {} as never,
    );
  return { events, message, tick: () => (now += 60_000) };
}

/** fold 进 familiar，读那个群里在场的人。 */
function present(events: AliceEvent[]): string {
  const state = events.reduce(
    (s, e) => familiar.reduce?.(s, e) as FamiliarState,
    familiar.initial as FamiliarState,
  );
  const chat = emptyChat(SCOPE, "group", true);
  chat.timeline = events.flatMap((e) =>
    e.type === "message.received"
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
  return familiar.contribute?.(chat, (events.at(-1)?.at ?? T0) + 60_000, state, [])[0]?.text ?? "";
}

describe("她被拉进新群", () => {
  it("对照：启动时就在的群，那里的人是这个群里的朋友", () => {
    const a = adapter([SCOPE]);
    a.message(1, 7);
    a.tick();
    a.message(2, 8);
    expect(a.events.some((e) => e.type === "membership.changed")).toBe(false);
    expect(present(a.events)).toContain("这个群里的朋友");
  });

  it("入群提示里有她：记成 membership.changed，那里的人不是老朋友", () => {
    const a = adapter([]);
    a.message(1, 7, { action: { type: "users_added", users: [42] }, text: "" });
    a.tick();
    a.message(2, 8);
    expect(a.events.filter((e) => e.type === "membership.changed")).toHaveLength(1);
    expect(present(a.events)).not.toContain("这个群里的朋友");
  });

  it("提示没送到：启动时不在的群，第一条消息之前记成被拉进来了，只记一次", () => {
    const a = adapter([]);
    a.message(1, 7);
    a.tick();
    a.message(2, 8);
    const changes = a.events.filter((e) => e.type === "membership.changed");
    expect(changes).toEqual([
      { type: "membership.changed", at: T0, scope: SCOPE, member: true, reason: "added" },
    ]);
    expect(a.events[0]?.type).toBe("membership.changed");
    expect(present(a.events)).not.toContain("这个群里的朋友");
  });

  it("对话列表还没拿到时，谁都不算新进的群", () => {
    const a = adapter(null);
    a.message(1, 7);
    expect(a.events.some((e) => e.type === "membership.changed")).toBe(false);
  });
});
