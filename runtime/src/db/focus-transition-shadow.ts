/**
 * ADR-259 Wave 1: append-only shadow focus transition facts.
 *
 * This writer records structured execution-boundary evidence only: rejected
 * cross-chat sends, remote observations, and forwarded share edges. It must not
 * be read by IAUS, retarget gates, pressure scoring, or send authorization.
 * @see docs/adr/259-focus-trajectory-closed-loop/README.md §Wave 1
 */
import type { ExecutionObservation, ScriptExecutionErrorDetail } from "../core/script-execution.js";
import { getDb } from "./connection.js";
import { writeFocusTransitionIntent } from "./focus-transition-intent.js";
import { focusTransitionShadow } from "./schema.js";

function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function classifyShadow(source: string): string {
  if (
    source === "irc.say" ||
    source === "irc.reply" ||
    source === "irc.sticker" ||
    source === "irc.voice" ||
    source === "irc.send-file"
  ) {
    return "switch_then_send_shadow";
  }
  return "cross_chat_send_shadow";
}

function parseActionFields(action: string): { kind: string; fields: Record<string, string> } {
  const [kind = "", ...parts] = action.split(":");
  const fields: Record<string, string> = {};
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    fields[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return { kind, fields };
}

function channelIdFromSourceTarget(sourceTarget?: string | null): string | null {
  const prefix = "channel:";
  return sourceTarget?.startsWith(prefix) ? sourceTarget.slice(prefix.length) : null;
}

function writeShadow(input: {
  transitionShadowId: string;
  tick: number;
  actionId: string;
  actionLogId?: number | null;
  candidateId?: string | null;
  sourceTarget?: string | null;
  currentChatId: string;
  requestedChatId: string;
  sourceCommand: string;
  transitionClass: string;
  evidenceStatus: string;
  payload?: unknown;
}): void {
  getDb()
    .insert(focusTransitionShadow)
    .values({
      transitionShadowId: input.transitionShadowId,
      tick: input.tick,
      actionId: input.actionId,
      actionLogId: input.actionLogId ?? null,
      candidateId: input.candidateId ?? null,
      sourceTarget: input.sourceTarget ?? null,
      currentChatId: input.currentChatId,
      requestedChatId: input.requestedChatId,
      sourceCommand: input.sourceCommand,
      transitionClass: input.transitionClass,
      evidenceStatus: input.evidenceStatus,
      payloadJson: encodeJson(input.payload ?? {}),
    })
    .onConflictDoNothing()
    .run();
}

export function writeFocusTransitionShadows(input: {
  tick: number;
  actionId: string;
  actionLogId?: number | null;
  candidateId?: string | null;
  sourceTarget?: string | null;
  errorDetails: readonly ScriptExecutionErrorDetail[];
  observations?: readonly ExecutionObservation[];
  completedActions?: readonly string[];
}): void {
  let errorIndex = 0;
  for (const detail of input.errorDetails) {
    if (detail.code !== "command_cross_chat_send") continue;
    if (!detail.currentChatId || !detail.requestedChatId) continue;

    writeShadow({
      transitionShadowId: `focus_shadow:${input.actionId}:${errorIndex}`,
      tick: input.tick,
      actionId: input.actionId,
      actionLogId: input.actionLogId,
      candidateId: input.candidateId,
      sourceTarget: input.sourceTarget,
      currentChatId: detail.currentChatId,
      requestedChatId: detail.requestedChatId,
      sourceCommand: detail.source,
      transitionClass: classifyShadow(detail.source),
      evidenceStatus: "structured_requested_target",
      payload: detail.payload ?? {},
    });
    writeFocusTransitionIntent({
      intentId: `blocked_switch_request:${input.actionId}:${errorIndex}`,
      tick: input.tick,
      sourceChatId: detail.currentChatId,
      requestedChatId: detail.requestedChatId,
      intentKind: "switch_request_blocked",
      reason: "Tried to send in another chat before it became current.",
      sourceCommand: detail.source,
      payload: {
        actionId: input.actionId,
        sourceTarget: input.sourceTarget ?? null,
        attemptedCommand: detail.source,
        ...(detail.payload ? { attemptedPayload: detail.payload } : {}),
      },
    });
    errorIndex++;
  }

  let observationIndex = 0;
  for (const observation of input.observations ?? []) {
    if (observation.source !== "irc.tail" && observation.source !== "irc.read") continue;
    if (!observation.currentChatId || !observation.targetChatId) continue;
    if (observation.currentChatId === observation.targetChatId) continue;

    writeShadow({
      transitionShadowId: `focus_shadow:${input.actionId}:observation:${observationIndex}`,
      tick: input.tick,
      actionId: input.actionId,
      actionLogId: input.actionLogId,
      candidateId: input.candidateId,
      sourceTarget: input.sourceTarget,
      currentChatId: observation.currentChatId,
      requestedChatId: observation.targetChatId,
      sourceCommand: observation.source,
      transitionClass: "observe_shadow",
      evidenceStatus: "structured_observation_target",
      payload: {
        kind: observation.kind,
        ...(observation.payload ?? {}),
      },
    });
    observationIndex++;
  }

  const currentChatId = channelIdFromSourceTarget(input.sourceTarget);
  let actionIndex = 0;
  for (const action of input.completedActions ?? []) {
    const { kind, fields } = parseActionFields(action);
    if (kind !== "forwarded") continue;
    if (!fields.from || !fields.to) continue;
    const current = currentChatId ?? fields.from;
    if (current === fields.to && fields.from === fields.to) continue;

    writeShadow({
      transitionShadowId: `focus_shadow:${input.actionId}:completed:${actionIndex}`,
      tick: input.tick,
      actionId: input.actionId,
      actionLogId: input.actionLogId,
      candidateId: input.candidateId,
      sourceTarget: input.sourceTarget,
      currentChatId: fields.from,
      requestedChatId: fields.to,
      sourceCommand: "irc.forward",
      transitionClass: "share_shadow",
      evidenceStatus: "structured_completed_action",
      payload: {
        authorizedChatId: current,
        fromChatId: fields.from,
        toChatId: fields.to,
        msgId: fields.msgId ?? null,
      },
    });
    actionIndex++;
  }
}
