/**
 * ReAct Pipeline 类型定义 — 所有模块的共享类型。
 *
 * @see docs/adr/140-react-efficiency-architecture.md
 */

// ── 从旧代码导入 + re-export 的类型（保持单一真相来源）──────────────────

export type { ScriptExecutionResult } from "../../core/script-execution.js";

import type { ScriptExecutionResult } from "../../core/script-execution.js";

export type { VoiceAction } from "../../voices/personality.js";
export type { ActionQueueItem } from "../action-queue.js";

// ── SubcycleResult: ReAct 子周期输出 ────────────────────────────────────

/**
 * ReAct 子周期的输出。outcome 字段决定 engagement 循环的分支。
 *
 * ADR-214 Wave B: 删除 ExecutableResult/RecordedAction re-export。
 */
export interface SubcycleResult {
  /** 子周期退出原因——决定 orchestrator 的后续分支。 */
  outcome:
    | "waiting_reply"
    | "watching"
    | "terminal"
    | "empty"
    | "resting"
    | "fed_up"
    | "cooling_down"
    | "tc_budget_exhausted";
  /** 子周期内累积的脚本执行事实。 */
  execution: ScriptExecutionResult;
  /** 脚本执行总耗时（毫秒）。 */
  duration: number;
  /** D5: 实际使用的 ReAct 轮次数（0-based count）。 */
  roundsUsed: number;
  /** ADR-232: episode 内 TC 续轮次数（host 触发的额外 LLM 调用轮数）。 */
  episodeRounds: number;
  /** ADR-235: TC 循环可观测性元数据。 */
  tcMeta?: import("../tick/types.js").TickTcMeta;
  /** LLM 调用失败分类。 */
  failureKind?: import("../tick/callLLM.js").TickFailureKind;
}
