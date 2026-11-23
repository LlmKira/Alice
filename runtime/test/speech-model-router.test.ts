import { describe, expect, it } from "vitest";
import { pickSpeechModel } from "../src/llm/speech-model.js";
import type { SpeechRoutingFacts } from "../src/speech/prompt.js";

const base: SpeechRoutingFacts = {
  chatType: "group",
  foreignLanguage: false,
  hasMood: false,
  hasBotObservation: false,
  ownTurnsInLog: 0,
};

describe("pickSpeechModel (tiered Gemini-4 router via structured routing facts)", () => {
  const tiered = ["google/gemini-4-neon", "google/gemini-4-hydrogen"] as const;
  const hetero = ["google/gemini-4-neon", "bytedance/doubao-seed-2.1-pro-260915"] as const;

  it("stays on the single model when pool has one entry", () => {
    expect(
      pickSpeechModel(
        ["google/gemini-3.8-flash"],
        { kind: "speech", callId: "telegram:-1#7" },
        { user: "", routing: base },
      ),
    ).toBe("google/gemini-3.8-flash");
  });

  it("keeps ponder, private chats, and foreign-language turns on the primary model", () => {
    expect(
      pickSpeechModel(tiered, { kind: "ponder", callId: "self~reflect@3" }, { user: "" }),
    ).toBe("google/gemini-4-neon");
    expect(
      pickSpeechModel(
        tiered,
        { kind: "speech", callId: "telegram:1#3" },
        { user: "", routing: { ...base, chatType: "private" } },
      ),
    ).toBe("google/gemini-4-neon");
    expect(
      pickSpeechModel(
        tiered,
        { kind: "speech", callId: "telegram:-1#1" },
        { user: "", routing: { ...base, foreignLanguage: true } },
      ),
    ).toBe("google/gemini-4-neon");
  });

  it("routes light group chatter to the secondary model and upgrades deep/emotional/bot-observed group turns to primary", () => {
    expect(
      pickSpeechModel(
        tiered,
        { kind: "speech", callId: "qq:group:1#10" },
        { user: "", routing: base },
      ),
    ).toBe("google/gemini-4-hydrogen");

    expect(
      pickSpeechModel(
        tiered,
        { kind: "speech", callId: "qq:group:1#11" },
        { user: "", routing: { ...base, ownTurnsInLog: 2 } },
      ),
    ).toBe("google/gemini-4-neon");

    expect(
      pickSpeechModel(
        tiered,
        { kind: "speech", callId: "qq:group:1#12" },
        { user: "", routing: { ...base, hasMood: true } },
      ),
    ).toBe("google/gemini-4-neon");

    expect(
      pickSpeechModel(
        tiered,
        { kind: "speech", callId: "qq:group:1#13" },
        { user: "", routing: { ...base, hasBotObservation: true } },
      ),
    ).toBe("google/gemini-4-neon");
  });

  it("routes immediately to a non-Google partner when Alice's recent lines contain a verbal tic", () => {
    expect(
      pickSpeechModel(
        hetero,
        { kind: "speech", callId: "telegram:-1#10" },
        { user: "12:01 [2] <你> 物理跳过时间是吧", routing: { ...base, ownTurnsInLog: 2 } },
      ),
    ).toBe("bytedance/doubao-seed-2.1-pro-260915");
  });
});
