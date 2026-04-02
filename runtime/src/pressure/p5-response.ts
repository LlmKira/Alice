/**
 * P5 Response Obligation — 论文 §3.5 对齐实现 + 工程增强。
 *
 * 论文公式：
 *   P₅(n) = Σ_{h ∈ H_active} directed(h, n) × w_tier(h) × w_chat(h) × decay(h, n)
 *
 * 工程修正（ADR-157, ADR-153, ADR-215）：
 * - 指数核替代双曲线（物理更正确，残余更低）
 * - Hawkes λ(t) 调制（对方活跃时义务持续）
 * - 对数缩放 directed（防止大规模图中未处理消息累积导致饱和）
 * - per-channel 义务上限（防止单频道消息风暴淹没系统）
 *
 * @see paper/ §3.5 Response Obligation
 * @see docs/adr/157-signal-decay-integrity.md
 * @see docs/adr/215-p5-directed-saturation-fix.md
 */

import {
  CHAT_TYPE_WEIGHTS,
  chatIdToContactId,
  DUNBAR_TIER_WEIGHT,
  tierBiasCorrection,
} from "../graph/constants.js";
import { readSocialReception } from "../graph/dynamic-props.js";
import { findActiveConversation } from "../graph/queries.js";
import type { WorldModel } from "../graph/world-model.js";
import { elapsedS, readNodeMs } from "./clock.js";
import { getDefaultParams, type HawkesState, queryIntensity } from "./hawkes.js";
import type { PressureResult } from "./p1-attention.js";
import {
  decaySignal,
  OBLIGATION_HALFLIFE_GROUP,
  OBLIGATION_HALFLIFE_PRIVATE,
} from "./signal-decay.js";

// ADR-222 已删除

/** alice_turn 时的额外回应义务加成（30%）。 */
const TURN_OBLIGATION_BOOST = 1.3;

/**
 * ADR-215: per-channel directed 上限。
 * 防止单频道消息风暴：即使未处理 100 条 directed 消息，
 * 有效义务上限为 ln(1+5) ≈ 1.8（而非 100）。
 */
const DIRECTED_CAP_PER_CHANNEL = 5.0;

/**
 * 对数缩放 directed 计数：将线性增长的未处理消息计数
 * 转换为有界义务强度。大规模图中防止 P5 饱和。
 *
 * effectiveDirected = ln(1 + min(directed, DIRECTED_CAP_PER_CHANNEL))
 *
 * @see docs/adr/215-p5-directed-saturation-fix.md
 */
function effectiveDirected(directed: number): number {
  const capped = Math.min(Math.max(0, directed), DIRECTED_CAP_PER_CHANNEL);
  return Math.log1p(capped); // ln(1 + capped), capped=5 → ~1.79
}

export function p5ResponseObligation(G: WorldModel, _n: number, nowMs: number): PressureResult {
  const contributions: Record<string, number> = {};
  const beliefs = G.beliefs;

  for (const hid of G.getEntitiesByType("channel")) {
    const attrs = G.getChannel(hid);
    const directedRaw = attrs.pending_directed;
    if (directedRaw <= 0) continue;

    // ADR-215: 对数缩放 directed，防止大规模图中饱和
    const directed = effectiveDirected(directedRaw);

    // Wave 6: Tier bias correction — 通过 channel 的 tier_contact 推断 contactId，
    // 读取 BeliefStore 中 tier 信念的 σ²，σ² 高时向基线回归。
    // @see paper/ §Social POMDP "Tier Overestimate Bias Correction"
    const contactId = chatIdToContactId(hid);
    // ADR-91 Layer 2: Bot directed 消息降权 ×0.1
    const isBot = contactId != null && G.has(contactId) && G.getContact(contactId).is_bot === true;
    const botWeight = isBot ? 0.1 : 1.0;
    const b = contactId ? beliefs.get(contactId, "tier") : undefined;
    const effectiveTier = tierBiasCorrection(attrs.tier_contact, b?.sigma2);
    const w = DUNBAR_TIER_WEIGHT[effectiveTier] ?? 0.8;
    const chatType = attrs.chat_type;
    const chatW = CHAT_TYPE_WEIGHTS[chatType]?.response ?? 1.0;
    const lastDirectedMs = readNodeMs(G, hid, "last_directed_ms");
    const ageS = Math.max(elapsedS(nowMs, lastDirectedMs), 1.0);
    // ADR-157: 统一使用 signal-decay.ts 的指数核和半衰期常量。
    // 半衰期：私聊 3600s，群聊 2400s（与 effectiveObligation 一致）。
    // 旧版使用双曲线 1/(1+ageS/τ)，指数核 2^(-ageS/τ) 自然消退更符合事件信号物理。
    // @see docs/adr/157-signal-decay-integrity.md §Fix 1
    const isPrivate = chatType === "private";
    const decayHalfLife = isPrivate ? OBLIGATION_HALFLIFE_PRIVATE : OBLIGATION_HALFLIFE_GROUP;
    const rawDecay = decaySignal(1.0, ageS, decayHalfLife);
    // ADR-153 Phase 2: λ(t) 高 → 衰减减慢（对方仍在活跃，义务持续）
    // k_p5 = 0.5, clamp [1, 2]。仿真验证：活跃期 2× 基线，沉默后收敛。
    // @see simulation/experiments/exp_hawkes_phase2_validation.py 验证 1
    let decay = rawDecay;
    const cId = chatIdToContactId(hid);
    if (cId && G.has(cId)) {
      const c = G.getContact(cId);
      if (c.hawkes_last_event_ms && c.hawkes_last_event_ms > 0) {
        const hp = getDefaultParams(c.tier, false);
        const hs: HawkesState = {
          lambdaCarry: c.hawkes_carry ?? 0,
          lastEventMs: c.hawkes_last_event_ms,
        };
        const hi = queryIntensity(hp, hs, nowMs);
        const modulation = Math.min(
          2,
          1 + 0.5 * Math.max(0, (hi.lambda - hp.mu) / Math.max(hp.mu, 1e-10)),
        );
        decay = rawDecay * modulation;
      }
    }

    // ADR-156: social reception 独立调制（与 ADR-222 habituation 正交）。
    // reception 是他人对 Alice 的社交反馈；habituation 是 Alice 自身的适应性衰减。
    // reception=0（默认/未设置）→ 1.0（不惩罚无数据状态）。
    const reception = readSocialReception(G, hid);
    const receptionFactor =
      reception >= 0 ? 1.0 : reception > -0.3 ? 0.7 : reception > -0.6 ? 0.3 : 0.1;

    // ADR-70 P0.5: Alice 正在为此频道思考 → 抑制 P5 累积
    const thinkingSince = G.getChannel(hid).alice_thinking_since;
    if (thinkingSince != null) {
      contributions[hid] = directed * w * chatW * decay * receptionFactor * 0.1 * botWeight;
      continue;
    }

    // M4: conversation turn awareness — 轮到 Alice 回复 → 额外义务
    let turnBoost = 1.0;
    const convId = findActiveConversation(G, hid);
    if (convId && G.has(convId)) {
      const convAttrs = G.getConversation(convId);
      if (convAttrs.turn_state === "alice_turn") {
        turnBoost = TURN_OBLIGATION_BOOST;
      }
    }

    const basePressure = directed * w * chatW * decay;
    contributions[hid] = basePressure * turnBoost * botWeight * receptionFactor;
  }

  const total = Object.values(contributions).reduce((a, b) => a + b, 0);
  return { total, contributions };
}
