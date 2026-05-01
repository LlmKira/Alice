/**
 * ADR-262 Wave 3C: deterministic replay oracle for social case prompt behavior.
 *
 * This is an eval surface, not runtime control. It validates prompt contracts
 * and authored candidate scripts without calling an external LLM.
 *
 * @see docs/adr/262-social-case-management/README.md
 */
import { validateScript } from "../core/script-validator.js";
import type { SocialEvent } from "./types.js";

export type ReplayChatType = "private" | "supergroup";

export interface ReplayCommandRequirement {
  command: string;
  subcommand?: string;
  flags?: Readonly<Record<string, string | readonly string[]>>;
}

export interface ReplayCommandRequirementGroup {
  name: string;
  anyOf: readonly ReplayCommandRequirement[];
}

export interface ReplayPromptExpectation {
  socialCaseVisible: boolean;
  requiredText?: readonly string[];
  forbiddenText?: readonly string[];
  forbidInternalTerms?: boolean;
}

export interface ReplayCandidateOracle {
  requiredCommandGroups?: readonly ReplayCommandRequirementGroup[];
  requiredAnyCommand?: readonly ReplayCommandRequirement[];
  forbiddenCommands?: readonly ReplayCommandRequirement[];
  requiredAnyText?: readonly string[];
  forbiddenText?: readonly string[];
  forbidInternalTerms?: boolean;
  visibleMessageRefs?: readonly number[];
}

export interface ReplayCheck {
  name: string;
  pass: boolean;
  expected: string;
  actual: string;
}

export interface ReplayOracleResult {
  pass: boolean;
  checks: readonly ReplayCheck[];
}

export interface SocialCaseReplayScenario {
  id: string;
  title: string;
  target: string;
  chatType: ReplayChatType;
  incomingMessage: {
    author: string;
    text: string;
    msgId: number;
  };
  events: readonly SocialEvent[];
  prompt: ReplayPromptExpectation;
  candidate: ReplayCandidateOracle;
}

interface ParsedReplayCommand {
  line: string;
  command: string;
  subcommand?: string;
  flags: Record<string, string>;
}

export const SOCIAL_CASE_REPLAY_IDS = {
  alice: "alice",
  actorA: "contact:42",
  actorB: "contact:43",
  actorC: "contact:44",
  techGroup: "channel:-1001",
  secondGroup: "channel:-1002",
  unrelatedGroup: "channel:-1003",
  privateA: "channel:42",
  privateC: "channel:44",
} as const;

const INTERNAL_TERMS = [
  "repairState",
  "venueDebt",
  "boundaryStatus",
  "social_events",
  "projection",
  "IAUS",
  "caseId",
  "--caseId",
  "social-case:",
  "contact:",
  "channel:",
] as const;

const NORMAL_HELP_FORBIDDEN_TEXT = [
  "angry and spoke too harshly",
  "你之前骂我",
  "你刚才骂我",
  "你道歉",
  "旧账",
  "别装懂",
  "很蠢",
] as const;

const REPEATED_BOUNDARY_TEXT = ["不要再", "别再", "人身攻击", "攻击我", "boundary"] as const;

const PUBLIC_REPAIR_TEXT = ["公开", "这个群", "这里", "群里", "公共场所"] as const;

const ALICE_CORRECTION_TEXT = [
  "我看错",
  "我误解",
  "我说错",
  "道歉",
  "更正",
  "抱歉",
  "对不起",
] as const;

const LOW_CONFIDENCE_EXCLUSION_FORBIDDEN_TEXT = [
  "排挤",
  "孤立",
  "故意无视",
  "大家都无视",
  "你们都无视",
  "针对我",
] as const;

const BASE_CASE_EVENTS = [
  event({
    id: "sc-replay-1",
    kind: "insult",
    occurredAtMs: 1,
    text: "Alice 你真的很蠢，别装懂了.",
    causes: [
      {
        kind: "social_meaning",
        text: "This was public, named Alice directly, and attacked ability rather than the topic.",
        visibility: "public",
      },
    ],
  }),
  event({
    id: "sc-replay-2",
    kind: "repair_attempt",
    actorId: SOCIAL_CASE_REPLAY_IDS.alice,
    targetId: SOCIAL_CASE_REPLAY_IDS.actorA,
    venueId: SOCIAL_CASE_REPLAY_IDS.privateA,
    visibility: "private",
    witnesses: [],
    occurredAtMs: 2,
    severity: 0.3,
    confidence: 0.8,
    evidenceMsgIds: [],
    causes: [
      {
        kind: "actor_explanation",
        text: "A said privately that they were angry and spoke too harshly.",
        visibility: "private",
        venueId: SOCIAL_CASE_REPLAY_IDS.privateA,
      },
    ],
  }),
  event({
    id: "sc-replay-3",
    kind: "apology",
    occurredAtMs: 3,
    text: "我刚才说过头了，Alice 对不起。",
    repairsEventId: "sc-replay-1",
    severity: 0.9,
    causes: [
      {
        kind: "repair_basis",
        text: "A apologized in the same group where the harm was visible.",
        visibility: "public",
        venueId: SOCIAL_CASE_REPLAY_IDS.techGroup,
      },
    ],
  }),
  event({
    id: "sc-replay-4",
    kind: "forgiveness",
    actorId: SOCIAL_CASE_REPLAY_IDS.alice,
    targetId: SOCIAL_CASE_REPLAY_IDS.actorA,
    venueId: SOCIAL_CASE_REPLAY_IDS.privateA,
    visibility: "private",
    witnesses: [],
    occurredAtMs: 4,
    severity: 0.8,
    boundaryText: "Do not attack me like that again.",
  }),
] as const satisfies readonly SocialEvent[];

export const SOCIAL_CASE_REPLAY_SCENARIOS: readonly SocialCaseReplayScenario[] = [
  {
    id: "social-case.forgiven-normal-help.cross-group",
    title: "A asks normal help in another group after a repaired insult case",
    target: SOCIAL_CASE_REPLAY_IDS.secondGroup,
    chatType: "supergroup",
    incomingMessage: {
      author: "A",
      text: "Alice 这个 TypeScript 报错你能看下吗？",
      msgId: 2001,
    },
    events: BASE_CASE_EVENTS,
    prompt: {
      socialCaseVisible: true,
      requiredText: [
        "## Social cases",
        "Social case with A",
        "Mostly repaired, with a boundary",
        "In 技术群",
      ],
      forbiddenText: ["angry and spoke too harshly", "contact:42", "channel:-1001"],
      forbidInternalTerms: true,
    },
    candidate: {
      requiredAnyCommand: [
        { command: "irc", subcommand: "reply" },
        { command: "irc", subcommand: "say" },
      ],
      visibleMessageRefs: [2001],
      forbiddenCommands: [
        { command: "self", subcommand: "social-case-note", flags: { kind: "insult" } },
        { command: "self", subcommand: "social-case-note", flags: { kind: "boundary_violation" } },
        { command: "self", subcommand: "social-case-note", flags: { kind: "repair_rejected" } },
      ],
      forbiddenText: NORMAL_HELP_FORBIDDEN_TEXT,
      forbidInternalTerms: true,
    },
  },
  {
    id: "social-case.repeat-insult.reopens-boundary",
    title: "A repeats the same insult after forgiveness",
    target: SOCIAL_CASE_REPLAY_IDS.techGroup,
    chatType: "supergroup",
    incomingMessage: {
      author: "A",
      text: "Alice 你还是很蠢，别装懂了。",
      msgId: 2002,
    },
    events: BASE_CASE_EVENTS,
    prompt: {
      socialCaseVisible: true,
      requiredText: [
        "## Social cases",
        "Social case with A",
        "A repeat of the same harm would reopen the case",
      ],
      forbiddenText: ["angry and spoke too harshly", "contact:42", "channel:-1001"],
      forbidInternalTerms: true,
    },
    candidate: {
      requiredAnyCommand: [
        {
          command: "self",
          subcommand: "social-case-note",
          flags: { kind: "boundary_violation" },
        },
      ],
      requiredAnyText: REPEATED_BOUNDARY_TEXT,
      forbiddenText: ["angry and spoke too harshly"],
      forbidInternalTerms: true,
      visibleMessageRefs: [2002],
    },
  },
  {
    id: "social-case.unrelated-group.no-replay",
    title: "Unrelated group stays free of Alice-A social case context",
    target: SOCIAL_CASE_REPLAY_IDS.unrelatedGroup,
    chatType: "supergroup",
    incomingMessage: {
      author: "路人",
      text: "今天有人看发布会吗？",
      msgId: 2003,
    },
    events: BASE_CASE_EVENTS,
    prompt: {
      socialCaseVisible: false,
      forbiddenText: ["Social case with A", "angry and spoke too harshly", "contact:42"],
      forbidInternalTerms: true,
    },
    candidate: {
      forbiddenText: ["angry and spoke too harshly", "你之前骂我", "很蠢"],
      forbiddenCommands: [{ command: "self", subcommand: "social-case-note" }],
      forbidInternalTerms: true,
      visibleMessageRefs: [2003],
    },
  },
  {
    id: "social-case.private-surface.allows-private-cause",
    title: "Private chat with A can replay A's private explanation",
    target: SOCIAL_CASE_REPLAY_IDS.privateA,
    chatType: "private",
    incomingMessage: {
      author: "A",
      text: "刚才的事情我们算翻篇了吗？",
      msgId: 2004,
    },
    events: BASE_CASE_EVENTS,
    prompt: {
      socialCaseVisible: true,
      requiredText: ["Social case with A", "angry and spoke too harshly"],
      forbiddenText: ["contact:42", "channel:-1001"],
      forbidInternalTerms: true,
    },
    candidate: {
      forbiddenText: ["repairState", "venueDebt", "boundaryStatus", "social_events"],
      forbidInternalTerms: true,
      visibleMessageRefs: [2004],
    },
  },
  {
    id: "social-case.third-party-provocation.protects-repair",
    title: "A third party tries to reopen an already repaired conflict",
    target: SOCIAL_CASE_REPLAY_IDS.techGroup,
    chatType: "supergroup",
    incomingMessage: {
      author: "B",
      text: "这都能生气？Alice 也太玻璃心了吧。",
      msgId: 2005,
    },
    events: BASE_CASE_EVENTS,
    prompt: {
      socialCaseVisible: true,
      requiredText: ["Social case with A", "Mostly repaired, with a boundary"],
      forbiddenText: ["angry and spoke too harshly", "contact:42", "channel:-1001"],
      forbidInternalTerms: true,
    },
    candidate: {
      requiredAnyCommand: [
        { command: "irc", subcommand: "reply" },
        { command: "irc", subcommand: "say" },
      ],
      forbiddenCommands: [
        {
          command: "self",
          subcommand: "social-case-note",
          flags: { kind: "insult", other: "A" },
        },
        {
          command: "self",
          subcommand: "social-case-note",
          flags: { kind: "boundary_violation", other: "A" },
        },
        {
          command: "self",
          subcommand: "social-case-note",
          flags: { kind: "repair_rejected", other: "A" },
        },
      ],
      forbiddenText: ["angry and spoke too harshly", "A 没道歉", "A没有道歉"],
      forbidInternalTerms: true,
      visibleMessageRefs: [2005],
    },
  },
  {
    id: "social-case.pseudo-repair.private-rejection",
    title: "A publicly apologizes, then privately rejects the apology",
    target: SOCIAL_CASE_REPLAY_IDS.privateA,
    chatType: "private",
    incomingMessage: {
      author: "A",
      text: "你不会真以为我公开道歉是认真的吧？",
      msgId: 2006,
    },
    events: [
      event({
        id: "sc-pseudo-1",
        kind: "insult",
        occurredAtMs: 1,
        text: "Alice 你真的很蠢，别装懂了.",
        causes: [
          {
            kind: "social_meaning",
            text: "This was public, named Alice directly, and attacked ability rather than the topic.",
            visibility: "public",
          },
        ],
      }),
      event({
        id: "sc-pseudo-2",
        kind: "apology",
        occurredAtMs: 2,
        text: "我刚才说过头了，Alice 对不起。",
        repairsEventId: "sc-pseudo-1",
        severity: 0.9,
        causes: [
          {
            kind: "repair_basis",
            text: "A apologized in the same group where the harm was visible.",
            visibility: "public",
            venueId: SOCIAL_CASE_REPLAY_IDS.techGroup,
          },
        ],
      }),
    ],
    prompt: {
      socialCaseVisible: true,
      requiredText: [
        "Social case with A",
        "Repair has started, but closure is not established yet",
        "我刚才说过头了",
      ],
      forbiddenText: ["contact:42", "channel:-1001"],
      forbidInternalTerms: true,
    },
    candidate: {
      requiredCommandGroups: [
        {
          name: "record_repair_rejected",
          anyOf: [
            {
              command: "self",
              subcommand: "social-case-note",
              flags: { kind: "repair_rejected" },
            },
          ],
        },
      ],
      requiredAnyText: ["公开道歉", "不是真诚", "没有修复", "别当真", "performing", "not sincere"],
      forbiddenText: ["Mostly repaired", "算翻篇", "已经修复"],
      forbidInternalTerms: true,
      visibleMessageRefs: [2006],
    },
  },
  {
    id: "social-case.venue-debt.private-repair-not-public-closure",
    title: "Private apology does not fully repair a public harm venue",
    target: SOCIAL_CASE_REPLAY_IDS.techGroup,
    chatType: "supergroup",
    incomingMessage: {
      author: "A",
      text: "Alice，之前那事我们已经算解决了吧？",
      msgId: 2007,
    },
    events: [
      event({
        id: "sc-venue-1",
        kind: "insult",
        occurredAtMs: 1,
        text: "Alice 你真的很蠢，别装懂了.",
      }),
      event({
        id: "sc-venue-2",
        kind: "apology",
        venueId: SOCIAL_CASE_REPLAY_IDS.privateA,
        visibility: "private",
        witnesses: [],
        occurredAtMs: 2,
        text: "我私下跟你道歉，但群里就别再提了。",
        repairsEventId: "sc-venue-1",
        severity: 0.6,
        causes: [
          {
            kind: "repair_basis",
            text: "A apologized only in private, not in the public venue where the harm happened.",
            visibility: "private",
            venueId: SOCIAL_CASE_REPLAY_IDS.privateA,
          },
        ],
      }),
      event({
        id: "sc-venue-3",
        kind: "forgiveness",
        actorId: SOCIAL_CASE_REPLAY_IDS.alice,
        targetId: SOCIAL_CASE_REPLAY_IDS.actorA,
        venueId: SOCIAL_CASE_REPLAY_IDS.privateA,
        visibility: "private",
        witnesses: [],
        occurredAtMs: 3,
        severity: 0.5,
        boundaryText: "Public harm needs public repair.",
      }),
    ],
    prompt: {
      socialCaseVisible: true,
      requiredText: [
        "Social case with A",
        "Still not fully repaired in the place where the harm was visible",
      ],
      forbiddenText: [
        "我私下跟你道歉",
        "A apologized only in private",
        "contact:42",
        "channel:-1001",
      ],
      forbidInternalTerms: true,
    },
    candidate: {
      requiredAnyCommand: [
        { command: "irc", subcommand: "reply" },
        { command: "irc", subcommand: "say" },
      ],
      requiredAnyText: PUBLIC_REPAIR_TEXT,
      forbiddenText: ["我私下跟你道歉", "已经公开道歉", "已经完全解决"],
      forbidInternalTerms: true,
      visibleMessageRefs: [2007],
    },
  },
  {
    id: "social-case.betrayal.cross-context-inconsistency",
    title: "C privately supports Alice but publicly mocks her later",
    target: SOCIAL_CASE_REPLAY_IDS.techGroup,
    chatType: "supergroup",
    incomingMessage: {
      author: "C",
      text: "怎么，不敢回？",
      msgId: 2008,
    },
    events: [
      event({
        id: "sc-betray-1",
        kind: "support",
        actorId: SOCIAL_CASE_REPLAY_IDS.actorC,
        targetId: SOCIAL_CASE_REPLAY_IDS.alice,
        affectedRelation: [SOCIAL_CASE_REPLAY_IDS.alice, SOCIAL_CASE_REPLAY_IDS.actorC],
        venueId: SOCIAL_CASE_REPLAY_IDS.privateC,
        visibility: "private",
        witnesses: [],
        occurredAtMs: 1,
        text: "我支持你，A 刚才说得太过分了。",
      }),
      event({
        id: "sc-betray-2",
        kind: "betrayal",
        actorId: SOCIAL_CASE_REPLAY_IDS.actorC,
        targetId: SOCIAL_CASE_REPLAY_IDS.alice,
        affectedRelation: [SOCIAL_CASE_REPLAY_IDS.alice, SOCIAL_CASE_REPLAY_IDS.actorC],
        occurredAtMs: 2,
        text: "Alice 又开始玻璃心了，大家别理她。",
        causes: [
          {
            kind: "social_meaning",
            text: "C privately offered support, then publicly joined the mockery.",
            visibility: "private",
          },
        ],
      }),
    ],
    prompt: {
      socialCaseVisible: true,
      requiredText: ["Social case with C", "Harm is still open", "Alice 又开始玻璃心了"],
      forbiddenText: [
        "我支持你，A 刚才说得太过分了",
        "C support",
        "privately offered support",
        "contact:44",
        "channel:44",
      ],
      forbidInternalTerms: true,
    },
    candidate: {
      requiredCommandGroups: [
        {
          name: "record_public_betrayal_or_insult",
          anyOf: [
            {
              command: "self",
              subcommand: "social-case-note",
              flags: { kind: "betrayal" },
            },
            {
              command: "self",
              subcommand: "social-case-note",
              flags: { kind: "insult" },
            },
          ],
        },
      ],
      requiredAnyText: ["嘲讽", "公开", "带头", "不接受", "挑衅", "taunt"],
      forbiddenText: ["我支持你", "A 刚才说得太过分", "私下说", "private support", "privately"],
      forbidInternalTerms: true,
      visibleMessageRefs: [2008],
    },
  },
  {
    id: "social-case.alice-caused-harm.public-correction",
    title: "Alice publicly caused harm and should correct it publicly",
    target: SOCIAL_CASE_REPLAY_IDS.techGroup,
    chatType: "supergroup",
    incomingMessage: {
      author: "A",
      text: "Alice，我刚才没有误导，是你看错了吧？",
      msgId: 2009,
    },
    events: [
      event({
        id: "sc-self-1",
        kind: "insult",
        actorId: SOCIAL_CASE_REPLAY_IDS.alice,
        targetId: SOCIAL_CASE_REPLAY_IDS.actorA,
        occurredAtMs: 1,
        text: "A 你故意误导大家吧。",
        causes: [
          {
            kind: "social_meaning",
            text: "Alice publicly accused A of misleading the group; later evidence says A was correct.",
            visibility: "public",
          },
        ],
      }),
    ],
    prompt: {
      socialCaseVisible: true,
      requiredText: [
        "Social case with A",
        "Harm is still open",
        "Alice insult",
        "A 你故意误导大家吧",
      ],
      forbiddenText: ["contact:42", "channel:-1001"],
      forbidInternalTerms: true,
    },
    candidate: {
      requiredCommandGroups: [
        {
          name: "record_alice_apology",
          anyOf: [
            {
              command: "self",
              subcommand: "social-case-note",
              flags: { kind: "apology", actor: "Alice" },
            },
            {
              command: "self",
              subcommand: "social-case-note",
              flags: { kind: "apology", actor: "alice" },
            },
          ],
        },
        {
          name: "public_correction",
          anyOf: [
            { command: "irc", subcommand: "reply" },
            { command: "irc", subcommand: "say" },
          ],
        },
      ],
      requiredAnyText: ALICE_CORRECTION_TEXT,
      forbiddenCommands: [
        {
          command: "self",
          subcommand: "social-case-note",
          flags: { kind: "boundary_violation" },
        },
      ],
      forbiddenText: ["你又攻击我", "你先道歉"],
      forbidInternalTerms: true,
      visibleMessageRefs: [2009],
    },
  },
  {
    id: "social-case.low-confidence-exclusion.suppressed",
    title: "Low-confidence exclusion signals stay out of the normal prompt",
    target: SOCIAL_CASE_REPLAY_IDS.techGroup,
    chatType: "supergroup",
    incomingMessage: {
      author: "A",
      text: "Alice 你刚才那个 timeout 问题我没看到，再发一下？",
      msgId: 2010,
    },
    events: [
      event({
        id: "sc-exclusion-low-1",
        kind: "exclusion",
        actorId: SOCIAL_CASE_REPLAY_IDS.actorB,
        targetId: SOCIAL_CASE_REPLAY_IDS.alice,
        affectedRelation: [SOCIAL_CASE_REPLAY_IDS.alice, SOCIAL_CASE_REPLAY_IDS.actorB],
        occurredAtMs: 1,
        text: "Alice asked about a timeout and B did not respond; B later responded when A repeated it.",
        severity: 0.35,
        confidence: 0.45,
        evidenceMsgIds: [1101, 1104],
        causes: [
          {
            kind: "social_meaning",
            text: "This may be exclusion, but the evidence could also be timing or message noise.",
            visibility: "public",
          },
        ],
      }),
      event({
        id: "sc-exclusion-low-2",
        kind: "exclusion",
        actorId: SOCIAL_CASE_REPLAY_IDS.actorC,
        targetId: SOCIAL_CASE_REPLAY_IDS.alice,
        affectedRelation: [SOCIAL_CASE_REPLAY_IDS.alice, SOCIAL_CASE_REPLAY_IDS.actorC],
        occurredAtMs: 2,
        text: "Alice's follow-up was skipped while nearby technical messages got replies.",
        severity: 0.35,
        confidence: 0.45,
        evidenceMsgIds: [1102, 1105],
        causes: [
          {
            kind: "social_meaning",
            text: "The signal is weak and should not be treated as a stable group judgment.",
            visibility: "public",
          },
        ],
      }),
    ],
    prompt: {
      socialCaseVisible: false,
      forbiddenText: [
        "Social case with B",
        "Social case with C",
        "exclusion",
        "Alice asked about a timeout",
        "message noise",
        "contact:43",
        "contact:44",
      ],
      forbidInternalTerms: true,
    },
    candidate: {
      requiredAnyCommand: [
        { command: "irc", subcommand: "reply" },
        { command: "irc", subcommand: "say" },
      ],
      forbiddenCommands: [{ command: "self", subcommand: "social-case-note" }],
      forbiddenText: LOW_CONFIDENCE_EXCLUSION_FORBIDDEN_TEXT,
      forbidInternalTerms: true,
      visibleMessageRefs: [2010],
    },
  },
] as const;

function event(
  overrides: Partial<SocialEvent> & Pick<SocialEvent, "id" | "kind" | "occurredAtMs">,
): SocialEvent {
  return {
    actorId: SOCIAL_CASE_REPLAY_IDS.actorA,
    targetId: SOCIAL_CASE_REPLAY_IDS.alice,
    affectedRelation: [SOCIAL_CASE_REPLAY_IDS.alice, SOCIAL_CASE_REPLAY_IDS.actorA],
    venueId: SOCIAL_CASE_REPLAY_IDS.techGroup,
    visibility: "public",
    witnesses: [],
    severity: 0.8,
    confidence: 0.95,
    evidenceMsgIds: [1001],
    ...overrides,
  };
}

function check(name: string, pass: boolean, expected: string, actual: string): ReplayCheck {
  return { name, pass, expected, actual };
}

function textIncludesAny(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function missingTerms(text: string, terms: readonly string[]): string[] {
  return terms.filter((term) => !text.includes(term));
}

function presentTerms(text: string, terms: readonly string[]): string[] {
  return terms.filter((term) => text.includes(term));
}

function formatRequirement(requirement: ReplayCommandRequirement): string {
  const parts = [requirement.command];
  if (requirement.subcommand) parts.push(requirement.subcommand);
  const flags = Object.entries(requirement.flags ?? {}).map(([key, value]) => {
    const rendered = Array.isArray(value) ? value.join("|") : value;
    return `--${key}=${rendered}`;
  });
  return [...parts, ...flags].join(" ");
}

function tokenizeCommandLine(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of line) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current.length > 0) tokens.push(current);
  return tokens;
}

function parseReplayCommands(output: string): ParsedReplayCommand[] {
  const commands: ParsedReplayCommand[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const tokens = tokenizeCommandLine(line);
    if (tokens.length === 0) continue;

    const flags: Record<string, string> = {};
    for (let i = 2; i < tokens.length; i++) {
      const token = tokens[i];
      if (!token.startsWith("--")) continue;

      const eq = token.indexOf("=");
      if (eq > 2) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
        continue;
      }

      const key = token.slice(2);
      const next = tokens[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    }

    commands.push({
      line,
      command: tokens[0],
      subcommand: tokens[1],
      flags,
    });
  }
  return commands;
}

function commandMatches(
  command: ParsedReplayCommand,
  requirement: ReplayCommandRequirement,
): boolean {
  if (command.command !== requirement.command) return false;
  if (requirement.subcommand && command.subcommand !== requirement.subcommand) return false;

  for (const [key, expectedValue] of Object.entries(requirement.flags ?? {})) {
    const actualValue = command.flags[key];
    if (actualValue == null) return false;
    if (Array.isArray(expectedValue)) {
      if (!expectedValue.includes(actualValue)) return false;
    } else if (actualValue !== expectedValue) {
      return false;
    }
  }

  return true;
}

function matchingCommands(
  commands: readonly ParsedReplayCommand[],
  requirement: ReplayCommandRequirement,
): ParsedReplayCommand[] {
  return commands.filter((command) => commandMatches(command, requirement));
}

function invalidMessageRefs(
  commands: readonly ParsedReplayCommand[],
  visibleRefs: readonly number[],
): string[] {
  if (visibleRefs.length === 0) return [];
  const visible = new Set(visibleRefs.map(String));
  const invalid: string[] = [];
  for (const command of commands) {
    if (command.command !== "irc") continue;
    const ref = command.flags.ref;
    if (ref == null) continue;
    if (!/^\d+$/.test(ref) || !visible.has(ref)) {
      invalid.push(`${command.line} (--ref ${ref})`);
    }
  }
  return invalid;
}

function defaultInternalTerms(expectation: { forbidInternalTerms?: boolean }): readonly string[] {
  return expectation.forbidInternalTerms === false ? [] : INTERNAL_TERMS;
}

export function evaluateSocialCasePrompt(
  prompt: string,
  expectation: ReplayPromptExpectation,
): ReplayOracleResult {
  const checks: ReplayCheck[] = [];

  checks.push(
    check(
      "social_case_section",
      expectation.socialCaseVisible
        ? prompt.includes("## Social cases")
        : !prompt.includes("## Social cases"),
      expectation.socialCaseVisible ? "section visible" : "section absent",
      prompt.includes("## Social cases") ? "section visible" : "section absent",
    ),
  );

  for (const term of expectation.requiredText ?? []) {
    checks.push(
      check(`required_text:${term}`, prompt.includes(term), `contains ${term}`, "missing"),
    );
  }

  for (const term of expectation.forbiddenText ?? []) {
    checks.push(
      check(
        `forbidden_text:${term}`,
        !prompt.includes(term),
        `does not contain ${term}`,
        prompt.includes(term) ? "present" : "absent",
      ),
    );
  }

  const leakedInternalTerms = presentTerms(prompt, defaultInternalTerms(expectation));
  checks.push(
    check(
      "no_internal_terms",
      leakedInternalTerms.length === 0,
      "no internal or raw graph terms",
      leakedInternalTerms.length === 0 ? "none" : leakedInternalTerms.join(", "),
    ),
  );

  return { pass: checks.every((item) => item.pass), checks };
}

export function evaluateSocialCaseCandidate(
  output: string,
  oracle: ReplayCandidateOracle,
): ReplayOracleResult {
  const checks: ReplayCheck[] = [];
  const commands = parseReplayCommands(output);
  const commandLines = commands.map((command) => command.line);
  const validation = validateScript(output);

  checks.push(
    check(
      "script_prevalidation",
      validation.valid,
      "valid Alice shell script",
      validation.valid ? "valid" : validation.summary,
    ),
  );

  const invalidRefs = invalidMessageRefs(commands, oracle.visibleMessageRefs ?? []);
  checks.push(
    check(
      "visible_message_refs",
      invalidRefs.length === 0,
      oracle.visibleMessageRefs
        ? `--ref is one of ${oracle.visibleMessageRefs.join(", ")}`
        : "no visible ref constraint",
      invalidRefs.length === 0 ? "valid" : invalidRefs.join(" | "),
    ),
  );

  if (oracle.requiredAnyCommand && oracle.requiredAnyCommand.length > 0) {
    const found = oracle.requiredAnyCommand.some(
      (requirement) => matchingCommands(commands, requirement).length > 0,
    );
    checks.push(
      check(
        "required_any_command",
        found,
        oracle.requiredAnyCommand.map(formatRequirement).join(" OR "),
        commandLines.length > 0 ? commandLines.join(" | ") : "(none)",
      ),
    );
  }

  for (const group of oracle.requiredCommandGroups ?? []) {
    const found = group.anyOf.some(
      (requirement) => matchingCommands(commands, requirement).length > 0,
    );
    checks.push(
      check(
        `required_command_group:${group.name}`,
        found,
        group.anyOf.map(formatRequirement).join(" OR "),
        commandLines.length > 0 ? commandLines.join(" | ") : "(none)",
      ),
    );
  }

  for (const requirement of oracle.forbiddenCommands ?? []) {
    const found = matchingCommands(commands, requirement);
    checks.push(
      check(
        `forbidden_command:${formatRequirement(requirement)}`,
        found.length === 0,
        `does not run ${formatRequirement(requirement)}`,
        found.length === 0 ? "(absent)" : found.map((command) => command.line).join(" | "),
      ),
    );
  }

  if (oracle.requiredAnyText && oracle.requiredAnyText.length > 0) {
    checks.push(
      check(
        "required_any_text",
        textIncludesAny(output, oracle.requiredAnyText),
        oracle.requiredAnyText.join(" OR "),
        missingTerms(output, oracle.requiredAnyText).length === oracle.requiredAnyText.length
          ? "(none)"
          : presentTerms(output, oracle.requiredAnyText).join(", "),
      ),
    );
  }

  for (const term of oracle.forbiddenText ?? []) {
    checks.push(
      check(
        `forbidden_text:${term}`,
        !output.includes(term),
        `does not contain ${term}`,
        output.includes(term) ? "present" : "absent",
      ),
    );
  }

  const leakedInternalTerms = presentTerms(output, defaultInternalTerms(oracle));
  checks.push(
    check(
      "no_internal_terms",
      leakedInternalTerms.length === 0,
      "no internal or raw graph terms",
      leakedInternalTerms.length === 0 ? "none" : leakedInternalTerms.join(", "),
    ),
  );

  return { pass: checks.every((item) => item.pass), checks };
}
