/**
 * 类型安全的 graph dynamic property 访问器。
 *
 * 遵循 ModStateRegistry 模式（core/types.ts）：
 * 单一受控 cast 点，所有调用站点零 `as`。
 *
 * getDynamic() 返回 unknown（逃生舱口）。本模块提供类型化读取，
 * 包含运行时类型守卫（typeof 检查），防止错误类型的数据静默传播。
 */

import type { ForwardRegistry } from "../engine/act/timeline.js";
import type { WorldModel } from "./world-model.js";

// ═══════════════════════════════════════════════════════════════════════════
// 社交接收度（ADR-156）
// ═══════════════════════════════════════════════════════════════════════════

/** 读取群组的社交接收度 ∈ [-1, 1]。未设置时返回 0。 */
export function readSocialReception(G: WorldModel, channelId: string): number {
  if (!G.has(channelId)) return 0;
  const v = G.getDynamic(channelId, "social_reception");
  return typeof v === "number" ? v : 0;
}

/** 读取社交接收度最后更新时间（epoch ms）。 */
export function readSocialReceptionMs(G: WorldModel, channelId: string): number {
  if (!G.has(channelId)) return 0;
  const v = G.getDynamic(channelId, "social_reception_ms");
  return typeof v === "number" ? v : 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// 转发记录（BT 反馈闭环）
// ═══════════════════════════════════════════════════════════════════════════

/** 读取频道的消息转发记录。 */
export function readForwardRegistry(G: WorldModel, channelId: string): ForwardRegistry {
  if (!G.has(channelId)) return {};
  const v = G.getDynamic(channelId, "forwarded_msgs");
  if (v == null || typeof v !== "object" || Array.isArray(v)) return {};
  return v as ForwardRegistry;
}

/** 记录一次转发：srcChannel 的 msgId 被转发到 targetName。 */
function writeForwardEntry(
  G: WorldModel,
  channelId: string,
  msgId: number,
  targetName: string,
): void {
  const registry = readForwardRegistry(G, channelId);
  const key = String(msgId);
  if (!registry[key]) registry[key] = [];
  if (!registry[key].includes(targetName)) registry[key].push(targetName);
  G.setDynamic(channelId, "forwarded_msgs", registry);
}

/** 记录一次跨聊天分享的完整事实：源消息、目标、以及两端最近分享时间。 */
export function recordForwardShare(
  G: WorldModel,
  params: {
    fromGraphId: string;
    msgId: number;
    toGraphId: string;
    targetName: string;
    nowMs?: number;
  },
): void {
  const nowMs = params.nowMs ?? Date.now();

  if (G.has(params.fromGraphId)) {
    G.setDynamic(params.fromGraphId, "last_shared_ms", nowMs);
    writeForwardEntry(G, params.fromGraphId, params.msgId, params.targetName);
  }
  if (G.has(params.toGraphId)) {
    G.setDynamic(params.toGraphId, "last_shared_ms", nowMs);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Block 检测
// ═══════════════════════════════════════════════════════════════════════════

/** 联系人是否拉黑了 Alice。 */
export function isBlockedByContact(G: WorldModel, contactId: string): boolean {
  return G.has(contactId) && G.getDynamic(contactId, "blocked_alice") === true;
}

// ═══════════════════════════════════════════════════════════════════════════
// 分享时间
// ═══════════════════════════════════════════════════════════════════════════

/** 读取最近一次分享时间（epoch ms）。0 = 从未分享。 */
export function readLastSharedMs(G: WorldModel, nodeId: string): number {
  if (!G.has(nodeId)) return 0;
  const v = G.getDynamic(nodeId, "last_shared_ms");
  return typeof v === "number" ? v : 0;
}
