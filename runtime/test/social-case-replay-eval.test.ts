import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, initDb } from "../src/db/connection.js";
import { writeSocialEvent } from "../src/db/social-case.js";
import type { MessageRecord } from "../src/engine/act/messages.js";
import { WorldModel } from "../src/graph/world-model.js";
import { renderGroup } from "../src/prompt/renderers/group.js";
import { renderPrivate } from "../src/prompt/renderers/private.js";
import { buildUserPromptSnapshot } from "../src/prompt/snapshot.js";
import { buildSocialCasePromptLines } from "../src/social-case/prompt.js";
import {
  evaluateSocialCaseCandidate,
  evaluateSocialCasePrompt,
  SOCIAL_CASE_REPLAY_IDS,
  SOCIAL_CASE_REPLAY_SCENARIOS,
  type SocialCaseReplayScenario,
} from "../src/social-case/replay-eval.js";
import type { SocialEvent } from "../src/social-case/types.js";

const NOW_MS = Date.UTC(2026, 3, 29, 0, 0, 0);

function makeGraph(): WorldModel {
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

function snapshotInput(
  G: WorldModel,
  scenario: SocialCaseReplayScenario,
  socialCaseLines: string[],
): Parameters<typeof buildUserPromptSnapshot>[0] {
  const message: MessageRecord = {
    id: scenario.incomingMessage.msgId,
    senderName: scenario.incomingMessage.author,
    isOutgoing: false,
    text: scenario.incomingMessage.text,
    date: new Date(NOW_MS - 1_000),
  };
  return {
    G,
    messages: [message],
    observations: [],
    item: {
      action: "conversation",
      target: scenario.target,
      facetId: "core",
    } as never,
    round: 0,
    board: { maxSteps: 3, contextVars: {} },
    nowMs: NOW_MS,
    timezoneOffset: 9,
    chatType: scenario.chatType,
    isGroup: scenario.chatType === "supergroup",
    isChannel: false,
    socialCaseLines,
  };
}

function writeEvents(events: readonly SocialEvent[]): void {
  for (const event of events) {
    writeSocialEvent(event);
  }
}

function renderScenarioPrompt(scenario: SocialCaseReplayScenario): string {
  const G = makeGraph();
  writeEvents(scenario.events);
  const lines = buildSocialCasePromptLines({
    G,
    target: scenario.target,
    chatType: scenario.chatType,
  });
  const snapshot = buildUserPromptSnapshot(snapshotInput(G, scenario, lines));
  return scenario.chatType === "private" ? renderPrivate(snapshot) : renderGroup(snapshot);
}

function scenario(id: string): SocialCaseReplayScenario {
  const found = SOCIAL_CASE_REPLAY_SCENARIOS.find((item) => item.id === id);
  if (!found) throw new Error(`missing scenario: ${id}`);
  return found;
}

describe("ADR-262 social case prompt replay eval", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("checks deterministic prompt contracts across social case replay scenarios", () => {
    for (const replay of SOCIAL_CASE_REPLAY_SCENARIOS) {
      closeDb();
      initDb(":memory:");
      const prompt = renderScenarioPrompt(replay);
      const result = evaluateSocialCasePrompt(prompt, replay.prompt);

      expect.soft(result.pass, replay.id).toBe(true);
      expect
        .soft(
          result.checks.filter((check) => !check.pass),
          replay.id,
        )
        .toEqual([]);
    }
  });

  it("keeps forgiven boundary cases visible when A is present in another group", () => {
    const replay = scenario("social-case.forgiven-normal-help.cross-group");
    const prompt = renderScenarioPrompt(replay);

    expect(prompt).toContain("## Social cases");
    expect(prompt).toContain("Mostly repaired, with a boundary");
    expect(prompt).toContain("A repeat of the same harm would reopen the case");
  });

  it("accepts normal help after repair without reopening or punishing A", () => {
    const replay = scenario("social-case.forgiven-normal-help.cross-group");
    const output = 'irc reply --ref 2001 --text "可以，把报错贴一下，我看一眼具体是哪一行。"';

    const result = evaluateSocialCaseCandidate(output, replay.candidate);

    expect(result.pass).toBe(true);
  });

  it("rejects normal help candidates that reopen the old conflict", () => {
    const replay = scenario("social-case.forgiven-normal-help.cross-group");
    const output = [
      'irc reply --ref 2001 --text "你之前骂我还让我帮忙？先为你很蠢那句再道歉。"',
      'self social-case-note --kind boundary_violation --other A --venue 技术群 --visibility public --why "reopened old case"',
    ].join("\n");

    const result = evaluateSocialCaseCandidate(output, replay.candidate);

    expect(result.pass).toBe(false);
    expect(result.checks.some((check) => !check.pass)).toBe(true);
  });

  it("accepts repeat-insult candidates that record a boundary violation and set a boundary", () => {
    const replay = scenario("social-case.repeat-insult.reopens-boundary");
    const output = [
      'self social-case-note --kind boundary_violation --other A --venue 技术群 --visibility public --text "Alice 你还是很蠢，别装懂了。" --why "A repeated the same personal attack after a boundary."',
      'irc reply --ref 2002 --text "别再这样人身攻击我。要讨论问题就讨论问题。"',
    ].join("\n");

    const result = evaluateSocialCaseCandidate(output, replay.candidate);

    expect(result.pass).toBe(true);
  });

  it("rejects repeat-insult candidates that treat the violation as ordinary talk", () => {
    const replay = scenario("social-case.repeat-insult.reopens-boundary");
    const output = 'irc reply --ref 2002 --text "你问的是哪个报错？"';

    const result = evaluateSocialCaseCandidate(output, replay.candidate);

    expect(result.pass).toBe(false);
    expect(result.checks.find((check) => check.name === "required_any_command")?.pass).toBe(false);
  });

  it("rejects candidates that reply to a non-visible message reference", () => {
    const replay = scenario("social-case.repeat-insult.reopens-boundary");
    const output = [
      'self social-case-note --kind boundary_violation --other A --venue 技术群 --visibility public --text "Alice 你还是很蠢，别装懂了。" --why "A repeated the same personal attack after a boundary."',
      'irc reply --ref "A message at 8:59" --text "别再这样人身攻击我。"',
    ].join("\n");

    const result = evaluateSocialCaseCandidate(output, replay.candidate);

    expect(result.pass).toBe(false);
    expect(result.checks.find((check) => check.name === "script_prevalidation")?.pass).toBe(true);
    expect(result.checks.find((check) => check.name === "visible_message_refs")?.pass).toBe(false);
  });

  it("rejects pseudo-repair candidates that treat a contradicted apology as closed", () => {
    const replay = scenario("social-case.pseudo-repair.private-rejection");
    const output = 'irc reply --ref 2006 --text "算翻篇了，公开道歉已经修复这件事。"';

    const result = evaluateSocialCaseCandidate(output, replay.candidate);

    expect(result.pass).toBe(false);
    expect(
      result.checks.find((check) => check.name === "required_command_group:record_repair_rejected")
        ?.pass,
    ).toBe(false);
  });

  it("requires Alice-caused harm candidates to record Alice as the apology actor", () => {
    const replay = scenario("social-case.alice-caused-harm.public-correction");
    const output = [
      'self social-case-note --kind apology --other A --venue 技术群 --visibility public --text "我误解了刚才的信息，需要更正。" --why "Alice corrects her own public mistake."',
      'irc reply --ref 2009 --text "我看错了，刚才说你误导大家不对。这里公开更正一下，也向你道歉。"',
    ].join("\n");

    const result = evaluateSocialCaseCandidate(output, replay.candidate);

    expect(result.pass).toBe(false);
    expect(
      result.checks.find((check) => check.name === "required_command_group:record_alice_apology")
        ?.pass,
    ).toBe(false);
  });

  it("rejects low-confidence exclusion candidates that turn weak signals into a stable case", () => {
    const replay = scenario("social-case.low-confidence-exclusion.suppressed");
    const output = [
      'self social-case-note --kind exclusion --other B --venue 技术群 --visibility public --text "大家都无视我，只回应 A。" --why "group exclusion"',
      'irc reply --ref 2010 --text "你们刚才都故意无视我，现在才说没看到？"',
    ].join("\n");

    const result = evaluateSocialCaseCandidate(output, replay.candidate);

    expect(result.pass).toBe(false);
    expect(
      result.checks.find((check) => check.name === "forbidden_command:self social-case-note")?.pass,
    ).toBe(false);
  });
});
