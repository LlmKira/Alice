/**
 * ADR-185 §3: applyOutcomeMoodNudge 单元测试。
 *
 * ADR-214 Wave B: 参数改为 ScriptExecutionResult。
 * shell-native 下 rate_outcome 不在 completedActions 中追踪，
 * applyOutcomeMoodNudge 退化到 NUDGE_SENT_FALLBACK（0.3）。
 *
 * @see docs/adr/185-cross-pollination-from-llm-agent-landscape.md §3
 */
import { describe, expect, it } from "vitest";
import type { ScriptExecutionResult } from "../src/core/script-execution.js";
import { readEmotionEpisodes } from "../src/emotion/graph.js";
import { applyOutcomeMoodNudge } from "../src/engine/react/feedback-arc.js";
import { WorldModel } from "../src/graph/world-model.js";

// -- 辅助工厂 ----------------------------------------------------------------

/** 构建 minimal ScriptExecutionResult。 */
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

function makeFailedResult(errorCodes: ScriptExecutionResult["errorCodes"]): ScriptExecutionResult {
  return {
    ...makeResult(),
    errors: ["failed"],
    errorCodes: [...errorCodes],
  };
}

/** 创建包含 self agent 的 WorldModel，可指定旧 self mood，验证 ADR-268 不再写它。 */
function makeGraph(moodValence = 0): WorldModel {
  const G = new WorldModel();
  G.addAgent("self", { mood_valence: moodValence, mood_set_ms: 0 });
  return G;
}

const SCALE = 0.05;

describe("ADR-268: applyOutcomeMoodNudge emotion episodes", () => {
  // -- shell-native: rate_outcome 不可用，退化到 fallback ----------------------

  it("消息已发送（无 rate_outcome）→ pleased episode，不写 legacy self mood", () => {
    const G = makeGraph(0);
    const sr = makeResult();
    applyOutcomeMoodNudge(G, sr, true, false, SCALE);
    expect(G.getAgent("self").mood_valence).toBe(0);
    expect(G.getAgent("self").mood_set_ms).toBe(0);
    expect(readEmotionEpisodes(G)).toHaveLength(1);
    expect(readEmotionEpisodes(G)[0]?.kind).toBe("pleased");
  });

  it("LLM 失败 → tired episode，不写 legacy self mood", () => {
    const G = makeGraph(0);
    const sr = makeResult();
    applyOutcomeMoodNudge(G, sr, false, true, SCALE);
    expect(G.getAgent("self").mood_valence).toBe(0);
    expect(readEmotionEpisodes(G)[0]?.kind).toBe("tired");
  });

  it("重复 Telegram 确定性失败 → annoyed episode", () => {
    const G = makeGraph(0);
    applyOutcomeMoodNudge(G, makeFailedResult(["invalid_reaction"]), false, false, SCALE);
    applyOutcomeMoodNudge(G, makeFailedResult(["invalid_reaction"]), false, false, SCALE);
    expect(readEmotionEpisodes(G).at(-1)?.kind).toBe("annoyed");
    expect(G.getAgent("self").mood_valence).toBe(0);
  });

  it("主动沉默 → mood_valence 不变", () => {
    const G = makeGraph(0.2);
    const sr = makeResult();
    applyOutcomeMoodNudge(G, sr, false, false, SCALE);
    // messageSent=false, llmFailed=false → silence → delta=0
    expect(G.getAgent("self").mood_valence).toBe(0.2);
  });

  // -- 深度对话额外加成 -------------------------------------------------------

  it("深度对话 (subcycles=4) → pleased episode intensity 更高", () => {
    const G = makeGraph(0);
    const sr = makeResult();
    applyOutcomeMoodNudge(G, sr, true, false, SCALE, 4);
    expect(readEmotionEpisodes(G)[0]?.kind).toBe("pleased");
    expect(readEmotionEpisodes(G)[0]?.intensity).toBeGreaterThan(SCALE * 0.3);
  });

  it("subcycles=2（边界值）→ 不触发深度对话奖励", () => {
    const G = makeGraph(0);
    const sr = makeResult();
    applyOutcomeMoodNudge(G, sr, true, false, SCALE, 2);
    expect(readEmotionEpisodes(G)[0]?.cause.summary).toContain("sent successfully");
  });

  it("legacy clamp path is gone: positive nudge leaves old scalar untouched", () => {
    const G = makeGraph(0.99);
    const sr = makeResult();
    applyOutcomeMoodNudge(G, sr, true, false, SCALE);
    expect(G.getAgent("self").mood_valence).toBe(0.99);
  });

  it("legacy clamp path is gone: negative nudge leaves old scalar untouched", () => {
    const G = makeGraph(-0.98);
    const sr = makeResult();
    applyOutcomeMoodNudge(G, sr, false, true, SCALE);
    expect(G.getAgent("self").mood_valence).toBe(-0.98);
  });

  // -- 禁用 -------------------------------------------------------------------

  it("nudgeScale=0 → 无影响", () => {
    const G = makeGraph(0.5);
    const sr = makeResult();
    applyOutcomeMoodNudge(G, sr, true, false, 0);
    expect(G.getAgent("self").mood_valence).toBe(0.5);
    expect(readEmotionEpisodes(G)).toHaveLength(0);
  });

  it("非零 delta 时不重置 legacy mood_set_ms", () => {
    const G = makeGraph(0);
    const sr = makeResult();
    applyOutcomeMoodNudge(G, sr, true, false, SCALE);
    expect(G.getAgent("self").mood_set_ms).toBe(0);
  });

  // -- 无 self agent → 安全退出 ------------------------------------------------

  it("无 self agent → 不崩溃", () => {
    const G = new WorldModel(); // 无 self
    const sr = makeResult();
    expect(() => {
      applyOutcomeMoodNudge(G, sr, true, false, SCALE);
    }).not.toThrow();
  });
});
