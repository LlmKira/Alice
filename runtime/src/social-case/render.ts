import type { CaseRenderOptions, CaseRunbookAction, SocialCaseProjection } from "./types.js";

const DEFAULT_ACTIONS: readonly CaseRunbookAction[] = [
  {
    label: "Reply in this chat",
    command: 'irc reply --ref <msg> --text "..."',
    meaning: "Respond to a concrete message in the current venue.",
  },
  {
    label: "Speak in this chat",
    command: 'irc say --text "..."',
    meaning: "Say something in the current venue.",
  },
  {
    label: "Record a case fact",
    command:
      'self social-case-note --kind <insult|apology|forgiveness|boundary_violation|repair_rejected|betrayal|support> --other <person> --venue <place> --visibility <private|public|semi_public> --text "..." --why "..."',
    meaning:
      "Append a typed social event fact. Use repair_rejected for fake apology, betrayal for cross-context betrayal, and boundary_violation only for repeated harm after repair or a boundary.",
  },
  {
    label: "Record repeated boundary harm",
    command:
      'self social-case-note --kind boundary_violation --other <person> --venue <place> --visibility public --text "..." --why "They repeated the same harm after a boundary."',
    meaning:
      "Use this only when a repaired or boundary-set case is reopened by a repeated insult or boundary break.",
  },
  {
    label: "Record fake repair",
    command:
      'self social-case-note --kind repair_rejected --other <person> --venue <place> --visibility <private|public|semi_public> --text "..." --why "Their repair was rejected or contradicted."',
    meaning: "Use this when an apology or repair attempt is contradicted by later behavior.",
  },
  {
    label: "Record Alice apology",
    command:
      'self social-case-note --kind apology --other <person> --actor Alice --target <person> --venue <place> --visibility public --text "..." --why "Alice corrects her own public mistake."',
    meaning:
      "Use this when Alice caused the harm; a public reply alone does not record the case repair fact.",
  },
  {
    label: "Inspect this case",
    command: "self social-cases --other <person>",
    meaning: "Read the current case brief before acting.",
  },
];

function isVisibleOnSurface(
  causeVisibility: string,
  surfaceVisibility: CaseRenderOptions["surfaceVisibility"],
): boolean {
  return surfaceVisibility === "private" || causeVisibility !== "private";
}

function renderActions(options: CaseRenderOptions): CaseRunbookAction[] {
  const actions = [...(options.actions ?? DEFAULT_ACTIONS)];
  if (options.threadId != null) {
    actions.push({
      label: "Close the visible case/thread after speaking",
      command: `irc say --resolve-thread ${options.threadId} --text "..."`,
      meaning: "Migration-only handle; this does not make thread the social fact authority.",
    });
  }
  return actions;
}

function commandWithWritebackHandle(
  command: string,
  handle: string | undefined,
  about: string | undefined,
): string {
  if (!command.startsWith("self social-case-note ")) return command;
  if (handle) {
    if (command.includes(" --case ")) return command;
    const quoted = `"${handle.replace(/["\\$`]/g, "\\$&")}"`;
    return command.replace("self social-case-note ", `self social-case-note --case ${quoted} `);
  }
  if (command.includes(" --about ")) return command;
  if (!about) return command;
  const quoted = `"${about.replace(/["\\$`]/g, "\\$&")}"`;
  return command.replace("self social-case-note ", `self social-case-note --about ${quoted} `);
}

export function renderSocialCaseBrief(
  projection: SocialCaseProjection,
  options: CaseRenderOptions,
): string {
  return renderSocialCaseBriefLines(projection, options).join("\n");
}

export function renderSocialCaseBriefLines(
  projection: SocialCaseProjection,
  options: CaseRenderOptions,
): string[] {
  const lines: string[] = [];
  const selfId = options.selfId ?? "alice";
  const other = projection.pair.find((id) => id !== selfId) ?? projection.pair[0];
  const entityLabel = options.labelForEntity ?? ((id: string) => id);
  const venueLabel = options.labelForVenue ?? ((id: string) => id);

  lines.push(`Social case with ${entityLabel(other)}`);
  if (options.writebackHandle) lines.push(`Case handle: ${options.writebackHandle}`);
  lines.push(`Case brief: ${projection.currentRead}`);
  lines.push("发生了什么:");

  let hiddenPrivateCauseCount = 0;
  for (const event of projection.events) {
    const eventTextVisible = isVisibleOnSurface(event.visibility, options.surfaceVisibility);
    if (!eventTextVisible) {
      hiddenPrivateCauseCount++;
      continue;
    }

    const quote = event.text ? `: "${event.text}"` : "";
    lines.push(
      `- In ${venueLabel(event.venueId)}, ${entityLabel(event.actorId)} ${event.kind}${quote}.`,
    );
    for (const cause of event.causes ?? []) {
      if (isVisibleOnSurface(cause.visibility, options.surfaceVisibility)) {
        lines.push(`- Why: ${cause.text}`);
      } else {
        hiddenPrivateCauseCount++;
      }
    }
  }

  if (hiddenPrivateCauseCount > 0) {
    lines.push(
      `- ${hiddenPrivateCauseCount} private detail(s) exist but are not shown on this surface.`,
    );
  }

  lines.push("Action runbook: available commands, not a recommendation.");
  lines.push("可以做什么:");
  for (const action of renderActions(options)) {
    lines.push(
      `- ${action.label}: \`${commandWithWritebackHandle(
        action.command,
        options.writebackHandle,
        options.writebackAbout,
      )}\` (${action.meaning})`,
    );
  }

  return lines;
}
