import type { Mechanism } from "../src/mind/mechanism.js";

/** 测心智核心用的最小唤醒：私聊、回复她、点名她时醒来。 */
export const directedWake: Mechanism = {
  name: "directed-wake",
  wake: (_chat, event) => (event.type === "message.received" && event.directed ? 1 : 0),
};
