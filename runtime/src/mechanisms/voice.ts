import type { Mechanism } from "../mind/mechanism.js";

/**
 * 表达方式（capabilities A16、A13、A27，在生产）。登记表里这几行要有机制提供（provided）：不放机制，
 * 她就看不到它们，消融就是从组合里移除。都没有状态。
 * - voice：发语音（tools.voice，外壳合成，llm/tts.ts）。
 * - expression：改自己刚发的消息（tools.edit）、跟着复读（tools.repeat）。
 */
export const voice: Mechanism = {
  name: "voice",
  affordances: ["voice"],
};

export const expression: Mechanism = {
  name: "expression",
  affordances: ["edit", "repeat"],
};
