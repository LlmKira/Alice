/**
 * ADR-259 Wave 3: append-only read-only focus transition intents.
 *
 * This writer records transition requests only. It must not switch active chat,
 * authorize sends, feed IAUS, or feed a retarget gate in Wave 3.
 * @see docs/adr/259-focus-trajectory-closed-loop/wave-3-readonly-intent-audit.md
 */
import { randomUUID } from "node:crypto";
import { getDb } from "./connection.js";
import { focusTransitionIntent } from "./schema.js";

export type FocusTransitionIntentKind = "observe" | "switch_request" | "switch_request_blocked";

export interface WrittenFocusTransitionIntent {
  intentId: string;
  tick: number;
  sourceChatId: string;
  requestedChatId: string;
  intentKind: FocusTransitionIntentKind;
  reason: string;
}

export function writeFocusTransitionIntent(input: {
  intentId?: string;
  tick: number;
  sourceChatId?: string | null;
  requestedChatId: string;
  intentKind: FocusTransitionIntentKind;
  reason: string;
  sourceCommand?: string;
  payload?: unknown;
}): WrittenFocusTransitionIntent {
  const sourceChatId = normalizeChatId(input.sourceChatId);
  const requestedChatId = normalizeChatId(input.requestedChatId);
  const reason = input.reason.trim();
  const sourceCommand = input.sourceCommand ?? "self.attention-pull";
  const row = {
    intentId: input.intentId ?? `${input.intentKind}_${input.tick}_${randomUUID()}`,
    tick: input.tick,
    sourceChatId,
    requestedChatId,
    intentKind: input.intentKind,
    reason,
  };

  getDb()
    .insert(focusTransitionIntent)
    .values({
      intentId: row.intentId,
      tick: row.tick,
      sourceChatId: row.sourceChatId,
      requestedChatId: row.requestedChatId,
      intentKind: row.intentKind,
      reason: row.reason,
      sourceCommand,
      payloadJson: encodeJson(input.payload ?? {}),
    })
    .onConflictDoNothing()
    .run();

  return row;
}

function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function normalizeChatId(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "unknown_source_chat";
}
