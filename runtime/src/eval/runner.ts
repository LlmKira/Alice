/**
 * ADR-136: Eval Runner — 统一到生产 tick() 的端到端评估执行器。
 *
 * 核心流程（每场景每次运行）：
 * 1. createEvalFixture → 组装 fixture
 * 2. buildEvalTickDeps → 构建 eval 专用 TickDeps（录制模式）
 * 3. tick(board, allTools, deps, ctx) → 调用生产 tick 循环
 * 4. gradeStructural → 分层评分（goal/budget/process）
 *
 * 设计决策：
 * - 直接调用生产 tick()，通过 TickDeps 注入 eval 行为差异
 * - LLM 调用使用独立的 evalCallLLM，允许 temperature 覆盖 + 跳过审计
 * - 不执行 Telegram 动作（录制模式）——只关心决策，不关心执行
 * - eval 消息是静态的，不 fetch
 * - 消融实验通过 deps.buildPrompt 路由
 * - 诊断快照通过 deps.onStep 收集
 *
 * @see docs/adr/136-model-eval-suite.md
 * @see docs/adr/142-action-space-architecture/README.md
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { generateText } from "ai";
import { type Config, getLlmProviderByRoute, loadConfig } from "../config.js";
import { mergeScriptExecutionResults } from "../core/script-execution.js";
import { extractRuntimeConfig } from "../engine/act/runtime-config.js";
import { collectAllTools } from "../engine/tick/affordance-filter.js";
import { createBlackboard } from "../engine/tick/blackboard.js";
import { type TickDeps, tick } from "../engine/tick/tick.js";
import type { FeatureFlags, TickResult, ToolCategory } from "../engine/tick/types.js";
import type { WorldModel } from "../graph/world-model.js";
import { getEvalProvider, initProviders } from "../llm/client.js";
import { parseTickStep } from "../llm/schemas.js";
import { TELEGRAM_ACTIONS } from "../telegram/actions/index.js";
import { createLogger } from "../utils/logger.js";
import { buildAblationPrompt } from "./ablation.js";
import { type EvalCache, isCachedPass, loadCache, saveCache } from "./cache.js";
import { createEvalFixture, type EvalFixture, setupEvalDb, teardownEvalDb } from "./fixtures.js";
import { gradeStructural, toEvalTickResult } from "./graders.js";
import { ALL_SCENARIOS } from "./scenarios/index.js";
import type {
  AblationCondition,
  AggregatedStat,
  EvalReport,
  EvalRunnerConfig,
  EvalRunResult,
  EvalScenario,
  ScenarioAggregateResult,
} from "./types.js";

const log = createLogger("eval");

// ── Eval LLM 调用 ─────────────────────────────────────────────────────────

type EvalLLMResult = {
  script: string;
  afterward: "done" | "waiting_reply" | "watching" | "resting" | "fed_up" | "cooling_down";
};

/**
 * Eval 专用 LLM 调用 — 与 callTickLLM 逻辑一致，
 * 但允许 temperature 覆盖 + 不写审计日志。
 *
 * @see docs/adr/211-instructor-js-script-prevalidation.md
 */
async function evalCallLLM(
  system: string,
  user: string,
  temperature: number,
  timeout: number,
): Promise<EvalLLMResult | null> {
  try {
    const { provider, model } = getEvalProvider();
    const { text } = await generateText({
      model: provider(model),
      system,
      prompt: user,
      temperature,
      abortSignal: AbortSignal.timeout(timeout),
    });
    const step = parseTickStep(text);
    return { script: step.script, afterward: step.afterward };
  } catch (e) {
    log.error("Eval LLM call failed", e);
    return null;
  }
}

// ── FeatureFlags 推导 ─────────────────────────────────────────────────────

/** 从 eval Config + Graph 推导 FeatureFlags（与 tick/bridge.ts 逻辑一致）。 */
function deriveEvalFeatureFlags(config: Config, G: WorldModel): FeatureFlags {
  return {
    hasWeather: true,
    hasMusic: !!config.musicApiBaseUrl,
    hasBrowser: !!config.exaApiKey,
    hasTTS: !!config.ttsBaseUrl && !!config.ttsApiKey,
    hasStickers: G.has("self") && Array.isArray(G.getDynamic("self", "installed_stickers")),
    hasBots: G.getEntitiesByType("contact").some((id) => G.getContact(id).is_bot === true),
    hasSystemThreads: G.getEntitiesByType("thread").some(
      (tid) => G.getThread(tid).source === "system" && G.getThread(tid).status === "open",
    ),
    hasVideo: !!config.youtubeApiKey,
  };
}

// ── Eval TickDeps 构建 ──────────────────────────────────────────────────

/** 诊断数据容器 — onStep 回调回写。 */
interface EvalDiagnostics {
  promptSnapshots: Array<{ round: number; system: string; user: string; script: string | null }>;
}

/**
 * 构建 eval 专用的 TickDeps — 将 eval fixture 适配到生产 tick() 接口。
 *
 * 与生产版 buildTickDeps（bridge.ts）的差异：
 * - callLLM: 使用 evalCallLLM（temperature 覆盖 + 无审计日志）
 * - executeActions: no-op（录制模式，不执行 Telegram 动作）
 * - fetchMessages: 空（eval 消息是静态的）
 * - buildPrompt: 消融条件路由（contextVars.__ablation_condition）
 * - onStep: 诊断快照收集
 */
function buildEvalTickDeps(
  _fx: EvalFixture,
  temperature: number,
  timeout: number,
  ablationCondition: AblationCondition | undefined,
  diagnostics: EvalDiagnostics,
): TickDeps {
  return {
    callLLM: async (system, user, _tick, _target, _voice, _contextVars) => {
      const result = await evalCallLLM(system, user, temperature, timeout);
      if (!result) return null;
      return {
        afterward: result.afterward,
        toolCallCount: 1,
        budgetExhausted: false,
        rawScript: result.script,
        commandOutput: `$ ${result.script}\n(eval)`,
        logs: [result.script],
        errors: [],
        instructionErrors: [],
        errorCodes: [],
        duration: 0,
        thinks: [],
        queryLogs: [],
        observations: [],
        completedActions: [],
        silenceReason: null,
        llmProvider: "eval",
        llmModel: "eval",
      };
    },

    // 消融路由
    buildPrompt:
      ablationCondition && ablationCondition !== "full"
        ? (board, allTools, ctx) => buildAblationPrompt(ablationCondition, board, allTools, ctx)
        : undefined,

    // 诊断快照
    onStep: (info) => diagnostics.promptSnapshots.push(info),
  };
}

// ── Multi-round: App stay() 模拟 ──────────────────────────────────────────
//
// BT 框架的核心价值是多步执行。当 LLM 正确使用 stay() 等待 App 异步结果时，
// eval 必须模拟 round 2（注入模拟 App 结果 → 重新 tick），否则只测了半个 BT 循环。
//
// 生产流程：round 1 → stay() → watcher 等待 → round 2 拿到结果 → send_message
// eval 模拟：round 1 → stay() → 注入 mock 结果 → round 2 → 合并两轮结果评分

/** 提取 App 异步调用动作（use_*_app 模式）。
 * ADR-214 Wave A: TickResult 不再有 actions。此函数始终返回空数组。
 * Wave B 将基于 completedActions 重写。
 */
function getAppActions(_actions: unknown): Array<{ fn: string; args?: Record<string, unknown> }> {
  return [];
}

/**
 * 为 App 调用生成模拟结果（eval round 2 注入用）。
 *
 * 格式设计：`[use_X_app 结果] 具体数据`
 * - 前缀包含原始函数名，让 LLM 关联"这是我上一步调用的结果"
 * - 数据足够具体以支持 LLM 生成有意义的回复
 */
function mockAppResults(actions: Array<{ fn: string; args?: Record<string, unknown> }>): string[] {
  return getAppActions(actions).map((a) => {
    const q = String(a.args?.query ?? a.args?.location ?? a.args?.date ?? a.args?.event ?? "");
    switch (a.fn) {
      case "use_weather_app":
        return `[${a.fn} 结果] ${q || "目标城市"}：多云，25°C，东南风 2-3 级，适合出行`;
      case "use_calendar_app":
        return `[${a.fn} 结果] ${q || "查询日期"}：星期三，工作日`;
      case "use_countdown_app":
        return `[${a.fn} 结果] 距离${q || "目标日期"}还有 123 天`;
      case "use_video_app":
        return `[${a.fn} 结果] 搜索"${q}": 1. 经典教程 (12min) 2. 快速入门 (8min) 3. 进阶指南 (15min)`;
      case "google":
        return `[${a.fn} 结果] 搜索"${q}": 最新 iPhone 16 于 2025 年 9 月发布，起售价 $799`;
      case "visit":
        return `[${a.fn} 结果] 网页摘要: ${q || "页面内容概述"}，关键信息已提取`;
      case "use_trending_app":
        return `[${a.fn} 结果] 1. #科技新突破 (1.2亿阅读) 2. #春季养生 (8000万阅读) 3. #新片上映 (6500万阅读)`;
      case "use_music_app":
        return `[${a.fn} 结果] 1. 夜的钢琴曲 — 石进 2. River Flows in You — 李闰珉`;
      default:
        return `[${a.fn} 结果] 查询完成`;
    }
  });
}

/**
 * 合并两轮 TickResult — round 2 的 outcome 为准，其余累积。
 */
function mergeTickResults(r1: TickResult, r2: TickResult): TickResult {
  return {
    outcome: r2.outcome,
    observations: [...r1.observations, ...r2.observations],
    execution: mergeScriptExecutionResults([r1.execution, r2.execution]),
    stepsUsed: r1.stepsUsed + r2.stepsUsed,
    preparedCategories: [
      ...new Set([...r1.preparedCategories, ...r2.preparedCategories]),
    ] as ToolCategory[],
    duration: r1.duration + r2.duration,
    episodeRounds: r1.episodeRounds + r2.episodeRounds,
  };
}

// ── 单场景运行 ─────────────────────────────────────────────────────────────

async function runScenarioOnce(
  scenario: EvalScenario,
  runIndex: number,
  config: EvalRunnerConfig,
  dumpDir?: string,
): Promise<EvalRunResult> {
  const start = Date.now();

  setupEvalDb();
  try {
    const fx = createEvalFixture(scenario);

    // 1. 推导 FeatureFlags + 收集全量工具
    const features = deriveEvalFeatureFlags(fx.ctx.config, fx.graph);
    const allTools = collectAllTools(fx.dispatcher.mods, TELEGRAM_ACTIONS);

    // 2. 创建 Blackboard
    const board = createBlackboard({
      pressures: fx.ctx.getCurrentPressures(),
      voice: fx.item.action,
      target: fx.item.target ?? null,
      features,
      contextVars: fx.contextVars,
    });

    // 3. 构建 eval TickDeps
    const ablationCondition = fx.contextVars.__ablation_condition as AblationCondition | undefined;
    const diagnostics: EvalDiagnostics = { promptSnapshots: [] };
    const deps = buildEvalTickDeps(
      fx,
      config.temperature,
      config.timeout,
      ablationCondition,
      diagnostics,
    );

    // 4. 调用生产 tick()
    const tickCtx = {
      G: fx.graph,
      dispatcher: fx.dispatcher,
      mods: fx.dispatcher.mods,
      config: fx.ctx.config,
      item: fx.item,
      tick: fx.tick,
      messages: fx.messages,
      observations: [] as string[],
      round: 0,
      nowMs: fx.nowMs,
      client: null as null,
      runtimeConfig: extractRuntimeConfig(fx.ctx.config),
    };
    let result = await tick(board, allTools, deps, tickCtx);

    // 4b. Multi-round: App continuation (stay/expect_reply)
    // 当 LLM 使用 stay() 或 expect_reply() 等待 App 异步结果时，模拟 round 2。
    // 复现生产 engagement watcher：round 1 调用 App → round 2 拿到结果后回复。
    // LLM 可能用 stay()（观望等待）或 expect_reply()（等待回复），两者都是合法的等待信号。
    // ADR-214 Wave A: getAppActions 始终返回空（TickResult 无 actions 字段）。
    // Multi-round eval 暂时禁用，Wave B 将基于 completedActions 重写。
    const appActions = getAppActions(null);
    const isWaiting = result.outcome === "watching" || result.outcome === "waiting_reply";
    if (isWaiting && appActions.length > 0) {
      log.info(
        `  → ${result.outcome}() with ${appActions.length} app action(s), simulating round 2`,
      );

      // 保存 round 1 数据（board arrays 与 result 共享引用，必须先拷贝）
      const r1: TickResult = {
        ...result,
        observations: [...result.observations],
        execution: {
          logs: [...result.execution.logs],
          errors: [...result.execution.errors],
          instructionErrors: [...result.execution.instructionErrors],
          errorCodes: [...result.execution.errorCodes],
          duration: result.execution.duration,
          thinks: [...result.execution.thinks],
          queryLogs: [...result.execution.queryLogs],
          observations: [...result.execution.observations],
          completedActions: [...result.execution.completedActions],
          silenceReason: result.execution.silenceReason,
        },
        preparedCategories: [...result.preparedCategories],
      };

      // 重置 board 可变状态（保留 preparedCategories — 兼容旧 eval 断言）
      const appObs = mockAppResults([]);
      board.observations = appObs;
      board.execution = mergeScriptExecutionResults([]);
      board.budget.usedSteps = 0;

      // Round 2
      const r2 = await tick(board, allTools, deps, {
        ...tickCtx,
        round: 1,
        observations: appObs,
      });

      result = mergeTickResults(r1, r2);
    }

    // 5. 评分
    const structural = gradeStructural(
      toEvalTickResult(result),
      scenario.structural,
      result.stepsUsed,
    );

    // ADR-139: prompt dump — 失败场景导出诊断快照
    if (dumpDir && !structural.pass && diagnostics.promptSnapshots.length > 0) {
      const safeId = scenario.id.replace(/[^a-zA-Z0-9._-]/g, "_");
      for (let si = 0; si < diagnostics.promptSnapshots.length; si++) {
        const snap = diagnostics.promptSnapshots[si];
        // 用数组索引替代 snap.round 避免多轮 tick 中 usedSteps 重置导致文件名冲突
        const prefix = `${dumpDir}/${safeId}_s${si}`;
        writeFileSync(`${prefix}_system.txt`, snap.system, "utf-8");
        writeFileSync(`${prefix}_user.txt`, snap.user, "utf-8");
        if (snap.script) writeFileSync(`${prefix}_script.js`, snap.script, "utf-8");
      }
    }

    return {
      scenarioId: scenario.id,
      runIndex,
      script: result.execution.thinks.join("\n") || null,
      steps: result.stepsUsed,
      structural,
      duration: Date.now() - start,
      errors: result.execution.errors,
      // `needs` 是旧 eval 输出字段名；值来自 legacy preparedCategories。
      needs: result.preparedCategories as string[],
    };
  } catch (e) {
    return {
      scenarioId: scenario.id,
      runIndex,
      script: null,
      steps: 0,
      structural: { pass: false, checks: [], score: 0 },
      duration: Date.now() - start,
      errors: [e instanceof Error ? e.message : String(e)],
    };
  } finally {
    teardownEvalDb();
  }
}

// ── 聚合 ───────────────────────────────────────────────────────────────────

function aggregateScenario(scenario: EvalScenario, runs: EvalRunResult[]): ScenarioAggregateResult {
  const structuralPasses = runs.filter((r) => r.structural.pass).length;
  return {
    scenarioId: scenario.id,
    title: scenario.title,
    tags: scenario.tags,
    expectedIntent: scenario.structural.expectedIntent,
    expectedBranch: scenario.structural.expectedBranch,
    runs,
    passAtK: structuralPasses > 0,
    passAllK: structuralPasses === runs.length,
    passRate: runs.length > 0 ? structuralPasses / runs.length : 0,
  };
}

// ── 主入口 ──────────────────────────────────────────────────────────────────

/** 可选参数对象 — 替代位置参数，支持后续扩展。 */
export interface EvalSuiteOptions {
  /** 场景列表（默认全部 BRANCH_SCENARIOS） */
  readonly scenarios?: readonly EvalScenario[];
  /** 每完成一个场景的所有 runs 后回调（用于 CLI 流式输出） */
  readonly onScenarioComplete?: (result: ScenarioAggregateResult) => void;
  /** ADR-139: 失败场景 prompt dump 目录。设置后自动导出失败场景的 system/user/script。 */
  readonly dumpDir?: string;
  /** 跳过已 pass 的场景（默认 true — 顺序测试模式）。设为 false 全量重跑。 */
  readonly skipPassed?: boolean;
  /** 遇到 FAIL 不停止（默认 false — fail-fast 模式）。设为 true 跑完所有场景。 */
  readonly runAll?: boolean;
}

/**
 * 运行完整 eval suite。
 *
 * @param config — eval runner 配置
 * @param options — 可选参数（场景列表、流式回调等）
 */
export async function runEvalSuite(
  config: EvalRunnerConfig,
  options?: EvalSuiteOptions,
): Promise<EvalReport> {
  // 初始化 LLM provider
  const runtimeConfig = loadConfig();
  initProviders(runtimeConfig);

  const allScenarios = options?.scenarios ?? ALL_SCENARIOS;

  // 过滤
  let filtered: readonly EvalScenario[] = allScenarios;
  if (config.filterTags && config.filterTags.length > 0) {
    const tags = new Set(config.filterTags);
    filtered = filtered.filter((s) => s.tags.some((t) => tags.has(t)));
  }
  if (config.filterPrefix) {
    const prefix = config.filterPrefix;
    filtered = filtered.filter((s) => s.id.startsWith(prefix));
  }

  // ADR-139: prompt dump 目录初始化
  const dumpDir = options?.dumpDir;
  if (dumpDir) {
    mkdirSync(dumpDir, { recursive: true });
    log.info(`Prompt dump enabled → ${dumpDir}`);
  }

  // ── 缓存：顺序测试 skip-on-pass ──
  const skipPassed = options?.skipPassed ?? true;
  const cache: EvalCache = skipPassed ? loadCache() : {};
  let skippedCount = 0;

  const results: ScenarioAggregateResult[] = [];

  for (const scenario of filtered) {
    // Skip-on-pass: 已 pass 的场景生成 cached 结果，不调用 LLM
    if (skipPassed && isCachedPass(cache, scenario.id)) {
      skippedCount++;
      const cachedAgg: ScenarioAggregateResult = {
        scenarioId: scenario.id,
        title: scenario.title,
        tags: scenario.tags,
        expectedIntent: scenario.structural.expectedIntent,
        expectedBranch: scenario.structural.expectedBranch,
        runs: [],
        passAtK: true,
        passAllK: true,
        passRate: 1,
        cached: true,
      };
      results.push(cachedAgg);
      options?.onScenarioComplete?.(cachedAgg);
      continue;
    }

    const runs: EvalRunResult[] = [];
    for (let i = 0; i < config.runs; i++) {
      log.info(`Running ${scenario.id} [${i + 1}/${config.runs}]`);
      const result = await runScenarioOnce(scenario, i, config, dumpDir);
      runs.push(result);
    }
    const agg = aggregateScenario(scenario, runs);
    results.push(agg);
    options?.onScenarioComplete?.(agg);

    // 写入缓存（每个场景完成后立即持久化，中断不丢进度）
    cache[scenario.id] = {
      pass: agg.passAtK,
      timestamp: new Date().toISOString(),
      model: config.providerName ?? getLlmProviderByRoute(runtimeConfig, "eval")?.model,
      passRate: agg.passRate,
    };
    saveCache(cache);

    // Fail-fast: 遇到失败立即停止，不浪费后续 LLM 调用
    if (!agg.passAtK && !options?.runAll) {
      log.info(`FAIL on ${scenario.id} — stopping (use --full to continue past failures)`);
      break;
    }
  }

  if (skippedCount > 0) {
    log.info(`Skipped ${skippedCount} cached-pass scenarios (use --full to re-run all)`);
  }

  // ── 按标签聚合（只统计实际运行的场景）──
  const tagStats: Record<string, AggregatedStat> = {};
  for (const agg of results) {
    if (agg.cached) continue; // 缓存跳过的不计入统计
    for (const tag of agg.tags) {
      if (!tagStats[tag]) tagStats[tag] = { pass: 0, total: 0, rate: 0 };
      tagStats[tag].total += agg.runs.length;
      tagStats[tag].pass += agg.runs.filter((r) => r.structural.pass).length;
    }
  }
  for (const stat of Object.values(tagStats)) {
    stat.rate = stat.total > 0 ? stat.pass / stat.total : 0;
  }

  // ── 按社交意图聚合（ADR-138：Intent 取代 Branch 为主聚合维度）──
  // 可接受集场景按第一个意图归类（主意图）
  const intentStats: Record<string, AggregatedStat> = {};
  for (const agg of results) {
    if (agg.cached) continue; // 缓存跳过的不计入统计
    const raw = agg.expectedIntent;
    const intent = Array.isArray(raw) ? raw[0] : raw;
    if (!intentStats[intent]) intentStats[intent] = { pass: 0, total: 0, rate: 0 };
    intentStats[intent].total += agg.runs.length;
    intentStats[intent].pass += agg.runs.filter((r) => r.structural.pass).length;
  }
  for (const stat of Object.values(intentStats)) {
    stat.rate = stat.total > 0 ? stat.pass / stat.total : 0;
  }

  return {
    model:
      config.providerName ?? getLlmProviderByRoute(runtimeConfig, "eval")?.model ?? "unknown",
    timestamp: new Date().toISOString(),
    totalScenarios: filtered.length,
    runsPerScenario: config.runs,
    scenarios: results,
    tagStats,
    intentStats,
  };
}
