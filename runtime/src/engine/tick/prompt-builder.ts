/**
 * Blackboard Tick Prompt 构建器 — 从 Blackboard 状态组装 LLM prompt。
 *
 * - Shell Manual：真实命令空间 + engine bridge
 * - Capability Guide：从 CAPABILITY_FAMILIES + 工具 affordance 生成 man <category> 填写指南
 * - 复用叶子函数：resolveTarget, timeline
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ⚠ PROMPT 诚实性原则（ADR-209）
 *
 * Alice 不知道引擎的存在。她只是一个人。每行 prompt 内容必须满足以下条件之一：
 *   □ 是真实世界的观察事实（"Leo 10 分钟前发了消息"）
 *   □ 是人类可理解的语义标签（"你最近有点冷淡"）
 *   □ 是情境提示，不是指令（"群里有人在吵架"，不是"不要插话"）
 *
 * 绝对禁止：
 *   ✗ 不暴露系统术语（tick, voice, pressure, mod, stage, step）
 *   ✗ 不暴露原始数值（百分比、计数、ID）——必须用语义标签
 *   ✗ 不解释"为什么"系统这样设计（LLM 只关心现象，不关心原因）
 *   ✗ 不发元指令（"Decide what to do." / "Make your decision now."）
 *   ✗ 不说"Your instinct:"（系统标签前缀）
 * ═══════════════════════════════════════════════════════════════════════
 *
 * @see docs/adr/142-action-space-architecture/README.md
 * @see docs/adr/163-expand-instruction-bt-native-disclosure.md §17
 * @see docs/adr/209-tui-native-prompt.md — 诚实性原则
 */

import { CAPABILITY_FAMILIES } from "../../core/capability-families.js";
import type { Dispatcher } from "../../core/dispatcher.js";
import { enforcePromptStyle } from "../../core/prompt-style.js";
import { generateShellManual } from "../../core/shell-manual.js";
import { estimateTokens, renderContributionsByZone } from "../../core/storyteller.js";
import type { ModDefinition } from "../../core/types.js";
import { applyVisibilityFilter, buildAudienceContext } from "../../core/visibility.js";
import { findActiveConversation } from "../../graph/queries.js";
import type { WorldModel } from "../../graph/world-model.js";
import { getInjectableFeedItems } from "../../mods/feeds.mod.js";
import { buildUserPromptSnapshot, renderUserPrompt } from "../../prompt/index.js";
import { createLogger } from "../../utils/logger.js";
import { humanDuration } from "../../utils/time-format.js";
import { getFacetTags, getFacetWhisper } from "../../voices/palette.js";
import type { MessageRecord } from "../act/messages.js";
import { computeChannelPresence } from "../act/presence.js";
import { GLOBAL_TOKEN_BUDGET } from "../act/prompt-budget.js";
import { buildShellGuide } from "../act/shell-guide.js";
import type { ActionQueueItem } from "../action-queue.js";
import { resolveTarget } from "./target.js";
import type { Blackboard, FeatureFlags, UnifiedTool } from "./types.js";

const log = createLogger("tick/prompt");

// ═══════════════════════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════════════════════

/** prompt-builder 所需的最小上下文（依赖注入，不直接用 ActContext）。 */
export interface TickPromptContext {
  G: WorldModel;
  dispatcher: Dispatcher;
  mods: readonly ModDefinition[];
  config: {
    budgetZones?: Record<string, number>;
    ttsBaseUrl?: string;
    ttsApiKey?: string;
    exaApiKey?: string;
    musicApiBaseUrl?: string;
    peripheral: {
      perChannelCap: number;
      totalCap: number;
      minTextLength: number;
    };
  };
  item: ActionQueueItem;
  tick: number;
  messages: MessageRecord[];
  observations: string[];
  round: number;
  /** ADR-232: episode 内 TC 续轮次数（watching 触发的额外轮数）。0 = 首轮。 */
  episodeRound?: number;
  /** 墙钟时间覆盖（ms）。省略时使用 Date.now()。Eval 用固定时间戳消除时间漂移。 */
  nowMs?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Capability Guide — 从工具 affordance 生成 needs 填写指南
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 从 contextual 工具的 affordance 元数据生成 Capability Guide。
 * 告诉 LLM 可以通过 man <category> 激活哪些类别，以及何时该激活。
 *
 * always 工具不需要出现（始终可见），on-demand 不通过 needs 激活。
 * 只渲染 contextual 工具的 category + whenToUse。
 *
 * hardgate 过滤：requires 指定的 FeatureFlag 为 false 时，
 * 该工具不渲染到 guide 中——避免误导模型 prepare 不可用的 categories。
 */
export function buildCapabilityGuide(
  allTools: readonly UnifiedTool[],
  features?: Readonly<FeatureFlags>,
): string {
  // ADR-196 F9: 只追踪 category 存在性（函数名不再渲染，与 .d.ts 去重）
  const categories = new Set<string>();
  // 从 per-tool affordance 收集 whenToUse / whenNotToUse 作为 App 族的 fallback
  const toolWhenToUse = new Map<string, string>();
  const toolWhenNotToUse = new Map<string, string>();

  for (const tool of allTools) {
    const { affordance } = tool;
    if (affordance.priority !== "capability") continue;

    // hardgate: requires 指定的 feature 必须为 true，否则跳过
    if (features && affordance.requires && !features[affordance.requires]) continue;

    if (!categories.has(affordance.category)) {
      categories.add(affordance.category);
      // 首个 tool 的 whenToUse/whenNotToUse 作为 fallback（App 族没有 CAPABILITY_FAMILIES 条目）
      toolWhenToUse.set(affordance.category, affordance.whenToUse);
      if (affordance.whenNotToUse) {
        toolWhenNotToUse.set(affordance.category, affordance.whenNotToUse);
      }
    }
  }

  if (categories.size === 0) return "";

  const lines: string[] = [
    "## Capability Guide",
    "",
    "Run `<command> --help` for usage details.",
    "",
  ];

  for (const category of categories) {
    // 族注册表是 whenToUse 的唯一真相源；App 族降级到 per-tool affordance
    const family = CAPABILITY_FAMILIES[category as import("../tick/types.js").ToolCategory];
    const whenToUse = family?.whenToUse ?? toolWhenToUse.get(category) ?? category;
    const whenNotToUse = toolWhenNotToUse.get(category);
    if (whenNotToUse) {
      lines.push(`- "${category}": ${whenToUse} (not for: ${whenNotToUse})`);
    } else {
      lines.push(`- "${category}": ${whenToUse}`);
    }
  }

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// buildTickPrompt — 核心 prompt 组装
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 从 Blackboard 状态 + filtered tools 构建 LLM prompt。
 *
 * system = manual + scriptGuide + capabilityGuide + mod contributions
 * user = contextVars + timeline + observations + footer
 *
 * @see docs/adr/142-action-space-architecture/README.md
 */
export async function buildTickPrompt(
  board: Blackboard,
  allTools: readonly UnifiedTool[],
  ctx: TickPromptContext,
): Promise<{ system: string; user: string }> {
  const { G, dispatcher, config, item, tick, messages, observations, round, episodeRound } = ctx;

  const chatType =
    item.target && G.has(item.target)
      ? (G.getChannel(item.target).chat_type ?? "private")
      : "private";
  const isGroup = chatType === "group" || chatType === "supergroup";
  // ADR-206: 频道是信息流实体，独立于 group 和 private 的第三种渲染路径
  const isChannel = chatType === "channel";

  const scriptGuide = buildShellGuide({
    isGroup,
    isChannel,
    facetTags: getFacetTags(item.facetId),
    hasBots: board.features.hasBots,
  });

  // ── 工具手册 + Capability Guide ──
  const manual = await generateShellManual(dispatcher.mods);
  // ADR-223: 扁平工具可见性 — Capability Guide 已删除。
  // 56 个工具 × CLI 签名 ≈ 4000 token，在 12K budget 内。
  // 所有工具签名已通过 Command Catalog + shell manual 扁平展示。
  // 三层折叠（core/capability/on-demand）为省 2000 token 导致搜索等关键工具被永久隐藏。
  // Claude Tool Search 解决的是 500+ JSON schema 工具的问题（每个~1000 token）；
  // Alice 用 CLI 签名（每个~70 token），56 个工具全展开仅 4000 token，不需要搜索机制。

  // ── Zone-aware budget ──
  const footerText = buildActionFooter(G, item, tick, messages, ctx.nowMs);
  let conversationFixedTokens =
    estimateTokens(scriptGuide) + estimateTokens(manual) + estimateTokens(footerText);
  // ADR-223: capGuide removed — tokens reclaimed for flat tool visibility
  if (messages.length > 0) {
    for (const msg of messages) {
      const hasMedia = msg.segments?.some((s) => s.kind === "media" || s.kind === "image");
      const budget = hasMedia ? 500 : 200;
      const preview = msg.text.length > budget ? msg.text.slice(0, budget) : msg.text;
      conversationFixedTokens += estimateTokens(
        `  [00:00] ${msg.senderName} (${msg.id}): ${preview}`,
      );
    }
  }

  // ADR-172: Contribute → Rank → 【Filter】 → Trim → Inject
  // ADR-220: 只收集 header bucket（system prompt 用）。
  // User prompt 完全由新 ECS 管线生成，section/footer bucket 不再需要。
  const rawContributions = dispatcher.collectContributions();
  const headerOnly = rawContributions.filter((c) => c.bucket === "header");
  const audience = buildAudienceContext(G, item.target ?? null, chatType);
  const contributions = applyVisibilityFilter(headerOnly, audience, G);
  const { system: renderedSystem, zoneStats } = renderContributionsByZone(
    contributions,
    GLOBAL_TOKEN_BUDGET,
    config.budgetZones,
    conversationFixedTokens,
  );
  log.debug("Zone budget utilization", zoneStats);

  // ── system prompt 组装 ──
  // manual + scriptGuide + capabilityGuide + mod contributions
  // ADR-223: capGuide removed — all tools visible in shell manual
  const systemParts = [renderedSystem, manual, scriptGuide];
  const system = systemParts.join("\n\n");

  // ── ADR-220: 声明式 User Prompt ──
  const nowMs = ctx.nowMs ?? Date.now();

  // 策略 C: 预收集 mod state（用于联系人画像、群组黑话）
  const relState = dispatcher.readModState<{
    contactProfiles?: Record<
      string,
      {
        portrait?: string;
        traits?: Record<string, { value: number }>;
        crystallizedInterests?: Record<string, { label: string; confidence: number }>;
        interests?: string[];
      }
    >;
  }>("relationships");
  const learnState = dispatcher.readModState<{
    jargon?: Record<string, Record<string, { term: string; meaning: string }>>;
  }>("learning");

  // 提取当前 target 的黑话
  const targetJargon: Array<{ term: string; meaning: string }> = [];
  if (learnState?.jargon && item.target) {
    const groupJargon = learnState.jargon[item.target];
    if (groupJargon) {
      for (const entry of Object.values(groupJargon)) {
        targetJargon.push({ term: entry.term, meaning: entry.meaning });
      }
    }
  }

  const snapshot = buildUserPromptSnapshot({
    G,
    messages,
    observations,
    item,
    round,
    episodeRound,
    board: { maxSteps: board.budget.maxSteps, contextVars: board.contextVars },
    nowMs,
    chatType,
    isGroup,
    isChannel,
    contactProfiles: relState?.contactProfiles,
    jargonEntries: targetJargon.length > 0 ? targetJargon : undefined,
    feedItems: isChannel ? getInjectableFeedItems() : undefined,
    peripheralConfig:
      !isGroup && !isChannel
        ? {
            perChannelCap: config.peripheral.perChannelCap,
            totalCap: config.peripheral.totalCap,
            minTextLength: config.peripheral.minTextLength,
          }
        : undefined,
  });
  const user = renderUserPrompt(snapshot);

  // ADR-141: 安全网
  enforcePromptStyle(system, "system-prompt-tick");
  enforcePromptStyle(user, "user-prompt-tick");

  return { system, user };
}

// ═══════════════════════════════════════════════════════════════════════════
// 行动尾部 — 从 act/prompt.ts 迁移
// ═══════════════════════════════════════════════════════════════════════════

// ADR-174: VOICE_WHISPER 静态常量已删除，whisper 从 Persona Facet 动态获取。
// @see docs/adr/174-persona-facets.md

/**
 * ADR-174: 从 facet 获取声部低语。
 *
 * facetId 存在时从 palette 获取情境化的 whisper；
 * fallback 到 voice 名称（兼容无 facet 的代码路径）。
 */
export function resolveWhisper(voice: string, isGroup: boolean, facetId?: string | null): string {
  return getFacetWhisper(facetId, voice, isGroup);
}

function capitalizeFirst(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * 构建行动尾部提示——内心低语，不暴露系统概念。
 *
 * ADR-152: 群聊使用极乐迪斯科式问句低语，引导 LLM 先自我评估再行动。
 * 私聊保留情境事实陈述。
 *
 * 诚实性原则（ADR-209 F1）：
 * - 不说 "Your instinct:"（系统标签）
 * - 不说 "Decide what to do."（元指令）
 * - whisper 本身已是人类化内心独白，直接使用
 */
export function buildActionFooter(
  G: WorldModel,
  item: ActionQueueItem,
  _tick: number,
  messages?: readonly MessageRecord[],
  nowMs?: number,
): string {
  const target = item.target;

  // 从图中推断群聊/私聊
  const chatType =
    target && G.has(target) ? (G.getChannel(target).chat_type ?? "private") : "private";
  const isGroup = chatType === "group" || chatType === "supergroup";

  const feeling = resolveWhisper(item.action, isGroup, item.facetId);

  if (!target) {
    return capitalizeFirst(feeling);
  }

  const resolved = resolveTarget(G, target);

  // 查找 open thread
  let openThread = "";
  const convId =
    resolved.channelId && G.has(resolved.channelId)
      ? findActiveConversation(G, resolved.channelId)
      : null;
  if (convId && G.has(convId)) {
    const topic = G.getConversation(convId).topic;
    if (topic) openThread = topic;
  }

  // ADR-70 P3: 关系描述已由 relationships.mod contribute() 提供，此处不重复。
  const parts: string[] = [];
  parts.push(capitalizeFirst(feeling));

  // Layer 3: 对话状态增强（RC1 防复读）——在 instinct 后注入已发消息提醒
  if (messages && messages.length > 0) {
    const now = nowMs ?? Date.now();
    const presence = computeChannelPresence(messages);
    if (presence.trailingYours >= 1) {
      let lastOutgoing: MessageRecord | undefined;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].isOutgoing) {
          lastOutgoing = messages[i];
          break;
        }
      }
      if (lastOutgoing) {
        const agoS = (now - lastOutgoing.date.getTime()) / 1000;
        const agoLabel = humanDuration(agoS);
        parts.push(`Already sent a message ~${agoLabel} — still waiting for their reply.`);
      }
    }
  }

  if (openThread) parts.push(`You were talking about: ${openThread}.`);
  // 论文 L5: Degraded Action — 社交成本过高时约束 LLM 输出简短回复
  // @see paper/ Definition 10: L5 "Degraded Action"
  if (item.reason?.includes("degraded_action")) {
    parts.push("Running low — a reaction or a short line is enough.");
  }
  return parts.join("\n");
}
