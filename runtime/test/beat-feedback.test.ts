/**
 * ADR-23 Wave 2 测试 — Beat 驱动的多维人格反馈。
 *
 * ADR-214 Wave B: shell-native 下 extractBeatTypes/extractBeatFeedback 始终返回空。
 * 测试重心转向 BEAT_FEEDBACK_MAP 映射正确性和人格向量演化方向。
 */
import { describe, expect, it } from "vitest";
import type { ScriptExecutionResult } from "../src/core/script-execution.js";
import {
  BEAT_FEEDBACK_MAP,
  extractBeatFeedback,
  extractBeatTypes,
} from "../src/voices/beat-feedback.js";
import { PersonalityVector, personalityEvolutionBatch } from "../src/voices/personality.js";

/** 创建一个最小的 ScriptExecutionResult mock。 */
function makeResult(completedActions: string[] = []): ScriptExecutionResult {
  return {
    logs: [],
    errors: [],
    instructionErrors: [],
    errorCodes: [],
    duration: 0,
    thinks: [],
    queryLogs: [],
    observations: [],
    completedActions,
    silenceReason: null,
  };
}

describe("BEAT_FEEDBACK_MAP", () => {
  it("6 种社交 Beat 类型有映射", () => {
    expect(BEAT_FEEDBACK_MAP.observation).toBeDefined();
    expect(BEAT_FEEDBACK_MAP.engagement).toBeDefined();
    expect(BEAT_FEEDBACK_MAP.assistance).toBeDefined();
    expect(BEAT_FEEDBACK_MAP.misstep).toBeDefined();
    expect(BEAT_FEEDBACK_MAP.connection).toBeDefined();
    expect(BEAT_FEEDBACK_MAP.insight).toBeDefined();
  });

  it("misstep 有双向反馈（Caution+ Sociability-）", () => {
    const fb = BEAT_FEEDBACK_MAP.misstep;
    expect(fb).toHaveLength(2);
    // Caution (index 3) 正强化
    expect(fb[0].voice).toBe(3);
    expect(fb[0].magnitude).toBeGreaterThan(0);
    // Sociability (index 2) 微抑制
    expect(fb[1].voice).toBe(2);
    expect(fb[1].magnitude).toBeLessThan(0);
  });

  it("connection 对 Sociability 有最大强化", () => {
    const fb = BEAT_FEEDBACK_MAP.connection;
    expect(fb).toHaveLength(1);
    expect(fb[0].voice).toBe(2); // Sociability
    expect(fb[0].magnitude).toBe(0.5);
  });
});

describe("extractBeatTypes (shell-native)", () => {
  it("shell-native 下始终返回空数组", () => {
    // shell-native: dispatch 动作不在 completedActions 中追踪
    const result = makeResult(["sent:chatId=123:msgId=456"]);
    expect(extractBeatTypes(result)).toEqual([]);
  });

  it("空 completedActions 返回空数组", () => {
    const result = makeResult();
    expect(extractBeatTypes(result)).toEqual([]);
  });
});

describe("extractBeatFeedback (shell-native)", () => {
  it("shell-native 下始终返回 null（退化到 v4）", () => {
    const result = makeResult(["sent:chatId=123:msgId=456"]);
    expect(extractBeatFeedback(result)).toBeNull();
  });
});

describe("Beat feedback → 人格向量演化方向", () => {
  const base = new PersonalityVector(); // 均匀 [0.2, 0.2, 0.2, 0.2, 0.2]
  const home = [0.2, 0.2, 0.2, 0.2, 0.2];
  const evolve = (pv: PersonalityVector, actionIdx: number, feedback: number, alpha = 0.01) =>
    personalityEvolutionBatch(pv, [{ actionIdx, feedback }], alpha, 0.0005, home);

  it("observation → Curiosity 增加", () => {
    const fb = BEAT_FEEDBACK_MAP.observation[0];
    const evolved = evolve(base, fb.voice, fb.magnitude);
    expect(evolved.piC).toBeGreaterThan(base.piC);
  });

  it("engagement → Sociability 增加", () => {
    const fb = BEAT_FEEDBACK_MAP.engagement[0];
    const evolved = evolve(base, fb.voice, fb.magnitude);
    expect(evolved.piS).toBeGreaterThan(base.piS);
  });

  it("assistance → Diligence 增加", () => {
    const fb = BEAT_FEEDBACK_MAP.assistance[0];
    const evolved = evolve(base, fb.voice, fb.magnitude);
    expect(evolved.piD).toBeGreaterThan(base.piD);
  });

  it("insight → Curiosity 增加（ADR-81: Reflection 移除，映射到 Curiosity）", () => {
    const fb = BEAT_FEEDBACK_MAP.insight[0];
    const evolved = evolve(base, fb.voice, fb.magnitude);
    expect(evolved.piC).toBeGreaterThan(base.piC);
  });

  it("misstep → Caution 增加, Sociability 减少", () => {
    const [cautionFb, socialFb] = BEAT_FEEDBACK_MAP.misstep;
    // batch 的优势：一次调用处理多个 feedback，不重复投影
    const evolved = personalityEvolutionBatch(
      base,
      [
        { actionIdx: cautionFb.voice, feedback: cautionFb.magnitude },
        { actionIdx: socialFb.voice, feedback: socialFb.magnitude },
      ],
      0.01,
      0.0005,
      home,
    );
    expect(evolved.piX).toBeGreaterThan(base.piX);
    expect(evolved.piS).toBeLessThan(base.piS);
  });

  it("connection → Sociability 增加（最大幅度）", () => {
    const fb = BEAT_FEEDBACK_MAP.connection[0];
    const evolved = evolve(base, fb.voice, fb.magnitude);
    const evolvedEng = evolve(
      base,
      BEAT_FEEDBACK_MAP.engagement[0].voice,
      BEAT_FEEDBACK_MAP.engagement[0].magnitude,
    );
    expect(evolved.piS).toBeGreaterThan(evolvedEng.piS);
  });
});

describe("v4 退化反馈", () => {
  const home = [0.2, 0.2, 0.2, 0.2, 0.2];
  it("无 Beat 时使用降权反馈 success=0.2", () => {
    const pv = new PersonalityVector();
    const evolved = personalityEvolutionBatch(
      pv,
      [{ actionIdx: 0, feedback: 0.2 }],
      0.01,
      0.0005,
      home,
    );
    expect(evolved.piD).toBeGreaterThan(pv.piD);
    const evolvedOld = personalityEvolutionBatch(
      pv,
      [{ actionIdx: 0, feedback: 0.7 }],
      0.01,
      0.0005,
      home,
    );
    expect(evolved.piD).toBeLessThan(evolvedOld.piD);
  });
});
