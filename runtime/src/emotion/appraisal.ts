/**
 * ADR-268 structured appraisal producers.
 *
 * These functions consume typed runtime facts and produce emotion episodes or
 * repair facts. They intentionally do not classify raw prompt text.
 *
 * @see docs/adr/268-emotion-episode-state/README.md
 */
import type { ScriptExecutionErrorCode } from "../core/script-execution.js";
import { chatIdToContactId, DUNBAR_TIER_THETA, ensureChannelId } from "../graph/constants.js";
import type { DunbarTier } from "../graph/entities.js";
import type { WorldModel } from "../graph/world-model.js";
import type { SocialEvent } from "../social-case/types.js";
import { recordEmotionEpisode, recordEmotionRepair } from "./graph.js";
import type { EmotionKind } from "./types.js";

const FAILURE_MEMORY_MS = 15 * 60_000;
const LONELY_DEBOUNCE_MS = 2 * 60 * 60_000;

type ActionFailureClass = "provider" | "telegram" | "validation" | "command" | "script";

const FAILURE_CLASS_BY_CODE: Partial<Record<ScriptExecutionErrorCode, ActionFailureClass>> = {
  provider_unavailable: "provider",
  timeout: "telegram",
  invalid_reaction: "telegram",
  invalid_sticker_keyword: "telegram",
  unreachable_telegram_user: "telegram",
  voice_messages_forbidden: "telegram",
  telegram_hard_permanent: "telegram",
  telegram_soft_permanent: "telegram",
  command_cross_chat_send: "command",
  command_invalid_target: "command",
  command_invalid_message_id: "command",
  command_invalid_reply_ref: "command",
  command_missing_argument: "command",
  command_arg_format: "command",
  script_validation: "validation",
  shell_nonzero: "script",
};

function stableHash(input: string): string {
  let hash = 0;
  for (const ch of input) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash.toString(36);
}

function socialEmotionId(event: SocialEvent, kind: EmotionKind): string {
  return `emotion-social-${kind}-${stableHash(event.id)}`;
}

function socialRepairId(event: SocialEvent, repairKind: string): string {
  return `emotion-repair-social-${repairKind}-${stableHash(event.id)}`;
}

function socialEventSummary(event: SocialEvent): string {
  const cause = event.causes?.find((item) => item.kind === "social_meaning")?.text;
  return cause ?? event.text ?? `${event.kind} was recorded as a social case fact.`;
}

export function appraiseSocialEventEmotion(
  graph: WorldModel,
  event: SocialEvent,
  nowMs = event.occurredAtMs,
): void {
  const summary = socialEventSummary(event);
  const targetId = event.venueId || event.actorId;
  const common = {
    targetId,
    nowMs,
    cause: { type: "feedback" as const, evidenceId: event.id, summary },
  };

  switch (event.kind) {
    case "support": {
      const kind: EmotionKind = event.severity >= 0.7 ? "touched" : "pleased";
      recordEmotionEpisode(graph, {
        ...common,
        id: socialEmotionId(event, kind),
        kind,
        intensity: 0.25 + event.severity * 0.45,
        confidence: event.confidence,
      });
      if (event.severity >= 0.6) {
        recordEmotionEpisode(graph, {
          ...common,
          id: socialEmotionId(event, "shy"),
          kind: "shy",
          intensity: 0.2 + event.severity * 0.28,
          confidence: event.confidence,
        });
      }
      break;
    }
    case "apology": {
      recordEmotionRepair(graph, {
        id: socialRepairId(event, "apology"),
        repairKind: "apology",
        emotionKind: "hurt",
        targetId,
        strength: 0.35 + event.severity * 0.5,
        confidence: event.confidence,
        nowMs,
        cause: { type: "feedback", evidenceId: event.id, summary },
      });
      break;
    }
    case "repair_attempt": {
      recordEmotionRepair(graph, {
        id: socialRepairId(event, "warm_clarification"),
        repairKind: "warm_clarification",
        emotionKind: "hurt",
        targetId,
        strength: 0.25 + event.severity * 0.35,
        confidence: event.confidence,
        nowMs,
        cause: { type: "feedback", evidenceId: event.id, summary },
      });
      break;
    }
    case "forgiveness": {
      recordEmotionRepair(graph, {
        id: socialRepairId(event, "successful_repair"),
        repairKind: "successful_repair",
        targetId,
        strength: 0.5 + event.severity * 0.4,
        confidence: event.confidence,
        nowMs,
        cause: { type: "feedback", evidenceId: event.id, summary },
      });
      break;
    }
    case "insult":
    case "exclusion":
    case "betrayal":
    case "boundary_violation":
    case "repair_rejected": {
      recordEmotionEpisode(graph, {
        ...common,
        id: socialEmotionId(event, "hurt"),
        kind: "hurt",
        intensity: 0.35 + event.severity * 0.45,
        confidence: event.confidence,
      });
      break;
    }
    default:
      break;
  }
}

export function appraiseActivityEmotion(
  graph: WorldModel,
  input: {
    targetId: string;
    activityType: string;
    intensity: number | null;
    relevance: number | null;
    nowMs: number;
  },
): void {
  if (input.relevance == null || input.relevance > 0.2) return;
  if (input.intensity != null && input.intensity > 0.4) return;

  recordEmotionEpisode(graph, {
    id: `emotion-activity-flat-${stableHash(`${input.targetId}:${input.activityType}:${input.nowMs}`)}`,
    kind: "flat",
    targetId: input.targetId,
    nowMs: input.nowMs,
    intensity: 0.25,
    confidence: 0.55,
    cause: {
      type: "memory",
      summary: `The current activity in ${input.targetId} has little pull for Alice.`,
    },
  });
}

export function appraiseRiskEmotion(
  graph: WorldModel,
  input: {
    targetId: string;
    level: string;
    reason?: string;
    nowMs: number;
  },
): void {
  if (input.level !== "medium" && input.level !== "high") return;
  recordEmotionEpisode(graph, {
    id: `emotion-risk-uneasy-${stableHash(`${input.targetId}:${input.level}:${input.nowMs}`)}`,
    kind: "uneasy",
    targetId: input.targetId,
    nowMs: input.nowMs,
    intensity: input.level === "high" ? 0.55 : 0.35,
    confidence: 0.65,
    cause: {
      type: "feedback",
      summary: input.reason ?? "A structured social risk signal made the situation feel uncertain.",
    },
  });
}

export function appraiseActionFailureEmotion(
  graph: WorldModel,
  input: {
    targetId?: string;
    errorCodes: readonly ScriptExecutionErrorCode[];
    failureKind?: "provider_unavailable" | "llm_invalid";
    nowMs: number;
  },
): void {
  const classes = new Set<ActionFailureClass>();
  for (const code of input.errorCodes) {
    const cls = FAILURE_CLASS_BY_CODE[code];
    if (cls) classes.add(cls);
  }
  if (input.failureKind === "provider_unavailable") classes.add("provider");
  if (input.failureKind === "llm_invalid") classes.add("validation");
  if (classes.size === 0 && input.errorCodes.length === 0 && input.failureKind == null) {
    classes.add("validation");
  }
  if (classes.size === 0) return;

  const currentCount = Number(graph.getDynamic("self", "emotion_failure_count") ?? 0);
  const lastMs = Number(graph.getDynamic("self", "emotion_failure_last_ms") ?? 0);
  const recent = lastMs > 0 && input.nowMs - lastMs <= FAILURE_MEMORY_MS;
  const nextCount = recent ? currentCount + 1 : 1;
  graph.setDynamic("self", "emotion_failure_count", nextCount);
  graph.setDynamic("self", "emotion_failure_last_ms", input.nowMs);

  const deterministic = classes.has("telegram") || classes.has("command") || classes.has("script");
  const kind: EmotionKind = deterministic && nextCount >= 2 ? "annoyed" : "tired";
  recordEmotionEpisode(graph, {
    id: `emotion-action-${kind}-${stableHash(`${input.targetId ?? "self"}:${input.errorCodes.join(",")}:${input.nowMs}`)}`,
    kind,
    targetId: input.targetId,
    nowMs: input.nowMs,
    intensity: Math.min(0.65, 0.25 + nextCount * 0.12),
    confidence: 0.7,
    cause: {
      type: deterministic ? "action_result" : "overload",
      summary:
        kind === "annoyed"
          ? "Repeated deterministic action failures created irritating friction."
          : "The last response path failed and left Alice lower on energy.",
    },
  });
}

export function appraiseLonelySilence(graph: WorldModel, nowMs: number): void {
  for (const channelId of graph.getEntitiesByType("channel")) {
    const channel = graph.getChannel(channelId);
    if (channel.chat_type !== "private") continue;
    const contactId = chatIdToContactId(channelId);
    if (!contactId || !graph.has(contactId)) continue;
    const contact = graph.getContact(contactId);
    const tier = contact.tier as DunbarTier;
    if (tier > 50) continue;

    const lastOutgoingMs = Number(channel.last_outgoing_ms ?? 0);
    const lastIncomingMs = Number(channel.last_incoming_ms ?? 0);
    const consecutiveOutgoing = Number(channel.consecutive_outgoing ?? 0);
    if (lastOutgoingMs <= 0 || consecutiveOutgoing !== 1) continue;
    if (lastIncomingMs > lastOutgoingMs) continue;

    const waitMs = Math.min(3 * 60 * 60_000, (DUNBAR_TIER_THETA[tier] ?? 43_200) * 1000 * 0.25);
    if (nowMs - lastOutgoingMs < waitMs) continue;

    const lastLonelyMs = Number(graph.getDynamic(channelId, "emotion_lonely_ms") ?? 0);
    if (lastLonelyMs > 0 && nowMs - lastLonelyMs < LONELY_DEBOUNCE_MS) continue;

    recordEmotionEpisode(graph, {
      id: `emotion-lonely-${stableHash(`${channelId}:${lastOutgoingMs}`)}`,
      kind: "lonely",
      targetId: ensureChannelId(channelId) ?? channelId,
      nowMs,
      intensity: tier <= 15 ? 0.45 : 0.35,
      confidence: 0.65,
      cause: {
        type: "silence",
        targetId: channelId,
        summary: "A close chat stayed quiet after one soft check-in.",
      },
    });
    graph.setDynamic(channelId, "emotion_lonely_ms", nowMs);
  }
}

export function appraiseWarmReturnRepair(
  graph: WorldModel,
  input: { channelId: string; nowMs: number },
): void {
  recordEmotionRepair(graph, {
    id: `emotion-repair-warm-return-${stableHash(`${input.channelId}:${input.nowMs}`)}`,
    repairKind: "warm_return",
    emotionKind: "lonely",
    targetId: input.channelId,
    strength: 0.8,
    confidence: 0.7,
    nowMs: input.nowMs,
    cause: {
      type: "message",
      summary: "The person returned warmly after a quiet stretch.",
    },
  });
}
