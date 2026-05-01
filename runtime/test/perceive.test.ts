import { describe, expect, it } from "vitest";
import { perceiveTick } from "../src/engine/perceive.js";
import { WorldModel } from "../src/graph/world-model.js";
import { EventBuffer } from "../src/telegram/events.js";

describe("perceiveTick — group bot flood cooldown", () => {
  it("群聊纯 bot 连发不会解锁沉默，反而追加轻微冷却", () => {
    const G = new WorldModel();
    G.addChannel("channel:group", {
      chat_type: "group",
      consecutive_act_silences: 1,
    });

    const buffer = new EventBuffer();
    buffer.push({ type: "new_message", channelId: "channel:group", senderIsBot: true, tick: 1 });
    buffer.push({ type: "new_message", channelId: "channel:group", senderIsBot: true, tick: 1 });

    perceiveTick(G, buffer, 1);

    expect(G.getChannel("channel:group").consecutive_act_silences).toBe(2);
    expect(G.getChannel("channel:group").last_act_silence_ms).toBeTypeOf("number");
  });

  it("群聊真人消息才会逐步解锁沉默冷却", () => {
    const G = new WorldModel();
    G.addChannel("channel:group", {
      chat_type: "group",
      consecutive_act_silences: 2,
    });

    const buffer = new EventBuffer();
    buffer.push({ type: "new_message", channelId: "channel:group", senderIsBot: false, tick: 1 });

    perceiveTick(G, buffer, 1);

    expect(G.getChannel("channel:group").consecutive_act_silences).toBe(1);
  });
});
