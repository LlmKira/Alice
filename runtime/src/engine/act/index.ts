/**
 * ACT 线程：从 ActionQueue 取行动 → LLM 生成 shell script → shell-native executor 执行。
 *
 * ADR-142: 核心循环已迁移到 engine/tick/（Blackboard Tick + SAA）。
 * 此文件保留为导出聚合层。
 *
 * @see docs/adr/142-action-space-architecture/README.md
 * @see docs/adr/140-react-efficiency-architecture.md
 */

// ── 核心入口 ──────────────────────────────────────────────────────────────

export { type ActContext, startReActLoop as startActLoop } from "../react/orchestrator.js";

// ── Tick 管线（ADR-142 新增）─────────────────────────────────────────────

export { runTickSubcycle } from "../tick/bridge.js";
export type { TickResult } from "../tick/types.js";

// ── 共享模块 ──────────────────────────────────────────────────────────────

export { formatQueryObservations } from "../../telegram/query-observations.js";
export {
  type AdaptiveCooldownOpts,
  adaptiveGamma,
  classifyFailure,
  computeAdaptiveCooldown,
  computeEAProxy,
  type EngagementMetrics,
  type FailureSubtype,
  type FailureType,
  logPersonalityEvolution,
} from "../react/feedback-arc.js";
export { extractRuntimeConfig } from "./runtime-config.js";

// ── act/ 叶子模块 ────────────────────────────────────────────────────────

export { buildActionFooter } from "../tick/prompt-builder.js";
export { EngagementSession } from "./engagement.js";
export { diffuseReplyChain } from "./messages.js";
export {
  type ActiveWatcher,
  type DeferredTurnOutcome,
  type EngagementSlot,
  MAX_CONCURRENT_ENGAGEMENTS,
  SWITCH_COST_MS,
  type WatchPlan,
} from "./scheduler.js";
