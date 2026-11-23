/**
 * ADR-299 第一片（下改上 · 按人沉淀的双轨慢印记与主动回响）：
 * 把单次对话里的真情震动（feel / 刺伤 / 拒绝 / 反思 / 主动开口后的落空与被接住）折成按人沉淀的两股慢势能：
 * - bond（牵挂/偏心引力）：7 天半衰期，受双方真实互动与情绪深度拉升；
 * - scar（未消之疤）：10 天半衰期，群内公开刺伤重于私聊；口头 let-go 只微减，须同一人多次真诚友好才渐进融冰；
 *   别处获得新的温暖体验会极轻地稀释陈年他处旧疤，防止“永久全员冻结”。
 * 只经 WillTerms（intrinsicGain、impositionScale、cost）软势能接进意愿层，不设硬门，且守 demand: false（不加速全局节律）。
 * 纯函数，时间只来自 event.at。
 */
import { memberAfter } from "../../mind/affordances.js";
import { type AliceEvent, type ChatType, NEGATIVE_REACTIONS } from "../../mind/events.js";
import { valenceAt } from "./affect.js";
import { feature, type PressureFeature, type View } from "./feature.js";
import type { ChatNode } from "./world.js";

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;

const BOND_HALF_LIFE = 7 * D;
const SCAR_HALF_LIFE = 10 * D;
const MISSED_HALF_LIFE = 3 * D;
const HEAL_MIN_GAP = 20 * MIN;
const PROACTIVE_STALE_MS = 6 * H;
const LONELY_RESONANCE_MS = 2 * H;

export interface PersonAttachment {
  /** 对这个人的慢牵挂 / 偏心引力 [0, 1]。 */
  bond: number;
  /** 未消解的关系深疤 [0, 1]。 */
  scar: number;
  /** 上一次主动发 DM 等待回应的时刻（0 表示没有待回）。 */
  proactivePendingAt: number;
  /** 主动找对方却落空 / 被冷淡的衰减累计，抑制死缠烂打。 */
  proactiveMissed: number;
  /** 上次更新时刻。 */
  at: number;
}

export interface AttachmentState {
  people: Readonly<Record<string, PersonAttachment>>;
}

const emptyAttachment: AttachmentState = { people: {} };

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

const half = (value: number, dt: number, halfLifeMs: number): number =>
  dt <= 0 || value <= 0 ? value : value * 0.5 ** (dt / halfLifeMs);

/** 将某人的慢印记衰减到 now 时刻。 */
export function decayedAttachment(
  rec: PersonAttachment | undefined,
  now: number,
): PersonAttachment {
  if (!rec) return { bond: 0, scar: 0, proactivePendingAt: 0, proactiveMissed: 0, at: now };
  const dt = Math.max(0, now - rec.at);
  // ADR-299 第 3 片（不可逆感）：有较深未消之疤且持续未和解时，牵挂会加速萎缩退回疏远，
  // 不会仅靠时间流逝自动回到亲密基线。
  const effectiveBondHalfLife =
    rec.scar > 0.15 ? BOND_HALF_LIFE / (1 + 2.5 * rec.scar) : BOND_HALF_LIFE;
  return {
    bond: half(rec.bond, dt, effectiveBondHalfLife),
    scar: half(rec.scar, dt, SCAR_HALF_LIFE),
    proactivePendingAt: rec.proactivePendingAt,
    proactiveMissed: half(rec.proactiveMissed, dt, MISSED_HALF_LIFE),
    at: now,
  };
}

function updatePerson(
  state: AttachmentState,
  id: string,
  now: number,
  fn: (cur: PersonAttachment) => PersonAttachment,
): AttachmentState {
  const next = fn(decayedAttachment(state.people[id], now));
  return { people: { ...state.people, [id]: { ...next, at: now } } };
}

/** 别处获得真实温暖体验时，极温和地稀释无关他人的陈年旧疤，避免因两次网络冲突全盘冻结。 */
function diluteUnrelatedScars(
  state: AttachmentState,
  exceptId: string,
  now: number,
  factor = 0.97,
): AttachmentState {
  const entries = Object.entries(state.people);
  if (entries.length === 0) return state;
  let changed = false;
  const people: Record<string, PersonAttachment> = {};
  for (const [id, raw] of entries) {
    if (id === exceptId) {
      people[id] = raw;
      continue;
    }
    const cur = decayedAttachment(raw, now);
    if (cur.scar > 0.01) {
      changed = true;
      people[id] = { ...cur, scar: cur.scar * factor };
    } else {
      people[id] = cur;
    }
  }
  return changed ? { people } : state;
}

function targetForScope(world: View<"chats" | "relations">, scope: string): string | null {
  const chat = world.chats[scope];
  if (!chat) return null;
  if (chat.chatType === "private") return chat.partner;
  const waiting = world.relations.waiting[scope];
  if (waiting && waiting.length > 0) return waiting.at(-1) ?? null;
  return chat.recentFrom.at(-1) ?? null;
}

function speakerForMessage(
  world: View<"chats" | "relations">,
  scope: string,
  messageId: string,
): string | null {
  const addr = world.relations.addressed?.[scope]?.find(([id]) => id === messageId)?.[1];
  if (addr) return addr;
  const chat = world.chats[scope];
  if (!chat) return null;
  if (chat.chatType === "private") return chat.partner;
  const idx = chat.recentIds.lastIndexOf(messageId);
  return idx >= 0 ? (chat.recentFrom[idx] ?? null) : null;
}

function applyFeel(
  state: AttachmentState,
  world: View<"chats" | "relations">,
  event: Extract<AliceEvent, { type: "act.done" }>,
): AttachmentState {
  if (event.act.kind !== "feel" || event.valence === undefined) return state;
  const who = targetForScope(world, event.scope);
  if (!who) return state;
  const chatType: ChatType = world.chats[event.scope]?.chatType ?? "private";
  const v = event.valence;
  if (v > 0.25) {
    const gain = (chatType === "private" ? 0.22 : 0.14) * ((v - 0.25) / 0.75);
    const updated = updatePerson(state, who, event.at, (cur) => ({
      ...cur,
      bond: clamp01(cur.bond + gain * (1 - 0.5 * cur.scar)),
    }));
    return v > 0.35 ? diluteUnrelatedScars(updated, who, event.at) : updated;
  }
  if (v < -0.3) {
    const hurt = (chatType === "group" ? 0.28 : 0.22) * ((-0.3 - v) / 0.7);
    return updatePerson(state, who, event.at, (cur) => ({
      ...cur,
      scar: clamp01(cur.scar + hurt),
      bond: cur.bond * 0.9,
    }));
  }
  return state;
}

function applyPerceived(
  state: AttachmentState,
  world: View<"chats" | "relations">,
  event: Extract<AliceEvent, { type: "message.perceived" }>,
): AttachmentState {
  const who = speakerForMessage(world, event.scope, event.messageId);
  if (!who) return state;
  const chatType: ChatType = world.chats[event.scope]?.chatType ?? "private";
  const isGroup = chatType === "group";
  if (event.tone === "hostile" || event.stop) {
    const wound =
      (event.tone === "hostile" ? (isGroup ? 0.48 : 0.32) : 0) + (event.stop ? 0.25 : 0);
    return updatePerson(state, who, event.at, (cur) => {
      const wasPending = !isGroup && cur.proactivePendingAt > 0;
      return {
        ...cur,
        scar: clamp01(cur.scar + wound),
        bond: cur.bond * 0.65,
        proactivePendingAt: wasPending ? 0 : cur.proactivePendingAt,
        proactiveMissed: wasPending ? cur.proactiveMissed + 1 : cur.proactiveMissed,
      };
    });
  }
  if (event.tone === "cold" || event.aloof) {
    const sting = isGroup ? 0.18 : 0.12;
    return updatePerson(state, who, event.at, (cur) => {
      const wasPending = !isGroup && cur.proactivePendingAt > 0;
      return {
        ...cur,
        scar: clamp01(cur.scar + sting),
        proactivePendingAt: wasPending ? 0 : cur.proactivePendingAt,
        proactiveMissed: wasPending ? cur.proactiveMissed + 0.5 : cur.proactiveMissed,
      };
    });
  }
  if (event.tone === "friendly") {
    const rawGap = event.at - (state.people[who]?.at ?? 0);
    return updatePerson(state, who, event.at, (cur) => {
      const answeredProactive = !isGroup && cur.proactivePendingAt > 0;
      // 真诚友好的多次互动（隔开一段对话节奏）才慢慢软化深疤，不会一条“哈哈”就瞬间翻篇。
      const healedScar = rawGap >= HEAL_MIN_GAP ? cur.scar * 0.84 : cur.scar * 0.96;
      const bondAdd = answeredProactive ? 0.08 : 0.04;
      return {
        ...cur,
        scar: healedScar,
        bond: clamp01(cur.bond + bondAdd * (1 - healedScar)),
        proactivePendingAt: answeredProactive ? 0 : cur.proactivePendingAt,
        proactiveMissed: answeredProactive ? cur.proactiveMissed * 0.5 : cur.proactiveMissed,
      };
    });
  }
  return state;
}

function applyReflect(
  state: AttachmentState,
  event: Extract<AliceEvent, { type: "ponder.done" }>,
): AttachmentState {
  if (event.ponder.kind !== "reflect") return state;
  const moodValence = event.ponder.mood?.valence ?? 0;
  let next = state;
  for (const entry of event.ponder.entries) {
    if (!entry.about || (entry.importance ?? 0) < 7) continue;
    const id = entry.about;
    if (moodValence > 0.2) {
      next = updatePerson(next, id, event.at, (cur) => ({
        ...cur,
        bond: clamp01(cur.bond + 0.14 * (1 - 0.5 * cur.scar)),
      }));
      next = diluteUnrelatedScars(next, id, event.at);
    } else if (moodValence < -0.25) {
      next = updatePerson(next, id, event.at, (cur) => ({
        ...cur,
        scar: clamp01(cur.scar + 0.3),
        bond: cur.bond * 0.8,
      }));
    }
  }
  return next;
}

function applySent(
  cur: AttachmentState,
  before: View<"chats" | "relations">,
  after: View<"chats">,
  event: Extract<AliceEvent, { type: "message.sent" }>,
): AttachmentState {
  const chat = after.chats[event.scope];
  if (!chat || chat.chatType !== "private" || !chat.partner) return cur;
  const wasWaiting = (before.relations.waiting[event.scope]?.length ?? 0) > 0;
  const partner = chat.partner;
  if (wasWaiting) {
    return updatePerson(cur, partner, event.at, (p) => ({ ...p, proactivePendingAt: 0 }));
  }
  return updatePerson(cur, partner, event.at, (p) => {
    const prevMissed =
      p.proactivePendingAt > 0 && event.at - p.proactivePendingAt >= PROACTIVE_STALE_MS ? 0.6 : 0;
    return {
      ...p,
      proactivePendingAt: event.at,
      proactiveMissed: p.proactiveMissed + prevMissed,
    };
  });
}

function applyReceived(
  cur: AttachmentState,
  after: View<"chats">,
  event: Extract<AliceEvent, { type: "message.received" }>,
): AttachmentState {
  const chat = after.chats[event.scope];
  if (!chat || chat.chatType !== "private" || !chat.partner) return cur;
  const prev = cur.people[chat.partner];
  if (!prev || prev.proactivePendingAt <= 0) return cur;
  return updatePerson(cur, chat.partner, event.at, (p) => ({
    ...p,
    bond: clamp01(p.bond + 0.06 * (1 - p.scar)),
    proactivePendingAt: 0,
    proactiveMissed: p.proactiveMissed * 0.6,
  }));
}

function applyReaction(
  cur: AttachmentState,
  before: View<"chats">,
  event: Extract<AliceEvent, { type: "reaction.received" }>,
): AttachmentState {
  const awaiting = before.chats[event.scope]?.awaiting;
  if (!event.senderId || !awaiting?.ids.includes(event.messageId)) return cur;
  const isGroup = (before.chats[event.scope]?.chatType ?? "private") === "group";
  if (NEGATIVE_REACTIONS.has(event.emoji)) {
    return updatePerson(cur, event.senderId, event.at, (p) => ({
      ...p,
      scar: clamp01(p.scar + (isGroup ? 0.15 : 0.1)),
    }));
  }
  return updatePerson(cur, event.senderId, event.at, (p) => ({
    ...p,
    bond: clamp01(p.bond + 0.04 * (1 - p.scar)),
    proactivePendingAt: !isGroup ? 0 : p.proactivePendingAt,
    proactiveMissed:
      !isGroup && p.proactivePendingAt > 0 ? p.proactiveMissed * 0.7 : p.proactiveMissed,
  }));
}

function reduceAttachment(
  before: View<"chats" | "relations" | "attachment">,
  after: View<"chats" | "relations" | "attachment">,
  event: AliceEvent,
): AttachmentState {
  const cur = after.attachment ?? emptyAttachment;
  switch (event.type) {
    case "act.done": {
      if (event.act.kind === "feel") return applyFeel(cur, after, event);
      if (event.act.kind !== "let-go") return cur;
      // 嘴上说算了只卸下当下尖刺，深疤仍留着，靠后续真诚互动慢慢化开。
      const who = speakerForMessage(after, event.scope, event.act.messageId);
      return who ? updatePerson(cur, who, event.at, (p) => ({ ...p, scar: p.scar * 0.88 })) : cur;
    }
    case "message.perceived":
      return applyPerceived(cur, after, event);
    case "ponder.done":
      return applyReflect(cur, event);
    case "message.sent":
      return applySent(cur, before, after, event);
    case "message.received":
      return applyReceived(cur, after, event);
    case "reaction.received":
      return applyReaction(cur, before, event);
    case "act.failed": {
      const chat = after.chats[event.scope];
      if (event.reason !== "refused" || chat?.chatType !== "private" || !chat.partner) return cur;
      return updatePerson(cur, chat.partner, event.at, (p) => ({
        ...p,
        scar: clamp01(p.scar + 0.55),
        bond: p.bond * 0.5,
        proactivePendingAt: 0,
        proactiveMissed: p.proactiveMissed + 1,
      }));
    }
    default:
      return cur;
  }
}

/** 群聊近期发言人里最高的净牵挂分（bond * (1 - scar)），用来驱动对偏心之人在场群的自然倾向。 */
function groupAttachmentPull(
  world: View<"chats" | "attachment">,
  chat: ChatNode,
  now: number,
): number {
  const att = world.attachment;
  if (!att) return 0;
  let pull = 0;
  for (const id of new Set(chat.recentFrom.slice(-8))) {
    const p = decayedAttachment(att.people[id], now);
    const net = p.bond * (1 - p.scar);
    if (net > pull) pull = net;
  }
  return pull;
}

function partnerLonelyResonance(
  world: View<"affect">,
  bond: number,
  scar: number,
  now: number,
): number {
  if (bond <= 0.25 || scar >= 0.15) return 0;
  const val = valenceAt(world.affect, now);
  const sought = world.affect.soughtAt;
  const lonelyElapsed = sought !== null && sought > 0 ? Math.max(0, now - sought) : 0;
  return val < world.affect.home || lonelyElapsed >= LONELY_RESONANCE_MS ? 0.15 * bond : 0;
}

/**
 * ADR-299 情感依恋与深疤闭环：连接此刻心动/伤感与长期意愿、记忆权重与社交代价。
 */
export const attachmentLoop: PressureFeature = feature({
  name: "attachment-loop",
  provides: ["attachment"],
  requires: ["chats", "relations"],
  uses: ["affect", "feedback"],
  reduce: (before, after, event) => {
    const next = reduceAttachment(before, after, event);
    return next === after.attachment ? after : { ...after, attachment: next };
  },
  will: {
    intrinsicGain: (world, reading, now) => {
      const att = world.attachment;
      const chat = world.chats[reading.scope];
      if (!att || !chat) return 1;
      if (chat.chatType === "private" && chat.partner) {
        const p = decayedAttachment(att.people[chat.partner], now);
        const attachBoost = 1 + 0.35 * p.bond * (1 - p.scar);
        const resonance = partnerLonelyResonance(world, p.bond, p.scar, now);
        const scarDamp = Math.max(0.45, 1 - 0.55 * p.scar);
        const missDamp = reading.solicited ? 1 : Math.max(0.55, 1 / (1 + 0.35 * p.proactiveMissed));
        return (attachBoost + resonance) * scarDamp * missDamp;
      }
      if (chat.chatType === "group") {
        const pull = groupAttachmentPull(world, chat, now);
        const waiting = world.relations.waiting[reading.scope] ?? [];
        const minScar =
          waiting.length > 0
            ? Math.min(...waiting.map((id) => decayedAttachment(att.people[id], now).scar))
            : 0;
        const waitDamp = waiting.length > 0 ? Math.max(0.6, 1 - 0.4 * minScar) : 1;
        return (1 + 0.25 * pull) * waitDamp;
      }
      return 1;
    },
    impositionScale: (world, chat, _affordance, now) => {
      const att = world.attachment;
      if (!att || chat.chatType !== "private" || !chat.partner) return 1;
      const p = decayedAttachment(att.people[chat.partner], now);
      if (p.bond <= 0.25 || p.scar >= 0.15) return 1;
      return Math.max(0.75, 1 - 0.25 * p.bond);
    },
    cost: (world, chat, affordance, now) => {
      const att = world.attachment;
      if (!att || memberAfter(affordance) !== undefined) {
        return 0;
      }
      if (chat.chatType === "private" && chat.partner) {
        const p = decayedAttachment(att.people[chat.partner], now);
        return p.scar >= 0.05 ? 0.65 * p.scar * (1 - (affordance.relieves.aversion ?? 0)) : 0;
      }
      return 0;
    },
  },
});
