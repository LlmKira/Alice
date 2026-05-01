/**
 * ADR-254 Wave 0: pure diagnostic classifier for IAUS action_log rows.
 *
 * This is an audit fallback over already persisted facts. It must not become
 * runtime control policy or a long-term authority for Telegram execution state.
 *
 * @see docs/adr/254-target-control-projection/README.md
 */

export type IausActionCategory =
  | "telegram_success"
  | "telegram_failure"
  | "command_misuse"
  | "llm_silence"
  | "llm_failure"
  | "observe_only"
  | "internal_action";

export type IausTelegramEffect =
  | "send"
  | "reply"
  | "sticker"
  | "voice"
  | "react"
  | "read"
  | "forward";

export type IausTelegramEffectCounts = Record<IausTelegramEffect, number>;

export interface IausActionClassifierRow {
  action_type: string | null;
  success: number | boolean | null;
  tc_command_log: string | null;
  engagement_outcome: string | null;
  tc_afterward: string | null;
}

export interface IausActionClassification {
  category: IausActionCategory;
  telegramSuccesses: number;
  telegramFailures: number;
  successEffects: IausTelegramEffectCounts;
  failureEffects: IausTelegramEffectCounts;
}

const EFFECTS: IausTelegramEffect[] = [
  "send",
  "reply",
  "sticker",
  "voice",
  "react",
  "read",
  "forward",
];

const COMMAND_EFFECTS: Partial<Record<string, IausTelegramEffect>> = {
  say: "send",
  reply: "reply",
  sticker: "sticker",
  voice: "voice",
  react: "react",
  read: "read",
  forward: "forward",
};

const TELEGRAM_FAILURE_RE =
  /(Engine API (?:returned \d+ for POST \/telegram\/[a-z-]+|timeout)|INPUT_USER_DEACTIVATED|CHANNEL_INVALID|REACTION_INVALID|refusing cross-chat send|telegram\/[a-z-]+ failed)/i;

export function classifyIausActionRow(row: IausActionClassifierRow): IausActionClassification {
  const successEffects = emptyEffectCounts();
  const failureEffects = emptyEffectCounts();
  const commandLog = row.tc_command_log ?? "";

  const attempts = extractTelegramAttempts(commandLog);
  for (const effect of extractSuccessEffects(commandLog)) {
    increment(successEffects, effect);
  }
  for (const effect of extractFailureEffects(commandLog, attempts)) {
    increment(failureEffects, effect);
  }

  const telegramSuccesses = sumEffects(successEffects);
  const telegramFailures = sumEffects(failureEffects);
  const category = classifyCategory(row, {
    commandLog,
    telegramSuccesses,
    telegramFailures,
  });

  return {
    category,
    telegramSuccesses,
    telegramFailures,
    successEffects,
    failureEffects,
  };
}

export function emptyEffectCounts(): IausTelegramEffectCounts {
  return Object.fromEntries(EFFECTS.map((effect) => [effect, 0])) as IausTelegramEffectCounts;
}

function classifyCategory(
  row: IausActionClassifierRow,
  facts: { commandLog: string; telegramSuccesses: number; telegramFailures: number },
): IausActionCategory {
  const actionType = row.action_type ?? "";
  if (actionType === "command_misuse") return "command_misuse";
  if (actionType === "telegram_failed") return "telegram_failure";
  if (
    actionType === "llm_failed" ||
    actionType === "provider_failed" ||
    actionType === "validation_failed" ||
    row.engagement_outcome === "llm_failed"
  ) {
    return "llm_failure";
  }
  if (actionType === "silence") return "llm_silence";
  if (facts.telegramSuccesses > 0) return "telegram_success";
  if (facts.telegramFailures > 0) return "telegram_failure";
  if (hasInternalAction(facts.commandLog, actionType, row.tc_afterward)) return "internal_action";
  return "observe_only";
}

function extractTelegramAttempts(commandLog: string): IausTelegramEffect[] {
  const attempts: IausTelegramEffect[] = [];
  const re = /^\s*(?:\$\s*)?irc\s+([a-z-]+)\b/gim;
  for (const match of commandLog.matchAll(re)) {
    const effect = COMMAND_EFFECTS[match[1]?.toLowerCase() ?? ""];
    if (effect) attempts.push(effect);
  }
  return attempts;
}

function extractSuccessEffects(commandLog: string): IausTelegramEffect[] {
  return [
    ...repeat("sticker", countMatches(commandLog, /^\s*\u2713 Sent sticker\b/gim)),
    ...repeat("voice", countMatches(commandLog, /^\s*\u2713 Sent voice\b/gim)),
    ...repeat("reply", countMatches(commandLog, /^\s*\u2713 Replied to:/gim)),
    ...repeat("send", countMatches(commandLog, /^\s*\u2713 Sent:/gim)),
    ...repeat("react", countMatches(commandLog, /^\s*\u2713 Reacted\b/gim)),
    ...repeat("read", countMatches(commandLog, /^\s*\u2713 Marked as read\b/gim)),
    ...repeat("forward", countMatches(commandLog, /^\s*\u2713 Forwarded:/gim)),
  ];
}

function extractFailureEffects(
  commandLog: string,
  attempts: readonly IausTelegramEffect[],
): IausTelegramEffect[] {
  const effects: IausTelegramEffect[] = [];
  const endpointRe = /POST \/telegram\/([a-z-]+)/gi;
  for (const match of commandLog.matchAll(endpointRe)) {
    const effect = mapTelegramEndpoint(match[1] ?? "");
    if (effect) effects.push(effect);
  }
  if (effects.length > 0) return effects;
  if (!TELEGRAM_FAILURE_RE.test(commandLog)) return [];
  const attemptedEffect = attempts.at(-1);
  return attemptedEffect ? [attemptedEffect] : [];
}

function hasInternalAction(
  commandLog: string,
  actionType: string,
  afterward: string | null,
): boolean {
  if (actionType !== "observe" && actionType !== "") return true;
  if (/^\s*self\s+/im.test(commandLog)) return true;
  if (/^\s*\u2713 Done\b/im.test(commandLog)) return true;
  if (/\bsuccess:\s*true\b/i.test(commandLog)) return true;
  return afterward === "done" && commandLog.trim().length === 0;
}

function mapTelegramEndpoint(endpoint: string): IausTelegramEffect | null {
  switch (endpoint) {
    case "send":
      return "send";
    case "sticker":
      return "sticker";
    case "voice":
      return "voice";
    case "react":
      return "react";
    case "read":
      return "read";
    case "forward":
      return "forward";
    default:
      return null;
  }
}

function countMatches(text: string, re: RegExp): number {
  return [...text.matchAll(re)].length;
}

function repeat(effect: IausTelegramEffect, count: number): IausTelegramEffect[] {
  return Array.from({ length: count }, () => effect);
}

function increment(counts: IausTelegramEffectCounts, effect: IausTelegramEffect): void {
  counts[effect]++;
}

function sumEffects(counts: IausTelegramEffectCounts): number {
  return EFFECTS.reduce((sum, effect) => sum + counts[effect], 0);
}
