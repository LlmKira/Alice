/**
 * 平台层（sim/platform.ts）：假 Telegram 照 mtcute 在用户账号上的样子送更新，经真的入站适配、去重、对话轮询、执行器。
 * 2026-11-12 体检的缺陷都出在这几种怪处上（eval-artifacts/footprint/）：适配器或执行器退回去，这里就红。
 */
import { describe, expect, it } from "vitest";
import { Album } from "../src/album.js";
import { type ActEffect, deliver } from "../src/interpret.js";
import type { AliceEvent, MessageReceived } from "../src/mind/events.js";
import { towardHerReader } from "../src/mind/step.js";
import { FakeTelegram, SELF, throughPlatform } from "../src/sim/platform.js";
import { executeAct } from "../src/telegram/acts.js";
import { CATCH_UP_MS } from "../src/telegram/catch-up.js";
import { Gates, Telegram } from "../src/telegram/gates.js";
import { Shelf } from "../src/telegram/shelf.js";
import { bindTelegramWorldAdapter } from "../src/telegram/world-adapter.js";

const G = "telegram:-1009001";
const G2 = "telegram:-1009002";
const T0 = Date.parse("2026-11-13T06:00:00Z");
const MIN = 60_000;

const heard = (
  at: number,
  scope: string,
  id: string,
  who: string,
  more: Partial<MessageReceived> = {},
): MessageReceived => ({
  type: "message.received",
  at,
  scope,
  chatType: "group",
  messageId: id,
  senderId: who,
  senderName: `u${who}`,
  text: "今天好冷",
  contentType: "text",
  replyToMessageId: null,
  directed: false,
  chatTitle: "群",
  ...more,
});
const said = (at: number, scope: string, id: string): AliceEvent => ({
  type: "message.sent",
  at,
  scope,
  messageId: id,
  kind: "text",
  text: "我觉得是这样",
});
const received = (events: readonly AliceEvent[]) =>
  events.filter((e): e is MessageReceived => e.type === "message.received");

describe("平台层：mtcute 在用户账号上的怪处", () => {
  it("全推送时原样过去：编号、人、文字不变，点名照记", async () => {
    const ideal = [heard(T0, G, "100", "11"), heard(T0 + MIN, G, "101", "12", { directed: true })];
    expect(await throughPlatform(ideal)).toEqual(ideal);
  });

  it("她自己的话不派发；同一个群里回复她的那条没有被回复者，记下回复的编号，心智算它在找她", async () => {
    const reply = heard(T0 + 2 * MIN, G, "102", "12", { replyToMessageId: "101", directed: true });
    const out = await throughPlatform([heard(T0, G, "100", "11"), said(T0 + MIN, G, "101"), reply]);
    // 适配器只记事实：没点名，回复的是 101。
    const got = received(out);
    expect(got.map((e) => e.senderId)).toEqual(["11", "12"]);
    expect(got[1]).toMatchObject({ replyToMessageId: "101", directed: false });
    // 心智：101 是她发的，这条是在找她。
    const toward = towardHerReader();
    const seen = out.map((e) => toward(e).event);
    expect(received(seen)[1]?.directed).toBe(true);
  });

  it("收不到成员变化的更新：被拉进群、被移出只有群里的提示，记成她的成员变化；别人进群不进时间线", async () => {
    const out = await throughPlatform([
      heard(T0, G, "100", "11"),
      { type: "membership.changed", at: T0 + MIN, scope: G2, member: true, reason: "added" },
      heard(T0 + 2 * MIN, G2, "200", "21"),
      { type: "member.joined", at: T0 + 3 * MIN, scope: G2, userId: "22" },
      { type: "membership.changed", at: T0 + 4 * MIN, scope: G2, member: false, reason: "kicked" },
    ]);
    const here = out.filter((e) => "scope" in e && e.scope === G2).map((e) => e.type);
    expect(here).toEqual([
      "membership.changed",
      "message.received",
      "member.joined",
      "membership.changed",
    ]);
    // 记在提示到的那一刻（不是等到群里第一条消息时才按"启动后才出现的群"补上）。
    const changes = out.filter((e) => e.type === "membership.changed");
    expect(
      changes.map((e) => e.type === "membership.changed" && [e.at, e.member, e.reason]),
    ).toEqual([
      [T0 + MIN, true, "added"],
      [T0 + 4 * MIN, false, "kicked"],
    ]);
  });

  it("不推送的群：消息只靠对话轮询补到，每条一次，晚到不超过一轮", async () => {
    const ideal = [0, 1, 2].map((k) => heard(T0 + k * 30_000, G, String(100 + k), "11"));
    const out = received(await throughPlatform(ideal, { unpushed: new Set([G]) }));
    expect(out.map((e) => e.messageId)).toEqual(["100", "101", "102"]);
    for (const [k, e] of out.entries()) {
      const at = (ideal[k] as AliceEvent).at;
      expect(e.at).toBeGreaterThan(at);
      expect(e.at - at).toBeLessThanOrEqual(CATCH_UP_MS);
    }
  });

  it("不推送的热闹群：一轮之间来了好几页，一条不少、按先后补到", async () => {
    // 300 条在一个轮询间隔里（停机重启、轮询出错之后也会这样攒下来）。
    const ideal = Array.from({ length: 300 }, (_, k) =>
      heard(T0 + k * 500, G, String(1000 + k), String(11 + (k % 5))),
    );
    const out = received(await throughPlatform(ideal, { unpushed: new Set([G]) }));
    expect(out.map((e) => e.messageId)).toEqual(ideal.map((e) => e.messageId));
  });

  it("推送晚到：对话轮询先补到，推送再送一遍，只记一次", async () => {
    const ideal = [0, 1].map((k) => heard(T0 + k * MIN, G, String(100 + k), "11"));
    const out = received(await throughPlatform(ideal, { late: new Set([G]) }));
    expect(out.map((e) => e.messageId)).toEqual(["100", "101"]);
  });

  it("这个群限定了表情：表情点不上，同一轮的话照样发出去，她的话不派发回来", async () => {
    let now = T0;
    const fake = new FakeTelegram(() => now);
    const chatId = -1009003;
    fake.chat(chatId, "group", { reactions: ["👍"] });
    const inbound: AliceEvent[] = [];
    bindTelegramWorldAdapter(fake.dispatcher, {
      selfId: String(SELF.id),
      now: () => now,
      onEvent: (e) => void inbound.push(e),
      admit: () => true,
      newGroup: () => false,
    });
    const someone = fake.user(11, "u11");
    const target = fake.post(chatId, someone, { text: "今天好冷" });
    const scope = `telegram:${chatId}`;
    const ctx = {
      telegram: new Telegram(fake.client, new Gates(() => now)),
      target: { chatId },
      scope,
      shelf: new Shelf(),
      stickerFileId: () => null,
      album: new Album(async () => []),
      now: () => now,
      speak: async () => {
        throw new Error("no speech synthesis here");
      },
      pause: async () => {},
    };
    const events: AliceEvent[] = [];
    const batch: ActEffect[] = [
      { type: "act", scope, act: { kind: "react", messageId: String(target), emoji: "👀" } },
      { type: "act", scope, act: { kind: "send", text: "是啊", replyTo: null } },
    ];
    now += MIN;
    await deliver(batch, {
      now: () => now,
      emit: (e) => void events.push(e),
      act: (_scope, act) => executeAct(ctx, act),
      timeline: () => [],
    });
    expect(events.map((e) => (e.type === "act.failed" ? e.reason : e.type))).toEqual([
      "invalid_reaction",
      "message.sent",
    ]);
    expect(received(inbound).map((e) => e.senderId)).toEqual(["11"]);
  });
});
