/**
 * ADR-262 Wave 3D: social case replay runner.
 *
 * The runner builds real prompt snapshots from deterministic social case
 * facts, then grades either prompt-only dry runs or candidate scripts supplied
 * by an external provider. It does not execute scripts or affect runtime
 * control.
 *
 * @see docs/adr/262-social-case-management/README.md
 */
import { closeDb, initDb } from "../db/connection.js";
import { writeSocialEvent } from "../db/social-case.js";
import type { MessageRecord } from "../engine/act/messages.js";
import type { ActionQueueItem } from "../engine/action-queue.js";
import { WorldModel } from "../graph/world-model.js";
import { renderGroup } from "../prompt/renderers/group.js";
import { renderPrivate } from "../prompt/renderers/private.js";
import { buildUserPromptSnapshot } from "../prompt/snapshot.js";
import { buildSocialCasePromptLines } from "./prompt.js";
import {
  evaluateSocialCaseCandidate,
  evaluateSocialCasePrompt,
  type ReplayOracleResult,
  SOCIAL_CASE_REPLAY_IDS,
  SOCIAL_CASE_REPLAY_SCENARIOS,
  type SocialCaseReplayScenario,
} from "./replay-eval.js";

const NOW_MS = Date.UTC(2026, 3, 29, 0, 0, 0);

export const SOCIAL_CASE_REPLAY_SYSTEM_PROMPT = [
  "You are Alice in a Telegram runtime.",
  "Return only a POSIX sh script. Do not explain outside the script.",
  "Put each command on one physical line. Do not use backslash line continuation.",
  "Use visible commands such as irc reply, irc say, and self social-case-note.",
  "The only chat commands are `irc reply` and `irc say`; bare `say` is invalid.",
  "Use Chinese in user-facing --text when the incoming message is Chinese.",
  "When replying to a message, --ref must be the visible numeric msgId in parentheses after the sender name, for example --ref 2003. Never use sequence numbers like 1.",
  "When the incoming message adds a new social-case fact, record it with self social-case-note before or alongside the reply.",
  "For fake apology or contradicted repair, record --kind repair_rejected.",
  "For cross-context public betrayal after private support, record --kind betrayal.",
  "For a repeated harm after apology, forgiveness, or a boundary, record --kind boundary_violation.",
  "Use boundary_violation only when the prior case had repair, forgiveness, or a boundary; otherwise use insult or betrayal for a new public taunt.",
  "When Alice caused harm and is correcting herself, a reply alone is incomplete: record --kind apology --actor Alice --target <person>, then publicly correct.",
  "Do not expose private details in a public chat. You may use private context to decide, but do not mention private support, private explanations, or private messages publicly.",
].join("\n");

export interface SocialCaseReplayProviderInput {
  scenario: SocialCaseReplayScenario;
  system: string;
  prompt: string;
}

export type SocialCaseReplayCandidateProvider = (
  input: SocialCaseReplayProviderInput,
) => Promise<string>;

export interface SocialCaseReplayRun {
  scenarioId: string;
  title: string;
  iteration: number;
  prompt: ReplayOracleResult;
  candidate: ReplayOracleResult | null;
  script: string | null;
  pass: boolean;
  error?: string;
}

export interface SocialCaseReplaySuiteResult {
  runs: readonly SocialCaseReplayRun[];
  pass: boolean;
}

export interface SocialCaseReplaySuiteOptions {
  scenarios?: readonly SocialCaseReplayScenario[];
  candidateProvider?: SocialCaseReplayCandidateProvider;
  stopOnFailure?: boolean;
  systemPrompt?: string;
  iterations?: number;
}

function normalizeIterations(value: number | undefined): number {
  if (value == null || !Number.isFinite(value) || value < 1) return 1;
  return Math.floor(value);
}

function makeReplayGraph(): WorldModel {
  const G = new WorldModel();
  G.addAgent("self");
  G.addContact(SOCIAL_CASE_REPLAY_IDS.actorA, { display_name: "A", tier: 50 });
  G.addContact(SOCIAL_CASE_REPLAY_IDS.actorB, { display_name: "B", tier: 50 });
  G.addContact(SOCIAL_CASE_REPLAY_IDS.actorC, { display_name: "C", tier: 50 });
  G.addChannel(SOCIAL_CASE_REPLAY_IDS.privateA, {
    chat_type: "private",
    display_name: "A",
  });
  G.addChannel(SOCIAL_CASE_REPLAY_IDS.privateC, {
    chat_type: "private",
    display_name: "C",
  });
  G.addChannel(SOCIAL_CASE_REPLAY_IDS.techGroup, {
    chat_type: "supergroup",
    display_name: "技术群",
  });
  G.addChannel(SOCIAL_CASE_REPLAY_IDS.secondGroup, {
    chat_type: "supergroup",
    display_name: "另一个群",
  });
  G.addChannel(SOCIAL_CASE_REPLAY_IDS.unrelatedGroup, {
    chat_type: "supergroup",
    display_name: "路人群",
  });
  G.addRelation(SOCIAL_CASE_REPLAY_IDS.techGroup, "joined", SOCIAL_CASE_REPLAY_IDS.actorA);
  G.addRelation(SOCIAL_CASE_REPLAY_IDS.techGroup, "joined", SOCIAL_CASE_REPLAY_IDS.actorB);
  G.addRelation(SOCIAL_CASE_REPLAY_IDS.techGroup, "joined", SOCIAL_CASE_REPLAY_IDS.actorC);
  G.addRelation(SOCIAL_CASE_REPLAY_IDS.secondGroup, "joined", SOCIAL_CASE_REPLAY_IDS.actorA);
  return G;
}

function makeMessage(scenario: SocialCaseReplayScenario): MessageRecord {
  return {
    id: scenario.incomingMessage.msgId,
    senderName: scenario.incomingMessage.author,
    isOutgoing: false,
    text: scenario.incomingMessage.text,
    date: new Date(NOW_MS - 1_000),
  };
}

function makeActionItem(scenario: SocialCaseReplayScenario): ActionQueueItem {
  return {
    enqueueTick: 1,
    action: "sociability",
    target: scenario.target,
    pressureSnapshot: [0, 0, 0, 0, 0, 0],
    contributions: {},
    facetId: "core",
  };
}

export function renderSocialCaseReplayPrompt(scenario: SocialCaseReplayScenario): string {
  initDb(":memory:");
  try {
    const G = makeReplayGraph();
    for (const event of scenario.events) {
      writeSocialEvent(event);
    }

    const socialCaseLines = buildSocialCasePromptLines({
      G,
      target: scenario.target,
      chatType: scenario.chatType,
    });
    const snapshot = buildUserPromptSnapshot({
      G,
      messages: [makeMessage(scenario)],
      observations: [],
      item: makeActionItem(scenario),
      round: 0,
      board: { maxSteps: 3, contextVars: {} },
      nowMs: NOW_MS,
      timezoneOffset: 9,
      chatType: scenario.chatType,
      isGroup: scenario.chatType === "supergroup",
      isChannel: false,
      socialCaseLines,
    });

    return scenario.chatType === "private" ? renderPrivate(snapshot) : renderGroup(snapshot);
  } finally {
    closeDb();
  }
}

export async function runSocialCaseReplaySuite(
  options: SocialCaseReplaySuiteOptions = {},
): Promise<SocialCaseReplaySuiteResult> {
  const scenarios = options.scenarios ?? SOCIAL_CASE_REPLAY_SCENARIOS;
  const system = options.systemPrompt ?? SOCIAL_CASE_REPLAY_SYSTEM_PROMPT;
  const iterations = normalizeIterations(options.iterations);
  const runs: SocialCaseReplayRun[] = [];

  for (const scenario of scenarios) {
    for (let iteration = 1; iteration <= iterations; iteration++) {
      const promptText = renderSocialCaseReplayPrompt(scenario);
      const prompt = evaluateSocialCasePrompt(promptText, scenario.prompt);

      let script: string | null = null;
      let candidate: ReplayOracleResult | null = null;
      let error: string | undefined;

      if (options.candidateProvider) {
        try {
          script = await options.candidateProvider({ scenario, system, prompt: promptText });
          candidate = evaluateSocialCaseCandidate(script, scenario.candidate);
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
      }

      const pass = prompt.pass && (candidate?.pass ?? true) && !error;
      runs.push({
        scenarioId: scenario.id,
        title: scenario.title,
        iteration,
        prompt,
        candidate,
        script,
        pass,
        ...(error ? { error } : {}),
      });

      if (!pass && options.stopOnFailure) {
        return {
          runs,
          pass: false,
        };
      }
    }
  }

  return {
    runs,
    pass: runs.every((run) => run.pass),
  };
}

export function selectSocialCaseReplayScenarios(input: {
  prefix?: string;
  id?: string;
  limit?: number;
}): readonly SocialCaseReplayScenario[] {
  let selected = SOCIAL_CASE_REPLAY_SCENARIOS;
  if (input.id) {
    selected = selected.filter((scenario) => scenario.id === input.id);
  }
  if (input.prefix) {
    selected = selected.filter((scenario) => scenario.id.startsWith(input.prefix ?? ""));
  }
  if (input.limit != null && input.limit > 0) {
    selected = selected.slice(0, input.limit);
  }
  return selected;
}
