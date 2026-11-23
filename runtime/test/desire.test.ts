/**
 * 她手里有东西、想分享（2026-11-14 进生产，mechanisms/pressure/desire.ts、why.ts；PLAN 第 44 件）。
 * 只测坏掉了会很糟的：频道新帖带着标题和内容送到该在的会话；这股劲自己能叫醒她、去掉它的消融组里叫不醒；想过就用掉；
 * 只对上这个会话在聊的东西；叫醒她的原因写成她的感受、换掉旁观者的那句；新鲜度按频道自己的节奏。
 */
import { describe, expect, it } from "vitest";
import {
  emptyPosts,
  freshFor,
  freshness,
  type PostItem,
  reducePosts,
} from "../src/mechanisms/pressure/desire.js";
import { emptyWorld } from "../src/mechanisms/pressure/world.js";
import { mechanisms } from "../src/mechanisms/registry.js";
import type { SpeechRequest } from "../src/mind/effects.js";
import type { AliceEvent, MessageReceived, SpeechDecision } from "../src/mind/events.js";
import type { Mechanism } from "../src/mind/mechanism.js";
import { replay } from "../src/sim/replay.js";
import { arms } from "../src/sim/will-arms.js";

/** 本地（UTC+8）11 月 12 日 10:00，醒着。 */
const T0 = Date.UTC(2026, 10, 12, 2, 0);
const MIN = 60_000;
const H = 60 * MIN;
const GROUP = "telegram:-100";
const OTHER = "telegram:-200";
const CHANNEL = "telegram:-1009";
const BUSY = "telegram:-1012";
/** 第二天中午（醒着）。 */
const HIT_AT = T0 + 26 * H;

/** 生产（2026-11-14 起带着想分享的劲）和去掉它的消融组。 */
const candidate = mechanisms;
const without = arms({})["no-desire"] as readonly Mechanism[];

let n = 0;
function msg(at: number, o: Partial<MessageReceived> = {}): MessageReceived {
  n++;
  const scope = o.scope ?? GROUP;
  return {
    type: "message.received",
    at,
    scope,
    chatType: "group",
    messageId: `m${n}`,
    senderId: "100",
    senderName: "小林",
    text: "hi",
    contentType: "text",
    replyToMessageId: null,
    directed: false,
    chatTitle: scope === GROUP ? "装机群" : "猫猫群",
    ...o,
  };
}

const post = (at: number, id: string, text: string, scope = CHANNEL): AliceEvent => ({
  type: "post.received",
  at,
  scope,
  messageId: id,
  title: "科技日报",
  text,
});

const FILLER = [
  "苹果发布新款耳机\n降噪更好，续航十小时",
  "某地暴雨航班延误\n机场滞留旅客上千人",
  "新番导演访谈\n谈到分镜和配乐",
  "咖啡价格上涨\n产地干旱减产",
  "地铁新线开通\n早高峰客流破纪录",
  "马拉松报名开启\n名额三万",
  "博物馆夜场开放\n周五到十点",
];
const HIT = "英伟达CEO黄仁勋宣布辞职\n显卡市场震动，英伟达股价盘后下跌";

/**
 * 装机群里小林常找她聊天（和她亲近），这两天一直在聊显卡和英伟达；猫猫群只聊猫。频道先来几条无关的，
 * 然后来一条英伟达的。之后两个群都安静下来。
 */
function world(withHit = true): AliceEvent[] {
  const ev: AliceEvent[] = [];
  // 小林过去一周天天找她聊天（relationTier 进 tier 5 "常聊"），这两天一直在聊显卡和英伟达。
  for (let d = 7; d >= 1; d--) {
    const dayAt = T0 - d * 24 * H;
    ev.push(msg(dayAt, { text: "爱丽丝最近有空吗，来看看新出的硬件评测", directed: true }));
    ev.push({
      type: "message.sent",
      at: dayAt + 30_000,
      scope: GROUP,
      messageId: `sd${d}`,
      text: "在看呢",
      kind: "text",
    });
  }
  for (let i = 0; i < 6; i++) {
    const at = T0 + 24 * H + i * MIN;
    ev.push(msg(at, { text: "爱丽丝你看这张显卡怎么样", directed: true }));
    if (i === 0) {
      ev.push({
        type: "message.sent",
        at: at + 10_000,
        scope: GROUP,
        messageId: "s1",
        text: "确实贵",
        kind: "text",
      });
    }
    ev.push(msg(at + 20_000, { text: "英伟达的显卡又涨价了，黄仁勋真会卖" }));
    ev.push(
      msg(at + 30_000, {
        scope: OTHER,
        senderId: "300",
        senderName: "阿喵",
        text: "我家猫今天又把杯子推下桌了",
      }),
    );
  }
  // 她平常在这里分享一次的工夫里看到的帖子要先有一些（desire.ts picked 的 window）：一天里另一个频道来四十条无关的。
  for (let i = 0; i < 40; i++) {
    ev.push(post(T0 + 30 * MIN + i * 36 * MIN, `f${i}`, FILLER[i % FILLER.length] as string, BUSY));
  }
  if (withHit) ev.push(post(HIT_AT, "hit", HIT));
  ev.push(msg(HIT_AT + 6 * H, { scope: "telegram:-999", senderId: "999", text: "." }));
  return ev;
}

type Oracle = (request: SpeechRequest) => SpeechDecision;
const quiet: Oracle = () => ({ acts: [] });

async function run(
  events: AliceEvent[],
  ms: readonly Mechanism[] = candidate,
  oracle: Oracle = quiet,
) {
  const requests: SpeechRequest[] = [];
  await replay(events, {
    mechanisms: ms,
    tickMs: 60_000,
    speech: (request) => {
      requests.push(request);
      return oracle(request);
    },
  });
  return requests;
}

const text = (r: SpeechRequest) => r.contributions.map((c) => c.text).join("\n");
const after = (rs: SpeechRequest[]) => rs.filter((r) => r.at >= HIT_AT);

describe("desire: what she sees in channels and wants to share", { timeout: 90_000 }, () => {
  // 下面 4 条只读断言跑的是完全相同的默认世界；复用同一份不可变回放结果。
  let cachedDefault: Promise<SpeechRequest[]> | null = null;
  const defaultRun = () => (cachedDefault ??= run(world()));

  it("a fresh post that matches what a close group is talking about is put before her there, with title and content", async () => {
    const rs = after(await defaultRun());
    const shown = rs.filter(
      (r) => r.scope === GROUP && text(r).includes("英伟达CEO黄仁勋宣布辞职"),
    );
    expect(shown.length).toBeGreaterThan(0);
    expect(text(shown[0] as SpeechRequest)).toContain("显卡市场震动");
    expect(text(shown[0] as SpeechRequest)).toContain("刚在频道看到一条：");
    // 猫猫群没在聊这个：不摆给她。
    for (const r of rs.filter((x) => x.scope === OTHER)) expect(text(r)).not.toContain("黄仁勋");
  });

  it("the urge itself wakes her in the quiet group; without it the post is never shown", async () => {
    const wakes = (rs: SpeechRequest[]) =>
      after(rs).filter((r) => r.scope === GROUP && r.triggerMessageId === null).length;
    expect(wakes(await defaultRun())).toBeGreaterThan(wakes(await run(world(false))));
    const prod = after(await run(world(), without)).filter((r) => r.scope === GROUP);
    for (const r of prod) expect(text(r)).not.toContain("黄仁勋宣布辞职");
  });

  it("once she has thought it over there, it is used up there", async () => {
    const rs = after(await defaultRun());
    const shown = rs.filter((r) => r.scope === GROUP && text(r).includes("黄仁勋宣布辞职"));
    expect(shown.length).toBe(1);
  });

  it("the same story from a second channel is not new once she has thought over the first; a bare link is not an item", async () => {
    const again: AliceEvent = {
      type: "post.received",
      at: HIT_AT + 20 * MIN,
      scope: "telegram:-1010",
      messageId: "again",
      title: "另一个频道",
      text: "英伟达CEO黄仁勋宣布辞职\n显卡市场震动，英伟达股价盘后下跌",
    };
    const link: AliceEvent = {
      type: "post.received",
      at: HIT_AT + 30 * MIN,
      scope: "telegram:-1011",
      messageId: "link",
      title: "链接频道",
      text: "https://example.com/nvidia-显卡-黄仁勋",
    };
    const events = [...world(), again, link].sort((a, b) => a.at - b.at);
    const rs = after(await run(events));
    const shown = rs.filter((r) => r.scope === GROUP && text(r).includes("黄仁勋宣布辞职"));
    expect(shown.length).toBe(1);
    for (const r of rs.filter((x) => x.scope === GROUP))
      expect(text(r)).not.toContain("example.com");
  });

  it("a caption says what it is attached to", async () => {
    const video: AliceEvent = {
      type: "post.received",
      at: HIT_AT,
      scope: CHANNEL,
      messageId: "video",
      title: "科技日报",
      text: "英伟达CEO黄仁勋宣布辞职，显卡市场震动",
      media: "视频 9 秒",
    };
    const events = [...world(false), video].sort((a, b) => a.at - b.at);
    const rs = after(await run(events));
    const shown = rs.filter((r) => r.scope === GROUP && text(r).includes("黄仁勋宣布辞职"));
    expect(shown.length).toBeGreaterThan(0);
    expect(text(shown[0] as SpeechRequest)).toContain("（视频 9 秒）");
  });

  it("after she says one out loud, the next waits until someone else there has spoken", async () => {
    const second: AliceEvent = post(
      HIT_AT + 40 * MIN,
      "hit2",
      "英伟达发布新一代显卡\n显卡性能翻倍，黄仁勋的继任者亮相",
      "telegram:-1013",
    );
    const events = [...world(), second].sort((a, b) => a.at - b.at);
    const speaksShare: Oracle = (r) =>
      text(r).includes("频道看到一条：")
        ? { acts: [{ kind: "send", text: "你们看这个", replyTo: null }] }
        : { acts: [] };
    const rs = after(await run(events, candidate, speaksShare));
    const shownIn = (s: string) =>
      rs.filter((r) => r.scope === GROUP && text(r).includes(s)).length;
    expect(shownIn("黄仁勋宣布辞职")).toBe(1);
    expect(shownIn("新一代显卡")).toBe(0);
  });

  it("nothing is put before her while someone there is waiting for her", async () => {
    const asked = msg(HIT_AT + MIN, { text: "爱丽丝在吗", directed: true });
    const events = [...world(), asked].sort((a, b) => a.at - b.at);
    const rs = (await run(events)).filter(
      (r) => r.scope === GROUP && r.triggerMessageId === asked.messageId,
    );
    expect(rs.length).toBeGreaterThan(0);
    for (const r of rs) expect(text(r)).not.toContain("黄仁勋宣布辞职");
  });

  it("the bystander line becomes a plain fact when she knows why she woke", async () => {
    const rs = await defaultRun();
    const unsought = rs.filter((r) => r.scope === GROUP && r.triggerMessageId === null);
    expect(unsought.length).toBeGreaterThan(0);
    for (const r of unsought) {
      expect(text(r)).not.toContain("你在旁边看着");
      expect(text(r)).toContain("没人点名；大家在自己聊。");
    }
  });
});

describe("desire: freshness follows each channel's own pace", () => {
  const item = { scope: CHANNEL, at: 0 } as PostItem;
  it("a post from a busy channel sinks faster than one from a slow channel", () => {
    const busy = { ...emptyPosts, channels: { [CHANNEL]: { lastAt: 0, gap: 20 * MIN, n: 40 } } };
    const slow = { ...emptyPosts, channels: { [CHANNEL]: { lastAt: 0, gap: 20 * H, n: 40 } } };
    expect(freshness(busy, item, 3 * H)).toBeLessThan(0.05);
    expect(freshness(slow, item, 3 * H)).toBeGreaterThan(0.8);
  });
  it("with few posts the pace leans on the prior", () => {
    expect(freshFor(undefined)).toBe(6 * H);
    expect(freshFor({ lastAt: 0, gap: 10 * MIN, n: 1 })).toBeGreaterThan(4 * H);
  });
});

describe("the live rotation's phone arm is built on the new production", () => {
  it("phone carries the share urge and the scene facts, and differs from production only by phone", () => {
    const all = arms({});
    const phone = all.phone as readonly Mechanism[];
    const prodNames = (all.production as readonly Mechanism[]).map((m) => m.name);
    const phoneNames = phone.map((m) => m.name);
    expect(prodNames).toContain("scene-facts");
    expect(phoneNames).toContain("scene-facts");
    const field = (ms: readonly Mechanism[]) => ms.find((m) => m.name.startsWith("pressure"))?.name;
    expect(field(phone)).toContain("desire");
    expect(field(phone)).toContain("context-mentions");
    expect(field(phone)).toContain("phone");
    expect(phoneNames.slice(1)).toEqual(prodNames.slice(1));
  });

  it("deduplicates repeated post.received events with the same scope and messageId", () => {
    const seen = { ...emptyWorld, posts: emptyPosts };
    const ev = post(T0, "dup-1", "标题一行\n正文内容在这里");
    const once = reducePosts(seen, seen, ev);
    const twice = reducePosts(once, once, post(T0 + 60_000, "dup-1", "标题一行\n正文内容在这里"));
    expect(twice.posts?.items).toHaveLength(1);
  });
});
