/**
 * ADR-262 Wave 4F: hidden writeback context for prompt-visible social cases.
 *
 * Alice sees short natural case handles. The stable case-file handle stays in
 * execution context so ordinary prompts do not expose `caseId`.
 *
 * @see docs/adr/262-social-case-management/README.md
 */

export interface SocialCaseWritebackEntry {
  about: string;
  caseId: string;
  handle: string;
}

const CURRENT_SOCIAL_CASE_ID = "CURRENT_SOCIAL_CASE_ID";
const CURRENT_SOCIAL_CASE_ABOUT = "CURRENT_SOCIAL_CASE_ABOUT";
const CURRENT_SOCIAL_CASE_HANDLE = "CURRENT_SOCIAL_CASE_HANDLE";
const SOCIAL_CASE_SLOT_PREFIX = "SOCIAL_CASE_";
const MAX_CONTEXT_CASES = 10;

function contextString(contextVars: Record<string, unknown>, key: string): string | undefined {
  const value = contextVars[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function argString(args: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = args?.[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function socialCaseWritebackContextVars(
  entries: readonly SocialCaseWritebackEntry[],
): Record<string, string> {
  const vars: Record<string, string> = {};
  const visibleEntries = entries
    .filter(
      (entry) =>
        entry.about.trim().length > 0 &&
        entry.caseId.trim().length > 0 &&
        entry.handle.trim().length > 0,
    )
    .slice(0, MAX_CONTEXT_CASES);

  if (visibleEntries.length === 1) {
    vars[CURRENT_SOCIAL_CASE_ID] = visibleEntries[0].caseId;
    vars[CURRENT_SOCIAL_CASE_ABOUT] = visibleEntries[0].about;
    vars[CURRENT_SOCIAL_CASE_HANDLE] = visibleEntries[0].handle;
  }

  visibleEntries.forEach((entry, index) => {
    vars[`${SOCIAL_CASE_SLOT_PREFIX}${index}_ABOUT`] = entry.about;
    vars[`${SOCIAL_CASE_SLOT_PREFIX}${index}_HANDLE`] = entry.handle;
    vars[`${SOCIAL_CASE_SLOT_PREFIX}${index}_ID`] = entry.caseId;
  });

  return vars;
}

export function replaceSocialCaseWritebackContextVars(
  target: Record<string, unknown>,
  next: Record<string, string>,
): void {
  delete target[CURRENT_SOCIAL_CASE_ID];
  delete target[CURRENT_SOCIAL_CASE_ABOUT];
  delete target[CURRENT_SOCIAL_CASE_HANDLE];
  for (let index = 0; index < MAX_CONTEXT_CASES; index++) {
    delete target[`${SOCIAL_CASE_SLOT_PREFIX}${index}_ABOUT`];
    delete target[`${SOCIAL_CASE_SLOT_PREFIX}${index}_HANDLE`];
    delete target[`${SOCIAL_CASE_SLOT_PREFIX}${index}_ID`];
  }
  Object.assign(target, next);
}

export function deriveSocialCaseIdFromContext(
  contextVars: Record<string, unknown>,
  args?: Record<string, unknown>,
): string | undefined {
  const handle = argString(args, "case");
  if (handle) {
    for (let index = 0; index < MAX_CONTEXT_CASES; index++) {
      const slotHandle = contextString(contextVars, `${SOCIAL_CASE_SLOT_PREFIX}${index}_HANDLE`);
      if (slotHandle !== handle) continue;
      return contextString(contextVars, `${SOCIAL_CASE_SLOT_PREFIX}${index}_ID`);
    }
    return undefined;
  }

  const about = argString(args, "about");
  if (about) {
    for (let index = 0; index < MAX_CONTEXT_CASES; index++) {
      const slotAbout = contextString(contextVars, `${SOCIAL_CASE_SLOT_PREFIX}${index}_ABOUT`);
      if (slotAbout !== about) continue;
      return contextString(contextVars, `${SOCIAL_CASE_SLOT_PREFIX}${index}_ID`);
    }
    return undefined;
  }

  return contextString(contextVars, CURRENT_SOCIAL_CASE_ID);
}
