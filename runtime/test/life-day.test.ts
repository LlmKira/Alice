import { describe, expect, it } from "vitest";
import { decodeEvent } from "../src/journal.js";
import { createPressure, PRODUCTION } from "../src/mechanisms/pressure/index.js";
import { createLifeBody } from "../src/mechanisms/pressure/life-body.js";
import { affordances } from "../src/mind/affordances.js";
import type { LifeDayRequest } from "../src/mind/effects.js";
import type { AliceEvent, LifeDayPonder } from "../src/mind/events.js";
import { emptyState } from "../src/mind/state.js";
import { step } from "../src/mind/step.js";
import { parseLifeDay, renderLifeDayPrompt } from "../src/speech/life-day.js";

const OFFSET_MS = 8 * 3_600_000;
const local = (h: number, m = 0) => Date.UTC(2026, 10, 14, h, m) - OFFSET_MS;

const dailyLife = createPressure(affordances, {
  ...PRODUCTION,
  sleep: undefined,
  life: createLifeBody({ busyMode: "phi-half", dailyContent: true }),
});

describe("her daily life content (her-life.md Slice 2)", () => {
  it("asks once per waking day via strictly chat-free LifeDayRequest and falls back cleanly on failure", () => {
    const tMorning = local(10, 0);
    let state = emptyState;
    state = step(
      state,
      {
        type: "message.received",
        at: tMorning - 60_000,
        scope: "telegram:1",
        chatType: "private",
        messageId: "m0",
        senderId: "u1",
        senderName: "小周",
        text: "早呀",
        contentType: "text",
        replyToMessageId: null,
        directed: true,
      },
      [dailyLife],
    ).state;
    state = step(
      state,
      { type: "noise.drawn", at: tMorning, scope: "self", draws: { life: 0, "life-length": 0 } },
      [dailyLife],
    ).state;
    const tick1 = step(state, { type: "clock.tick", at: tMorning + 10_000 }, [dailyLife]);
    state = tick1.state;
    const ponderAsk = tick1.effects.find((e) => e.type === "call-ponder");
    expect(ponderAsk).toBeDefined();
    if (!ponderAsk || ponderAsk.type !== "call-ponder" || ponderAsk.request.kind !== "life") {
      throw new Error("expected life ponder request");
    }
    const req: LifeDayRequest = ponderAsk.request;
    // 类型与内容隔离：不含任何 chats / messages 字段
    expect(Object.keys(req).sort()).toEqual(["at", "date", "kind", "scope", "yesterday"]);
    expect(req.date).toBe("2026-11-14");

    // 同一天失败后不重复在每个时钟格里重问
    state = step(
      state,
      {
        type: "ponder.failed",
        at: tMorning + 20_000,
        scope: "self",
        callId: ponderAsk.callId,
        kind: "life",
        reason: "model",
      },
      [dailyLife],
    ).state;
    const tick2 = step(state, { type: "clock.tick", at: tMorning + 30_000 }, [dailyLife]);
    expect(tick2.effects.some((e) => e.type === "call-ponder")).toBe(false);
  });

  it("renders/parses daily content and surfaces activity details + time-unlocked moments across chats", () => {
    const req: LifeDayRequest = {
      kind: "life",
      at: local(9, 30),
      scope: "self",
      date: "2026-11-14",
      yesterday: {
        activities: { meal: "番茄炒蛋" },
        moments: ["楼下橘猫蹭了鞋子"],
        ongoing: ["在追《葬送的芙莉莲》"],
      },
    };
    const prompt = renderLifeDayPrompt("你是 Alice。", req);
    expect(prompt.user).toContain("番茄炒蛋");
    const parsed: LifeDayPonder = parseLifeDay(
      JSON.stringify({
        activities: { meal: "麻婆豆腐", read: "《沙丘》", game: "空洞骑士" },
        moments: [
          { hour: 11, text: "煮汤稍微煮溢出来了" },
          { hour: 16, text: "阳台飘来一阵桂花香" },
        ],
        ongoing: ["在追《葬送的芙莉莲》"],
      }),
      req,
    );
    expect(parsed.activities.read).toBe("《沙丘》");
    expect(parsed.moments).toHaveLength(2);

    const doneEvent: AliceEvent = {
      type: "ponder.done",
      at: local(9, 31),
      scope: "self",
      callId: "self~life@1",
      ponder: parsed,
    };
    expect(decodeEvent(doneEvent.type, doneEvent.scope, doneEvent)).toEqual(doneEvent);

    let state = emptyState;
    state = step(
      state,
      {
        type: "noise.drawn",
        at: local(12, 0),
        scope: "self",
        draws: { life: 0.1, "life-length": 0 },
      },
      [dailyLife],
    ).state;
    state = step(state, doneEvent, [dailyLife]).state;

    // 12 点时：11 点的小事已经解锁，16 点的小事还没到时间不泄露
    const lines = (
      dailyLife.contribute?.(
        { scope: "telegram:1", chatType: "private", timeline: [], member: true } as never,
        local(12, 5),
        state.mechanisms[dailyLife.name],
        [],
      ) ?? []
    )
      .map((c) => c.text)
      .join("\n");
    expect(lines).toContain("煮汤稍微煮溢出来了");
    expect(lines).not.toContain("阳台飘来一阵桂花香");
    expect(lines).toContain("在追《葬送的芙莉莲》");
  });
});
