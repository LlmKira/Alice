/**
 * Tick Bridge — 将 Blackboard Tick 管线适配到现有 orchestrator 接口。
 *
 * 职责：
 * 1. 从 ActContext + ActionQueueItem 派生 FeatureFlags + Blackboard
 * 2. 组装 TickDeps（从现有模块函数包装）
 * 3. 调用 tick() 核心循环
 * 4. 将 TickResult 转换为 SubcycleResult（供现有 orchestrator 消费）
 *
 * @see docs/adr/142-action-space-architecture/README.md
 */

import type { ActionRuntimeConfig } from "../../core/action-executor.js";
import { getDb } from "../../db/connection.js";
import { type AvailableProvider, selectProviderForTick } from "../../llm/client.js";
import { TELEGRAM_ACTIONS } from "../../telegram/actions/index.js";
import { hasPaletteEntries } from "../../telegram/apps/sticker-palette.js";
import type { PressureDims } from "../../utils/math.js";
import type { EngagementSession } from "../act/engagement.js";
import type { MessageRecord } from "../act/messages.js";
import { extractRuntimeConfig } from "../act/runtime-config.js";
import type { ActionQueueItem } from "../action-queue.js";
import type { ActContext } from "../react/orchestrator.js";
import type { SubcycleResult } from "../react/types.js";
import { collectAllTools } from "./affordance-filter.js";
import { createBlackboard } from "./blackboard.js";
import { callTickLLM } from "./callLLM.js";
import type { TickPromptContext } from "./prompt-builder.js";
import type { ResolvedTarget } from "./target.js";
import { type TickDeps, tick } from "./tick.js";
import type { FeatureFlags, TickResult, UnifiedTool } from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════
// FeatureFlags 派生
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 从 ActContext 派生运行时 FeatureFlags。
 *
 * 每个 flag 对应一个硬门禁条件：
 * - 配置型（hasMusic, hasBrowser, hasTTS, hasVideo）：取决于 API key / URL 是否配置
 * - 图型（hasStickers, hasBots, hasSystemThreads）：取决于 WorldModel 实体状态
 * - 永真型（hasWeather）：天气 API (wttr.in) 免费无 key
 */
function deriveFeatureFlags(ctx: ActContext): FeatureFlags {
  const { config, G } = ctx;
  return {
    hasWeather: true, // wttr.in 免费，始终可用
    hasMusic: !!config.musicApiBaseUrl,
    hasBrowser: !!config.exaApiKey,
    hasTTS: !!config.ttsBaseUrl && !!config.ttsApiKey,
    hasVideo: !!config.youtubeApiKey,
    hasStickers:
      hasPaletteEntries(getDb()) ||
      (G.has("self") && Array.isArray(G.getDynamic("self", "installed_stickers"))),
    hasBots: G.getEntitiesByType("contact").some((id) => G.getContact(id).is_bot === true),
    hasSystemThreads: G.getEntitiesByType("thread").some(
      (tid) => G.getThread(tid).source === "system" && G.getThread(tid).status === "open",
    ),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TickResult → SubcycleResult 类型转换
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 将 TickResult 转换为 SubcycleResult。
 *
 * 映射规则：
 * - stepsUsed → roundsUsed（语义等价，名称不同）
 * - observations/preparedCategories 仅存在于 TickResult，不映射
 */
function toSubcycleResult(result: TickResult): SubcycleResult {
  return {
    outcome: result.outcome,
    execution: result.execution,
    duration: result.duration,
    roundsUsed: result.stepsUsed,
    episodeRounds: result.episodeRounds,
    tcMeta: result.tcMeta,
    failureKind: result.failureKind,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TickDeps 组装
// ═══════════════════════════════════════════════════════════════════════════

function buildTickDeps(): TickDeps {
  return {
    callLLM: async (system, user, tick, target, voice, contextVars, selectedProvider) => {
      return callTickLLM(system, user, tick, target, voice, contextVars, selectedProvider);
    },

    // ADR-214 Wave A: resolveQueries 已删除。
    // shell-native 架构下 scriptResult.actions 始终为空，
    // resolveQueries 从未执行有意义的工作。
    // Query 动作通过容器内 Engine API HTTP 直接执行。
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 共享 tick 运行上下文
// ═══════════════════════════════════════════════════════════════════════════

/** tick() 的完整上下文类型 — TickPromptContext + 运行时依赖。 */
type TickRunContext = TickPromptContext & {
  client: unknown;
  runtimeConfig: ActionRuntimeConfig;
  llmProvider: AvailableProvider;
};

/** tick() 运行所需的全部预备产物。 */
interface TickRunKit {
  board: ReturnType<typeof createBlackboard>;
  allTools: readonly UnifiedTool[];
  deps: TickDeps;
}

/**
 * 构建 tick() 运行所需的 Blackboard + 工具列表 + 依赖。
 * 提取共享逻辑供 runTickSubcycle 使用。
 */
function prepareTickRun(
  ctx: ActContext,
  item: ActionQueueItem,
  contextVars: Record<string, unknown>,
  opts?: { maxSteps?: number },
): TickRunKit {
  const features = deriveFeatureFlags(ctx);
  const pressures = ctx.getCurrentPressures() as PressureDims;

  const board = createBlackboard({
    pressures,
    voice: item.action,
    target: item.target ?? null,
    features,
    contextVars,
    maxSteps: opts?.maxSteps,
  });

  const allTools = collectAllTools(ctx.dispatcher.mods, TELEGRAM_ACTIONS);
  const deps = buildTickDeps();

  return { board, allTools, deps };
}

/** 从 ActContext 组装 tick() 所需的 TickRunContext。 */
function buildTickRunContext(
  ctx: ActContext,
  item: ActionQueueItem,
  currentTick: number,
  messages: MessageRecord[],
  observations: string[],
  llmProvider: AvailableProvider,
): TickRunContext {
  return {
    G: ctx.G,
    dispatcher: ctx.dispatcher,
    mods: ctx.dispatcher.mods,
    config: ctx.config,
    item,
    tick: currentTick,
    messages,
    observations,
    round: 0,
    client: ctx.client,
    runtimeConfig: extractRuntimeConfig(ctx.config),
    llmProvider,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 公共 API — 替代 runReActSubcycle 的直接替换函数
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 运行 Blackboard Tick 子周期 — orchestrator.ts 的 drop-in 替换。
 *
 * ADR-169 结构性重构：查询解析和错误驱动续轮已内化到 tick() 循环中。
 * bridge 层只负责组装 Blackboard + deps + context，不做续轮逻辑。
 *
 * @see docs/adr/169-fire-query-auto-continuation.md
 */
export async function runTickSubcycle(
  ctx: ActContext,
  item: ActionQueueItem,
  currentTick: number,
  _targetChatId: number | null,
  liveMessages: MessageRecord[],
  _resolved: ResolvedTarget | null,
  contextVars: Record<string, unknown> | undefined,
  _session: EngagementSession,
): Promise<SubcycleResult> {
  const { board, allTools, deps } = prepareTickRun(ctx, item, contextVars ?? {});
  const llmProvider = selectProviderForTick();

  const tickCtx = buildTickRunContext(
    ctx,
    item,
    currentTick,
    liveMessages,
    board.observations,
    llmProvider,
  );
  const result = await tick(board, allTools, deps, tickCtx);
  // ADR-215: 将 LLM residue 透传到 ActionQueueItem → processResult 消费
  if (result.llmResidue) item.llmResidue = result.llmResidue;
  return toSubcycleResult(result);
}

// ADR-214 Wave B: runCorrectionTick 已删除。
// shell-native 架构下 Telegram 动作通过容器内 Engine API HTTP 直接执行，
// correction tick 的机械重试和 LLM 修正均为死代码。
