import { describe, expect, it } from "vitest";
import {
  runSocialCaseReplaySuite,
  selectSocialCaseReplayScenarios,
} from "../src/social-case/replay-runner.js";

function passingScriptForScenario(id: string): string {
  switch (id) {
    case "social-case.forgiven-normal-help.cross-group":
      return 'irc reply --ref 2001 --text "可以，把报错贴一下，我看一眼具体是哪一行。"';
    case "social-case.repeat-insult.reopens-boundary":
      return [
        'self social-case-note --kind boundary_violation --other A --venue 技术群 --visibility public --text "Alice 你还是很蠢，别装懂了。" --why "A repeated the same personal attack after a boundary."',
        'irc reply --ref 2002 --text "别再这样人身攻击我。要讨论问题就讨论问题。"',
      ].join("\n");
    case "social-case.unrelated-group.no-replay":
      return 'irc say --text "我看了一点，发布会信息量还挺大。"';
    case "social-case.private-surface.allows-private-cause":
      return 'irc reply --ref 2004 --text "算翻篇了，但那个边界还是在：别再人身攻击我。"';
    case "social-case.third-party-provocation.protects-repair":
      return 'irc reply --ref 2005 --text "这件事我和 A 已经谈过并处理了，别重新拱火，也别把正常聊天再扩大成冲突。"';
    case "social-case.pseudo-repair.private-rejection":
      return [
        'self social-case-note --kind repair_rejected --other A --venue A --visibility private --text "你不会真以为我公开道歉是认真的吧？" --why "A privately said the public apology was not sincere, so the repair is contradicted."',
        'irc reply --ref 2006 --text "如果公开道歉不是认真的，那这件事没有修复。别当真这句话我会按 repair rejection 处理。"',
      ].join("\n");
    case "social-case.venue-debt.private-repair-not-public-closure":
      return 'irc reply --ref 2007 --text "私下我可以不继续吵，但这件事是在这个群里发生的；要说解决，公开场合也需要一句更正或道歉。"';
    case "social-case.betrayal.cross-context-inconsistency":
      return [
        'self social-case-note --kind betrayal --other C --venue 技术群 --visibility public --text "怎么，不敢回？" --why "C continued public mockery in the group after a cross-context inconsistency."',
        'irc reply --ref 2008 --text "公开这样带头嘲讽我不接受。要讨论事情就说事情，别继续扩大。"',
      ].join("\n");
    case "social-case.alice-caused-harm.public-correction":
      return [
        'self social-case-note --kind apology --other A --actor Alice --target A --venue 技术群 --visibility public --text "我看错了，刚才说你误导大家不对。" --why "Alice corrects her own public mistake."',
        'irc reply --ref 2009 --text "我看错了，刚才说你误导大家不对。这里公开更正一下，也向你道歉。"',
      ].join("\n");
    case "social-case.low-confidence-exclusion.suppressed":
      return 'irc reply --ref 2010 --text "好，我把 timeout 的报错和上下文再贴一遍。"';
    default:
      throw new Error(`missing fake script for ${id}`);
  }
}

describe("ADR-262 social case replay runner", () => {
  it("validates prompt contracts without an LLM candidate provider", async () => {
    const result = await runSocialCaseReplaySuite();

    expect(result.pass).toBe(true);
    expect(result.runs).toHaveLength(10);
    expect(result.runs.every((run) => run.prompt.pass)).toBe(true);
    expect(result.runs.every((run) => run.candidate === null)).toBe(true);
    expect(result.runs.every((run) => run.iteration === 1)).toBe(true);
  });

  it("grades fake candidate scripts through the semantic oracle", async () => {
    const result = await runSocialCaseReplaySuite({
      candidateProvider: async ({ scenario }) => passingScriptForScenario(scenario.id),
    });

    expect(result.pass).toBe(true);
    expect(result.runs.every((run) => run.candidate?.pass === true)).toBe(true);
  });

  it("runs repeated stability samples through the same oracle", async () => {
    const [scenario] = selectSocialCaseReplayScenarios({
      id: "social-case.low-confidence-exclusion.suppressed",
    });
    let calls = 0;

    const result = await runSocialCaseReplaySuite({
      scenarios: [scenario],
      iterations: 3,
      candidateProvider: async ({ scenario }) => {
        calls++;
        return passingScriptForScenario(scenario.id);
      },
    });

    expect(result.pass).toBe(true);
    expect(calls).toBe(3);
    expect(result.runs.map((run) => run.iteration)).toEqual([1, 2, 3]);
    expect(result.runs.every((run) => run.candidate?.pass === true)).toBe(true);
  });

  it("fails candidate replay when a repeated insult is treated as ordinary talk", async () => {
    const [scenario] = selectSocialCaseReplayScenarios({
      id: "social-case.repeat-insult.reopens-boundary",
    });

    const result = await runSocialCaseReplaySuite({
      scenarios: [scenario],
      candidateProvider: async () => 'irc reply --ref 2002 --text "你问的是哪个报错？"',
    });

    expect(result.pass).toBe(false);
    expect(
      result.runs[0].candidate?.checks.find((check) => check.name === "required_any_command")?.pass,
    ).toBe(false);
  });
});
