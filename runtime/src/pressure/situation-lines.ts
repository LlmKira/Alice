/**
 * 压力语义化：数字 → 自然语言情境描述。
 *
 * 压力数字是代码内部的排序依据，不是给 LLM 看的。
 * LLM 需要的是情境事实——"你已经 3 天没和 Carol 说话了"，
 * 而不是 "relationship cooling (P3=2.1)"。
 *
 * per-entity 数据已经在 AllPressures.contributions 中，
 * 只需关联图属性生成自然语言。
 *
 * D2 管线统一（Wave 5）：
 * - SemanticTriple: 论文 Def 3.5 ⟨F,T,S⟩ 的结构化表示
 * - generateSemanticTriples(): 生成全量三元组（供 VoI 等外部消费者使用）
 * - buildSituationBriefing(): 支持焦点集驱动渲染 + belief hedging
 *
 * ADR-194: 双语态渲染（Two-voice rendering）。
 * 当前 target 用行动语态（obligation），非当前 target 用环境语态（ambient）。
 * @see docs/adr/194-situation-briefing-inbox-anxiety.md
 *
 * @see docs/adr/57-social-cognition-architecture.md §9
 * @see paper-five-dim/ Def 3.5: Semantic Triple ⟨F,T,S⟩
 */
import type { BeliefStore } from "../belief/store.js";
import { ensureChannelId, extractNumericId } from "../graph/constants.js";
import { safeDisplayName } from "../graph/display.js";
import type { WorldModel } from "../graph/world-model.js";
import type { AllPressures } from "./aggregate.js";
import { elapsedS, readNodeMs } from "./clock.js";
import { effectiveObligation, effectiveOutgoing, effectiveUnread } from "./signal-decay.js";
import { DEFAULT_SATURATION_COST_CONFIG } from "./social-cost.js";

/** 一天的秒数。 */
const SECONDS_PER_DAY = 86_400;

/** 最多输出的实体行数。 */
const MAX_ENTITY_LINES = 6;

/** 压力维度 key。 */
const PRESSURE_KEYS = ["P1", "P2", "P3", "P4", "P5", "P6"] as const;
export type PressureKey = (typeof PRESSURE_KEYS)[number];

// -- D2 Trend: 压力时间导数方向（论文 Def 3.5 Semantic Triple ⟨F,T,S⟩） -------

export type Trend = "rising" | "steady" | "falling";

/**
 * 计算压力时间导数方向。
 * 比较当前值与历史均值，判断压力维度的趋势。
 * 历史不足 3 ticks 时默认 steady（数据不足以判断趋势）。
 */
export function computeTrend(history: number[], currentValue: number): Trend {
  if (history.length < 3) return "steady";
  const mean = history.reduce((a, b) => a + b, 0) / history.length;
  if (mean < 1e-6) return currentValue > 1e-6 ? "rising" : "steady";
  if (currentValue > mean * 1.1) return "rising";
  if (currentValue < mean * 0.9) return "falling";
  return "steady";
}

/** Trend 修饰后缀：嵌入 Signal 文本，让 LLM 感知变化方向。
 * ADR-196 F11: 使用自然语言替代技术术语 */
function trendSuffix(trend: Trend): string {
  if (trend === "rising") return " — and picking up";
  if (trend === "falling") return " — and calming down";
  return "";
}

/**
 * 包装生成器：在原始 Signal 后附加 Trend 修饰。
 * 避免逐函数修改，保持各 lineP* 函数的纯净性。
 * ADR-194: 新增 ambient 参数透传。
 */
function withTrend(
  fn: (eid: string, intensity: Intensity, G: WorldModel, nowMs: number, ambient: boolean) => string,
): (
  eid: string,
  intensity: Intensity,
  G: WorldModel,
  nowMs: number,
  trend: Trend,
  ambient: boolean,
) => string {
  return (eid, intensity, G, nowMs, trend, ambient) =>
    fn(eid, intensity, G, nowMs, ambient) + trendSuffix(trend);
}

// -- 实体名字解析 ---------------------------------------------------------------

/** ADR-172: 委托给 safeDisplayName — 永不返回 raw graph ID。 */
function entityDisplayName(eid: string, G: WorldModel): string {
  return safeDisplayName(G, eid);
}

// -- 强度分级（维度内百分位） -----------------------------------------------------

export type Intensity = "low" | "mid" | "high";

// -- D2 Semantic Triple（论文 Def 3.5 ⟨F,T,S⟩ 的结构化表示） -----------------

/**
 * 语义三元组——压力维度的结构化描述。
 *
 * 每个三元组包含：
 * - Factor (F): 哪个压力维度（P1-P6）
 * - Trend (T): 时间导数方向（rising/steady/falling）
 * - Signal (S): 自然语言描述
 *
 * 额外字段用于排序和 VoI 计算。
 *
 * @see paper-five-dim/ Def 3.5: Semantic Triple ⟨F,T,S⟩
 */
export interface SemanticTriple {
  /** Factor: 哪个压力维度。 */
  factor: PressureKey;
  /** Trend: 时间导数方向。 */
  trend: Trend;
  /** Signal: 自然语言描述。 */
  signal: string;
  /** 关联实体 ID。 */
  entityId: string;
  /** 原始压力强度分级。 */
  intensity: Intensity;
  /** 信念不确定性（来自 BeliefStore，可选）。越高越不确定。 */
  confidence?: number;
}

/**
 * 在同一维度的所有贡献值中，按百分位判断强度。
 * 单实体时 ≥ 阈值即 high；多实体时按排名。
 */
function intensityInDimension(value: number, allValues: number[]): Intensity {
  if (allValues.length <= 1) return value > 0 ? "high" : "low";
  const sorted = [...allValues].sort((a, b) => b - a);
  // M1 修复: indexOf 对浮点重复值不稳定（-1 导致 percentile > 1）。
  // 改用 findIndex + <= 比较，避免浮点精度问题和重复值歧义。
  const rank = sorted.findIndex((v) => v <= value);
  if (rank < 0) return "high"; // 防御：值未找到（理论不可能）
  const percentile = 1 - rank / (sorted.length - 1);
  if (percentile >= 0.75) return "high";
  if (percentile >= 0.35) return "mid";
  return "low";
}

// -- 按维度生成自然语言 -----------------------------------------------------------

function lineP5(
  eid: string,
  intensity: Intensity,
  G: WorldModel,
  nowMs: number,
  ambient = false,
): string {
  const name = entityDisplayName(eid, G);
  if (!G.has(eid)) {
    return ambient ? `${name} sent you something.` : `${name} is waiting for your reply.`;
  }
  // ADR-194: 环境语态——中性通知，不暗示行动义务
  if (ambient) {
    switch (intensity) {
      case "low":
        return `${name} sent you something.`;
      case "mid":
        return `${name} mentioned you.`;
      case "high":
        return `${name} has been trying to reach you.`;
    }
  }
  const attrs = G.getChannel(eid);
  // ADR-124: 使用 effectiveObligation 替代 pending_directed
  // @see docs/adr/126-obligation-field-decay.md §D6
  const pending = effectiveObligation(G, eid, nowMs);
  const directedText = String(attrs.last_directed_text ?? "");
  // CA 邻接对：引用对方的消息让 LLM 知道"在等什么回复"
  const quote = directedText ? `${name} said "${directedText}"` : "";
  switch (intensity) {
    case "low":
      return quote ? `${quote}.` : `${name} messaged you.`;
    case "mid":
      return quote
        ? `${quote} \u2014 waiting for your reply.`
        : `${name} is waiting for your reply.`;
    case "high":
      if (quote) {
        return pending > 1
          ? `${quote} \u2014 several messages waiting for your reply.`
          : `${quote} \u2014 waiting for your reply.`;
      }
      return pending > 1
        ? `${name} has been waiting for a while \u2014 several messages unanswered.`
        : `${name} has been waiting for a while.`;
  }
}

function lineP1(
  eid: string,
  intensity: Intensity,
  G: WorldModel,
  nowMs: number,
  ambient = false,
): string {
  const name = entityDisplayName(eid, G);
  if (!G.has(eid)) return `A few new messages in ${name}.`;
  // ADR-134 D5: 使用 effectiveUnread 保持与 P1 计算一致
  const unread = Math.round(effectiveUnread(G, eid, nowMs));
  // ADR-194: 环境语态——中性事实，不触发清理冲动
  if (ambient) {
    switch (intensity) {
      case "low":
        return `${name} has some new messages.`;
      case "mid":
        return `${name} has been chatting.`;
      case "high":
        return `${name} is pretty active right now.`;
    }
  }
  switch (intensity) {
    case "low":
      return `A few new messages in ${name}.`;
    case "mid":
      return `Several unread messages in ${name}.`;
    case "high":
      return `${name} is buzzing \u2014 ${unread > 50 ? "a flood of" : "many"} unread messages piling up.`;
  }
}

/**
 * 从 contact 实体找到对应私聊 channel 上的 last_outgoing_text。
 * 命名规则：contact:telegram:X → channel:telegram:X（私聊共享 native ID）。
 */
function findLastOutgoingText(eid: string, G: WorldModel): string {
  // contact:telegram:123 → channel:telegram:123
  const channelId = ensureChannelId(eid);
  if (!channelId || !G.has(channelId)) return "";
  return G.getChannel(channelId).last_outgoing_text ?? "";
}

function lineP3(
  eid: string,
  intensity: Intensity,
  G: WorldModel,
  nowMs: number,
  ambient = false,
): string {
  const name = entityDisplayName(eid, G);
  if (!G.has(eid)) return `It's been a while since you talked to ${name}.`;

  // ADR-104: P3 contributions 包含 contact（私聊冷却）和 channel（群组缺席）两种实体。
  const nodeType = G.getNodeType(eid);
  if (nodeType === "channel") {
    return lineP3Group(eid, name, intensity, G, nowMs, ambient);
  }

  const lastActiveMs = readNodeMs(G, eid, "last_active_ms");
  // 防护：last_active_ms=0 意味着"从未交互"，不应算出 epoch 以来的天数
  if (lastActiveMs <= 0) return `You haven't talked to ${name} yet.`;
  const days = Math.floor(elapsedS(nowMs, lastActiveMs) / SECONDS_PER_DAY);
  // 支柱 ④: 引用 Alice 上次说的话，让 LLM 知道对话断在哪
  const lastSaid = findLastOutgoingText(eid, G);
  const suffix = lastSaid ? ` Last time, you said "${lastSaid}"` : "";
  switch (intensity) {
    case "low":
      return `It's been a while since you talked to ${name}.${suffix}`;
    case "mid":
      return days > 0
        ? `You haven't talked to ${name} in ${days} day${days > 1 ? "s" : ""}.${suffix}`
        : `It's been a while since you talked to ${name}.${suffix}`;
    case "high":
      return days > 0
        ? `${name} is drifting \u2014 no contact in ${days} day${days > 1 ? "s" : ""}.${suffix}`
        : `${name} is drifting away.${suffix}`;
  }
}

/** P3 群组缺席子维度：Alice 多久没在群里说话了。 */
function lineP3Group(
  eid: string,
  name: string,
  intensity: Intensity,
  G: WorldModel,
  nowMs: number,
  ambient = false,
): string {
  const lastAliceMs = readNodeMs(G, eid, "last_alice_action_ms");
  if (lastAliceMs <= 0) return `You haven't spoken in ${name} yet.`;
  const days = Math.floor(elapsedS(nowMs, lastAliceMs) / SECONDS_PER_DAY);
  // ADR-194: 环境语态——不制造缺席愧疚
  if (ambient) {
    switch (intensity) {
      case "low":
        return `${name} has been going on without you.`;
      case "mid":
        return `${name} has been active lately.`;
      case "high":
        return `${name} is active.`;
    }
  }
  switch (intensity) {
    case "low":
      return `You've been quiet in ${name} for a while.`;
    case "mid":
      return days > 0
        ? `You haven't said anything in ${name} in ${days} day${days > 1 ? "s" : ""}.`
        : `You've been quiet in ${name} for a while.`;
    case "high":
      return days > 0
        ? `${name} is active but you've been absent for ${days} day${days > 1 ? "s" : ""}.`
        : `${name} is active but you've been absent.`;
  }
}

function lineP4(eid: string, intensity: Intensity, G: WorldModel): string {
  const name = entityDisplayName(eid, G);
  switch (intensity) {
    case "low":
    case "mid":
      return `Thread "${name}" hasn't been touched in a while.`;
    case "high":
      return `Thread "${name}" has gone stale.`;
  }
}

function lineP6(
  eid: string,
  intensity: Intensity,
  G: WorldModel,
  _nowMs: number,
  ambient = false,
): string {
  const name = entityDisplayName(eid, G);
  switch (intensity) {
    case "low":
      return `Something stirring around ${name}.`;
    case "mid":
      return `Something new happening around ${name}.`;
    case "high":
      // ADR-194: 环境语态——去掉 "worth checking out" 行动建议
      return ambient
        ? `A lot going on around ${name} lately.`
        : `A lot of fresh activity around ${name} \u2014 worth checking out.`;
  }
}

function lineP2(
  eid: string,
  intensity: Intensity,
  G: WorldModel,
  _nowMs: number,
  ambient = false,
): string {
  const name = entityDisplayName(eid, G);
  switch (intensity) {
    case "low":
      return `Some new details about ${name}.`;
    case "mid":
      return `There's new information about ${name}.`;
    case "high":
      // ADR-194: 环境语态——去掉 "you haven't processed" 任务帧措辞
      return ambient
        ? `There's been new information about ${name}.`
        : `Important new information about ${name} that you haven't processed.`;
  }
}

const LINE_GENERATORS: Record<
  PressureKey,
  (
    eid: string,
    intensity: Intensity,
    G: WorldModel,
    nowMs: number,
    trend: Trend,
    ambient: boolean,
  ) => string
> = {
  P5: withTrend(lineP5),
  P1: withTrend(lineP1),
  P3: withTrend(lineP3),
  P4: withTrend(lineP4),
  P6: withTrend(lineP6),
  P2: withTrend(lineP2),
};

// -- 定性总况 -------------------------------------------------------------------

// ADR-194: 定性总况从过载帧改为环境帧——"世界在转"而非"你超负荷"
function qualitativeOverall(api: number): string {
  if (api < 0.5) return "Everything is calm right now.";
  if (api < 1.5) return "A few things on your mind.";
  if (api < 3.0) return "A few things going on in other chats.";
  if (api < 4.5) return "Other chats have been active.";
  return "The world's been busy while you're here.";
}

// -- 核心函数 -------------------------------------------------------------------

interface EntityPressureEntry {
  entityId: string;
  dominantKey: PressureKey;
  dominantValue: number;
}

/** D2 焦点集 + belief 选项（Wave 5 新增，向后兼容）。 */
export interface SituationBriefingOptions {
  /** 焦点实体 ID 集合。焦点实体优先渲染（即使压力值不是最高）。 */
  focalEntities?: string[];
  /** BeliefStore。sigma^2 高时追加 hedging language（模糊修饰）。 */
  beliefs?: BeliefStore;
  /**
   * 当前 action scope 的 target（channel entity ID）。
   * ADR-194: 非此 target 的 entity 使用环境语态（ambient=true），
   * 避免 obligation 措辞制造收件箱焦虑。
   */
  actionTarget?: string;
}

// -- D2 hedging language（信念不确定性 → 模糊修饰） --------------------------

/** sigma^2 阈值：高于此值认为"高不确定性"。 */
const SIGMA2_HIGH = 0.5;
/** sigma^2 阈值：低于此值认为"高确信度"。 */
const SIGMA2_LOW = 0.15;

/**
 * 根据 belief 的 sigma^2 为信号文本添加 hedging 修饰。
 *
 * - 高 sigma^2 (> 0.5): "You vaguely recall..." 前缀
 * - 低 sigma^2 (< 0.15): "You're pretty sure — " 前缀
 * - 中间: 原文不变
 *
 * @see paper-pomdp/ §3: Belief Uncertainty
 */
function applyHedging(signal: string, sigma2: number): string {
  if (sigma2 > SIGMA2_HIGH) {
    return `You vaguely recall — ${signal}`;
  }
  if (sigma2 < SIGMA2_LOW) {
    return `You're pretty sure — ${signal}`;
  }
  return signal;
}

/**
 * 从 BeliefStore 获取实体的综合 sigma^2（取 tier 和 mood 中的较大值）。
 * 取较大值是因为任一维度的高不确定性都应触发 hedging。
 */
function entitySigma2(eid: string, beliefs: BeliefStore | undefined): number | undefined {
  if (!beliefs) return undefined;
  const bTier = beliefs.getOrDefault(eid, "tier");
  const bMood = beliefs.getOrDefault(eid, "mood");
  return Math.max(bTier.sigma2, bMood.sigma2);
}

// -- 收集逻辑（从 buildSituationBriefing 提取，供 generateSemanticTriples 共用）

/** 收集所有 (entity, pressureKey, value) 和维度值映射。 */
function collectEntityPressures(p: AllPressures): {
  entityMap: Map<string, { key: PressureKey; value: number }[]>;
  dimensionValues: Record<PressureKey, number[]>;
} {
  const entityMap = new Map<string, { key: PressureKey; value: number }[]>();
  const dimensionValues: Record<PressureKey, number[]> = {
    P1: [],
    P2: [],
    P3: [],
    P4: [],
    P5: [],
    P6: [],
  };

  for (const pk of PRESSURE_KEYS) {
    const contribs = p.contributions[pk];
    if (!contribs) continue;
    for (const [eid, val] of Object.entries(contribs)) {
      if (val <= 0) continue;
      let arr = entityMap.get(eid);
      if (!arr) {
        arr = [];
        entityMap.set(eid, arr);
      }
      arr.push({ key: pk, value: val });
      dimensionValues[pk].push(val);
    }
  }

  return { entityMap, dimensionValues };
}

/** 构建维度总量映射（用于 trend 计算）。 */
function dimTotalsFrom(p: AllPressures): Record<PressureKey, number> {
  return { P1: p.P1, P2: p.P2, P3: p.P3, P4: p.P4, P5: p.P5, P6: p.P6 };
}

/**
 * 生成全量语义三元组。
 *
 * 将六维压力场的 per-entity 贡献转化为结构化三元组 ⟨F,T,S⟩。
 * 供内部渲染和外部消费者（如 D5 VoI 计算）使用。
 *
 * @see paper-five-dim/ Def 3.5: Semantic Triple ⟨F,T,S⟩
 */
export function generateSemanticTriples(
  p: AllPressures,
  G: WorldModel,
  _tick: number,
  nowMs: number,
  beliefs?: BeliefStore,
): SemanticTriple[] {
  const { entityMap, dimensionValues } = collectEntityPressures(p);
  const dimTotals = dimTotalsFrom(p);
  const triples: SemanticTriple[] = [];

  // 为每个实体的每个有贡献维度生成三元组
  for (const [eid, contribs] of entityMap) {
    for (const { key: pk, value } of contribs) {
      const intensity = intensityInDimension(value, dimensionValues[pk]);
      const dimHistory = p.pressureHistory?.[pk] ?? [];
      const trend = computeTrend(dimHistory, dimTotals[pk]);
      const generator = LINE_GENERATORS[pk];
      // ADR-194: 三元组用于 VoI 计算，始终使用行动语态（ambient=false）
      const signal = generator(eid, intensity, G, nowMs, trend, false);
      const sigma2 = entitySigma2(eid, beliefs);

      triples.push({
        factor: pk,
        trend,
        signal,
        entityId: eid,
        intensity,
        confidence: sigma2 !== undefined ? 1 - sigma2 : undefined,
      });
    }
  }

  return triples;
}

/**
 * 将六维压力场转化为 per-entity 自然语言情境描述。
 *
 * 逻辑：
 * 1. 从 contributions 收集 (entityId, pressureKey, value) 三元组
 * 2. 按 entity 分组——每个 entity 取最大贡献维度作为"主调"
 * 3. 按最大贡献值降序排列（最紧迫的排最前）
 *    - D2 Wave 5: focalEntities 优先（即使压力值不是最高）
 * 4. 取 top-6 实体，每个生成一句自然语言
 *    - D2 Wave 5: belief sigma^2 高时追加 hedging language
 * 5. 末尾追加定性总况
 *
 * 数字的唯一作用：排序和语气强度。不出现在输出文本中。
 *
 * @param p 六维压力结果
 * @param G 伴侣图
 * @param tick 当前 tick
 * @param options D2 焦点集 + belief 选项（可选，向后兼容）
 *
 * @see paper-five-dim/ Def 3.5: Semantic Triple ⟨F,T,S⟩
 * @see paper-five-dim/ Definition 7.1: Context Assembly
 */
export function buildSituationBriefing(
  p: AllPressures,
  G: WorldModel,
  _tick: number,
  nowMs: number,
  options?: SituationBriefingOptions,
): string[] {
  const focalSet = options?.focalEntities ? new Set(options.focalEntities) : null;
  const beliefs = options?.beliefs;
  // ADR-187 D1: 视野裁剪 — 预计算 actionTarget 的 numeric ID
  const actionTarget = options?.actionTarget ?? null;
  const actionTargetNum = actionTarget ? extractNumericId(actionTarget) : null;

  // 1. 收集所有 (entity, key, value)
  const { entityMap, dimensionValues } = collectEntityPressures(p);

  // 2. 按 entity 分组，取最大贡献维度
  const entries: EntityPressureEntry[] = [];
  for (const [eid, contribs] of entityMap) {
    let best = contribs[0];
    for (let i = 1; i < contribs.length; i++) {
      if (contribs[i].value > best.value) best = contribs[i];
    }
    entries.push({ entityId: eid, dominantKey: best.key, dominantValue: best.value });
  }

  // 3. 排序：focal 实体优先（保持内部压力降序），然后非 focal 按压力降序
  if (focalSet && focalSet.size > 0) {
    const focalEntries: EntityPressureEntry[] = [];
    const nonFocalEntries: EntityPressureEntry[] = [];
    for (const e of entries) {
      if (focalSet.has(e.entityId)) {
        focalEntries.push(e);
      } else {
        nonFocalEntries.push(e);
      }
    }
    // 各自按压力降序
    focalEntries.sort((a, b) => b.dominantValue - a.dominantValue);
    nonFocalEntries.sort((a, b) => b.dominantValue - a.dominantValue);
    // focal 在前
    entries.length = 0;
    entries.push(...focalEntries, ...nonFocalEntries);
  } else {
    // 无焦点集：原有逻辑，纯压力降序
    entries.sort((a, b) => b.dominantValue - a.dominantValue);
  }

  // 4. 取 top-N，生成自然语言（D2 Trend: 嵌入 ⟨F,T,S⟩ 的 T）
  const lines: string[] = [];
  const topN = entries.slice(0, MAX_ENTITY_LINES);
  const dimTotals = dimTotalsFrom(p);

  // ADR-196 F6: 匿名实体（无 display_name/title）合并为计数摘要，节省 token
  let anonymousCount = 0;

  for (const entry of topN) {
    // ADR-196 F6: 跳过匿名实体，累计计数
    if (G.has(entry.entityId)) {
      const dn = G.getDynamic(entry.entityId, "display_name");
      const title = G.getDynamic(entry.entityId, "title");
      if (!dn && !title) {
        anonymousCount++;
        continue;
      }
    }

    // ADR-194: 判断是否为当前 action target — 决定使用行动语态还是环境语态。
    // 当前 target 用 obligation 措辞（可行动），非当前 target 用 ambient 措辞（只感知）。
    let ambient = false;
    if (actionTarget && entry.entityId !== actionTarget) {
      const entityNum = extractNumericId(entry.entityId);
      // 私聊: channel:X 和 contact:X 共享 numeric ID → 视为同一 target
      const isCurrentTarget =
        actionTargetNum != null && entityNum != null && actionTargetNum === entityNum;
      ambient = !isCurrentTarget;
    }

    const generator = LINE_GENERATORS[entry.dominantKey];
    const intensity = intensityInDimension(entry.dominantValue, dimensionValues[entry.dominantKey]);
    const dimHistory = p.pressureHistory?.[entry.dominantKey] ?? [];
    const trend = computeTrend(dimHistory, dimTotals[entry.dominantKey]);
    let line = generator(entry.entityId, intensity, G, nowMs, trend, ambient);

    // D2 Wave 5: belief hedging — sigma^2 驱动的模糊修饰
    const sigma2 = entitySigma2(entry.entityId, beliefs);
    if (sigma2 !== undefined) {
      line = applyHedging(line, sigma2);
    }

    lines.push(line);
  }

  // ADR-196 F6: 匿名实体合并为一行摘要
  if (anonymousCount > 0) {
    lines.push(
      `${anonymousCount} other chat${anonymousCount !== 1 ? "s" : ""} ${anonymousCount !== 1 ? "are" : "is"} also active.`,
    );
  }

  // 5. 支柱 ④: anti-bombing 检测（turn-taking 理论：连发无回复 = 独白轰炸）
  // ADR-113 修正：群聊 5+ 条仍属刷屏，阈值从 8 降到 5
  // ADR-157: 从 saturation cost 的 outgoing cap 派生——bombing = 超过上限
  // @see runtime/src/pressure/social-cost.ts SaturationCostConfigSchema
  const BOMBING_THRESHOLD_PRIVATE = DEFAULT_SATURATION_COST_CONFIG.outgoingCapPrivate + 1;
  const BOMBING_THRESHOLD_GROUP = DEFAULT_SATURATION_COST_CONFIG.outgoingCapGroup + 1;
  for (const chId of G.getEntitiesByType("channel")) {
    const chAttrs = G.getChannel(chId);
    // ADR-126: 使用 effectiveOutgoing（24h 半衰期衰减）
    const consecutive = effectiveOutgoing(G, chId, nowMs);
    const chChatType = chAttrs.chat_type ?? "private";
    const threshold =
      chChatType === "group" || chChatType === "supergroup"
        ? BOMBING_THRESHOLD_GROUP
        : BOMBING_THRESHOLD_PRIVATE;
    if (consecutive >= threshold) {
      const chName = entityDisplayName(chId, G);
      lines.push(`You've sent several messages to ${chName} without a reply — consider waiting.`);
    }
  }

  // 6. 定性总况
  lines.push(qualitativeOverall(p.API));

  return lines;
}
